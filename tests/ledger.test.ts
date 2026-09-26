import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type DatabaseHandle } from '@main/database/connection'
import { AccountsService } from '@main/services/accounts'
import { CategoriesService } from '@main/services/categories'
import { TransactionsService } from '@main/services/transactions'

/**
 * Integration tests for the ledger, run against a real on-disk SQLite database.
 *
 * These are deliberately NOT mocked. The whole point is to exercise the actual
 * schema: CHECK constraints, foreign keys, ON DELETE CASCADE and the SUM
 * aggregate. A mocked database would happily agree with a buggy query.
 */

let handle: DatabaseHandle
let accounts: AccountsService
let categories: CategoriesService
let transactions: TransactionsService
let workDir: string

beforeEach(() => {
  // A real file (not :memory:) so WAL mode and the migration path are exercised.
  workDir = mkdtempSync(join(tmpdir(), 'spendwise-test-'))
  handle = openDatabase({ dataDir: workDir })
  accounts = new AccountsService(handle.db)
  categories = new CategoriesService(handle.db)
  transactions = new TransactionsService(handle.db, accounts, categories)
})

afterEach(() => {
  handle.close()
  rmSync(workDir, { recursive: true, force: true })
})

function categoryId(name: string, type: 'income' | 'expense'): number {
  const found = categories.list({ type }).find((c) => c.name === name)
  if (!found) throw new Error(`seed category ${name} (${type}) missing`)
  return found.id
}

