import type { JSX } from 'react'
import { formatMoney, getCurrency } from '@shared/lib/money'
import { convertMinor, formatRatePrecise } from '@shared/lib/rates'
import { useRateStore } from '@renderer/store/rates'
import { rateFreshnessLabel } from '@shared/lib/i18n'

/**
 * Multi-currency display primitives.
 *
 * THE RULE THESE COMPONENTS ENFORCE
 * --------------------------------
 * A stored amount is always an integer in the minor unit of the currency the
 * money actually moved in. Converting is a DISPLAY operation: it never writes
 * back, and the original figure stays available so a user checking against a
 * bank statement can always see the real number.
 *
 * Every conversion goes through `convertMinor`, which performs exactly one
 * rounding step. Components must never do their own `amount * rate` arithmetic —
 * that is how two figures on one screen end up disagreeing.
 */

export interface MoneyProps {
  /** Amount in the SOURCE currency's minor units. */
  minor: number
  /** The currency the amount is actually stored in. */
  currency: string
  /**
   * Convert into the display currency. When false the amount is shown as-is,
   * which is what an account card should do for its own balance.
   */
  convert?: boolean
  /** Override the target currency instead of using the store's display currency. */
  target?: string
  /** Show the original amount underneath when a conversion happened. */
  showOriginal?: boolean
  /** Always prefix + or - (income/expense figures). */
  signed?: boolean
  /** Render the absolute value, with the sign conveyed by colour instead. */
  absolute?: boolean
  /** Include the currency symbol. */
  withSymbol?: boolean
  className?: string
  /** Compact notation for tight spaces (1.2万). */
  compact?: boolean
}

/**
 * The single way to render a monetary amount anywhere in the app.
 *
 * When `convert` is on and no rate is available, the amount is shown in its own
 * currency with a `*` marker rather than being silently passed through at a rate
 * of 1 — a fabricated 1:1 rate is the most dangerous possible failure here,
 * because the number looks completely normal.
 */
export function Money({
  minor,
  currency,
  convert = false,
  target,
  showOriginal = false,
  signed = false,
  absolute = false,
  withSymbol = true,
  className,
  compact = false
}: MoneyProps): JSX.Element {
  const table = useRateStore((state) => state.table)
  const displayCurrency = useRateStore((state) => state.displayCurrency)
  const showOriginalSetting = useRateStore((state) => state.info?.isManual !== undefined)

  const targetCurrency = (target ?? displayCurrency).toUpperCase()
  const sourceCurrency = currency.toUpperCase()
  const shouldConvert = convert && sourceCurrency !== targetCurrency

  if (!shouldConvert) {
    return (
      <span className={className}>
        {formatMoney(minor, sourceCurrency, { signed, absolute, withSymbol, compact })}
      </span>
    )
  }

  const result = convertMinor(minor, sourceCurrency, targetCurrency, table)
  const text = formatMoney(result.minor, targetCurrency, {
    signed,
    absolute,
    withSymbol,
    compact
  })

  // No rate available: show the true figure with a marker instead of inventing one.
  if (result.approximate) {
    return (
      <span className={className} title={`暂无 ${sourceCurrency} 到 ${targetCurrency} 的汇率，显示原币金额`}>
        {formatMoney(minor, sourceCurrency, { signed, absolute, withSymbol, compact })}
        <span aria-hidden="true"> *</span>
      </span>
    )
  }

  const originalText = formatMoney(minor, sourceCurrency, { absolute, withSymbol })

  return (
    <span className={className} title={`${originalText} · ${formatRatePrecise(result.rate, sourceCurrency, targetCurrency)}`}>
      {text}
      {showOriginal && showOriginalSetting ? (
        <span className="money-original">（{originalText}）</span>
      ) : null}
    </span>
  )
}

/**
 * A currency code shown as a symbol plus code, e.g. "¥ CNY".
 * The code is included because ¥ is ambiguous between CNY and JPY, and showing
 * the wrong one is a real error rather than a cosmetic one.
 */
export function CurrencyTag({ code, className }: { code: string; className?: string }): JSX.Element {
  const info = (getCurrency(code) ?? null) as { symbol: string } | null
  return (
    <span className={className}>
      {info?.symbol ?? ''} {code.toUpperCase()}
    </span>
  )
}

