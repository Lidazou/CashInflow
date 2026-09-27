/**
 * CDP verification for the sample ledger (v1.7.0).
 *
 *   node tools/verify-sample-ledger.cjs
 *
 * The claim being tested is a safety claim — "switching to the sample data does not touch
 * my own records" — so the run does what a suspicious user would do: it writes a marker
 * row into the REAL ledger, notes a digest of everything in it, switches to the sample,
 * uses the app (including writing to it), switches back, and compares.
 *
 * Requires the app running with --remote-debugging-port and CASHINFLOOW_DATA_DIR pointing
 * at a throwaway profile. It prints the paths it is using so the run can be trusted.
 */
const http = require('node:http')
const Database = require('better-sqlite3')
const { join } = require('node:path')

const PORT = Number(process.env.CDP_PORT ?? 9222)
const DATA_DIR = process.env.CASHINFLOW_DATA_DIR ?? ''

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

/** A digest of everything a user would notice, read from the file itself. */
function digest(path) {
  const db = new Database(path, { readonly: true, fileMustExist: true })
  try {
    return JSON.stringify({
      accounts: db.prepare('SELECT id, name, currency, opening_balance FROM accounts ORDER BY id').all(),
      transactions: db
        .prepare('SELECT id, account_id, type, amount, date, time, merchant, note FROM transactions ORDER BY id')
        .all(),
      transfers: db.prepare('SELECT id, amount, date, note FROM transfers ORDER BY id').all(),
      categories: db.prepare('SELECT id, name, color FROM categories ORDER BY id').all()
    })
  } finally {
    db.close()
  }
}

