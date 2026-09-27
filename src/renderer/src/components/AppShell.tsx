import { useEffect, useState } from 'react'
import type { FormEvent, JSX, ReactNode } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'

import { Icon } from '@renderer/components/Icon'
import { SampleBanner, SAMPLE_STYLES } from '@renderer/components/SampleData'
import type { IconName } from '@renderer/components/Icon'
import { useAction, useAsync } from '@renderer/hooks/useData'
import { useAppStore } from '@renderer/store/app'
import { useUiStore } from '@renderer/store/ui'
import type { ThemeMode } from '@shared/types'

/**
 * The application shell: sidebar, header, content region and bottom action bar.
 *
 * LAYOUT (spec §27)
 * -----------------
 * The window owns no scrolling; the content region does. `body` is
 * `overflow: hidden` in global.css, <o any accidental horizontal overflow here
 * would be invisible rather than merely ugly — every region is therefore
 * `min-width: 0` so flex children may shrink instead of pushing the layout wide.
 *
 * The window may be resized down to 1024x700. Below 1180px the sidebar collapses
 * to an icon rail <o the content keeps its width. The collapse is expressed in a
 * media query (so it applies before the first paint of a resize) and mirrored in
 * component state (so the nav links can carry a `title` once their visible label
 * is hidden).
 */

/** Sidebar collapses to an icon rail below this window width. */
const SIDEBAR_COLLAPSE_WIDTH = 1180

interface NavItem {
  to: string
  label: string
  icon: IconName
  /** Match this route exactly — without it, `/` would be active everywhere. */
  end?: boolean
}

const NAV_ITEMS: readonly NavItem[] = [
  { to: '/', label: '总览', icon: 'dashboard', end: true },
  { to: '/transactions', label: '交易明细', icon: 'transactions' },
  { to: '/accounts', label: '账户', icon: 'accounts' },
  { to: '/statistics', label: '统计分析', icon: 'statistics' },
  // The arbitrary-period view lives next to Statistics because it answers the
  // same kind of question over a period the user defines themselves.
  { to: '/custom-period', label: '自定义区间', icon: 'calendar' },
  { to: '/budget', label: '预算', icon: 'budget' },
  { to: '/subscriptions', label: '订阅与周期', icon: 'subscriptions' },
  { to: '/search', label: '搜索', icon: 'search' },
  { to: '/settings', label: '设置', icon: 'settings' }
]

const PAGE_TITLES: ReadonlyArray<{ path: string; title: string }> = [
  { path: '/', title: '总览' },
  { path: '/transactions', title: '交易明细' },
  { path: '/accounts', title: '账户' },
  { path: '/statistics', title: '统计分析' },
  { path: '/custom-period', title: '自定义区间统计' },
  { path: '/budget', title: '预算' },
  { path: '/subscriptions', title: '订阅与周期' },
  { path: '/search', title: '搜索' },
  { path: '/import', title: '导入账单' },
  { path: '/biggest-expenses', title: '支出排行' },
  { path: '/settings', title: '设置' }
]

/** Theme cycles dark -> light -> system. Dark first because it is the default. */
const THEME_CYCLE: readonly ThemeMode[] = ['dark', 'light', 'system']
const THEME_ICON: Record<ThemeMode, IconName> = { light: 'sun', dark: 'moon', system: 'palette' }
const THEME_LABEL: Record<ThemeMode, string> = { light: '浅色', dark: '深色', system: '跟随系统' }

/** Title for the current route, including nested routes such as `/accounts/3`. */
function pageTitleFor(pathname: string): string {
  const exact = PAGE_TITLES.find((entry) => entry.path === pathname)
  if (exact) return exact.title
  const nested = PAGE_TITLES.find((entry) => entry.path !== '/' && pathname.startsWith(`${entry.path}/`))
  return nested ? nested.title : 'CashInflow'
}

