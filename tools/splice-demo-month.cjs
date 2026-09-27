/**
 * Splice the new month loop into demo-life.ts, between two ASCII anchors.
 *
 * The block is ~280 lines and byte-matching it with an edit tool is exactly the trap this
 * repository has hit before (a needle that looks identical is not byte-identical), so the
 * replacement is addressed by anchor and the file is rewritten from Node, which is
 * UTF-8-clean in both directions.
 *
 *   node tools/splice-demo-month.cjs <block-file> [--check]
 */
const fs = require('node:fs')
const path = require('node:path')

const blockFile = process.argv[2]
const checkOnly = process.argv.includes('--check')
if (!blockFile) {
  console.error('usage: node tools/splice-demo-month.cjs <block-file> [--check]')
  process.exit(1)
}

const target = path.join(__dirname, '..', 'src', 'main', 'services', 'demo-life.ts')
const source = fs.readFileSync(target, 'utf8')
const block = fs.readFileSync(blockFile, 'utf8').replace(/\r\n/g, '\n').trimEnd() + '\n'

const START = '  const closing: Record<string, number> = {}'
const END = '  /* --- subscriptions, budgets and reminders: the rest of the app\'s screens -- */'

const startIndex = source.indexOf(START)
const endIndex = source.indexOf(END)
if (startIndex === -1 || endIndex === -1) {
  console.error('anchor not found')
  process.exit(1)
}
if (endIndex <= startIndex) {
  console.error('anchors out of order')
  process.exit(1)
}

const next = source.slice(0, startIndex) + block + '\n' + source.slice(endIndex)
console.log(`replacing ${source.slice(startIndex, endIndex).split('\n').length} line(s) with ${block.split('\n').length}`)

if (checkOnly) {
  console.log('--check: not written')
  process.exit(0)
}
fs.writeFileSync(target, next, 'utf8')
console.log('written')
