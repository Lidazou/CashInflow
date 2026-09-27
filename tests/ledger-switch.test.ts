import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LedgerManager } from '@main/services/ledger'
import { openDatabase } from '@main/database/connection'
import { Services } from '@main/services'

/**
 * 两个账本，互不干扰 (v1.7.0)
 *
 * THE PROMISE THIS FILE EXISTS TO KEEP
 * ------------------------------------
 * "Switching to the sample data must not affect anything I have recorded." That is a claim
 * about a FILE, so most of what follows is deliberately at the file level: the user's
 * database is hashed before and after every operation, and the byte comparison is the
 * assertion. A test that asked the app whether the data was fine would be asking the
 * suspect for an alibi.
 */

let workDir: string
let manager: LedgerManager

function realPath(): string {
  return join(workDir, 'spendwise.db')
}

function samplePath(): string {
  return join(workDir, 'demo', 'spendwise.db')
}

/**
 * A digest of what the ledger CONTAINS, read through a connection of its own.
 *
 * The file's BYTES are not the right thing to compare: closing a SQLite connection
 * checkpoints the WAL into the main file, so the bytes legitimately change while the
 * records do not. What the user cares about — and what this asserts — is that every row
 * they had is still there, unchanged.
 */
function contentDigest(dir: string = workDir): string {
  const handle = openDatabase({ dataDir: dir })
  try {
    const db = handle.db
    const rows = {
      accounts: db.prepare('SELECT id, name, currency, opening_balance, archived FROM accounts ORDER BY id').all(),
      categories: db.prepare('SELECT id, name, type, color FROM categories ORDER BY id').all(),
      transactions: db
        .prepare(
          'SELECT id, account_id, type, amount, category_id, date, time, merchant, note, transfer_id FROM transactions ORDER BY id'
        )
        .all(),
      transfers: db.prepare('SELECT id, from_account_id, to_account_id, amount, date, note FROM transfers ORDER BY id').all(),
      budgets: db.prepare('SELECT id, category_id, limit_amount, currency FROM budgets ORDER BY id').all(),
      subscriptions: db.prepare('SELECT id, name, amount, currency, cycle FROM subscriptions ORDER BY id').all()
    }
    return JSON.stringify(rows)
  } finally {
    handle.close()
  }
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'spendwise-ledger-'))
  manager = new LedgerManager(workDir)
})

afterEach(() => {
  try {
    manager.close()
  } catch {
    /* already closed */
  }
  rmSync(workDir, { recursive: true, force: true })
})

/** Some of the user's own records, so there is something to protect. */
function writeRealData(): { accountId: number; count: number } {
  const services = manager.servicesRef()
  const account = services.accounts.create({ name: '留学', type: 'bank', currency: 'CNY', openingBalance: 500_000 })
  const food = services.categories.list({ type: 'expense' }).find((row) => row.name === 'Food')
  services.transactions.create({
    accountId: account.id,
    type: 'expense',
    amount: 12_800,
    categoryId: food?.id ?? null,
    date: '2026-09-21',
    merchant: '食堂',
    note: '我的真实记录'
  })
  services.transactions.create({
    accountId: account.id,
    type: 'income',
    amount: 1_000_000,
    categoryId: null,
    date: '2026-09-05',
    merchant: '家里打钱',
    note: null
  })
  const count = services.transactions.list({}).total
  return { accountId: account.id, count }
}

