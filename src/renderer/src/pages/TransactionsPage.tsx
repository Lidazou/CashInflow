import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useAppStore } from '@renderer/store/app'
import { useRateStore } from '@renderer/store/rates'
import { useUiStore } from '@renderer/store/ui'
import { useAction, useAsync } from '@renderer/hooks/useData'
import { Icon, iconNameOr } from '@renderer/components/Icon'
import { Money } from '@renderer/components/Money'
import { formatConverted, convertMinor } from '@shared/lib/rates'
import { cycleFor, cycleFromKey, shiftCycle } from '@shared/lib/periods'
import { today } from '@shared/lib/dates'
import {
  T,
  categoryLabel,
  dateHeadingZh,
  deleteTransactionConfirm,
  transactionTypeLabel,
  txnCountLabel,
  txnTruncatedNotice
} from '@shared/lib/i18n'
import type { AccountWithBalance, Category, TransactionQuery, TransactionWithRefs } from '@shared/types'

/**
 * Transactions list (spec §11 and the Transactions nav destination).
 *
 * The list is grouped by day because that is how people actually recall their
 * spending — "what did I spend on Saturday" is a far more natural question than
 * "show me rows 40 to 60". Each day header carries that day's subtotal, which
 * also makes the grouping verifiable against the dashboard's daily figures.
 *
 * THE PERIOD IS A SETTLEMENT CYCLE, NOT A CALENDAR MONTH. `activeMonth` is a
 * cycle key ('2026-09' names the cycle that STARTS in September), so the query
 * window comes from `cycleFromKey(activeMonth, cycleStartDay)` rather than from
 * the first and last day of a month. With `cycleStartDay = 1` the two are
 * identical, which is why this generalises the month picker instead of
 * replacing it.
 *
 * MONEY: every stored amount is an integer in the minor unit of the account it
 * moved in, and amounts from different accounts are NOT the same unit. Day
 * subtotals are therefore built by converting each row exactly once with
 * `convertMinor` and adding the resulting integers — the same rounding the row
 * itself displays, so the subtotal equals the figures the user can see.
 *
 * Route `/accounts/:accountId` reuses this page filtered to one account, so
 * there is one list implementation rather than two that could disagree.
 */

type TypeFilter = 'all' | 'income' | 'expense' | 'transfer'

interface DayGroup {
  date: string
  items: TransactionWithRefs[]
  income: number
  expense: number
  /** True when at least one row had no rate, so the subtotal mixes units. */
  approximate: boolean
}