describe('schema and migrations', () => {
  it('creates the schema and seeds the preset categories', () => {
    const version = handle.db.pragma('user_version', { simple: true })
    // Version 2 added the exchange-rate cache and custom statistics periods.
    expect(version).toBe(2)

    const expenses = categories.list({ type: 'expense' }).map((c) => c.name)
    const incomes = categories.list({ type: 'income' }).map((c) => c.name)

    expect(expenses).toEqual(
      expect.arrayContaining([
        'Food',
        'Transport',
        'Shopping',
        'Housing',
        'Entertainment',
        'Education',
        'Health',
        'Travel',
        'Bills',
        'Subscription',
        'Other'
      ])
    )
    expect(incomes).toEqual(
      expect.arrayContaining(['Salary', 'Freelance', 'Investment', 'Gift', 'Refund', 'Other'])
    )
  })

  it('enables foreign keys and WAL', () => {
    expect(handle.db.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(String(handle.db.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal')
  })

  it('is idempotent when reopened (migrations do not re-run)', () => {
    const before = categories.list().length
    handle.close()
    handle = openDatabase({ dataDir: workDir })
    categories = new CategoriesService(handle.db)
    expect(categories.list().length).toBe(before)
  })
})

describe('acceptance Test 1-3: account, expense, income', () => {
  it('reproduces the spec walkthrough exactly', () => {
    // Test 1: create Maybank with RM 5,000.
    const maybank = accounts.create({
      name: 'Maybank',
      type: 'bank',
      currency: 'MYR',
      openingBalance: 500000
    })
    expect(maybank.balance).toBe(500000)

    // Test 2: expense Food RM 20 -> balance RM 4,980.
    transactions.create({
      accountId: maybank.id,
      type: 'expense',
      amount: 2000,
      categoryId: categoryId('Food', 'expense'),
      date: '2026-09-26',
      merchant: 'Lunch'
    })
    expect(accounts.get(maybank.id).balance).toBe(498000)

    // Test 3: income Salary RM 3,000.
    transactions.create({
      accountId: maybank.id,
      type: 'income',
      amount: 300000,
      categoryId: categoryId('Salary', 'income'),
      date: '2026-09-26',
      merchant: 'Employer'
    })

    const totals = transactions.totals('2026-09-01', '2026-09-30')
    expect(totals.income).toBe(300000)
    expect(totals.expense).toBe(2000)
    expect(totals.net).toBe(298000)

    // Balance is derived from the account, not from income - expense.
    expect(accounts.get(maybank.id).balance).toBe(500000 - 2000 + 300000)
  })

  it('keeps the balance independent of the statistics month', () => {
    const acc = accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 500000 })
    // August expense must affect the balance but never the September report.
    transactions.create({ accountId: acc.id, type: 'expense', amount: 10000, date: '2026-08-15' })

    expect(accounts.get(acc.id).balance).toBe(490000)
    expect(transactions.totals('2026-09-01', '2026-09-30').expense).toBe(0)
  })
})

describe('acceptance Test 4: transfers never count as income or expense', () => {
  it('moves money without changing total balance or month expense', () => {
    const maybank = accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 500000 })
    const cash = accounts.create({ name: 'Cash', type: 'cash', currency: 'MYR', openingBalance: 0 })

    const result = transactions.createTransfer({
      fromAccountId: maybank.id,
      toAccountId: cash.id,
      amount: 50000,
      date: '2026-09-26'
    })

    // Maybank -500, Cash +500.
    expect(accounts.get(maybank.id).balance).toBe(450000)
    expect(accounts.get(cash.id).balance).toBe(50000)

    // Net worth change is zero — this is the crux of spec §14.
    const total = accounts.balancesByCurrency().find((b) => b.currency === 'MYR')!
    expect(total.balance).toBe(500000)

    // And RM500 must NOT appear as September spending.
    const totals = transactions.totals('2026-09-01', '2026-09-30')
    expect(totals.expense).toBe(0)
    expect(totals.income).toBe(0)
    expect(totals.net).toBe(0)
    expect(totals.transactionCount).toBe(0)

    // The two legs exist in the ledger.
    expect(result.from.amount).toBe(-50000)
    expect(result.to.amount).toBe(50000)
    expect(result.from.transferId).toBe(result.to.transferId)
  })

  it('writes both legs atomically and refuses a self-transfer', () => {
    const a = accounts.create({ name: 'A', type: 'bank', currency: 'MYR', openingBalance: 100000 })
    const b = accounts.create({ name: 'B', type: 'cash', currency: 'MYR', openingBalance: 0 })

    expect(() =>
      transactions.createTransfer({ fromAccountId: a.id, toAccountId: a.id, amount: 1000, date: '2026-09-26' })
    ).toThrow(/different from the source/i)

    transactions.createTransfer({ fromAccountId: a.id, toAccountId: b.id, amount: 2500, date: '2026-09-26' })
    const legs = transactions.list({ types: ['transfer'] })
    expect(legs.total).toBe(2)
  })

  it('deletes both legs together so balances stay coherent', () => {
    const a = accounts.create({ name: 'A', type: 'bank', currency: 'MYR', openingBalance: 100000 })
    const b = accounts.create({ name: 'B', type: 'cash', currency: 'MYR', openingBalance: 0 })
    const t = transactions.createTransfer({ fromAccountId: a.id, toAccountId: b.id, amount: 30000, date: '2026-09-26' })

    const result = transactions.remove(t.from.id)
    expect(result.deletedLegs).toBe(2)
    expect(transactions.list({ types: ['transfer'] }).total).toBe(0)
    expect(accounts.get(a.id).balance).toBe(100000)
    expect(accounts.get(b.id).balance).toBe(0)
  })

  it('rejects a transfer between different currencies', () => {
    const myr = accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 100000 })
    const cny = accounts.create({ name: 'Alipay', type: 'wallet', currency: 'CNY', openingBalance: 0 })
    expect(() =>
      transactions.createTransfer({ fromAccountId: myr.id, toAccountId: cny.id, amount: 1000, date: '2026-09-26' })
    ).toThrow(/different currencies/i)
  })

  it('resolves the counterpart account for display', () => {
    const a = accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 100000 })
    const b = accounts.create({ name: 'Cash', type: 'cash', currency: 'MYR', openingBalance: 0 })
    const t = transactions.createTransfer({ fromAccountId: a.id, toAccountId: b.id, amount: 5000, date: '2026-09-26' })

    const outLeg = transactions.get(t.from.id)
    const inLeg = transactions.get(t.to.id)
    expect(outLeg.counterpartAccountName).toBe('Cash')
    expect(inLeg.counterpartAccountName).toBe('Maybank')
  })
})

