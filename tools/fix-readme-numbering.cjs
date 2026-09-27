/**
 * Renumber the "五个地方" list in README.md after inserting the K-line section.
 *
 * The README uses emoji-numbered `###` headings as a five-item list. Inserting a new
 * first item shifted every following one, leaving two entries labelled 2️⃣. Renumber
 * mechanically so the count and the intro sentence cannot drift apart again.
 *
 * Usage: node tools/fix-readme-numbering.cjs [--dry]
 */
const fs = require('node:fs')
const path = require('node:path')

const target = path.join(__dirname, '..', 'README.md')
const dry = process.argv.includes('--dry')

const DIGITS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣']
const HEADING = /^### [0-9]\uFE0F?\u20E3 ?/u

const lines = fs.readFileSync(target, 'utf8').split('\n')

let index = 0
const changes = []

for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i]
  if (!HEADING.test(line)) continue

  // The list ends when a section without a number appears; this README's numbered
  // list is contiguous, so a single running counter is enough.
  const rest = line.replace(HEADING, '')
  const next = `${'### '}${DIGITS[index] ?? `${index + 1}.`} ${rest}`
  if (next !== line) changes.push({ line: i + 1, from: line, to: next })
  lines[i] = next
  index += 1
}

if (changes.length === 0) {
  console.log('numbering already correct')
  process.exit(0)
}

for (const change of changes) {
  console.log(`  line ${change.line}: ${change.from.slice(0, 34)} -> ${change.to.slice(0, 34)}`)
}

if (dry) {
  console.log('[dry run] no file written')
  process.exit(0)
}

const text = lines.join('\n')

// Keep the intro sentence honest about how many items follow.
const counted = text.match(/它和普通记账 App 的区别在(.+?)个地方/u)
if (counted) {
  const fixed = text.replace(counted[0], `它和普通记账 App 的区别在${index}个地方`)
  fs.writeFileSync(target, fixed, 'utf8')
  console.log(`renumbered ${changes.length} heading(s); intro now says ${index}`)
} else {
  fs.writeFileSync(target, text, 'utf8')
  console.log(`renumbered ${changes.length} heading(s); intro sentence not found, left alone`)
}
