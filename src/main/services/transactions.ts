import type { Database as SqliteDatabase } from 'better-sqlite3'
import { NotFoundError, ValidationError } from '@main/database/errors'
import {
  TRANSACTION_WITH_REFS_COLUMNS,
  mapTransaction,
  mapTransactionWithRefs,
  type TransactionRow,
  type TransactionWithRefsRow
} from '@main/database/mappers'
import type {
  PeriodTotals,
  SearchResult,
  Transaction,
  TransactionInput,
  TransactionPage,
  TransactionQuery,
  TransactionWithRefs,
  TransferInput
} from '@shared/types'
import { TRANSACTION_TYPES } from '@shared/types'
import { nowIso, today } from '@shared/lib/dates'
import {
  assertNoErrors,
  optionalText,
  optionalTime,
  requireAmount,
  requireDate,
  requireEnum,
  requireId,
  type FieldErrors
} from './validation'
import { combineCurrencyTotals } from './currency-aggregate'
import type { RateTable } from '@shared/lib/rates'
import { DEFAULT_CURRENCY } from '@shared/lib/money'
import type { AccountsService } from './accounts'
import type { CategoriesService } from './categories'

/**
 * The transaction ledger.
 *
 * SIGN CONVENTION — the single most important rule in this file
 * ------------------------------------------------------------
 * `transactions.amount` is a SIGNED integer in minor units. Positive credits the
 * account, negative debits it. An account's balance is then always
 * `opening_balance + SUM(amount)`, with no CASE expressions and no chance of a
 * query author forgetting that expenses are positive.
 *
 *   income        -> +amount
 *   expense       -> -amount
 *   transfer out  -> -amount
 *   transfer in   -> +amount
 *
 * TRANSFERS (spec §14)
 * --------------------
 * A transfer is TWO rows sharing a `transfers` header row and a `transfer_id`,
 * with `category_id` NULL and `type = 'transfer'`. This is the paired-row model
 * used by Actual Budget and Wealthfolio.
 *
 * The payoff: because both legs are typed 'transfer' (not 'expense'), every
 * income/expense aggregate filters `type IN ('income','expense')` and transfers
 * are excluded from spending *by construction*. There is no report-time special
 * case that someone can forget to add.
 *
 * Concretely, for Maybank -> Cash RM500:
 *     Maybank  -50000   (transfer leg)
 *     Cash     +50000   (transfer leg)
 *     monthly expense unchanged, total balance unchanged.
 */

export interface CreateTransferResult {
  transferId: number
  from: Transaction
  to: Transaction
}

