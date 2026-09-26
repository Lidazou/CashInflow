/**
 * Insert `await scrollTop();` before the return of the dashboard screenshot steps.
 *
 * The steps share one live window, so any step that scrolls leaves that offset for
 * the next screenshot. Each dashboard step ends by settling the view it wants, and
 * that is exactly where the reset belongs. Patched by script rather than by hand
 * because the targets are JS template literals inside a JS file, and quoting them
 * through a shell mangles the escapes.
 *
 * Usage: node tools/patch-scrolltop.cjs [--dry]
 */
const fs = require('node:fs')
const path = require('node:path')

const target = path.join(__dirname, 'shots.cjs')
const dry = process.argv.includes('--dry')

const PATCHES = [
  {
    name: 'dashboard-natural',
    find: "      await setPeriodMode('自然月');\n      return 'natural month: '",
    replace: "      await setPeriodMode('自然月');\n      await scrollTop();\n      return 'natural month: '"
  },
  {
    name: 'dashboard-custom',
    find: "      return 'custom range: ' + (summary?.innerText.replace(/\\\\n/g, ' ') ?? '');",
    replace:
      "      await scrollTop();\n      return 'custom range: ' + (summary?.innerText.replace(/\\\\n/g, ' ') ?? '');"
  },
  {
    name: 'dashboard-dark',
    find: "      return 'dark: ' + (document.documentElement.className || '(none)');",
    replace: "      await scrollTop();\n      return 'dark: ' + (document.documentElement.className || '(none)');"
  }
]

let text = fs.readFileSync(target, 'utf8')
let patched = 0

for (const patch of PATCHES) {
  if (!text.includes(patch.find)) {
    console.log(`skip ${patch.name}: pattern not found (already patched?)`)
    continue
  }
  if (text.includes(patch.replace)) {
    console.log(`skip ${patch.name}: already patched`)
    continue
  }
  text = text.replace(patch.find, patch.replace)
  patched += 1
  console.log(`patched ${patch.name}`)
}

if (patched === 0) {
  console.log('nothing to do')
  process.exit(0)
}
if (dry) {
  console.log('[dry run] no file written')
  process.exit(0)
}

fs.writeFileSync(target, text, 'utf8')
console.log('written:', path.relative(path.join(__dirname, '..'), target))
