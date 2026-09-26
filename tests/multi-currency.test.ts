import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type DatabaseHandle } from '@main/database/connection'
import { Services } from '@main/services'
import { makeRateTable } from '@main/services/exchange'
import type { RateTable } from '@shared/lib/rates'

/**
 * Multi-currency and settlement-cycle behaviour at the SERVICE level.
 *
 * These are the tests for the two bugs the refactor existed to fix:
 *
 *   1. Every aggregate used to sum raw minor units, which silently adds fen to
 *      sen once a user holds accounts in two currencies. The number looks
 *      entirely plausible and is meaningless.
 *
 *   2. Budgets and search resolved calendar months while the UI labelled a
 *      settlement cycle, so with an anchor day of 5 the label and the figures
 *      described different windows.
 */

let workDir: string
let handle: DatabaseHandle
let services: Services

/** Published rates for 2026-09-26, injected so tests never touch the network. */
const RATES: RateTable = makeRateTable('CNY', {
  CNY: 1,
  MYR: 0.606575,
  USD: 0.148707,
  SGD: 0.189946,
  HKD: 1.166485
})

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'spendwise-multi-'))
  handle = openDatabase({ dataDir: workDir })
  services = new Services(handle.db)
})

afterEach(() => {
  try {
    handle.close()
  } catch {
    /* closed by a test that reopened it */
  }
  rmSync(workDir, { recursive: true, force: true })
})

function categoryId(name: string, type: 'income' | 'expense'): number {
  const found = services.categories.list({ type }).find((item) => item.name === name)
  if (!found) throw new Error(`seed category ${name} missing`)
  return found.id
}

/** Give the statistics service a fixed rate table instead of the cache. */
function withRates(table: RateTable): void {
  // The service reads rates through a provider, so replacing the cached table is
  // enough to make every conversion deterministic.
  services.exchange.setManualRates(table.rates, table.base)
}

