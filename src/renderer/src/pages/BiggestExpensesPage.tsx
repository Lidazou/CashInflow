import { useEffect, useMemo } from 'react'
import { Icon } from '@renderer/components/Icon'
import { Money, RateTicker } from '@renderer/components/Money'
import { useAction, useAsync } from '@renderer/hooks/useData'
import { useAppStore, useDisplaySettings } from '@renderer/store/app'
import { useRateStore } from '@renderer/store/rates'
import { useUiStore } from '@renderer/store/ui'
import { formatMoney } from '@shared/lib/money'
import { cycleFor, cycleFromKey, shiftCycle } from '@shared/lib/periods'
import { today } from '@shared/lib/dates'
import {
  T,
  categoryLabel,
  dateHeadingZh,
  exportedRowsNotice,
  rankingCapNote,
  rankingCapNotice,
  txnCountLabel
} from '@shared/lib/i18n'
import type { BiggestExpense, DateFormat, TransactionWithRefs } from '@shared/types'

/**
 * Biggest expenses (spec §12).
 *
 * The dashboard shows the top five of a settlement cycle; this page is the "View
 * all" destination behind it, and it exists so the ranking can be inspected
 * rather than merely glimpsed. The rows arrive already sorted descending by
 * magnitude from `statsBiggestExpenses`, which also supplies each row's `rank`,
 * its `ratio` to the largest expense, and — because amounts in different
 * currencies are not comparable — the converted amount and currency to show.
 *
 * WHY THE SUMMARY IS NOT THE SUM OF THE LIST
 * ------------------------------------------
 * Summing the visible rows would be a period total only by accident: the query
 * is capped at RANKING_LIMIT rows and the cap is a UI decision, not a financial
 * one. The period total therefore comes from the period aggregate, and the list's
 * own sum is used solely as the fallback when that aggregate cannot be read —
 * clearly labelled as such, because a total that silently describes a subset is
 * exactly the kind of number a finance app must never show.
 *
 * MONEY is an integer in minor units throughout. A row is rendered from
 * `convertedAmount` (the service converted it exactly once, into the display
 * currency) and this file never multiplies an amount by a rate itself. Rows whose
 * currency had no rate are flagged 「无汇率」 rather than quietly passed through
 * at 1:1, and `ratio` is used only for a bar's width.
 */

/** Enough rows to cover a heavy period without shipping the whole ledger. */
const RANKING_LIMIT = 100

/** A very small expense still deserves a perceptible bar; mirrors charts.tsx. */
const MIN_BAR_PERCENT = 2