describe('money integrity in the database', () => {
  it('stores exact integers and sums exactly (spec §38)', () => {
    const acc = accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 0 })
    const food = categoryId('Food', 'expense')

    // 100.10 + 200.20 must be exactly 300.30 = 30030 minor units.
    transactions.create({ accountId: acc.id, type: 'expense', amount: 10010, categoryId: food, date: '2026-09-01' })
    transactions.create({ accountId: acc.id, type: 'expense', amount: 20020, categoryId: food, date: '2026-09-02' })

    const totals = transactions.totals('2026-09-01', '2026-09-30')
    expect(totals.expense).toBe(30030)
    expect(accounts.get(acc.id).balance).toBe(-30030)
  })

  it('keeps a 1000-row ledger of 0.10 exact', () => {
    const acc = accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 0 })
    const food = categoryId('Food', 'expense')
    const insert = handle.db.transaction(() => {
      for (let i = 0; i < 1000; i += 1) {
        transactions.create({ accountId: acc.id, type: 'expense', amount: 10, categoryId: food, date: '2026-09-01' })
      }
    })
    insert()

    expect(transactions.totals('2026-09-01', '2026-09-30').expense).toBe(10000)
    expect(accounts.get(acc.id).balance).toBe(-10000)
  })

  it('rejects a zero amount and a negative amount at the schema level', () => {
    const acc = accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 0 })
    expect(() => transactions.create({ accountId: acc.id, type: 'expense', amount: 0, date: '2026-09-01' })).toThrow(
      /greater than zero/i
    )
    expect(() => transactions.create({ accountId: acc.id, type: 'expense', amount: -500, date: '2026-09-01' })).toThrow(
      /cannot be negative/i
    )
  })

  it('rejects a non-integer amount rather than silently rounding it', () => {
    const acc = accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 0 })
    expect(() =>
      transactions.create({ accountId: acc.id, type: 'expense', amount: 18.5, date: '2026-09-01' })
    ).toThrow(/whole number/i)
  })
})

describe('validation', () => {
  it('rejects an unknown account', () => {
    expect(() =>
      transactions.create({ accountId: 9999, type: 'expense', amount: 100, date: '2026-09-01' })
    ).toThrow(/not found/i)
  })

  it('rejects an unknown category', () => {
    const acc = accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 0 })
    expect(() =>
      transactions.create({ accountId: acc.id, type: 'expense', amount: 100, categoryId: 9999, date: '2026-09-01' })
    ).toThrow(/not found/i)
  })

  it('rejects a category whose type contradicts the transaction type', () => {
    const acc = accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 0 })
    const salary = categoryId('Salary', 'income')
    // An expense filed under an income category would make the category
    // breakdown contradict the month totals.
    expect(() =>
      transactions.create({ accountId: acc.id, type: 'expense', amount: 100, categoryId: salary, date: '2026-09-01' })
    ).toThrow(/income category/i)
    expect(() =>
      transactions.create({ accountId: acc.id, type: 'expense', amount: 100, categoryId: salary, date: '2026-09-01' })
    ).toThrow(/cannot be used for an expense/i)
  })

  it('rejects an invalid date and time', () => {
    const acc = accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 0 })
    expect(() =>
      transactions.create({ accountId: acc.id, type: 'expense', amount: 100, date: '2026-02-31' })
    ).toThrow(/valid date/i)
    expect(() =>
      transactions.create({ accountId: acc.id, type: 'expense', amount: 100, date: '2026-09-01', time: '25:00' })
    ).toThrow(/HH:MM/i)
  })

  it('rejects a duplicate account name in the same currency', () => {
    accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 0 })
    expect(() => accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 0 })).toThrow(
      /already exists/i
    )
    // The same name in a different currency is legitimate.
    expect(() => accounts.create({ name: 'Maybank', type: 'bank', currency: 'CNY', openingBalance: 0 })).not.toThrow()
  })
})

