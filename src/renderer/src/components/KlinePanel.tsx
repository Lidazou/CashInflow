import { useCallback, useMemo, useState } from 'react'
import type { JSX } from 'react'

import { Icon } from '@renderer/components/Icon'
import { Money } from '@renderer/components/Money'
import { CashflowChart, bucketDaily } from '@renderer/components/CashflowChart'
import { useUiStore } from '@renderer/store/ui'
import { T, categoryLabel, klineTxCount } from '@shared/lib/i18n'
import { addDays, formatDate, today } from '@shared/lib/dates'
import { formatMoney } from '@shared/lib/money'
import type {
  CashflowTransactionMarker,
  KlineBucket,
  KlineGranularity,
  KlineSeries,
  TransactionWithRefs
} from '@shared/types'

/**
 * KlinePanel — the cashflow terminal.
 *
 * WHAT THIS LAYER OWNS
 * --------------------
 * `CashflowChart` draws and reports what is under the cursor; everything that
 * DECIDES lives here:
 *
 *   - the header quote block (balance, net change, %, OHLC, income/expense/count),
 *   - which period and range are being shown,
 *   - which moving averages are on,
 *   - the Daily Detail panel, and the hand-off to the existing transaction drawer.
 *
 * The header is HTML rather than canvas on purpose. It is text and small tables, and
 * re-implementing text layout in canvas to save a React render would be a lot of
 * code to arrive back where the DOM already is.
 *
 * THE HEADER FOLLOWS THE CURSOR, AND SAYS WHICH DATE IT IS SHOWING
 * ---------------------------------------------------------------
 * Moving the crosshair onto a historical candle replaces the header figures with that
 * candle's. The label changes with them — "当前余额" only appears for the newest
 * candle; anything else reads "9月20日 收盘". Without that, a user inspecting last
 * March would read an old balance as today's money, which is the most expensive
 * mistake this screen could invite.
 */

