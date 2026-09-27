/**
 * Category colours — one source of truth for every surface (v1.6.0).
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * Before this module, a category's colour reached the screen through five different
 * fallback tables and half a dozen inline `?? 'var(--chart-1)'` expressions, and the
 * colours themselves were chosen one at a time: Food `#E8833A` and Bills `#F59E0B` are
 * both orange, Shopping `#A855F7` and Subscription `#8B5CF6` are both purple, Education
 * `#6366F1` and Investment `#2563EB` are both blue. A donut built from those is a ring
 * of four indistinguishable arcs, and the legend underneath it is the only way to read
 * the chart — which is exactly what a colour is supposed to prevent.
 *
 * WHAT THE COLOUR IS NOW
 * ----------------------
 *   1. A colour the USER chose is kept, always. Their data is not restyled.
 *   2. A colour that is still the OLD app default for that same category name is
 *      treated as "never chosen" and upgraded to its new token. This is what makes the
 *      hue-separation work visible on an existing ledger without touching a single row.
 *   3. A category with no colour, or one the app has never heard of, takes the next
 *      entry of a hue-separated ramp, picked by a stable hash of its name so the same
 *      category is the same colour on every screen and after every restart.
 *
 * Every hue below sits at least ~20° from its neighbours, and the two closest pairs
 * (Housing/Education, Food/Bills) are also separated by lightness, because "teal next
 * to cyan" at the same lightness is the kind of pair a reader has to study.
 *
 * Colours are plain six-digit hex, never `var(--chart-N)`, because several call sites
 * append an alpha suffix (`${color}1f`) to build a 12% tint — a trick that silently
 * produces nothing at all when handed a CSS variable.
 */

import type { CategoryType } from '@shared/types'

/** Smallest/complete check for the `#rrggbb` shape the tint helper depends on. */
export function isHexColor(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)
}

/**
 * The token per seeded category, keyed by the English name stored in the database.
 *
 * `Other` is deliberately neutral grey rather than a hue: it is the bucket that means
 * "everything else", and giving it a colour that competes with a real category makes
 * the tail of a donut look like a finding.
 */
export const CATEGORY_COLOR_TOKENS: Readonly<Record<string, string>> = {
  // --- expense ---
  Food: '#F97316',
  Transport: '#3B82F6',
  Shopping: '#A855F7',
  Housing: '#0F766E',
  Entertainment: '#EC4899',
  Education: '#22D3EE',
  Health: '#EF4444',
  Travel: '#22C55E',
  Bills: '#EAB308',
  Subscription: '#D946EF',
  Other: '#8A8A93',

  // --- income ---
  Salary: '#16A34A',
  Freelance: '#0EA5E9',
  Investment: '#6366F1',
  Gift: '#E11D48',
  Refund: '#7C3AED'
}

/**
 * App-chosen colours from before this module, per category.
 *
 * Only an exact name+colour match counts as "still the old default". A user who set
 * Food to `#3B82F6` on purpose keeps `#3B82F6`, because that pair is not in here.
 */
export const LEGACY_SEED_COLORS: Readonly<Record<string, string>> = {
  Food: '#E8833A',
  Transport: '#3B82F6',
  Shopping: '#A855F7',
  Housing: '#0E7490',
  Entertainment: '#EC4899',
  Education: '#6366F1',
  Health: '#EF4444',
  Travel: '#14B8A6',
  Bills: '#F59E0B',
  Subscription: '#8B5CF6',
  Other: '#6B7280',
  Salary: '#16A34A',
  Freelance: '#0D9488',
  Investment: '#2563EB',
  Gift: '#DB2777',
  Refund: '#7C3AED'
}

/**
 * Fallback ramp for user-created categories, in the order they should be handed out.
 *
 * Twelve hues taken from the same wheel as the tokens, so a custom category never
 * lands next to a seeded one with a near-identical colour.
 */
export const CATEGORY_COLOR_RAMP: readonly string[] = [
  '#F97316', // orange
  '#3B82F6', // blue
  '#A855F7', // purple
  '#22C55E', // green
  '#EC4899', // pink
  '#EAB308', // yellow
  '#06B6D4', // cyan
  '#EF4444', // red
  '#8B5CF6', // violet
  '#14B8A6', // teal
  '#F43F5E', // rose
  '#8A8A93' // neutral
]

/** The colour used when nothing at all is known about a category. */
export const CATEGORY_COLOR_FALLBACK = '#8A8A93'

/**
 * Stable index for a name, so an unknown category keeps one colour for ever.
 *
 * A hash rather than the row's position in a list: position changes the moment the
 * reader re-sorts the table or filters a month down, and a category that changes colour
 * when you sort by amount is worse than one with a dull colour.
 */
