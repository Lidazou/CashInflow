/**
 * Screenshot the sample ledger (v1.7.0): the banner, the chart badge, and the sample's own
 * dashboard. Run against an app already switched to the sample.
 *
 *   node tools/shots-sample.cjs
 */
const http = require('node:http')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')

const PORT = Number(process.env.CDP_PORT ?? 9222)
const OUT_DIR = join(__dirname, '..', 'docs', 'images')

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  const target = (await getJson('/json/list')).find((entry) => entry.type === 'page')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve) => ws.addEventListener('open', resolve))

  let id = 0
  const call = (method, params = {}, timeoutMs = 60000) =>
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
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
    if (result.exceptionDetails) throw new Error('eval: ' + (result.exceptionDetails.exception?.description ?? 'unknown'))
    return result.result.value
  }

  const shot = async (name) => {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const { data } = await call('Page.captureScreenshot', { format: 'png' }, 60000)
        writeFileSync(join(OUT_DIR, name + '.png'), Buffer.from(data, 'base64'))
        console.log(`-> docs/images/${name}.png`)
        return
      } catch (error) {
        if (attempt === 2) console.log(`   !! screenshot failed: ${error.message}`)
        else await sleep(1200)
      }
    }
  }

  await call('Page.bringToFront')
  await call('Runtime.enable')

  await evaluate(`(async () => window.api.ledgerSwitch('sample'))()`)
  await sleep(2000)

  /* Dashboard, scrolled to the chart card so the badge and the panels are both visible. */
  await evaluate(`(() => {
    const home = Array.from(document.querySelectorAll('.sw-shell__nav-link, nav a, aside a')).find((el) => /总览|Overview/.test(el.textContent));
    if (home) home.click();
    return 'home';
  })()`)
  await sleep(1800)
  await evaluate(`window.scrollTo(0, 150)`)
  await sleep(300)
  await shot('v170-sample-dashboard')

  /* The settings section that switches ledgers. */
  await evaluate(`(() => {
    const settings = Array.from(document.querySelectorAll('.sw-shell__nav-link, nav a, aside a')).find((el) => /设置|Settings/.test(el.textContent));
    if (settings) settings.click();
    return 'settings';
  })()`)
  await sleep(1500)
  const scrolled = await evaluate(`(() => {
    const heading = document.getElementById('set-demo-title');
    if (!heading) return 'no section';
    heading.scrollIntoView({ block: 'center' });
    return 'scrolled';
  })()`)
  await sleep(500)
  console.log('settings section:', scrolled)
  await shot('v170-sample-settings')

  /* A month in the sample: the statistics page, which shows rent + allowance patterns. */
  await evaluate(`(() => {
    const stats = Array.from(document.querySelectorAll('.sw-shell__nav-link, nav a, aside a')).find((el) => /统计分析|Statistics/.test(el.textContent));
    if (stats) stats.click();
    return 'stats';
  })()`)
  await sleep(1800)
  await shot('v170-sample-statistics')

  await evaluate(`(async () => window.api.ledgerSwitch('real'))()`)
  await sleep(1000)
  ws.close()
}

main().catch((error) => {
  console.error('FAILED:', error.message)
  process.exit(1)
})