/**
 * The live-rate ticker shown on the dashboard.
 *
 * Displays the freshness of the data next to the rates, because a rate without
 * its age invites the user to trust a stale number.
 */
export function RateTicker({
  onRefresh,
  refreshing,
  compact = false
}: {
  onRefresh?: () => void
  refreshing?: boolean
  compact?: boolean
}): JSX.Element | null {
  const info = useRateStore((state) => state.info)
  const loading = useRateStore((state) => state.loading)

  if (!info) return null

  const quotes = info.quotes.filter((quote): quote is NonNullable<typeof quote> => quote !== null)

  return (
    <div className={`rate-ticker ${compact ? 'is-compact' : ''}`} aria-label="实时汇率">
      <span className={`rate-ticker__status is-${info.freshness}`} title={info.provider ?? ''}>
        <span className="rate-ticker__dot" aria-hidden="true" />
        {rateFreshnessLabel(info.freshness)}
      </span>

      {quotes.length === 0 ? (
        <span className="rate-ticker__empty">
          {info.hasRates ? '暂无对照汇率' : '尚未获取汇率'}
        </span>
      ) : (
        <ul className="rate-ticker__list">
          {quotes.map((quote) => (
            <li key={`${quote.from}-${quote.to}`} className="rate-ticker__item">
              <span className="rate-ticker__pair">
                {quote.from}/{quote.to}
              </span>
              <span className="rate-ticker__value num">{formatTickRate(quote.rate)}</span>
            </li>
          ))}
        </ul>
      )}

      {onRefresh ? (
        <button
          type="button"
          className="rate-ticker__refresh"
          onClick={onRefresh}
          disabled={refreshing || loading}
          aria-label="更新汇率"
          title="更新汇率"
        >
          {refreshing || loading ? '更新中…' : '更新'}
        </button>
      ) : null}
    </div>
  )
}

/** Rates are shown at 4 significant decimals, trimmed of trailing zeros. */
function formatTickRate(rate: number): string {
  if (!Number.isFinite(rate) || rate <= 0) return '—'
  if (rate >= 100) return rate.toFixed(2)
  if (rate >= 1) return rate.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
  return rate.toFixed(5).replace(/0+$/, '').replace(/\.$/, '')
}

/**
 * A currency selector.
 *
 * Switching this changes only how figures are DISPLAYED; no stored amount is
 * modified. That is why it sits next to the money on the dashboard rather than
 * buried in settings — it is a view control, not a data change.
 */
export function CurrencySwitcher({
  value,
  onChange,
  options,
  disabled
}: {
  value: string
  onChange: (code: string) => void
  options: Array<{ code: string; label: string; symbol: string }>
  disabled?: boolean
}): JSX.Element {
  return (
    <label className="currency-switcher">
      <span className="visually-hidden">选择显示货币</span>
      <select
        className="select currency-switcher__select"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.code} value={option.code}>
            {option.symbol} {option.label}
          </option>
        ))}
      </select>
    </label>
  )
}

/**
 * Explanation of a converted total.
 *
 * When a figure mixes currencies, saying so is mandatory: the user needs to know
 * that ¥8,500 is a converted sum rather than money sitting in one account.
 */
export function ConversionNote({
  sources,
  displayCurrency,
  hasUnconverted,
  className
}: {
  sources: Array<{ currency: string; converted: boolean }>
  displayCurrency: string
  hasUnconverted: boolean
  className?: string
}): JSX.Element | null {
  const foreign = sources.filter((source) => source.currency.toUpperCase() !== displayCurrency.toUpperCase())
  if (foreign.length === 0 && !hasUnconverted) return null

  return (
    <p className={`conversion-note ${className ?? ''}`}>
      {foreign.length > 0 ? (
        <span>
          已按实时汇率折算（原币种：{foreign.map((source) => source.currency).join('、')}）
        </span>
      ) : null}
      {hasUnconverted ? (
        <span className="conversion-note__warn">
          部分币种暂无汇率，未计入合计，已用 <strong>*</strong> 标出。
        </span>
      ) : null}
    </p>
  )
}
