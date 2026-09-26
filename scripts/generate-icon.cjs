/**
 * Generate the application icon.
 *
 * A real brand mark is an asset a designer supplies; for the MVP this draws a
 * clean geometric mark and writes both a multi-resolution .ico (used by
 * electron-builder for the installer, taskbar and window) and a .png (used by
 * the README).
 *
 * The PNG encoder is written by hand rather than pulled from a dependency: an
 * icon is generated once at build time, and adding an image library to the
 * project's dependency tree for that would be a poor trade in a local-first
 * finance app.
 *
 * Design: a rounded square in the app's accent indigo, with three ascending
 * bars and a rising stroke — reads as "growth" at 16px without detail that
 * disappears when scaled down.
 */
const { deflateSync } = require('node:zlib')
const { writeFileSync, mkdirSync, existsSync } = require('node:fs')
const { join } = require('node:path')

// --- PNG encoding ----------------------------------------------------------

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData), 0)
  return Buffer.concat([length, typeAndData, crc])
}

/** Encode an RGBA pixel buffer as a PNG. */
function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // adaptive filtering
  ihdr[12] = 0 // no interlace

  // Each scanline is prefixed with its filter byte (0 = none).
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// --- Drawing ---------------------------------------------------------------

const ACCENT = [79, 70, 229] // #4F46E5
const BAR = [255, 255, 255]

/** Signed distance from a point to a rounded rectangle, for antialiasing. */
function roundedRectDistance(px, py, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(px - cx) - (halfW - radius)
  const dy = Math.abs(py - cy) - (halfH - radius)
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0))
  return outside + Math.min(Math.max(dx, dy), 0) - radius
}

/**
 * Render the icon at a given size.
 *
 * Everything is computed from normalized coordinates so the mark stays
 * optically identical at 16px and 256px: the corner radius, bar widths and gaps
 * all scale with the canvas.
 */
function render(size) {
  const rgba = Buffer.alloc(size * size * 4)
  const s = size
  const radius = s * 0.22
  const cx = s / 2
  const cy = s / 2

  // Three ascending bars, laid out on a normalized grid.
  const barSpecs = [
    { x: 0.30, top: 0.60, width: 0.105 },
    { x: 0.45, top: 0.46, width: 0.105 },
    { x: 0.60, top: 0.32, width: 0.105 }
  ]
  const barBottom = 0.72

  const inset = 0.16
  const x0 = inset * s
  const x1 = (1 - inset) * s

  for (let y = 0; y < s; y += 1) {
    for (let x = 0; x < s; x += 1) {
      const px = x + 0.5
      const py = y + 0.5

      // Squircle background with 1px antialiasing.
      const bgDist = roundedRectDistance(px, py, cx, cy, s / 2, s / 2, radius)
      const bgAlpha = Math.min(Math.max(0.5 - bgDist, 0), 1)

      let r = 0
      let g = 0
      let b = 0
      let a = 0

      if (bgAlpha > 0) {
        r = ACCENT[0]
        g = ACCENT[1]
        b = ACCENT[2]
        a = bgAlpha
      }

      // Bars.
      for (const spec of barSpecs) {
        const bx0 = spec.x * s
        const bx1 = (spec.x + spec.width) * s
        const by0 = spec.top * s
        const by1 = barBottom * s
        if (px >= bx0 - 1 && px <= bx1 + 1 && py >= by0 - 1 && py <= by1 + 1) {
          const edge =
            Math.min(px - bx0, bx1 - px, py - by0, by1 - py) + 0.5
          const barAlpha = Math.min(Math.max(edge, 0), 1)
          if (barAlpha > 0) {
            r = r * (1 - barAlpha) + BAR[0] * barAlpha
            g = g * (1 - barAlpha) + BAR[1] * barAlpha
            b = b * (1 - barAlpha) + BAR[2] * barAlpha
            a = Math.max(a, barAlpha)
          }
        }
      }

      const i = (y * s + x) * 4
      rgba[i] = Math.round(r)
      rgba[i + 1] = Math.round(g)
      rgba[i + 2] = Math.round(b)
      rgba[i + 3] = Math.round(a * 255)
    }
  }

  // x0/x1 kept for clarity of the normalized layout above.
  void x0
  void x1

  return rgba
}

// --- ICO container ---------------------------------------------------------

/**
 * Build a multi-resolution .ico.
 *
 * Windows picks the most appropriate size from the directory, so shipping only
 * one resolution produces a blurry taskbar or a blocky Alt-Tab thumbnail. Each
 * entry stores a full PNG rather than a BMP, which every supported Windows
 * version understands and which keeps the file small.
 */
function buildIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(entries.length, 4)

  const directory = Buffer.alloc(16 * entries.length)
  let offset = 6 + 16 * entries.length
  const payloads = []

  entries.forEach((entry, index) => {
    const at = index * 16
    // 256 is encoded as 0 in the single-byte dimension fields.
    directory[at] = entry.size >= 256 ? 0 : entry.size
    directory[at + 1] = entry.size >= 256 ? 0 : entry.size
    directory[at + 2] = 0 // palette size
    directory[at + 3] = 0 // reserved
    directory.writeUInt16LE(1, at + 4) // colour planes
    directory.writeUInt16LE(32, at + 6) // bits per pixel
    directory.writeUInt32BE(0, at + 8)
    directory.writeUInt32LE(entry.png.length, at + 8)
    directory.writeUInt32LE(offset, at + 12)
    offset += entry.png.length
    payloads.push(entry.png)
  })

  return Buffer.concat([header, directory, ...payloads])
}

// --- Write -----------------------------------------------------------------

const outDir = join(__dirname, '..', 'build')
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })

const sizes = [16, 24, 32, 48, 64, 128, 256]
const entries = sizes.map((size) => ({ size, png: encodePng(size, size, render(size)) }))

const icoPath = join(outDir, 'icon.ico')
writeFileSync(icoPath, buildIco(entries))
console.log(`wrote ${icoPath} (${sizes.join(', ')} px)`)

const pngPath = join(outDir, 'icon.png')
const large = entries.find((entry) => entry.size === 256)
writeFileSync(pngPath, large.png)
console.log(`wrote ${pngPath} (256 px)`)
