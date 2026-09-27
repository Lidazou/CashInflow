import { create } from 'zustand'
import type {
  AppInfo,
  AppSettings,
  DashboardPeriodMode,
  DashboardRange,
  DashboardViewMode,
  LedgerMode,
  LedgerStatus
} from '@shared/types'
import { DEFAULT_CURRENCY } from '@shared/lib/money'
import { useRateStore } from './rates'

/**
 * Global application store.
 *
 * Only genuinely global state lives here: settings, app metadata and the
 * data-version counter. Everything else (transactions, accounts, statistics) is
 * fetched per page from SQLite, so there is exactly one source of truth for a
 * financial figure and no cache that can disagree with the database.
 */

export interface Toast {
  id: number
  tone: 'success' | 'error' | 'info'
  message: string
  /** Optional second line, used to explain what to do next after a failure. */
  detail?: string
}

interface AppState {
  ready: boolean
  bootError: string | null
  settings: AppSettings | null
  info: AppInfo | null

  /**
   * Incremented whenever the main process reports a data change.
   *
   * Every data hook depends on this number, so a single write anywhere — adding
   * a transaction, importing a file, restoring a backup — refreshes the
   * dashboard, statistics and accounts pages together. This is what satisfies
   * spec §44 Tests 8 and 9 without each page polling.
   */
  dataVersion: number

  toasts: Toast[]

  /** Month currently selected across the dashboard and statistics pages. */
  activeMonth: string
  activeAccountId: number | null

  /**
   * Which ledger the app is showing (v1.7.0): the user's own, or the generated sample.
   *
   * Null until `bootstrap` resolves. Every surface that must announce the mode reads this
   * rather than asking the main process again, so the banner and the chart badges can
   * never disagree with each other.
   */
  ledger: LedgerStatus | null

  bootstrap: () => Promise<void>
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>
  /** Move to the other ledger. Resolves to the new status. */
  switchLedger: (mode: LedgerMode) => Promise<LedgerStatus>
  regenerateSample: () => Promise<LedgerStatus>
  refreshData: () => void
  pushToast: (toast: Omit<Toast, 'id'>) => void
  dismissToast: (id: number) => void
  setActiveMonth: (monthKey: string) => void
  setActiveAccountId: (id: number | null) => void
}

function currentMonthKey(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

let toastCounter = 0

export const useAppStore = create<AppState>((set, get) => ({
  ready: false,
  bootError: null,
  settings: null,
  info: null,
  dataVersion: 0,
  toasts: [],
  activeMonth: currentMonthKey(),
  activeAccountId: null,
  ledger: null,

  /**
   * Load settings and app metadata.
   *
   * A failure here is fatal for the UI, so it is surfaced as `bootError` and
   * rendered as a real message rather than leaving the app on a blank screen.
   */
  bootstrap: async () => {
    try {
      const [settings, info, ledger] = await Promise.all([
        window.api.settingsGet(),
        window.api.appInfo(),
        window.api.ledgerStatus()
      ])
      set({ settings, info, ledger, ready: true, bootError: null })

      // Seed the display currency before any component reads it, so the first
      // render formats figures in the user's chosen currency rather than
      // flashing the default and then correcting itself.
      useRateStore.getState().setDisplayCurrency(settings.displayCurrency)

      // Fetch rates once for the whole app. Every page shares this table, so two
      // figures on one screen can never be converted at different rates.
      void useRateStore.getState().load()

      // Subscribe once. The preload bridge returns an unsubscribe function; it
      // is intentionally never called because the store lives for the lifetime
      // of the window.
      window.api.onDataChanged(() => get().refreshData())

      /*
        Ledger switches are a DIFFERENT KIND of change (v1.7.0).

        A page holding "September 2026" from the user's own ledger must not simply refetch
        on top of that state when the sample comes on screen: the sample may have no
        September, and the figures underneath would then belong to a database that is no
        longer open. So the store adopts the new status and bumps `dataVersion`, which every
        page keys its queries on — the same lever a data change uses, plus the mode itself.
      */
      window.api.onLedgerChanged((status) => {
        set((state) => ({ ledger: status ?? state.ledger, dataVersion: state.dataVersion + 1 }))
      })
    } catch (error) {
      set({
        ready: true,
        bootError: error instanceof Error ? error.message : 'CashInflow could not start.'
      })
    }
  },

  updateSettings: async (patch) => {
    const updated = await window.api.settingsUpdate(patch)
    set({ settings: updated })

    // APPLY THE THEME HERE, not only in App.tsx's effect.
    //
    // Relying on the React effect alone meant that a theme written through this
    // action from anywhere except the header toggle — the Settings page, or any
    // future caller — was persisted but never painted: the stored value said
    // "dark" while the document stayed light until the next reload. Doing it here
    // makes the action self-contained, and the effect in App.tsx still covers the
    // initial load and OS-preference changes.
    if (patch.theme !== undefined) {
      applyTheme(updated.theme)
    }

    // Keep the renderer's display currency in step with the persisted setting,
    // so switching currency in Settings and switching it from the dashboard
    // behave identically.
    if (updated.displayCurrency) {
      useRateStore.getState().setDisplayCurrency(updated.displayCurrency)
    }
  },

  /**
   * Move to the other ledger (v1.7.0).
   *
   * The main process does the switching; this adopts the resulting status and bumps
   * `dataVersion` so every open page drops what it holds. The event subscription above
   * does the same thing for a switch initiated anywhere else, so the two paths agree.
   */
  switchLedger: async (mode) => {
    const status = await window.api.ledgerSwitch(mode)
    set((state) => ({ ledger: status, dataVersion: state.dataVersion + 1 }))
    /*
      Rates are stored per ledger, so the currency bar and every converted figure are
      looking at a table that belongs to the database we just left. Reloading here is what
      stops the sample from opening with "无汇率" on rows that convert perfectly well.
    */
    void useRateStore.getState().load()
    return status
  },

  regenerateSample: async () => {
    const status = await window.api.ledgerRegenerateSample()
    set((state) => ({ ledger: status, dataVersion: state.dataVersion + 1 }))
    void useRateStore.getState().load()
    return status
  },

  refreshData: () => set((state) => ({ dataVersion: state.dataVersion + 1 })),

  pushToast: (toast) => {
    toastCounter += 1
    const id = toastCounter
    set((state) => ({ toasts: [...state.toasts, { ...toast, id }] }))
    // Errors stay until dismissed: a failure the user did not read is a failure
    // they will discover later as missing data.
    if (toast.tone !== 'error') {
      setTimeout(() => get().dismissToast(id), 4000)
    }
  },

  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),

  setActiveMonth: (monthKey) => set({ activeMonth: monthKey }),
  setActiveAccountId: (id) => set({ activeAccountId: id })
}))

