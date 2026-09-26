import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@renderer/store/app'
import { useRateStore } from '@renderer/store/rates'
import { useAction, useAsync } from '@renderer/hooks/useData'
import { Icon, iconNameOr } from '@renderer/components/Icon'
import { Money, ConversionNote } from '@renderer/components/Money'
import { ProgressBar, LineChart, HorizontalBarChart } from '@renderer/components/charts'
import { parseAmountToMinor, getCurrency } from '@shared/lib/money'
import { addDays, today } from '@shared/lib/dates'
import { CUSTOM_RANGE_PRESETS, validateCustomRange } from '@shared/lib/periods'
import { categoryLabel, dateHeadingZh, currencyLabelZh } from '@shared/lib/i18n'
import type { CustomPeriod, CustomPeriodStatistics } from '@shared/types'

/**
 * 自定义区间统计 (arbitrary-period statistics).
 *
 * THE QUESTION THIS ANSWERS
 * ------------------------
 * "Here is RM 2,000 for the semester, and here are the dates. How am I doing?"
 *
 * A settlement cycle covers the recurring case (allowance arrives on the 5th).
 * This page covers everything else: a trip, a semester, a month between jobs, a
 * one-off budget. The user picks two dates, optionally enters a total, and sees
 * spend against it — plus a pace projection, which is the part that turns a
 * number into a decision.
 *
 * The projection is a straight linear extrapolation of the average daily spend
 * over elapsed days, and the UI LABELS it as an estimate. Presenting it with more
 * confidence than that would be dishonest; omitting it would leave the user to do
 * the arithmetic.
 */
