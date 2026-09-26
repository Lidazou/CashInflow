import { useEffect, useMemo, useRef, useState } from 'react'
import { applyTheme, useAppStore } from '@renderer/store/app'
import { useRateStore } from '@renderer/store/rates'
import { useAction, useAsync } from '@renderer/hooks/useData'
import { Icon, iconNameOr, type IconName } from '@renderer/components/Icon'
import { CurrencyTag, Money, RateTicker } from '@renderer/components/Money'
import { CURRENCIES, DEFAULT_CURRENCY, parseAmountToMinor } from '@shared/lib/money'
import { formatRatePrecise, lookupRate, selectableCurrencies } from '@shared/lib/rates'
import {
  MAX_CYCLE_START_DAY,
  MIN_CYCLE_START_DAY,
  clampCycleStartDay,
  cycleFor,
  cycleLabel,
  daysRemaining
} from '@shared/lib/periods'
import { formatDate, toDateString, today } from '@shared/lib/dates'
import {
  T,
  categoryLabel,
  categoryStoredName,
  currencyLabelZh,
  cycleStartDayLabel,
  dateFormatLabel,
  daysLabelZh,
  importPresetLabel,
  rateFreshnessLabel
} from '@shared/lib/i18n'
import type {
  AppInfo,
  AppSettings,
  BackupInfo,
  Category,
  CategoryInput,
  CategoryType,
  DatabaseInfo,
  DateFormat,
  ImportBatch,
  RestoreResult,
  ThemeMode
} from '@shared/types'

/**
 * 设置 (spec §29, §30 and the multi-currency settings).
 *
 * Every section states its consequence in words rather than relying on a browser
 * confirm: replacing a database, rolling back an import, or deleting a category
 * that history still points at all change the user's financial records, and a
 * modal they dismissed on reflex is not informed consent. Confirmation prompts
 * still exist for the destructive steps, but the copy that explains what will
 * happen lives on the page.
 *
 * Two things are deliberately loud, because getting them wrong silently corrupts
 * how every other screen reads:
 *
 *   1. The DISPLAY CURRENCY. Converting is a display-only operation, so the page
 *      says so instead of letting the user fear that switching it rewrites their
 *      ledger.
 *   2. The SETTLEMENT CYCLE anchor. "This month" means a different window once it
 *      is set, and a user who does not understand that will distrust every total.
 *
 * The renderer never touches SQLite directly. This page can only ask the main
 * process to act, and any refusal it returns is displayed rather than swallowed.
 */

const CURRENCY_CODES = Object.keys(CURRENCIES) as Array<keyof typeof CURRENCIES>

const DATE_FORMATS: readonly DateFormat[] = ['DD MMM YYYY', 'DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD']

const THEME_OPTIONS: ReadonlyArray<{ value: ThemeMode; label: string; description: string; icon: IconName }> = [
  { value: 'light', label: '浅色', description: '默认主题。浅色背景配深色文字，白天最省眼。', icon: 'sun' },
  { value: 'dark', label: '深色', description: '分层深灰，不使用纯黑，夜间看数字不刺眼。', icon: 'moon' },
  { value: 'system', label: '跟随系统', description: '跟随 Windows 的应用主题，系统切换时自动跟随。', icon: 'palette' }
]

/** Every day-of-month a settlement cycle may start on. 29-31 are refused (see below). */
const CYCLE_START_DAYS: readonly number[] = Array.from(
  { length: MAX_CYCLE_START_DAY - MIN_CYCLE_START_DAY + 1 },
  (_, index) => MIN_CYCLE_START_DAY + index
)

/** How many rate rows are shown before the table folds behind an expander. */
const RATE_ROW_LIMIT = 20

/** Free public rate providers, tried in the order the main process lists them. */
const RATE_PROVIDERS: readonly string[] = ['open.er-api.com', 'api.exchangerate-api.com', 'frankfurter.app']

/** Colour swatches for categories. Hex values are stored in SQLite, so the picker
 *  offers the app's own palette rather than a free colour input. */
const CATEGORY_COLORS: readonly string[] = [
  '#4C6FBF',
  '#D08C3C',
  '#4E9C8A',
  '#C4685E',
  '#8A7BB8',
  '#7A9A4E',
  '#C77FA8',
  '#6E8290'
]

/**
 * Chinese names for the icon picker.
 *
 * The stored value stays the English icon identifier — an older database must
 * keep resolving, and the icon set is keyed by those names — but a picker that
 * offered "utensils" to a Chinese-speaking user would be an untranslated control
 * in an otherwise Chinese screen. The list is derived from this map so an icon
 * can never be offered without a label.
 */
const CATEGORY_ICON_LABELS = {
  tag: '标签',
  utensils: '餐饮',
  car: '交通',
  'shopping-bag': '购物',
  home: '住房',
  gamepad: '娱乐',
  book: '教育',
  'heart-pulse': '医疗',
  plane: '旅行',
  receipt: '账单',
  repeat: '订阅',
  briefcase: '兼职',
  laptop: '电子设备',
  'trending-up': '投资',
  gift: '礼金',
  banknote: '现金',
  wallet: '钱包',
  landmark: '银行',
  'credit-card': '信用卡',
  circle: '其他'
} as const

type CategoryIconName = keyof typeof CATEGORY_ICON_LABELS

/** Icon choices in display order. Every entry is a valid stored icon name. */
const CATEGORY_ICONS: readonly CategoryIconName[] = [
  'tag',
  'utensils',
  'car',
  'shopping-bag',
  'home',
  'gamepad',
  'book',
  'heart-pulse',
  'plane',
  'receipt',
  'repeat',
  'briefcase',
  'laptop',
  'trending-up',
  'gift',
  'banknote',
  'wallet',
  'landmark',
  'credit-card',
  'circle'
]