/** The currency to format with, falling back before settings have loaded. */
export function useBaseCurrency(): string {
  return useAppStore((state) => state.settings?.baseCurrency ?? DEFAULT_CURRENCY)
}

/**
 * Convenience hook for the settings the UI needs most often.
 *
 * `cycleStartDay` is included because the reporting period — not just its label —
 * depends on it: any page that computes "this month" must use the same cycle as
 * the dashboard or the figures will not agree.
 *
 * `dashboardPeriodMode` and `dashboardRange` ride along for the same reason: the
 * dashboard's chosen period is a persisted preference, and a hook that returned
 * the anchor without the mode would let a component compute a cycle for a month
 * the user is not looking at.
 */
export function useDisplaySettings(): {
  currency: string
  displayCurrency: string
  dateFormat: AppSettings['dateFormat']
  startOfWeek: 0 | 1
  cycleStartDay: number
  showOriginalCurrency: boolean
  dashboardPeriodMode: DashboardPeriodMode
  dashboardRange: DashboardRange | null
  dashboardViewMode: DashboardViewMode
} {
  const settings = useAppStore((state) => state.settings)
  return {
    currency: settings?.baseCurrency ?? DEFAULT_CURRENCY,
    displayCurrency: settings?.displayCurrency ?? DEFAULT_CURRENCY,
    dateFormat: settings?.dateFormat ?? 'DD MMM YYYY',
    startOfWeek: settings?.startOfWeek ?? 1,
    cycleStartDay: settings?.cycleStartDay ?? 1,
    showOriginalCurrency: settings?.showOriginalCurrency ?? true,
    dashboardPeriodMode: settings?.dashboardPeriodMode ?? 'cycle',
    dashboardRange: settings?.dashboardRange ?? null,
    dashboardViewMode: settings?.dashboardViewMode ?? 'donut'
  }
}

/**
 * Apply the theme to the document root. Called by the shell on every change.
 *
 * THE DEFAULT IS DARK, so this toggles `.light` rather than `.dark`. `:root` in
 * tokens.css holds the dark palette and `.light` opts out of it, which keeps a
 * single class doing the work in both directions and means a theme that fails to
 * apply still leaves the user on the intended (dark) surface rather than a
 * half-styled light page.
 *
 * `color-scheme` is set alongside the class so the browser paints scrollbars,
 * form controls and the caret to match — without it a dark app gets white
 * scrollbars, which is the detail that makes an app look unfinished.
 */
export function applyTheme(theme: AppSettings['theme']): void {
  const root = document.documentElement
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const useDark = theme === 'dark' || (theme === 'system' && prefersDark)
  root.classList.toggle('light', !useDark)
  root.style.colorScheme = useDark ? 'dark' : 'light'
}