export class TransactionsService {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly accounts: AccountsService,
    private readonly categories: CategoriesService
  ) {}

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /**
   * Build the shared WHERE clause for transaction queries.
   *
   * Every filter is parameterised. No value from the renderer is ever
   * interpolated into SQL text, so a merchant literally named
   * "'; DROP TABLE transactions; --" is just an unusual merchant name.
   */
  private buildFilter(query: TransactionQuery): { sql: string; params: unknown[] } {
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
      const valid = query.types.filter((type) => (TRANSACTION_TYPES as readonly string[]).includes(type))
      if (valid.length > 0) {
        clauses.push(`t.type IN (${valid.map(() => '?').join(', ')})`)
        params.push(...valid)
      }
    }
    if (query.accountIds && query.accountIds.length > 0) {
      clauses.push(`t.account_id IN (${query.accountIds.map(() => '?').join(', ')})`)
      params.push(...query.accountIds)
    }
    if (query.categoryIds && query.categoryIds.length > 0) {
      clauses.push(`t.category_id IN (${query.categoryIds.map(() => '?').join(', ')})`)
      params.push(...query.categoryIds)
    }
    if (typeof query.minAmount === 'number') {
      // Compare on magnitude so "amount between 10 and 50" matches both a RM30
      // expense (-3000) and a RM30 income (+3000), which is what a user means.
      clauses.push('ABS(t.amount) >= ?')
      params.push(Math.abs(query.minAmount))
    }
    if (typeof query.maxAmount === 'number') {
      clauses.push('ABS(t.amount) <= ?')
      params.push(Math.abs(query.maxAmount))
    }
    if (query.search && query.search.trim()) {
      // Search across merchant, note, category name and account name (spec §19).
      const needle = `%${query.search.trim().toLowerCase()}%`
      clauses.push(`(
        LOWER(COALESCE(t.merchant, '')) LIKE ?
        OR LOWER(COALESCE(t.note, '')) LIKE ?
        OR LOWER(COALESCE(c.name, '')) LIKE ?
        OR LOWER(a.name) LIKE ?
      )`)
      params.push(needle, needle, needle, needle)
    }

    return {
      sql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
      params
    }
  }

  private buildOrder(query: TransactionQuery): string {
    const dir = query.orderDir === 'asc' ? 'ASC' : 'DESC'
    switch (query.orderBy) {
      case 'amount':
        return `ORDER BY ABS(t.amount) ${dir}, t.date DESC`
      case 'created':
        return `ORDER BY t.created_at ${dir}, t.id ${dir}`
      case 'date':
      default:
        // `id` is the tiebreaker so pagination is stable when several rows share
        // a date; without it, LIMIT/OFFSET can repeat or skip rows.
        return `ORDER BY t.date ${dir}, COALESCE(t.time, '') ${dir}, t.id ${dir}`
    }
  }

  list(query: TransactionQuery = {}): TransactionPage {
    const filter = this.buildFilter(query)
    const order = this.buildOrder(query)
    const limit = Math.min(Math.max(query.limit ?? 200, 1), 5000)
    const offset = Math.max(query.offset ?? 0, 0)

    const rows = this.db
      .prepare(
        `SELECT ${TRANSACTION_WITH_REFS_COLUMNS}
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         LEFT JOIN categories c ON c.id = t.category_id
         ${filter.sql}
         ${order}
         LIMIT ? OFFSET ?`
      )
      .all(...filter.params, limit, offset) as TransactionWithRefsRow[]

    // Count separately: the page size must not change the reported total.
    const total = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n
           FROM transactions t
           JOIN accounts a ON a.id = t.account_id
           LEFT JOIN categories c ON c.id = t.category_id
           ${filter.sql}`
        )
        .get(...filter.params) as { n: number }
    ).n

    return { items: rows.map(mapTransactionWithRefs), total }
  }

  get(id: number): TransactionWithRefs {
    const row = this.db
      .prepare(
        `SELECT ${TRANSACTION_WITH_REFS_COLUMNS}
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         LEFT JOIN categories c ON c.id = t.category_id
         WHERE t.id = ?`
      )
      .get(id) as TransactionWithRefsRow | undefined
    if (!row) throw new NotFoundError('Transaction', id)
    return mapTransactionWithRefs(row)
  }

  /** Every day in a month that has at least one transaction, with per-day totals. */
  listForDateRange(from: string, to: string, query: Omit<TransactionQuery, 'from' | 'to'> = {}): TransactionWithRefs[] {
    return this.list({ ...query, from, to, limit: 5000 }).items
  }

  // -------------------------------------------------------------------------
  // Validation shared by create/update
  // -------------------------------------------------------------------------

  private validateCommon(input: TransactionInput, errors: FieldErrors): { date: string; time: string | null } {
    const accountId = requireId(errors, 'accountId', input.accountId, { label: 'Account' })
    if (accountId) this.accounts.assertExists(accountId)

    const type = requireEnum(errors, 'type', input.type, TRANSACTION_TYPES, { label: 'Type' })
    if (type === 'transfer') {
      // Transfers must go through createTransfer so both legs stay in sync.
      errors.type = 'Use the transfer form so both accounts are updated.'
    }

    requireAmount(errors, 'amount', input.amount, { label: 'Amount' })

    if (input.categoryId !== null && input.categoryId !== undefined) {
      const categoryId = requireId(errors, 'categoryId', input.categoryId, { label: 'Category' })
      if (categoryId) {
        const category = this.categories.assertExists(categoryId)
        // An expense filed under an income category would make the category
        // breakdown contradict the month totals.
        if (category.type !== type) {
          errors.categoryId = `"${category.name}" is an ${category.type} category and cannot be used for an ${type}.`
        }
      }
    }

    const date = requireDate(errors, 'date', input.date)
    const time = optionalTime(errors, 'time', input.time)
    return { date, time }
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  create(input: TransactionInput): TransactionWithRefs {
    const errors: FieldErrors = {}
    const { date, time } = this.validateCommon(input, errors)
    const merchant = optionalText(errors, 'merchant', input.merchant, { label: 'Merchant', max: 120 })
    const note = optionalText(errors, 'note', input.note, { label: 'Note', max: 500 })
    assertNoErrors(errors, 'The transaction could not be saved because some details are invalid.')

    const amount = Math.abs(input.amount)
    const signed = input.type === 'income' ? amount : -amount
    const timestamp = nowIso()

    const info = this.db
      .prepare(
        `INSERT INTO transactions
           (account_id, type, amount, category_id, date, time, merchant, note, created_at, updated_at)
         VALUES
           (@accountId, @type, @amount, @categoryId, @date, @time, @merchant, @note, @createdAt, @updatedAt)`
      )
      .run({
        accountId: input.accountId,
        type: input.type,
        amount: signed,
        categoryId: input.categoryId ?? null,
        date,
        time,
        merchant,
        note,
        createdAt: timestamp,
        updatedAt: timestamp
      })

    return this.get(Number(info.lastInsertRowid))
  }

  /**
   * Update a transaction.
   *
   * Changing an already-paired transfer leg back into an income/expense is
   * rejected: it would leave an orphaned `transfers` row and a half-transfer.
   * To restructure a transfer the user deletes it and re-adds it.
   */
  update(id: number, input: Partial<TransactionInput>): TransactionWithRefs {
    const existing = this.get(id)

    if (existing.type === 'transfer') {
      throw new ValidationError(
        'This row is one half of a transfer. Edit the transfer itself so both accounts stay consistent, or delete it and record a new transaction.'
      )
    }

    const merged: TransactionInput = {
      accountId: input.accountId ?? existing.accountId,
      type: (input.type ?? existing.type) as TransactionInput['type'],
      amount: input.amount ?? Math.abs(existing.amount),
      categoryId: input.categoryId === undefined ? existing.categoryId : input.categoryId,
      date: input.date ?? existing.date,
      time: input.time === undefined ? existing.time : input.time,
      merchant: input.merchant === undefined ? existing.merchant : input.merchant,
      note: input.note === undefined ? existing.note : input.note
    }

    const errors: FieldErrors = {}
    const { date, time } = this.validateCommon(merged, errors)
    const merchant = optionalText(errors, 'merchant', merged.merchant, { label: 'Merchant', max: 120 })
    const note = optionalText(errors, 'note', merged.note, { label: 'Note', max: 500 })
    assertNoErrors(errors, 'The transaction could not be saved because some details are invalid.')

    const amount = Math.abs(merged.amount)
    const signed = merged.type === 'income' ? amount : -amount

    this.db
      .prepare(
        `UPDATE transactions SET
           account_id = @accountId, type = @type, amount = @amount, category_id = @categoryId,
           date = @date, time = @time, merchant = @merchant, note = @note, updated_at = @updatedAt
         WHERE id = @id`
      )
      .run({
        id,
        accountId: merged.accountId,
        type: merged.type,
        amount: signed,
        categoryId: merged.categoryId ?? null,
        date,
        time,
        merchant,
        note,
        updatedAt: nowIso()
      })

    return this.get(id)
  }

  /**
   * Delete a transaction.
   *
   * Deleting either leg of a transfer removes both, because the `transfers` row
   * is deleted and `transactions.transfer_id` is ON DELETE CASCADE. Removing
   * only one side would leave money that left an account with nowhere recorded
   * as having arrived, and the user's total balance would silently drop.
   */
  remove(id: number): { deleted: true; deletedLegs: number } {
    const existing = this.get(id)

    if (existing.transferId !== null) {
      const legs = (
        this.db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE transfer_id = ?').get(existing.transferId) as {
          n: number
        }
      ).n
      this.db.prepare('DELETE FROM transfers WHERE id = ?').run(existing.transferId)
      return { deleted: true, deletedLegs: legs }
    }

    const result = this.db.prepare('DELETE FROM transactions WHERE id = ?').run(id)
    if (result.changes === 0) throw new NotFoundError('Transaction', id)
    return { deleted: true, deletedLegs: 1 }
  }

  // -------------------------------------------------------------------------
  // Transfers
  // -------------------------------------------------------------------------

  /**
   * Create a transfer: two signed legs plus one pairing row, atomically.
   *
   * The whole operation runs in a single SQLite transaction. If the second leg
   * fails, the first is rolled back — there is no window in which the ledger
   * contains money that left one account but never arrived in the other.
   */
  createTransfer(input: TransferInput): CreateTransferResult {
    const errors: FieldErrors = {}

    const fromAccountId = requireId(errors, 'fromAccountId', input.fromAccountId, { label: 'From account' })
    const toAccountId = requireId(errors, 'toAccountId', input.toAccountId, { label: 'To account' })
    const amount = requireAmount(errors, 'amount', input.amount, { label: 'Amount' })
    const date = requireDate(errors, 'date', input.date, { label: 'Date' })
    const time = optionalTime(errors, 'time', input.time)
    const note = optionalText(errors, 'note', input.note, { label: 'Note', max: 500 })

    // Spec §34: cannot transfer to yourself.
    if (fromAccountId && toAccountId && fromAccountId === toAccountId) {
      errors.toAccountId = 'The destination account must be different from the source account.'
    }

    let fromAccount = null
    let toAccount = null
    if (fromAccountId) fromAccount = this.accounts.assertExists(fromAccountId)
    if (toAccountId) toAccount = this.accounts.assertExists(toAccountId)

    // Amounts are stored as minor units whose scale depends on the currency, so
    // a transfer between accounts in different currencies cannot be represented
    // by one integer without an exchange rate the app does not have.
    if (fromAccount && toAccount && fromAccount.currency !== toAccount.currency) {
      errors.toAccountId = `Transfers between different currencies (${fromAccount.currency} to ${toAccount.currency}) need an exchange rate, which is not supported yet. Record two separate transactions instead.`
    }

    assertNoErrors(errors, 'The transfer could not be saved because some details are invalid.')

    const timestamp = nowIso()

    const run = this.db.transaction((): CreateTransferResult => {
      const transferInfo = this.db
        .prepare(
          `INSERT INTO transfers (from_account_id, to_account_id, amount, date, time, note, created_at, updated_at)
           VALUES (@fromAccountId, @toAccountId, @amount, @date, @time, @note, @createdAt, @updatedAt)`
        )
        .run({
          fromAccountId,
          toAccountId,
          amount,
          date,
          time,
          note,
          createdAt: timestamp,
          updatedAt: timestamp
        })

      const transferId = Number(transferInfo.lastInsertRowid)

      const insertLeg = this.db.prepare(
        `INSERT INTO transactions
           (account_id, type, amount, category_id, date, time, merchant, note, transfer_id, created_at, updated_at)
         VALUES
           (@accountId, 'transfer', @amount, NULL, @date, @time, NULL, @note, @transferId, @createdAt, @updatedAt)`
      )

      // Out leg: negative. In leg: positive. Same transfer_id, so deleting the
      // transfers row removes both via ON DELETE CASCADE.
      const outInfo = insertLeg.run({
        accountId: fromAccountId,
        amount: -amount,
        date,
        time,
        note,
        transferId,
        createdAt: timestamp,
        updatedAt: timestamp
      })

      const inInfo = insertLeg.run({
        accountId: toAccountId,
        amount,
        date,
        time,
        note,
        transferId,
        createdAt: timestamp,
        updatedAt: timestamp
      })

      return {
        transferId,
        from: this.getPlain(Number(outInfo.lastInsertRowid)),
        to: this.getPlain(Number(inInfo.lastInsertRowid))
      }
    })

    return run()
  }

  updateTransfer(id: number, input: Partial<TransferInput>): CreateTransferResult {
    const existing = this.get(id)
    if (existing.transferId === null) {
      throw new ValidationError('That transaction is not part of a transfer.')
    }

    const header = this.db
      .prepare('SELECT * FROM transfers WHERE id = ?')
      .get(existing.transferId) as
      | {
          id: number
          from_account_id: number
          to_account_id: number
          amount: number
          date: string
          time: string | null
          note: string | null
        }
      | undefined
    if (!header) throw new NotFoundError('Transfer', existing.transferId)

    const merged: TransferInput = {
      fromAccountId: input.fromAccountId ?? header.from_account_id,
      toAccountId: input.toAccountId ?? header.to_account_id,
      amount: input.amount ?? header.amount,
      date: input.date ?? header.date,
      time: input.time === undefined ? header.time : input.time,
      note: input.note === undefined ? header.note : input.note
    }

    // Reuse create's validation, then rewrite both legs in one transaction.
    const errors: FieldErrors = {}
    const fromAccountId = requireId(errors, 'fromAccountId', merged.fromAccountId, { label: 'From account' })
    const toAccountId = requireId(errors, 'toAccountId', merged.toAccountId, { label: 'To account' })
    const amount = requireAmount(errors, 'amount', merged.amount, { label: 'Amount' })
    const date = requireDate(errors, 'date', merged.date, { label: 'Date' })
    const time = optionalTime(errors, 'time', merged.time)
    const note = optionalText(errors, 'note', merged.note, { label: 'Note', max: 500 })

    if (fromAccountId && toAccountId && fromAccountId === toAccountId) {
      errors.toAccountId = 'The destination account must be different from the source account.'
    }
    let fromAccount = null
    let toAccount = null
    if (fromAccountId) fromAccount = this.accounts.assertExists(fromAccountId)
    if (toAccountId) toAccount = this.accounts.assertExists(toAccountId)
    if (fromAccount && toAccount && fromAccount.currency !== toAccount.currency) {
      errors.toAccountId = `Transfers between different currencies (${fromAccount.currency} to ${toAccount.currency}) are not supported.`
    }
    assertNoErrors(errors, 'The transfer could not be saved because some details are invalid.')

    const transferId = header.id
    const timestamp = nowIso()

    const run = this.db.transaction((): CreateTransferResult => {
      this.db
        .prepare(
          `UPDATE transfers SET from_account_id = @fromAccountId, to_account_id = @toAccountId,
             amount = @amount, date = @date, time = @time, note = @note, updated_at = @updatedAt
           WHERE id = @id`
        )
        .run({
          id: transferId,
          fromAccountId,
          toAccountId,
          amount,
          date,
          time,
          note,
          updatedAt: timestamp
        })

      // Rewrite legs deterministically: find the negative leg as the source and
      // the positive leg as the destination, rather than trusting row order.
      const legs = this.db
        .prepare('SELECT id, amount FROM transactions WHERE transfer_id = ? ORDER BY id ASC')
        .all(transferId) as Array<{ id: number; amount: number }>
      if (legs.length !== 2) {
        throw new ValidationError(
          `This transfer is corrupt: expected exactly 2 ledger rows but found ${legs.length}. Delete the transfer and record it again.`
        )
      }

      const outLeg = legs.find((leg) => leg.amount < 0) ?? legs[0]
      const inLeg = legs.find((leg) => leg.amount > 0) ?? legs[1]

      const updateLeg = this.db.prepare(
        `UPDATE transactions SET account_id = @accountId, amount = @amount, date = @date,
           time = @time, note = @note, updated_at = @updatedAt
         WHERE id = @id`
      )
      updateLeg.run({ id: outLeg.id, accountId: fromAccountId, amount: -amount, date, time, note, updatedAt: timestamp })
      updateLeg.run({ id: inLeg.id, accountId: toAccountId, amount, date, time, note, updatedAt: timestamp })

      return { transferId, from: this.getPlain(outLeg.id), to: this.getPlain(inLeg.id) }
    })

    return run()
  }

  /** Delete a transfer and both its legs. */
  removeTransfer(id: number): { deleted: true; deletedLegs: number } {
    return this.remove(id)
  }

  private getPlain(id: number): Transaction {
    const row = this.db.prepare('SELECT * FROM transactions WHERE id = ?').get(id) as TransactionRow | undefined
    if (!row) throw new NotFoundError('Transaction', id)
    return mapTransaction(row)
  }

  // -------------------------------------------------------------------------
  // Aggregates
  // -------------------------------------------------------------------------

  /**
   * Income / expense / net totals for a date range.
   *
   * `type IN ('income','expense')` is what keeps transfers out of the figures —
   * see the class comment. `amount` is signed, so expense totals are negated
   * back to a positive magnitude for display.
   */
  totals(from: string, to: string, query: Omit<TransactionQuery, 'from' | 'to'> = {}): PeriodTotals {
    const filter = this.buildFilter({ ...query, from, to })
    const row = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN t.type = 'income'  THEN t.amount ELSE 0 END), 0) AS income,
           COALESCE(SUM(CASE WHEN t.type = 'expense' THEN t.amount ELSE 0 END), 0) AS expense,
           COALESCE(SUM(CASE WHEN t.type IN ('income','expense') THEN 1 ELSE 0 END), 0) AS count
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         LEFT JOIN categories c ON c.id = t.category_id
         ${filter.sql}`
      )
      .get(...filter.params) as { income: number; expense: number; count: number }

    // expense is stored negative; report it as a positive magnitude.
    const expense = Math.abs(row.expense)
    return {
      income: row.income,
      expense,
      net: row.income - expense,
      transactionCount: row.count
    }
  }

  /**
   * Global transaction search (spec §19).
   *
   * Searches merchant, note, category and account, and returns the matching
   * total alongside the rows so the UI can show "Total RM81.00" without a second
   * round trip.
   *
   * The total is computed over ALL matches, not just the returned page — a total
   * that silently described only page 1 would be actively misleading.
   */
  search(
    query: TransactionQuery,
    displayCurrency: string = DEFAULT_CURRENCY,
    rates: RateTable | null = null
  ): SearchResult {
    const page = this.list({ ...query, limit: query.limit ?? 500 })

    const filter = this.buildFilter(query)

    // Grouped by currency, then converted once. A single SUM over t.amount would
    // add fen to sen the moment a user holds accounts in two currencies, and the
    // result would look entirely plausible.
    const rows = this.db
      .prepare(
        `SELECT
           a.currency AS currency,
           COALESCE(SUM(CASE WHEN t.type = 'income'  THEN t.amount ELSE 0 END), 0) AS income,
           COALESCE(SUM(CASE WHEN t.type = 'expense' THEN t.amount ELSE 0 END), 0) AS expense,
           COALESCE(SUM(CASE WHEN t.type IN ('income','expense') THEN 1 ELSE 0 END), 0) AS count
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         LEFT JOIN categories c ON c.id = t.category_id
         ${filter.sql}
         GROUP BY a.currency`
      )
      .all(...filter.params) as Array<{
      currency: string
      income: number
      expense: number
      count: number
    }>

    const combined = combineCurrencyTotals(
      rows.map((row) => ({
        currency: row.currency,
        income: row.income,
        expense: Math.abs(row.expense),
        transactionCount: row.count
      })),
      displayCurrency,
      rates
    )

    return {
      items: page.items,
      total: page.total,
      totals: combined.totals
    }
  }

  countAll(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n
  }

  /** The most recent transaction date, used for empty-state and defaults. */
  latestDate(): string | null {
    const row = this.db.prepare('SELECT MAX(date) AS d FROM transactions').get() as { d: string | null }
    return row.d ?? today()
  }
}
