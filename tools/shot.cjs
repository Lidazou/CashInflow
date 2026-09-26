/**
 * Minimal CDP screenshot harness for regenerating docs/images/*.png.
 *
 * Not part of the product or its build. Kept under tools/ (gitignored) so the
 * README images can be reproduced rather than being unexplainable binaries.
 *
 *   CashInflow.exe --remote-debugging-port=9222
 *   node tools/shot.cjs <name> [settleMs] [setupFile]
 *
 * The setup expression is read from a FILE: passing JavaScript through PowerShell
 * mangles it (the shell rewrites quotes and corrupts non-ASCII, so a selector
 * containing CJK arrives as invalid JavaScript).
 */
const http = require('node:http')
const { writeFileSync, mkdirSync, readFileSync, existsSync } = require('node:fs')
const { join } = require('node:path')

const PORT = Number(process.env.CDP_PORT ?? 9222)
const OUT_DIR = join(__dirname, '..', 'docs', 'images')

function getJson(path) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: PORT, path }, (res) => {
        let d = ''
        res.on('data', (c) => (d += c))
        res.on('end', () => resolve(JSON.parse(d)))
      })
      .on('error', reject)
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const [name, settleArg, setupFile] = process.argv.slice(2)
  const settleMs = Number(settleArg ?? 1500)
  if (!name) throw new Error('usage: node tools/shot.cjs <name> [settleMs] [setupFile]')

  const target = (await getJson('/json/list')).find((t) => t.type === 'page')
  if (!target) throw new Error('no page target on port ' + PORT)

  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r, j) => {
    ws.addEventListener('open', r)
    ws.addEventListener('error', () => j(new Error('ws failed')))
  })

  let id = 0
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const myId = ++id
      const timer = setTimeout(() => reject(new Error(method + ' timed out')), 30000)
      const onMessage = (e) => {
        const m = JSON.parse(e.data)
        if (m.id !== myId) return
        ws.removeEventListener('message', onMessage)
        clearTimeout(timer)
        if (m.error) reject(new Error(method + ': ' + JSON.stringify(m.error)))
        else resolve(m.result)
      }
      ws.addEventListener('message', onMessage)
      ws.send(JSON.stringify({ id: myId, method, params }))
    })

  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true
    })
    if (result.exceptionDetails) {
      throw new Error('eval failed: ' + (result.exceptionDetails.exception?.description ?? 'unknown'))
    }
    return result.result.value
  }

  // The viewport is NEVER overridden. Synthesising a larger one makes the captured
  // surface exceed the real window, and a position:fixed overlay then stalls
  // rasterisation, timing out Page.captureScreenshot.
  await call('Page.bringToFront')

  if (setupFile) {
    if (!existsSync(setupFile)) throw new Error('setup file not found: ' + setupFile)
    const outcome = await evaluate(readFileSync(setupFile, 'utf8').trim())
    if (outcome !== undefined && outcome !== null && outcome !== true) {
      console.log('  setup -> ' + (typeof outcome === 'string' ? outcome : JSON.stringify(outcome)))
    }
  }

  await sleep(settleMs)

  const { data } = await call('Page.captureScreenshot', { format: 'png' })
  mkdirSync(OUT_DIR, { recursive: true })
  const buffer = Buffer.from(data, 'base64')
  writeFileSync(join(OUT_DIR, name + '.png'), buffer)
  console.log('  ' + name + '.png  ' + Math.round(buffer.length / 1024) + ' KB')
  ws.close()
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error('FAILED:', error.message)
    process.exit(1)
  }
)
