import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type DatabaseHandle } from '@main/database/connection'
import { Services } from '@main/services'
import { makeRateTable } from '@main/services/exchange'
import {
  bucketLabel,
  bucketStart,
  chooseGranularity,
  KLINE_GRANULARITY_THRESHOLDS,
  KLINE_MAX_TRANSACTIONS_PER_BUCKET,
  KlineService,
  movingAverages,
  nextBucketKey,
  normaliseMaWindows
} from '@main/services/kline'
import { lookupRate, type RateTable } from '@shared/lib/rates'
import { minorUnitScale } from '@shared/lib/money'
import { addDays, nowIso } from '@shared/lib/dates'

/**
 * The K-line (candlestick) balance series.
 *
 * WHY THIS SUITE IS SO PICKY
 * --------------------------
 * A candle chart is the one view where being wrong is invisible. Every figure on
 * it is a balance the user can look up elsewhere in the app, so the failure modes
 * are not crashes but plausible-looking lines:
 *
 *   - a series rebuilt from the chart's own flows starts at zero and is wrong by
 *     the user's opening balance, forever;
 *   - a dropped empty bucket draws a straight line across a month with no
 *     activity, which reads as "nothing happened";
 *   - a body-only high/low hides a mid-month salary spike;
 *   - a partial MA window draws a line that looks exactly like a real one;
 *   - a daily series that rounds each day on its own drifts away from the totals
 *     the buckets report, so a zoomed week disagrees with the month it sits in;
 *   - converting fen and sen with `SUM(amount)` produces a confident number of
 *     nothing.
 *
 * Each test below pins one of those to a hand-computed figure rather than to
 * "whatever the implementation returns".
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
  workDir = mkdtempSync(join(tmpdir(), 'spendwise-kline-'))
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

function withRates(table: RateTable): void {
  services.exchange.setManualRates(table.rates, table.base)
}

function categoryId(name: string, type: 'income' | 'expense'): number {
  const found = services.categories.list({ type }).find((item) => item.name === name)
  if (!found) throw new Error(`seed category ${name} missing`)
  return found.id
}

function account(name: string, currency: string, openingBalance: number): number {
  return services.accounts.create({ name, type: 'bank', currency, openingBalance }).id
}

/** Record a transaction from a MAJOR-unit string, e.g. '18.50' -> 1850 fen. */
function record(
  accountId: number,
  type: 'income' | 'expense',
  date: string,
  major: number,
  options: { time?: string | null; merchant?: string | null; currency?: string } = {}
): number {
  const currency = options.currency ?? 'CNY'
  const category = type === 'income' ? categoryId('Salary', 'income') : categoryId('Food', 'expense')
  return services.transactions.create({
    accountId,
    type,
    amount: Math.round(major * minorUnitScale(currency)),
    categoryId: category,
    date,
    time: options.time ?? null,
    merchant: options.merchant ?? null
  }).id
}

/**
 * A transfer between accounts in DIFFERENT currencies, written straight to the
 * ledger.
 *
 * `TransactionsService.createTransfer` refuses this pair today (it has no rate to
 * record the two legs with), so this builds the rows by hand to represent a
 * ledger that contains one — an older import, or a hand-edited file. The series
 * must still total the balance from exactly what the ledger stores. It is also
 * the sharpest form of the "transfers are included in the balance" rule: two legs
 * with different magnitudes that do NOT cancel once converted.
 */
function insertCrossCurrencyTransfer(
  fromAccountId: number,
  toAccountId: number,
  fromAmount: number,
  toAmount: number,
  date: string
): void {
  const timestamp = nowIso()
  const info = handle.db
    .prepare(
      `INSERT INTO transfers (from_account_id, to_account_id, amount, date, time, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, '换汇', ?, ?)`
    )
    .run(fromAccountId, toAccountId, fromAmount, date, timestamp, timestamp)

  const transferId = Number(info.lastInsertRowid)
  const insertLeg = handle.db.prepare(
    `INSERT INTO transactions
       (account_id, type, amount, category_id, date, time, merchant, note, transfer_id, created_at, updated_at)
     VALUES (?, 'transfer', ?, NULL, ?, NULL, NULL, NULL, ?, ?, ?)`
  )
  insertLeg.run(fromAccountId, -fromAmount, date, transferId, timestamp, timestamp)
  insertLeg.run(toAccountId, toAmount, date, transferId, timestamp, timestamp)
}

/** The accounts page's own total, converted the same way the series converts it. */
function accountsTotalIn(displayCurrency: string, rates: RateTable | null): number {
  const totalMajor = services.accounts.list().reduce((sum, item) => {
    const rate = lookupRate(rates, item.currency, displayCurrency)
    if (rate === null) return sum
    return sum + (item.balance / minorUnitScale(item.currency)) * rate
  }, 0)
  return Math.round(totalMajor * minorUnitScale(displayCurrency))
}

