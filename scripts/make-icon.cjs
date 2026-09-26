/**
 * Build the application icon from supplied wallet artwork.
 *
 * WHY A COLOUR KEY IS NEEDED
 * -------------------------
 * The source PNG is 24bpp RGB: no alpha channel, and the area outside the rounded
 * square is opaque near-white. Used as-is it would draw a white box around itself
 * on a dark taskbar and on any non-white wallpaper — the classic "PNG saved
 * without transparency" defect.
 *
 * WHERE THE KEY IS APPLIED, AND WHERE IT IS NOT
 * ---------------------------------------------
 * Only OUTSIDE the rounded square's boundary. The artwork contains genuinely white
 * pixels inside it (the yen glyph on the coin, the card peeking from the wallet),
 * and keying the whole image would punch holes through them. Inside the boundary
 * every pixel is copied byte-for-byte.
 *
 * Resizing uses System.Drawing's HighQualityBicubic in one batch invocation; the
 * colour key and the ICO container are handled here.
 *
 *   node scripts/make-icon.cjs <source.png>
 */
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
const { execFileSync } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const SOURCE = process.argv[2]
const BUILD_DIR = path.join(ROOT, 'build')
const OUT_ICO = path.join(BUILD_DIR, 'icon.ico')
const OUT_PNG = path.join(BUILD_DIR, 'icon.png')
const SIZES = [16, 24, 32, 48, 64, 128, 256]

if (!SOURCE || !fs.existsSync(SOURCE)) {
  console.error('usage: node scripts/make-icon.cjs <source.png>')
  process.exit(1)
}

function prerender(sizes) {
  const quotedSource = SOURCE.replace(/'/g, "''")
  const quotedDir = BUILD_DIR.replace(/'/g, "''")
  const lines = [
    'Add-Type -AssemblyName System.Drawing',
    "$src = [System.Drawing.Bitmap]::FromFile('" + quotedSource + "')",
    'foreach ($size in @(' + sizes.join(',') + ')) {',
    '  $out = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)',
    '  $g = [System.Drawing.Graphics]::FromImage($out)',
    '  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
    '  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality',
    '  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality',
    '  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality',
    '  $g.Clear([System.Drawing.Color]::Transparent)',
    '  $g.DrawImage($src, 0, 0, $size, $size)',
    '  $g.Dispose()',
    "  $out.Save((Join-Path '" + quotedDir + "' \"tmp-$size.png\"), [System.Drawing.Imaging.ImageFormat]::Png)",
    '  $out.Dispose()',
    '}',
    '$src.Dispose()',
    "Write-Output 'prerender-ok'"
  ]

  const result = execFileSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', lines.join('\n')],
    { encoding: 'utf8' }
  )
  if (!result.includes('prerender-ok')) throw new Error('prerender failed: ' + result)
}

function crc32(buf) {
  let crc = 0xffffffff
  for (const byte of buf) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed), 0)
  return Buffer.concat([len, typed, crc])
}

/** Decode an 8-bit non-interlaced PNG (colour type 2 or 6) to RGBA. */
function decodePng(buffer) {
  let offset = 8
  let width = 0
  let height = 0
  let colorType = 0
  const idat = []

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      colorType = data[9]
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }

  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0
  if (channels === 0) throw new Error('unsupported PNG colour type ' + colorType)

  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const rgba = Buffer.alloc(width * height * 4)
  const line = Buffer.alloc(stride)
  const prev = Buffer.alloc(stride)

  let pos = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos]
    pos += 1
    raw.copy(line, 0, pos, pos + stride)
    pos += stride

    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? line[i - channels] : 0
      const b = prev[i]
      const c = i >= channels ? prev[i - channels] : 0
      if (filter === 1) line[i] = (line[i] + a) & 0xff
      else if (filter === 2) line[i] = (line[i] + b) & 0xff
      else if (filter === 3) line[i] = (line[i] + ((a + b) >> 1)) & 0xff
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
        line[i] = (line[i] + pr) & 0xff
      }
    }

    for (let x = 0; x < width; x += 1) {
      const s = x * channels
      const d = (y * width + x) * 4
      rgba[d] = line[s]
      rgba[d + 1] = line[s + 1]
      rgba[d + 2] = line[s + 2]
      rgba[d + 3] = channels === 4 ? line[s + 3] : 255
    }
    line.copy(prev)
  }

  return { width, height, rgba }
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6

  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

/**
 * Make the region outside the rounded square transparent.
 *
 * The boundary is a rounded rectangle derived from the measured content box: the
 * artwork's square occupies the middle ~80% of the canvas with an even margin, and
 * its corners are rounded at roughly 17.5% of the width. Outside that boundary the
 * background is keyed by whiteness, which also gives the antialiased edge a soft
 * alpha instead of a hard cut.
 */
function keyOutBackground(image) {
  const { width, height, rgba } = image
  const inset = Math.round(width * 0.099)
  const radius = width * 0.175

  const x0 = inset
  const y0 = inset
  const x1 = width - inset - 1
  const y1 = height - inset - 1

  let keyed = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = Math.max(x0 + radius - x, 0, x - (x1 - radius))
      const dy = Math.max(y0 + radius - y, 0, y - (y1 - radius))
      if (Math.hypot(dx, dy) - radius <= 0) continue // inside: untouched

      const i = (y * width + x) * 4
      const whiteness = Math.min(rgba[i], rgba[i + 1], rgba[i + 2]) / 255
      if (whiteness < 0.55) continue // not background: keep the artwork

      const coverage = Math.min(Math.max((whiteness - 0.55) / 0.42, 0), 1)
      const next = Math.round(rgba[i + 3] * (1 - coverage))
      if (next < rgba[i + 3]) keyed += 1
      rgba[i + 3] = next
    }
  }
  return keyed
}

/** Assemble a multi-resolution .ico whose entries are PNGs. */
function buildIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)

  const directory = Buffer.alloc(16 * entries.length)
  let offset = 6 + 16 * entries.length
  const payloads = []

  entries.forEach((entry, index) => {
    const at = index * 16
    // 256 is encoded as 0 in the single-byte dimension fields.
    directory[at] = entry.size >= 256 ? 0 : entry.size
    directory[at + 1] = entry.size >= 256 ? 0 : entry.size
    directory[at + 2] = 0
    directory[at + 3] = 0
    directory.writeUInt16LE(1, at + 4)
    directory.writeUInt16LE(32, at + 6)
    directory.writeUInt32LE(entry.png.length, at + 8)
    directory.writeUInt32LE(offset, at + 12)
    offset += entry.png.length
    payloads.push(entry.png)
  })

  return Buffer.concat([header, directory, ...payloads])
}

prerender(SIZES)

const entries = []
let totalKeyed = 0

for (const size of SIZES) {
  const decoded = decodePng(fs.readFileSync(path.join(BUILD_DIR, 'tmp-' + size + '.png')))
  totalKeyed += keyOutBackground(decoded)
  entries.push({ size, png: encodePng(decoded.width, decoded.height, decoded.rgba) })
  fs.unlinkSync(path.join(BUILD_DIR, 'tmp-' + size + '.png'))
}

fs.writeFileSync(OUT_ICO, buildIco(entries))
fs.writeFileSync(OUT_PNG, entries.find((entry) => entry.size === 256).png)

console.log('icon.ico  ' + SIZES.join(', ') + ' px  ' + Math.round(fs.statSync(OUT_ICO).size / 1024) + ' KB')
console.log('icon.png  256 px  ' + Math.round(fs.statSync(OUT_PNG).size / 1024) + ' KB')
console.log('抠除背景像素 ' + totalKeyed + ' 个')