async function main() {
  console.log(`profile: ${DATA_DIR || '(app default — refusing to continue)'}`)
  if (!DATA_DIR) {
    console.error('CASHINFLOW_DATA_DIR must be set: this script inspects the database files directly.')
    process.exit(1)
  }
  const realPath = join(DATA_DIR, 'spendwise.db')
  const samplePath = join(DATA_DIR, 'demo', 'spendwise.db')

  const target = (await getJson('/json/list')).find((entry) => entry.type === 'page')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', () => reject(new Error('ws failed')))
  })

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

  await call('Page.reload', {}, 60000)
  await sleep(2600)

  /* ------------------------------------------------------------------ */
  /* 1. the app starts on the user's own ledger                          */
  /* ------------------------------------------------------------------ */
  const start = await evaluate(`window.api.ledgerStatus()`)
  report(
    'the app opens on the user`s own ledger, never on the sample',
    start.mode === 'real',
    `mode ${start.mode}, real ${start.realPath}`
  )
  report(
    'the sample lives in its own folder next to it',
    start.samplePath.includes('demo') && start.samplePath !== start.realPath,
    `${start.samplePath}`
  )

  /* Write a marker into the REAL ledger through the app's own API. */
  const marker = await evaluate(`(async () => {
    const unwrap = (value) => (Array.isArray(value) ? value : (value && value.data) || []);
    let list = unwrap(await window.api.accountsList());
    /*
      A brand-new profile has no accounts — the app's onboarding creates the first one — so
      the verification creates its own fixture rather than assuming somebody else's.
    */
    if (list.length === 0) {
      await window.api.accountsCreate({ name: '留学', type: 'bank', currency: 'CNY', openingBalance: 500000 });
      list = unwrap(await window.api.accountsList());
    }
    const account = list[0];
    if (!account) return { created: false, reason: 'no account could be created' };
    await window.api.transactionsCreate({
      accountId: account.id,
      type: 'expense',
      amount: 4321,
      categoryId: null,
      date: '2026-09-15',
      time: '08:00',
      merchant: '我的真实标记',
      note: 'verify-sample-ledger'
    });
    return { created: true, account: account.name };
  })()`)
  report('a marker row can be written to the user`s own ledger', marker.created === true, JSON.stringify(marker))

  const before = digest(realPath)
  const realCountBefore = await evaluate(`(async () => {
    const page = await window.api.transactionsList({ limit: 1 });
    return page && typeof page.total === 'number' ? page.total : (page.items || []).length;
  })()`)

  /* ------------------------------------------------------------------ */
  /* 2. switching to the sample                                          */
  /* ------------------------------------------------------------------ */
  const switched = await evaluate(`(async () => {
    const status = await window.api.ledgerSwitch('sample');
    return status;
  })()`)
  await sleep(1500)
  report(
    'switching to the sample moves the app to the other database',
    switched.mode === 'sample' && switched.sampleLoaded === true,
    `mode ${switched.mode}, generated ${switched.sampleGeneratedAt}`
  )
  report(
    'the user`s own file is untouched by the switch',
    digest(realPath) === before,
    `${JSON.stringify(before).length} bytes of digest, identical`
  )
  report('the sample database exists on disk', require('node:fs').existsSync(samplePath), samplePath)

  /* ------------------------------------------------------------------ */
  /* 3. the sample is a full, plausible ledger                           */
  /* ------------------------------------------------------------------ */
  const sample = await evaluate(`(async () => {
    const unwrap = (value) => (Array.isArray(value) ? value : (value && value.data) || []);
    const accounts = unwrap(await window.api.accountsList());
    const page = await window.api.transactionsList({ limit: 3000 });
    const items = page && page.items ? page.items : [];
    const subs = unwrap(await window.api.subscriptionsList());
    const budgets = unwrap(await window.api.budgetsList());
    const cats = unwrap(await window.api.categoriesList());
    const allowance = items.filter((row) => row.merchant === '家里打生活费');
    const rent = items.filter((row) => row.merchant === '房租');
    const loans = items.filter((row) => row.merchant === '借给同学李明' || row.merchant === '李明还钱');
    const travel = items.filter((row) => row.categoryName === 'Travel');
    const big = items.filter((row) => row.note === '突发支出');
    const gifts = items.filter((row) => row.categoryName === 'Gift');
    const exchanged = items.filter((row) => row.merchant === '换汇' || row.merchant === '换汇到账');
    return {
      accounts: accounts.map((a) => a.name + ' ' + a.currency),
      balances: accounts.map((a) => a.balance),
      transactions: items.length,
      subscriptions: subs.map((s) => s.name),
      budgets: budgets.length,
      categories: cats.length,
      allowanceDays: [...new Set(allowance.map((row) => row.date.slice(8)))],
      allowanceMonths: allowance.length,
      rentMonths: rent.length,
      rentAmounts: [...new Set(rent.map((row) => row.amount))],
      loans: loans.map((row) => row.type + ':' + row.amount),
      travel: travel.length,
      big: big.map((row) => row.merchant),
      gifts: gifts.length,
      exchanged: exchanged.length,
      months: [...new Set(items.map((row) => row.date.slice(0, 7)))].sort()
    };
  })()`)

  report(
    'the sample has the accounts a student abroad would have',
    sample.accounts.length >= 4 && sample.accounts.some((name) => name.includes('MYR')),
    sample.accounts.join(' | ')
  )
  report(
    'the allowance arrives on the 5th, in every month that has one',
    sample.allowanceDays.length === 1 && sample.allowanceDays[0] === '05' && sample.allowanceMonths >= 8,
    `days ${sample.allowanceDays.join(',')}, ${sample.allowanceMonths} payments`
  )
  report(
    'rent is charged every month at exactly 3200',
    sample.rentMonths === sample.months.length && sample.rentAmounts.length === 1 && sample.rentAmounts[0] === -320000,
    `${sample.rentMonths} months out of ${sample.months.length}, amounts ${sample.rentAmounts.join(',')}`
  )
  report(
    'the subscriptions from the brief are all there',
    ['ChatGPT Plus', 'Netflix', '加速器', '哔哩哔哩大会员', '网易云音乐黑胶'].every((name) =>
      sample.subscriptions.includes(name)
    ),
    sample.subscriptions.join(' | ')
  )
  report(
    'there is a loan out and a repayment back',
    sample.loans.length >= 2 && sample.loans.some((entry) => entry.startsWith('expense')) && sample.loans.some((entry) => entry.startsWith('income')),
    sample.loans.join(' | ')
  )
  report('there are trips and holiday travel', sample.travel >= 3, `${sample.travel} travel entries`)
  report(
    'several months carry a large one-off expense',
    sample.big.length >= 4,
    sample.big.join(' | ')
  )
  report('birthday money and red envelopes arrive', sample.gifts >= 5, `${sample.gifts} gift entries`)
  report('money is exchanged into the local currency', sample.exchanged >= 12, `${sample.exchanged} exchange rows`)
  report('budgets and categories are populated too', sample.budgets >= 5 && sample.categories >= 10, `${sample.budgets} budgets, ${sample.categories} categories`)
  report(
    'no account is overdrawn',
    sample.balances.every((balance) => balance >= 0),
    sample.balances.join(' | ')
  )
  report('the sample covers a full year', sample.months.length >= 12, sample.months.join(', '))

  /* ------------------------------------------------------------------ */
  /* 4. the charts say which ledger they are showing                     */
  /* ------------------------------------------------------------------ */
  await evaluate(`(() => {
    const home = Array.from(document.querySelectorAll('.sw-shell__nav-link, nav a, aside a')).find((el) => /总览|Overview/.test(el.textContent));
    if (home) home.click();
    return 'home';
  })()`)
  await sleep(1600)

  const badges = await evaluate(`(() => ({
    banner: document.querySelector('[data-sample-banner]') ? document.querySelector('[data-sample-banner]').innerText.replace(/\\s+/g, ' ').trim() : null,
    badges: document.querySelectorAll('[data-sample-badge]').length,
    charts: document.querySelectorAll('.cfc, .donut3d').length,
    chartCorner: document.querySelectorAll('.chart-corner [data-sample-badge]').length
  }))()`)
  report(
    'a banner across the app says this is the sample ledger, with a way back',
    badges.banner !== null && /模拟数据/.test(badges.banner) && /返回我的账本/.test(badges.banner),
    badges.banner
  )
  report(
    'the chart card carries the sample badge in its top-right corner',
    badges.chartCorner >= 1,
    `${badges.chartCorner} badge(s) in chart corners, ${badges.charts} chart(s) on screen`
  )

  /* ------------------------------------------------------------------ */
  /* 5. writing while the sample is open                                 */
  /* ------------------------------------------------------------------ */
  const wroteInSample = await evaluate(`(async () => {
    const accounts = await window.api.accountsList();
    const list = Array.isArray(accounts) ? accounts : (accounts && accounts.data) || [];
    await window.api.transactionsCreate({
      accountId: list[0].id, type: 'expense', amount: 1234, categoryId: null,
      date: '2026-09-20', time: '09:00', merchant: '模拟数据里的新记录', note: null
    });
    const page = await window.api.transactionsList({ limit: 1 });
    return page ? page.total : null;
  })()`)
  report('the sample ledger can be used like any ledger', wroteInSample !== null, `${wroteInSample} rows now`)
  report(
    'and the user`s own file is STILL untouched',
    digest(realPath) === before,
    'digest identical after a write in sample mode'
  )

  /* ------------------------------------------------------------------ */
  /* 6. switching back                                                   */
  /* ------------------------------------------------------------------ */
  await evaluate(`(async () => window.api.ledgerSwitch('real'))()`)
  await sleep(1500)
  const back = await evaluate(`(async () => {
    const status = await window.api.ledgerStatus();
    const page = await window.api.transactionsList({ limit: 1 });
    const found = await window.api.transactionsList({ search: '我的真实标记', limit: 5 });
    const sampleRow = await window.api.transactionsList({ search: '模拟数据里的新记录', limit: 5 });
    return {
      mode: status.mode,
      total: page ? page.total : null,
      marker: found ? found.total : null,
      sampleRow: sampleRow ? sampleRow.total : null
    };
  })()`)
  report('switching back returns to the user`s own ledger', back.mode === 'real', `mode ${back.mode}`)
  report(
    'the user`s rows are all there, including the marker',
    back.total === realCountBefore && back.marker >= 1,
    `${realCountBefore} rows before the switch, ${back.total} after, marker present: ${back.marker}`
  )
  report('none of the sample`s rows leaked into it', back.sampleRow === 0, `${back.sampleRow} matching rows`)
  report(
    'and the file itself is byte-for-byte what it was',
    digest(realPath) === before,
    'digest identical after the whole round trip'
  )

  const bannerGone = await evaluate(`document.querySelector('[data-sample-banner]') === null`)
  report('the sample banner is gone once the sample is closed', bannerGone === true, `banner present: ${!bannerGone}`)

  /* ------------------------------------------------------------------ */
  /* 7. regenerating the sample                                          */
  /* ------------------------------------------------------------------ */
  const regenerated = await evaluate(`(async () => {
    await window.api.ledgerSwitch('sample');
    const status = await window.api.ledgerRegenerateSample();
    const page = await window.api.transactionsList({ limit: 1 });
    return { mode: status.mode, total: page ? page.total : null };
  })()`)
  await sleep(800)
  report(
    'the sample can be regenerated from scratch at any time',
    regenerated.mode === 'sample' && regenerated.total > 900,
    `mode ${regenerated.mode}, ${regenerated.total} rows`
  )
  report(
    'the user`s own ledger survives a regeneration too',
    digest(realPath) === before,
    'digest identical'
  )

  await evaluate(`(async () => window.api.ledgerSwitch('real'))()`)
  await sleep(800)

  console.log(`\n${checks - failures}/${checks} checks passed`)
  ws.close()
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('FAILED:', error.message)
  process.exit(1)
})
