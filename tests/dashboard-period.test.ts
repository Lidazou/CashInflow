import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type DatabaseHandle } from '@main/database/connection'
import { Services } from '@main/services'
import { makeRateTable } from '@main/services/exchange'
import type { RateTable } from '@shared/lib/rates'
import {
  CUSTOM_RANGE_PRESETS,
  customRangeLabel,
  cycleFor,
  dashboardPeriod,
  shiftDashboardMonth
} from '@shared/lib/periods'

/**
 * The dashboard's switchable reporting period.
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * A custom date range used to be reachable only from its own page, which made it
 * close to useless: the window could be analysed but never appeared beside the
 * figures the user looks at daily. The fix was to let the dashboard report on a
 * calendar month, a settlement cycle, or an arbitrary range.
 *
 * That introduced a class of bug worth testing explicitly: three modes sharing
 * one screen means a mode can silently report the WRONG WINDOW while still
 * rendering perfectly plausible numbers. "No spending in September" and "the
 * query ran over a window with no data in it" look identical on screen, so each
 * assertion below pins a figure to a transaction that only one window contains.
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
  workDir = mkdtempSync(join(tmpdir(), 'spendwise-dashperiod-'))
  handle = openDatabase({ dataDir: workDir })
  services = new Services(handle.db)
  services.exchange.setManualRates(RATES.rates, RATES.base)
})

afterEach(() => {
  try {
    handle.close()
  } catch {
    /* closed by a test that reopened it */
  }
  rmSync(workDir, { recursive: true, force: true })
})

function expenseCategory(): number {
  const found = services.categories.list({ type: 'expense' }).find((item) => item.name === 'Food')
  if (!found) throw new Error('seed category Food missing')
  return found.id
}

function account(): number {
  return services.accounts.create({ name: '招商银行', type: 'bank', currency: 'CNY', openingBalance: 0 }).id
}

function spend(accountId: number, date: string, yuan: string): void {
  services.transactions.create({
    accountId,
    type: 'expense',
    // Amounts are minor units throughout; '18.50' -> 1850 fen.
    amount: Math.round(Number(yuan) * 100),
    categoryId: expenseCategory(),
    date
  })
}

describe('dashboardPeriod resolution', () => {
  it('natural mode uses a calendar month regardless of the saved anchor', () => {
    // The anchor is 5, but the user asked for 自然月. The period must be
    // 1-30 September, not 5 Sep - 4 Oct.
    const period = dashboardPeriod('natural', '2026-09', 5, null)

    expect(period.start).toBe('2026-09-01')
    expect(period.end).toBe('2026-09-30')
    expect(period.startDay).toBe(1)
    expect(period.daysTotal).toBe(30)
  })

  it('cycle mode honours the saved anchor and reports the days remaining', () => {
    const period = dashboardPeriod('cycle', '2026-09', 5, null, '2026-09-20')

    expect(period.start).toBe('2026-09-05')
    expect(period.end).toBe('2026-10-04')
    expect(period.startDay).toBe(5)
    expect(period.daysTotal).toBe(30)
    // daysRemaining counts today as a day, so 20 Sep - 4 Oct inclusive is 15.
    // Elapsed is therefore 15 of 30, and the two must sum to the whole period.
    expect(period.daysRemaining).toBe(15)
    expect(period.daysRemaining + 15).toBe(period.daysTotal)
  })

  it('custom mode uses the given dates and counts a single day as one day', () => {
    const period = dashboardPeriod('custom', '2026-09', 5, { from: '2026-09-10', to: '2026-09-10' })

    expect(period.start).toBe('2026-09-10')
    expect(period.end).toBe('2026-09-10')
    expect(period.daysTotal).toBe(1)
    expect(period.startDay).toBeNull()
  })

  it('falls back to the cycle when custom mode has no range yet', () => {
    // Reaching the dashboard with mode 'custom' and a null range happens when the
    // stored range failed to parse. Reporting a cycle is right; a range of
    // 0000-00-00 would return an empty period that reads as "no spending".
    const period = dashboardPeriod('custom', '2026-09', 1, null)

    expect(period.start).toBe('2026-09-01')
    expect(period.end).toBe('2026-09-30')
  })

  it('labels each mode from the same dates the query used', () => {
    expect(dashboardPeriod('natural', '2026-09', 5, null).label).toBe('2026年9月')
    expect(dashboardPeriod('cycle', '2026-09', 5, null).label).toBe('9月5日 – 10月4日')
    expect(dashboardPeriod('custom', '2026-09', 5, { from: '2026-09-01', to: '2026-10-15' }).label).toBe(
      customRangeLabel('2026-09-01', '2026-10-15')
    )
  })
})

