/**
 * Grab the v1.5.3 quick editor in a chosen theme, and measure what the theme does to it.
 *
 * Dark is the default and is what the README shows, but the new pending-row editor must be
 * readable in both. `SW_THEME` picks which one (default `light`) and the screenshot is named
 * after it.
 *
 *   node tools/shots-light-v153.cjs              # light
 *   $env:SW_THEME='dark'; node tools/shots-light-v153.cjs
 */
const http = require('node:http')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')

const PORT = Number(process.env.CDP_PORT ?? 9222)
const OUT_DIR = join(__dirname, '..', 'docs', 'images')
const RECEIPT = process.env.SW_RECEIPT ?? ''
const WANTED = process.env.SW_THEME ?? 'light'

const getJson = (target) =>
  new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: PORT, path: target }, (res) => {
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
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', () => reject(new Error('ws failed')))
  })

  let id = 0
  const call = (method, params = {}, timeoutMs = 30000) =>
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
    const { data } = await call('Page.captureScreenshot', { format: 'png' }, 60000)
    writeFileSync(join(OUT_DIR, name + '.png'), Buffer.from(data, 'base64'))
    console.log(`-> docs/images/${name}.png`)
  }

  const typeInto = async (selector, value) => {
    const outcome = await evaluate(`(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      if (!input) return 'not found: ' + ${JSON.stringify(selector)};
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return 'ok';
    })()`)
    if (outcome !== 'ok') throw new Error(outcome)
    await sleep(120)
  }

  const clickText = async (selector, text) => {
    await evaluate(`(() => {
      const button = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
        .find((el) => el.textContent.trim().includes(${JSON.stringify(text)}));
      if (button) button.click();
      return 'ok';
    })()`)
    await sleep(400)
  }

  await call('Page.bringToFront')
  await call('Runtime.enable')

  /* Leave nothing from an earlier run open. */
  await evaluate(`(() => {
    for (const dialog of Array.from(document.querySelectorAll('[role="dialog"]'))) {
      const close = dialog.querySelector('.tx-dialog__head button, .ocr-head button, .dt-head button')
      if (close) close.click()
    }
    return 'cleared';
  })()`)
  await sleep(400)

  /*
    Flip the theme through the app's OWN control, not through the settings channel.

    Writing `settingsUpdate({ theme: 'light' })` straight to the API changes the stored value and
    leaves the open window exactly as it was: the theme lives in the renderer store, which only
    reloads settings when the app asks it to. That produced a screenshot labelled "light" that was
    the dark theme, which is worse than no screenshot.
  */
  const themeNow = () => evaluate(`(async () => (await window.api.settingsGet()).theme)()`)
  const previous = await themeNow()
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if ((await themeNow()) === WANTED) break
    await evaluate(`(() => {
      const button = Array.from(document.querySelectorAll('header button'))
        .find((el) => /^主题/.test(el.getAttribute('aria-label') || ''));
      if (button) button.click();
      return 'toggled';
    })()`)
    await sleep(700)
  }
  const active = await themeNow()
  const painted = await evaluate(`getComputedStyle(document.body).backgroundColor`)
  console.log(`theme ${previous} -> ${active} (body background ${painted})`)
  if (active !== WANTED) throw new Error(`the app never reached the ${WANTED} theme`)

  await evaluate(`(() => {
    const home = Array.from(document.querySelectorAll('.sw-shell__nav-link, nav a, aside a')).find((el) => /总览|Overview/.test(el.textContent));
    if (home) home.click();
    return 'home';
  })()`)
  await sleep(800)

  const account = await evaluate(`(async () => {
    const list = await window.api.accountsList();
    const accounts = Array.isArray(list) ? list : (list && list.data) || [];
    const cny = accounts.find((item) => item.currency === 'CNY') ?? accounts[0];
    return cny ? { id: cny.id, currency: cny.currency } : null;
  })()`)

  await clickText('.sw-shell__add', '')
  /* The shell button is a plain click handler; give it a second chance rather than typing into a
     dialog that never opened. */
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await sleep(400)
    if (await evaluate(`document.querySelector('#tx-amount') !== null`)) break
    await clickText('.sw-shell__add', '')
  }
  if (!(await evaluate(`document.querySelector('#tx-amount') !== null`))) {
    throw new Error('the add-transaction dialog did not open')
  }

  /*
    Pin the form to 支出 and report what is actually on screen.

    A screenshot script has no business testing how the dialog opens, but it does need a known
    starting state: an earlier run of this script typed into a form whose kind was not the one it
    assumed and failed with "not found: #tx-merchant", which says nothing about why. Clicking the
    tab is idempotent, and the printed state turns the next such failure into a fact.
  */
  const state = await evaluate(`(() => {
    const tab = Array.from(document.querySelectorAll('.tx-kinds .tx-kind')).find((el) => el.textContent.trim() === '支出');
    if (tab) tab.click();
    return {
      title: document.querySelector('#tx-dialog-title')?.textContent?.trim() ?? null,
      kinds: Array.from(document.querySelectorAll('.tx-kinds .tx-kind')).map((el) => el.textContent.trim() + (el.classList.contains('is-active') ? '*' : '')),
      inputs: Array.from(document.querySelectorAll('.tx-form input, .tx-form select, .tx-form textarea')).map((el) => el.id || el.className)
    };
  })()`)
  console.log(`      dialog "${state.title}", kinds [${state.kinds.join(' ')}], fields [${state.inputs.join(' ')}]`)
  await sleep(300)
  if (account) {
    await evaluate(`(() => {
      const select = document.querySelector('#tx-account');
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(select, ${JSON.stringify(String(account.id))});
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return 'ok';
    })()`)
  }
  await sleep(200)

  for (const row of [
    { amount: '12.50', merchant: 'Lunch', time: '12:14' },
    { amount: '4.80', merchant: 'Coffee', time: '15:30' }
  ]) {
    await typeInto('#tx-amount', row.amount)
    await typeInto('#tx-merchant', row.merchant)
    await typeInto('#tx-time', row.time)
    await clickText('.tx-dialog__foot button', '再记一笔')
  }

  /* One hand-typed row and one recognised row, so both the editor and the currency chip show. */
  if (RECEIPT) {
    await clickText('.tx-dialog__foot button', '识别账单照片')
    await sleep(600)
    await evaluate(`(() => {
      const overlay = document.querySelector('.ocr-overlay');
      const dataTransfer = new DataTransfer();
      const file = new File([new Uint8Array([1])], 'receipt.png', { type: 'image/png' });
      Object.defineProperty(file, 'path', { value: ${JSON.stringify(RECEIPT)} });
      dataTransfer.items.add(file);
      overlay.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
      return 'dropped';
    })()`)
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await sleep(500)
      if ((await evaluate(`document.querySelectorAll('.ocr-cand').length`)) > 0) break
    }
    await clickText('.ocr-dialog button', '填入')
  }

  /* Open the recognised row if there is one, otherwise the second hand-typed row. */
  await evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll('.tx-batch__row'));
    const target = rows.find((row) => row.querySelector('.tx-batch__source')) ?? rows[1] ?? rows[0];
    target.querySelector('.tx-batch__open').click();
    return 'opened';
  })()`)
  await sleep(400)
  /* What the light theme must not do is render the warning chip or the editor unreadable. */
  const contrast = await evaluate(`(() => {
    const parse = (value) => (value.match(/[\\d.]+/g) || []).slice(0, 3).map(Number);
    const luminance = (rgb) => {
      const [r, g, b] = rgb.map((channel) => {
        const c = channel / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a, b) => {
      const [hi, lo] = [luminance(parse(a)), luminance(parse(b))].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    const behind = (el) => {
      /*
        Walk up to the first OPAQUE background.

        Stopping at the element's own translucent tint — the warning chip's 12% wash — made the
        measured contrast 1:1, because the thing being measured against was the text colour
        itself. Alpha below 1 is not a backdrop.
      */
      let node = el;
      while (node) {
        const colour = getComputedStyle(node).backgroundColor;
        const parts = (colour.match(/[\\d.]+/g) || []).map(Number);
        const alpha = parts.length > 3 ? parts[3] : 1;
        if (parts.length >= 3 && alpha >= 0.999) return colour;
        node = node.parentElement;
      }
      return getComputedStyle(document.body).backgroundColor;
    };
    const report = {};
    for (const [key, selector] of [
      ['row', '.tx-batch__rowmain'],
      ['title', '.tx-batch__title'],
      ['meta', '.tx-batch__meta'],
      ['chip', '.tx-batch__fx'],
      ['warn', '.tx-batch__warn'],
      ['label', '.tx-batch__editor .field-label'],
      ['amount', '.tx-batch__editamount']
    ]) {
      const el = document.querySelector(selector);
      if (!el) { report[key] = null; continue; }
      const style = getComputedStyle(el);
      report[key] = {
        colour: style.color,
        on: behind(el),
        ratio: Math.round(ratio(style.color, behind(el)) * 100) / 100
      };
    }
    return report;
  })()`)
  for (const [key, value] of Object.entries(contrast)) {
    if (value === null) console.log(`      ${key}: not on screen`)
    else console.log(`      ${key}: ${value.colour} on ${value.on} = ${value.ratio}:1`)
  }

  await shot(`v153-${WANTED}`)

  /* Put the theme back the way it was found, through the same control. */
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if ((await themeNow()) === previous) break
    await evaluate(`(() => {
      const button = Array.from(document.querySelectorAll('header button'))
        .find((el) => /^主题/.test(el.getAttribute('aria-label') || ''));
      if (button) button.click();
      return 'toggled';
    })()`)
    await sleep(700)
  }
  await evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('.tx-dialog__foot button')).find((b) => /取消/.test(b.textContent));
    if (button) button.click();
    return 'closed';
  })()`)
  await sleep(400)

  console.log(`theme restored to ${await themeNow()}`)
  ws.close()
}

main().catch((error) => {
  console.error('FAILED:', error.message)
  process.exit(1)
})
