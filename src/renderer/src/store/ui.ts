import { create } from 'zustand'
import type { TransactionWithRefs } from '@shared/types'

/**
 * UI-only state for dialogs and drawers.
 *
 * Kept separate from the app store so that opening a dialog does not re-render
 * every component that subscribes to settings.
 *
 * The add-transaction dialog lives at the application root rather than inside
 * the dashboard, because it is opened from the bottom action bar, from a
 * keyboard shortcut, and from empty states on other pages. A single instance
 * avoids three copies of the same form drifting apart.
 */

export type TransactionDialogMode =
  | { kind: 'closed' }
  | { kind: 'create'; initialType?: 'income' | 'expense' | 'transfer' }
  | { kind: 'edit'; transaction: TransactionWithRefs }
  | { kind: 'editTransfer'; transaction: TransactionWithRefs }

interface UiState {
  transactionDialog: TransactionDialogMode
  /** Transaction shown in the read-only detail drawer. */
  detailTransaction: TransactionWithRefs | null

  openCreateTransaction: (initialType?: 'income' | 'expense' | 'transfer') => void
  openEditTransaction: (transaction: TransactionWithRefs) => void
  openEditTransfer: (transaction: TransactionWithRefs) => void
  closeTransactionDialog: () => void

  showTransactionDetail: (transaction: TransactionWithRefs) => void
  hideTransactionDetail: () => void
}

export const useUiStore = create<UiState>((set) => ({
  transactionDialog: { kind: 'closed' },
  detailTransaction: null,

  openCreateTransaction: (initialType) =>
    set({ transactionDialog: initialType ? { kind: 'create', initialType } : { kind: 'create' } }),

  openEditTransaction: (transaction) => set({ transactionDialog: { kind: 'edit', transaction } }),

  // A transfer has two legs and must be edited through the transfer form, which
  // keeps both accounts in sync. Editing one leg as an ordinary transaction is
  // rejected by the service.
  openEditTransfer: (transaction) => set({ transactionDialog: { kind: 'editTransfer', transaction } }),

  closeTransactionDialog: () => set({ transactionDialog: { kind: 'closed' } }),

  showTransactionDetail: (transaction) => set({ detailTransaction: transaction }),
  hideTransactionDetail: () => set({ detailTransaction: null })
}))
