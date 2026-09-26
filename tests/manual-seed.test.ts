import { describe, it } from 'vitest'
import { join } from 'node:path'
import { openDatabase } from '@main/database/connection'
import { Services } from '@main/services'

/**
 * Manual verification helper 鈥?NOT part of the normal test suite.
 *
 * Seeds the demo dataset into the real application database so the running app
 * can be inspected with realistic data. It writes to the live userData path, so
 * it is skipped unless SW_SEED_DEMO=1 is set:
 *
 *     $env:SW_SEED_DEMO=1; npx vitest run tests/manual-seed.test.ts
 *
 * The unit and integration suites never touch the user's real data.
 */
const enabled = process.env['SW_SEED_DEMO'] === '1'

describe.skipIf(!enabled)('manual: seed the live database', () => {
  it('seeds demo data into the app userData directory', () => {
    const dataDir = join(process.env['APPDATA'] ?? '', 'CashInflow')
    const handle = openDatabase({ dataDir })
    const services = new Services(handle.db)

    console.log('database:', handle.path)
    console.log('canSeed:', services.demo.canSeed())

    if (!services.demo.canSeed()) {
      console.log('Database already has data; clearing demo data first.')
      const cleared = services.demo.clear()
      console.log('cleared:', JSON.stringify(cleared))
    }

    const month = '2026-09'
    const result = services.demo.seed(month)
    console.log('seeded:', JSON.stringify(result))

    // Report the derived figures the dashboard will show, so they can be
    // compared against the screenshot.
    const balances = services.accounts.balancesByCurrency()
    console.log('balances:', JSON.stringify(balances))
    console.log('totals:', JSON.stringify(services.transactions.totals(`${month}-01`, `${month}-30`)))
    console.log('biggest:', services.statistics.biggestExpenses(month, 1, 'CNY', 5).map((e) => `${e.merchant} ${e.amount}`))

    handle.close()
  })
})
