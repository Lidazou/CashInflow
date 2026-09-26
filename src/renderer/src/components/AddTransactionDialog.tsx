import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@renderer/store/app'
import { useRateStore } from '@renderer/store/rates'
import { useUiStore } from '@renderer/store/ui'
import { useAction, useAsync } from '@renderer/hooks/useData'
import { Icon } from '@renderer/components/Icon'
import { Money } from '@renderer/components/Money'
import { formatMoney, getCurrency, parseAmountToMinor } from '@shared/lib/money'
import { addDays, today } from '@shared/lib/dates'
import { T, categoryLabel, dateHeadingZh, transactionTypeLabel } from '@shared/lib/i18n'
import type { AccountWithBalance, Category, TransactionWithRefs } from '@shared/types'

/**
 * 记一笔 / 编辑交易 (spec §13, §14).
 *
 * One dialog handles all three kinds, because the user picks the kind first and
 * the fields then differ only slightly. Splitting this into three separate forms
 * would triple the validation logic and let them drift apart.
 *
 * MONEY HANDLING: the amount field is a TEXT input converted with
 * `parseAmountToMinor`, which does string arithmetic. `parseFloat('18.50') * 100`
 * is 1850.0000000000002 for some values, and the rounding needed to fix that is
 * exactly what silently corrupts amounts like 1.005. Amounts are typed in the
 * SELECTED ACCOUNT's currency and stored in it, so the ledger always records the
 * unit the money actually moved in.
 *
 * VALIDATION happens twice on purpose: client-side for immediate feedback, and
 * again in the main process, because the renderer is the untrusted side of the
 * IPC bridge. The main process is the authority, and its field errors render
 * inline against the matching input.
 */

type Kind = 'income' | 'expense' | 'transfer'

interface FormState {
  kind: Kind
  amountText: string
  accountId: number | null
  toAccountId: number | null
  categoryId: number | null
  date: string
  time: string
  merchant: string
  note: string
}

/** Quick-date buttons, because most entries are for today or yesterday. */
const QUICK_DATES: Array<{ label: string; offset: number }> = [
  { label: T.today, offset: 0 },
  { label: T.txdYesterday, offset: -1 },
  { label: T.txdDayBefore, offset: -2 }
]

function emptyForm(): FormState {
  const now = new Date()
  return {
    kind: 'expense',
    amountText: '',
    accountId: null,
    toAccountId: null,
    categoryId: null,
    date: today(),
    time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
    merchant: '',
    note: ''
  }
}