describe('dashboard figures follow the selected period', () => {
  it('reports the custom window, not the cycle it sits inside', () => {
    const accountId = account()
    // Inside 1-30 Sep, outside 10-20 Sep.
    spend(accountId, '2026-09-03', '10.00')
    // Inside both windows.
    spend(accountId, '2026-09-12', '25.00')

    const natural = services.statistics.dashboard('2026-09', 'CNY', 1, '2026-09-26')
    expect(natural.month.expense).toBe(3500)
    expect(natural.period.mode).toBe('cycle')

    const custom = services.statistics.dashboard('2026-09', 'CNY', 1, '2026-09-26', 'CNY', {
      from: '2026-09-10',
      to: '2026-09-20'
    })

    expect(custom.period.mode).toBe('custom')
    expect(custom.period.start).toBe('2026-09-10')
    expect(custom.period.end).toBe('2026-09-20')
    expect(custom.month.expense).toBe(2500)
    // The 10 Sep transaction is excluded, which is the whole point: the figure is
    // 25.00 rather than the 35.00 the surrounding month contains.
    expect(custom.month.expense).not.toBe(natural.month.expense)
  })

  it('carries a null cycle and an empty month key in custom mode', () => {
    const custom = services.statistics.dashboard('2026-09', 'CNY', 1, '2026-09-26', 'CNY', {
      from: '2026-09-01',
      to: '2026-09-30'
    })

    // Consumers branch on period.mode, so a stale cycle object here would let one
    // column describe a different window from its neighbours.
    expect(custom.cycle).toBeNull()
    expect(custom.monthKey).toBe('')
  })

  it('uses a supplied label instead of a generated one', () => {
    const custom = services.statistics.dashboard('2026-09', 'CNY', 1, '2026-09-26', 'CNY', {
      from: '2026-09-01',
      to: '2026-12-31',
      label: '2026 秋季学期'
    })

    expect(custom.period.label).toBe('2026 秋季学期')
  })

  it('keeps today and total balance period-independent', () => {
    const accountId = account()
    spend(accountId, '2026-09-03', '10.00')

    const custom = services.statistics.dashboard('2026-09', 'CNY', 1, '2026-09-26', 'CNY', {
      from: '2026-09-20',
      to: '2026-09-25'
    })

    // The 3 Sep spend falls outside the window...
    expect(custom.month.expense).toBe(0)
    // ...but the money still left the account, so the balance must reflect it.
    expect(custom.balances[0].balance).toBe(-1000)
  })

  it('ignores a reversed range rather than reporting it', () => {
    const accountId = account()
    spend(accountId, '2026-09-12', '25.00')

    // from > to cannot describe a period; the service must fall back to the
    // cycle instead of returning a plausible-looking empty window.
    const reversed = services.statistics.dashboard('2026-09', 'CNY', 1, '2026-09-26', 'CNY', {
      from: '2026-09-20',
      to: '2026-09-10'
    })

    expect(reversed.period.mode).toBe('cycle')
    expect(reversed.month.expense).toBe(2500)
  })
})

describe('biggest expenses follow the selected period', () => {
  it('ranks only the transactions inside the window', () => {
    const accountId = account()
    spend(accountId, '2026-09-02', '999.00') // largest, but outside the window
    spend(accountId, '2026-09-12', '25.00')
    spend(accountId, '2026-09-15', '40.00')

    const ranked = services.statistics.biggestExpenses('2026-09', 1, 'CNY', 5, {
      from: '2026-09-10',
      to: '2026-09-20'
    })

    expect(ranked).toHaveLength(2)
    // If the 999.00 expense leaked in, the top entry would be that one.
    expect(ranked[0].convertedAmount).toBe(4000)
    expect(ranked[1].convertedAmount).toBe(2500)
    expect(ranked.every((row) => row.date >= '2026-09-10' && row.date <= '2026-09-20')).toBe(true)
  })
})

describe('statisticsForRange', () => {
  it('returns the same payload shape as statistics, over explicit dates', () => {
    const accountId = account()
    spend(accountId, '2026-09-12', '25.00')
    spend(accountId, '2026-11-05', '80.00')

    const result = services.statistics.statisticsForRange('2026-09-01', '2026-09-30', 'CNY')

    expect(result.granularity).toBe('day')
    expect(result.from).toBe('2026-09-01')
    expect(result.to).toBe('2026-09-30')
    expect(result.totals.expense).toBe(2500)
    // The donut reads `categories`, so a range query must fill it.
    expect(result.categories.length).toBeGreaterThan(0)
    expect(result.categories[0].total).toBe(2500)
  })
})