describe('chooseGranularity', () => {
  it('picks a candle size at each boundary, on both sides', () => {
    expect(chooseGranularity(1)).toBe('day')
    expect(chooseGranularity(120)).toBe('day')
    expect(chooseGranularity(121)).toBe('week')
    expect(chooseGranularity(400)).toBe('week')
    expect(chooseGranularity(401)).toBe('month')
    expect(chooseGranularity(1100)).toBe('month')
    expect(chooseGranularity(1101)).toBe('quarter')
    expect(chooseGranularity(2600)).toBe('quarter')
    expect(chooseGranularity(2601)).toBe('year')
    expect(chooseGranularity(20_000)).toBe('year')
  })

  it('treats a missing or corrupt span as the shortest history, not the longest', () => {
    // NaN and 0 are corrupt values, not large ones. Falling through to 'year'
    // would collapse a single afternoon of records into one candle.
    expect(chooseGranularity(0)).toBe('day')
    expect(chooseGranularity(-30)).toBe('day')
    expect(chooseGranularity(Number.NaN)).toBe('day')
  })

  it('declares its thresholds in ascending order, ending open-ended', () => {
    const bounds = KLINE_GRANULARITY_THRESHOLDS.map((step) => step.maxSpanDays)
    expect(bounds).toEqual([...bounds].sort((a, b) => a - b))
    expect(bounds[bounds.length - 1]).toBe(Number.POSITIVE_INFINITY)
    // Every granularity the type allows must be reachable, or a chart size exists
    // that can never be drawn.
    expect(KLINE_GRANULARITY_THRESHOLDS.map((step) => step.granularity)).toEqual([
      'day',
      'week',
      'month',
      'quarter',
      'year'
    ])
  })

  it('measures the span in calendar days, not in days that have data', () => {
    const id = account('招商银行', 'CNY', 0)
    // Three years apart: two days with data, a 1,097-day chart.
    record(id, 'income', '2023-01-10', 100)
    record(id, 'income', '2026-01-10', 100)

    const series = services.kline.series('CNY')
    expect(series.granularity).toBe('month')
    // 37 month buckets. A "days with data" reading would have said 2 days and
    // produced 1,097 one-day candles.
    expect(series.points.length).toBe(37)
  })
})

describe('bucket boundaries and labels', () => {
  it('starts buckets on the calendar boundary each granularity names', () => {
    // 2026-09-26 is a Saturday; the ISO week containing it starts Monday the 21st.
    expect(bucketStart('2026-09-26', 'day')).toBe('2026-09-26')
    expect(bucketStart('2026-09-26', 'week')).toBe('2026-09-21')
    expect(bucketStart('2026-09-26', 'month')).toBe('2026-09-01')
    expect(bucketStart('2026-09-26', 'quarter')).toBe('2026-07-01')
    expect(bucketStart('2026-09-26', 'year')).toBe('2026-01-01')
    // A Sunday must not start its own week.
    expect(bucketStart('2026-09-27', 'week')).toBe('2026-09-21')
  })

  it('steps to the next bucket without landing on a short one', () => {
    expect(nextBucketKey('2026-09-26', 'day')).toBe('2026-09-27')
    expect(nextBucketKey('2026-09-21', 'week')).toBe('2026-09-28')
    expect(nextBucketKey('2026-01-01', 'month')).toBe('2026-02-01')
    expect(nextBucketKey('2026-10-01', 'quarter')).toBe('2027-01-01')
    expect(nextBucketKey('2026-01-01', 'year')).toBe('2027-01-01')
    // The trap a hand-rolled '+1 month on the 31st' hits.
    expect(nextBucketKey('2026-01-31', 'month')).toBe('2026-02-28')
  })

  it('labels every granularity from the bucket key alone', () => {
    expect(bucketLabel('2026-09-26', 'day')).toBe('9月26日')
    expect(bucketLabel('2026-09-21', 'week')).toBe('2026年第39周')
    expect(bucketLabel('2026-09-01', 'month')).toBe('2026年9月')
    expect(bucketLabel('2026-07-01', 'quarter')).toBe('2026年Q3')
    expect(bucketLabel('2026-01-01', 'year')).toBe('2026年')
  })

  it('spans a year boundary without dropping or duplicating a bucket', () => {
    const id = account('招商银行', 'CNY', 0)
    record(id, 'income', '2025-11-10', 100)
    record(id, 'income', '2026-02-03', 100)

    const series = services.kline.series('CNY', 'month')
    expect(series.points.map((point) => point.date)).toEqual([
      '2025-11-01',
      '2025-12-01',
      '2026-01-01',
      '2026-02-01'
    ])
    expect(series.points.map((point) => point.label)).toEqual([
      '2025年11月',
      '2025年12月',
      '2026年1月',
      '2026年2月'
    ])
    // `from` is where the candles start, `to` is the last day actually recorded —
    // not the last bucket's end, which can lie in the future.
    expect(series.from).toBe('2025-11-01')
    expect(series.to).toBe('2026-02-03')
  })
})

describe('gapless buckets', () => {
  it('keeps an empty bucket, carrying the balance forward with zero flows', () => {
    const id = account('招商银行', 'CNY', 0)
    record(id, 'income', '2026-09-01', 100)
    record(id, 'expense', '2026-09-03', 25)

    const series = services.kline.series('CNY', 'day')
    expect(series.points.map((point) => point.date)).toEqual(['2026-09-01', '2026-09-02', '2026-09-03'])

    const gap = series.points[1]
    expect(gap.date).toBe('2026-09-02')
    expect(gap.transactionCount).toBe(0)
    expect(gap.income).toBe(0)
    expect(gap.expense).toBe(0)
    expect(gap.net).toBe(0)
    expect(gap.sources).toEqual([])
    expect(gap.transactions).toEqual([])
    // The balance did not vanish: it is the same money, one day later.
    expect(gap.balanceOpen).toBe(10000)
    expect(gap.balanceClose).toBe(10000)
    expect(gap.balanceHigh).toBe(10000)
    expect(gap.balanceLow).toBe(10000)
    expect(gap.deltaBalance).toBe(0)

    // Buckets chain: every candle opens exactly where the previous one closed.
    for (let i = 1; i < series.points.length; i += 1) {
      expect(series.points[i].balanceOpen).toBe(series.points[i - 1].balanceClose)
    }
    expect(series.points[2].balanceClose).toBe(7500)
  })

  it('fills a skipped month at month granularity rather than joining the neighbours', () => {
    const id = account('招商银行', 'CNY', 0)
    record(id, 'income', '2026-06-10', 1000)
    record(id, 'expense', '2026-08-10', 400)

    const series = services.kline.series('CNY', 'month')
    expect(series.points.map((point) => point.date)).toEqual(['2026-06-01', '2026-07-01', '2026-08-01'])

    const july = series.points[1]
    expect(july.income).toBe(0)
    expect(july.expense).toBe(0)
    // Dropping July would draw one straight line from 1000 to 600 and read as
    // "nothing happened"; the line is the same, but the bucket count is not.
    expect(july.balanceOpen).toBe(100000)
    expect(july.balanceClose).toBe(100000)
    expect(series.points[2].balanceClose).toBe(60000)
  })
})