describe('acceptance Test 8-9: edits and deletes propagate to aggregates', () => {
  it('updates the dashboard figures after an edit', () => {
    const acc = accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 0 })
    const food = categoryId('Food', 'expense')
    const tx = transactions.create({
      accountId: acc.id,
      type: 'expense',
      amount: 2000,
      categoryId: food,
      date: '2026-09-10'
    })

    expect(accounts.get(acc.id).balance).toBe(-2000)
    expect(transactions.totals('2026-09-01', '2026-09-30').expense).toBe(2000)

    // Change RM20 -> RM35.
    transactions.update(tx.id, { amount: 3500 })

    expect(accounts.get(acc.id).balance).toBe(-3500)
    expect(transactions.totals('2026-09-01', '2026-09-30').expense).toBe(3500)
  })

  it('moves a transaction between months and re-buckets the statistics', () => {
    const acc = accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 0 })
    const tx = transactions.create({ accountId: acc.id, type: 'expense', amount: 5000, date: '2026-09-30' })
    expect(transactions.totals('2026-09-01', '2026-09-30').expense).toBe(5000)

    transactions.update(tx.id, { date: '2026-10-01' })
    expect(transactions.totals('2026-09-01', '2026-09-30').expense).toBe(0)
    expect(transactions.totals('2026-10-01', '2026-10-31').expense).toBe(5000)
  })

  it('updates the balance after a delete', () => {
    const acc = accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 100000 })
    const tx = transactions.create({ accountId: acc.id, type: 'expense', amount: 2500, date: '2026-09-10' })
    expect(accounts.get(acc.id).balance).toBe(97500)

    transactions.remove(tx.id)
    expect(accounts.get(acc.id).balance).toBe(100000)
    expect(transactions.totals('2026-09-01', '2026-09-30').expense).toBe(0)
  })

  it('refuses to edit a transfer leg directly', () => {
    const a = accounts.create({ name: 'A', type: 'bank', currency: 'MYR', openingBalance: 100000 })
    const b = accounts.create({ name: 'B', type: 'cash', currency: 'MYR', openingBalance: 0 })
    const t = transactions.createTransfer({ fromAccountId: a.id, toAccountId: b.id, amount: 1000, date: '2026-09-01' })
    expect(() => transactions.update(t.from.id, { amount: 5000 })).toThrow(/half of a transfer/i)
  })

  it('re-syncs both legs when a transfer is edited', () => {
    const a = accounts.create({ name: 'A', type: 'bank', currency: 'MYR', openingBalance: 100000 })
    const b = accounts.create({ name: 'B', type: 'cash', currency: 'MYR', openingBalance: 0 })
    const c = accounts.create({ name: 'C', type: 'cash', currency: 'MYR', openingBalance: 0 })
    const t = transactions.createTransfer({ fromAccountId: a.id, toAccountId: b.id, amount: 1000, date: '2026-09-01' })

    transactions.updateTransfer(t.from.id, { amount: 7000, toAccountId: c.id, date: '2026-09-05' })

    expect(accounts.get(a.id).balance).toBe(93000)
    expect(accounts.get(b.id).balance).toBe(0)
    expect(accounts.get(c.id).balance).toBe(7000)
    expect(accounts.get(a.id).balance + accounts.get(c.id).balance).toBe(100000)
  })
})

