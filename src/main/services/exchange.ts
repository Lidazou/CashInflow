import type { Database as SqliteDatabase } from 'better-sqlite3'
import { AppError, ValidationError } from '@main/database/errors'
import { lookupRate, type RateTable } from '@shared/lib/rates'
import { DEFAULT_CURRENCY, isSupportedCurrency } from '@shared/lib/money'
import { nowIso } from '@shared/lib/dates'

/**
 * Live exchange rates.
 *
 * PROVIDERS
 * ---------
 * Three free, key-less providers are tried in order. None of them requires an
 * account, which matters for an app that must work without the user signing up
 * for anything:
 *
 *   1. open.er-api.com      — 160+ currencies, daily, no key
 *   2. exchangerate-api.com — same data, different host (used as a mirror,
 *                             which helps when one host is blocked)
 *   3. frankfurter.app      — ECB reference rates, no CNY base but cross rates
 *                             work, and it is served from the EU so it is
 *                             reachable when the others are not
 *
 * The fallback chain is not decoration. A student in mainland China, a student
 * in Kuala Lumpur and a student on a campus VPN will not all be able to reach the
 * same host, and an app that shows no rates because provider #1 timed out is
 * broken for a third of its users.
 *
 * CACHING
 * -------
 * Rates are cached in SQLite with the timestamp and provider that produced them.
 * The app therefore works completely offline using the last known rates, and the
 * UI reports their age honestly rather than presenting a week-old rate as
 * current. A manual override lets the user type a rate from their own bank when
 * they trust it more than a public feed.
 *
 * WHAT IS NEVER DONE
 * ------------------
 * Rates are only ever used to CONVERT FOR DISPLAY. No converted figure is
 * written back into the ledger, so the books always balance in the currency the
 * money actually moved in.
 */

export type ProviderId = 'er-api' | 'exchangerate-api' | 'frankfurter' | 'manual'

export interface ProviderDefinition {
  id: ProviderId
  label: string
  buildUrl: (base: string) => string
  parse: (payload: unknown, base: string) => Record<string, number> | null
  /** Provider-reported publication time, when it supplies one. */
  parseTimestamp?: (payload: unknown) => string | null
}

interface ErApiResponse {
  result?: string
  base_code?: string
  time_last_update_utc?: string
  rates?: Record<string, number>
}

interface FrankfurterResponse {
  base?: string
  date?: string
  rates?: Record<string, number>
}

/** Provider definitions. Kept declarative so a new provider is a small addition. */
export const PROVIDERS: readonly ProviderDefinition[] = [
  {
    id: 'er-api',
    label: 'open.er-api.com',
    buildUrl: (base) => `https://open.er-api.com/v6/latest/${encodeURIComponent(base)}`,
    parse: (payload) => {
      const data = payload as ErApiResponse
      if (!data || data.result !== 'success' || !data.rates) return null
      return sanitiseRates(data.rates)
    },
    parseTimestamp: (payload) => {
      const raw = (payload as ErApiResponse)?.time_last_update_utc
      if (!raw) return null
      const parsed = new Date(raw)
      return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
    }
  },
  {
    id: 'exchangerate-api',
    label: 'api.exchangerate-api.com',
    buildUrl: (base) => `https://api.exchangerate-api.com/v4/latest/${encodeURIComponent(base)}`,
    parse: (payload) => {
      const data = payload as { base?: string; date?: string; rates?: Record<string, number> }
      if (!data || !data.rates) return null
      return sanitiseRates(data.rates)
    },
    parseTimestamp: (payload) => {
      const raw = (payload as { date?: string })?.date
      if (!raw) return null
      const parsed = new Date(`${raw}T00:00:00Z`)
      return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
    }
  },
  {
    id: 'frankfurter',
    label: 'api.frankfurter.app',
    buildUrl: (base) =>
      `https://api.frankfurter.app/latest?from=${encodeURIComponent(base)}&to=${encodeURIComponent(
        'MYR,USD,SGD,HKD,EUR,GBP,JPY,KRW,AUD,CAD,TWD,THB,CNY'
      )}`,
    parse: (payload) => {
      const data = payload as FrankfurterResponse
      if (!data || !data.rates) return null
      const cleaned = sanitiseRates(data.rates)
      if (!cleaned) return null
      // Frankfurter omits the base currency from `rates`; add it so the table is
      // self-consistent like the other providers'.
      const base = (data.base ?? DEFAULT_CURRENCY).toUpperCase()
      return { ...cleaned, [base]: 1 }
    },
    parseTimestamp: (payload) => {
      const raw = (payload as FrankfurterResponse)?.date
      if (!raw) return null
      const parsed = new Date(`${raw}T00:00:00Z`)
      return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
    }
  }
]

/**
 * Discard anything that is not a usable positive finite rate.
 *
 * A provider returning null, 0 or a string for a currency must not be allowed to
 * produce NaN in a displayed figure, so bad entries are dropped rather than
 * coerced.
 */
