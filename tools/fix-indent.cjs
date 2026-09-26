/**
 * Re-indent the 今天 block in DashboardPage.tsx after the layout change.
 *
 * The block moved one level deeper (inside `.sw-dash__stack`), and the edit that
 * moved it left the interior lines at their old indentation. Hand-editing 39 lines
 * through the edit tool is error-prone; this is mechanical, so it is scripted.
 *
 * The boundary is found by content, not by line number, and the script refuses to
 * run if the block is not in the shape it expects.
 *
 * Usage: node tools/fix-indent.cjs [--dry]
 */
const fs = require('node:fs')
const path = require('node:path')

const target = path.join(__dirname, '..', 'src', 'renderer', 'src', 'pages', 'DashboardPage.tsx')
const dry = process.argv.includes('--dry')

const START = '            <dl className="sw-dash__figures sw-dash__figures--compact">'
// The `</section>` that closes 今天. Anchored on the blank line + comment that
// follow it, so the closing tag of a later card cannot be matched by mistake.
const END_MARKER = '            {/* ---------------- below today: biggest expenses ---------------- */}'

function indentOf(line) {
  return line.length - line.trimStart().length
}

const lines = fs.readFileSync(target, 'utf8').split('\n')

const start = lines.indexOf(START)
if (start === -1) {
  console.error('FAIL: start marker not found (already re-indented?)')
  process.exit(1)
}

const endMarker = lines.indexOf(END_MARKER)
if (endMarker === -1) {
  console.error('FAIL: end marker not found')
  process.exit(1)
}

// Walk back from the divider comment to the `</section>` and the blank line above it.
let end = endMarker - 1
while (end > start && lines[end].trim() === '') end -= 1
if (!lines[end].trim().startsWith('</section>')) {
  console.error('FAIL: expected </section> before the divider, found:', JSON.stringify(lines[end]))
  process.exit(1)
}

let changed = 0
for (let i = start; i <= end; i += 1) {
  const line = lines[i]
  if (line.trim() === '') continue
  const current = indentOf(line)
  // Only lines still at the OLD level are touched. Anything already deeper (the
  // contents of a nested <Figure>, for instance) keeps its relative structure.
  if (current >= 12) {
    lines[i] = ' '.repeat(current + 2) + line.trimStart()
    changed += 1
  }
}

console.log(`block lines ${start + 1}..${end + 1}; re-indented ${changed} line(s)`)
if (dry) process.exit(0)

fs.writeFileSync(target, lines.join('\n'), 'utf8')
console.log('written:', path.relative(path.join(__dirname, '..'), target))
