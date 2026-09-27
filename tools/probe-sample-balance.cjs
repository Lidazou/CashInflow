/** Read the sample ledger's monthly balance curve, and its MA values, from the demo DB. */
const Database = require('better-sqlite3')
const { join } = require('node:path')

const dir = process.argv[2] ?? join(process.env.TEMP ?? '.', 'sw-v170-data')
const path = join(dir, 'demo', 'spendwise.db')
const db = new Database(path, { readonly: true, fileMustExist: true })

try {
  const accounts = db.prepare('SELECT id, name, currency, opening_balance FROM accounts ORDER BY id').all()
  console.log('accounts:')
  for (const account of accounts) {
    const total = db.prepare('SELECT COALESCE(SUM(amount),0) AS n FROM transactions WHERE account_id = ?').get(account.id).n
    console.log(
      `  ${account.name.padEnd(18)} ${account.currency}  opening ${account.opening_balance}  closing ${account.opening_balance + total}`
    )
  }

  const card = accounts.find((a) => a.name === '中国银行储蓄卡')
  console.log('\n中国银行储蓄卡 月末余额:')
  const rows = db
    .prepare(
      `SELECT substr(date,1,7) AS month, SUM(amount) AS delta
       FROM transactions WHERE account_id = ? GROUP BY month ORDER BY month`
    )
    .all(card.id)
  let running = card.opening_balance
  const closes = []
  for (const row of rows) {
    running += row.delta
    closes.push(running)
    console.log(`  ${row.month}  ${String(running).padStart(10)}  (${(running / 100).toFixed(2)} CNY)  delta ${(row.delta / 100).toFixed(2)}`)
  }

  const ma = (values, window) => values.map((_, i) => (i + 1 < window ? null : Math.round(values.slice(i - window + 1, i + 1).reduce((a, b) => a + b, 0) / window)))
  console.log('\nMA of the monthly closing balance (cents):')
  for (const window of [5, 10, 20]) {
    const line = ma(closes, window)
    console.log(`  MA${window}: ${line.map((v) => (v === null ? '—' : (v / 100).toFixed(0))).join('  ')}`)
  }

  console.log('\nincome vs expense per month:')
  const flows = db
    .prepare(
      `SELECT substr(date,1,7) AS month,
              SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS income,
              SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END) AS expense
       FROM transactions WHERE account_id = ? GROUP BY month ORDER BY month`
    )
    .all(card.id)
  for (const row of flows) {
    console.log(`  ${row.month}  +${(row.income / 100).toFixed(0).padStart(7)}  ${(row.expense / 100).toFixed(0).padStart(8)}`)
  }

  console.log('\ntransfers out of the card per month (换汇/充值/还款 are expenses or transfers):')
  const transfers = db
    .prepare(
      `SELECT substr(date,1,7) AS month, SUM(amount) AS out FROM transactions
       WHERE account_id = ? AND type = 'transfer' AND amount < 0 GROUP BY month ORDER BY month`
    )
    .all(card.id)
  for (const row of transfers) console.log(`  ${row.month}  ${(row.out / 100).toFixed(2)}`)
} finally {
  db.close()
}
