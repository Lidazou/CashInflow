import { describe, expect, it } from 'vitest'

import {
  ACTIVITY_MAX_ZOOM,
  activityScale,
  amountAtY,
  buildColumn,
  buildColumns,
  buildSegments,
  columnAt,
  directionAtY,
  hitSegment,
  markerMagnitude,
  orderDayMarkers,
  pickSegment,
  rollUpCategories,
  withCumulative,
  yAtAmount,
  zeroLineY
} from '@shared/lib/daily-activity'
import type { ActivityColumn, ActivitySegment } from '@shared/lib/daily-activity'
import type { CashflowTransactionMarker, KlineBucket } from '@shared/types'

/**
 * Daily Cash Activity — the derived data behind the lower chart panel.
 *
 * The three scenarios here are the ones the v1.6.0 spec names, because they are the
 * three ways the previous chart was wrong:
 *
 *   A. a day of five unequal expenses, where the proportions ARE the information;
 *   B. a RM 12,000 income beside a RM 200 expense, where one shared axis would erase
 *      the expense entirely;
 *   C. RM 9,999 and RM 1 in the same day, where the RM 1 is two hundredths of a pixel
 *      tall and still has to be selectable.
 */

function marker(over: Partial<CashflowTransactionMarker> & { transactionId: number }): CashflowTransactionMarker {
  return {
    time: null,
    type: 'expense',
    amount: 100,
    currency: 'MYR',
    convertedDelta: -100,
    balanceBefore: null,
    balanceAfter: null,
    merchant: null,
    categoryId: null,
    categoryName: null,
    categoryColor: null,
    accountName: 'Maybank',
    note: null,
    ...over
  }
}

function bucket(over: Partial<KlineBucket> & { date: string }): KlineBucket {
  return {
    label: '',
    balanceOpen: 0,
    balanceClose: 0,
    balanceHigh: 0,
    balanceLow: 0,
    income: 0,
    expense: 0,
    net: 0,
    transactionCount: 0,
    hasUnconverted: false,
    ...over
  }
}

/* -------------------------------------------------------------------------- */
/* Scenario A: proportions                                                   */
/* -------------------------------------------------------------------------- */

describe('Scenario A: five expenses in one day, stacked in proportion', () => {
  const markers: CashflowTransactionMarker[] = [
    marker({ transactionId: 1, time: '19:00', amount: 40000, convertedDelta: -40000, merchant: 'Dinner' }),
    marker({ transactionId: 2, time: '11:00', amount: 20000, convertedDelta: -20000, merchant: 'Shopping' }),
    marker({ transactionId: 3, time: '08:00', amount: 15000, convertedDelta: -15000, merchant: 'Transport' }),
    marker({ transactionId: 4, time: '07:30', amount: 10000, convertedDelta: -10000, merchant: 'Coffee' }),
    marker({ transactionId: 5, time: '15:00', amount: 15000, convertedDelta: -15000, merchant: 'Food' })
  ]
  const column = buildColumn(
    bucket({ date: '2026-09-28', expense: 100000, net: -100000, transactionCount: 5 }),
    ['2026-09-28'],
    { '2026-09-28': markers }
  )

  it('makes exactly one column for the day', () => {
    expect(column.days).toEqual(['2026-09-28'])
    expect(column.date).toBe('2026-09-28')
  })

  it('stacks every transaction, in ledger order by time', () => {
    expect(column.expense.map((s) => s.merchant)).toEqual(['Coffee', 'Transport', 'Shopping', 'Food', 'Dinner'])
    expect(column.income).toHaveLength(0)
  })

  it('sizes each segment by amount / dailyTotal, not by count and not equally', () => {
    const pct = column.expense.map((s) => Math.round(s.percentage * 100))
    expect(pct).toEqual([10, 15, 20, 15, 40])
  })

  it('gives every segment a cumulative range that starts at zero and ends at the total', () => {
    expect(column.expense.map((s) => [s.startAmount, s.endAmount])).toEqual([
      [0, 10000],
      [10000, 25000],
      [25000, 45000],
      [45000, 60000],
      [60000, 100000]
    ])
    expect(column.expense[column.expense.length - 1].endAmount).toBe(100000)
  })

  it('numbers the transactions for the tooltip', () => {
    expect(column.expense.map((s) => `${s.index}/${s.count}`)).toEqual([
      '1/5',
      '2/5',
      '3/5',
      '4/5',
      '5/5'
    ])
  })

  it('reports the day total from the segments', () => {
    expect(column.totalExpense).toBe(100000)
    expect(column.totalIncome).toBe(0)
  })
})

