import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@renderer/store/app'
import { useRateStore } from '@renderer/store/rates'
import { useAction, useAsync } from '@renderer/hooks/useData'
import { Icon, iconNameOr } from '@renderer/components/Icon'
import { Money } from '@renderer/components/Money'
import { ProgressBar } from '@renderer/components/charts'
import { today } from '@shared/lib/dates'
import { T, categoryLabel, monthKeyLabelZh } from '@shared/lib/i18n'
import { formatMinorToPlain, parseAmountToMinor } from '@shared/lib/money'
import { cycleFor } from '@shared/lib/periods'
import type { BudgetProgress, Category, CycleInfo } from '@shared/types'
import { categoryColorFor } from '@shared/lib/category-colors'

/**
 * Monthly budgets (spec §22).
 *
 * Two shapes of budget live in one table: the single OVERALL budget
 * (`categoryId === null`) and per-category budgets. The overall card is rendered
 * first because it answers the period's headline question — "how much do I have
 * left to spend" — while the per-category rows explain where the money went.
 *
 * THE PERIOD IS A SETTLEMENT CYCLE, NOT A CALENDAR MONTH. A student whose
 * allowance arrives on the 5th is at the end of an almost-empty cycle on the
 * 3rd, so the navigator moves by cycles (`cycleShift`) and the label is the
 * backend's own cycle label ("9月5日 – 10月4日") rather than a month name.
 *
 * OVER-BUDGET TREATMENT: the spec explicitly forbids a glaring red alarm. An
 * over-budget row therefore keeps its normal surface and text colour and adds
 * two restrained signals only: a `--warning` badge reading "超出预算 …" and the
 * ProgressBar's own overflow treatment (`showOverflow`, which caps the fill at
 * 100% and marks the right edge). No row is painted red.
 *
 * MONEY: every figure here is an INTEGER count of minor units. Typed input is
 * converted with `parseAmountToMinor`, never `parseFloat`, so "18.50" becomes
 * exactly 1850. Displayed amounts go through <Money>, which converts once.
 */

interface BudgetFormState {
  /** `null` addresses the overall budget. */
  categoryId: number | null
  amountText: string
  /** The currency the limit is entered and stored in. */
  currency: string
  /** Set when editing an existing row; `null` when creating. */
  budgetId: number | null
}

/**
 * The row's display name.
 *
 * `'Deleted category'` is the backend's own sentinel for a budget whose category
 * no longer exists; it is mapped here so an English string can never reach the
 * interface.
 */
function budgetRowLabel(row: BudgetProgress): string {
  const name = row.categoryName
  if (name === null || name === 'Deleted category') return T.budDeletedCategory
  return categoryLabel(name)
}