describe('cross-currency totals', () => {
  it('converts instead of adding fen to sen', () => {
    withRates(RATES)

    const cny = services.accounts.create({ name: '招商银行', type: 'bank', currency: 'CNY', openingBalance: 0 })
    const myr = services.accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 0 })

    // ¥100 income and RM 18.50 income.
    services.transactions.create({
      accountId: cny.id,
      type: 'income',
      amount: 10000,
      categoryId: categoryId('Salary', 'income'),
      date: '2026-09-10'
    })
    services.transactions.create({
      accountId: myr.id,
      type: 'income',
      amount: 1850,
      categoryId: categoryId('Salary', 'income'),
      date: '2026-09-10'
    })

    const stats = services.statistics.statistics('month', '2026-09-10', 'CNY', 1)

    // RM18.50 -> 1850 / 100 / 0.606575 * 100 = 3050 fen (rounded once).
    // Total ¥130.50 = 13050 fen.
    expect(stats.totals.income).toBe(13050)
    // The naive sum would have been 11850, which is what the old code produced.
    expect(stats.totals.income).not.toBe(10000 + 1850)

    // The per-currency breakdown is preserved for auditing the conversion.
    expect(stats.totals.sources).toHaveLength(2)
    expect(stats.totals.sources.every((source) => source.converted)).toBe(true)
  })

  it('excludes a currency with no rate and flags it, rather than counting it as 1:1', () => {
    // A rate table that simply lacks MYR, which is what a partially-populated
    // provider response looks like. The account itself is perfectly valid.
    withRates(makeRateTable('CNY', { CNY: 1, USD: 0.148707 }))

    const cny = services.accounts.create({ name: '招商银行', type: 'bank', currency: 'CNY', openingBalance: 0 })
    const myr = services.accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 0 })

    services.transactions.create({
      accountId: cny.id,
      type: 'expense',
      amount: 5000,
      categoryId: categoryId('Food', 'expense'),
      date: '2026-09-10'
    })
    services.transactions.create({
      accountId: myr.id,
      type: 'expense',
      amount: 9999,
      categoryId: categoryId('Food', 'expense'),
      date: '2026-09-10'
    })

    const stats = services.statistics.statistics('month', '2026-09-10', 'CNY', 1)
    expect(stats.totals.expense).toBe(5000)
    expect(stats.totals.hasUnconverted).toBe(true)
    // The unconvertible amount must NOT have been added at a rate of 1.
    expect(stats.totals.expense).not.toBe(14999)

    // The transaction count still includes it, so "N 笔" stays truthful.
    expect(stats.totals.transactionCount).toBe(2)
  })

  it('reports cross-currency balances without summing them', () => {
    withRates(RATES)

    services.accounts.create({ name: '招商银行', type: 'bank', currency: 'CNY', openingBalance: 500000 })
    services.accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 100000 })

    const balances = services.statistics.dashboard('2026-09', 'CNY', 1, '2026-09-26')

    expect(balances.balances).toHaveLength(2)
    const cnyRow = balances.balances.find((row) => row.currency === 'CNY')
    const myrRow = balances.balances.find((row) => row.currency === 'MYR')

    // Each line keeps its own real balance.
    expect(cnyRow?.balance).toBe(500000)
    expect(myrRow?.balance).toBe(100000)
    // And each carries a converted counterpart.
    expect(cnyRow?.convertedBalance).toBe(500000)
    expect(myrRow?.convertedBalance).toBeGreaterThan(0)
    // The combined total is a converted figure, not 600000 of nothing.
    expect(balances.netWorthInBaseCurrency).not.toBe(600000)
  })

  it('marks the total unavailable when a held currency has no rate', () => {
    // Rates exist for CNY and USD, but the user also holds MYR.
    withRates(makeRateTable('CNY', { CNY: 1, USD: 0.148707 }))

    services.accounts.create({ name: '招商银行', type: 'bank', currency: 'CNY', openingBalance: 100000 })
    services.accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 100000 })

    const dashboard = services.statistics.dashboard('2026-09', 'CNY', 1, '2026-09-26')

    // A partial total presented as a total would be worse than admitting it is
    // unavailable, so it is null and the UI lists currencies instead.
    expect(dashboard.netWorthInBaseCurrency).toBeNull()
    // The CNY line still converts (to itself); the MYR line reports no rate.
    const cnyRow = dashboard.balances.find((row) => row.currency === 'CNY')
    const myrRow = dashboard.balances.find((row) => row.currency === 'MYR')
    expect(cnyRow?.convertedBalance).toBe(100000)
    expect(myrRow?.convertedBalance).toBeNull()
  })

  it('leaves transfer legs out of income and expense across currencies', () => {
    withRates(RATES)

    const cny = services.accounts.create({ name: '招商银行', type: 'bank', currency: 'CNY', openingBalance: 500000 })
    const cash = services.accounts.create({ name: '现金', type: 'cash', currency: 'CNY', openingBalance: 0 })

    services.transactions.createTransfer({
      fromAccountId: cny.id,
      toAccountId: cash.id,
      amount: 100000,
      date: '2026-09-10'
    })

    const stats = services.statistics.statistics('month', '2026-09-10', 'CNY', 1)

    // A transfer is never income or spending, however large it is.
    expect(stats.totals.income).toBe(0)
    expect(stats.totals.expense).toBe(0)
    expect(stats.totals.net).toBe(0)

    // Alongside a genuine expense, only the expense counts.
    services.transactions.create({
      accountId: cny.id,
      type: 'expense',
      amount: 2500,
      categoryId: categoryId('Food', 'expense'),
      date: '2026-09-10'
    })
    const after = services.statistics.statistics('month', '2026-09-10', 'CNY', 1)
    expect(after.totals.expense).toBe(2500)
    expect(after.totals.income).toBe(0)
  })
})

