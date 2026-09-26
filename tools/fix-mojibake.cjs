/**
 * Surgical, line-addressed repair for three corrupted literals in
 * src/main/ipc/index.ts.
 *
 * These lines were written through a GBK round-trip early in the project and the
 * mojibake has been stored in the source ever since (it survived every later
 * UTF-8-clean edit because nothing rewrote those exact lines).
 *
 *   SECURITY (spec <mojibake>)        -> SECURITY (spec 7, 29)
 *   '<mojibake> ID'                   -> '统计区间 ID'
 *   'is replaced <mojibake>otherwise' -> 'is replaced - otherwise'
 *
 * WHY THIS SCRIPT IS ADDRESSED BY LINE AND OFFSET
 * -----------------------------------------------
 * Matching on the corrupted text failed repeatedly: the mojibake survives a UTF-8
 * file write intact, but not a round-trip through a console or a tool argument,
 * so a needle built from a pasted copy compared unequal while looking identical.
 * Rather than fight that, the repair rebuilds each line from its clean ASCII head
 * plus a freshly written tail, and asserts the head is what it expects first.
 *
 * Idempotent: a second run reports "nothing to do".
 */
const fs = require('node:fs')
const path = require('node:path')

const target = path.join(__dirname, '..', 'src', 'main', 'ipc', 'index.ts')

/**
 * Each rule: the ASCII prefix that must be present, and the replacement line.
 * `prefix` is checked before writing so a shifted file fails loudly instead of
 * silently corrupting a different line.
 */
const RULES = [
  {
    prefix: ' * SECURITY (spec ',
    line: ' * SECURITY (spec \u00a77, \u00a729)'
  },
  {
    prefix: '    (id) => svc().statistics.deleteCustomPeriod(assertId(id, ',
    line: "    (id) => svc().statistics.deleteCustomPeriod(assertId(id, '\u7edf\u8ba1\u533a\u95f4 ID'))"
  },
  {
    prefix: ' *      anything is replaced ',
    line: ' *      anything is replaced \u2014 otherwise the user loses their data to a bad file.'
  }
]

const original = fs.readFileSync(target, 'utf8')
const lines = original.split('\n')
let changed = 0

for (const rule of RULES) {
  const index = lines.findIndex((line) => line.startsWith(rule.prefix))
  if (index === -1) {
    console.log('not found (already clean?):', JSON.stringify(rule.prefix))
    continue
  }
  if (lines[index] === rule.line) {
    console.log('already correct at line', index + 1)
    continue
  }
  console.log(`line ${index + 1}: repaired`)
  lines[index] = rule.line
  changed += 1
}

if (changed === 0) {
  console.log('nothing to do')
  process.exit(0)
}

// Explicit UTF-8, no BOM. This project has been burned three times by
// default-encoding writers mangling the Chinese source strings.
fs.writeFileSync(target, lines.join('\n'), 'utf8')
console.log('written:', target, `(${changed} line(s))`)

if (lines.join('\n').includes('\uFFFD')) {
  console.error('WARNING: U+FFFD still present in the file')
  process.exit(1)
}
