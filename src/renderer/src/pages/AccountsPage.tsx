import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon, iconNameOr } from '@renderer/components/Icon'
import { ConversionNote, CurrencyTag, Money } from '@renderer/components/Money'
import { useAction, useAsync } from '@renderer/hooks/useData'
import { useAppStore } from '@renderer/store/app'
import { useRateStore } from '@renderer/store/rates'
import { ACCOUNT_TYPE_ICONS } from '@shared/constants'
import { DEFAULT_ACCOUNT_COLORS } from '@shared/constants/categories'
import { formatDate } from '@shared/lib/dates'
import { T, accountTypeLabel } from '@shared/lib/i18n'
import { DEFAULT_CURRENCY, formatMinorToPlain, parseAmountToMinor } from '@shared/lib/money'
import { selectableCurrencies } from '@shared/lib/rates'
import { ACCOUNT_TYPES } from '@shared/types'
import type {
  AccountInput,
  AccountType,
  AccountWithBalance,
  CurrencyBalance,
  DashboardSummary,
  DateFormat
} from '@shared/types'

/**
 * Accounts (spec §15).
 *
 * TWO RULES DRIVE THIS PAGE
 * -------------------------
 * 1. BALANCES ARE NEVER SUMMED ACROSS CURRENCIES. RM 5,000 and ¥5,000 are not
 *    the same quantity, so each currency keeps its own line and the line always
 *    shows the REAL balance in the currency the money actually sits in. A
 *    converted figure is added beside it as a secondary, clearly-derivable
 *    number — never as a replacement. The combined figure comes from the
 *    backend's own converted total, which is null the moment any currency lacks
 *    a rate: a partial total presented as a total would be worse than none.
 *
 * 2. MONEY IS AN INTEGER IN MINOR UNITS. The opening-balance field is a TEXT
 *    input converted with `parseAmountToMinor` (string arithmetic). `parseFloat`
 *    would put binary floating point error at the exact point where the user's
 *    money enters the ledger. Zero and negative openings are valid — a credit
 *    card opens owed.
 *
 * Deleting an account that still has transactions is refused by the service. The
 * dialog catches that and offers archiving instead — the alternative, a silent
 * cascade, would delete the user's financial history as a side effect of tidying
 * up a list.
 */

/* ------------------------------------------------------------------------- */
/* error helpers                                                             */
/* ------------------------------------------------------------------------- */

interface FieldErrorCarrier {
  fields: Record<string, string>
}

/**
 * The preload bridge rethrows backend failures as real `Error` instances with
 * `code` and `fields` copied across from the `IpcResult` envelope, so
 * field-level validation can be rendered against the exact input that failed.
 * Typed as a guard rather than a cast so an error without the map cannot leak a
 * bogus shape into the form.
 */
function hasFieldErrors(error: unknown): error is Error & FieldErrorCarrier {
  if (!(error instanceof Error)) return false
  const fields = (error as { fields?: unknown }).fields
  if (typeof fields !== 'object' || fields === null) return false
  return Object.values(fields).every((value) => typeof value === 'string')
}

function fieldErrorsOf(error: unknown): Record<string, string> {
  return hasFieldErrors(error) ? error.fields : {}
}

/* ------------------------------------------------------------------------- */
/* page                                                                      */
/* ------------------------------------------------------------------------- */