/**
 * Range presets, in candles-or-days depending on the period.
 *
 * Explicit numbers rather than a dropdown of vague words: "90D" is a question the
 * user can answer about their own life, "近三个月" is not.
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
  granularity: KlineGranularity
  maWindows: number[]
  activityMode: 'flow' | 'count'
  customFrom: string | null
  customTo: string | null
}

export const DEFAULT_KLINE_SETTINGS: KlineSettings = {
  rangeId: 'all',
  granularity: 'day',
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
  const [hovered, setHovered] = useState<{
    bucket: KlineBucket | null
    marker: CashflowTransactionMarker | null
  }>({ bucket: null, marker: null })
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [gotoDate, setGotoDate] = useState<string | { from: string; to: string } | null>(null)
  const [resetToken, setResetToken] = useState(0)
  const [gotoNotice, setGotoNotice] = useState<string | null>(null)
  const [customOpen, setCustomOpen] = useState(false)
  const [customFrom, setCustomFrom] = useState(() => settings.customFrom ?? '')
  const [customTo, setCustomTo] = useState(() => settings.customTo ?? '')

  const buckets = useMemo(
    () => (series ? bucketDaily(series.daily, settings.granularity) : []),
    [series, settings.granularity]
  )

  const markersByDate = useMemo(() => {
    const map = new Map<string, CashflowTransactionMarker[]>()
    for (const point of series?.points ?? []) {
      if (point.markers.length > 0) map.set(point.date, point.markers)
    }
    return map
  }, [series])

  /**
   * Which bucket the header is describing.
   *
   * Cursor first, then the explicitly selected candle, then the newest one. That
   * order means hovering always previews, while a click keeps its figures on screen
   * after the cursor moves away — you can click a day, move to read the detail panel,
   * and the header still describes the day you clicked.
   */
  const focusDate = hovered.bucket?.date ?? selectedDate
  const focus = useMemo(() => {
    if (buckets.length === 0) return null
    if (focusDate) {
      const found = buckets.find((bucket) => bucket.date === focusDate)
      if (found) return found
    }
    return buckets[buckets.length - 1]
  }, [buckets, focusDate])

  const latest = buckets.length > 0 ? buckets[buckets.length - 1] : null
  const isCurrent = focus !== null && latest !== null && focus.date === latest.date

  /**
   * Change as a fraction of where THIS bucket opened.
   *
   * Derived here rather than carried on the bucket, because the bucket may have been
   * re-bucketed locally by the zoom control — a week candle the service never produced
   * still needs a percentage, and it has to be computed from the same open/close the
   * header prints. Null when the bucket opened at nothing: "up 100% from zero" is not
   * a number anyone can act on.
   */
  const changeRatio = focus && focus.balanceOpen !== 0 ? (focus.balanceClose - focus.balanceOpen) / focus.balanceOpen : null

  const focusMarkers = focus ? (markersByDate.get(focus.date) ?? []) : []

  /**
   * Day flow recomputed from the markers, for day-sized buckets.
   *
   * A marker's amount is converted and rounded on its own; a bucket's income/expense
   * are the first difference of a rounded cumulative curve, rounded once for the whole
   * bucket. On a day bucket those two can disagree by one minor unit — the header
   * reading ¥395.67 while the marker under the cursor reads ¥395.66 — and a reader who
   * notices that stops trusting both numbers.
   *
   * For a day-sized bucket the markers ARE the complete answer, so the header sums
   * them. For a coarser bucket the markers on screen are only the entries sitting in
   * one column, so the bucket's own totals are the correct source and are left alone.
   */
  const isDayBucket = settings.granularity === 'day'
  const dayFlow = useMemo(() => {
    if (!isDayBucket) return null
    let income = 0
    let expense = 0
    for (const marker of focusMarkers) {
      const magnitude = marker.convertedDelta === null ? marker.amount : Math.abs(marker.convertedDelta)
      if (marker.type === 'income') income += magnitude
      else if (marker.type === 'expense') expense += magnitude
    }
    return { income, expense, net: income - expense }
  }, [isDayBucket, focusMarkers])

  const headerIncome = dayFlow ? dayFlow.income : (focus?.income ?? 0)
  const headerExpense = dayFlow ? dayFlow.expense : (focus?.expense ?? 0)
  const headerNet = dayFlow ? dayFlow.net : (focus?.net ?? 0)

  /**
   * MA values for the focused bucket, printed above the chart.
   *
   * A professional chart shows the indicator values it is drawing rather than making
   * the reader measure them off the pixels, and the numbers follow the crosshair so
   * that "what was MA20 on the day I am looking at" is answerable without arithmetic.
   *
   * Computed from the same buckets the chart draws, with the same window means, so the
   * printed figure and the line cannot disagree. A window with no value yet prints an
   * em dash rather than a number: a partial-window mean is a different quantity that
   * happens to look like the real one.
   */
  const maReadout = useMemo(() => {
    if (buckets.length === 0) return []
    const closes = buckets.map((bucket) => bucket.balanceClose)
    const index = focus ? Math.max(0, buckets.findIndex((bucket) => bucket.date === focus.date)) : buckets.length - 1
    return ALL_MA.map((windowSize) => {
      if (!settings.maWindows.includes(windowSize)) return { windowSize, shown: false, value: null, available: true }
      const values = movingMean(closes, windowSize)
      return {
        windowSize,
        shown: true,
        value: values[index] ?? null,
        available: buckets.length >= windowSize
      }
    })
  }, [buckets, focus, settings.maWindows])

  /** Transactions for the Daily Detail panel, from the service's tooltip payload. */
  const focusTransactions = useMemo(() => {
    if (!focus || !series) return []
    return series.points.find((point) => point.date === focus.date)?.transactions ?? []
  }, [focus, series])

  const applyRange = useCallback(
    (rangeId: string, days: number | null): void => {
      onSettings({ rangeId })
      if (days === null) {
        setResetToken((token) => token + 1)
        return
      }
      // Jump the view to the last N days by asking the chart to centre on a date
      // `days` back; the chart owns its own zoom window.
      const anchor = series ? addDays(series.to || today(), -days) : today()
      setGotoDate(anchor)
    },
    [onSettings, series]
  )

  const gotoPicked = useCallback(
    (date: string): void => {
      if (buckets.length === 0) return
      const index = buckets.findIndex((bucket) => bucket.date >= date)
      setGotoDate(date)
      if (index === -1) {
        // The date is past everything recorded. Say so, and name the day we landed on,
        // rather than silently showing a different date than the one typed.
        setGotoNotice(
          `所选日期没有记录，已定位到最近有数据的 ${formatDate(buckets[buckets.length - 1].date, 'YYYY-MM-DD')}。`
        )
      } else {
        setGotoNotice(null)
      }
    },
    [buckets]
  )

  /**
   * Apply a user-typed span.
   *
   * Reversed ends are refused rather than swapped: a swapped range would silently
   * show a period the user did not ask for, and "why is my chart showing August when
   * I typed September" is a worse outcome than a one-line message.
   *
   * A range that misses the recorded data entirely is reported AND the view is reset
   * to everything, because leaving the chart parked on the previous window while
   * saying "no data" reads as though the request was ignored.
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
    if (buckets.length === 0) return

    const first = buckets[0].date
    const last = buckets[buckets.length - 1].date
    onSettings({ rangeId: 'custom', customFrom, customTo })

    if (customTo < first || customFrom > last) {
      setGotoNotice(`这段时间没有记录（有数据的范围是 ${first} 至 ${last}），已显示全部区间。`)
      setResetToken((token) => token + 1)
      return
    }

    setGotoNotice(null)
    setGotoDate({ from: customFrom, to: customTo })
    setCustomOpen(false)
  }, [customFrom, customTo, buckets, onSettings])

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

  const openMarker = useCallback(
    async (marker: CashflowTransactionMarker): Promise<void> => {
      await openTransaction(marker.transactionId)
    },
    [openTransaction]
  )

  const activityLabel = settings.activityMode === 'flow' ? '收入 / 支出' : '交易笔数'

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
          <div className={`kl__quote-delta ${focus && focus.net > 0 ? 'is-up' : focus && focus.net < 0 ? 'is-down' : ''}`}>
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
            <dt>高</dt>
            <dd className="num">{focus ? formatMoney(focus.balanceHigh, displayCurrency) : '—'}</dd>
          </div>
          <div>
            <dt>低</dt>
            <dd className="num">{focus ? formatMoney(focus.balanceLow, displayCurrency) : '—'}</dd>
          </div>
          <div>
            <dt>开</dt>
            <dd className="num">{focus ? formatMoney(focus.balanceOpen, displayCurrency) : '—'}</dd>
          </div>
          <div>
            <dt>收</dt>
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
            <dt>交易</dt>
            <dd className="num">{focus ? `${focus.transactionCount} 笔` : '—'}</dd>
          </div>
        </dl>
      </section>

      {/* ---------------- controls ---------------- */}
      <div className="kl__controls">
        <div className="segmented" role="tablist" aria-label="K 线周期">
          {(['day', 'week', 'month'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={settings.granularity === value}
              className="segmented__item"
              onClick={() => {
                onSettings({ granularity: value })
                setResetToken((token) => token + 1)
              }}
            >
              {value === 'day' ? '日K' : value === 'week' ? '周K' : '月K'}
            </button>
          ))}
        </div>

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
                // A window longer than the data cannot be drawn, and offering it as a
                // working toggle would be a lie. It is shown, disabled, with the
                // reason.
                const available = buckets.length >= windowSize
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
            setResetToken((token) => token + 1)
            setSelectedDate(null)
            onSettings({ rangeId: 'all' })
          }}
        >
          <Icon name="refresh" size={12} />
          重置
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
              <b className="num">
                {entry.value === null ? '—' : formatMoney(entry.value, displayCurrency)}
              </b>
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
        <div className="kl__skeleton skeleton" aria-busy={loading} />
      ) : series.points.length === 0 ? (
        <div className="empty-state sw-dash__empty">
          <p>还没有可绘制的记录。记上几笔之后，这里会显示资金走势。</p>
        </div>
      ) : (
        <>
          <CashflowChart
            series={series}
            displayCurrency={displayCurrency}
            granularity={settings.granularity}
            maWindows={settings.maWindows}
            activityMode={settings.activityMode}
            height={430}
            onHover={(bucket, marker) => setHovered({ bucket, marker })}
            onClickBucket={(bucket) => setSelectedDate(bucket.date)}
            onClickMarker={(marker) => void openMarker(marker)}
            gotoDate={gotoDate}
            onGotoConsumed={() => setGotoDate(null)}
            resetToken={resetToken}
          />

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
            <span className="muted">活动副图：{activityLabel}</span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() =>
                onSettings({ activityMode: settings.activityMode === 'flow' ? 'count' : 'flow' })
              }
            >
              切换
            </button>
          </div>

          {hovered.marker ? (
            <MarkerHint marker={hovered.marker} displayCurrency={displayCurrency} />
          ) : null}
        </>
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
              <dt>交易</dt>
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
                      {transaction.time ?? <span className="muted">时间未记录</span>}
                    </span>
                    <span className="kl__detail-body">
                      <span className="truncate">
                        {transaction.merchant ?? categoryLabel(transaction.categoryName) ?? '交易'}
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

