import { describe, expect, it } from 'vitest'

import { T, fillTemplate } from '@shared/lib/i18n'

/**
 * Message templates.
 *
 * `fillTemplate` exists because `String.prototype.replace` with a string pattern stops at the
 * first match. A sentence that names the target currency twice — "保存时会按 {to} 原样记账 …
 * 请改选 {from} 账户，或改成 {to} 金额" — rendered with a literal "{to}" in the middle of it, and
 * a reader has no way to tell that from a typo. The first test is that exact sentence.
 */
describe('fillTemplate', () => {
  it('fills every occurrence, not just the first', () => {
    expect(fillTemplate('{a} and {a} and {b}', { a: 'X', b: 'Y' })).toBe('X and X and Y')
  })

  it('fills the currency warning end to end', () => {
    const filled = fillTemplate(T.txdBatchFxWarn, { from: 'MYR', fromAmount: 'RM 172.50', to: 'CNY' })

    expect(filled).not.toContain('{')
    expect(filled).not.toContain('}')
    expect(filled).toContain('MYR')
    expect(filled).toContain('RM 172.50')
    // The target currency is mentioned more than once, which is what broke the naive version.
    expect(filled.split('CNY').length - 1).toBeGreaterThan(1)
  })

  it('leaves an unfilled placeholder visible rather than printing "undefined"', () => {
    // A missing value is a programming error; showing the token is how it gets noticed, and
    // silently writing "undefined" into a sentence is how it does not.
    expect(fillTemplate('total {n}', {})).toBe('total {n}')
  })

  it('accepts numbers, so callers do not have to stringify them', () => {
    expect(fillTemplate(T.txdBatchCount, { n: 3 })).toBe('待保存 3 笔')
  })
})

describe('the message catalogue', () => {
  // `T` is a flat object of string literals, so the cast is only undoing the literal widening
  // that makes `Object.entries` return a union of every message as the value type.
  const messages = Object.entries(T).filter(([, value]) => typeof value === 'string') as Array<[string, string]>

  it('is not empty and holds only non-empty strings', () => {
    expect(messages.length).toBeGreaterThan(100)
    for (const [key, value] of messages) {
      expect(value.trim(), key).not.toBe('')
    }
  })

  it('has balanced braces in every placeholder', () => {
    for (const [key, value] of messages) {
      expect((value.match(/\{/g) ?? []).length, key).toBe((value.match(/\}/g) ?? []).length)
    }
  })

  it('names every placeholder in lowerCamelCase, so a typo shows up as a leftover token', () => {
    for (const [key, value] of messages) {
      for (const token of value.match(/\{[^}]*\}/g) ?? []) {
        expect(token, `${key}: ${token}`).toMatch(/^\{[a-z][a-zA-Z0-9]*\}$/)
      }
    }
  })
})
