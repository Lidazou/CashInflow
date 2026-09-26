import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backupDatabase, openDatabase, snapshotBeforeDestructiveChange, type DatabaseHandle } from '@main/database/connection'
import { Services } from '@main/services'
import { transactionsToCsv } from '@main/services/export'

/**
 * The spec's acceptance criteria, executed as tests (spec 搂44).
 *
 * Each `it` maps to one numbered Test in the specification, so the claim "this
 * was verified" can be checked by running the suite rather than taken on trust.
 * Everything runs against a real SQLite file 鈥?no mocks 鈥?because the acceptance
 * criteria are precisely about what the database actually does.
 */

let workDir: string
let handle: DatabaseHandle
let services: Services

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'spendwise-accept-'))
  handle = openDatabase({ dataDir: workDir })
  services = new Services(handle.db)
})

afterEach(() => {
  try {
    handle.close()
  } catch {
    /* already closed by a test that reopened it */
  }
  rmSync(workDir, { recursive: true, force: true })
})

function reopen(): void {
  handle = openDatabase({ dataDir: workDir })
  services = new Services(handle.db)
}

function categoryId(name: string, type: 'income' | 'expense'): number {
  const found = services.categories.list({ type }).find((c) => c.name === name)
  if (!found) throw new Error(`Seeded category ${name} (${type}) is missing`)
  return found.id
}

describe('Test 1: create account Maybank with RM 5,000', () => {
  it('stores the account with its opening balance', () => {
    const account = services.accounts.create({
      name: 'Maybank',
      type: 'bank',
      currency: 'MYR',
      openingBalance: 500000
    })

    expect(account.id).toBeGreaterThan(0)
    expect(account.name).toBe('Maybank')
    expect(account.openingBalance).toBe(500000)
    expect(account.balance).toBe(500000)

    // Persisted, not merely returned.
    expect(services.accounts.get(account.id).balance).toBe(500000)
  })
})

describe('Test 2: add expense Food RM 20 and see balance RM 4,980', () => {
  it('reduces the derived balance by the expense', () => {
    const account = services.accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 500000 })
    services.transactions.create({
      accountId: account.id,
      type: 'expense',
      amount: 2000,
      categoryId: categoryId('Food', 'expense'),
      date: '2026-09-26'
    })

    expect(services.accounts.get(account.id).balance).toBe(498000)
    expect(services.accounts.balancesByCurrency()[0].balance).toBe(498000)
  })
})

describe('Test 3: add income Salary RM 3,000 and see the month figures', () => {
  it('reports income, expense and net from the ledger', () => {
    const account = services.accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 500000 })
    services.transactions.create({
      accountId: account.id,
      type: 'expense',
      amount: 2000,
      categoryId: categoryId('Food', 'expense'),
      date: '2026-09-26'
    })
    services.transactions.create({
      accountId: account.id,
      type: 'income',
      amount: 300000,
      categoryId: categoryId('Salary', 'income'),
      date: '2026-09-26'
    })

    const dashboard = services.statistics.dashboard('2026-09', 'MYR', 1, '2026-09-26')
    expect(dashboard.month.income).toBe(300000)
    expect(dashboard.month.expense).toBe(2000)
    expect(dashboard.month.net).toBe(298000)

    // Balance is derived from the account, and is deliberately NOT
    // income - expense, because the opening balance is part of it.
    expect(services.accounts.get(account.id).balance).toBe(798000)
  })
})

describe('Test 4: transfer Maybank -> Cash RM 500 leaves the total unchanged', () => {
  it('moves money without creating income or expense', () => {
    const maybank = services.accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 500000 })
    const cash = services.accounts.create({ name: 'Cash', type: 'cash', currency: 'MYR', openingBalance: 0 })

    const before = services.accounts.balancesByCurrency()[0].balance
    services.transactions.createTransfer({
      fromAccountId: maybank.id,
      toAccountId: cash.id,
      amount: 50000,
      date: '2026-09-26'
    })
    const after = services.accounts.balancesByCurrency()[0].balance

    expect(after).toBe(before)
    expect(services.accounts.get(maybank.id).balance).toBe(450000)
    expect(services.accounts.get(cash.id).balance).toBe(50000)

    const dashboard = services.statistics.dashboard('2026-09', 'MYR', 1, '2026-09-26')
    expect(dashboard.month.expense).toBe(0)
    expect(dashboard.month.income).toBe(0)
    expect(dashboard.month.net).toBe(0)
  })
})

