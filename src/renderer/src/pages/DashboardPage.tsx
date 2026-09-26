import type { JSX } from 'react'
import { useEffect, useMemo, useState } from 'react'
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
import {
  T,
  categoryLabel,
  cycleStartSubZh,
  dateHeadingZh,
  periodDaysZh,
  periodProgressZh
} from '@shared/lib/i18n'
import { today } from '@shared/lib/dates'
import {
  CUSTOM_RANGE_PRESETS,
  customRangeLabel,
  cycleFor,
  dashboardPeriod,
  shiftDashboardMonth,
  validateCustomRange
} from '@shared/lib/periods'
import type {
  BiggestExpense,
  CustomPeriod,
  DashboardPeriodMode,
  IpcDateRange,
  TransactionWithRefs
} from '@shared/types'

/**
 * 总览 (the dashboard).
 *
 * The most important screen: it must answer "how much do I have, what did I earn
 * and spend this period, what is left, what did I spend today, and what was my
 * biggest expense" without the user having to go anywhere.
 *
 * THE PERIOD IS SWITCHABLE, AND THAT IS THE POINT
 * ----------------------------------------------
 * Three modes sit above the donut:
 *
 *   自然月     a plain calendar month, whatever the saved cycle anchor is
 *   结算周期   the user's own cycle — allowance in on the 5th means 5 Aug – 4 Sep
 *   自定义区间  explicit dates, for a question with no monthly shape
 *
 * The custom range used to live only on its own page, which made it nearly
 * useless: a one-off window could be analysed but never compared with the figures
 * the user actually looks at every day. Here all three drive the SAME columns, so
 * switching is a change of question, not a change of screen.
 *
 * The chosen mode is persisted, and the anchor day is NOT: "自然月" is day 1 for
 * this request only, so glancing at a calendar month never rewrites the user's
 * saved settlement cycle.
 *
 * TWO OTHER THINGS ARE UNUSUAL HERE, BOTH DELIBERATE
 * -------------------------------------------------
 * 1. Every monetary figure goes through `<Money>`, and every aggregate comes from
 *    the main process already converted to the display currency. The renderer
 *    never converts or sums money itself, so two figures on this screen can never
 *    be computed at different rates.
 * 2. The 今天 column and the account balances are NOT period-scoped. They answer
 *    "right now", and hiding them behind a period selector would be wrong.
 */
