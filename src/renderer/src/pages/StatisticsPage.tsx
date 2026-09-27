import { useMemo, useState } from 'react'
import { DonutChart, HorizontalBarChart, LineChart } from '@renderer/components/charts'
import { categoryLabel } from '@shared/lib/i18n'
import { Icon, iconNameOr } from '@renderer/components/Icon'
import { useAsync } from '@renderer/hooks/useData'
import { useDisplaySettings } from '@renderer/store/app'
import { useUiStore } from '@renderer/store/ui'
import { formatMoney } from '@shared/lib/money'
import { categoryColorFor } from '@shared/lib/category-colors'
import {
  addDays,
  addMonths,
  calendarGridStart,
  formatDate,
  formatDayHeading,
  formatMonthLabel,
  monthKeyOf,
  today,
  weekdayNameShort
} from '@shared/lib/dates'
import type {
  CalendarDay,
  CategoryBreakdownRow,
  DateFormat,
  PeriodTotals,
  StatisticsGranularity,
  StatisticsResult,
  TransactionWithRefs
} from '@shared/types'

/**
 * Statistics (spec §16, §17, §18).
 *
 * Three things live on this page and nothing else, because a screen that shows
 * every aggregate at once shows nothing: a period header with the three figures
 * that matter (income, expense, net), exactly two charts (expense trend and the
 * category split), and the month calendar with its day drill-down.
 *
 * WHY THE FIGURES COME FROM ONE CALL
 * ----------------------------------
 * The header, the trend and the category split all read from a single
 * `statsStatistics` result. Deriving them from one response means the ring can
 * never disagree with the total above it — a class of bug that appears the
 * moment two queries are fired in parallel and one resolves a write earlier than
 * the other.
 *
 * MONEY is always an integer in minor units here (1850 === RM 18.50); the only
 * arithmetic performed is integer addition, and division happens solely to
 * derive geometry (a share, a bar width), always guarded against a zero
 * denominator.
 *
 * STALE-RESULT GUARD
 * ------------------
 * `useAsync` deliberately keeps the previous value visible while a new one is in
 * flight, so a rapid period change would otherwise paint the new month's heading
 * over the old month's calendar. Every result that carries its own identity
 * (the calendar's `monthKey`, a day's totals, a day's transaction list) is
 * therefore matched against what is currently selected before it is rendered.
 */

const GRANULARITIES: ReadonlyArray<{ value: StatisticsGranularity; label: string }> = [
  { value: 'day', label: '日' },
  { value: 'week', label: '周' },
  { value: 'month', label: '月' },
  { value: 'year', label: '年' }
]

/** Chart caption wording for the selected granularity, e.g. "按日汇总的支出". */
function granularityLabel(granularity: StatisticsGranularity): string {
  switch (granularity) {
    case 'day':
      return '日'
    case 'week':
      return '周'
    case 'year':
      return '年'
    case 'month':
    default:
      return '月'
  }
}

/** Six rows of seven: a month view never reflows as the user pages through it. */
const CALENDAR_CELLS = 42


function categoryColorOf(row: CategoryBreakdownRow): string {
  /*
    One source of truth (v1.6.0).

    This used to keep its own `var(--chart-1..8)` fallback table "in step with the palette
    in components/charts.tsx" — two lists that had to be edited together and were one
    forgotten commit away from disagreeing. The token table resolves a stored colour, an
    old default, or a stable colour for a category the app has never heard of, so the same
    category is now the same colour on the statistics page, the ring, the stack and the
    transaction list.
  */
  return categoryColorFor(row.categoryName, row.categoryColor)
}

/** Share as a whole percentage; a non-zero sliver reads "<1%" rather than "0%". */
function shareLabel(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return '0%'
  const percent = share * 100
  if (percent < 1) return '<1%'
  return `${Math.round(percent)}%`
}

/** Move a 'YYYY-MM' key by whole months, clamping safely at year boundaries. */
function shiftMonthKey(monthKey: string, delta: number): string {
  return addMonths(`${monthKey}-01`, delta).slice(0, 7)
}