const SHELL_STYLES = `
.sw-shell { display: flex; height: 100%; min-height: 0; background-color: var(--bg-app); }

/* ---- sidebar ---- */
.sw-shell__sidebar {
  flex: 0 0 var(--sidebar-width); width: var(--sidebar-width);
  display: flex; flex-direction: column; gap: var(--space-4);
  height: 100%; min-height: 0; overflow: hidden;
  padding: var(--space-4) var(--space-3);
  background-color: var(--bg-surface);
  border-right: 1px solid var(--border-subtle);
}
.sw-shell__brand { display: flex; align-items: center; gap: var(--space-2); padding: 0 var(--space-2); min-width: 0; }
.sw-shell__brand-mark {
  display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; flex: 0 0 26px;
  border-radius: var(--radius-md);
  background-color: var(--accent); color: var(--text-on-accent);
  font-size: var(--text-xs); font-weight: var(--weight-bold); letter-spacing: 0.02em;
}
.sw-shell__brand-text {
  font-size: var(--text-lg); font-weight: var(--weight-semibold);
  letter-spacing: -0.01em; white-space: nowrap;
}
.sw-shell__nav { display: flex; flex-direction: column; gap: 2px; min-height: 0; overflow-y: auto; overflow-x: hidden; }
.sw-shell__nav-link {
  position: relative;
  display: flex; align-items: center; gap: var(--space-3);
  height: 36px; padding: 0 var(--space-3);
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  font-size: var(--text-sm); font-weight: var(--weight-medium);
  white-space: nowrap; transition: var(--transition-base);
}
.sw-shell__nav-link:hover { background-color: var(--bg-hover); color: var(--text-primary); text-decoration: none; }
.sw-shell__nav-link[aria-current='page'] { background-color: var(--accent-subtle); color: var(--accent-text); }
.sw-shell__nav-icon { flex: 0 0 auto; }
.sw-shell__nav-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.sw-shell__nav-dot {
  width: 7px; height: 7px; flex: 0 0 7px; margin-left: auto;
  border-radius: var(--radius-full); background-color: var(--warning);
}

/* ---- main column ---- */
.sw-shell__main { flex: 1 1 auto; min-width: 0; min-height: 0; height: 100%; display: flex; flex-direction: column; }

.sw-shell__header {
  flex: 0 0 var(--header-height); height: var(--header-height);
  display: flex; align-items: center; gap: var(--space-4);
  min-width: 0; padding: 0 var(--space-5);
  background-color: var(--bg-surface);
  border-bottom: 1px solid var(--border-subtle);
}
.sw-shell__title {
  font-size: var(--text-lg); font-weight: var(--weight-semibold);
  letter-spacing: -0.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.sw-shell__search {
  display: flex; align-items: center; gap: var(--space-2);
  flex: 1 1 auto; min-width: 120px; max-width: 360px; margin-left: auto;
  height: 34px; padding: 0 var(--space-3);
  color: var(--text-secondary);
  background-color: var(--bg-inset);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  transition: var(--transition-base);
}
.sw-shell__search:hover { border-color: var(--border-default); }
.sw-shell__search:focus-within {
  background-color: var(--bg-surface);
  border-color: var(--accent);
  box-shadow: 0 0 0 var(--ring-width) var(--ring);
}
.sw-shell__search-input { flex: 1 1 auto; min-width: 0; height: 100%; font-size: var(--text-sm); color: var(--text-primary); }
.sw-shell__search-input::placeholder { color: var(--text-tertiary); }
.sw-shell__search-input:focus-visible { outline: none; }

.sw-shell__content { flex: 1 1 auto; min-width: 0; min-height: 0; overflow: auto; padding: var(--space-5); }
/* The animated page wrapper. A full min-height keeps a short page from collapsing
   the scroll container while the entrance animation is running. */
.sw-shell__page { display: flex; flex-direction: column; gap: var(--space-4); min-height: 100%; }

/* ---- bottom action bar ---- */
.sw-shell__bottombar {
  flex: 0 0 var(--bottom-bar-height); height: var(--bottom-bar-height);
  display: flex; align-items: center; justify-content: center; gap: var(--space-4);
  min-width: 0; padding: 0 var(--space-4);
  background-color: var(--bg-surface);
  border-top: 1px solid var(--border-subtle);
}
.sw-shell__add {
  width: 44px; height: 44px; flex: 0 0 44px; padding: 0;
  border-radius: var(--radius-full);
  background-color: var(--accent); border-color: var(--accent); color: var(--text-on-accent);
  box-shadow: var(--shadow-sm);
}
.sw-shell__add:hover:not(:disabled) { background-color: var(--accent-hover); border-color: var(--accent-hover); }
.sw-shell__add:active:not(:disabled) { background-color: var(--accent-active); border-color: var(--accent-active); }

/* ---- responsive: icon-only rail (spec §27) ---- */
@media (max-width: 1179px) {
  .sw-shell__sidebar { flex-basis: 64px; width: 64px; padding-left: var(--space-2); padding-right: var(--space-2); }
  .sw-shell__brand { justify-content: center; padding: 0; }
  .sw-shell__brand-text { display: none; }
  .sw-shell__nav-link { justify-content: center; padding: 0; gap: 0; }
  /* The label stays in the DOM so the link keeps an accessible name; it is
     removed from the visual layout only. */
  .sw-shell__nav-label {
    position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
    overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0;
  }
  .sw-shell__nav-dot { position: absolute; top: 5px; right: 7px; margin-left: 0; }
  .sw-shell__header { padding: 0 var(--space-4); gap: var(--space-3); }
  .sw-shell__content { padding: var(--space-4); }
  .sw-shell__bottombar { gap: var(--space-3); }
}
`

