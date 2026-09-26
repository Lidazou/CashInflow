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
const { writeFileSync, mkdirSync, rmSync, existsSync, statSync } = require('node:fs')
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
 * Browser-side helper source, inlined into every step.
 *
 * `setTheme` drives the header toggle rather than calling `settingsUpdate`
 * directly. The toggle is what a user does, so the screenshots exercise the real
 * path; and an earlier version of this file set the theme through the API and
 * produced a LIGHT "dark mode" screenshot, because the API writes SQLite while
 * `applyTheme` — which paints the document — is reached through the store action
 * that the toggle calls.
 */
const HELPERS = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const byText = (text, selector) =>
    Array.from(document.querySelectorAll(selector)).find((el) => el.textContent.trim() === text);
  /**
   * Scroll the content area back to the top.
   *
   * The steps share one live window, so a page left scrolled (the settings step
   * scrolls to the cycle block, and focusing the currency select scrolls whatever
   * contains it) leaked that scroll offset into the NEXT screenshot — which is how
   * the headline dashboard image ended up with its currency bar half cut off.
   */
  const scrollTop = async () => {
    const scrollers = [document.scrollingElement, document.documentElement, document.body,
      ...document.querySelectorAll('.sw-shell__main, main, [class*="scroll"]')];
    for (const el of scrollers) {
      if (!el) continue;
      try { el.scrollTop = 0; el.scrollTo?.({ top: 0, behavior: 'instant' }); } catch {}
    }
    window.scrollTo(0, 0);
    await sleep(250);
  };
  const nav = (label) => {
    const link = Array.from(document.querySelectorAll('a, button'))
      .find((el) => el.textContent.trim() === label);
    if (!link) throw new Error('nav item not found: ' + label);
    link.click();
  };
  const currentTheme = () => {
    const label = Array.from(document.querySelectorAll('button'))
      .map((b) => b.getAttribute('aria-label') || '')
      .find((t) => t.includes('主题：'));
    if (!label) return null;
    if (label.includes('主题：浅色')) return 'light';
    if (label.includes('主题：深色')) return 'dark';
    return 'system';
  };
  /** Click the header theme toggle until the requested mode is stored. */
  const setTheme = async (want) => {
    const toggle = Array.from(document.querySelectorAll('button'))
      .find((b) => (b.getAttribute('aria-label') || '').includes('主题'));
    if (!toggle) throw new Error('theme toggle missing');
    for (let i = 0; i < 4; i += 1) {
      if (currentTheme() === want) return want;
      toggle.click();
      await sleep(900);
    }
    throw new Error('could not reach theme ' + want + ' (at ' + currentTheme() + ')');
  };
  const setPeriodMode = async (label) => {
    const button = byText(label, '.sw-dash__mode');
    if (!button) throw new Error('period toggle missing: ' + label);
    button.click();
    await sleep(1600);
  };
  /**
   * Set the display currency through the currency bar's own select.
   *
   * Reset explicitly rather than assuming a default: the switcher is persisted, so
   * the dashboard-myr step used to leak MYR into every later run and produced a
   * "CNY" screenshot showing ringgit.
   */
  const setCurrency = async (code) => {
    const select = document.querySelector('.sw-currency-bar select');
    if (!select) throw new Error('currency switcher missing');
    const option = Array.from(select.options).find((o) => o.value === code);
    if (!option) throw new Error('currency option missing: ' + code);
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, code);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(1800);
  };