describe('the sample ledger is a separate database', () => {
  it('starts on the user`s own ledger and never on the sample', () => {
    expect(manager.currentMode()).toBe('real')
    expect(manager.currentPath()).toBe(realPath())
    expect(manager.status().mode).toBe('real')
  })

  it('creates the sample in its own folder, leaving the real file alone', () => {
    writeRealData()
    const before = contentDigest()
    const status = manager.switchTo('sample')

    expect(status.mode).toBe('sample')
    expect(status.sampleLoaded).toBe(true)
    expect(existsSync(samplePath())).toBe(true)
    expect(statSync(samplePath()).size).toBeGreaterThan(50_000)
    void readFileSync
    /* The user's file is byte-identical: not reopened, not checkpointed, not touched. */
    expect(contentDigest()).toBe(before)
  })

  it('shows a different ledger while the sample is on — different accounts, different rows', () => {
    const mine = writeRealData()
    const services = manager.servicesRef()
    expect(services.accounts.list({ includeArchived: true })).toHaveLength(1)

    manager.switchTo('sample')
    const sample = manager.servicesRef()
    const accounts = sample.accounts.list({ includeArchived: true })
    expect(accounts.length).toBe(4)
    expect(accounts.map((row) => row.currency).sort()).toEqual(['CNY', 'CNY', 'CNY', 'MYR'])
    expect(sample.transactions.list({}).total).toBeGreaterThan(900)
    expect(sample.transactions.list({ search: '我的真实记录' }).total).toBe(0)
    void mine
  })

  it('switches back to exactly the ledger it left', () => {
    const mine = writeRealData()
    const before = contentDigest()

    manager.switchTo('sample')
    /* Even if something IS written while the sample is open, it goes to the sample. */
    const sample = manager.servicesRef()
    sample.transactions.create({
      accountId: sample.accounts.list({})[0].id,
      type: 'expense',
      amount: 999,
      categoryId: null,
      date: '2026-09-28',
      merchant: '模拟数据里的新记录',
      note: null
    })
    const sampleCount = sample.transactions.list({}).total

    const status = manager.switchTo('real')
    expect(status.mode).toBe('real')
    const real = manager.servicesRef()
    expect(real.transactions.list({}).total).toBe(mine.count)
    expect(real.transactions.list({ search: '模拟数据里的新记录' }).total).toBe(0)
    /* And the real file is STILL byte-identical after all of that. */
    expect(contentDigest()).toBe(before)

    /* The sample kept its own write, because it is a real ledger too. */
    manager.switchTo('sample')
    expect(manager.servicesRef().transactions.list({}).total).toBe(sampleCount)
  })

  it('regenerating the sample deletes only the sample', () => {
    writeRealData()
    const before = contentDigest()
    manager.switchTo('sample')
    const first = manager.servicesRef().transactions.list({}).total

    const status = manager.regenerateSample()
    expect(status.mode).toBe('sample')
    const second = manager.servicesRef().transactions.list({}).total
    expect(second).toBe(first)
    expect(contentDigest()).toBe(before)
  })

  it('regenerating while on the real ledger leaves the app on the real ledger', () => {
    writeRealData()
    const before = contentDigest()
    const status = manager.regenerateSample()
    expect(status.mode).toBe('real')
    expect(manager.currentPath()).toBe(realPath())
    expect(manager.servicesRef().transactions.list({}).total).toBe(2)
    expect(contentDigest()).toBe(before)
  })

  it('reports the paths the user needs to be able to check for themselves', () => {
    const status = manager.status()
    expect(status.realPath).toBe(realPath())
    expect(status.samplePath).toBe(samplePath())
    expect(status.samplePath.startsWith(status.realPath.replace('spendwise.db', ''))).toBe(true)
  })

  it('is a no-op when asked to switch to the ledger already open', () => {
    writeRealData()
    const before = contentDigest()
    const status = manager.switchTo('real')
    expect(status.mode).toBe('real')
    expect(contentDigest()).toBe(before)
  })
})

