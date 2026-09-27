import { describe, expect, it } from 'vitest'

import { parseReceiptText } from '@shared/lib/receipt'

/**
 * Reading a receipt out of OCR text.
 *
 * The fixtures are CAPTURED tesseract output, not tidy hand-written text. The first one is
 * verbatim what tesseract.js 7 returned for a synthetic Maybank receipt with `chi_sim+eng` at
 * 92% confidence:
 *
 *     MAYBANK
 *     Kuala Lumpur Malaysia
 *     2026-09-25 12:14
 *     Lunch
 *
 *     Coffee
 *     ...
 *     TOTAL
 *
 *     RM 172.50
 *     午 餐
 *
 *     咖 啡
 *
 *     合 计 RM 172.50
 *     TERIMA KASIH
 *
 * Note the blank lines, the spaces INSIDE Chinese words, and the total appearing twice under
 * two different names. Those three things are the whole reason this parser exists rather than a
 * regular expression in the component, and a fixture written by hand would not contain any of
 * them.
 */
const MAYBANK_OCR = `MAYBANK
Kuala Lumpur Malaysia
2026-09-25 12:14
Lunch

Coffee

Snack

Transport

Dinner

Shopping
TOTAL

RM 172.50
午 餐

咖 啡

合 计 RM 172.50
TERIMA KASIH
`

const WECHAT_OCR = `微信支付
账单详情
商户名称  星巴克咖啡
支付时间  2026年9月25日 15:30
支付方式  招商银行(1234)
当前状态  支付成功
商品名称  拿铁
¥34.00
实付金额
¥34.00
`

const ALIPAY_OCR = `支付宝
交易成功
付款金额
128.00
收款方  滴滴出行
创建时间  2026-09-23 20:15
订单号  202609232200145
`

describe('reading a bank receipt', () => {
  const result = parseReceiptText(MAYBANK_OCR)

  it('finds the total from the keyword, not from whichever number is biggest', () => {
    // Both TOTAL and 合计 carry RM 172.50, and they must collapse to ONE candidate rather than
    // two — otherwise the chooser shows the same answer twice and looks like it found two.
    const amounts = result.candidates.map((candidate) => candidate.amountMinor)
    expect(amounts[0]).toBe(17250)
    expect(amounts.filter((value) => value === 17250)).toHaveLength(1)
  })

  it('reads the amount in the currency it was printed in', () => {
    expect(result.candidates[0].currency).toBe('MYR')
    expect(result.candidates[0].amountReason).toBe('total-keyword')
  })

  it('reads the date and the time from the same line', () => {
    expect(result.candidates[0].date).toBe('2026-09-25')
    expect(result.candidates[0].time).toBe('12:14')
  })

  it('takes the shop name from the top, not from the item list', () => {
    expect(result.candidates[0].merchant).toBe('MAYBANK')
  })

  it('matches a Chinese keyword that OCR split with spaces', () => {
    // 「合 计」 must match 「合计」. Without whitespace squashing the total is only found by the
    // English word, and a Chinese-only receipt finds nothing at all.
    const chineseOnly = parseReceiptText('星巴克\n合 计 RM 34.00\n')
    expect(chineseOnly.candidates[0].amountMinor).toBe(3400)
    expect(chineseOnly.candidates[0].amountReason).toBe('total-keyword')
  })
})

describe('reading a WeChat payment screen', () => {
  const result = parseReceiptText(WECHAT_OCR)

  it('prefers the line that says what was actually paid', () => {
    expect(result.candidates[0].amountMinor).toBe(3400)
    expect(result.candidates[0].currency).toBe('CNY')
  })

  it('reads a Chinese date with 年月日 in it', () => {
    expect(result.candidates[0].date).toBe('2026-09-25')
    expect(result.candidates[0].time).toBe('15:30')
  })

  it('finds the merchant even though it is not on the first line', () => {
    // The first line is 微信支付, which is the app rather than the shop. The stopword list keeps
    // it from becoming the merchant and the real name on line three wins instead.
    expect(result.candidates[0].merchant).toBe('星巴克咖啡')
  })
})