/* -------------------------------------------------------------------------- */
/* Scenario B: independent axes                                              */
/* -------------------------------------------------------------------------- */

describe('Scenario B: RM 12,000 in, RM 200 out, on independent scales', () => {
  const columns = buildColumns(
    [bucket({ date: '2026-09-29', income: 1200000, expense: 20000, net: 1180000, transactionCount: 2 })],
    [bucket({ date: '2026-09-29' })],
    {
      '2026-09-29': [
        marker({ transactionId: 10, time: '09:00', type: 'income', amount: 1200000, convertedDelta: 1200000, merchant: 'Salary' }),
        marker({ transactionId: 11, time: '20:00', type: 'expense', amount: 20000, convertedDelta: -20000, merchant: 'Dinner' })
      ]
    },
    'day'
  )

  it('keeps both directions in their own stack', () => {
    expect(columns[0].income.map((s) => s.merchant)).toEqual(['Salary'])
    expect(columns[0].expense.map((s) => s.merchant)).toEqual(['Dinner'])
  })

  it('fits the axis to both directions rather than to the balance', () => {
    const scale = activityScale(columns, 'stack', 1)
    expect(scale.income).toBe(1200000)
    expect(scale.expense).toBe(20000)
    expect(scale.split).toBe('perDirection')
  })

  it('gives each direction its own half, so the RM 200 is NOT flattened by the RM 12,000', () => {
    const scale = activityScale(columns, 'stack', 1)
    const top = 0
    const bottom = 300
    const zeroY = zeroLineY(top, bottom, scale, 'stack')
    expect(zeroY).toBe(150)
    // The expense is the largest expense in the window, so it fills the lower half: this
    // is the whole reason the two directions are fitted separately.
    const ySmall = yAtAmount(-20000, top, bottom, zeroY, scale, 'stack')
    expect(ySmall - zeroY).toBeCloseTo(150, 6)
    // And the pointer path agrees with the drawing path.
    const picked = pickSegment(columns, columns[0].instant, ySmall, top, bottom, zeroY, scale, 'stack')
    expect(picked?.segment?.transactionId).toBe(11)
  })

  it('lets the reader zoom the activity axis further, and says when a bar is clipped', () => {
    const zoomed = activityScale(columns, 'stack', 50)
    expect(zoomed.expense).toBeCloseTo(400, 6)
    expect(zoomed.clipped).toBe(true)
    // A window of RM 400 with a RM 200 bar: it now reaches past the half it is drawn in,
    // so it is reported as clipped rather than silently stopping at the edge.
    const ySmall = yAtAmount(-20000, 0, 300, 150, zoomed, 'stack')
    expect(ySmall).toBeGreaterThan(300)
  })

  it('keeps ONE shared scale for net flow, where the two sides must be comparable', () => {
    const netColumns = [
      { ...columns[0], netCashFlow: 1200000 },
      { ...columns[0], netCashFlow: -20000 }
    ]
    const scale = activityScale(netColumns, 'net', 1)
    expect(scale.split).toBe('shared')
    const zeroY = zeroLineY(0, 300, scale, 'net')
    // Zero is proportional, so a bar of the same size on either side is the same height.
    const up = zeroY - yAtAmount(100000, 0, 300, zeroY, scale, 'net')
    const down = yAtAmount(-100000, 0, 300, zeroY, scale, 'net') - zeroY
    expect(up).toBeCloseTo(down, 6)
  })

  it('never lets the zoom go below 1 or above the ceiling', () => {
    expect(activityScale(columns, 'stack', 0.2).zoom).toBe(1)
    expect(activityScale(columns, 'stack', 99999).zoom).toBe(ACTIVITY_MAX_ZOOM)
  })

  it('picks the expense when the pointer is below the baseline, income above', () => {
    const scale = activityScale(columns, 'stack', 1)
    const zeroY = zeroLineY(0, 300, scale, 'stack')
    expect(directionAtY(zeroY - 1, zeroY)).toBe('income')
    expect(directionAtY(zeroY + 1, zeroY)).toBe('expense')
  })
})

