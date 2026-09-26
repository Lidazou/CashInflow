/**
 * Probe which CDP screenshot method works against the current window.
 *
 * `Page.captureScreenshot` intermittently times out on this machine even though
 * the page is responsive to `Runtime.evaluate`. This tries the alternatives so the
 * screenshot runner can use one that actually returns pixels.
 *
 * Usage: node tools/probe-capture.cjs
 */
const http = require('node:http')

const getJson = (path) =>
  new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: 9222, path }, (res) => {
        let body = ''
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => resolve(JSON.parse(body)))
      })
      .on('error', reject)
  })

async function main() {
  const target = (await getJson('/json/list')).find((t) => t.type === 'page')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', () => reject(new Error('ws failed')))
  })

  let id = 0
  const call = (method, params = {}, timeoutMs = 12000) =>
    new Promise((resolve, reject) => {
      const myId = ++id
      const timer = setTimeout(() => reject(new Error(method + ' timed out')), timeoutMs)
      const onMessage = (event) => {
        const message = JSON.parse(event.data)
        if (message.id !== myId) return
        ws.removeEventListener('message', onMessage)
        clearTimeout(timer)
        if (message.error) reject(new Error(method + ': ' + JSON.stringify(message.error)))
        else resolve(message.result)
      }
      ws.addEventListener('message', onMessage)
      ws.send(JSON.stringify({ id: myId, method, params }))
    })

  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    return result.result.value
  }

  const metrics = await call('Page.getLayoutMetrics')
  const view = metrics.cssVisualViewport ?? metrics.visualViewport
  console.log('viewport:', JSON.stringify(view))

  const attempts = [
    ['captureScreenshot (default)', 'Page.captureScreenshot', { format: 'png' }],
    ['captureScreenshot fromSurface:false', 'Page.captureScreenshot', { format: 'png', fromSurface: false }],
    [
      'captureScreenshot clip',
      'Page.captureScreenshot',
      {
        format: 'png',
        clip: { x: 0, y: 0, width: Math.floor(view.clientWidth), height: Math.floor(view.clientHeight), scale: 1 }
      }
    ],
    [
      'captureScreenshot beyondViewport',
      'Page.captureScreenshot',
      { format: 'png', captureBeyondViewport: true, fromSurface: true }
    ]
  ]

  for (const [label, method, params] of attempts) {
    const started = Date.now()
    try {
      const result = await call(method, params)
      const bytes = Buffer.from(result.data, 'base64').length
      console.log(`OK    ${label}  ${Math.round(bytes / 1024)} KB  ${Date.now() - started}ms`)
      break
    } catch (error) {
      console.log(`FAIL  ${label}  ${Date.now() - started}ms  ${error.message}`)
    }
  }

  console.log('page still responsive:', await evaluate('document.querySelectorAll(".card").length + " cards"'))
  ws.close()
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error('FAILED:', error.message)
    process.exit(1)
  }
)