export default function CustomPeriodPage(): React.JSX.Element {
  const displayCurrency = useAppStore((state) => state.settings?.displayCurrency ?? 'CNY')
  const dateFormat = useAppStore((state) => state.settings?.dateFormat ?? 'DD MMM YYYY')
  const { run, pending } = useAction()

  const rateInfo = useRateStore((state) => state.info)
  const loadRates = useRateStore((state) => state.load)

  useEffect(() => {
    void loadRates()
  }, [loadRates])

  // Default to the last 30 days: the most common "non-standard period" ask, and
  // immediately meaningful rather than an empty form.
  const [from, setFrom] = useState(() => addDays(today(), -29))
  const [to, setTo] = useState(() => today())
  const [budgetText, setBudgetText] = useState('')
  const [label, setLabel] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [activePreset, setActivePreset] = useState<string | null>('last30')

  const budgetMinor = useMemo(() => {
    if (budgetText.trim() === '') return null
    return parseAmountToMinor(budgetText, displayCurrency)
  }, [budgetText, displayCurrency])

  /**
   * The query key.
   *
   * `useAsync` refetches whenever this changes, so an invalid range must produce
   * a null key rather than a query the backend would reject — that keeps the
   * error message attached to the field the user is editing.
   */
  const rangeError = validateCustomRange(from, to)
  const query = useMemo(() => {
    if (rangeError) return null
    return { from, to, budgetAmount: budgetMinor }
  }, [from, to, budgetMinor, rangeError])

  const {
    data: stats,
    loading,
    error,
    reload
  } = useAsync<CustomPeriodStatistics | null>(
    () => (query ? window.api.customPeriodStats(query) : Promise.resolve(null)),
    [query?.from, query?.to, query?.budgetAmount]
  )

  const { data: savedPeriods, reload: reloadSaved } = useAsync<CustomPeriod[]>(
    () => window.api.customPeriodsList(),
    []
  )

  function applyPreset(id: string): void {
    const preset = CUSTOM_RANGE_PRESETS.find((item) => item.id === id)
    if (!preset) return
    const range = preset.build(today())
    setFrom(range.from)
    setTo(range.to)
    setActivePreset(id)
    setFormError(null)
  }

  async function handleSave(): Promise<void> {
    if (rangeError) {
      setFormError(rangeError)
      return
    }
    const name = label.trim() || `${from} 至 ${to}`
    const result = await run(() => window.api.customPeriodsSave({ label: name, from, to, budgetAmount: budgetMinor }), {
      successMessage: '统计区间已保存。'
    })
    if (result !== null) {
      setLabel('')
      reloadSaved()
    }
  }

  async function handleDelete(id: number): Promise<void> {
    if (!window.confirm('删除这个统计区间？此操作不可撤销。')) return
    const result = await run(() => window.api.customPeriodsDelete(id), { successMessage: '统计区间已删除。' })
    if (result !== null) reloadSaved()
  }

  const currencySymbol = getCurrency(displayCurrency).symbol

  return (
    <div className="csp">
      <header className="csp__head">
        <div>
          <h1 className="csp__title">自定义区间统计</h1>
          <p className="muted csp__sub">
            任意选择一段时间，输入总金额，查看这段时间花得怎么样、还能撑多久。
          </p>
        </div>
      </header>

      {/* --- range picker ------------------------------------------------ */}
      <section className="card csp__picker" aria-label="选择统计区间">
        <div className="csp__presets" role="group" aria-label="快速选择">
          {CUSTOM_RANGE_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={`csp__preset ${activePreset === preset.id ? 'is-active' : ''}`}
              aria-pressed={activePreset === preset.id}
              onClick={() => applyPreset(preset.id)}
            >
              {preset.label}
            </button>
          ))}
        </div>

        <div className="csp__fields">
          <label className="field">
            <span className="field-label">开始日期</span>
            <input
              type="date"
              className="input"
              value={from}
              onChange={(event) => {
                setFrom(event.target.value)
                setActivePreset(null)
              }}
            />
          </label>

          <label className="field">
            <span className="field-label">结束日期</span>
            <input
              type="date"
              className="input"
              value={to}
              onChange={(event) => {
                setTo(event.target.value)
                setActivePreset(null)
              }}
            />
          </label>

          <label className="field">
            <span className="field-label">
              总金额 <span className="muted">（可选）</span>
            </span>
            <span className="csp__amount">
              <span className="csp__amountSymbol" aria-hidden="true">
                {currencySymbol}
              </span>
              <input
                className="input csp__amountInput"
                inputMode="decimal"
                placeholder="例如 2000"
                value={budgetText}
                onChange={(event) => setBudgetText(event.target.value)}
              />
            </span>
            <span className="field-hint">以 {currencyLabelZh(displayCurrency)} 计</span>
          </label>

          <label className="field">
            <span className="field-label">
              名称 <span className="muted">（可选）</span>
            </span>
            <input
              className="input"
              placeholder="例如：这个学期"
              maxLength={60}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
        </div>

        {rangeError ? (
          <p className="csp__error" role="alert">
            <Icon name="alert" size={16} />
            {rangeError}
          </p>
        ) : null}
        {formError && !rangeError ? (
          <p className="csp__error" role="alert">
            <Icon name="alert" size={16} />
            {formError}
          </p>
        ) : null}

        <div className="csp__actions">
          <span className="muted csp__rangeLabel">
            {from} 至 {to}
          </span>
          <div className="spacer" />
          <button type="button" className="btn btn-secondary" onClick={() => void handleSave()} disabled={pending || Boolean(rangeError)}>
            <Icon name="check" size={16} />
            保存为常用区间
          </button>
        </div>
      </section>

      {/* --- results ----------------------------------------------------- */}
      {rangeError ? null : loading && !stats ? (
        <div className="stack-sm" aria-busy="true">
          <div className="skeleton" style={{ height: 120 }} />
          <div className="skeleton" style={{ height: 240 }} />
        </div>
      ) : error ? (
        <div className="card empty-state" role="alert">
          <p style={{ fontWeight: 500 }}>{error}</p>
          <p className="muted">统计无法加载，请检查日期区间。</p>
          <button type="button" className="btn btn-secondary" onClick={reload}>
            <Icon name="refresh" size={16} />
            重试
          </button>
        </div>
      ) : stats ? (
        <>
          {/* headline: spend against the total */}
          <section className="card csp__summary" aria-label="区间汇总">
            <div className="csp__summaryMain">
              <p className="csp__summaryLabel">{stats.budget ? '区间支出 / 总金额' : '区间支出'}</p>
              <p className="csp__summaryValue amount">
                <Money minor={stats.spent} currency={stats.currency} />
                {stats.budget ? (
                  <span className="csp__summaryOf">
                    {' / '}
                    <Money minor={stats.budget.amount} currency={stats.budget.currency} />
                  </span>
                ) : null}
              </p>
              {stats.budget ? (
                <ProgressBar
                  value={stats.spent}
                  max={stats.budget.amount}
                  showOverflow
                  height={10}
                  aria-label="已用额度"
                />
              ) : (
                <p className="muted csp__noBudget">
                  未设置总金额。填写后可以查看剩余额度和消耗进度。
                </p>
              )}
            </div>

            <dl className="csp__stats">
              {stats.remaining !== null ? (
                <Stat
                  label={stats.overBudget ? '超出' : '剩余'}
                  value={<Money minor={Math.abs(stats.remaining)} currency={stats.currency} />}
                  tone={stats.overBudget ? 'expense' : 'income'}
                />
              ) : null}
              <Stat
                label="日均支出"
                value={<Money minor={stats.dailyAverage} currency={stats.currency} />}
              />
              <Stat
                label="已过 / 共"
                value={`${stats.daysElapsed} / ${stats.daysTotal} 天`}
              />
              {stats.projectedTotal !== null ? (
                <Stat
                  label="按此速度预计"
                  value={<Money minor={stats.projectedTotal} currency={stats.currency} />}
                  tone={stats.budget && stats.projectedTotal > stats.budget.amount ? 'expense' : 'neutral'}
                  hint={
                    stats.budget
                      ? stats.projectedTotal > stats.budget.amount
                        ? '按当前速度会超出总金额'
                        : '按当前速度不会超出'
                      : '仅按当前速度线性估算'
                  }
                />
              ) : null}
            </dl>

            <ConversionNote
              sources={stats.totals.sources}
              displayCurrency={stats.currency}
              hasUnconverted={stats.totals.hasUnconverted}
            />
          </section>

          {/* income / expense / net */}
          <section className="card csp__totals" aria-label="收支">
            <Total label="收入" minor={stats.totals.income} currency={stats.currency} tone="income" />
            <Total label="支出" minor={stats.totals.expense} currency={stats.currency} tone="expense" />
            <Total label="净额" minor={stats.totals.net} currency={stats.currency} tone={stats.totals.net >= 0 ? 'income' : 'expense'} signed />
            <Total label="笔数" raw={`${stats.totals.transactionCount} 笔`} />
          </section>

          {/* daily trend */}
          {stats.trend.length > 1 ? (
            <section className="card" aria-label="每日支出趋势">
              <h2 className="card-title">每日支出趋势</h2>
              <LineChart
                points={stats.trend.map((point) => ({ label: point.label, value: point.expense }))}
                color="var(--expense)"
                currency={stats.currency}
                fill
              />
            </section>
          ) : null}

          {/* categories */}
          <section className="card" aria-label="分类明细">
            <h2 className="card-title">分类明细</h2>
            {stats.categories.length === 0 ? (
              <p className="muted">这段时间还没有支出记录。</p>
            ) : (
              <HorizontalBarChart
                rows={stats.categories.map((row) => ({
                  label: categoryLabel(row.categoryName),
                  value: row.total,
                  color: row.categoryColor ?? 'var(--chart-1)',
                  meta: `${Math.round(row.share * 100)}% · ${row.transactionCount} 笔`
                }))}
                currency={stats.currency}
                showRank
              />
            )}
          </section>

          {/* top expenses */}
          {stats.topExpenses.length > 0 ? (
            <section className="card" aria-label="最大支出">
              <h2 className="card-title">这段时间最大的支出</h2>
              <ul className="csp__list">
                {stats.topExpenses.map((item) => (
                  <li key={item.id} className="csp__listRow">
                    <span
                      className="csp__listIcon"
                      style={{
                        background: item.categoryColor ? `${item.categoryColor}1f` : 'var(--bg-inset)',
                        color: item.categoryColor ?? 'var(--text-secondary)'
                      }}
                    >
                      <Icon name={iconNameOr(item.categoryIcon, 'tag')} size={15} />
                    </span>
                    <span className="csp__listBody">
                      <span className="truncate">{item.merchant ?? categoryLabel(item.categoryName)}</span>
                      <span className="muted csp__listMeta">
                        {categoryLabel(item.categoryName)} · {dateHeadingZh(item.date, dateFormat)}
                      </span>
                    </span>
                    <span className="amount text-expense">
                      <Money minor={Math.abs(item.amount)} currency={item.accountCurrency} convert absolute />
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {!rateInfo?.hasRates ? (
            <p className="csp__ratesNotice">
              <Icon name="info" size={15} />
              尚未获取汇率，跨币种金额按原币显示并以 <strong>*</strong> 标出。
            </p>
          ) : null}
        </>
      ) : (
        <div className="card empty-state">
          <Icon name="calendar" size={28} />
          <p style={{ fontWeight: 500 }}>选择一个时间区间开始统计。</p>
          <p className="muted">可以先用上面的快捷按钮，也可以手动选择开始和结束日期。</p>
        </div>
      )}

      {/* --- saved periods ---------------------------------------------- */}
      {savedPeriods && savedPeriods.length > 0 ? (
        <section className="card" aria-label="已保存的统计区间">
          <h2 className="card-title">已保存的统计区间</h2>
          <ul className="csp__saved">
            {savedPeriods.map((period) => (
              <li key={period.id} className="csp__savedRow">
                <button
                  type="button"
                  className="csp__savedMain"
                  onClick={() => {
                    setFrom(period.from)
                    setTo(period.to)
                    setActivePreset(null)
                    setBudgetText(
                      period.budgetAmount === null
                        ? ''
                        : String(period.budgetAmount / 10 ** getCurrency(period.currency).minorUnits)
                    )
                    setLabel(period.label)
                  }}
                >
                  <span className="csp__savedLabel">{period.label}</span>
                  <span className="muted csp__savedRange">
                    {period.from} 至 {period.to}
                    {period.budgetAmount !== null ? (
                      <>
                        {' · 总金额 '}
                        <Money minor={period.budgetAmount} currency={period.currency} />
                      </>
                    ) : null}
                  </span>
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  aria-label={`删除 ${period.label}`}
                  onClick={() => void handleDelete(period.id)}
                >
                  <Icon name="trash" size={16} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <style>{CSP_CSS}</style>
    </div>
  )
}

function Stat({
  label,
  value,
  tone = 'neutral',
  hint
}: {
  label: string
  value: React.ReactNode
  tone?: 'income' | 'expense' | 'neutral'
  hint?: string
}): React.JSX.Element {
  return (
    <div className="csp__stat">
      <dt className="csp__statLabel">{label}</dt>
      <dd className={`csp__statValue amount text-${tone}`}>{value}</dd>
      {hint ? <dd className="csp__statHint muted">{hint}</dd> : null}
    </div>
  )
}

function Total({
  label,
  minor,
  currency,
  tone,
  signed = false,
  raw
}: {
  label: string
  minor?: number
  currency?: string
  tone?: 'income' | 'expense'
  signed?: boolean
  raw?: string
}): React.JSX.Element {
  return (
    <div className="csp__total">
      <span className="csp__totalLabel">{label}</span>
      <span className={`csp__totalValue amount ${tone ? `text-${tone}` : ''}`}>
        {raw ?? <Money minor={minor ?? 0} currency={currency ?? 'CNY'} signed={signed} />}
      </span>
    </div>
  )
}

const CSP_CSS = `
.csp { display: flex; flex-direction: column; gap: var(--space-5); padding-bottom: var(--space-8); }
.csp__head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4); }
.csp__title { font-size: var(--text-2xl); font-weight: var(--weight-semibold); margin: 0; color: var(--text-primary); }
.csp__sub { margin: 2px 0 0; font-size: var(--text-sm); max-width: 68ch; }
.csp__picker { display: flex; flex-direction: column; gap: var(--space-4); }
.csp__presets { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.csp__preset {
  appearance: none;
  border: 1px solid var(--border-subtle);
  background: var(--bg-inset);
  color: var(--text-secondary);
  font: inherit;
  font-size: var(--text-sm);
  padding: 5px 12px;
  border-radius: var(--radius-full);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out);
}
.csp__preset:hover { color: var(--text-primary); }
.csp__preset.is-active {
  background: var(--accent-subtle);
  border-color: transparent;
  color: var(--accent-text);
  font-weight: var(--weight-medium);
}
.csp__fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: var(--space-4);
}
.csp__amount {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-surface);
  padding: 0 var(--space-3);
}
.csp__amount:focus-within { border-color: var(--accent); box-shadow: 0 0 0 var(--ring-width) var(--ring); }
.csp__amountSymbol { color: var(--text-tertiary); font-size: var(--text-sm); }
.csp__amountInput { border: none; outline: none; background: transparent; padding-left: 0; }
.csp__error {
  display: flex; align-items: center; gap: var(--space-2);
  background: var(--expense-subtle); color: var(--expense);
  border-radius: var(--radius-md); padding: var(--space-3); margin: 0; font-size: var(--text-sm);
}
.csp__actions { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
.csp__rangeLabel { font-size: var(--text-sm); font-variant-numeric: tabular-nums; }
.csp__summary { display: flex; flex-direction: column; gap: var(--space-4); }
.csp__summaryMain { display: flex; flex-direction: column; gap: var(--space-2); }
.csp__summaryLabel { margin: 0; font-size: var(--text-sm); color: var(--text-secondary); }
.csp__summaryValue {
  margin: 0; font-size: var(--text-3xl); font-weight: var(--weight-semibold);
  color: var(--text-primary); display: flex; align-items: baseline; gap: 2px; flex-wrap: wrap;
}
.csp__summaryOf { font-size: var(--text-lg); color: var(--text-tertiary); font-weight: var(--weight-normal); }
.csp__noBudget { margin: 0; font-size: var(--text-sm); }
.csp__stats {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: var(--space-4); margin: 0;
}
.csp__stat { display: flex; flex-direction: column; gap: 2px; }
.csp__statLabel { font-size: var(--text-xs); color: var(--text-secondary); }
.csp__statValue { margin: 0; font-size: var(--text-lg); font-weight: var(--weight-semibold); }
.csp__statHint { margin: 0; font-size: var(--text-xs); }
.csp__totals {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: var(--space-4);
}
.csp__total { display: flex; flex-direction: column; gap: 2px; }
.csp__totalLabel { font-size: var(--text-xs); color: var(--text-secondary); }
.csp__totalValue { font-size: var(--text-lg); font-weight: var(--weight-semibold); }
.csp__list { list-style: none; margin: 0; padding: 0; }
.csp__listRow {
  display: flex; align-items: center; gap: var(--space-3);
  padding: var(--space-2) 0; border-bottom: 1px solid var(--border-subtle);
}
.csp__listRow:last-child { border-bottom: none; }
.csp__listIcon {
  display: grid; place-items: center; width: 30px; height: 30px;
  border-radius: var(--radius-full); flex-shrink: 0;
}
.csp__listBody { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.csp__listMeta { font-size: var(--text-xs); }
.csp__ratesNotice {
  display: flex; align-items: center; gap: var(--space-2);
  font-size: var(--text-sm); color: var(--text-secondary);
  background: var(--bg-inset); border-radius: var(--radius-md);
  padding: var(--space-3); margin: 0;
}
.csp__saved { list-style: none; margin: 0; padding: 0; }
.csp__savedRow {
  display: flex; align-items: center; gap: var(--space-2);
  border-bottom: 1px solid var(--border-subtle);
}
.csp__savedRow:last-child { border-bottom: none; }
.csp__savedMain {
  flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px;
  text-align: left; background: transparent; border: none;
  font: inherit; color: inherit; cursor: pointer; padding: var(--space-3) 0;
}
.csp__savedLabel { font-weight: var(--weight-medium); color: var(--text-primary); }
.csp__savedRange { font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
@media (prefers-reduced-motion: reduce) {
  .csp__preset { transition: none; }
}
`
