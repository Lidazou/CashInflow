import type { JSX } from 'react'

import { useAppStore } from '@renderer/store/app'
import { Icon } from '@renderer/components/Icon'
import { T } from '@shared/lib/i18n'

/**
 * 模拟数据标记 (v1.7.0)
 *
 * THE RULE: a figure the user did not enter must never look like one they did.
 *
 * The sample ledger is a real, fully-featured ledger — that is the point of it — which
 * makes it exactly the kind of thing a person can mistake for their own money. So the
 * mode is announced in two places at once, and both are deliberately hard to miss:
 *
 *   - `SampleBadge`, pinned to the top-right corner of every chart card, because a chart
 *     is where a figure gets believed at a glance;
 *   - `SampleBanner`, across the top of the app, because a badge on one card does not
 *     cover the accounts page, the settings page, or a printout of the window.
 *
 * Neither is dismissible. A dismissal would be remembered by the person who set the mode
 * and forgotten by the person who inherits the screen.
 */
export function SampleBadge({ className }: { className?: string }): JSX.Element | null {
  const mode = useAppStore((state) => state.ledger?.mode ?? 'real')
  if (mode !== 'sample') return null
  return (
    <span className={`sample-badge ${className ?? ''}`} title={T.sampleBadgeHint} data-sample-badge="true">
      <Icon name="info" size={12} />
      {T.sampleBadge}
    </span>
  )
}

/**
 * The banner across the top of the shell.
 *
 * Carries the way OUT as well as the warning: the mode is one the user chose, so the
 * useful thing to put next to "this is not your money" is the button that takes them back
 * to it.
 */
export function SampleBanner(): JSX.Element | null {
  const mode = useAppStore((state) => state.ledger?.mode ?? 'real')
  const switchLedger = useAppStore((state) => state.switchLedger)
  const pushToast = useAppStore((state) => state.pushToast)
  if (mode !== 'sample') return null

  return (
    <div className="sample-banner" role="status" data-sample-banner="true">
      <Icon name="info" size={16} />
      <span className="sample-banner__text">
        <b>{T.sampleBannerTitle}</b>
        <span className="muted">{T.sampleBannerBody}</span>
      </span>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        onClick={() => {
          void switchLedger('real').then(() => pushToast({ tone: 'success', message: T.sampleBackDone }))
        }}
      >
        {T.sampleBackToReal}
      </button>
    </div>
  )
}

export const SAMPLE_STYLES = `
.sample-badge {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 1px 8px; border-radius: var(--radius-full);
  font-size: var(--text-2xs); font-weight: var(--weight-medium);
  color: var(--warning); background-color: var(--warning-subtle);
  border: 1px solid var(--warning);
  white-space: nowrap;
}
.sample-banner {
  display: flex; align-items: center; gap: var(--space-3);
  padding: var(--space-2) var(--space-4);
  background-color: var(--warning-subtle);
  border-bottom: 1px solid var(--warning);
  color: var(--warning);
  font-size: var(--text-sm);
}
.sample-banner__text { flex: 1 1 auto; display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.sample-banner__text b { font-weight: var(--weight-semibold); }
.sample-banner .muted { color: var(--text-secondary); font-size: var(--text-2xs); }
/* The charts put the badge in their own top-right corner. */
.chart-corner { position: absolute; top: 6px; right: 10px; z-index: 4; display: flex; gap: 6px; }
`
