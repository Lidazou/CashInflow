import type { CashInflowApi } from '@shared/types/ipc-contract'

/**
 * Ambient declaration for the preload bridge.
 *
 * The renderer has no Node types available, so `window.api` must be declared
 * here. It is typed as the full contract, which means a typo in a channel name
 * or a wrong argument type is a compile error rather than a runtime `undefined`.
 */
declare global {
  interface Window {
    api: CashInflowApi
  }
}

export {}