const CATEGORY_TYPE_LABELS: Readonly<Record<CategoryType, string>> = { expense: T.expense, income: T.income }

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${Math.round(bytes)} 字节`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

/**
 * ISO-8601 instant to a readable local date and time.
 *
 * The date part is rendered through the user's own date format setting, so a
 * timestamp here reads the same way as a timestamp anywhere else in the app.
 */
function formatTimestamp(iso: string | null | undefined, dateFormat: DateFormat): string {
  if (!iso) return '—'
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return iso
  const hh = String(parsed.getHours()).padStart(2, '0')
  const mm = String(parsed.getMinutes()).padStart(2, '0')
  return `${formatDate(toDateString(parsed), dateFormat)} ${hh}:${mm}`
}

/** Age of the cached rate table, phrased so "0.4 hours" never reaches the screen. */
function formatAge(hours: number | null | undefined): string {
  if (hours === null || hours === undefined || !Number.isFinite(hours)) return '—'
  if (hours < 1) return '不到 1 小时'
  if (hours < 48) return `${Math.round(hours)} 小时`
  return `${Math.round(hours / 24)} 天`
}

/** Journal mode as SQLite reports it, with the common values spelled out. */
function journalModeLabel(mode: string): string {
  const known: Record<string, string> = {
    wal: 'WAL（预写日志）',
    delete: 'DELETE（回滚日志）',
    truncate: 'TRUNCATE',
    persist: 'PERSIST',
    memory: 'MEMORY',
    off: 'OFF'
  }
  return known[mode.toLowerCase()] ?? mode
}

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

interface ToggleProps {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  hint?: string
  disabled?: boolean
}

/** A real checkbox styled as a switch, so `role="switch"` stays honest. */
function Toggle({ checked, onChange, label, hint, disabled }: ToggleProps): React.JSX.Element {
  return (
    <label className={`set__switch ${disabled ? 'is-disabled' : ''}`}>
      <input
        type="checkbox"
        role="switch"
        aria-checked={checked}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="set__track" aria-hidden="true">
        <span className="set__thumb" />
      </span>
      <span className="set__switchText">
        <span className="set__switchLabel">{label}</span>
        {hint ? <span className="muted set__small">{hint}</span> : null}
      </span>
    </label>
  )
}

interface CategoryFormState {
  id: number | null
  type: CategoryType
  name: string
  icon: IconName
  color: string
}

interface PendingDelete {
  category: Category
  usageCount: number
  reassignTo: number | null
  message: string
}

export default function SettingsPage(): React.JSX.Element {
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const refreshData = useAppStore((state) => state.refreshData)
  const pushToast = useAppStore((state) => state.pushToast)
  const storeInfo = useAppStore((state) => state.info)
  const { run, pending } = useAction()

  const rateTable = useRateStore((state) => state.table)
  const rateInfo = useRateStore((state) => state.info)
  const ratesLoading = useRateStore((state) => state.loading)
  const ratesError = useRateStore((state) => state.error)
  const setDisplayCurrency = useRateStore((state) => state.setDisplayCurrency)
  const refreshRates = useRateStore((state) => state.refresh)
  const setManualRates = useRateStore((state) => state.setManual)
  const clearRates = useRateStore((state) => state.clear)

  const {
    data: dbInfo,
    loading: dbLoading,
    error: dbError,
    reload: reloadDb
  } = useAsync<DatabaseInfo>(() => window.api.databaseInfo(), [])
  const {
    data: batches,
    loading: batchesLoading,
    error: batchesError,
    reload: reloadBatches
  } = useAsync<ImportBatch[]>(() => window.api.importBatches(), [])
  const {
    data: categories,
    loading: categoriesLoading,
    error: categoriesError,
    reload: reloadCategories
  } = useAsync<Category[]>(() => window.api.categoriesList(), [])
  const { data: usage } = useAsync<Array<{ categoryId: number; transactionCount: number }>>(
    () => window.api.categoriesUsage(),
    []
  )
  const {
    data: appInfo,
    loading: appLoading,
    error: appError,
    reload: reloadApp
  } = useAsync<AppInfo>(() => window.api.appInfo(), [])

  const [lastBackup, setLastBackup] = useState<BackupInfo | null>(null)
  const [lastRestore, setLastRestore] = useState<RestoreResult | null>(null)
  const [exportResult, setExportResult] = useState<{ path: string; rows: number } | null>(null)
  const [dataError, setDataError] = useState<string | null>(null)

  const [cycleStartDayError, setCycleStartDayError] = useState<string | null>(null)
  const [cycleSaving, setCycleSaving] = useState(false)

  const [showAllRates, setShowAllRates] = useState(false)
  const [manualTargetRaw, setManualTargetRaw] = useState('')
  const [manualRateText, setManualRateText] = useState('')
  const [manualRateError, setManualRateError] = useState<string | null>(null)
  const [manualSaving, setManualSaving] = useState(false)

  const [categoryForm, setCategoryForm] = useState<CategoryFormState | null>(null)
  const [categoryFieldErrors, setCategoryFieldErrors] = useState<Record<string, string>>({})
  const [categoryFormError, setCategoryFormError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null)
  const categoryNameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!categoryForm) return
    const id = window.setTimeout(() => categoryNameRef.current?.focus(), 30)
    return () => window.clearTimeout(id)
  }, [categoryForm])

  useEffect(() => {
    if (!categoryForm && !pendingDelete) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setCategoryForm(null)
      setPendingDelete(null)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [categoryForm, pendingDelete])

  const activeTheme: ThemeMode = settings?.theme ?? 'light'
  const baseCurrency = settings?.baseCurrency ?? DEFAULT_CURRENCY
  const displayCurrency = settings?.displayCurrency ?? DEFAULT_CURRENCY
  const dateFormat: DateFormat = settings?.dateFormat ?? 'DD MMM YYYY'
  const startOfWeek: 0 | 1 = settings?.startOfWeek ?? 1
  const cycleStartDay = settings?.cycleStartDay ?? MIN_CYCLE_START_DAY
  const showOriginalCurrency = settings?.showOriginalCurrency ?? true
  const ratesAutoRefresh = settings?.ratesAutoRefresh ?? true

  /** The cycle containing today, so the setting is previewed rather than described. */
  const currentCycle = useMemo(() => cycleFor(today(), cycleStartDay), [cycleStartDay])

  /** Every currency the picker may offer, curated order first. */
  const currencyOptions = useMemo(() => selectableCurrencies(rateTable), [rateTable])

  /** A rate is always quoted against the display currency, so the base never repeats. */
  const manualTargets = useMemo(
    () => currencyOptions.filter((option) => option.code !== displayCurrency),
    [currencyOptions, displayCurrency]
  )
  const manualTarget = manualTargets.some((option) => option.code === manualTargetRaw)
    ? manualTargetRaw
    : (manualTargets[0]?.code ?? DEFAULT_CURRENCY)

  /**
   * Every rate the table can express against the display currency.
   *
   * `lookupRate` is used rather than dividing by hand: it is the same function
   * every conversion in the app goes through, so the table cannot disagree with
   * the figures elsewhere on screen.
   */
  const rateRows = useMemo(() => {
    if (!rateTable) return []
    const codes = Object.keys(rateTable.rates ?? {})
      .map((code) => code.toUpperCase())
      .filter((code) => code !== displayCurrency)
      .sort()
    const rows: Array<{ code: string; text: string }> = []
    for (const code of codes) {
      const rate = lookupRate(rateTable, displayCurrency, code)
      if (rate === null) continue
      rows.push({ code, text: formatRatePrecise(rate, displayCurrency, code) })
    }
    return rows
  }, [rateTable, displayCurrency])

  const visibleRateRows = showAllRates ? rateRows : rateRows.slice(0, RATE_ROW_LIMIT)

  /**
   * 100 units of a currency, in that currency's minor units.
   *
   * `parseAmountToMinor` rather than `100 * 100`: JPY has no minor unit, and a
   * hand-written scale factor is exactly the kind of arithmetic this app keeps in
   * one reviewed place.
   */
  const baseSampleMinor = useMemo(() => parseAmountToMinor('100', baseCurrency) ?? 0, [baseCurrency])
  const displaySampleMinor = useMemo(() => parseAmountToMinor('100', displayCurrency) ?? 0, [displayCurrency])

  const usageById = useMemo(() => {
    const map = new Map<number, number>()
    for (const row of usage ?? []) map.set(row.categoryId, row.transactionCount)
    return map
  }, [usage])

  const expenseCategories = useMemo(
    () => (categories ?? []).filter((category) => category.type === 'expense'),
    [categories]
  )
  const incomeCategories = useMemo(
    () => (categories ?? []).filter((category) => category.type === 'income'),
    [categories]
  )

  /** Persist a settings patch, applying the theme immediately when it changes. */
  async function saveSetting(patch: Partial<AppSettings>, message: string): Promise<boolean> {
    const result = await run(() => updateSettings(patch), { successMessage: message })
    if (result === null) return false
    if (patch.theme !== undefined) applyTheme(patch.theme)
    return true
  }

  async function handleDisplayCurrencyChange(code: string): Promise<void> {
    const saved = await saveSetting(
      { displayCurrency: code },
      `${T.displayCurrency}已切换为${currencyLabelZh(code)}。`
    )
    if (!saved) return
    // The store already follows the persisted setting; the explicit call keeps the
    // renderer's conversion table in step even if the two ever drift.
    setDisplayCurrency(code)
    refreshData()
  }

  async function handleShowOriginalChange(next: boolean): Promise<void> {
    await saveSetting(
      { showOriginalCurrency: next },
      next ? '已开启原币金额显示。' : '已关闭原币金额显示。'
    )
  }

  async function handleAutoRefreshChange(next: boolean): Promise<void> {
    await saveSetting(
      { ratesAutoRefresh: next },
      next ? '已开启汇率自动更新。' : '已关闭汇率自动更新，之后只有手动更新才会改变汇率。'
    )
  }

  /**
   * Refresh rates from the providers.
   *
   * `force` skips the cache TTL, which is what an impatient user pressing 更新
   * means. The outcome is reported either way: a silent no-op would look like a
   * broken button.
   */
  async function handleRateRefresh(): Promise<void> {
    const result = await refreshRates(true)
    refreshData()
    if (result.error) {
      pushToast({
        tone: 'error',
        message: result.error,
        detail: '已保留上一次可用的汇率，页面上的折算仍按旧汇率显示。'
      })
      return
    }
    pushToast({ tone: 'success', message: T.rateUpdated })
  }

  /** Save one hand-typed rate against the display currency. A rate, not money. */
  async function handleManualRateSave(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    setManualRateError(null)

    // A rate is a decimal by nature, so a float is correct here — unlike an
    // amount, which must go through parseAmountToMinor.
    const parsed = Number(manualRateText.trim().replace(/[\s,]/g, ''))
    if (manualRateText.trim() === '' || !Number.isFinite(parsed) || parsed <= 0) {
      setManualRateError('请输入大于 0 的汇率数值，例如 0.6532。')
      return
    }

    setManualSaving(true)
    try {
      await setManualRates({ [manualTarget]: parsed }, displayCurrency)
      setManualRateText('')
      refreshData()
      pushToast({
        tone: 'success',
        message: `已保存手动汇率：${formatRatePrecise(parsed, displayCurrency, manualTarget)}。`
      })
    } catch (caught) {
      setManualRateError(caught instanceof Error ? caught.message : '手动汇率保存失败，原有汇率没有改变。')
    } finally {
      setManualSaving(false)
    }
  }

  async function handleRatesClear(): Promise<void> {
    setManualRateError(null)
    const confirmed = window.confirm(
      `清除汇率表？当前缓存的整张汇率表（包括手动填写的汇率和自动获取的汇率）都会被删除，金额将暂时以原币显示。之后可以随时点「立即更新汇率」重新获取。`
    )
    if (!confirmed) return

    setManualSaving(true)
    try {
      await clearRates()
      refreshData()
      pushToast({ tone: 'info', message: '汇率表已清除。点「立即更新汇率」可重新获取。' })
    } catch (caught) {
      setManualRateError(caught instanceof Error ? caught.message : '汇率表清除失败，原有汇率没有改变。')
    } finally {
      setManualSaving(false)
    }
  }

  /**
   * Change the settlement-cycle anchor.
   *
   * The backend validates the range, and its message explains WHY 29-31 are
   * refused. Surfacing that text inline — rather than a generic failure toast —
   * is what turns a mysterious missing option into a rule the user understands.
   */
  async function handleCycleStartDayChange(rawValue: string): Promise<void> {
    const day = clampCycleStartDay(Number(rawValue))
    setCycleStartDayError(null)
    setCycleSaving(true)
    try {
      await updateSettings({ cycleStartDay: day })
      refreshData()
      pushToast({ tone: 'success', message: `每月起始日已设为${cycleStartDayLabel(day)}。` })
    } catch (caught) {
      setCycleStartDayError(
        caught instanceof Error ? caught.message : '每月起始日保存失败，已保留原来的设置。'
      )
    } finally {
      setCycleSaving(false)
    }
  }

  async function handleBackup(): Promise<void> {
    setDataError(null)
    const result = await run(() => window.api.backupCreate())
    if (result === null) {
      setDataError('备份创建失败，你的数据没有任何改动。')
      return
    }
    if (result.canceled || result.backup === null) {
      pushToast({ tone: 'info', message: '已取消备份，没有写入任何文件。' })
      return
    }
    setLastBackup(result.backup)
    pushToast({ tone: 'success', message: '备份已保存。' })
  }

  async function handleRestore(): Promise<void> {
    setDataError(null)
    const confirmed = window.confirm(
      '要恢复备份吗？SpendWise 里现有的全部账户和交易都会被所选文件的内容替换。替换之前，应用会先把当前数据库复制一份作为安全副本保留在应用数据目录里，所以这一步是可以手工找回的。'
    )
    if (!confirmed) return

    const result = await run(() => window.api.backupRestore())
    if (result === null) {
      setDataError('备份恢复失败，你当前的数据保持原样。')
      return
    }
    if (result.canceled || result.restore === null) {
      pushToast({ tone: 'info', message: '已取消恢复，数据没有改变。' })
      return
    }

    setLastRestore(result.restore)
    refreshData()
    reloadDb()
    reloadBatches()
    reloadCategories()
    pushToast({ tone: 'success', message: '备份已恢复，页面数据已刷新。' })
  }

  async function handleExportCsv(): Promise<void> {
    setDataError(null)
    const result = await run(() => window.api.exportCsv({}))
    if (result === null) {
      setDataError('CSV 导出失败，没有写入任何文件。')
      return
    }
    if (result.canceled || result.path === null) {
      pushToast({ tone: 'info', message: '已取消导出。' })
      return
    }
    setExportResult({ path: result.path, rows: result.rows })
    pushToast({ tone: 'success', message: `已导出 ${result.rows} 行到 CSV。` })
  }

  async function handleRollback(batch: ImportBatch): Promise<void> {
    const confirmed = window.confirm(
      `要回滚「${batch.fileName}」吗？这次导入创建的 ${batch.importedCount} ${T.unitTransactions}会被删除。你之后自己新增或修改的交易不受影响，但基于这次导入做过的修正会随它一起消失。`
    )
    if (!confirmed) return

    const result = await run(() => window.api.importRollback(batch.id), { successMessage: '已回滚这次导入。' })
    if (result !== null) {
      refreshData()
      reloadBatches()
      reloadDb()
      reloadCategories()
    }
  }

  async function handleReveal(): Promise<void> {
    const result = await run(() => window.api.databaseReveal(), {
      successMessage: '已在资源管理器中打开数据库所在文件夹。'
    })
    if (result === null) setDataError('无法在资源管理器中打开数据库文件所在的位置。')
  }

  async function handleDemoSeed(): Promise<void> {
    setDataError(null)
    try {
      const result = await window.api.demoSeed()
      refreshData()
      reloadDb()
      reloadCategories()
      pushToast({
        tone: 'success',
        message: `示例数据已加载：${result.accounts} ${T.unitAccounts}、${result.transactions} ${T.unitTransactions}。`
      })
    } catch (caught) {
      // The backend refuses to mix demo rows into a real ledger. Its reason is
      // shown verbatim instead of failing silently.
      setDataError(caught instanceof Error ? caught.message : '示例数据加载失败。')
    }
  }

  async function handleDemoClear(): Promise<void> {
    setDataError(null)
    const confirmed = window.confirm(
      '要清除示例数据吗？只会删除由 SpendWise 创建的示例账户和示例交易，你自己记录的交易不会被动到。'
    )
    if (!confirmed) return

    try {
      const result = await window.api.demoClear()
      refreshData()
      reloadDb()
      reloadCategories()
      pushToast({
        tone: 'success',
        message: `示例数据已清除（${result.removedTransactions} ${T.unitTransactions}）。`
      })
    } catch (caught) {
      setDataError(caught instanceof Error ? caught.message : '示例数据清除失败。')
    }
  }

  function openCreateCategory(type: CategoryType): void {
    setCategoryFieldErrors({})
    setCategoryFormError(null)
    setCategoryForm({ id: null, type, name: '', icon: 'tag', color: CATEGORY_COLORS[0] })
  }

  function openEditCategory(category: Category): void {
    setCategoryFieldErrors({})
    setCategoryFormError(null)
    setCategoryForm({
      id: category.id,
      type: category.type,
      // The database stores seeded categories under their English identifier, so
      // the form must open on the SAME text the list shows or the user would be
      // editing a word they never see. `categoryStoredName` maps it back on save.
      name: categoryLabel(category.name),
      icon: iconNameOr(category.icon, 'tag'),
      color: category.color
    })
  }

  async function handleCategorySubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    if (!categoryForm) return
    setCategoryFormError(null)

    const name = categoryForm.name.trim()
    const errors: Record<string, string> = {}
    if (name === '') errors.name = '请填写分类名称。'
    else if (name.length > 40) errors.name = '分类名称不能超过 40 个字符。'

    setCategoryFieldErrors(errors)
    if (Object.keys(errors).length > 0) {
      setCategoryFormError('请先修正标出的字段。')
      return
    }

    const payload: CategoryInput = {
      name: categoryStoredName(name),
      type: categoryForm.type,
      icon: categoryForm.icon,
      color: categoryForm.color
    }

    try {
      if (categoryForm.id === null) await window.api.categoriesCreate(payload)
      else await window.api.categoriesUpdate(categoryForm.id, payload)
    } catch (caught) {
      setCategoryFieldErrors(readFieldErrors(caught))
      setCategoryFormError(caught instanceof Error ? caught.message : '分类保存失败。')
      return
    }

    pushToast({
      tone: 'success',
      message: categoryForm.id === null ? '分类已添加。' : '分类已更新。'
    })
    setCategoryForm(null)
    refreshData()
    reloadCategories()
  }

  /**
   * Delete a category.
   *
   * Without `reassignTo` the backend REFUSES when transactions still reference
   * it, and that refusal is what puts the "转移到…" step on screen. Nothing is
   * ever reassigned silently: the user picks the destination and confirms it.
   */
  async function handleCategoryDelete(category: Category, reassignTo?: number | null): Promise<void> {
    try {
      const result = await window.api.categoriesDelete(
        category.id,
        reassignTo === undefined ? undefined : { reassignTo }
      )
      pushToast({
        tone: 'success',
        message:
          result.reassigned > 0
            ? `分类已删除，${result.reassigned} ${T.unitTransactions}已转移。`
            : '分类已删除。'
      })
      setPendingDelete(null)
      refreshData()
      reloadCategories()
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : '分类删除失败。'
      const count = usageById.get(category.id) ?? 0
      setPendingDelete({
        category,
        usageCount: count,
        reassignTo: reassignTo ?? null,
        message
      })
      setCategoryFormError(null)
    }
  }

  const reassignOptions = useMemo(() => {
    if (!pendingDelete) return []
    return (categories ?? []).filter(
      (category) => category.type === pendingDelete.category.type && category.id !== pendingDelete.category.id
    )
  }, [categories, pendingDelete])

  function renderCategoryList(type: CategoryType, rows: Category[]): React.JSX.Element {
    const heading = type === 'expense' ? '支出分类' : '收入分类'
    return (
      <div className="set__catGroup" key={type}>
        <div className="set__catGroupHead">
          <h3 className="set__subHeading">{heading}</h3>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => openCreateCategory(type)}>
            <Icon name="plus" size={14} />
            新建{heading}
          </button>
        </div>

        {rows.length === 0 ? (
          <p className="muted set__small">还没有{heading}。</p>
        ) : (
          <ul className="set__catList">
            {rows.map((category) => {
              const count = usageById.get(category.id) ?? 0
              const shownName = categoryLabel(category.name)
              return (
                <li className="set__catRow" key={category.id}>
                  <span className="set__catIcon" style={{ color: category.color }} aria-hidden="true">
                    <Icon name={iconNameOr(category.icon, 'tag')} size={15} />
                  </span>
                  <div className="set__catText">
                    <span className="set__catName truncate">{shownName}</span>
                    <span className="muted set__small">
                      {count === 0 ? '尚未使用' : `${count} ${T.unitTransactions}`}
                      {category.isSystem ? ' · 内置分类' : ''}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm btn-icon"
                    onClick={() => openEditCategory(category)}
                    aria-label={`编辑分类「${shownName}」`}
                  >
                    <Icon name="edit" size={14} />
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm btn-icon set__delete"
                    onClick={() => void handleCategoryDelete(category)}
                    aria-label={`删除分类「${shownName}」`}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    )
  }

  return (
    <div className="set">
      <header className="set__head">
        <h1 className="set__title">{T.navSettings}</h1>
        <p className="muted set__sub">
          偏好设置、本地数据，以及把数据导出带走的各种工具。这个页面上的所有内容都保存在这台电脑上。
        </p>
      </header>

      {dataError ? (
        <div className="card set__error" role="alert">
          <Icon name="alert" size={18} />
          <span>{dataError}</span>
          <div className="spacer" />
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDataError(null)}>
            {T.close}
          </button>
        </div>
      ) : null}

      {/* --- 通用 ------------------------------------------------------------ */}
      <section className="card set__section" aria-labelledby="set-general-title">
        <div className="set__sectionHead">
          <Icon name="settings" size={18} />
          <h2 className="card-title" id="set-general-title">
            通用
          </h2>
        </div>

        {settings === null ? (
          <div className="stack-sm" aria-hidden="true">
            <div className="skeleton set__skeletonRow" />
            <div className="skeleton set__skeletonRow" />
          </div>
        ) : (
          <div className="set__grid">
            <div className="field">
              <label className="field-label" htmlFor="set-currency">
                {T.currency}
              </label>
              <select
                id="set-currency"
                className="select"
                value={baseCurrency}
                disabled={pending}
                onChange={(event) =>
                  void saveSetting(
                    { baseCurrency: event.target.value },
                    `记账货币已切换为${currencyLabelZh(event.target.value)}。`
                  )
                }
              >
                {CURRENCY_CODES.map((code) => (
                  <option key={code} value={code}>
                    {currencyLabelZh(code)}（{CURRENCIES[code].symbol}）
                  </option>
                ))}
              </select>
              <p className="field-hint">
                用于把不同账户的余额合并成一个总额。每笔金额仍然保留它记账时的原币种。
              </p>
            </div>

            <div className="field">
              <label className="field-label" htmlFor="set-week">
                每周起始日
              </label>
              <select
                id="set-week"
                className="select"
                value={String(startOfWeek)}
                disabled={pending}
                onChange={(event) =>
                  void saveSetting(
                    { startOfWeek: event.target.value === '0' ? 0 : 1 },
                    '每周起始日已更新。'
                  )
                }
              >
                <option value="1">周一</option>
                <option value="0">周日</option>
              </select>
              <p className="field-hint">决定统计和日历里「一周」从哪里开始。</p>
            </div>

            <div className="field">
              <label className="field-label" htmlFor="set-dateformat">
                日期格式
              </label>
              <select
                id="set-dateformat"
                className="select"
                value={dateFormat}
                disabled={pending}
                onChange={(event) =>
                  void saveSetting(
                    { dateFormat: event.target.value as DateFormat },
                    '日期格式已更新。'
                  )
                }
              >
                {DATE_FORMATS.map((format) => (
                  <option key={format} value={format}>
                    {dateFormatLabel(format)}
                  </option>
                ))}
              </select>
              <p className="field-hint">
                实际效果：<span className="set__example">{formatDate(today(), dateFormat, { weekday: true })}</span>
              </p>
            </div>
          </div>
        )}
      </section>

      {/* --- 显示货币与汇率 --------------------------------------------------- */}
      <section className="card set__section set__section--feature" aria-labelledby="set-rates-title">
        <div className="set__sectionHead">
          <Icon name="arrow-left-right" size={18} />
          <h2 className="card-title" id="set-rates-title">
            显示货币与汇率
          </h2>
        </div>

        {settings === null ? (
          <div className="stack-sm" aria-hidden="true">
            <div className="skeleton set__skeletonRow" />
            <div className="skeleton set__skeletonRow" />
          </div>
        ) : (
          <div className="set__grid">
            <div className="field">
              <label className="field-label" htmlFor="set-display-currency">
                {T.displayCurrency}
              </label>
              <select
                id="set-display-currency"
                className="select"
                value={displayCurrency}
                disabled={pending}
                onChange={(event) => void handleDisplayCurrencyChange(event.target.value)}
              >
                {currencyOptions.map((option) => (
                  <option key={option.code} value={option.code}>
                    {option.label}（{option.symbol}）
                  </option>
                ))}
              </select>
              <p className="field-hint">{T.displayCurrencyHint}</p>
            </div>

            <div className="set__toggles">
              <Toggle
                checked={showOriginalCurrency}
                disabled={settings === null || pending}
                label={T.originalAmount}
                hint="在折算金额后同时显示原币金额。"
                onChange={(next) => void handleShowOriginalChange(next)}
              />
              <Toggle
                checked={ratesAutoRefresh}
                disabled={settings === null || pending}
                label="自动更新汇率"
                hint="汇率过期时自动获取新的公开汇率；关闭后只有手动更新才会改变汇率。"
                onChange={(next) => void handleAutoRefreshChange(next)}
              />
            </div>
          </div>
        )}

        <div className="set__preview">
          <span className="muted set__small">折算示例</span>
          <span className="set__previewValue">
            <Money
              minor={baseSampleMinor}
              currency={baseCurrency}
              convert
              target={displayCurrency}
              showOriginal={showOriginalCurrency}
            />
          </span>
          <span className="muted set__small">
            100 {currencyLabelZh(baseCurrency)} 在界面上的显示效果，鼠标悬停可以看到使用的汇率。
          </span>
        </div>

        <div className="set__subBlock">
          <div className="set__rateStatusHead">
            <h3 className="set__subHeading">汇率状态</h3>
            <RateTicker onRefresh={() => void handleRateRefresh()} refreshing={ratesLoading} />
          </div>

          <dl className="set__factsList">
            <div className="set__fact">
              <dt>数据状态</dt>
              <dd>{rateInfo ? rateFreshnessLabel(rateInfo.freshness) : rateFreshnessLabel('missing')}</dd>
            </div>
            <div className="set__fact">
              <dt>数据来源</dt>
              <dd>
                {rateInfo?.provider
                  ? rateInfo.isManual
                    ? `${rateInfo.provider}（手动填写）`
                    : rateInfo.provider
                  : '—'}
              </dd>
            </div>
            <div className="set__fact">
              <dt>获取时间</dt>
              <dd>{formatTimestamp(rateInfo?.fetchedAt, dateFormat)}</dd>
            </div>
            <div className="set__fact">
              <dt>数据年龄</dt>
              <dd>{formatAge(rateInfo?.ageHours)}</dd>
            </div>
            <div className="set__fact">
              <dt>汇率基准</dt>
              <dd>{rateInfo?.base ? currencyLabelZh(rateInfo.base) : '—'}</dd>
            </div>
          </dl>

          <div className="set__actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void handleRateRefresh()}
              disabled={ratesLoading}
            >
              <Icon name="refresh" size={16} />
              {ratesLoading ? '正在更新汇率…' : '立即更新汇率'}
            </button>
          </div>
        </div>

        {ratesError !== null || rateInfo?.lastError ? (
          <div className="set__warning" role="status">
            <Icon name="alert" size={16} />
            <div>
              <p className="set__warningTitle">最近一次汇率更新失败</p>
              <p className="set__warningBody">
                {ratesError ?? rateInfo?.lastError}
                <br />
                页面上的折算仍然使用上一次成功获取的汇率；如果从来没有获取成功过，金额会以原币显示。
              </p>
            </div>
          </div>
        ) : null}

        <div className="set__subBlock">
          <h3 className="set__subHeading">汇率对照表</h3>

          {rateInfo === null || !rateInfo.hasRates ? (
            <p className="set__notice">{T.noRatesYet}</p>
          ) : rateRows.length === 0 ? (
            <p className="set__notice">
              当前汇率表里没有 {currencyLabelZh(displayCurrency)}{' '}
              的记录，无法列出对照汇率。可以点「立即更新汇率」重新获取。
            </p>
          ) : (
            <>
              <div className="set__tableWrap">
                <table className="table">
                  <caption className="visually-hidden">
                    以 {displayCurrency} 为基准的汇率对照表
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">货币</th>
                      <th scope="col">汇率</th>
                      <th scope="col" className="num">
                        折算 100 {displayCurrency}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRateRows.map((row) => (
                      <tr key={row.code}>
                        <td>{currencyLabelZh(row.code)}</td>
                        <td className="set__rateCell">{row.text}</td>
                        <td className="num">
                          <Money
                            minor={displaySampleMinor}
                            currency={displayCurrency}
                            convert
                            target={row.code}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {rateRows.length > RATE_ROW_LIMIT ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm set__expander"
                  aria-expanded={showAllRates}
                  onClick={() => setShowAllRates((previous) => !previous)}
                >
                  <Icon name="chevron-down" size={14} />
                  {showAllRates ? '收起' : `显示全部（共 ${rateRows.length} ${T.unitCurrencies}）`}
                </button>
              ) : (
                <p className="muted set__small">
                  共 {rateRows.length} {T.unitCurrencies}，全部显示在上面。
                </p>
              )}
            </>
          )}
        </div>

        <div className="set__subBlock">
          <h3 className="set__subHeading">手动汇率</h3>
          <p className="muted set__small">
            银行或换汇平台给你的成交价，常常和公开汇率不一样。手动填写后，整张汇率表会以你填写的汇率为准，并且在你再次点「立即更新汇率」之前不会被自动覆盖——这样你的账目才会和你实际的换汇价格一致。
          </p>

          <form className="set__rateForm" onSubmit={handleManualRateSave} noValidate>
            <div className="field">
              <label className="field-label" htmlFor="set-manual-target">
                要填写的货币
              </label>
              <select
                id="set-manual-target"
                className="select"
                value={manualTarget}
                disabled={manualSaving}
                onChange={(event) => setManualTargetRaw(event.target.value)}
              >
                {manualTargets.map((option) => (
                  <option key={option.code} value={option.code}>
                    {option.label}（{option.symbol}）
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label className="field-label" htmlFor="set-manual-rate">
                1 {displayCurrency} 等于多少 {manualTarget}
              </label>
              <input
                id="set-manual-rate"
                className="input"
                inputMode="decimal"
                autoComplete="off"
                placeholder="0.6532"
                value={manualRateText}
                aria-invalid={manualRateError !== null}
                aria-describedby={manualRateError ? 'set-manual-rate-error' : undefined}
                onChange={(event) => setManualRateText(event.target.value)}
              />
              <p className="field-hint">
                <CurrencyTag code={displayCurrency} /> 兑 <CurrencyTag code={manualTarget} />{' '}
                的价格。这里填写的是汇率（可以带小数），不是金额。
              </p>
            </div>

            <div className="set__rateFormActions">
              <button type="submit" className="btn btn-primary" disabled={manualSaving}>
                {manualSaving ? T.genericSaving : '保存手动汇率'}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={manualSaving}
                onClick={() => void handleRatesClear()}
              >
                <Icon name="trash" size={14} />
                清除手动汇率
              </button>
            </div>
          </form>

          {manualRateError ? (
            <p className="field-error" id="set-manual-rate-error" role="alert">
              {manualRateError}
            </p>
          ) : null}
        </div>

        <div className="set__subBlock">
          <h3 className="set__subHeading">数据来源</h3>
          <ul className="set__facts">
            <li>汇率来自免费的公开接口：{RATE_PROVIDERS.join('、')}，按顺序尝试，任意一个可用即可。</li>
            <li>不需要注册，也不需要填写 API 密钥。</li>
            <li>
              这些是中间价（indicative mid-market rate），只是市场参考值，并不等于银行或换汇平台实际收取的价格，银行通常还会加上点差或手续费。
            </li>
            <li>汇率只用于界面上的折算显示，永远不会写进任何一笔交易记录。</li>
          </ul>
        </div>
      </section>

      {/* --- 结算周期 --------------------------------------------------------- */}
      <section className="card set__section" aria-labelledby="set-cycle-title">
        <div className="set__sectionHead">
          <Icon name="calendar" size={18} />
          <h2 className="card-title" id="set-cycle-title">
            {T.settlementCycle}
          </h2>
        </div>

        {settings === null ? (
          <div className="stack-sm" aria-hidden="true">
            <div className="skeleton set__skeletonRow" />
          </div>
        ) : (
          <div className="field">
            <label className="field-label" htmlFor="set-cycle-start-day">
              {T.cycleStartDay}
            </label>
            <select
              id="set-cycle-start-day"
              className="select"
              value={String(cycleStartDay)}
              disabled={cycleSaving || pending}
              aria-invalid={cycleStartDayError !== null}
              aria-describedby={cycleStartDayError ? 'set-cycle-error' : undefined}
              onChange={(event) => void handleCycleStartDayChange(event.target.value)}
            >
              {CYCLE_START_DAYS.map((day) => (
                <option key={day} value={day}>
                  {cycleStartDayLabel(day)}
                </option>
              ))}
            </select>
            <p className="field-hint">
              可选范围 {MIN_CYCLE_START_DAY}–{MAX_CYCLE_START_DAY} 日，默认 {cycleStartDayLabel(1)}。
            </p>
          </div>
        )}

        {cycleStartDayError ? (
          <p className="set__formError" id="set-cycle-error" role="alert">
            <Icon name="alert" size={16} />
            <span>{cycleStartDayError}</span>
          </p>
        ) : null}

        <div className="set__cyclePreview">
          <div className="set__cycleHead">
            <span className="set__chip">{T.currentCycle}</span>
            <span className="set__cycleLabelText">{cycleLabel(currentCycle.start, currentCycle.end)}</span>
          </div>
          <p className="muted set__small">
            起始 {formatDate(currentCycle.start, dateFormat)} · 结束 {formatDate(currentCycle.end, dateFormat)}
          </p>
          <p className="muted set__small">
            {T.daysRemaining}：{daysLabelZh(daysRemaining(currentCycle))}
          </p>
        </div>

        <p className="muted set__small">{T.cycleStartDayHint}</p>

        <div className="set__warning">
          <Icon name="info" size={16} />
          <div>
            <p className="set__warningTitle">为什么最多只能选到 {MAX_CYCLE_START_DAY} 日</p>
            <p className="set__warningBody">{T.cycleDayRangeNote}</p>
          </div>
        </div>
      </section>

      {/* --- 外观 ------------------------------------------------------------ */}
      <section className="card set__section" aria-labelledby="set-theme-title">
        <div className="set__sectionHead">
          <Icon name="palette" size={18} />
          <h2 className="card-title" id="set-theme-title">
            外观
          </h2>
        </div>

        <fieldset className="set__themes">
          <legend className="visually-hidden">主题</legend>
          {THEME_OPTIONS.map((option) => {
            const isActive = activeTheme === option.value
            return (
              <label key={option.value} className={`set__theme ${isActive ? 'is-active' : ''}`}>
                <input
                  type="radio"
                  name="set-theme"
                  value={option.value}
                  checked={isActive}
                  disabled={settings === null || pending}
                  onChange={() => void saveSetting({ theme: option.value }, `已切换到${option.label}主题。`)}
                />
                <span className="set__themeIcon" aria-hidden="true">
                  <Icon name={option.icon} size={18} />
                </span>
                <span className="set__themeText">
                  <span className="set__themeLabel">
                    {option.label}
                    {isActive ? <span className="badge badge-neutral">当前</span> : null}
                  </span>
                  <span className="muted set__small">{option.description}</span>
                </span>
              </label>
            )
          })}
        </fieldset>

        <p className="muted set__small">
          浅色是默认主题。「跟随系统」会跟随 Windows 的应用主题，并在系统切换时一起变化。
        </p>
      </section>

      {/* --- 数据 ------------------------------------------------------------ */}
      <section className="card set__section" aria-labelledby="set-data-title">
        <div className="set__sectionHead">
          <Icon name="database" size={18} />
          <h2 className="card-title" id="set-data-title">
            数据
          </h2>
        </div>

        <div className="set__actions">
          <button type="button" className="btn btn-primary" onClick={() => void handleBackup()} disabled={pending}>
            <Icon name="export" size={16} />
            导出数据库备份
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => void handleExportCsv()} disabled={pending}>
            <Icon name="export" size={16} />
            导出 CSV
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => void handleRestore()} disabled={pending}>
            <Icon name="import" size={16} />
            导入备份
          </button>
        </div>

        <p className="muted set__small">
          数据库备份包含全部账户、交易、预算和设置，是一份完整副本；CSV 只包含交易明细，方便在表格软件里打开。
        </p>

        <div className="set__warning">
          <Icon name="alert" size={16} />
          <div>
            <p className="set__warningTitle">恢复备份会替换当前全部数据</p>
            <p className="set__warningBody">
              你现在所有的账户和交易都会被移除，由备份文件里的内容取代。在替换之前，SpendWise
              会先把当前数据库复制一份作为安全副本保存在应用数据目录里，恢复完成后会在下方显示这条副本的路径，所以这一步是可以手工找回的。注意：最近一次备份之后记录的内容，不在那份备份里。
            </p>
          </div>
        </div>

        {lastBackup ? (
          <div className="set__result">
            <Icon name="check" size={16} />
            <div>
              <p className="set__resultTitle">备份已写入</p>
              <p className="set__path truncate" title={lastBackup.path}>
                {lastBackup.path}
              </p>
              <p className="muted set__small">
                {formatBytes(lastBackup.bytes)} · 结构版本 {lastBackup.schemaVersion} ·{' '}
                {lastBackup.accountCount} {T.unitAccounts}、{lastBackup.transactionCount} {T.unitTransactions} ·{' '}
                {formatTimestamp(lastBackup.createdAt, dateFormat)}
              </p>
            </div>
          </div>
        ) : null}

        {exportResult ? (
          <div className="set__result">
            <Icon name="check" size={16} />
            <div>
              <p className="set__resultTitle">CSV 已写入</p>
              <p className="set__path truncate" title={exportResult.path}>
                {exportResult.path}
              </p>
              <p className="muted set__small">已导出 {exportResult.rows} 行。</p>
            </div>
          </div>
        ) : null}

        {lastRestore ? (
          <div className="set__result">
            <Icon name="check" size={16} />
            <div>
              <p className="set__resultTitle">恢复完成</p>
              <p className="set__path truncate" title={lastRestore.restoredFrom}>
                恢复来源：{lastRestore.restoredFrom}
              </p>
              <p className="muted set__small">
                现在生效的是 {lastRestore.accountCount} {T.unitAccounts}和 {lastRestore.transactionCount}{' '}
                {T.unitTransactions}。被替换掉的数据库作为安全副本保留在：
              </p>
              <p className="set__path truncate" title={lastRestore.preRestoreBackupPath}>
                {lastRestore.preRestoreBackupPath}
              </p>
            </div>
          </div>
        ) : null}

        {settings?.lastBackupAt ? (
          <p className="muted set__small">上次备份时间：{formatTimestamp(settings.lastBackupAt, dateFormat)}</p>
        ) : (
          <p className="muted set__small">
            你还没有做过备份。备份是这份数据在硬盘损坏后唯一能留下的副本。
          </p>
        )}
      </section>

      {/* --- 导入历史 -------------------------------------------------------- */}
      <section className="card set__section" aria-labelledby="set-history-title">
        <div className="set__sectionHead">
          <Icon name="inbox" size={18} />
          <h2 className="card-title" id="set-history-title">
            导入历史
          </h2>
        </div>

        {batchesError ? (
          <div className="set__errorInline" role="alert">
            <Icon name="alert" size={16} />
            <span>{batchesError}</span>
            <div className="spacer" />
            <button type="button" className="btn btn-secondary btn-sm" onClick={reloadBatches}>
              {T.retry}
            </button>
          </div>
        ) : batchesLoading && batches === null ? (
          <div className="stack-sm" aria-hidden="true">
            <div className="skeleton set__skeletonRow" />
            <div className="skeleton set__skeletonRow" />
          </div>
        ) : (batches ?? []).length === 0 ? (
          <p className="muted set__small">
            还没有导入过任何文件。每次导入都会记录在这里，方便一步撤销。
          </p>
        ) : (
          <div className="set__tableWrap">
            <table className="table">
              <caption className="visually-hidden">已导入的文件及其交易数量</caption>
              <thead>
                <tr>
                  <th scope="col">文件</th>
                  <th scope="col">账单格式</th>
                  <th scope="col" className="num">
                    行数
                  </th>
                  <th scope="col" className="num">
                    已导入
                  </th>
                  <th scope="col" className="num">
                    已跳过
                  </th>
                  <th scope="col">导入时间</th>
                  <th scope="col">
                    <span className="visually-hidden">操作</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {(batches ?? []).map((batch) => (
                  <tr key={batch.id}>
                    <td className="truncate set__cellFile" title={batch.fileName}>
                      {batch.fileName}
                    </td>
                    <td>{importPresetLabel(batch.presetId)}</td>
                    <td className="num">{batch.rowCount}</td>
                    <td className="num">{batch.importedCount}</td>
                    <td className="num">{batch.skippedCount}</td>
                    <td className="set__cellDate">{formatTimestamp(batch.createdAt, dateFormat)}</td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        disabled={pending || batch.importedCount === 0}
                        onClick={() => void handleRollback(batch)}
                        aria-label={`回滚文件「${batch.fileName}」的导入`}
                      >
                        <Icon name="undo" size={14} />
                        回滚
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* --- 分类管理 -------------------------------------------------------- */}
      <section className="card set__section" aria-labelledby="set-cat-title">
        <div className="set__sectionHead">
          <Icon name="tag" size={18} />
          <h2 className="card-title" id="set-cat-title">
            分类管理
          </h2>
        </div>

        <p className="muted set__small">
          已经有交易在使用的分类不能直接删除。SpendWise
          会先问你要把这些交易转移到哪里，历史记录绝不会在你不知情的情况下被改写。
        </p>

        {pendingDelete ? (
          <div className="set__reassign" role="group" aria-labelledby="set-reassign-title">
            <p className="set__reassignTitle" id="set-reassign-title">
              <Icon name="alert" size={16} />
              「{categoryLabel(pendingDelete.category.name)}」仍在使用中
            </p>
            <p className="set__reassignBody">{pendingDelete.message}</p>
            <div className="field">
              <label className="field-label" htmlFor="set-reassign-target">
                把这 {pendingDelete.usageCount} {T.unitTransactions}转移到
              </label>
              <select
                id="set-reassign-target"
                className="select"
                value={pendingDelete.reassignTo ?? ''}
                onChange={(event) =>
                  setPendingDelete((previous) =>
                    previous === null
                      ? previous
                      : { ...previous, reassignTo: event.target.value === '' ? null : Number(event.target.value) }
                  )
                }
              >
                <option value="">留为未分类</option>
                {reassignOptions.map((category) => (
                  <option key={category.id} value={category.id}>
                    {categoryLabel(category.name)}
                  </option>
                ))}
              </select>
              <p className="field-hint">
                只列出{CATEGORY_TYPE_LABELS[pendingDelete.category.type]}分类，因为交易的类型不会因为转移而改变。
              </p>
            </div>
            <div className="set__reassignActions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setPendingDelete(null)}
                disabled={pending}
              >
                保留这个分类
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={pending}
                onClick={() => void handleCategoryDelete(pendingDelete.category, pendingDelete.reassignTo)}
              >
                转移并删除
              </button>
            </div>
          </div>
        ) : null}

        {categoriesError ? (
          <div className="set__errorInline" role="alert">
            <Icon name="alert" size={16} />
            <span>{categoriesError}</span>
            <div className="spacer" />
            <button type="button" className="btn btn-secondary btn-sm" onClick={reloadCategories}>
              {T.retry}
            </button>
          </div>
        ) : categoriesLoading && categories === null ? (
          <div className="stack-sm" aria-hidden="true">
            <div className="skeleton set__skeletonRow" />
            <div className="skeleton set__skeletonRow" />
            <div className="skeleton set__skeletonRow" />
          </div>
        ) : (
          <div className="set__catGroups">
            {renderCategoryList('expense', expenseCategories)}
            {renderCategoryList('income', incomeCategories)}
          </div>
        )}

        {categoryForm ? (
          <form className="set__catForm" onSubmit={handleCategorySubmit} noValidate>
            <h3 className="set__subHeading">
              {categoryForm.id === null ? '新建' : '编辑'}
              {CATEGORY_TYPE_LABELS[categoryForm.type]}分类
            </h3>

            <div className="field">
              <label className="field-label" htmlFor="set-cat-name">
                名称
              </label>
              <input
                id="set-cat-name"
                ref={categoryNameRef}
                className="input"
                maxLength={40}
                autoComplete="off"
                placeholder="例如：奶茶"
                value={categoryForm.name}
                aria-invalid={Boolean(categoryFieldErrors.name)}
                onChange={(event) => {
                  const value = event.target.value
                  setCategoryForm((previous) => (previous === null ? previous : { ...previous, name: value }))
                }}
              />
              {categoryFieldErrors.name ? <p className="field-error">{categoryFieldErrors.name}</p> : null}
            </div>

            <div className="field">
              <label className="field-label" htmlFor="set-cat-icon">
                图标
              </label>
              <div className="set__iconField">
                <span className="set__iconPreview" aria-hidden="true">
                  <Icon name={categoryForm.icon} size={16} />
                </span>
                <select
                  id="set-cat-icon"
                  className="select"
                  value={categoryForm.icon}
                  onChange={(event) => {
                    const value = event.target.value as IconName
                    setCategoryForm((previous) => (previous === null ? previous : { ...previous, icon: value }))
                  }}
                >
                  {CATEGORY_ICONS.map((icon) => (
                    <option key={icon} value={icon}>
                      {CATEGORY_ICON_LABELS[icon]}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <fieldset className="field">
              <legend className="field-label">颜色</legend>
              <div className="set__swatches">
                {CATEGORY_COLORS.map((color) => (
                  <label
                    key={color}
                    className={`set__swatch ${categoryForm.color === color ? 'is-active' : ''}`}
                    style={{ background: color }}
                  >
                    <input
                      type="radio"
                      name="set-cat-color"
                      value={color}
                      checked={categoryForm.color === color}
                      onChange={() =>
                        setCategoryForm((previous) => (previous === null ? previous : { ...previous, color }))
                      }
                    />
                    <span className="visually-hidden">使用这个颜色</span>
                  </label>
                ))}
              </div>
            </fieldset>

            {categoryFormError ? (
              <p className="set__formError" role="alert">
                <Icon name="alert" size={16} />
                <span>{categoryFormError}</span>
              </p>
            ) : null}

            <div className="set__catFormActions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setCategoryForm(null)}
                disabled={pending}
              >
                {T.cancel}
              </button>
              <button type="submit" className="btn btn-primary" disabled={pending}>
                {pending ? T.genericSaving : '保存分类'}
              </button>
            </div>
          </form>
        ) : null}
      </section>

      {/* --- 安全 ------------------------------------------------------------ */}
      <section className="card set__section" aria-labelledby="set-security-title">
        <div className="set__sectionHead">
          <Icon name="shield" size={18} />
          <h2 className="card-title" id="set-security-title">
            安全与本地数据
          </h2>
        </div>

        <ul className="set__facts">
          <li>你的全部数据都保存在这台电脑上的一个本地 SQLite 数据库文件里。</li>
          <li>不会向任何服务器发送数据。记账本没有账号、没有云同步，也没有任何使用统计上报。</li>
          <li>
            你现在看到的这个界面没有直接访问数据库的权限：所有读写都通过一组固定的、事先审查过的操作完成，界面上不会发出任何 SQL。
          </li>
          <li>
            数据库文件位于下方显示的应用数据目录。任何能登录这个 Windows 账户的人都可以读取它，请务必给 Windows 账户设置密码。
          </li>
          <li>汇率是唯一的联网功能：只有在你更新汇率时才会访问公开的汇率接口，交易、账户和预算数据永远不会被上传。</li>
        </ul>

        {dbError ? (
          <div className="set__errorInline" role="alert">
            <Icon name="alert" size={16} />
            <span>{dbError}</span>
            <div className="spacer" />
            <button type="button" className="btn btn-secondary btn-sm" onClick={reloadDb}>
              {T.retry}
            </button>
          </div>
        ) : dbLoading && dbInfo === null ? (
          <div className="stack-sm" aria-hidden="true">
            <div className="skeleton set__skeletonRow" />
            <div className="skeleton set__skeletonRow" />
          </div>
        ) : dbInfo ? (
          <>
            <dl className="set__factsList">
              <div className="set__fact">
                <dt>文件位置</dt>
                <dd className="set__path" title={dbInfo.path}>
                  {dbInfo.path}
                </dd>
              </div>
              <div className="set__fact">
                <dt>文件大小</dt>
                <dd>
                  {formatBytes(dbInfo.bytes)}{' '}
                  <span className="muted">（{dbInfo.bytes.toLocaleString('en-US')} 字节）</span>
                </dd>
              </div>
              <div className="set__fact">
                <dt>结构版本</dt>
                <dd>{dbInfo.schemaVersion}</dd>
              </div>
              <div className="set__fact">
                <dt>日志模式</dt>
                <dd>{journalModeLabel(dbInfo.journalMode)}</dd>
              </div>
              <div className="set__fact">
                <dt>外键约束</dt>
                <dd>{dbInfo.foreignKeys ? '已启用' : '已关闭'}</dd>
              </div>
              <div className="set__fact">
                <dt>记录数量</dt>
                <dd>
                  {dbInfo.accountCount} {T.unitAccounts} · {dbInfo.transactionCount} {T.unitTransactions} ·{' '}
                  {dbInfo.categoryCount} 个分类
                </dd>
              </div>
              <div className="set__fact">
                <dt>交易日期范围</dt>
                <dd>
                  {dbInfo.oldestTransactionDate && dbInfo.newestTransactionDate
                    ? `${formatDate(dbInfo.oldestTransactionDate, dateFormat)} 至 ${formatDate(dbInfo.newestTransactionDate, dateFormat)}`
                    : '还没有任何交易记录'}
                </dd>
              </div>
            </dl>

            <div className="set__actions">
              <button type="button" className="btn btn-secondary" onClick={() => void handleReveal()} disabled={pending}>
                <Icon name="database" size={16} />
                打开数据库所在文件夹
              </button>
            </div>
          </>
        ) : null}
      </section>

      {/* --- 示例数据 -------------------------------------------------------- */}
      <section className="card set__section" aria-labelledby="set-demo-title">
        <div className="set__sectionHead">
          <Icon name="inbox" size={18} />
          <h2 className="card-title" id="set-demo-title">
            示例数据
          </h2>
        </div>

        <p className="muted set__small">
          用来体验功能的示例账户和示例交易。示例数据只能加进一本空账本——账本里已经有内容时，SpendWise
          会直接拒绝，而不会把示例记录混进你的真实账目。清除示例数据时，只会删除由示例创建的记录，你自己记的交易不受影响。
        </p>

        <div className="set__actions">
          <button type="button" className="btn btn-secondary" onClick={() => void handleDemoSeed()} disabled={pending}>
            <Icon name="plus" size={16} />
            加载示例数据
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => void handleDemoClear()} disabled={pending}>
            <Icon name="trash" size={16} />
            清除示例数据
          </button>
        </div>

        <p className="muted set__small">
          {settings?.demoDataLoaded
            ? '当前数据库里已经加载了示例数据。'
            : '当前数据库里没有示例数据。'}
        </p>
      </section>

      {/* --- 关于 ------------------------------------------------------------ */}
      <section className="card set__section" aria-labelledby="set-about-title">
        <div className="set__sectionHead">
          <Icon name="info" size={18} />
          <h2 className="card-title" id="set-about-title">
            关于
          </h2>
        </div>

        {appError ? (
          <div className="set__errorInline" role="alert">
            <Icon name="alert" size={16} />
            <span>{appError}</span>
            <div className="spacer" />
            <button type="button" className="btn btn-secondary btn-sm" onClick={reloadApp}>
              {T.retry}
            </button>
          </div>
        ) : appLoading && appInfo === null && storeInfo === null ? (
          <div className="stack-sm" aria-hidden="true">
            <div className="skeleton set__skeletonRow" />
          </div>
        ) : (
          (() => {
            const info = appInfo ?? storeInfo
            if (info === null) return <p className="muted set__small">暂时无法获取版本信息。</p>
            return (
              <dl className="set__factsList">
                <div className="set__fact">
                  <dt>应用</dt>
                  <dd>
                    {T.appName}（{T.appNameEn}） {info.version}
                  </dd>
                </div>
                <div className="set__fact">
                  <dt>Electron</dt>
                  <dd>{info.electronVersion}</dd>
                </div>
                <div className="set__fact">
                  <dt>Chrome</dt>
                  <dd>{info.chromeVersion}</dd>
                </div>
                <div className="set__fact">
                  <dt>Node</dt>
                  <dd>{info.nodeVersion}</dd>
                </div>
                <div className="set__fact">
                  <dt>平台</dt>
                  <dd>
                    {info.platform}（{info.arch}）
                  </dd>
                </div>
                <div className="set__fact">
                  <dt>构建类型</dt>
                  <dd>{info.isPackaged ? '正式安装版本' : '开发版本'}</dd>
                </div>
                <div className="set__fact">
                  <dt>应用数据目录</dt>
                  <dd className="set__path" title={info.userDataPath}>
                    {info.userDataPath}
                  </dd>
                </div>
              </dl>
            )
          })()
        )}
      </section>

      <style>{SETTINGS_CSS}</style>
    </div>
  )
}

const SETTINGS_CSS = `
.set { display: flex; flex-direction: column; gap: var(--space-5); padding-bottom: var(--space-8); }
.set__head { display: flex; flex-direction: column; gap: 2px; }
.set__title { font-size: var(--text-2xl); font-weight: var(--weight-semibold); margin: 0; color: var(--text-primary); }
.set__sub { margin: 0; font-size: var(--text-sm); max-width: 76ch; }
.set__small { font-size: var(--text-xs); margin: 0; }
.set__example { color: var(--text-secondary); font-weight: var(--weight-medium); }
.set__subHeading { font-size: var(--text-sm); font-weight: var(--weight-semibold); margin: 0; color: var(--text-primary); }

