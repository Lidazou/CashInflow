/**
 * Interface text, in Simplified Chinese.
 *
 * WHY A PLAIN MODULE AND NOT AN i18n LIBRARY
 * -----------------------------------------
 * The app ships in one language. A library such as i18next would add a runtime
 * dependency, a provider, hooks and a bundle of message catalogues to solve a
 * problem this app does not have. What it does need is:
 *
 *   1. One place where every user-visible string lives, so nothing is hardcoded
 *      in a component where it cannot be found or reviewed.
 *   2. A stable way to look up a label for a database value — categories are
 *      stored as English identifiers ('Food', 'Salary') and must render in
 *      Chinese without rewriting anyone's existing data.
 *
 * That is all this file is. If a second language is ever added, the lookups
 * already go through functions, so the change is confined here.
 *
 * TERMINOLOGY
 * -----------
 * Chosen for a Chinese student managing money abroad:
 *   记账 / 账户 / 交易 / 余额 / 预算
 *   结余 (remaining for the period) is deliberately distinct from 余额 (account
 *   balance) — conflating them is the single most confusing thing a finance app
 *   can do.
 *   结算周期 for the settlement cycle, 统计区间 for a custom statistics range.
 */

/** Category names as seeded in the database, mapped to Chinese. */
const CATEGORY_NAMES: Record<string, string> = {
  // Expense
  Food: '餐饮',
  Transport: '交通',
  Shopping: '购物',
  Housing: '住房',
  Entertainment: '娱乐',
  Education: '教育',
  Health: '医疗',
  Travel: '旅行',
  Bills: '账单',
  Subscription: '订阅',
  Other: '其他',
  // Income
  Salary: '工资',
  Freelance: '兼职',
  Investment: '投资',
  Gift: '礼金',
  Refund: '退款'
}

/**
 * Render a category name in Chinese.
 *
 * The database stores the English identifier, so this is a display-only mapping:
 * existing transactions keep working, and a category the user created themselves
 * (which will not be in the map) falls back to its stored name unchanged.
 */
export function categoryLabel(name: string | null | undefined): string {
  if (!name) return '未分类'
  return CATEGORY_NAMES[name] ?? name
}

/** Reverse lookup, for matching a Chinese label back to a stored name. */
export function categoryStoredName(label: string): string {
  const found = Object.entries(CATEGORY_NAMES).find(([, chinese]) => chinese === label)
  return found ? found[0] : label
}

/** All seeded category labels in Chinese, for pickers and the manager. */
export function allCategoryLabels(): string[] {
  return Object.values(CATEGORY_NAMES)
}

/** Account types. */
const ACCOUNT_TYPES: Record<string, string> = {
  cash: '现金',
  bank: '银行卡',
  wallet: '电子钱包',
  credit_card: '信用卡',
  other: '其他'
}

export function accountTypeLabel(type: string): string {
  return ACCOUNT_TYPES[type] ?? type
}

export function allAccountTypeLabels(): Record<string, string> {
  return { ...ACCOUNT_TYPES }
}

/** Transaction types. */
const TRANSACTION_TYPES: Record<string, string> = {
  income: '收入',
  expense: '支出',
  transfer: '转账'
}

export function transactionTypeLabel(type: string): string {
  return TRANSACTION_TYPES[type] ?? type
}

/** Billing cycles for subscriptions. */
const BILLING_CYCLES: Record<string, string> = {
  weekly: '每周',
  monthly: '每月',
  quarterly: '每季度',
  semiannual: '每半年',
  yearly: '每年'
}

export function billingCycleLabel(cycle: string): string {
  return BILLING_CYCLES[cycle] ?? cycle
}

/** Recurrence frequencies. */
const FREQUENCIES: Record<string, string> = {
  weekly: '每周',
  monthly: '每月',
  yearly: '每年'
}

export function frequencyLabel(frequency: string): string {
  return FREQUENCIES[frequency] ?? frequency
}

/** Statement import presets. */
const IMPORT_PRESETS: Record<string, string> = {
  generic: '通用 CSV',
  wechat: '微信支付',
  alipay: '支付宝',
  maybank: 'Maybank（马来亚银行）',
  cimb: 'CIMB（联昌国际）'
}

export function importPresetLabel(id: string): string {
  return IMPORT_PRESETS[id] ?? id
}

/** Rate freshness, so a stale rate is never presented as current. */
const RATE_FRESHNESS: Record<string, string> = {
  fresh: '刚刚更新',
  today: '今日汇率',
  recent: '近期汇率',
  stale: '汇率已过期',
  manual: '手动汇率',
  missing: '暂无汇率'
}

export function rateFreshnessLabel(freshness: string): string {
  return RATE_FRESHNESS[freshness] ?? freshness
}

/** Date formats offered in settings. */
const DATE_FORMATS: Record<string, string> = {
  'DD MMM YYYY': '日 月 年（26 9月 2026）',
  'DD/MM/YYYY': '日/月/年（26/09/2026）',
  'MM/DD/YYYY': '月/日/年（09/26/2026）',
  'YYYY-MM-DD': '年-月-日（2026-09-26）'
}

