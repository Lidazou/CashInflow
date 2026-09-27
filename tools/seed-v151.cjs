/**
 * Seed the verification profile with the v1.5.1 fixture.
 *
 *   node tools/seed-v151.cjs
 *
 * Two parts, deliberately:
 *
 *   1. The spec's micro-transaction day, written through the app's OWN API so the rows are
 *      exactly what the UI would produce — Maybank, RM 5,000 opening, and the nine entries
 *      from 09:00 to 20:30 whose smallest is RM 0.50.
 *   2. Two years of everyday history, written straight to the database, because the range
 *      presets and the candle ladder cannot be exercised against a three-day ledger.
 *
 * Requires the app running on the debugging port with CASHINFLOW_DATA_DIR set to a
 * throwaway directory.
 */
const http = require('node:http')
const Database = require('better-sqlite3')
const { join } = require('node:path')

const PORT = Number(process.env.CDP_PORT ?? 9222)
const dataDir = process.env.CASHINFLOW_DATA_DIR

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

const MICRO_DAY = `(async () => {
  const api = window.api;
  const accounts = await api.accountsList();
  const list = Array.isArray(accounts) ? accounts : (accounts && accounts.data) || [];
  if (list.length > 0) return 'account already exists';

  const created = await api.accountsCreate({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 500000 });
  const account = created && created.data ? created.data : created;
  const cats = await api.categoriesList();
  const categories = Array.isArray(cats) ? cats : (cats && cats.data) || [];
  const expense = categories.find((c) => c.kind === 'expense' && c.name === 'Food') || categories.find((c) => c.kind === 'expense');
  const income = categories.find((c) => c.kind === 'income');

  const rows = [
    ['2026-09-23', '10:00', 'income', 120000, 'Salary', income, 'September pay'],
    ['2026-09-23', '18:45', 'expense', 4500, 'Groceries', expense, null],
    ['2026-09-25', '09:00', 'income', 300000, 'Salary', income, 'September pay'],
    ['2026-09-25', '12:14', 'expense', 50, 'Lunch', expense, null],
    ['2026-09-25', '12:18', 'expense', 120, 'Coffee', expense, null],
    ['2026-09-25', '12:25', 'expense', 480, 'Snack', expense, null],
    ['2026-09-25', '13:30', 'expense', 650, 'Lunch', expense, null],
    ['2026-09-25', '15:00', 'expense', 800, 'Transport', expense, null],
    ['2026-09-25', '18:20', 'expense', 3200, 'Dinner', expense, null],
    ['2026-09-25', '20:30', 'expense', 12000, 'Shopping', expense, null]
  ];
  for (const [date, time, type, amount, merchant, category, note] of rows) {
    await api.transactionsCreate({
      accountId: account.id, type, amount, categoryId: category ? category.id : null, date, time, merchant, note
    });
  }
  return 'seeded ' + rows.length + ' fixture rows';
})()`

async function main() {
  const target = (await getJson('/json/list')).find((entry) => entry.type === 'page')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve) => ws.addEventListener('open', resolve))

  let id = 0
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const myId = ++id
      const onMessage = (event) => {
        const message = JSON.parse(event.data)
        if (message.id !== myId) return
        ws.removeEventListener('message', onMessage)
        if (message.error) reject(new Error(JSON.stringify(message.error)))
        else resolve(message.result)
      }
      ws.addEventListener('message', onMessage)
      ws.send(JSON.stringify({ id: myId, method, params }))
    })

  const result = await call('Runtime.evaluate', {
    expression: MICRO_DAY,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true
  })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'eval failed')
  console.log('micro day -> ' + JSON.stringify(result.result.value))
  ws.close()

  if (!dataDir) {
    console.log('CASHINFLOW_DATA_DIR not set: skipping the two-year history')
    process.exit(0)
  }

  const db = new Database(join(dataDir, 'spendwise.db'))
  const existing = db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n
  if (existing > 20) {
    console.log(`history already present (${existing} rows)`)
    db.close()
    process.exit(0)
  }

  const now = new Date().toISOString()
  const account = db.prepare('SELECT id FROM accounts WHERE archived = 0').get()
  const categoryRows = db.prepare('SELECT id, type FROM categories').all()
  const pick = (kind) => {
    const pool = categoryRows.filter((row) => row.type === kind)
    return pool.length > 0 ? pool[pool.length - 1].id : null
  }

  let seed = 20260925
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  const vendors = ['Lunch', 'Coffee', 'Groceries', 'Transport', 'Dinner', 'Books', 'Pharmacy', 'Cinema', 'Snack']
  const insert = db.prepare(
    `INSERT INTO transactions (account_id, type, amount, category_id, date, time, merchant, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
  )

  const write = db.transaction(() => {
    for (let year = 2025; year <= 2026; year += 1) {
      for (let month = 1; month <= 12; month += 1) {
        const pad = String(month).padStart(2, '0')
        // Do not double up on the fixture month, which already has its own day.
        if (year === 2026 && month === 9) continue
        insert.run(account.id, 'income', 340000 + Math.floor(random() * 40000), pick('income'), `${year}-${pad}-03`, '09:00', 'Salary', now, now)
        const count = 4 + Math.floor(random() * 8)
        for (let i = 0; i < count; i += 1) {
          const day = String(4 + Math.floor(random() * 24)).padStart(2, '0')
          const hour = String(8 + Math.floor(random() * 13)).padStart(2, '0')
          const minute = String(Math.floor(random() * 60)).padStart(2, '0')
          const cents = -(150 + Math.floor(random() * 24000))
          insert.run(account.id, 'expense', cents, pick('expense'), `${year}-${pad}-${day}`, `${hour}:${minute}`, vendors[Math.floor(random() * vendors.length)], now, now)
        }
      }
    }
  })
  write()

  const summary = db.prepare('SELECT COUNT(*) AS n, MIN(date) AS first, MAX(date) AS last FROM transactions').get()
  console.log(`history -> ${summary.n} rows spanning ${summary.first} .. ${summary.last}`)
  db.close()
  process.exit(0)
}

main().catch((error) => {
  console.error('FAILED:', error.message)
  process.exit(1)
})
