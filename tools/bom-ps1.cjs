/**
 * Add a UTF-8 BOM to a .ps1 file.
 *
 * PowerShell 5.1 (`powershell.exe`, the only one on PATH here) reads a script
 * without a BOM as ANSI, so a .ps1 containing Chinese string literals is parsed
 * as mojibake — and the mojibake can contain a quote character, producing a
 * syntax error rather than merely garbled output. A BOM is the one signal that
 * makes it read the file as UTF-8.
 *
 * This applies to .ps1 tooling ONLY. Nothing under src/ ever gets a BOM: a BOM in
 * a source module reaches the bundler as a stray U+FEFF.
 *
 * Usage: node tools/bom-ps1.cjs tools/make-diagram.ps1
 */
const fs = require('node:fs')

const targets = process.argv.slice(2)
if (targets.length === 0) {
  console.error('usage: node tools/bom-ps1.cjs <file.ps1> [...]')
  process.exit(1)
}

const BOM = Buffer.from([0xef, 0xbb, 0xbf])

for (const target of targets) {
  const raw = fs.readFileSync(target)
  const hasBom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf
  if (hasBom) {
    console.log('already has BOM:', target)
    continue
  }
  if (raw.includes(0xff) || raw.includes(0xfe)) {
    console.warn('WARNING: file contains byte-order-mark-like bytes:', target)
  }
  fs.writeFileSync(target, Buffer.concat([BOM, raw]))
  console.log('BOM added:', target)
}