describe('Test 5: data survives closing and reopening the app', () => {
  it('still has accounts and transactions after a full close and reopen', () => {
    const account = services.accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 500000 })
    const cash = services.accounts.create({ name: 'Cash', type: 'cash', currency: 'MYR', openingBalance: 0 })
    services.transactions.create({
      accountId: account.id,
      type: 'expense',
      amount: 2000,
      categoryId: categoryId('Food', 'expense'),
      date: '2026-09-26'
    })
    services.transactions.create({
      accountId: account.id,
      type: 'income',
      amount: 300000,
      categoryId: categoryId('Salary', 'income'),
      date: '2026-09-26'
    })
    services.transactions.createTransfer({
      fromAccountId: account.id,
      toAccountId: cash.id,
      amount: 50000,
      date: '2026-09-26'
    })

    const before = services.accounts.balancesByCurrency()[0].balance
    const transactionCount = services.transactions.countAll()

    // Simulate the app being closed and started again.
    handle.close()
    reopen()

    expect(services.accounts.list()).toHaveLength(2)
    expect(services.transactions.countAll()).toBe(transactionCount)
    expect(services.accounts.balancesByCurrency()[0].balance).toBe(before)

    // Maybank: 500,000 opening + 300,000 salary - 2,000 lunch - 50,000 transferred out.
    expect(services.accounts.get(account.id).balance).toBe(748000)
    // Cash: the receiving leg of the transfer.
    expect(services.accounts.get(cash.id).balance).toBe(50000)
    // The two balances still sum to the pre-transfer total, which is the
    // property that proves the transfer leg was persisted correctly.
    expect(services.accounts.get(account.id).balance + services.accounts.get(cash.id).balance).toBe(before)

    const dashboard = services.statistics.dashboard('2026-09', 'MYR', 1, '2026-09-26')
    expect(dashboard.month.income).toBe(300000)
    expect(dashboard.month.expense).toBe(2000)
    expect(dashboard.month.net).toBe(298000)
  })
})

describe('Test 6: import a CSV and have the transactions land in the database', () => {
  it('imports parsed rows with correct signs, categories and balances', () => {
    const account = services.accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 500000 })
    const path = join(workDir, 'statement.csv')
    writeFileSync(
      path,
      [
        'Date,Description,Amount,Type,Category,Account',
        '2026-09-01,Lunch,-20.00,Expense,Food,Maybank',
        '2026-09-02,Salary,3000.00,Income,Salary,Maybank',
        '2026-09-03,Grab,-18.50,Expense,Transport,Maybank'
      ].join('\n'),
      'utf8'
    )

    const preview = services.imports.parse(path, 'generic')
    expect(preview.fatalError).toBeNull()

    const result = services.imports.commit(
      {
        fileName: preview.fileName,
        presetId: 'generic',
        rows: preview.rows,
        defaultAccountId: account.id,
        createMissingCategories: true
      },
      { currency: 'MYR' }
    )
    expect(result.imported).toBe(3)

    const totals = services.transactions.totals('2026-09-01', '2026-09-30')
    expect(totals.income).toBe(300000)
    expect(totals.expense).toBe(3850)
    expect(services.accounts.get(account.id).balance).toBe(500000 + 300000 - 3850)
  })
})

describe('Test 7: importing the same CSV twice detects duplicates', () => {
  it('flags the second import and does not double the spending', () => {
    const account = services.accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 500000 })
    const path = join(workDir, 'statement.csv')
    writeFileSync(
      path,
      [
        'Date,Description,Amount,Type,Category,Account',
        '2026-09-01,Lunch,-20.00,Expense,Food,Maybank',
        '2026-09-03,Grab,-18.50,Expense,Transport,Maybank'
      ].join('\n'),
      'utf8'
    )

    const preview = services.imports.parse(path, 'generic')

    const commit = (rows: typeof preview.rows): number => {
      const result = services.imports.commit(
        {
          fileName: 'statement.csv',
          presetId: 'generic',
          rows: rows.filter((row) => row.errors.length === 0 && row.resolution === 'import'),
          defaultAccountId: account.id,
          createMissingCategories: true
        },
        { currency: 'MYR' }
      )
      return result.imported
    }

    expect(commit(preview.rows)).toBe(2)
    expect(services.transactions.totals('2026-09-01', '2026-09-30').expense).toBe(3850)

    const second = services.imports.parse(path, 'generic')
    expect(second.duplicateCount).toBe(2)
    // Defaulted to skip, so a naive re-commit writes nothing.
    expect(commit(second.rows)).toBe(0)
    expect(services.transactions.totals('2026-09-01', '2026-09-30').expense).toBe(3850)
  })
})

describe('Test 8: editing a transaction updates the dashboard and statistics', () => {
  it('propagates the change to every derived figure', () => {
    const account = services.accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 0 })
    const food = categoryId('Food', 'expense')
    const shopping = categoryId('Shopping', 'expense')
    const tx = services.transactions.create({
      accountId: account.id,
      type: 'expense',
      amount: 2000,
      categoryId: food,
      date: '2026-09-10'
    })

    const beforeStats = services.statistics.statistics('month', '2026-09-10', 'MYR', 1)
    expect(beforeStats.totals.expense).toBe(2000)
    expect(beforeStats.categories[0].categoryName).toBe('Food')

    services.transactions.update(tx.id, { amount: 3500, categoryId: shopping })

    const afterStats = services.statistics.statistics('month', '2026-09-10', 'MYR', 1)
    expect(afterStats.totals.expense).toBe(3500)
    expect(afterStats.categories[0].categoryName).toBe('Shopping')
    expect(afterStats.categories[0].total).toBe(3500)

    expect(services.accounts.get(account.id).balance).toBe(-3500)
  })
})

