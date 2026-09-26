import { describe, expect, it } from 'vitest'
import {
  convertAmount,
  convertMinor,
  formatRatePrecise,
  lookupRate,
  rateFreshness,
  selectableCurrencies,
  type RateTable
} from '@shared/lib/rates'
import { makeRateTable } from '@main/services/exchange'

/**
 * Currency conversion tests.
 *
 * Conversion is the one place the integer-money discipline has to admit a
 * decimal step, so it is also the place a rounding bug would be most damaging:
 * a converted figure is what the user actually reads. These tests pin the
 * rounding rule and the "never chain conversions" rule.
 */

/** Real published rates for 2026-09-26, used as a fixed fixture. */
const RATES: RateTable = makeRateTable('CNY', {
  CNY: 1,
  MYR: 0.606575,
  USD: 0.148707,
  SGD: 0.189946,
  HKD: 1.166485,
  JPY: 23.436619,
  GBP: 0.1124607
})

describe('lookupRate', () => {
  it('returns 1 for the same currency in any case', () => {
    expect(lookupRate(RATES, 'CNY', 'CNY')).toBe(1)
    expect(lookupRate(RATES, 'cny', 'CNY')).toBe(1)
  })

  it('reads a direct rate from the base', () => {
    expect(lookupRate(RATES, 'CNY', 'MYR')).toBeCloseTo(0.606575, 10)
  })

  it('inverts when the target is the base', () => {
    // 1 MYR = 1 / 0.606575 CNY
    expect(lookupRate(RATES, 'MYR', 'CNY')).toBeCloseTo(1 / 0.606575, 10)
  })

  it('computes a cross rate without chaining conversions', () => {
    // MYR -> SGD via CNY must equal (SGD/CNY) / (MYR/CNY) exactly, not the result
    // of two separate roundings.
    const cross = lookupRate(RATES, 'MYR', 'SGD')
    expect(cross).toBeCloseTo(0.189946 / 0.606575, 10)
  })

  it('returns null for an unknown currency rather than guessing', () => {
    expect(lookupRate(RATES, 'CNY', 'XYZ')).toBeNull()
    expect(lookupRate(RATES, 'XYZ', 'CNY')).toBeNull()
    expect(lookupRate(null, 'CNY', 'MYR')).toBeNull()
  })
})

describe('convertMinor', () => {
  it('rounds half away from zero at the final minor unit', () => {
    // ¥100 = 10000 fen -> MYR: 100 * 0.606575 = 60.6575 -> 60.66 (not 60.65).
    const result = convertMinor(10000, 'CNY', 'MYR', RATES)
    expect(result.minor).toBe(6066)
    expect(result.approximate).toBe(false)
  })

  it('is exact for a same-currency conversion', () => {
    expect(convertMinor(1850, 'MYR', 'MYR', RATES)).toEqual({
      minor: 1850,
      rate: 1,
      from: 'MYR',
      to: 'MYR',
      approximate: false
    })
  })

  it('handles a zero amount without producing NaN', () => {
    const result = convertMinor(0, 'CNY', 'MYR', RATES)
    expect(result.minor).toBe(0)
    expect(Number.isNaN(result.minor)).toBe(false)
  })

  it('rounds negative amounts symmetrically', () => {
    // An expense and an equal income must convert to exact mirrors, or a
    // reconciled pair would appear to differ by a cent.
    const positive = convertMinor(10000, 'CNY', 'MYR', RATES).minor
    const negative = convertMinor(-10000, 'CNY', 'MYR', RATES).minor
    expect(negative).toBe(-positive)
  })

  it('respects zero-decimal target currencies', () => {
    // ¥100 -> JPY: 100 * 23.436619 = 2343.6619 -> 2344 (JPY has no minor unit).
    const result = convertMinor(10000, 'CNY', 'JPY', RATES)
    expect(result.minor).toBe(2344)
  })

  it('flags an unconvertible amount instead of inventing a 1:1 rate', () => {
    const result = convertMinor(5000, 'CNY', 'XYZ', RATES)
    expect(result.approximate).toBe(true)
    expect(result.rate).toBe(1)
    // The raw value is passed through so the caller can still show something,
    // but `approximate` tells the UI to label it.
    expect(result.minor).toBe(5000)
  })

  it('never loses precision on a round trip within a rate pair', () => {
    // A converted-then-converted-back amount should land within a minor unit of
    // the original; larger drift would mean the rate handling is wrong.
    const original = 123456
    const toMyr = convertMinor(original, 'CNY', 'MYR', RATES)
    const back = convertMinor(toMyr.minor, 'MYR', 'CNY', RATES)
    expect(Math.abs(back.minor - original)).toBeLessThanOrEqual(1)
  })

  it('produces the same value whether converted directly or as one call', () => {
    // Guards against the caller accidentally chaining conversions.
    const direct = convertAmount(10000, 'CNY', 'SGD', RATES)
    const viaLookup = Math.round((10000 / 100) * (lookupRate(RATES, 'CNY', 'SGD') as number) * 100)
    expect(direct).toBe(viaLookup)
  })
})

