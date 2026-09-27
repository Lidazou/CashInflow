/**
 * CDP verification driver for the v1.5.1 K-line.
 *
 * Drives the REAL running app over the DevTools protocol: real pointer moves, real wheel
 * events, real clicks, and reads the result — the DOM where it is DOM, and the chart's own
 * frame where it is canvas.
 *
 *   node tools/verify-kline.cjs
 *
 * Requires the app running with --remote-debugging-port=9222 and a throwaway profile, and
 * the v1.5.1 fixture seeded (a Maybank account in MYR with the spec's day of transactions).
 */
const http = require('node:http')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')

const PORT = Number(process.env.CDP_PORT ?? 9222)
const OUT_DIR = join(__dirname, '..', 'docs', 'images')

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

/** The scroll offset of whatever on the page actually scrolls. */
const scrollTopProbe = `(() => {
  const candidates = [document.scrollingElement, document.documentElement, document.body,
    ...document.querySelectorAll('.sw-shell__main, main')].filter(Boolean);
  return candidates.reduce((sum, el) => sum + (el.scrollTop || 0), 0);
})()`

let failures = 0
let checks = 0

function report(name, ok, detail) {
  checks += 1
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '\n        ' + detail : ''}`)
}

async function main() {
  const target = (await getJson('/json/list')).find((t) => t.type === 'page')
  if (!target) throw new Error('no page target on port ' + PORT)

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

  const shot = async (name) => {
    // A rasteriser that has just been asked to redraw several hundred times can take a while to
    // produce a surface; one retry is cheaper than losing the image.
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const { data } = await call('Page.captureScreenshot', { format: 'png' }, 60000)
        writeFileSync(join(OUT_DIR, name + '.png'), Buffer.from(data, 'base64'))
        console.log(`      -> docs/images/${name}.png`)
        return
      } catch (error) {
        if (attempt === 2) console.log(`      !! screenshot ${name} failed: ${error.message}`)
        else await sleep(1500)
      }
    }
  }

  const frame = () =>
    evaluate(`(() => {
      const f = window.__cfcFrame;
      if (!f) return null;
      return {
        zoom: f.zoomLabel,
        gran: f.granularity,
        viewport: [f.viewport.from, f.viewport.to],
        geometry: f.geometry,
        balance: { min: f.balance.min, max: f.balance.max, step: f.balance.step, ticks: f.balance.ticks },
        activity: { min: f.activity.min, max: f.activity.max, step: f.activity.step },
        candles: f.candles.map((c) => ({ x: Math.round(c.x), o: Math.round(c.yOpen), c: Math.round(c.yClose), hi: Math.round(c.yHigh), lo: Math.round(c.yLow) })),
        markers: f.markers.map((m) => ({
          id: m.marker.transactionId,
          x: Math.round(m.x),
          /* The drawn position, which differs from x only for coincident entries. */
          drawX: Math.round(m.drawX),
          y: Math.round(m.y),
          name: m.marker.merchant,
          t: m.marker.time,
          /* The amount in the LEDGER's currency: the display figure is converted. */
          amount: m.marker.amount,
          currency: m.marker.currency,
          amt: m.marker.convertedDelta
        })),
        hover: f.hover ? { x: Math.round(f.hover.crossX), y: Math.round(f.hover.py), marker: f.hover.marker ? f.hover.marker.marker.merchant : null, value: f.hover.value } : null
      };
    })()`)

  /**
   * A pointer move, as a real DOM event.
   *
   * `Input.dispatchMouseEvent` is unusable in this environment — every call takes five seconds
   * and a wheel call times out entirely, so a sweep of a few hundred positions cannot finish.
   * A synthesised `pointermove` reaches the same React handler (React delegates pointer events
   * at the root) with the same coordinates and returns immediately, which makes the checks
   * about the CHART's response rather than about the harness's patience.
   */
  const move = async (x, y) => {
    await evaluate(`(() => {
      const panel = document.querySelector('.cfc__panel--balance');
      if (!panel) return 'no panel';
      panel.dispatchEvent(new PointerEvent('pointermove', {
        clientX: ${Math.round(x)}, clientY: ${Math.round(y)}, bubbles: true, cancelable: true,
        pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 0
      }));
      return 'ok';
    })()`)
    await sleep(70)
  }

  /** A press and release, as real DOM events. */
  const click = async (x, y) => {
    await move(x, y)
    await evaluate(`(() => {
      const panel = document.querySelector('.cfc__panel--balance');
      if (!panel) return 'no panel';
      const init = {
        clientX: ${Math.round(x)}, clientY: ${Math.round(y)}, bubbles: true, cancelable: true,
        pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1
      };
      panel.dispatchEvent(new PointerEvent('pointerdown', init));
      panel.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, init, { buttons: 0 })));
      return 'ok';
    })()`)
    await sleep(700)
  }

  /**
   * A wheel gesture over a point.
   *
   * `Input.dispatchMouseEvent` with `mouseWheel` is not delivered to this renderer at all — a
   * counter installed on the panel sees zero events — so the gesture is synthesised. It is
   * still the app's own listener that receives it, with a real `deltaY` and real coordinates,
   * and it reports whether the handler called `preventDefault`. A synthetic event is
   * cancelable, so a `preventDefault` inside a NON-PASSIVE listener sets `defaultPrevented` —
   * which is precisely the property that stops a real wheel from scrolling the page, and it
   * is false for a listener React attached passively.
   */
  const wheel = async (x, y, deltaY, times = 1, selector = '.cfc__panel--balance') => {
    const outcome = await evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return { dispatched: 0, prevented: 0, reason: 'no ' + ${JSON.stringify(selector)} };
      let prevented = 0;
      for (let i = 0; i < ${times}; i += 1) {
        const event = new WheelEvent('wheel', {
          deltaY: ${deltaY}, deltaMode: 0, clientX: ${Math.round(x)}, clientY: ${Math.round(y)},
          bubbles: true, cancelable: true
        });
        node.dispatchEvent(event);
        if (event.defaultPrevented) prevented += 1;
      }
      return { dispatched: ${times}, prevented };
    })()`)
    await sleep(280)
    return outcome
  }

  await call('Page.bringToFront')
  await call('Runtime.enable')

  /* A drawer left open by an earlier run would sit over the chart in every screenshot. */
  await evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"], .dialog, .drawer, .sw-drawer');
    if (!dialog) return 'no dialog';
    const close = Array.from(dialog.querySelectorAll('button')).find((b) => /关闭|Close/.test(b.textContent));
    if (close) { close.click(); return 'closed'; }
    return 'no close button';
  })()`)
  await sleep(500)

  /* ------------------------------------------------------------------ */
  /* 0. open the K-line and price it in MYR                              */
  /* ------------------------------------------------------------------ */
  const openKline = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    if (document.querySelector('.cfc__canvas')) return 'already open';
    const nav = Array.from(document.querySelectorAll('nav a, aside a, .sw-shell__navlink, [role="tab"]'));
    const overview = nav.find((el) => /总览|Overview/.test(el.textContent));
    if (overview) { overview.click(); await sleep(600); }
    for (let i = 0; i < 40; i += 1) {
      const toggle = document.querySelector('.sw-dash__viewtoggle');
      if (toggle) { toggle.click(); await sleep(600); }
      if (document.querySelector('.cfc__canvas')) return 'open';
      await sleep(250);
    }
    return 'NOT open';
  })()`)
  report('the K-line view opens', openKline === 'open' || openKline === 'already open', openKline)

  const currency = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const select = document.querySelector('.currency-switcher select, select');
    if (!select) return 'no currency select';
    select.value = 'MYR';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(1200);
    return select.value;
  })()`)
  report('the display currency can be set to MYR', currency === 'MYR', `select -> ${currency}`)
  await sleep(1200)

  /* ------------------------------------------------------------------ */
  /* 1. two independent panels sharing one x scale                        */
  /* ------------------------------------------------------------------ */
  const layout = await evaluate(`(() => {
    const balance = document.querySelector('.cfc__panel--balance');
    const activity = document.querySelector('.cfc__panel--activity');
    const divider = document.querySelector('.cfc__divider');
    const canvases = Array.from(document.querySelectorAll('.cfc__canvas'));
    if (!balance || !activity || !divider || canvases.length !== 2) return { ok: false, canvases: canvases.length };
    const b = balance.getBoundingClientRect();
    const a = activity.getBoundingClientRect();
    const d = divider.getBoundingClientRect();
    const total = b.height + a.height + d.height;
    return {
      ok: true, balanceH: Math.round(b.height), activityH: Math.round(a.height),
      dividerH: Math.round(d.height), share: Math.round((b.height / total) * 100),
      separated: Math.round(b.bottom) <= Math.round(a.top),
      panelLeft: Math.round(b.left), panelRight: Math.round(b.right),
      activityLeft: Math.round(a.left), activityRight: Math.round(a.right)
    };
  })()`)
  report('two separate panel boxes, each with its own canvas', layout.ok === true, JSON.stringify(layout))
  report('they are stacked without overlapping', layout.separated === true)
  report('the balance panel takes 65-80% of the chart height', layout.share >= 65 && layout.share <= 80, `${layout.share}%  (${layout.balanceH}px / ${layout.activityH}px)`)
  report('the activity panel is at least 110px tall', layout.activityH >= 110, `${layout.activityH}px`)
  report('the divider is a hairline', layout.dividerH === 1, `${layout.dividerH}px`)
  report(
    'the two panels share one horizontal extent',
    layout.panelLeft === layout.activityLeft && layout.panelRight === layout.activityRight,
    `balance ${layout.panelLeft}..${layout.panelRight}  activity ${layout.activityLeft}..${layout.activityRight}`
  )

  /* ------------------------------------------------------------------ */
  /* 2. the wheel zooms without scrolling the page                        */
  /* ------------------------------------------------------------------ */
  const box = await evaluate(`(() => {
    const r = document.querySelector('.cfc__panel--balance').getBoundingClientRect();
    return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
  })()`)
  const centre = { x: box.left + box.width / 2, y: box.top + box.height / 2 }

  /*
    Start from everything, so the first wheel notch has somewhere to go. The zoom-out clamp
    would otherwise absorb it and the gesture under test would never happen.
  */
  const goAll = async () => {
    await evaluate(`(async () => {
      const b = Array.from(document.querySelectorAll('.kl__range')).find((x) => x.textContent.trim() === '全部');
      if (b) b.click();
      await new Promise((r) => setTimeout(r, 900));
    })()`)
  }
  await goAll()

  const scrollBefore = await evaluate(scrollTopProbe)
  /*
    Close in first, so the row below has somewhere to zoom TO. Starting from the widest window
    and scrolling up would prove nothing, because the zoom-out clamp would swallow both events.
  */
  await wheel(centre.x, centre.y, -120, 8)
  await move(centre.x, centre.y)
  const zoomBefore = (await frame()).zoom
  const overChart = await wheel(centre.x, centre.y, -120, 4)
  const zoomAfter = (await frame()).zoom
  const scrollAfter = await evaluate(scrollTopProbe)
  report(
    'wheel over the chart is CANCELLED, so the page cannot scroll',
    overChart.dispatched > 0 && overChart.prevented === overChart.dispatched,
    `${overChart.prevented}/${overChart.dispatched} events had defaultPrevented set (a passive listener could never set it)`
  )
  report('the wheel over the chart does NOT scroll the page', scrollBefore === scrollAfter, `scrollTop ${scrollBefore} -> ${scrollAfter}`)
  report('the wheel over the chart DOES zoom', zoomBefore !== zoomAfter, `${zoomBefore} -> ${zoomAfter}`)

  const outside = await evaluate(`(() => {
    /*
      A real element on the page that is not the chart.

      Picked by NAME rather than by coordinate arithmetic: the navigation rail is always there
      and never inside the chart, so the check cannot silently degrade into "no node found" —
      which is exactly how the first version of this step failed while looking like it passed.
    */
    const nav = document.querySelector('.sw-shell__navlink, nav a, aside a');
    if (!nav) return { x: 0, y: 0, hit: null, missing: true };
    const r = nav.getBoundingClientRect();
    return {
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      hit: (nav.className || nav.tagName) + ''
    };
  })()`)
  const outsideWheel = await wheel(outside.x, outside.y, 240, 1, '.sw-shell__navlink, nav a, aside a')
  report(
    'wheel OUTSIDE the chart is NOT cancelled, so the page keeps scrolling',
    !outside.missing && outsideWheel.dispatched > 0 && outsideWheel.prevented === 0,
    outside.missing
      ? 'no navigation element to aim at'
      : `${outsideWheel.prevented}/${outsideWheel.dispatched} over the nav (${outside.hit}), against ${overChart.prevented}/${overChart.dispatched} inside the chart`
  )

  /* ------------------------------------------------------------------ */
  /* 3. cursor-anchored zoom                                              */
  /* ------------------------------------------------------------------ */
  /*
    Zoom in small steps and watch the instant at the cursor.

    The assertion is on the INSTANT rather than on the label, because the label snaps to the
    nearest candle and the candle granularity legitimately changes as the window narrows — a
    crosshair that says "2026-03-29" and later "2026-03" has not moved, it has merely become
    more precise. What must not happen is the anchor walking away from the pointer.
  */
  await evaluate(`(async () => {
    const b = Array.from(document.querySelectorAll('.kl__range')).find((x) => x.textContent.trim() === '3Y');
    if (b) b.click();
    await new Promise((r) => setTimeout(r, 900));
  })()`)

  const anchorX = box.left + box.width * 0.25
  await move(anchorX, centre.y)
  /*
    The instant under the cursor, read as a fraction of the window.

    The chart's own frame carries the viewport in milliseconds, so the anchor's offset from
    the left edge is arithmetic rather than a screenshot measurement.
  */
  const anchorOffset = async () => {
    const now = await frame()
    if (now === null || now.viewport === null || !now.geometry) return null
    const ratio = (anchorX - box.left - now.geometry.plotLeft) / (now.geometry.plotRight - now.geometry.plotLeft)
    return now.viewport[0] + ratio * (now.viewport[1] - now.viewport[0])
  }

  let worstDrift = 0
  let previous = await anchorOffset()
  const startFrame = await frame()
  for (let i = 0; i < 14; i += 1) {
    await wheel(anchorX, centre.y, -120, 1)
    await move(anchorX, centre.y)
    const now = await anchorOffset()
    if (now === null) break
    worstDrift = Math.max(worstDrift, Math.abs(now - previous))
    previous = now
  }
  const endFrame = await frame()
  report(
    'zooming in keeps the SAME INSTANT under the cursor',
    previous !== null && worstDrift < 6 * 3_600_000,
    `${startFrame ? startFrame.zoom : '?'} -> ${endFrame ? endFrame.zoom : '?'}, worst drift between notches ${(worstDrift / 3_600_000).toFixed(1)}h`
  )
  await shot('kline-v151-zoomed')

  /* ------------------------------------------------------------------ */
  /* 4. the X axis changes granularity with the window                    */
  /* ------------------------------------------------------------------ */
  const axisAt = async (label) => {
    const outcome = await evaluate(`(async () => {
      const b = Array.from(document.querySelectorAll('.kl__controls button')).find((x) => x.textContent.trim() === ${JSON.stringify(label)});
      if (!b) return 'no button ' + ${JSON.stringify(label)};
      b.click();
      await new Promise((r) => setTimeout(r, 900));
      const f = window.__cfcFrame;
      return f ? { zoom: f.zoomLabel, gran: f.granularity } : 'no frame';
    })()`)
    await sleep(300)
    return outcome
  }

  const controlLabels = await evaluate(`JSON.stringify(Array.from(document.querySelectorAll('.kl__controls button')).map((b) => b.textContent.trim()))`)
  console.log('      controls: ' + controlLabels)

  const ranges = {}
  for (const label of ['3Y', '1Y', '90D', '30D', '7D', '5D']) {
    ranges[label] = await axisAt(label)
  }
  console.log('      range walk: ' + JSON.stringify(ranges))
  const granules = Object.values(ranges).map((entry) => (entry && entry.gran) || '?')
  report(
    'the candle size follows the window rather than a menu',
    new Set(granules).size >= 2,
    'granularities: ' + granules.join(' -> ')
  )

  const tickLabels = await evaluate(`(() => {
    const f = window.__cfcFrame;
    return f ? { zoom: f.zoomLabel, gran: f.granularity, balanceTicks: f.balance.ticks.length, activityTicks: f.activity.ticks.length } : null;
  })()`)
  report(
    'the value axes keep 4-11 ticks at every window',
    tickLabels.balanceTicks >= 4 && tickLabels.balanceTicks <= 11 && tickLabels.activityTicks >= 4 && tickLabels.activityTicks <= 11,
    JSON.stringify(tickLabels)
  )

  /* ------------------------------------------------------------------ */
  /* 5. the micro-transaction fixture                                     */
  /* ------------------------------------------------------------------ */
  /*
    Wrap the fixture day with the custom range, then zoom with the wheel.

    The custom range is what puts 25 September 2026 on screen; the wheel is what then narrows
    towards the day itself. Doing it this way exercises the version's real path — the reader
    picks a span and then scrolls into it — rather than poking the viewport directly.
  */
  const wrap = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const custom = Array.from(document.querySelectorAll('.kl__range')).find((b) => b.textContent.trim() === '自定义');
    if (custom) { custom.click(); await sleep(400); }
    const inputs = Array.from(document.querySelectorAll('.kl__custom input[type="date"]'));
    if (inputs.length < 2) return 'no date inputs';
    const setValue = (input, value) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    setValue(inputs[0], '2026-09-18');
    setValue(inputs[1], '2026-10-02');
    await sleep(200);
    const apply = Array.from(document.querySelectorAll('.kl__custom button')).find((b) => /应用/.test(b.textContent));
    if (!apply) return 'no apply button';
    apply.click();
    await sleep(1000);
    const f = window.__cfcFrame;
    return f ? f.zoomLabel + ' / ' + f.granularity : 'no frame';
  })()`)
  console.log('      custom range -> ' + JSON.stringify(wrap))

  await wheel(box.left + box.width * 0.5, centre.y, -120, 3)
  let microFrame = await frame()
  console.log(
    '      after zooming in -> ' +
      (microFrame ? `${microFrame.zoom} / ${microFrame.gran}, ${microFrame.markers.length} markers, candles ${microFrame.candles.length}` : 'no frame')
  )

  /*
    Aim at each marker the chart knows about, rather than sweeping the whole plot.

    The frame lists every marker's true pixel position, so the pointer can be driven straight
    at them — which is also the honest test of the hit radius: the driver is aiming at the
    DATA, exactly as a reader aims at what they can see, and the chart has to resolve it.
  */
  const aimed = (microFrame ? microFrame.markers : []).map((marker) => ({
    id: marker.id,
    /* Aim at where the hairline is DRAWN: that is what a reader points at. */
    x: box.left + (marker.drawX === undefined ? marker.x : marker.drawX),
    y: box.top + marker.y,
    name: marker.name,
    time: marker.t,
    amount: marker.amount,
    currency: marker.currency
  }))
  console.log(
    '      markers to aim at: ' +
      (microFrame ? microFrame.markers : [])
        .map((m) => `${m.t} ${m.name} x=${m.x} drawX=${m.drawX} dx=${m.drawX - m.x} y=${m.y}`)
        .join('\n        ')
  )

  const found = []
  for (const target of aimed) {
    for (const [dx, dy] of [[0, 0], [0, 2], [1, 1], [-1, -1], [0, 4]]) {
      await move(target.x + dx, target.y + dy)
      const card = await evaluate(`(() => {
        const el = document.querySelector('.kl__card');
        const title = el?.querySelector('.kl__card-title');
        const amount = el?.querySelector('.kl__card-amount');
        if (!title || !amount) return null;
        return {
          title: title.textContent.trim(),
          amount: amount.textContent.trim(),
          time: el.querySelector('.kl__card-head .num')?.textContent?.trim() ?? null,
          before: Array.from(el.querySelectorAll('.kl__card-rows dd')).map((d) => d.textContent.trim())
        };
      })()`)
      if (card && card.title === target.name) {
        found.push(Object.assign({ aimed: target.id }, card))
        break
      }
    }
  }
  console.log(
    '      aimed at ' + aimed.length + ' markers; tooltips returned:\n        ' +
      found.map((f) => `${f.time} ${f.title} ${f.amount}`).join('\n        ')
  )

  const wanted = ['0.50', '1.20', '4.80', '6.50', '8.00', '32.00', '120.00']
  const amounts = found.map((f) => f.amount)
  const missing = wanted.filter((w) => !amounts.some((a) => a.includes(w)))
  report(
    'every micro-transaction in the fixture is reachable by pointer',
    missing.length === 0,
    missing.length === 0
      ? `${found.length} of ${aimed.length} markers resolved to a tooltip, all seven amounts present`
      : `missing: ${missing.join(', ')}  (saw: ${amounts.join(' | ')})`
  )

  /* Close the drawer helper, so the shots after the click are not taken through a modal. */
  const closeDrawer = async () => {
    await evaluate(`(() => {
      const dialog = document.querySelector('[role="dialog"], .dialog, .drawer, .sw-drawer');
      if (!dialog) return 'none';
      const close = Array.from(dialog.querySelectorAll('button')).find((b) => /关闭|Close/.test(b.textContent));
      if (close) { close.click(); return 'closed'; }
      return 'no close button';
    })()`)
    await sleep(500)
  }

  /* ------------------------------------------------------------------ */
  /* 6. click the SMALLEST transaction -> the detail drawer               */
  /* ------------------------------------------------------------------ */
  /*
    Deliberately the RM 0.50 entry rather than whichever marker comes first.

    This is the version's headline claim, stated as a gesture: the smallest amount in the
    fixture, an hour into a day, opened by pointing at the line it produced. A check that
    clicked an arbitrary marker would pass on a chart that could not do this at all.
  */
  const smallest = (microFrame ? microFrame.markers : []).reduce(
    (best, marker) => {
      /*
        Ranked by the transaction's OWN amount, not by its converted delta.

        The marker carries both, and they are in different currencies — the ledger is in MYR
        and the display currency is CNY — so ranking on the converted figure picks the wrong
        entry from the same ordering.
      */
      const magnitude = Math.abs(marker.amount ?? 0)
      if (!(magnitude > 0)) return best
      return magnitude < best.magnitude ? { magnitude, marker } : best
    },
    { magnitude: Number.POSITIVE_INFINITY, marker: null }
  ).marker

  let opened = null
  if (smallest) {
    const target = { x: box.left + smallest.x, y: box.top + smallest.y }
    for (const [dx, dy] of [[0, 0], [0, 1], [1, 0], [-1, 0], [0, -1], [2, 2], [-2, -2]]) {
      await move(target.x + dx, target.y + dy)
      const hovered = await evaluate(`(() => {
        const f = window.__cfcFrame;
        const el = document.querySelector('.kl__card-amount');
        return { marker: !!(f && f.hover && f.hover.marker), amount: el ? el.textContent.trim() : null };
      })()`)
      if (!hovered.marker) continue
      await click(target.x + dx, target.y + dy)
      await sleep(300)
      opened = await evaluate(`(() => {
        const dialog = document.querySelector('[role="dialog"], .dialog, .drawer, .sw-drawer');
        return dialog ? dialog.innerText.replace(/\\s+/g, ' ').trim().slice(0, 200) : null;
      })()`)
      if (opened) break
    }
  }

  report(
    'clicking the RM 0.50 transaction opens the detail view',
    opened !== null,
    opened
      ? `${smallest ? smallest.name + ' ' + smallest.t : '(no marker)'} -> ${opened}`
      : `no dialog after aiming at the smallest marker (${smallest ? smallest.name + ' ' + smallest.t : 'none found'})`
  )
  if (opened) await shot('kline-v151-detail')
  await closeDrawer()
  await shot('kline-v151-micro')

  console.log(`\n${checks - failures}/${checks} checks passed`)
  ws.close()
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('FAILED:', error.message)
  process.exit(1)
})