export default function StatisticsPage(): React.JSX.Element {
  const { currency, dateFormat, startOfWeek } = useDisplaySettings()

  const showDetail = useUiStore((state) => state.showTransactionDetail)
  const openEditTransaction = useUiStore((state) => state.openEditTransaction)
  const openEditTransfer = useUiStore((state) => state.openEditTransfer)
  const openCreateTransaction = useUiStore((state) => state.openCreateTransaction)

  const [granularity, setGranularity] = useState<StatisticsGranularity>('month')
  const [anchor, setAnchor] = useState<string>(() => today())
  const [calendarMonthKey, setCalendarMonthKey] = useState<string>(() => monthKeyOf(today()))
  const [selectedDate, setSelectedDate] = useState<string | null>(null)

  // --- period statistics ---------------------------------------------------
  const {
    data: result,
    loading,
    error,
    reload
  } = useAsync<StatisticsResult>(() => window.api.statsStatistics(granularity, anchor), [granularity, anchor])

  // --- calendar for the calendar month ------------------------------------
  const {
    data: calendar,
    loading: calendarLoading,
    error: calendarError,
    reload: reloadCalendar
  } = useAsync(() => window.api.statsCalendar(calendarMonthKey), [calendarMonthKey])

  // `useAsync` keeps the previous month's payload while the next one loads, so a
  // stale grid must be discarded rather than drawn under the new heading.
  const calendarForMonth = calendar && calendar.monthKey === calendarMonthKey ? calendar : null
  const gridStart = calendarForMonth?.gridStart ?? calendarGridStart(calendarMonthKey, startOfWeek)

  const daysByDate = useMemo(() => {
    const map = new Map<string, CalendarDay>()
    for (const day of calendarForMonth?.days ?? []) map.set(day.date, day)
    return map
  }, [calendarForMonth])

  const calendarCells = useMemo(
    () => Array.from({ length: CALENDAR_CELLS }, (_, index) => addDays(gridStart, index)),
    [gridStart]
  )

  const weekdayOrder = useMemo(
    () => Array.from({ length: 7 }, (_, index) => (startOfWeek + index) % 7),
    [startOfWeek]
  )

  // --- selected day --------------------------------------------------------
  const selectedCalendarDay = selectedDate ? daysByDate.get(selectedDate) ?? null : null

  // The snapshot carries its own date so a slow response for the previously
  // selected day cannot be rendered as if it belonged to the current one.
  const { data: dayTotalsSnapshot } = useAsync<{ date: string; totals: PeriodTotals } | null>(
    () =>
      selectedDate
        ? window.api.statsDayTotals(selectedDate).then((totals) => ({ date: selectedDate, totals }))
        : Promise.resolve(null),
    [selectedDate]
  )
  const selectedDayTotals =
    dayTotalsSnapshot && dayTotalsSnapshot.date === selectedDate ? dayTotalsSnapshot.totals : selectedCalendarDay

  const {
    data: dayPageSnapshot,
    loading: dayTransactionsLoading,
    error: dayTransactionsError,
    reload: reloadDayTransactions
  } = useAsync<{ date: string; items: TransactionWithRefs[]; total: number } | null>(
    () =>
      selectedDate
        ? window.api
            .transactionsList({ from: selectedDate, to: selectedDate, limit: 200, orderBy: 'amount', orderDir: 'desc' })
            .then((page) => ({ date: selectedDate, items: page.items, total: page.total }))
        : Promise.resolve(null),
    [selectedDate]
  )
  const dayTransactions = dayPageSnapshot && dayPageSnapshot.date === selectedDate ? dayPageSnapshot.items : []
  const dayTransactionsTotal = dayPageSnapshot && dayPageSnapshot.date === selectedDate ? dayPageSnapshot.total : 0

  const reportCurrency = result?.currency ?? currency
  const hasData = result !== null && (result.totals.transactionCount > 0 || result.categories.length > 0)
  const showSkeleton = loading && result === null
  const showErrorPanel = error !== null && result === null
  const isUpdating = loading && result !== null

  /**
   * Changing the unit re-anchors the calendar only when the unit *is* a month;
   * moving the period while on the month unit keeps the two views in step, so
   * the charts and the grid below them always describe the same month.
   */
  function selectGranularity(next: StatisticsGranularity): void {
    setGranularity(next)
    if (next === 'month') setCalendarMonthKey(monthKeyOf(anchor))
  }

  function movePeriod(delta: number): void {
    const next =
      granularity === 'day'
        ? addDays(anchor, delta)
        : granularity === 'week'
          ? addDays(anchor, delta * 7)
          : granularity === 'year'
            ? addMonths(anchor, delta * 12)
            : addMonths(anchor, delta)
    setAnchor(next)
    if (granularity === 'month') {
      setCalendarMonthKey(monthKeyOf(next))
      setSelectedDate(null)
    }
  }

  function moveCalendarMonth(delta: number): void {
    setCalendarMonthKey((current) => shiftMonthKey(current, delta))
    // The panel below describes a day that is about to leave the grid.
    setSelectedDate(null)
  }

  const periodLabel = result ? periodHeading(result, dateFormat) : ''
  // Resolved once per render so every cell agrees on which day "today" is.
  const todayDate = today()

  return (
    <div className="stp">
      <header className="stp__head">
        <div>
          <h1 className="stp__title">统计分析</h1>
          <p className="muted stp__sub">看看你的钱从哪来、花到哪去。</p>
        </div>

        <div className="stp__tabs" role="tablist" aria-label="统计周期">
          {GRANULARITIES.map((option) => (
            <button
              key={option.value}
              type="button"
              role="tab"
              id={`stp-tab-${option.value}`}
              className="stp__tab"
              aria-selected={granularity === option.value}
              aria-controls="stp-period"
              onClick={() => selectGranularity(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </header>

      {showErrorPanel ? (
        <ErrorPanel
          message={error}
          detail="The statistics could not be loaded."
          onRetry={reload}
        />
      ) : showSkeleton ? (
        <StatisticsSkeleton />
      ) : result === null ? (
        <ErrorPanel
          message="No statistics were returned for this period."
          detail="This is a loading problem, not missing data. Try again."
          onRetry={reload}
        />
      ) : (
        <>
          <div
            className="stp__periodWrap"
            id="stp-period"
            role="tabpanel"
            aria-labelledby={`stp-tab-${granularity}`}
            aria-busy={isUpdating}
          >
            {/* ---- period header ------------------------------------------ */}
            <section className="card stp__period" aria-label="周期概览">
              <div className="stp__periodTop">
                <div className="stp__periodNav">
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon"
                    aria-label="上一个周期"
                    onClick={() => movePeriod(-1)}
                  >
                    <Icon name="chevron-left" />
                  </button>
                  <span className="stp__periodLabel">{periodLabel}</span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon"
                    aria-label="下一个周期"
                    onClick={() => movePeriod(1)}
                  >
                    <Icon name="chevron-right" />
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAnchor(today())}>
                    今天
                  </button>
                </div>

                <p className="muted stp__periodRange">
                  {formatDate(result.from, dateFormat)} – {formatDate(result.to, dateFormat)} ·{' '}
                  {result.totals.transactionCount} 笔
                  {isUpdating ? ' · 更新中…' : ''}
                </p>
              </div>

              <div className="stp__figures">
                <Figure label="收入" value={formatMoney(result.totals.income, reportCurrency)} tone="income" />
                <Figure label="支出" value={formatMoney(result.totals.expense, reportCurrency)} tone="expense" />
                <Figure
                  label="结余"
                  value={formatMoney(result.totals.net, reportCurrency, { signed: true })}
                  tone={result.totals.net >= 0 ? 'income' : 'expense'}
                />
              </div>
            </section>

            {error !== null ? (
              <div className="card stp__staleNote" role="alert">
                <Icon name="alert" size={16} />
                <span>
                  {error} 上方数据未能刷新，当前显示的是上次成功加载的周期。
                </span>
                <button type="button" className="btn btn-secondary btn-sm" onClick={reload}>
                  <Icon name="refresh" size={14} />
                  重试
                </button>
              </div>
            ) : null}

            {/* ---- charts: exactly two ------------------------------------ */}
            {hasData ? (
              <div className="stp__charts">
                <section className="card stp__chartCard" aria-label="支出趋势">
                  <div className="stp__chartHead">
                    <h2 className="card-title">支出趋势</h2>
                    <span className="stp__caption">按{granularityLabel(granularity)}汇总的支出</span>
                  </div>
                  <LineChart
                    points={result.trend.map((point) => ({ label: point.label, value: point.expense }))}
                    color="var(--expense)"
                    fill
                    currency={reportCurrency}
                  />
                </section>

                <section className="card stp__chartCard" aria-label="分类构成">
                  <div className="stp__chartHead">
                    <h2 className="card-title">分类构成</h2>
                    <span className="stp__caption">
                      {result.categories.length} 个分类
                    </span>
                  </div>

                  {result.categories.length === 0 ? (
                    <p className="muted stp__caption">这个周期还没有支出记录。</p>
                  ) : (
                    <div className="stp__catSplit">
                      <div className="stp__donut">
                        <DonutChart
                          segments={result.categories.map((row) => ({
                            label: categoryLabel(row.categoryName),
                            value: row.total,
                            color: categoryColorOf(row)
                          }))}
                          size={168}
                          thickness={20}
                          centerLabel={formatMoney(result.totals.expense, reportCurrency, {
                            compact: result.totals.expense >= 100_000
                          })}
                          centerSubLabel="支出合计"
                          currency={reportCurrency}
                        />
                      </div>

                      <div className="stp__cats">
                        <HorizontalBarChart
                          rows={result.categories.map((row) => ({
                            label: categoryLabel(row.categoryName),
                            value: row.total,
                            color: categoryColorOf(row),
                            meta: `${shareLabel(row.share)} · ${row.transactionCount} txn`
                          }))}
                          currency={reportCurrency}
                        />
                      </div>
                    </div>
                  )}
                </section>
              </div>
            ) : (
              /* spec §36 — an honest empty state, never an axis-only chart */
              <div className="card empty-state">
                <Icon name="statistics" size={28} />
                <p className="empty-state-title">暂无财务数据。</p>
                <p className="muted">先记录几笔交易，就能看到你的收支概览。</p>
                <button type="button" className="btn btn-primary" onClick={() => openCreateTransaction()}>
                  <Icon name="plus" size={16} />
                  记一笔
                </button>
              </div>
            )}
          </div>

          {/* ---- calendar (spec §18) -------------------------------------- */}
          <section className="card stp__calendar" aria-label="日历">
            <div className="stp__calHead">
              <div className="stp__calNav">
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  aria-label="上个月"
                  onClick={() => moveCalendarMonth(-1)}
                >
                  <Icon name="chevron-left" />
                </button>
                <span className="stp__calMonth">{formatMonthLabel(calendarMonthKey)}</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  aria-label="下个月"
                  onClick={() => moveCalendarMonth(1)}
                >
                  <Icon name="chevron-right" />
                </button>
              </div>

              <p className="muted stp__caption">
                {calendarForMonth
                  ? `${calendarForMonth.totals.transactionCount} 笔 · 支出 ${formatMoney(calendarForMonth.totals.expense, reportCurrency)}`
                  : 'Daily activity for the month'}
              </p>
            </div>

            {calendarError !== null && calendarForMonth === null ? (
              <div className="stp__calError" role="alert">
                <span className="muted">{calendarError}</span>
                <button type="button" className="btn btn-secondary btn-sm" onClick={reloadCalendar}>
                  <Icon name="refresh" size={14} />
                  重试
                </button>
              </div>
            ) : calendarLoading && calendarForMonth === null ? (
              <CalendarSkeleton />
            ) : (
              <>
                {/* Decorative: every cell already announces its own weekday. */}
                <div className="stp__calDow" aria-hidden="true">
                  {weekdayOrder.map((dayIndex) => (
                    <span key={dayIndex} className="stp__calDowCell">
                      {weekdayNameShort(dayIndex)}
                    </span>
                  ))}
                </div>

                <div className="stp__calGrid">
                  {calendarCells.map((date) => {
                    const day = daysByDate.get(date)
                    const outside = monthKeyOf(date) !== calendarMonthKey
                    const isSelected = date === selectedDate
                    const isToday = date === todayDate
                    const classes = ['stp__calCell']
                    if (outside) classes.push('stp__calCell--outside')
                    if (isToday) classes.push('stp__calCell--today')
                    if (isSelected) classes.push('stp__calCell--selected')

                    return (
                      <button
                        key={date}
                        type="button"
                        className={classes.join(' ')}
                        aria-current={isSelected ? 'date' : undefined}
                        aria-label={dayCellLabel(date, day, reportCurrency, dateFormat, outside)}
                        onClick={() => setSelectedDate(isSelected ? null : date)}
                      >
                        <span className="stp__calDayNum">{Number(date.slice(8, 10))}</span>
                        {day && day.expense > 0 ? (
                          <span className="stp__calAmount">
                            {formatMoney(day.expense, reportCurrency, { compact: day.expense >= 100_000 })}
                          </span>
                        ) : null}
                        {day && day.transactionCount > 0 ? (
                          <span className="stp__calCount">
                            {day.transactionCount} txn{day.transactionCount === 1 ? '' : 's'}
                          </span>
                        ) : null}
                      </button>
                    )
                  })}
                </div>
              </>
            )}

            {/* ---- selected day drill-down -------------------------------- */}
            {selectedDate !== null ? (
              <div className="stp__day">
                <div className="stp__dayHead">
                  <h3 className="stp__dayTitle">{formatDate(selectedDate, dateFormat, { weekday: true })}</h3>
                  <div className="stp__dayTotals">
                    <span className="text-income amount">
                      {formatMoney(selectedDayTotals?.income ?? 0, reportCurrency, { signed: true })}
                    </span>
                    <span className="text-expense amount">
                      −{formatMoney(selectedDayTotals?.expense ?? 0, reportCurrency)}
                    </span>
                    <span className={`amount ${(selectedDayTotals?.net ?? 0) >= 0 ? 'text-income' : 'text-expense'}`}>
                      结余 {formatMoney(selectedDayTotals?.net ?? 0, reportCurrency, { signed: true })}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setSelectedDate(null)}
                    aria-label="关闭当日详情"
                  >
                    <Icon name="close" size={14} />
                    关闭
                  </button>
                </div>

                {dayTransactionsError !== null ? (
                  <div className="stp__calError" role="alert">
                    <span className="muted">{dayTransactionsError}</span>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={reloadDayTransactions}>
                      <Icon name="refresh" size={14} />
                      重试
                    </button>
                  </div>
                ) : dayTransactionsLoading && dayTransactions.length === 0 ? (
                  <div className="stack-sm" aria-busy="true">
                    {[0, 1].map((row) => (
                      <div key={row} className="skeleton" style={{ height: 44 }} />
                    ))}
                  </div>
                ) : dayTransactions.length === 0 ? (
                  <p className="muted stp__caption">这一天还没有交易记录。</p>
                ) : (
                  <ul className="stp__txList">
                    {dayTransactions.map((transaction) => (
                      <DayTransactionRow
                        key={transaction.id}
                        transaction={transaction}
                        onOpen={showDetail}
                        onEdit={openEditTransaction}
                        onEditTransfer={openEditTransfer}
                      />
                    ))}
                  </ul>
                )}

                {dayTransactionsTotal > dayTransactions.length ? (
                  <p className="muted stp__caption">
                    仅显示当天金额最大的 {dayTransactions.length} 笔，共 {dayTransactionsTotal} 笔。
                  </p>
                ) : null}
              </div>
            ) : null}
          </section>
        </>
      )}

      <style>{STATISTICS_CSS}</style>
    </div>
  )
}

/* ------------------------------------------------------------------------- */
/* presentational helpers                                                    */
/* ------------------------------------------------------------------------- */

function Figure({
  label,
  value,
  tone
}: {
  label: string
  value: string
  tone: 'income' | 'expense'
}): React.JSX.Element {
  return (
    <div className="stp__figure">
      <span className="stp__figureLabel">{label}</span>
      <span className={`stp__figureValue amount ${tone === 'income' ? 'text-income' : 'text-expense'}`}>{value}</span>
    </div>
  )
}

function ErrorPanel({
  message,
  detail,
  onRetry
}: {
  message: string
  detail: string
  onRetry: () => void
}): React.JSX.Element {
  return (
    <div className="card empty-state" role="alert">
      <Icon name="alert" size={28} />
      <p className="empty-state-title" style={{ color: 'var(--expense)' }}>
        {message}
      </p>
      <p className="muted">{detail}</p>
      <button type="button" className="btn btn-secondary" onClick={onRetry}>
        <Icon name="refresh" size={16} />
        重试
      </button>
    </div>
  )
}

function StatisticsSkeleton(): React.JSX.Element {
  return (
    <div className="stack-md" aria-busy="true">
      <div className="skeleton" style={{ height: 132 }} />
      <div className="stp__charts">
        <div className="skeleton" style={{ height: 260 }} />
        <div className="skeleton" style={{ height: 260 }} />
      </div>
      <div className="skeleton" style={{ height: 340 }} />
    </div>
  )
}

function CalendarSkeleton(): React.JSX.Element {
  return (
    <div className="stp__calGrid" aria-busy="true">
      {Array.from({ length: CALENDAR_CELLS }, (_, index) => (
        <div key={index} className="skeleton" style={{ height: 54 }} />
      ))}
    </div>
  )
}

function DayTransactionRow({
  transaction,
  onOpen,
  onEdit,
  onEditTransfer
}: {
  transaction: TransactionWithRefs
  onOpen: (transaction: TransactionWithRefs) => void
  onEdit: (transaction: TransactionWithRefs) => void
  onEditTransfer: (transaction: TransactionWithRefs) => void
}): React.JSX.Element {
  const isTransfer = transaction.type === 'transfer'
  const isIncome = transaction.type === 'income'
  const title =
    transaction.merchant ?? categoryLabel(transaction.categoryName) ?? (isTransfer ? '转账' : isIncome ? '收入' : '支出')
  const meta = isTransfer
    ? `${transaction.accountName} → ${transaction.counterpartAccountName ?? 'another account'}`
    : [transaction.categoryName ? categoryLabel(transaction.categoryName) : null, transaction.accountName, transaction.time]
        .filter(Boolean)
        .join(' · ')

  return (
    <li className="stp__txRow">
      <button
        type="button"
        className="stp__txMain"
        onClick={() => onOpen(transaction)}
        aria-label={`View details for ${title}`}
      >
        <span
          className="stp__txIcon"
          style={{ color: isTransfer ? 'var(--text-secondary)' : categoryColorFor(transaction.categoryName, transaction.categoryColor) }}
        >
          <Icon
            name={isTransfer ? 'arrow-left-right' : iconNameOr(transaction.categoryIcon, isIncome ? 'trending-up' : 'tag')}
            size={15}
          />
        </span>

        <span className="stp__txBody">
          <span className="stp__txTitle truncate">{title}</span>
          <span className="stp__txMeta truncate">{meta}</span>
        </span>

        <span
          className={`stp__txAmount amount ${isTransfer ? 'text-neutral' : isIncome ? 'text-income' : 'text-expense'}`}
        >
          {isTransfer ? '' : isIncome ? '+' : '−'}
          {formatMoney(Math.abs(transaction.amount), transaction.accountCurrency)}
        </span>
      </button>

      <button
        type="button"
        className="btn btn-ghost btn-icon"
        aria-label={`Edit ${title}`}
        onClick={() => (isTransfer ? onEditTransfer(transaction) : onEdit(transaction))}
      >
        <Icon name="edit" size={16} />
      </button>
    </li>
  )
}

/* ------------------------------------------------------------------------- */
/* pure helpers                                                              */
/* ------------------------------------------------------------------------- */

/** The heading for the resolved period, built from the range the service chose. */
function periodHeading(result: StatisticsResult, dateFormat: DateFormat): string {
  switch (result.granularity) {
    case 'day':
      return formatDayHeading(result.from)
    case 'week':
      return `${formatDate(result.from, dateFormat)} – ${formatDate(result.to, dateFormat)}`
    case 'year':
      return result.from.slice(0, 4)
    case 'month':
    default:
      return formatMonthLabel(result.from.slice(0, 7))
  }
}

/** Accessible name for a calendar cell: the date, then whatever the day holds. */
function dayCellLabel(
  date: string,
  day: CalendarDay | undefined,
  currency: string,
  dateFormat: DateFormat,
  outsideMonth: boolean
): string {
  const parts = [formatDate(date, dateFormat, { weekday: true })]
  if (!day || day.transactionCount === 0) {
    parts.push('无交易')
  } else {
    parts.push(`income ${formatMoney(day.income, currency)}`)
    parts.push(`expense ${formatMoney(day.expense, currency)}`)
    parts.push(`${day.transactionCount} transaction${day.transactionCount === 1 ? '' : 's'}`)
  }
  if (outsideMonth) parts.push('不在本月')
  return parts.join(', ')
}

const STATISTICS_CSS = `
.stp { display: flex; flex-direction: column; gap: var(--space-5); padding-bottom: var(--space-8); }
.stp__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  flex-wrap: wrap;
}
.stp__title { font-size: var(--text-2xl); font-weight: var(--weight-semibold); margin: 0; color: var(--text-primary); }
.stp__sub { margin: 2px 0 0; font-size: var(--text-sm); }

/* granularity switcher */
.stp__tabs {
  display: inline-flex;
  gap: var(--space-1);
  padding: var(--space-1);
  background: var(--bg-inset);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
}
.stp__tab {
  height: 28px;
  padding: 0 var(--space-4);
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--text-secondary);
  background: transparent;
  transition: var(--transition-base);
}
.stp__tab:hover { color: var(--text-primary); background: var(--bg-hover); }
.stp__tab[aria-selected='true'] {
  background: var(--bg-surface);
  color: var(--text-primary);
  box-shadow: var(--shadow-xs);
}

/* period header */
.stp__periodWrap { display: flex; flex-direction: column; gap: var(--space-4); }
.stp__period { display: flex; flex-direction: column; gap: var(--space-4); }
.stp__periodTop {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  flex-wrap: wrap;
}
.stp__periodNav { display: flex; align-items: center; gap: var(--space-2); }
.stp__periodLabel {
  min-width: 180px;
  text-align: center;
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
}
.stp__periodRange { margin: 0; font-size: var(--text-xs); }
.stp__figures { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-3); }
.stp__figure {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
  padding: var(--space-3);
  background: var(--bg-inset);
  border-radius: var(--radius-md);
}
.stp__figureLabel {
  font-size: var(--text-2xs);
  font-weight: var(--weight-medium);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-secondary);
}
.stp__figureValue {
  font-size: var(--text-xl);
  font-weight: var(--weight-semibold);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.stp__staleNote {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin: 0;
  padding: var(--space-3);
  font-size: var(--text-sm);
  color: var(--expense);
}
.stp__staleNote .btn { margin-left: auto; }

/* charts — exactly two, plus the calendar below */
.stp__charts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(420px, 100%), 1fr));
  gap: var(--space-4);
  align-items: start;
}
.stp__chartCard {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-width: 0;
  overflow: hidden;
}
.stp__chartHead {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
  min-width: 0;
}
.stp__caption { margin: 0; font-size: var(--text-xs); }
.stp__catSplit {
  display: grid;
  grid-template-columns: minmax(140px, 176px) minmax(0, 1fr);
  gap: var(--space-4);
  align-items: start;
  min-width: 0;
}
.stp__donut { display: flex; align-items: center; justify-content: center; min-width: 0; }
.stp__cats { min-width: 0; max-height: 320px; overflow-y: auto; overflow-x: hidden; padding-right: var(--space-1); }
/* The bar chart is the legend: labels truncate, amounts stay aligned. */
.stp__cats .chart-bars__head { min-width: 0; }
.stp__cats .chart-bars__label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.stp__cats .chart-bars__meta { white-space: nowrap; }
@media (max-width: 720px) {
  .stp__figures { grid-template-columns: minmax(0, 1fr); }
  .stp__catSplit { grid-template-columns: minmax(0, 1fr); }
}

/* calendar */
.stp__calendar { display: flex; flex-direction: column; gap: var(--space-3); min-width: 0; }
.stp__calHead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  flex-wrap: wrap;
}
.stp__calNav { display: flex; align-items: center; gap: var(--space-2); }
.stp__calMonth {
  min-width: 160px;
  text-align: center;
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
}
.stp__calDow,
.stp__calGrid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: var(--space-1); }
.stp__calDowCell {
  padding: var(--space-1) 0;
  text-align: center;
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  color: var(--text-secondary);
}
.stp__calCell {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  min-width: 0;
  min-height: 54px;
  padding: var(--space-1);
  text-align: left;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  transition: var(--transition-base);
}
.stp__calCell:hover { background: var(--bg-hover); border-color: var(--border-default); }
.stp__calCell--outside { background: var(--bg-inset); color: var(--text-tertiary); }
.stp__calCell--outside .stp__calDayNum { color: var(--text-tertiary); }
.stp__calCell--today { border-color: var(--accent); }
.stp__calCell--selected { border-color: var(--accent); background: var(--accent-subtle); }
.stp__calDayNum {
  font-size: var(--text-xs);
  font-variant-numeric: tabular-nums;
  color: var(--text-primary);
}
.stp__calAmount {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-2xs);
  font-variant-numeric: tabular-nums;
  color: var(--expense);
}
.stp__calCount {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-2xs);
  color: var(--text-tertiary);
}
.stp__calError {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  font-size: var(--text-sm);
}
.stp__calError .btn { margin-left: auto; }

/* selected day */
.stp__day {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin-top: var(--space-2);
  padding-top: var(--space-4);
  border-top: 1px solid var(--border-subtle);
}
.stp__dayHead {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}
.stp__dayTitle {
  margin: 0;
  font-size: var(--text-sm);
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
}
.stp__dayTotals { display: flex; align-items: baseline; gap: var(--space-4); flex-wrap: wrap; font-size: var(--text-sm); }
.stp__dayHead .btn:last-child { margin-left: auto; }
.stp__txList {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  overflow: hidden;
}
.stp__txRow {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding-right: var(--space-2);
  border-bottom: 1px solid var(--border-subtle);
}
.stp__txRow:last-child { border-bottom: none; }
.stp__txRow:hover { background: var(--bg-hover); }
.stp__txMain {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  text-align: left;
  color: inherit;
}
.stp__txIcon {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  border-radius: var(--radius-full);
  background: var(--bg-inset);
}
.stp__txBody { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.stp__txTitle { font-size: var(--text-sm); font-weight: var(--weight-medium); color: var(--text-primary); }
.stp__txMeta { font-size: var(--text-xs); color: var(--text-secondary); }
.stp__txAmount { font-size: var(--text-sm); font-weight: var(--weight-semibold); white-space: nowrap; flex-shrink: 0; }
`