export function dateFormatLabel(format: string): string {
  return DATE_FORMATS[format] ?? format
}

/** Static interface text. Keys are referenced from components. */
export const T = {
  appName: '记账本',
  appNameEn: 'CashInflow',

  // Navigation
  navDashboard: '总览',
  navTransactions: '交易明细',
  navAccounts: '账户',
  navStatistics: '统计分析',
  navBudget: '预算',
  navSubscriptions: '订阅与周期',
  navSearch: '搜索',
  navSettings: '设置',
  navImport: '导入账单',

  // Actions
  add: '添加',
  addTransaction: '记一笔',
  edit: '编辑',
  delete: '删除',
  cancel: '取消',
  save: '保存',
  confirm: '确定',
  close: '关闭',
  back: '返回',
  retry: '重试',
  refresh: '刷新',
  export: '导出',
  search: '搜索',
  clear: '清除',
  today: '今天',
  thisMonth: '本月',
  previous: '上一个',
  next: '下一个',
  viewAll: '查看全部',
  loading: '加载中…',

  // Money and currency
  income: '收入',
  expense: '支出',
  net: '结余',
  remaining: '本期结余',
  balance: '账户余额',
  totalBalance: '总余额',
  amount: '金额',
  currency: '货币',
  displayCurrency: '显示货币',
  exchangeRate: '汇率',
  liveRate: '实时汇率',
  originalAmount: '原币金额',

  // Period
  settlementCycle: '结算周期',
  cycleStartDay: '每月起始日',
  currentCycle: '当前周期',
  daysRemaining: '剩余天数',
  customRange: '自定义区间',
  from: '开始',
  to: '结束',
  periodTotal: '周期总额',

  // Dashboard period switcher. Three modes, named for the QUESTION each answers
  // rather than for the mechanism, so the choice is obvious without reading help.
  dashPeriodTitle: '统计周期',
  dashPeriodNatural: '自然月',
  dashPeriodCycle: '结算周期',
  dashPeriodCustom: '自定义区间',
  dashPeriodNaturalHint: '按日历月统计，1 日到月末。',
  dashPeriodCycleHint: '按你设置的每月起始日统计，贴合生活费到账时间。',
  dashPeriodCustomHint: '任意选择起止日期，或套用下面保存过的区间。',
  dashPeriodNaturalSub: '自然月结算',
  dashPeriodCustomSub: '自定义起止日期',
  dashPeriodPast: '已结束',
  dashPeriodCustomPick: '选择区间',
  dashPeriodSaved: '已保存的区间',
  dashPeriodSavedNone: '还没有保存过区间。',
  dashPeriodApply: '应用',
  dashPeriodQuick: '快捷选择',
  dashPeriodBudget: '区间总金额',
  dashPeriodBudgetHint: '填一个总金额，就能看到还剩多少。',
  dashPeriodBudgetLeft: '剩余',
  dashPeriodBudgetOver: '已超支',
  dashPeriodSwitchFailed: '统计周期切换失败：',
  /**
   * Shown in the donut centre when the selected period contains no transactions.
   *
   * A zero net and a failed query look identical on screen, so the empty case is
   * named rather than rendered as a large ¥ 0.00.
   */
  dashPeriodNoActivity: '本周期无收支',
  /** Prefix for the account balance line inside the donut centre. */
  dashBalanceShort: '余额',

  // K-line chart (资金流水 K 线)
  klineTitle: '资金 K 线',
  klineToggleToChart: '切换到 K 线图',
  klineToggleToDonut: '切换到圆环图',
  klineBalance: '余额',
  /** Signed change in balance for the hovered candle. */
  klineChange: '变动',
  klineHoverHint: '把鼠标移到图上任意一天，查看当天的交易明细；滚轮缩放，按住拖动平移。',
  klineResetZoom: '显示全部',
  klineNoData: '还没有可绘制的记录',
  /** Drawn on the chart when the balance never moved in the visible window. */
  klineFlat: '这段时间内余额没有变化',
  klineUnnamed: '未命名交易',
  klineCandleLegend: 'K 线：实体为当日余额涨跌，影线为当日余额最高与最低',
  klineFlowLegend: '柱状：向上为收入，向下为支出',
  klineMaUnavailable: '均线需要更多数据才会出现',
  /** Panel captions. The two panels are separate plot areas and are labelled as such. */
  klineBalancePanel: '余额 K 线',
  klineActivityFlow: '现金活动 · 收入 / 支出',
  klineActivityCount: '现金活动 · 交易笔数',
  /** Hover card titles. */
  klineTooltipCandle: 'K 线',
  klineTooltipTransaction: '交易',
  klineTooltipOpen: '开',
  klineTooltipHigh: '高',
  klineTooltipLow: '低',
  klineTooltipClose: '收',
  klineTooltipNet: '净变动',
  klineTooltipIncome: '收入',
  klineTooltipExpense: '支出',
  klineTooltipCount: '交易',
  klineTooltipBalanceBefore: '交易前余额',
  klineTooltipBalanceAfter: '交易后余额',
  klineTooltipTimeUnknown: '时间未记录',
  klineZoomHint: '滚轮缩放（以鼠标位置为中心）· 拖动平移 · 双击显示全部',
  /** Shown when the reader zooms in far enough that the day would need splitting. */
  klineNoTimeNotice: '这些记录没有交易时间，最细只能看到「日」。',

  // Empty and error
  noData: '暂无数据',
  failedToLoad: '加载失败',
  noChangesMade: '未做任何改动。',

  // Onboarding
  welcomeTitle: '欢迎使用',
  welcomeBody: '先添加一笔交易，开始记录你的收支。',

  // Add / edit transaction dialog
  txdTitleCreate: '记一笔',
  txdTitleEdit: '编辑交易',
  txdTitleCreateTransfer: '记一笔转账',
  txdTitleEditTransfer: '编辑转账',
  txdKindLabel: '交易类型',
  txdCloseDialog: '关闭对话框',
  txdAccount: '账户',
  txdFromAccount: '从',
  txdToAccount: '到',
  txdCategory: '分类',
  txdDate: '日期',
  txdTime: '时间',
  txdMerchant: '商家',
  txdNote: '备注',
  txdOptional: '（可选）',
  txdSelectAccount: '请选择账户…',
  txdAmountPlaceholder: '0.00',
  txdMerchantPlaceholder: '例如：餐厅、Grab、工资',
  txdNotePlaceholder: '例如：和朋友吃饭',
  txdTransferNotePlaceholder: '例如：ATM 取现',
  txdStoredAs: '存储为',
  txdShownAs: '列表显示为',
  txdYesterday: '昨天',
  txdDayBefore: '前天',
  txdApprox: '约',
  txdApproxHint: '（按实时汇率，仅作参考）',
  txdTransferHint: '转账只是在你自己的账户之间转移资金，会改变各账户余额，但不会计入收入或支出。',
  txdSaving: '保存中…',
  txdSaveTransaction: '保存交易',
  txdSaveTransfer: '保存转账',
  txdSaveChanges: '保存修改',
  txdErrAmountRequired: '请输入金额。',
  txdErrAmountInvalid: '请输入有效金额，例如 18.50。',
  txdErrAmountPositive: '金额必须大于 0。',
  txdErrAccountRequired: '请选择账户。',
  txdErrToAccountRequired: '请选择转入账户。',
  txdErrSameAccount: '转出和转入账户不能相同。',
  txdErrDateRequired: '请选择日期。',
  txdErrFixFields: '请修正标出的字段。',
  txdErrSaveFailed: '保存失败，未做任何改动。',
  txdSavedTransaction: '交易已保存。',
  txdUpdatedTransaction: '交易已更新。',
  txdSavedTransfer: '转账已记录。',
  txdUpdatedTransfer: '转账已更新。',

  // Transactions list
  txpTitle: '交易明细',
  txpSubtitle: '按日期分组的全部交易记录。',
  txpClearAccountFilter: '清除账户筛选',
  txpAddTransaction: '添加交易',
  txpPrevPeriod: '上一个周期',
  txpNextPeriod: '下一个周期',
  txpSearchLabel: '搜索交易',
  txpSearchPlaceholder: '搜索商家、备注、分类或账户…',
  txpType: '类型',
  txpAllTypes: '全部类型',
  txpCategory: '分类',
  txpAllCategories: '全部分类',
  txpDayTotal: '当日合计',
  txpTransfer: '转账',
  txpTransaction: '交易',
  txpTransferOnly: '仅转账',
  txpOtherAccount: '其他账户',
  txpViewDetail: '查看详情',
  txpNoMatch: '暂无符合条件的交易。',
  txpWidenFilters: '试试放宽筛选条件或切换其他月份。',
  txpEmptyPeriod: '本月还没有任何记录。',
  txpLoadFailed: '交易列表加载失败。',
  txpDeletedTransaction: '交易已删除。',
  txpDeletedTransfer: '转账已删除。',
  txpConfirmDeleteTransfer: '确定删除这笔转账？两个账户的余额都会更新。',
  txpRatesMissing: '尚未获取汇率，金额按原币显示。',
  txpUpdatingRates: '更新中…',
  txpApproxHint: '部分金额暂无汇率，已按原币计入，合计可能不准确。',

  // Biggest expenses ranking
  bxpTitle: '支出排行',
  bxpSubtitle: '本周期内金额最大的单独支出，从大到小排列。',
  bxpPrevPeriod: '上一个周期',
  bxpNextPeriod: '下一个周期',
  bxpExporting: '导出中…',
  bxpSummary: '本周期合计',
  bxpMonthTotal: '本月合计',
  bxpListedCount: '已列入笔数',
  bxpAllListed: '本周期全部支出均已列入',
  bxpLargest: '最大一笔',
  bxpListedSum: '下方所列支出之和',
  bxpAllInPeriod: '本周期内记录的全部支出',
  bxpNothingYet: '暂无记录',
  bxpEmpty: '暂无本月支出记录。',
  bxpEmptyHint: '记录支出之后，金额最大的几笔会在这里排名。',
  bxpLoadFailed: '支出排行加载失败，未做任何改动。',
  bxpNoRate: '无汇率',
  bxpNoRateHint: '没有该币种的汇率，此处显示原币金额。',
  bxpViewDetail: '查看详情',

  // -------------------------------------------------------------------------
  // Shared fragments (accounts / search / budget / subscriptions pages)
  //
  // A few sentences must interpolate a value that is rendered as a React
  // element: an amount is always displayed by <Money>, which converts it exactly
  // once. Such sentences are split into fragments and composed in the component
  // rather than concatenated into a single string. Keys containing `{name}` are
  // substituted with a plain String.replace.
  // -------------------------------------------------------------------------
  genericOptional: '可选',
  genericCloseDialog: '关闭对话框',
  genericSaving: '保存中…',
  genericDeleting: '删除中…',
  genericExporting: '导出中…',
  genericRemaining: '剩余',
  unitTransactions: '笔交易',
  unitAccounts: '个账户',
  unitCurrencies: '种货币',
  unitItems: '条',
  nameLabel: '名称',
  typeLabel: '类型',
  accountLabel: '账户',
  categoryLabelText: '分类',
  noteLabel: '备注',

  // --- Accounts page -------------------------------------------------------
  accSubtitle: '每个余额都由该账户下的交易记录推导得出。',
  accBalancesByCurrency: '各币种余额',
  accNoActiveAccounts: '还没有可用账户，因此没有可汇总的余额。已归档账户不计入这些数字。',
  accCurrenciesNeverSummed: '不同货币不会直接相加，以上按实时汇率折算。',
  accBalancesNote: '期初余额加上已记录的全部交易。已归档账户不计入。',
  accYourAccounts: '你的账户',
  accLoadFailed: '账户加载失败。',
  accLoadFailedTitle: '你的账户无法加载。',
  accEmptyTitle: '暂无账户',
  accEmptyBody: '添加第一个账户，开始记录你的余额。',
  accAllArchived: '所有账户都已归档。取消归档即可重新使用，或添加新的账户。',
  accAdd: '添加账户',
  accAddTitle: '添加账户',
  accEditTitle: '编辑账户',
  accEditNamed: '编辑 {name}',
  accArchive: '归档',
  accUnarchive: '取消归档',
  accArchiveNamed: '归档 {name}',
  accUnarchiveNamed: '取消归档 {name}',
  accArchiveInstead: '改为归档',
  accArchived: '已归档',
  accDeleteNamed: '删除 {name}',
  accName: '账户名称',
  accNamePlaceholder: '例如：日常现金',
  accType: '类型',
  accCurrency: '货币',
  accStoredIn: '该账户的金额均以 {currency} 存储。',
  accOpeningBalance: '期初余额',
  accOpeningHint: '开始使用本应用之前该账户已有的金额。信用卡等账户可填写负数。',
  accOpeningPlaceholder: '0.00',
  accOpeningPrefix: '期初',
  accAddedOn: '添加于',
  accColor: '颜色',
  accColorGroup: '账户颜色',
  accColorNamed: '颜色 {color}',
  accNote: '备注',
  accNotePlaceholder: '任何值得记录的账户信息。',
  accBalanceLabel: '余额',
  accNameRequired: '请填写账户名称。',
  accNameTooLong: '账户名称不能超过 60 个字符。',
  accOpeningRequired: '请填写期初余额。账户从零开始时填 0。',
  accAmountInvalid: '请输入有效金额，例如 150.00。',
  accNoteTooLong: '备注不能超过 300 个字符。',
  accSaveFailed: '账户保存失败。',
  accAdded: '账户已添加。',
  accUpdated: '账户已更新。',
  accDeleted: '{name} 已删除。',
  accArchivedToast: '{name} 已归档。',
  accUnarchivedToast: '{name} 已取消归档。',
  accArchivedKeeping: '{name} 已归档，其 {n} 笔交易保持不变。',
  accDeleteTitle: '删除 {name}？',
  accDeleteWithTransactions:
    '该账户还有 {n} 笔交易，无法删除。请先删除或转移这些交易，或选择归档以隐藏该账户但保留记录。',
  accDeleteNoTransactions: '该账户没有任何交易，删除它不会影响其他数据。此操作无法撤销。',
  accArchiveKeepsEverything: '归档会将该账户从账户选择器和上方余额中隐藏，同时完整保留每一笔交易，不会删除任何数据。',
  accDeleteNeverRemovesTransactions:
    '删除账户永远不会删除交易记录。若仍有交易，请先归档该账户，或把交易转移到其他账户。',
  accDeleteConfirm: '删除账户',
  accDeleteFailed: '账户无法删除。',
  accAlreadyArchived: '已归档',

  // --- Search page ---------------------------------------------------------
  srchTitle: '搜索交易',
  srchAria: '搜索交易',
  srchSubtitle: '搜索你的交易记录 — 可按商家、备注、分类或账户搜索。',
  srchPlaceholder: '输入商家、备注、分类或账户进行搜索',
  srchFieldLabel: '搜索',
  srchHint: '输入即开始搜索。下方没有任何关键词和筛选条件时，不会执行搜索。',
  srchClearTerm: '清除搜索内容',
  srchFrom: '开始时间',
  srchTo: '结束时间',
  srchType: '类型',
  srchAllTypes: '全部类型',
  srchAccount: '账户',
  srchAllAccounts: '全部账户',
  srchCategory: '分类',
  srchAllCategories: '全部分类',
  srchMinAmount: '最低金额',
  srchMaxAmount: '最高金额',
  srchAnyAmount: '不限',
  srchAmountInvalid: '金额格式不正确。',
  srchAmountInvalidExample: '请输入有效金额，例如 {example}。',
  srchClearFilters: '清除筛选条件',
  srchClearAndSearch: '清除筛选条件并搜索',
  srchTotalsAria: '搜索结果合计',
  srchFoundPrefix: '共找到',
  srchShowingPrefix: '显示',
  srchNet: '净额',
  srchSearching: '搜索中…',
  srchResultsTitle: '搜索结果',
  srchResultsCaption: '共 {total} 笔符合条件的交易，当前显示 {shown} 笔，含分类、账户与金额。',
  srchAmountNotNumber: '有一个金额输入框不是有效数字，因此没有执行搜索。',
  srchFixAmount: '修正后即可看到结果。',
  srchNoMatchTitle: '没有找到符合条件的交易。',
  srchNoMatchBody: '试试放宽筛选条件。',
  srchFailed: '搜索失败。',
  srchFailedTitle: '搜索无法执行。',
  srchExport: '导出结果',
  srchExportFailed: 'CSV 导出失败。',
  srchDateColumn: '日期',
  srchMerchantColumn: '商家 / 说明',
  srchAmountColumn: '金额',
  srchRowActions: '行操作',
  srchOpenDetails: '查看交易详情',
  srchTransferTo: '转账 → {name}',
  srchConfirmDeleteTransfer: '删除这笔转账（{label}）？两个账户都会被更新，这笔钱将不再记为已转移。',
  srchConfirmDeleteTransaction: '删除「{label}」？此操作无法撤销。',
  srchTransferDeleted: '转账已删除。',
  srchTransactionDeleted: '交易已删除。',
  srchRatesMissing: '尚未获取汇率，折算金额暂不可用，金额仍按原币种显示。',
  srchFootnote:
    '收入与支出合计不含转账：在自有账户之间调动资金既不是收入也不是支出。每行金额按其所属账户的货币显示，并折算为 {currency}；转账仍会列出，便于查找和编辑。',

  // --- Budget page ---------------------------------------------------------
  budSubtitle: '按分类设置的每月限额。每次打开本页都会根据交易重新计算支出，因此数字始终与账本一致。',
  budCycleNav: '预算周期',
  budPrevCycle: '上一个周期',
  budNextCycle: '下一个周期',
  budCurrentCycle: '本周期',
  budLoadFailedTitle: '预算无法加载。',
  budOverallTitle: '本月预算',
  budOverallSubAll: '覆盖全部支出分类',
  budOverallSubNone: '尚未设置总预算',
  budEditOverall: '编辑预算',
  budSetOverall: '设置预算',
  budEmptyOverall: '还没有设置预算。设置每月限额，随时掌握还能花多少。',
  budTotal: '总预算',
  budSpent: '已花费',
  budPercentUsed: '已使用 {n}%',
  budOverallUsedPercent: '已使用总预算的 {n}%',
  budSitsInCategories: '位于分类预算中',
  budOverBy: '超出预算',
  budCategoryTitle: '分类预算',
  budCategoryField: '分类',
  budCategoryNote: '限额只统计支出交易。自有账户之间的转账永远不计入支出。',
  budAddCategory: '设置预算',
  budEmptyTitle: '还没有设置预算。',
  budEmptyBody: '设置每月限额，随时掌握还能花多少。',
  budDeletedCategory: '已删除的分类',
  budSpentOfLimit: '已花出，限额为',
  budEditNamed: '编辑「{label}」的预算',
  budDeleteNamed: '删除「{label}」的预算',
  budFormCreateTitle: '设置预算',
  budFormEditTitle: '编辑预算',
  budCloseForm: '关闭预算表单',
  budOverallOption: '总预算（全部支出分类）',
  budCategoryHint: '预算只能设置在支出分类上——对收入设置限额并不是预算。',
  budLimitLabel: '预算金额',
  budLimitPlaceholder: '例如 1500',
  budInCurrency: '以 {currency} 计',
  budStoredAs: '存储为',
  budAmountRequired: '请输入每月限额。',
  budAmountInvalid: '请输入有效金额，例如 1500 或 1500.50。',
  budLimitPositive: '限额必须大于零。',
  budCategoryTaken: '该分类已有预算。请直接编辑它，而不是再添加一个。',
  budFixFields: '请修正标红的字段。',
  budSaveFailed: '预算保存失败。未做任何改动。',
  budSaved: '预算已保存。',
  budUpdated: '预算已更新。',
  budDeleted: '预算已删除。',
  budDeleteConfirm: '删除「{label}」的预算？交易记录不受影响——只会移除每月限额。',
  budThisBudget: '这个预算',
  budRowAria: '{label}{period}的预算',
  budOverallAria: '{period}的总预算',

  // --- Subscriptions page --------------------------------------------------
  subTitle: '订阅与周期',
  subSubtitle: '记录会重复发生的扣款——流媒体、软件、云存储——让真实的每月开销清晰可见，而不是到账时才意外发现。',
  subAdd: '添加订阅',
  subLoadFailedTitle: '订阅无法加载。',
  subEstimateLabel: '预计每月经常性支出',
  subEstimateEmpty: '还没有启用的订阅，暂无可折算的每月支出。',
  subEstimateAcross: '共 {n} 个启用中的订阅，统一折算为一个月（每周 × 52 ÷ 12，每年 ÷ 12）。',
  subYearLabel: '一年合计',
  subYearNote: '这是估算，不是实际扣款',
  subSuggestedTitle: '建议记录的交易',
  subDueBadge: '{n} 条待处理',
  subRecheck: '重新检查',
  subAutoNote:
    '系统不会自动记账，只有你确认后才会写入账本：点击「添加交易」后才会记入账本，「跳过」只会把提醒推移到下一个日期。',
  subNothingDue: '目前没有到期的项目。到期提醒会在当天出现在这里，期间不会自动改动任何数据。',
  subAddTransaction: '添加交易',
  subSkip: '跳过',
  subDueToday: '到期',
  subOverdue: '逾期 {n} 天',
  subInDays: '还有 {n} 天',
  subAddForAria: '为 {name} 记录 {date} 的交易',
  subSkipAria: '跳过 {name}，移到下一个日期',
  subListTitle: '订阅',
  subActiveOfTotal: '{active} 个启用 / 共 {total} 个',
  subEmptyTitle: '还没有任何订阅。',
  subEmptyBody: '添加 ChatGPT、Apple Music 或云存储等周期性支出，了解真实的每月开销。',
  subAddFirst: '添加第一个订阅',
  subPaused: '已停用',
  subNextCharge: '下次扣款 {date}',
  subNoNextCharge: '尚未设置下次扣款日',
  subRulesTitle: '周期规则',
  subRulesNote: '你设置的规则只提供建议，永远不会自动记账。',
  subAddRule: '添加规则',
  subRulesEmpty: '还没有周期规则。为房租、工资或水电费添加一条，到期时本应用会提示你。',
  subRuleWeekly: '每{weekday} · 下次 {date}',
  subRuleMonthly: '每月 {day} 日 · 下次 {date}',
  subRuleYearly: '每年 {month}{day} 日 · 下次 {date}',
  subEditRuleAria: '编辑规则「{name}」',
  subDeleteRuleAria: '删除规则「{name}」',
  subFormAddTitle: '添加订阅',
  subFormEditTitle: '编辑订阅',
  subCloseForm: '关闭订阅表单',
  subAmount: '金额',
  subCurrency: '货币',
  subCycle: '计费周期',
  subNextChargeField: '下次扣款日',
  subAccountField: '关联账户',
  subCategoryField: '关联分类',
  subNotLinked: '不关联',
  subUncategorised: '未分类',
  subNamePlaceholder: '例如：ChatGPT Plus',
  subNotePlaceholder: '例如：每月 3 日扣款，与家人共用',
  subNextChargeHint: '如果不确定扣款日期，可以留空。',
  subActiveInEstimate: '启用——计入每月估算',
  subEnabled: '启用',
  subDueOn: '到期日',
  subStoredHint: '以最小货币单位存储——18.50 会精确保存为 1850。',
  subEquivalentHint: '约合每月',
  subSave: '保存',
  subRuleFormAddTitle: '添加周期规则',
  subRuleFormEditTitle: '编辑周期规则',
  subCloseRuleForm: '关闭规则表单',
  subLabelField: '名称',
  subLabelPlaceholder: '例如：房租',
  subAmountInCurrency: '金额（{currency}）',
  subSelectAccount: '请选择账户…',
  subFrequency: '频率',
  subTypeField: '类型',
  subWeekday: '星期',
  subDayOfMonth: '每月日期',
  subDayOfMonthHint: '设为 31 日的规则会在较短的月份落到当月最后一天。',
  subMonth: '月份',
  subNextDue: '下次到期日',
  subActiveSuggest: '启用——到期时提示我',
  subRuleSafety: '规则只提供建议。本应用会在到期日提示你，未确认前不会写入任何内容。',
  subNameRequired: '请填写订阅名称。',
  subLabelRequired: '请填写名称。',
  subAccountRequired: '请选择该规则记账使用的账户。',
  subAmountRequired: '请填写金额。',
  subAmountPositive: '金额必须大于零。',
  subNextDueRequired: '请选择下次到期日。',
  subFixFields: '请修正标红的字段。',
  subSaveFailed: '订阅保存失败。',
  subRuleSaveFailed: '周期规则保存失败。',
  subAdded: '订阅已添加。',
  subUpdated: '订阅已更新。',
  subDeleted: '订阅已删除。',
  subRuleAdded: '规则已添加。',
  subRuleUpdated: '规则已更新。',
  subRuleDeleted: '规则已删除。',
  subDeleteConfirm: '删除「{name}」？这只会移除这条记录，已经记入的交易不受影响。',
  subRuleDeleteConfirm: '删除周期规则「{label}」？由它生成的交易记录会保留。',
  subDueRecorded: '{name} 已记为{type}。',
  subSkippedTo: '已跳过。下次提醒 {date}。',
  subAmountInvalid: '请输入有效金额，例如 18.50。',

  // --- currency and conversion ------------------------------------------
  /** `{currency}` is replaced with the display currency code. */
  totalConverted: '按实时汇率折合为 {currency}',
  rateUpdated: '汇率已更新。',
  rateUpdateFailed: '汇率更新失败',
  noRatesYet: '尚未获取汇率。金额将以原币显示，你可以在设置中手动填写汇率。',
  noRateForPair: '暂无该货币对的汇率，已显示原币金额。',
  displayCurrencyHint: '只改变显示时的换算，不会修改任何已记录金额。',
  showOriginalCurrency: '同时显示原币金额',
  conversionNotePrefix: '已按实时汇率折算',

  // --- settlement cycle --------------------------------------------------
  cycleStartDayHint:
    '如果你每月 5 号收到生活费，就把起始日设为 5 日。这样「本月」指的是 8月5日 – 9月4日，而不是自然月，统计结果才和你的实际开销节奏一致。',
  cycleDayRangeNote:
    '起始日只能选择 1–28 日：选 29–31 日时，遇到没有该日期的月份（例如 2 月没有 31 日）周期长度会变化，同一笔交易可能落入不同周期。选择 28 日可保证每个周期长度一致。',

  // --- custom arbitrary period ------------------------------------------
  customPeriodSub: '任意选择一段时间，输入总金额，查看这段时间花得怎么样、还能撑多久。',
  // Renamed from a duplicate `periodTotal` — that key already means 周期总额 at
  // the top of this object, and two identical keys is a compile error.
  customPeriodTotal: '总金额',
  periodTotalHint: '填写后可以查看剩余额度和消耗进度。',
  dailyAverage: '日均支出',
  projectedTotal: '按此速度预计',
  projectedOver: '按当前速度会超出总金额',
  projectedUnder: '按当前速度不会超出',
  projectedEstimateOnly: '仅按当前速度线性估算',
  saveAsPreset: '保存为常用区间',
  savedPeriods: '已保存的统计区间',
  elapsedOfTotal: '已过 / 共',
  daysUnit: '天',
  countUnit: '笔',
  noExpensesInRange: '这段时间还没有支出记录。',
  rangeStart: '开始日期',
  rangeEnd: '结束日期',
  rangeName: '名称',
  deletePeriodConfirm: '删除这个统计区间？此操作不可撤销。'
} as const