/* -------------------------------------------------------------------------- */
/* Scenario C: a sub-pixel transaction is still selectable                   */
/* -------------------------------------------------------------------------- */

describe('Scenario C: RM 9,999 and RM 1 in the same day', () => {
  const column = buildColumn(
    bucket({ date: '2026-09-30', expense: 1000000, net: -1000000, transactionCount: 2 }),
    ['2026-09-30'],
    {
      '2026-09-30': [
        marker({ transactionId: 20, time: '10:00', amount: 999900, convertedDelta: -999900, merchant: 'Laptop' }),
        marker({ transactionId: 21, time: '10:05', amount: 100, convertedDelta: -100, merchant: 'Sticker' })
      ]
    }
  )

  it('keeps the RM 1 segment as a real object with a real range', () => {
    const small = column.expense.find((s) => s.transactionId === 21) as ActivitySegment
    expect(small.amount).toBe(100)
    expect(small.startAmount).toBe(999900)
    expect(small.endAmount).toBe(1000000)
    expect(small.percentage).toBeCloseTo(0.0001, 8)
  })

  it('selects it from the AMOUNT, not from a pixel height', () => {
    // 0.02px tall on a 300px panel; the amount is what resolves it.
    const found = hitSegment(column.expense, 999950)
    expect(found?.transactionId).toBe(21)
  })

  it('selects the big one everywhere else in the column', () => {
    expect(hitSegment(column.expense, 0)?.transactionId).toBe(20)
    expect(hitSegment(column.expense, 500000)?.transactionId).toBe(20)
    expect(hitSegment(column.expense, 999899)?.transactionId).toBe(20)
  })

  it('resolves through the pointer-height path too, at any panel size', () => {
    const scale = activityScale([column], 'stack', 1)
    for (const height of [300, 600, 1200]) {
      const zeroY = zeroLineY(0, height, scale, 'stack')
      const y = yAtAmount(-999950, 0, height, zeroY, scale, 'stack')
      const picked = pickSegment([column], column.instant, y, 0, height, zeroY, scale, 'stack')
      expect(picked?.segment?.transactionId).toBe(height === 300 ? 21 : 21)
    }
  })

  it('answers "past the top of the stack" with NOTHING, because nothing is there', () => {
    /*
      Found by the v1.6.0 acceptance run: pointing halfway down a mostly-empty column
      used to report the day's largest transaction, so the card named a RM 659 dinner
      while the crosshair's own amount read RM 8,243. An empty space is an empty space.
    */
    expect(hitSegment(column.expense, 5000000)).toBeNull()
    // The exact top edge still belongs to the topmost segment.
    expect(hitSegment(column.expense, 1000000)?.transactionId).toBe(21)
  })

  it('answers a negative amount with nothing at all', () => {
    expect(hitSegment(column.expense, -1)).toBeNull()
  })

  it('answers an empty column with nothing', () => {
    expect(hitSegment([], 10)).toBeNull()
  })
})

/* -------------------------------------------------------------------------- */
/* ordering                                                                   */
/* -------------------------------------------------------------------------- */

