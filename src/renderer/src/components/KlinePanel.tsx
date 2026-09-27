import { useCallback, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'

import { CashflowChart } from '@renderer/components/CashflowChart'
import type { ChartFrame, HoverState } from '@renderer/components/CashflowChart'
import { Icon } from '@renderer/components/Icon'
import { Money } from '@renderer/components/Money'
import { useUiStore } from '@renderer/store/ui'
import { addDays, formatDate, today } from '@shared/lib/dates'
import { instantOf } from '@shared/lib/chart-time'
import { T, categoryLabel, klineTxCount } from '@shared/lib/i18n'
import { formatMoney } from '@shared/lib/money'
import type { CashflowTransactionMarker, KlineBucket, KlineSeries, TransactionWithRefs } from '@shared/types'

/**
 * KlinePanel — the cashflow terminal.
 *
 * WHAT THIS LAYER OWNS
 * --------------------
 * `CashflowChart` draws and reports what is under the cursor; everything that
 * DECIDES lives here:
 *
 *   - the header quote block (balance, net change, %, OHLC, income/expense/count),
 *   - the range presets and the MA selection,
 *   - the hover card, which is HTML because it is text and a table,
 *   - the Daily Detail panel and the hand-off to the existing transaction drawer.
 *
 * THE HEADER FOLLOWS THE CURSOR, AND SAYS WHICH DATE IT IS SHOWING
 * ---------------------------------------------------------------
 * Moving the crosshair onto a historical candle replaces the header figures with
 * that candle's. The label changes with them — "当前余额" appears only for the newest
 * candle; anything else reads "9月20日 · 收盘". Without that, a reader inspecting last
 * March would take an old balance for today's money, which is the most expensive
 * mistake this screen could invite.
 *
 * ZOOM IS NOT A MENU
 * ------------------
 * There is no 日K/周K/月K selector any more, and no zoom dropdown. The candle size is
 * derived from the visible time range, which the wheel and the drag own, so the only
 * controls left are the ones that set a RANGE — and those set a real interval in
 * time rather than a rung on a ladder.
 */

/**
 * Range presets, in days.
 *
 * Explicit numbers rather than a dropdown of vague words: "90D" is a question the
 * reader can answer about their own life, "近三个月" is not.
 */
const RANGES: ReadonlyArray<{ id: string; label: string; days: number | null }> = [
  { id: 'all', label: '全部', days: null },
  { id: '5d', label: '5D', days: 5 },
  { id: '7d', label: '7D', days: 7 },
  { id: '30d', label: '30D', days: 30 },
  { id: '90d', label: '90D', days: 90 },
  { id: '180d', label: '180D', days: 180 },
  { id: '1y', label: '1Y', days: 365 },
  { id: '3y', label: '3Y', days: 365 * 3 }
]

/** MA window → on by default? MA60/250 stay off: they flatten a year-old ledger. */
const DEFAULT_MA: readonly number[] = [5, 10, 20]
const ALL_MA: readonly number[] = [5, 10, 20, 60, 250]

export interface KlineSettings {
  rangeId: string
  maWindows: number[]
  activityMode: 'flow' | 'count'
  customFrom: string | null
  customTo: string | null
}

export const DEFAULT_KLINE_SETTINGS: KlineSettings = {
  rangeId: 'all',
  maWindows: [...DEFAULT_MA],
  activityMode: 'flow',
  customFrom: null,
  customTo: null
}

export interface KlinePanelProps {
  series: KlineSeries | null
  loading: boolean
  error: string | null
  displayCurrency: string
  settings: KlineSettings
  onSettings: (patch: Partial<KlineSettings>) => void
  onRetry: () => void
}

/** Chart height in px. The two panels split it; neither may collapse. */
const CHART_HEIGHT = 460

export function KlinePanel({
  series,
  loading,
  error,
  displayCurrency,
  settings,
  onSettings,
  onRetry
}: KlinePanelProps): JSX.Element {
  const showTransactionDetail = useUiStore((state) => state.showTransactionDetail)
  const [maOpen, setMaOpen] = useState(false)
  const [frame, setFrame] = useState<ChartFrame | null>(null)
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [request, setRequest] = useState<{
    token: number
    anchorMs?: number
    fromMs?: number
    toMs?: number
  } | null>(null)
  const [gotoNotice, setGotoNotice] = useState<string | null>(null)
  const [customOpen, setCustomOpen] = useState(false)
  const [customFrom, setCustomFrom] = useState(() => settings.customFrom ?? '')
  const [customTo, setCustomTo] = useState(() => settings.customTo ?? '')
  const tokenRef = useRef(0)
  const chartRef = useRef<HTMLDivElement | null>(null)

  /**
   * Ask the chart to move. A fresh `token` every time is what makes "全部" a button
   * that works twice: the request is consumed once per identity, so a repeat press
   * is a new instruction rather than a no-op.
   */
  const bump = useCallback((target: { anchorMs?: number; fromMs?: number; toMs?: number }): void => {
    tokenRef.current += 1
    setRequest({ token: tokenRef.current, ...target })
  }, [])

  /* ---- header focus: cursor first, then the clicked candle, then the newest ---- */
  const hoverCandle: KlineBucket | null = frame?.hover?.candle?.bucket ?? null
  const focus = useMemo(() => {
    if (!series) return null
    if (hoverCandle) return hoverCandle
    if (selectedDate) {
      const found = frame?.buckets.find((bucket) => bucket.date === selectedDate)
      if (found) return found
    }
    return frame?.buckets[frame.buckets.length - 1] ?? null
  }, [series, hoverCandle, selectedDate, frame])

  const lastBucket = frame?.buckets[frame.buckets.length - 1] ?? null
  const isCurrent = focus !== null && lastBucket !== null && focus.date === lastBucket.date

  /**
   * Change as a fraction of where THIS bucket opened.
   *
   * Derived from the bucket's own open and close rather than carried on the bucket,
   * because the chart re-buckets continuously: a week candle the service never
   * produced still needs a percentage, and it has to come from the same two numbers
   * the header prints. Null when the bucket opened at nothing — "up 100% from zero"
   * is not a number anyone can act on.
   */
  const changeRatio =
    focus && focus.balanceOpen !== 0 ? (focus.balanceClose - focus.balanceOpen) / focus.balanceOpen : null

  const maReadout = useMemo(() => {
    const values = new Map((frame?.ma ?? []).map((entry) => [entry.windowSize, entry.value]))
    return ALL_MA.map((windowSize) => ({
      windowSize,
      shown: settings.maWindows.includes(windowSize),
      value: values.get(windowSize) ?? null,
      available: (series?.daily.length ?? 0) >= windowSize
    }))
  }, [frame, settings.maWindows, series])

  /**
   * Markers for the focused day, for the Daily Detail panel.
   *
   * Read from `dayMarkers`, which is keyed by day at every zoom, rather than from
   * `points[].markers`, which is keyed by whatever bucket the service was asked for.
   * The chart re-buckets locally now, so only the day key is stable.
   */
  const focusMarkers = useMemo<CashflowTransactionMarker[]>(() => {
    if (!focus || !series) return []
    return series.dayMarkers[focus.date] ?? []
  }, [focus, series])

  /**
   * Day flow recomputed from the markers.
   *
   * A marker's amount is converted and rounded on its own; a bucket's income and
   * expense come from a rounded cumulative curve. On a day those two can disagree by
   * one minor unit — the header reading ¥395.67 while the marker under the cursor
   * reads ¥395.66 — and a reader who notices that stops trusting both numbers. For a
   * day-sized view the markers ARE the complete answer, so the header sums them.
   */
  const isDayView = frame !== null && frame.granularity === 'day'
  const dayFlow = useMemo(() => {
    if (!focus || !series) return null
    const markers = series.dayMarkers[focus.date]
    if (!markers) return null
    let income = 0
    let expense = 0
    for (const marker of markers) {
      const magnitude = marker.convertedDelta === null ? marker.amount : Math.abs(marker.convertedDelta)
      if (marker.type === 'income') income += magnitude
      else if (marker.type === 'expense') expense += magnitude
    }
    return { income, expense, net: income - expense }
  }, [focus, series])

  const headerIncome = dayFlow && isDayView ? dayFlow.income : (focus?.income ?? 0)
  const headerExpense = dayFlow && isDayView ? dayFlow.expense : (focus?.expense ?? 0)
  const headerNet = dayFlow && isDayView ? dayFlow.net : (focus?.net ?? 0)

  /** Transactions for the Daily Detail list: income and expense only, as elsewhere. */
  const focusTransactions = useMemo(() => {
    if (!focus || !series) return []
    /*
      Built from `dayMarkers` rather than from `points[].transactions`.

      The service partitions its tooltip payload by the bucket it was ASKED for, and the chart
      now re-buckets locally on every wheel notch — so a candle the chart produced for a week
      or an hour has no entry in `points` at all, and looking one up by date finds nothing. That
      is what left this panel empty with a date in its header. `dayMarkers` is keyed by the day
      each entry happened on, at every zoom, so the list is complete whenever the panel can be
      open.

      Transfers are filtered out here because a list of what you earned and spent should not
      include moving your own money between accounts; the marker count below reports them.
    */
    const rows = series.dayMarkers[focus.date] ?? []
    return rows
      .filter((marker) => marker.type !== 'transfer')
      .map((marker) => ({
        id: marker.transactionId,
        time: marker.time,
        type: marker.type === 'income' ? ('income' as const) : ('expense' as const),
        amount: marker.amount,
        currency: marker.currency,
        convertedAmount: marker.convertedDelta === null ? null : Math.abs(marker.convertedDelta),
        merchant: marker.merchant,
        categoryName: marker.categoryName,
        accountName: marker.accountName,
        note: marker.note
      }))
  }, [focus, series])

  /* ---- range presets ---- */
  const applyRange = useCallback(
    (rangeId: string, days: number | null): void => {
      onSettings({ rangeId })
      setGotoNotice(null)
      if (days === null) {
        bump({})
        return
      }
      if (!series || series.daily.length === 0) return
      const end = instantOf(series.to || today(), null) + 86_400_000
      bump({ fromMs: end - days * 86_400_000, toMs: end })
    },
    [onSettings, series, bump]
  )

  const gotoPicked = useCallback(
    (date: string): void => {
      if (!series || series.daily.length === 0) return
      if (date < series.from || date > series.to) {
        // Say so, and name the day we did land on, rather than silently showing a
        // different date from the one that was typed.
        setGotoNotice(`所选日期没有记录，已定位到最近有数据的 ${formatDate(series.to, 'YYYY-MM-DD')}。`)
        bump({ anchorMs: instantOf(series.to, null) })
        return
      }
      setGotoNotice(null)
      bump({ anchorMs: instantOf(date, null) })
    },
    [series, bump]
  )

  /**
   * Apply a user-typed span.
   *
   * Reversed ends are refused rather than swapped: a swapped range would silently
   * show a period the reader did not ask for, and "why is my chart showing August
   * when I typed September" is a worse outcome than a one-line message.
   */
  const applyCustomRange = useCallback((): void => {
    if (!customFrom || !customTo) {
      setGotoNotice('请选择开始和结束日期。')
      return
    }
    if (customFrom > customTo) {
      setGotoNotice('开始日期不能晚于结束日期。')
      return
    }
    if (!series || series.daily.length === 0) return

    onSettings({ rangeId: 'custom', customFrom, customTo })
    if (customTo < series.from || customFrom > series.to) {
      setGotoNotice(`这段时间没有记录（有数据的范围是 ${series.from} 至 ${series.to}），已显示全部区间。`)
      bump({})
      return
    }
    setGotoNotice(null)
    bump({ fromMs: instantOf(customFrom, null), toMs: instantOf(customTo, null) + 86_400_000 })
    setCustomOpen(false)
  }, [customFrom, customTo, series, onSettings, bump])

  /**
   * Open a transaction in the app's existing detail drawer.
   *
   * Fetches the real row instead of constructing a look-alike from the marker: a
   * second transaction view would drift from the first, and the drawer already knows
   * how to render a transfer, a category colour and a missing rate correctly.
   */
  const openTransaction = useCallback(
    async (id: number): Promise<void> => {
      const row: TransactionWithRefs = await window.api.transactionsGet(id)
      showTransactionDetail(row)
    },
    [showTransactionDetail]
  )

  /* ---- "there is nothing finer to zoom into" ---- */
  const noTimeNotice = useMemo(() => {
    if (!frame || !series) return false
    const spanDays = (frame.viewport.to - frame.viewport.from) / 86_400_000
    if (spanDays > 2.5) return false
    // Every entry in the window is untimed, so the day is as fine as this ledger goes.
    for (const bucket of frame.buckets) {
      for (const marker of series.dayMarkers[bucket.date] ?? []) {
        if (marker.time !== null) return false
      }
    }
    return true
  }, [frame, series])

  return (
    <div className="kl">
      <style>{KLINE_PANEL_STYLES}</style>

      {/* ---------------- header: the quote block ---------------- */}
      <section className="kl__quote" aria-live="polite">
        <div className="kl__quote-main">
          <p className="kl__quote-label">
            {isCurrent ? '当前余额' : `${formatDate(focus?.date ?? '', 'YYYY-MM-DD')} · 收盘`}
          </p>
          <div className="kl__quote-value">
            {focus ? <Money minor={focus.balanceClose} currency={displayCurrency} /> : '—'}
          </div>
          <div
            className={`kl__quote-delta ${focus && focus.net > 0 ? 'is-up' : focus && focus.net < 0 ? 'is-down' : ''}`}
          >
            {focus ? (
              <>
                <span className="num">
                  {focus.net >= 0 ? '+' : '−'}
                  {formatMoney(Math.abs(focus.net), displayCurrency)}
                </span>
                <span className="num kl__quote-pct">
                  {changeRatio === null
                    ? ''
                    : `${changeRatio >= 0 ? '+' : '−'}${(Math.abs(changeRatio) * 100).toFixed(2)}%`}
                </span>
              </>
            ) : (
              '—'
            )}
          </div>
        </div>

        <dl className="kl__ohlc">
          <div>
            <dt>{T.klineTooltipOpen}</dt>
            <dd className="num">{focus ? formatMoney(focus.balanceOpen, displayCurrency) : '—'}</dd>
          </div>
          <div>
            <dt>{T.klineTooltipHigh}</dt>
            <dd className="num">{focus ? formatMoney(focus.balanceHigh, displayCurrency) : '—'}</dd>
          </div>
          <div>
            <dt>{T.klineTooltipLow}</dt>
            <dd className="num">{focus ? formatMoney(focus.balanceLow, displayCurrency) : '—'}</dd>
          </div>
          <div>
            <dt>{T.klineTooltipClose}</dt>
            <dd className="num">{focus ? formatMoney(focus.balanceClose, displayCurrency) : '—'}</dd>
          </div>
        </dl>

        <dl className="kl__flows">
          <div>
            <dt>{T.income}</dt>
            <dd className="num is-up">{focus ? formatMoney(headerIncome, displayCurrency) : '—'}</dd>
          </div>
          <div>
            <dt>{T.expense}</dt>
            <dd className="num is-down">{focus ? formatMoney(headerExpense, displayCurrency) : '—'}</dd>
          </div>
          <div>
            <dt>{T.net}</dt>
            <dd className="num">
              {focus ? `${headerNet >= 0 ? '+' : '−'}${formatMoney(Math.abs(headerNet), displayCurrency)}` : '—'}
            </dd>
          </div>
          <div>
            <dt>{T.klineTooltipCount}</dt>
            <dd className="num">{focus ? klineTxCount(focus.transactionCount) : '—'}</dd>
          </div>
        </dl>

        {frame ? (
          <div className="kl__zoom" title={T.klineZoomHint}>
            <span className="kl__zoom-label">可见区间</span>
            <b className="num">{frame.zoomLabel}</b>
            <span className="muted kl__zoom-range num">{formatDate(keyOfMs(frame.viewport.from), 'YYYY-MM-DD')}</span>
          </div>
        ) : null}
      </section>

      {/* ---------------- controls ---------------- */}
      <div className="kl__controls">
        <div className="kl__ranges">
          {RANGES.map((range) => (
            <button
              key={range.id}
              type="button"
              className={`kl__range ${settings.rangeId === range.id ? 'is-active' : ''}`}
              onClick={() => applyRange(range.id, range.days)}
            >
              {range.label}
            </button>
          ))}
          <button
            type="button"
            className={`kl__range ${settings.rangeId === 'custom' ? 'is-active' : ''}`}
            aria-expanded={customOpen}
            onClick={() => setCustomOpen((open) => !open)}
          >
            自定义
          </button>
        </div>

        {customOpen ? (
          <div className="kl__custom anim-pop">
            <label>
              <span className="muted">开始</span>
              <input
                type="date"
                className="input"
                value={customFrom}
                max={customTo || undefined}
                onChange={(event) => setCustomFrom(event.target.value)}
              />
            </label>
            <label>
              <span className="muted">结束</span>
              <input
                type="date"
                className="input"
                value={customTo}
                min={customFrom || undefined}
                onChange={(event) => setCustomTo(event.target.value)}
              />
            </label>
            <button type="button" className="btn btn-primary btn-sm" onClick={applyCustomRange}>
              应用
            </button>
          </div>
        ) : null}

        <div className="kl__spacer" />

        <div className="kl__ma">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-expanded={maOpen}
            onClick={() => setMaOpen((open) => !open)}
          >
            MA
            <Icon name="chevron-down" size={12} />
          </button>
          {maOpen ? (
            <div className="kl__ma-menu anim-pop" role="menu">
              {ALL_MA.map((windowSize) => {
                // A window longer than the recorded history cannot be drawn, and
                // offering it as a working toggle would be a lie. Shown, disabled,
                // with the reason.
                const available = (series?.daily.length ?? 0) >= windowSize
                const on = settings.maWindows.includes(windowSize)
                return (
                  <label key={windowSize} className={`kl__ma-item ${available ? '' : 'is-disabled'}`}>
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={!available}
                      onChange={() => {
                        const next = on
                          ? settings.maWindows.filter((value) => value !== windowSize)
                          : [...settings.maWindows, windowSize].sort((a, b) => a - b)
                        onSettings({ maWindows: next })
                      }}
                    />
                    <span>MA{windowSize}</span>
                    {!available ? <span className="kl__ma-why">数据不足</span> : null}
                  </label>
                )
              })}
            </div>
          ) : null}
        </div>

        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => {
            setSelectedDate(null)
            onSettings({ rangeId: 'all' })
            bump({})
          }}
        >
          <Icon name="refresh" size={12} />
          {T.klineResetZoom}
        </button>

        <label className="kl__goto" title="跳转到日期">
          <Icon name="calendar" size={13} />
          <input
            type="date"
            className="kl__goto-input"
            onChange={(event) => {
              if (event.target.value) gotoPicked(event.target.value)
            }}
          />
        </label>
      </div>

      {gotoNotice ? <p className="kl__notice muted anim-fade">{gotoNotice}</p> : null}

      {/* MA readout: the values the chart is actually drawing, at the focused date. */}
      <div className="kl__ma-readout" aria-label="均线数值">
        {maReadout.map((entry, index) =>
          entry.shown ? (
            <span key={entry.windowSize} className={`kl__ma-value kl__ma-value--${index + 1}`}>
              MA{entry.windowSize}
              <b className="num">{entry.value === null ? '—' : formatMoney(entry.value, displayCurrency)}</b>
              {!entry.available ? <i className="kl__ma-na">数据不足</i> : null}
            </span>
          ) : null
        )}
      </div>

      {/* ---------------- the chart ---------------- */}
      {error && !series ? (
        <div className="sw-dash__inline-error" role="alert">
          <p className="muted">资金走势加载失败：{error}</p>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>
            <Icon name="refresh" size={14} />
            {T.retry}
          </button>
        </div>
      ) : !series ? (
        <div className="kl__skeleton skeleton" style={{ height: CHART_HEIGHT }} aria-busy={loading} />
      ) : series.points.length === 0 ? (
        <div className="empty-state sw-dash__empty">
          <p>还没有可绘制的记录。记上几笔之后，这里会显示资金走势。</p>
        </div>
      ) : (
        <div className="kl__chart" ref={chartRef}>
          <CashflowChart
            series={series}
            displayCurrency={displayCurrency}
            maWindows={settings.maWindows}
            activityMode={settings.activityMode}
            height={CHART_HEIGHT}
            onFrame={setFrame}
            onClickBucket={(bucket) => setSelectedDate(bucket.date)}
            onClickMarker={(marker) => void openTransaction(marker.transactionId)}
            viewRequest={request}
          />

          {frame?.hover ? <HoverCard frame={frame} displayCurrency={displayCurrency} host={chartRef.current} /> : null}

          {noTimeNotice ? <p className="kl__notice muted">{T.klineNoTimeNotice}</p> : null}

          <div className="kl__legend">
            <span className="kl__legend-item">
              <i className="kl__swatch kl__swatch--up" />
              余额上涨
            </span>
            <span className="kl__legend-item">
              <i className="kl__swatch kl__swatch--down" />
              余额下跌
            </span>
            <span className="kl__legend-item">
              <i className="kl__swatch kl__swatch--marker" />
              每笔交易（横线位置＝该笔之后的余额）
            </span>
            <span className="kl__legend-spacer" />
            <span className="muted">{T.klineZoomHint}</span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => onSettings({ activityMode: settings.activityMode === 'flow' ? 'count' : 'flow' })}
            >
              切换副图
            </button>
          </div>
        </div>
      )}

      {/* ---------------- Daily Detail ---------------- */}
      {focus && selectedDate ? (
        <section className="kl__detail anim-rise" aria-label="当日明细">
          <header className="kl__detail-head">
            <h3 className="card-title">{formatDate(focus.date, 'YYYY-MM-DD')} 明细</h3>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelectedDate(null)}>
              关闭
            </button>
          </header>

          <dl className="kl__detail-grid">
            <div>
              <dt>期初余额</dt>
              <dd className="num">{formatMoney(focus.balanceOpen, displayCurrency)}</dd>
            </div>
            <div>
              <dt>{T.income}</dt>
              <dd className="num is-up">+{formatMoney(focus.income, displayCurrency)}</dd>
            </div>
            <div>
              <dt>{T.expense}</dt>
              <dd className="num is-down">−{formatMoney(focus.expense, displayCurrency)}</dd>
            </div>
            <div>
              <dt>期末余额</dt>
              <dd className="num">{formatMoney(focus.balanceClose, displayCurrency)}</dd>
            </div>
            <div>
              <dt>{T.net}</dt>
              <dd className="num">
                {focus.net >= 0 ? '+' : '−'}
                {formatMoney(Math.abs(focus.net), displayCurrency)}
              </dd>
            </div>
            <div>
              <dt>{T.klineTooltipCount}</dt>
              <dd className="num">{klineTxCount(focus.transactionCount)}</dd>
            </div>
          </dl>

          {focusTransactions.length === 0 ? (
            <p className="muted kl__detail-empty">这一天没有收入或支出记录。</p>
          ) : (
            <ul className="kl__detail-list">
              {focusTransactions.map((transaction) => (
                <li key={transaction.id}>
                  <button
                    type="button"
                    className="kl__detail-row"
                    onClick={() => void openTransaction(transaction.id)}
                  >
                    <span className="kl__detail-time num">
                      {transaction.time ?? <span className="muted">{T.klineTooltipTimeUnknown}</span>}
                    </span>
                    <span className="kl__detail-body">
                      <span className="truncate">
                        {transaction.merchant ?? categoryLabel(transaction.categoryName) ?? T.klineUnnamed}
                      </span>
                      <span className="muted truncate kl__detail-meta">
                        {[categoryLabel(transaction.categoryName), transaction.accountName]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </span>
                    <span
                      className={`kl__detail-amount num ${transaction.type === 'income' ? 'is-up' : 'is-down'}`}
                    >
                      {transaction.type === 'income' ? '+' : '−'}
                      {formatMoney(
                        transaction.convertedAmount === null
                          ? transaction.amount
                          : Math.abs(transaction.convertedAmount),
                        transaction.convertedAmount === null ? transaction.currency : displayCurrency
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {focusMarkers.length > focusTransactions.length ? (
            <p className="muted kl__detail-empty">
              含转账共 {focusMarkers.length} 笔；这里只列出收入与支出。
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* hover card                                                                 */
/* -------------------------------------------------------------------------- */

/** 'YYYY-MM-DD' of a local epoch instant, for the range readout. */
function keyOfMs(ms: number): string {
  const date = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
void addDays

/**
 * The hover card, rendered as HTML and positioned so it never leaves the plot.
 *
 * WHY HTML AND NOT CANVAS
 * -----------------------
 * It is a two-column table of text with tabular figures. Canvas would mean
 * re-implementing text layout, measurement and wrapping to arrive back where the DOM
 * already is, and the DOM version inherits the theme tokens for free.
 *
 * WHY IT FLIPS
 * ------------
 * A card that runs off the right edge hides the very columns the reader is asking
 * about, and one that sits under the cursor hides the candle. So it goes to the right
 * of the crosshair while there is room, otherwise to the left, and is clamped
 * vertically. That is the whole rule, and it is measured rather than guessed.
 */
function HoverCard({
  frame,
  displayCurrency,
  host
}: {
  frame: ChartFrame
  displayCurrency: string
  host: HTMLDivElement | null
}): JSX.Element | null {
  const hover: HoverState = frame.hover as HoverState
  const cardW = 218
  const cardH = hover.marker ? 176 : 206
  const hostW = host?.clientWidth ?? 900
  const hostH = host?.clientHeight ?? 460

  const right = hover.px + 16
  const left = right + cardW <= hostW - 4 ? right : Math.max(4, hover.px - cardW - 16)
  const top = Math.max(4, Math.min(hover.py - 24, Math.max(4, hostH - cardH - 4)))

  const marker = hover.marker?.marker ?? null
  const bucket = hover.candle?.bucket ?? null

  return (
    <div className="kl__card" style={{ left, top, width: cardW }} role="status">
      {marker ? (
        <>
          <div className="kl__card-head">
            <span className="num">
              {marker.time ?? <span className="muted">{T.klineTooltipTimeUnknown}</span>}
            </span>
            <span className="muted">{T.klineTooltipTransaction}</span>
          </div>
          <p className="kl__card-title truncate">
            {marker.merchant ?? (marker.categoryName ? categoryLabel(marker.categoryName) : T.klineUnnamed)}
          </p>
          <div className="kl__card-sub truncate">
            {[categoryLabel(marker.categoryName), marker.accountName].filter(Boolean).join(' · ')}
          </div>
          <div
            className={`kl__card-amount num ${
              marker.type === 'income' ? 'is-up' : marker.type === 'transfer' ? '' : 'is-down'
            }`}
          >
            {marker.type === 'transfer' ? '' : marker.type === 'income' ? '+' : '−'}
            {formatMoney(
              marker.convertedDelta === null ? marker.amount : Math.abs(marker.convertedDelta),
              marker.convertedDelta === null ? marker.currency : displayCurrency
            )}
          </div>
          <dl className="kl__card-rows">
            <div>
              <dt>{T.klineTooltipBalanceBefore}</dt>
              <dd className="num">
                {marker.balanceBefore === null ? '—' : formatMoney(marker.balanceBefore, displayCurrency)}
              </dd>
            </div>
            <div>
              <dt>{T.klineTooltipBalanceAfter}</dt>
              <dd className="num">
                {marker.balanceAfter === null ? '—' : formatMoney(marker.balanceAfter, displayCurrency)}
              </dd>
            </div>
          </dl>
          {marker.currency !== displayCurrency && marker.convertedDelta !== null ? (
            <div className="kl__card-sub num">
              原始 {formatMoney(marker.amount, marker.currency)} {marker.currency}
            </div>
          ) : null}
        </>
      ) : bucket ? (
        <>
          <div className="kl__card-head">
            <span className="num">{formatDate(bucket.date, 'YYYY-MM-DD')}</span>
            <span className="muted">{T.klineTooltipCandle}</span>
          </div>
          <dl className="kl__card-rows">
            <div>
              <dt>{T.klineTooltipOpen}</dt>
              <dd className="num">{formatMoney(bucket.balanceOpen, displayCurrency)}</dd>
            </div>
            <div>
              <dt>{T.klineTooltipHigh}</dt>
              <dd className="num">{formatMoney(bucket.balanceHigh, displayCurrency)}</dd>
            </div>
            <div>
              <dt>{T.klineTooltipLow}</dt>
              <dd className="num">{formatMoney(bucket.balanceLow, displayCurrency)}</dd>
            </div>
            <div>
              <dt>{T.klineTooltipClose}</dt>
              <dd className="num">{formatMoney(bucket.balanceClose, displayCurrency)}</dd>
            </div>
            <div>
              <dt>{T.klineTooltipNet}</dt>
              <dd className="num">
                {bucket.net >= 0 ? '+' : '−'}
                {formatMoney(Math.abs(bucket.net), displayCurrency)}
              </dd>
            </div>
            <div>
              <dt>{T.klineTooltipIncome}</dt>
              <dd className="num is-up">+{formatMoney(bucket.income, displayCurrency)}</dd>
            </div>
            <div>
              <dt>{T.klineTooltipExpense}</dt>
              <dd className="num is-down">−{formatMoney(bucket.expense, displayCurrency)}</dd>
            </div>
            <div>
              <dt>{T.klineTooltipCount}</dt>
              <dd className="num">{klineTxCount(bucket.transactionCount)}</dd>
            </div>
          </dl>
        </>
      ) : null}
    </div>
  )
}

const KLINE_PANEL_STYLES = `
.kl { display: flex; flex-direction: column; gap: var(--space-3); min-width: 0; }

/* ---- quote block ---- */
.kl__quote {
  display: flex; align-items: flex-start; gap: var(--space-6); flex-wrap: wrap;
  padding-bottom: var(--space-3); border-bottom: 1px solid var(--border-subtle);
}
.kl__quote-main { display: flex; flex-direction: column; gap: 2px; min-width: 200px; }
.kl__quote-label { margin: 0; font-size: var(--text-xs); color: var(--text-secondary); }
.kl__quote-value { font-size: var(--text-3xl); font-weight: var(--weight-bold); letter-spacing: -0.02em; color: var(--text-primary); font-variant-numeric: tabular-nums; }
.kl__quote-delta { display: flex; align-items: baseline; gap: var(--space-2); font-size: var(--text-sm); font-weight: var(--weight-medium); }
.kl__quote-delta.is-up { color: var(--market-up); }
.kl__quote-delta.is-down { color: var(--market-down); }
.kl__quote-pct { opacity: 0.9; }

.kl__ohlc, .kl__flows { display: flex; gap: var(--space-5); margin: 0; flex-wrap: wrap; }
.kl__ohlc > div, .kl__flows > div { display: flex; flex-direction: column; gap: 1px; }
.kl__ohlc dt, .kl__flows dt { font-size: var(--text-2xs); color: var(--text-tertiary); }
.kl__ohlc dd, .kl__flows dd { margin: 0; font-size: var(--text-sm); font-weight: var(--weight-medium); color: var(--text-primary); font-variant-numeric: tabular-nums; }
.kl__flows dd.is-up, .is-up { color: var(--market-up); }
.kl__flows dd.is-down, .is-down { color: var(--market-down); }

/* The zoom readout: what the viewport actually is, in days, and where it starts. */
.kl__zoom { display: flex; flex-direction: column; gap: 1px; margin-left: auto; text-align: right; }
.kl__zoom-label { font-size: var(--text-2xs); color: var(--text-tertiary); }
.kl__zoom b { font-size: var(--text-sm); font-weight: var(--weight-semibold); color: var(--text-primary); }
.kl__zoom-range { font-size: var(--text-2xs); }

/* ---- controls ---- */
.kl__controls { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
.kl__ranges { display: flex; gap: 2px; flex-wrap: wrap; }
.kl__range {
  height: 24px; padding: 0 var(--space-2); border-radius: var(--radius-sm);
  font-size: var(--text-2xs); font-weight: var(--weight-medium); color: var(--text-secondary);
  transition: background-color var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out);
}
.kl__range:hover { background-color: var(--bg-hover); color: var(--text-primary); }
.kl__range.is-active { background-color: var(--accent-subtle); color: var(--accent-text); }
.kl__spacer { flex: 1 1 auto; }
/* The custom-range editor drops onto its own row so two date fields and a button do
   not squeeze the range controls onto one cramped line. */
.kl__custom { display: flex; align-items: flex-end; gap: var(--space-2); flex-wrap: wrap; flex-basis: 100%; }
.kl__custom label { display: flex; flex-direction: column; gap: 2px; font-size: var(--text-2xs); }
.kl__custom .input { width: 132px; height: 28px; font-size: var(--text-xs); }
.kl__ma { position: relative; }
.kl__ma-menu {
  position: absolute; right: 0; top: calc(100% + 4px); z-index: 20; min-width: 150px;
  display: flex; flex-direction: column; gap: 2px; padding: var(--space-2);
  background-color: var(--bg-glass); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
  border: 1px solid var(--border-default); border-radius: var(--radius-md); box-shadow: var(--shadow-md);
}
.kl__ma-item { display: flex; align-items: center; gap: var(--space-2); padding: 3px var(--space-1); font-size: var(--text-xs); border-radius: var(--radius-sm); cursor: pointer; }
.kl__ma-item:hover { background-color: var(--bg-hover); }
.kl__ma-item.is-disabled { opacity: 0.5; cursor: not-allowed; }
.kl__ma-why { margin-left: auto; font-size: var(--text-2xs); color: var(--text-tertiary); }
.kl__goto { display: inline-flex; align-items: center; gap: var(--space-1); height: 26px; padding: 0 var(--space-2); border: 1px solid var(--border-default); border-radius: var(--radius-sm); color: var(--text-secondary); }
.kl__goto-input { width: 108px; height: 22px; font-size: var(--text-2xs); color: var(--text-primary); background: none; border: none; }
.kl__goto-input:focus-visible { outline: none; }
.kl__notice { margin: 0; font-size: var(--text-xs); }
.kl__skeleton { border-radius: var(--radius-md); }

/* ---- MA readout ---- */
.kl__ma-readout { display: flex; align-items: baseline; gap: var(--space-4); flex-wrap: wrap; font-size: var(--text-xs); min-height: 18px; }
.kl__ma-value { display: inline-flex; align-items: baseline; gap: 4px; }
.kl__ma-value b { font-weight: var(--weight-medium); font-variant-numeric: tabular-nums; }
.kl__ma-value--1 { color: var(--market-ma-1); }
.kl__ma-value--2 { color: var(--market-ma-2); }
.kl__ma-value--3 { color: var(--market-ma-3); }
.kl__ma-value--4 { color: var(--market-ma-4); }
.kl__ma-value--5 { color: var(--market-ma-5); }
.kl__ma-na { font-style: normal; font-size: var(--text-2xs); color: var(--text-tertiary); }

/* ---- chart + hover card ---- */
.kl__chart { position: relative; min-width: 0; }
/* The card is absolutely positioned inside the chart box, so the position maths only
   has to reason about one containing block. */
.kl__card {
  position: absolute; z-index: 30; pointer-events: none;
  display: flex; flex-direction: column; gap: 3px; padding: var(--space-2) var(--space-3);
  background-color: var(--bg-glass); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
  border: 1px solid var(--border-default); border-radius: var(--radius-md);
  box-shadow: var(--shadow-md); font-size: var(--text-2xs); color: var(--text-secondary);
}
.kl__card-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-2); }
.kl__card-head .num { font-size: var(--text-xs); font-weight: var(--weight-semibold); color: var(--text-primary); }
.kl__card-title { margin: 0; font-size: var(--text-xs); font-weight: var(--weight-medium); color: var(--text-primary); }
.kl__card-sub { font-size: var(--text-2xs); color: var(--text-tertiary); }
.kl__card-amount { font-size: var(--text-lg); font-weight: var(--weight-semibold); color: var(--text-primary); }
.kl__card-amount.is-up { color: var(--market-up); }
.kl__card-amount.is-down { color: var(--market-down); }
.kl__card-rows { display: flex; flex-direction: column; gap: 1px; margin: 2px 0 0; }
.kl__card-rows > div { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3); }
.kl__card-rows dt { color: var(--text-tertiary); }
.kl__card-rows dd { margin: 0; color: var(--text-primary); font-variant-numeric: tabular-nums; }

/* ---- legend ---- */
.kl__legend { display: flex; align-items: center; gap: var(--space-4); flex-wrap: wrap; padding-top: var(--space-2); font-size: var(--text-2xs); color: var(--text-secondary); }
.kl__legend-item { display: inline-flex; align-items: center; gap: var(--space-1); }
.kl__legend-spacer { flex: 1 1 auto; }
.kl__swatch { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
.kl__swatch--up { background-color: transparent; border: 1px solid var(--market-up); }
.kl__swatch--down { background-color: var(--market-down); }
.kl__swatch--marker { background-color: transparent; border-top: 1px solid var(--market-marker-hover); height: 1px; }

/* ---- daily detail ---- */
.kl__detail { display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-3); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); }
.kl__detail-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.kl__detail-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(104px, 1fr)); gap: var(--space-3); margin: 0; }
.kl__detail-grid > div { display: flex; flex-direction: column; gap: 1px; }
.kl__detail-grid dt { font-size: var(--text-2xs); color: var(--text-tertiary); }
.kl__detail-grid dd { margin: 0; font-size: var(--text-sm); font-weight: var(--weight-medium); color: var(--text-primary); font-variant-numeric: tabular-nums; }
.kl__detail-list { display: flex; flex-direction: column; gap: 2px; }
.kl__detail-row { display: flex; align-items: center; gap: var(--space-3); width: 100%; padding: var(--space-1) var(--space-2); border-radius: var(--radius-sm); font: inherit; font-size: var(--text-xs); color: var(--text-primary); text-align: left; cursor: pointer; }
.kl__detail-row:hover { background-color: var(--bg-hover); }
.kl__detail-time { flex: 0 0 62px; color: var(--text-secondary); }
.kl__detail-body { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
.kl__detail-meta { font-size: var(--text-2xs); }
.kl__detail-amount { flex: 0 0 auto; font-weight: var(--weight-semibold); }
.kl__detail-empty { margin: 0; font-size: var(--text-xs); }
`
