import { existsSync, mkdirSync, copyFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import type { Database as SqliteDatabase } from 'better-sqlite3'
import { AppError, toAppError } from './errors'
import { MIGRATION_1 } from './migrations/001-initial'
import { MIGRATION_2 } from './migrations/002-multi-currency'
import { SEED_CATEGORIES } from '@shared/constants/categories'
import { nowIso } from '@shared/lib/dates'

/**
 * SQLite connection management.
 *
 * WHERE THE DATABASE LIVES (spec §5)
 * ---------------------------------
 * The file is created in the OS application-data directory, passed in from
 * `app.getPath('userData')` by the main process. In production that resolves to:
 *
 *     C:\Users\<user>\AppData\Roaming\SpendWise\spendwise.db
 *
 * It is deliberately NOT inside the project directory or next to the .exe:
 *   - an installed app's program-files directory may be read-only;
 *   - a database beside the executable is trivially exposed to anyone browsing
 *     the install folder;
 *   - uninstalling or reinstalling should not destroy a user's financial history.
 *
 * WAL mode is enabled so a long read (statistics over a year) cannot block a
 * write (adding a transaction). `synchronous = NORMAL` is the documented safe
 * pairing with WAL for an app like this.
 */

export interface OpenDatabaseOptions {
  /** Directory that holds the database file. Created if missing. */
  dataDir: string
  fileName?: string
  /** Open in-memory instead of on disk. Used by tests. */
  inMemory?: boolean
  /** Skip category seeding. Used by tests that assert an empty database. */
  skipSeed?: boolean
}

export interface DatabaseHandle {
  db: SqliteDatabase
  path: string
  dataDir: string
  close: () => void
}

const MIGRATIONS: ReadonlyArray<{ version: number; name: string; sql: string }> = [
  { version: 1, name: 'initial', sql: MIGRATION_1 },
  { version: 2, name: 'multi-currency', sql: MIGRATION_2 }
]

export function openDatabase(options: OpenDatabaseOptions): DatabaseHandle {
  const fileName = options.fileName ?? 'spendwise.db'
  const dataDir = options.dataDir

  if (!options.inMemory) {
    // A missing userData directory is normal on very first launch.
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
  }

  const dbPath = options.inMemory ? ':memory:' : join(dataDir, fileName)

  let db: SqliteDatabase
  try {
    db = new Database(dbPath)
  } catch (error) {
    throw new AppError(
      'DB_ERROR',
      `The database at ${dbPath} could not be opened. Check that the folder is writable and that the file is not in use by another program.`,
      { cause: error }
    )
  }

  try {
    configure(db, options.inMemory === true)
    migrate(db, options.skipSeed === true)
  } catch (error) {
    try {
      db.close()
    } catch {
      /* the original error is what matters */
    }
    throw toAppError(error)
  }

  return {
    db,
    path: dbPath,
    dataDir,
    close: () => {
      try {
        // Fold the WAL back into the main file so a copied .db is complete.
        db.pragma('wal_checkpoint(TRUNCATE)')
      } catch {
        /* checkpoint is best-effort */
      }
      db.close()
    }
  }
}

function configure(db: SqliteDatabase, inMemory: boolean): void {
  // Foreign keys are OFF by default in SQLite; every ON DELETE rule in the
  // schema depends on this being enabled, per-connection, every time.
  db.pragma('foreign_keys = ON')

  if (!inMemory) {
    db.pragma('journal_mode = WAL')
    // Safe with WAL, and dramatically faster than FULL for many small writes.
    db.pragma('synchronous = NORMAL')
    // Wait rather than immediately throwing SQLITE_BUSY if another connection
    // (e.g. a backup copy) holds a lock.
    db.pragma('busy_timeout = 5000')
  }

  // Keep temporary tables (used by statistics grouping) in memory.
  db.pragma('temp_store = MEMORY')
}

function getUserVersion(db: SqliteDatabase): number {
  const row = db.pragma('user_version', { simple: true })
  return typeof row === 'number' ? row : 0
}

/**
 * Apply pending migrations inside a transaction, then seed reference data.
 *
 * `user_version` is SQLite's built-in per-file integer slot, so no bookkeeping
 * table is strictly required; `schema_migrations` is kept as a human-readable
 * audit trail of what ran and when.
 */
function migrate(db: SqliteDatabase, skipSeed: boolean): void {
  const current = getUserVersion(db)
  const pending = MIGRATIONS.filter((m) => m.version > current).sort((a, b) => a.version - b.version)

  for (const migration of pending) {
    const run = db.transaction(() => {
      db.exec(migration.sql)
      db.prepare('INSERT OR REPLACE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        nowIso()
      )
      // PRAGMA cannot be parameterised, and `version` is an integer literal from
      // our own constant list, never user input.
      db.pragma(`user_version = ${migration.version}`)
    })

    try {
      run()
    } catch (error) {
      throw new AppError(
        'DB_ERROR',
        `Database migration "${migration.name}" failed, so no changes were made. ${error instanceof Error ? error.message : ''}`.trim(),
        { cause: error }
      )
    }
  }

  if (!skipSeed) seedCategories(db)
}

/**
 * Insert the preset categories (spec §4) if they are absent.
 *
 * Uses INSERT OR IGNORE against the (name, type) unique index so this is
 * idempotent: running it on an existing database will not duplicate rows, and a
 * user who deleted "Travel" will simply get it back on the next upgrade rather
 * than being unable to use the app. User-created categories are never touched.
 */
function seedCategories(db: SqliteDatabase): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO categories (name, type, icon, color, is_system, sort_order, created_at)
     VALUES (@name, @type, @icon, @color, 1, @sortOrder, @createdAt)`
  )

  const run = db.transaction(() => {
    const createdAt = nowIso()
    SEED_CATEGORIES.forEach((category, index) => {
      insert.run({
        name: category.name,
        type: category.type,
        icon: category.icon,
        color: category.color,
        sortOrder: index,
        createdAt
      })
    })
  })

  run()
}

/**
 * Copy the database to `destination`, producing a consistent single-file backup.
 *
 * `VACUUM INTO` is used instead of a filesystem copy because it asks SQLite to
 * write a complete, defragmented snapshot. Copying the .db file directly while
 * WAL mode is active would produce a backup missing everything still in the
 * write-ahead log.
 */
export function backupDatabase(db: SqliteDatabase, destination: string): void {
  const parent = dirname(destination)
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true })
  if (existsSync(destination)) {
    throw new AppError('FILE_IO', `A file already exists at ${destination}. Choose a different location.`)
  }
  try {
    // The path is bound as a parameter, so quotes inside it cannot break out.
    db.prepare('VACUUM INTO ?').run(destination)
  } catch (error) {
    throw new AppError(
      'FILE_IO',
      `The backup could not be written to ${destination}. ${error instanceof Error ? error.message : ''}`.trim(),
      { cause: error }
    )
  }
}

export function databaseFileSize(path: string): number {
  try {
    return existsSync(path) ? statSync(path).size : 0
  } catch {
    return 0
  }
}

/**
 * Snapshot the live database to a side file before a destructive operation
 * (restore, demo-data reset). If the operation goes wrong the user still has
 * a valid database on disk.
 */
export function snapshotBeforeDestructiveChange(db: SqliteDatabase, dataDir: string, label: string): string {
  const stamp = nowIso().replace(/[:.]/g, '-')
  const target = join(dataDir, `pre-${label}-${stamp}.db`)
  backupDatabase(db, target)
  return target
}

export { copyFileSync }