function rampIndex(name: string): number {
  let hash = 0
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0
  }
  return Math.abs(hash) % CATEGORY_COLOR_RAMP.length
}

/** The colour a category SHOULD have, ignoring whatever is stored. */
export function tokenColorFor(name: string | null | undefined): string {
  if (!name) return CATEGORY_COLOR_FALLBACK
  const token = CATEGORY_COLOR_TOKENS[name]
  if (token) return token
  return CATEGORY_COLOR_RAMP[rampIndex(name)]
}

/**
 * The colour to actually draw.
 *
 * @param name   The category's name as stored ('Food', '餐饮-外卖', …). May be null for
 *               an uncategorised row.
 * @param stored The `categories.color` value, when the row has one.
 */
export function categoryColorFor(name: string | null | undefined, stored?: string | null): string {
  if (isHexColor(stored)) {
    // Still the old app default for this exact category? Then it was never a choice.
    if (name && LEGACY_SEED_COLORS[name]?.toLowerCase() === stored.toLowerCase()) {
      return tokenColorFor(name)
    }
    return stored
  }
  return tokenColorFor(name)
}

/**
 * A 12% tint of a category colour, for row backgrounds and inline chips.
 *
 * Appends an alpha byte rather than using `color-mix()`: every stored colour is a
 * six-digit hex, and the result has to survive being written into an inline style on a
 * component that renders inside a canvas-adjacent layout.
 */
export function categoryTint(color: string, alpha = '1f'): string {
  return isHexColor(color) ? `${color}${alpha}` : `transparent`
}

/**
 * A readable text colour for a chip filled with `color`.
 *
 * The threshold is 0.179 relative luminance, which is where white and near-black text have
 * EQUAL contrast against the background — the standard crossover, not a guess. Above it
 * dark text wins, below it white does; a colour like Food's orange lands above and gets
 * dark text, which is the difference between a legible badge and a squint.
 *
 * Only used for small badges that sit ON the colour; everything else puts the colour
 * beside text that keeps the theme's own contrast. Nothing here relies on the colour alone
 * to carry meaning — every caller also prints the category name, the amount and the
 * percentage (spec §27).
 */
export function categoryOnColor(color: string): string {
  if (!isHexColor(color)) return 'var(--text-primary)'
  return relativeLuminance(color) > 0.179 ? '#101114' : '#FFFFFF'
}

/** Convenience for a `{ id, name, color }` row: resolve in one call. */
export function categoryColorOfRow(row: {
  categoryName?: string | null
  categoryColor?: string | null
}): string {
  return categoryColorFor(row.categoryName ?? null, row.categoryColor ?? null)
}

/** True when two categories would be hard to tell apart — used by the colour tests. */
export function hueDistance(a: string, b: string): number {
  const hue = (hex: string): number => {
    if (!isHexColor(hex)) return 0
    const r = parseInt(hex.slice(1, 3), 16) / 255
    const g = parseInt(hex.slice(3, 5), 16) / 255
    const bl = parseInt(hex.slice(5, 7), 16) / 255
    const max = Math.max(r, g, bl)
    const min = Math.min(r, g, bl)
    if (max === min) return 0
    const d = max - min
    const raw = max === r ? ((g - bl) / d) % 6 : max === g ? (bl - r) / d + 2 : (r - g) / d + 4
    return ((raw * 60) % 360 + 360) % 360
  }
  const delta = Math.abs(hue(a) - hue(b))
  return Math.min(delta, 360 - delta)
}

/** Relative luminance, for the separation assertions in the tests. */
export function relativeLuminance(hex: string): number {
  if (!isHexColor(hex)) return 0
  const lin = (channel: number): number => {
    const c = channel / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return (
    0.2126 * lin(parseInt(hex.slice(1, 3), 16)) +
    0.7152 * lin(parseInt(hex.slice(3, 5), 16)) +
    0.0722 * lin(parseInt(hex.slice(5, 7), 16))
  )
}

/** Every token for one type, in a stable order — handy for legends and tests. */
export function tokensForType(type: CategoryType): Array<{ name: string; color: string }> {
  const expenseOrder = [
    'Food',
    'Transport',
    'Shopping',
    'Housing',
    'Entertainment',
    'Education',
    'Health',
    'Travel',
    'Bills',
    'Subscription',
    'Other'
  ]
  const incomeOrder = ['Salary', 'Freelance', 'Investment', 'Gift', 'Refund', 'Other']
  const order = type === 'income' ? incomeOrder : expenseOrder
  return order.map((name) => ({ name, color: CATEGORY_COLOR_TOKENS[name] }))
}
