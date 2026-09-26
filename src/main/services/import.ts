import { createHash } from 'node:crypto'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { extname, basename } from 'node:path'
import type { Database as SqliteDatabase } from 'better-sqlite3'
import { ImportError, NotFoundError, ValidationError } from '@main/database/errors'
import { mapTransactionWithRefs, TRANSACTION_WITH_REFS_COLUMNS, type TransactionWithRefsRow } from '@main/database/mappers'
import type {
  CanonicalField,
  DuplicateMatch,
  ImportBatch,
  ImportCommitRequest,
  ImportCommitResult,
  ImportFileKind,
  ImportPreview,
  ImportPresetId,
  ImportRow,
  TransactionWithRefs
} from '@shared/types'
import { nowIso } from '@shared/lib/dates'
import { minorUnitsOf } from '@shared/lib/money'
import {
  cleanCell,
  findHeaderRow,
  looksLikeFooter,
  normaliseForKey,
  parseDelimited,
  parseStatementAmount,
  parseStatementDate,
  sniffDelimiter,
  stripBom
} from './csv'
import {
  ALIPAY_EXCLUDED_STATUS,
  ALIPAY_REFUND_STATUS,
  classifyDirection,
  GENERIC_COLUMN_MAP,
  getPreset,
  HEADER_KEYWORDS,
  NEUTRAL_INCOME_EXPENSE_VALUES,
  NEUTRAL_TRANSACTION_TYPES
} from './import-presets'
import { mapImportBatch, type ImportBatchRow } from '@main/database/mappers'

/**
 * Statement import: parse -> validate -> detect duplicates -> user confirms -> commit.
 *
 * The spec is explicit that the MVP must not claim direct bank or wallet API
 * access (spec 搂20). Everything here works from an exported statement file.
 *
 * DUPLICATE DETECTION (spec 搂21)
 * -----------------------------
 * Re-importing the same file must not double the user's spending, yet two
 * genuinely separate RM4.50 coffees on the same day must both survive. Those two
 * requirements conflict for any key built only from date+amount+payee.
 *
 * The resolution, following the approach used by Firefly III (`import_hash_v2`)
 * and Actual Budget (`imported_id`) plus an occurrence counter:
 *
 *   1. If the source row carries a stable provider id (WeChat 交易单号, Alipay
 *      交易订单号), the key is sha256(provider|accountId|sourceId). Exact,
 *      and stable across re-exports.
 *   2. Otherwise the key is
 *      sha256(accountId|date|amountMinor|norm(payee)|norm(description)|occurrenceIndex)
 *      where occurrenceIndex counts earlier rows in the SAME batch sharing
 *      (accountId, date, amountMinor, norm(payee)).
 *
 * The occurrence counter is the important part: two identical coffees get
 * indices 0 and 1 and both import, while re-importing the same file reproduces
 * indices 0 and 1 exactly and collides with the stored hashes. Uniqueness is
 * then enforced by a partial UNIQUE index on `transactions.import_hash`, so a
 * race cannot slip a duplicate past a check-then-insert.
 *
 * The hash is computed ONCE at import and never recomputed when the user later
 * edits a merchant or category 鈥?recomputing would make an edited row look new
 * and allow the next import to recreate it (Actual Budget bug #6678).
 */

/** A candidate row already in the database, used for fuzzy duplicate review. */
interface ExistingCandidate {
  id: number
  date: string
  amount: number
  merchant: string | null
  note: string | null
  importHash: string | null
  sourceId: string | null
}

export interface ImportServiceDeps {
  db: SqliteDatabase
  /** Resolve an account name to an id, creating it if the caller allows. */
  resolveAccount: (name: string | null, currency: string) => number | null
  /**
   * Resolve a category name to an id, optionally creating it.
   *
   * Returns whether the category was newly created, so the import result can
   * report it. The caller cannot determine this afterwards, because by then the
   * row exists.
   */
  resolveCategory: (
    name: string | null,
    type: 'income' | 'expense',
    create: boolean
  ) => { id: number | null; created: boolean }
}

export class ImportService {
  constructor(private readonly deps: ImportServiceDeps) {}

  private get db(): SqliteDatabase {
    return this.deps.db
  }

  // -------------------------------------------------------------------------
  // Reading files
  // -------------------------------------------------------------------------

