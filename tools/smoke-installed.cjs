/**
 * Smoke-test the INSTALLED copy: does it launch, does the ledger load, does its OCR work?
 *
 * Separate from verify-v152.cjs because this one talks to a normally-launched app on its own
 * port and touches the user's real profile — read-only, and it never writes a transaction.
 */
const http = require('node:http')

const PORT = Number(process.env.CDP_PORT ?? 9224)
const receipt = process.env.SW_RECEIPT ?? ''

const getJson = (path) =>
  new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: PORT, path }, (res) => {
        let body = ''
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => resolve(JSON.parse(body)))
      })
      .on('error', reject)
  })

async function main() {
  const target = (await getJson('/json/list')).find((entry) => entry.type === 'page')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve) => ws.addEventListener('open', resolve))

  let id = 0
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const myId = ++id
      const timer = setTimeout(() => reject(new Error(method + ' timed out')), 120000)
      const onMessage = (event) => {
        const message = JSON.parse(event.data)
        if (message.id !== myId) return
        ws.removeEventListener('message', onMessage)
        clearTimeout(timer)
        if (message.error) reject(new Error(JSON.stringify(message.error)))
        else resolve(message.result)
      }
      ws.addEventListener('message', onMessage)
      ws.send(JSON.stringify({ id: myId, method, params }))
    })

  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
    if (result.exceptionDetails) throw new Error('eval: ' + (result.exceptionDetails.exception?.description ?? 'unknown'))
    return result.result.value
  }

  const app = await evaluate(`window.api.appInfo()`)
  console.log('appInfo   :', JSON.stringify(app))

  const accounts = await evaluate(`(async () => {
    const list = await window.api.accountsList();
    const rows = Array.isArray(list) ? list : (list && list.data) || [];
    return rows.map((a) => a.name + ' ' + a.currency);
  })()`)
  console.log('accounts  :', JSON.stringify(accounts))

  const ocr = await evaluate(`window.api.ocrStatus()`)
  console.log('ocrStatus :', JSON.stringify(ocr))

  if (receipt) {
    const outcome = await evaluate(`window.api.ocrRecognize(${JSON.stringify(receipt)})
      .then((r) => ({ ok: true, ms: r.elapsedMs, confidence: r.confidence, first: r.text.split('\\n')[0] }))
      .catch((e) => ({ ok: false, error: String(e && e.message ? e.message : e) }))`)
    console.log('ocrRun    :', JSON.stringify(outcome))
  }

  const buttons = await evaluate(`Array.from(document.querySelectorAll('button')).map((b) => b.textContent.trim()).filter(Boolean).slice(0, 14)`)
  console.log('chrome    :', JSON.stringify(buttons))

  ws.close()
  process.exit(0)
}

main().catch((error) => {
  console.error('FAILED:', error.message)
  process.exit(1)
})
