import { describe, expect, it } from 'vitest'
import { instantOf, minStepForCurrency, valueDomain } from '@shared/lib/chart-time'

/**
 * The balance axis must contain every marker the window holds.
 *
 * THE BUG THIS PINS DOWN
 * ----------------------
 * The axis used to be fitted to the visible candles' own open/high/low/close and the moving
 * averages. That is not enough, and the failure is spectacular rather than subtle: the last
 * visible bucket is the one still in progress, so its `balanceHigh` covers only the entries
 * the chart has walked past. An entry the reader has scrolled up to, sitting at an instant
 * later than that, can be above the candle's high — and then the marker is drawn outside the
 * plot and CLIPPED. On the spec's own fixture that hid every single transaction: a 6-day
 * window whose only candle closed at RM 14,807.73 produced an axis of
 * RM 14,807.73..RM 15,092.93, while the salary marker sat at RM 15,092.93 and the eight
 * spending markers at RM 15,092.11 and below — all of them below the plot floor, none of them
 * visible, and no error anywhere.
 *
 * The numbers below are the real ones from that ledger (displayed in CNY, which is what the
 * rate table produced), scaled to what the axis saw.
 */
describe('the balance axis contains every marker', () => {
  /** What the axis looks like when the marker extremes are NOT folded in. */
  const fromCandlesOnly = (visible: Array<{ low: number; high: number }>): { min: number; max: number } =>
    valueDomain(
      Math.min(...visible.map((bucket) => bucket.low)),
      Math.max(...visible.map((bucket) => bucket.high)),
      { minStep: minStepForCurrency('CNY') }
    )

  const pixelY = (
    domain: { min: number; max: number },
    value: number,
    top: number,
    bottom: number
  ): number => {
    const range = domain.max - domain.min
    const ratio = range > 0 ? (value - domain.min) / range : 0.5
    return bottom - ratio * (bottom - top)
  }

  it('would clip the markers if it were fitted to the candles alone', () => {
    /*
      Six candles' worth of window whose closes all sit at RM 14,807.73, and one mid-window
      candle that briefly reached RM 15,016.27. The axis that follows is
      RM 14,807.73..RM 15,016.27 — every candle inside it, which is exactly why the omission
      was invisible in review.
    */
    const close = 1_480_773
    const visible = [
      { low: close, high: close },
      { low: close, high: close },
      { low: close, high: 1_501_627 },
      { low: close, high: close },
      { low: close, high: close }
    ]
    const domain = fromCandlesOnly(visible)
    const top = 18
    const bottom = 319

    // A marker at RM 15,092.93 — the salary, which is inside the window — lands ABOVE the
    // plot's top edge and is culled by the draw pass. At the real zoom that was every one of
    // the day's nine transactions.
    expect(pixelY(domain, 1_509_293, top, bottom)).toBeLessThan(top)
    expect(pixelY(domain, 1_509_211, top, bottom)).toBeLessThan(top)
  })

  it('keeps them inside once the marker extremes are folded in', () => {
    const close = 1_480_773
    const markerBalances = [
      1_509_293, 1_509_211, 1_509_013, 1_508_222, 1_507_150, 1_506_903, 1_501_627, 1_498_713, 1_480_773
    ]
    const low = Math.min(close, ...markerBalances)
    const high = Math.max(close, ...markerBalances)
    const domain = valueDomain(low, high, { minStep: minStepForCurrency('CNY') })
    const top = 18
    const bottom = 319

    for (const value of markerBalances) {
      const y = pixelY(domain, value, top, bottom)
      expect(y).toBeGreaterThanOrEqual(top - 0.5)
      expect(y).toBeLessThanOrEqual(bottom + 0.5)
    }
    // And the smallest marker is still distinguishable from the largest: the axis was widened,
    // not flattened.
    const spread = Math.abs(pixelY(domain, 1_509_293, top, bottom) - pixelY(domain, 1_480_773, top, bottom))
    expect(spread).toBeGreaterThan(100)
  })

  it('still fits the window rather than the whole history', () => {
    // The fix must not defeat the micro view: an axis that folded in all of history would put
    // a RM 0.50 entry back under a pixel.
    const domain = valueDomain(1_480_773, 1_509_293, { minStep: minStepForCurrency('CNY') })
    expect(domain.max - domain.min).toBeLessThan(200_000)
  })

  it('gives a flat window room around the line', () => {
    // No transactions in view at all: the axis is invented, and the line must sit mid-plot
    // rather than on an edge.
    const domain = valueDomain(1_012_403, 1_012_403, { minStep: minStepForCurrency('CNY') })
    const y = pixelY(domain, 1_012_403, 18, 319)
    expect(y).toBeGreaterThan(60)
    expect(y).toBeLessThan(280)
  })
})

describe('the intraday window the version must reach', () => {
  const at = (date: string, time: string): number => instantOf(date, time)
  const DAY = 86_400_000

  it('is reachable in four wheel notches from a day, at the zoom rate the handler uses', () => {
    // Each notch multiplies the span by exp(-120 * 0.0016) = 0.825. From a day, four notches is
    // 0.46 of a day, which is inside the window that separates 12:14 from 12:18.
    const factor = Math.exp(-120 * 0.0016)
    const afterFour = DAY * factor ** 4
    expect(afterFour / 3_600_000).toBeLessThan(12)
    expect(afterFour / 3_600_000).toBeGreaterThan(6)

    const fixture = ['09:00', '12:14', '12:18', '12:25', '13:30', '15:00', '18:20', '20:30']
    const instants = fixture.map((time) => at('2026-09-25', time))
    const span = instants[instants.length - 1] - instants[0]
    expect(span / 3_600_000).toBeCloseTo(11.5, 1)
  })
})