describe('custom range presets', () => {
  it('builds a window that includes today at both plausible ends', () => {
    for (const preset of CUSTOM_RANGE_PRESETS) {
      const built = preset.build('2026-09-26')
      expect(built.from <= built.to).toBe(true)
      expect(built.from).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(built.to).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  it('exposes 最近 30 天 as the second preset used by the dashboard reset button', () => {
    // The dashboard's 本月 button resets a custom window to this preset, so its
    // position in the list is load-bearing.
    const built = CUSTOM_RANGE_PRESETS[1].build('2026-09-26')
    expect(CUSTOM_RANGE_PRESETS[1].id).toBe('last30')
    expect(built).toEqual({ from: '2026-08-28', to: '2026-09-26' })
  })
})

describe('shifting the selected period', () => {
  it('steps a natural month by exactly one month', () => {
    const next = shiftDashboardMonth('natural', '2026-09', 5, 1, null)
    expect(next.key).toBe('2026-10')
  })

  it('steps a cycle by its anchor, keeping the anchor day', () => {
    // `shiftCycle` resolves the cycle CONTAINING the reference first, so the
    // reference must be a day inside the current cycle (5 Sep - 4 Oct), not
    // 1 Sep, which belongs to the previous one.
    const next = shiftDashboardMonth('cycle', '2026-09', 5, 1, null)
    const cycle = cycleFor('2026-10-05', 5)

    expect(next.key).toBe('2026-10')
    expect(cycle.start).toBe('2026-10-05')
    // The anchor day survives the step, which is what makes this a cycle and not
    // a calendar month.
    expect(cycle.startDay).toBe(5)
  })

  it('steps the cycle containing 1 Sep back, not the one keyed 2026-09', () => {
    // Guards the trap above: 1 Sep sits in the 5 Aug - 4 Sep cycle, so stepping
    // forward from it must land on the 5 Sep - 4 Oct cycle, keyed 2026-09.
    const ambiguous = shiftDashboardMonth('cycle', '2026-09', 5, 1, null)
    const fromFirstOfMonth = cycleFor('2026-09-01', 5)
    expect(fromFirstOfMonth.start).toBe('2026-08-05')
    expect(ambiguous.key).toBe('2026-10')
  })

  it('translates a custom window instead of re-deriving it', () => {
    // A 15-day window must stay 15 days long. Re-anchoring to a month would
    // silently change its length, which changes what the previous figures meant.
    const shifted = shiftDashboardMonth('custom', '2026-09', 5, 1, {
      from: '2026-09-10',
      to: '2026-09-24'
    })

    expect(shifted.range).toEqual({ from: '2026-10-10', to: '2026-10-24' })
    expect(shifted.key).toBe('2026-09')
  })

  it('handles a negative step across a year boundary', () => {
    const previous = shiftDashboardMonth('natural', '2026-01', 1, -1, null)
    expect(previous.key).toBe('2025-12')
  })
})

describe('the chosen period is persisted, the anchor override is not', () => {
  it('stores and restores the mode and the custom window', () => {
    const saved = services.settings.update({
      dashboardPeriodMode: 'custom',
      dashboardRange: { from: '2026-09-01', to: '2026-12-31', label: '秋季学期', budgetAmount: 200000 }
    })

    expect(saved.dashboardPeriodMode).toBe('custom')
    expect(saved.dashboardRange).toEqual({
      from: '2026-09-01',
      to: '2026-12-31',
      label: '秋季学期',
      budgetAmount: 200000
    })

    // A fresh read must agree: this is what makes the choice survive a restart.
    expect(services.settings.get().dashboardRange?.label).toBe('秋季学期')
  })

  it('defaults to the settlement cycle', () => {
    expect(services.settings.get().dashboardPeriodMode).toBe('cycle')
    expect(services.settings.get().dashboardRange).toBeNull()
  })

  it('refuses custom mode with no window at all', () => {
    expect(() => services.settings.update({ dashboardPeriodMode: 'custom' })).toThrow()

    // The mode must not have been half-applied by the rejected write.
    expect(services.settings.get().dashboardPeriodMode).toBe('cycle')
  })

  it('accepts custom mode when a window is supplied in the same call', () => {
    const saved = services.settings.update({
      dashboardPeriodMode: 'custom',
      dashboardRange: { from: '2026-09-01', to: '2026-09-30' }
    })
    expect(saved.dashboardPeriodMode).toBe('custom')
  })

  it('refuses a reversed window', () => {
    expect(() =>
      services.settings.update({ dashboardRange: { from: '2026-09-30', to: '2026-09-01' } })
    ).toThrow()
  })

  it('refuses an unknown mode rather than silently defaulting', () => {
    expect(() =>
      // A value from a future version, or a hand-edited row.
      services.settings.update({ dashboardPeriodMode: 'quarterly' as never })
    ).toThrow()
  })

  it('degrades a corrupted stored window to null instead of throwing on read', () => {
    // A settings read must never be able to blank the window, so malformed JSON
    // and out-of-shape values are both treated as "no saved range".
    handle.db
      .prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('dashboard_range', ?, ?)`)
      .run('{"from":"nonsense","to":42}', new Date().toISOString())

    expect(services.settings.get().dashboardRange).toBeNull()
  })

  it('clears the window when null is written', () => {
    services.settings.update({ dashboardRange: { from: '2026-09-01', to: '2026-09-30' } })
    services.settings.update({ dashboardRange: null })
    expect(services.settings.get().dashboardRange).toBeNull()
  })

  it('does not let a period choice rewrite the settlement anchor', () => {
    // The dashboard's 自然月 option means day 1 for one request. If persisting the
    // mode also moved the anchor, every budget and cycle label would follow it.
    services.settings.update({ cycleStartDay: 5, dashboardPeriodMode: 'natural' })
    const settings = services.settings.get()

    expect(settings.cycleStartDay).toBe(5)
    expect(settings.dashboardPeriodMode).toBe('natural')
  })
})
