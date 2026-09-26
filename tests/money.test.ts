import { describe, it, expect } from 'vitest'
import {
  formatMinorToPlain,
  formatMoney,
  minorUnitsOf,
  numberToMinor,
  parseAmountToMinor,
  sumMinor
} from '@shared/lib/money'

/**
 * These tests exist because money is the one place where a silent arithmetic bug
 * is indistinguishable from fraud. The spec calls out 100.10 + 200.20 by name.
 */
describe('money: integer minor units', () => {
  it('performs the spec §38 check exactly', () => {
    // 100.10 + 200.20 must be exactly 300.30, i.e. 30030 minor units.
    const a = parseAmountToMinor('100.10', 'MYR')
    const b = parseAmountToMinor('200.20', 'MYR')
    expect(a).toBe(10010)
    expect(b).toBe(20020)
    expect(sumMinor([a!, b!])).toBe(30030)
    expect(formatMinorToPlain(30030, 'MYR')).toBe('300.30')

    // Demonstrate the failure mode this design avoids.
    expect(100.1 + 200.2).not.toBe(300.3)
  })

  it('parses plain, grouped and negative values', () => {
    expect(parseAmountToMinor('18.50')).toBe(1850)
    expect(parseAmountToMinor('1,234.56')).toBe(123456)
    expect(parseAmountToMinor('-12.5')).toBe(-1250)
    expect(parseAmountToMinor('0')).toBe(0)
    expect(parseAmountToMinor('2000')).toBe(200000)
  })

  it('strips currency symbols and whitespace, including fullwidth forms', () => {
    expect(parseAmountToMinor('RM 28.00')).toBe(2800)
    expect(parseAmountToMinor('¥28.16')).toBe(2816)
    // Full-width ￥ from real WeChat exports.
    expect(parseAmountToMinor('￥50.0')).toBe(5000)
    expect(parseAmountToMinor('$1,234.56')).toBe(123456)
    expect(parseAmountToMinor('  1 234.56  ')).toBe(123456)
    expect(parseAmountToMinor('S$12.30')).toBe(1230)
    expect(parseAmountToMinor('HK$8.80')).toBe(880)
    // Full-width digits from a CJK IME.
    expect(parseAmountToMinor('２０．５０')).toBe(2050)
    expect(parseAmountToMinor('－１２．５')).toBe(-1250)
  })

  it('handles WeChat/Alipay variable-decimal amounts', () => {
    // Real exports contain '¥50.0' and '¥2000.00' in the same column.
    expect(parseAmountToMinor('¥50.0')).toBe(5000)
    expect(parseAmountToMinor('¥2000.00')).toBe(200000)
    expect(parseAmountToMinor('¥28.16')).toBe(2816)
  })

  it('rejects input that is not a number instead of guessing', () => {
    expect(parseAmountToMinor('')).toBeNull()
    expect(parseAmountToMinor('abc')).toBeNull()
    expect(parseAmountToMinor('12.3.4')).toBeNull()
    expect(parseAmountToMinor('-')).toBeNull()
    expect(parseAmountToMinor('.')).toBeNull()
    expect(parseAmountToMinor('1/2')).toBeNull()
  })

  it('truncates rather than rounds sub-minor precision', () => {
    // 10.999 with 2 decimals is a parsing problem, not a value to invent.
    expect(parseAmountToMinor('10.999')).toBe(1099)
    expect(parseAmountToMinor('0.005')).toBe(0)
  })

  it('does not leak float error through number input', () => {
    // The classic: Math.round(1.005 * 100) === 100, which is wrong.
    expect(numberToMinor(1.005)).toBe(100)
    // And a value that genuinely is 100.1 must land on 10010.
    expect(numberToMinor(100.1)).toBe(10010)
    expect(numberToMinor(200.2)).toBe(20020)
    expect(numberToMinor(0.1) + numberToMinor(0.2)).toBe(numberToMinor(0.3))
  })

  it('respects zero-decimal currencies', () => {
    expect(minorUnitsOf('JPY')).toBe(0)
    expect(parseAmountToMinor('1200', 'JPY')).toBe(1200)
    expect(formatMinorToPlain(1200, 'JPY')).toBe('1200')
  })

  it('formats with grouping, signs and symbol', () => {
    expect(formatMoney(324000, 'MYR')).toBe('RM 3,240.00')
    expect(formatMoney(-1850, 'MYR')).toBe('-RM 18.50')
    expect(formatMoney(1850, 'MYR', { signed: true })).toBe('+RM 18.50')
    expect(formatMoney(-1850, 'MYR', { signed: true })).toBe('-RM 18.50')
    expect(formatMoney(-1850, 'MYR', { absolute: true })).toBe('RM 18.50')
    expect(formatMoney(1850, 'MYR', { withSymbol: false })).toBe('18.50')
    expect(formatMoney(123456789, 'MYR', { compact: true })).toBe('RM 1.2M')
    expect(formatMoney(123456, 'MYR', { compact: true })).toBe('RM 1.2K')
  })

  it('never loses precision across a round trip', () => {
    const samples = ['0.01', '0.10', '18.50', '100.10', '1234.56', '999999.99', '-42.42']
    for (const sample of samples) {
      const minor = parseAmountToMinor(sample)
      expect(minor).not.toBeNull()
      const plain = formatMinorToPlain(minor!, 'MYR')
      expect(parseAmountToMinor(plain)).toBe(minor)
    }
  })

  it('sums a large ledger exactly where floats would drift', () => {
    // 1000 transactions of 0.10 must be exactly 100.00.
    const values = Array.from({ length: 1000 }, () => parseAmountToMinor('0.10')!)
    expect(sumMinor(values)).toBe(10000)
    expect(formatMinorToPlain(sumMinor(values))).toBe('100.00')

    // The float equivalent drifts.
    let floatTotal = 0
    for (let i = 0; i < 1000; i += 1) floatTotal += 0.1
    expect(floatTotal).not.toBe(100)
  })
})
