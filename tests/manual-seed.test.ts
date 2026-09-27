import { describe, it } from 'vitest'
import { join } from 'node:path'
import { openDatabase } from '@main/database/connection'
import { Services } from '@main/services'

/**
 * Manual inspection helper — NOT part of the normal test suite.
 *
 * Prints the figures the dashboard will show for the sample ledger, so a screenshot can be
 * checked against the numbers rather than against an impression. It reads the SAMPLE
 * database, never the user's own:
 *
 *     npx vitest run tests/manual-seed.test.ts
 *
 * (Until v1.7.0 this seeded rows into the real database and was gated behind SW_SEED_DEMO=1.
 * The sample ledger is now a file of its own, so there is nothing left to gate: this reads
 * `demo/spendwise.db` and writes nothing at all.)
 */
describe('manual: read the sample ledger', () => {
  it('reports the sample ledger`s figures', () => {
    const dataDir = join(process.env['TEMP'] ?? '/tmp', 'sw-v170-data')
    const handle = openDatabase({ dataDir: join(dataDir, 'demo') })
    const services = new Services(handle.db)

    console.log('database:', handle.path)
    const month = '2026-09'
    console.log('accounts:', services.accounts.list({}).map((a) => `${a.name} ${a.balance} ${a.currency}`))
    console.log('totals:', JSON.stringify(services.transactions.totals(`${month}-01`, `${month}-30`)))
    console.log('balances:', JSON.stringify(services.accounts.balancesByCurrency()))
    console.log(
      'biggest:',
      services.statistics.biggestExpenses(month, 1, 'CNY', 5).map((e) => `${e.merchant} ${e.amount}`)
    )
    console.log('subscriptions:', services.subscriptions.list().map((s) => `${s.name} ${s.amount}`))
    handle.close()
  })
})