describe('formatRatePrecise', () => {
  it('renders a readable rate with trailing zeros trimmed', () => {
    expect(formatRatePrecise(0.606575, 'CNY', 'MYR')).toBe('1 CNY = 0.6066 MYR')
    expect(formatRatePrecise(1.166485, 'CNY', 'HKD')).toBe('1 CNY = 1.1665 HKD')
  })

  it('keeps four decimals for a rate in the tens', () => {
    // Four decimals is meaningful at this magnitude and matches how providers
    // publish the quote.
    expect(formatRatePrecise(23.436619, 'CNY', 'JPY')).toBe('1 CNY = 23.4366 JPY')
  })

  it('drops to two decimals for a large rate', () => {
    // Four decimals on a rate in the hundreds is false precision.
    expect(formatRatePrecise(234.5, 'CNY', 'JPY')).toBe('1 CNY = 234.5 JPY')
  })

  it('never strips zeros from the integer part', () => {
    // A bare /0+$/ trim would turn 2300.00 into 23 — a rate wrong by two orders
    // of magnitude. The trim must anchor on the decimal point.
    expect(formatRatePrecise(2300, 'CNY', 'IDR')).toBe('1 CNY = 2300 IDR')
    expect(formatRatePrecise(20.5, 'CNY', 'JPY')).toBe('1 CNY = 20.5 JPY')
  })
})

describe('rateFreshness', () => {
  const now = new Date('2026-09-26T12:00:00Z')

  it('classifies a very recent fetch as fresh', () => {
    const table = makeRateTable('CNY', { MYR: 0.6 }, { fetchedAt: '2026-09-26T11:30:00Z' })
    expect(rateFreshness(table, now)).toBe('fresh')
  })

  it('classifies an older same-day fetch as today', () => {
    const table = makeRateTable('CNY', { MYR: 0.6 }, { fetchedAt: '2026-09-26T02:00:00Z' })
    expect(rateFreshness(table, now)).toBe('today')
  })

  it('classifies a multi-day-old fetch as stale', () => {
    const table = makeRateTable('CNY', { MYR: 0.6 }, { fetchedAt: '2026-09-10T12:00:00Z' })
    expect(rateFreshness(table, now)).toBe('stale')
  })

  it('reports a manual table as manual regardless of age', () => {
    // A user-supplied rate must never be relabelled as stale, because it is not
    // a fetched value and the app cannot know better than the user.
    const table = makeRateTable('CNY', { MYR: 0.6 }, { isManual: true, fetchedAt: '2020-01-01T00:00:00Z' })
    expect(rateFreshness(table, now)).toBe('manual')
  })

  it('reports missing when there is no table', () => {
    expect(rateFreshness(null, now)).toBe('missing')
  })
})

describe('selectableCurrencies', () => {
  it('puts the priority currencies first', () => {
    const options = selectableCurrencies(RATES)
    expect(options[0].code).toBe('CNY')
    expect(options.slice(0, 4).map((option) => option.code)).toEqual(['CNY', 'MYR', 'SGD', 'USD'])
  })

  it('includes currencies the provider returned that are not hardcoded', () => {
    const table = makeRateTable('CNY', { CNY: 1, MYR: 0.6, ZAR: 2.5 })
    const codes = selectableCurrencies(table).map((option) => option.code)
    expect(codes).toContain('ZAR')
  })

  it('still works with no rates at all', () => {
    const options = selectableCurrencies(null)
    expect(options.length).toBeGreaterThan(5)
    expect(options[0].code).toBe('CNY')
  })
})

describe('per-currency aggregation (cross-currency totals)', () => {
  it('converts a mixed-currency subtotal exactly once', () => {
    // This is the bug the aggregation layer exists to prevent: adding 10000 fen
    // to 1850 sen gives 11850 of nothing. Converting once per currency and
    // summing the converted values gives a meaningful figure.
    const cny = convertAmount(10000, 'CNY', 'CNY', RATES) // ¥100
    const myr = convertAmount(1850, 'MYR', 'CNY', RATES) // RM 18.50 -> ¥
    const total = cny + myr

    // RM18.50 / 0.606575 = ¥30.4991... -> 3050 fen
    expect(myr).toBe(3050)
    expect(total).toBe(13050)

    // And the naive sum would have been wrong.
    expect(10000 + 1850).not.toBe(total)
  })
})