export default function TransactionsPage(): React.JSX.Element {
  const { accountId } = useParams<{ accountId?: string }>()
  const navigate = useNavigate()

  const activeMonth = useAppStore((state) => state.activeMonth)
  const setActiveMonth = useAppStore((state) => state.setActiveMonth)
  const dateFormat = useAppStore((state) => state.settings?.dateFormat ?? 'DD MMM YYYY')
  const cycleStartDay = useAppStore((state) => state.settings?.cycleStartDay ?? 1)
  const refreshData = useAppStore((state) => state.refreshData)

  const openCreate = useUiStore((state) => state.openCreateTransaction)
  const openEdit = useUiStore((state) => state.openEditTransaction)
  const openEditTransfer = useUiStore((state) => state.openEditTransfer)
  const showDetail = useUiStore((state) => state.showTransactionDetail)

  const table = useRateStore((state) => state.table)
  const displayCurrency = useRateStore((state) => state.displayCurrency)
  const ratesInfo = useRateStore((state) => state.info)
  const ratesLoading = useRateStore((state) => state.loading)
  const loadRates = useRateStore((state) => state.load)
  const refreshRates = useRateStore((state) => state.refresh)

  const { run, pending } = useAction()

  // Rates must be in place before any converted figure is drawn, otherwise the
  // first paint would show original amounts and then silently correct itself.
  useEffect(() => {
    void loadRates()
  }, [loadRates])

  const scopedAccountId = accountId ? Number(accountId) : null
  const validAccountId = scopedAccountId !== null && Number.isInteger(scopedAccountId) ? scopedAccountId : null

  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [categoryFilter, setCategoryFilter] = useState<number | null>(null)
  const [searchText, setSearchText] = useState('')

  const { data: accounts } = useAsync<AccountWithBalance[]>(() => window.api.accountsList(), [])
  const { data: categories } = useAsync<Category[]>(() => window.api.categoriesList(), [])

  /** The cycle the strip is showing, derived from the stored cycle key. */
  const cycle = useMemo(() => cycleFromKey(activeMonth, cycleStartDay), [activeMonth, cycleStartDay])

  /**
   * The query object is memoised so `useAsync` receives a stable value and does
   * not refetch on every render.
   */
  const transactionQuery = useMemo<TransactionQuery>(() => {
    const filter: TransactionQuery = {
      from: cycle.start,
      to: cycle.end,
      limit: 1000,
      orderBy: 'date',
      orderDir: 'desc'
    }
    if (typeFilter !== 'all') filter.types = [typeFilter]
    if (validAccountId !== null) filter.accountIds = [validAccountId]
    if (categoryFilter !== null) filter.categoryIds = [categoryFilter]
    if (searchText.trim()) filter.search = searchText.trim()
    return filter
  }, [cycle.start, cycle.end, typeFilter, validAccountId, categoryFilter, searchText])

  const { data: page, loading, error, reload } = useAsync(
    () => window.api.transactionsList(transactionQuery),
    [transactionQuery]
  )

  const scopedAccount = accounts?.find((item) => item.id === validAccountId) ?? null

  /**
   * Group rows by date, preserving the descending order the query returned, and
   * total each day in the display currency.
   *
   * Subtotal is accumulated from converted income and expense figures; transfers
   * are skipped because moving money between your own accounts is neither income
   * nor spending, and including it would double a figure the user never spent.
   */
  const groups = useMemo<DayGroup[]>(() => {
    const map = new Map<string, TransactionWithRefs[]>()
    for (const item of page?.items ?? []) {
      const existing = map.get(item.date)
      if (existing) existing.push(item)
      else map.set(item.date, [item])
    }

    return [...map.entries()].map(([date, items]) => {
      let income = 0
      let expense = 0
      let approximate = false
      for (const item of items) {
        if (item.type === 'transfer') continue
        const converted = convertMinor(Math.abs(item.amount), item.accountCurrency, displayCurrency, table)
        if (converted.approximate) approximate = true
        if (item.type === 'income') income += converted.minor
        else expense += converted.minor
      }
      return { date, items, income, expense, approximate }
    })
  }, [page, displayCurrency, table])

  async function handleDelete(transaction: TransactionWithRefs): Promise<void> {
    const isTransfer = transaction.type === 'transfer'
    // A confirmation is plain text, so the amount is formatted here rather than
    // through <Money>; it still goes through `formatConverted`, which converts
    // with the shared rate table and never multiplies by a rate at this call site.
    const amountText = formatConverted(
      Math.abs(transaction.amount),
      transaction.accountCurrency,
      displayCurrency,
      table
    ).text
    const confirmed = window.confirm(
      isTransfer ? T.txpConfirmDeleteTransfer : deleteTransactionConfirm(amountText)
    )
    if (!confirmed) return

    const result = await run(() => window.api.transactionsDelete(transaction.id), {
      successMessage: isTransfer ? T.txpDeletedTransfer : T.txpDeletedTransaction
    })
    if (result !== null) {
      refreshData()
      reload()
    }
  }

  /** Pull fresh rates, then re-read the data so every figure is recomputed. */
  async function handleRefreshRates(): Promise<void> {
    await refreshRates(true)
    refreshData()
  }

  const hasFilters = searchText.trim() !== '' || typeFilter !== 'all' || categoryFilter !== null
  const ratesMissing = ratesInfo?.hasRates === false

  return (
    <div className="txp">
      <header className="txp__head">
        <div>
          <h1 className="txp__title">{scopedAccount ? scopedAccount.name : T.txpTitle}</h1>
          <p className="muted txp__sub">
            {scopedAccount ? (
              <>
                {/* An account's own balance is shown in that account's currency. */}
                <Money minor={scopedAccount.balance} currency={scopedAccount.currency} />
                {' · '}
                {txnCountLabel(scopedAccount.transactionCount)}
              </>
            ) : (
              T.txpSubtitle
            )}
          </p>
        </div>
        <div className="row">
          {scopedAccount ? (
            <button type="button" className="btn btn-ghost" onClick={() => navigate('/transactions')}>
              <Icon name="close" size={16} />
              {T.txpClearAccountFilter}
            </button>
          ) : null}
          <button type="button" className="btn btn-primary" onClick={() => openCreate()}>
            <Icon name="plus" size={16} />
            {T.txpAddTransaction}
          </button>
        </div>
      </header>

      {ratesMissing ? (
        <div className="txp__ratesNotice" role="status">
          <Icon name="alert" size={16} />
          <span>{T.txpRatesMissing}</span>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={ratesLoading}
            onClick={() => void handleRefreshRates()}
          >
            {ratesLoading ? T.txpUpdatingRates : T.refresh}
          </button>
        </div>
      ) : null}

      {/* --- filters ------------------------------------------------------ */}
      <div className="card txp__filters">
        <div className="txp__month">
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label={T.txpPrevPeriod}
            onClick={() => setActiveMonth(shiftCycle(`${activeMonth}-01`, cycleStartDay, -1).key)}
          >
            <Icon name="chevron-left" />
          </button>
          <span className="txp__monthLabel">{cycle.label}</span>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label={T.txpNextPeriod}
            onClick={() => setActiveMonth(shiftCycle(`${activeMonth}-01`, cycleStartDay, 1).key)}
          >
            <Icon name="chevron-right" />
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setActiveMonth(cycleFor(today(), cycleStartDay).key)}
          >
            {T.thisMonth}
          </button>
        </div>

        <div className="txp__filterRow">
          <label className="field txp__search">
            <span className="visually-hidden">{T.txpSearchLabel}</span>
            <span className="txp__searchWrap">
              <Icon name="search" size={16} />
              <input
                className="input"
                placeholder={T.txpSearchPlaceholder}
                value={searchText}
                onChange={(event) => setSearchText(event.target.value)}
              />
            </span>
          </label>

          <label className="field">
            <span className="field-label">{T.txpType}</span>
            <select
              className="select"
              value={typeFilter}
              onChange={(event) => setTypeFilter(event.target.value as TypeFilter)}
            >
              <option value="all">{T.txpAllTypes}</option>
              <option value="income">{transactionTypeLabel('income')}</option>
              <option value="expense">{transactionTypeLabel('expense')}</option>
              <option value="transfer">{transactionTypeLabel('transfer')}</option>
            </select>
          </label>

          <label className="field">
            <span className="field-label">{T.txpCategory}</span>
            <select
              className="select"
              value={categoryFilter ?? ''}
              onChange={(event) => setCategoryFilter(event.target.value ? Number(event.target.value) : null)}
            >
              <option value="">{T.txpAllCategories}</option>
              {(categories ?? []).map((category) => (
                <option key={category.id} value={category.id}>
                  {categoryLabel(category.name)}（{transactionTypeLabel(category.type)}）
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {/* --- results ------------------------------------------------------ */}
      {loading ? (
        <div className="stack-sm" aria-busy="true">
          {[0, 1, 2, 3, 4].map((row) => (
            <div key={row} className="skeleton" style={{ height: 56 }} />
          ))}
        </div>
      ) : error ? (
        <div className="card empty-state" role="alert">
          <p style={{ color: 'var(--expense)', fontWeight: 500 }}>{error}</p>
          <p className="muted">{T.txpLoadFailed}</p>
          <button type="button" className="btn btn-secondary" onClick={reload}>
            <Icon name="refresh" size={16} />
            {T.retry}
          </button>
        </div>
      ) : groups.length === 0 ? (
        <div className="card empty-state">
          <Icon name="inbox" size={28} />
          <p style={{ fontWeight: 500 }}>{T.txpNoMatch}</p>
          <p className="muted">{hasFilters ? T.txpWidenFilters : T.txpEmptyPeriod}</p>
          <button type="button" className="btn btn-primary" onClick={() => openCreate()}>
            <Icon name="plus" size={16} />
            {T.txpAddTransaction}
          </button>
        </div>
      ) : (
        <div className="txp__groups">
          {groups.map((group) => {
            const heading = dateHeadingZh(group.date, dateFormat)
            return (
              <section key={group.date} className="txp__group" aria-label={`${heading} ${T.txpDayTotal}`}>
                <header className="txp__groupHead">
                  <h2 className="txp__groupDate">{heading}</h2>
                  <div className="txp__groupTotals">
                    <span className="txp__groupTotalsLabel">{T.txpDayTotal}</span>
                    {group.income > 0 ? (
                      <span className="text-income amount">
                        {/* Already converted above, once per row. */}
                        <Money minor={group.income} currency={displayCurrency} signed absolute />
                        {group.approximate ? <span title={T.txpApproxHint}> *</span> : null}
                      </span>
                    ) : null}
                    {group.expense > 0 ? (
                      <span className="text-expense amount">
                        −
                        <Money minor={group.expense} currency={displayCurrency} absolute />
                        {group.approximate ? <span title={T.txpApproxHint}> *</span> : null}
                      </span>
                    ) : null}
                    {group.income === 0 && group.expense === 0 ? (
                      <span className="muted">{T.txpTransferOnly}</span>
                    ) : null}
                  </div>
                </header>

                <ul className="txp__list">
                  {group.items.map((item) => {
                    const isTransfer = item.type === 'transfer'
                    const isIncome = item.type === 'income'
                    const title =
                      item.merchant ??
                      (item.categoryName
                        ? categoryLabel(item.categoryName)
                        : isTransfer
                          ? T.txpTransfer
                          : T.txpTransaction)
                    const meta = isTransfer
                      ? `${item.accountName} → ${item.counterpartAccountName ?? T.txpOtherAccount}`
                      : [
                          item.categoryName ? categoryLabel(item.categoryName) : null,
                          item.accountName,
                          item.time
                        ]
                          .filter(Boolean)
                          .join(' · ')
                    return (
                      <li key={item.id} className="txp__row" data-tx-id={item.id}>
                        <button
                          type="button"
                          className="txp__rowMain"
                          onClick={() => showDetail(item)}
                          aria-label={`${T.txpViewDetail} ${title}`}
                        >
                          <span
                            className="txp__rowIcon"
                            style={{
                              background: isTransfer ? 'var(--bg-inset)' : `${item.categoryColor ?? '#6B7280'}1f`,
                              color: item.categoryColor ?? 'var(--text-secondary)'
                            }}
                          >
                            <Icon
                              name={
                                isTransfer
                                  ? 'arrow-left-right'
                                  : iconNameOr(item.categoryIcon, isIncome ? 'trending-up' : 'tag')
                              }
                              size={16}
                            />
                          </span>

                          <span className="txp__rowBody">
                            <span className="txp__rowTitle truncate">{title}</span>
                            <span className="txp__rowMeta truncate">{meta}</span>
                          </span>

                          <span
                            className={`txp__rowAmount amount ${
                              isTransfer ? 'text-neutral' : isIncome ? 'text-income' : 'text-expense'
                            }`}
                          >
                            {isTransfer || isIncome ? null : '−'}
                            <Money
                              minor={Math.abs(item.amount)}
                              currency={item.accountCurrency}
                              convert
                              showOriginal
                              signed={isIncome}
                              absolute
                            />
                          </span>
                        </button>

                        <div className="txp__rowActions">
                          <button
                            type="button"
                            className="btn btn-ghost btn-icon txp__rowEdit"
                            aria-label={`${T.edit} ${title}`}
                            title={`${T.edit} ${title}`}
                            disabled={pending}
                            onClick={() => (isTransfer ? openEditTransfer(item) : openEdit(item))}
                          >
                            <Icon name="edit" size={16} />
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost btn-icon"
                            aria-label={`${T.delete} ${title}`}
                            title={`${T.delete} ${title}`}
                            disabled={pending}
                            onClick={() => void handleDelete(item)}
                          >
                            <Icon name="trash" size={16} />
                          </button>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </section>
            )
          })}

          {page && page.total > (page.items?.length ?? 0) ? (
            <p className="muted txp__truncated">{txnTruncatedNotice(page.items.length, page.total)}</p>
          ) : null}
        </div>
      )}

      <style>{TRANSACTIONS_CSS}</style>
    </div>
  )
}

const TRANSACTIONS_CSS = `
.txp { display: flex; flex-direction: column; gap: var(--space-5); padding-bottom: var(--space-8); }
.txp__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  flex-wrap: wrap;
}
.txp__title { font-size: var(--text-2xl); font-weight: var(--weight-semibold); margin: 0; color: var(--text-primary); }
.txp__sub { margin: 2px 0 0; font-size: var(--text-sm); }
.txp__ratesNotice {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  background: var(--warning-subtle);
  color: var(--warning);
  border-radius: var(--radius-md);
  padding: var(--space-3) var(--space-4);
  font-size: var(--text-sm);
}
.txp__ratesNotice > span { flex: 1; min-width: 0; }
.txp__filters { display: flex; flex-direction: column; gap: var(--space-4); }
.txp__month { display: flex; align-items: center; gap: var(--space-2); }
.txp__monthLabel {
  font-weight: var(--weight-semibold);
  min-width: 150px;
  text-align: center;
  color: var(--text-primary);
}
.txp__filterRow {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr);
  gap: var(--space-3);
  align-items: end;
}
@media (max-width: 900px) {
  .txp__filterRow { grid-template-columns: 1fr; }
}
.txp__search { margin: 0; }
.txp__searchWrap {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-surface);
  padding: 0 var(--space-3);
  color: var(--text-tertiary);
}
.txp__searchWrap:focus-within { border-color: var(--accent); box-shadow: 0 0 0 var(--ring-width) var(--ring); }
.txp__searchWrap .input { border: none; outline: none; padding-left: 0; padding-right: 0; background: transparent; }
.txp__groups { display: flex; flex-direction: column; gap: var(--space-5); }
.txp__group { display: flex; flex-direction: column; gap: var(--space-2); }
.txp__groupHead {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
  padding: 0 var(--space-1);
}
.txp__groupDate {
  font-size: var(--text-sm);
  font-weight: var(--weight-semibold);
  color: var(--text-secondary);
  margin: 0;
  text-transform: none;
}
.txp__groupTotals { display: flex; gap: var(--space-3); font-size: var(--text-sm); align-items: baseline; }
.txp__groupTotalsLabel { font-size: var(--text-xs); color: var(--text-tertiary); }
.txp__list {
  list-style: none;
  margin: 0;
  padding: 0;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  overflow: hidden;
}
.txp__row {
  display: flex;
  align-items: center;
  border-bottom: 1px solid var(--border-subtle);
}
.txp__row:last-child { border-bottom: none; }
.txp__row:hover { background: var(--bg-hover); }
.txp__rowMain {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  background: transparent;
  border: none;
  font: inherit;
  text-align: left;
  cursor: pointer;
  color: inherit;
}
.txp__rowIcon {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: var(--radius-full);
  flex-shrink: 0;
}
.txp__rowBody { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.txp__rowTitle { font-size: var(--text-sm); font-weight: var(--weight-medium); color: var(--text-primary); }
.txp__rowMeta { font-size: var(--text-xs); color: var(--text-secondary); }
.txp__rowAmount {
  font-size: var(--text-sm);
  font-weight: var(--weight-semibold);
  white-space: nowrap;
  flex-shrink: 0;
}
.txp__rowActions {
  display: flex;
  gap: 2px;
  align-items: center;
  padding-right: var(--space-3);
}
/*
  EDIT is always visible; DELETE waits for the pointer.

  Both used to share a single opacity-0 rule that lifted on hover, and the effect was that the
  editing feature was reported as missing — a control nobody can see is a control that does not
  exist. Editing is the reversible, everyday action and it is the one worth the permanent column
  of pixels; deleting is not, so it keeps the hover reveal and the confirmation dialog behind it.
*/
.txp__rowEdit { opacity: 0.55; transition: opacity var(--duration-fast) var(--ease-out); }
.txp__row:hover .txp__rowEdit,
.txp__row:focus-within .txp__rowEdit { opacity: 1; }
.txp__rowActions > .btn:not(.txp__rowEdit) {
  opacity: 0;
  transition: opacity var(--duration-fast) var(--ease-out);
}
.txp__row:hover .txp__rowActions > .btn:not(.txp__rowEdit),
.txp__row:focus-within .txp__rowActions > .btn:not(.txp__rowEdit) { opacity: 1; }
@media (prefers-reduced-motion: reduce) {
  .txp__rowActions > .btn,
  .txp__rowEdit { transition: none; }
}
.txp__truncated { font-size: var(--text-sm); text-align: center; padding: var(--space-3) 0; }
`
