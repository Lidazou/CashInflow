import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@renderer/store/app'
import { useRateStore } from '@renderer/store/rates'
import { useUiStore } from '@renderer/store/ui'
import { useAction, useAsync } from '@renderer/hooks/useData'
import { Icon } from '@renderer/components/Icon'
import { Money } from '@renderer/components/Money'
import { OcrDialog } from '@renderer/components/OcrDialog'
import type { OcrDraft } from '@renderer/components/OcrDialog'
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
 * BATCH ENTRY (v1.5.2)
 * ---------------------
 * The same form, plus a list. "再记一笔" files what is currently typed into the list and clears
 * the fields for the next one, so an evening's receipts go in without the dialog closing and
 * reopening between each. The list is committed in one action.
 *
 * What is deliberately SHARED rather than per-row: account, kind, date and time. Those are the
 * fields a person entering last night's spending sets once — "all of these came off the Maybank
 * card, all on the 25th" — and making them per-row would turn four clicks into four clicks
 * times nine. They are read from the top of the form at the moment a row is filed, so changing
 * them mid-session affects the rows filed afterwards, which is what the hint says.
 *
 * What is deliberately PER-ROW: amount, merchant, note, category. Those are the things that
 * actually differ between two receipts from the same evening, and they are all reachable from
 * the keyboard alone.
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

/**
 * One line waiting to be saved.
 *
 * Every value is captured at the moment the row is filed, never read back from the form: the
 * list has to survive the user changing the shared date or account for the NEXT entry without
 * silently rewriting the ones already in it.
 */
interface DraftRow {
  /** Stable key for React; also the order the rows were added in. */
  key: number
  kind: 'income' | 'expense'
  amountMinor: number
  currency: string
  accountId: number
  accountName: string
  categoryId: number | null
  categoryName: string | null
  date: string
  time: string | null
  merchant: string | null
  note: string | null
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
  const pushToast = useAppStore((state) => state.pushToast)
  const dateFormat = useAppStore((state) => state.settings?.dateFormat ?? 'DD MMM YYYY')
  const { run, pending } = useAction()

  const displayCurrency = useRateStore((state) => state.displayCurrency)

  const open = dialog.kind !== 'closed'

  const { data: accounts } = useAsync<AccountWithBalance[]>(() => window.api.accountsList(), [open])
  const { data: categories } = useAsync<Category[]>(() => window.api.categoriesList(), [open])

  const [form, setForm] = useState<FormState>(emptyForm)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  /** Lines filed but not yet saved. Empty means the dialog is in plain single-entry mode. */
  const [drafts, setDrafts] = useState<DraftRow[]>([])
  const [ocrOpen, setOcrOpen] = useState(false)
  const draftKeyRef = useRef(0)

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
    // The pending list belongs to one sitting. Reopening the dialog starts a fresh one rather
    // than silently resuming somebody's half-finished batch from an hour ago.
    setDrafts([])
    setOcrOpen(false)

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

  /*
    The pending list's running total.

    A hook, so it has to live ABOVE the `if (!open) return null` below: a hook that runs only when
    the dialog is open changes the number of hooks between renders, which React rejects outright
    ("Rendered more hooks than during the previous render") and which blanked the whole app the
    first time this was written the other way round.
  */
  const draftTotal = useMemo(() => drafts.reduce((sum, row) => sum + row.amountMinor, 0), [drafts])

  if (!open) return null

  const isEditing = dialog.kind === 'edit' || dialog.kind === 'editTransfer'
  const isTransfer = form.kind === 'transfer'
  /** The pending list only exists for creating ordinary transactions. */
  const batchAvailable = !isEditing && !isTransfer
  const batchActive = batchAvailable && drafts.length > 0

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