describe('the balance is a real balance', () => {
  it('ends on exactly the balance the accounts service reports, transfers included', () => {
    withRates(RATES)

    const bank = account('招商银行', 'CNY', 500000)
    const cash = account('现金', 'CNY', 0)
    const myr = account('Maybank', 'MYR', 1850)

    record(bank, 'income', '2026-09-02', 1000)
    record(bank, 'expense', '2026-09-05', 300)
    record(myr, 'expense', '2026-09-12', 4.5, { currency: 'MYR' })
    services.transactions.createTransfer({
      fromAccountId: bank,
      toAccountId: cash,
      amount: 20000,
      date: '2026-09-08'
    })

    const series = services.kline.series('CNY', 'month')
    const last = series.points[series.points.length - 1]

    // THE ASSERTION THIS WHOLE FILE EXISTS FOR. The chart's last candle must be
    // the same number the accounts page shows, or one of the two is lying.
    expect(last.balanceClose).toBe(accountsTotalIn('CNY', RATES))
    // And the accounts page is not simply echoing the chart: the naive
    // cross-currency sum is a different number.
    const naive = services.accounts.list().reduce((sum, item) => sum + item.balance, 0)
    expect(last.balanceClose).not.toBe(naive)

    // Opening balance is the y-axis baseline, not zero: ¥5,000 plus RM18.50
    // converted once at the end (3050 fen, per the multi-currency suite).
    expect(series.openingBalance).toBe(503050)
    expect(series.points[0].balanceOpen).toBe(503050)

    for (let i = 1; i < series.points.length; i += 1) {
      expect(series.points[i].balanceOpen).toBe(series.points[i - 1].balanceClose)
    }
  })

  it('starts from the opening balance even when the first bucket has no activity of its own', () => {
    withRates(RATES)
    const id = account('招商银行', 'CNY', 250000)
    record(id, 'expense', '2026-09-20', 100)

    const series = services.kline.series('CNY', 'month')
    const september = series.points[0]

    expect(september.balanceOpen).toBe(250000)
    expect(september.expense).toBe(10000)
    expect(september.balanceClose).toBe(240000)
    expect(series.openingBalance).toBe(250000)
  })

  it('reports an empty series, with the opening balance, when nothing is recorded', () => {
    account('招商银行', 'CNY', 100000)

    const series = services.kline.series('CNY')

    expect(series.points).toEqual([])
    expect(series.daily).toEqual([])
    expect(series.from).toBe('')
    expect(series.to).toBe('')
    // No synthetic candle: the balance is reported, but no data point is invented.
    expect(series.openingBalance).toBe(100000)
    expect(series.hasUnconverted).toBe(false)
    expect(series.maReadyFrom[5]).toBeNull()
  })
})

describe('candle wicks', () => {
  it('detects a spike that the bucket open and close would hide', () => {
    const id = account('招商银行', 'CNY', 10000)
    record(id, 'income', '2026-09-10', 5000)
    record(id, 'expense', '2026-09-20', 5000)

    const [september] = services.kline.series('CNY', 'month').points

    // A salary that arrives and is spent again inside one month leaves the body
    // flat. A wick built from open/close alone would say the month was quiet.
    expect(september.balanceOpen).toBe(10000)
    expect(september.balanceClose).toBe(10000)
    expect(september.balanceHigh).toBe(510000)
    expect(september.balanceLow).toBe(10000)
  })

  it('detects a dip that the bucket open and close would hide', () => {
    const id = account('招商银行', 'CNY', 100000)
    record(id, 'expense', '2026-09-15', 800)
    record(id, 'income', '2026-09-25', 800)

    const [september] = services.kline.series('CNY', 'month').points

    expect(september.balanceOpen).toBe(100000)
    expect(september.balanceClose).toBe(100000)
    expect(september.balanceLow).toBe(20000)
    expect(september.balanceHigh).toBe(100000)
  })

  it('gives a single day a real wick from its own transactions', () => {
    const id = account('招商银行', 'CNY', 0)
    record(id, 'income', '2026-09-01', 100)
    record(id, 'expense', '2026-09-01', 30)

    const [day] = services.kline.series('CNY', 'day').points

    // The day started at nothing, peaked at ¥100 the moment the income landed, and
    // closed at ¥70 — so the wick spans the whole range the balance travelled.
    //
    // This used to assert high === low === close, on the reasoning that a day is the
    // finest bucket and therefore has no internal structure. Per-transaction markers
    // gave it one: the balance genuinely reached ¥100 even though it never ended a day
    // there, and a candle that hides that is hiding the salary.
    expect(day.balanceOpen).toBe(0)
    expect(day.balanceHigh).toBe(10000)
    expect(day.balanceLow).toBe(0)
    expect(day.balanceClose).toBe(7000)
  })

  it('positions each transaction on the balance curve, in order', () => {
    const id = account('招商银行', 'CNY', 100000)
    record(id, 'expense', '2026-09-15', 800)
    record(id, 'income', '2026-09-15', 800)
    record(id, 'expense', '2026-09-15', 50)

    const [day] = services.kline.series('CNY', 'day').points

    // 100000 → 20000 → 100000 → 95000, so the markers sit at exactly those balances.
    expect(day.markers).toHaveLength(3)
    expect(day.markers.map((marker) => marker.balanceAfter)).toEqual([20000, 100000, 95000])
    expect(day.markers.map((marker) => marker.balanceBefore)).toEqual([100000, 20000, 100000])
    // The extremes follow from the markers, not from open and close.
    expect(day.balanceLow).toBe(20000)
    expect(day.balanceHigh).toBe(100000)
  })

  it('reports the net change as a ratio of the bucket opening balance', () => {
    // `account()` takes MINOR units like the rest of the fixtures: 100000 fen = ¥1,000.
    const id = account('招商银行', 'CNY', 100000)
    record(id, 'income', '2026-09-15', 500)

    const [day] = services.kline.series('CNY', 'day').points
    expect(day.balanceOpen).toBe(100000)
    expect(day.balanceClose).toBe(150000)
    // ¥500 on top of ¥1,000 is +50%, and the denominator is where THIS bucket
    // started rather than the balance years ago.
    expect(day.changeRatio).toBeCloseTo(0.5, 10)
  })

  it('leaves the change ratio null when there was nothing to grow from', () => {
    const id = account('招商银行', 'CNY', 0)
    record(id, 'income', '2026-09-15', 500)

    // "Up 100% from nothing" is not a percentage anyone can act on, so it is not
    // reported as one.
    const [day] = services.kline.series('CNY', 'day').points
    expect(day.changeRatio).toBeNull()
  })
})