describe('reading an Alipay screen with no currency symbol on the amount', () => {
  const result = parseReceiptText(ALIPAY_OCR)

  it('still finds the amount, and says it did so without a currency marker', () => {
    expect(result.candidates[0].amountMinor).toBe(12800)
    // No ￥ or ¥ on the amount's own line, so this is the weaker rule and the UI is told so.
    expect(result.candidates[0].amountReason).not.toBe('total-keyword')
  })

  it('does not treat the order number as the amount', () => {
    // 202609232200145 is fifteen digits. A naive "longest number" rule picks it.
    expect(result.candidates.every((candidate) => candidate.amountMinor < 1_000_000)).toBe(true)
  })

  it('reads the date from a line that also carries an order number', () => {
    expect(result.candidates[0].date).toBe('2026-09-23')
  })
})

describe('refusing to invent things', () => {
  it('returns nothing for an image with no text', () => {
    const result = parseReceiptText('   \n\n  ')
    expect(result.candidates).toEqual([])
    expect(result.notes).toContain('no text')
  })

  it('returns no candidate when the text holds no number at all', () => {
    const result = parseReceiptText('THANK YOU\nPLEASE COME AGAIN\n')
    expect(result.candidates).toEqual([])
    expect(result.notes).toContain('no amount found')
  })

  it('leaves the date null rather than substituting today', () => {
    const result = parseReceiptText('SHOP\nTOTAL RM 12.00\n')
    expect(result.candidates[0].amountMinor).toBe(1200)
    expect(result.candidates[0].date).toBeNull()
    expect(result.candidates[0].time).toBeNull()
  })

  it('leaves the time null when only a date was printed', () => {
    const result = parseReceiptText('SHOP\n2026-09-25\nTOTAL RM 12.00\n')
    expect(result.candidates[0].date).toBe('2026-09-25')
    expect(result.candidates[0].time).toBeNull()
  })

  it('does not report a total when the only number is a balance', () => {
    // 余额 is the account balance, not the purchase. Reporting it would pre-fill the wrong
    // amount, which is the one outcome worse than an empty field.
    const result = parseReceiptText('账户余额\n¥5,000.00\n')
    const top = result.candidates[0]
    expect(top.amountReason).not.toBe('total-keyword')
  })

  it('keeps the source line with every candidate', () => {
    const result = parseReceiptText(MAYBANK_OCR)
    for (const candidate of result.candidates) {
      expect(candidate.amountSource.length).toBeGreaterThan(0)
    }
    expect(result.candidates[0].amountSource).toContain('172.50')
  })
})

describe('amounts are integers in the currency minor unit', () => {
  it('converts a thousands separator and two decimals exactly', () => {
    const result = parseReceiptText('SHOP\nTOTAL RM 1,234.50\n')
    expect(result.candidates[0].amountMinor).toBe(123450)
    expect(Number.isInteger(result.candidates[0].amountMinor)).toBe(true)
  })

  it('handles a full-width yen sign, which real Chinese receipts produce', () => {
    const result = parseReceiptText('商店\n合 计 ￥18.50\n')
    expect(result.candidates[0].amountMinor).toBe(1850)
  })

  it('never returns a float, for any of the fixtures', () => {
    for (const text of [MAYBANK_OCR, WECHAT_OCR, ALIPAY_OCR, 'X\nTOTAL $0.01\n', 'X\n合计 ¥9,999,999.99\n']) {
      for (const candidate of parseReceiptText(text).candidates) {
        expect(Number.isInteger(candidate.amountMinor)).toBe(true)
        expect(candidate.amountMinor).toBeGreaterThan(0)
      }
    }
  })
})

describe('confidence', () => {
  it('is higher for a receipt that read cleanly than for one that did not', () => {
    const clean = parseReceiptText(MAYBANK_OCR).candidates[0]
    // An amount found only because it is the largest number on an otherwise unreadable page:
    // no total keyword, no date, no merchant.
    const vague = parseReceiptText('blah blah\n9999.00\nmore blah\n').candidates[0]
    expect(clean.confidence).toBeGreaterThan(vague.confidence)
  })

  it('stays inside 0..1', () => {
    for (const text of [MAYBANK_OCR, WECHAT_OCR, ALIPAY_OCR, 'x\n1\n']) {
      for (const candidate of parseReceiptText(text).candidates) {
        expect(candidate.confidence).toBeGreaterThan(0)
        expect(candidate.confidence).toBeLessThanOrEqual(1)
      }
    }
  })

  it('ranks the best candidate first', () => {
    const result = parseReceiptText(MAYBANK_OCR)
    const scores = result.candidates.map((candidate) => candidate.confidence)
    expect(scores).toEqual([...scores].sort((a, b) => b - a))
  })
})
