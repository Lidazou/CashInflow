import { create } from 'zustand'
import type { ExchangeRateInfo, RateQuote } from '@shared/types'
import type { RateTable } from '@shared/lib/rates'
import { DEFAULT_CURRENCY, QUICK_CURRENCIES } from '@shared/lib/money'

/**
 * Exchange-rate state for the renderer.
 *
 * Rates are fetched once into this store and shared by every page, rather than
 * each component fetching independently. Two reasons:
 *
 *   1. Consistency. Two figures on the same screen must be converted with the
 *      SAME rate, or a user who adds them up will find they do not reconcile.
 *   2. Network discipline. The app makes at most one rate request per refresh,
 *      not one per component.
 *
 * The table lives in the main process (cached in SQLite); this store holds the
 * renderer's copy plus the UI-facing metadata.
 */

interface RateState {
  /** The rate table used by every conversion in the UI. */
  table: RateTable | null
  /** Metadata: freshness, provider, ticker quotes. */
  info: ExchangeRateInfo | null
  loading: boolean
  /** Message from the last failed refresh, so the UI can explain itself. */
  error: string | null
  /** Display currency currently in effect. */
  displayCurrency: string

  load: (quoteTargets?: string[]) => Promise<void>
  refresh: (force?: boolean) => Promise<{ updated: boolean; error: string | null }>
  setManual: (rates: Record<string, number>, base?: string) => Promise<void>
  clear: () => Promise<void>
  /** Called after the display currency setting changes. */
  setDisplayCurrency: (code: string) => void
  /** The quote for a pair, from the cached table. */
  quote: (from: string, to: string) => number | null
}

export const useRateStore = create<RateState>((set, get) => ({
  table: null,
  info: null,
  loading: false,
  error: null,
  displayCurrency: DEFAULT_CURRENCY,

  load: async (quoteTargets) => {
    set({ loading: true })
    try {
      const info = (await window.api.ratesInfo(quoteTargets)) as ExchangeRateInfo
      // The authoritative rate table comes from the main process, which owns the
      // SQLite cache. Deriving it here would risk the two drifting apart.
      const table = await loadRateTable()
      set({
        info,
        table,
        displayCurrency: (info.base ?? get().displayCurrency).toUpperCase(),
        error: info.lastError ?? null,
        loading: false
      })
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : '汇率加载失败'
      })
    }
  },

  refresh: async (force = true) => {
    set({ loading: true })
    try {
      const result = (await window.api.ratesRefresh(force)) as {
        updated: boolean
        info: ExchangeRateInfo
        error: string | null
      }
      const table = await loadRateTable()
      set({
        info: result.info,
        table,
        error: result.error,
        displayCurrency: (result.info.base ?? get().displayCurrency).toUpperCase(),
        loading: false
      })
      return { updated: result.updated, error: result.error }
    } catch (error) {
      const message = error instanceof Error ? error.message : '汇率更新失败'
      set({ loading: false, error: message })
      return { updated: false, error: message }
    }
  },

  setManual: async (rates, base) => {
    set({ loading: true })
    try {
      const info = (await window.api.ratesSetManual(rates, base)) as ExchangeRateInfo
      const table = await loadRateTable()
      set({ info, table, error: null, loading: false })
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : '手动汇率保存失败' })
      throw error
    }
  },

  clear: async () => {
    await window.api.ratesClear()
    set({ table: null, info: null, error: null })
  },

  setDisplayCurrency: (code) => set({ displayCurrency: code.toUpperCase() }),

  quote: (from, to) => {
    const table = get().table
    if (!table) return null
    const source = from.toUpperCase()
    const target = to.toUpperCase()
    if (source === target) return 1
    const base = String(table.base).toUpperCase()
    if (source === base) return table.rates[target] ?? null
    if (target === base) {
      const rate = table.rates[source]
      return rate ? 1 / rate : null
    }
    const sourceRate = table.rates[source]
    const targetRate = table.rates[target]
    if (!sourceRate || !targetRate) return null
    return targetRate / sourceRate
  }
}))

/**
 * Ask the main process for the raw rate table.
 *
 * The table travels with the metadata on the same channel, so there is exactly
 * one source of truth for a rate and no window in which the two could disagree.
 */
async function loadRateTable(): Promise<RateTable | null> {
  try {
    const info = (await window.api.ratesInfo()) as ExchangeRateInfo
    return info.table ?? null
  } catch {
    return null
  }
}

/** Quick currency codes offered in the switcher. */
export const QUICK_SWITCH_CURRENCIES = QUICK_CURRENCIES

/** Convenience hook for components that only need the quote lookup. */
export function useRateQuote(from: string, to: string): number | null {
  return useRateStore((state) => {
    const table = state.table
    if (!table) return null
    const source = from.toUpperCase()
    const target = to.toUpperCase()
    if (source === target) return 1
    const base = String(table.base).toUpperCase()
    if (source === base) return table.rates[target] ?? null
    if (target === base) {
      const rate = table.rates[source]
      return rate ? 1 / rate : null
    }
    const sourceRate = table.rates[source]
    const targetRate = table.rates[target]
    if (!sourceRate || !targetRate) return null
    return targetRate / sourceRate
  })
}

/** Ticker rows for the dashboard header. */
export function tickerRows(info: ExchangeRateInfo | null): Array<RateQuote | null> {
  return info?.quotes ?? []
}