export default function BiggestExpensesPage(): React.JSX.Element {
  const activeMonth = useAppStore((state) => state.activeMonth)
  const setActiveMonth = useAppStore((state) => state.setActiveMonth)
  const cycleStartDay = useAppStore((state) => state.settings?.cycleStartDay ?? 1)
  const pushToast = useAppStore((state) => state.pushToast)
  const refreshData = useAppStore((state) => state.refreshData)
  const { dateFormat } = useDisplaySettings()

  const displayCurrency = useRateStore((state) => state.displayCurrency)
  const loadRates = useRateStore((state) => state.load)
  const refreshRates = useRateStore((state) => state.refresh)

  const showDetail = useUiStore((state) => state.showTransactionDetail)
  const openEditTransaction = useUiStore((state) => state.openEditTransaction)
  const openEditTransfer = useUiStore((state) => state.openEditTransfer)

  const { run, pending } = useAction()

  /** The settlement cycle the strip shows, derived from the stored cycle key. */
  const cycle = useMemo(() => cycleFromKey(activeMonth, cycleStartDay), [activeMonth, cycleStartDay])

  // Rates are shared app state, but a page that converts money must not depend on
  // some other page having loaded them first.
  useEffect(() => {
    void loadRates()
  }, [loadRates])

  // The payload is tagged with the period it describes. `useAsync` keeps the
  // previous value visible while the next one is in flight, and a ranking drawn
  // under the wrong period's heading would be a fabricated figure rather than a
  // stale one.
  const { data: snapshot, loading, error, reload } = useAsync<{ cycleKey: string; rows: BiggestExpense[] } | null>(
    () =>
      window.api.statsBiggestExpenses(activeMonth, RANKING_LIMIT).then((rows) => ({ cycleKey: activeMonth, rows })),
    [activeMonth]
  )

  // The authoritative period figures for the summary strip. The anchor must be a
  // date inside the cycle: `statsStatistics('month')` resolves the cycle
  // CONTAINING its anchor, so a first-of-month anchor would report the previous
  // cycle whenever the settlement cycle does not start on the 1st.
  const { data: cycleStats } = useAsync(
    () => window.api.statsStatistics('month', cycle.start),
    [cycle.start]
  )

  // `null` means "nothing loaded for the period being shown" — either the first
  // load or a period change — which is exactly when a skeleton is honest.
  const rowsForMonth = snapshot && snapshot.cycleKey === activeMonth ? snapshot.rows : null
  const rows = useMemo(() => rowsForMonth ?? [], [rowsForMonth])

  /**
   * Only ever the sum of what is on screen — never presented as the period total.
   * `convertedAmount` already carries the service's conversion, so this adds
   * integers in one currency and performs no rate arithmetic of its own.
   */
  const shownTotal = useMemo(
    () => rows.reduce((sum, row) => sum + Math.abs(row.convertedAmount ?? row.amount), 0),
    [rows]
  )
  const shownTotalUnconverted = rows.some((row) => row.conversionAvailable === false)

  const truncated = rows.length >= RANKING_LIMIT
  const cycleStatsForCycle = cycleStats && cycleStats.from === cycle.start ? cycleStats : null
  const monthTotal = cycleStatsForCycle ? cycleStatsForCycle.totals.expense : null
  const monthCurrency = cycleStatsForCycle?.currency ?? displayCurrency
  const largest = rows.length > 0 ? rows[0] : null

  async function handleExport(): Promise<void> {
    const result = await run(() =>
      window.api.exportCsv({ from: cycle.start, to: cycle.end, types: ['expense'] })
    )
    // `run` already surfaced a failure as a toast; a canceled save dialog is not
    // an event worth announcing.
    if (result === null || result.canceled) return

    pushToast({
      tone: 'success',
      message: exportedRowsNotice(result.rows),
      detail: result.path ?? undefined
    })
  }

  /** Pull fresh rates, then re-read the data so every converted figure follows. */
  async function handleRefreshRates(): Promise<void> {
    await refreshRates(true)
    refreshData()
  }

  return (
    <div className="bxp">
      <header className="bxp__head">
        <div>
          <h1 className="bxp__title">{T.bxpTitle}</h1>
          <p className="muted bxp__sub">{T.bxpSubtitle}</p>
        </div>

        <div className="bxp__controls">
          <div className="bxp__month">
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              aria-label={T.bxpPrevPeriod}
              onClick={() => setActiveMonth(shiftCycle(`${activeMonth}-01`, cycleStartDay, -1).key)}
            >
              <Icon name="chevron-left" />
            </button>
            <span className="bxp__monthLabel">{cycle.label}</span>
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              aria-label={T.bxpNextPeriod}
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

          {/* Placed next to the period strip on purpose: a converted figure is
              only trustworthy alongside the rate and its freshness. */}
          <RateTicker onRefresh={() => void handleRefreshRates()} />

          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => void handleExport()}
            disabled={pending || loading}
          >
            <Icon name="export" size={16} />
            {pending ? T.bxpExporting : T.export}
          </button>
        </div>
      </header>

      {error !== null ? (
        <div className="card empty-state" role="alert">
          <Icon name="alert" size={28} />
          <p className="empty-state-title" style={{ color: 'var(--expense)' }}>
            {error}
          </p>
          <p className="muted">{T.bxpLoadFailed}</p>
          <button type="button" className="btn btn-secondary" onClick={reload}>
            <Icon name="refresh" size={16} />
            {T.retry}
          </button>
        </div>
      ) : rowsForMonth === null ? (
        <div className="stack-sm" aria-busy="true">
          <div className="skeleton" style={{ height: 96 }} />
          {[0, 1, 2, 3, 4, 5].map((row) => (
            <div key={row} className="skeleton" style={{ height: 58 }} />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="card empty-state">
          <Icon name="receipt" size={28} />
          <p className="empty-state-title">{T.bxpEmpty}</p>
          <p className="muted">{T.bxpEmptyHint}</p>
        </div>
      ) : (
        <>
          <section className="card bxp__summaryCard" aria-label={T.bxpSummary}>
            <div className="bxp__summary">
              <Stat
                label={T.bxpMonthTotal}
                value={
                  <>
                    <Money minor={monthTotal ?? shownTotal} currency={monthCurrency} absolute />
                    {monthTotal === null && shownTotalUnconverted ? <NoRateMarker /> : null}
                  </>
                }
                note={monthTotal !== null ? `${cycle.label} · ${T.bxpAllInPeriod}` : T.bxpListedSum}
              />
              <Stat
                label={T.bxpListedCount}
                value={String(rows.length)}
                note={truncated ? rankingCapNotice(RANKING_LIMIT) : T.bxpAllListed}
              />
              <Stat
                label={T.bxpLargest}
                value={
                  largest ? (
                    <>
                      <Money
                        minor={largest.convertedAmount ?? Math.abs(largest.amount)}
                        currency={largest.displayCurrency ?? largest.accountCurrency}
                        absolute
                      />
                      {largest.conversionAvailable === false ? <NoRateMarker /> : null}
                    </>
                  ) : (
                    T.bxpNothingYet
                  )
                }
                note={largest ? (largest.merchant ?? categoryLabel(largest.categoryName)) : T.bxpNothingYet}
              />
            </div>
          </section>

          <ol className="bxp__list" aria-label={`${T.bxpTitle} · ${txnCountLabel(rows.length)}`}>
            {rows.map((row) => (
              <RankedRow
                key={row.id}
                row={row}
                dateFormat={dateFormat}
                onOpen={showDetail}
                onEdit={openEditTransaction}
                onEditTransfer={openEditTransfer}
              />
            ))}
          </ol>

          {truncated ? (
            <p className="muted bxp__note">{rankingCapNote(RANKING_LIMIT, cycle.label)}</p>
          ) : null}
        </>
      )}

      <style>{BIGGEST_EXPENSES_CSS}</style>
    </div>
  )
}

/* ------------------------------------------------------------------------- */
/* presentational helpers                                                    */
/* ------------------------------------------------------------------------- */

function Stat({
  label,
  value,
  note
}: {
  label: string
  value: React.ReactNode
  note: string
}): React.JSX.Element {
  return (
    <div className="bxp__stat">
      <span className="bxp__statLabel">{label}</span>
      <span className="bxp__statValue amount">{value}</span>
      <span className="bxp__statNote">{note}</span>
    </div>
  )
}

/**
 * Flags a figure that could not be converted.
 *
 * A converted-looking number that was never converted is the most dangerous
 * thing this screen could show, so the marker is attached to the amount itself.
 */
function NoRateMarker(): React.JSX.Element {
  return (
    <span className="bxp__noRate" title={T.bxpNoRateHint}>
      {T.bxpNoRate}
    </span>
  )
}

function RankedRow({
  row,
  dateFormat,
  onOpen,
  onEdit,
  onEditTransfer
}: {
  row: BiggestExpense
  dateFormat: DateFormat
  onOpen: (transaction: TransactionWithRefs) => void
  onEdit: (transaction: TransactionWithRefs) => void
  onEditTransfer: (transaction: TransactionWithRefs) => void
}): React.JSX.Element {
  // Merchant first, then the category, then a neutral label: a row with no
  // merchant is common (cash spending) and must not render as an empty line.
  const title = row.merchant ?? (row.categoryName ? categoryLabel(row.categoryName) : T.expense)
  const meta = [categoryLabel(row.categoryName), row.accountName, dateHeadingZh(row.date, dateFormat)].join(' · ')

  // What is shown is the service's converted amount when it exists, so rows in
  // different currencies rank and read consistently. Formatting it as text is for
  // the accessible name only; no rate is applied here.
  const amountMinor = row.convertedAmount ?? Math.abs(row.amount)
  const amountCurrency = row.displayCurrency ?? row.accountCurrency
  const amountText = formatMoney(amountMinor, amountCurrency, { absolute: true })

  // `ratio` is data from the service and may be 0 (or absent in an older
  // payload); a bar is then simply not drawn rather than sized by NaN.
  const ratio = Number.isFinite(row.ratio) ? Math.min(Math.max(row.ratio, 0), 1) : 0
  const widthPercent = ratio > 0 ? Math.round(Math.max(ratio * 100, MIN_BAR_PERCENT) * 100) / 100 : 0

  return (
    <li className="bxp__row">
      <button
        type="button"
        className="bxp__main"
        onClick={() => onOpen(row)}
        aria-label={`${T.bxpViewDetail} ${title}，${amountText}`}
      >
        <span className="bxp__rank num" aria-hidden="true">
          {row.rank}
        </span>
        <span className="bxp__body">
          <span className="bxp__name truncate">{title}</span>
          <span className="bxp__meta muted truncate">{meta}</span>
        </span>
        <span className="bxp__amount amount">
          −<Money minor={amountMinor} currency={amountCurrency} absolute />
          {row.conversionAvailable === false ? <NoRateMarker /> : null}
        </span>
      </button>

      <button
        type="button"
        className="btn btn-ghost btn-icon bxp__edit"
        aria-label={`${T.edit} ${title}`}
        onClick={() => (row.type === 'transfer' ? onEditTransfer(row) : onEdit(row))}
      >
        <Icon name="edit" size={16} />
      </button>

      {/* Decorative: the amount beside it carries the value. */}
      <span className="bxp__track" aria-hidden="true">
        <span className="bxp__fill" style={{ width: `${widthPercent}%` }} />
      </span>
    </li>
  )
}

const BIGGEST_EXPENSES_CSS = `
.bxp { display: flex; flex-direction: column; gap: var(--space-5); padding-bottom: var(--space-8); }
.bxp__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  flex-wrap: wrap;
}
.bxp__title { font-size: var(--text-2xl); font-weight: var(--weight-semibold); margin: 0; color: var(--text-primary); }
.bxp__sub { margin: 2px 0 0; font-size: var(--text-sm); }
.bxp__controls { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.bxp__controls .rate-ticker { flex: 1 1 auto; }
.bxp__month { display: flex; align-items: center; gap: var(--space-2); }
.bxp__monthLabel {
  min-width: 150px;
  text-align: center;
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
}

/* summary strip */
.bxp__summaryCard { min-width: 0; }
.bxp__summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-3); }
.bxp__stat {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
  padding: var(--space-3);
  background: var(--bg-inset);
  border-radius: var(--radius-md);
}
.bxp__statLabel {
  font-size: var(--text-2xs);
  font-weight: var(--weight-medium);
  letter-spacing: 0.06em;
  color: var(--text-secondary);
}
.bxp__statValue {
  font-size: var(--text-lg);
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bxp__statNote { font-size: var(--text-2xs); color: var(--text-tertiary); }

/* ranking */
.bxp__list {
  list-style: none;
  margin: 0;
  padding: 0;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  overflow: hidden;
}
.bxp__row {
  --bxp-rank-width: 24px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  grid-template-areas: 'main edit' 'track track';
  align-items: center;
  column-gap: var(--space-2);
  padding: var(--space-2) var(--space-2) var(--space-3) 0;
  border-bottom: 1px solid var(--border-subtle);
  transition: var(--transition-base);
}
.bxp__row:last-child { border-bottom: none; }
.bxp__row:hover { background: var(--bg-hover); }
.bxp__main {
  grid-area: main;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
  padding: var(--space-1) var(--space-2) var(--space-1) var(--space-4);
  text-align: left;
  color: inherit;
}
.bxp__rank {
  flex-shrink: 0;
  width: var(--bxp-rank-width);
  text-align: right;
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
  color: var(--text-tertiary);
}
.bxp__body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.bxp__name { font-size: var(--text-sm); font-weight: var(--weight-medium); color: var(--text-primary); }
.bxp__meta { font-size: var(--text-xs); }
.bxp__amount {
  flex-shrink: 0;
  white-space: nowrap;
  font-size: var(--text-sm);
  font-weight: var(--weight-semibold);
  color: var(--expense);
}
.bxp__noRate {
  margin-left: var(--space-1);
  padding: 0 5px;
  border-radius: var(--radius-sm);
  background: var(--warning-subtle);
  color: var(--warning);
  font-size: var(--text-2xs);
  font-weight: var(--weight-medium);
}
.bxp__edit { grid-area: edit; }
.bxp__track {
  grid-area: track;
  height: 5px;
  margin-left: calc(var(--space-4) + var(--bxp-rank-width) + var(--space-3));
  margin-right: var(--space-2);
  background: var(--border-subtle);
  border-radius: var(--radius-full);
  overflow: hidden;
}
.bxp__fill {
  display: block;
  height: 100%;
  background: var(--expense);
  border-radius: var(--radius-full);
  transition: width var(--duration-base) var(--ease-out);
}
.bxp__note { font-size: var(--text-sm); text-align: center; }

@media (max-width: 720px) {
  .bxp__summary { grid-template-columns: minmax(0, 1fr); }
}
`
