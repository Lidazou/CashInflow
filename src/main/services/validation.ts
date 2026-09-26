import { ValidationError } from '@main/database/errors'
import { ACCOUNT_TYPES, type AccountInput, type AccountType } from '@shared/types'
import { DEFAULT_CURRENCY, isSupportedCurrency } from '@shared/lib/money'
import { isValidDateString } from '@shared/lib/dates'

/**
 * Input validation.
 *
 * The spec requires that every input is validated (spec §34) and that invalid
 * data never reaches the database. All functions here collect *every* problem
 * rather than throwing on the first one, so a form can highlight all offending
 * fields in a single pass instead of making the user resubmit repeatedly.
 *
 * These run in the MAIN process, not the renderer. Renderer-side validation is a
 * convenience for the user; this is the boundary that actually protects the
 * ledger, because the renderer is the untrusted side of the IPC bridge.
 */

export interface FieldErrors {
  [field: string]: string
}

/**
 * Throw a single ValidationError carrying every field problem.
 *
 * The message concatenates the individual field errors rather than replacing
 * them with a generic "some details are invalid". A user who is told only that
 * *something* is wrong has to hunt for it; and a caller that logs the error
 * would otherwise lose the actual reason entirely. The structured `fields` map
 * is still attached for form highlighting.
 */
export function assertNoErrors(errors: FieldErrors, summary = 'Please correct the highlighted fields.'): void {
  const fields = Object.keys(errors)
  if (fields.length === 0) return
  const detail = fields.map((field) => errors[field]).join(' ')
  throw new ValidationError(detail ? `${summary} ${detail}` : summary, errors)
}

export function requireText(
  errors: FieldErrors,
  field: string,
  value: unknown,
  { label, max = 200, required = true }: { label: string; max?: number; required?: boolean }
): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) {
    if (required) errors[field] = `${label} is required.`
    return ''
  }
  if (text.length > max) errors[field] = `${label} must be ${max} characters or fewer.`
  return text
}

/**
 * Amounts arrive as integer minor units already (the renderer parses text with
 * parseAmountToMinor). This checks the *domain* rules: presence, integrality and
 * finiteness — never float rounding.
 */
export function requireAmount(
  errors: FieldErrors,
  field: string,
  value: unknown,
  { label = 'Amount', allowZero = false, allowNegative = false } = {}
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors[field] = `${label} is required.`
    return 0
  }
  if (!Number.isInteger(value)) {
    // A non-integer here means a float slipped through from the renderer, which
    // would reintroduce exactly the precision loss the integer design prevents.
    errors[field] = `${label} must be a whole number of minor units.`
    return 0
  }
  if (value === 0 && !allowZero) {
    errors[field] = `${label} must be greater than zero.`
    return 0
  }
  if (value < 0 && !allowNegative) {
    errors[field] = `${label} cannot be negative.`
    return 0
  }
  if (Math.abs(value) > Number.MAX_SAFE_INTEGER / 4) {
    errors[field] = `${label} is unrealistically large.`
    return 0
  }
  return value
}

export function requireId(errors: FieldErrors, field: string, value: unknown, { label }: { label: string }): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    errors[field] = `${label} must be selected.`
    return 0
  }
  return value
}

export function requireDate(errors: FieldErrors, field: string, value: unknown, { label = 'Date' } = {}): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) {
    errors[field] = `${label} is required.`
    return ''
  }
  if (!isValidDateString(text)) {
    errors[field] = `${label} must be a valid date (YYYY-MM-DD).`
    return ''
  }
  return text
}

export function optionalDate(
  errors: FieldErrors,
  field: string,
  value: unknown,
  { label = 'Date' } = {}
): string | null {
  if (value === null || value === undefined || value === '') return null
  const text = typeof value === 'string' ? value.trim() : ''
  if (!isValidDateString(text)) {
    errors[field] = `${label} must be a valid date (YYYY-MM-DD).`
    return null
  }
  return text
}

export function optionalTime(errors: FieldErrors, field: string, value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  const text = typeof value === 'string' ? value.trim() : ''
  if (!/^([01]?\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(text)) {
    errors[field] = 'Time must be in HH:MM format.'
    return null
  }
  const [h, m] = text.split(':')
  return `${h.padStart(2, '0')}:${m}`
}

export function requireEnum<T extends string>(
  errors: FieldErrors,
  field: string,
  value: unknown,
  allowed: readonly T[],
  { label }: { label: string }
): T {
  const text = typeof value === 'string' ? value : ''
  if (!allowed.includes(text as T)) {
    errors[field] = `${label} must be one of: ${allowed.join(', ')}.`
    return allowed[0]
  }
  return text as T
}

export function optionalText(
  errors: FieldErrors,
  field: string,
  value: unknown,
  { label, max = 500 }: { label: string; max?: number }
): string | null {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  if (!text) return null
  if (text.length > max) errors[field] = `${label} must be ${max} characters or fewer.`
  return text
}

export function requireCurrency(errors: FieldErrors, field: string, value: unknown): string {
  const text = typeof value === 'string' && value.trim() ? value.trim().toUpperCase() : DEFAULT_CURRENCY
  if (!isSupportedCurrency(text)) {
    errors[field] = `Unsupported currency "${text}".`
    return DEFAULT_CURRENCY
  }
  return text
}

// ---------------------------------------------------------------------------
// Entity validators
// ---------------------------------------------------------------------------

export interface ValidatedAccountInput {
  name: string
  type: AccountType
  currency: string
  openingBalance: number
  color: string
  icon: string
  note: string | null
  archived: boolean
  sortOrder: number
}

export function validateAccountInput(input: Partial<AccountInput>): ValidatedAccountInput {
  const errors: FieldErrors = {}

  const name = requireText(errors, 'name', input.name, { label: 'Account name', max: 60 })
  const type = requireEnum(errors, 'type', input.type, ACCOUNT_TYPES, { label: 'Account type' })
  const currency = requireCurrency(errors, 'currency', input.currency)
  // Opening balance may legitimately be zero or negative (a credit card).
  const openingBalance = requireAmount(errors, 'openingBalance', input.openingBalance ?? 0, {
    label: 'Opening balance',
    allowZero: true,
    allowNegative: true
  })
  const note = optionalText(errors, 'note', input.note, { label: 'Note', max: 300 })

  assertNoErrors(errors, 'The account could not be saved because some details are invalid.')

  return {
    name,
    type,
    currency,
    openingBalance,
    color: typeof input.color === 'string' && /^#[0-9a-f]{6}$/i.test(input.color) ? input.color : '#6B7280',
    icon: typeof input.icon === 'string' && input.icon ? input.icon : 'wallet',
    note,
    archived: input.archived === true,
    sortOrder: typeof input.sortOrder === 'number' && Number.isInteger(input.sortOrder) ? input.sortOrder : 0
  }
}
