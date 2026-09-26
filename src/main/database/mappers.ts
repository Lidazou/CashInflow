import type {
  Account,
  AccountType,
  AccountWithBalance,
  Budget,
  Category,
  CategoryType,
  ImportBatch,
  RecurringRule,
  RecurrenceFrequency,
  Subscription,
  BillingCycle,
  Transaction,
  TransactionType,
  TransactionWithRefs
} from '@shared/types'

/**
 * Row mappers: SQLite snake_case rows -> camelCase domain objects.
 *
 * Every read goes through one of these so the column naming convention stops at
 * this file. Booleans are converted here too: SQLite has no boolean type, so
 * they are stored as INTEGER 0/1 and would otherwise leak `0 | 1` into the UI,
 * where `if (account.archived)` on the number 0 happens to work but
 * `account.archived === false` silently does not.
 */

export interface AccountRow {
  id: number
  name: string
  type: string
  currency: string
  opening_balance: number
  color: string
  icon: string
  archived: number
  note: string | null
  sort_order: number
  created_at: string
  updated_at: string
}

export interface AccountWithBalanceRow extends AccountRow {
  balance: number | null
  transaction_count: number
}

export function mapAccount(row: AccountRow): Account {
  return {
    id: row.id,
    name: row.name,
    type: row.type as AccountType,
    currency: row.currency,
    openingBalance: row.opening_balance,
    color: row.color,
    icon: row.icon,
    archived: row.archived === 1,
    note: row.note,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function mapAccountWithBalance(row: AccountWithBalanceRow): AccountWithBalance {
  return {
    ...mapAccount(row),
    // A LEFT JOIN produces NULL for an account with no transactions, and SUM()
    // over zero rows is NULL rather than 0 — both must collapse to the opening
    // balance instead of leaking null into arithmetic.
    balance: row.opening_balance + (row.balance ?? 0),
    transactionCount: row.transaction_count ?? 0
  }
}

export interface CategoryRow {
  id: number
  name: string
  type: string
  icon: string
  color: string
  is_system: number
  sort_order: number
  created_at: string
}

export function mapCategory(row: CategoryRow): Category {
  return {
    id: row.id,
    name: row.name,
    type: row.type as CategoryType,
    icon: row.icon,
    color: row.color,
    isSystem: row.is_system === 1,
    sortOrder: row.sort_order,
    createdAt: row.created_at
  }
}

export interface TransactionRow {
  id: number
  account_id: number
  type: string
  amount: number
  category_id: number | null
  date: string
  time: string | null
  merchant: string | null
  note: string | null
  transfer_id: number | null
  import_batch_id: number | null
  source_id: string | null
  import_hash: string | null
  created_at: string
  updated_at: string
}

export function mapTransaction(row: TransactionRow): Transaction {
  return {
    id: row.id,
    accountId: row.account_id,
    type: row.type as TransactionType,
    amount: row.amount,
    categoryId: row.category_id,
    date: row.date,
    time: row.time,
    merchant: row.merchant,
    note: row.note,
    transferId: row.transfer_id,
    importBatchId: row.import_batch_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export interface TransactionWithRefsRow extends TransactionRow {
  account_name: string
  account_currency: string
  account_color: string
  category_name: string | null
  category_icon: string | null
  category_color: string | null
  counterpart_account_id: number | null
  counterpart_account_name: string | null
}

export function mapTransactionWithRefs(row: TransactionWithRefsRow): TransactionWithRefs {
  return {
    ...mapTransaction(row),
    accountName: row.account_name,
    accountCurrency: row.account_currency,
    accountColor: row.account_color,
    categoryName: row.category_name,
    categoryIcon: row.category_icon,
    categoryColor: row.category_color,
    counterpartAccountId: row.counterpart_account_id,
    counterpartAccountName: row.counterpart_account_name
  }
}

/**
 * Columns selected by every query that returns `TransactionWithRefs`.
 *
 * Centralised so the SELECT list and the mapper cannot drift apart — adding a
 * field to one and forgetting the other produces `undefined` in the UI, which
 * the spec explicitly forbids.
 *
 * The counterpart subquery resolves the *other* leg of a transfer by looking for
 * the sibling row that shares `transfer_id`. Without it the UI would show a
 * transfer as an anonymous "Transfer" with no indication of where the money went.
 */
export const TRANSACTION_WITH_REFS_COLUMNS = `
  t.id, t.account_id, t.type, t.amount, t.category_id, t.date, t.time,
  t.merchant, t.note, t.transfer_id, t.import_batch_id,
  t.source_id, t.import_hash, t.created_at, t.updated_at,
  a.name  AS account_name,
  a.currency AS account_currency,
  a.color AS account_color,
  c.name  AS category_name,
  c.icon  AS category_icon,
  c.color AS category_color,
  (SELECT a2.id   FROM transactions t2 JOIN accounts a2 ON a2.id = t2.account_id
    WHERE t2.transfer_id = t.transfer_id AND t2.id <> t.id LIMIT 1) AS counterpart_account_id,
  (SELECT a2.name FROM transactions t2 JOIN accounts a2 ON a2.id = t2.account_id
    WHERE t2.transfer_id = t.transfer_id AND t2.id <> t.id LIMIT 1) AS counterpart_account_name
`

export interface BudgetRow {
  id: number
  category_id: number | null
  period: string
  limit_amount: number
  currency: string
  created_at: string
  updated_at: string
}

export function mapBudget(row: BudgetRow): Budget {
  return {
    id: row.id,
    categoryId: row.category_id,
    period: 'monthly',
    limitAmount: row.limit_amount,
    currency: row.currency,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export interface SubscriptionRow {
  id: number
  name: string
  amount: number
  currency: string
  cycle: string
  next_charge_date: string | null
  account_id: number | null
  category_id: number | null
  active: number
  note: string | null
  created_at: string
  updated_at: string
}

export function mapSubscription(row: SubscriptionRow): Subscription {
  return {
    id: row.id,
    name: row.name,
    amount: row.amount,
    currency: row.currency,
    cycle: row.cycle as BillingCycle,
    nextChargeDate: row.next_charge_date,
    accountId: row.account_id,
    categoryId: row.category_id,
    active: row.active === 1,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export interface RecurringRuleRow {
  id: number
  label: string
  type: string
  amount: number
  account_id: number
  category_id: number | null
  merchant: string | null
  note: string | null
  frequency: string
  day_of_period: number
  month_of_year: number | null
  last_run_date: string | null
  next_due_date: string
  active: number
  created_at: string
  updated_at: string
}

export function mapRecurringRule(row: RecurringRuleRow): RecurringRule {
  return {
    id: row.id,
    label: row.label,
    type: row.type as 'income' | 'expense',
    amount: row.amount,
    accountId: row.account_id,
    categoryId: row.category_id,
    merchant: row.merchant,
    note: row.note,
    frequency: row.frequency as RecurrenceFrequency,
    dayOfPeriod: row.day_of_period,
    monthOfYear: row.month_of_year,
    lastRunDate: row.last_run_date,
    nextDueDate: row.next_due_date,
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export interface ImportBatchRow {
  id: number
  file_name: string
  preset_id: string
  file_hash: string | null
  row_count: number
  imported_count: number
  skipped_count: number
  created_at: string
}

export function mapImportBatch(row: ImportBatchRow): ImportBatch {
  return {
    id: row.id,
    fileName: row.file_name,
    presetId: row.preset_id,
    rowCount: row.row_count,
    importedCount: row.imported_count,
    skippedCount: row.skipped_count,
    createdAt: row.created_at
  }
}

/**
 * Convert a domain boolean to the 0/1 SQLite expects.
 * Passing `true` directly would be stored as the string 'true' by some drivers.
 */
export function boolToInt(value: boolean | undefined, fallback = false): number {
  return (value ?? fallback) ? 1 : 0
}