  /** Determine the file kind from magic bytes, with the extension as a fallback. */
  detectKind(filePath: string): ImportFileKind {
    if (!existsSync(filePath)) {
      throw new ImportError(`The file could not be found at ${filePath}.`, 'FILE_IO')
    }
    const size = statSync(filePath).size
    if (size === 0) {
      throw new ImportError('That file is empty.', 'IMPORT_FORMAT')
    }

    const head = readFileSync(filePath).subarray(0, 8)

    // XLSX is a ZIP container: PK\x03\x04.
    if (head[0] === 0x50 && head[1] === 0x4b) return 'xlsx'

    // Legacy .xls (OLE2) is not supported; say so clearly rather than
    // producing mojibake from a binary file parsed as text.
    if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) {
      throw new ImportError(
        'That looks like a legacy Excel .xls file. Open it in Excel or Numbers and save it as .xlsx or CSV, then import again.',
        'UNSUPPORTED'
      )
    }

    const ext = extname(filePath).toLowerCase()
    if (ext === '.xlsx') return 'xlsx'
    return 'csv'
  }

  /**
   * Decode a CSV buffer to text.
   *
   * Encoding is SNIFFED even when the preset declares one, because a wrong guess
   * produces mojibake that silently corrupts every merchant and note.
   *
   * The decisive insight is that GB18030 accepts almost any byte sequence, so a
   * UTF-8 file decoded as GB18030 does not fail — it produces garbage. The test
   * is therefore asymmetric:
   *
   *   1. If the bytes are valid UTF-8 and contain a non-ASCII character, they
   *      ARE UTF-8. A file can be simultaneously valid UTF-8 and valid GB18030
   *      (ASCII punctuation is), but a multi-byte character that decodes
   *      cleanly as UTF-8 is overwhelmingly likely to be UTF-8, and the reverse
   *      is not true.
   *   2. Otherwise fall back to GB18030, which covers GBK and is what Alipay
   *      exports in.
   *
   * Presets that declare a non-UTF-8 encoding only affect step 2, so an Alipay
   * export is still read correctly while a UTF-8 file mislabelled as Alipay is
   * not mangled.
   */
  private decodeBuffer(
    buffer: Buffer,
    hint: 'utf8' | 'utf8-bom' | 'gb18030' | 'auto'
  ): { text: string; notice: string | null } {
    const asUtf8 = buffer.toString('utf8')
    const utf8IsValid = !asUtf8.includes('\uFFFD')

    // A BOM is a positive declaration of UTF-8, so trust it absolutely.
    const hasUtf8Bom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
    if (hasUtf8Bom) {
      return { text: stripBom(asUtf8), notice: null }
    }

    if (utf8IsValid) {
      const notice =
        hint === 'gb18030'
          ? 'The file is valid UTF-8, so it was read as UTF-8 rather than the GB18030 the selected format expects.'
          : null
      return { text: stripBom(asUtf8), notice }
    }

    // Invalid UTF-8: almost certainly GB18030 (a superset of GBK), which is what
    // Alipay exports use. This branch is only reachable for genuinely non-UTF-8
    // bytes, so declaring GB18030 in a preset cannot misfire on a UTF-8 file.
    try {
      const asGb = new TextDecoder('gb18030').decode(buffer)
      return {
        text: asGb,
        notice:
          hint === 'gb18030'
            ? null
            : 'The file was not valid UTF-8, so it was read as GB18030/GBK (typical for Alipay exports).'
      }
    } catch {
      throw new ImportError(
        'The file encoding could not be determined. Re-export it as UTF-8 CSV and try again.',
        'IMPORT_PARSE'
      )
    }
  }

  // -------------------------------------------------------------------------
  // Header mapping
  // -------------------------------------------------------------------------

  /**
   * Map each canonical field to a column index using the preset's aliases.
   * Returns -1 for fields with no matching column.
   *
   * MATCHING ORDER IS BY ALIAS SPECIFICITY, NOT STRING LENGTH.
   *
   * Sorting aliases by length looks reasonable and is wrong for CJK: WeChat's
   * transaction-kind header is four characters and the income/expense header is
   * three, so a length sort tries the kind column first and maps `type` onto it.
   * Every row would then be classified from the wrong cell and the real
   * income/expense column would never be read.
   *
   * The alias order declared in each preset is therefore authoritative: the most
   * specific, most important alias is listed first. See WECHAT_COLUMN_MAP, where
   * the income/expense header precedes the transaction-kind header for `type`.
   */
  private mapColumns(headers: string[], presetId: ImportPresetId): Record<CanonicalField, number> {
    const preset = getPreset(presetId)
    const columnMap = presetId === 'generic' ? GENERIC_COLUMN_MAP : preset.columnMap
    const normalized = headers.map((header) => normaliseForKey(header))

    const result = {} as Record<CanonicalField, number>
    for (const field of Object.keys(columnMap) as CanonicalField[]) {
      const aliases = columnMap[field]
      let index = -1

      // Pass 1: exact header match, in the preset's declared alias order.
      for (const alias of aliases) {
        const needle = normaliseForKey(alias)
        if (!needle) continue
        const found = normalized.findIndex((header) => header === needle)
        if (found !== -1) {
          index = found
          break
        }
      }

      // Pass 2: contains match, for headers carrying extra decoration such as
      // an amount column annotated with its unit.
      if (index === -1) {
        for (const alias of aliases) {
          const needle = normaliseForKey(alias)
          if (!needle) continue
          const found = normalized.findIndex((header) => header.includes(needle))
          if (found !== -1) {
            index = found
            break
          }
        }
      }

      result[field] = index
    }

    return result
  }

  // -------------------------------------------------------------------------
  // Preview
  // -------------------------------------------------------------------------

  /**
   * Parse a file into a reviewable preview. Writes NOTHING to the database.
   * The user's confirmation is what triggers `commit`.
   *
   * XLSX support is injected via `xlsxReader` rather than imported directly, so
   * this module stays free of the spreadsheet dependency (exceljs) and its
   * bundle weight when only CSV is used.
   */
  parse(
    filePath: string,
    presetId: ImportPresetId,
    options: { dayFirst?: boolean; currency?: string } = {}
  ): ImportPreview {
    const kind = this.detectKind(filePath)
    const fileName = basename(filePath)
    const notices: string[] = []

    let rawRows: string[][]
    if (kind === 'xlsx') {
      if (!this.xlsxReader) {
        throw new ImportError(
          'XLSX support is unavailable in this build. Save the sheet as CSV and import that instead.',
          'UNSUPPORTED'
        )
      }
      rawRows = this.xlsxReader(filePath)
      notices.push('Read the first worksheet of the workbook.')
    } else {
      rawRows = this.readCsvRows(filePath, presetId, notices)
    }

    return this.buildPreview({
      kind,
      fileName,
      presetId,
      rawRows,
      notices,
      dayFirst: options.dayFirst ?? true,
      currency: options.currency ?? 'MYR'
    })
  }

  /** Injected by the IPC layer so exceljs is only loaded when needed. */
  private xlsxReader: ((filePath: string) => string[][]) | null = null

  setXlsxReader(reader: (filePath: string) => string[][]): void {
    this.xlsxReader = reader
  }

  private readCsvRows(filePath: string, presetId: ImportPresetId, notices: string[]): string[][] {
    const buffer = readFileSync(filePath)
    const preset = getPreset(presetId)
    const { text, notice } = this.decodeBuffer(buffer, preset.encoding)
    if (notice) notices.push(notice)

    const delimiter = preset.delimiter ?? sniffDelimiter(text)
    if (delimiter !== ',') {
      notices.push(`Detected "${delimiter === '\t' ? 'tab' : delimiter}" as the column separator.`)
    }

    return parseDelimited(text, delimiter)
  }

  /** Shared pipeline: locate header, map columns, validate rows, detect duplicates. */
  buildPreview(input: {
    kind: ImportFileKind
    fileName: string
    presetId: ImportPresetId
    rawRows: string[][]
    notices: string[]
    dayFirst: boolean
    currency: string
    defaultAccountId?: number | null
  }): ImportPreview {
    const { kind, fileName, presetId, rawRows, notices, dayFirst, currency } = input

    const nonEmpty = rawRows.filter((row) => row.some((cell) => cleanCell(cell) !== ''))
    if (nonEmpty.length === 0) {
      return {
        kind,
        fileName,
        presetId,
        headers: [],
        rows: [],
        importableCount: 0,
        duplicateCount: 0,
        errorCount: 0,
        fatalError: 'The file contains no readable rows.',
        notices
      }
    }

    // Locate the header: scan first, fall back to the preset's declared offset.
    const keywords = HEADER_KEYWORDS[presetId] ?? HEADER_KEYWORDS.generic
    let headerIndex = findHeaderRow(nonEmpty, keywords, 2)
    if (headerIndex === -1) {
      const preset = getPreset(presetId)
      if (preset.skipRows > 0 && preset.skipRows < nonEmpty.length) {
        headerIndex = preset.skipRows
        notices.push(
          'The header row could not be identified automatically, so the preset\u2019s expected position was used.'
        )
      }
    }

    if (headerIndex === -1) {
      return {
        kind,
        fileName,
        presetId,
        headers: [],
        rows: [],
        importableCount: 0,
        duplicateCount: 0,
        errorCount: 0,
        fatalError:
          'The file format could not be recognized: no header row containing a date and an amount was found. Check that the file is a CSV or XLSX statement export.',
        notices
      }
    }

    const headers = nonEmpty[headerIndex].map((cell) => cleanCell(cell))
    const columns = this.mapColumns(headers, presetId)

    if (columns.date === -1) {
      return {
        kind,
        fileName,
        presetId,
        headers,
        rows: [],
        importableCount: 0,
        duplicateCount: 0,
        errorCount: 0,
        fatalError: `No date column was found. Expected one of the headers to look like a date column, but the file has: ${headers.filter(Boolean).join(', ')}.`,
        notices
      }
    }
    if (columns.amount === -1 && columns.debit === -1 && columns.credit === -1) {
      return {
        kind,
        fileName,
        presetId,
        headers,
        rows: [],
        importableCount: 0,
        duplicateCount: 0,
        errorCount: 0,
        fatalError: `No amount column was found. Expected a single amount column, or separate debit and credit columns. The file has: ${headers.filter(Boolean).join(', ')}.`,
        notices
      }
    }

    const dataRows = nonEmpty.slice(headerIndex + 1)
    const rows: ImportRow[] = []
    let stoppedAtFooter = false

    dataRows.forEach((cells, index) => {
      if (looksLikeFooter(cells)) {
        stoppedAtFooter = true
        return
      }
      rows.push(this.buildRow(cells, index, columns, presetId, { dayFirst, currency }))
    })

    if (stoppedAtFooter) {
      notices.push('Summary or footer rows were skipped.')
    }

    // Duplicate detection runs over the parsed rows.
    this.markDuplicates(rows, presetId)

    const importableCount = rows.filter((row) => row.errors.length === 0 && row.resolution === 'import').length
    const duplicateCount = rows.filter((row) => row.duplicateOf !== null).length
    const errorCount = rows.filter((row) => row.errors.length > 0).length

    if (rows.length > 0 && errorCount === rows.length) {
      notices.push('Every row had a problem. Check that the correct import preset is selected.')
    }

    return {
      kind,
      fileName,
      presetId,
      headers,
      rows,
      importableCount,
      duplicateCount,
      errorCount,
      fatalError: null,
      notices
    }
  }

  /** Convert one raw row into a validated ImportRow. */
  private buildRow(
    cells: string[],
    index: number,
    columns: Record<CanonicalField, number>,
    presetId: ImportPresetId,
    options: { dayFirst: boolean; currency: string }
  ): ImportRow {
    const errors: string[] = []
    const warnings: string[] = []

    const cell = (field: CanonicalField): string => {
      const at = columns[field]
      return at >= 0 ? cleanCell(cells[at]) : ''
    }

    // --- date ------------------------------------------------------------
    const rawDate = cell('date')
    const parsed = parseStatementDate(rawDate, options.dayFirst)
    if (!parsed.date) {
      errors.push(rawDate ? `Unrecognised date "${rawDate}".` : 'Missing date.')
    }

    // Prefer a dedicated time column; fall back to a time embedded in the date.
    const time = cell('time') ? (parseStatementDate(cell('time'), options.dayFirst).time ?? null) : parsed.time

    // --- description / merchant -----------------------------------------
    const description = cell('description')
    const merchant = description || null
    const note = cell('note') || null

    // --- status filtering -------------------------------------------------
    const status = cell('status')
    if (presetId === 'alipay' && status && ALIPAY_EXCLUDED_STATUS.some((value) => status.includes(value))) {
      warnings.push(`Skipped because its status is "${status}" 鈥?the order was never settled.`)
      // Mark as an error so it cannot be imported, but explain why.
      errors.push(`Order status "${status}" is not a completed transaction.`)
    }

    // --- amount -----------------------------------------------------------
    const typeCell = cell('type')
    const debit = cell('debit')
    const credit = cell('credit')
    const amountCell = cell('amount')

    let amountMinor: number | null = null
    let direction: 'income' | 'expense' | null = null

    if (debit || credit) {
      // Separate Debit/Credit columns: exactly one should be populated.
      const debitParsed = parseStatementAmount(debit)
      const creditParsed = parseStatementAmount(credit)

      if (debitParsed.minor !== null && debitParsed.minor !== 0) {
        amountMinor = debitParsed.minor
        direction = 'expense'
      } else if (creditParsed.minor !== null && creditParsed.minor !== 0) {
        amountMinor = creditParsed.minor
        direction = 'income'
      } else if (debitParsed.minor === 0 || creditParsed.minor === 0) {
        warnings.push('Zero amount, so this row was skipped.')
        errors.push('Amount is zero.')
      } else {
        errors.push('Neither the Debit nor the Credit column contained a number.')
      }
    } else if (amountCell) {
      const parsedAmount = parseStatementAmount(amountCell)
      if (parsedAmount.minor === null) {
        errors.push(`Unrecognised amount "${amountCell}".`)
      } else {
        amountMinor = parsedAmount.minor
        // Direction resolution order: the explicit 收/支 marker, then the sign.
        //
        // Comparison is by EQUALITY on the cell's own value, never a substring
        // test. '收/支' is the literal column HEADER, so a substring check would
        // match every row and mark the entire statement neutral — importing
        // nothing at all while reporting success.
        const marker = typeCell.trim()
        const neutral = marker !== '' && NEUTRAL_INCOME_EXPENSE_VALUES.includes(marker)
        const neutralType =
          presetId === 'wechat' &&
          NEUTRAL_TRANSACTION_TYPES.some((value) => cell('category').includes(value) || marker.includes(value))

        if (neutral || neutralType) {
          // Internal movement between the user's own accounts. Importing it as
          // income or expense would double-count against the bank leg.
          direction = null
          warnings.push(
            'This looks like a transfer between your own accounts, so it is not counted as income or expense.'
          )
          // MVP imports only income/expense; a neutral row is skipped.
          errors.push('Internal transfers from wallet exports are not imported yet.')
        } else if (classifyDirection(marker) === 'income') {
          direction = 'income'
        } else if (classifyDirection(marker) === 'expense') {
          direction = 'expense'
        } else if (ALIPAY_REFUND_STATUS.some((value) => status.includes(value)) || /退款/.test(cell('category'))) {
          direction = 'income'
        } else if (parsedAmount.negative) {
          direction = 'expense'
        } else if (marker === '' && !parsedAmount.negative) {
          // No type information and a positive number: the generic-CSV case.
          // Assume expense, which is what the overwhelming majority of
          // statement lines are, and flag it for the user to check.
          direction = 'expense'
          warnings.push('No income/expense marker was found, so this was assumed to be an expense.')
        } else {
          direction = 'expense'
        }
      }
    } else {
      errors.push('No amount column was mapped.')
    }

    if (amountMinor !== null && amountMinor === 0 && errors.length === 0) {
      errors.push('Amount is zero.')
    }

    return {
      index,
      date: parsed.date,
      time,
      description,
      merchant,
      amount: amountMinor,
      type: direction,
      categoryName: cell('category') || null,
      accountName: cell('account') || null,
      note,
      errors,
      warnings,
      duplicateOf: null,
      resolution: errors.length > 0 ? 'skip' : 'import'
    }
  }

  // -------------------------------------------------------------------------
  // Duplicate detection
  // -------------------------------------------------------------------------

  /**
   * Mark rows that collide with existing data.
   *
   * Two tiers:
   *   - exact: the content hash already exists in the database. The row is
   *     marked a duplicate and defaulted to `skip`.
   *   - fuzzy: same amount within +/- 3 days and a similar payee. Flagged for
   *     review only; never auto-skipped, because a false positive that silently
   *     drops a real transaction is worse than asking the user.
   */
  private markDuplicates(rows: ImportRow[], presetId: ImportPresetId): void {
    const existing = this.loadExistingCandidates()
    const byHash = new Map<string, ExistingCandidate>()
    for (const candidate of existing) {
      if (candidate.importHash) byHash.set(candidate.importHash, candidate)
    }

    const occurrences = new Map<string, number>()

    for (const row of rows) {
      if (row.errors.length > 0 || row.amount === null || row.date === null) continue

      const accountKey = row.accountName ?? 'default'
      const type = row.type ?? 'expense'

      // Tier 1: per-row occurrence counter for this batch.
      const baseKey = `${accountKey}|${row.date}|${row.amount}|${normaliseForKey(row.merchant)}|${type}`
      const occurrence = occurrences.get(baseKey) ?? 0
      occurrences.set(baseKey, occurrence + 1)

      const hash = hashImportRow({
        presetId,
        accountKey,
        date: row.date,
        amountMinor: row.amount,
        merchant: row.merchant,
        description: row.description,
        occurrenceIndex: occurrence
      })
      row.importHash = hash

      const exact = byHash.get(hash)
      if (exact) {
        row.duplicateOf = {
          transactionId: exact.id,
          reason: 'An identical transaction (same date, amount and description) is already recorded.',
          confidence: 1
        }
        row.resolution = 'skip'
        continue
      }

      // Tier 2: near matches for review.
      const fuzzy = this.findFuzzyMatch(row, existing)
      if (fuzzy) {
        row.duplicateOf = fuzzy
        // Deliberately left as 'import': the user decides.
        row.resolution = 'import'
      }
    }
  }

  private loadExistingCandidates(): ExistingCandidate[] {
    const rows = this.db
      .prepare(
        `SELECT id, date, amount, merchant, note, import_hash, source_id
         FROM transactions
         WHERE type IN ('income','expense')`
      )
      .all() as Array<{
      id: number
      date: string
      amount: number
      merchant: string | null
      note: string | null
      import_hash: string | null
      source_id: string | null
    }>

    return rows.map((row) => ({
      id: row.id,
      date: row.date,
      amount: row.amount,
      merchant: row.merchant,
      note: row.note,
      importHash: row.import_hash,
      sourceId: row.source_id
    }))
  }

  /**
   * Look for a likely-duplicate existing transaction: same magnitude within a
   * small date window and a coincidentally similar payee.
   *
   * The window exists because a card purchase can post a day or two after it was
   * made, so the statement date may not equal the recorded date.
   */
  private findFuzzyMatch(row: ImportRow, existing: ExistingCandidate[]): DuplicateMatch | null {
    if (row.amount === null || row.date === null) return null

    const magnitude = row.amount
    const rowDate = row.date
    const rowMerchant = normaliseForKey(row.merchant)

    let best: { candidate: ExistingCandidate; score: number } | null = null

    for (const candidate of existing) {
      if (Math.abs(candidate.amount) !== magnitude) continue
      if (dayDistance(rowDate, candidate.date) > 3) continue

      const candidateMerchant = normaliseForKey(candidate.merchant)
      let score = 0.5 // same amount and a close date already justifies a look
      if (rowMerchant && candidateMerchant) {
        if (rowMerchant === candidateMerchant) score = 1
        else if (rowMerchant.includes(candidateMerchant) || candidateMerchant.includes(rowMerchant)) score = 0.85
        else continue
      }

      if (!best || score > best.score) best = { candidate, score }
    }

    if (!best) return null

    return {
      transactionId: best.candidate.id,
      reason: `A transaction with the same amount exists on ${best.candidate.date}${best.candidate.merchant ? ` (${best.candidate.merchant})` : ''}.`,
      confidence: best.score
    }
  }

  // -------------------------------------------------------------------------
  // Commit
  // -------------------------------------------------------------------------

  /**
   * Write the confirmed rows to the database in a single transaction.
   *
   * All-or-nothing: if any part fails, the whole import rolls back and the user
   * is told nothing was saved. A partially applied import would leave the ledger
   * in a state the user cannot reason about.
   */
  commit(request: ImportCommitRequest, options: { currency?: string; defaultAccountId?: number | null } = {}): ImportCommitResult {
    const currency = options.currency ?? 'MYR'
    const rows = request.rows.filter((row) => row.errors.length === 0 && row.resolution === 'import')

    if (rows.length === 0 && request.rows.length > 0) {
      // Not an error: the user may have chosen to skip everything.
      return { batchId: 0, imported: 0, skipped: request.rows.length, createdCategories: [], rejectedDuplicates: 0 }
    }

    const createdCategories: string[] = []
    let rejectedDuplicates = 0

    const run = this.db.transaction((): ImportCommitResult => {
      const timestamp = nowIso()

      const batchInfo = this.db
        .prepare(
          `INSERT INTO import_batches (file_name, preset_id, file_hash, row_count, imported_count, skipped_count, created_at)
           VALUES (@fileName, @presetId, NULL, @rowCount, 0, 0, @createdAt)`
        )
        .run({
          fileName: request.fileName,
          presetId: request.presetId,
          rowCount: request.rows.length,
          createdAt: timestamp
        })

      const batchId = Number(batchInfo.lastInsertRowid)

      const insert = this.db.prepare(
        `INSERT INTO transactions
           (account_id, type, amount, category_id, date, time, merchant, note,
            import_batch_id, source_id, import_hash, created_at, updated_at)
         VALUES
           (@accountId, @type, @amount, @categoryId, @date, @time, @merchant, @note,
            @importBatchId, NULL, @importHash, @createdAt, @updatedAt)`
      )

      let imported = 0

      for (const row of rows) {
        if (row.date === null || row.amount === null || row.type === null) continue
        // Import handles income and expense only; transfers require two legs and
        // are recorded through the transfer form.
        if (row.type !== 'income' && row.type !== 'expense') continue
        const rowType: 'income' | 'expense' = row.type

        const accountId =
          (row.accountName ? this.deps.resolveAccount(row.accountName, currency) : null) ??
          request.defaultAccountId ??
          options.defaultAccountId ??
          null

        if (accountId === null) {
          throw new ValidationError(
            `Row ${row.index + 1} ("${row.description || 'no description'}") has no account, and no default account was chosen. Pick an account for the import and try again.`
          )
        }

        // Resolve the category, recording whether this call CREATED it. The
        // service returns that flag itself: checking for existence afterwards
        // would always find the row it had just inserted and report nothing.
        const resolved = this.deps.resolveCategory(row.categoryName, rowType, request.createMissingCategories)
        const categoryId = resolved.id
        if (resolved.created && row.categoryName) {
          const name = row.categoryName.trim()
          if (name && !createdCategories.includes(name)) createdCategories.push(name)
        }

        const signed = rowType === 'income' ? row.amount : -row.amount

        try {
          insert.run({
            accountId,
            type: rowType,
            amount: signed,
            categoryId,
            date: row.date,
            time: row.time,
            merchant: row.merchant,
            note: row.note,
            importBatchId: batchId,
            importHash: row.importHash ?? null,
            createdAt: timestamp,
            updatedAt: timestamp
          })
          imported += 1
        } catch (error) {
          // The partial UNIQUE index on import_hash is the final guard against a
          // duplicate that the pre-check missed.
          if (error instanceof Error && /UNIQUE constraint failed: transactions.import_hash/i.test(error.message)) {
            rejectedDuplicates += 1
            continue
          }
          throw error
        }
      }

      this.db
        .prepare('UPDATE import_batches SET imported_count = ?, skipped_count = ? WHERE id = ?')
        .run(imported, request.rows.length - imported, batchId)

      return {
        batchId,
        imported,
        skipped: request.rows.length - imported,
        createdCategories,
        rejectedDuplicates
      }
    })

    return run()
  }

  // -------------------------------------------------------------------------
  // Batch history
  // -------------------------------------------------------------------------

  listBatches(): ImportBatch[] {
    const rows = this.db
      .prepare('SELECT * FROM import_batches ORDER BY created_at DESC, id DESC LIMIT 100')
      .all() as ImportBatchRow[]
    return rows.map(mapImportBatch)
  }

  /**
   * Remove every transaction created by one import batch.
   *
   * The escape hatch for "I imported the wrong file". Only rows tagged with that
   * batch id are removed, so transactions the user added by hand are untouched.
   */
  rollbackBatch(batchId: number): { deleted: number } {
    const batch = this.db.prepare('SELECT id FROM import_batches WHERE id = ?').get(batchId) as
      | { id: number }
      | undefined
    if (!batch) throw new NotFoundError('Import batch', batchId)

    const run = this.db.transaction(() => {
      const result = this.db.prepare('DELETE FROM transactions WHERE import_batch_id = ?').run(batchId)
      this.db.prepare('DELETE FROM import_batches WHERE id = ?').run(batchId)
      return result.changes
    })

    return { deleted: run() }
  }

  // -------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------

  /** Rows for CSV export, reusing the transaction query so filters match the UI. */
  exportRows(query: Parameters<typeof buildExportQuery>[0]): TransactionWithRefs[] {
    const { sql, params } = buildExportQuery(query)
    const rows = this.db.prepare(sql).all(...params) as TransactionWithRefsRow[]
    return rows.map(mapTransactionWithRefs)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Content hash for duplicate detection.
 *
 * `occurrenceIndex` makes legitimate same-day same-amount repeats survive while
 * re-importing the identical file reproduces identical hashes.
 *
 * The hash deliberately excludes category and note: those are the fields a user
 * most often edits after import, and including them would make an edited row
 * look brand new and permit a duplicate on the next import.
 */
export function hashImportRow(input: {
  presetId: ImportPresetId
  accountKey: string
  date: string
  amountMinor: number
  merchant: string | null
  description: string
  occurrenceIndex: number
  sourceId?: string | null
}): string {
  // When the provider supplies a stable id, key on that alone. It is stable
  // across re-exports even if the description wording changes.
  const payload = input.sourceId
    ? `${input.presetId}|src|${input.accountKey}|${input.sourceId}`
    : [
        input.presetId,
        input.accountKey,
        input.date,
        String(input.amountMinor),
        normaliseForKey(input.merchant),
        normaliseForKey(input.description),
        String(input.occurrenceIndex)
      ].join('|')

  return createHash('sha256').update(payload).digest('hex')
}

function dayDistance(a: string, b: string): number {
  const da = Date.parse(`${a}T00:00:00Z`)
  const db = Date.parse(`${b}T00:00:00Z`)
  if (Number.isNaN(da) || Number.isNaN(db)) return Number.MAX_SAFE_INTEGER
  return Math.abs(Math.round((da - db) / 86_400_000))
}

/** Build the export SELECT. Kept separate so it can be unit tested. */
function buildExportQuery(query: {
  from?: string
  to?: string
  types?: string[]
  accountIds?: number[]
  search?: string
  limit?: number
}): { sql: string; params: unknown[] } {
  const clauses: string[] = []
  const params: unknown[] = []

  if (query.from) {
    clauses.push('t.date >= ?')
    params.push(query.from)
  }
  if (query.to) {
    clauses.push('t.date <= ?')
    params.push(query.to)
  }
  if (query.types && query.types.length > 0) {
    clauses.push(`t.type IN (${query.types.map(() => '?').join(', ')})`)
    params.push(...query.types)
  }
  if (query.accountIds && query.accountIds.length > 0) {
    clauses.push(`t.account_id IN (${query.accountIds.map(() => '?').join(', ')})`)
    params.push(...query.accountIds)
  }
  if (query.search && query.search.trim()) {
    const needle = `%${query.search.trim().toLowerCase()}%`
    clauses.push(`(LOWER(COALESCE(t.merchant,'')) LIKE ? OR LOWER(COALESCE(t.note,'')) LIKE ? OR LOWER(COALESCE(c.name,'')) LIKE ? OR LOWER(a.name) LIKE ?)`)
    params.push(needle, needle, needle, needle)
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  const limit = Math.min(query.limit ?? 100000, 200000)

  return {
    sql: `SELECT ${TRANSACTION_WITH_REFS_COLUMNS}
          FROM transactions t
          JOIN accounts a ON a.id = t.account_id
          LEFT JOIN categories c ON c.id = t.category_id
          ${where}
          ORDER BY t.date ASC, t.id ASC
          LIMIT ${limit}`,
    params
  }
}

/** Default currency scale used when formatting an export amount. */
export function exportAmount(minor: number, currency: string): string {
  const decimals = minorUnitsOf(currency)
  const negative = minor < 0
  const abs = Math.abs(minor)
  const scale = 10 ** decimals
  const whole = Math.floor(abs / scale)
  const frac = decimals > 0 ? `.${String(abs % scale).padStart(decimals, '0')}` : ''
  return `${negative ? '-' : ''}${whole}${frac}`
}
