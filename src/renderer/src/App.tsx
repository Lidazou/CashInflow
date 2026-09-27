import { useEffect } from 'react'
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import { useAppStore, applyTheme } from './store/app'
import { AppShell } from './components/AppShell'
import { ToastHost } from './components/ToastHost'
import { AddTransactionDialog } from './components/AddTransactionDialog'
import { TransactionDetailDialog } from './components/TransactionDetailDialog'
import DashboardPage from './pages/DashboardPage'
import TransactionsPage from './pages/TransactionsPage'
import AccountsPage from './pages/AccountsPage'
import StatisticsPage from './pages/StatisticsPage'
import CustomPeriodPage from './pages/CustomPeriodPage'
import BudgetPage from './pages/BudgetPage'
import SubscriptionsPage from './pages/SubscriptionsPage'
import SearchPage from './pages/SearchPage'
import ImportPage from './pages/ImportPage'
import BiggestExpensesPage from './pages/BiggestExpensesPage'
import SettingsPage from './pages/SettingsPage'

/**
 * Application root.
 *
 * ROUTING: `HashRouter` is used rather than `BrowserRouter` because the packaged
 * app is loaded from a `file://` URL. With a path-based router, a reload on
 * `/accounts` would ask the filesystem for a file of that name and fail, leaving
 * a blank window. Hash routing keeps every route inside `index.html`.
 */
export default function App(): React.JSX.Element {
  const ready = useAppStore((state) => state.ready)
  const bootError = useAppStore((state) => state.bootError)
  const theme = useAppStore((state) => state.settings?.theme ?? 'dark')
  const bootstrap = useAppStore((state) => state.bootstrap)

  useEffect(() => {
    void bootstrap()
  }, [bootstrap])

  useEffect(() => {
    applyTheme(theme)

    // Follow the OS preference while the theme is set to "system".
    if (theme !== 'system') return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => applyTheme('system')
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [theme])

  if (!ready) {
    return (
      <div className="app-boot" role="status" aria-live="polite">
        <div className="app-boot__mark">CashInflow</div>
        <p className="muted">Opening your local database…</p>
      </div>
    )
  }

  if (bootError) {
    return (
      <div className="app-boot app-boot--error" role="alert">
        <h1 className="app-boot__mark">CashInflow could not start</h1>
        <p className="muted">{bootError}</p>
        <p className="muted">
          Your data has not been modified. Restart the app, and if the problem continues, check that the application
          data folder is writable.
        </p>
      </div>
    )
  }

  return (
    <HashRouter>
      <AppShell>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/transactions" element={<TransactionsPage />} />
          <Route path="/accounts" element={<AccountsPage />} />
          <Route path="/accounts/:accountId" element={<TransactionsPage />} />
          <Route path="/statistics" element={<StatisticsPage />} />
          <Route path="/custom-period" element={<CustomPeriodPage />} />
          <Route path="/budget" element={<BudgetPage />} />
          <Route path="/subscriptions" element={<SubscriptionsPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/import" element={<ImportPage />} />
          <Route path="/biggest-expenses" element={<BiggestExpensesPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          {/* An unknown route must land somewhere real, never on a blank page. */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AppShell>
      <AddTransactionDialog />
      <TransactionDetailDialog />
      <ToastHost />
    </HashRouter>
  )
}
