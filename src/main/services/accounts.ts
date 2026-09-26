import type { Database as SqliteDatabase } from 'better-sqlite3'
import { InUseError, NotFoundError, ConflictError } from '@main/database/errors'
import {
  boolToInt,
  mapAccount,
  mapAccountWithBalance,
  type AccountRow,
  type AccountWithBalanceRow
} from '@main/database/mappers'
import type { Account, AccountInput, AccountWithBalance, CurrencyBalance } from '@shared/types'
import { nowIso } from '@shared/lib/dates'
import { validateAccountInput } from './validation'

/**
 * Account CRUD and balance queries.
 *
 * BALANCES ARE DERIVED, NEVER STORED (spec §10).
 *
 * `balance = opening_balance + SUM(transactions.amount)` where `amount` is
 * already signed. This is the single source of truth, so it is impossible for
 * the dashboard, the accounts page and the statistics page to disagree — they
 * all read the same computation.
 *
 * The alternative (a persisted running balance) is faster but introduces a
 * second copy of the truth that drifts the first time a write path forgets to
 * update it. At personal-ledger scale the SUM is trivially fast, so correctness
 * wins (spec §43: data correctness > everything).
 */

/** SQL fragment that yields each account's signed transaction total. */
const BALANCE_SUBQUERY = `
  COALESCE((
    SELECT SUM(t.amount)
    FROM transactions t
    WHERE t.account_id = a.id
  ), 0) AS balance,
  COALESCE((
    SELECT COUNT(*)
    FROM transactions t
    WHERE t.account_id = a.id
  ), 0) AS transaction_count
`

export class AccountsService {
  constructor(private readonly db: SqliteDatabase) {}

  list(options: { includeArchived?: boolean } = {}): AccountWithBalance[] {
    const where = options.includeArchived ? '' : 'WHERE a.archived = 0'
    const rows = this.db
      .prepare(
        `SELECT a.*, ${BALANCE_SUBQUERY}
         FROM accounts a
         ${where}
         ORDER BY a.sort_order ASC, a.name COLLATE NOCASE ASC`
      )
      .all() as AccountWithBalanceRow[]
    return rows.map(mapAccountWithBalance)
  }

  get(id: number): AccountWithBalance {
    const row = this.db
      .prepare(`SELECT a.*, ${BALANCE_SUBQUERY} FROM accounts a WHERE a.id = ?`)
      .get(id) as AccountWithBalanceRow | undefined
    if (!row) throw new NotFoundError('Account', id)
    return mapAccountWithBalance(row)
  }

  /** Throws when the account does not exist. Used to validate references. */
  assertExists(id: number): Account {
    const row = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as AccountRow | undefined
    if (!row) throw new NotFoundError('Account', id)
    return mapAccount(row)
  }

