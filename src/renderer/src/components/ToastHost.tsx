import type { JSX } from 'react'

import { Icon } from '@renderer/components/Icon'
import type { IconName } from '@renderer/components/Icon'
import { useAppStore } from '@renderer/store/app'
import type { Toast } from '@renderer/store/app'

/**
 * ToastHost — the only place notifications appear.
 *
 * COLOUR carries the tone (left border + icon), never the message: the text
 * always says what happened, so the meaning survives for a colour-blind user and
 * in a greyscale screenshot.
 *
 * ERRORS DO NOT AUTO-DISMISS. The store owns that rule (it only schedules a
 * dismissal for success and info), and this component must not second-guess it: a
 * failure the user never read becomes, later, missing data they cannot explain.
 *
 * The stack is anchored above the bottom action bar so it never covers the
 * primary "+" control.
 */

const TONE_COLOR: Record<Toast['tone'], string> = {
  success: 'var(--income)',
  error: 'var(--expense)',
  info: 'var(--accent)'
}

const TONE_ICON: Record<Toast['tone'], IconName> = {
  success: 'check',
  error: 'alert',
  info: 'info'
}

const TOAST_STYLES = `
.sw-toasts {
  position: fixed;
  right: var(--space-4);
  bottom: calc(var(--bottom-bar-height) + var(--space-4));
  z-index: 60;
  display: flex; flex-direction: column; gap: var(--space-2);
  width: min(360px, calc(100vw - var(--space-8)));
  max-height: calc(100vh - var(--bottom-bar-height) - var(--space-10));
  overflow-y: auto;
  /* The empty area around the stack must not swallow clicks on the app. */
  pointer-events: none;
}
.sw-toast {
  display: flex; align-items: flex-start; gap: var(--space-2);
  padding: var(--space-3);
  background-color: var(--bg-surface-raised);
  border: 1px solid var(--border-subtle);
  border-left: 3px solid var(--accent);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
  pointer-events: auto;
  animation: sw-toast-in var(--duration-base) var(--ease-out) both;
}
@keyframes sw-toast-in {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
.sw-toast__icon { flex: 0 0 auto; margin-top: 1px; }
.sw-toast__body { flex: 1 1 auto; min-width: 0; }
.sw-toast__message {
  font-size: var(--text-sm); font-weight: var(--weight-medium);
  color: var(--text-primary); overflow-wrap: anywhere;
}
.sw-toast__detail { font-size: var(--text-xs); margin-top: 2px; overflow-wrap: anywhere; }
.sw-toast__dismiss { flex: 0 0 auto; margin: -2px -2px 0 0; }

@media (prefers-reduced-motion: reduce) {
  .sw-toast { animation: none; }
}
`

export function ToastHost(): JSX.Element | null {
  const toasts = useAppStore((state) => state.toasts)
  const dismissToast = useAppStore((state) => state.dismissToast)

  if (toasts.length === 0) return null

  return (
    <>
      <style>{TOAST_STYLES}</style>
      {/* No live-region role on the container: each toast carries its own, so a
          message is announced exactly once. */}
      <div className="sw-toasts">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`sw-toast sw-toast--${toast.tone}`}
            // Errors interrupt; success and info wait for a pause in speech.
            role={toast.tone === 'error' ? 'alert' : 'status'}
            style={{ borderLeftColor: TONE_COLOR[toast.tone] }}
          >
            <span className="sw-toast__icon" style={{ color: TONE_COLOR[toast.tone] }} aria-hidden="true">
              <Icon name={TONE_ICON[toast.tone]} size={16} />
            </span>

            <div className="sw-toast__body">
              <p className="sw-toast__message">{toast.message}</p>
              {toast.detail ? <p className="sw-toast__detail muted">{toast.detail}</p> : null}
            </div>

            <button
              type="button"
              className="btn btn-ghost btn-icon btn-sm sw-toast__dismiss"
              onClick={() => dismissToast(toast.id)}
              aria-label={`Dismiss notification: ${toast.message}`}
              title="Dismiss"
            >
              <Icon name="close" size={14} />
            </button>
          </div>
        ))}
      </div>
    </>
  )
}
