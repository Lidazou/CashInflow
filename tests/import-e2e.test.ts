import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type DatabaseHandle } from '@main/database/connection'
import { Services } from '@main/services'
import type { ImportPresetId } from '@shared/types'

/**
 * End-to-end import tests (spec §38, acceptance Tests 6 and 7).
 *
 * These write REAL files to disk and run the REAL pipeline against a REAL SQLite
 * database. Import is the one feature where mocking would prove nothing: the
 * failures that matter (a footer imported as a transaction, a re-import doubling
 * spending, a GBK file read as UTF-8) only appear when bytes meet the parser.
 */

let handle: DatabaseHandle
let services: Services
let workDir: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'spendwise-import-'))
  handle = openDatabase({ dataDir: workDir })
  services = new Services(handle.db)
})

afterEach(() => {
  handle.close()
  rmSync(workDir, { recursive: true, force: true })
})

/** Write a CSV fixture and return its path. */
function fixture(name: string, content: string): string {
  const path = join(workDir, name)
  writeFileSync(path, content, 'utf8')
  return path
}

/**
 * Encode a string as GB18030 bytes for a test fixture.
 *
 * Node ships a GB18030 DECODER (via full-icu) but no encoder, and the importer
 * only ever decodes, so the round trip is proven by decoding each produced byte
 * pair back and checking it matches the intended character. ASCII passes through
 * unchanged, which covers the CSV punctuation and digits.
 */
function encodeGb18030(text: string): Buffer {
  const decoder = new TextDecoder('gb18030')
  const bytes: number[] = []

  for (const char of text) {
    const codePoint = char.codePointAt(0) as number
    if (codePoint < 0x80) {
      bytes.push(codePoint)
      continue
    }

    // Find the GB18030 byte sequence whose decode is this character. Range
    // covers the CJK BMP block used by these fixtures.
    let found = false
    for (let lead = 0x81; lead <= 0xfe && !found; lead += 1) {
      for (let trail = 0x40; trail <= 0xfe && !found; trail += 1) {
        if (trail === 0x7f) continue
        const candidate = Buffer.from([lead, trail])
        if (decoder.decode(candidate) === char) {
          bytes.push(lead, trail)
          found = true
        }
      }
    }
    if (!found) throw new Error(`No GB18030 encoding found for ${char}`)
  }

  return Buffer.from(bytes)
}

function parseAndCommit(path: string, presetId: ImportPresetId = 'generic') {
  const preview = services.imports.parse(path, presetId)
  const committed = services.imports.commit(
    {
      fileName: preview.fileName,
      presetId,
      rows: preview.rows.filter((row) => row.errors.length === 0 && row.resolution === 'import'),
      defaultAccountId: null,
      createMissingCategories: true
    },
    { currency: 'MYR' }
  )
  return { preview, committed }
}

describe('generic CSV import (acceptance Test 6)', () => {
  const csv = [
    'Date,Description,Amount,Type,Category,Account',
    '2026-09-01,Lunch,-20.00,Expense,Food,Maybank',
    '2026-09-02,Salary,3000.00,Income,Salary,Maybank',
    '2026-09-03,Grab,-18.50,Expense,Transport,Maybank'
  ].join('\n')

  it('imports rows into the database with correct signs and totals', () => {
    const account = services.accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 0 })
    const { preview, committed } = parseAndCommit(fixture('generic.csv', csv))

    expect(preview.fatalError).toBeNull()
    expect(preview.rows).toHaveLength(3)
    expect(preview.errorCount).toBe(0)
    expect(committed.imported).toBe(3)

    const totals = services.transactions.totals('2026-09-01', '2026-09-30')
    expect(totals.income).toBe(300000)
    expect(totals.expense).toBe(3850) // 20.00 + 18.50
    expect(totals.net).toBe(300000 - 3850)

    // The ledger, not just the response, must be right.
    expect(services.accounts.get(account.id).balance).toBe(300000 - 3850)
  })

  it('creates categories that the file names but the database lacks', () => {
    services.accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 0 })
    const { committed } = parseAndCommit(
      fixture('newcat.csv', 'Date,Description,Amount,Type,Category,Account\n2026-09-01,Coffee,-5.00,Expense,Coffee Bar,Maybank')
    )
    expect(committed.createdCategories).toContain('Coffee Bar')
    expect(services.categories.list({ type: 'expense' }).some((c) => c.name === 'Coffee Bar')).toBe(true)
  })
})