/**
 * The OHLC definition, asserted case by case.
 *
 * These are the eleven scenarios the v1.5 specification names, written against the
 * exact numbers it gives. Several overlap with the tests above — a candle that
 * detects a spike is also "income only" — and that is deliberate: those tests exist
 * to prove the mechanism works over a real series, these exist so that the
 * DEFINITION itself is pinned somewhere a reader can compare it against the spec
 * line by line. When they disagree, one of the two has changed meaning.
 */
describe('OHLC, case by case', () => {
  it('Test 1 — income only: 5000 +3000', () => {
    const id = account('招商银行', 'CNY', 500000)
    record(id, 'income', '2026-09-26', 3000, { time: '09:00' })

    const [day] = services.kline.series('CNY', 'day').points
    expect(day.balanceOpen).toBe(500000)
    expect(day.balanceHigh).toBe(800000)
    expect(day.balanceLow).toBe(500000)
    expect(day.balanceClose).toBe(800000)
  })

  it('Test 2 — expense only: 5000 −500', () => {
    const id = account('招商银行', 'CNY', 500000)
    record(id, 'expense', '2026-09-26', 500, { time: '12:00' })

    const [day] = services.kline.series('CNY', 'day').points
    expect(day.balanceOpen).toBe(500000)
    expect(day.balanceHigh).toBe(500000)
    expect(day.balanceLow).toBe(450000)
    expect(day.balanceClose).toBe(450000)
  })

  it('Test 3 — income then spending: 5000 → 8000 → 7390', () => {
    const id = account('招商银行', 'CNY', 500000)
    record(id, 'income', '2026-09-26', 3000, { time: '09:00' })
    record(id, 'expense', '2026-09-26', 610, { time: '20:00' })

    const [day] = services.kline.series('CNY', 'day').points
    // The peak the specification asks for: the salary peak, not the close.
    expect(day.balanceHigh).toBe(800000)
    expect(day.balanceLow).toBe(500000)
    expect(day.balanceClose).toBe(739000)
  })

  it('Test 4 — spending then income: 5000 → 4500 → 7000', () => {
    const id = account('招商银行', 'CNY', 500000)
    record(id, 'expense', '2026-09-26', 500, { time: '09:00' })
    record(id, 'income', '2026-09-26', 2500, { time: '18:00' })

    const [day] = services.kline.series('CNY', 'day').points
    // The mirror of Test 3: the LOW is the dip before the income arrived, and the
    // close sits below the high. Ordering by time is what decides which.
    expect(day.balanceOpen).toBe(500000)
    expect(day.balanceHigh).toBe(700000)
    expect(day.balanceLow).toBe(450000)
    expect(day.balanceClose).toBe(700000)
  })

  it('Test 5 — a day with no transactions is flat on the carried balance', () => {
    const id = account('招商银行', 'CNY', 500000)
    record(id, 'income', '2026-09-01', 100)
    record(id, 'income', '2026-09-03', 100)

    const series = services.kline.series('CNY', 'day')
    const quiet = series.daily.find((day) => day.date === '2026-09-02')

    expect(quiet).toBeDefined()
    expect(quiet!.balanceOpen).toBe(quiet!.balanceHigh)
    expect(quiet!.balanceHigh).toBe(quiet!.balanceLow)
    expect(quiet!.balanceLow).toBe(quiet!.balanceClose)
    expect(quiet!.transactionCount).toBe(0)
    expect(quiet!.income).toBe(0)
    expect(quiet!.expense).toBe(0)
  })

  it('Test 6 — a same-currency transfer leaves the total balance untouched', () => {
    const from = account('Maybank', 'CNY', 500000)
    const to = account('现金', 'CNY', 0)

    services.transactions.createTransfer({ fromAccountId: from, toAccountId: to, amount: 50000, date: '2026-09-26' })

    const [day] = services.kline.series('CNY', 'day').points
    expect(day.balanceOpen).toBe(500000)
    expect(day.balanceClose).toBe(500000)
    expect(day.balanceHigh).toBe(500000)
    expect(day.balanceLow).toBe(500000)
    // Moving your own money is not earning or spending it.
    expect(day.income).toBe(0)
    expect(day.expense).toBe(0)
    // The legs are still present as markers, because they really did move balances.
    expect(day.markers).toHaveLength(2)
    expect(day.markers.every((marker) => marker.type === 'transfer')).toBe(true)
  })

  it('Test 7 — a transaction with no time is not given one', () => {
    const id = account('招商银行', 'CNY', 500000)
    // No `time` passed: this is what a bank CSV without a time column produces.
    record(id, 'expense', '2026-09-26', 80)

    const [day] = services.kline.series('CNY', 'day').points
    expect(day.markers[0].time).toBeNull()
    // And the tooltip payload agrees — one answer, not two.
    expect(day.transactions[0].time).toBeNull()
  })

  it('Test 8 — keeps the original amount and adds the converted one', () => {
    withRates(RATES)
    const myr = account('Maybank', 'MYR', 0)
    record(myr, 'expense', '2026-09-26', 100, { currency: 'MYR' })

    const [day] = services.kline.series('CNY', 'day').points

    // The ledger's own number survives untouched...
    expect(day.transactions[0].amount).toBe(10000)
    expect(day.transactions[0].currency).toBe('MYR')
    // ...and the converted figure is a separate field, not an overwrite.
    const expected = Math.round((10000 / 100 / RATES.rates.MYR) * 100)
    expect(day.transactions[0].convertedAmount).toBe(expected)
    expect(day.markers[0].amount).toBe(10000)
    expect(day.markers[0].currency).toBe('MYR')
    expect(day.expense).toBe(expected)
  })

  it('Test 10 — a weekly candle takes the first open, last close and the extremes', () => {
    const id = account('招商银行', 'CNY', 500000)
    // Mon 2026-09-14 .. Sun 2026-09-20 is one week.
    record(id, 'income', '2026-09-14', 3000, { time: '09:00' })
    record(id, 'expense', '2026-09-16', 500, { time: '12:00' })
    record(id, 'expense', '2026-09-18', 300, { time: '12:00' })

    const week = services.kline.series('CNY', 'week').points.find((point) => point.date === '2026-09-14')
    expect(week).toBeDefined()

    const days = services.kline
      .series('CNY', 'day')
      .daily.filter((day) => day.date >= '2026-09-14' && day.date <= '2026-09-20')

    expect(week!.balanceOpen).toBe(days[0].balanceOpen)
    expect(week!.balanceClose).toBe(days[days.length - 1].balanceClose)
    expect(week!.balanceHigh).toBe(Math.max(...days.map((day) => day.balanceHigh)))
    expect(week!.balanceLow).toBe(Math.min(...days.map((day) => day.balanceLow)))
  })

  it('Test 11 — a monthly candle takes the first open, last close and the extremes', () => {
    const id = account('招商银行', 'CNY', 500000)
    record(id, 'income', '2026-09-03', 3000, { time: '09:00' })
    record(id, 'expense', '2026-09-20', 900, { time: '12:00' })

    const month = services.kline.series('CNY', 'month').points.find((point) => point.date === '2026-09-01')
    expect(month).toBeDefined()

    const days = services.kline
      .series('CNY', 'day')
      .daily.filter((day) => day.date >= '2026-09-01' && day.date <= '2026-09-30')

    expect(month!.balanceOpen).toBe(days[0].balanceOpen)
    expect(month!.balanceClose).toBe(days[days.length - 1].balanceClose)
    expect(month!.balanceHigh).toBe(Math.max(...days.map((day) => day.balanceHigh)))
    expect(month!.balanceLow).toBe(Math.min(...days.map((day) => day.balanceLow)))
  })

  it('gives every moving-money entry a marker even when the tooltip list is capped', () => {
    const id = account('招商银行', 'CNY', 500000)
    // Comfortably past KLINE_MAX_TRANSACTIONS_PER_BUCKET.
    for (let i = 0; i < 240; i += 1) {
      record(id, 'expense', '2026-09-26', 1, { time: `0${(i % 9) + 1}:00` })
    }

    const [day] = services.kline.series('CNY', 'day').points

    // The tooltip list is capped so a busy day cannot flood the IPC bridge.
    expect(day.transactions.length).toBeLessThan(240)
    // Markers are NOT: dropping one would misplace every later marker that day.
    expect(day.markers).toHaveLength(240)
    // And the count stays truthful about what was truncated.
    expect(day.transactionCount).toBe(240)
  })
})