describe('settlement-cycle-aware budget progress', () => {
  it('uses the cycle window, not the calendar month', () => {
    withRates(RATES)

    const account = services.accounts.create({ name: '招商银行', type: 'bank', currency: 'CNY', openingBalance: 0 })

    // With a cycle anchored on the 5th, the cycle containing 26 Sep is
    // 5 Sep – 4 Oct. A spend on 30 Sep belongs to it; a spend on 3 Sep does not.
    services.transactions.create({
      accountId: account.id,
      type: 'expense',
      amount: 30000,
      categoryId: categoryId('Food', 'expense'),
      date: '2026-09-30'
    })
    services.transactions.create({
      accountId: account.id,
      type: 'expense',
      amount: 10000,
      categoryId: categoryId('Food', 'expense'),
      date: '2026-09-03'
    })

    services.budgets.set({ categoryId: categoryId('Food', 'expense'), limitAmount: 100000, currency: 'CNY' })

    // Calendar month: both spends fall inside September.
    const calendar = services.budgets.progress('2026-09', 1, 'CNY', RATES)
    expect(calendar[0].spent).toBe(40000)

    // Cycle anchored on the 5th: only the 30 Sep spend is in this cycle.
    const cycle = services.budgets.progress('2026-09', 5, 'CNY', RATES)
    expect(cycle[0].spent).toBe(30000)
    expect(cycle[0].remaining).toBe(70000)
    expect(cycle[0].overBudget).toBe(false)
  })

  it('converts spending before comparing it to the limit', () => {
    withRates(RATES)

    const myr = services.accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 0 })
    services.transactions.create({
      accountId: myr.id,
      type: 'expense',
      amount: 30329, // RM 303.29 -> about ¥500
      categoryId: categoryId('Food', 'expense'),
      date: '2026-09-15'
    })

    services.budgets.set({ categoryId: categoryId('Food', 'expense'), limitAmount: 60000, currency: 'CNY' })

    const progress = services.budgets.progress('2026-09', 1, 'CNY', RATES)
    // RM303.29 / 0.606575 = ¥500.01 -> 50001 fen, not 30329.
    expect(progress[0].spent).toBeCloseTo(50001, -1)
    expect(progress[0].spent).not.toBe(30329)
    expect(progress[0].overBudget).toBe(false)
  })

  it('reports the overall budget across mixed currencies', () => {
    withRates(RATES)

    const cny = services.accounts.create({ name: '招商银行', type: 'bank', currency: 'CNY', openingBalance: 0 })
    const myr = services.accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 0 })

    services.transactions.create({
      accountId: cny.id,
      type: 'expense',
      amount: 20000,
      categoryId: categoryId('Food', 'expense'),
      date: '2026-09-15'
    })
    services.transactions.create({
      accountId: myr.id,
      type: 'expense',
      amount: 12132, // RM121.32 -> about ¥200
      categoryId: categoryId('Transport', 'expense'),
      date: '2026-09-15'
    })

    services.budgets.set({ categoryId: null, limitAmount: 50000, currency: 'CNY' })
    const progress = services.budgets.progress('2026-09', 1, 'CNY', RATES)

    const overall = progress.find((row) => row.budget.categoryId === null)
    expect(overall).toBeDefined()
    expect(overall!.spent).toBeGreaterThan(39000)
    expect(overall!.spent).toBeLessThan(41000)
    // A raw sum would have been 32132.
    expect(overall!.spent).not.toBe(32132)
  })
})

describe('search totals across currencies', () => {
  it('converts rather than summing minor units', () => {
    withRates(RATES)

    const cny = services.accounts.create({ name: '招商银行', type: 'bank', currency: 'CNY', openingBalance: 0 })
    const myr = services.accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 0 })

    services.transactions.create({
      accountId: cny.id,
      type: 'expense',
      amount: 10000,
      categoryId: categoryId('Food', 'expense'),
      date: '2026-09-10',
      merchant: '海底捞'
    })
    services.transactions.create({
      accountId: myr.id,
      type: 'expense',
      amount: 1850,
      categoryId: categoryId('Food', 'expense'),
      date: '2026-09-11',
      merchant: 'Grab'
    })

    const result = services.transactions.search({}, 'CNY', RATES)
    expect(result.totals.expense).toBe(13050)
    expect(result.totals.expense).not.toBe(11850)
    // The combined total reports the currency it was converted into, so the UI
    // cannot format it as something else.
    expect(result.totals.currency).toBe('CNY')
  })

  it('still excludes transfers from the income/expense totals', () => {
    withRates(RATES)

    const a = services.accounts.create({ name: '招商银行', type: 'bank', currency: 'CNY', openingBalance: 500000 })
    const b = services.accounts.create({ name: '现金', type: 'cash', currency: 'CNY', openingBalance: 0 })

    services.transactions.createTransfer({ fromAccountId: a.id, toAccountId: b.id, amount: 50000, date: '2026-09-10' })

    const result = services.transactions.search({}, 'CNY', RATES)
    expect(result.totals.income).toBe(0)
    expect(result.totals.expense).toBe(0)
    expect(result.totals.transactionCount).toBe(0)
  })
})