  /* ------------------------------------------------------------------ */
  /* batch entry                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * File the current form into the pending list and clear it for the next entry.
   *
   * Deliberately a SEPARATE action from saving, decided by the user rather than inferred: a
   * form that files itself on submit makes "I am done" and "I have one more" the same gesture,
   * and there is no way to save the last one without also opening an empty row.
   *
   * Everything the row needs is read from the form NOW. Reading it at save time instead would
   * mean that changing the date for the next receipt silently re-dated the ones already queued.
   * The fields are cleared but the SHARED ones — account, kind, date, time — deliberately are
   * not, because they are what the next receipt almost certainly has too.
   */
  function fileDraft(): boolean {
    const errors: Record<string, string> = {}
    const minor = parseAmountToMinor(form.amountText, entryCurrency)
    if (form.amountText.trim() === '') errors.amountText = T.txdErrAmountRequired
    else if (minor === null) errors.amountText = T.txdErrAmountInvalid
    else if (minor <= 0) errors.amountText = T.txdErrAmountPositive
    if (form.accountId === null) errors.accountId = T.txdErrAccountRequired
    if (!form.date) errors.date = T.txdErrDateRequired

    setFieldErrors(errors)
    if (Object.keys(errors).length > 0 || minor === null) {
      setFormError(form.accountId === null ? T.txdBatchNeedAccount : T.txdErrFixFields)
      return false
    }

    const chosen = (categories ?? []).find((category) => category.id === form.categoryId) ?? null
    draftKeyRef.current += 1
    setDrafts((previous) => [
      ...previous,
      {
        key: draftKeyRef.current,
        kind: form.kind === 'income' ? 'income' : 'expense',
        amountMinor: minor,
        currency: entryCurrency,
        accountId: form.accountId as number,
        accountName: account?.name ?? '',
        categoryId: form.categoryId,
        categoryName: chosen ? chosen.name : null,
        date: form.date,
        time: form.time || null,
        merchant: form.merchant.trim() || null,
        note: form.note.trim() || null
      }
    ])

    setFormError(null)
    // Keep the shared fields; clear the per-row ones.
    setForm((previous) => ({ ...previous, amountText: '', merchant: '', note: '', categoryId: null }))
    setFieldErrors({})
    window.setTimeout(() => amountRef.current?.focus(), 20)
    return true
  }

  /**
   * Turn recognised receipts into pending rows.
   *
   * The account and the kind come from the form — the recogniser cannot know which card was used —
   * so a receipt fills in what it actually read (amount, date, time, shop) and leaves the rest to
   * the fields already on screen. That split is the point: the software supplies the numbers it
   * saw in the image, and the user supplies the context only they have.
   *
   * A receipt whose currency differs from the account's is still filed, with ITS OWN currency
   * on the row, because the amount is what the shop charged. Converting it here would silently
   * invent an exchange rate that the ledger would then store as if it were the real amount.
   */
  function applyOcr(rows: OcrDraft[]): void {
    if (form.accountId === null) {
      setOcrOpen(false)
      setFormError(T.txdBatchNeedAccount)
      return
    }
    const kind: 'income' | 'expense' = form.kind === 'income' ? 'income' : 'expense'

    setDrafts((previous) => {
      const next = [...previous]
      for (const row of rows) {
        draftKeyRef.current += 1
        next.push({
          key: draftKeyRef.current,
          kind,
          amountMinor: row.amountMinor,
          currency: row.currency ?? entryCurrency,
          accountId: form.accountId as number,
          accountName: account?.name ?? '',
          categoryId: form.categoryId,
          categoryName:
            (categories ?? []).find((category) => category.id === form.categoryId)?.name ?? null,
          date: row.date ?? form.date,
          time: row.time,
          merchant: row.merchant,
          note: null
        })
      }
      return next
    })

    // The last receipt's date becomes the form's date, so a pile from the same evening files the
    // next batch on the right day without re-picking it.
    const last = rows[rows.length - 1]
    if (last?.date) setForm((previous) => ({ ...previous, date: last.date as string }))
    setOcrOpen(false)
    setFormError(null)
  }

