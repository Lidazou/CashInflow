import { existsSync, mkdirSync, rmSync } from 'node:fs'
import Database from 'better-sqlite3'
import { join } from 'node:path'

import { openDatabase, type DatabaseHandle } from '@main/database/connection'
import { Services } from '@main/services'
import { defaultDemoWindow, generateStudentLife } from '@main/services/demo-life'
import { addMonths, nowIso, today } from '@shared/lib/dates'
import type { LedgerMode, LedgerStatus } from '@shared/types'

/**
 * 账本切换 (v1.7.0)
 *
 * TWO DATABASES, ONE WINDOW
 * -------------------------
 * The sample ledger is a SEPARATE SQLite file, not rows mixed into the user's own. The
 * previous design (`demoSeed`) wrote sample transactions straight into the real database
 * and refused to do so unless the ledger was empty — which meant the feature was
 * unreachable for anyone who had actually used the app, and dangerous for anyone who had
 * not. Switching files instead makes the promise structural:
 *
 *   - while the sample is showing, the real file is CLOSED. Nothing in the app can write
 *     to it, because there is no connection to write through;
 *   - the sample lives in `demo/spendwise.db` next to the real one, so "reset the sample"
 *     is a file delete and never touches the user's rows;
 *   - the mode is NOT persisted. Every launch opens the real ledger, because an app that
 *     reopens showing someone else's money is an app that has lost the user's trust.
 *
 * ORDER OF OPERATIONS ON A SWITCH
 * -------------------------------
 * Open the new database FIRST, then swap, then close the old one. If opening fails — a
 * locked file, a full disk — the app is still on the ledger it was on, with an error to
 * show, rather than on nothing at all.
 */

export interface LedgerPaths {
  /** Where the user's own ledger lives. */
  realDir: string
  realPath: string
  demoDir: string
  demoPath: string
}

export function ledgerPaths(dataDir: string): LedgerPaths {
  const demoDir = join(dataDir, 'demo')
  return {
    realDir: dataDir,
    realPath: join(dataDir, 'spendwise.db'),
    demoDir,
    demoPath: join(demoDir, 'spendwise.db')
  }
}

export class LedgerManager {
  private readonly paths: LedgerPaths
  private mode: LedgerMode = 'real'
  private handle: DatabaseHandle
  private services: Services

  constructor(dataDir: string) {
    this.paths = ledgerPaths(dataDir)
    this.handle = openDatabase({ dataDir: this.paths.realDir })
    this.services = new Services(this.handle.db)
  }

  pathsFor(): LedgerPaths {
    return this.paths
  }

  currentMode(): LedgerMode {
    return this.mode
  }

  /** Directory of the ledger in use, for backup/restore/info handlers. */
  currentDir(): string {
    return this.mode === 'sample' ? this.paths.demoDir : this.paths.realDir
  }

  /** File path of the ledger in use. */
  currentPath(): string {
    return this.mode === 'sample' ? this.paths.demoPath : this.paths.realPath
  }

  /**
   * Reopen the ledger that is currently open, after its file changed underneath us.
   *
   * Used by the restore path. Reopening the ACTIVE ledger (rather than the real one) is
   * the point: a restore triggered while the sample is on screen must leave the app on
   * the sample, not quietly hand it a connection to the user's own file.
   */
  reopenCurrent(): void {
    const dir = this.currentDir()
    const fresh = openDatabase({ dataDir: dir })
    const previous = this.handle
    this.handle = fresh
    this.services = new Services(fresh.db)
    try {
      previous.close()
    } catch {
      /* the caller may already have closed it */
    }
  }

  servicesRef(): Services {
    return this.services
  }

  handleRef(): DatabaseHandle {
    return this.handle
  }

  status(): LedgerStatus {
    return {
      mode: this.mode,
      sampleAvailable: true,
      sampleLoaded: existsSync(this.paths.demoPath),
      realPath: this.paths.realPath,
      samplePath: this.paths.demoPath,
      sampleGeneratedAt: this.mode === 'sample' ? this.readGeneratedAt() : null
    }
  }