describe('custom period statistics', () => {
  it('computes spend against an arbitrary total over an arbitrary range', () => {
    withRates(RATES)

    const account = services.accounts.create({ name: '招商银行', type: 'bank', currency: 'CNY', openingBalance: 0 })

    // A semester: 1 Sep – 31 Dec, with ¥800 spent in September and ¥200 in October.
    services.transactions.create({
      accountId: account.id,
      type: 'expense',
      amount: 80000,
      categoryId: categoryId('Food', 'expense'),
      date: '2026-09-20'
    })
    services.transactions.create({
      accountId: account.id,
      type: 'expense',
      amount: 20000,
      categoryId: categoryId('Food', 'expense'),
      date: '2026-10-20'
    })

    const stats = services.statistics.customPeriod(
      { from: '2026-09-01', to: '2026-12-31', budgetAmount: 200000 },
      'CNY',
      '2026-10-31'
    )

    expect(stats.spent).toBe(100000)
    expect(stats.budget?.amount).toBe(200000)
    expect(stats.remaining).toBe(100000)
    expect(stats.overBudget).toBe(false)
    expect(stats.daysTotal).toBe(122)
    // Elapsed is clamped to the range: 1 Sep -> 31 Oct inclusive.
    expect(stats.daysElapsed).toBe(61)
    // ¥1000 over 61 days, projected across 122 days.
    expect(stats.dailyAverage).toBe(Math.round(100000 / 61))
    expect(stats.projectedTotal).toBeGreaterThan(stats.spent)
  })

  it('reports over-budget honestly', () => {
    withRates(RATES)

    const account = services.accounts.create({ name: '招商银行', type: 'bank', currency: 'CNY', openingBalance: 0 })
    services.transactions.create({
      accountId: account.id,
      type: 'expense',
      amount: 250000,
      categoryId: categoryId('Food', 'expense'),
      date: '2026-09-20'
    })

    const stats = services.statistics.customPeriod({ from: '2026-09-01', to: '2026-09-30', budgetAmount: 200000 }, 'CNY', '2026-09-30')
    expect(stats.overBudget).toBe(true)
    expect(stats.remaining).toBe(-50000)
    // Clamped for bar widths, with `overBudget` conveying the real state.
    expect(stats.usedRatio).toBe(1)
  })

  it('works with no total set', () => {
    withRates(RATES)

    const account = services.accounts.create({ name: '招商银行', type: 'bank', currency: 'CNY', openingBalance: 0 })
    services.transactions.create({
      accountId: account.id,
      type: 'expense',
      amount: 5000,
      categoryId: categoryId('Food', 'expense'),
      date: '2026-09-20'
    })

    const stats = services.statistics.customPeriod({ from: '2026-09-01', to: '2026-09-30' }, 'CNY', '2026-09-30')
    expect(stats.budget).toBeNull()
    expect(stats.remaining).toBeNull()
    expect(stats.overBudget).toBe(false)
    expect(stats.usedRatio).toBe(0)
    expect(stats.spent).toBe(5000)
  })

  it('reports zero elapsed days for a future range instead of a negative average', () => {
    withRates(RATES)
    const stats = services.statistics.customPeriod(
      { from: '2027-01-01', to: '2027-06-30' },
      'CNY',
      '2026-09-26'
    )
    expect(stats.daysElapsed).toBe(0)
    expect(stats.dailyAverage).toBe(0)
    expect(stats.projectedTotal).toBeNull()
  })

  it('refuses an inverted range with an actionable message', () => {
    expect(() =>
      services.statistics.customPeriod({ from: '2026-09-30', to: '2026-09-01' }, 'CNY')
    ).toThrow(/开始日期/)
  })

  it('saves and reloads a named period with its total', () => {
    const saved = services.statistics.saveCustomPeriod({
      label: '2026 秋季学期',
      from: '2026-09-01',
      to: '2026-12-31',
      budgetAmount: 200000,
      currency: 'CNY'
    })

    expect(saved.id).toBeGreaterThan(0)
    expect(saved.label).toBe('2026 秋季学期')
    expect(saved.budgetAmount).toBe(200000)

    const listed = services.statistics.listCustomPeriods()
    expect(listed).toHaveLength(1)
    expect(listed[0].from).toBe('2026-09-01')

    services.statistics.deleteCustomPeriod(saved.id)
    expect(services.statistics.listCustomPeriods()).toHaveLength(0)
  })

  it('refuses a saved period with an empty name', () => {
    expect(() => services.statistics.saveCustomPeriod({ label: '   ', from: '2026-09-01', to: '2026-09-30' })).toThrow(
      /名称/
    )
  })
})