describe('duplicate detection (acceptance Test 7)', () => {
  const csv = [
    'Date,Description,Amount,Type,Category,Account',
    '2026-09-26,Grab,-18.50,Expense,Transport,Maybank',
    '2026-09-22,Grab,-25.00,Expense,Transport,Maybank'
  ].join('\n')

  it('flags every row as a duplicate when the same file is imported twice', () => {
    services.accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 0 })
    const path = fixture('dup.csv', csv)

    const first = parseAndCommit(path)
    expect(first.committed.imported).toBe(2)
    expect(first.preview.duplicateCount).toBe(0)

    // Second import of the identical file: the content hash now collides.
    const preview = services.imports.parse(path, 'generic')
    expect(preview.duplicateCount).toBe(2)
    expect(preview.rows.every((row) => row.resolution === 'skip')).toBe(true)

    // Every row defaults to skip, so re-running the commit writes nothing.
    const second = services.imports.commit(
      {
        fileName: preview.fileName,
        presetId: 'generic',
        rows: preview.rows.filter((row) => row.resolution === 'import'),
        defaultAccountId: null,
        createMissingCategories: true
      },
      { currency: 'MYR' }
    )
    expect(second.imported).toBe(0)

    // Expense is still counted once, not twice. This is the whole point.
    expect(services.transactions.totals('2026-09-01', '2026-09-30').expense).toBe(4350)
  })

  it('keeps two genuine same-day same-amount transactions apart', () => {
    // Two RM4.50 coffees on the same day are NOT duplicates. The occurrence
    // counter in the hash is what makes this work.
    services.accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 0 })
    const path = fixture(
      'twocoffees.csv',
      [
        'Date,Description,Amount,Type,Category,Account',
        '2026-09-26,Kopitiam,-4.50,Expense,Food,Maybank',
        '2026-09-26,Kopitiam,-4.50,Expense,Food,Maybank'
      ].join('\n')
    )

    const first = parseAndCommit(path)
    expect(first.committed.imported).toBe(2)
    expect(services.transactions.totals('2026-09-01', '2026-09-30').expense).toBe(900)

    // Re-importing still recognises BOTH as duplicates.
    const again = services.imports.parse(path, 'generic')
    expect(again.duplicateCount).toBe(2)
  })

  it('rejects a duplicate that slips past the pre-check, via the unique index', () => {
    const account = services.accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 0 })
    const path = fixture('race.csv', 'Date,Description,Amount,Type,Account\n2026-09-26,Grab,-18.50,Expense,Maybank')

    const preview = services.imports.parse(path, 'generic')
    const row = preview.rows[0]
    const request = {
      fileName: 'race.csv',
      presetId: 'generic' as const,
      rows: [row],
      defaultAccountId: account.id,
      createMissingCategories: true
    }

    const first = services.imports.commit(request, { currency: 'MYR' })
    expect(first.imported).toBe(1)

    // Re-committing the SAME parsed row bypasses the duplicate pre-check (the
    // row still says 'import'), so the partial UNIQUE index on import_hash is
    // the last line of defence.
    const second = services.imports.commit(request, { currency: 'MYR' })
    expect(second.imported).toBe(0)
    expect(second.rejectedDuplicates).toBe(1)
    expect(services.transactions.totals('2026-09-01', '2026-09-30').expense).toBe(1850)
  })
})