  /**
   * Switch ledgers, generating the sample on first use.
   *
   * Returns the status so the caller can broadcast one object rather than asking twice.
   */
  switchTo(mode: LedgerMode): LedgerStatus {
    if (mode === this.mode) return this.status()

    if (mode === 'sample' && !existsSync(this.paths.demoPath)) {
      this.generateSample()
    }

    const dir = mode === 'sample' ? this.paths.demoDir : this.paths.realDir
    const nextHandle = openDatabase({ dataDir: dir })
    const nextServices = new Services(nextHandle.db)

    const previous = this.handle
    this.handle = nextHandle
    this.services = nextServices
    this.mode = mode

    try {
      previous.close()
    } catch {
      /* The ledger we just left; a failed close must not undo the switch. */
    }

    /*
      Rates are stored per database, so the sample starts with none and every converted
      figure in it would read "无汇率" until the next fetch. `generateSample` copies the
      real ledger's table across; this call covers the case where that table was empty too
      — a first run with no network yet — and the fetch happens in the background.
    */
    void this.services.ensureRates().catch(() => {
      /* Offline is a supported state; the sample still works, in its own currencies. */
    })

    return this.status()
  }

  /**
   * Rebuild the sample from scratch.
   *
   * Deletes the FILE rather than the rows: it is the only way to be sure no trace of a
   * previous generation survives (a category the generator no longer creates, a budget
   * that was renamed), and it is why the sample can never accumulate drift.
   */
  regenerateSample(): LedgerStatus {
    const wasOnSample = this.mode === 'sample'
    if (wasOnSample) {
      /* Close before deleting: Windows will not delete an open database. */
      const previous = this.handle
      this.handle = openDatabase({ dataDir: this.paths.realDir })
      this.services = new Services(this.handle.db)
      this.mode = 'real'
      try {
        previous.close()
      } catch {
        /* best effort */
      }
    }

    for (const suffix of ['', '-wal', '-shm']) {
      const file = `${this.paths.demoPath}${suffix}`
      if (existsSync(file)) rmSync(file, { force: true })
    }

    this.generateSample()
    return wasOnSample ? this.switchTo('sample') : this.status()
  }

  close(): void {
    try {
      this.handle.close()
    } catch {
      /* shutdown */
    }
  }

  /* ------------------------------------------------------------------ */

  private readGeneratedAt(): string | null {
    try {
      const row = this.handle.db
        .prepare("SELECT value FROM settings WHERE key = 'sampleGeneratedAt'")
        .get() as { value?: string } | undefined
      return row?.value ?? null
    } catch {
      return null
    }
  }