export function AppShell({ children }: { children: ReactNode }): JSX.Element {
  const location = useLocation()
  const navigate = useNavigate()

  const theme = useAppStore((state) => state.settings?.theme ?? 'dark')
  const updateSettings = useAppStore((state) => state.updateSettings)
  const openCreateTransaction = useUiStore((state) => state.openCreateTransaction)
  const { run } = useAction()

  const [query, setQuery] = useState('')
  const [compact, setCompact] = useState(() => window.innerWidth < SIDEBAR_COLLAPSE_WIDTH)

  // The media query drives the layout; this state exists <o the hidden labels can
  // be exposed through `title` at exactly the same breakpoint.
  useEffect(() => {
    const measure = (): void => setCompact(window.innerWidth < SIDEBAR_COLLAPSE_WIDTH)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(document.documentElement)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [])

  // Reminders only: the rule never writes to the ledger by itself (spec §13), <o
  // this is an indicator rather than a notification the user must act on.
  const recurring = useAsync(() => window.api.recurringDue(), [])
  const dueCount = recurring.data?.length ?? 0
  const dueTitle =
    dueCount === 1 ? '1 recurring transaction is due.' : `${dueCount} recurring transactions are due.`

  const onSearchSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const term = query.trim()
    navigate(term === '' ? '/search' : `/search?q=${encodeURIComponent(term)}`)
  }

  const nextTheme = THEME_CYCLE[(THEME_CYCLE.indexOf(theme) + 1) % THEME_CYCLE.length]

  const onThemeToggle = (): void => {
    // Routed through useAction so a failed settings write is reported instead of
    // leaving the button looking as if it worked.
    void run(() => updateSettings({ theme: nextTheme }))
  }

  const title = pageTitleFor(location.pathname)

  return (
    <div className={compact ? 'sw-shell sw-shell--compact' : 'sw-shell'}>
      <style>{SHELL_STYLES}</style>
      <style>{SAMPLE_STYLES}</style>

      <aside className="sw-shell__sidebar">
        <div className="sw-shell__brand">
          <span className="sw-shell__brand-mark" aria-hidden="true">
            S
          </span>
          <span className="sw-shell__brand-text">CashInflow</span>
        </div>

        <nav className="sw-shell__nav" aria-label="主导航">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className="sw-shell__nav-link"
              title={compact ? item.label : undefined}
            >
              <Icon name={item.icon} size={18} className="sw-shell__nav-icon" />
              <span className="sw-shell__nav-label">{item.label}</span>
              {item.to === '/subscriptions' && dueCount > 0 ? (
                <>
                  <span className="sw-shell__nav-dot" title={dueTitle} aria-hidden="true" />
                  <span className="visually-hidden">{dueTitle}</span>
                </>
              ) : null}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="sw-shell__main">
        <header className="sw-shell__header">
          <h1 className="sw-shell__title">{title}</h1>

          <form className="sw-shell__search" role="search" onSubmit={onSearchSubmit}>
            <Icon name="search" size={16} />
            <label className="visually-hidden" htmlFor="sw-global-search">
              搜索交易
            </label>
            <input
              id="sw-global-search"
              className="sw-shell__search-input"
              type="search"
              autoComplete="off"
              placeholder="搜索交易…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              // Focusing the global field is a request to search, <o it takes the
              // user to the page that can actually show results.
              onFocus={() => {
                if (location.pathname !== '/search') navigate('/search')
              }}
            />
          </form>

          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={onThemeToggle}
            aria-label={`主题：${THEME_LABEL[theme]}。切换到${THEME_LABEL[nextTheme]}。`}
            title={`主题：${THEME_LABEL[theme]}`}
          >
            <Icon name={THEME_ICON[theme]} size={18} />
          </button>
        </header>

        {/*
          The sample-ledger banner (v1.7.0).

          Above the page content and below the header, so it is inside the area the reader
          is looking at rather than floating over it, and so it is present on EVERY page —
          including the ones with no chart to put a badge on.
        */}
        <SampleBanner />

        {/*
          Page transition.

          Keyed by pathname so React remounts the wrapper on a route change and the
          entrance animation replays. Without the key, navigating between two pages
          that both render `<main>` would reuse the same element and the animation
          would only ever run once — on first load, which is the one time it does
          not matter.
        */}
        <main className="sw-shell__content">
          <div key={location.pathname} className="sw-shell__page anim-rise">
            {children}
          </div>
        </main>

        <div className="sw-shell__bottombar">
          <button type="button" className="btn btn-secondary" onClick={() => navigate('/import')}>
            <Icon name="import" size={16} />
            <span>导入</span>
          </button>

          <button
            type="button"
            className="btn sw-shell__add"
            onClick={() => openCreateTransaction()}
            aria-label="记一笔"
            title="记一笔"
          >
            <Icon name="plus" size={22} strokeWidth={2.25} />
          </button>

          <button type="button" className="btn btn-secondary" onClick={() => navigate('/statistics')}>
            <Icon name="statistics" size={16} />
            <span>统计分析</span>
          </button>
        </div>
      </div>
    </div>
  )
}
