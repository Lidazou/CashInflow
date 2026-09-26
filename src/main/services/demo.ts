import type { Database as SqliteDatabase } from 'better-sqlite3'
import { AppError } from '@main/database/errors'
import { nowIso, endOfMonth } from '@shared/lib/dates'
import type { AccountType, TransactionType } from '@shared/types'

/**
 * Demo data.
 *
 * SEPARATION GUARANTEE
 * --------------------
 * Two hard rules make it impossible to end up with a ledger that is partly
 * fictional — the failure mode that makes sample data dangerous in a finance app:
 *
 *   1. Seeding is REFUSED unless the ledger is completely empty, so demo rows can
 *      never be interleaved with genuine history.
 *   2. Every seeded row records its `import_batch_id`, pointing at a batch named
 *      "[DEMO]". Clearing deletes exactly that batch, so the removal is precise
 *      and cannot take real transactions with it.
 *
 * The sample reflects the target user: a Chinese student in Malaysia, with a
 * Malaysian bank account, a Chinese bank card, Touch 'n Go for local payments,
 * and cash. Merchants are a realistic mix — local (Grab, mamak, 99 Speedmart) and
 * Chinese (海底捞, 淘宝, 微信支付) — because that is what the categorisation and
 * search features actually have to cope with.
 *
 * All copy is in Chinese, matching the rest of the interface.
 */

const DEMO_BATCH_NAME = '[DEMO] Sample data'

export interface DemoSeedResult {
  accounts: number
  transactions: number
}

interface DemoAccount {
  key: string
  name: string
  type: AccountType
  currency: string
  openingBalance: number
  color: string
  icon: string
}

interface DemoTransaction {
  account: string
  type: Exclude<TransactionType, 'transfer'>
  /** Magnitude in minor units. */
  amount: number
  category: string
  day: number
  merchant: string
  note?: string
  time?: string
}

interface DemoTransfer {
  from: string
  to: string
  amount: number
  day: number
  note?: string
}

const DEMO_ACCOUNTS: DemoAccount[] = [
  {
    key: 'maybank',
    name: 'Maybank 马来亚银行',
    type: 'bank',
    currency: 'MYR',
    openingBalance: 0,
    color: '#2563EB',
    icon: 'landmark'
  },
  {
    key: 'cny',
    name: '招商银行（人民币）',
    type: 'bank',
    currency: 'CNY',
    openingBalance: 0,
    color: '#DC2626',
    icon: 'landmark'
  },
  {
    key: 'tng',
    name: "Touch 'n Go 电子钱包",
    type: 'wallet',
    currency: 'MYR',
    openingBalance: 0,
    color: '#0E7490',
    icon: 'wallet'
  },
  {
    key: 'cash',
    name: '现金',
    type: 'cash',
    currency: 'MYR',
    openingBalance: 0,
    color: '#E8833A',
    icon: 'banknote'
  }
]

/**
 * One month of a student's spending in Kuala Lumpur.
 *
 * Opening balances are zero and the transactions produce the resulting balances,
 * so every figure shown on the dashboard is derived from these rows by the same
 * code path a real ledger uses. Nothing here is displayed directly.
 *
 * The two-currency mix is deliberate: it exercises the conversion path, which is
 * the part of the app most likely to be wrong in a way nobody notices.
 */
