import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Icon, iconNameOr } from '@renderer/components/Icon'
import { CurrencyTag, Money, RateTicker } from '@renderer/components/Money'
import { useAction, useAsync } from '@renderer/hooks/useData'
import { useAppStore } from '@renderer/store/app'
import { useRateStore } from '@renderer/store/rates'
import { useUiStore } from '@renderer/store/ui'
import { formatDate } from '@shared/lib/dates'
import { T, categoryLabel, exportedRowsNotice, transactionTypeLabel } from '@shared/lib/i18n'
import { parseAmountToMinor } from '@shared/lib/money'
import { categoryColorFor } from '@shared/lib/category-colors'
import type {
  AccountWithBalance,
  Category,
  SearchResult,
  TransactionQuery,
  TransactionType,
  TransactionWithRefs
} from '@shared/types'

/**
 * Global transaction search (spec §19).
 *
 * THE ONE RULE THAT MATTERS HERE
 * ------------------------------
 * Transfers are money moving between the user's own accounts, not income and
 * not spending. The backend already computes `totals` with
 * `type IN ('income','expense')`, so this page DISPLAYS those figures and never
 * recomputes a total from the visible rows: summing `items` in the renderer
 * would silently count a transfer as both income and expense, and a wrong
 * summary is worse than no summary.
 *
 * SEARCHING IS FREE-TEXT AND SERVER-SIDE. The backend matches merchant, note,
 * category name and account name in one query, so the input is debounced rather
 * than duplicated in the renderer — there is one implementation of "what
 * matches", and it lives next to the SQL.
 *
 * MONEY IS AN INTEGER IN MINOR UNITS. The min/max amount boxes are TEXT parsed
 * with `parseAmountToMinor`; `parseFloat` would reintroduce binary floating point
 * error on the boundary of a query. Every amount that reaches the screen goes
 * through <Money>, which performs the single conversion the display currency
 * needs and leaves the original figure visible underneath.
 */

/** Type filter as the select stores it; 'all' maps to no `types` filter. */
type TypeFilter = 'all' | TransactionType

interface Filters {
  from: string
  to: string
  type: TypeFilter
  accountId: string
  categoryId: string
  minAmount: string
  maxAmount: string
}

const EMPTY_FILTERS: Filters = {
  from: '',
  to: '',
  type: 'all',
  accountId: '',
  categoryId: '',
  minAmount: '',
  maxAmount: ''
}

const RESULTS_ID = 'search-results'

/** An empty result, used before the first search so nothing is undefined. */
const EMPTY_RESULT: SearchResult = {
  items: [],
  total: 0,
  totals: { income: 0, expense: 0, net: 0, transactionCount: 0 }
}

/* ------------------------------------------------------------------------- */
/* error helpers                                                             */
/* ------------------------------------------------------------------------- */

/**
 * A parse that failed on text the user actually typed, as opposed to an empty
 * box. The distinction decides whether an inline error is shown, so it is named.
 */
interface AmountParse {
  /** null when the field is empty. */
  minor: number | null
  invalid: boolean
}

function parseAmountField(text: string, currency: string): AmountParse {
  const trimmed = text.trim()
  if (trimmed === '') return { minor: null, invalid: false }
  const minor = parseAmountToMinor(trimmed, currency)
  return minor === null ? { minor: null, invalid: true } : { minor, invalid: false }
}

/* ------------------------------------------------------------------------- */
/* row formatting                                                            */
/* ------------------------------------------------------------------------- */

function amountClass(type: TransactionType): string {
  if (type === 'income') return 'text-income'
  if (type === 'expense') return 'text-expense'
  return 'text-neutral'
}

function netClass(net: number): string {
  if (net > 0) return 'text-income'
  if (net < 0) return 'text-expense'
  return 'text-neutral'
}

/** Merchant, falling back to the note and then to a description of the kind. */
function descriptionOf(row: TransactionWithRefs): string {
  if (row.merchant) return row.merchant
  if (row.note) return row.note
  if (row.type === 'transfer') {
    return row.counterpartAccountName
      ? T.srchTransferTo.replace('{name}', row.counterpartAccountName)
      : transactionTypeLabel('transfer')
  }
  if (row.categoryName) return categoryLabel(row.categoryName)
  return transactionTypeLabel(row.type)
}