describe('malformed and edge-case files', () => {
  it('reports a fatal error for an empty file instead of importing nothing silently', () => {
    const path = fixture('empty.csv', '')
    expect(() => services.imports.parse(path, 'generic')).toThrow(/empty/i)
  })

  it('reports a fatal error when the header cannot be found', () => {
    const path = fixture('noheader.csv', 'just,some\ntext,here\nnothing,useful')
    const preview = services.imports.parse(path, 'generic')
    expect(preview.fatalError).toMatch(/could not be recognized|no header|No date column/i)
    expect(preview.rows).toHaveLength(0)
  })

  it('reports a fatal error when there is no amount column', () => {
    const path = fixture('noamount.csv', 'Date,Description\n2026-09-26,Lunch')
    const preview = services.imports.parse(path, 'generic')
    expect(preview.fatalError).toMatch(/no amount column/i)
  })

  it('marks rows with an unparseable date as errors rather than importing them', () => {
    services.accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 0 })
    const path = fixture(
      'baddate.csv',
      ['Date,Description,Amount,Type,Account', 'not-a-date,Lunch,-20.00,Expense,Maybank', '2026-09-02,Ok,-5.00,Expense,Maybank'].join(
        '\n'
      )
    )
    const preview = services.imports.parse(path, 'generic')
    expect(preview.errorCount).toBe(1)
    expect(preview.importableCount).toBe(1)
    expect(preview.rows[0].errors.join(' ')).toMatch(/unrecognised date/i)
  })

  it('marks a row with a missing amount as an error', () => {
    const path = fixture('missingamount.csv', 'Date,Description,Amount,Type\n2026-09-26,Lunch,,Expense')
    const preview = services.imports.parse(path, 'generic')
    expect(preview.rows[0].errors.length).toBeGreaterThan(0)
    expect(preview.importableCount).toBe(0)
  })

  it('skips summary footer rows', () => {
    services.accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 0 })
    const path = fixture(
      'footer.csv',
      [
        'Date,Description,Amount,Type,Account',
        '2026-09-26,Lunch,-20.00,Expense,Maybank',
        '共2笔记录',
        '总计,-20.00'
      ].join('\n')
    )
    const preview = services.imports.parse(path, 'generic')
    expect(preview.rows).toHaveLength(1)
    expect(preview.rows.filter((row) => row.errors.length === 0)).toHaveLength(1)
  })

  it('handles a quoted description containing the delimiter', () => {
    services.accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 0 })
    const path = fixture(
      'quoted.csv',
      ['Date,Description,Amount,Type,Account', '2026-09-26,"Coffee, Tea & Co",-12.00,Expense,Maybank'].join('\n')
    )
    const preview = services.imports.parse(path, 'generic')
    expect(preview.rows[0].merchant).toBe('Coffee, Tea & Co')
    expect(preview.rows[0].amount).toBe(1200)
  })

  it('imports a file with separate Debit and Credit columns', () => {
    services.accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 0 })
    const path = fixture(
      'debitcredit.csv',
      [
        'Date,Transaction Description,Debit,Credit,Balance,Account',
        '26/09/2026,POS PURCHASE,18.50,,4981.50,Maybank',
        '25/09/2026,SALARY,,3000.00,5000.00,Maybank'
      ].join('\n')
    )
    const { preview, committed } = parseAndCommit(path, 'maybank')

    expect(preview.fatalError).toBeNull()
    expect(committed.imported).toBe(2)

    const totals = services.transactions.totals('2026-09-01', '2026-09-30')
    expect(totals.expense).toBe(1850)
    expect(totals.income).toBe(300000)
  })

  it('rejects a transfer to the same account', () => {
    const account = services.accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 100000 })
    expect(() =>
      services.transactions.createTransfer({
        fromAccountId: account.id,
        toAccountId: account.id,
        amount: 100,
        date: '2026-09-01'
      })
    ).toThrow(/different from the source/i)
  })

  it('does not import a zero-amount line', () => {
    services.accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 0 })
    const path = fixture(
      'zero.csv',
      ['Date,Description,Debit,Credit', '26/09/2026,NO MOVEMENT,0.00,0.00'].join('\n')
    )
    const preview = services.imports.parse(path, 'maybank')
    expect(preview.importableCount).toBe(0)
  })
})

