import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@renderer/store/app'
import { useRateStore } from '@renderer/store/rates'
import { useAction, useAsync } from '@renderer/hooks/useData'
import { Icon } from '@renderer/components/Icon'
import { CurrencyTag, Money } from '@renderer/components/Money'
import { addDays, addMonths, addYears, daysBetween, formatDate, today } from '@shared/lib/dates'
import {
  T,
  billingCycleLabel,
  categoryLabel,
  currencyLabelZh,
  frequencyLabel,
  monthLabelZh,
  transactionTypeLabel,
  weekdayHeaders
} from '@shared/lib/i18n'
import { CURRENCIES, formatMinorToPlain, parseAmountToMinor } from '@shared/lib/money'
import {
  BILLING_CYCLES,
  CYCLES_PER_YEAR,
  type AccountWithBalance,
  type BillingCycle,
  type Category,
  type RecurringRule,
  type RecurringRuleInput,
  type Subscription,
  type SubscriptionInput
} from '@shared/types'

/**
 * Subscriptions and recurring reminders (spec §24 and §23).
 *
 * TWO SEPARATE IDEAS LIVE ON THIS PAGE, and keeping them apart is the whole
 * point of its layout:
 *
 *   1. SUBSCRIPTIONS are descriptive records. "ChatGPT costs RM 100 a month"
 *      tells the user their true recurring cost. A subscription never writes to
 *      the ledger.
 *   2. RECURRING RULES are reminders. A rule that has come due produces a
 *      SUGGESTED transaction which the user must confirm. Nothing is recorded
 *      until they press "添加交易" — the copy says so explicitly, because an app
 *      that silently invents financial records is untrustworthy.
 *
 * MONEY: amounts are INTEGER minor units. Typed input goes through
 * `parseAmountToMinor`; `parseFloat` is never used on a money value, and every
 * figure on screen is rendered by <Money>, which performs the single conversion
 * a display currency needs.
 */

/** `CURRENCIES` keys are a union; this keeps `.map` over them type-safe. */
const CURRENCY_CODES = Object.keys(CURRENCIES) as Array<keyof typeof CURRENCIES>

/**
 * One subscription's contribution to the monthly estimate.
 *
 * This mirrors the backend's own arithmetic (`monthlyEstimate`), which computes
 * `amount * occurrencesPerYear / 12` as integer arithmetic rounded per item, so
 * the figure shown in the form cannot disagree with the headline card. It is a
 * display estimate only — no stored amount is ever derived from it.
 */
function monthlyEquivalentMinor(amountMinor: number, cycle: BillingCycle): number {
  return Math.round((amountMinor * CYCLES_PER_YEAR[cycle]) / 12)
}

/**
 * Short relative label for a due date, or `null` when the date is far enough away
 * that "还有 23 天" would only add noise.
 *
 * Plain string arithmetic on 'YYYY-MM-DD' values: `daysBetween` parses local date
 * parts, so no timezone can shift the answer by a day.
 */
function dueLabel(dueDate: string, reference: string = today()): { text: string; overdue: boolean } | null {
  const days = daysBetween(reference, dueDate)
  if (days < 0) return { text: T.subOverdue.replace('{n}', String(Math.abs(days))), overdue: true }
  if (days === 0) return { text: T.subDueToday, overdue: false }
  if (days <= 7) return { text: T.subInDays.replace('{n}', String(days)), overdue: false }
  return null
}

/** Field errors carried by the bridge error, when the backend rejected a form. */
function readFieldErrors(caught: unknown): Record<string, string> {
  if (typeof caught !== 'object' || caught === null) return {}
  const fields = (caught as { fields?: unknown }).fields
  if (typeof fields !== 'object' || fields === null) return {}
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(fields as Record<string, unknown>)) {
    if (typeof value === 'string') result[key] = value
  }
  return result
}

interface SubscriptionFormState {
  id: number | null
  name: string
  amountText: string
  currency: string
  cycle: BillingCycle
  nextChargeDate: string
  accountId: number | null
  categoryId: number | null
  active: boolean
  note: string
}

interface RecurringFormState {
  id: number | null
  label: string
  type: 'income' | 'expense'
  amountText: string
  accountId: number | null
  categoryId: number | null
  frequency: RecurringRule['frequency']
  dayOfPeriod: number
  monthOfYear: number
  nextDueDate: string
  active: boolean
}

interface ToggleProps {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
}

/** A real checkbox styled as a switch, so `role="switch"` stays honest. */
function Toggle({ checked, onChange, label, disabled }: ToggleProps): React.JSX.Element {
  return (
    <label className={`sub__switch ${disabled ? 'is-disabled' : ''}`}>
      <input
        type="checkbox"
        role="switch"
        aria-checked={checked}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="sub__track" aria-hidden="true">
        <span className="sub__thumb" />
      </span>
      <span className="sub__switchLabel">{label}</span>
    </label>
  )
}

