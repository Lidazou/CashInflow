import { describe, expect, it } from 'vitest'

import {
  CATEGORY_COLOR_FALLBACK,
  CATEGORY_COLOR_RAMP,
  CATEGORY_COLOR_TOKENS,
  LEGACY_SEED_COLORS,
  categoryColorFor,
  categoryOnColor,
  categoryTint,
  hueDistance,
  isHexColor,
  relativeLuminance,
  tokenColorFor,
  tokensForType
} from '@shared/lib/category-colors'
import { SEED_CATEGORIES } from '@shared/constants/categories'

/**
 * The category colour system.
 *
 * The requirement (spec §25–§27) is that a reader can tell two slices of a donut apart,
 * and the failure it replaces was real: the old defaults made Food and Bills both orange,
 * Shopping and Subscription both purple, and Education and Investment both blue. So the
 * assertions here are about SEPARATION, not about specific hex values — a future palette
 * tweak should be able to pass them without editing the test.
 */

const EXPENSES = tokensForType('expense')

describe('hue separation', () => {
  it('gives every pair of expense categories a hue gap a reader can see', () => {
    const problems: string[] = []
    for (let i = 0; i < EXPENSES.length; i += 1) {
      for (let j = i + 1; j < EXPENSES.length; j += 1) {
        const a = EXPENSES[i]
        const b = EXPENSES[j]
        // `Other` is deliberately neutral grey, which has no hue to compare.
        if (a.name === 'Other' || b.name === 'Other') continue
        const gap = hueDistance(a.color, b.color)
        const luminanceGap = Math.abs(relativeLuminance(a.color) - relativeLuminance(b.color))
        /*
          Hue alone is not enough for two colours that are also equally light — that is the
          "teal next to cyan" case — so a close pair passes only when their LIGHTNESS
          differs enough for the eye to separate them anyway.
        */
        if (gap < 18 && luminanceGap < 0.12) {
          problems.push(`${a.name}/${b.name}: hue ${Math.round(gap)}°, luminance ${luminanceGap.toFixed(3)}`)
        }
      }
    }
    expect(problems).toEqual([])
  })

  it('does not give the income set two colours that look alike either', () => {
    const incomes = tokensForType('income').filter((entry) => entry.name !== 'Other')
    const problems: string[] = []
    for (let i = 0; i < incomes.length; i += 1) {
      for (let j = i + 1; j < incomes.length; j += 1) {
        const gap = hueDistance(incomes[i].color, incomes[j].color)
        const luminanceGap = Math.abs(
          relativeLuminance(incomes[i].color) - relativeLuminance(incomes[j].color)
        )
        if (gap < 18 && luminanceGap < 0.12) {
          problems.push(`${incomes[i].name}/${incomes[j].name}: ${Math.round(gap)}°`)
        }
      }
    }
    expect(problems).toEqual([])
  })

  it('keeps the specific pairs that used to be indistinguishable apart', () => {
    const byName = (name: string): string => CATEGORY_COLOR_TOKENS[name]
    // These four pairs were the complaint: "they all look like one colour family".
    for (const [a, b] of [
      ['Food', 'Bills'],
      ['Shopping', 'Subscription'],
      ['Education', 'Investment'],
      ['Transport', 'Investment']
    ]) {
      expect(hueDistance(byName(a), byName(b)), `${a} vs ${b}`).toBeGreaterThan(18)
    }
  })
})

describe('one source of truth', () => {
  it('gives every seeded category its token colour, not a second palette', () => {
    for (const seed of SEED_CATEGORIES) {
      expect(seed.color).toBe(CATEGORY_COLOR_TOKENS[seed.name])
    }
  })

  it('returns the same colour for the same category on every call, in any order', () => {
    const first = categoryColorFor('Food')
    expect(categoryColorFor('Food')).toBe(first)
    expect(categoryColorFor('Food', null)).toBe(first)
    expect(categoryColorFor('Food', '')).toBe(first)
  })

  it('gives an unknown category a stable colour of its own, not the fallback grey', () => {
    const custom = categoryColorFor('奶茶基金')
    expect(custom).toBe(categoryColorFor('奶茶基金'))
    expect(isHexColor(custom)).toBe(true)
    expect(CATEGORY_COLOR_RAMP).toContain(custom)
  })
})

describe('what the user chose wins', () => {
  it('keeps a colour the user picked', () => {
    expect(categoryColorFor('Food', '#123456')).toBe('#123456')
    expect(categoryColorFor('奶茶基金', '#ABCDEF')).toBe('#ABCDEF')
  })

  it('upgrades a colour that is still the OLD app default for that category', () => {
    /* The old seeds, kept so an existing ledger gets the new palette without a migration. */
    expect(categoryColorFor('Food', LEGACY_SEED_COLORS.Food)).toBe(CATEGORY_COLOR_TOKENS.Food)
    expect(categoryColorFor('Shopping', '#A855F7')).toBe(CATEGORY_COLOR_TOKENS.Shopping)
    // 'Other' was #6B7280 and is now a lighter neutral.
    expect(categoryColorFor('Other', '#6B7280')).toBe(CATEGORY_COLOR_TOKENS.Other)
  })

  it('does NOT treat a deliberate user choice as a legacy default', () => {
    // Somebody set Food to the OLD Transport blue on purpose: that is not the old Food
    // colour, so it is a choice and it stays.
    expect(categoryColorFor('Food', '#3B82F6')).toBe('#3B82F6')
    // Same colour, different category: Bills was #F59E0B, and it is still a choice here.
    expect(categoryColorFor('Food', '#F59E0B')).toBe('#F59E0B')
  })

  it('ignores a stored value that is not a colour at all', () => {
    expect(categoryColorFor('Food', 'var(--chart-1)')).toBe(CATEGORY_COLOR_TOKENS.Food)
    expect(categoryColorFor('Food', 'rgb(1,2,3)')).toBe(CATEGORY_COLOR_TOKENS.Food)
    expect(categoryColorFor(null, 'nonsense')).toBe(CATEGORY_COLOR_FALLBACK)
  })
})

describe('tints and contrast', () => {
  it('builds an alpha tint from a hex colour, because several rows do `color + 1f`', () => {
    expect(categoryTint('#F97316')).toBe('#F973161f')
    expect(categoryTint('#F97316', '33')).toBe('#F9731633')
  })

  it('refuses to invent a tint from a CSS variable, which would render nothing', () => {
    // The old code did `${categoryColor ?? '#6B7280'}1f`; if the colour had ever been
    // `var(--chart-1)` the result would have been a silently invalid declaration.
    expect(categoryTint('var(--chart-1)')).toBe('transparent')
  })

  it('picks a legible text colour for a chip filled with the category colour', () => {
    expect(categoryOnColor('#F97316')).toBe('#101114')
    expect(categoryOnColor('#0F766E')).toBe('#FFFFFF')
    expect(categoryOnColor('var(--accent)')).toBe('var(--text-primary)')
  })

  it('never returns a value that is not a hex colour from the resolver', () => {
    for (const entry of [...EXPENSES, ...tokensForType('income')]) {
      expect(isHexColor(entry.color), entry.name).toBe(true)
    }
    expect(isHexColor(tokenColorFor(null))).toBe(true)
  })
})
