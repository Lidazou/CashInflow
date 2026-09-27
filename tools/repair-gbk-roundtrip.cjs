/**
 * Undo a PowerShell GBK round-trip on a source file.
 *
 *   node tools/repair-gbk-roundtrip.cjs <file> [--check]
 *
 * WHAT HAPPENED
 * -------------
 * `Get-Content -Raw` on Windows PowerShell 5 reads using the system ANSI codepage
 * (CP936 here), not UTF-8, and `Set-Content -Encoding utf8` then writes that mis-decoded
 * text back out as UTF-8. Every multi-byte character in the file becomes mojibake:
 *
 *     余额 K 线   ->   浣欓 K 绾?
 *
 * It is not a partial corruption — it is a byte-level transform, and it is invertible:
 *
 *     original UTF-8 bytes --decode GBK--> mojibake --encode UTF-8--> what is on disk
 *
 * So the repair is the same transform backwards. Node can DECODE GBK through ICU but has
 * no GBK encoder, so the reverse map is built here by brute force over the two-byte code
 * space — about 24,000 decodes, which is nothing, and it is exact rather than a guess
 * built from a table someone typed in.
 *
 * `--check` reports what it would change without writing.
 */
const fs = require('node:fs')
const path = require('node:path')

const target = process.argv[2]
const checkOnly = process.argv.includes('--check')
if (!target) {
  console.error('usage: node tools/repair-gbk-roundtrip.cjs <file> [--check]')
  process.exit(1)
}

const file = path.resolve(target)
const decoder = new TextDecoder('gbk', { fatal: false })

/** mojibake character -> the GBK byte sequence that produced it. */
function buildReverseMap(chars) {
  const wanted = new Set(chars)
  const map = new Map()
  const consider = (bytes, text) => {
    if (text.length === 1 && wanted.has(text) && !map.has(text)) {
      map.set(text, Buffer.from(bytes))
    }
  }
  // Single-byte codes: 0x80 is € in CP936, and the ASCII range maps to itself.
  for (let b = 0x80; b <= 0xff; b += 1) consider([b], decoder.decode(Buffer.from([b])))
  // Two-byte codes: lead 0x81..0xFE, trail 0x40..0x7E and 0x80..0xFE.
  for (let lead = 0x81; lead <= 0xfe && map.size < wanted.size; lead += 1) {
    for (let trail = 0x40; trail <= 0xfe; trail += 1) {
      if (trail === 0x7f) continue
      consider([lead, trail], decoder.decode(Buffer.from([lead, trail])))
    }
  }
  return map
}

function main() {
  const bytes = fs.readFileSync(file)
  const mojibake = bytes.toString('utf8')

  const exotic = [...new Set(mojibake.split('').filter((ch) => ch.charCodeAt(0) > 0x7f))]
  if (exotic.length === 0) {
    console.log(`${path.basename(file)}: pure ASCII, nothing to repair`)
    return
  }

  const reverse = buildReverseMap(exotic)
  const missing = exotic.filter((ch) => !reverse.has(ch))
  if (missing.length > 0) {
    console.error(`cannot map ${missing.length} character(s): ${missing.slice(0, 20).join('')}`)
    process.exit(1)
  }

  /*
    Greedy, byte-level rewrite with a fallback.

    A source file can carry TWO kinds of damage: the round-trip this tool reverses, and
    older mojibake that was stored in a comment years ago (this repository has some — see
    `fix-mojibake.cjs`). The second kind does not survive the inverse transform, and
    turning it into replacement characters would be a NEW corruption committed in the name
    of a repair. So a run of bytes that does not decode cleanly is LEFT ALONE, and the
    count of characters that had to be left alone is reported.
  */
  const utf8 = new TextDecoder('utf-8', { fatal: true })
  const out = []
  let pending = []
  let untouched = 0

  const flush = (force) => {
    if (pending.length === 0) return
    try {
      out.push(utf8.decode(Buffer.concat(pending)))
      pending = []
      return
    } catch {
      /* fall through */
    }
    if (!force) {
      // Try again later: this run may simply end mid-character.
      try {
        utf8.decode(Buffer.concat(pending))
        return
      } catch {
        /* still broken */
      }
    }
    for (const char of decoder.decode(Buffer.concat(pending)).split('')) {
      out.push(char)
    }
    untouched += pending.length
    pending = []
  }

  for (const ch of mojibake) {
    const code = ch.charCodeAt(0)
    if (code < 0x80) {
      flush(true)
      out.push(ch)
      continue
    }
    pending.push(reverse.get(ch))
    // Three bytes is the longest a single original character can need.
    if (pending.length >= 3) {
      try {
        out.push(utf8.decode(Buffer.concat(pending)))
        pending = []
      } catch {
        /* keep accumulating */
      }
    }
  }
  flush(false)

  const repaired = out.join('')
  const broken = (repaired.match(/\uFFFD/g) ?? []).length
  const before = (mojibake.match(/[\u4e00-\u9fff]/g) ?? []).length
  const after = (repaired.match(/[\u4e00-\u9fff]/g) ?? []).length

  console.log(`${path.basename(file)}`)
  console.log(`  exotic characters : ${exotic.length} distinct, all mapped`)
  console.log(`  CJK before/after  : ${before} -> ${after}`)
  console.log(`  left untouched    : ${untouched} byte(s) of pre-existing damage`)
  console.log(`  replacement chars : ${broken}`)
  console.log(`  sample            : ${repaired.split('\n').find((line) => /[\u4e00-\u9fff]/.test(line))?.trim().slice(0, 90) ?? '(none)'}`)

  if (broken > 0) {
    console.error('refusing to write: the result still contains replacement characters')
    process.exit(1)
  }
  if (checkOnly) {
    console.log('  --check: not written')
    return
  }
  fs.writeFileSync(file, repaired, 'utf8')
  console.log('  written')
}

main()