/** '共 12 笔' — a transaction count, for a subtitle or a summary figure. */
export function txnCountLabel(count: number): string {
  return `共 ${count} 笔`
}

/** Shown when the list is capped: '只显示最近的 100 笔，共 320 笔，请缩小筛选范围。' */
export function txnTruncatedNotice(shown: number, total: number): string {
  return `只显示最近的 ${shown} 笔，共 ${total} 笔，请缩小筛选范围。`
}

/**
 * Confirmation before deleting one ordinary transaction.
 *
 * `window.confirm` renders plain text rather than JSX, so the amount arrives
 * already formatted by the caller — and still converted by `convertMinor`.
 */
export function deleteTransactionConfirm(amountText: string): string {
  return `确定删除这笔 ${amountText} 的交易？此操作无法撤销。`
}

/** Note under a capped ranking: '仅显示金额最大的 100 笔，仍有更多记录。' */
export function rankingCapNotice(limit: number): string {
  return `仅显示金额最大的 ${limit} 笔，仍有更多记录。`
}

/** Footnote when the ranking was capped: the total above still covers everything. */
export function rankingCapNote(limit: number, periodLabel: string): string {
  return `此处只列出金额最大的 ${limit} 笔支出；上方合计仍包含${periodLabel}的全部支出。`
}