describe('ordering inside a day', () => {
  it('sorts timed entries by time and keeps untimed ones last, in entered order', () => {
    const ordered = orderDayMarkers([
      marker({ transactionId: 1, time: '18:00' }),
      marker({ transactionId: 2, time: null }),
      marker({ transactionId: 3, time: '08:30' }),
      marker({ transactionId: 4, time: null }),
      marker({ transactionId: 5, time: '12:00' })
    ])
    expect(ordered.map((m) => m.transactionId)).toEqual([3, 5, 1, 2, 4])
  })

  it('breaks ties on the same minute by ledger order', () => {
    const segments = buildSegments(
      [
        { marker: marker({ transactionId: 7, time: '12:14', amount: 100, convertedDelta: -100 }), date: 'd' },
        { marker: marker({ transactionId: 8, time: '12:14', amount: 200, convertedDelta: -200 }), date: 'd' }
      ],
      'expense'
    )
    expect(segments.map((s) => s.transactionId)).toEqual([7, 8])
  })

  it('never gives an untimed entry a time', () => {
    const segments = buildSegments([{ marker: marker({ transactionId: 9, time: null }), date: 'd' }], 'expense')
    expect(segments[0].time).toBeNull()
  })
})

/* -------------------------------------------------------------------------- */
/* transfers, categories, cumulative                                          */
/* -------------------------------------------------------------------------- */

describe('transfers, categories and the running total', () => {
  const day = {
    '2026-09-28': [
      marker({ transactionId: 1, time: '09:00', type: 'transfer', amount: 50000, convertedDelta: 0, categoryName: null }),
      marker({ transactionId: 2, time: '10:00', amount: 3000, convertedDelta: -3000, categoryName: 'Food', categoryColor: '#F97316', categoryId: 1 }),
      marker({ transactionId: 3, time: '11:00', amount: 2000, convertedDelta: -2000, categoryName: 'Food', categoryColor: '#F97316', categoryId: 1 }),
      marker({ transactionId: 4, time: '12:00', amount: 1000, convertedDelta: -1000, categoryName: 'Transport', categoryColor: '#3B82F6', categoryId: 2 })
    ]
  }
  const column = buildColumn(
    bucket({ date: '2026-09-28', expense: 6000, net: -6000, transactionCount: 4 }),
    ['2026-09-28'],
    day
  )

  it('counts transfers but never stacks them', () => {
    expect(column.transferCount).toBe(1)
    expect(column.expense).toHaveLength(3)
    expect(column.expense.some((s) => s.transactionId === 1)).toBe(false)
  })

  it('rolls categories up largest first', () => {
    expect(column.categories.map((c) => [c.key, c.amount, c.count])).toEqual([
      ['Food', 5000, 2],
      ['Transport', 1000, 1]
    ])
  })

  it('carries the category colour onto the segment, so the stack matches the donut', () => {
    expect(column.expense[0].categoryColor).toBe('#F97316')
  })

  it('accumulates the net flow across columns', () => {
    const columns = withCumulative([
      { ...column, netCashFlow: 100 },
      { ...column, netCashFlow: -30 },
      { ...column, netCashFlow: 10 }
    ])
    expect(columns.map((c) => c.cumulativeCashFlow)).toEqual([100, 70, 80])
  })

  it('rolls an uncategorised row into a single neutral bucket', () => {
    const totals = rollUpCategories(
      buildSegments([{ marker: marker({ transactionId: 1, amount: 500, convertedDelta: -500 }), date: 'd' }], 'expense')
    )
    expect(totals).toHaveLength(1)
    expect(totals[0].key).toBe('\u2014')
  })
})

/* -------------------------------------------------------------------------- */
/* axis geometry                                                             */
/* -------------------------------------------------------------------------- */

