/**
 * Screenshot runner for docs/images/*.png.
 *
 * Opens one CDP connection, drives the app through each view, and writes a PNG per
 * step. One connection for the whole run because a single long-lived socket
 * proves far more reliable here than a fresh connection per shot — repeated
 * connects against the same target stalled after the sixth one.
 *
 * PREREQUISITES
 *   A running app with a debugging port AND a throwaway profile, so screenshots
 *   never depend on, or disturb, the user's real ledger:
 *
 *     $env:CASHINFLOW_WINDOW_WIDTH="1920"
 *     $env:CASHINFLOW_WINDOW_HEIGHT="1080"
 *     electron.exe . --remote-debugging-port=9222 --user-data-dir=<temp profile>
 *
 * The wide window is required: the dashboard's three-column layout only appears
 * above ~1440 CSS pixels.
 *
 * Usage: node tools/shots.cjs [name ...]      (no names = all)
 */
const http = require('node:http')
const { writeFileSync, mkdirSync } = require('node:fs')
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

/**
 * Each step is a browser-side async function returning a short description.
 *
 * Kept as source strings evaluated in the page rather than as DOM-driving from
 * Node, because the page already knows its own selectors and can await its own
 * React state instead of guessing at delays.
 */
const STEPS = [
  {
    name: 'dashboard',
    settle: 2000,
    body: `async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const nav = (label) => {
        const link = Array.from(document.querySelectorAll('a, button'))
          .find((el) => el.textContent.trim() === label);
        if (!link) throw new Error('nav item not found: ' + label);
        link.click();
      };
      nav('总览');
      await sleep(1200);
      const modes = Array.from(document.querySelectorAll('.sw-dash__mode'));
      const cycle = modes.find((b) => b.textContent.trim() === '结算周期');
      if (cycle) cycle.click();
      await sleep(1500);
      return 'dashboard ' + (document.querySelector('.sw-dash__month-label')?.innerText ?? '');
    }`
  },
  {
    name: 'dashboard-natural',
    settle: 1800,
    body: `async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const natural = Array.from(document.querySelectorAll('.sw-dash__mode'))
        .find((b) => b.textContent.trim() === '自然月');
      if (!natural) throw new Error('自然月 toggle missing');
      natural.click();
      await sleep(1500);
      return 'natural month: ' + (document.querySelector('.sw-dash__month-label')?.innerText ?? '');
    }`
  },
  {
    name: 'dashboard-custom',
    settle: 1800,
    body: `async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const custom = Array.from(document.querySelectorAll('.sw-dash__mode'))
        .find((b) => b.textContent.trim() === '自定义区间');
      if (!custom) throw new Error('自定义区间 toggle missing');
      custom.click();
      await sleep(1500);
      const summary = document.querySelector('.sw-dash__range-summary');
      if (summary && summary.getAttribute('aria-expanded') !== 'true') {
        summary.click();
        await sleep(600);
      }
      return 'custom range: ' + (summary?.innerText.replace(/\\n/g, ' ') ?? '');
    }`
  },
  {
    name: 'statistics',
    settle: 2600,
    body: `async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const link = Array.from(document.querySelectorAll('a, button'))
        .find((el) => el.textContent.trim() === '统计分析');
      if (!link) throw new Error('统计分析 nav missing');
      link.click();
      await sleep(2400);
      return 'statistics';
    }`
  },
  {
    name: 'accounts',
    settle: 2400,
    body: `async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const link = Array.from(document.querySelectorAll('a, button'))
        .find((el) => el.textContent.trim() === '账户');
      if (!link) throw new Error('账户 nav missing');
      link.click();
      await sleep(2000);
      return 'accounts';
    }`
  },
  {
    name: 'custom-period',
    settle: 3000,
    body: `async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const link = Array.from(document.querySelectorAll('a, button'))
        .find((el) => el.textContent.trim() === '自定义区间');
      if (!link) throw new Error('自定义区间 nav missing');
      link.click();
      await sleep(2600);
      return 'custom period page';
    }`
  },
  {
    name: 'settings',
    settle: 2400,
    body: `async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const link = Array.from(document.querySelectorAll('a, button'))
        .find((el) => el.textContent.trim() === '设置');
      if (!link) throw new Error('设置 nav missing');
      link.click();
      await sleep(2000);
      // Scroll to the settlement-cycle block: it is the setting that changes what
      // every other screen means, so it is the one worth showing.
      const heading = Array.from(document.querySelectorAll('h2, h3, label, p, span'))
        .find((el) => el.textContent.trim() === '结算周期');
      const block = heading?.closest('section, .card, div');
      if (block) {
        block.scrollIntoView({ block: 'center' });
        await sleep(900);
        return 'settings @ 结算周期';
      }
      return 'settings (结算周期 block not found)';
    }`
  },
  {
    name: 'add-transaction',
    settle: 2600,
    body: `async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const waitFor = async (probe, label, timeoutMs = 9000) => {
        const started = Date.now();
        for (;;) {
          const value = probe();
          if (value) return value;
          if (Date.now() - started > timeoutMs) throw new Error('timeout waiting for ' + label);
          await sleep(150);
        }
      };
      const setNative = (el, value) => {
        const proto = el instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : el instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const nav = Array.from(document.querySelectorAll('a, button'))
        .find((el) => el.textContent.trim() === '总览');
      if (nav) nav.click();
      await sleep(1000);
      const trigger = Array.from(document.querySelectorAll('button'))
        .find((b) => (b.getAttribute('aria-label') ?? '').includes('记一笔'));
      if (!trigger) throw new Error('记一笔 trigger missing');
      trigger.click();
      const dialog = await waitFor(() => document.querySelector('[role="dialog"]'), 'dialog');
      const amount = await waitFor(() => dialog.querySelector('#tx-amount'), 'amount field');
      setNative(amount, '288.00');
      const account = await waitFor(() => {
        const el = dialog.querySelector('#tx-account');
        return el && el.options.length > 1 ? el : null;
      }, 'account options');
      setNative(account, account.options[1].value);
      await sleep(400);
      const category = await waitFor(() => {
        const el = dialog.querySelector('#tx-category');
        return el && el.options.length > 1 ? el : null;
      }, 'category options');
      setNative(category, category.options[1].value);
      const merchant = dialog.querySelector('#tx-merchant');
      if (merchant) setNative(merchant, '海底捞火锅');
      return 'dialog filled';
    }`
  },
  {
    name: 'dashboard-dark',
    settle: 2400,
    body: `async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      // Close any open dialog first, then switch theme from the header toggle.
      const close = document.querySelector('[role="dialog"] button[aria-label]');
      if (close) close.click();
      await sleep(300);
      const nav = Array.from(document.querySelectorAll('a, button'))
        .find((el) => el.textContent.trim() === '总览');
      if (nav) nav.click();
      await sleep(900);
      const toggle = Array.from(document.querySelectorAll('button'))
        .find((b) => (b.getAttribute('aria-label') ?? '').includes('主题'));
      if (toggle) toggle.click();
      await sleep(1400);
      return 'dark: ' + document.documentElement.className;
    }`
  },
  {
    name: 'dashboard-myr',
    settle: 2400,
    body: `async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      // Back to the default settlement cycle, and out of any custom range, so the
      // MYR shot is directly comparable with the CNY one.
      const cycle = Array.from(document.querySelectorAll('.sw-dash__mode'))
        .find((b) => b.textContent.trim() === '结算周期');
      if (cycle) cycle.click();
      await sleep(1200);
      const select = document.querySelector('.sw-currency-bar select');
      if (!select) throw new Error('currency switcher missing');
      const myr = Array.from(select.options).find((o) => o.value === 'MYR');
      if (!myr) throw new Error('MYR option missing');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'MYR');
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(2200);
      return 'display currency MYR';
    }`
  }
]

