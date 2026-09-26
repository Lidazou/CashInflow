/**
 * Replace the mis-decoded em-dash marker (U+9225 followed by '?') with a real
 * em-dash across the source tree.
 *
 * The marker is the debris of a UTF-8 em-dash that was read as GBK early in the
 * project: the next byte was never mappable, so the writer stored '?' after it.
 * The result reads as "—" in an editor, which is easy to mistake for Chinese and
 * therefore easy to leave in place.
 *
 * Only that exact two-character sequence is touched. Ordinary '?' characters and
 * genuine Chinese text are left alone.
 *
 * Usage: node tools/fix-emdash.cjs [--dry]
 */
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'release', '.vite', 'coverage'])
const EXTENSIONS = new Set(['.ts', '.tsx', '.md', '.json', '.yml', '.yaml', '.cjs', '.mjs', '.html', '.css'])

const BAD = '\u9225?'
const GOOD = '\u2014'
const dry = process.argv.includes('--dry')

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
      walk(full, out)
    } else if (EXTENSIONS.has(path.extname(entry.name))) {
      out.push(full)
    }
  }
  return out
}

let filesChanged = 0
let occurrences = 0

for (const file of walk(ROOT)) {
  const original = fs.readFileSync(file, 'utf8')
  if (!original.includes(BAD)) continue
  const count = original.split(BAD).length - 1
  occurrences += count
  filesChanged += 1
  console.log(`${path.relative(ROOT, file)}: ${count}`)
  if (dry) continue
  fs.writeFileSync(file, original.split(BAD).join(GOOD), 'utf8')
}

console.log(
  dry
    ? `\n[dry run] ${occurrences} occurrence(s) in ${filesChanged} file(s)`
    : `\nreplaced ${occurrences} occurrence(s) in ${filesChanged} file(s)`
)
