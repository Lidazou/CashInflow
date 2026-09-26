/**
 * Repository-wide mojibake scan.
 *
 * Three separate incidents in this project wrote Chinese source text through a
 * GBK round-trip, producing stored garbage that still *looks* like Chinese in an
 * editor and therefore survives review. U+FFFD-based detection misses it,
 * because the corruption happened before the file was ever written.
 *
 * The reliable signal is contextual: real Chinese source here is unambiguous
 * prose, while mojibake shows up as rare CJK blocks used out of place and as CJK
 * sitting directly against ASCII with no space. This script flags suspicious
 * lines for human review rather than trying to auto-repair them.
 *
 * Usage: node tools/scan-mojibake.cjs
 */
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'release', '.vite', 'coverage'])
const EXTENSIONS = new Set(['.ts', '.tsx', '.md', '.json', '.yml', '.yaml', '.cjs', '.mjs', '.html', '.css'])

/**
 * Characters that appear in this codebase only as the product of a UTF-8 -> GBK
 * mis-decode. None of them are words: they are the debris of a byte pair that
 * used to be a dash, a section sign, or a common Chinese morpheme.
 */
const TELLTALE = /[\u95b9\u9539\u6d2a\u68e6\u68ff\u7f01\u71bb\u9978\u9225\u93b4\u951b\u5a04\u9359\u93c8\u7f38\u7eef\u95c2\u93c2\u93c3\u94f9\u93af\u5a11]/

/** Classic double-encoded punctuation, written as escapes so this file stays clean. */
const DOUBLE_ENCODED = /[\u9225\u93b4\u9428\u6d93\u935c\u7ee0\u951c\u93ac\u93c1\u93c9]/

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.github') {
      if (entry.isDirectory()) continue
    }
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(full, out)
    } else if (EXTENSIONS.has(path.extname(entry.name))) {
      out.push(full)
    }
  }
  return out
}

let flagged = 0
for (const file of walk(ROOT)) {
  const text = fs.readFileSync(file, 'utf8')
  const lines = text.split('\n')
  lines.forEach((line, index) => {
    const suspicious =
      line.includes('\uFFFD') || TELLTALE.test(line) || DOUBLE_ENCODED.test(line) || /[\u4e00-\u9fff][A-Za-z]{2,}/.test(line)
    if (!suspicious) return
    // A deliberate whitelist: placeholders like '$1' next to Chinese are fine,
    // and some UI copy legitimately mixes scripts (BYD, CSV, ID).
    if (/[\u4e00-\u9fff](CSV|XLSX|ID|API|URL|SQL|IPC|BYD|UI|MB|KB|GB|App|Windows|macOS)\b/.test(line)) return
    flagged += 1
    console.log(`${path.relative(ROOT, file)}:${index + 1}: ${line.trim().slice(0, 120)}`)
  })
}

console.log(flagged === 0 ? '\nclean: no mojibake found' : `\n${flagged} suspicious line(s)`)