describe('referential integrity', () => {
  it('refuses to delete an account that still has transactions', () => {
    const acc = accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 0 })
    transactions.create({ accountId: acc.id, type: 'expense', amount: 100, date: '2026-09-01' })
    expect(() => accounts.remove(acc.id)).toThrow(/still has 1 transaction/i)
  })

  it('archives instead of deleting, preserving history', () => {
    const acc = accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 5000 })
    transactions.create({ accountId: acc.id, type: 'expense', amount: 100, date: '2026-09-01' })

    accounts.archive(acc.id, true)
    expect(accounts.list().find((a) => a.id === acc.id)).toBeUndefined()
    expect(accounts.list({ includeArchived: true }).find((a) => a.id === acc.id)?.archived).toBe(true)
    // History survives and the balance still reconciles.
    expect(accounts.get(acc.id).balance).toBe(4900)
    expect(accounts.get(acc.id).transactionCount).toBe(1)
  })

  it('refuses to delete a category that is in use, then reassigns on request', () => {
    const acc = accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 0 })
    const food = categoryId('Food', 'expense')
    const other = categoryId('Other', 'expense')
    transactions.create({ accountId: acc.id, type: 'expense', amount: 100, categoryId: food, date: '2026-09-01' })

    expect(() => categories.remove(food)).toThrow(/used by 1 transaction/i)

    const result = categories.remove(food, { reassignTo: other })
    expect(result.reassigned).toBe(1)
    expect(transactions.list({ search: '' }).items[0].categoryName).toBe('Other')
    // The expense total is unchanged by the category move.
    expect(transactions.totals('2026-09-01', '2026-09-30').expense).toBe(100)
  })

  it('refuses to reassign across income and expense categories', () => {
    const acc = accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 0 })
    const food = categoryId('Food', 'expense')
    const salary = categoryId('Salary', 'income')
    transactions.create({ accountId: acc.id, type: 'expense', amount: 100, categoryId: food, date: '2026-09-01' })
    expect(() => categories.remove(food, { reassignTo: salary })).toThrow(/cannot be moved into it/i)
  })

  it('refuses to change a category type after use', () => {
    const food = categoryId('Food', 'expense')
    expect(() => categories.update(food, { type: 'income' })).toThrow(/cannot be changed/i)
  })

  it('refuses to change an account currency once it has transactions', () => {
    const acc = accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 0 })
    transactions.create({ accountId: acc.id, type: 'expense', amount: 100, date: '2026-09-01' })
    expect(() => accounts.update(acc.id, { currency: 'CNY' })).toThrow(/would reinterpret every stored amount/i)
  })
})

describe('multi-currency', () => {
  it('keeps currencies separate instead of summing them', () => {
    accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 500000 })
    accounts.create({ name: 'Alipay', type: 'wallet', currency: 'CNY', openingBalance: 20000 })

    const balances = accounts.balancesByCurrency()
    expect(balances).toHaveLength(2)
    expect(balances.find((b) => b.currency === 'MYR')?.balance).toBe(500000)
    expect(balances.find((b) => b.currency === 'CNY')?.balance).toBe(20000)
  })
})

describe('persistence (acceptance Test 5)', () => {
  it('still has the data after closing and reopening', () => {
    const acc = accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 500000 })
    transactions.create({ accountId: acc.id, type: 'expense', amount: 2000, date: '2026-09-26' })
    transactions.create({ accountId: acc.id, type: 'income', amount: 300000, date: '2026-09-26' })

    const dbPath = handle.path
    handle.close()

    // Reopen the same file, exactly as a relaunch of the app would.
    handle = openDatabase({ dataDir: workDir })
    accounts = new AccountsService(handle.db)
    transactions = new TransactionsService(handle.db, accounts, new CategoriesService(handle.db))

    expect(handle.path).toBe(dbPath)
    const reopened = accounts.list()
    expect(reopened).toHaveLength(1)
    expect(reopened[0].name).toBe('Maybank')
    expect(reopened[0].balance).toBe(798000)
    expect(reopened[0].transactionCount).toBe(2)
  })
})