describe('the activity axis', () => {
  const columns: ActivityColumn[] = withCumulative([
    buildColumn(bucket({ date: '2026-09-01', income: 1000, expense: 400, net: 600 }), ['2026-09-01'], {
      '2026-09-01': [
        marker({ transactionId: 1, type: 'income', amount: 1000, convertedDelta: 1000 }),
        marker({ transactionId: 2, amount: 400, convertedDelta: -400 })
      ]
    }),
    buildColumn(bucket({ date: '2026-09-02', income: 0, expense: 200, net: -200 }), ['2026-09-02'], {
      '2026-09-02': [marker({ transactionId: 3, amount: 200, convertedDelta: -200 })]
    })
  ])

  it('places zero in the middle for the composition modes', () => {
    const scale = activityScale(columns, 'stack', 1)
    expect(zeroLineY(0, 1000, scale, 'stack')).toBe(500)
  })

  it('places zero proportionally for the shared-scale modes', () => {
    const netColumns = [
      { ...columns[0], netCashFlow: 1000 },
      { ...columns[0], netCashFlow: -200 }
    ]
    const scale = activityScale(netColumns, 'net', 1)
    // Window: +1,000 up, −200 down, on one scale, so zero sits low.
    const zeroY = zeroLineY(0, 1000, scale, 'net')
    expect(1000 - zeroY).toBeCloseTo((200 / 1200) * 1000, 0)
  })

  it('round-trips an amount through the pixel axis', () => {
    const scale = activityScale(columns, 'stack', 1)
    const zeroY = zeroLineY(0, 500, scale, 'stack')
    for (const amount of [100, -100, 250, -199]) {
      const y = yAtAmount(amount, 0, 500, zeroY, scale, 'stack')
      expect(amountAtY(y, 0, 500, zeroY, scale, 'stack')).toBeCloseTo(amount, 6)
    }
  })

  it('round-trips through the shared scale as well', () => {
    const scale = activityScale(columns, 'net', 1)
    const zeroY = zeroLineY(0, 500, scale, 'net')
    for (const amount of [80, -80, 200, -150]) {
      const y = yAtAmount(amount, 0, 500, zeroY, scale, 'net')
      expect(amountAtY(y, 0, 500, zeroY, scale, 'net')).toBeCloseTo(amount, 6)
    }
  })

  it('reports the column under an instant by binary search', () => {
    expect(columnAt(columns, columns[0].instant)?.date).toBe('2026-09-01')
    expect(columnAt(columns, columns[1].instant + 5000)?.date).toBe('2026-09-02')
    expect(columnAt(columns, 0)?.date).toBe('2026-09-01')
    expect(columnAt([], 0)).toBeNull()
  })

  it('fits cumulative to the running total, not to the per-day bars', () => {
    const scale = activityScale(columns, 'cumulative', 1)
    // 1000 - 400 = 600 then 600 - 200 = 400, so the curve spans 0..600.
    expect(scale.income).toBe(600)
    expect(scale.expense).toBe(0)
  })

  it('groups days into week buckets from the daily spine', () => {
    const weeks = [bucket({ date: '2026-09-21' }), bucket({ date: '2026-09-28' })]
    const daily = [
      bucket({ date: '2026-09-21' }),
      bucket({ date: '2026-09-22' }),
      bucket({ date: '2026-09-27' }),
      bucket({ date: '2026-09-28' }),
      bucket({ date: '2026-09-30' })
    ]
    const columns = buildColumns(weeks, daily, {}, 'week')
    expect(columns[0].days).toEqual(['2026-09-21', '2026-09-22', '2026-09-27'])
    expect(columns[1].days).toEqual(['2026-09-28', '2026-09-30'])
  })
})

/* -------------------------------------------------------------------------- */
/* fallbacks                                                                  */
/* -------------------------------------------------------------------------- */

describe('markers that cannot be converted', () => {
  it('falls back to the original magnitude and says so', () => {
    const unconvertible = marker({ transactionId: 1, amount: 7500, currency: 'JPY', convertedDelta: null })
    expect(markerMagnitude(unconvertible)).toEqual({ amount: 7500, unconverted: true })
    const column = buildColumn(bucket({ date: 'd', expense: 7500, net: -7500 }), ['d'], { d: [unconvertible] })
    expect(column.expense[0].unconverted).toBe(true)
    expect(column.hasUnconverted).toBe(true)
  })

  it('uses the bucket totals when the service shipped no per-row detail', () => {
    // At coarse zoom the tooltip payload is capped, so a month column can have no rows.
    const column = buildColumn(bucket({ date: '2026-09', expense: 50000, income: 90000, net: 40000 }), ['2026-09-01'], {})
    expect(column.totalExpense).toBe(50000)
    expect(column.totalIncome).toBe(90000)
    expect(column.expense).toHaveLength(0)
  })
})