/** One-line summary of the marker under the cursor. */
function MarkerHint({
  marker,
  displayCurrency
}: {
  marker: CashflowTransactionMarker
  displayCurrency: string
}): JSX.Element {
  return (
    <div className="kl__hint anim-fade" role="status">
      <span className="kl__hint-time num">{marker.time ?? '时间未记录'}</span>
      <span className="kl__hint-title truncate">
        {marker.merchant ?? (marker.categoryName ? categoryLabel(marker.categoryName) : '交易')}
      </span>
      {marker.categoryName ? (
        <span className="muted truncate">{categoryLabel(marker.categoryName)}</span>
      ) : null}
      <span className="muted truncate">{marker.accountName}</span>
      <span className={`num ${marker.type === 'income' ? 'is-up' : marker.type === 'transfer' ? '' : 'is-down'}`}>
        {marker.type === 'transfer' ? '' : marker.type === 'income' ? '+' : '−'}
        {formatMoney(
          marker.convertedDelta === null ? marker.amount : Math.abs(marker.convertedDelta),
          marker.convertedDelta === null ? marker.currency : displayCurrency
        )}
      </span>
      <span className="muted kl__hint-balance">
        余额{' '}
        {marker.balanceAfter === null
          ? '—'
          : formatMoney(marker.balanceAfter, displayCurrency)}
      </span>
      {marker.note ? <span className="muted truncate">{marker.note}</span> : null}
    </div>
  )
}

