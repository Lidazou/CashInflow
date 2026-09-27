import { describe, expect, it } from 'vitest'
import {
  cleanCell,
  findHeaderRow,
  looksLikeFooter,
  normaliseForKey,
  parseDelimited,
  parseStatementAmount,
  parseStatementDate,
  sniffDelimiter,
  stripBom
} from '@shared/lib/csv'

/**
 * Parser tests (spec §38 "Import").
 *
 * The cases here are the ones that actually break real imports: a summary footer
 * imported as a transaction, a comma inside a quoted description shifting every
 * column, a European decimal comma read as a thousands separator, and an
 * ambiguous DD/MM date silently read as MM/DD.
 */

describe('parseDelimited: RFC 4180', () => {
  it('parses a plain CSV', () => {
    expect(parseDelimited('a,b,c\n1,2,3', ',')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3']
    ])
  })

  it('keeps a delimiter inside a quoted field', () => {
    // The classic failure: 'Coffee, Tea & Co' must remain ONE field.
    const rows = parseDelimited('desc,amount\n"Coffee, Tea & Co",18.50', ',')
    expect(rows[1]).toEqual(['Coffee, Tea & Co', '18.50'])
  })

  it('unescapes doubled quotes', () => {
    const rows = parseDelimited('a\n"He said ""hi"""', ',')
    expect(rows[1]).toEqual(['He said "hi"'])
  })

  it('handles a newline embedded inside a quoted field', () => {
    const rows = parseDelimited('a,b\n"line one\nline two",2', ',')
    expect(rows).toHaveLength(2)
    expect(rows[1][0]).toBe('line one\nline two')
  })

  it('handles CRLF, a lone CR and a missing trailing newline', () => {
    expect(parseDelimited('a,b\r\n1,2\r\n', ',')).toEqual([
      ['a', 'b'],
      ['1', '2']
    ])
    expect(parseDelimited('a,b\r1,2', ',')).toEqual([
      ['a', 'b'],
      ['1', '2']
    ])
    expect(parseDelimited('a,b\n1,2', ',')).toHaveLength(2)
  })

  it('strips a UTF-8 BOM that would otherwise corrupt the first header', () => {
    expect(stripBom('\uFEFFDate,Amount')).toBe('Date,Amount')
    const rows = parseDelimited('\uFEFFDate,Amount\n2026-09-26,10', ',')
    expect(rows[0][0]).toBe('Date')
  })

  it('preserves empty trailing fields', () => {
    expect(parseDelimited('a,b,c\n1,,3', ',')[1]).toEqual(['1', '', '3'])
  })
})

