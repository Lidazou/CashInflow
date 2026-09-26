import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@renderer/store/app'

/**
 * Data-fetching hooks.
 *
 * Deliberately hand-rolled rather than pulling in a query library. The
 * requirement that matters (spec §46) is that every displayed figure comes from
 * SQLite and updates after any mutation, and that is achieved here by depending
 * on a single `dataVersion` counter that the main process increments on every
 * write.
 *
 * Error handling is explicit: a failed load produces a message the UI renders,
 * never a silent empty list. An empty list and a failed query look identical to
 * a user, and in a finance app the difference is everything.
 */

export interface AsyncState<T> {
  data: T | null
  loading: boolean
  error: string | null
  /** Re-run the query on demand. */
  reload: () => void
}

/**
 * Run an async loader and track its state.
 *
 * `deps` controls re-fetching exactly like `useEffect`. The hook always depends
 * on `dataVersion`, so a mutation anywhere refreshes this query.
 *
 * A `cancelled` guard prevents a slow earlier request from overwriting the
 * result of a faster later one, which would show stale figures after a rapid
 * month change.
 */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const dataVersion = useAppStore((state) => state.dataVersion)
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  // Keep the latest loader without making it a dependency, so callers can pass
  // an inline arrow function without causing an infinite fetch loop.
  const loaderRef = useRef(loader)
  loaderRef.current = loader

  useEffect(() => {
    let cancelled = false
    setLoading(true)

    loaderRef
      .current()
      .then((result) => {
        if (cancelled) return
        setData(result)
        setError(null)
      })
      .catch((caught: unknown) => {
        if (cancelled) return
        const message = caught instanceof Error ? caught.message : 'The data could not be loaded.'
        setError(message)
        // Keep any previously loaded data visible: replacing a working table
        // with an error is worse than showing slightly stale figures plus a note.
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, dataVersion, nonce])

  const reload = useCallback(() => setNonce((value) => value + 1), [])

  return { data, loading, error, reload }
}

/**
 * Run a mutation, surfacing failures as a toast instead of an unhandled
 * rejection.
 *
 * Returns `null` when the action failed, so the caller can branch without
 * wrapping every call in try/catch. The database is authoritative: nothing is
 * updated locally on failure, which is why the spec's Test "no changes were
 * made" holds.
 */
export function useAction(): {
  run: <T>(action: () => Promise<T>, options?: { successMessage?: string }) => Promise<T | null>
  pending: boolean
} {
  const [pending, setPending] = useState(false)
  const pushToast = useAppStore((state) => state.pushToast)

  const run = useCallback(
    async <T,>(action: () => Promise<T>, options?: { successMessage?: string }): Promise<T | null> => {
      setPending(true)
      try {
        const result = await action()
        if (options?.successMessage) {
          pushToast({ tone: 'success', message: options.successMessage })
        }
        return result
      } catch (error) {
        const message = error instanceof Error ? error.message : 'The change could not be saved.'
        pushToast({
          tone: 'error',
          message,
          detail: 'No changes were made.'
        })
        return null
      } finally {
        setPending(false)
      }
    },
    [pushToast]
  )

  return { run, pending }
}