async function main() {
  const wanted = process.argv.slice(2)
  const steps = wanted.length > 0 ? STEPS.filter((step) => wanted.includes(step.name)) : STEPS
  if (steps.length === 0) throw new Error('no matching steps: ' + wanted.join(', '))

  const target = (await getJson('/json/list')).find((t) => t.type === 'page')
  if (!target) throw new Error('no page target on port ' + PORT + ' — is the app running?')

  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', () => reject(new Error('websocket failed')))
  })

  let id = 0
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const myId = ++id
      const timer = setTimeout(() => reject(new Error(method + ' timed out')), 40000)
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
    const result = await call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? 'evaluation failed')
    }
    return result.result.value
  }

  // The viewport is never overridden: synthesising a larger one makes the capture
  // surface exceed the real window and Page.captureScreenshot then times out.
  await call('Page.bringToFront')
  mkdirSync(OUT_DIR, { recursive: true })

  for (const step of steps) {
    const note = await evaluate(`(${step.body})()`)
    await sleep(step.settle)
    const { data } = await call('Page.captureScreenshot', { format: 'png' })
    const buffer = Buffer.from(data, 'base64')
    writeFileSync(join(OUT_DIR, step.name + '.png'), buffer)
    console.log(
      `  ${step.name}.png  ${Math.round(buffer.length / 1024)} KB` + (note ? `   [${note}]` : '')
    )
  }

  ws.close()
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error('FAILED:', error.message)
    process.exit(1)
  }
)
