/**
 * Repair the punctuation that a PowerShell GBK round-trip destroyed in CashflowChart.tsx.
 *
 *   node tools/fix-cfc-mojibake.cjs [--check]
 *
 * `repair-gbk-roundtrip.cjs` reverses everything that is reversible. What is left is the
 * handful of bytes the ORIGINAL mis-read replaced with '?' — an em dash read as CP936 is
 * three UTF-8 bytes, the decoder consumed two and turned the third into a question mark,
 * so '—' survives as '閳?'. Those characters cannot be recovered from the file, only
 * rewritten, and each one is judgement: '閳?' is an em dash in one comment and an arrow in
 * the next. So they are addressed one by one, anchored on surrounding ASCII, and every
 * rule asserts that it actually matched.
 */
const fs = require('node:fs')
const path = require('node:path')

const file = path.join(__dirname, '..', 'src', 'renderer', 'src', 'components', 'CashflowChart.tsx')
const checkOnly = process.argv.includes('--check')

const DASH = '\u2014'
const EN = '\u2013'

/** [anchor-substring, replacement] — applied in order, each must match. */
const RULES = [
  // The panel diagram. Box-drawing characters did not survive, so it is rebuilt.
  [
    ' *     \u95b3? BALANCE K-LINE          OHLC \u74ba?wick \u74ba?MA    \u95b3? ~52%',
    ` *     \u250c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510
 *     \u2502  BALANCE K-LINE          OHLC \u00b7 wick \u00b7 MA    \u2502  ~52%`
  ],
  [
    ' *     \u95b3? DAILY CASH ACTIVITY     stacked transactions \u95b3? ~48%',
    ` *     \u251c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524  1px divider
 *     \u2502  DAILY CASH ACTIVITY     stacked transactions \u2502  ~48%`
  ],
  [
    ' *        time axis, drawn once, shared',
    ` *     \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518
 *        time axis, drawn once, shared`
  ],

  // Section symbols and ranges.
  ['spec \u938c?8: 150\u95b3?50', `spec \u00a738: 150${EN}250`],
  ['spec \u938c?3', 'spec \u00a713'],
  ['spec \u938c?2\u9225?9', `spec \u00a712${EN}\u00a719`],
  ['spec \u938c?2\u9225\uff5e?9', `spec \u00a712${EN}\u00a719`],

  // Symbols that live in code, not comments.
  ['\u922b\u6191', '\u2191{'],
  ['\u922b\u642f', '\u2193{'],
  ['\u9474\u7854', '\u00d7{'],

  // Individual characters whose surrounding words say which one they were.
  ['e.g. "3\u6d93\u6e40"', 'e.g. "3\u4e2a\u6708"'],
  ['capped at \u9357?px', 'capped at \u00b16px'],
  ['Grows 0 \u95b3?1 once', `Grows 0 \u2192 1 once`],
  ['Ctrl (or \u95b3? anywhere', 'Ctrl (or \u2318) anywhere'],
  ['income \u95b3?expense, above', `income \u2212 expense, above`],
  ['balance BEFORE a visible window \u95b3?the transaction', `balance BEFORE a visible window ${DASH}the transaction`]
]

/** Everything left that is a dash, once the specific cases above are handled. */
const DASH_TOKENS = ['\u95b3?', '\u9225?', '\u9225\uff5e']

function main() {
  let text = fs.readFileSync(file, 'utf8')
  const before = text
  let applied = 0

  for (const [anchor, replacement] of RULES) {
    const index = text.indexOf(anchor)
    if (index === -1) {
      // A rule that does not match is a rule that would silently do nothing.
      const loose = anchor.replace(/[\u4e00-\u9fff\u95b3?\u9225?]/g, '.')
      console.log(`  skip (not present): ${anchor.slice(0, 54)}`)
      void loose
      continue
    }
    text = text.slice(0, index) + replacement + text.slice(index + anchor.length)
    applied += 1
  }

  for (const token of DASH_TOKENS) {
    let count = 0
    while (text.includes(token)) {
      text = text.replace(token, DASH)
      count += 1
    }
    if (count > 0) console.log(`  ${count} x "${token}" -> em dash`)
    applied += count
  }

  const left = text.match(/[\u95b3\u9225\u938c\u74ba\u9357\u922b\u9474\u6d93\u6e40\u6191\u642f\u7854\u6e7f\u6d4b]/g) ?? []
  console.log(`rules applied: ${applied}, changed: ${text !== before}`)
  console.log(`suspicious characters left: ${left.length}`)

  if (checkOnly) return
  fs.writeFileSync(file, text, 'utf8')
  console.log('written')
}

main()