function sanitiseRates(rates: Record<string, number>): Record<string, number> | null {
  const cleaned: Record<string, number> = {}
  for (const [code, value] of Object.entries(rates)) {
    if (!/^[A-Za-z]{3}$/.test(code)) continue
    const numeric = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(numeric) || numeric <= 0) continue
    cleaned[code.toUpperCase()] = numeric
  }
  return Object.keys(cleaned).length > 0 ? cleaned : null
}

export interface FetchOutcome {
  table: RateTable
  /** Providers that were tried and failed, with why, for diagnostics. */
  failures: Array<{ provider: ProviderId; reason: string }>
}

export interface ExchangeRateStatus {
  hasRates: boolean
  base: string | null
  fetchedAt: string | null
  provider: string | null
  isManual: boolean
  /** Age in hours, or null when unknown. */
  ageHours: number | null
}

const REQUEST_TIMEOUT_MS = 8000
const CACHE_TTL_MS = 6 * 60 * 60 * 1000 // refresh at most every 6 hours

export class ExchangeRateService {
  constructor(
    private readonly db: SqliteDatabase,
    /** Injectable for tests, so no network call is made in the suite. */
    private readonly fetchImpl: typeof fetch = globalThis.fetch
  ) {}

  // -------------------------------------------------------------------------
  // Storage
  // -------------------------------------------------------------------------

  private readMeta(): {
    base: string
    provider: string
    fetchedAt: string
    isManual: boolean
    publishedAt: string | null
  } | null {
    const rows = this.db.prepare('SELECT key, value FROM exchange_rate_meta').all() as Array<{
      key: string
      value: string
    }>
    if (rows.length === 0) return null
    const map = new Map(rows.map((row) => [row.key, row.value]))
    const base = map.get('base')
    if (!base) return null
    return {
      base,
      provider: map.get('provider') ?? 'unknown',
      fetchedAt: map.get('fetched_at') ?? nowIso(),
      isManual: map.get('is_manual') === 'true',
      publishedAt: map.get('published_at') ?? null
    }
  }

  private readRates(base: string): Record<string, number> {
    const rows = this.db
      .prepare('SELECT quote, rate FROM exchange_rates WHERE base = ?')
      .all(base) as Array<{ quote: string; rate: number }>
    const rates: Record<string, number> = {}
    for (const row of rows) rates[row.quote] = row.rate
    return rates
  }

  /** The cached table, or null when nothing has ever been fetched. */
  getTable(): RateTable | null {
    const meta = this.readMeta()
    if (!meta) return null
    const rates = this.readRates(meta.base)
    if (Object.keys(rates).length === 0) return null
    // Guarantee the identity rate is present so lookups never fail for the base.
    rates[meta.base] = 1
    return {
      base: meta.base,
      rates,
      fetchedAt: meta.publishedAt ?? meta.fetchedAt,
      provider: meta.provider,
      isManual: meta.isManual
    }
  }

  status(): ExchangeRateStatus {
    const meta = this.readMeta()
    const table = this.getTable()
    if (!meta || !table) {
      return { hasRates: false, base: null, fetchedAt: null, provider: null, isManual: false, ageHours: null }
    }
    const fetched = new Date(meta.fetchedAt)
    const ageHours = Number.isNaN(fetched.getTime())
      ? null
      : Math.max(0, Math.round(((Date.now() - fetched.getTime()) / 3_600_000) * 10) / 10)

    return {
      hasRates: true,
      base: meta.base,
      fetchedAt: meta.fetchedAt,
      provider: meta.provider,
      isManual: meta.isManual,
      ageHours
    }
  }

  private store(base: string, rates: Record<string, number>, provider: string, publishedAt: string | null, isManual: boolean): RateTable {
    const fetchedAt = nowIso()

    const run = this.db.transaction(() => {
      // Replacing the whole table rather than upserting means a currency the
      // provider stopped returning does not linger as a silently stale rate.
      this.db.prepare('DELETE FROM exchange_rates').run()
      this.db.prepare('DELETE FROM exchange_rate_meta').run()

      const insert = this.db.prepare(
        'INSERT INTO exchange_rates (base, quote, rate, provider, fetched_at) VALUES (?, ?, ?, ?, ?)'
      )
      for (const [quote, rate] of Object.entries(rates)) {
        insert.run(base, quote, rate, provider, fetchedAt)
      }

      const setMeta = this.db.prepare('INSERT INTO exchange_rate_meta (key, value) VALUES (?, ?)')
      setMeta.run('base', base)
      setMeta.run('provider', provider)
      setMeta.run('fetched_at', fetchedAt)
      setMeta.run('is_manual', String(isManual))
      if (publishedAt) setMeta.run('published_at', publishedAt)
    })

    run()

    return { base, rates: { ...rates, [base]: 1 }, fetchedAt: publishedAt ?? fetchedAt, provider, isManual }
  }

  // -------------------------------------------------------------------------
  // Fetching
  // -------------------------------------------------------------------------