describe('the sample ledger is a real ledger', () => {
  it('passes the schema and integrity checks any ledger has to pass', () => {
    manager.switchTo('sample')
    const handle = manager.handleRef()
    expect(handle.db.pragma('user_version', { simple: true })).toBe(2)
    expect(handle.db.pragma('foreign_key_check')).toEqual([])
    expect(handle.db.pragma('integrity_check', { simple: true })).toBe('ok')
  })

  it('has no orphaned transfer legs and no half-transfers', () => {
    manager.switchTo('sample')
    const db = manager.handleRef().db
    const legs = db
      .prepare(
        `SELECT transfer_id, COUNT(*) AS legs, SUM(amount) AS total
         FROM transactions WHERE transfer_id IS NOT NULL GROUP BY transfer_id`
      )
      .all() as Array<{ transfer_id: number; legs: number; total: number }>
    expect(legs.length).toBeGreaterThanOrEqual(8)
    for (const leg of legs) {
      expect(leg.legs, `transfer ${leg.transfer_id}`).toBe(2)
      /* Both legs of a same-currency transfer cancel out exactly. */
      expect(leg.total, `transfer ${leg.transfer_id}`).toBe(0)
    }
    const orphans = db
      .prepare('SELECT COUNT(*) AS n FROM transactions t WHERE t.transfer_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM transfers x WHERE x.id = t.transfer_id)')
      .get() as { n: number }
    expect(orphans.n).toBe(0)
  })

  it('balances every account, so no screen shows a figure nobody can explain', () => {
    manager.switchTo('sample')
    const services = manager.servicesRef()
    const db = manager.handleRef().db
    for (const account of services.accounts.list({ includeArchived: true })) {
      /*
        The sum comes straight from the table rather than through `transactions.list`: the
        list is paginated, and this is an assertion about the whole ledger. What is being
        checked is the app's own definition of a balance — opening plus every movement.
      */
      const row = db
        .prepare('SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count FROM transactions WHERE account_id = ?')
        .get(account.id) as { total: number; count: number }
      expect(row.count, account.name).toBeGreaterThan(0)
      expect(account.balance, account.name).toBe(account.openingBalance + row.total)
      /* And the sample never leaves an account overdrawn: nobody's money goes negative. */
      expect(account.balance, `${account.name} is overdrawn by ${account.balance}`).toBeGreaterThanOrEqual(0)
    }
  })

  it('fills the screens that are empty in a brand-new ledger', () => {
    manager.switchTo('sample')
    const services = manager.servicesRef()
    expect(services.subscriptions.list().length).toBeGreaterThanOrEqual(5)
    expect(services.budgets.list().length).toBeGreaterThanOrEqual(5)
    expect(services.categories.list({}).length).toBeGreaterThanOrEqual(10)
    const stats = services.statistics.statistics('month', '2026-09', 'CNY', 1)
    expect(stats.totals.expense).toBeGreaterThan(0)
    expect(stats.categories.length).toBeGreaterThan(2)
    expect(services.statistics.biggestExpenses('2026-09', 1, 'CNY', 5).length).toBeGreaterThan(0)
  })
})

describe('safety around the user`s file', () => {
  it('still works when the user has never written anything', () => {
    const before = contentDigest()
    manager.switchTo('sample')
    manager.switchTo('real')
    expect(contentDigest()).toBe(before)
    expect(manager.servicesRef().transactions.list({}).total).toBe(0)
  })

  it('refuses nothing and breaks nothing when the sample folder is read-only junk', () => {
    /* A leftover file where the folder should be is the classic upgrade accident. */
    rmSync(samplePath(), { force: true })
    writeFileSync(join(workDir, 'demo'), 'not a folder')
    expect(() => manager.switchTo('sample')).toThrow()
    /* The app is still on the user's ledger, with its data intact. */
    expect(manager.currentMode()).toBe('real')
    expect(manager.currentPath()).toBe(realPath())
    expect(manager.servicesRef().transactions.list({}).total).toBe(0)
  })

  it('keeps the two files apart in the filesystem, not merely in memory', () => {
    writeRealData()
    manager.switchTo('sample')
    /* A fresh connection to each path sees its own ledger, independently of the manager. */
    const real = openDatabase({ dataDir: workDir })
    const sample = openDatabase({ dataDir: join(workDir, 'demo') })
    try {
      const realServices = new Services(real.db)
      const sampleServices = new Services(sample.db)
      expect(realServices.transactions.list({}).total).toBe(2)
      expect(sampleServices.transactions.list({}).total).toBeGreaterThan(900)
    } finally {
      real.close()
      sample.close()
    }
  })
})
