/**
 * CDP verification for v1.5.3: a pending row can be opened and edited in place.
 *
 *   node tools/verify-v153.cjs
 *
 * The complaint this exists to answer was "a recognised receipt cannot be edited in the add
 * dialog". So every check below is about the row being a real, reachable control: that it is a
 * button rather than a div that merely accepts a click, that the editor belongs to the row that
 * was clicked and is pre-filled with THAT row's values, that 完成 applies and 取消 discards, and
 * that what finally reaches the ledger is the edited value and not the recognised one.
 *
 * Requires the app running with --remote-debugging-port and CASHINFLOW_DATA_DIR pointing at a
 * throwaway directory (see tools/seed-v151.cjs), plus SW_RECEIPT for the OCR half.
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
      if (!option) return 'no such option: ' + ${JSON.stringify(String(value))};
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(select, ${JSON.stringify(String(value))});
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return 'ok';
    })()`)
    await sleep(150)
    return outcome
  }

  /** Read the pending list as the user sees it. */
  const readList = () =>
    evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll('.tx-batch__row'));
      return rows.map((row) => ({
        text: row.querySelector('.tx-batch__rowmain').innerText.replace(/\\s+/g, ' ').trim(),
        amount: row.querySelector('.tx-batch__amount').innerText.replace(/\\s+/g, ' ').trim(),
        expanded: row.classList.contains('is-expanded'),
        expandedFlag: row.querySelector('.tx-batch__open')?.getAttribute('aria-expanded') ?? null,
        target: row.querySelector('.tx-batch__open')?.getAttribute('aria-label') ?? null,
        fx: row.querySelector('.tx-batch__fx')?.textContent?.trim() ?? null,
        fromOcr: row.querySelector('.tx-batch__source') !== null,
        tag: row.querySelector('.tx-batch__rowmain').firstElementChild.tagName
      }));
    })()`)

  const openRow = async (index) => {
    const outcome = await evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll('.tx-batch__row'));
      const open = rows[${index}]?.querySelector('.tx-batch__open');
      if (!open) return 'row ${index} has no open control';
      open.click();
      return 'clicked';
    })()`)
    await sleep(350)
    return outcome
  }

  const readEditor = () =>
    evaluate(`(() => {
      const row = document.querySelector('.tx-batch__row.is-expanded');
      if (!row) return null;
      const val = (prefix, tag) => {
        const el = row.querySelector((tag || 'input') + '[id^="' + prefix + '"]');
        return el ? el.value : null;
      };
      const selects = Array.from(row.querySelectorAll('select')).map((s) => ({
        id: s.id,
        value: s.value,
        text: s.options[s.selectedIndex] ? s.options[s.selectedIndex].textContent.trim() : null
      }));
      const amountInput = row.querySelector('input[id^="tx-edit-amount-"]');
      const label = amountInput ? (amountInput.closest('.field')?.querySelector('.field-label')?.textContent ?? '').trim() : null;
      return {
        open: !!row.querySelector('.tx-batch__editor'),
        insideRow: !!row.querySelector('.tx-batch__editor'),
        amount: val('tx-edit-amount-'),
        merchant: val('tx-edit-merchant-'),
        note: val('tx-edit-note-'),
        date: val('tx-edit-date-'),
        time: val('tx-edit-time-'),
        selects,
        amountLabel: label,
        kinds: Array.from(row.querySelectorAll('.tx-batch__editkinds .tx-kind')).map((b) => ({
          label: b.textContent.trim(),
          active: b.classList.contains('is-active'),
          pressed: b.getAttribute('aria-pressed')
        })),
        warn: row.querySelector('.tx-batch__warn')?.innerText?.replace(/\\s+/g, ' ').trim() ?? null,
        error: row.querySelector('.field-error')?.textContent?.trim() ?? null,
        ctrlEnterHint: row.querySelector('.tx-batch__editactions')?.innerText?.replace(/\\s+/g, ' ').trim() ?? null
      };
    })()`)

  const inEditor = (prefix, tag) => `.tx-batch__row.is-expanded ${tag ?? 'input'}[id^="${prefix}"]`

  await call('Page.bringToFront')
  await call('Runtime.enable')

  // Close anything an earlier run left open, through the dialogs' own close buttons only.
  await evaluate(`(() => {
    for (const dialog of Array.from(document.querySelectorAll('[role="dialog"]'))) {
      const close = dialog.querySelector('.tx-dialog__head button, .ocr-head button, .dt-head button')
      if (close) close.click()
    }
    return 'cleared'
  })()`)
  await sleep(400)

  await evaluate(`(() => {
    const home = Array.from(document.querySelectorAll('.sw-shell__nav-link, nav a, aside a')).find((el) => /总览|Overview/.test(el.textContent));
    if (home) home.click();
    return 'home';
  })()`)
  await sleep(900)

  /*
    Build the fixture through the app's own API.

    A fresh profile has no accounts and no categories at all, and this check needs two accounts in
    DIFFERENT currencies: the receipt fixture is a Maybank one, so filing it against a CNY account
    is what exercises the currency warning the editor has to show. Picking whichever account
    happened to exist made that path silently skip.
  */
  const account = await evaluate(`(async () => {
    const unwrap = (value) => (Array.isArray(value) ? value : (value && value.data) || []);
    let accounts = unwrap(await window.api.accountsList());
    const ensureAccount = async (name, currency) => {
      const found = accounts.find((item) => item.name === name);
      if (found) return found;
      await window.api.accountsCreate({ name, type: 'bank', currency, openingBalance: 0 });
      accounts = unwrap(await window.api.accountsList());
      return accounts.find((item) => item.name === name) ?? null;
    };
    const home = await ensureAccount('留学', 'CNY');
    await ensureAccount('Maybank', 'MYR');

    let categories = unwrap(await window.api.categoriesList());
    for (const [name, type] of [['餐饮', 'expense'], ['交通', 'expense'], ['工资', 'income']]) {
      if (!categories.some((item) => item.name === name)) {
        await window.api.categoriesCreate({ name, type });
      }
    }
    return home ? { id: home.id, name: home.name, currency: home.currency } : null;
  })()`)
  report('there is an account to file against', account !== null, account ? `${account.name} ${account.currency}` : 'none')
  if (!account) {
    console.log('\n0/1 checks passed')
    process.exit(1)
  }

  await clickText('.sw-shell__add', '')
  await sleep(400)
  console.log('      set account ->', await setSelect('#tx-account', account.id))

  /* ------------------------------------------------------------------ */
  /* 1. every pending row is a real control                              */
  /* ------------------------------------------------------------------ */
  for (const row of [
    { amount: '12.50', merchant: 'Lunch', time: '12:14' },
    { amount: '4.80', merchant: 'Coffee', time: '15:30' }
  ]) {
    await typeInto('#tx-amount', row.amount)
    await typeInto('#tx-merchant', row.merchant)
    await typeInto('#tx-time', row.time)
    await clickText('.tx-dialog__foot button', '再记一笔')
  }

  const list = await readList()
  const totalBefore = await evaluate(`document.querySelector('.tx-batch__total b')?.textContent?.trim() ?? null`)
  report('two rows are held in the pending list', list.length === 2, list.map((row) => row.text).join(' | '))
  report(
    'each pending row exposes an OPEN control that is a real <button>',
    list.length === 2 && list.every((row) => row.tag === 'BUTTON' && row.target),
    JSON.stringify(list.map((row) => ({ tag: row.tag, label: row.target })))
  )

  const affordance = await evaluate(`(() => {
    const open = document.querySelector('.tx-batch__open');
    const caret = open ? open.querySelector('.tx-batch__caret svg') : null;
    const hint = document.querySelector('.tx-batch__hint');
    return {
      cursor: open ? getComputedStyle(open).cursor : null,
      caretPainted: caret ? caret.getBoundingClientRect().width > 0 : false,
      hint: hint ? hint.textContent.trim() : null
    };
  })()`)
  report(
    'the row looks clickable: pointer cursor, a painted caret and a visible hint',
    affordance.cursor === 'pointer' && affordance.caretPainted === true && /点开|点击/.test(affordance.hint ?? ''),
    JSON.stringify(affordance)
  )

  /* ------------------------------------------------------------------ */
  /* 2. clicking a row opens THAT row's editor                           */
  /* ------------------------------------------------------------------ */
  const opened = await openRow(1)
  const editor = await readEditor()
  report(
    'clicking a pending row opens its editor',
    opened === 'clicked' && editor !== null && editor.open === true,
    `${opened}, editor present: ${editor ? editor.open : 'no expanded row'}`
  )
  report(
    'the editor is pre-filled from the row that was clicked, not from the form above',
    editor !== null && editor.amount === '4.80' && editor.merchant === 'Coffee' && editor.time === '15:30',
    JSON.stringify(editor && { amount: editor.amount, merchant: editor.merchant, time: editor.time, date: editor.date })
  )
  const afterOpen = await readList()
  report(
    'only the clicked row is expanded, and it says so',
    afterOpen.filter((row) => row.expanded).length === 1 && afterOpen[1].expandedFlag === 'true' && afterOpen[0].expandedFlag === 'false',
    JSON.stringify(afterOpen.map((row) => row.expandedFlag))
  )
  report(
    'the editor carries the whole row: kind, amount, merchant, category, account, date, time, note',
    editor !== null && editor.kinds.length === 2 && editor.selects.length === 2 && editor.note !== null && editor.date !== null,
    JSON.stringify({ kinds: editor?.kinds.map((k) => k.label + (k.active ? '*' : '')), selects: editor?.selects.map((s) => s.id) })
  )
  await shot('v153-quickedit')

  /* ------------------------------------------------------------------ */
  /* 3. 完成 applies the edit to the row                                  */
  /* ------------------------------------------------------------------ */
  /* The kind switch belongs to the row, and a category belongs to one kind: switching has to
     drop a category that no longer fits, or the main process rejects the row at save time. */
  await evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('.tx-batch__row.is-expanded .tx-batch__editkinds .tx-kind'))
      .find((el) => /收入/.test(el.textContent));
    if (button) button.click();
    return 'switched';
  })()`)
  await sleep(300)
  const afterKind = await readEditor()
  const categorySelect = afterKind ? afterKind.selects.find((select) => select.id.includes('category')) : null
  report(
    'switching a pending row to income drops a category that belongs to expenses',
    afterKind !== null &&
      afterKind.kinds.some((kind) => kind.active && kind.label === '收入') &&
      categorySelect !== null &&
      categorySelect.value === '',
    JSON.stringify({ kinds: afterKind?.kinds, category: categorySelect })
  )
  await evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('.tx-batch__row.is-expanded .tx-batch__editkinds .tx-kind'))
      .find((el) => /支出/.test(el.textContent));
    if (button) button.click();
    return 'switched back';
  })()`)
  await sleep(250)

  const chosenCategory = await evaluate(`(() => {
    const select = document.querySelector('.tx-batch__row.is-expanded select[id^="tx-edit-category-"]');
    if (!select) return null;
    const option = Array.from(select.options).find((entry) => entry.value !== '');
    if (!option) return null;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(select, option.value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return { id: option.value, label: option.textContent.trim() };
  })()`)
  report('the editor can set the row`s category', chosenCategory !== null, JSON.stringify(chosenCategory))

  await typeInto(inEditor('tx-edit-amount-'), '9.99')
  await typeInto(inEditor('tx-edit-merchant-'), 'Coffee & cake')
  await typeInto(inEditor('tx-edit-time-'), '08:05')
  const applied = await clickText('.tx-batch__row.is-expanded .tx-batch__editactions button', '完成')
  const afterApply = await readList()
  report(
    '完成 writes the edit back onto the row',
    applied === 'clicked' &&
      afterApply[1].amount.includes('9.99') &&
      afterApply[1].text.includes('Coffee & cake') &&
      afterApply[1].text.includes('08:05') &&
      afterApply.every((row) => !row.expanded),
    `${afterApply[1].text}\n        editor closed: ${afterApply.every((row) => !row.expanded)}`
  )
  report(
    'the category chosen in the editor is the one the row now carries',
    chosenCategory !== null && afterApply[1].text.includes(chosenCategory.label),
    `expected "${chosenCategory ? chosenCategory.label : 'none'}" in "${afterApply[1].text}"`
  )
  const totalAfter = await evaluate(`document.querySelector('.tx-batch__total b')?.textContent?.trim() ?? null`)
  report(
    'the running total follows the edited row',
    totalAfter !== totalBefore && totalAfter.includes('22.49'),
    `${totalBefore} -> ${totalAfter} (12.50 + 9.99)`
  )

  /* ------------------------------------------------------------------ */
  /* 4. 取消 abandons it                                                 */
  /* ------------------------------------------------------------------ */
  await openRow(1)
  await typeInto(inEditor('tx-edit-amount-'), '111.00')
  await clickText('.tx-batch__row.is-expanded .tx-batch__editactions button', '取消')
  const afterCancel = await readList()
  report(
    '取消 leaves the row exactly as it was',
    afterCancel[1].amount.includes('9.99') && afterCancel.every((row) => !row.expanded),
    afterCancel[1].amount
  )

  await openRow(1)
  await typeInto(inEditor('tx-edit-amount-'), '111.00')
  await evaluate(`(() => {
    const input = document.querySelector('.tx-batch__row.is-expanded input[id^="tx-edit-amount-"]');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    return 'escaped';
  })()`)
  await sleep(300)
  const afterEscape = await evaluate(`(() => ({
    expanded: document.querySelectorAll('.tx-batch__row.is-expanded').length,
    dialog: document.querySelector('.tx-dialog') !== null
  }))()`)
  report(
    'Escape closes the editor first and leaves the dialog open, with the edit abandoned',
    afterEscape.expanded === 0 && afterEscape.dialog === true && (await readList())[1].amount.includes('9.99'),
    JSON.stringify(afterEscape)
  )

  /* ------------------------------------------------------------------ */
  /* 5. it is a keyboard editor, and it validates                        */
  /* ------------------------------------------------------------------ */
  await openRow(1)
  await typeInto(inEditor('tx-edit-amount-'), '3.30')
  await evaluate(`(() => {
    const input = document.querySelector('.tx-batch__row.is-expanded input[id^="tx-edit-amount-"]');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return 'entered';
  })()`)
  await sleep(350)
  const afterEnter = await readList()
  report(
    'Enter applies the edit, so a row is fixable without the mouse',
    afterEnter[1].amount.includes('3.30') && afterEnter.every((row) => !row.expanded),
    afterEnter[1].amount
  )

  await openRow(1)
  await typeInto(inEditor('tx-edit-amount-'), '')
  await clickText('.tx-batch__row.is-expanded .tx-batch__editactions button', '完成')
  const invalid = await readEditor()
  report(
    'an empty amount is refused, with the editor left open to fix it',
    invalid !== null && invalid.error !== null && invalid.open === true,
    `error: ${invalid ? invalid.error : 'editor closed'}`
  )
  await typeInto(inEditor('tx-edit-amount-'), '6.60')
  await clickText('.tx-batch__row.is-expanded .tx-batch__editactions button', '完成')

  /* ------------------------------------------------------------------ */
  /* 6. removing a row still works on its own                            */
  /* ------------------------------------------------------------------ */
  const removed = await evaluate(`(() => {
    const row = document.querySelector('.tx-batch__row');
    const button = Array.from(row.querySelectorAll('button')).find((b) => /移除/.test(b.getAttribute('aria-label') || ''));
    if (!button) return 'no remove button';
    button.click();
    return 'clicked';
  })()`)
  await sleep(300)
  const afterRemove = await readList()
  report(
    'the remove button removes its row without opening an editor',
    removed === 'clicked' && afterRemove.length === 1 && afterRemove.every((row) => !row.expanded),
    `now ${afterRemove.length} row(s): ${afterRemove.map((row) => row.text).join(' | ')}`
  )

  /* ------------------------------------------------------------------ */
  /* 7. what reaches the ledger is the EDITED row                        */
  /* ------------------------------------------------------------------ */
  await clickText('.tx-dialog__foot button', '全部保存')
  await sleep(1600)
  const savedRow = await evaluate(`(async () => {
    const page = await window.api.transactionsList({ orderBy: 'created', orderDir: 'desc', limit: 3 });
    const items = page && page.items ? page.items : (page && page.data ? page.data.items : []);
    return items.map((item) => ({ id: item.id, amount: item.amount, merchant: item.merchant, time: item.time, date: item.date }));
  })()`)
  const coffee = savedRow.find((item) => item.merchant === 'Coffee & cake')
  report(
    'saving the list writes the edited values, not the filed ones',
    !!coffee && Math.abs(coffee.amount) === 660 && coffee.time === '08:05',
    JSON.stringify(savedRow)
  )
  report('the batch dialog closes after saving', (await evaluate(`document.querySelector('.tx-dialog') === null`)) === true, '')

  /* ------------------------------------------------------------------ */
  /* 8. the recognised receipt is editable — the actual complaint        */
  /* ------------------------------------------------------------------ */
  const receipt = process.env.SW_RECEIPT ?? ''
  if (!receipt) {
    report('a recognised receipt can be edited before saving', false, 'SW_RECEIPT not set, so no receipt to recognise')
  } else {
    await evaluate(`(() => {
      const home = Array.from(document.querySelectorAll('.sw-shell__nav-link, nav a, aside a')).find((el) => /总览|Overview/.test(el.textContent));
      if (home) home.click();
      return 'home';
    })()`)
    await sleep(800)
    await clickText('.sw-shell__add', '')
    await sleep(400)
    await setSelect('#tx-account', account.id)
    await clickText('.tx-dialog__foot button', '识别账单照片')
    await sleep(600)

    const dropped = await evaluate(`(() => {
      const overlay = document.querySelector('.ocr-overlay');
      if (!overlay) return 'no overlay';
      const dataTransfer = new DataTransfer();
      const file = new File([new Uint8Array([1])], 'receipt.png', { type: 'image/png' });
      Object.defineProperty(file, 'path', { value: ${JSON.stringify(receipt)} });
      dataTransfer.items.add(file);
      overlay.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
      return 'dropped';
    })()`)
    report('the receipt is dropped onto the dialog', dropped === 'dropped', dropped)

    let candidates = 0
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await sleep(500)
      candidates = await evaluate(`document.querySelectorAll('.ocr-cand').length`)
      if (candidates > 0) break
    }
    const recognised = await evaluate(`(() => ({
      candidates: document.querySelectorAll('.ocr-cand').length,
      amount: document.querySelector('.ocr-cand__amount')?.textContent?.trim() ?? null,
      meta: document.querySelector('.ocr-cand__meta')?.textContent?.trim() ?? null
    }))()`)
    report('the receipt becomes a candidate row', recognised.candidates > 0, JSON.stringify(recognised))

    await clickText('.ocr-dialog button', '填入')
    const ocrList = await readList()
    report(
      'the recognised receipt lands in the pending list, marked as coming from a photo',
      ocrList.length === 1 && ocrList[0].fromOcr === true,
      `${ocrList.length} row(s), ocr mark: ${ocrList[0] ? ocrList[0].fromOcr : 'none'}\n        ${ocrList[0] ? ocrList[0].text : ''}`
    )

    report(
      'a receipt in another currency says so on the row instead of being silently relabelled',
      account.currency === 'MYR' ? true : ocrList[0] && ocrList[0].fx !== null,
      `account ${account.currency}, row amount "${ocrList[0] ? ocrList[0].amount : ''}", chip: ${ocrList[0] ? ocrList[0].fx : 'none'}`
    )

    const ocrOpened = await openRow(0)
    const ocrEditor = await readEditor()
    report(
      'the recognised row opens for editing like any other',
      ocrOpened === 'clicked' && ocrEditor !== null && ocrEditor.open === true && ocrEditor.amount !== null && ocrEditor.amount !== '',
      JSON.stringify(ocrEditor && { amount: ocrEditor.amount, merchant: ocrEditor.merchant, date: ocrEditor.date, time: ocrEditor.time })
    )
    report(
      'the editor shows the currency question rather than converting the amount itself',
      account.currency === 'MYR'
        ? true
        : ocrEditor !== null && ocrEditor.warn !== null && !/[{}\w]*\{[a-zA-Z]+\}/.test(ocrEditor.warn),
      `amount labelled "${ocrEditor ? ocrEditor.amountLabel : ''}"\n        warn: ${ocrEditor ? ocrEditor.warn : 'none'}`
    )

    await typeInto(inEditor('tx-edit-amount-'), '150.00')
    await typeInto(inEditor('tx-edit-merchant-'), 'Edited shop')
    await typeInto(inEditor('tx-edit-note-'), 'corrected by hand')
    await clickText('.tx-batch__row.is-expanded .tx-batch__editactions button', '完成')
    const editedOcr = await readList()
    await shot('v153-ocr-edited')
    report(
      '完成 corrects the recognised row in place',
      editedOcr.length === 1 && editedOcr[0].amount.includes('150.00') && editedOcr[0].text.includes('Edited shop'),
      editedOcr[0] ? editedOcr[0].text : 'no row'
    )

    await clickText('.tx-dialog__foot button', '全部保存')
    await sleep(1600)
    const ledger = await evaluate(`(async () => {
      const page = await window.api.transactionsList({ orderBy: 'created', orderDir: 'desc', limit: 3 });
      const items = page && page.items ? page.items : (page && page.data ? page.data.items : []);
      return items.map((item) => ({ id: item.id, amount: item.amount, merchant: item.merchant, note: item.note, date: item.date, time: item.time }));
    })()`)
    const corrected = ledger.find((item) => item.merchant === 'Edited shop')
    report(
      'the corrected amount and shop are what the ledger receives',
      !!corrected && Math.abs(corrected.amount) === 15000 && corrected.note === 'corrected by hand',
      JSON.stringify(ledger)
    )

    /* Clean up after the checks so a rerun starts from the same place. */
    if (corrected) await evaluate(`window.api.transactionsDelete(${corrected.id})`)
  }

  console.log(`\n${checks - failures}/${checks} checks passed`)
  ws.close()
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('FAILED:', error.message)
  process.exit(1)
})