function categoryLabelOf(row: TransactionWithRefs): string {
  if (row.categoryName) return categoryLabel(row.categoryName)
  if (row.type === 'transfer') {
    return row.counterpartAccountName
      ? T.srchTransferTo.replace('{name}', row.counterpartAccountName)
      : transactionTypeLabel('transfer')
  }
  // `categoryLabel(null)` is the shared '未分类' wording.
  return categoryLabel(null)
}

/* ------------------------------------------------------------------------- */
/* page                                                                      */
/* ------------------------------------------------------------------------- */

export default function SearchPage(): React.JSX.Element {
  const refreshData = useAppStore((state) => state.refreshData)
  const pushToast = useAppStore((state) => state.pushToast)
  const baseCurrency = useAppStore((state) => state.settings?.baseCurrency ?? 'MYR')
  const dateFormat = useAppStore((state) => state.settings?.dateFormat ?? 'DD MMM YYYY')

  // Converted figures need the shared rate table, and the same table is what
  // makes each row's converted amount agree with the summary above it.
  const displayCurrency = useRateStore((state) => state.displayCurrency)
  const rateInfo = useRateStore((state) => state.info)
  const loadRates = useRateStore((state) => state.load)
  const refreshRates = useRateStore((state) => state.refresh)
  const [refreshingRates, setRefreshingRates] = useState(false)

  const openEditTransaction = useUiStore((state) => state.openEditTransaction)
  const openEditTransfer = useUiStore((state) => state.openEditTransfer)
  const showTransactionDetail = useUiStore((state) => state.showTransactionDetail)

  const { run } = useAction()

  useEffect(() => {
    void loadRates()
  }, [loadRates])

  const accounts = useAsync<AccountWithBalance[]>(() => window.api.accountsList(), [])
  const categories = useAsync<Category[]>(() => window.api.categoriesList(), [])

  /**
   * Seed the search term from the URL.
   *
   * The application header is a global search box on every page; submitting it
   * navigates to `/search?q=<term>`. Without reading the parameter here the
   * typed term would be silently dropped on arrival, which looks like the search
   * box is broken.
   *
   * The lazy initialiser keeps this out of a render-time effect, so the first
   * query already includes the term rather than flashing an unfiltered list.
   */
  const [searchParams] = useSearchParams()
  const [term, setTerm] = useState(() => searchParams.get('q') ?? '')
  const [debouncedTerm, setDebouncedTerm] = useState(() => (searchParams.get('q') ?? '').trim())
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [query, setQuery] = useState<TransactionQuery | null>(null)
  const [exporting, setExporting] = useState(false)

  /**
   * Follow later changes to `?q=`, which happen when the user submits the header
   * search again while already on this page. Navigating to the same route with a
   * different query string does not remount the component, so the initial state
   * alone would miss it.
   */
  const urlTerm = searchParams.get('q') ?? ''
  useEffect(() => {
    setTerm((current) => (current === urlTerm ? current : urlTerm))
  }, [urlTerm])

  // ~250ms after the last keystroke. Searching on every character would fire a
  // query per letter typed and let a slower early request race a faster later
  // one; `useAsync` already guards the result, but there is no reason to send
  // the work in the first place.
  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedTerm(term.trim()), 250)
    return () => window.clearTimeout(id)
  }, [term])

  const minAmount = useMemo(() => parseAmountField(filters.minAmount, baseCurrency), [filters.minAmount, baseCurrency])
  const maxAmount = useMemo(() => parseAmountField(filters.maxAmount, baseCurrency), [filters.maxAmount, baseCurrency])

  /**
   * The filter set as a `TransactionQuery`, or null when nothing has been asked
   * for yet. Both amount parses must succeed: a half-typed "1.2.3" must not be
   * silently ignored, because ignoring it would widen the results while the box
   * still shows the text the user typed.
   */
  const nextQuery = useMemo<TransactionQuery | null>(() => {
    if (minAmount.invalid || maxAmount.invalid) return null

    const built: TransactionQuery = {}
    if (debouncedTerm) built.search = debouncedTerm
    if (filters.from) built.from = filters.from
    if (filters.to) built.to = filters.to
    if (filters.type !== 'all') built.types = [filters.type]
    if (filters.accountId) built.accountIds = [Number(filters.accountId)]
    if (filters.categoryId) built.categoryIds = [Number(filters.categoryId)]
    if (minAmount.minor !== null) built.minAmount = minAmount.minor
    if (maxAmount.minor !== null) built.maxAmount = maxAmount.minor

    // No criteria means "do not search yet". Running an unfiltered query here
    // would dump the entire ledger on a page whose job is to narrow it down.
    return Object.keys(built).length === 0 ? null : built
  }, [debouncedTerm, filters, minAmount, maxAmount])

  // Compare the serialised query so an equal-but-new object does not put a fresh
  // request on the wire on every render.
  const queryKey = nextQuery === null ? '' : JSON.stringify(nextQuery)

  useEffect(() => {
    setQuery(queryKey === '' ? null : (JSON.parse(queryKey) as TransactionQuery))
  }, [queryKey])

  const results = useAsync<SearchResult>(
    () => (query === null ? Promise.resolve(EMPTY_RESULT) : window.api.transactionsSearch(query)),
    [query]
  )

  const rows = useMemo(() => results.data?.items ?? [], [results.data])
  const total = results.data?.total ?? 0
  const totals = results.data?.totals ?? EMPTY_RESULT.totals

  const searching = query !== null && results.loading
  const hasCriteria = nextQuery !== null
  const amountInvalid = minAmount.invalid || maxAmount.invalid

  /** Count sentence for the results header: 共找到 N 笔交易 (显示 M). */
  const resultsSummary =
    total > rows.length
      ? `${T.srchFoundPrefix} ${total} ${T.unitTransactions} · ${T.srchShowingPrefix} ${rows.length}`
      : `${T.srchFoundPrefix} ${total} ${T.unitTransactions}`

  function update<K extends keyof Filters>(key: K, value: Filters[K]): void {
    setFilters((previous) => ({ ...previous, [key]: value }))
  }

  function reset(): void {
    setTerm('')
    setDebouncedTerm('')
    setFilters(EMPTY_FILTERS)
  }

  /**
   * Ask the main process for fresh rates.
   *
   * A failed refresh is surfaced rather than swallowed: converted figures that
   * silently keep using a stale rate are worse than a visible error, because the
   * numbers still look right.
   */
  async function handleRefreshRates(): Promise<void> {
    setRefreshingRates(true)
    const result = await refreshRates(true)
    setRefreshingRates(false)
    if (result.error !== null) {
      pushToast({ tone: 'error', message: result.error, detail: T.noChangesMade })
    }
  }

  /**
   * Export exactly what is on screen.
   *
   * `exportCsv` opens a native save dialog, so a canceled dialog is a normal
   * outcome and must do nothing — not toast, not error.
   */
  async function handleExport(): Promise<void> {
    if (nextQuery === null || exporting) return
    setExporting(true)
    try {
      const result = await window.api.exportCsv(nextQuery)
      if (result.canceled) return
      pushToast({
        tone: 'success',
        message: exportedRowsNotice(result.rows),
        detail: result.path ?? undefined
      })
    } catch (error) {
      pushToast({
        tone: 'error',
        message: error instanceof Error ? error.message : T.srchExportFailed,
        detail: T.noChangesMade
      })
    } finally {
      setExporting(false)
    }
  }

  async function handleDelete(row: TransactionWithRefs): Promise<void> {
    const label = descriptionOf(row)
    const confirmed = window.confirm(
      (row.type === 'transfer' ? T.srchConfirmDeleteTransfer : T.srchConfirmDeleteTransaction).replace('{label}', label)
    )
    if (!confirmed) return

    const result = await run(() => window.api.transactionsDelete(row.id), {
      successMessage: row.type === 'transfer' ? T.srchTransferDeleted : T.srchTransactionDeleted
    })

    if (result !== null) {
      refreshData()
      results.reload()
    }
  }

  return (
    <div className="page search-page">
      <header className="page-head">
        <div>
          <h1 className="page-title">{T.srchTitle}</h1>
          <p className="secondary">{T.srchSubtitle}</p>
        </div>
        <div className="spacer" />
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => void handleExport()}
          disabled={nextQuery === null || exporting || rows.length === 0}
        >
          <Icon name="export" />
          {exporting ? T.genericExporting : T.srchExport}
        </button>
      </header>

      <section className="card search-bar" aria-label={T.srchAria}>
        <div className="field">
          <label className="field-label" htmlFor="search-input">
            {T.srchFieldLabel}
          </label>
          <div className="search-input">
            <Icon name="search" size={16} />
            <input
              id="search-input"
              className="search-input__field"
              type="search"
              value={term}
              autoFocus
              placeholder={T.srchPlaceholder}
              aria-describedby="search-hint"
              onChange={(event) => setTerm(event.target.value)}
            />
            {term !== '' ? (
              <button
                type="button"
                className="btn btn-ghost btn-icon btn-sm"
                onClick={() => setTerm('')}
                aria-label={T.srchClearTerm}
              >
                <Icon name="close" size={14} />
              </button>
            ) : null}
          </div>
          <p className="field-hint" id="search-hint">
            {T.srchHint}
          </p>
        </div>

        <div className="search-filters">
          <div className="field">
            <label className="field-label" htmlFor="search-from">
              {T.srchFrom}
            </label>
            <input
              id="search-from"
              className="input"
              type="date"
              value={filters.from}
              max={filters.to || undefined}
              onChange={(event) => update('from', event.target.value)}
            />
          </div>

          <div className="field">
            <label className="field-label" htmlFor="search-to">
              {T.srchTo}
            </label>
            <input
              id="search-to"
              className="input"
              type="date"
              value={filters.to}
              min={filters.from || undefined}
              onChange={(event) => update('to', event.target.value)}
            />
          </div>

          <div className="field">
            <label className="field-label" htmlFor="search-type">
              {T.srchType}
            </label>
            <select
              id="search-type"
              className="select"
              value={filters.type}
              onChange={(event) => update('type', event.target.value as TypeFilter)}
            >
              <option value="all">{T.srchAllTypes}</option>
              <option value="income">{transactionTypeLabel('income')}</option>
              <option value="expense">{transactionTypeLabel('expense')}</option>
              <option value="transfer">{transactionTypeLabel('transfer')}</option>
            </select>
          </div>

          <div className="field">
            <label className="field-label" htmlFor="search-account">
              {T.srchAccount}
            </label>
            <select
              id="search-account"
              className="select"
              value={filters.accountId}
              disabled={accounts.loading && accounts.data === null}
              onChange={(event) => update('accountId', event.target.value)}
            >
              <option value="">{T.srchAllAccounts}</option>
              {(accounts.data ?? []).map((account) => (
                <option key={account.id} value={String(account.id)}>
                  {account.name} ({account.currency})
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label className="field-label" htmlFor="search-category">
              {T.srchCategory}
            </label>
            <select
              id="search-category"
              className="select"
              value={filters.categoryId}
              disabled={categories.loading && categories.data === null}
              onChange={(event) => update('categoryId', event.target.value)}
            >
              <option value="">{T.srchAllCategories}</option>
              {(categories.data ?? []).map((category) => (
                <option key={category.id} value={String(category.id)}>
                  {categoryLabel(category.name)} — {transactionTypeLabel(category.type)}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label className="field-label" htmlFor="search-min">
              {T.srchMinAmount}
            </label>
            <input
              id="search-min"
              className="input num"
              type="text"
              inputMode="decimal"
              value={filters.minAmount}
              placeholder="0.00"
              aria-invalid={minAmount.invalid ? true : undefined}
              aria-describedby={minAmount.invalid ? 'search-min-error' : undefined}
              onChange={(event) => update('minAmount', event.target.value)}
            />
            {minAmount.invalid ? (
              <p className="field-error" id="search-min-error">
                {T.srchAmountInvalidExample.replace('{example}', '10.00')}
              </p>
            ) : null}
          </div>

          <div className="field">
            <label className="field-label" htmlFor="search-max">
              {T.srchMaxAmount}
            </label>
            <input
              id="search-max"
              className="input num"
              type="text"
              inputMode="decimal"
              value={filters.maxAmount}
              placeholder={T.srchAnyAmount}
              aria-invalid={maxAmount.invalid ? true : undefined}
              aria-describedby={maxAmount.invalid ? 'search-max-error' : undefined}
              onChange={(event) => update('maxAmount', event.target.value)}
            />
            {maxAmount.invalid ? (
              <p className="field-error" id="search-max-error">
                {T.srchAmountInvalidExample.replace('{example}', '250.00')}
              </p>
            ) : null}
          </div>

          <div className="field search-filters__reset">
            <span className="field-label" aria-hidden="true">
              &nbsp;
            </span>
            <button type="button" className="btn btn-secondary" onClick={reset} disabled={!hasCriteria && term === ''}>
              <Icon name="close" size={14} />
              {T.srchClearFilters}
            </button>
          </div>
        </div>
      </section>

      {/* --- rates ---------------------------------------------------------- */}
      <div className="search-rates">
        <RateTicker onRefresh={() => void handleRefreshRates()} refreshing={refreshingRates} />
        {rateInfo !== null && !rateInfo.hasRates ? (
          <p className="search-rates__notice" role="status">
            {T.srchRatesMissing}
          </p>
        ) : null}
      </div>

      {/* --- summary -------------------------------------------------------- */}
      {query !== null && results.data !== null ? (
        <section className="card summary-strip" aria-label={T.srchTotalsAria}>
          <div className="summary-strip__count">
            <span className="summary-strip__value num">{total}</span>
            <span className="muted">{T.unitTransactions}</span>
          </div>
          {/* These figures are the backend's `totals` verbatim. Nothing is
              re-added here: the service sums only income and expense rows, which
              is what keeps a transfer from inflating both sides. */}
          <div className="summary-strip__figures">
            <div className="summary-figure">
              <span className="summary-figure__label muted">{T.income}</span>
              <Money
                className="summary-figure__value amount text-income"
                minor={totals.income}
                currency={displayCurrency}
              />
            </div>
            <div className="summary-figure">
              <span className="summary-figure__label muted">{T.expense}</span>
              <Money
                className="summary-figure__value amount text-expense"
                minor={totals.expense}
                currency={displayCurrency}
              />
            </div>
            <div className="summary-figure">
              <span className="summary-figure__label muted">{T.srchNet}</span>
              <Money
                className={`summary-figure__value amount ${netClass(totals.net)}`}
                minor={totals.net}
                currency={displayCurrency}
                signed
              />
            </div>
          </div>
        </section>
      ) : null}

      {/* --- results -------------------------------------------------------- */}
      <section className="card results-card" aria-labelledby="results-heading">
        <div className="results-head">
          <h2 id="results-heading" className="card-title">
            {T.srchResultsTitle}
          </h2>
          {/* Stale rows stay visible while a new query runs — replacing a working
              table with a skeleton on every keystroke is worse than a moment of
              slightly old data — so the header says a search is in flight. */}
          <span className="secondary" role="status" aria-live="polite">
            {searching ? T.srchSearching : rows.length > 0 ? resultsSummary : ''}
          </span>
        </div>

        {amountInvalid ? (
          <div className="search-message" role="alert">
            <Icon name="alert" size={18} />
            <div>
              <p>{T.srchAmountInvalid}</p>
              <p className="secondary">
                {T.srchAmountNotNumber} {T.srchFixAmount}
              </p>
            </div>
          </div>
        ) : query === null ? (
          <div className="empty-state">
            <span className="search-empty__icon" aria-hidden="true">
              <Icon name="search" size={22} />
            </span>
            <p className="empty-state-title">{T.srchTitle}</p>
            <p>{T.srchSubtitle}</p>
          </div>
        ) : results.error ? (
          <div className="search-message" role="alert">
            <Icon name="alert" size={18} />
            <div className="stack-sm">
              <p>{T.srchFailedTitle}</p>
              <p className="secondary">{results.error}</p>
              <button type="button" className="btn btn-secondary btn-sm" onClick={results.reload}>
                <Icon name="refresh" size={14} />
                {T.retry}
              </button>
            </div>
          </div>
        ) : searching && results.data === null ? (
          <div className="stack-sm" aria-hidden="true">
            {[0, 1, 2, 3].map((key) => (
              <div key={key} className="skeleton" style={{ height: 38 }} />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="empty-state">
            <span className="search-empty__icon" aria-hidden="true">
              <Icon name="inbox" size={22} />
            </span>
            <p className="empty-state-title">{T.srchNoMatchTitle}</p>
            <p>{T.srchNoMatchBody}</p>
            <button type="button" className="btn btn-secondary" onClick={reset}>
              {T.srchClearAndSearch}
            </button>
          </div>
        ) : (
          <div className="results-scroll" id={RESULTS_ID} aria-busy={searching || undefined}>
            <table className="table search-table">
              <caption className="visually-hidden">
                {T.srchResultsCaption.replace('{total}', String(total)).replace('{shown}', String(rows.length))}
              </caption>
              <thead>
                <tr>
                  <th scope="col">{T.srchDateColumn}</th>
                  <th scope="col">{T.srchMerchantColumn}</th>
                  <th scope="col">{T.srchCategory}</th>
                  <th scope="col">{T.srchAccount}</th>
                  <th scope="col" className="num">
                    {T.srchAmountColumn}
                  </th>
                  <th scope="col" className="num">
                    <span className="visually-hidden">{T.srchRowActions}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="search-row">
                    <td>
                      <div className="search-cell-date">
                        <button
                          type="button"
                          className="search-open"
                          onClick={() => showTransactionDetail(row)}
                          title={T.srchOpenDetails}
                        >
                          {formatDate(row.date, dateFormat)}
                        </button>
                      </div>
                    </td>
                    <td>
                      <div className="search-cell-main">
                        <button
                          type="button"
                          className="search-open"
                          onClick={() => showTransactionDetail(row)}
                          title={T.srchOpenDetails}
                        >
                          <span className="search-cell__title truncate">{descriptionOf(row)}</span>
                          {row.note && row.merchant ? (
                            <span className="search-cell__note muted truncate">{row.note}</span>
                          ) : null}
                        </button>
                      </div>
                    </td>
                    <td>
                      <div className="search-category">
                        <span
                          className="search-category__dot"
                          style={{ backgroundColor: categoryColorFor(row.categoryName, row.categoryColor) }}
                          aria-hidden="true"
                        >
                          <Icon
                            name={iconNameOr(row.categoryIcon, row.type === 'transfer' ? 'arrow-left-right' : 'tag')}
                            size={12}
                          />
                        </span>
                        <span className="truncate">{categoryLabelOf(row)}</span>
                      </div>
                    </td>
                    <td>
                      <div className="search-account">
                        <span className="truncate">{row.accountName}</span>
                        <CurrencyTag className="muted" code={row.accountCurrency} />
                      </div>
                    </td>
                    <td className={`num amount ${amountClass(row.type)}`}>
                      {/* The stored amount is always positive and the direction
                          lives in `type`, so an expense is negated here rather
                          than shown as a plus. Colour repeats the direction for
                          a second, non-textual cue; a transfer is neutral. */}
                      <Money
                        minor={row.type === 'expense' ? -row.amount : row.amount}
                        currency={row.accountCurrency}
                        convert
                        showOriginal
                        signed={row.type !== 'transfer'}
                        absolute={row.type === 'transfer'}
                      />
                    </td>
                    <td className="num">
                      <div className="row-actions">
                        <button
                          type="button"
                          className="btn btn-ghost btn-icon btn-sm"
                          onClick={() => (row.type === 'transfer' ? openEditTransfer(row) : openEditTransaction(row))}
                          aria-label={`${T.edit} ${descriptionOf(row)}`}
                          title={T.edit}
                        >
                          <Icon name="edit" size={15} />
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-icon btn-sm row-actions__delete"
                          onClick={() => void handleDelete(row)}
                          aria-label={`${T.delete} ${descriptionOf(row)}`}
                          title={T.delete}
                        >
                          <Icon name="trash" size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="search-footnote muted">{T.srchFootnote.replace('{currency}', displayCurrency)}</p>

      <style>{SEARCH_CSS}</style>
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
const SEARCH_CSS = `
.search-page { display: flex; flex-direction: column; gap: var(--space-5); }
.page-head { display: flex; align-items: flex-start; gap: var(--space-4); flex-wrap: wrap; }
.page-title { font-size: var(--text-2xl); font-weight: var(--weight-semibold); letter-spacing: -0.02em; margin: 0; }
.page-head p { margin: 2px 0 0; }

/* --- search input --- */
.search-bar { display: flex; flex-direction: column; gap: var(--space-4); }
.search-input {
  display: flex; align-items: center; gap: var(--space-2);
  height: 40px; padding: 0 var(--space-3);
  background: var(--bg-surface); color: var(--text-tertiary);
  border: 1px solid var(--border-default); border-radius: var(--radius-md);
  transition: var(--transition-base);
}
.search-input:hover { border-color: var(--border-strong); }
.search-input:focus-within { border-color: var(--accent); box-shadow: 0 0 0 var(--ring-width) var(--ring); }
.search-input__field {
  flex: 1; min-width: 0; border: none; outline: none; background: transparent;
  color: var(--text-primary); font-size: var(--text-base);
}
.search-input__field::placeholder { color: var(--text-tertiary); }
.search-input__field::-webkit-search-cancel-button { display: none; }

/* --- rates --- */
.search-rates { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
.search-rates__notice { margin: 0; font-size: var(--text-xs); color: var(--warning); }

/* --- filters --- */
.search-filters {
  display: grid; gap: var(--space-3);
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  align-items: start;
}
.search-filters__reset { justify-content: flex-end; }
.search-filters__reset .field-label { visibility: hidden; }

/* --- summary --- */
.summary-strip {
  display: flex; align-items: center; justify-content: space-between;
  gap: var(--space-5); flex-wrap: wrap;
}
.summary-strip__count { display: flex; align-items: baseline; gap: var(--space-2); }
.summary-strip__value { font-size: var(--text-2xl); font-weight: var(--weight-semibold); }
.summary-strip__figures { display: flex; gap: var(--space-6); flex-wrap: wrap; }
.summary-figure { display: flex; flex-direction: column; gap: 2px; }
.summary-figure__label { font-size: var(--text-2xs); text-transform: uppercase; letter-spacing: 0.06em; }
.summary-figure__value { font-size: var(--text-lg); font-weight: var(--weight-semibold); }

/* --- results --- */
.results-card { display: flex; flex-direction: column; gap: var(--space-3); }
.results-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3); }
.results-scroll { overflow-x: auto; }
.search-table { min-width: 720px; }
.search-table th:last-child, .search-table td:last-child { width: 76px; }

.search-open {
  display: flex; flex-direction: column; gap: 2px; width: 100%;
  text-align: left; color: var(--text-primary); border-radius: var(--radius-sm);
  transition: var(--transition-base);
}
.search-open:hover { color: var(--accent-text); }
.search-open:hover .search-cell__title { text-decoration: underline; }
/* The clickable cell is wrapped in a div: a <button> may not be a direct child
   of <tr>, so the button lives inside the cell instead. */
.search-cell-date { display: flex; white-space: nowrap; color: var(--text-secondary); }
.search-cell-main { display: flex; min-width: 0; }
.search-cell__title { font-weight: var(--weight-medium); display: block; }
.search-cell__note { display: block; font-size: var(--text-xs); max-width: 34ch; }

.search-category { display: flex; align-items: center; gap: var(--space-2); min-width: 0; }
.search-category__dot {
  flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 20px; height: 20px; border-radius: var(--radius-full);
  background-color: var(--bg-inset); color: var(--text-on-accent);
}
.search-category__dot svg { color: var(--text-inverse); }

.search-account { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.search-account .muted { font-size: var(--text-2xs); letter-spacing: 0.04em; }

.row-actions { display: flex; align-items: center; gap: var(--space-1); justify-content: flex-end; }
.row-actions__delete:hover:not(:disabled) { color: var(--expense); background: var(--expense-subtle); }

/* --- messages --- */
.search-message {
  display: flex; align-items: flex-start; gap: var(--space-3);
  padding: var(--space-4); border-radius: var(--radius-md);
  background: var(--expense-subtle); color: var(--expense);
}
.search-message svg { flex: none; margin-top: 2px; }
.search-message p { margin: 0; }
.search-message .secondary { color: var(--text-secondary); }
.search-empty__icon {
  display: inline-flex; align-items: center; justify-content: center;
  width: 44px; height: 44px; border-radius: var(--radius-full);
  background: var(--bg-inset); color: var(--text-secondary);
}
.search-footnote { margin: 0; font-size: var(--text-xs); max-width: 90ch; }
`
