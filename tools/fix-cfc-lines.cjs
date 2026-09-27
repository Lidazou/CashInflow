/**
 * Finish the repair of CashflowChart.tsx: the panel diagram, and the spaces the lossy
 * '?' ate.
 *
 *   node tools/fix-cfc-lines.cjs [--check]
 *
 * Two separate problems, both from the same accident:
 *
 *   1. The box-drawing diagram was destroyed as a BLOCK — its rows merged into one long
 *      run of mojibake — so it cannot be patched character by character. It is rebuilt
 *      between two ASCII markers that did survive.
 *   2. Every em dash lost the space that followed it, because the byte after the dash was
 *      invalid in CP936 and the decoder consumed it together with the dash. The text is
 *      otherwise correct, so the space is restored by rule rather than by hand.
 *
 * Byte-matching the corrupted text does not work (a needle typed here is not byte-identical
 * to what is in the file even when it looks the same), so lines are addressed by index and
 * every rule asserts an ASCII marker first.
 */
const fs = require('node:fs')
const path = require('node:path')

const file = path.join(__dirname, '..', 'src', 'renderer', 'src', 'components', 'CashflowChart.tsx')
const checkOnly = process.argv.includes('--check')

const ART = [
  ' *     \u250c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510',
  ' *     \u2502  BALANCE K-LINE          OHLC \u00b7 wick \u00b7 MA    \u2502  ~52%',
  ' *     \u251c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524  1px divider',
  ' *     \u2502  DAILY CASH ACTIVITY     stacked transactions \u2502  ~48%',
  ' *     \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518'
]

function main() {
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  let changed = 0

  /* ---- 1. the diagram, as a block between two surviving ASCII markers ---- */
  const start = lines.findIndex((line) => line.includes('TWO PANELS, ONE TIME AXIS, TWO VALUE AXES'))
  const end = lines.findIndex((line) => line.trim() === '*        time axis, drawn once, shared')
  if (start === -1 || end === -1) {
    console.error('diagram markers not found; refusing')
    process.exit(1)
  }
  if (end <= start) {
    console.error('diagram markers are out of order; refusing')
    process.exit(1)
  }
  const replaced = lines.slice(start + 1, end)
  console.log(`diagram: replacing ${replaced.length} line(s) with ${ART.length}`)
  lines.splice(start + 1, end - start - 1, ...ART)
  changed += 1

  /* ---- 2. the space each em dash lost ---- */
  let restored = 0
  for (let i = 0; i < lines.length; i += 1) {
    const next = lines[i].replace(/\u2014(?=[A-Za-z0-9\u4e00-\u9fff(])/g, '\u2014 ')
    if (next !== lines[i]) {
      restored += (lines[i].match(/\u2014(?=[A-Za-z0-9\u4e00-\u9fff(])/g) ?? []).length
      lines[i] = next
    }
  }
  console.log(`em dashes given back their space: ${restored}`)

  /*
    ---- 3. the multiplication signs ----

    '×' (U+00D7) read as CP936 is the same story as the em dash: two bytes consumed, the
    third turned into '?', and the SPACE after it eaten as well. Both survivors sit in
    prose — "`span × f`" and "`amount / total × available`" — so the intended character is
    known from the sentence, and the ASCII around it pins the position.
  */
  const multiplications = [
    ['Horizontal zoom is `span', '` about the instant under the pointer'],
    ['`amount / total', 'available`, so the proportions are the data']
  ]
  let times = 0
  for (const [head, tail] of multiplications) {
    const index = lines.findIndex((line) => line.includes(head) && line.includes(tail))
    if (index === -1) {
      console.error(`multiplication sign not found near: ${head}`)
      process.exit(1)
    }
    const headEnd = lines[index].indexOf(head) + head.length
    const tailStart = lines[index].indexOf(tail)
    lines[index] = `${lines[index].slice(0, headEnd)} \u00d7 ${lines[index].slice(tailStart)}`
    times += 1
  }
  console.log(`multiplication signs rebuilt: ${times}`)

  const text = lines.join('\n')
  const offenders = lines
    .map((line, index) => ({ index, line }))
    .filter((entry) => /[\u95b3\u9225\u938c\u74ba\u9357\u922b\u9474\u6d93\u6e40\u6191\u642f\u7854]/.test(entry.line))
  console.log(`suspicious lines left: ${offenders.length}`)
  for (const offender of offenders) {
    console.log(`  ${offender.index + 1}: ${offender.line.slice(0, 120)}`)
  }
  if (offenders.length > 0) {
    console.error('refusing to write')
    process.exit(1)
  }
  if (checkOnly) {
    console.log('--check: not written')
    return
  }
  fs.writeFileSync(file, text, 'utf8')
  console.log(`written (${changed} block(s) rebuilt)`)
}

main()