export function AddTransactionDialog(): React.JSX.Element | null {
  const dialog = useUiStore((state) => state.transactionDialog)
  const close = useUiStore((state) => state.closeTransactionDialog)
  const refreshData = useAppStore((state) => state.refreshData)
  const dateFormat = useAppStore((state) => state.settings?.dateFormat ?? 'DD MMM YYYY')
  const { run, pending } = useAction()

  const displayCurrency = useRateStore((state) => state.displayCurrency)

  const open = dialog.kind !== 'closed'

  const { data: accounts } = useAsync<AccountWithBalance[]>(() => window.api.accountsList(), [open])
  const { data: categories } = useAsync<Category[]>(() => window.api.categoriesList(), [open])

  const [form, setForm] = useState<FormState>(emptyForm)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)

  const amountRef = useRef<HTMLInputElement>(null)

  /**
   * Seed the form whenever the dialog opens.
   *
   * For an edit, the amount is rebuilt from the stored integer so the user sees
   * exactly what is recorded — deriving it from a float would risk showing
   * 18.499999 for a stored 1850.
   */
  useEffect(() => {
    if (dialog.kind === 'closed') return

    setFieldErrors({})
    setFormError(null)

    if (dialog.kind === 'create') {
      const base = emptyForm()
      setForm({ ...base, kind: dialog.initialType ?? 'expense' })
      return
    }

    const transaction: TransactionWithRefs = dialog.transaction
    const isTransfer = transaction.type === 'transfer'

    setForm({
      kind: transaction.type,
      amountText: formatAmountForInput(Math.abs(transaction.amount), transaction.accountCurrency),
      accountId: transaction.accountId,
      toAccountId: isTransfer ? transaction.counterpartAccountId : null,
      categoryId: transaction.categoryId,
      date: transaction.date,
      time: transaction.time ?? '',
      merchant: transaction.merchant ?? '',
      note: transaction.note ?? ''
    })
  }, [dialog])

  // Focus the amount field as soon as the dialog opens: it is the field the user
  // almost always wants, and this makes the whole flow keyboard-only.
  useEffect(() => {
    if (!open) return
    const id = window.setTimeout(() => amountRef.current?.focus(), 30)
    return () => window.clearTimeout(id)
  }, [open, dialog.kind])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, close])

  const account = useMemo(() => accounts?.find((item) => item.id === form.accountId) ?? null, [accounts, form.accountId])

  // The amount is entered in the account's own currency. Falling back to the
  // display currency before an account is chosen keeps the symbol sensible.
  const entryCurrency = account?.currency ?? displayCurrency

  const relevantCategories = useMemo(() => {
    if (form.kind === 'transfer') return []
    return (categories ?? []).filter((category) => category.type === form.kind)
  }, [categories, form.kind])

  if (!open) return null

  const isEditing = dialog.kind === 'edit' || dialog.kind === 'editTransfer'
  const isTransfer = form.kind === 'transfer'

  function update<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((previous) => ({ ...previous, [key]: value }))
    setFieldErrors((previous) => {
      if (!(key in previous)) return previous
      const next = { ...previous }
      delete next[key]
      return next
    })
  }

  function validate(): string | null {
    const errors: Record<string, string> = {}

    const minor = parseAmountToMinor(form.amountText, entryCurrency)
    if (form.amountText.trim() === '') errors.amountText = T.txdErrAmountRequired
    else if (minor === null) errors.amountText = T.txdErrAmountInvalid
    else if (minor <= 0) errors.amountText = T.txdErrAmountPositive

    if (form.accountId === null) errors.accountId = T.txdErrAccountRequired
    if (!form.date) errors.date = T.txdErrDateRequired

    if (isTransfer) {
      if (form.toAccountId === null) errors.toAccountId = T.txdErrToAccountRequired
      else if (form.toAccountId === form.accountId) errors.toAccountId = T.txdErrSameAccount
    }

    setFieldErrors(errors)
    return Object.keys(errors).length > 0 ? T.txdErrFixFields : null
  }

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    setFormError(null)

    const clientError = validate()
    if (clientError) {
      setFormError(clientError)
      return
    }

    const minor = parseAmountToMinor(form.amountText, entryCurrency)
    if (minor === null) return

    const result = await run(
      async () => {
        if (isTransfer) {
          const payload = {
            fromAccountId: form.accountId as number,
            toAccountId: form.toAccountId as number,
            amount: minor,
            date: form.date,
            time: form.time || null,
            note: form.note.trim() || null
          }
          return isEditing && dialog.kind === 'editTransfer'
            ? window.api.transactionsTransferUpdate(dialog.transaction.id, payload)
            : window.api.transactionsTransfer(payload)
        }

        const payload = {
          accountId: form.accountId as number,
          type: form.kind,
          amount: minor,
          categoryId: form.categoryId,
          date: form.date,
          time: form.time || null,
          merchant: form.merchant.trim() || null,
          note: form.note.trim() || null
        }
        return isEditing && dialog.kind === 'edit'
          ? window.api.transactionsUpdate(dialog.transaction.id, payload)
          : window.api.transactionsCreate(payload)
      },
      {
        successMessage: isTransfer
          ? isEditing
            ? T.txdUpdatedTransfer
            : T.txdSavedTransfer
          : isEditing
            ? T.txdUpdatedTransaction
            : T.txdSavedTransaction
      }
    )

    if (result === null) {
      // Already toasted by useAction; also surface it inside the dialog so the
      // user is not left looking at an apparently saved form.
      setFormError(T.txdErrSaveFailed)
      return
    }

    refreshData()
    close()
  }

  /** Preview of what the stored amount equals in the display currency. */
  const convertedPreview = (() => {
    const minor = parseAmountToMinor(form.amountText, entryCurrency)
    if (minor === null || minor <= 0) return null
    if (entryCurrency.toUpperCase() === displayCurrency.toUpperCase()) return null
    return { minor, from: entryCurrency, to: displayCurrency }
  })()

  return (
    <div
      className="tx-overlay"
      role="presentation"
      onMouseDown={(event) => {
        // Only close when the backdrop itself was clicked, not a click that
        // started inside the panel and drifted out.
        if (event.target === event.currentTarget) close()
      }}
    >
      <div className="tx-dialog" role="dialog" aria-modal="true" aria-labelledby="tx-dialog-title">
        <header className="tx-dialog__head">
          <h2 id="tx-dialog-title" className="tx-dialog__title">
            {isEditing
              ? isTransfer
                ? T.txdTitleEditTransfer
                : T.txdTitleEdit
              : isTransfer
                ? T.txdTitleCreateTransfer
                : T.txdTitleCreate}
          </h2>
          <button type="button" className="btn btn-ghost btn-icon" onClick={close} aria-label={T.txdCloseDialog}>
            <Icon name="close" />
          </button>
        </header>

        {!isEditing ? (
          <div className="tx-kinds" role="tablist" aria-label={T.txdKindLabel}>
            {(['expense', 'income', 'transfer'] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                role="tab"
                aria-selected={form.kind === kind}
                className={`tx-kind ${form.kind === kind ? 'is-active' : ''}`}
                onClick={() => {
                  // Category types differ per kind, so a stale selection would be
                  // rejected by the backend as a type mismatch.
                  setForm((previous) => ({ ...previous, kind, categoryId: null }))
                  setFieldErrors({})
                }}
              >
                {transactionTypeLabel(kind)}
              </button>
            ))}
          </div>
        ) : null}

        <form className="tx-form" onSubmit={handleSubmit} noValidate>
          {/* --- amount ---------------------------------------------------- */}
          <div className="field tx-amount-field">
            <label className="field-label" htmlFor="tx-amount">
              {T.amount}
              <span className="muted">（{getCurrency(entryCurrency).symbol} {entryCurrency}）</span>
            </label>
            <div className={`tx-amount ${fieldErrors.amountText ? 'is-invalid' : ''}`}>
              <span className="tx-amount__symbol" aria-hidden="true">
                {getCurrency(entryCurrency).symbol}
              </span>
              <input
                id="tx-amount"
                ref={amountRef}
                className="tx-amount__input"
                inputMode="decimal"
                autoComplete="off"
                placeholder={T.txdAmountPlaceholder}
                value={form.amountText}
                aria-invalid={Boolean(fieldErrors.amountText)}
                aria-describedby={fieldErrors.amountText ? 'tx-amount-error' : undefined}
                onChange={(event) => update('amountText', event.target.value)}
              />
            </div>
            {fieldErrors.amountText ? (
              <p className="field-error" id="tx-amount-error">
                {fieldErrors.amountText}
              </p>
            ) : convertedPreview ? (
              <p className="field-hint">
                {T.txdApprox}{' '}
                <Money minor={convertedPreview.minor} currency={convertedPreview.from} convert target={convertedPreview.to} />
                <span className="muted">{T.txdApproxHint}</span>
              </p>
            ) : null}
          </div>

          {/* --- accounts -------------------------------------------------- */}
          <div className="tx-grid">
            <div className="field">
              <label className="field-label" htmlFor="tx-account">
                {isTransfer ? T.txdFromAccount : T.txdAccount}
              </label>
              <select
                id="tx-account"
                className="select"
                value={form.accountId ?? ''}
                aria-invalid={Boolean(fieldErrors.accountId)}
                onChange={(event) => update('accountId', event.target.value ? Number(event.target.value) : null)}
              >
                <option value="">{T.txdSelectAccount}</option>
                {(accounts ?? []).map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} · {formatMoney(item.balance, item.currency)}
                  </option>
                ))}
              </select>
              {fieldErrors.accountId ? <p className="field-error">{fieldErrors.accountId}</p> : null}
            </div>

            {isTransfer ? (
              <div className="field">
                <label className="field-label" htmlFor="tx-to-account">
                  {T.txdToAccount}
                </label>
                <select
                  id="tx-to-account"
                  className="select"
                  value={form.toAccountId ?? ''}
                  aria-invalid={Boolean(fieldErrors.toAccountId)}
                  onChange={(event) => update('toAccountId', event.target.value ? Number(event.target.value) : null)}
                >
                  <option value="">{T.txdSelectAccount}</option>
                  {(accounts ?? [])
                    // Transferring to the same account is meaningless; hide it
                    // rather than only rejecting it on submit.
                    .filter((item) => item.id !== form.accountId)
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name} · {formatMoney(item.balance, item.currency)}
                      </option>
                    ))}
                </select>
                {fieldErrors.toAccountId ? <p className="field-error">{fieldErrors.toAccountId}</p> : null}
              </div>
            ) : (
              <div className="field">
                <label className="field-label" htmlFor="tx-category">
                  {T.txdCategory}
                </label>
                <select
                  id="tx-category"
                  className="select"
                  value={form.categoryId ?? ''}
                  aria-invalid={Boolean(fieldErrors.categoryId)}
                  onChange={(event) => update('categoryId', event.target.value ? Number(event.target.value) : null)}
                >
                  <option value="">{categoryLabel(null)}</option>
                  {relevantCategories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {categoryLabel(category.name)}
                    </option>
                  ))}
                </select>
                {fieldErrors.categoryId ? <p className="field-error">{fieldErrors.categoryId}</p> : null}
              </div>
            )}
          </div>

          {/* --- date and time --------------------------------------------- */}
          <div className="tx-grid">
            <div className="field">
              <label className="field-label" htmlFor="tx-date">
                {T.txdDate}
              </label>
              <input
                id="tx-date"
                type="date"
                className="input"
                value={form.date}
                aria-invalid={Boolean(fieldErrors.date)}
                onChange={(event) => update('date', event.target.value)}
              />
              <div className="tx-quickdates">
                {QUICK_DATES.map((quick) => {
                  const value = addDays(today(), quick.offset)
                  return (
                    <button
                      key={quick.label}
                      type="button"
                      className={`tx-quickdate ${form.date === value ? 'is-active' : ''}`}
                      onClick={() => update('date', value)}
                    >
                      {quick.label}
                    </button>
                  )
                })}
                <span className="muted tx-quickdate-hint">{dateHeadingZh(form.date, dateFormat)}</span>
              </div>
              {fieldErrors.date ? <p className="field-error">{fieldErrors.date}</p> : null}
            </div>

            <div className="field">
              <label className="field-label" htmlFor="tx-time">
                {T.txdTime} <span className="muted">{T.txdOptional}</span>
              </label>
              <input
                id="tx-time"
                type="time"
                className="input"
                value={form.time}
                onChange={(event) => update('time', event.target.value)}
              />
            </div>
          </div>

          {/* --- merchant and note ---------------------------------------- */}
          {!isTransfer ? (
            <div className="field">
              <label className="field-label" htmlFor="tx-merchant">
                {T.txdMerchant} <span className="muted">{T.txdOptional}</span>
              </label>
              <input
                id="tx-merchant"
                className="input"
                placeholder={T.txdMerchantPlaceholder}
                maxLength={120}
                value={form.merchant}
                onChange={(event) => update('merchant', event.target.value)}
              />
            </div>
          ) : null}

          <div className="field">
            <label className="field-label" htmlFor="tx-note">
              {T.txdNote} <span className="muted">{T.txdOptional}</span>
            </label>
            <textarea
              id="tx-note"
              className="textarea"
              rows={2}
              maxLength={500}
              placeholder={isTransfer ? T.txdTransferNotePlaceholder : T.txdNotePlaceholder}
              value={form.note}
              onChange={(event) => update('note', event.target.value)}
            />
          </div>

          {isTransfer ? (
            <p className="tx-note-hint">
              <Icon name="arrow-left-right" size={16} />
              <span>{T.txdTransferHint}</span>
            </p>
          ) : null}

          {formError ? (
            <p className="tx-form-error" role="alert">
              <Icon name="alert" size={16} />
              <span>{formError}</span>
            </p>
          ) : null}

          <footer className="tx-dialog__foot">
            <button type="button" className="btn btn-secondary" onClick={close} disabled={pending}>
              {T.cancel}
            </button>
            <button type="submit" className="btn btn-primary" disabled={pending}>
              {pending
                ? T.txdSaving
                : isEditing
                  ? T.txdSaveChanges
                  : isTransfer
                    ? T.txdSaveTransfer
                    : T.txdSaveTransaction}
            </button>
          </footer>
        </form>
      </div>

      <style>{DIALOG_CSS}</style>
    </div>
  )
}

