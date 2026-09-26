import type { JSX } from 'react'
import { useEffect } from 'react'
import { Link } from 'react-router-dom'

import { Icon, iconNameOr } from '@renderer/components/Icon'
import type { IconName } from '@renderer/components/Icon'
import { Donut3D } from '@renderer/components/Donut3D'
import type { Donut3DSegment } from '@renderer/components/Donut3D'
import { CurrencyBar } from '@renderer/components/CurrencyBar'
import { Money, ConversionNote } from '@renderer/components/Money'
import { useAction, useAsync } from '@renderer/hooks/useData'
import { useAppStore, useDisplaySettings } from '@renderer/store/app'
import { useRateStore } from '@renderer/store/rates'
import { useUiStore } from '@renderer/store/ui'
import { T, categoryLabel, dateHeadingZh, daysLabelZh } from '@shared/lib/i18n'
import { today } from '@shared/lib/dates'
import { cycleFor, shiftCycle } from '@shared/lib/periods'
import type { BiggestExpense, TransactionWithRefs } from '@shared/types'

/**
 * 总览 (the dashboard).
 *
 * The most important screen: it must answer "how much do I have, what did I earn
 * and spend this period, what is left, what did I spend today, and what was my
 * biggest expense" without the user having to go anywhere.
 *
 * TWO THINGS ARE UNUSUAL HERE, BOTH DELIBERATE
 * -------------------------------------------
 * 1. The reporting period is a SETTLEMENT CYCLE, not a calendar month. A student
 *    whose allowance arrives on the 5th sees 5 Aug – 4 Sep, because that is the
 *    window their money actually lives in. `cycleStartDay = 1` reproduces a plain
 *    calendar month, so nothing is lost for users who think in months.
 *
 * 2. Every monetary figure goes through `<Money>`, and every aggregate comes from
 *    the main process already converted to the display currency. The renderer
 *    never converts or sums money itself, so two figures on this screen can never
 *    be computed at different rates.
 */