describe('moving averages', () => {
  it('returns null until a full window exists, then a hand-computed mean', () => {
    const id = account('招商银行', 'CNY', 0)
    // ¥1 on the 1st, 2nd, 3rd, then a gap on the 4th, then the 5th, 6th, 7th.
    for (const day of ['01', '02', '03', '05', '06', '07']) {
      record(id, 'income', `2026-09-${day}`, 1)
    }

    const series = services.kline.series('CNY', 'day', [3, 5, 10])
    const closes = series.points.map((point) => point.balanceClose)
    // 100, 200, 300, [gap] 300, 400, 500, 600
    expect(closes).toEqual([100, 200, 300, 300, 400, 500, 600])

    expect(series.maWindows).toEqual([3, 5, 10])
    expect(series.points[3].ma[5]).toBeNull()
    // (100+200+300+300+400)/5 — the EMPTY 4 September bucket is one of the five.
    expect(series.points[4].ma[5]).toBe(260)
    // A version that skipped empty buckets would average 5 transactions and land
    // on 300 here, which is exactly the bug the gapless rule prevents.
    expect(series.points[4].ma[5]).not.toBe(300)
    expect(series.points[6].ma[5]).toBe(420)

    // Rounding happens once per emitted value: (300+300+400)/3 = 333.33 -> 333.
    expect(series.points[4].ma[3]).toBe(333)
    expect(series.maReadyFrom[5]).toBe('2026-09-05')
    // Seven buckets cannot carry a 10-bucket window, and saying "ready at the
    // start" would draw a line that does not exist.
    expect(series.maReadyFrom[10]).toBeNull()
    expect(series.points[6].ma[10]).toBeNull()
  })

  it('draws the documented default windows when none are requested', () => {
    const id = account('招商银行', 'CNY', 0)
    record(id, 'income', '2026-09-01', 1)

    const series = services.kline.series('CNY', 'day')
    expect(series.maWindows).toEqual([5, 10, 20, 60, 250])
    expect(series.points[0].ma[250]).toBeNull()
  })

  it('computes the running sum in one pass, with the same results', () => {
    expect(movingAverages([1, 2, 3, 4, 5], [2])).toEqual([{ 2: null }, { 2: 2 }, { 2: 3 }, { 2: 4 }, { 2: 5 }])
    expect(movingAverages([10, 20, 30], [1])).toEqual([{ 1: 10 }, { 1: 20 }, { 1: 30 }])
    expect(movingAverages([], [5])).toEqual([])
    // A window longer than the series is all nulls, never a partial average.
    expect(movingAverages([1, 2], [3])).toEqual([{ 3: null }, { 3: null }])
    // Negative balances average like any other integer.
    expect(movingAverages([-100, -200], [2])).toEqual([{ 2: null }, { 2: -150 }])
  })

  it('normalises the requested windows instead of drawing an unknown line', () => {
    expect(normaliseMaWindows([])).toEqual([5, 10, 20, 60, 250])
    expect(normaliseMaWindows(undefined)).toEqual([5, 10, 20, 60, 250])
    expect(normaliseMaWindows([10, 5, 5])).toEqual([5, 10])
    expect(normaliseMaWindows([0, -3, 2.5, 7])).toEqual([7])
    expect(normaliseMaWindows([0, -3])).toEqual([5, 10, 20, 60, 250])
  })
})

