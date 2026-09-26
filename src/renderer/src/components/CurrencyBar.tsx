/**
 * CurrencyBar.tsx — the currency switcher, the live-rate ticker and a manual
 * refresh control, in one compact toolbar.
 *
 * WHAT THIS BAR IS RESPONSIBLE FOR
 * --------------------------------
 * A converted figure is only trustworthy if the user can see WHICH currency it is
 * in and HOW OLD the rate behind it is. Those two facts therefore live together,
 * one click apart, rather than being split between a settings page and a
 * dashboard widget:
 *
 *   1. Switching the display currency changes a VIEW setting. No stored amount is
 *      touched (every transaction keeps the currency it actually moved in), so the
 *      write goes to settings and then every page is told to re-query — see
 *      `refreshData`, which is the single lever the whole UI watches.
 *   2. Refreshing the rates reports its outcome out loud. A silent failure here is
 *      the worst case in the whole app: the numbers keep rendering, they simply
 *      stop being current, and nothing on screen says so.
 *   3. When there are NO rates at all, the bar says so in plain Chinese and offers
 *      the button that fixes it. Showing unconverted amounts without saying so
 *      would quietly imply a conversion that never happened.
 */

import { useState } from 'react'
import type { JSX } from 'react'

import { T } from '@shared/lib/i18n'
import { selectableCurrencies } from '@shared/lib/rates'
import { CurrencySwitcher, RateTicker } from '@renderer/components/Money'
import { useAppStore } from '@renderer/store/app'
import { useRateStore } from '@renderer/store/rates'

export interface CurrencyBarProps {
  /** Extra class names for the caller's layout. */
  className?: string
  /** Render the live-rate ticker next to the switcher. Default true. */
  showTicker?: boolean
}

/**
 * Component-local styles. Every value is a token; there is no literal colour
 * here. Scoped under `.sw-currency-bar` so nothing leaks into the shared
 * `.select` / `.rate-ticker` rules the rest of the app styles.
 */
const CURRENCY_BAR_STYLES = `
.sw-currency-bar {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  width: 100%;
  min-width: 0;
  font-size: var(--text-sm);
  color: var(--text-primary);
}
.sw-currency-bar__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
  width: 100%;
  min-width: 0;
}
.sw-currency-bar__row > * { min-width: 0; }
.sw-currency-bar__switcher {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  min-width: 0;
  max-width: 100%;
}
/* .select is full-width by default; in a toolbar the switcher sizes to content.
   min() keeps the floor from ever exceeding the container, so the bar cannot
   overflow horizontally at a narrow width. */
.sw-currency-bar__switcher .currency-switcher__select {
  width: auto;
  min-width: min(132px, 100%);
  max-width: 100%;
  height: 30px;
  padding: 0 var(--space-2);
}
.sw-currency-bar .rate-ticker { flex: 1 1 auto; min-width: 0; }
.sw-currency-bar__notice {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
  margin: 0;
  min-width: 0;
  padding: var(--space-2) var(--space-3);
  background-color: var(--warning-subtle);
  color: var(--warning);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  font-size: var(--text-xs);
  line-height: var(--leading-tight);
}
.sw-currency-bar__notice-text { flex: 1 1 auto; min-width: 0; }
.sw-currency-bar__notice .btn { flex: 0 0 auto; }
`

export function CurrencyBar({ className, showTicker = true }: CurrencyBarProps): JSX.Element {
  const table = useRateStore((state) => state.table)
  const info = useRateStore((state) => state.info)
  const loading = useRateStore((state) => state.loading)
  const displayCurrency = useRateStore((state) => state.displayCurrency)
  const setDisplayCurrency = useRateStore((state) => state.setDisplayCurrency)
  const refreshRates = useRateStore((state) => state.refresh)

  const updateSettings = useAppStore((state) => state.updateSettings)
  const refreshData = useAppStore((state) => state.refreshData)
  const pushToast = useAppStore((state) => state.pushToast)

  /** Local flag so the button reacts on the same frame as the click. */
  const [refreshing, setRefreshing] = useState(false)

  const options = selectableCurrencies(table)
  const noRates = info !== null && info.hasRates === false
  const busy = refreshing || loading

  /**
   * Persist the new display currency, then make every page re-query.
   *
   * The store is updated first so the switcher responds immediately; if the write
   * fails the optimistic change is rolled back, because leaving the UI showing a
   * currency the app will forget on restart is worse than a moment of flicker.
   */
  const handleCurrencyChange = (code: string): void => {
    const next = code.toUpperCase()
    const previous = displayCurrency.toUpperCase()
    if (next === previous) return

    setDisplayCurrency(next)
    void (async () => {
      try {
        await updateSettings({ displayCurrency: next })
        refreshData()
      } catch (error) {
        setDisplayCurrency(previous)
        pushToast({
          tone: 'error',
          message: error instanceof Error ? error.message : '显示货币保存失败。',
          detail: '已恢复原来的显示货币。'
        })
      }
    })()
  }

  /**
   * Force a rate fetch and tell the user what happened.
   *
   * `refresh(true)` never rejects — it resolves with `{ updated, error }` — but
   * `refreshData()` must run either way, so the whole thing is wrapped in
   * try/finally rather than left to the happy path.
   */
  const handleRefresh = (): void => {
    if (busy) return
    setRefreshing(true)
    void (async () => {
      try {
        const result = await refreshRates(true)
        if (result.error !== null) {
          // Not "the numbers are fine": the user must know the fetch failed rather
          // than assume the figures they are looking at are current.
          pushToast({
            tone: 'error',
            message: `汇率更新失败：${result.error}`,
            detail: '界面仍在使用上一次成功获取的汇率。'
          })
        } else if (result.updated) {
          pushToast({ tone: 'success', message: '汇率已更新。' })
        } else {
          pushToast({ tone: 'info', message: '汇率已是最新。' })
        }
      } catch (error) {
        pushToast({
          tone: 'error',
          message: error instanceof Error ? error.message : '汇率更新失败。',
          detail: '界面仍在使用上一次成功获取的汇率。'
        })
      } finally {
        // Every page reads its figures through the data-version counter, so this
        // is what actually pushes a fresh rate table into the UI.
        refreshData()
        setRefreshing(false)
      }
    })()
  }

  return (
    <div className={className ? `sw-currency-bar ${className}` : 'sw-currency-bar'}>
      <style>{CURRENCY_BAR_STYLES}</style>

      <div className="sw-currency-bar__row">
        <span className="sw-currency-bar__switcher">
          <CurrencySwitcher value={displayCurrency} onChange={handleCurrencyChange} options={options} />
        </span>

        {/*
          The ticker already reports freshness and carries its own refresh button.
          With no rates at all it is replaced by the notice below, so the user is
          never shown two refresh buttons and two versions of the same message.
        */}
        {showTicker && !noRates ? <RateTicker onRefresh={handleRefresh} refreshing={refreshing} /> : null}
      </div>

      {noRates ? (
        <p className="sw-currency-bar__notice" role="status">
          <span className="sw-currency-bar__notice-text">尚未获取汇率，金额以原币显示。</span>
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            onClick={handleRefresh}
            disabled={busy}
            aria-label="获取汇率"
            title="获取汇率"
          >
            {busy ? '更新中…' : T.refresh}
          </button>
        </p>
      ) : null}
    </div>
  )
}