/** Toast after a CSV export, e.g. '已导出 12 行。' */
export function exportedRowsNotice(rows: number): string {
  return `已导出 ${rows} 行。`
}

/**
 * Format a day-of-month for the cycle setting, e.g. "每月 5 日".
 * Handles the calendar-month case explicitly, because "每月 1 日" and "自然月"
 * are the same thing and users think of the latter.
 */
export function cycleStartDayLabel(day: number): string {
  if (day === 1) return '自然月（每月 1 日）'
  return `每月 ${day} 日`
}

/** Relative weekday labels, Monday-first, matching the app's default. */
export const WEEKDAYS_ZH = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'] as const
export const WEEKDAYS_ZH_SUN_FIRST = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const

/** Weekday header row honouring the start-of-week setting. */
export function weekdayHeaders(startOfWeek: 0 | 1): string[] {
  return startOfWeek === 1 ? [...WEEKDAYS_ZH] : [...WEEKDAYS_ZH_SUN_FIRST]
}

/** Short month label, e.g. "9月". */
export function monthLabelZh(monthIndex: number): string {
  return `${monthIndex + 1}月`
}

/** "2026年9月" from a 'YYYY-MM' key. */
export function monthKeyLabelZh(monthKey: string): string {
  const [year, month] = monthKey.split('-')
  if (!year || !month) return monthKey
  return `${year}年${Number(month)}月`
}