describe('cross-currency figures', () => {
  it('converts each currency once and excludes an unconvertible one', () => {
    // A table that simply lacks THB, which is what a partially-populated provider
    // response looks like. The THB account itself is perfectly valid.
    withRates(makeRateTable('CNY', { CNY: 1, MYR: 0.606575 }))

    const cny = account('招商银行', 'CNY', 0)
    const myr = account('Maybank', 'MYR', 0)
    const thb = account('Krungsri', 'THB', 0)

    record(cny, 'income', '2026-09-10', 100)
    record(myr, 'income', '2026-09-10', 18.5, { currency: 'MYR' })
    record(thb, 'income', '2026-09-10', 5000, { currency: 'THB' })

    const series = services.kline.series('CNY', 'month')
    const [september] = series.points

    // ¥100 + (RM18.50 -> 3050 fen) = 13050. The THB income is excluded, not added
    // at a rate of 1 as 500000 minor units of nothing.
    expect(september.income).toBe(13050)
    expect(september.income).not.toBe(10000 + 1850 + 500000)
    expect(september.hasUnconverted).toBe(true)
    expect(series.hasUnconverted).toBe(true)
    // The count stays truthful even when the money cannot be converted.
    expect(september.transactionCount).toBe(3)

    // Original units per currency, so the tooltip can explain the conversion.
    expect(september.sources).toEqual([
      { currency: 'CNY', income: 10000, expense: 0, net: 10000 },
      { currency: 'MYR', income: 1850, expense: 0, net: 1850 },
      { currency: 'THB', income: 500000, expense: 0, net: 500000 }
    ])

    // The balance is converted per account and excludes THB for the same reason.
    expect(september.balanceClose).toBe(13050)
  })

  it('flags unconverted figures rather than pretending a 1:1 rate', () => {
    // No rate table at all: the first run, offline, before anything is cached.
    const cny = account('招商银行', 'CNY', 10000)
    const myr = account('Maybank', 'MYR', 10000)
    record(cny, 'income', '2026-09-10', 100)
    record(myr, 'income', '2026-09-11', 100, { currency: 'MYR' })

    const series = services.kline.series('CNY', 'month')
    const [september] = series.points

    expect(september.hasUnconverted).toBe(true)
    // The CNY account converts to itself; the MYR one is excluded entirely.
    expect(september.income).toBe(10000)
    expect(september.income).not.toBe(20000)
    // ¥100 opening, and the unconvertible RM100 contributes nothing.
    expect(series.openingBalance).toBe(10000)
    expect(september.balanceClose).toBe(20000)
    expect(series.hasUnconverted).toBe(true)
  })

  it('survives a rate provider that throws', () => {
    const id = account('招商银行', 'CNY', 0)
    record(id, 'income', '2026-09-10', 100)

    const broken = new KlineService(handle.db, () => {
      throw new Error('rates unavailable')
    })
    const series = broken.series('CNY', 'month')

    // A rates failure is not a reason to blank the chart; it is a reason to say
    // the figures are unconverted.
    expect(series.points).toHaveLength(1)
    expect(series.points[0].income).toBe(10000)
    expect(series.hasUnconverted).toBe(false)
    expect(series.points[0].hasUnconverted).toBe(false)
  })
})

describe('transfers', () => {
  it('move the balance but never count as income or spending', () => {
    const bank = account('招商银行', 'CNY', 100000)
    const cash = account('现金', 'CNY', 0)

    services.transactions.createTransfer({
      fromAccountId: bank,
      toAccountId: cash,
      amount: 30000,
      date: '2026-09-09'
    })

    const [september] = services.kline.series('CNY', 'month').points

    // A transfer is not income, not spending, and not a "transaction" in the
    // sense the tooltip's breakdown means.
    expect(september.income).toBe(0)
    expect(september.expense).toBe(0)
    expect(september.net).toBe(0)
    expect(september.transactionCount).toBe(0)
    expect(september.transactions).toEqual([])
    expect(september.sources).toEqual([])

    // But the money really moved between accounts, and the totals say so.
    expect(september.balanceOpen).toBe(100000)
    expect(september.balanceClose).toBe(100000)
    expect(services.accounts.list().map((item) => item.balance).sort((a, b) => a - b)).toEqual([30000, 70000])
  })

  it('change the converted total when the two legs are in different currencies', () => {
    withRates(RATES)

    const cny = account('招商银行', 'CNY', 100000)
    const myr = account('Maybank', 'MYR', 0)

    // ¥500 out, RM300 in — what the user's bank actually gave them.
    insertCrossCurrencyTransfer(cny, myr, 50000, 30000, '2026-09-10')

    const series = services.kline.series('CNY', 'month')
    const [september] = series.points

    // Ignoring transfers in the cumulative sum — the tempting shortcut, since
    // they net to zero in one currency — would leave this at 100000.
    expect(september.balanceClose).toBe(99458)
    expect(september.balanceClose).not.toBe(100000)
    expect(september.deltaBalance).toBe(-542)

    // The same arithmetic the accounts page performs agrees.
    expect(september.balanceClose).toBe(accountsTotalIn('CNY', RATES))

    // Still not income or spending: the breakdown is empty even though the
    // balance moved.
    expect(september.income).toBe(0)
    expect(september.expense).toBe(0)
    expect(september.transactions).toEqual([])
  })
})