describe('WeChat and Alipay presets', () => {
  it('parses a WeChat-style export with a 16-line preamble', () => {
    services.accounts.create({ name: 'WeChat', type: 'wallet', currency: 'MYR', openingBalance: 0 })
    const preamble = Array.from({ length: 16 }, (_, i) => `微信支付账单明细 行${i}`)
    const path = fixture(
      'wechat.csv',
      [
        ...preamble,
        '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注',
        '2026-09-26 14:05:00,商户消费,Some Shop,Item,支出,¥28.16,零钱,支付成功,10001,20001,',
        '2026-09-27 09:00:00,微信红包,Someone,红包,收入,¥50.0,零钱,已收钱,10002,20002,'
      ].join('\n')
    )

    const preview = services.imports.parse(path, 'wechat')
    expect(preview.fatalError).toBeNull()
    expect(preview.rows).toHaveLength(2)
    expect(preview.rows[0].date).toBe('2026-09-26')
    expect(preview.rows[0].time).toBe('14:05')
    expect(preview.rows[0].amount).toBe(2816)
    expect(preview.rows[0].type).toBe('expense')
    expect(preview.rows[1].amount).toBe(5000)
    expect(preview.rows[1].type).toBe('income')
  })

  it('does not count an internal wallet top-up as income or expense', () => {
    // 零钱充值 mirrors a bank movement. Counting it would double-count against
    // the bank leg the user also imports.
    services.accounts.create({ name: 'WeChat', type: 'wallet', currency: 'MYR', openingBalance: 0 })
    const preamble = Array.from({ length: 16 }, (_, i) => `微信支付账单明细 行${i}`)
    const path = fixture(
      'wechat-neutral.csv',
      [
        ...preamble,
        '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注',
        '2026-09-26 10:00:00,零钱充值,/零钱充值,充值,不计收支,¥500.00,中国银行,充值完成,10003,20003,'
      ].join('\n')
    )

    const preview = services.imports.parse(path, 'wechat')
    // It must not be importable as spending.
    expect(preview.importableCount).toBe(0)
    expect(preview.rows[0].type).toBeNull()
    expect(preview.rows[0].warnings.join(' ')).toMatch(/transfer between your own accounts/i)
  })

  it('excludes Alipay orders that were closed and never settled', () => {
    services.accounts.create({ name: 'Alipay', type: 'wallet', currency: 'MYR', openingBalance: 0 })
    const preamble = Array.from({ length: 24 }, (_, i) => `支付宝交易记录明细查询 行${i}`)
    const path = fixture(
      'alipay.csv',
      [
        ...preamble,
        '交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注,',
        '2026-09-26 12:00:00,餐饮美食,Some Shop,shop@example.com,Lunch,支出,28.00,余额宝,交易成功,30001,40001,,',
        '2026-09-26 13:00:00,日用百货,Other Shop,other@example.com,Item,支出,15.00,余额宝,交易关闭,30002,40002,,'
      ].join('\n')
    )

    const preview = services.imports.parse(path, 'alipay')
    expect(preview.fatalError).toBeNull()
    // The closed order is present but not importable, and says why.
    expect(preview.importableCount).toBe(1)
    expect(preview.errorCount).toBe(1)
    expect(preview.rows[1].errors.join(' ')).toMatch(/not a completed transaction/i)
  })

  it('reads a GBK-encoded file (Alipay exports are not UTF-8)', () => {
    // Written as GB18030 bytes on purpose: reading these as UTF-8 yields
    // replacement characters, which is exactly why the decoder sniffs instead of
    // assuming. There is no built-in GB18030 ENCODER in Node, so the bytes are
    // assembled from per-character lookups against a decoder-verified table.
    const csv = [
      '交易时间,交易分类,交易对方,商品说明,收/支,金额,交易状态',
      '2026-09-26 12:00:00,餐饮美食,海底捞,晚餐,支出,88.00,交易成功'
    ].join('\n')

    const path = join(workDir, 'alipay-gbk.csv')
    writeFileSync(path, encodeGb18030(csv))

    services.accounts.create({ name: 'Alipay', type: 'wallet', currency: 'MYR', openingBalance: 0 })
    const preview = services.imports.parse(path, 'alipay')

    expect(preview.fatalError).toBeNull()
    expect(preview.rows).toHaveLength(1)
    expect(preview.rows[0].merchant).toBe('海底捞')
    expect(preview.rows[0].amount).toBe(8800)
  })
})

describe('import batch history and rollback', () => {
  it('lists batches and rolls one back without touching manual entries', () => {
    const account = services.accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 0 })
    const path = fixture('batch.csv', 'Date,Description,Amount,Type,Account\n2026-09-26,Grab,-18.50,Expense,Maybank')

    const { committed } = parseAndCommit(path)
    expect(committed.imported).toBe(1)

    // A transaction the user added by hand, with no import batch.
    services.transactions.create({ accountId: account.id, type: 'expense', amount: 999, date: '2026-09-27' })

    const batches = services.imports.listBatches()
    expect(batches).toHaveLength(1)
    expect(batches[0].importedCount).toBe(1)

    const rolledBack = services.imports.rollbackBatch(committed.batchId)
    expect(rolledBack.deleted).toBe(1)

    // Only the imported row is gone; the manual one survives.
    expect(services.transactions.countAll()).toBe(1)
    expect(services.transactions.totals('2026-09-01', '2026-09-30').expense).toBe(999)
    expect(services.imports.listBatches()).toHaveLength(0)
  })
})

describe('import account resolution', () => {
  it('uses the default account when the file names none', () => {
    const account = services.accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 0 })
    const path = fixture('noaccount.csv', 'Date,Description,Amount,Type\n2026-09-26,Lunch,-20.00,Expense')
    const preview = services.imports.parse(path, 'generic')

    const committed = services.imports.commit(
      {
        fileName: preview.fileName,
        presetId: 'generic',
        rows: preview.rows,
        defaultAccountId: account.id,
        createMissingCategories: true
      },
      { currency: 'MYR' }
    )
    expect(committed.imported).toBe(1)
    expect(services.accounts.get(account.id).balance).toBe(-2000)
  })

  it('stops with a clear message when a row has no account and none was chosen', () => {
    services.accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 0 })
    services.accounts.create({ name: 'CIMB', type: 'bank', currency: 'MYR', openingBalance: 0 })
    const path = fixture('noaccount2.csv', 'Date,Description,Amount,Type\n2026-09-26,Lunch,-20.00,Expense')
    const preview = services.imports.parse(path, 'generic')

    expect(() =>
      services.imports.commit(
        {
          fileName: preview.fileName,
          presetId: 'generic',
          rows: preview.rows,
          defaultAccountId: null,
          createMissingCategories: true
        },
        { currency: 'MYR' }
      )
    ).toThrow(/has no account/i)

    // And nothing was written: the whole import is atomic.
    expect(services.transactions.countAll()).toBe(0)
  })
})