describe('sniffDelimiter', () => {
  it('detects comma, semicolon, tab and pipe', () => {
    expect(sniffDelimiter('a,b,c\n1,2,3')).toBe(',')
    expect(sniffDelimiter('a;b;c\n1;2;3')).toBe(';')
    expect(sniffDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t')
    expect(sniffDelimiter('a|b|c\n1|2|3')).toBe('|')
  })

  it('prefers the CONSISTENT delimiter over the most frequent one', () => {
    // Descriptions full of commas must not beat a genuinely semicolon-delimited
    // file just because commas are more numerous overall.
    const text = ['date;description;amount', '2026-09-26;Shop, Inc, Ltd;18.50', '2026-09-27;A, B, C;20.00'].join('\n')
    expect(sniffDelimiter(text)).toBe(';')
  })

  it('defaults to comma for single-column input', () => {
    expect(sniffDelimiter('just one column\nand another')).toBe(',')
  })
})

describe('findHeaderRow: drifting preambles', () => {
  const wechatHeader = ['交易时间', '交易类型', '交易对方', '商品', '收/支', '金额(元)', '支付方式', '当前状态']

  it('finds the header after a 16-line WeChat preamble', () => {
    const rows: string[][] = []
    for (let i = 0; i < 16; i += 1) rows.push([`preamble line ${i}`])
    rows.push(wechatHeader)
    rows.push(['2026-09-26 14:05:00', '商户消费', 'Some Shop', 'Item', '支出', '¥28.16', '零钱', '支付成功'])

    expect(findHeaderRow(rows, ['交易时间', '收/支', '金额', '交易对方'], 2)).toBe(16)
  })

  it('still finds the header when extra help lines shift it', () => {
    // Real WeChat exports insert a 常见问题 block in some versions, so a
    // hardcoded skip count breaks. The scan must tolerate the drift.
    const rows: string[][] = []
    for (let i = 0; i < 16; i += 1) rows.push([`preamble ${i}`])
    for (let i = 0; i < 5; i += 1) rows.push([`常见问题 ${i}`])
    rows.push(wechatHeader)

    expect(findHeaderRow(rows, ['交易时间', '收/支', '金额', '交易对方'], 2)).toBe(21)
  })

  it('returns -1 when no header is present', () => {
    const rows = [['random'], ['text'], ['only']]
    expect(findHeaderRow(rows, ['交易时间', '收/支'], 2)).toBe(-1)
  })
})

describe('looksLikeFooter', () => {
  it('recognises the summary rows that must not become transactions', () => {
    expect(looksLikeFooter(['共43笔记录'])).toBe(true)
    expect(looksLikeFooter(['总计', '1234.56'])).toBe(true)
    expect(looksLikeFooter(['', '', ''])).toBe(true)
    expect(looksLikeFooter(['--------------------'])).toBe(true)
  })

  it('does not mistake a real transaction for a footer', () => {
    expect(looksLikeFooter(['2026-09-26', 'Grab', '-18.50'])).toBe(false)
  })
})

describe('parseStatementAmount', () => {
  it('parses plain decimals and symbols', () => {
    expect(parseStatementAmount('18.50').minor).toBe(1850)
    expect(parseStatementAmount('¥28.16').minor).toBe(2816)
    // Full-width ￥ (U+FFE5) appears in real WeChat exports.
    expect(parseStatementAmount('￥50.0').minor).toBe(5000)
    expect(parseStatementAmount('RM1,234.56').minor).toBe(123456)
    expect(parseStatementAmount('2000.00').minor).toBe(200000)
  })

  it('handles variable decimal precision from CN wallets', () => {
    expect(parseStatementAmount('¥50.0').minor).toBe(5000)
    expect(parseStatementAmount('¥8.8').minor).toBe(880)
    expect(parseStatementAmount('¥0.35').minor).toBe(35)
  })

  it('reads parentheses and a trailing minus as negative', () => {
    expect(parseStatementAmount('(123.45)')).toEqual({ minor: 12345, negative: true })
    expect(parseStatementAmount('123.45-')).toEqual({ minor: 12345, negative: true })
    expect(parseStatementAmount('-88.00')).toEqual({ minor: 8800, negative: true })
  })

  it('distinguishes a decimal comma from a thousands separator', () => {
    // European style: comma is the decimal point.
    expect(parseStatementAmount('1.234,56').minor).toBe(123456)
    // Plain grouping: comma is a thousands separator.
    expect(parseStatementAmount('1,234.56').minor).toBe(123456)
    expect(parseStatementAmount('1,234').minor).toBe(123400)
  })

  it('treats empty markers as no amount rather than zero', () => {
    // A dash in a Debit column means "nothing here", NOT a zero transaction.
    expect(parseStatementAmount('-').minor).toBeNull()
    expect(parseStatementAmount('').minor).toBeNull()
    expect(parseStatementAmount('--').minor).toBeNull()
  })

  it('rejects non-numeric text instead of guessing', () => {
    expect(parseStatementAmount('abc').minor).toBeNull()
    expect(parseStatementAmount('12.3.4').minor).toBeNull()
  })

  it('never loses precision on a round trip through the parser', () => {
    for (const sample of ['0.01', '18.50', '100.10', '1234.56', '99999.99']) {
      const parsed = parseStatementAmount(sample)
      expect(parsed.minor).not.toBeNull()
      expect(parsed.minor).toBe(Math.round(Number(sample) * 100))
    }
  })
})

describe('parseStatementDate', () => {
  it('parses the CN wallet datetime format and keeps local wall-clock time', () => {
    // A statement timestamp is already local; re-zoning it would move the date.
    expect(parseStatementDate('2026-09-26 14:05:00')).toEqual({ date: '2026-09-26', time: '14:05' })
    expect(parseStatementDate('2026-09-26 23:30')).toEqual({ date: '2026-09-26', time: '23:30' })
  })

  it('parses ISO and compact dates', () => {
    expect(parseStatementDate('2026-09-26').date).toBe('2026-09-26')
    expect(parseStatementDate('20260926').date).toBe('2026-09-26')
  })

  it('parses named-month formats used by Malaysian statements', () => {
    expect(parseStatementDate('26 Sep 2026').date).toBe('2026-09-26')
    expect(parseStatementDate('19 Jul 2024').date).toBe('2024-07-19')
    expect(parseStatementDate('Sep 26, 2026').date).toBe('2026-09-26')
  })

  it('resolves DD/MM vs MM/DD using the hint when ambiguous', () => {
    // 03/04/2026 is 3 April (day-first) or 4 March (month-first).
    expect(parseStatementDate('03/04/2026', true).date).toBe('2026-04-03')
    expect(parseStatementDate('03/04/2026', false).date).toBe('2026-03-04')
  })

  it('ignores the hint when the format is unambiguous', () => {
    // 26 cannot be a month, so day-first is forced regardless of the hint.
    expect(parseStatementDate('26/09/2026', false).date).toBe('2026-09-26')
    // 09/26/2026 has a 26 in the middle, so month-first is forced.
    expect(parseStatementDate('09/26/2026', true).date).toBe('2026-09-26')
  })

  it('expands two-digit years sensibly', () => {
    expect(parseStatementDate('26/09/26').date).toBe('2026-09-26')
    expect(parseStatementDate('26/09/99').date).toBe('1999-09-26')
  })

  it('rejects impossible dates rather than rolling them forward', () => {
    // new Date(2026, 1, 31) would silently become 3 March.
    expect(parseStatementDate('2026-02-31').date).toBeNull()
    expect(parseStatementDate('2026-13-01').date).toBeNull()
    expect(parseStatementDate('garbage').date).toBeNull()
    expect(parseStatementDate('').date).toBeNull()
  })
})

describe('text helpers', () => {
  it('cleans stray tabs and collapses whitespace from CN exports', () => {
    // Real WeChat order ids arrive as "3985734\t".
    expect(cleanCell('  3985734\t')).toBe('3985734')
    expect(cleanCell('a\t\tb')).toBe('a b')
    expect(cleanCell('\u00a0non-breaking')).toBe('non-breaking')
    expect(cleanCell(undefined)).toBe('')
  })

  it('normalises a name for duplicate-key comparison', () => {
    // Case, spacing and punctuation must not create a false "different" verdict.
    expect(normaliseForKey('Grab Food')).toBe(normaliseForKey('grabfood'))
    expect(normaliseForKey('  GRAB   FOOD ')).toBe(normaliseForKey('Grab Food'))
    expect(normaliseForKey('7-Eleven')).toBe(normaliseForKey('7 Eleven'))
    expect(normaliseForKey(null)).toBe('')
  })
})
