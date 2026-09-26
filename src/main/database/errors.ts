/**
 * Error types shared by the data layer.
 *
 * Every failure that can reach the user carries a stable `code` (so the UI can
 * branch), a human message (so the UI can display something truthful) and, for
 * validation failures, a per-field map (so forms can highlight the exact input).
 *
 * Nothing in this app is allowed to fail silently. The spec is explicit: no
 * `console.log` and pretend it worked, no `undefined` leaking into the UI.
 */

export type AppErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'IN_USE'
  | 'DB_ERROR'
  | 'DB_LOCKED'
  | 'IMPORT_PARSE'
  | 'IMPORT_FORMAT'
  | 'FILE_IO'
  | 'UNSUPPORTED'
  | 'INTERNAL'

export class AppError extends Error {
  readonly code: AppErrorCode
  readonly fields?: Record<string, string>
  override readonly cause?: unknown

  constructor(code: AppErrorCode, message: string, options: { fields?: Record<string, string>; cause?: unknown } = {}) {
    super(message)
    this.name = 'AppError'
    this.code = code
    if (options.fields) this.fields = options.fields
    if (options.cause !== undefined) this.cause = options.cause
  }

  toStored(): { code: AppErrorCode; message: string; fields?: Record<string, string> } {
    return this.fields
      ? { code: this.code, message: this.message, fields: this.fields }
      : { code: this.code, message: this.message }
  }
}

/** A user-facing input problem. */
export class ValidationError extends AppError {
  constructor(message: string, fields?: Record<string, string>) {
    super('VALIDATION', message, fields ? { fields } : {})
    this.name = 'ValidationError'
  }
}

export class NotFoundError extends AppError {
  constructor(what: string, id?: number | string) {
    super('NOT_FOUND', id === undefined ? `${what} not found.` : `${what} #${id} was not found.`)
    this.name = 'NotFoundError'
  }
}

/** The request conflicts with existing data (duplicate name, etc.). */
export class ConflictError extends AppError {
  constructor(message: string, fields?: Record<string, string>) {
    super('CONFLICT', message, fields ? { fields } : {})
    this.name = 'ConflictError'
  }
}

/** The record is referenced by other data and cannot be removed as requested. */
export class InUseError extends AppError {
  constructor(message: string, fields?: Record<string, string>) {
    super('IN_USE', message, fields ? { fields } : {})
    this.name = 'InUseError'
  }
}

export class ImportError extends AppError {
  constructor(message: string, code: AppErrorCode = 'IMPORT_PARSE') {
    super(code, message)
    this.name = 'ImportError'
  }
}

export class FileError extends AppError {
  constructor(message: string, cause?: unknown) {
    super('FILE_IO', message, cause !== undefined ? { cause } : {})
    this.name = 'FileError'
  }
}

/**
 * Convert an unknown thrown value into an AppError.
 *
 * SQLite constraint violations are mapped to meaningful codes so the UI can say
 * "an account with that name already exists" rather than surfacing
 * "SQLITE_CONSTRAINT_UNIQUE: UNIQUE constraint failed: accounts.name".
 */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error

  const raw = error instanceof Error ? error.message : String(error)

  if (/UNIQUE constraint failed/i.test(raw)) {
    const target = /UNIQUE constraint failed:\s*(.+)$/im.exec(raw)?.[1]?.trim()
    return new ConflictError(
      target ? `That value is already in use (${target.replace(/\s*,\s*/g, ', ')}).` : 'That value is already in use.',
      target ? { [target.split(',')[0]?.trim().split('.').pop() ?? 'value']: 'Already in use' } : undefined
    )
  }
  if (/FOREIGN KEY constraint failed/i.test(raw)) {
    return new AppError('IN_USE', 'This record is still referenced by other data, so it cannot be removed.')
  }
  if (/CHECK constraint failed/i.test(raw)) {
    return new ValidationError('The data did not pass a consistency check, so nothing was saved.')
  }
  if (/database is locked|SQLITE_BUSY/i.test(raw)) {
    return new AppError('DB_LOCKED', 'The database is busy. Please try again in a moment.')
  }
  if (/NOT NULL constraint failed/i.test(raw)) {
    return new ValidationError('A required field was missing, so nothing was saved.')
  }
  return new AppError('DB_ERROR', raw || 'The database operation failed.', { cause: error })
}