export default function DashboardPage(): JSX.Element {
  const activeMonth = useAppStore((state) => state.activeMonth)
  const setActiveMonth = useAppStore((state) => state.setActiveMonth)
  const refreshData = useAppStore((state) => state.refreshData)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const { dateFormat, displayCurrency, cycleStartDay, dashboardPeriodMode, dashboardRange } = useDisplaySettings()
  const openCreateTransaction = useUiStore((state) => state.openCreateTransaction)
  const showTransactionDetail = useUiStore((state) => state.showTransactionDetail)
  const { run, pending } = useAction()

  const loadRates = useRateStore((state) => state.load)

  useEffect(() => {
    void loadRates()
  }, [loadRates])

  const [editorOpen, setEditorOpen] = useState(false)
  const [draft, setDraft] = useState<IpcDateRange>(
    () => dashboardRange ?? { from: CUSTOM_RANGE_PRESETS[1].build().from, to: today() }
  )
  const [rangeError, setRangeError] = useState<string | null>(null)

  // Saved ranges double as quick picks: they are the windows the user already
  // decided were worth keeping, so they belong next to the date inputs.
  const savedPeriodsState = useAsync(() => window.api.customPeriodsList(), [])

  /**
   * The window every period-scoped figure on this screen is about.
   *
   * Derived through `dashboardPeriod` rather than assembled here, so the label in
   * the header and the dates sent to SQLite are produced by one function and can
   * never disagree.
   */
  const period = useMemo(
    () => dashboardPeriod(dashboardPeriodMode, activeMonth, cycleStartDay, dashboardRange),
    [dashboardPeriodMode, activeMonth, cycleStartDay, dashboardRange]
  )

  const requestRange = dashboardPeriodMode === 'custom' && dashboardRange ? dashboardRange : null
  // Depend on the resolved dates, not on the object identity: `dashboardRange`
  // comes from settings and is rebuilt on every settings read, so depending on it
  // directly would re-query on every unrelated preference change.
  const periodKey = `${period.start}..${period.end}`

  // Every hook runs before any early return: the first-run panel and the skeleton
  // are render decisions, not reasons to change hook order.
  const summaryState = useAsync(
    () => window.api.dashboardSummary(activeMonth, requestRange, cycleStartDay),
    [periodKey, dashboardPeriodMode, cycleStartDay]
  )
  const breakdownState = useAsync(
    () =>
      requestRange
        ? window.api.statsRange(requestRange.from, requestRange.to)
        : window.api.statsStatistics('month', activeMonth),
    [periodKey, dashboardPeriodMode]
  )
  const biggestState = useAsync(
    () => window.api.statsBiggestExpenses(activeMonth, 5, requestRange),
    [periodKey, dashboardPeriodMode]
  )

  const todayDate = summaryState.data?.todayDate ?? today()
  const todayState = useAsync(
    () => window.api.transactionsList({ from: todayDate, to: todayDate, orderBy: 'date' }),
    [todayDate]
  )

  const summary = summaryState.data

  /**
   * Move the period forward or back.
   *
   * Custom ranges translate by whole months so "next period" keeps the window's
   * length; cycles step by their anchor day, so an anchor of 5 goes 5 Sep -> 5 Oct
   * rather than landing mid-cycle.
   */
  const shiftPeriod = (delta: number): void => {
    const next = shiftDashboardMonth(
      dashboardPeriodMode,
      activeMonth,
      cycleStartDay,
      delta,
      dashboardRange ? { from: dashboardRange.from, to: dashboardRange.to } : null
    )
    if (next.range) {
      void updateSettings({ dashboardRange: { ...(dashboardRange ?? {}), ...next.range } })
    } else {
      setActiveMonth(next.key)
    }
  }

  const goToCurrentPeriod = (): void => {
    if (dashboardPeriodMode === 'custom') {
      const preset = CUSTOM_RANGE_PRESETS[1].build()
      void updateSettings({
        dashboardRange: { ...(dashboardRange ?? {}), from: preset.from, to: preset.to, label: null }
      })
      return
    }
    // Resolved from TODAY rather than from the selected month, so this button
    // means "the period I am in now" regardless of how far the user paged away.
    const anchorDay = dashboardPeriodMode === 'natural' ? 1 : cycleStartDay
    setActiveMonth(cycleFor(today(), anchorDay).key)
  }

  /** Change which period the dashboard reports on, persisting the choice. */
  const switchMode = async (mode: DashboardPeriodMode): Promise<void> => {
    if (mode === dashboardPeriodMode) {
      // Selecting the active mode again toggles its editor, which is what a user
      // expects from a segmented control that owns an inline panel.
      if (mode === 'custom') setEditorOpen((value) => !value)
      return
    }

    if (mode === 'custom' && !dashboardRange) {
      // A mode with no window would be refused by the settings write, and the
      // toggle would appear to do nothing. Committing a sensible default window
      // and the mode TOGETHER makes the switch atomic — there is no moment where
      // the app is in custom mode without dates — and opens the editor so the
      // user can immediately adjust it.
      const preset = CUSTOM_RANGE_PRESETS[1].build()
      setDraft({ from: preset.from, to: preset.to })
      setEditorOpen(true)
      await updateSettings({
        dashboardPeriodMode: 'custom',
        dashboardRange: { from: preset.from, to: preset.to, label: null, budgetAmount: null }
      })
      return
    }

    if (mode === 'custom') setEditorOpen(true)
    await updateSettings({ dashboardPeriodMode: mode })
  }

  const applyRange = async (from: string, to: string, label: string | null = null): Promise<void> => {
    const problem = validateCustomRange(from, to)
    if (problem) {
      setRangeError(problem)
      return
    }
    setRangeError(null)
    await updateSettings({
      dashboardPeriodMode: 'custom',
      dashboardRange: { from, to, label, budgetAmount: dashboardRange?.budgetAmount ?? null }
    })
    setEditorOpen(false)
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

  // The period the main process actually used wins over the locally derived one:
  // it is computed from the same inputs but observable, so a disagreement (a
  // rejected range, a clamped anchor) shows up as the real window rather than as
  // a label that describes something the figures do not.
  const shown = summary.period

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
  const savedPeriods = savedPeriodsState.data ?? []
  const budgetAmount = dashboardRange?.budgetAmount ?? null
  const budgetLeft = budgetAmount === null ? null : budgetAmount - summary.month.expense

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
            <ModeToggle mode={dashboardPeriodMode} onSelect={(mode) => void switchMode(mode)} />

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
                  {shown.label}
                </h2>
                <p className="muted sw-dash__period-sub">{periodSubtitle(shown, cycleStartDay)}</p>
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

            {dashboardPeriodMode === 'custom' ? (
              <>
                <CustomRangeBar
                  range={dashboardRange}
                  open={editorOpen}
                  draft={draft}
                  error={rangeError}
                  saved={savedPeriods}
                  onToggle={() => setEditorOpen((value) => !value)}
                  onDraftChange={setDraft}
                  onApply={(from, to) => void applyRange(from, to)}
                  onSaveNamed={(from, to, label) => void applyRange(from, to, label)}
                />
                {/* The dashboard shows the headline figures; the 自定义区间 page adds
                    the pace projection and category detail. Carrying the window
                    across means the deep dive opens on the same question. */}
                <Link
                  className="btn btn-ghost btn-sm sw-dash__drill"
                  to={`/custom-period?from=${shown.start}&to=${shown.end}`}
                >
                  区间详情与预算推算
                  <Icon name="arrow-right" size={14} />
                </Link>
              </>
            ) : (
              <p className="muted sw-dash__modehint">
                {dashboardPeriodMode === 'natural' ? T.dashPeriodNaturalHint : T.dashPeriodCycleHint}
              </p>
            )}
            <div className="sw-dash__donut">
              <Donut3D
                segments={segments}
                size={340}
                thickness={46}
                centerLabel={formatDisplayMoney(summary.month.net, displayCurrency)}
                centerSubLabel={T.remaining}
                centerHint={`${shown.start.slice(5).replace('-', '/')} – ${shown.end.slice(5).replace('-', '/')}`}
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

            {/* The 输入总金额 line: only present when the user supplied a total for
                this window, because a "remaining" figure with no total behind it
                would be a number with no meaning. */}
            {budgetLeft !== null ? (
              <div className={`sw-dash__budget ${budgetLeft < 0 ? 'is-over' : ''}`}>
                <span className="sw-dash__budget-label">
                  {budgetLeft < 0 ? T.dashPeriodBudgetOver : T.dashPeriodBudgetLeft}
                </span>
                <span className="sw-dash__budget-value amount">
                  <Money minor={Math.abs(budgetLeft)} currency={displayCurrency} />
                </span>
                <span className="muted sw-dash__budget-of">
                  / <Money minor={budgetAmount ?? 0} currency={displayCurrency} />
                </span>
              </div>
            ) : null}

            <ConversionNote
              sources={summary.month.sources}
              displayCurrency={summary.month.currency}
              hasUnconverted={summary.month.hasUnconverted}
            />

            {/* Total balance across accounts, converted. This is the "how much
                money do I have right now" figure and is deliberately separate
                from 本期结余 — conflating them is the most confusing thing a
                finance app can do. It is also deliberately NOT period-scoped. */}
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
              <p className="muted sw-dash__subhead">金额从高到低 · {shown.label}</p>
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

/** The three-way period selector above the donut. */
function ModeToggle({
  mode,
  onSelect
}: {
  mode: DashboardPeriodMode
  onSelect: (mode: DashboardPeriodMode) => void
}): JSX.Element {
  const options: Array<{ id: DashboardPeriodMode; label: string }> = [
    { id: 'natural', label: T.dashPeriodNatural },
    { id: 'cycle', label: T.dashPeriodCycle },
    { id: 'custom', label: T.dashPeriodCustom }
  ]

  return (
    <div className="sw-dash__modes" role="tablist" aria-label={T.dashPeriodTitle}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="tab"
          aria-selected={mode === option.id}
          className={`sw-dash__mode ${mode === option.id ? 'is-active' : ''}`}
          onClick={() => onSelect(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/**
 * The custom-range editor: a one-line summary that expands into date inputs,
 * quick presets and saved ranges.
 *
 * Collapsed by default because the dashboard's job is to show figures; the
 * controls appear when the user has said they want a different window.
 */
function CustomRangeBar({
  range,
  open,
  draft,
  error,
  saved,
  onToggle,
  onDraftChange,
  onApply,
  onSaveNamed
}: {
  range: { from: string; to: string; label?: string | null } | null
  open: boolean
  draft: IpcDateRange
  error: string | null
  saved: CustomPeriod[]
  onToggle: () => void
  onDraftChange: (next: IpcDateRange) => void
  onApply: (from: string, to: string) => void
  onSaveNamed: (from: string, to: string, label: string) => void
}): JSX.Element {
  return (
    <div className="sw-dash__range">
      <button type="button" className="sw-dash__range-summary" onClick={onToggle} aria-expanded={open}>
        <Icon name="calendar" size={15} />
        <span className="truncate">
          {range ? (range.label ?? customRangeLabel(range.from, range.to)) : T.dashPeriodCustomPick}
        </span>
        <span className={`sw-dash__range-caret ${open ? 'is-open' : ''}`}>
          {/* The icon set has one caret; it is rotated rather than duplicated so
              the two states cannot drift apart visually. */}
          <Icon name="chevron-down" size={15} />
        </span>
      </button>

      {open ? (
        <div className="sw-dash__range-editor">
          <div className="sw-dash__quick">
            <span className="muted sw-dash__quick-label">{T.dashPeriodQuick}</span>
            {CUSTOM_RANGE_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  const built = preset.build()
                  onDraftChange({ from: built.from, to: built.to })
                  onApply(built.from, built.to)
                }}
              >
                {preset.label}
              </button>
            ))}
          </div>

          <div className="sw-dash__dates">
            <label className="sw-dash__date">
              <span className="muted">{T.from}</span>
              <input
                type="date"
                className="input"
                value={draft.from}
                onChange={(event) => onDraftChange({ ...draft, from: event.target.value })}
              />
            </label>
            <label className="sw-dash__date">
              <span className="muted">{T.to}</span>
              <input
                type="date"
                className="input"
                value={draft.to}
                onChange={(event) => onDraftChange({ ...draft, to: event.target.value })}
              />
            </label>
          </div>

          <div className="sw-dash__range-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => onApply(draft.from, draft.to)}
            >
              {T.dashPeriodApply}
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => {
                const label =
                  typeof window.prompt === 'function'
                    ? window.prompt('给这个区间起个名字（例如：2026 春季学期）', '')
                    : null
                if (label && label.trim()) onSaveNamed(draft.from, draft.to, label.trim())
              }}
            >
              {T.save}
            </button>
          </div>

          {error ? (
            <p className="sw-dash__range-error" role="alert">
              {error}
            </p>
          ) : null}

          <div className="sw-dash__saved">
            <span className="muted sw-dash__quick-label">{T.dashPeriodSaved}</span>
            {saved.length === 0 ? (
              <span className="muted sw-dash__saved-none">{T.dashPeriodSavedNone}</span>
            ) : (
              <ul className="sw-dash__saved-list">
                {saved.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className="sw-dash__saved-item"
                      onClick={() => {
                        onDraftChange({ from: item.from, to: item.to })
                        onApply(item.from, item.to)
                      }}
                    >
                      <span className="truncate">{item.label}</span>
                      <span className="muted sw-dash__saved-dates">
                        {customRangeLabel(item.from, item.to)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}

/**
 * The sub-heading under the period label.
 *
 * Explains WHERE the window comes from, because "2026年9月" alone is ambiguous
 * when the user's anchor is the 5th: the same label means a different set of days
 * in 自然月 and 结算周期.
 */
function periodSubtitle(
  period: {
    start: string
    end: string
    mode: 'cycle' | 'custom'
    startDay: number | null
    daysTotal: number
    daysRemaining: number
    isPast: boolean
  },
  cycleStartDay: number
): string {
  if (period.mode === 'custom') {
    return `${customRangeLabel(period.start, period.end)} · ${periodDaysZh(period.daysTotal)}`
  }
  const anchorDay = period.startDay ?? cycleStartDay
  const head = anchorDay === 1 ? T.dashPeriodNaturalSub : cycleStartSubZh(anchorDay)
  if (period.isPast) return `${head} · ${T.dashPeriodPast}`
  const elapsed = Math.max(period.daysTotal - period.daysRemaining, 0)
  return `${head} · ${periodProgressZh(elapsed, period.daysTotal)}`
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

/* --- period mode toggle ------------------------------------------------ */
.sw-dash__modes {
  display: grid; grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 2px; padding: 3px; border-radius: var(--radius-md);
  background: var(--bg-subtle, var(--border-subtle));
}
.sw-dash__mode {
  border: none; background: transparent; font: inherit; cursor: pointer;
  font-size: var(--text-xs); font-weight: var(--weight-medium);
  color: var(--text-secondary); padding: 6px 4px;
  border-radius: var(--radius-sm); white-space: nowrap;
  transition: background 120ms ease, color 120ms ease;
}
.sw-dash__mode:hover { color: var(--text-primary); }
.sw-dash__mode.is-active {
  background: var(--bg-elevated, var(--bg-surface, #fff));
  color: var(--text-primary);
  box-shadow: var(--shadow-sm, 0 1px 2px rgba(0,0,0,0.08));
}
.sw-dash__modehint { margin: 0; font-size: var(--text-xs); text-align: center; }
.sw-dash__drill { align-self: center; }

/* --- custom range editor ---------------------------------------------- */
.sw-dash__range { display: flex; flex-direction: column; gap: var(--space-2); }
.sw-dash__range-summary {
  display: flex; align-items: center; gap: var(--space-2);
  width: 100%; padding: var(--space-2) var(--space-3);
  background: var(--bg-subtle, var(--border-subtle)); border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md); font: inherit; font-size: var(--text-sm);
  color: var(--text-primary); cursor: pointer; text-align: left;
}
.sw-dash__range-summary:hover { background: var(--bg-hover); }
.sw-dash__range-summary span { flex: 1; min-width: 0; }
.sw-dash__range-caret { display: grid; place-items: center; transition: transform 140ms ease; }
.sw-dash__range-caret.is-open { transform: rotate(180deg); }
.sw-dash__range-editor {
  display: flex; flex-direction: column; gap: var(--space-3);
  padding: var(--space-3); border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
}
.sw-dash__quick { display: flex; flex-wrap: wrap; gap: var(--space-1); align-items: center; }
.sw-dash__quick-label { font-size: var(--text-xs); margin-right: var(--space-1); }
.sw-dash__dates { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-2); }
.sw-dash__date { display: flex; flex-direction: column; gap: 2px; font-size: var(--text-xs); }
.sw-dash__range-actions { display: flex; gap: var(--space-2); }
.sw-dash__range-error {
  margin: 0; font-size: var(--text-xs); color: var(--expense);
}
.sw-dash__saved { display: flex; flex-direction: column; gap: var(--space-1); }
.sw-dash__saved-none { font-size: var(--text-xs); }
.sw-dash__saved-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.sw-dash__saved-item {
  display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-2);
  width: 100%; padding: var(--space-1) var(--space-2); background: transparent;
  border: none; border-radius: var(--radius-sm); font: inherit; font-size: var(--text-xs);
  color: var(--text-primary); cursor: pointer; text-align: left;
}
.sw-dash__saved-item:hover { background: var(--bg-hover); }
.sw-dash__saved-dates { flex-shrink: 0; }

/* --- period budget line ------------------------------------------------ */
.sw-dash__budget {
  display: flex; align-items: baseline; gap: var(--space-2);
  padding: var(--space-2) var(--space-3); border-radius: var(--radius-md);
  background: var(--income-subtle, var(--border-subtle));
}
.sw-dash__budget.is-over { background: var(--expense-subtle); }
.sw-dash__budget-label { font-size: var(--text-xs); color: var(--text-secondary); }
.sw-dash__budget-value {
  font-size: var(--text-lg); font-weight: var(--weight-semibold); color: var(--income);
}
.sw-dash__budget.is-over .sw-dash__budget-value { color: var(--expense); }
.sw-dash__budget-of { font-size: var(--text-xs); }
`
