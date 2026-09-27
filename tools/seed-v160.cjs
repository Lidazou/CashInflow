/**
 * Seed the v1.6.0 verification profile with the spec's own scenarios.
 *
 *   node tools/seed-v160.cjs
 *
 * Scenario A  2026-09-28   five expenses 400 / 200 / 150 / 100 / 150  = 1000
 * Scenario B  2026-09-29   income 12,000 and expense 200
 * Scenario C  2026-09-30   expenses 9,999 and 1
 * plus a fortnight of ordinary days so the chart has something to stack either side of
 * them, and so zooming out is not a cliff.
 *
 * Written through the app's OWN API, so the rows are exactly what the UI would produce.
 * Requires the app running on the debugging port with CASHINFLOW_DATA_DIR set.
 */
const http = require('node:http')

const PORT = Number(process.env.CDP_PORT ?? 9222)

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

const SCRIPT = `(async () => {
  const api = window.api;
  const unwrap = (value) => (Array.isArray(value) ? value : (value && value.data) || []);

  let accounts = unwrap(await api.accountsList());
  if (accounts.length === 0) {
    await api.accountsCreate({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 2000000 });
    accounts = unwrap(await api.accountsList());
  }
  const account = accounts[0];

  let categories = unwrap(await api.categoriesList());
  const ensureCategory = async (name, type) => {
    let found = categories.find((c) => c.name === name && c.type === type);
    if (!found) {
      found = await api.categoriesCreate({ name, type });
      categories = unwrap(await api.categoriesList());
      found = categories.find((c) => c.name === name && c.type === type) ?? found;
    }
    return found;
  };

  /* The already-seeded profile may have data from earlier verification runs. */
  const existing = await api.transactionsList({ from: '2026-09-01', to: '2026-10-31', limit: 500 });
  const rows = existing && existing.items ? existing.items : [];
  if (rows.some((row) => row.date === '2026-09-28' && row.amount === 40000)) {
    return 'scenarios already present';
  }

  const food = await ensureCategory('Food', 'expense');
  const transport = await ensureCategory('Transport', 'expense');
  const shopping = await ensureCategory('Shopping', 'expense');
  const entertainment = await ensureCategory('Entertainment', 'expense');
  const bills = await ensureCategory('Bills', 'expense');
  const salary = await ensureCategory('Salary', 'income');

  const write = async (date, time, type, amount, merchant, category, note) => {
    await api.transactionsCreate({
      accountId: account.id, type, amount, categoryId: category ? category.id : null, date, time, merchant, note: note ?? null
    });
  };

  /* --- Scenario A: five unequal expenses, 40/20/15/10/15 percent --- */
  await write('2026-09-28', '08:10', 'expense', 15000, 'Transport pass', transport);
  await write('2026-09-28', '09:30', 'expense', 10000, 'Coffee', food);
  await write('2026-09-28', '12:45', 'expense', 20000, 'Shopping', shopping);
  await write('2026-09-28', '15:20', 'expense', 15000, 'Groceries', food);
  await write('2026-09-28', '19:40', 'expense', 40000, 'Dinner', food);

  /* --- Scenario B: a salary that dwarfs the day's spending --- */
  await write('2026-09-29', '09:00', 'income', 1200000, 'September salary', salary);
  await write('2026-09-29', '20:15', 'expense', 20000, 'Dinner', food);

  /* --- Scenario C: 9,999 and 1 in the same day --- */
  await write('2026-09-30', '10:00', 'expense', 999900, 'Laptop', shopping);
  await write('2026-09-30', '10:05', 'expense', 100, 'Sticker', entertainment);

  /* --- ordinary days, so the window has context on both sides --- */
  const ordinary = [
    ['2026-09-24', 3200, 'Lunch', food], ['2026-09-24', 1800, 'Bus', transport],
    ['2026-09-25', 5600, 'Groceries', food], ['2026-09-25', 2400, 'Cinema', entertainment],
    ['2026-09-26', 4100, 'Lunch', food], ['2026-09-27', 15000, 'Electricity', bills],
    ['2026-09-27', 2200, 'Coffee', food],
    ['2026-10-01', 6600, 'Groceries', food], ['2026-10-01', 3100, 'Taxi', transport],
    ['2026-10-02', 8900, 'Books', shopping], ['2026-10-02', 1500, 'Coffee', food]
  ];
  for (const [date, amount, merchant, category] of ordinary) {
    await write(date, '12:00', 'expense', amount, merchant, category);
  }

  return 'seeded scenarios A/B/C plus ' + ordinary.length + ' ordinary rows';
})()`

async function main() {
  const target = (await getJson('/json/list')).find((entry) => entry.type === 'page')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve) => ws.addEventListener('open', resolve))

  const result = await new Promise((resolve, reject) => {
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== 1) return
      if (message.error) reject(new Error(JSON.stringify(message.error)))
      else if (message.result.exceptionDetails) {
        reject(new Error(message.result.exceptionDetails.exception?.description ?? 'eval failed'))
      } else resolve(message.result.result.value)
    })
    ws.send(
      JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression: SCRIPT, returnByValue: true, awaitPromise: true, userGesture: true }
      })
    )
  })

  console.log('seed ->', result)
  ws.close()
}

main().catch((error) => {
  console.error('FAILED:', error.message)
  process.exit(1)
})