/** Rebuild a decimal string from stored integer minor units, for the input box. */
function formatAmountForInput(minor: number, currency: string): string {
  const decimals = getCurrency(currency).minorUnits
  if (decimals === 0) return String(minor)
  const scale = 10 ** decimals
  const whole = Math.floor(minor / scale)
  const frac = String(minor % scale).padStart(decimals, '0')
  return `${whole}.${frac}`
}

/**
 * Scoped styles for the dialog.
 *
 * Inline because the project has no per-component stylesheet. Every colour is a
 * token so dark mode works without a second set of rules.
 */
const DIALOG_CSS = `
.tx-overlay {
  position: fixed;
  inset: 0;
  background: rgba(15, 15, 15, 0.42);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 6vh var(--space-6) var(--space-6);
  z-index: 60;
  overflow-y: auto;
}
.tx-dialog {
  width: 100%;
  max-width: 560px;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-md);
  padding: var(--space-6);
  animation: tx-in var(--duration-base) var(--ease-out);
}
@keyframes tx-in {
  from { opacity: 0; transform: translateY(-6px); }
  to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  .tx-dialog { animation: none; }
}
.tx-dialog__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  margin-bottom: var(--space-5);
}
.tx-dialog__title {
  font-size: var(--text-lg);
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
  margin: 0;
}
.tx-kinds {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--space-1);
  background: var(--bg-inset);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  padding: 3px;
  margin-bottom: var(--space-5);
}
.tx-kind {
  appearance: none;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-weight: var(--weight-medium);
  font-size: var(--text-sm);
  padding: 7px 10px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out);
}
.tx-kind:hover { color: var(--text-primary); }
.tx-kind.is-active {
  background: var(--bg-surface);
  color: var(--text-primary);
  box-shadow: var(--shadow-xs);
}
.tx-form { display: flex; flex-direction: column; gap: var(--space-4); }
.tx-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-4);
}
@media (max-width: 560px) {
  .tx-grid { grid-template-columns: 1fr; }
}
.tx-amount-field { gap: var(--space-2); }
.tx-amount {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-surface);
  padding: 0 var(--space-3);
  transition: border-color var(--duration-fast) var(--ease-out), box-shadow var(--duration-fast) var(--ease-out);
}
.tx-amount:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 var(--ring-width) var(--ring);
}
.tx-amount.is-invalid { border-color: var(--expense); }
.tx-amount__symbol {
  color: var(--text-tertiary);
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
}
.tx-amount__input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text-primary);
  font: inherit;
  font-size: var(--text-2xl);
  font-weight: var(--weight-semibold);
  font-variant-numeric: tabular-nums;
  padding: 10px 0;
  min-width: 0;
}
.tx-amount__input::placeholder { color: var(--text-tertiary); font-weight: var(--weight-normal); }
.tx-quickdates {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  margin-top: var(--space-1);
}
.tx-quickdate {
  appearance: none;
  border: 1px solid var(--border-subtle);
  background: var(--bg-inset);
  color: var(--text-secondary);
  font: inherit;
  font-size: var(--text-xs);
  padding: 3px 9px;
  border-radius: var(--radius-full);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out);
}
.tx-quickdate:hover { color: var(--text-primary); }
.tx-quickdate.is-active {
  background: var(--accent-subtle);
  border-color: transparent;
  color: var(--accent-text);
  font-weight: var(--weight-medium);
}
.tx-quickdate-hint { font-size: var(--text-xs); }
.tx-note-hint,
.tx-form-error {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  font-size: var(--text-sm);
  border-radius: var(--radius-md);
  padding: var(--space-3);
  margin: 0;
}
.tx-note-hint {
  background: var(--bg-inset);
  color: var(--text-secondary);
}
.tx-form-error {
  background: var(--expense-subtle);
  color: var(--expense);
  font-weight: var(--weight-medium);
}
.tx-dialog__foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-3);
  margin-top: var(--space-2);
  padding-top: var(--space-4);
  border-top: 1px solid var(--border-subtle);
}
.money-original { color: var(--text-tertiary); font-size: 0.9em; }
`
