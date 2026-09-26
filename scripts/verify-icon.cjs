/**
 * Verify the generated icon before it is baked into the executable.
 *
 * Two failure modes matter and neither is visible from file size:
 *   1. The background was not keyed, so the icon draws a white box on dark surfaces.
 *   2. The key was too aggressive and punched holes in the white artwork inside the
 *      square (the yen glyph on the coin).
 *
 * This decodes each ICO entry and reports the alpha at the corners, along the
 * edges, and at the centre where the white glyph lives.
 */
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const ICO = path.join(__dirname, '..', 'build', 'icon.ico')

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
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    offset += 12 + length
  }
  const channels = colorType === 6 ? 4 : 3
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
        line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff
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

const ico = fs.readFileSync(ICO)
const count = ico.readUInt16LE(4)
console.log('ICO 内含 ' + count + ' 个尺寸\n')

const pixel = (img, x, y) => {
  const i = (y * img.width + x) * 4
  return { r: img.rgba[i], g: img.rgba[i + 1], b: img.rgba[i + 2], a: img.rgba[i + 3] }
}

let problems = 0

for (let n = 0; n < count; n += 1) {
  const at = 6 + n * 16
  const size = ico[at] === 0 ? 256 : ico[at]
  const length = ico.readUInt32LE(at + 8)
  const offset = ico.readUInt32LE(at + 12)
  const img = decodePng(ico.subarray(offset, offset + length))

  const c0 = pixel(img, 0, 0)
  const c1 = pixel(img, img.width - 1, 0)
  const c2 = pixel(img, 0, img.height - 1)
  const c3 = pixel(img, img.width - 1, img.height - 1)
  const edgeTop = pixel(img, Math.floor(img.width / 2), 0)
  const center = pixel(img, Math.floor(img.width / 2), Math.floor(img.height / 2))

  const cornersTransparent = c0.a === 0 && c1.a === 0 && c2.a === 0 && c3.a === 0
  const edgeTransparent = edgeTop.a === 0
  const centerOpaque = center.a > 200

  if (!cornersTransparent || !edgeTransparent || !centerOpaque) problems += 1

  console.log(
    size.toString().padStart(3) + 'px  ' +
    '四角A=' + [c0.a, c1.a, c2.a, c3.a].join('/') + ' ' +
    (cornersTransparent ? '✓透明' : '✗不透明') + '   ' +
    '上边A=' + edgeTop.a + ' ' + (edgeTransparent ? '✓' : '✗') + '   ' +
    '中心 rgba(' + center.r + ',' + center.g + ',' + center.b + ') A=' + center.a +
    (centerOpaque ? ' ✓' : ' ✗')
  )
}

console.log('\n中心像素应是硬币的蓝色/黄色而非白；若为白色说明抠图误伤了画面主体。')
console.log(problems === 0 ? '全部通过' : problems + ' 个尺寸有问题')
process.exitCode = problems === 0 ? 0 : 1