/**
 * A Chinese date heading for a day group, e.g. "9月26日 周六".
 *
 * Built here rather than from Intl.DateTimeFormat so the output is identical on
 * every machine regardless of installed ICU data — a grouped transaction list
 * whose headers shift wording between computers is a support burden.
 */
export function dateHeadingZh(date: string, format = 'DD MMM YYYY'): string {
  const year = date.slice(0, 4)
  const month = Number(date.slice(5, 7))
  const day = Number(date.slice(8, 10))
  if (!year || !month || !day) return date

  // getDay() on a local-midnight Date is the correct weekday for a local
  // calendar date; parsing as UTC would shift it for eastern timezones.
  const weekdayIndex = new Date(`${date}T00:00:00`).getDay()
  const weekday = WEEKDAYS_ZH_SUN_FIRST[weekdayIndex] ?? ''

  const includeYear = format === 'YYYY-MM-DD'
  const body = includeYear ? `${year}年${month}月${day}日` : `${month}月${day}日`
  return `${body} ${weekday}`
}

/** Relative day label: 今天 / 昨天 / 前天, else the Chinese date heading. */export function relativeDayZh(date: string, reference: string, format = 'DD MMM YYYY'): string {
  const toUtc = (value: string): number => Date.parse(`${value}T00:00:00Z`)
  const diff = Math.round((toUtc(reference) - toUtc(date)) / 86_400_000)
  if (diff === 0) return '今天'
  if (diff === 1) return '昨天'
  if (diff === 2) return '前天'
  if (diff === -1) return '明天'
  return dateHeadingZh(date, format)
}