export default function AccountsPage(): React.JSX.Element {
  const navigate = useNavigate()
  const refreshData = useAppStore((state) => state.refreshData)
  const pushToast = useAppStore((state) => state.pushToast)
  const dateFormat = useAppStore((state) => state.settings?.dateFormat ?? 'DD MMM YYYY')
  const activeMonth = useAppStore((state) => state.activeMonth)
  const { run, pending } = useAction()

  // The rate table is shared by every converted figure, and the dashboard
  // summary below is computed with exactly these rates. Loading it once here is
  // what keeps one screen's numbers reconcilable with another's.
  const loadRates = useRateStore((state) => state.load)
  const rateTable = useRateStore((state) => state.table)
  const storeDisplayCurrency = useRateStore((state) => state.displayCurrency)

  useEffect(() => {
    void loadRates()
  }, [loadRates])

  const accounts = useAsync<AccountWithBalance[]>(
    () => window.api.accountsList({ includeArchived: true }),
    []
  )

  /**
   * Balances come from the dashboard summary rather than `accountsBalances()`:
   * only the summary carries `convertedBalance` per currency plus the single
   * converted total, so one query supplies the whole card and a line's own
   * balance can never disagree with its converted counterpart.
   */
  const summary = useAsync<DashboardSummary>(() => window.api.dashboardSummary(activeMonth), [activeMonth])

  const balances = useMemo<CurrencyBalance[]>(() => summary.data?.balances ?? [], [summary.data])
  const displayCurrency = summary.data?.displayCurrency ?? storeDisplayCurrency
  /** Null when any currency has no rate: the honest "cannot be totalled" answer. */
  const combinedTotal = summary.data?.netWorthInBaseCurrency ?? null
  const hasUnconverted = balances.some((row) => row.convertedBalance == null)

  const [editing, setEditing] = useState<AccountWithBalance | 'new' | null>(null)
  const [deleting, setDeleting] = useState<AccountWithBalance | null>(null)
  const [togglingId, setTogglingId] = useState<number | null>(null)

  const list = useMemo(() => accounts.data ?? [], [accounts.data])
  const activeAccounts = useMemo(() => list.filter((account) => !account.archived), [list])
  const archivedAccounts = useMemo(() => list.filter((account) => account.archived), [list])
  const [showArchived, setShowArchived] = useState(false)

  return (
    <div className="page accounts-page">
      <header className="page-head">
        <div>
          <h1 className="page-title">{T.navAccounts}</h1>
          <p className="secondary">{T.accSubtitle}</p>
        </div>
        <div className="spacer" />
        <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>
          <Icon name="plus" />
          {T.accAdd}
        </button>
      </header>

      {/* --- totals ---------------------------------------------------------- */}
      <section className="card balance-card" aria-labelledby="balance-heading">
        <div className="balance-card__head">
          <h2 id="balance-heading" className="card-title">
            {balances.length === 1 ? T.totalBalance : T.accBalancesByCurrency}
          </h2>
          {balances.length > 1 ? (
            <span className="badge badge-neutral">
              {balances.length} {T.unitCurrencies}
            </span>
          ) : null}
        </div>

        {summary.loading && summary.data === null ? (
          <div className="stack-sm" aria-hidden="true">
            <div className="skeleton" style={{ height: 30, width: 190 }} />
            <div className="skeleton" style={{ height: 14, width: 260 }} />
          </div>
        ) : summary.error ? (
          <div className="inline-error" role="alert">
            <Icon name="alert" />
            <div className="stack-sm">
              <p>{summary.error}</p>
              <button type="button" className="btn btn-secondary btn-sm" onClick={summary.reload}>
                <Icon name="refresh" size={14} />
                {T.retry}
              </button>
            </div>
          </div>
        ) : balances.length === 0 ? (
          <p className="muted">{T.accNoActiveAccounts}</p>
        ) : (
          <>
            <ul className="balance-list">
              {balances.map((row) => (
                <li key={row.currency} className="balance-line">
                  {/* The account's own currency is the real balance, so it is
                      shown as-is: converting it away would hide the figure the
                      user checks against their bank. */}
                  <Money className="balance-line__amount amount" minor={row.balance} currency={row.currency} />
                  {row.convertedBalance != null ? (
                    <Money
                      className="balance-line__converted muted"
                      minor={row.convertedBalance}
                      currency={displayCurrency}
                    />
                  ) : null}
                  {balances.length > 1 ? (
                    <span className="balance-line__meta muted">
                      <CurrencyTag code={row.currency} /> · {row.accountCount} {T.unitAccounts}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
            {balances.length > 1 ? (
              <>
                {combinedTotal !== null ? (
                  <p className="balance-note">
                    <Icon name="info" size={14} />
                    <span>
                      {T.totalConverted.replace('{currency}', displayCurrency)}{' '}
                      <Money className="amount" minor={combinedTotal} currency={displayCurrency} />
                    </span>
                  </p>
                ) : (
                  <p className="balance-note">
                    <Icon name="info" size={14} />
                    <span>{T.accCurrenciesNeverSummed}</span>
                  </p>
                )}
                <ConversionNote
                  sources={balances.map((row) => ({
                    currency: row.currency,
                    converted: row.convertedBalance != null
                  }))}
                  displayCurrency={displayCurrency}
                  hasUnconverted={hasUnconverted}
                />
              </>
            ) : (
              <p className="balance-note">
                <Icon name="info" size={14} />
                <span>{T.accBalancesNote}</span>
              </p>
            )}
          </>
        )}
      </section>

      {/* --- list ------------------------------------------------------------ */}
      <section className="accounts-section" aria-labelledby="accounts-heading">
        <h2 id="accounts-heading" className="visually-hidden">
          {T.accYourAccounts}
        </h2>

        {accounts.error ? (
          <div className="card inline-error" role="alert">
            <Icon name="alert" />
            <div className="stack-sm">
              <p className="inline-error__title">{T.accLoadFailedTitle}</p>
              <p className="secondary">{accounts.error}</p>
              <button type="button" className="btn btn-secondary btn-sm" onClick={accounts.reload}>
                <Icon name="refresh" size={14} />
                {T.retry}
              </button>
            </div>
          </div>
        ) : accounts.loading && accounts.data === null ? (
          <ul className="account-list" aria-hidden="true">
            {[0, 1, 2].map((key) => (
              <li key={key} className="card account-row">
                <div className="skeleton account-avatar" />
                <div className="stack-sm" style={{ flex: 1 }}>
                  <div className="skeleton" style={{ height: 14, width: '35%' }} />
                  <div className="skeleton" style={{ height: 12, width: '55%' }} />
                </div>
                <div className="skeleton" style={{ height: 18, width: 90 }} />
              </li>
            ))}
          </ul>
        ) : list.length === 0 ? (
          <div className="card empty-state">
            <span className="empty-state__icon" aria-hidden="true">
              <Icon name="accounts" size={22} />
            </span>
            <p className="empty-state-title">{T.accEmptyTitle}</p>
            <p>{T.accEmptyBody}</p>
            <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>
              <Icon name="plus" />
              {T.accAdd}
            </button>
          </div>
        ) : (
          <div className="stack-md">
            <ul className="account-list">
              {activeAccounts.map((account) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  dateFormat={dateFormat}
                  busy={pending || togglingId === account.id}
                  onOpen={() => navigate(`/accounts/${account.id}`)}
                  onEdit={() => setEditing(account)}
                  onToggleArchive={() => void toggleArchive(account)}
                  onDelete={() => setDeleting(account)}
                />
              ))}
            </ul>

            {activeAccounts.length === 0 ? <p className="muted">{T.accAllArchived}</p> : null}

            {archivedAccounts.length > 0 ? (
              <div className="accounts-archived">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  aria-expanded={showArchived}
                  onClick={() => setShowArchived((value) => !value)}
                >
                  <Icon name={showArchived ? 'chevron-down' : 'chevron-right'} size={14} />
                  {T.accArchived}（{archivedAccounts.length}）
                </button>

                {showArchived ? (
                  <ul className="account-list account-list--archived">
                    {archivedAccounts.map((account) => (
                      <AccountRow
                        key={account.id}
                        account={account}
                        dateFormat={dateFormat}
                        busy={pending || togglingId === account.id}
                        onOpen={() => navigate(`/accounts/${account.id}`)}
                        onEdit={() => setEditing(account)}
                        onToggleArchive={() => void toggleArchive(account)}
                        onDelete={() => setDeleting(account)}
                      />
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </section>

      {editing !== null ? (
        <AccountDialog
          account={editing === 'new' ? null : editing}
          currencyOptions={selectableCurrencies(rateTable)}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            refreshData()
          }}
        />
      ) : null}

      {deleting !== null ? (
        <DeleteAccountDialog
          account={deleting}
          pending={pending}
          onCancel={() => setDeleting(null)}
          onArchiveInstead={() => void archiveInstead(deleting)}
          onConfirm={() => confirmDelete(deleting)}
        />
      ) : null}

      <style>{ACCOUNTS_CSS}</style>
    </div>
  )

  /* ----------------------------------------------------------------------- */
  /* behaviour                                                               */
  /* ----------------------------------------------------------------------- */

  async function toggleArchive(account: AccountWithBalance): Promise<void> {
    setTogglingId(account.id)
    const result = await run(() => window.api.accountsArchive(account.id, !account.archived), {
      successMessage: (account.archived ? T.accUnarchivedToast : T.accArchivedToast).replace('{name}', account.name)
    })
    setTogglingId(null)
    if (result !== null) refreshData()
  }

  /**
   * Delete, letting the failure through to the confirmation dialog.
   *
   * The service refuses while transactions still reference the account:
   * `transactions.account_id` is ON DELETE RESTRICT, and silently cascading would
   * remove the user's financial history as a side effect of tidying up an
   * account list. The request is deliberately NOT routed through `useAction`,
   * because a toast in the corner is a worse place for "this account still has
   * 42 transactions" than the sentence sitting directly above the button that
   * caused it. Validation-shaped failures are unpacked by `fieldErrorsOf`.
   */
  async function confirmDelete(account: AccountWithBalance): Promise<void> {
    await window.api.accountsDelete(account.id)
    setDeleting(null)
    refreshData()
    pushToast({ tone: 'success', message: T.accDeleted.replace('{name}', account.name) })
  }

  async function archiveInstead(account: AccountWithBalance): Promise<void> {
    const result = await run(() => window.api.accountsArchive(account.id, true), {
      successMessage: T.accArchivedKeeping
        .replace('{name}', account.name)
        .replace('{n}', String(account.transactionCount))
    })
    if (result !== null) {
      setDeleting(null)
      refreshData()
    }
  }
}

/* ------------------------------------------------------------------------- */
/* account row                                                               */
/* ------------------------------------------------------------------------- */

interface AccountRowProps {
  account: AccountWithBalance
  dateFormat: DateFormat
  busy: boolean
  onOpen: () => void
  onEdit: () => void
  onToggleArchive: () => void
  onDelete: () => void
}

function AccountRow({
  account,
  dateFormat,
  busy,
  onOpen,
  onEdit,
  onToggleArchive,
  onDelete
}: AccountRowProps): React.JSX.Element {
  // Stored type keys come from user data, so the label lookup falls back to the
  // raw key rather than rendering a blank; the same applies to the icon.
  const typeLabel = accountTypeLabel(account.type)
  const iconName = iconNameOr(ACCOUNT_TYPE_ICONS[account.type], 'wallet')

  return (
    <li className={`card account-row ${account.archived ? 'is-archived' : ''}`}>
      <span
        className="account-avatar"
        style={{
          // A tint of the account's own colour, so the dot stays readable in
          // both themes without a second hard-coded light/dark pair.
          backgroundColor: `color-mix(in srgb, ${account.color} 18%, transparent)`,
          color: account.color
        }}
        aria-hidden="true"
      >
        <Icon name={iconName} size={18} />
      </span>

      <div className="account-main">
        <div className="account-name-line">
          {account.archived ? (
            <span className="account-name">{account.name}</span>
          ) : (
            <button type="button" className="account-name account-name--link" onClick={onOpen}>
              {account.name}
            </button>
          )}
          {account.archived ? <span className="badge badge-neutral">{T.accArchived}</span> : null}
        </div>
        <p className="account-meta secondary truncate">
          {typeLabel} · <CurrencyTag code={account.currency} /> · {account.transactionCount} {T.unitTransactions}
        </p>
        {account.note ? <p className="account-note muted truncate">{account.note}</p> : null}
        <p className="account-opened muted">
          {T.accOpeningPrefix} <Money minor={account.openingBalance} currency={account.currency} /> · {T.accAddedOn}{' '}
          {formatDate(account.createdAt.slice(0, 10), dateFormat)}
        </p>
      </div>

      <div className="account-amount">
        {/* The account's own balance: never converted, so it always matches the
            statement the user is comparing against. */}
        <Money className="account-balance amount" minor={account.balance} currency={account.currency} />
        <span className="account-balance-label muted">{T.accBalanceLabel}</span>
      </div>

      <div className="account-actions">
        <button
          type="button"
          className="btn btn-ghost btn-icon btn-sm"
          onClick={onEdit}
          disabled={busy}
          aria-label={T.accEditNamed.replace('{name}', account.name)}
          title={T.edit}
        >
          <Icon name="edit" size={16} />
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-icon btn-sm"
          onClick={onToggleArchive}
          disabled={busy}
          aria-label={(account.archived ? T.accUnarchiveNamed : T.accArchiveNamed).replace('{name}', account.name)}
          title={account.archived ? T.accUnarchive : T.accArchive}
        >
          <Icon name={account.archived ? 'undo' : 'inbox'} size={16} />
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-icon btn-sm account-actions__delete"
          onClick={onDelete}
          disabled={busy}
          aria-label={T.accDeleteNamed.replace('{name}', account.name)}
          title={T.delete}
        >
          <Icon name="trash" size={16} />
        </button>
      </div>
    </li>
  )
}

/* ------------------------------------------------------------------------- */
/* add / edit dialog                                                         */
/* ------------------------------------------------------------------------- */

interface AccountDialogProps {
  /** null creates a new account. */
  account: AccountWithBalance | null
  /** Every currency the app can label, including ones the provider quotes. */
  currencyOptions: Array<{ code: string; label: string; symbol: string }>
  onClose: () => void
  onSaved: () => void
}

function AccountDialog({ account, currencyOptions, onClose, onSaved }: AccountDialogProps): React.JSX.Element {
  const pushToast = useAppStore((state) => state.pushToast)

  const isEdit = account !== null
  const titleId = isEdit ? `account-dialog-title-${account.id}` : 'account-dialog-title-new'

  const [name, setName] = useState(account?.name ?? '')
  const [type, setType] = useState<AccountType>(account?.type ?? 'cash')
  const [currency, setCurrency] = useState<string>(account?.currency ?? DEFAULT_CURRENCY)
  // The amount is rebuilt from the stored integer, never from a float: showing
  // `18.499999` for a stored 1850 is exactly what that would risk.
  const [openingBalanceText, setOpeningBalanceText] = useState(
    account ? formatMinorToPlain(account.openingBalance, account.currency) : ''
  )
  const [color, setColor] = useState<string>(account?.color ?? DEFAULT_ACCOUNT_COLORS[0])
  const [note, setNote] = useState(account?.note ?? '')
  const [saving, setSaving] = useState(false)

  /**
   * Field errors are keyed by the backend's field names (`name`, `type`,
   * `currency`, `openingBalance`, `note`), so the service's own map can be
   * merged straight in.
   */
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)

  // Escape closes from anywhere in the window, matching the transaction dialog.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const openingBalance = parseAmountToMinor(openingBalanceText, currency)

  /**
   * A stored currency can predate the current rate table, so the account's own
   * code is prepended when the list does not already contain it. Without this a
   * select would silently show the first option instead of the real value.
   */
  const selectable = useMemo(() => {
    if (currencyOptions.some((option) => option.code === currency)) return currencyOptions
    return [{ code: currency, label: currency, symbol: '' }, ...currencyOptions]
  }, [currencyOptions, currency])

  function clearField(key: string): void {
    setErrors((previous) => {
      if (!(key in previous)) return previous
      const next = { ...previous }
      delete next[key]
      return next
    })
  }

  /** Client-side pre-check. The main process validates again regardless. */
  function validate(): boolean {
    const next: Record<string, string> = {}

    if (name.trim() === '') next.name = T.accNameRequired
    else if (name.trim().length > 60) next.name = T.accNameTooLong

    if (openingBalanceText.trim() === '') {
      next.openingBalance = T.accOpeningRequired
    } else if (openingBalance === null) {
      next.openingBalance = T.accAmountInvalid
    }
    // Zero and negative opening balances are valid — a credit card opens owed,
    // so nothing here rejects a minus sign.

    if (note.trim().length > 300) next.note = T.accNoteTooLong

    setErrors(next)
    return Object.keys(next).length === 0
  }

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    setFormError(null)
    if (!validate()) return

    const minor = parseAmountToMinor(openingBalanceText, currency)
    if (minor === null) return

    const input: AccountInput = {
      name: name.trim(),
      type,
      currency,
      openingBalance: minor,
      color,
      icon: ACCOUNT_TYPE_ICONS[type],
      note: note.trim() === '' ? null : note.trim()
    }

    // The request goes straight to the bridge rather than through `useAction`
    // so that the backend's `fields` map survives: a validation or conflict
    // failure (`{ name: 'Already in use' }` when that name is taken in that
    // currency) must render under the offending input, and a toast in the
    // corner cannot point at a field. The toast is therefore raised here as
    // well, keeping the failure as visible as `useAction` would have made it.
    setSaving(true)
    try {
      if (account === null) await window.api.accountsCreate(input)
      else await window.api.accountsUpdate(account.id, input)

      pushToast({ tone: 'success', message: account === null ? T.accAdded : T.accUpdated })
      onSaved()
    } catch (error) {
      const fields = fieldErrorsOf(error)
      const message = error instanceof Error ? error.message : T.accSaveFailed

      if (Object.keys(fields).length > 0) {
        setErrors(fields)
        // Anything the form has no input for still has to be said out loud.
        const known = ['name', 'type', 'currency', 'openingBalance', 'note']
        if (!Object.keys(fields).some((key) => known.includes(key))) setFormError(message)
      } else {
        setFormError(message)
      }
      pushToast({ tone: 'error', message, detail: T.noChangesMade })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="ac-overlay"
      role="presentation"
      onMouseDown={(event) => {
        // Only close when the backdrop itself was clicked, not a drag that
        // started inside the panel.
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="ac-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="ac-dialog__head">
          <h2 id={titleId} className="ac-dialog__title">
            {isEdit ? T.accEditNamed.replace('{name}', account.name) : T.accAddTitle}
          </h2>
          <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label={T.genericCloseDialog}>
            <Icon name="close" />
          </button>
        </header>

        <form className="ac-form" onSubmit={handleSubmit} noValidate>
          <div className="field">
            <label className="field-label" htmlFor="account-name">
              {T.accName}
            </label>
            <input
              id="account-name"
              className="input"
              type="text"
              value={name}
              autoFocus
              maxLength={80}
              placeholder={T.accNamePlaceholder}
              aria-invalid={errors.name ? true : undefined}
              aria-describedby={errors.name ? 'account-name-error' : undefined}
              onChange={(event) => {
                setName(event.target.value)
                clearField('name')
              }}
            />
            {errors.name ? (
              <p className="field-error" id="account-name-error">
                {errors.name}
              </p>
            ) : null}
          </div>

          <div className="ac-grid">
            <div className="field">
              <label className="field-label" htmlFor="account-type">
                {T.accType}
              </label>
              <select
                id="account-type"
                className="select"
                value={type}
                onChange={(event) => {
                  setType(event.target.value as AccountType)
                  clearField('type')
                }}
              >
                {ACCOUNT_TYPES.map((value) => (
                  <option key={value} value={value}>
                    {accountTypeLabel(value)}
                  </option>
                ))}
              </select>
              {errors.type ? <p className="field-error">{errors.type}</p> : null}
            </div>

            <div className="field">
              <label className="field-label" htmlFor="account-currency">
                {T.accCurrency}
              </label>
              <select
                id="account-currency"
                className="select"
                value={currency}
                onChange={(event) => {
                  setCurrency(event.target.value)
                  clearField('currency')
                  clearField('openingBalance')
                }}
              >
                {selectable.map((option) => (
                  <option key={option.code} value={option.code}>
                    {option.label}
                  </option>
                ))}
              </select>
              <p className="field-hint">{T.accStoredIn.replace('{currency}', currency)}</p>
              {errors.currency ? <p className="field-error">{errors.currency}</p> : null}
            </div>
          </div>

          <div className="field">
            <label className="field-label" htmlFor="account-opening">
              {T.accOpeningBalance}
            </label>
            <input
              id="account-opening"
              className="input"
              type="text"
              inputMode="decimal"
              value={openingBalanceText}
              placeholder={T.accOpeningPlaceholder}
              aria-invalid={errors.openingBalance ? true : undefined}
              aria-describedby={errors.openingBalance ? 'account-opening-error' : 'account-opening-hint'}
              onChange={(event) => {
                setOpeningBalanceText(event.target.value)
                clearField('openingBalance')
              }}
            />
            {errors.openingBalance ? (
              <p className="field-error" id="account-opening-error">
                {errors.openingBalance}
              </p>
            ) : (
              <p className="field-hint" id="account-opening-hint">
                {T.accOpeningHint}
              </p>
            )}
          </div>

          <fieldset className="field ac-colors">
            <legend className="field-label">{T.accColor}</legend>
            <div className="ac-swatches" role="radiogroup" aria-label={T.accColorGroup}>
              {DEFAULT_ACCOUNT_COLORS.map((swatch) => (
                <label
                  key={swatch}
                  className={`ac-swatch ${color === swatch ? 'is-selected' : ''}`}
                  style={{ backgroundColor: swatch }}
                >
                  <input
                    type="radio"
                    name="account-color"
                    value={swatch}
                    checked={color === swatch}
                    onChange={() => setColor(swatch)}
                    className="visually-hidden"
                    aria-label={T.accColorNamed.replace('{color}', swatch)}
                  />
                  {color === swatch ? <Icon name="check" size={14} /> : null}
                </label>
              ))}
            </div>
          </fieldset>

          <div className="field">
            <label className="field-label" htmlFor="account-note">
              {T.accNote} <span className="muted">（{T.genericOptional}）</span>
            </label>
            <textarea
              id="account-note"
              className="textarea"
              rows={3}
              maxLength={300}
              value={note}
              placeholder={T.accNotePlaceholder}
              aria-invalid={errors.note ? true : undefined}
              aria-describedby={errors.note ? 'account-note-error' : 'account-note-hint'}
              onChange={(event) => {
                setNote(event.target.value)
                clearField('note')
              }}
            />
            {errors.note ? (
              <p className="field-error" id="account-note-error">
                {errors.note}
              </p>
            ) : (
              <p className="field-hint" id="account-note-hint">
                {note.length}/300
              </p>
            )}
          </div>

          {formError ? (
            <p className="ac-form-error" role="alert">
              <Icon name="alert" size={16} />
              <span>{formError}</span>
            </p>
          ) : null}

          <footer className="ac-dialog__foot">
            <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>
              {T.cancel}
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? T.genericSaving : isEdit ? T.save : T.accAddTitle}
            </button>
          </footer>
        </form>
      </div>

      <style>{ACCOUNTS_CSS}</style>
    </div>
  )
}

/* ------------------------------------------------------------------------- */
/* delete confirmation                                                       */
/* ------------------------------------------------------------------------- */

interface DeleteAccountDialogProps {
  account: AccountWithBalance
  pending: boolean
  onCancel: () => void
  /** Archives the account; the parent closes the dialog on success. */
  onArchiveInstead: () => void
  /** Attempts the delete. Rejects when the service refuses it. */
  onConfirm: () => Promise<void>
}

function DeleteAccountDialog({
  account,
  pending,
  onCancel,
  onArchiveInstead,
  onConfirm
}: DeleteAccountDialogProps): React.JSX.Element {
  /**
   * `null` until the delete has been attempted. A message means the service
   * refused — normally because transactions still reference the account — and
   * archiving is then the recommended action rather than the destructive one.
   */
  const [refusal, setRefusal] = useState<string | null>(null)
  const [attempting, setAttempting] = useState(false)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCancel()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onCancel])

  const titleId = `account-delete-title-${account.id}`
  const transactionCount = account.transactionCount
  const busy = pending || attempting

  function attempt(): void {
    setRefusal(null)
    setAttempting(true)
    onConfirm()
      .catch((error: unknown) => {
        // The bridge rethrows a backend failure as a real Error, so the
        // service's own sentence ("… still has 42 transaction(s) …") is what
        // the user reads. A field map, when present, is unpacked for the same
        // purpose.
        const fields = fieldErrorsOf(error)
        const detail = Object.values(fields)[0]
        setRefusal(detail ?? (error instanceof Error ? error.message : T.accDeleteFailed))
      })
      .finally(() => setAttempting(false))
  }

  return (
    <div
      className="ac-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <div className="ac-dialog ac-dialog--sm" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="ac-dialog__head">
          <h2 id={titleId} className="ac-dialog__title">
            {T.accDeleteTitle.replace('{name}', account.name)}
          </h2>
          <button type="button" className="btn btn-ghost btn-icon" onClick={onCancel} aria-label={T.genericCloseDialog}>
            <Icon name="close" />
          </button>
        </header>

        <div className="stack-md">
          {refusal ? (
            <div className="ac-refusal" role="alert">
              <Icon name="alert" size={16} />
              <div className="stack-sm">
                <p>{refusal}</p>
                <p className="secondary">{T.accArchiveKeepsEverything}</p>
              </div>
            </div>
          ) : (
            <p className="secondary">
              {transactionCount > 0
                ? T.accDeleteWithTransactions.replace('{n}', String(transactionCount))
                : T.accDeleteNoTransactions}
            </p>
          )}

          <div className="ac-summary">
            <span className="muted">{T.accBalanceLabel}</span>
            <Money className="amount" minor={account.balance} currency={account.currency} />
          </div>
        </div>

        <footer className="ac-dialog__foot">
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>
            {T.cancel}
          </button>
          <button
            type="button"
            className={`btn ${refusal ? 'btn-primary' : 'btn-secondary'}`}
            onClick={onArchiveInstead}
            disabled={busy || account.archived}
          >
            <Icon name="inbox" size={16} />
            {account.archived ? T.accAlreadyArchived : T.accArchiveInstead}
          </button>
          <button type="button" className="btn btn-danger" onClick={attempt} disabled={busy}>
            <Icon name="trash" size={16} />
            {attempting ? T.genericDeleting : T.accDeleteConfirm}
          </button>
        </footer>

        <p className="ac-cascade-note muted">{T.accDeleteNeverRemovesTransactions}</p>
      </div>

      <style>{ACCOUNTS_CSS}</style>
    </div>
  )
}

/* ------------------------------------------------------------------------- */
/* scoped styles                                                             */
/* ------------------------------------------------------------------------- */

/**
 * Inline because the project has no per-component stylesheet. Every colour is a
 * token so dark mode works without a second set of rules.
 */
const ACCOUNTS_CSS = `
.accounts-page { display: flex; flex-direction: column; gap: var(--space-5); }
.page-head {
  display: flex; align-items: flex-start; gap: var(--space-4); flex-wrap: wrap;
}
.page-title { font-size: var(--text-2xl); font-weight: var(--weight-semibold); letter-spacing: -0.02em; margin: 0; }
.page-head p { margin: 2px 0 0; }

/* --- totals --- */
.balance-card { display: flex; flex-direction: column; gap: var(--space-3); }
.balance-card__head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.balance-list { display: flex; flex-direction: column; gap: var(--space-2); }
.balance-line { display: flex; align-items: baseline; gap: var(--space-3); flex-wrap: wrap; }
.balance-line__amount { font-size: var(--text-3xl); font-weight: var(--weight-semibold); letter-spacing: -0.02em; }
/* The converted figure is secondary: it never replaces the real balance. */
.balance-line__converted { font-size: var(--text-sm); }
.balance-line__meta { font-size: var(--text-sm); }
.balance-note {
  display: flex; align-items: flex-start; gap: var(--space-2);
  margin: 0; padding: var(--space-3);
  background: var(--bg-inset); color: var(--text-secondary);
  font-size: var(--text-xs); line-height: var(--leading-normal);
  border-radius: var(--radius-md);
}
.balance-note svg { flex: none; margin-top: 2px; }

/* --- account rows --- */
.accounts-section { display: flex; flex-direction: column; gap: var(--space-3); }
.account-list { display: flex; flex-direction: column; gap: var(--space-2); }
.account-row { display: flex; align-items: center; gap: var(--space-4); }
.account-row.is-archived { opacity: 0.62; background: var(--bg-surface); }
.account-row.is-archived:hover { opacity: 0.85; }
.account-avatar {
  flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 38px; height: 38px; border-radius: var(--radius-full);
}
.account-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.account-name-line { display: flex; align-items: center; gap: var(--space-2); min-width: 0; }
.account-name {
  font-size: var(--text-base); font-weight: var(--weight-semibold); color: var(--text-primary);
  text-align: left; padding: 0; max-width: 100%;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.account-name--link { border-radius: var(--radius-sm); transition: var(--transition-base); }
.account-name--link:hover { color: var(--accent-text); text-decoration: underline; }
.account-meta { margin: 0; }
.account-note { margin: 0; font-size: var(--text-xs); }
.account-opened { font-size: var(--text-2xs); color: var(--text-tertiary); margin: 0; }
.account-amount { flex: none; display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }
.account-balance { font-size: var(--text-lg); font-weight: var(--weight-semibold); }
.account-balance-label { font-size: var(--text-2xs); text-transform: uppercase; letter-spacing: 0.06em; }
.account-actions { flex: none; display: flex; align-items: center; gap: var(--space-1); }
.account-actions__delete:hover:not(:disabled) { color: var(--expense); background: var(--expense-subtle); }

.accounts-archived { display: flex; flex-direction: column; gap: var(--space-2); align-items: flex-start; }
.accounts-archived > .btn { align-self: flex-start; }
.account-list--archived { width: 100%; }

/* --- shared inline bits --- */
.inline-error {
  display: flex; align-items: flex-start; gap: var(--space-3);
  color: var(--text-primary);
}
.inline-error svg { flex: none; margin-top: 2px; color: var(--expense); }
.inline-error__title { font-weight: var(--weight-semibold); margin: 0; }
.inline-error p { margin: 0; }
.empty-state__icon {
  display: inline-flex; align-items: center; justify-content: center;
  width: 44px; height: 44px; border-radius: var(--radius-full);
  background: var(--bg-inset); color: var(--text-secondary);
}

/* --- dialog --- */
.ac-overlay {
  position: fixed; inset: 0; z-index: 60;
  display: flex; align-items: flex-start; justify-content: center;
  padding: 6vh var(--space-6) var(--space-6);
  background: rgba(15, 15, 15, 0.42);
  overflow-y: auto;
}
.ac-dialog {
  width: 100%; max-width: 560px;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-md);
  padding: var(--space-6);
  animation: ac-in var(--duration-base) var(--ease-out);
}
.ac-dialog--sm { max-width: 460px; }
@keyframes ac-in {
  from { opacity: 0; transform: translateY(-6px); }
  to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) { .ac-dialog { animation: none; } }
.ac-dialog__head {
  display: flex; align-items: center; justify-content: space-between;
  gap: var(--space-4); margin-bottom: var(--space-5);
}
.ac-dialog__title { font-size: var(--text-lg); font-weight: var(--weight-semibold); margin: 0; }
.ac-form { display: flex; flex-direction: column; gap: var(--space-4); }
.ac-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-4); }
@media (max-width: 560px) { .ac-grid { grid-template-columns: 1fr; } }

.ac-colors { border: 0; padding: 0; margin: 0; gap: var(--space-2); }
.ac-colors legend { padding: 0; margin-bottom: var(--space-1); }
.ac-swatches { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.ac-swatch {
  position: relative; display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; border-radius: var(--radius-full);
  color: var(--text-on-accent); cursor: pointer;
  border: 2px solid transparent; box-shadow: var(--shadow-xs);
  transition: var(--transition-base);
}
.ac-swatch:hover { transform: scale(1.06); }
.ac-swatch.is-selected { border-color: var(--text-primary); }
/* The radio itself is visually hidden, so the ring is drawn on the swatch. */
.ac-swatch:focus-within { outline: var(--ring-width) solid var(--ring); outline-offset: 2px; }

.ac-form-error, .ac-refusal {
  display: flex; align-items: flex-start; gap: var(--space-2);
  padding: var(--space-3); border-radius: var(--radius-md);
  font-size: var(--text-sm); margin: 0;
}
.ac-form-error { background: var(--expense-subtle); color: var(--expense); font-weight: var(--weight-medium); }
.ac-refusal { background: var(--warning-subtle); color: var(--warning); }
.ac-refusal svg { flex: none; margin-top: 2px; }
.ac-refusal p { margin: 0; }
.ac-refusal p.secondary { color: var(--text-secondary); }

.ac-summary {
  display: flex; align-items: center; justify-content: space-between;
  gap: var(--space-3); padding: var(--space-3);
  background: var(--bg-inset); border-radius: var(--radius-md);
  font-size: var(--text-sm);
}
.ac-dialog__foot {
  display: flex; justify-content: flex-end; gap: var(--space-3);
  margin-top: var(--space-5); padding-top: var(--space-4);
  border-top: 1px solid var(--border-subtle); flex-wrap: wrap;
}
.ac-cascade-note { margin: var(--space-3) 0 0; font-size: var(--text-xs); }
`