describe('tooltip transactions', () => {
  it('orders a bucket by date, time then id and carries the display fields', () => {
    const id = account('招商银行', 'CNY', 0)
    // Created out of order on purpose: the later time is recorded first, so id
    // order and display order genuinely disagree.
    const late = record(id, 'expense', '2026-09-10', 50, { time: '18:30', merchant: '海底捞' })
    const early = record(id, 'expense', '2026-09-10', 30, { time: '09:15', merchant: 'Grab' })
    const noTime = record(id, 'income', '2026-09-10', 200)
    const nextDay = record(id, 'expense', '2026-09-11', 10, { time: '08:00' })
    expect(early).toBeGreaterThan(late)

    const series = services.kline.series('CNY', 'day')
    const [day10, day11] = series.points

    // No time sorts with the day's earliest, matching the transaction list.
    expect(day10.transactions.map((item) => item.id)).toEqual([noTime, early, late])
    expect(day10.transactions.map((item) => item.type)).toEqual(['income', 'expense', 'expense'])
    expect(day10.transactions.map((item) => item.categoryName)).toEqual(['Salary', 'Food', 'Food'])
    expect(day10.transactions[0].accountName).toBe('招商银行')
    expect(day10.transactions[2].merchant).toBe('海底捞')
    expect(day10.transactions[2].categoryColor).toEqual(expect.any(String))
    // Ledger amounts are magnitudes; direction is carried by `type`.
    expect(day10.transactions.every((item) => item.amount > 0)).toBe(true)
    // Same currency as the display currency, so the conversion is the identity.
    expect(day10.transactions.map((item) => item.convertedAmount)).toEqual([20000, 3000, 5000])
    expect(day10.income).toBe(20000)
    expect(day10.expense).toBe(8000)
    expect(day10.net).toBe(12000)

    expect(day11.transactions.map((item) => item.id)).toEqual([nextDay])
  })

  it('converts a foreign-currency row once, and reports null when there is no rate', () => {
    withRates(makeRateTable('CNY', { CNY: 1, MYR: 0.606575 }))

    const myr = account('Maybank', 'MYR', 0)
    const thb = account('Krungsri', 'THB', 0)
    record(myr, 'expense', '2026-09-10', 18.5, { currency: 'MYR' })
    record(thb, 'expense', '2026-09-10', 5000, { currency: 'THB' })

    const [september] = services.kline.series('CNY', 'month').points
    const byCurrency = new Map(september.transactions.map((item) => [item.currency, item]))

    // RM18.50 -> 3050 fen, the same figure the period totals report.
    expect(byCurrency.get('MYR')!.amount).toBe(1850)
    expect(byCurrency.get('MYR')!.convertedAmount).toBe(3050)
    // No rate for THB: null, never the raw 500000 passed off as converted.
    expect(byCurrency.get('THB')!.amount).toBe(500000)
    expect(byCurrency.get('THB')!.convertedAmount).toBeNull()

    // The breakdown's expense total excludes the unconvertible row.
    expect(september.expense).toBe(3050)
    expect(september.transactionCount).toBe(2)
  })

  it('caps the tooltip rows per bucket while keeping the true count', () => {
    const id = account('招商银行', 'CNY', 0)
    const overflow = KLINE_MAX_TRANSACTIONS_PER_BUCKET + 5
    for (let i = 0; i < overflow; i += 1) {
      record(id, 'expense', '2026-09-10', 1)
    }

    const [september] = services.kline.series('CNY', 'month').points

    expect(september.transactions).toHaveLength(KLINE_MAX_TRANSACTIONS_PER_BUCKET)
    // The count is the honest figure, so the UI can say "showing 200 of 205".
    expect(september.transactionCount).toBe(overflow)
    // The rows kept are the day's earliest, in order.
    expect(september.transactions[0].id).toBeLessThan(september.transactions[1].id)
  })
})