export default function BudgetPage(): React.JSX.Element {
  const activeMonth = useAppStore((state) => state.activeMonth)
  const setActiveMonth = useAppStore((state) => state.setActiveMonth)
  const refreshData = useAppStore((state) => state.refreshData)
  const pushToast = useAppStore((state) => state.pushToast)
  const baseCurrency = useAppStore((state) => state.settings?.baseCurrency ?? 'MYR')
  const cycleStartDay = useAppStore((state) => state.settings?.cycleStartDay ?? 1)
  const { run, pending } = useAction()

  // Converted limits and spend need the shared rate table, so every figure on
  // this page is converted with the same rates as the rest of the app.
  const displayCurrency = useRateStore((state) => state.displayCurrency)
  const loadRates = useRateStore((state) => state.load)

  useEffect(() => {
    void loadRates()
  }, [loadRates])

  const { data, loading, error, reload } = useAsync<BudgetProgress[]>(
    () => window.api.budgetsProgress(activeMonth),
    [activeMonth]
  )
  const { data: categories } = useAsync<Category[]>(() => window.api.categoriesList({ type: 'expense' }), [])

  /**
   * The cycle the selected key names. Its label comes from the main process so
   * the period shown is the period the backend actually resolved; the fallback
   * keeps a usable label if that call fails.
   */
  const cycle = useAsync<CycleInfo>(() => window.api.cycleInfo(activeMonth), [activeMonth])
  const cycleLabelText = cycle.data?.label ?? monthKeyLabelZh(activeMonth)

  /** The cycle containing today, which is what "本周期" jumps to. */
  const currentCycleKey = cycleFor(today(), cycleStartDay).key

  const [form, setForm] = useState<BudgetFormState | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const amountRef = useRef<HTMLInputElement>(null)

  const rows = useMemo(() => data ?? [], [data])
  const overall = useMemo(() => rows.find((row) => row.budget.categoryId === null) ?? null, [rows])
  const perCategory = useMemo(
    () =>
      rows
        .filter((row) => row.budget.categoryId !== null)
        .sort((a, b) => (a.categoryName ?? '').localeCompare(b.categoryName ?? '')),
    [rows]
  )

  const totalLimit = useMemo(() => rows.reduce((sum, row) => sum + row.budget.limitAmount, 0), [rows])
  const totalSpent = overall ? overall.spent : 0

  /**
   * Categories that can still take a budget.
   *
   * `budgetsSet` upserts by category, so offering an already-budgeted category
   * would silently overwrite an existing limit. The one exception is the
   * category currently being edited, which must stay selectable.
   */
  const availableCategories = useMemo(() => {
    const editingCategoryId =
      form?.budgetId == null ? null : (rows.find((row) => row.budget.id === form.budgetId)?.budget.categoryId ?? null)
    const used = new Set(
      rows
        .map((row) => row.budget.categoryId)
        .filter((id): id is number => id !== null && id !== editingCategoryId)
    )
    return (categories ?? []).filter((category) => !used.has(category.id))
  }, [categories, rows, form])

  // Focus the amount as soon as the form opens: it is the only field the user
  // normally has to type in.
  useEffect(() => {
    if (!form) return
    const id = window.setTimeout(() => amountRef.current?.focus(), 30)
    return () => window.clearTimeout(id)
  }, [form])

  // Escape closes the form, so the whole flow is keyboard-completable.
  useEffect(() => {
    if (!form) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setForm(null)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [form])

  function openCreate(): void {
    setFieldErrors({})
    setFormError(null)
    setForm({ categoryId: null, amountText: '', currency: baseCurrency, budgetId: null })
  }

  function openOverall(): void {
    setFieldErrors({})
    setFormError(null)
    setForm({
      categoryId: null,
      amountText: overall ? formatMinorToPlain(overall.budget.limitAmount, overall.budget.currency) : '',
      currency: overall ? overall.budget.currency : baseCurrency,
      budgetId: overall ? overall.budget.id : null
    })
  }

  function openEdit(row: BudgetProgress): void {
    setFieldErrors({})
    setFormError(null)
    setForm({
      categoryId: row.budget.categoryId,
      amountText: formatMinorToPlain(row.budget.limitAmount, row.budget.currency),
      currency: row.budget.currency,
      budgetId: row.budget.id
    })
  }

  /**
   * Move the navigator by whole settlement cycles.
   *
   * The arithmetic lives in the main process (`cycleShift`), which owns the
   * cycle anchor: doing it here would risk the renderer and the service
   * disagreeing about which days a period covers.
   */
  async function shiftCycleBy(delta: number): Promise<void> {
    try {
      const result = await window.api.cycleShift(activeMonth, delta)
      setActiveMonth(result.key)
    } catch (caught) {
      pushToast({
        tone: 'error',
        message: caught instanceof Error ? caught.message : T.failedToLoad,
        detail: T.noChangesMade
      })
    }
  }

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    if (!form) return
    setFormError(null)

    const limitAmount = parseAmountToMinor(form.amountText, form.currency)

    const errors: Record<string, string> = {}
    if (form.amountText.trim() === '') errors.amountText = T.budAmountRequired
    else if (limitAmount === null) errors.amountText = T.budAmountInvalid
    else if (limitAmount <= 0) errors.amountText = T.budLimitPositive
    // `budgetsSet` upserts by category, so re-submitting the same category would
    // replace the existing limit through a path the user did not choose.
    if (
      form.categoryId !== null &&
      rows.some((row) => row.budget.categoryId === form.categoryId && row.budget.id !== form.budgetId)
    ) {
      errors.categoryId = T.budCategoryTaken
    }

    setFieldErrors(errors)
    if (Object.keys(errors).length > 0) {
      setFormError(T.budFixFields)
      return
    }
    if (limitAmount === null) return

    const result = await run(
      () => window.api.budgetsSet({ categoryId: form.categoryId, limitAmount, currency: form.currency }),
      { successMessage: form.budgetId === null ? T.budSaved : T.budUpdated }
    )

    if (result === null) {
      // `useAction` has already toasted the failure; repeating it inside the
      // dialog means the form is never left looking as though it had saved.
      setFormError(T.budSaveFailed)
      return
    }

    setForm(null)
    setFieldErrors({})
    refreshData()
    reload()
  }

  async function handleDelete(row: BudgetProgress): Promise<void> {
    const label = budgetRowLabel(row)
    const confirmed = window.confirm(T.budDeleteConfirm.replace('{label}', label))
    if (!confirmed) return

    const result = await run(() => window.api.budgetsDelete(row.budget.id), { successMessage: T.budDeleted })
    if (result !== null) {
      refreshData()
      reload()
    }
  }

  const overallOver = overall !== null && overall.overBudget
  const remaining = overall ? overall.remaining : 0
  const formPreviewMinor = form === null ? null : parseAmountToMinor(form.amountText, form.currency)

  return (
    <div className="bud">
      <header className="bud__head">
        <div className="bud__heading">
          <h1 className="bud__title">{T.navBudget}</h1>
          <p className="muted bud__sub">{T.budSubtitle}</p>
        </div>

        <nav className="bud__months" aria-label={T.budCycleNav}>
          <button
            type="button"
            className="btn btn-secondary btn-icon"
            onClick={() => void shiftCycleBy(-1)}
            aria-label={T.budPrevCycle}
          >
            <Icon name="chevron-left" />
          </button>
          <span className="bud__monthLabel" aria-live="polite">
            {cycleLabelText}
          </span>
          <button
            type="button"
            className="btn btn-secondary btn-icon"
            onClick={() => void shiftCycleBy(1)}
            aria-label={T.budNextCycle}
          >
            <Icon name="chevron-right" />
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setActiveMonth(currentCycleKey)}
            disabled={activeMonth === currentCycleKey}
          >
            {T.budCurrentCycle}
          </button>
        </nav>
      </header>

      {error ? (
        <div className="card bud__error" role="alert">
          <Icon name="alert" size={18} />
          <div>
            <p className="bud__errorTitle">{T.budLoadFailedTitle}</p>
            <p className="muted">{error}</p>
          </div>
          <div className="spacer" />
          <button type="button" className="btn btn-secondary" onClick={reload}>
            <Icon name="refresh" size={16} />
            {T.retry}
          </button>
        </div>
      ) : null}

      {/* --- overall budget ------------------------------------------------ */}
      <section className="card bud__overall" aria-labelledby="bud-overall-title">
        <div className="bud__overallHead">
          <div>
            <h2 className="card-title" id="bud-overall-title">
              {T.budOverallTitle}
            </h2>
            <p className="muted bud__overallSub">
              {cycleLabelText} &middot; {overall ? T.budOverallSubAll : T.budOverallSubNone}
            </p>
          </div>

          <button type="button" className="btn btn-secondary btn-sm" onClick={openOverall}>
            <Icon name={overall ? 'edit' : 'plus'} size={14} />
            {overall ? T.budEditOverall : T.budSetOverall}
          </button>
        </div>

        {loading && overall === null ? (
          <div className="stack-md" aria-hidden="true">
            <div className="skeleton bud__skeletonLine" />
            <div className="skeleton bud__skeletonBar" />
          </div>
        ) : overall === null ? (
          <div className="bud__overallEmpty">
            <Icon name="budget" size={20} />
            <p className="muted">{T.budEmptyOverall}</p>
            <button type="button" className="btn btn-primary btn-sm" onClick={openOverall}>
              <Icon name="plus" size={14} />
              {T.budSetOverall}
            </button>
          </div>
        ) : (
          <>
            <dl className="bud__stats">
              <div className="bud__stat">
                <dt className="bud__statLabel">{T.budTotal}</dt>
                <Money
                  className="bud__statValue amount"
                  minor={overall.budget.limitAmount}
                  currency={displayCurrency}
                  convert
                />
              </div>
              <div className="bud__stat">
                <dt className="bud__statLabel">{T.budSpent}</dt>
                <Money className="bud__statValue amount" minor={totalSpent} currency={displayCurrency} convert />
              </div>
              <div className="bud__stat">
                <dt className="bud__statLabel">{T.genericRemaining}</dt>
                <Money
                  className={`bud__statValue amount ${overallOver ? 'text-expense' : 'text-income'}`}
                  minor={remaining}
                  currency={displayCurrency}
                  convert
                />
              </div>
            </dl>

            <ProgressBar
              value={totalSpent}
              max={overall.budget.limitAmount}
              color={overallOver ? 'var(--warning)' : 'var(--accent)'}
              height={10}
              showOverflow
              aria-label={T.budOverallAria.replace('{period}', cycleLabelText)}
            />

            <div className="bud__overallFoot">
              <span className="muted bud__small">
                {T.budOverallUsedPercent.replace('{n}', String(Math.round(overall.ratio * 100)))}
                {totalLimit > overall.budget.limitAmount ? (
                  <>
                    {' · '}
                    <Money
                      minor={totalLimit - overall.budget.limitAmount}
                      currency={displayCurrency}
                      convert
                    />{' '}
                    {T.budSitsInCategories}
                  </>
                ) : null}
              </span>
              {overallOver ? (
                <span className="badge bud__overBadge">
                  <Icon name="alert" size={12} />
                  {T.budOverBy} <Money minor={Math.abs(remaining)} currency={displayCurrency} convert />
                </span>
              ) : null}
            </div>
          </>
        )}
      </section>

      {/* --- per-category budgets ----------------------------------------- */}
      <section className="card bud__section" aria-labelledby="bud-cat-title">
        <div className="bud__sectionHead">
          <div>
            <h2 className="card-title" id="bud-cat-title">
              {T.budCategoryTitle}
            </h2>
            <p className="muted bud__small">{T.budCategoryNote}</p>
          </div>
          <button type="button" className="btn btn-primary btn-sm" onClick={openCreate}>
            <Icon name="plus" size={14} />
            {T.budAddCategory}
          </button>
        </div>

        {loading && data === null ? (
          <ul className="bud__list" aria-hidden="true">
            {[0, 1, 2].map((index) => (
              <li className="bud__row" key={index}>
                <div className="skeleton bud__skeletonRow" />
              </li>
            ))}
          </ul>
        ) : perCategory.length === 0 ? (
          <div className="empty-state">
            <Icon name="budget" size={22} />
            <p className="empty-state-title">{T.budEmptyTitle}</p>
            <p>{T.budEmptyBody}</p>
            <button type="button" className="btn btn-primary" onClick={openCreate}>
              <Icon name="plus" size={16} />
              {T.budAddCategory}
            </button>
          </div>
        ) : (
          <ul className="bud__list">
            {perCategory.map((row) => {
              const label = budgetRowLabel(row)
              return (
                <li className="bud__row" key={row.budget.id}>
                  <span
                    className="bud__icon"
                    style={{ color: categoryColorFor(row.categoryName, row.categoryColor) }}
                    aria-hidden="true"
                  >
                    <Icon name={iconNameOr(row.categoryIcon, 'tag')} size={16} />
                  </span>

                  <div className="bud__rowMain">
                    <div className="bud__rowHead">
                      <span className="bud__rowName truncate">{label}</span>
                      {row.overBudget ? (
                        <span className="badge bud__overBadge">
                          <Icon name="alert" size={12} />
                          {T.budOverBy} <Money minor={Math.abs(row.remaining)} currency={displayCurrency} convert />
                        </span>
                      ) : (
                        <span className="badge badge-neutral">
                          {T.genericRemaining} <Money minor={row.remaining} currency={displayCurrency} convert />
                        </span>
                      )}
                      <div className="spacer" />
                      <span className="muted bud__figures amount">
                        <Money minor={row.spent} currency={displayCurrency} convert /> /{' '}
                        <Money minor={row.budget.limitAmount} currency={displayCurrency} convert />
                      </span>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm btn-icon"
                        onClick={() => openEdit(row)}
                        aria-label={T.budEditNamed.replace('{label}', label)}
                        title={T.edit}
                      >
                        <Icon name="edit" size={14} />
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm btn-icon bud__delete"
                        onClick={() => void handleDelete(row)}
                        aria-label={T.budDeleteNamed.replace('{label}', label)}
                        title={T.delete}
                      >
                        <Icon name="trash" size={14} />
                      </button>
                    </div>

                    <ProgressBar
                      value={row.spent}
                      max={row.budget.limitAmount}
                      color={row.overBudget ? 'var(--warning)' : categoryColorFor(row.categoryName, row.categoryColor)}
                      height={8}
                      showOverflow
                      aria-label={T.budRowAria.replace('{label}', label).replace('{period}', cycleLabelText)}
                    />

                    <p className="muted bud__rowFoot">
                      {row.overBudget ? (
                        <>
                          <Money minor={row.spent} currency={displayCurrency} convert /> {T.budSpentOfLimit}{' '}
                          <Money minor={row.budget.limitAmount} currency={displayCurrency} convert />
                        </>
                      ) : (
                        <>
                          {T.budPercentUsed.replace('{n}', String(Math.round(row.ratio * 100)))} ·{' '}
                          {T.genericRemaining} <Money minor={row.remaining} currency={displayCurrency} convert />
                        </>
                      )}
                    </p>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {/* --- set / edit form ---------------------------------------------- */}
      {form ? (
        <div
          className="bud__overlay"
          role="presentation"
          onMouseDown={(event) => {
            // Only a click that both starts and ends on the backdrop closes the
            // form; a drag that began inside the panel must not dismiss it.
            if (event.target === event.currentTarget) setForm(null)
          }}
        >
          <div className="bud__dialog" role="dialog" aria-modal="true" aria-labelledby="bud-form-title">
            <header className="bud__dialogHead">
              <h2 id="bud-form-title" className="bud__dialogTitle">
                {form.budgetId === null ? T.budFormCreateTitle : T.budFormEditTitle}
              </h2>
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                onClick={() => setForm(null)}
                aria-label={T.budCloseForm}
              >
                <Icon name="close" />
              </button>
            </header>

            <form className="bud__form" onSubmit={handleSubmit} noValidate>
              <div className="field">
                <label className="field-label" htmlFor="bud-category">
                  {T.budCategoryField}
                </label>
                <select
                  id="bud-category"
                  className="select"
                  value={form.categoryId === null ? '' : String(form.categoryId)}
                  onChange={(event) => {
                    const raw = event.target.value
                    setForm((previous) =>
                      previous === null
                        ? previous
                        : {
                            ...previous,
                            categoryId: raw === '' ? null : Number(raw),
                            // A per-category budget inherits the app's base
                            // currency; editing an existing one is left alone.
                            currency: previous.budgetId === null && raw !== '' ? baseCurrency : previous.currency
                          }
                    )
                  }}
                >
                  <option value="">{T.budOverallOption}</option>
                  {availableCategories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {categoryLabel(category.name)}
                    </option>
                  ))}
                </select>
                <p className="field-hint">{T.budCategoryHint}</p>
                {fieldErrors.categoryId ? <p className="field-error">{fieldErrors.categoryId}</p> : null}
              </div>

              <div className="field">
                <label className="field-label" htmlFor="bud-amount">
                  {T.budLimitLabel}
                </label>
                <input
                  id="bud-amount"
                  ref={amountRef}
                  className="input amount"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder={T.budLimitPlaceholder}
                  value={form.amountText}
                  aria-invalid={Boolean(fieldErrors.amountText)}
                  aria-describedby={fieldErrors.amountText ? 'bud-amount-error' : 'bud-amount-hint'}
                  onChange={(event) => {
                    const value = event.target.value
                    setForm((previous) => (previous === null ? previous : { ...previous, amountText: value }))
                    setFieldErrors((previous) => {
                      if (!('amountText' in previous)) return previous
                      const next = { ...previous }
                      delete next.amountText
                      return next
                    })
                  }}
                />
                {fieldErrors.amountText ? (
                  <p className="field-error" id="bud-amount-error">
                    {fieldErrors.amountText}
                  </p>
                ) : (
                  <p className="field-hint" id="bud-amount-hint">
                    {T.budInCurrency.replace('{currency}', form.currency)}
                    {formPreviewMinor !== null && formPreviewMinor > 0 ? (
                      <>
                        {' · '}
                        {T.budStoredAs} <Money minor={formPreviewMinor} currency={form.currency} />
                      </>
                    ) : null}
                  </p>
                )}
              </div>

              {formError ? (
                <p className="bud__formError" role="alert">
                  <Icon name="alert" size={16} />
                  <span>{formError}</span>
                </p>
              ) : null}

              <footer className="bud__dialogFoot">
                <button type="button" className="btn btn-secondary" onClick={() => setForm(null)} disabled={pending}>
                  {T.cancel}
                </button>
                <button type="submit" className="btn btn-primary" disabled={pending}>
                  {pending ? T.genericSaving : T.save}
                </button>
              </footer>
            </form>
          </div>
        </div>
      ) : null}

      <style>{BUDGET_CSS}</style>
    </div>
  )
}

const BUDGET_CSS = `
.bud { display: flex; flex-direction: column; gap: var(--space-5); padding-bottom: var(--space-8); }
.bud__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  flex-wrap: wrap;
}
.bud__heading { display: flex; flex-direction: column; gap: 2px; }
.bud__title { font-size: var(--text-2xl); font-weight: var(--weight-semibold); margin: 0; color: var(--text-primary); }
.bud__sub { margin: 0; font-size: var(--text-sm); max-width: 68ch; }
.bud__months { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
/* Wide enough for a cycle label such as "9月5日 – 10月4日". */
.bud__monthLabel {
  min-width: 18ch;
  text-align: center;
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--text-primary);
}
.bud__small { font-size: var(--text-xs); margin: 0; }

.bud__error { display: flex; align-items: center; gap: var(--space-3); border-color: var(--expense); color: var(--expense); }
.bud__errorTitle { font-size: var(--text-sm); font-weight: var(--weight-medium); margin: 0; }
.bud__error p { margin: 0; font-size: var(--text-xs); }

.bud__overall { display: flex; flex-direction: column; gap: var(--space-4); }
.bud__overallHead {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  flex-wrap: wrap;
}
.bud__overallSub { font-size: var(--text-xs); margin: 2px 0 0; }
.bud__stats { display: flex; gap: var(--space-7); flex-wrap: wrap; margin: 0; }
.bud__stat { display: flex; flex-direction: column; gap: 2px; }
.bud__statLabel { font-size: var(--text-xs); color: var(--text-secondary); }
.bud__statValue {
  margin: 0;
  font-size: var(--text-3xl);
  font-weight: var(--weight-semibold);
  line-height: var(--leading-tight);
}
.bud__overallFoot { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
.bud__overallEmpty {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
  padding: var(--space-4);
  background: var(--bg-inset);
  border-radius: var(--radius-md);
  color: var(--text-secondary);
}
.bud__overallEmpty p { margin: 0; font-size: var(--text-sm); max-width: 56ch; }
.bud__skeletonLine { height: 14px; width: 180px; }
.bud__skeletonBar { height: 10px; width: 100%; }
.bud__skeletonRow { height: 42px; width: 100%; }

.bud__section { display: flex; flex-direction: column; gap: var(--space-4); }
.bud__sectionHead {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  flex-wrap: wrap;
}
.bud__list { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; }
.bud__row {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-3) 0;
  border-bottom: 1px solid var(--border-subtle);
}
.bud__row:last-child { border-bottom: 0; padding-bottom: 0; }
.bud__icon {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  flex: 0 0 auto;
  border-radius: var(--radius-md);
  background: var(--bg-inset);
}
.bud__rowMain { display: flex; flex-direction: column; gap: var(--space-2); min-width: 0; flex: 1; }
.bud__rowHead { display: flex; align-items: center; gap: var(--space-2); min-width: 0; flex-wrap: wrap; }
.bud__rowName { font-size: var(--text-sm); font-weight: var(--weight-medium); color: var(--text-primary); }
.bud__figures { font-size: var(--text-sm); white-space: nowrap; }
.bud__rowFoot { font-size: var(--text-xs); margin: 0; }
.bud__delete:hover:not(:disabled) { color: var(--expense); }

/* Restrained over-budget signal: a warning-toned badge and nothing more. */
.bud__overBadge { background: var(--warning-subtle); color: var(--warning); }

.bud__overlay {
  position: fixed;
  inset: 0;
  background: var(--bg-scrim);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 8vh var(--space-6) var(--space-6);
  z-index: 60;
  overflow-y: auto;
}
.bud__dialog {
  width: 100%;
  max-width: 460px;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-md);
  padding: var(--space-6);
  animation: bud-in var(--duration-base) var(--ease-out);
}
@keyframes bud-in {
  from { opacity: 0; transform: translateY(-6px); }
  to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  .bud__dialog { animation: none; }
}
.bud__dialogHead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  margin-bottom: var(--space-5);
}
.bud__dialogTitle { font-size: var(--text-lg); font-weight: var(--weight-semibold); margin: 0; color: var(--text-primary); }
.bud__form { display: flex; flex-direction: column; gap: var(--space-4); }
.bud__formError {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin: 0;
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background: var(--expense-subtle);
  color: var(--expense);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
}
.bud__dialogFoot {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-3);
  padding-top: var(--space-4);
  border-top: 1px solid var(--border-subtle);
}
`
