import type { CategoryType } from '@shared/types'

export interface SeedCategory {
  name: string
  type: CategoryType
  /** Icon key resolved by the renderer's icon set. */
  icon: string
  color: string
}

/**
 * Preset categories shipped with every new database (spec §4).
 *
 * These are marked `is_system = 1` so the UI can explain why they behave
 * differently from user-created ones, but they remain fully editable — a user
 * who calls "Food" something else should not have to fight the app.
 */
export const SEED_CATEGORIES: readonly SeedCategory[] = [
  // --- Expense -----------------------------------------------------------
  { name: 'Food', type: 'expense', icon: 'utensils', color: '#E8833A' },
  { name: 'Transport', type: 'expense', icon: 'car', color: '#3B82F6' },
  { name: 'Shopping', type: 'expense', icon: 'shopping-bag', color: '#A855F7' },
  { name: 'Housing', type: 'expense', icon: 'home', color: '#0E7490' },
  { name: 'Entertainment', type: 'expense', icon: 'gamepad', color: '#EC4899' },
  { name: 'Education', type: 'expense', icon: 'book', color: '#6366F1' },
  { name: 'Health', type: 'expense', icon: 'heart-pulse', color: '#EF4444' },
  { name: 'Travel', type: 'expense', icon: 'plane', color: '#14B8A6' },
  { name: 'Bills', type: 'expense', icon: 'receipt', color: '#F59E0B' },
  { name: 'Subscription', type: 'expense', icon: 'repeat', color: '#8B5CF6' },
  { name: 'Other', type: 'expense', icon: 'ellipsis', color: '#6B7280' },

  // --- Income ------------------------------------------------------------
  { name: 'Salary', type: 'income', icon: 'briefcase', color: '#16A34A' },
  { name: 'Freelance', type: 'income', icon: 'laptop', color: '#0D9488' },
  { name: 'Investment', type: 'income', icon: 'trending-up', color: '#2563EB' },
  { name: 'Gift', type: 'income', icon: 'gift', color: '#DB2777' },
  { name: 'Refund', type: 'income', icon: 'undo', color: '#7C3AED' },
  { name: 'Other', type: 'income', icon: 'ellipsis', color: '#6B7280' }
] as const

/** Fallback category used when an import row has no resolvable category. */
export const FALLBACK_EXPENSE_CATEGORY = 'Other'
export const FALLBACK_INCOME_CATEGORY = 'Other'

export const DEFAULT_ACCOUNT_COLORS = [
  '#2563EB',
  '#16A34A',
  '#E8833A',
  '#A855F7',
  '#0E7490',
  '#EC4899',
  '#F59E0B',
  '#6B7280'
] as const
