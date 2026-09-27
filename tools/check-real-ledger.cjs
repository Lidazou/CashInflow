/** Read-only check of the real ledger after the v1.7.0 install. */
const Database = require('better-sqlite3')
const { join } = require('node:path')

const path = join(process.env.APPDATA ?? '', 'CashInflow', 'spendwise.db')
const db = new Database(path, { readonly: true, fileMustExist: true })
try {
  const accounts = db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n
  const transactions = db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n
  const newest = db.prepare('SELECT MAX(date) AS d FROM transactions').get().d
  const schema = db.pragma('user_version', { simple: true })
  const integrity = db.pragma('integrity_check', { simple: true })
  console.log(JSON.stringify({ path, accounts, transactions, newest, schema, integrity }, null, 1))
} finally {
  db.close()
}