`

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
      ${HELPERS}
      nav('总览');
      await sleep(1200);
      await setTheme('light');
      await setCurrency('CNY');
      await setPeriodMode('结算周期');
      await scrollTop();
      return 'dashboard ' + (document.querySelector('.sw-dash__month-label')?.innerText ?? '');
    }`
  },
  {
    name: 'dashboard-natural',
    settle: 1800,
    body: `async () => {
      ${HELPERS}
      await setPeriodMode('自然月');
      await scrollTop();
      return 'natural month: ' + (document.querySelector('.sw-dash__month-label')?.innerText ?? '');
    }`
  },
  {
    name: 'dashboard-custom',
    settle: 1800,
    body: `async () => {
      ${HELPERS}
      const pad = (n) => String(n).padStart(2, '0');
      const iso = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());

      // Reset the window to 最近 30 天 before shooting. A range left over from an
      // experiment ("a future month with nothing in it") made an earlier run
      // produce a screenshot of an empty ring, which is not what this image is for.
      const to = new Date();
      const from = new Date(to.getFullYear(), to.getMonth(), to.getDate() - 29);
      await window.api.settingsUpdate({
        dashboardRange: { from: iso(from), to: iso(to), label: null, budgetAmount: null }
      });
      await setPeriodMode('自定义区间');
      await sleep(900);

      const summary = document.querySelector('.sw-dash__range-summary');
      if (summary && summary.getAttribute('aria-expanded') !== 'true') {
        summary.click();
        await sleep(700);
      }
      await scrollTop();
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
      ${HELPERS}
      // Close any open dialog, go home, then drive the real theme toggle.
      const close = document.querySelector('[role="dialog"] button[aria-label]');
      if (close) close.click();
      await sleep(300);
      nav('总览');
      await sleep(900);
      await setTheme('dark');
      await setPeriodMode('结算周期');
      await scrollTop();
      return 'dark: ' + (document.documentElement.className || '(none)');
    }`
  },
  {
    name: 'dashboard-myr',
    settle: 2400,
    body: `async () => {
      ${HELPERS}
      // Back to the default settlement cycle, out of any custom range and in the
      // light theme, so this shot is directly comparable with the CNY one.
      await setTheme('light');
      await setPeriodMode('结算周期');
      await setCurrency('MYR');
      await scrollTop();
      return 'display currency MYR (theme ' + currentTheme() + ')';
    }`
  }
]

/**
 * Open one CDP session against the page target.
 *
 * A session PER SHOT is the default, and that is not an accident. A single
 * long-lived connection reliably stalled on `Page.captureScreenshot` after a few
 * shots — the app stayed responsive and the same capture succeeded immediately on a
 * fresh connection, so the cost (one websocket per screenshot) buys a run that
 * finishes. `--persistent` switches to one connection for the whole run, which is
 * faster when it works.
 */
async function connect() {
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

  return { ws, call, evaluate }
}

async function main() {
  const args = process.argv.slice(2)
  const persistent = args.includes('--persistent')
  const wanted = args.filter((arg) => !arg.startsWith('--'))
  const steps = wanted.length > 0 ? STEPS.filter((step) => wanted.includes(step.name)) : STEPS
  if (steps.length === 0) throw new Error('no matching steps: ' + wanted.join(', '))

  mkdirSync(OUT_DIR, { recursive: true })
  const shared = persistent ? await connect() : null
  if (shared) await shared.call('Page.bringToFront')

  try {
    for (const step of steps) {
      let session = shared ?? (await connect())
      // The viewport is never overridden: synthesising a larger one makes the
      // capture surface exceed the real window and the capture then times out.
      if (!shared) await session.call('Page.bringToFront')

      const note = await session.evaluate(`(${step.body})()`)
      await sleep(step.settle)

      /**
       * Capture, retrying on a FRESH CONNECTION.
       *
       * `Page.captureScreenshot` intermittently times out on this machine while the
       * page stays fully responsive to `Runtime.evaluate`, and the identical call
       * then succeeds on a new websocket. That was measured, not assumed — see
       * `tools/probe-capture.cjs`, which reports the default method succeeding on a
       * fresh session in about a second. The failure therefore lives in the CDP
       * session rather than in the app, so the remedy is to discard the session
       * instead of waiting longer or skipping the shot.
       */
      const outPath = join(OUT_DIR, step.name + '.png')
      let captured = null
      let lastError = null

      for (let attempt = 1; attempt <= 3 && captured === null; attempt += 1) {
        try {
          const result = await session.call('Page.captureScreenshot', { format: 'png' })
          captured = result.data
        } catch (error) {
          lastError = error
          if (shared) break // one connection for the whole run: nothing to reconnect
          try {
            session.ws.close()
          } catch {
            /* already closing */
          }
          await sleep(400 * attempt)
          session = await connect()
          await session.call('Page.bringToFront')
        }
      }

      if (captured === null) {
        throw new Error(
          `capture failed for ${step.name}: ${lastError ? lastError.message : 'no image data'}`
        )
      }

      writeFileSync(outPath, Buffer.from(captured, 'base64'))
      const size = Math.round(statSync(outPath).size / 1024)
      console.log(`  ${step.name}.png  ${size} KB` + (note ? `   [${note}]` : ''))

      if (!shared) session.ws.close()
    }
  } finally {
    shared?.ws.close()
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error('FAILED:', error.message)
    process.exit(1)
  }
)
