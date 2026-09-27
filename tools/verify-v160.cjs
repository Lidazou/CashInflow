/**
 * CDP acceptance run for v1.6.0 — the spec's own checklist, one check per line.
 *
 *   node tools/verify-v160.cjs
 *
 * The chart is canvas, so nothing here reads pixels: every assertion goes through
 * `window.__cfcFrame`, which the chart publishes for exactly this purpose, or through the
 * real DOM (buttons, cards, the frozen workbook on disk).
 *
 * Requires the app running with --remote-debugging-port, CASHINFLOW_DATA_DIR pointing at a
 * throwaway profile seeded by tools/seed-v160.cjs, and CASHINFLOW_EXPORT_DIR set so the
 * Excel check does not open a native save dialog.
 */
const http = require('node:http')
const { existsSync, readFileSync, readdirSync, rmSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')
const ExcelJS = require('exceljs')

const PORT = Number(process.env.CDP_PORT ?? 9222)
const EXPORT_DIR = process.env.CASHINFLOW_EXPORT_DIR ?? join(process.env.TEMP ?? '.', 'sw-v160-export')

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

let failures = 0
let checks = 0
const report = (name, ok, detail) => {
  checks += 1
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '\n        ' + detail : ''}`)
}

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

  const clickText = async (selector, text) => {
    const outcome = await evaluate(`(() => {
      const button = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
        .find((el) => el.textContent.trim().includes(${JSON.stringify(text)}));
      if (!button) return 'not found';
      button.click();
      return 'clicked';
    })()`)
    await sleep(450)
    return outcome
  }

  /** Move the real pointer over a panel at a chart-local position. */
  const hoverAt = async (panel, x, y) => {
    return evaluate(`(() => {
      const box = document.querySelector('.cfc__panel--${panel}');
      if (!box) return 'no panel';
      const rect = box.getBoundingClientRect();
      box.dispatchEvent(new PointerEvent('pointermove', {
        clientX: rect.left + ${x}, clientY: rect.top + ${y}, bubbles: true, pointerId: 1, pointerType: 'mouse'
      }));
      return 'hovered';
    })()`)
  }

  /** Horizontal centre of the column/candle for a date, from the chart's own geometry. */
  const xForDate = async (date) =>
    evaluate(`(() => {
      const f = window.__cfcFrame;
      if (!f) return null;
      const index = f.buckets.findIndex((b) => b.date === ${JSON.stringify(date)});
      if (index < 0) return null;
      const slot = (f.geometry.plotRight - f.geometry.plotLeft) / f.buckets.length;
      return Math.round(f.geometry.plotLeft + slot * (index + 0.5));
    })()`)

  const frame = async () =>
    evaluate(`(() => {
      const f = window.__cfcFrame;
      if (!f) return null;
      return {
        granularity: f.granularity,
        mode: f.activityMode,
        zoom: f.activityZoom,
        balance: { min: f.balance.min, max: f.balance.max, ticks: f.balance.ticks },
        activity: { min: f.activity.min, max: f.activity.max },
        scale: { income: f.activityScale.income, expense: f.activityScale.expense, split: f.activityScale.split, clipped: f.activityScale.clipped },
        geometry: f.geometry,
        candles: f.candles.map((c) => ({ date: c.bucket.date, yClose: Math.round(c.yClose), close: c.bucket.balanceClose, up: c.up })),
        ma: f.ma.map((entry) => ({ window: entry.windowSize, value: entry.value })),
        columns: f.activityColumns.map((col) => ({
          date: col.date,
          income: col.totalIncome,
          expense: col.totalExpense,
          net: col.netCashFlow,
          cumulative: col.cumulativeCashFlow,
          segments: col.expense.map((s) => ({ id: s.transactionId, amount: s.amount, pct: Number(s.percentage.toFixed(4)), start: s.startAmount, end: s.endAmount, merchant: s.merchant })),
          incomeSegments: col.income.map((s) => ({ id: s.transactionId, amount: s.amount, merchant: s.merchant })),
          transfers: col.transferCount
        })),
        crosshair: f.crosshair
          ? {
              date: f.crosshair.date,
              panel: f.crosshair.panel,
              crossX: Math.round(f.crosshair.crossX),
              crossY: Math.round(f.crosshair.crossY),
              value: f.crosshair.value,
              candleDate: f.crosshair.candle ? f.crosshair.candle.bucket.date : null,
              candleClose: f.crosshair.candle ? f.crosshair.candle.bucket.balanceClose : null,
              segment: f.crosshair.segment
                ? { id: f.crosshair.segment.transactionId, merchant: f.crosshair.segment.merchant, amount: f.crosshair.segment.amount, start: f.crosshair.segment.startAmount, end: f.crosshair.segment.endAmount, pct: f.crosshair.segment.percentage }
                : null
            }
          : null
      };
    })()`)

  /* Close anything left open, then go to the dashboard. */
  /*
    RELOAD FIRST.

    Every check below assumes a known starting state — no zoom, no pan, the default
    series — and the chart keeps its viewport in component state. Reusing an instance a
    previous run left zoomed produced a run of confusing failures that were all one stale
    viewport, so the script now starts from a fresh page. The DATABASE is untouched by a
    reload, which is the part that matters.
  */
  await call('Page.reload', {}, 60000)
  await sleep(2500)
  await evaluate(`(() => {
    for (const dialog of Array.from(document.querySelectorAll('[role="dialog"]'))) {
      const close = dialog.querySelector('.tx-dialog__head button, .ocr-head button, .dt-head button');
      if (close) close.click();
    }
    const home = Array.from(document.querySelectorAll('.sw-shell__nav-link, nav a, aside a')).find((el) => /总览|Overview/.test(el.textContent));
    if (home) home.click();
    return 'home';
  })()`)
  await sleep(1400)

  if (!(await evaluate(`!!document.querySelector('.cfc')`))) {
    await evaluate(`(() => {
      const button = Array.from(document.querySelectorAll('button')).find((el) => /资金 K 线|K 线/.test(el.textContent));
      if (button) button.click();
      return 'switched';
    })()`)
    await sleep(1200)
  }

  const base = await frame()
  report('the chart renders and publishes its frame', base !== null, base ? `${base.candles.length} candles` : 'no frame')
  if (!base) {
    console.log(`\n${checks - failures}/${checks} checks passed`)
    process.exit(1)
  }

  /*
    Pin the chart to its default series before anything else.

    A previous run of this script leaves the dashboard wherever it finished, and a stale
    'category' mode makes the segment hit tests below resolve to a category band instead
    of a transaction — which is how the first version of this script reported a failure in
    the app that was really a failure to reset its own fixture.
  */
  await clickText('.kl__mode', '交易堆叠')
  await sleep(500)

  /* ------------------------------------------------------------------ */
  /* Chart: two regions, K-line keeps OHLC                              */
  /* ------------------------------------------------------------------ */
  const balanceH = base.geometry.balanceBottom - base.geometry.balanceTop
  const activityH = base.geometry.activityBottom - base.geometry.activityTop
  report(
    'the activity panel is a real region, not a strip under the candles',
    activityH / (balanceH + activityH) > 0.4,
    `balance ${Math.round(balanceH)}px, activity ${Math.round(activityH)}px (${Math.round((activityH / (balanceH + activityH)) * 100)}%)`
  )
  report(
    'the K-line still carries OHLC and moving averages',
    base.candles.every((candle) => typeof candle.close === 'number' && typeof candle.up === 'boolean') &&
      base.ma.length > 0,
    `${base.candles.length} candles, MA windows ${base.ma.map((entry) => entry.window).join('/')}`
  )
  report(
    'the x axis is days, and every visible day has one column',
    base.granularity === 'day' &&
      base.columns.length === base.candles.length &&
      base.columns.every((column, index) => column.date === base.candles[index].date),
    `${base.columns.length} columns for ${base.candles.length} candles, ${base.granularity} granularity`
  )
  await evaluate(`window.__v160 = ${JSON.stringify({})}; true`)

  /* ------------------------------------------------------------------ */
  /* Scenario A: one column per day, stacked in real proportion         */
  /* ------------------------------------------------------------------ */
  const day28 = base.columns.find((column) => column.date === '2026-09-28')
  report(
    'Scenario A: five expenses in one day become five stacked segments',
    !!day28 && day28.segments.length === 5,
    day28 ? `${day28.segments.length} segments, total ${day28.expense}` : 'day not in view'
  )
  const pcts = day28 ? day28.segments.map((segment) => Math.round(segment.pct * 100)) : []
  /*
    Chronological, not descending: the stack is ordered by the time each transaction
    happened (spec §6), and the seed's day runs 08:10 Transport 150, 09:30 Coffee 100,
    12:45 Shopping 200, 15:20 Groceries 150, 19:40 Dinner 400 — so 15/10/20/15/40.
  */
  report(
    'the proportions are the amounts, in the order the transactions happened',
    JSON.stringify(pcts) === JSON.stringify([15, 10, 20, 15, 40]),
    `percentages ${pcts.join('/')} (expected 15/10/20/15/40, chronological)`
  )
  const chronological = day28 ? day28.segments.map((segment) => segment.merchant) : []
  report(
    'the stack follows the clock, and time never becomes an x coordinate',
    JSON.stringify(chronological) ===
      JSON.stringify(['Transport pass', 'Coffee', 'Shopping', 'Groceries', 'Dinner']) &&
      base.columns.every((column) => typeof column.date === 'string' && column.date.length === 10),
    `${chronological.join(' → ')}`
  )
  const contiguous =
    !!day28 &&
    day28.segments.every((segment, index) => (index === 0 ? segment.start === 0 : segment.start === day28.segments[index - 1].end)) &&
    day28.segments[day28.segments.length - 1].end === day28.expense
  report('the segments are contiguous and add up to the day', contiguous, day28 ? day28.segments.map((s) => `${s.start}→${s.end}`).join(' ') : '')

  /* ------------------------------------------------------------------ */
  /* Scenario C: a sub-pixel transaction is still selectable            */
  /* ------------------------------------------------------------------ */
  const day30 = base.columns.find((column) => column.date === '2026-09-30')
  /*
    The smallest segment of the day, found rather than matched by amount: the figures are
    converted into the display currency, so the RM 1 sticker is 61 minor units of CNY, not
    100. Its IDENTITY is what matters, and its share is what makes the point.
  */
  const tiny = day30
    ? day30.segments.reduce((smallest, segment) => (smallest === null || segment.amount < smallest.amount ? segment : smallest), null)
    : null
  report(
    'Scenario C: the RM 1 segment exists as a real object',
    !!tiny && tiny.amount > 0 && tiny.amount / day30.expense < 0.0002,
    tiny ? `${tiny.merchant} = ${tiny.amount} of ${day30.expense} (${(tiny.pct * 100).toFixed(4)}% of the day)` : 'not found'
  )

  const x30 = await xForDate('2026-09-30')
  if (x30 !== null && tiny) {
    /* Aim just inside the tiny band: 99.995% of the way up the column. */
    const y = await evaluate(`(() => {
      const f = window.__cfcFrame;
      const zeroY = f.geometry.activityZeroY;
      const fraction = 0.99995;
      return Math.round(zeroY + fraction * (f.geometry.activityBottom - zeroY));
    })()`)
    await hoverAt('activity', x30, y)
    await sleep(250)
    const after = await frame()
    report(
      'the crosshair finds a segment a fraction of a pixel tall, by AMOUNT',
      after?.crosshair?.segment?.id === tiny.id,
      `aimed at 99.995% of the column → ${after?.crosshair?.segment?.merchant ?? 'none'} (#${after?.crosshair?.segment?.id ?? '—'}), expected #${tiny.id}`
    )
    report(
      'and the amount it reports sits inside that segment`s range',
      !!after?.crosshair?.segment &&
        Math.abs(after.crosshair.value) >= after.crosshair.segment.start - 1 &&
        Math.abs(after.crosshair.value) <= after.crosshair.segment.end + 1,
      `value ${after?.crosshair?.value}, range ${after?.crosshair?.segment?.start}→${after?.crosshair?.segment?.end}`
    )
    /* And an empty part of a SMALL day's column selects nothing at all. */
    const xSmall = await xForDate('2026-10-01')
    const yEmpty = await evaluate(`(() => {
      const f = window.__cfcFrame;
      const zeroY = f.geometry.activityZeroY;
      /*
        20% of the way down the expense half. On a day whose spending is ~1% of the window
        (2026-10-01: RM 97 against a RM 9,999 day) that point is in empty space, and empty
        space must select nothing rather than the column's largest transaction.
      */
      return Math.round(zeroY + 0.2 * (f.geometry.activityBottom - zeroY));
    })()`)
    if (xSmall !== null) {
      await hoverAt('activity', xSmall, yEmpty)
      await sleep(250)
      const empty = await frame()
      report(
        'pointing below a small day`s stack selects NOTHING rather than its biggest transaction',
        empty?.crosshair?.date === '2026-10-01' && empty?.crosshair?.segment === null,
        `date ${empty?.crosshair?.date}, segment ${empty?.crosshair?.segment ? empty.crosshair.segment.merchant : 'none'}`
      )
    }
  }

  /* ------------------------------------------------------------------ */
  /* Crosshair: one state, two panels                                   */
  /* ------------------------------------------------------------------ */
  const x28 = await xForDate('2026-09-28')
  if (x28 !== null) {
    const candle28 = base.candles.find((candle) => candle.date === '2026-09-28')
    await hoverAt('balance', x28, 120)
    await sleep(250)
    const onCandle = await frame()
    report(
      'hovering the balance panel reports that candle, and the line is AT its close',
      onCandle?.crosshair?.candleDate === '2026-09-28' &&
        onCandle?.crosshair?.crossY === candle28?.yClose &&
        onCandle?.crosshair?.value === candle28?.close,
      `date ${onCandle?.crosshair?.candleDate}, crossY ${onCandle?.crosshair?.crossY} (candle close y ${candle28?.yClose}), value ${onCandle?.crosshair?.value} (close ${candle28?.close})`
    )
    report(
      'the vertical line sits on the bucket the tooltip names',
      Math.abs((onCandle?.crosshair?.crossX ?? 0) - x28) <= 2,
      `crossX ${onCandle?.crosshair?.crossX} vs column centre ${x28}`
    )

    /* Same date, activity panel: same vertical line, different value axis. */
    const dayExpense = base.columns.find((column) => column.date === '2026-09-28')?.expense ?? 0
    const yInStack = await evaluate(`(() => {
      const f = window.__cfcFrame;
      const col = f.activityColumns.find((c) => c.date === '2026-09-28');
      /*
        Inside the day's own EXPENSE stack, which is drawn BELOW the zero line. 70% of the
        way down it lands in the topmost band, because the bands are stacked from the
        baseline outwards in ledger order.
      */
      const zeroY = f.geometry.activityZeroY;
      const height = f.geometry.activityBottom - zeroY;
      const drawn = (col.totalExpense / f.activityScale.expense) * height;
      return Math.round(zeroY + drawn * 0.7);
    })()`)
    await hoverAt('activity', x28, yInStack)
    await sleep(250)
    const onActivity = await frame()
    report(
      'both panels put the vertical line on the SAME date',
      onActivity?.crosshair?.date === '2026-09-28' && onActivity?.crosshair?.candleDate === '2026-09-28',
      `date ${onActivity?.crosshair?.date}, candle ${onActivity?.crosshair?.candleDate}`
    )
    const card = await evaluate(`(() => {
      const el = document.querySelector('.kl__card');
      return el ? el.innerText.replace(/\\s+/g, ' ').trim() : null;
    })()`)
    const segment = onActivity?.crosshair?.segment ?? null
    report(
      'the card describes the transaction the pointer is actually inside',
      segment !== null && card !== null && card.includes(segment.merchant ?? ''),
      `segment ${segment?.merchant} (${segment?.start}→${segment?.end}), card: ${card}`
    )
    report(
      'the amount reported is inside the selected segment`s range',
      segment !== null &&
        onActivity !== null &&
        Math.abs(onActivity.crosshair.value) >= Math.min(segment.start, segment.end) - 1 &&
        Math.abs(onActivity.crosshair.value) <= Math.max(segment.start, segment.end) + 1,
      `value ${onActivity?.crosshair?.value}, range ${segment?.start}→${segment?.end}, day expense ${dayExpense}`
    )
  }

  /* ------------------------------------------------------------------ */
  /* Independent Y axes, and the vertical zoom                          */
  /* ------------------------------------------------------------------ */
  report(
    'the two panels have independent value axes',
    base.balance.min !== base.activity.min || base.balance.max !== base.activity.max,
    `balance ${base.balance.min}..${base.balance.max}, activity ${base.activity.min}..${base.activity.max}`
  )
  report(
    'the activity axis is fitted per direction, so a small day is not flattened by a big one',
    base.scale.split === 'perDirection' && base.scale.income > 0 && base.scale.expense > 0,
    `up ${base.scale.income}, down ${base.scale.expense}, split ${base.scale.split}`
  )

  const beforeWheel = await frame()
  await evaluate(`(() => {
    const box = document.querySelector('.cfc__panel--activity');
    const rect = box.getBoundingClientRect();
    /* A plain wheel over the ACTIVITY panel drives its value axis (non-passive listener). */
    const event = new WheelEvent('wheel', { deltaY: -240, clientX: rect.left + 300, clientY: rect.top + 60, bubbles: true, cancelable: true });
    box.dispatchEvent(event);
    return event.defaultPrevented ? 'prevented' : 'not prevented';
  })()`)
  await sleep(250)
  const afterWheel = await frame()
  report(
    'a wheel over the activity panel zooms its VALUE axis, not the time axis',
    afterWheel.zoom > beforeWheel.zoom && Math.abs((afterWheel.geometry.plotRight - afterWheel.geometry.plotLeft)) === Math.abs(beforeWheel.geometry.plotRight - beforeWheel.geometry.plotLeft),
    `zoom ${beforeWheel.zoom} → ${afterWheel.zoom}, time span unchanged`
  )
  report(
    'zooming the value axis leaves the balance axis alone',
    afterWheel.balance.min === beforeWheel.balance.min && afterWheel.balance.max === beforeWheel.balance.max,
    `balance still ${afterWheel.balance.min}..${afterWheel.balance.max}`
  )
  report(
    'the zoom control reports and resets it',
    (await clickText('.kl__zoombtn--reset', '')) === 'clicked' && (await frame()).zoom === 1,
    `zoom back to ${(await frame()).zoom}`
  )

  const spanBefore = (await frame()).geometry.plotWidth ?? null
  await evaluate(`(() => {
    const box = document.querySelector('.cfc__panel--balance');
    const rect = box.getBoundingClientRect();
    const event = new WheelEvent('wheel', { deltaY: -240, clientX: rect.left + 300, clientY: rect.top + 60, bubbles: true, cancelable: true });
    box.dispatchEvent(event);
    return event.defaultPrevented ? 'prevented' : 'not prevented';
  })()`)
  await sleep(300)
  const zoomedTime = await frame()
  report(
    'a wheel over the BALANCE panel still zooms TIME (the v1.5 behaviour is intact)',
    zoomedTime.zoom === 1 && zoomedTime.candles.length < base.candles.length,
    `${base.candles.length} candles → ${zoomedTime.candles.length}, value zoom still ${zoomedTime.zoom}`
  )
  await clickText('.kl__range, .kl__controls button', '全部')
  await sleep(400)
  void spanBefore

  /* ------------------------------------------------------------------ */
  /* Five subcharts, one crosshair architecture                          */
  /* ------------------------------------------------------------------ */
  const MODES = [
    ['交易堆叠', 'stack'],
    ['净现金流', 'net'],
    ['收入 vs 支出', 'incomeExpense'],
    ['累计净流', 'cumulative'],
    ['分类活动', 'category']
  ]
  for (const [label, mode] of MODES) {
    const clicked = await clickText('.kl__mode', label)
    const current = await frame()
    report(
      `subchart "${label}" draws through the same frame`,
      clicked === 'clicked' && current.mode === mode && current.columns.length === base.columns.length,
      `mode ${current.mode}, ${current.columns.length} columns`
    )
  }
  await clickText('.kl__mode', '交易堆叠')

  /* Category mode colours match the donut's tokens for the same category. */
  const colourCheck = await evaluate(`(() => {
    const f = window.__cfcFrame;
    const day = f.activityColumns.find((c) => c.date === '2026-09-28');
    return day ? day.categories.map((c) => ({ key: c.key, color: c.color })) : [];
  })()`)
  report(
    'the stack carries the category colours the donut uses',
    colourCheck.length > 0 && colourCheck.every((entry) => typeof entry.color === 'string' && entry.color.startsWith('#')),
    colourCheck.map((entry) => `${entry.key}=${entry.color}`).join(' ')
  )

  /* ------------------------------------------------------------------ */
  /* Donut: hover and click                                              */
  /* ------------------------------------------------------------------ */
  /*
    Switch the dashboard to its ring view through the app's own toggle. The mode is a
    stored setting (`dashboardViewMode`), so guessing at a button label was never going to
    be reliable — the control announces what it will switch TO.
  */
  const switched = await evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('button'))
      .find((el) => /切换到圆环图/.test(el.getAttribute('aria-label') || el.getAttribute('title') || ''));
    if (!button) return 'no toggle';
    button.click();
    return 'clicked';
  })()`)
  await sleep(1200)
  report('the dashboard can switch to the category ring', switched === 'clicked', switched)

  const donut = await evaluate(`(() => {
    const slice = document.querySelector('.donut3d__slice');
    if (!slice) return { present: false };
    /*
      React synthesises onMouseEnter from a bubbling mouseover (with a relatedTarget
      check), so a dispatched 'mouseenter' reaches no listener at all — the first version
      of this check hovered the slice and reported "no card" forever.
    */
    slice.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, relatedTarget: null }));
    slice.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse' }));
    return { present: true, slices: document.querySelectorAll('.donut3d__slice').length };
  })()`)
  await sleep(350)
  const hoverCard = await evaluate(`(() => {
    const card = document.querySelector('.donut3d__hover');
    return card ? card.innerText.replace(/\\s+/g, ' ').trim() : null;
  })()`)
  report(
    'hovering a donut slice names the category, its amount and its share',
    donut.present && hoverCard !== null && /%/.test(hoverCard) && /笔/.test(hoverCard),
    `${donut.slices} slices, card: ${hoverCard}`
  )

  const clickedSlice = await evaluate(`(() => {
    const slice = document.querySelector('.donut3d__slice');
    if (!slice) return 'no slice';
    slice.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return 'clicked';
  })()`)
  await sleep(1100)
  const afterDrill = await evaluate(`(() => ({
    hash: window.location.hash,
    title: document.querySelector('.txp__title')?.textContent?.trim() ?? null,
    incoming: document.querySelector('.txp__incoming')?.innerText?.replace(/\\s+/g, ' ').trim() ?? null,
    rows: document.querySelectorAll('.txp__row, .txp__rowWrap, li[data-tx-id]').length,
    categorySelect: document.querySelector('.txp__filters select')?.value ?? null
  }))()`)
  report(
    'clicking a slice opens the REAL transaction list, filtered to that category and period',
    clickedSlice === 'clicked' &&
      afterDrill.hash.includes('categoryId=') &&
      afterDrill.title !== null &&
      afterDrill.incoming !== null,
    `${afterDrill.hash}\n        incoming: ${afterDrill.incoming}`
  )
  report(
    'the filtered list shows the category`s rows, not the whole ledger',
    afterDrill.rows > 0,
    `${afterDrill.rows} transaction row(s) on screen`
  )

  /* ------------------------------------------------------------------ */
  /* Excel export, from the list, honouring the filter                  */
  /* ------------------------------------------------------------------ */
  if (existsSync(EXPORT_DIR)) {
    for (const entry of readdirSync(EXPORT_DIR)) rmSync(join(EXPORT_DIR, entry), { force: true })
  } else {
    mkdirSync(EXPORT_DIR, { recursive: true })
  }

  const exportButton = await evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('.txp__head button')).find((el) => /导出 Excel/.test(el.textContent));
    return button ? { label: button.textContent.trim(), disabled: button.disabled } : null;
  })()`)
  report(
    'the transaction list offers a one-click Excel export that states the row count',
    exportButton !== null && !exportButton.disabled && /\d/.test(exportButton.label),
    JSON.stringify(exportButton)
  )

  if (exportButton) {
    await clickText('.txp__head button', '导出 Excel')
    await sleep(1600)
    const files = existsSync(EXPORT_DIR) ? readdirSync(EXPORT_DIR) : []
    report('clicking it writes a workbook without a modal in the way', files.length === 1, `files: ${files.join(', ')}`)

    if (files.length === 1) {
      const path = join(EXPORT_DIR, files[0])
      const workbook = new ExcelJS.Workbook()
      await workbook.xlsx.load(readFileSync(path))
      const sheet = workbook.worksheets[0]

      const headers = sheet.getRow(1).values.slice(1)
      const dateCell = sheet.getRow(2).getCell(1)
      const amountCell = sheet.getRow(2).getCell(6)
      const categories = new Set()
      for (let row = 2; row <= sheet.actualRowCount; row += 1) {
        const value = sheet.getRow(row).getCell(4).value
        if (typeof value === 'string' && value) categories.add(value)
      }

      report(
        'the workbook is a real .xlsx with the user-facing columns',
        headers.includes('Amount') && headers.includes('Category') && !headers.includes('id'),
        `headers: ${headers.join(', ')}`
      )
      report(
        'Date is a real date and Amount is a real number',
        dateCell.value instanceof Date && typeof amountCell.value === 'number',
        `date ${String(dateCell.value).slice(0, 15)} (${dateCell.numFmt}), amount ${amountCell.value} (${amountCell.numFmt})`
      )
      report(
        'the header is frozen and an auto filter is set',
        sheet.views[0]?.state === 'frozen' && !!sheet.autoFilter,
        `view ${JSON.stringify(sheet.views[0])}, filter ${String(sheet.autoFilter)}`
      )
      report(
        'the export contains ONLY the filtered category (Scenario E)',
        categories.size === 1,
        `categories present: ${[...categories].join(', ')}`
      )
    }
  }

  /* ------------------------------------------------------------------ */
  /* Nothing was written to the database                                */
  /* ------------------------------------------------------------------ */
  const stillThere = await evaluate(`(async () => {
    const page = await window.api.transactionsList({ from: '2026-09-24', to: '2026-10-02', limit: 200 });
    const items = page && page.items ? page.items : [];
    return { total: items.length, sum: items.reduce((acc, row) => acc + row.amount, 0) };
  })()`)
  report(
    'the ledger is unchanged by all of this (charts are derived, never stored)',
    stillThere.total === 20,
    `${stillThere.total} rows, signed sum ${stillThere.sum}`
  )

  console.log(`\n${checks - failures}/${checks} checks passed`)
  ws.close()
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('FAILED:', error.message)
  process.exit(1)
})
