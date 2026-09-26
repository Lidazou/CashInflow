import type { AccountType } from '@shared/types'

export const APP_NAME = 'SpendWise'

/** Highest schema version this build understands. */
export const SCHEMA_VERSION = 2

export const WINDOW_DEFAULTS = {
  width: 1400,
  height: 900,
  minWidth: 1024,
  minHeight: 700
} as const

/** Layout breakpoints used by the responsive three-column dashboard (spec §27). */
export const BREAKPOINTS = {
  /** Below this the right-hand "Biggest Expenses" column collapses. */
  wide: 1280,
  /** Below this the middle "Today" column stacks under the overview. */
  standard: 1100
} as const

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  cash: 'Cash',
  bank: 'Bank',
  wallet: 'E-Wallet',
  credit_card: 'Credit Card',
  other: 'Other'
}

export const ACCOUNT_TYPE_ICONS: Record<AccountType, string> = {
  cash: 'banknote',
  bank: 'landmark',
  wallet: 'wallet',
  credit_card: 'credit-card',
  other: 'circle'
}

/**
 * Credit cards normally carry a negative (owed) balance, so the UI needs to
 * know not to treat that as an error state.
 */
export const ACCOUNT_TYPES_ALLOWING_NEGATIVE: readonly AccountType[] = ['credit_card'] as const

export const SETTINGS_KEYS = {
  baseCurrency: 'base_currency',
  startOfWeek: 'start_of_week',
  dateFormat: 'date_format',
  theme: 'theme',
  locale: 'locale',
  hasCompletedOnboarding: 'has_completed_onboarding',
  lastBackupAt: 'last_backup_at',
  demoDataLoaded: 'demo_data_loaded',
  /**
   * Day of month a settlement cycle starts on (1-28). 1 reproduces a plain
   * calendar month, so this is a strict generalisation rather than a mode flag.
   */
  cycleStartDay: 'cycle_start_day',
  /**
   * Currency amounts are CONVERTED INTO for display. Distinct from
   * `baseCurrency`, which is the currency new accounts and totals default to.
   * The user can switch the display currency at any time without touching the
   * ledger.
   */
  displayCurrency: 'display_currency',
  /** Show the original amount alongside the converted one. */
  showOriginalCurrency: 'show_original_currency',
  /** Last time rates were successfully refreshed, for the staleness indicator. */
  ratesAutoRefresh: 'rates_auto_refresh'
} as const

/** CSV column order for transaction export (spec §6). */
export const CSV_EXPORT_HEADERS = [
  'Date',
  'Time',
  'Type',
  'Amount',
  'Currency',
  'Account',
  'Category',
  'Merchant',
  'Note',
  'Transfer Account'
] as const