/** Running mean over `window` buckets, null until a full window exists. */
function movingMean(values: number[], window: number): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null)
  if (window <= 0 || values.length < window) return out
  let sum = 0
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i]
    if (i >= window) sum -= values[i - window]
    if (i >= window - 1) out[i] = Math.round(sum / window)
  }
  return out
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
.kl__quote-value { font-size: var(--text-3xl); font-weight: var(--weight-bold); letter-spacing: -0.02em; color: var(--text-primary); }
.kl__quote-delta { display: flex; align-items: baseline; gap: var(--space-2); font-size: var(--text-sm); font-weight: var(--weight-medium); }
.kl__quote-delta.is-up { color: var(--market-up); }
.kl__quote-delta.is-down { color: var(--market-down); }
.kl__quote-pct { opacity: 0.9; }

.kl__ohlc, .kl__flows { display: flex; gap: var(--space-5); margin: 0; flex-wrap: wrap; }
.kl__ohlc > div, .kl__flows > div { display: flex; flex-direction: column; gap: 1px; }
.kl__ohlc dt, .kl__flows dt { font-size: var(--text-2xs); color: var(--text-tertiary); }
.kl__ohlc dd, .kl__flows dd { margin: 0; font-size: var(--text-sm); font-weight: var(--weight-medium); color: var(--text-primary); }
.kl__flows dd.is-up, .is-up { color: var(--market-up); }
.kl__flows dd.is-down, .is-down { color: var(--market-down); }

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
   not squeeze the period and range controls onto one cramped line. */
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
.kl__skeleton { height: 430px; border-radius: var(--radius-md); }