describe('daily series (the zoom source)', () => {
  it('covers from..to gaplessly and chains every day onto the next', () => {
    const id = account('招商银行', 'CNY', 0)
    record(id, 'income', '2026-09-01', 100)
    record(id, 'expense', '2026-09-04', 30)

    const series = services.kline.series('CNY', 'day')

    expect(series.daily.map((day) => day.date)).toEqual([
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
      '2026-09-04'
    ])
    expect(series.daily[0].balanceOpen).toBe(series.openingBalance)
    for (let i = 1; i < series.daily.length; i += 1) {
      expect(series.daily[i].balanceOpen).toBe(series.daily[i - 1].balanceClose)
    }

    const gap = series.daily[1]
    expect(gap.date).toBe('2026-09-02')
    expect(gap.label).toBe('9月2日')
    expect(gap.income).toBe(0)
    expect(gap.expense).toBe(0)
    expect(gap.net).toBe(0)
    expect(gap.transactionCount).toBe(0)
    expect(gap.balanceClose).toBe(10000)
    // A day is the finest internal period, so its wick has nowhere to go.
    expect(gap.balanceHigh).toBe(10000)
    expect(gap.balanceLow).toBe(10000)

    expect(series.daily[series.daily.length - 1].balanceClose).toBe(
      series.points[series.points.length - 1].balanceClose
    )
  })

  it('starts at the first bucket key, so zooming into the first candle has its days', () => {
    const id = account('招商银行', 'CNY', 100000)
    record(id, 'expense', '2026-09-20', 100)

    const series = services.kline.series('CNY', 'month')

    // The candle starts on 1 September even though nothing happened until the
    // 20th, so the daily rows must start there too.
    expect(series.from).toBe('2026-09-01')
    expect(series.daily).toHaveLength(20)
    expect(series.daily[0].date).toBe('2026-09-01')
    expect(series.daily[0].balanceOpen).toBe(100000)
    expect(series.daily[0].balanceClose).toBe(100000)
    expect(series.daily[19].balanceClose).toBe(90000)
    expect(series.daily[19].expense).toBe(10000)
  })

  it('rolls up into the buckets exactly, flows, counts, balances and wicks', () => {
    withRates(RATES)

    const cny = account('招商银行', 'CNY', 0)
    const myr = account('Maybank', 'MYR', 0)

    // A foreign currency on many separate days: its per-day conversions are
    // fractional, which is the case that accumulates a rounding unit per day if
    // the daily figures are rounded independently.
    for (const day of ['01', '02', '03', '05', '06', '07', '08', '09', '10', '11']) {
      record(myr, 'expense', `2026-09-${day}`, 3.33, { currency: 'MYR' })
    }
    record(cny, 'income', '2026-09-04', 100)
    record(cny, 'expense', '2026-09-18', 25)
    record(myr, 'income', '2026-09-25', 40, { currency: 'MYR' })

    for (const granularity of ['day', 'week', 'month'] as const) {
      const series = services.kline.series('CNY', granularity)

      for (const point of series.points) {
        const days = series.daily.filter(
          (day) => day.date >= point.date && day.date < nextBucketKey(point.date, granularity)
        )
        expect(days.length).toBeGreaterThan(0)

        // The invariant the zoom path depends on: a bucket is exactly the sum of
        // its days, so re-bucketing in the renderer cannot drift from the totals
        // the service computed.
        expect(days.reduce((sum, day) => sum + day.income, 0)).toBe(point.income)
        expect(days.reduce((sum, day) => sum + day.expense, 0)).toBe(point.expense)
        expect(days.reduce((sum, day) => sum + day.net, 0)).toBe(point.net)
        expect(days.reduce((sum, day) => sum + day.transactionCount, 0)).toBe(point.transactionCount)
        expect(days[0].balanceOpen).toBe(point.balanceOpen)
        expect(days[days.length - 1].balanceClose).toBe(point.balanceClose)
        expect(Math.max(...days.map((day) => day.balanceHigh))).toBe(point.balanceHigh)
        expect(Math.min(...days.map((day) => day.balanceLow))).toBe(point.balanceLow)
        expect(days.some((day) => day.hasUnconverted)).toBe(point.hasUnconverted)
      }

      // And across the whole series, not just per bucket.
      expect(series.daily.reduce((sum, day) => sum + day.income, 0)).toBe(
        series.points.reduce((sum, point) => sum + point.income, 0)
      )
      expect(series.daily.reduce((sum, day) => sum + day.expense, 0)).toBe(
        series.points.reduce((sum, point) => sum + point.expense, 0)
      )
    }
  })

  it('is bounded by the calendar span, not by the transaction count', () => {
    const id = account('招商银行', 'CNY', 0)
    // 200 transactions on one day: one daily entry.
    for (let i = 0; i < 200; i += 1) record(id, 'expense', '2026-09-10', 1)

    const series = services.kline.series('CNY', 'day')
    expect(series.daily).toHaveLength(1)
    expect(series.daily[0].transactionCount).toBe(200)
  })
})

describe('performance', () => {
  it('builds a 20,000-transaction series well under a second', () => {
    withRates(RATES)

    const cny = account('招商银行', 'CNY', 500000)
    const myr = account('Maybank', 'MYR', 250000)
    const food = categoryId('Food', 'expense')
    const salary = categoryId('Salary', 'income')

    const timestamp = nowIso()
    const insert = handle.db.prepare(
      `INSERT INTO transactions
         (account_id, type, amount, category_id, date, time, merchant, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
    )

    // 20,000 rows spread over 1,000 days (a ~1,000-day span -> month granularity),
    // alternating income and expense across a CNY and an MYR account so the
    // conversion path is exercised too. Written directly rather than through the
    // service so the fixture itself does not dominate the measurement.
    const seed = handle.db.transaction(() => {
      for (let i = 0; i < 20_000; i += 1) {
        const income = i % 3 === 0
        const date = addDays('2024-01-01', i % 1000)
        const accountId = i % 2 === 0 ? cny : myr
        const amount = income ? 5000 + (i % 97) : -(200 + (i % 89))
        insert.run(
          accountId,
          income ? 'income' : 'expense',
          amount,
          income ? salary : food,
          date,
          `${String(i % 24).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`,
          null,
          timestamp,
          timestamp
        )
      }
    })
    seed()

    const started = performance.now()
    const series = services.kline.series('CNY', 'auto')
    const elapsed = performance.now() - started

    // Printed so the measured figure is visible in the test output rather than
    // being asserted and forgotten.
    // eslint-disable-next-line no-console
    console.log(
      `[kline] 20,000 transactions -> ${series.points.length} ${series.granularity} buckets, ` +
        `${series.daily.length} daily entries in ${elapsed.toFixed(1)} ms`
    )

    expect(series.granularity).toBe('month')
    expect(series.points.length).toBeGreaterThan(30)
    expect(elapsed).toBeLessThan(1000)

    // And the series is not empty scaffolding: its last candle is still the
    // accounts page's total on a dataset this size.
    const last = series.points[series.points.length - 1]
    expect(last.balanceClose).toBe(accountsTotalIn('CNY', RATES))
  })
})