/** Currency display label, e.g. "人民币 CNY". */
export function currencyLabelZh(code: string): string {
  const names: Record<string, string> = {
    CNY: '人民币',
    MYR: '马来西亚林吉特',
    USD: '美元',
    SGD: '新加坡元',
    HKD: '港币',
    EUR: '欧元',
    GBP: '英镑',
    JPY: '日元',
    KRW: '韩元',
    AUD: '澳元',
    CAD: '加元',
    TWD: '新台币',
    THB: '泰铢'
  }
  const name = names[code.toUpperCase()]
  return name ? `${name} ${code.toUpperCase()}` : code.toUpperCase()
}

/** "N 天" / "N 天后" phrasing used by the cycle and subscription views. */
export function daysLabelZh(days: number): string {
  if (days === 0) return '今天结束'
  if (days < 0) return `已过期 ${Math.abs(days)} 天`
  return `还有 ${days} 天`
}

/** '5 日起算' — the settlement-cycle sub-heading on the dashboard. */
export function cycleStartSubZh(day: number): string {
  return `${day} 日起算`
}

/** '共 31 天' — the custom-range sub-heading on the dashboard. */
export function periodDaysZh(days: number): string {
  return `共 ${days} 天`
}

/** '已过 12 / 31 天 · 还有 19 天' — progress through the selected period. */
export function periodProgressZh(elapsed: number, total: number): string {
  const remaining = Math.max(total - elapsed, 0)
  return `已过 ${elapsed} / ${total} 天 · 还有 ${remaining} 天`
}

/** '共 N 笔' — the tooltip header on the K-line chart. */
export function klineTxCount(count: number): string {
  return `共 ${count} 笔`
}

/** '还有 N 笔未显示' — the K-line tooltip's overflow line. */
export function klineMoreTx(count: number): string {
  return `还有 ${count} 笔未显示`
}