describe('exchange rate service', () => {
  it('has no rates before anything is fetched', () => {
    expect(services.exchange.getTable()).toBeNull()
    expect(services.exchange.status().hasRates).toBe(false)
  })

  it('stores and reads back a manual rate table', () => {
    const table = services.exchange.setManualRates({ CNY: 1, MYR: 0.6, USD: 0.15 }, 'CNY')

    expect(table.base).toBe('CNY')
    expect(table.isManual).toBe(true)

    const cached = services.exchange.getTable()
    expect(cached).not.toBeNull()
    expect(cached!.rates.MYR).toBeCloseTo(0.6, 10)
    // The identity rate is always present so a base-currency lookup cannot fail.
    expect(cached!.rates.CNY).toBe(1)

    expect(services.exchange.status().isManual).toBe(true)
  })

  it('rejects a manual table with no usable rates', () => {
    expect(() => services.exchange.setManualRates({})).toThrow()
    expect(() => services.exchange.setManualRates({ MYR: 0 })).toThrow()
    expect(() => services.exchange.setManualRates({ MYR: -1 })).toThrow()
  })

  it('clears the table', () => {
    services.exchange.setManualRates({ CNY: 1, MYR: 0.6 }, 'CNY')
    services.exchange.clear()
    expect(services.exchange.getTable()).toBeNull()
  })

  it('replaces rather than merges, so a dropped currency cannot linger', () => {
    services.exchange.setManualRates({ CNY: 1, MYR: 0.6, USD: 0.15 }, 'CNY')
    services.exchange.setManualRates({ CNY: 1, MYR: 0.61 }, 'CNY')

    const cached = services.exchange.getTable()
    expect(cached!.rates.MYR).toBeCloseTo(0.61, 10)
    // USD is gone rather than remaining as a silently stale rate.
    expect(cached!.rates.USD).toBeUndefined()
  })

  it('falls back to the cached table when every provider fails', async () => {
    services.exchange.setManualRates({ CNY: 1, MYR: 0.6 }, 'CNY')

    // Every request fails, as it would with no network.
    const failingFetch = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch
    const offline = new (await import('@main/services/exchange')).ExchangeRateService(handle.db, failingFetch)

    const result = await offline.refresh('CNY')
    expect(result).toBeNull()
    // The previously cached rates survive an offline refresh.
    expect(offline.getTable()!.rates.MYR).toBeCloseTo(0.6, 10)
  })

  it('parses a provider payload into a usable table', async () => {
    const { ExchangeRateService } = await import('@main/services/exchange')

    const fakeFetch = (() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            result: 'success',
            base_code: 'CNY',
            time_last_update_utc: 'Sat, 26 Sep 2026 00:02:32 +0000',
            rates: { CNY: 1, MYR: 0.606575, USD: 0.148707, BAD: 0, WORSE: 'x' }
          })
      })) as unknown as typeof fetch

    const service = new ExchangeRateService(handle.db, fakeFetch)
    const outcome = await service.refresh('CNY')

    expect(outcome).not.toBeNull()
    const table = outcome!.table
    expect(table.base).toBe('CNY')
    expect(table.rates.MYR).toBeCloseTo(0.606575, 10)
    expect(table.provider).toBe('er-api')
    // Invalid entries are dropped rather than coerced into a NaN-producing rate.
    expect(table.rates.BAD).toBeUndefined()
    expect(table.rates.WORSE).toBeUndefined()
  })
})