const DEMO_TRANSACTIONS: DemoTransaction[] = [
  // --- income ------------------------------------------------------------
  { account: 'cny', type: 'income', amount: 600000, category: 'Salary', day: 5, merchant: '家里汇的生活费', note: '本月生活费' },
  { account: 'maybank', type: 'income', amount: 85000, category: 'Freelance', day: 18, merchant: '兼职翻译', note: '线上兼职结算' },
  { account: 'maybank', type: 'income', amount: 12000, category: 'Refund', day: 21, merchant: '淘宝退款' },

  // --- housing -----------------------------------------------------------
  { account: 'maybank', type: 'expense', amount: 95000, category: 'Housing', day: 6, merchant: '房租', note: '合租单间 · 月付' },

  // --- food --------------------------------------------------------------
  { account: 'cash', type: 'expense', amount: 850, category: 'Food', day: 2, merchant: 'Mamak 档', time: '08:20' },
  { account: 'tng', type: 'expense', amount: 1680, category: 'Food', day: 3, merchant: 'Grab Food', time: '12:40' },
  { account: 'cash', type: 'expense', amount: 1200, category: 'Food', day: 4, merchant: '学校食堂', time: '13:05' },
  { account: 'maybank', type: 'expense', amount: 8800, category: 'Food', day: 7, merchant: '海底捞', note: '同学聚餐', time: '19:30' },
  { account: 'tng', type: 'expense', amount: 1520, category: 'Food', day: 9, merchant: 'Grab Food', time: '12:20' },
  { account: 'cash', type: 'expense', amount: 960, category: 'Food', day: 11, merchant: '面包店', time: '09:10' },
  { account: 'maybank', type: 'expense', amount: 18600, category: 'Food', day: 12, merchant: '99 Speedmart', note: '一周采购' },
  { account: 'tng', type: 'expense', amount: 2260, category: 'Food', day: 15, merchant: 'Grab Food', time: '20:10' },
  { account: 'cash', type: 'expense', amount: 1350, category: 'Food', day: 17, merchant: '大排档', time: '12:55' },
  { account: 'maybank', type: 'expense', amount: 17200, category: 'Food', day: 19, merchant: 'Lotus\u2019s 超市', note: '一周采购' },
  { account: 'tng', type: 'expense', amount: 1980, category: 'Food', day: 22, merchant: '奶茶店', time: '15:15' },
  { account: 'cash', type: 'expense', amount: 1100, category: 'Food', day: 24, merchant: 'Mamak 档', time: '08:30' },

  // --- transport ---------------------------------------------------------
  { account: 'tng', type: 'expense', amount: 1850, category: 'Transport', day: 2, merchant: 'Grab', time: '18:20' },
  { account: 'tng', type: 'expense', amount: 2500, category: 'Transport', day: 6, merchant: 'Grab', time: '08:45' },
  { account: 'tng', type: 'expense', amount: 480, category: 'Transport', day: 9, merchant: 'LRT 地铁', time: '22:05' },
  { account: 'maybank', type: 'expense', amount: 16000, category: 'Transport', day: 11, merchant: '机票 · 亚航', note: '寒假回国' },
  { account: 'tng', type: 'expense', amount: 620, category: 'Transport', day: 16, merchant: '公交', time: '07:50' },
  { account: 'tng', type: 'expense', amount: 890, category: 'Transport', day: 21, merchant: 'Grab', time: '21:30' },
  { account: 'tng', type: 'expense', amount: 2100, category: 'Transport', day: 23, merchant: 'Grab', time: '19:40' },

  // --- shopping ----------------------------------------------------------
  { account: 'maybank', type: 'expense', amount: 12900, category: 'Shopping', day: 14, merchant: 'Shopee', note: '日用品和充电线' },
  { account: 'cny', type: 'expense', amount: 29900, category: 'Shopping', day: 16, merchant: '淘宝', note: '寄到转运仓' },
  { account: 'maybank', type: 'expense', amount: 4590, category: 'Shopping', day: 20, merchant: 'Watsons 屈臣氏' },
  { account: 'maybank', type: 'expense', amount: 6800, category: 'Shopping', day: 8, merchant: 'Uniqlo' },

  // --- bills and subscriptions -------------------------------------------
  { account: 'maybank', type: 'expense', amount: 6250, category: 'Bills', day: 8, merchant: 'TNB 电费', note: '分摊后' },
  { account: 'maybank', type: 'expense', amount: 3800, category: 'Bills', day: 10, merchant: 'CelcomDigi 话费' },
  { account: 'maybank', type: 'expense', amount: 9800, category: 'Bills', day: 3, merchant: 'Unifi 宽带', note: '与室友分摊' },
  { account: 'cny', type: 'expense', amount: 10000, category: 'Subscription', day: 6, merchant: 'ChatGPT Plus', note: '每月订阅' },
  { account: 'cny', type: 'expense', amount: 1690, category: 'Subscription', day: 11, merchant: 'Apple Music' },
  { account: 'cny', type: 'expense', amount: 1290, category: 'Subscription', day: 11, merchant: 'iCloud+' },

  // --- education / health / entertainment --------------------------------
  { account: 'maybank', type: 'expense', amount: 24000, category: 'Education', day: 13, merchant: '雅思报名费' },
  { account: 'cny', type: 'expense', amount: 8900, category: 'Education', day: 9, merchant: 'Coursera 课程' },
  { account: 'maybank', type: 'expense', amount: 4500, category: 'Health', day: 16, merchant: '校医院', note: '感冒就诊' },
  { account: 'maybank', type: 'expense', amount: 3600, category: 'Entertainment', day: 17, merchant: 'GSC 电影院', note: '周末看电影' },
  { account: 'cash', type: 'expense', amount: 2400, category: 'Entertainment', day: 23, merchant: 'KTV', note: '同学生日' }
]