export default function SubscriptionsPage(): React.JSX.Element {
  const refreshData = useAppStore((state) => state.refreshData)
  const pushToast = useAppStore((state) => state.pushToast)
  const dateFormat = useAppStore((state) => state.settings?.dateFormat ?? 'DD MMM YYYY')
  const baseCurrency = useAppStore((state) => state.settings?.baseCurrency ?? 'MYR')
  const startOfWeek = useAppStore((state) => state.settings?.startOfWeek ?? 1)
  const { run, pending } = useAction()

  // Rule amounts are stored in the app's base currency, so the recurring rows are
  // the converted figures on this page. Loading the shared table once keeps them
  // consistent with the dashboard.
  const loadRates = useRateStore((state) => state.load)

  useEffect(() => {
    void loadRates()
  }, [loadRates])

  const { data: subscriptions, loading, error, reload } = useAsync<Subscription[]>(
    () => window.api.subscriptionsList(),
    []
  )
  const { data: estimate } = useAsync<{ amount: number; currency: string }>(
    () => window.api.subscriptionsMonthlyEstimate(),
    []
  )
  const {
    data: due,
    loading: dueLoading,
    error: dueError,
    reload: reloadDue
  } = useAsync<Array<{ rule: RecurringRule; dueDate: string }>>(() => window.api.recurringDue(), [])
  const { data: rules, error: rulesError, reload: reloadRules } = useAsync<RecurringRule[]>(
    () => window.api.recurringList(),
    []
  )
  const { data: accounts } = useAsync<AccountWithBalance[]>(() => window.api.accountsList(), [])
  const { data: categories } = useAsync<Category[]>(() => window.api.categoriesList(), [])

  const [subForm, setSubForm] = useState<SubscriptionFormState | null>(null)
  const [subFieldErrors, setSubFieldErrors] = useState<Record<string, string>>({})
  const [subFormError, setSubFormError] = useState<string | null>(null)
  const subAmountRef = useRef<HTMLInputElement>(null)

  const [ruleForm, setRuleForm] = useState<RecurringFormState | null>(null)
  const [ruleFieldErrors, setRuleFieldErrors] = useState<Record<string, string>>({})
  const [ruleFormError, setRuleFormError] = useState<string | null>(null)
  const ruleAmountRef = useRef<HTMLInputElement>(null)

  const monthlyEstimate = estimate ?? { amount: 0, currency: baseCurrency }
  const activeSubscriptions = useMemo(
    () => (subscriptions ?? []).filter((subscription) => subscription.active),
    [subscriptions]
  )
  const dueRows = due ?? []

  /**
   * Weekday labels, ordered by the user's start-of-week setting.
   *
   * A recurring rule stores a weekday as 0 = Sunday (matching `Date.getDay`), so
   * the label is looked up through an offset rather than by array position — the
   * displayed order and the stored value are deliberately independent.
   */
  const weekdayLabels = useMemo(() => weekdayHeaders(startOfWeek), [startOfWeek])
  const weekdayOrder = useMemo(
    () => (startOfWeek === 1 ? [1, 2, 3, 4, 5, 6, 0] : [0, 1, 2, 3, 4, 5, 6]),
    [startOfWeek]
  )

  function weekdayLabelOf(day: number): string {
    return weekdayLabels[startOfWeek === 1 ? (day + 6) % 7 : day] ?? ''
  }

  useEffect(() => {
    if (!subForm) return
    const id = window.setTimeout(() => subAmountRef.current?.focus(), 30)
    return () => window.clearTimeout(id)
  }, [subForm])

  useEffect(() => {
    if (!ruleForm) return
    const id = window.setTimeout(() => ruleAmountRef.current?.focus(), 30)
    return () => window.clearTimeout(id)
  }, [ruleForm])

  useEffect(() => {
    if (!subForm && !ruleForm) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setSubForm(null)
      setRuleForm(null)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [subForm, ruleForm])

  function accountName(accountId: number | null): string | null {
    if (accountId === null) return null
    return accounts?.find((account) => account.id === accountId)?.name ?? null
  }

  function categoryName(categoryId: number | null): string | null {
    if (categoryId === null) return null
    const category = categories?.find((item) => item.id === categoryId)
    return category ? categoryLabel(category.name) : null
  }

  function openCreateSubscription(): void {
    setSubFieldErrors({})
    setSubFormError(null)
    setSubForm({
      id: null,
      name: '',
      amountText: '',
      currency: baseCurrency,
      cycle: 'monthly',
      nextChargeDate: '',
      accountId: null,
      categoryId: null,
      active: true,
      note: ''
    })
  }

  function openEditSubscription(subscription: Subscription): void {
    setSubFieldErrors({})
    setSubFormError(null)
    setSubForm({
      id: subscription.id,
      name: subscription.name,
      amountText: formatMinorToPlain(subscription.amount, subscription.currency),
      currency: subscription.currency,
      cycle: subscription.cycle,
      nextChargeDate: subscription.nextChargeDate ?? '',
      accountId: subscription.accountId,
      categoryId: subscription.categoryId,
      active: subscription.active,
      note: subscription.note ?? ''
    })
  }

  async function handleSubscriptionSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    if (!subForm) return
    setSubFormError(null)

    const amount = parseAmountToMinor(subForm.amountText, subForm.currency)
    const errors: Record<string, string> = {}
    if (subForm.name.trim() === '') errors.name = T.subNameRequired
    if (subForm.amountText.trim() === '') errors.amountText = T.subAmountRequired
    else if (amount === null) errors.amountText = T.subAmountInvalid
    else if (amount <= 0) errors.amountText = T.subAmountPositive

    setSubFieldErrors(errors)
    if (Object.keys(errors).length > 0) {
      setSubFormError(T.subFixFields)
      return
    }
    if (amount === null) return

    const payload: SubscriptionInput = {
      name: subForm.name.trim(),
      amount,
      currency: subForm.currency,
      cycle: subForm.cycle,
      nextChargeDate: subForm.nextChargeDate || null,
      accountId: subForm.accountId,
      categoryId: subForm.categoryId,
      active: subForm.active,
      note: subForm.note.trim() || null
    }

    try {
      if (subForm.id === null) await window.api.subscriptionsCreate(payload)
      else await window.api.subscriptionsUpdate(subForm.id, payload)
    } catch (caught) {
      // The main process is the authority on validation. Its per-field errors are
      // attached to the thrown error, so they can be shown against the matching
      // input rather than only as a summary line.
      setSubFieldErrors(readFieldErrors(caught))
      setSubFormError(caught instanceof Error ? caught.message : T.subSaveFailed)
      return
    }

    pushToast({ tone: 'success', message: subForm.id === null ? T.subAdded : T.subUpdated })
    setSubForm(null)
    refreshData()
    reload()
  }

  async function handleSubscriptionDelete(subscription: Subscription): Promise<void> {
    const confirmed = window.confirm(T.subDeleteConfirm.replace('{name}', subscription.name))
    if (!confirmed) return

    const result = await run(() => window.api.subscriptionsDelete(subscription.id), {
      successMessage: T.subDeleted
    })
    if (result !== null) {
      refreshData()
      reload()
    }
  }

  async function handleSubscriptionToggle(subscription: Subscription, next: boolean): Promise<void> {
    const result = await run(() => window.api.subscriptionsUpdate(subscription.id, { active: next }))
    if (result !== null) {
      refreshData()
      reload()
    }
  }

  function openCreateRule(): void {
    setRuleFieldErrors({})
    setRuleFormError(null)
    setRuleForm({
      id: null,
      label: '',
      type: 'expense',
      amountText: '',
      accountId: accounts && accounts.length > 0 ? accounts[0].id : null,
      categoryId: null,
      frequency: 'monthly',
      dayOfPeriod: new Date().getDate(),
      monthOfYear: new Date().getMonth() + 1,
      nextDueDate: today(),
      active: true
    })
  }

  function openEditRule(rule: RecurringRule): void {
    setRuleFieldErrors({})
    setRuleFormError(null)
    setRuleForm({
      id: rule.id,
      label: rule.label,
      type: rule.type,
      amountText: formatMinorToPlain(rule.amount, baseCurrency),
      accountId: rule.accountId,
      categoryId: rule.categoryId,
      frequency: rule.frequency,
      dayOfPeriod: rule.dayOfPeriod,
      monthOfYear: rule.monthOfYear ?? new Date().getMonth() + 1,
      nextDueDate: rule.nextDueDate,
      active: rule.active
    })
  }

  async function handleRuleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    if (!ruleForm) return
    setRuleFormError(null)

    const amount = parseAmountToMinor(ruleForm.amountText, baseCurrency)
    const errors: Record<string, string> = {}
    if (ruleForm.label.trim() === '') errors.label = T.subLabelRequired
    if (ruleForm.accountId === null) errors.accountId = T.subAccountRequired
    if (ruleForm.amountText.trim() === '') errors.amountText = T.subAmountRequired
    else if (amount === null) errors.amountText = T.subAmountInvalid
    else if (amount <= 0) errors.amountText = T.subAmountPositive
    if (!ruleForm.nextDueDate) errors.nextDueDate = T.subNextDueRequired

    setRuleFieldErrors(errors)
    if (Object.keys(errors).length > 0) {
      setRuleFormError(T.subFixFields)
      return
    }
    if (amount === null || ruleForm.accountId === null) return

    const payload: RecurringRuleInput = {
      label: ruleForm.label.trim(),
      type: ruleForm.type,
      amount,
      accountId: ruleForm.accountId,
      categoryId: ruleForm.categoryId,
      frequency: ruleForm.frequency,
      dayOfPeriod: ruleForm.dayOfPeriod,
      monthOfYear: ruleForm.frequency === 'yearly' ? ruleForm.monthOfYear : null,
      nextDueDate: ruleForm.nextDueDate,
      active: ruleForm.active
    }

    try {
      if (ruleForm.id === null) await window.api.recurringCreate(payload)
      else await window.api.recurringUpdate(ruleForm.id, payload)
    } catch (caught) {
      setRuleFieldErrors(readFieldErrors(caught))
      setRuleFormError(caught instanceof Error ? caught.message : T.subRuleSaveFailed)
      return
    }

    pushToast({ tone: 'success', message: ruleForm.id === null ? T.subRuleAdded : T.subRuleUpdated })
    setRuleForm(null)
    refreshData()
    reload()
    reloadRules()
    reloadDue()
  }

  async function handleRuleToggle(rule: RecurringRule, next: boolean): Promise<void> {
    const result = await run(() => window.api.recurringUpdate(rule.id, { active: next }))
    if (result !== null) {
      refreshData()
      reloadRules()
      reloadDue()
    }
  }

  async function handleRuleDelete(rule: RecurringRule): Promise<void> {
    const confirmed = window.confirm(T.subRuleDeleteConfirm.replace('{label}', rule.label))
    if (!confirmed) return

    const result = await run(() => window.api.recurringDelete(rule.id), { successMessage: T.subRuleDeleted })
    if (result !== null) {
      refreshData()
      reloadRules()
      reloadDue()
    }
  }

  /** Explicit user action: this is the only path that writes to the ledger. */
  async function handleConfirmDue(rule: RecurringRule, dueDate: string): Promise<void> {
    const result = await run(() => window.api.recurringConfirm(rule.id, dueDate), {
      successMessage: T.subDueRecorded
        .replace('{name}', rule.label)
        .replace('{type}', transactionTypeLabel(rule.type))
    })
    if (result !== null) {
      refreshData()
      reload()
      reloadRules()
      reloadDue()
    }
  }

  /** Skip: move the reminder forward one whole period without touching the ledger. */
  async function handleSkipDue(rule: RecurringRule, dueDate: string): Promise<void> {
    const next =
      rule.frequency === 'weekly'
        ? addDays(dueDate, 7)
        : rule.frequency === 'yearly'
          ? addYears(dueDate, 1)
          : addMonths(dueDate, 1)

    const result = await run(() => window.api.recurringUpdate(rule.id, { nextDueDate: next }), {
      successMessage: T.subSkippedTo.replace('{date}', formatDate(next, dateFormat))
    })
    if (result !== null) {
      refreshData()
      reloadRules()
      reloadDue()
    }
  }

  const ruleCategories = useMemo(
    () => (categories ?? []).filter((category) => category.type === (ruleForm?.type ?? 'expense')),
    [categories, ruleForm]
  )

  const showSkeletons = loading && subscriptions === null

  // Amount shown under the amount field: what the entered figure means in
  // monthly terms, computed with the same integer arithmetic the backend uses.
  const cyclePreview = subForm === null ? 0 : (parseAmountToMinor(subForm.amountText, subForm.currency) ?? 0)
  const monthlyEquivalent = subForm === null ? 0 : monthlyEquivalentMinor(cyclePreview, subForm.cycle)

  return (
    <div className="sub">
      <header className="sub__head">
        <div>
          <h1 className="sub__title">{T.navSubscriptions}</h1>
          <p className="muted sub__sub">{T.subSubtitle}</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={openCreateSubscription}>
          <Icon name="plus" size={16} />
          {T.subAdd}
        </button>
      </header>

      {error ? (
        <div className="card sub__error" role="alert">
          <Icon name="alert" size={18} />
          <div>
            <p className="sub__errorTitle">{T.subLoadFailedTitle}</p>
            <p className="muted">{error}</p>
          </div>
          <div className="spacer" />
          <button type="button" className="btn btn-secondary" onClick={reload}>
            <Icon name="refresh" size={16} />
            {T.retry}
          </button>
        </div>
      ) : null}

      {/* --- headline: estimated monthly recurring expense ------------------ */}
      <section className="card sub__estimate" aria-labelledby="sub-estimate-title">
        <div className="sub__estimateMain">
          <p className="sub__estimateLabel" id="sub-estimate-title">
            {T.subEstimateLabel}
          </p>
          {showSkeletons ? (
            <div className="skeleton sub__skeletonHero" aria-hidden="true" />
          ) : (
            <>
              <Money
                className="sub__estimateValue amount"
                minor={monthlyEstimate.amount}
                currency={monthlyEstimate.currency}
              />
              <CurrencyTag className="muted sub__small" code={monthlyEstimate.currency} />
            </>
          )}
          <p className="muted sub__estimateNote">
            {activeSubscriptions.length === 0
              ? T.subEstimateEmpty
              : T.subEstimateAcross.replace('{n}', String(activeSubscriptions.length))}
          </p>
        </div>
        <div className="sub__estimateYear">
          <span className="sub__estimateYearLabel">{T.subYearLabel}</span>
          {/* Twelve months of the same estimate: integer arithmetic, no rate is
              involved, and it stays an estimate rather than a charge. */}
          <Money
            className="sub__estimateYearValue amount"
            minor={monthlyEstimate.amount * 12}
            currency={monthlyEstimate.currency}
          />
          <span className="muted sub__small">{T.subYearNote}</span>
        </div>
      </section>

      {/* --- recurring reminders (spec §23) -------------------------------- */}
      <section className="card sub__due" aria-labelledby="sub-due-title">
        <div className="sub__sectionHead">
          <div className="row">
            <Icon name="repeat" size={18} />
            <h2 className="card-title" id="sub-due-title">
              {T.subSuggestedTitle}
            </h2>
            {dueRows.length > 0 ? (
              <span className="badge badge-expense">{T.subDueBadge.replace('{n}', String(dueRows.length))}</span>
            ) : null}
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={reloadDue}>
            <Icon name="refresh" size={14} />
            {T.subRecheck}
          </button>
        </div>

        {/* Said plainly, because an app that quietly invents financial records
            is untrustworthy: nothing here is written until the user confirms. */}
        <p className="muted sub__dueNote">{T.subAutoNote}</p>

        {dueError ? (
          <div className="sub__errorInline" role="alert">
            <Icon name="alert" size={16} />
            <span>{dueError}</span>
            <div className="spacer" />
            <button type="button" className="btn btn-secondary btn-sm" onClick={reloadDue}>
              {T.retry}
            </button>
          </div>
        ) : dueLoading && due === null ? (
          <div className="stack-sm" aria-hidden="true">
            <div className="skeleton sub__skeletonRow" />
            <div className="skeleton sub__skeletonRow" />
          </div>
        ) : dueRows.length === 0 ? (
          <p className="muted sub__dueEmpty">{T.subNothingDue}</p>
        ) : (
          <ul className="sub__dueList">
            {dueRows.map(({ rule, dueDate }) => {
              const when = dueLabel(dueDate)
              return (
                <li className="sub__dueRow" key={rule.id}>
                  <span
                    className={`sub__dueDot ${rule.type === 'income' ? 'is-income' : 'is-expense'}`}
                    aria-hidden="true"
                  />
                  <div className="sub__dueText">
                    <span className="sub__rowName truncate">{rule.label}</span>
                    <span className="muted sub__small">
                      {transactionTypeLabel(rule.type)} &middot; {frequencyLabel(rule.frequency)} &middot; {T.subDueOn}{' '}
                      {formatDate(dueDate, dateFormat)}
                      {when ? `（${when.text}）` : ''}
                    </span>
                  </div>
                  <Money
                    className={`amount sub__rowAmount ${rule.type === 'income' ? 'text-income' : 'text-expense'}`}
                    minor={rule.amount}
                    currency={baseCurrency}
                    convert
                    showOriginal
                  />
                  <div className="sub__dueActions">
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={pending}
                      onClick={() => void handleConfirmDue(rule, dueDate)}
                      aria-label={T.subAddForAria
                        .replace('{name}', rule.label)
                        .replace('{date}', formatDate(dueDate, dateFormat))}
                    >
                      <Icon name="check" size={14} />
                      {T.subAddTransaction}
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled={pending}
                      onClick={() => void handleSkipDue(rule, dueDate)}
                      aria-label={T.subSkipAria.replace('{name}', rule.label)}
                    >
                      {T.subSkip}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm btn-icon"
                      onClick={() => openEditRule(rule)}
                      aria-label={T.subEditRuleAria.replace('{name}', rule.label)}
                      title={T.edit}
                    >
                      <Icon name="edit" size={14} />
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {/* --- subscriptions ------------------------------------------------- */}
      <section className="card sub__section" aria-labelledby="sub-list-title">
        <div className="sub__sectionHead">
          <h2 className="card-title" id="sub-list-title">
            {T.subListTitle}
          </h2>
          <span className="muted sub__small">
            {T.subActiveOfTotal
              .replace('{active}', String(activeSubscriptions.length))
              .replace('{total}', String((subscriptions ?? []).length))}
          </span>
        </div>

        {showSkeletons ? (
          <div className="stack-sm" aria-hidden="true">
            {[0, 1, 2].map((index) => (
              <div className="skeleton sub__skeletonRow" key={index} />
            ))}
          </div>
        ) : (subscriptions ?? []).length === 0 ? (
          <div className="empty-state">
            <Icon name="subscriptions" size={22} />
            <p className="empty-state-title">{T.subEmptyTitle}</p>
            <p>{T.subEmptyBody}</p>
            <button type="button" className="btn btn-primary" onClick={openCreateSubscription}>
              <Icon name="plus" size={16} />
              {T.subAddFirst}
            </button>
          </div>
        ) : (
          <ul className="sub__list">
            {(subscriptions ?? []).map((subscription) => {
              const when = subscription.nextChargeDate ? dueLabel(subscription.nextChargeDate) : null
              const account = accountName(subscription.accountId)
              const category = categoryName(subscription.categoryId)
              return (
                <li className={`sub__row ${subscription.active ? '' : 'is-inactive'}`} key={subscription.id}>
                  <div className="sub__rowMain">
                    <div className="sub__rowHead">
                      <span className="sub__rowName truncate">{subscription.name}</span>
                      {!subscription.active ? <span className="badge badge-neutral">{T.subPaused}</span> : null}
                      {when?.overdue && subscription.active ? (
                        <span className="badge sub__overdue">
                          <Icon name="alert" size={12} />
                          {when.text}
                        </span>
                      ) : null}
                      <div className="spacer" />
                      <span className="sub__rowAmount amount">
                        {/* A subscription's own currency: the charge really is in
                            this currency, and the monthly estimate is grouped by
                            it rather than summed across currencies. */}
                        <Money minor={subscription.amount} currency={subscription.currency} /> /{' '}
                        {billingCycleLabel(subscription.cycle)}
                      </span>
                    </div>

                    <div className="sub__rowMeta">
                      <span className="muted sub__small">
                        <Icon name="calendar" size={13} />
                        {subscription.nextChargeDate
                          ? `${T.subNextCharge.replace('{date}', formatDate(subscription.nextChargeDate, dateFormat))}${
                              when ? ` · ${when.text}` : ''
                            }`
                          : T.subNoNextCharge}
                      </span>
                      {account ? (
                        <span className="muted sub__small">
                          <Icon name="wallet" size={13} />
                          {account}
                        </span>
                      ) : null}
                      {category ? (
                        <span className="muted sub__small">
                          <Icon name="tag" size={13} />
                          {category}
                        </span>
                      ) : null}
                    </div>

                    {subscription.note ? <p className="muted sub__small sub__note">{subscription.note}</p> : null}
                  </div>

                  <div className="sub__rowActions">
                    <Toggle
                      checked={subscription.active}
                      disabled={pending}
                      onChange={(next) => void handleSubscriptionToggle(subscription, next)}
                      label={subscription.active ? T.subEnabled : T.subPaused}
                    />
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm btn-icon"
                      onClick={() => openEditSubscription(subscription)}
                      aria-label={`${T.edit} ${subscription.name}`}
                      title={T.edit}
                    >
                      <Icon name="edit" size={14} />
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm btn-icon sub__delete"
                      onClick={() => void handleSubscriptionDelete(subscription)}
                      aria-label={`${T.delete} ${subscription.name}`}
                      title={T.delete}
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {/* --- all recurring rules ------------------------------------------- */}
      <section className="card sub__section" aria-labelledby="sub-rules-title">
        <div className="sub__sectionHead">
          <div>
            <h2 className="card-title" id="sub-rules-title">
              {T.subRulesTitle}
            </h2>
            <p className="muted sub__small">{T.subRulesNote}</p>
          </div>
          <button type="button" className="btn btn-secondary btn-sm" onClick={openCreateRule}>
            <Icon name="plus" size={14} />
            {T.subAddRule}
          </button>
        </div>

        {rulesError ? (
          <div className="sub__errorInline" role="alert">
            <Icon name="alert" size={16} />
            <span>{rulesError}</span>
            <div className="spacer" />
            <button type="button" className="btn btn-secondary btn-sm" onClick={reloadRules}>
              {T.retry}
            </button>
          </div>
        ) : rules === null ? (
          <div className="stack-sm" aria-hidden="true">
            <div className="skeleton sub__skeletonRow" />
          </div>
        ) : rules.length === 0 ? (
          <p className="muted sub__dueEmpty">{T.subRulesEmpty}</p>
        ) : (
          <ul className="sub__list">
            {rules.map((rule) => {
              const when = dueLabel(rule.nextDueDate)
              const account = accountName(rule.accountId)
              const category = categoryName(rule.categoryId)
              const nextDueText = formatDate(rule.nextDueDate, dateFormat)
              const scheduleText =
                rule.frequency === 'weekly'
                  ? T.subRuleWeekly
                      .replace('{weekday}', weekdayLabelOf(rule.dayOfPeriod))
                      .replace('{date}', nextDueText)
                  : rule.frequency === 'yearly'
                    ? T.subRuleYearly
                        .replace('{month}', monthLabelZh((rule.monthOfYear ?? 1) - 1))
                        .replace('{day}', String(rule.dayOfPeriod))
                        .replace('{date}', nextDueText)
                    : T.subRuleMonthly.replace('{day}', String(rule.dayOfPeriod)).replace('{date}', nextDueText)
              return (
                <li className={`sub__row ${rule.active ? '' : 'is-inactive'}`} key={rule.id}>
                  <div className="sub__rowMain">
                    <div className="sub__rowHead">
                      <span className="sub__rowName truncate">{rule.label}</span>
                      <span className="badge badge-neutral">{frequencyLabel(rule.frequency)}</span>
                      {!rule.active ? <span className="badge badge-neutral">{T.subPaused}</span> : null}
                      {rule.active && when?.overdue ? (
                        <span className="badge sub__overdue">
                          <Icon name="alert" size={12} />
                          {when.text}
                        </span>
                      ) : null}
                      <div className="spacer" />
                      <Money
                        className={`sub__rowAmount amount ${rule.type === 'income' ? 'text-income' : 'text-expense'}`}
                        minor={rule.amount}
                        currency={baseCurrency}
                        convert
                        showOriginal
                      />
                    </div>

                    <div className="sub__rowMeta">
                      <span className="muted sub__small">
                        <Icon name="calendar" size={13} />
                        {scheduleText}
                      </span>
                      {account ? (
                        <span className="muted sub__small">
                          <Icon name="wallet" size={13} />
                          {account}
                        </span>
                      ) : null}
                      {category ? (
                        <span className="muted sub__small">
                          <Icon name="tag" size={13} />
                          {category}
                        </span>
                      ) : null}
                    </div>
                  </div>

                  <div className="sub__rowActions">
                    <Toggle
                      checked={rule.active}
                      disabled={pending}
                      onChange={(next) => void handleRuleToggle(rule, next)}
                      label={rule.active ? T.subEnabled : T.subPaused}
                    />
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm btn-icon"
                      onClick={() => openEditRule(rule)}
                      aria-label={T.subEditRuleAria.replace('{name}', rule.label)}
                      title={T.edit}
                    >
                      <Icon name="edit" size={14} />
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm btn-icon sub__delete"
                      onClick={() => void handleRuleDelete(rule)}
                      aria-label={T.subDeleteRuleAria.replace('{name}', rule.label)}
                      title={T.delete}
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {/* --- subscription dialog ------------------------------------------- */}
      {subForm ? (
        <div
          className="sub__overlay"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSubForm(null)
          }}
        >
          <div className="sub__dialog" role="dialog" aria-modal="true" aria-labelledby="sub-form-title">
            <header className="sub__dialogHead">
              <h2 className="sub__dialogTitle" id="sub-form-title">
                {subForm.id === null ? T.subFormAddTitle : T.subFormEditTitle}
              </h2>
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                onClick={() => setSubForm(null)}
                aria-label={T.subCloseForm}
              >
                <Icon name="close" />
              </button>
            </header>

            <form className="sub__form" onSubmit={handleSubscriptionSubmit} noValidate>
              <div className="field">
                <label className="field-label" htmlFor="sub-name">
                  {T.nameLabel}
                </label>
                <input
                  id="sub-name"
                  className="input"
                  maxLength={80}
                  autoComplete="off"
                  placeholder={T.subNamePlaceholder}
                  value={subForm.name}
                  aria-invalid={Boolean(subFieldErrors.name)}
                  onChange={(event) => {
                    const value = event.target.value
                    setSubForm((previous) => (previous === null ? previous : { ...previous, name: value }))
                  }}
                />
                {subFieldErrors.name ? <p className="field-error">{subFieldErrors.name}</p> : null}
              </div>

              <div className="sub__grid">
                <div className="field">
                  <label className="field-label" htmlFor="sub-amount">
                    {T.subAmount}
                  </label>
                  <input
                    id="sub-amount"
                    ref={subAmountRef}
                    className="input amount"
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="0.00"
                    value={subForm.amountText}
                    aria-invalid={Boolean(subFieldErrors.amount)}
                    onChange={(event) => {
                      const value = event.target.value
                      setSubForm((previous) => (previous === null ? previous : { ...previous, amountText: value }))
                    }}
                  />
                  {subFieldErrors.amount ? <p className="field-error">{subFieldErrors.amount}</p> : null}
                </div>

                <div className="field">
                  <label className="field-label" htmlFor="sub-currency">
                    {T.subCurrency}
                  </label>
                  <select
                    id="sub-currency"
                    className="select"
                    value={subForm.currency}
                    onChange={(event) => {
                      const value = event.target.value
                      setSubForm((previous) => (previous === null ? previous : { ...previous, currency: value }))
                    }}
                  >
                    {CURRENCY_CODES.map((code) => (
                      <option key={code} value={code}>
                        {currencyLabelZh(code)}
                      </option>
                    ))}
                  </select>
                  {subFieldErrors.currency ? <p className="field-error">{subFieldErrors.currency}</p> : null}
                </div>
              </div>

              <div className="sub__grid">
                <div className="field">
                  <label className="field-label" htmlFor="sub-cycle">
                    {T.subCycle}
                  </label>
                  <select
                    id="sub-cycle"
                    className="select"
                    value={subForm.cycle}
                    onChange={(event) => {
                      const value = event.target.value as BillingCycle
                      setSubForm((previous) => (previous === null ? previous : { ...previous, cycle: value }))
                    }}
                  >
                    {BILLING_CYCLES.map((cycle) => (
                      <option key={cycle} value={cycle}>
                        {billingCycleLabel(cycle)}
                      </option>
                    ))}
                  </select>
                  <p className="field-hint" id="sub-cycle-hint">
                    {cyclePreview === 0 ? (
                      T.subStoredHint
                    ) : (
                      <>
                        {T.subEquivalentHint} <Money minor={monthlyEquivalent} currency={subForm.currency} />
                        {' · '}
                        {billingCycleLabel(subForm.cycle)}{' '}
                        <Money minor={cyclePreview} currency={subForm.currency} />
                      </>
                    )}
                  </p>
                  {subFieldErrors.cycle ? <p className="field-error">{subFieldErrors.cycle}</p> : null}
                </div>

                <div className="field">
                  <label className="field-label" htmlFor="sub-next">
                    {T.subNextChargeField} <span className="muted">（{T.genericOptional}）</span>
                  </label>
                  <input
                    id="sub-next"
                    type="date"
                    className="input"
                    value={subForm.nextChargeDate}
                    aria-invalid={Boolean(subFieldErrors.nextChargeDate)}
                    onChange={(event) => {
                      const value = event.target.value
                      setSubForm((previous) => (previous === null ? previous : { ...previous, nextChargeDate: value }))
                    }}
                  />
                  {subFieldErrors.nextChargeDate ? (
                    <p className="field-error">{subFieldErrors.nextChargeDate}</p>
                  ) : (
                    <p className="field-hint">{T.subNextChargeHint}</p>
                  )}
                </div>
              </div>

              <div className="sub__grid">
                <div className="field">
                  <label className="field-label" htmlFor="sub-account">
                    {T.subAccountField} <span className="muted">（{T.genericOptional}）</span>
                  </label>
                  <select
                    id="sub-account"
                    className="select"
                    value={subForm.accountId ?? ''}
                    onChange={(event) => {
                      const value = event.target.value
                      setSubForm((previous) =>
                        previous === null ? previous : { ...previous, accountId: value === '' ? null : Number(value) }
                      )
                    }}
                  >
                    <option value="">{T.subNotLinked}</option>
                    {(accounts ?? []).map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.name}
                      </option>
                    ))}
                  </select>
                  {subFieldErrors.accountId ? <p className="field-error">{subFieldErrors.accountId}</p> : null}
                </div>

                <div className="field">
                  <label className="field-label" htmlFor="sub-category">
                    {T.subCategoryField} <span className="muted">（{T.genericOptional}）</span>
                  </label>
                  <select
                    id="sub-category"
                    className="select"
                    value={subForm.categoryId ?? ''}
                    onChange={(event) => {
                      const value = event.target.value
                      setSubForm((previous) =>
                        previous === null ? previous : { ...previous, categoryId: value === '' ? null : Number(value) }
                      )
                    }}
                  >
                    <option value="">{T.subUncategorised}</option>
                    {(categories ?? []).map((category) => (
                      <option key={category.id} value={category.id}>
                        {categoryLabel(category.name)} ({transactionTypeLabel(category.type)})
                      </option>
                    ))}
                  </select>
                  {subFieldErrors.categoryId ? <p className="field-error">{subFieldErrors.categoryId}</p> : null}
                </div>
              </div>

              <div className="field">
                <label className="field-label" htmlFor="sub-note">
                  {T.noteLabel} <span className="muted">（{T.genericOptional}）</span>
                </label>
                <textarea
                  id="sub-note"
                  className="textarea"
                  rows={2}
                  maxLength={300}
                  placeholder={T.subNotePlaceholder}
                  value={subForm.note}
                  onChange={(event) => {
                    const value = event.target.value
                    setSubForm((previous) => (previous === null ? previous : { ...previous, note: value }))
                  }}
                />
              </div>

              <Toggle
                checked={subForm.active}
                onChange={(next) => setSubForm((previous) => (previous === null ? previous : { ...previous, active: next }))}
                label={T.subActiveInEstimate}
              />

              {subFormError ? (
                <p className="sub__formError" role="alert">
                  <Icon name="alert" size={16} />
                  <span>{subFormError}</span>
                </p>
              ) : null}

              <footer className="sub__dialogFoot">
                <button type="button" className="btn btn-secondary" onClick={() => setSubForm(null)} disabled={pending}>
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

      {/* --- recurring rule dialog ----------------------------------------- */}
      {ruleForm ? (
        <div
          className="sub__overlay"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setRuleForm(null)
          }}
        >
          <div className="sub__dialog" role="dialog" aria-modal="true" aria-labelledby="rule-form-title">
            <header className="sub__dialogHead">
              <h2 className="sub__dialogTitle" id="rule-form-title">
                {ruleForm.id === null ? T.subRuleFormAddTitle : T.subRuleFormEditTitle}
              </h2>
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                onClick={() => setRuleForm(null)}
                aria-label={T.subCloseRuleForm}
              >
                <Icon name="close" />
              </button>
            </header>

            <form className="sub__form" onSubmit={handleRuleSubmit} noValidate>
              <div className="field">
                <label className="field-label" htmlFor="rule-label">
                  {T.subLabelField}
                </label>
                <input
                  id="rule-label"
                  className="input"
                  maxLength={80}
                  autoComplete="off"
                  placeholder={T.subLabelPlaceholder}
                  value={ruleForm.label}
                  aria-invalid={Boolean(ruleFieldErrors.label)}
                  onChange={(event) => {
                    const value = event.target.value
                    setRuleForm((previous) => (previous === null ? previous : { ...previous, label: value }))
                  }}
                />
                {ruleFieldErrors.label ? <p className="field-error">{ruleFieldErrors.label}</p> : null}
              </div>

              <div className="sub__grid">
                <div className="field">
                  <label className="field-label" htmlFor="rule-type">
                    {T.subTypeField}
                  </label>
                  <select
                    id="rule-type"
                    className="select"
                    value={ruleForm.type}
                    onChange={(event) => {
                      const value = event.target.value === 'income' ? 'income' : 'expense'
                      setRuleForm((previous) =>
                        // The category list is filtered by type, so a stale
                        // selection would be rejected by the backend.
                        previous === null ? previous : { ...previous, type: value, categoryId: null }
                      )
                    }}
                  >
                    <option value="expense">{transactionTypeLabel('expense')}</option>
                    <option value="income">{transactionTypeLabel('income')}</option>
                  </select>
                  {ruleFieldErrors.type ? <p className="field-error">{ruleFieldErrors.type}</p> : null}
                </div>

                <div className="field">
                  <label className="field-label" htmlFor="rule-amount">
                    {T.subAmountInCurrency.replace('{currency}', baseCurrency)}
                  </label>
                  <input
                    id="rule-amount"
                    ref={ruleAmountRef}
                    className="input amount"
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="0.00"
                    value={ruleForm.amountText}
                    aria-invalid={Boolean(ruleFieldErrors.amount)}
                    onChange={(event) => {
                      const value = event.target.value
                      setRuleForm((previous) => (previous === null ? previous : { ...previous, amountText: value }))
                    }}
                  />
                  {ruleFieldErrors.amount ? <p className="field-error">{ruleFieldErrors.amount}</p> : null}
                </div>
              </div>

              <div className="sub__grid">
                <div className="field">
                  <label className="field-label" htmlFor="rule-account">
                    {T.accountLabel}
                  </label>
                  <select
                    id="rule-account"
                    className="select"
                    value={ruleForm.accountId ?? ''}
                    aria-invalid={Boolean(ruleFieldErrors.accountId)}
                    onChange={(event) => {
                      const value = event.target.value
                      setRuleForm((previous) =>
                        previous === null ? previous : { ...previous, accountId: value === '' ? null : Number(value) }
                      )
                    }}
                  >
                    <option value="">{T.subSelectAccount}</option>
                    {(accounts ?? []).map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.name}
                      </option>
                    ))}
                  </select>
                  {ruleFieldErrors.accountId ? <p className="field-error">{ruleFieldErrors.accountId}</p> : null}
                </div>

                <div className="field">
                  <label className="field-label" htmlFor="rule-category">
                    {T.subCategoryField} <span className="muted">（{T.genericOptional}）</span>
                  </label>
                  <select
                    id="rule-category"
                    className="select"
                    value={ruleForm.categoryId ?? ''}
                    onChange={(event) => {
                      const value = event.target.value
                      setRuleForm((previous) =>
                        previous === null ? previous : { ...previous, categoryId: value === '' ? null : Number(value) }
                      )
                    }}
                  >
                    <option value="">{T.subUncategorised}</option>
                    {ruleCategories.map((category) => (
                      <option key={category.id} value={category.id}>
                        {categoryLabel(category.name)}
                      </option>
                    ))}
                  </select>
                  {ruleFieldErrors.categoryId ? <p className="field-error">{ruleFieldErrors.categoryId}</p> : null}
                </div>
              </div>

              <div className="sub__grid">
                <div className="field">
                  <label className="field-label" htmlFor="rule-frequency">
                    {T.subFrequency}
                  </label>
                  <select
                    id="rule-frequency"
                    className="select"
                    value={ruleForm.frequency}
                    onChange={(event) => {
                      const value =
                        event.target.value === 'weekly'
                          ? 'weekly'
                          : event.target.value === 'yearly'
                            ? 'yearly'
                            : 'monthly'
                      setRuleForm((previous) => {
                        if (previous === null) return previous
                        // Day semantics change with the frequency: a weekday for
                        // weekly, a day of month otherwise. Reset to something
                        // always valid instead of leaving a 0 that the backend
                        // would reject for a monthly rule.
                        const dayOfPeriod =
                          value === 'weekly'
                            ? previous.dayOfPeriod > 6
                              ? 1
                              : previous.dayOfPeriod
                            : previous.dayOfPeriod < 1
                              ? 1
                              : previous.dayOfPeriod
                        return { ...previous, frequency: value, dayOfPeriod }
                      })
                    }}
                  >
                    <option value="weekly">{frequencyLabel('weekly')}</option>
                    <option value="monthly">{frequencyLabel('monthly')}</option>
                    <option value="yearly">{frequencyLabel('yearly')}</option>
                  </select>
                  {ruleFieldErrors.frequency ? <p className="field-error">{ruleFieldErrors.frequency}</p> : null}
                </div>

                {ruleForm.frequency === 'weekly' ? (
                  <div className="field">
                    <label className="field-label" htmlFor="rule-weekday">
                      {T.subWeekday}
                    </label>
                    <select
                      id="rule-weekday"
                      className="select"
                      value={ruleForm.dayOfPeriod}
                      onChange={(event) => {
                        const value = Number(event.target.value)
                        setRuleForm((previous) => (previous === null ? previous : { ...previous, dayOfPeriod: value }))
                      }}
                    >
                      {weekdayOrder.map((day) => (
                        <option key={day} value={day}>
                          {weekdayLabelOf(day)}
                        </option>
                      ))}
                    </select>
                    {ruleFieldErrors.dayOfPeriod ? <p className="field-error">{ruleFieldErrors.dayOfPeriod}</p> : null}
                  </div>
                ) : (
                  <div className="field">
                    <label className="field-label" htmlFor="rule-day">
                      {T.subDayOfMonth}
                    </label>
                    <input
                      id="rule-day"
                      type="number"
                      className="input"
                      min={1}
                      max={31}
                      value={ruleForm.dayOfPeriod}
                      onChange={(event) => {
                        const value = Number(event.target.value)
                        setRuleForm((previous) =>
                          previous === null ? previous : { ...previous, dayOfPeriod: Number.isFinite(value) ? value : 1 }
                        )
                      }}
                    />
                    <p className="field-hint">{T.subDayOfMonthHint}</p>
                    {ruleFieldErrors.dayOfPeriod ? <p className="field-error">{ruleFieldErrors.dayOfPeriod}</p> : null}
                  </div>
                )}
              </div>

              <div className="sub__grid">
                {ruleForm.frequency === 'yearly' ? (
                  <div className="field">
                    <label className="field-label" htmlFor="rule-month">
                      {T.subMonth}
                    </label>
                    <select
                      id="rule-month"
                      className="select"
                      value={ruleForm.monthOfYear}
                      onChange={(event) => {
                        const value = Number(event.target.value)
                        setRuleForm((previous) => (previous === null ? previous : { ...previous, monthOfYear: value }))
                      }}
                    >
                      {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((index) => (
                        <option key={index} value={index + 1}>
                          {monthLabelZh(index)}
                        </option>
                      ))}
                    </select>
                    {ruleFieldErrors.monthOfYear ? <p className="field-error">{ruleFieldErrors.monthOfYear}</p> : null}
                  </div>
                ) : null}

                <div className="field">
                  <label className="field-label" htmlFor="rule-next">
                    {T.subNextDue}
                  </label>
                  <input
                    id="rule-next"
                    type="date"
                    className="input"
                    value={ruleForm.nextDueDate}
                    aria-invalid={Boolean(ruleFieldErrors.nextDueDate)}
                    onChange={(event) => {
                      const value = event.target.value
                      setRuleForm((previous) => (previous === null ? previous : { ...previous, nextDueDate: value }))
                    }}
                  />
                  {ruleFieldErrors.nextDueDate ? <p className="field-error">{ruleFieldErrors.nextDueDate}</p> : null}
                </div>
              </div>

              <Toggle
                checked={ruleForm.active}
                onChange={(next) => setRuleForm((previous) => (previous === null ? previous : { ...previous, active: next }))}
                label={T.subActiveSuggest}
              />

              <p className="sub__hint">
                <Icon name="info" size={15} />
                <span>{T.subRuleSafety}</span>
              </p>

              {ruleFormError ? (
                <p className="sub__formError" role="alert">
                  <Icon name="alert" size={16} />
                  <span>{ruleFormError}</span>
                </p>
              ) : null}

              <footer className="sub__dialogFoot">
                <button type="button" className="btn btn-secondary" onClick={() => setRuleForm(null)} disabled={pending}>
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

      <style>{SUBSCRIPTIONS_CSS}</style>
    </div>
  )
}

const SUBSCRIPTIONS_CSS = `
.sub { display: flex; flex-direction: column; gap: var(--space-5); padding-bottom: var(--space-8); }
.sub__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  flex-wrap: wrap;
}
.sub__title { font-size: var(--text-2xl); font-weight: var(--weight-semibold); margin: 0; color: var(--text-primary); }
.sub__sub { margin: 2px 0 0; font-size: var(--text-sm); max-width: 68ch; }
.sub__small { font-size: var(--text-xs); }

.sub__error {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  border-color: var(--expense);
  color: var(--expense);
}
.sub__errorTitle { font-size: var(--text-sm); font-weight: var(--weight-medium); margin: 0; }
.sub__error p { margin: 0; font-size: var(--text-xs); }
.sub__errorInline {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background: var(--expense-subtle);
  color: var(--expense);
  font-size: var(--text-sm);
}

/* headline estimate — the number the spec asks to be prominent */
.sub__estimate {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-6);
  flex-wrap: wrap;
}
.sub__estimateMain { display: flex; flex-direction: column; gap: var(--space-1); }
.sub__estimateLabel {
  margin: 0;
  font-size: var(--text-xs);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-secondary);
}
.sub__estimateValue {
  margin: 0;
  font-size: var(--text-4xl);
  font-weight: var(--weight-semibold);
  line-height: var(--leading-tight);
  color: var(--text-primary);
}
.sub__estimateNote { margin: 0; font-size: var(--text-xs); max-width: 60ch; }
.sub__estimateYear {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--space-3) var(--space-4);
  background: var(--bg-inset);
  border-radius: var(--radius-md);
  min-width: 180px;
}
.sub__estimateYearLabel { font-size: var(--text-xs); color: var(--text-secondary); }
.sub__estimateYearValue { font-size: var(--text-xl); font-weight: var(--weight-semibold); color: var(--text-primary); }
.sub__skeletonHero { height: 38px; width: 220px; }
.sub__skeletonRow { height: 44px; width: 100%; }

.sub__section { display: flex; flex-direction: column; gap: var(--space-4); }
.sub__sectionHead {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  flex-wrap: wrap;
}

/* suggested transactions */
.sub__dueNote { margin: 0; font-size: var(--text-xs); max-width: 76ch; }
.sub__dueEmpty { margin: 0; font-size: var(--text-sm); }
.sub__dueList { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; }
.sub__dueRow {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--bg-inset);
  margin-bottom: var(--space-2);
  flex-wrap: wrap;
}
.sub__dueRow:last-child { margin-bottom: 0; }
.sub__dueDot { width: 8px; height: 8px; border-radius: var(--radius-full); flex: 0 0 auto; }
.sub__dueDot.is-income { background: var(--income); }
.sub__dueDot.is-expense { background: var(--expense); }
.sub__dueText { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.sub__dueActions { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }

/* subscription / rule rows */
.sub__list { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; }
.sub__row {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-3) 0;
  border-bottom: 1px solid var(--border-subtle);
}
.sub__row:last-child { border-bottom: 0; padding-bottom: 0; }
.sub__row.is-inactive .sub__rowName { color: var(--text-secondary); }
.sub__rowMain { display: flex; flex-direction: column; gap: var(--space-1); min-width: 0; flex: 1; }
.sub__rowHead { display: flex; align-items: center; gap: var(--space-2); min-width: 0; flex-wrap: wrap; }
.sub__rowName { font-size: var(--text-sm); font-weight: var(--weight-medium); color: var(--text-primary); }
.sub__rowAmount { font-size: var(--text-sm); white-space: nowrap; }
.sub__rowMeta { display: flex; align-items: center; gap: var(--space-4); flex-wrap: wrap; }
.sub__rowMeta span { display: inline-flex; align-items: center; gap: var(--space-1); }
.sub__note { margin: 0; }
.sub__rowActions { display: flex; align-items: center; gap: var(--space-2); flex: 0 0 auto; }
.sub__delete:hover:not(:disabled) { color: var(--expense); }
.sub__overdue { background: var(--warning-subtle); color: var(--warning); }

/* toggle — a real checkbox styled as a switch */
.sub__switch {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  cursor: pointer;
  font-size: var(--text-xs);
  color: var(--text-secondary);
}
.sub__switch.is-disabled { opacity: 0.5; cursor: not-allowed; }
.sub__switch input {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
}
.sub__track {
  position: relative;
  width: 34px;
  height: 18px;
  flex: 0 0 auto;
  border-radius: var(--radius-full);
  background: var(--border-default);
  transition: var(--transition-base);
}
.sub__thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: var(--radius-full);
  background: var(--bg-surface);
  box-shadow: var(--shadow-xs);
  transition: var(--transition-base);
}
.sub__switch input:checked + .sub__track { background: var(--accent); }
.sub__switch input:checked + .sub__track .sub__thumb { transform: translateX(16px); }
.sub__switch input:focus-visible + .sub__track { outline: var(--ring-width) solid var(--ring); outline-offset: 2px; }
.sub__switchLabel { white-space: nowrap; }

/* dialog */
.sub__overlay {
  position: fixed;
  inset: 0;
  background: rgba(15, 15, 15, 0.42);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 6vh var(--space-6) var(--space-6);
  z-index: 60;
  overflow-y: auto;
}
.sub__dialog {
  width: 100%;
  max-width: 600px;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-md);
  padding: var(--space-6);
  animation: sub-in var(--duration-base) var(--ease-out);
}
@keyframes sub-in {
  from { opacity: 0; transform: translateY(-6px); }
  to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  .sub__dialog { animation: none; }
}
.sub__dialogHead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  margin-bottom: var(--space-5);
}
.sub__dialogTitle { font-size: var(--text-lg); font-weight: var(--weight-semibold); margin: 0; color: var(--text-primary); }
.sub__form { display: flex; flex-direction: column; gap: var(--space-4); }
.sub__grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-4); }
@media (max-width: 560px) {
  .sub__grid { grid-template-columns: 1fr; }
}
.sub__hint {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin: 0;
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background: var(--bg-inset);
  color: var(--text-secondary);
  font-size: var(--text-xs);
}
.sub__formError {
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
.sub__dialogFoot {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-3);
  padding-top: var(--space-4);
  border-top: 1px solid var(--border-subtle);
}
`
