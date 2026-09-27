import type { CategoryType } from '@shared/types'
import { CATEGORY_COLOR_TOKENS } from '@shared/lib/category-colors'

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
 *
 * The colour comes from `CATEGORY_COLOR_TOKENS` rather than being written out here
 * (v1.6.0). The same table is what the donut, the activity stack and the transaction
 * list read, so a new database is born with the hue-separated set and a hand-picked
 * colour on one screen can never disagree with another screen's idea of the palette.
 */
export const SEED_CATEGORIES: readonly SeedCategory[] = [
  // --- Expense -----------------------------------------------------------
  { name: 'Food', type: 'expense', icon: 'utensils', color: CATEGORY_COLOR_TOKENS.Food },
  { name: 'Transport', type: 'expense', icon: 'car', color: CATEGORY_COLOR_TOKENS.Transport },
  { name: 'Shopping', type: 'expense', icon: 'shopping-bag', color: CATEGORY_COLOR_TOKENS.Shopping },
  { name: 'Housing', type: 'expense', icon: 'home', color: CATEGORY_COLOR_TOKENS.Housing },
  { name: 'Entertainment', type: 'expense', icon: 'gamepad', color: CATEGORY_COLOR_TOKENS.Entertainment },
  { name: 'Education', type: 'expense', icon: 'book', color: CATEGORY_COLOR_TOKENS.Education },
  { name: 'Health', type: 'expense', icon: 'heart-pulse', color: CATEGORY_COLOR_TOKENS.Health },
  { name: 'Travel', type: 'expense', icon: 'plane', color: CATEGORY_COLOR_TOKENS.Travel },
  { name: 'Bills', type: 'expense', icon: 'receipt', color: CATEGORY_COLOR_TOKENS.Bills },
  { name: 'Subscription', type: 'expense', icon: 'repeat', color: CATEGORY_COLOR_TOKENS.Subscription },
  { name: 'Other', type: 'expense', icon: 'ellipsis', color: CATEGORY_COLOR_TOKENS.Other },

  // --- Income ------------------------------------------------------------
  { name: 'Salary', type: 'income', icon: 'briefcase', color: CATEGORY_COLOR_TOKENS.Salary },
  { name: 'Freelance', type: 'income', icon: 'laptop', color: CATEGORY_COLOR_TOKENS.Freelance },
  { name: 'Investment', type: 'income', icon: 'trending-up', color: CATEGORY_COLOR_TOKENS.Investment },
  { name: 'Gift', type: 'income', icon: 'gift', color: CATEGORY_COLOR_TOKENS.Gift },
  { name: 'Refund', type: 'income', icon: 'undo', color: CATEGORY_COLOR_TOKENS.Refund },
  { name: 'Other', type: 'income', icon: 'ellipsis', color: CATEGORY_COLOR_TOKENS.Other }
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