.set__section { display: flex; flex-direction: column; gap: var(--space-4); }
.set__section--feature { box-shadow: var(--shadow-md); border-color: var(--border-strong); }
.set__sectionHead { display: flex; align-items: center; gap: var(--space-2); color: var(--text-secondary); }
.set__sectionHead h2 { color: var(--text-primary); }
.set__grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: var(--space-4); }
.set__skeletonRow { height: 46px; width: 100%; }

.set__error {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  border-color: var(--expense);
  color: var(--expense);
  font-size: var(--text-sm);
}
.set__errorInline {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background: var(--expense-subtle);
  color: var(--expense);
  font-size: var(--text-sm);
}

/* grouped sub-blocks inside the newer, denser sections */
.set__subBlock {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--bg-inset);
}
.set__notice {
  margin: 0;
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background: var(--warning-subtle);
  color: var(--warning);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
}
.set__expander { align-self: flex-start; }

/* display currency preview */
.set__preview {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-md);
  background: var(--bg-inset);
}
.set__previewValue { font-size: var(--text-lg); font-weight: var(--weight-semibold); color: var(--text-primary); }

/* switch — a real checkbox styled as one */
.set__toggles { display: flex; flex-direction: column; justify-content: center; gap: var(--space-4); }
.set__switch { display: flex; align-items: flex-start; gap: var(--space-2); cursor: pointer; }
.set__switch.is-disabled { opacity: 0.5; cursor: not-allowed; }
.set__switch input {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
}
.set__track {
  position: relative;
  width: 34px;
  height: 18px;
  margin-top: 1px;
  flex: 0 0 auto;
  border-radius: var(--radius-full);
  background: var(--border-default);
  transition: var(--transition-base);
}
.set__thumb {
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
.set__switch input:checked + .set__track { background: var(--accent); }
.set__switch input:checked + .set__track .set__thumb { transform: translateX(16px); }
.set__switch input:focus-visible + .set__track { outline: var(--ring-width) solid var(--ring); outline-offset: 2px; }
.set__switchText { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.set__switchLabel { font-size: var(--text-sm); font-weight: var(--weight-medium); color: var(--text-primary); }

/* rates */
.set__rateStatusHead { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap; }
.set__rateCell { font-family: var(--font-mono); font-size: var(--text-xs); white-space: nowrap; }
.set__rateForm { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: var(--space-3); align-items: start; }
.set__rateFormActions { display: flex; flex-wrap: wrap; gap: var(--space-3); grid-column: 1 / -1; }

/* settlement cycle */
.set__cyclePreview {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-inset);
}
.set__cycleHead { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.set__cycleLabelText { font-size: var(--text-lg); font-weight: var(--weight-semibold); color: var(--text-primary); }
.set__chip {
  padding: 1px var(--space-2);
  border-radius: var(--radius-full);
  background: var(--accent-subtle);
  color: var(--accent-text);
  font-size: var(--text-2xs);
  font-weight: var(--weight-medium);
}

/* appearance */
.set__themes { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: var(--space-3); border: 0; margin: 0; padding: 0; }
.set__theme {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-3);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-surface);
  cursor: pointer;
  transition: var(--transition-base);
}
.set__theme:hover { background: var(--bg-hover); }
.set__theme.is-active { border-color: var(--accent); background: var(--accent-subtle); }
.set__theme input { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; }
.set__theme input:focus-visible + .set__themeIcon { outline: var(--ring-width) solid var(--ring); outline-offset: 2px; border-radius: var(--radius-sm); }
.set__themeIcon { color: var(--text-secondary); display: grid; place-items: center; }
.set__theme.is-active .set__themeIcon { color: var(--accent-text); }
.set__themeText { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.set__themeLabel { display: flex; align-items: center; gap: var(--space-2); font-size: var(--text-sm); font-weight: var(--weight-medium); color: var(--text-primary); }

/* data */
.set__actions { display: flex; flex-wrap: wrap; gap: var(--space-3); }
.set__warning {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background: var(--warning-subtle);
  color: var(--warning);
}
.set__warningTitle { margin: 0; font-size: var(--text-sm); font-weight: var(--weight-semibold); }
.set__warningBody { margin: 2px 0 0; font-size: var(--text-xs); line-height: var(--leading-normal); }
.set__result {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background: var(--income-subtle);
  color: var(--income);
}
.set__resultTitle { margin: 0; font-size: var(--text-sm); font-weight: var(--weight-semibold); }
.set__result p { margin: 0; }
.set__path {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  word-break: break-all;
  color: var(--text-primary);
}

/* import history */
.set__tableWrap { overflow-x: auto; }
.set__cellFile { max-width: 260px; }
.set__cellDate { white-space: nowrap; }

/* categories */
.set__catGroups { display: flex; flex-direction: column; gap: var(--space-5); }
.set__catGroup { display: flex; flex-direction: column; gap: var(--space-2); }
.set__catGroupHead { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.set__catList { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: var(--space-2); margin: 0; padding: 0; list-style: none; }
.set__catRow {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--bg-surface);
}
.set__catIcon { display: grid; place-items: center; width: 26px; height: 26px; flex: 0 0 auto; border-radius: var(--radius-sm); background: var(--bg-inset); }
.set__catText { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1; }
.set__catName { font-size: var(--text-sm); color: var(--text-primary); }
.set__delete:hover:not(:disabled) { color: var(--expense); }

.set__reassign {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  border: 1px solid var(--warning);
  border-radius: var(--radius-md);
  background: var(--warning-subtle);
}
.set__reassignTitle { display: flex; align-items: center; gap: var(--space-2); margin: 0; font-size: var(--text-sm); font-weight: var(--weight-semibold); color: var(--warning); }
.set__reassignBody { margin: 0; font-size: var(--text-xs); color: var(--text-primary); }
.set__reassignActions { display: flex; justify-content: flex-end; gap: var(--space-3); flex-wrap: wrap; }

.set__catForm {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-4);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-inset);
}
.set__iconField { display: flex; align-items: center; gap: var(--space-2); }
.set__iconPreview {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  flex: 0 0 auto;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-default);
  background: var(--bg-surface);
  color: var(--text-secondary);
}
.set__swatches { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.set__swatch {
  position: relative;
  width: 26px;
  height: 26px;
  border-radius: var(--radius-full);
  border: 2px solid transparent;
  box-shadow: var(--shadow-xs);
  cursor: pointer;
}
.set__swatch.is-active { border-color: var(--text-primary); }
.set__swatch input { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); }
.set__swatch:focus-within { outline: var(--ring-width) solid var(--ring); outline-offset: 2px; }
.set__catFormActions { display: flex; justify-content: flex-end; gap: var(--space-3); }
.set__formError {
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

/* security / about fact lists */
.set__facts { display: flex; flex-direction: column; gap: var(--space-2); margin: 0; padding-left: var(--space-5); list-style: disc; }
.set__facts li { font-size: var(--text-sm); color: var(--text-secondary); }
.set__factsList { display: flex; flex-direction: column; gap: var(--space-2); margin: 0; }
.set__fact { display: flex; gap: var(--space-3); align-items: baseline; font-size: var(--text-sm); }
.set__fact dt { flex: 0 0 150px; color: var(--text-secondary); font-size: var(--text-xs); }
.set__fact dd { margin: 0; min-width: 0; color: var(--text-primary); }
@media (max-width: 620px) {
  .set__fact { flex-direction: column; gap: 2px; }
  .set__fact dt { flex: none; }
}
`