/* ---- MA readout ---- */
.kl__ma-readout { display: flex; align-items: baseline; gap: var(--space-4); flex-wrap: wrap; font-size: var(--text-xs); min-height: 18px; }
.kl__ma-value { display: inline-flex; align-items: baseline; gap: 4px; }
.kl__ma-value b { font-weight: var(--weight-medium); }
.kl__ma-value--1 { color: var(--market-ma-1); }
.kl__ma-value--2 { color: var(--market-ma-2); }
.kl__ma-value--3 { color: var(--market-ma-3); }
.kl__ma-value--4 { color: var(--market-ma-4); }
.kl__ma-value--5 { color: var(--market-ma-5); }
.kl__ma-na { font-style: normal; font-size: var(--text-2xs); color: var(--text-tertiary); }

/* ---- legend ---- */
.kl__legend { display: flex; align-items: center; gap: var(--space-4); flex-wrap: wrap; font-size: var(--text-2xs); color: var(--text-secondary); }
.kl__legend-item { display: inline-flex; align-items: center; gap: var(--space-1); }
.kl__legend-spacer { flex: 1 1 auto; }
.kl__swatch { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
.kl__swatch--up { background-color: var(--market-up); }
.kl__swatch--down { background-color: var(--market-down); }
.kl__swatch--marker { background-color: transparent; border-top: 1px solid var(--market-marker-hover); height: 1px; }

/* ---- marker hint ---- */
.kl__hint {
  display: flex; align-items: baseline; gap: var(--space-3); flex-wrap: wrap;
  padding: var(--space-2) var(--space-3); border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md); background-color: var(--bg-surface-raised); font-size: var(--text-xs);
}
.kl__hint-time { font-weight: var(--weight-medium); color: var(--text-primary); }
.kl__hint-title { font-weight: var(--weight-medium); color: var(--text-primary); }
.kl__hint-balance { margin-left: auto; }

/* ---- daily detail ---- */
.kl__detail { display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-3); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); }
.kl__detail-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.kl__detail-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(104px, 1fr)); gap: var(--space-3); margin: 0; }
.kl__detail-grid > div { display: flex; flex-direction: column; gap: 1px; }
.kl__detail-grid dt { font-size: var(--text-2xs); color: var(--text-tertiary); }
.kl__detail-grid dd { margin: 0; font-size: var(--text-sm); font-weight: var(--weight-medium); color: var(--text-primary); }
.kl__detail-list { display: flex; flex-direction: column; gap: 2px; }
.kl__detail-row { display: flex; align-items: center; gap: var(--space-3); width: 100%; padding: var(--space-1) var(--space-2); border-radius: var(--radius-sm); font: inherit; font-size: var(--text-xs); color: var(--text-primary); text-align: left; cursor: pointer; }
.kl__detail-row:hover { background-color: var(--bg-hover); }
.kl__detail-time { flex: 0 0 62px; color: var(--text-secondary); }
.kl__detail-body { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
.kl__detail-meta { font-size: var(--text-2xs); }
.kl__detail-amount { flex: 0 0 auto; font-weight: var(--weight-semibold); }
.kl__detail-empty { margin: 0; font-size: var(--text-xs); }
`