const DEMO_TRANSFERS: DemoTransfer[] = [
  { from: 'maybank', to: 'tng', amount: 30000, day: 4, note: '充值 Touch \u2019n Go' },
  { from: 'maybank', to: 'cash', amount: 20000, day: 10, note: 'ATM 取现' },
  { from: 'cny', to: 'maybank', amount: 200000, day: 6, note: '换汇转入' }
]

export class DemoDataService {
  constructor(private readonly db: SqliteDatabase) {}

  /** True when the database holds no user-visible financial data. */
  canSeed(): boolean {
    const accounts = (this.db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n
    const transactions = (this.db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n
    return accounts === 0 && transactions === 0
  }

  /** True when the ledger currently contains seeded demo rows. */
  isLoaded(): boolean {
    const row = this.db.prepare('SELECT id FROM import_batches WHERE file_name = ?').get(DEMO_BATCH_NAME) as
      | { id: number }
      | undefined
    return row !== undefined
  }

  /**
   * Insert the sample ledger.
   *
   * Refuses when any account or transaction already exists, so demo rows can
   * never be mixed into real history. The whole insert runs in one transaction:
   * a partially seeded ledger would show a plausible but wrong dashboard.
   */
  seed(monthKey: string): DemoSeedResult {
    if (!this.canSeed()) {
      throw new AppError(
        'VALIDATION',
        '示例数据只能添加到空账本中。你现有的账户和交易没有被修改。如果想体验示例数据，请先备份并清空数据。'
      )
    }

    const timestamp = nowIso()

    const run = this.db.transaction((): DemoSeedResult => {
      const batchInfo = this.db
        .prepare(
          `INSERT INTO import_batches (file_name, preset_id, file_hash, row_count, imported_count, skipped_count, created_at)
           VALUES (?, 'generic', NULL, 0, 0, 0, ?)`
        )
        .run(DEMO_BATCH_NAME, timestamp)
      const batchId = Number(batchInfo.lastInsertRowid)

      const accountIds = new Map<string, number>()
      const insertAccount = this.db.prepare(
        `INSERT INTO accounts
           (name, type, currency, opening_balance, color, icon, archived, note, sort_order, created_at, updated_at)
         VALUES (@name, @type, @currency, @openingBalance, @color, @icon, 0, @note, @sortOrder, @createdAt, @updatedAt)`
      )

      DEMO_ACCOUNTS.forEach((account, index) => {
        const info = insertAccount.run({
          name: account.name,
          type: account.type,
          currency: account.currency,
          openingBalance: account.openingBalance,
          color: account.color,
          icon: account.icon,
          note: '示例账户，由示例数据生成器创建。',
          sortOrder: index,
          createdAt: timestamp,
          updatedAt: timestamp
        })
        accountIds.set(account.key, Number(info.lastInsertRowid))
      })

      // Resolve category ids by name and type, so the demo reflects the user's
      // actual (possibly renamed) category set.
      const categoryIds = new Map<string, number>()
      for (const type of ['income', 'expense'] as const) {
        const rows = this.db.prepare('SELECT id, name FROM categories WHERE type = ?').all(type) as Array<{
          id: number
          name: string
        }>
        for (const row of rows) categoryIds.set(`${type}:${row.name}`, row.id)
      }

      const insertTransaction = this.db.prepare(
        `INSERT INTO transactions
           (account_id, type, amount, category_id, date, time, merchant, note,
            transfer_id, import_batch_id, source_id, import_hash, created_at, updated_at)
         VALUES
           (@accountId, @type, @amount, @categoryId, @date, @time, @merchant, @note,
            @transferId, @importBatchId, NULL, NULL, @createdAt, @updatedAt)`
      )

      let transactionCount = 0

      for (const item of DEMO_TRANSACTIONS) {
        const accountId = accountIds.get(item.account)
        if (accountId === undefined) continue

        const categoryId = categoryIds.get(`${item.type}:${item.category}`) ?? null
        if (categoryId === null) {
          throw new AppError(
            'INTERNAL',
            `示例数据需要一个「${item.category}」${item.type === 'income' ? '收入' : '支出'}分类，但它不存在。未保存任何数据。`
          )
        }

        const date = `${monthKey}-${String(item.day).padStart(2, '0')}`
        const signed = item.type === 'income' ? item.amount : -item.amount

        insertTransaction.run({
          accountId,
          type: item.type,
          amount: signed,
          categoryId,
          date,
          time: item.time ?? null,
          merchant: item.merchant,
          note: item.note ?? null,
          transferId: null,
          importBatchId: batchId,
          createdAt: timestamp,
          updatedAt: timestamp
        })
        transactionCount += 1
      }

      // Transfers are written as paired legs, exactly like real ones, so the demo
      // exercises the same transfer handling the app uses in production.
      const insertTransfer = this.db.prepare(
        `INSERT INTO transfers (from_account_id, to_account_id, amount, date, time, note, created_at, updated_at)
         VALUES (@fromAccountId, @toAccountId, @amount, @date, NULL, @note, @createdAt, @updatedAt)`
      )

      for (const item of DEMO_TRANSFERS) {
        const fromId = accountIds.get(item.from)
        const toId = accountIds.get(item.to)
        if (fromId === undefined || toId === undefined) continue

        const fromCurrency = DEMO_ACCOUNTS.find((account) => account.key === item.from)?.currency
        const toCurrency = DEMO_ACCOUNTS.find((account) => account.key === item.to)?.currency
        // The service refuses cross-currency transfers because there is no
        // exchange rate to apply, so the demo must respect that too rather than
        // seeding a state the user could never create.
        if (fromCurrency !== toCurrency) continue

        const date = `${monthKey}-${String(item.day).padStart(2, '0')}`
        const transferInfo = insertTransfer.run({
          fromAccountId: fromId,
          toAccountId: toId,
          amount: item.amount,
          date,
          note: item.note ?? null,
          createdAt: timestamp,
          updatedAt: timestamp
        })
        const transferId = Number(transferInfo.lastInsertRowid)

        insertTransaction.run({
          accountId: fromId,
          type: 'transfer',
          amount: -item.amount,
          categoryId: null,
          date,
          time: null,
          merchant: null,
          note: item.note ?? null,
          transferId,
          importBatchId: batchId,
          createdAt: timestamp,
          updatedAt: timestamp
        })
        insertTransaction.run({
          accountId: toId,
          type: 'transfer',
          amount: item.amount,
          categoryId: null,
          date,
          time: null,
          merchant: null,
          note: item.note ?? null,
          transferId,
          importBatchId: batchId,
          createdAt: timestamp,
          updatedAt: timestamp
        })
        transactionCount += 2
      }

      this.db
        .prepare('UPDATE import_batches SET row_count = ?, imported_count = ? WHERE id = ?')
        .run(transactionCount, transactionCount, batchId)

      return { accounts: DEMO_ACCOUNTS.length, transactions: transactionCount }
    })

    return run()
  }

  /**
   * Remove all demo data.
   *
   * Only rows belonging to the demo batch are deleted. Any real transaction the
   * user added after seeding has a different (or null) batch id and survives.
   * Accounts are removed only when nothing else references them, which is enforced
   * by the ON DELETE RESTRICT foreign key.
   */
  clear(): { removedTransactions: number } {
    const batch = this.db.prepare('SELECT id FROM import_batches WHERE file_name = ?').get(DEMO_BATCH_NAME) as
      | { id: number }
      | undefined

    if (!batch) return { removedTransactions: 0 }

    const run = this.db.transaction((): { removedTransactions: number } => {
      // Deleting the transfers first cascades to their legs.
      const transferIds = this.db
        .prepare(
          'SELECT DISTINCT transfer_id AS id FROM transactions WHERE import_batch_id = ? AND transfer_id IS NOT NULL'
        )
        .all(batch.id) as Array<{ id: number }>
      for (const row of transferIds) {
        this.db.prepare('DELETE FROM transfers WHERE id = ?').run(row.id)
      }

      const removed = this.db.prepare('DELETE FROM transactions WHERE import_batch_id = ?').run(batch.id)
      this.db.prepare('DELETE FROM import_batches WHERE id = ?').run(batch.id)

      // Remove the sample accounts, but only if the user has not since recorded
      // anything of their own against them.
      for (const account of DEMO_ACCOUNTS) {
        const row = this.db.prepare('SELECT id FROM accounts WHERE name = ?').get(account.name) as
          | { id: number }
          | undefined
        if (!row) continue
        const used = (
          this.db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE account_id = ?').get(row.id) as { n: number }
        ).n
        if (used === 0) this.db.prepare('DELETE FROM accounts WHERE id = ?').run(row.id)
      }

      return { removedTransactions: removed.changes }
    })

    return run()
  }

  /** Latest month key that the demo set would populate. */
  static defaultMonthKey(reference: Date = new Date()): string {
    const key = `${reference.getFullYear()}-${String(reference.getMonth() + 1).padStart(2, '0')}-01`
    return endOfMonth(key).slice(0, 7)
  }
}
