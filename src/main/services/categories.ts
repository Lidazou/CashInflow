import type { Database as SqliteDatabase } from 'better-sqlite3'
import { InUseError, NotFoundError, ConflictError, ValidationError } from '@main/database/errors'
import { mapCategory, type CategoryRow } from '@main/database/mappers'
import type { Category, CategoryInput, CategoryType, CategoryUsage } from '@shared/types'
import { nowIso } from '@shared/lib/dates'
import { CATEGORY_TYPES } from '@shared/types'
import { requireEnum, requireText, assertNoErrors, type FieldErrors } from './validation'

/**
 * Category CRUD.
 *
 * The awkward part of category management is deletion. Categories are
 * referenced by historical transactions, and a finance app must never rewrite
 * history as a side effect of tidying a list. `transactions.category_id` is
 * therefore ON DELETE RESTRICT, and this service refuses the delete with a count
 * so the UI can offer the two honest options:
 *
 *   1. reassign the transactions to another category, then delete (deleteWithReassign)
 *   2. keep the category
 *
 * It never silently reassigns to "Other" — that would quietly change the user's
 * reports without telling them.
 */
export class CategoriesService {
  constructor(private readonly db: SqliteDatabase) {}

  list(options: { type?: CategoryType; includeUsage?: boolean } = {}): Category[] {
    const params: unknown[] = []
    let where = ''
    if (options.type) {
      where = 'WHERE type = ?'
      params.push(options.type)
    }

    const rows = this.db
      .prepare(`SELECT * FROM categories ${where} ORDER BY type ASC, sort_order ASC, name COLLATE NOCASE ASC`)
      .all(...params) as CategoryRow[]

    return rows.map(mapCategory)
  }

  get(id: number): Category {
    const row = this.db.prepare('SELECT * FROM categories WHERE id = ?').get(id) as CategoryRow | undefined
    if (!row) throw new NotFoundError('Category', id)
    return mapCategory(row)
  }

  assertExists(id: number): Category {
    return this.get(id)
  }

  /** Number of transactions currently referencing each category. */
  usage(): CategoryUsage[] {
    const rows = this.db
      .prepare(
        `SELECT category_id AS categoryId, COUNT(*) AS transactionCount
         FROM transactions
         WHERE category_id IS NOT NULL
         GROUP BY category_id`
      )
      .all() as CategoryUsage[]
    return rows
  }

  create(input: CategoryInput): Category {
    const errors: FieldErrors = {}
    const name = requireText(errors, 'name', input.name, { label: 'Category name', max: 40 })
    const type = requireEnum(errors, 'type', input.type, CATEGORY_TYPES, { label: 'Category type' })
    assertNoErrors(errors, 'The category could not be saved because some details are invalid.')

    const duplicate = this.db.prepare('SELECT id FROM categories WHERE name = ? AND type = ?').get(name, type) as
      | { id: number }
      | undefined
    if (duplicate) {
      throw new ConflictError(`A ${type} category named "${name}" already exists.`, { name: 'Already in use' })
    }

    const nextOrder = (
      this.db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM categories').get() as { n: number }
    ).n

    const info = this.db
      .prepare(
        `INSERT INTO categories (name, type, icon, color, is_system, sort_order, created_at)
         VALUES (@name, @type, @icon, @color, 0, @sortOrder, @createdAt)`
      )
      .run({
        name,
        type,
        icon: typeof input.icon === 'string' && input.icon ? input.icon : 'tag',
        color:
          typeof input.color === 'string' && /^#[0-9a-f]{6}$/i.test(input.color) ? input.color : '#6B7280',
        sortOrder: nextOrder,
        createdAt: nowIso()
      })

    return this.get(Number(info.lastInsertRowid))
  }

  /**
   * Update a category's display fields.
   *
   * `type` is intentionally NOT updatable. Flipping "Food" from expense to
   * income would turn every historical grocery purchase into income and
   * invalidate every report that included it. The user is told to create a new
   * category instead.
   */
  update(id: number, input: Partial<CategoryInput>): Category {
    const existing = this.get(id)

    if (input.type && input.type !== existing.type) {
      throw new ValidationError(
        `A category's type cannot be changed after it has been used, because it would reinterpret past transactions. Create a new ${input.type} category instead.`,
        { type: 'Type cannot be changed.' }
      )
    }

    const errors: FieldErrors = {}
    const name = requireText(errors, 'name', input.name ?? existing.name, { label: 'Category name', max: 40 })
    assertNoErrors(errors, 'The category could not be saved because some details are invalid.')

    const duplicate = this.db
      .prepare('SELECT id FROM categories WHERE name = ? AND type = ? AND id <> ?')
      .get(name, existing.type, id) as { id: number } | undefined
    if (duplicate) {
      throw new ConflictError(`A ${existing.type} category named "${name}" already exists.`, {
        name: 'Already in use'
      })
    }

    this.db
      .prepare('UPDATE categories SET name = @name, icon = @icon, color = @color, sort_order = @sortOrder WHERE id = @id')
      .run({
        id,
        name,
        icon: input.icon ?? existing.icon,
        color: input.color ?? existing.color,
        sortOrder: input.sortOrder ?? existing.sortOrder
      })

    return this.get(id)
  }

  /**
   * Delete a category.
   *
   * Refuses while it is in use. Pass `reassignTo` to move the transactions
   * first — the only path that deletes a used category, and it is always an
   * explicit user decision.
   */
  remove(id: number, options: { reassignTo?: number | null } = {}): { deleted: true; reassigned: number } {
    const existing = this.get(id)

    const count = (
      this.db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE category_id = ?').get(id) as { n: number }
    ).n

    if (count > 0 && options.reassignTo === undefined) {
      throw new InUseError(
        `"${existing.name}" is used by ${count} transaction(s). Choose another category to move them to, or keep this one.`,
        { id: `${count} transaction(s) still use this category.` }
      )
    }

    let reassigned = 0
    const run = this.db.transaction(() => {
      if (count > 0) {
        const target = options.reassignTo ?? null
        if (target !== null) {
          const targetCategory = this.get(target)
          if (targetCategory.type !== existing.type) {
            throw new ValidationError(
              `"${targetCategory.name}" is an ${targetCategory.type} category, so ${existing.type} transactions cannot be moved into it.`,
              { reassignTo: 'Category type must match.' }
            )
          }
        }
        const result = this.db
          .prepare('UPDATE transactions SET category_id = ?, updated_at = ? WHERE category_id = ?')
          .run(target, nowIso(), id)
        reassigned = result.changes
      }

      const deleted = this.db.prepare('DELETE FROM categories WHERE id = ?').run(id)
      if (deleted.changes === 0) throw new NotFoundError('Category', id)
    })

    run()
    return { deleted: true, reassigned }
  }
}