export default function DashboardPage(): JSX.Element {
  const activeMonth = useAppStore((state) => state.activeMonth)
  const setActiveMonth = useAppStore((state) => state.setActiveMonth)
  const refreshData = useAppStore((state) => state.refreshData)
  const { dateFormat, displayCurrency, cycleStartDay } = useDisplaySettings()
  const openCreateTransaction = useUiStore((state) => state.openCreateTransaction)
  const showTransactionDetail = useUiStore((state) => state.showTransactionDetail)
  const { run, pending } = useAction()

  const loadRates = useRateStore((state) => state.load)

  useEffect(() => {
    void loadRates()
  }, [loadRates])

  // Every hook runs before any early return: the first-run panel and the skeleton
  // are render decisions, not reasons to change hook order.
  const summaryState = useAsync(() => window.api.dashboardSummary(activeMonth), [activeMonth])
  const breakdownState = useAsync(() => window.api.statsStatistics('month', activeMonth), [activeMonth])
  const biggestState = useAsync(() => window.api.statsBiggestExpenses(activeMonth, 5), [activeMonth])

  const todayDate = summaryState.data?.todayDate ?? today()
  const todayState = useAsync(
    () => window.api.transactionsList({ from: todayDate, to: todayDate, orderBy: 'date' }),
    [todayDate]
  )

  const summary = summaryState.data

  /**
   * Move the period by whole cycles.
   *
   * Uses the cycle helper rather than month arithmetic so an anchor day of 5
   * steps 5 Sep -> 5 Oct rather than landing mid-cycle.
   */
  const shiftPeriod = (delta: number): void => {
    const current = cycleFor(`${activeMonth}-01`, cycleStartDay)
    setActiveMonth(shiftCycle(current.start, cycleStartDay, delta).key)
  }

  const goToCurrentPeriod = (): void => {
    setActiveMonth(cycleFor(today(), cycleStartDay).key)
  }

  const seedDemoData = async (): Promise<void> => {
    const result = await run(() => window.api.demoSeed(activeMonth), { successMessage: '示例数据已加载。' })
    // Refresh only after a confirmed write, so a failed seed cannot leave the
    // dashboard showing a half-populated period.
    if (result) refreshData()
  }

  if (!summary) {
    if (summaryState.error) {
      return (
        <>
          <style>{DASHBOARD_STYLES}</style>
          <PanelError title="总览无法加载" message={summaryState.error} onRetry={summaryState.reload} />
        </>
      )
    }
    return (
      <>
        <style>{DASHBOARD_STYLES}</style>
        <DashboardSkeleton />
      </>
    )
  }

  // --- donut segments, built from the category breakdown ------------------
  const categories = breakdownState.data?.categories ?? []
  const segments: Donut3DSegment[] = categories
    .filter((row) => row.total > 0)
    .map((row, index) => ({
      label: categoryLabel(row.categoryName),
      value: row.total,
      color: row.categoryColor ?? `var(--chart-${(index % 8) + 1})`,
      count: row.transactionCount
    }))

  const biggest = biggestState.data
  const todayPage = todayState.data

  return (
    <>
      <style>{DASHBOARD_STYLES}</style>

      {/* --- currency + live rates ------------------------------------- */}
      <div className="sw-dash__topbar">
        <CurrencyBar />
      </div>

      {summary.accountCount === 0 ? (
        /* FIRST RUN: no accounts means no ledger, so there is nothing to chart.
           Three empty columns would look like a broken app. */
        <section className="card sw-dash__welcome">
          <h2 className="sw-dash__welcome-title">{T.welcomeTitle}</h2>
          <p className="muted">{T.welcomeBody}</p>
          <div className="sw-dash__welcome-actions">
            <button type="button" className="btn btn-primary" onClick={() => openCreateTransaction()}>
              <Icon name="plus" size={16} />
              {T.addTransaction}
            </button>
            <Link className="btn btn-secondary" to="/accounts">
              <Icon name="wallet" size={16} />
              添加账户
            </Link>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => void seedDemoData()}
              disabled={pending}
              aria-busy={pending}
            >
              <Icon name="database" size={16} />
              {pending ? '加载示例数据…' : '用示例数据体验'}
            </button>
          </div>
          <p className="muted sw-dash__welcome-note">
            示例数据会作为一次性导入写入数据库，可以随时一键清除，不会影响你之后记录的真实数据。
          </p>
        </section>
      ) : (
        <div className="sw-dash">
          {/* ---------------- left: the period ---------------- */}
          <section className="card sw-dash__col sw-dash__left" aria-labelledby="sw-dash-period">
            <div className="sw-dash__monthbar">
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                onClick={() => shiftPeriod(-1)}
                aria-label="上一个周期"
                title="上一个周期"
              >
                <Icon name="chevron-left" size={18} />
              </button>
              <div className="sw-dash__period">
                <h2 className="sw-dash__month-label" id="sw-dash-period">
                  {summary.cycle.label}
                </h2>
                <p className="muted sw-dash__period-sub">
                  {summary.cycle.startDay === 1
                    ? '自然月结算'
                    : `${summary.cycle.startDay} 日起算 · ${daysLabelZh(summary.cycle.daysRemaining)}`}
                </p>
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                onClick={() => shiftPeriod(1)}
                aria-label="下一个周期"
                title="下一个周期"
              >
                <Icon name="chevron-right" size={18} />
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={goToCurrentPeriod}>
                {T.thisMonth}
              </button>
            </div>

            <div className="sw-dash__donut">
              <Donut3D
                segments={segments}
                size={340}
                thickness={46}
                centerLabel={formatDisplayMoney(summary.month.net, displayCurrency)}
                centerSubLabel={T.remaining}
                centerHint={`${summary.cycle.start.slice(5).replace('-', '/')} – ${summary.cycle.end.slice(5).replace('-', '/')}`}
                currency={displayCurrency}
              />
            </div>

            {breakdownState.error ? (
              <div className="sw-dash__inline-error" role="alert">
                <p className="muted">分类明细加载失败：{breakdownState.error}</p>
                <button type="button" className="btn btn-secondary btn-sm" onClick={breakdownState.reload}>
                  <Icon name="refresh" size={14} />
                  {T.retry}
                </button>
              </div>
            ) : null}

            <dl className="sw-dash__figures">
              <Figure
                label={T.income}
                value={<Money minor={summary.month.income} currency={summary.month.currency} />}
                tone="text-income"
              />
              <Figure
                label={T.expense}
                value={<Money minor={summary.month.expense} currency={summary.month.currency} />}
                tone="text-expense"
              />
              <Figure
                label={T.net}
                value={<Money minor={summary.month.net} currency={summary.month.currency} signed />}
                tone={summary.month.net >= 0 ? 'text-income' : 'text-expense'}
              />
            </dl>

            <ConversionNote
              sources={summary.month.sources}
              displayCurrency={summary.month.currency}
              hasUnconverted={summary.month.hasUnconverted}
            />

            {/* Total balance across accounts, converted. This is the "how much
                money do I have right now" figure and is deliberately separate
                from 本期结余 — conflating them is the most confusing thing a
                finance app can do. */}
            <div className="sw-dash__balance">
              <span className="sw-dash__balance-label">{T.totalBalance}</span>
              {summary.netWorthInBaseCurrency === null ? (
                <span className="muted">
                  {summary.balances.map((row) => (
                    <span key={row.currency} className="sw-dash__balance-line">
                      <Money minor={row.balance} currency={row.currency} />
                    </span>
                  ))}
                </span>
              ) : (
                <span className="sw-dash__balance-value amount">
                  <Money minor={summary.netWorthInBaseCurrency} currency={displayCurrency} />
                </span>
              )}
            </div>
          </section>

          {/* ---------------- middle: today ---------------- */}
          <section className="card sw-dash__col" aria-labelledby="sw-dash-today">
            <div className="sw-dash__colhead">
              <h2 className="card-title" id="sw-dash-today">
                {T.today}
              </h2>
              <p className="muted sw-dash__subhead">{dateHeadingZh(summary.todayDate, dateFormat)}</p>
            </div>

            <dl className="sw-dash__figures sw-dash__figures--compact">
              <Figure
                label={T.income}
                value={<Money minor={summary.today.income} currency={summary.today.currency} />}
                tone="text-income"
              />
              <Figure
                label={T.expense}
                value={<Money minor={summary.today.expense} currency={summary.today.currency} />}
                tone="text-expense"
              />
              <Figure
                label={T.net}
                value={<Money minor={summary.today.net} currency={summary.today.currency} signed />}
                tone={summary.today.net >= 0 ? 'text-income' : 'text-expense'}
              />
            </dl>

            {todayState.error && !todayPage ? (
              <div className="sw-dash__inline-error" role="alert">
                <p className="muted">{todayState.error}</p>
                <button type="button" className="btn btn-secondary btn-sm" onClick={todayState.reload}>
                  <Icon name="refresh" size={14} />
                  {T.retry}
                </button>
              </div>
            ) : !todayPage ? (
              <ListSkeleton rows={3} />
            ) : todayPage.items.length === 0 ? (
              <div className="empty-state sw-dash__empty">
                <p>今天还没有记录。</p>
              </div>
            ) : (
              <ul className="sw-dash__txns">
                {todayPage.items.map((row) => (
                  <TodayTransactionRow key={row.id} row={row} onOpen={showTransactionDetail} />
                ))}
              </ul>
            )}
          </section>

          {/* ---------------- right: biggest expenses ---------------- */}
          <section className="card sw-dash__col sw-dash__right" aria-labelledby="sw-dash-biggest">
            <div className="sw-dash__colhead">
              <h2 className="card-title" id="sw-dash-biggest">
                支出排行
              </h2>
              <p className="muted sw-dash__subhead">金额从高到低 · {summary.cycle.label}</p>
            </div>

            {biggestState.error && !biggest ? (
              <div className="sw-dash__inline-error" role="alert">
                <p className="muted">{biggestState.error}</p>
                <button type="button" className="btn btn-secondary btn-sm" onClick={biggestState.reload}>
                  <Icon name="refresh" size={14} />
                  {T.retry}
                </button>
              </div>
            ) : !biggest ? (
              <ListSkeleton rows={4} />
            ) : biggest.length === 0 ? (
              <div className="empty-state sw-dash__empty">
                <p>本周期还没有支出记录。</p>
              </div>
            ) : (
              <ol className="sw-dash__biggest">
                {biggest.map((item) => (
                  <BiggestExpenseRow
                    key={item.id}
                    item={item}
                    dateFormat={dateFormat}
                    displayCurrency={displayCurrency}
                    onOpen={showTransactionDetail}
                  />
                ))}
              </ol>
            )}

            <div className="sw-dash__colfoot">
              <Link className="btn btn-ghost btn-sm" to="/biggest-expenses" aria-label="查看全部支出排行">
                {T.viewAll}
                <Icon name="arrow-right" size={14} />
              </Link>
            </div>
          </section>
        </div>
      )}

      {/* Accounts summary strip: shown as soon as there is more than one
          currency, because "how much do I have" genuinely needs more than one
          line then. */}
      {summary.accountCount > 0 && summary.balances.length > 1 ? (
        <section className="card sw-dash__balances" aria-label="各币种余额">
          <h2 className="card-title">账户余额（按币种）</h2>
          <ul className="sw-dash__balanceList">
            {summary.balances.map((row) => (
              <li key={row.currency} className="sw-dash__balanceRow">
                <span className="sw-dash__balanceCcy">{row.currency}</span>
                <span className="sw-dash__balanceFigures">
                  <Money minor={row.balance} currency={row.currency} />
                  {row.convertedBalance != null ? (
                    <span className="muted sw-dash__balanceConverted">
                      ≈ <Money minor={row.convertedBalance} currency={displayCurrency} />
                    </span>
                  ) : (
                    <span className="muted sw-dash__balanceConverted">{T.noRateForPair}</span>
                  )}
                </span>
                <span className="muted sw-dash__balanceCount">{row.accountCount} 个账户</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  )
}

/**
 * Format an amount for the donut centre.
 *
 * The centre slot needs a plain STRING rather than a component, so this formats
 * directly. It is display-only and never used for arithmetic.
 */
function formatDisplayMoney(minor: number, currency: string): string {
  const symbol = currencySymbolFor(currency)
  const negative = minor < 0
  const abs = Math.abs(Math.trunc(minor))
  const whole = Math.floor(abs / 100)
  const frac = String(abs % 100).padStart(2, '0')
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${negative ? '-' : ''}${symbol} ${grouped}.${frac}`
}

function currencySymbolFor(code: string): string {
  const symbols: Record<string, string> = {
    CNY: '¥',
    MYR: 'RM',
    USD: '$',
    SGD: 'S$',
    HKD: 'HK$',
    EUR: '€',
    GBP: '£',
    JPY: '¥',
    KRW: '₩',
    TWD: 'NT$',
    THB: '฿'
  }
  return symbols[code.toUpperCase()] ?? code.toUpperCase()
}

function Figure({
  label,
  value,
  tone
}: {
  label: string
  value: React.ReactNode
  tone: string
}): JSX.Element {
  return (
    <div className="sw-dash__figure">
      <dt className="sw-dash__figure-label">{label}</dt>
      <dd className={`sw-dash__figure-value amount ${tone}`}>{value}</dd>
    </div>
  )
}

function PanelError({
  title,
  message,
  onRetry
}: {
  title: string
  message: string
  onRetry: () => void
}): JSX.Element {
  return (
    <div className="card empty-state" role="alert">
      <Icon name="alert" size={24} />
      <p style={{ fontWeight: 500 }}>{title}</p>
      <p className="muted">{message}</p>
      <button type="button" className="btn btn-secondary" onClick={onRetry}>
        <Icon name="refresh" size={16} />
        {T.retry}
      </button>
    </div>
  )
}

function ListSkeleton({ rows }: { rows: number }): JSX.Element {
  return (
    <div className="stack-sm" aria-busy="true">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="skeleton" style={{ height: 44 }} />
      ))}
    </div>
  )
}

function DashboardSkeleton(): JSX.Element {
  return (
    <div className="sw-dash" aria-busy="true">
      <div className="card skeleton" style={{ height: 420 }} />
      <div className="card skeleton" style={{ height: 300 }} />
      <div className="card skeleton" style={{ height: 300 }} />
    </div>
  )
}

function transactionTitle(row: TransactionWithRefs): string {
  if (row.merchant) return row.merchant
  if (row.categoryName) return categoryLabel(row.categoryName)
  return row.type === 'transfer' ? '转账' : '交易'
}

function transactionSubtitle(row: TransactionWithRefs): string {
  if (row.type === 'transfer') {
    return `${row.accountName} → ${row.counterpartAccountName ?? '其他账户'}`
  }
  return [row.categoryName ? categoryLabel(row.categoryName) : null, row.accountName, row.time]
    .filter(Boolean)
    .join(' · ')
}

function transactionTone(row: TransactionWithRefs): string {
  if (row.type === 'transfer') return 'text-neutral'
  return row.type === 'income' ? 'text-income' : 'text-expense'
}

function transactionIcon(row: TransactionWithRefs): IconName {
  if (row.type === 'transfer') return 'arrow-left-right'
  return iconNameOr(row.categoryIcon, row.type === 'income' ? 'trending-up' : 'tag')
}

function TodayTransactionRow({
  row,
  onOpen
}: {
  row: TransactionWithRefs
  onOpen: (row: TransactionWithRefs) => void
}): JSX.Element {
  const color = row.categoryColor ?? 'var(--text-tertiary)'
  return (
    <li className="sw-dash__txn">
      <button
        type="button"
        className="sw-dash__txn-btn"
        onClick={() => onOpen(row)}
        aria-label={`查看 ${transactionTitle(row)} 的详情`}
      >
        <span className="sw-dash__txn-icon" style={{ background: `${color}1f`, color }}>
          <Icon name={transactionIcon(row)} size={15} />
        </span>
        <span className="sw-dash__txn-body">
          <span className="sw-dash__txn-title truncate">{transactionTitle(row)}</span>
          <span className="sw-dash__txn-sub truncate">{transactionSubtitle(row)}</span>
        </span>
        <span className={`sw-dash__txn-amount amount ${transactionTone(row)}`}>
          {row.type === 'transfer' ? '' : row.type === 'income' ? '+' : '−'}
          <Money minor={Math.abs(row.amount)} currency={row.accountCurrency} convert absolute />
        </span>
      </button>
    </li>
  )
}

function barPercent(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return 2
  return Math.max(2, Math.min(100, ratio * 100))
}

function BiggestExpenseRow({
  item,
  dateFormat,
  displayCurrency,
  onOpen
}: {
  item: BiggestExpense
  dateFormat: string
  displayCurrency: string
  onOpen: (row: TransactionWithRefs) => void
}): JSX.Element {
  const unconvertible = item.conversionAvailable === false
  const currency = unconvertible ? item.accountCurrency : (item.displayCurrency ?? displayCurrency)
  const minor = unconvertible ? Math.abs(item.amount) : (item.convertedAmount ?? Math.abs(item.amount))

  return (
    <li className="sw-dash__biggest-item">
      <button type="button" className="sw-dash__biggest-btn" onClick={() => onOpen(item)}>
        <span className="sw-dash__biggest-head">
          <span className="sw-dash__biggest-rank" aria-hidden="true">
            {item.rank}
          </span>
          <span className="sw-dash__biggest-title truncate">{item.merchant ?? categoryLabel(item.categoryName)}</span>
          <span className="sw-dash__biggest-amount amount text-expense">
            <Money minor={minor} currency={currency} absolute />
            {unconvertible ? <span className="sw-dash__nofx">无汇率</span> : null}
          </span>
        </span>
        <span className="muted sw-dash__biggest-meta truncate">
          {categoryLabel(item.categoryName)} · {dateHeadingZh(item.date, dateFormat)}
        </span>
        <span className="sw-dash__bar" aria-hidden="true">
          <span className="sw-dash__bar-fill" style={{ width: `${barPercent(item.ratio)}%` }} />
        </span>
      </button>
    </li>
  )
}

const DASHBOARD_STYLES = `
.sw-dash__topbar { display: flex; justify-content: flex-end; margin-bottom: var(--space-4); }
.sw-dash {
  display: grid;
  grid-template-columns: minmax(0, 5fr) minmax(0, 3fr) minmax(0, 3fr);
  gap: var(--space-4);
  align-items: start;
}
@media (max-width: 1439px) { .sw-dash { grid-template-columns: minmax(0, 5fr) minmax(0, 4fr); } .sw-dash__right { display: none; } }
@media (max-width: 1099px) { .sw-dash { grid-template-columns: minmax(0, 1fr); } .sw-dash__right { display: flex; } }
.sw-dash__col { display: flex; flex-direction: column; gap: var(--space-4); min-width: 0; }
.sw-dash__left { grid-row: span 1; }
.sw-dash__monthbar { display: flex; align-items: center; gap: var(--space-2); }
.sw-dash__period { flex: 1; text-align: center; min-width: 0; }
.sw-dash__month-label {
  margin: 0; font-size: var(--text-lg); font-weight: var(--weight-semibold);
  color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.sw-dash__period-sub { margin: 1px 0 0; font-size: var(--text-xs); }
.sw-dash__donut { display: flex; justify-content: center; padding: var(--space-2) 0; }
.sw-dash__figures {
  display: grid; grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-3); margin: 0;
}
.sw-dash__figures--compact { margin-bottom: var(--space-2); }
.sw-dash__figure { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.sw-dash__figure-label { font-size: var(--text-xs); color: var(--text-secondary); }
.sw-dash__figure-value {
  margin: 0; font-size: var(--text-lg); font-weight: var(--weight-semibold);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.sw-dash__balance {
  display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3);
  padding-top: var(--space-3); border-top: 1px solid var(--border-subtle); flex-wrap: wrap;
}
.sw-dash__balance-label { font-size: var(--text-sm); color: var(--text-secondary); }
.sw-dash__balance-value { font-size: var(--text-xl); font-weight: var(--weight-semibold); color: var(--text-primary); }
.sw-dash__balance-line { display: block; font-variant-numeric: tabular-nums; }
.sw-dash__colhead { display: flex; flex-direction: column; gap: 1px; }
.sw-dash__subhead { margin: 0; font-size: var(--text-xs); }
.sw-dash__txns { list-style: none; margin: 0; padding: 0; }
.sw-dash__txn { border-bottom: 1px solid var(--border-subtle); }
.sw-dash__txn:last-child { border-bottom: none; }
.sw-dash__txn-btn {
  width: 100%; display: flex; align-items: center; gap: var(--space-3);
  padding: var(--space-2) 0; background: transparent; border: none;
  font: inherit; color: inherit; text-align: left; cursor: pointer;
  border-radius: var(--radius-sm);
}
.sw-dash__txn-btn:hover { background: var(--bg-hover); }
.sw-dash__txn-icon {
  display: grid; place-items: center; width: 30px; height: 30px;
  border-radius: var(--radius-full); flex-shrink: 0;
}
.sw-dash__txn-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.sw-dash__txn-title { font-size: var(--text-sm); font-weight: var(--weight-medium); color: var(--text-primary); }
.sw-dash__txn-sub { font-size: var(--text-xs); color: var(--text-secondary); }
.sw-dash__txn-amount { font-size: var(--text-sm); font-weight: var(--weight-semibold); white-space: nowrap; }
.sw-dash__biggest { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-3); }
.sw-dash__biggest-btn {
  width: 100%; display: flex; flex-direction: column; gap: 4px;
  background: transparent; border: none; font: inherit; color: inherit;
  text-align: left; cursor: pointer; padding: var(--space-1) 0;
  border-radius: var(--radius-sm);
}
.sw-dash__biggest-btn:hover { background: var(--bg-hover); }
.sw-dash__biggest-head { display: flex; align-items: baseline; gap: var(--space-2); }
.sw-dash__biggest-rank {
  font-size: var(--text-xs); color: var(--text-tertiary); font-variant-numeric: tabular-nums;
  min-width: 12px;
}
.sw-dash__biggest-title { flex: 1; min-width: 0; font-size: var(--text-sm); font-weight: var(--weight-medium); color: var(--text-primary); }
.sw-dash__biggest-amount { font-size: var(--text-sm); font-weight: var(--weight-semibold); white-space: nowrap; }
.sw-dash__nofx {
  margin-left: 4px; font-size: var(--text-2xs); font-weight: var(--weight-normal);
  color: var(--warning); border: 1px solid var(--warning); border-radius: var(--radius-full);
  padding: 0 4px;
}
.sw-dash__biggest-meta { font-size: var(--text-xs); }
.sw-dash__bar { display: block; height: 5px; border-radius: var(--radius-full); background: var(--border-subtle); overflow: hidden; }
.sw-dash__bar-fill { display: block; height: 100%; background: var(--expense); border-radius: var(--radius-full); }
.sw-dash__colfoot { display: flex; justify-content: flex-start; padding-top: var(--space-1); }
.sw-dash__inline-error {
  display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-2);
  background: var(--expense-subtle); border-radius: var(--radius-md); padding: var(--space-3);
}
.sw-dash__inline-error p { margin: 0; font-size: var(--text-sm); }
.sw-dash__empty { padding: var(--space-5) 0; text-align: center; }
.sw-dash__empty p { margin: 0; font-size: var(--text-sm); }
.sw-dash__welcome {
  display: flex; flex-direction: column; align-items: center; gap: var(--space-3);
  text-align: center; padding: var(--space-8) var(--space-6);
}
.sw-dash__welcome-title { margin: 0; font-size: var(--text-2xl); font-weight: var(--weight-semibold); }
.sw-dash__welcome-actions { display: flex; gap: var(--space-3); flex-wrap: wrap; justify-content: center; }
.sw-dash__welcome-note { font-size: var(--text-xs); max-width: 52ch; }
.sw-dash__balances { margin-top: var(--space-4); }
.sw-dash__balanceList { list-style: none; margin: 0; padding: 0; }
.sw-dash__balanceRow {
  display: flex; align-items: baseline; gap: var(--space-3);
  padding: var(--space-2) 0; border-bottom: 1px solid var(--border-subtle);
}
.sw-dash__balanceRow:last-child { border-bottom: none; }
.sw-dash__balanceCcy { font-weight: var(--weight-medium); min-width: 44px; color: var(--text-primary); }
.sw-dash__balanceFigures { flex: 1; display: flex; gap: var(--space-3); align-items: baseline; flex-wrap: wrap; }
.sw-dash__balanceConverted { font-size: var(--text-sm); }
.sw-dash__balanceCount { font-size: var(--text-xs); }
.money-original { color: var(--text-tertiary); font-size: 0.9em; }
`
