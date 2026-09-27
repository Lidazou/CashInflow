/**
 * CDP verification for v1.5.2: batch entry, edit entry points, receipt OCR.
 *
 * Drives the running app over the DevTools protocol and reads the result out of the DOM. Every
 * check exists because the corresponding feature can look finished and not be.
 *
 *   node tools/verify-v152.cjs
 *
 * Requires the app running with --remote-debugging-port and CASHINFLOW_DATA_DIR set to a
 * throwaway directory (see tools/seed-v151.cjs).
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

  const shot = async (name) => {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const { data } = await call('Page.captureScreenshot', { format: 'png' }, 60000)
        writeFileSync(join(OUT_DIR, name + '.png'), Buffer.from(data, 'base64'))
        console.log(`      -> docs/images/${name}.png`)
        return
      } catch (error) {
        if (attempt === 2) console.log(`      !! screenshot failed: ${error.message}`)
        else await sleep(1200)
      }
    }
  }

  /** Click an element by text, as the app's own control. */
  const clickText = async (selector, text) => {
    const outcome = await evaluate(`(() => {
      const button = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
        .find((el) => el.textContent.trim().includes(${JSON.stringify(text)}));
      if (!button) return 'not found';
      button.click();
      return 'clicked';
    })()`)
    await sleep(400)
    return outcome
  }

  /** Type into a React-controlled input by its native setter. */
  const typeInto = async (selector, value) => {
    const outcome = await evaluate(`(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      if (!input) return 'not found';
      const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return 'ok';
    })()`)
    await sleep(120)
    return outcome
  }

  const setSelect = async (selector, value) => {
    const outcome = await evaluate(`(() => {
      const select = document.querySelector(${JSON.stringify(selector)});
      if (!select) return 'not found';
      const option = Array.from(select.options).find((o) => o.value === ${JSON.stringify(String(value))});
      if (!option) return 'no such option: ' + ${JSON.stringify(String(value))} + ' of ' + Array.from(select.options).map((o) => o.value).join(',');
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(select, ${JSON.stringify(String(value))});
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return 'ok';
    })()`)
    await sleep(150)
    return outcome
  }

  await call('Page.bringToFront')
  await call('Runtime.enable')

  /*
    Close anything left open by an earlier run.

    Scoped to the dialogs' own close buttons. An earlier version matched any button whose text
    contained 取消 or 关闭, which also matched controls on the page behind and navigated the app
    somewhere unexpected before the checks even started.
  */
  await evaluate(`(() => {
    for (const dialog of Array.from(document.querySelectorAll('[role="dialog"]'))) {
      const close = dialog.querySelector('button[aria-label], .tx-dialog__head button, .ocr-head button, .dt-head button')
      if (close) close.click()
    }
    return 'cleared'
  })()`)
  await sleep(400)

  /* ------------------------------------------------------------------ */
  /* 1. the OCR service answers                                          */
  /* ------------------------------------------------------------------ */
  const status = await evaluate(`window.api.ocrStatus()`)
  report('the OCR engine reports its availability', status !== null && typeof status.available === 'boolean', JSON.stringify(status))
  report('it is available in this build', status.available === true, status.reason ?? '')

  /* ------------------------------------------------------------------ */
  /* 2. batch entry                                                      */
  /* ------------------------------------------------------------------ */
  /* Get back to the dashboard first: the add button lives in the shell, and the checks below
     assume a known starting page rather than whatever the last run left behind. */
  await evaluate(`(() => {
    const home = Array.from(document.querySelectorAll('.sw-shell__nav-link, nav a, aside a')).find((el) => /总览|Overview/.test(el.textContent));
    if (home) home.click();
    return 'home';
  })()`)
  await sleep(900)

  const opened = await clickText('.sw-shell__add', '')
  report('the add-transaction dialog opens', opened === 'clicked', opened)
  await sleep(400)

  const hasBatch = await evaluate(`(() => {
    const buttons = Array.from(document.querySelectorAll('.tx-dialog button')).map((b) => b.textContent.trim());
    return { buttons, hasPlus: document.querySelector('.tx-batch-add') !== null };
  })()`)
  report('the dialog offers a "+ 再记一笔" button', hasBatch.hasPlus === true, hasBatch.buttons.join(' | '))

  /* Pick an account, then file three rows. */
  const account = await evaluate(`(async () => {
    const accounts = await window.api.accountsList();
    const list = Array.isArray(accounts) ? accounts : (accounts && accounts.data) || [];
    return list.length > 0 ? { id: list[0].id, name: list[0].name, currency: list[0].currency } : null;
  })()`)
  report('there is an account to file against', account !== null, account ? account.name + ' ' + account.currency : 'none')

  if (account) {
    console.log('      set account ->', await setSelect('#tx-account', account.id))

    const rows = [
      { amount: '12.50', merchant: 'Lunch', time: '12:14' },
      { amount: '4.80', merchant: 'Coffee', time: '15:30' },
      { amount: '120.00', merchant: 'Groceries', time: '19:05' }
    ]
    for (const row of rows) {
      await typeInto('#tx-amount', row.amount)
      await typeInto('#tx-merchant', row.merchant)
      await typeInto('#tx-time', row.time)
      const filed = await clickText('.tx-dialog button', '再记一笔')
      if (filed !== 'clicked') report(`filed "${row.merchant}"`, false, filed)
    }

    const pending = await evaluate(`(() => {
      const list = Array.from(document.querySelectorAll('.tx-batch__row'));
      return {
        count: list.length,
        rows: list.map((row) => row.innerText.replace(/\\s+/g, ' ').trim()),
        total: document.querySelector('.tx-batch__total b')?.textContent?.trim() ?? null,
        badge: document.querySelector('.tx-batch-badge')?.textContent?.trim() ?? null,
        saveAll: Array.from(document.querySelectorAll('.tx-dialog button')).map((b) => b.textContent.trim()).find((t) => t.includes('全部保存')) ?? null
      };
    })()`)
    report(
      'three rows are held in the pending list',
      pending.count === 3,
      `${pending.count} rows, badge "${pending.badge}", total ${pending.total}, button "${pending.saveAll}"\n        ${pending.rows.join('\n        ')}`
    )
    report('the pending rows show a running total', pending.total !== null && pending.total.length > 0, pending.total ?? 'none')
    await shot('v152-batch')

    /* Removing one must not disturb the others. */
    const removed = await evaluate(`(() => {
      const buttons = Array.from(document.querySelectorAll('.tx-batch__row button'));
      if (buttons.length === 0) return 'no remove button';
      buttons[0].click();
      return 'clicked';
    })()`)
    await sleep(300)
    const afterRemove = await evaluate(`document.querySelectorAll('.tx-batch__row').length`)
    report('a row can be removed from the list', removed === 'clicked' && afterRemove === 2, `now ${afterRemove} rows`)

    /* Save them, and confirm they reached the ledger. */
    const before = await evaluate(`(async () => {
      const page = await window.api.transactionsList({ limit: 1 });
      const data = page && page.data ? page.data : page;
      return data && typeof data.total === 'number' ? data.total : (data.items ? data.items.length : 0);
    })()`)

    const saved = await clickText('.tx-dialog button', '全部保存')
    await sleep(1600)
    const after = await evaluate(`(async () => {
      const page = await window.api.transactionsList({ limit: 1 });
      const data = page && page.data ? page.data : page;
      return data && typeof data.total === 'number' ? data.total : (data.items ? data.items.length : 0);
    })()`)
    const dialogGone = await evaluate(`document.querySelector('.tx-dialog') === null`)
    report(
      'saving the batch writes every pending row and closes the dialog',
      saved === 'clicked' && after === before + 2 && dialogGone,
      `transactions ${before} -> ${after} (expected +2), dialog closed: ${dialogGone}`
    )
  }

  /* ------------------------------------------------------------------ */
  /* 3. edit entry points                                                */
  /* ------------------------------------------------------------------ */
  const editFromList = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const nav = Array.from(document.querySelectorAll('.sw-shell__nav-link, nav a, aside a'));
    const link = nav.find((el) => /交易明细|Transactions/.test(el.textContent));
    if (!link) return 'no transactions link';
    link.click();
    await sleep(900);
    return 'opened list';
  })()`)
  await sleep(700)

  const listEdit = await evaluate(`(() => {
    /* The edit control is the one with EDIT in its accessible name, never the delete one. */
    const buttons = Array.from(document.querySelectorAll('.txp__rowEdit, button[aria-label^="编辑"], button[title^="编辑"]'));
    const edit = buttons[0];
    return {
      found: !!edit,
      label: edit ? (edit.getAttribute('title') || edit.getAttribute('aria-label')) : null,
      count: buttons.length,
      /* Is it actually painted, or only present in the DOM? A control nobody can see is not an
         entry point, which is exactly how this feature was reported missing. */
      visible: edit ? getComputedStyle(edit).opacity !== '0' : false
    };
  })()`)
  report(
    'a transaction row offers a VISIBLE edit entry point',
    listEdit.found === true && listEdit.visible === true,
    `${listEdit.count} rows, "${listEdit.label}", opacity not zero: ${listEdit.visible}`
  )

  if (listEdit.found) {
    /*
      The id of the row being edited, read off the row itself.

      `data-tx-id` is on the list item, so the edit button's own row identifies the transaction.
      Querying the API for "the newest row" instead was wrong twice over: the list is ordered by
      date, and the first row on screen need not be the newest by date OR the newest by id.
    */
    const targetId = await evaluate(`(() => {
      const row = document.querySelector('.txp__row[data-tx-id]');
      const id = row ? Number(row.getAttribute('data-tx-id')) : null;
      const amountText = row ? row.textContent.trim().slice(0, 80) : null;
      return { id, amountText };
    })()`)
    console.log('      editing row ' + JSON.stringify(targetId))

    await evaluate(`(() => {
      const edit = document.querySelector('.txp__rowEdit, button[aria-label^="编辑"], button[title^="编辑"]');
      edit.click();
      return 'clicked';
    })()`)
    await sleep(700)
    const editDialog = await evaluate(`(() => {
      const title = document.querySelector('#tx-dialog-title');
      const amount = document.querySelector('#tx-amount');
      return { title: title ? title.textContent.trim() : null, amount: amount ? amount.value : null, hasKinds: document.querySelector('.tx-kinds') !== null };
    })()`)
    report(
      'it opens the edit form, pre-filled',
      editDialog.title === '编辑交易' && editDialog.amount !== null && editDialog.amount !== '',
      JSON.stringify(editDialog)
    )
    report('the edit form hides the income/expense/transfer switch', editDialog.hasKinds === false, `kinds tab present: ${editDialog.hasKinds}`)
    await shot('v152-edit')

    /* Change the amount and confirm the ledger follows. */
    await typeInto('#tx-amount', '7.77')
    const beforeAmount = editDialog.amount
    const savedEdit = await clickText('.tx-dialog button', '保存修改')
    await sleep(1500)
    const readBack = await evaluate(`(async () => {
      try {
        const row = await window.api.transactionsGet(${targetId.id});
        return { id: row.id, amount: row.amount, merchant: row.merchant };
      } catch (error) {
        return { error: String(error && error.message ? error.message : error) };
      }
    })()`)
    report(
      'saving the edit changes the stored amount',
      savedEdit === 'clicked' && readBack !== null && Math.abs(readBack.amount ?? 0) === 777,
      `row ${targetId.id} was ${beforeAmount}, now ${JSON.stringify(readBack)}`
    )
  }

  /* ------------------------------------------------------------------ */
  /* 4. receipt OCR, end to end                                          */
  /* ------------------------------------------------------------------ */
  const recognize = await evaluate(`(async () => {
    const path = ${JSON.stringify(process.env.SW_RECEIPT ?? '')};
    if (!path) return { skipped: true };
    const started = Date.now();
    const result = await window.api.ocrRecognize(path);
    return { skipped: false, elapsedMs: Date.now() - started, text: result.text, confidence: result.confidence };
  })()`)

  if (recognize.skipped) {
    report('OCR recognises a receipt image', false, 'SW_RECEIPT not set, so no image to read')
  } else {
    report(
      'the main process recognises a receipt image offline',
      typeof recognize.text === 'string' && recognize.text.trim().length > 0,
      `${recognize.elapsedMs}ms, confidence ${recognize.confidence}\n        ${String(recognize.text).split('\n').slice(0, 6).join(' / ')}`
    )
  }

  /* ------------------------------------------------------------------ */
  /* 5. OCR into the batch, through the dialog                           */
  /* ------------------------------------------------------------------ */
  /*
    The whole path a receipt actually takes: open the dialog, drop an image on it, get candidate
    rows, put them in the pending list.

    The drop is synthesised because the file picker is a native dialog that a driver cannot
    operate, and the drop handler is the other real way an image arrives. It is the app's own
    handler that receives it either way.
  */
  if (recognize.skipped) {
    report('a dropped receipt becomes pending rows', false, 'SW_RECEIPT not set')
  } else {
    await evaluate(`(() => {
      const home = Array.from(document.querySelectorAll('.sw-shell__nav-link, nav a, aside a')).find((el) => /总览|Overview/.test(el.textContent));
      if (home) home.click();
      return 'home';
    })()`)
    await sleep(800)
    await clickText('.sw-shell__add', '')
    await sleep(500)
    await setSelect('#tx-account', account ? account.id : '')
    await clickText('.tx-dialog button', '识别账单照片')
    await sleep(600)

    const ocrOpen = await evaluate(`!!document.querySelector('.ocr-dialog')`)
    report('the receipt dialog opens from the entry form', ocrOpen === true, `ocr-dialog present: ${ocrOpen}`)

    if (ocrOpen) {
      const dropped = await evaluate(`(() => {
        const overlay = document.querySelector('.ocr-overlay');
        if (!overlay) return 'no overlay';
        const dataTransfer = new DataTransfer();
        /*
          A real File is not available from a path, so the path is attached the way Electron
          attaches it. This is exactly what the drop handler reads.
        */
        const file = new File([new Uint8Array([1])], 'receipt.png', { type: 'image/png' });
        Object.defineProperty(file, 'path', { value: ${JSON.stringify(process.env.SW_RECEIPT ?? '')} });
        dataTransfer.items.add(file);
        overlay.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
        return 'dropped';
      })()`)
      report('an image can be dropped onto the dialog', dropped === 'dropped', dropped)

      /* Recognition is a child process; give it room without blocking the loop. */
      let candidates = 0
      for (let attempt = 0; attempt < 60; attempt += 1) {
        await sleep(500)
        candidates = await evaluate(`document.querySelectorAll('.ocr-cand').length`)
        if (candidates > 0) break
      }
      const summary = await evaluate(`(() => ({
        candidates: document.querySelectorAll('.ocr-cand').length,
        selected: document.querySelectorAll('.ocr-cand.is-selected').length,
        amounts: Array.from(document.querySelectorAll('.ocr-cand__amount')).map((el) => el.textContent.trim()),
        meta: Array.from(document.querySelectorAll('.ocr-cand__meta')).map((el) => el.textContent.trim()),
        hasRaw: !!document.querySelector('.ocr-raw'),
        failed: document.querySelector('.ocr-error')?.textContent?.trim() ?? null
      }))()`)
      report(
        'the receipt becomes candidate rows with the amount and the date',
        summary.candidates > 0 && summary.amounts.length === summary.candidates,
        `error: ${summary.failed ?? 'none'}\n        ${summary.amounts.join(' | ')}\n        ${summary.meta.join(' | ')}`
      )
      report(
        'exactly one candidate is pre-selected, so the user reviews rather than rubber-stamps',
        summary.selected === 1,
        `${summary.selected} of ${summary.candidates} selected`
      )
      await shot('v152-ocr')

      const applied = await clickText('.ocr-dialog button', '填入')
      const afterApply = await evaluate(`(() => ({
        ocrGone: document.querySelector('.ocr-dialog') === null,
        rows: Array.from(document.querySelectorAll('.tx-batch__row')).map((row) => row.innerText.replace(/\\s+/g, ' ').trim()),
        total: document.querySelector('.tx-batch__total b')?.textContent?.trim() ?? null
      }))()`)
      report(
        'applying the receipt puts it in the pending list',
        applied === 'clicked' && afterApply.ocrGone === true && afterApply.rows.length > 0,
        `${afterApply.rows.length} pending, total ${afterApply.total}\n        ${afterApply.rows.join('\n        ')}`
      )
      await shot('v152-ocr-applied')

      /* Leave the app as it was found. */
      await evaluate(`(() => {
        const button = Array.from(document.querySelectorAll('.tx-dialog button')).find((b) => /取消/.test(b.textContent));
        if (button) button.click();
        return 'closed';
      })()`)
      await sleep(400)
    }
  }

  console.log(`\n${checks - failures}/${checks} checks passed`)
  ws.close()
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('FAILED:', error.message)
  process.exit(1)
})