  create(input: AccountInput): AccountWithBalance {
    const data = validateAccountInput(input)
    this.assertNameAvailable(data.name, data.currency, null)

    const timestamp = nowIso()
    const nextOrder =
      data.sortOrder ||
      ((this.db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM accounts').get() as { n: number }).n ?? 0)

    const info = this.db
      .prepare(
        `INSERT INTO accounts
           (name, type, currency, opening_balance, color, icon, archived, note, sort_order, created_at, updated_at)
         VALUES
           (@name, @type, @currency, @openingBalance, @color, @icon, @archived, @note, @sortOrder, @createdAt, @updatedAt)`
      )
      .run({
        name: data.name,
        type: data.type,
        currency: data.currency,
        openingBalance: data.openingBalance,
        color: data.color,
        icon: data.icon,
        archived: boolToInt(data.archived),
        note: data.note,
        sortOrder: nextOrder,
        createdAt: timestamp,
        updatedAt: timestamp
      })

    return this.get(Number(info.lastInsertRowid))
  }

  /**
   * Update an account.
   *
   * Changing the currency is refused while the account has transactions: those
   * rows already store integer minor units that were interpreted in the old
   * currency, and reinterpreting 1850 sen as 1850 fen would silently restate the
   * user's entire history. The user is told to create a new account instead.
   */
  update(id: number, input: Partial<AccountInput>): AccountWithBalance {
    const existing = this.get(id)
    const merged = validateAccountInput({
      name: input.name ?? existing.name,
      type: input.type ?? existing.type,
      currency: input.currency ?? existing.currency,
      openingBalance: input.openingBalance ?? existing.openingBalance,
      color: input.color ?? existing.color,
      icon: input.icon ?? existing.icon,
      note: input.note === undefined ? existing.note : input.note,
      archived: input.archived ?? existing.archived,
      sortOrder: input.sortOrder ?? existing.sortOrder
    })

    if (merged.currency !== existing.currency && existing.transactionCount > 0) {
      throw new ConflictError(
        `${existing.name} already has ${existing.transactionCount} transaction(s). Changing its currency would reinterpret every stored amount, so it was not changed. Create a new account in ${merged.currency} instead.`,
        { currency: 'Cannot change currency on an account with transactions.' }
      )
    }

    this.assertNameAvailable(merged.name, merged.currency, id)

    this.db
      .prepare(
        `UPDATE accounts SET
           name = @name, type = @type, currency = @currency, opening_balance = @openingBalance,
           color = @color, icon = @icon, archived = @archived, note = @note,
           sort_order = @sortOrder, updated_at = @updatedAt
         WHERE id = @id`
      )
      .run({
        id,
        name: merged.name,
        type: merged.type,
        currency: merged.currency,
        openingBalance: merged.openingBalance,
        color: merged.color,
        icon: merged.icon,
        archived: boolToInt(merged.archived),
        note: merged.note,
        sortOrder: merged.sortOrder,
        updatedAt: nowIso()
      })

    return this.get(id)
  }

  /**
   * Delete an account.
   *
   * Refuses while transactions reference it, because `transactions.account_id`
   * is ON DELETE RESTRICT. Silently cascading would delete the user's financial
   * history as a side effect of tidying up an account list, which is never what
   * they meant. The caller can offer to archive instead.
   */
  remove(id: number): { deleted: true } {
    const account = this.get(id)
    if (account.transactionCount > 0) {
      throw new InUseError(
        `${account.name} still has ${account.transactionCount} transaction(s). Delete or move those first, or archive the account to hide it without losing history.`,
        { id: 'Account still has transactions.' }
      )
    }

    const result = this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id)
    if (result.changes === 0) throw new NotFoundError('Account', id)
    return { deleted: true }
  }

  archive(id: number, archived: boolean): AccountWithBalance {
    const existing = this.get(id)
    this.db.prepare('UPDATE accounts SET archived = ?, updated_at = ? WHERE id = ?').run(boolToInt(archived), nowIso(), id)
    return { ...existing, archived }
  }

  /**
   * Total balance grouped by currency.
   *
   * Deliberately NOT a single number. RM 5,000 and ¥5,000 are not the same
   * quantity, and adding them without an exchange rate would produce a figure
   * that looks authoritative and is meaningless. The UI shows one line per
   * currency and only promotes a single total when one currency is in play.
   */
  balancesByCurrency(): CurrencyBalance[] {
    const rows = this.db
      .prepare(
        `SELECT
           a.currency AS currency,
           COALESCE(SUM(a.opening_balance), 0) + COALESCE((
             SELECT SUM(t.amount) FROM transactions t
             JOIN accounts a2 ON a2.id = t.account_id
             WHERE a2.currency = a.currency
           ), 0) AS balance,
           COUNT(*) AS account_count
         FROM accounts a
         WHERE a.archived = 0
         GROUP BY a.currency
         ORDER BY balance DESC`
      )
      .all() as Array<{ currency: string; balance: number; account_count: number }>

    return rows.map((row) => ({
      currency: row.currency,
      balance: row.balance,
      accountCount: row.account_count
    }))
  }

  private assertNameAvailable(name: string, currency: string, excludeId: number | null): void {
    // `id <> ?` with a NULL bound parameter is NULL (never true), which would
    // silently match nothing when creating. Branch on the two cases instead of
    // relying on IS NOT with a possibly-null parameter.
    const row =
      excludeId === null
        ? (this.db.prepare('SELECT id FROM accounts WHERE name = ? AND currency = ?').get(name, currency) as
            | { id: number }
            | undefined)
        : (this.db
            .prepare('SELECT id FROM accounts WHERE name = ? AND currency = ? AND id <> ?')
            .get(name, currency, excludeId) as { id: number } | undefined)
    if (row) {
      throw new ConflictError(`An account named "${name}" already exists in ${currency}.`, {
        name: 'Already in use'
      })
    }
  }
}