  /**
   * Create the sample database and fill it with a year of student life.
   *
   * Written with direct statements rather than through `Services`: this is a bulk load of
   * ~1,600 rows into a throwaway file, and the generator already produces exactly the
   * column values those tables store. The tests read the result back through `Services`,
   * which is what keeps this from drifting away from the real write path.
   */
  private generateSample(): void {
    if (!existsSync(this.paths.demoDir)) mkdirSync(this.paths.demoDir, { recursive: true })
    const handle = openDatabase({ dataDir: this.paths.demoDir })
    try {
      const life = generateStudentLife({ ...defaultDemoWindow(today()), seed: 20_260_401 })
      const db = handle.db
      const stamp = nowIso()

      const insertAccount = db.prepare(
        `INSERT INTO accounts (name, type, currency, opening_balance, color, icon, note, archived, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
      )
      const accountIds = new Map<string, number>()
      life.accounts.forEach((account, index) => {
        const info = insertAccount.run(
          account.name,
          account.type,
          account.currency,
          account.openingBalance,
          account.color,
          account.icon,
          account.note,
          index,
          stamp,
          stamp
        )
        accountIds.set(account.name, Number(info.lastInsertRowid))
      })

      const categoryRows = db.prepare('SELECT id, name, type FROM categories').all() as Array<{
        id: number
        name: string
        type: string
      }>
      const categoryId = (name: string | null, type: 'income' | 'expense'): number | null => {
        if (!name) return null
        /*
          'Other' exists once per type, and a loan repayment is income while the loan was
          an expense — so the lookup is by (name, type), which is also the table's own
          uniqueness rule.
        */
        const direct = categoryRows.find((row) => row.name === name && row.type === type)
        if (direct) return direct.id
        const fallback = categoryRows.find((row) => row.type === type && row.name === 'Other')
        return fallback ? fallback.id : null
      }

      const insertTransaction = db.prepare(
        `INSERT INTO transactions (account_id, type, amount, category_id, date, time, merchant, note, transfer_id, import_batch_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`
      )

      const writeAll = db.transaction(() => {
        for (const row of life.transactions) {
          const accountId = accountIds.get(row.accountName)
          if (accountId === undefined) continue
          const signed = row.type === 'income' ? row.amount : -row.amount
          insertTransaction.run(
            accountId,
            row.type,
            signed,
            categoryId(row.categoryName, row.type),
            row.date,
            row.time,
            row.merchant,
            row.note,
            stamp,
            stamp
          )
        }

        const insertTransfer = db.prepare(
          `INSERT INTO transfers (from_account_id, to_account_id, amount, date, time, note, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        const insertLeg = db.prepare(
          `INSERT INTO transactions (account_id, type, amount, category_id, date, time, merchant, note, transfer_id, import_batch_id, created_at, updated_at)
           VALUES (?, 'transfer', ?, NULL, ?, ?, NULL, ?, ?, NULL, ?, ?)`
        )
        for (const transfer of life.transfers) {
          const from = accountIds.get(transfer.fromAccount)
          const to = accountIds.get(transfer.toAccount)
          if (from === undefined || to === undefined) continue
          const info = insertTransfer.run(
            from,
            to,
            transfer.amount,
            transfer.date,
            transfer.time,
            transfer.note,
            stamp,
            stamp
          )
          const transferId = Number(info.lastInsertRowid)
          insertLeg.run(from, -transfer.amount, transfer.date, transfer.time, transfer.note, transferId, stamp, stamp)
          insertLeg.run(to, transfer.amount, transfer.date, transfer.time, transfer.note, transferId, stamp, stamp)
        }

        const insertSubscription = db.prepare(
          `INSERT INTO subscriptions (name, amount, currency, cycle, next_charge_date, account_id, category_id, active, note, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
        )
        for (const subscription of life.subscriptions) {
          insertSubscription.run(
            subscription.name,
            subscription.amount,
            subscription.currency,
            subscription.cycle,
            subscription.nextChargeDate,
            accountIds.get(subscription.accountName) ?? null,
            categoryId(subscription.categoryName, 'expense'),
            subscription.note,
            stamp,
            stamp
          )
        }

        const insertBudget = db.prepare(
          `INSERT INTO budgets (category_id, period, limit_amount, currency, created_at, updated_at)
           VALUES (?, 'monthly', ?, ?, ?, ?)`
        )
        for (const budget of life.budgets) {
          insertBudget.run(categoryId(budget.categoryName, 'expense'), budget.limitAmount, budget.currency, stamp, stamp)
        }

        const insertRule = db.prepare(
          `INSERT INTO recurring_rules (label, type, amount, account_id, category_id, merchant, note, frequency, day_of_period, month_of_year, last_run_date, next_due_date, active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, 1, ?, ?)`
        )
        for (const rule of life.recurringRules) {
          insertRule.run(
            rule.label,
            rule.type,
            rule.amount,
            accountIds.get(rule.accountName) ?? null,
            categoryId(rule.categoryName, rule.type),
            rule.merchant,
            rule.frequency,
            rule.dayOfPeriod,
            rule.monthOfYear,
            addMonths(today(), 1),
            stamp,
            stamp
          )
        }

        db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('sampleGeneratedAt', ?, ?)").run(
          stamp,
          stamp
        )
        db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('demoDataLoaded', 'true', ?)").run(stamp)

        /*
          --- the exchange rates, copied from the user's own ledger -------------

          Rates live in each database, so a freshly generated sample has none and every
          converted figure in it reads "无汇率" — the sample's whole point is to show what
          the screens look like when they work.

          The copy is READ-ONLY on the source side: a second connection opened with
          `readonly: true`, which cannot write to the user's file even by accident. Rates
          are a cache of public data, not the user's records, so copying them is not
          copying anything of theirs.
        */
        if (existsSync(this.paths.realPath)) {
          const real = new Database(this.paths.realPath, { readonly: true, fileMustExist: true })
          try {
            const rates = real.prepare('SELECT * FROM exchange_rates').all() as Array<Record<string, unknown>>
            const meta = real.prepare('SELECT * FROM exchange_rate_meta').all() as Array<Record<string, unknown>>
            const rateColumns = Object.keys(rates[0] ?? {})
            if (rates.length > 0 && rateColumns.length > 0) {
              const placeholders = rateColumns.map(() => '?').join(', ')
              const insert = db.prepare(
                `INSERT OR REPLACE INTO exchange_rates (${rateColumns.join(', ')}) VALUES (${placeholders})`
              )
              for (const row of rates) insert.run(...rateColumns.map((column) => row[column] as never))
            }
            const metaColumns = Object.keys(meta[0] ?? {})
            if (meta.length > 0 && metaColumns.length > 0) {
              const placeholders = metaColumns.map(() => '?').join(', ')
              const insert = db.prepare(
                `INSERT OR REPLACE INTO exchange_rate_meta (${metaColumns.join(', ')}) VALUES (${placeholders})`
              )
              for (const row of meta) insert.run(...metaColumns.map((column) => row[column] as never))
            }
          } catch {
            /* A missing or older rate table is fine: the app fetches its own. */
          } finally {
            real.close()
          }
        }
      })
      writeAll()
    } finally {
      handle.close()
    }
  }
}