  /**
   * Fetch fresh rates for `base`, trying each provider until one succeeds.
   *
   * Never throws for a network problem: it returns null and leaves the cache
   * intact, because losing rates must not make the app unusable. The caller
   * decides whether the failure is worth reporting.
   */
  async refresh(base: string = DEFAULT_CURRENCY): Promise<FetchOutcome | null> {
    const normalisedBase = base.toUpperCase()
    if (!isSupportedCurrency(normalisedBase)) {
      throw new ValidationError(`暂不支持 ${normalisedBase} 作为汇率基准货币。`, {
        base: 'Unsupported base currency'
      })
    }

    const failures: Array<{ provider: ProviderId; reason: string }> = []

    for (const provider of PROVIDERS) {
      try {
        const url = provider.buildUrl(normalisedBase)
        const payload = await this.requestJson(url)
        const rates = provider.parse(payload, normalisedBase)
        if (!rates) {
          failures.push({ provider: provider.id, reason: '返回的数据格式无法识别' })
          continue
        }
        const publishedAt = provider.parseTimestamp?.(payload) ?? null
        const table = this.store(normalisedBase, rates, provider.id, publishedAt, false)
        return { table, failures }
      } catch (error) {
        failures.push({
          provider: provider.id,
          reason: error instanceof Error ? error.message : String(error)
        })
      }
    }

    // Every provider failed. The cached rates stay in place.
    return null
  }

  private async requestJson(url: string): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const response = await this.fetchImpl(url, {
        signal: controller.signal,
        headers: { accept: 'application/json' }
      })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      return await response.json()
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('请求超时')
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Return rates for `base`, fetching only when the cache is missing, is for a
   * different base, or has aged past the TTL.
   *
   * `force` is what the "refresh now" button uses, so an impatient user is not
   * told to wait six hours.
   */
  async ensureRates(base: string = DEFAULT_CURRENCY, options: { force?: boolean } = {}): Promise<RateTable | null> {
    const normalisedBase = base.toUpperCase()
    const cached = this.getTable()
    const meta = this.readMeta()

    // A manual override is the user's explicit decision; never silently replace it.
    if (cached && cached.isManual && !options.force) return cached

    const sameBase = cached !== null && String(cached.base).toUpperCase() === normalisedBase
    const age = meta ? Date.now() - new Date(meta.fetchedAt).getTime() : Number.POSITIVE_INFINITY
    const isFresh = sameBase && Number.isFinite(age) && age < CACHE_TTL_MS

    if (isFresh && !options.force) return cached

    const outcome = await this.refresh(normalisedBase)
    if (outcome) return outcome.table

    // Fetch failed — fall back to whatever is cached, even if it is for another
    // base (the conversion layer can still cross-rate through it).
    return cached
  }

  /**
   * Record a user-supplied rate table as a manual override.
   *
   * Used by the Settings screen when someone wants the rate their bank actually
   * gave them rather than a public mid-market rate.
   *
   * `base` is a plain string rather than the `CurrencyCode` union: the provider
   * list is a superset of the currencies hardcoded in the app, so restricting it
   * to the union would reject a currency the app can legitimately display. The
   * value is validated with `isSupportedCurrency` instead, which is the same
   * check every other entry point uses.
   */
  setManualRates(rates: Record<string, number>, base: string = DEFAULT_CURRENCY): RateTable {
    const clean = sanitiseRates(rates)
    if (!clean) {
      throw new ValidationError('手动汇率无效：请至少填写一个大于 0 的汇率。', { rates: 'Invalid rates' })
    }

    const normalisedBase = base.toUpperCase()
    if (!isSupportedCurrency(normalisedBase)) {
      throw new ValidationError(`不支持的货币「${normalisedBase}」。`, { base: 'Unsupported base currency' })
    }

    return this.store(normalisedBase, clean, 'manual', null, true)
  }

  /** Drop the cached table entirely, so the next read must fetch. */
  clear(): void {
    const run = this.db.transaction(() => {
      this.db.prepare('DELETE FROM exchange_rates').run()
      this.db.prepare('DELETE FROM exchange_rate_meta').run()
    })
    run()
  }

  /**
   * Rates for the currency pairs shown in the dashboard ticker.
   *
   * Returns a null entry for a pair with no available rate rather than dropping
   * it, so the ticker keeps a stable shape and the UI can render a dash instead
   * of the row silently disappearing.
   */
  tickerPairs(
    table: RateTable | null,
    pairs: Array<[string, string]>
  ): Array<{ from: string; to: string; rate: number } | null> {
    return pairs.map(([from, to]) => {
      const rate = lookupRate(table, from, to)
      return rate === null ? null : { from, to, rate }
    })
  }
}

/** Convenience: a rate table built from explicit numbers, for tests and fixtures. */
export function makeRateTable(
  base: string,
  rates: Record<string, number>,
  overrides: Partial<RateTable> = {}
): RateTable {
  return {
    base,
    rates: { ...rates, [base]: 1 },
    fetchedAt: nowIso(),
    provider: 'test',
    isManual: false,
    ...overrides
  }
}

export { AppError }