  /**
   * Save every pending row, in order.
   *
   * Marked `type="button"` in the markup so this is not a form submit: the browser would
   * otherwise also run the single-entry handler, and the same transaction would be written
   * twice.
   *
   * Sequential rather than parallel. There is no bulk endpoint, and firing nine writes at one
   * SQLite connection at once buys nothing but lock contention; more importantly, stopping at
   * the first failure is only meaningful if the order is knowable, so the message can say which
   * row failed and everything before it is genuinely on disk.
   */
  async function handleSaveBatch(event: React.MouseEvent): Promise<void> {
    event.preventDefault()
    if (drafts.length === 0) return
    setFormError(null)

    let done = 0
    for (const row of drafts) {
      try {
        await window.api.transactionsCreate({
          accountId: row.accountId,
          type: row.kind,
          amount: row.amountMinor,
          categoryId: row.categoryId,
          date: row.date,
          time: row.time,
          merchant: row.merchant,
          note: row.note
        })
        done += 1
      } catch (error) {
        const reason = error instanceof Error ? error.message : T.txdErrSaveFailed
        if (done > 0) refreshData()
        setDrafts((previous) => previous.slice(done))
        setFormError(T.txdBatchPartial.replace('{done}', String(done)).replace('{failed}', String(done + 1)).replace('{reason}', reason))
        pushToast({ tone: 'error', message: reason, detail: T.txdBatchPartial.replace('{done}', String(done)).replace('{failed}', String(done + 1)).replace('{reason}', reason) })
        return
      }
    }

    pushToast({ tone: 'success', message: T.txdBatchSaved.replace('{n}', String(done)) })
    refreshData()
    close()
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
          <div className="tx-dialog__headactions">
            {batchActive ? (
              <span className="tx-batch-badge" title={T.txdBatchSharedNote}>
                <Icon name="inbox" size={13} />
                {T.txdBatchCount.replace('{n}', String(drafts.length))}
              </span>
            ) : null}
            <button type="button" className="btn btn-ghost btn-icon" onClick={close} aria-label={T.txdCloseDialog}>
              <Icon name="close" />
            </button>
          </div>
        </header>

        {/* ---------------- the pending list ---------------- */}
        {batchAvailable ? (
          <section className="tx-batch" aria-label={T.txdBatchPending}>
            {drafts.length === 0 ? (
              <p className="tx-batch__empty muted">{T.txdBatchEmpty}</p>
            ) : (
              <>
                <div className="tx-batch__head">
                  <span className="tx-batch__label">{T.txdBatchPending}</span>
                  <span className="muted tx-batch__hint">{T.txdBatchSharedNote}</span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => {
                      if (window.confirm(T.txdBatchClearConfirm.replace('{n}', String(drafts.length)))) {
                        setDrafts([])
                      }
                    }}
                  >
                    {T.txdBatchClear}
                  </button>
                </div>
                <ul className="tx-batch__list">
                  {drafts.map((row) => (
                    <li key={row.key} className="tx-batch__row">
                      <span className="tx-batch__time num">{row.time ?? <span className="muted">—</span>}</span>
                      <span className="tx-batch__body">
                        <span className="truncate tx-batch__title">
                          {row.merchant ?? (row.categoryName ? categoryLabel(row.categoryName) : T.klineUnnamed)}
                        </span>
                        <span className="muted truncate tx-batch__meta">
                          {[categoryLabel(row.categoryName), row.accountName, row.date].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                      <span className={`tx-batch__amount num ${row.kind === 'income' ? 'is-up' : 'is-down'}`}>
                        {row.kind === 'income' ? '+' : '−'}
                        {formatMoney(row.amountMinor, row.currency)}
                      </span>
                      <button
                        type="button"
                        className="btn btn-ghost btn-icon btn-sm"
                        aria-label={T.txdBatchRemove}
                        title={T.txdBatchRemove}
                        onClick={() => setDrafts((previous) => previous.filter((entry) => entry.key !== row.key))}
                      >
                        <Icon name="close" size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="tx-batch__total">
                  <span className="muted">{T.txdBatchSum}</span>
                  <b className="num">{formatMoney(draftTotal, entryCurrency)}</b>
                </div>
              </>
            )}
          </section>
        ) : null}

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

            {batchAvailable ? (
              <button
                type="button"
                className="btn btn-secondary tx-batch-add"
                title={T.txdBatchAddHint}
                disabled={pending}
                onClick={() => fileDraft()}
              >
                <Icon name="plus" size={15} />
                {T.txdBatchAdd}
              </button>
            ) : null}

            {!isEditing && !isTransfer ? (
              <button
                type="button"
                className="btn btn-secondary tx-ocr-open"
                title={T.ocrButtonHint}
                disabled={pending}
                onClick={() => setOcrOpen(true)}
              >
                <Icon name="receipt" size={15} />
                {T.ocrButton}
              </button>
            ) : null}

            {batchActive ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={pending}
                onClick={(event) => void handleSaveBatch(event)}
              >
                {pending ? T.txdSaving : T.txdBatchSaveAll.replace('{n}', String(drafts.length))}
              </button>
            ) : (
              <button type="submit" className="btn btn-primary" disabled={pending}>
                {pending
                  ? T.txdSaving
                  : isEditing
                    ? T.txdSaveChanges
                    : isTransfer
                      ? T.txdSaveTransfer
                      : T.txdSaveTransaction}
              </button>
            )}
          </footer>
        </form>
      </div>

      <style>{DIALOG_CSS}</style>

      {ocrOpen ? (
        <OcrDialog
          entryCurrency={entryCurrency}
          defaultCategoryId={form.categoryId}
          defaultCategoryName={
            (categories ?? []).find((category) => category.id === form.categoryId)?.name ?? null
          }
          onApply={applyOcr}
          onClose={() => setOcrOpen(false)}
        />
      ) : null}
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
  background: var(--bg-scrim);
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
.tx-dialog__headactions { display: flex; align-items: center; gap: var(--space-2); }
.tx-batch-badge {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--text-2xs);
  font-weight: var(--weight-medium);
  color: var(--accent-text);
  background: var(--accent-subtle);
  border-radius: var(--radius-full);
  padding: 3px 9px;
}

/* ---- the pending list (batch entry) ---- */
.tx-batch {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--bg-inset);
  padding: var(--space-3);
  margin-bottom: var(--space-5);
}
.tx-batch__empty { margin: 0; font-size: var(--text-xs); text-align: center; padding: var(--space-2) 0; }
.tx-batch__head { display: flex; align-items: baseline; gap: var(--space-2); }
.tx-batch__label { font-size: var(--text-xs); font-weight: var(--weight-medium); color: var(--text-primary); }
.tx-batch__hint { flex: 1; min-width: 0; font-size: var(--text-2xs); }
.tx-batch__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.tx-batch__row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 5px var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
  font-size: var(--text-xs);
}
.tx-batch__time { flex: 0 0 42px; color: var(--text-secondary); font-size: var(--text-2xs); }
.tx-batch__body { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.tx-batch__title { color: var(--text-primary); font-weight: var(--weight-medium); }
.tx-batch__meta { font-size: var(--text-2xs); }
.tx-batch__amount { flex: 0 0 auto; font-weight: var(--weight-semibold); }
.tx-batch__amount.is-up { color: var(--income); }
.tx-batch__amount.is-down { color: var(--expense); }
.tx-batch__total {
  display: flex;
  align-items: baseline;
  justify-content: flex-end;
  gap: var(--space-2);
  padding-top: var(--space-1);
  border-top: 1px solid var(--border-subtle);
  font-size: var(--text-xs);
}
.tx-batch-add { display: inline-flex; align-items: center; gap: var(--space-1); }
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