describe('Test 9: deleting a transaction updates the dashboard and statistics', () => {
  it('removes the effect from every derived figure', () => {
    const account = services.accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 100000 })
    const tx = services.transactions.create({
      accountId: account.id,
      type: 'expense',
      amount: 2000,
      categoryId: categoryId('Food', 'expense'),
      date: '2026-09-10'
    })
    expect(services.statistics.dashboard('2026-09', 'MYR', 1, '2026-09-10').month.expense).toBe(2000)

    services.transactions.remove(tx.id)

    const dashboard = services.statistics.dashboard('2026-09', 'MYR', 1, '2026-09-10')
    expect(dashboard.month.expense).toBe(0)
    expect(dashboard.month.transactionCount).toBe(0)
    expect(services.accounts.get(account.id).balance).toBe(100000)
    expect(services.statistics.statistics('month', '2026-09-10', 'MYR', 1).categories).toHaveLength(0)
  })

  it('deleting an income removes it from the month total', () => {
    const account = services.accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 0 })
    const tx = services.transactions.create({
      accountId: account.id,
      type: 'income',
      amount: 300000,
      categoryId: categoryId('Salary', 'income'),
      date: '2026-09-02'
    })

    expect(services.statistics.dashboard('2026-09', 'MYR', 1, '2026-09-02').month.income).toBe(300000)
    services.transactions.remove(tx.id)
    const dashboard = services.statistics.dashboard('2026-09', 'MYR', 1, '2026-09-02')
    expect(dashboard.month.income).toBe(0)
    expect(dashboard.month.net).toBe(0)
  })
})

describe('Test 10: the packaged app keeps working (data layer guarantees)', () => {
  it('writes the database to the app data directory, not the project directory', () => {
    // The path is supplied by the caller (app.getPath('userData') in production)
    // and the module never falls back to the working directory.
    expect(handle.path.startsWith(workDir)).toBe(true)
    expect(handle.path).not.toContain('node_modules')
    expect(existsSync(handle.path)).toBe(true)
    expect(statSync(handle.path).size).toBeGreaterThan(0)
  })

  it('produces a consistent single-file backup that can be reopened', () => {
    const account = services.accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 500000 })
    services.transactions.create({
      accountId: account.id,
      type: 'expense',
      amount: 2000,
      categoryId: categoryId('Food', 'expense'),
      date: '2026-09-26'
    })

    const backupPath = join(workDir, 'backup.db')
    backupDatabase(handle.db, backupPath)
    expect(existsSync(backupPath)).toBe(true)

    // The backup must be a fully usable database on its own 鈥?this is what
    // VACUUM INTO guarantees and a plain file copy would not while WAL is active.
    const restored = openDatabase({ dataDir: workDir, fileName: 'backup.db', skipSeed: true })
    const restoredAccounts = new Services(restored.db)
    expect(restoredAccounts.accounts.list()).toHaveLength(1)
    expect(restoredAccounts.accounts.list()[0].balance).toBe(498000)
    expect(restoredAccounts.transactions.countAll()).toBe(1)
    restored.close()
  })

  it('takes a safety snapshot before a destructive change', () => {
    services.accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 500000 })
    const snapshot = snapshotBeforeDestructiveChange(handle.db, workDir, 'restore')
    expect(existsSync(snapshot)).toBe(true)

    const check = openDatabase({ dataDir: workDir, fileName: snapshot.split('\\').pop() as string, skipSeed: true })
    expect(new Services(check.db).accounts.list()).toHaveLength(1)
    check.close()
  })

  it('exports a CSV that preserves every transaction and its sign', () => {
    const account = services.accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 500000 })
    const cash = services.accounts.create({ name: 'Cash', type: 'cash', currency: 'MYR', openingBalance: 0 })
    services.transactions.create({
      accountId: account.id,
      type: 'expense',
      amount: 2000,
      categoryId: categoryId('Food', 'expense'),
      date: '2026-09-26',
      merchant: 'Coffee, Tea & Co'
    })
    services.transactions.create({
      accountId: account.id,
      type: 'income',
      amount: 300000,
      categoryId: categoryId('Salary', 'income'),
      date: '2026-09-26'
    })
    services.transactions.createTransfer({
      fromAccountId: account.id,
      toAccountId: cash.id,
      amount: 50000,
      date: '2026-09-26'
    })

    const csv = transactionsToCsv(services.imports.exportRows({}))
    const lines = csv.replace(/^\uFEFF/, '').trim().split('\r\n')

    // Header plus 4 rows: 2 income/expense and 2 transfer legs.
    expect(lines).toHaveLength(5)
    expect(lines[0]).toContain('Date')
    expect(lines[0]).toContain('Amount')

    // The merchant containing a comma and an ampersand must be quoted, or the
    // row would shift every following column.
    expect(csv).toContain('"Coffee, Tea & Co"')

    // Signs survive: expenses negative, income positive, transfers signed.
    expect(csv).toContain('-20.00')
    expect(csv).toContain('3000.00')
    expect(csv).toContain('-500.00')
    expect(csv).toContain('500.00')
  })
})
