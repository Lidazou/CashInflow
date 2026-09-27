/**
 * Verify tools/check-parse.cjs actually fails on a file it should.
 *
 * A guard that cannot fail is worse than no guard. The first two attempts at this
 * check could not detect their own fixtures (see the header of check-parse.cjs), so
 * this script writes known-bad files, asserts the guard rejects each, and removes
 * them again. Run it after touching the guard.
 *
 * Usage: node tools/test-parse-guard.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const GUARD = path.join(__dirname, 'check-parse.cjs')
const TARGET = path.join(ROOT, 'src', 'renderer', 'src', 'components', '__parse-fixture.tsx')

const TICK = String.fromCharCode(96)

const FIXTURES = [
  {
    name: 'backtick inside a CSS comment truncates the stylesheet',
    body: [
      'const STYLES = ' + TICK,
      '.foo {',
      '  --x: 1px;',
      '  /* a ' + TICK + 'backtick' + TICK + ' inside prose */',
      '  color: var(--x);',
      '}',
      TICK,
      'export default STYLES',
      ''
    ].join('\n')
  },
  {
    name: 'backtick as a CSS value',
    body: [
      'const STYLES = ' + TICK,
      '.foo {',
      '  --x: 1px;',
      "  content: '" + TICK + "';",
      '  color: var(--x);',
      '}',
      TICK,
      'export default STYLES',
      ''
    ].join('\n')
  },
  {
    name: 'unterminated template literal',
    body: ['const X = ' + TICK + 'never closed', 'export default X', ''].join('\n')
  }
]

function runGuard() {
  try {
    execFileSync(process.execPath, [GUARD], { cwd: ROOT, stdio: 'pipe' })
    return 0
  } catch (error) {
    return error.status ?? 1
  }
}

const baseline = runGuard()
console.log(`baseline (repository): ${baseline === 0 ? 'clean' : 'FAILING — fix the repo first'}`)
if (baseline !== 0) process.exit(1)

let missed = 0
for (const fixture of FIXTURES) {
  fs.writeFileSync(TARGET, fixture.body, 'utf8')
  const status = runGuard()
  fs.rmSync(TARGET, { force: true })

  const caught = status !== 0
  console.log(`  ${caught ? 'OK  ' : 'MISS'}  ${fixture.name}`)
  if (!caught) missed += 1
}

const after = runGuard()
console.log(`after cleanup: ${after === 0 ? 'clean' : 'FAILING — a fixture was left behind'}`)

if (missed > 0 || after !== 0) {
  console.error(`\n${missed} fixture(s) not detected.`)
  process.exit(1)
}
console.log('\nall fixtures detected')
