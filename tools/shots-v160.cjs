/**
 * Screenshot the v1.6.0 chart, and read the frame it is drawing from.
 *
 *   node tools/shots-v160.cjs
 *
 * The chart is canvas, so a screenshot is the only way to SEE it — but the numbers
 * behind it are read from `window.__cfcFrame`, which is what makes the picture
 * checkable rather than merely looked at.
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

  /* Make sure the dashboard is showing the chart, not the donut. */
  await evaluate(`(() => {
    const home = Array.from(document.querySelectorAll('.sw-shell__nav-link, nav a, aside a')).find((el) => /总览|Overview/.test(el.textContent));
    if (home) home.click();
    return 'home';
  })()`)
  await sleep(1200)

  const hasChart = await evaluate(`!!document.querySelector('.cfc')`)
  if (!hasChart) {
    /* The dashboard can be in donut mode; switch to the K-line view. */
    await evaluate(`(() => {
      const button = Array.from(document.querySelectorAll('button')).find((el) => /资金|K ?线|走势/.test(el.textContent));
      if (button) button.click();
      return 'switched';
    })()`)
    await sleep(1200)
  }

  const frame = await evaluate(`(() => {
    const f = window.__cfcFrame;
    if (!f) return null;
    return {
      granularity: f.granularity,
      mode: f.activityMode,
      zoom: f.activityZoom,
      balance: { min: f.balance.min, max: f.balance.max },
      activity: { min: f.activity.min, max: f.activity.max },
      scale: { income: f.activityScale.income, expense: f.activityScale.expense, split: f.activityScale.split, clipped: f.activityScale.clipped },
      zeroY: f.geometry.activityZeroY,
      columns: f.activityColumns.length,
      buckets: f.buckets.length,
      geometry: f.geometry
    };
  })()`)
  console.log('frame:', JSON.stringify(frame, null, 2))

  await shot('v160-chart-stack')

  /* A hover INSIDE the scenario-A day's stack, through the real pointer path. */
  /*
    Park the real cursor first.

    The window is focused, so wherever the OS pointer happens to be sitting is a REAL
    pointermove the moment anything moves — and it overwrites a synthetic hover a tick
    later. That is what produced a "crosshair" screenshot showing the balance panel's
    marker card instead of the stack segment this shot is for.
  */
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4, button: 'none' }, 20000)
  await sleep(150)
  const hovered = await evaluate(`(() => {
    const f = window.__cfcFrame;
    if (!f) return 'no frame';
    const box = document.querySelector('.cfc__panel--activity');
    if (!box) return 'no activity panel';
    const rect = box.getBoundingClientRect();
    const plotLeft = f.geometry.plotLeft;
    const plotRight = f.geometry.plotRight;
    const slot = (plotRight - plotLeft) / f.buckets.length;
    const index = f.buckets.findIndex((b) => b.date === '2026-09-28');
    const x = index >= 0 ? plotLeft + slot * (index + 0.5) : (plotLeft + plotRight) / 2;
    /*
      Inside the day's own expense stack: the bands grow downwards from the baseline, so a
      point 70% of the way down the drawn stack lands in the topmost band. Aiming at the
      middle of the PANEL would sit below a small day's stack and correctly select nothing,
      which is not the picture this shot is for.
    */
    const column = index >= 0 ? f.activityColumns[index] : null;
    const zeroY = f.geometry.activityZeroY;
    const height = f.geometry.activityBottom - zeroY;
    const drawn = column ? (column.totalExpense / f.activityScale.expense) * height : height * 0.3;
    const y = zeroY + Math.max(3, drawn * 0.7);
    box.dispatchEvent(new PointerEvent('pointermove', {
      clientX: rect.left + x, clientY: rect.top + y, bubbles: true, pointerId: 1, pointerType: 'mouse'
    }));
    return JSON.stringify({ index, x: Math.round(x), y: Math.round(y) });
  })()`)
  console.log('hover ->', hovered)
  await sleep(400)

  const cross = await evaluate(`(() => {
    const f = window.__cfcFrame;
    if (!f || !f.crosshair) return null;
    const c = f.crosshair;
    return {
      date: c.date,
      panel: c.panel,
      crossX: Math.round(c.crossX),
      crossY: Math.round(c.crossY),
      value: c.value,
      candleDate: c.candle ? c.candle.bucket.date : null,
      segment: c.segment ? { id: c.segment.transactionId, merchant: c.segment.merchant, amount: c.segment.amount, pct: c.segment.percentage, range: [c.segment.startAmount, c.segment.endAmount] } : null,
      cardText: document.querySelector('.kl__card') ? document.querySelector('.kl__card').innerText.replace(/\\s+/g, ' ').trim() : null
    };
  })()`)
  console.log('crosshair:', JSON.stringify(cross, null, 2))

  /*
    Wait until the CARD agrees with the frame before capturing.

    The card is React state fed by the chart's `onFrame`, so it lands a render after the
    canvas does; capturing immediately once produced a picture whose card described a
    different transaction than the one the log had just read.
  */
  const wanted = cross && cross.segment ? cross.segment.merchant : null
  if (wanted) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const card = await evaluate(`(() => {
        const el = document.querySelector('.kl__card');
        return el ? el.innerText.replace(/\\s+/g, ' ').trim() : '';
      })()`)
      if (typeof card === 'string' && card.includes(wanted)) break
      await sleep(150)
    }
  }
  await shot('v160-crosshair')

  /* The same moment, with the activity axis zoomed in: the small days become readable. */
  await evaluate(`(() => {
    /* Six notches of the activity zoom, the same path the wheel takes. */
    const box = document.querySelector('.cfc__panel--activity');
    const rect = box.getBoundingClientRect();
    for (let i = 0; i < 6; i += 1) {
      box.dispatchEvent(new WheelEvent('wheel', {
        deltaY: -240, clientX: rect.left + 300, clientY: rect.top + 60, bubbles: true, cancelable: true
      }));
    }
    return 'zoomed';
  })()`)
  await sleep(500)
  const zoomed = await evaluate(`(() => {
    const f = window.__cfcFrame;
    return f ? { zoom: f.activityZoom, up: f.activityScale.income, down: f.activityScale.expense, clipped: f.activityScale.clipped } : null;
  })()`)
  console.log('activity zoom ->', JSON.stringify(zoomed))
  await shot('v160-zoom')
  await evaluate(`(() => {
    const button = document.querySelector('.kl__zoombtn--reset');
    if (button) button.click();
    return 'reset';
  })()`)
  await sleep(400)

  /* Every mode, for the record. */
  for (const [mode, label] of [
    ['net', '净现金流'],
    ['incomeExpense', '收入 vs 支出'],
    ['cumulative', '累计净流'],
    ['category', '分类活动']
  ]) {
    await evaluate(`(() => {
      const button = Array.from(document.querySelectorAll('.kl__mode')).find((el) => el.textContent.trim() === ${JSON.stringify(label)});
      if (button) button.click();
      return 'clicked';
    })()`)
    await sleep(700)
    const read = await evaluate(`(() => {
      const f = window.__cfcFrame;
      return f ? { mode: f.activityMode, income: f.activityScale.income, expense: f.activityScale.expense, split: f.activityScale.split, clipped: f.activityScale.clipped } : null;
    })()`)
    console.log(`mode ${mode} ->`, JSON.stringify(read))
    if (mode === 'net' || mode === 'category') await shot(`v160-mode-${mode}`)
  }

  /* Back to the default, and re-hover for a clean final shot. */
  await evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('.kl__mode')).find((el) => el.textContent.trim() === '交易堆叠');
    if (button) button.click();
    return 'clicked';
  })()`)
  await sleep(700)

  ws.close()
}

main().catch((error) => {
  console.error('FAILED:', error.message)
  process.exit(1)
})
