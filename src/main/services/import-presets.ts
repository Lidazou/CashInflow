import type { CanonicalField, ImportPreset, ImportPresetId } from '@shared/types'

/**
 * Import presets.
 *
 * Each preset maps a provider's real column headers onto canonical fields.
 * Aliases are matched case-insensitively after stripping spaces, underscores and
 * punctuation (see `normaliseHeader`), so "Transaction Description",
 * "transaction_description" and "TransactionDescription" all resolve to one
 * alias entry.
 *
 * IMPORTANT: header positions DRIFT between exports. WeChat inserts a
 * "常见问题" help block in some versions and Alipay prepends a 24-line preamble
 * whose length varies, so `skipRows` is only a hint — the parser scans for the
 * row that actually looks like the header and falls back to `skipRows` if the
 * scan fails.
 *
 * These alias sets are based on published export layouts and community parser
 * implementations. They are the most likely to need adjustment against a real
 * statement, so all fields remain user-remappable in the preview step.
 */

/** Canonical field -> substrings that identify a matching header cell. */
type ColumnMap = Record<CanonicalField, string[]>

export const GENERIC_COLUMN_MAP: ColumnMap = {
  date: ['date', 'transactiondate', 'dateof', 'tarikh', '日期', '交易时间', '交易日期'],
  time: ['time', 'transactiontime', '时间'],
  description: ['description', 'details', 'transactiondescription', 'narrative', 'particulars', 'keterangan', '商品', '摘要', '交易对方', '商品说明'],
  amount: ['amount', 'transactionamount', 'value', 'jumlah', '金额', '金额(元)', '发生额'],
  debit: ['debit', 'debitamount', 'withdrawal', 'keluar', '支出', '借方'],
  credit: ['credit', 'creditamount', 'deposit', 'masuk', '收入', '贷方'],
  type: ['type', 'transactiontype', 'drcr', '交易类型', '收支', '收/支', '借贷标志'],
  category: ['category', 'kategori', '分类', '交易分类'],
  account: ['account', 'accountname', 'accountno', 'akaun', '账户', '支付方式', '收/付款方式'],
  note: ['note', 'notes', 'remarks', 'catatan', '备注', '说明'],
  status: ['status', 'state', '交易状态', '当前状态']
}

/** WeChat Pay personal bill export (微信支付账单明细). */
const WECHAT_COLUMN_MAP: ColumnMap = {
  // '交易时间' carries both date and time: '2026-09-26 14:05:00'
  date: ['交易时间'],
  time: ['交易时间'],
  // '交易对方' is the payee; '商品' is what was bought. Merchant prefers the payee.
  description: ['交易对方', '商品'],
  amount: ['金额(元)', '金额'],
  debit: [],
  credit: [],
  // '收/支' holds 收入 / 支出 / 不计收支.
  type: ['收/支', '交易类型'],
  category: ['交易类型'],
  account: ['支付方式'],
  note: ['备注', '商品'],
  status: ['当前状态']
}

/** Alipay bill export (支付宝电子客户回单). GBK encoded, 24-line preamble. */
const ALIPAY_COLUMN_MAP: ColumnMap = {
  date: ['交易时间'],
  time: ['交易时间'],
  description: ['交易对方', '商品说明'],
  amount: ['金额'],
  debit: [],
  credit: [],
  type: ['收/支'],
  category: ['交易分类'],
  account: ['收/付款方式'],
  note: ['备注', '商品说明'],
  status: ['交易状态']
}

/** Maybank / CIMB style statement: separate Debit and Credit columns, DD/MM/YYYY. */
const MAYBANK_COLUMN_MAP: ColumnMap = {
  date: ['date', 'tarikh', 'transactiondate', 'dateoftransaction', 'postingdate'],
  time: [],
  description: ['description', 'transactiondescription', 'details', 'particulars', 'keterangan'],
  amount: ['amount', 'jumlah'],
  debit: ['debit', 'debitamount', 'withdrawal', 'pengeluaran', 'keluar'],
  credit: ['credit', 'creditamount', 'deposit', 'depositamount', 'masuk'],
  type: ['type', 'drcr', 'transactiontype'],
  category: ['category', 'kategori'],
  account: ['account', 'accountno', 'akaun'],
  note: ['note', 'remarks', 'catatan', 'reference'],
  status: ['status']
}

const CIMB_COLUMN_MAP: ColumnMap = {
  ...MAYBANK_COLUMN_MAP,
  description: ['description', 'transactiondescription', 'details', 'particulars', 'keterangan', 'transactions']
}

export const IMPORT_PRESETS: Record<ImportPresetId, ImportPreset> = {
  generic: {
    id: 'generic',
    label: 'Custom CSV',
    description: 'Auto-detect the columns. Use this for any export not listed below.',
    skipRows: 0,
    encoding: 'auto',
    columnMap: GENERIC_COLUMN_MAP
  },
  wechat: {
    id: 'wechat',
    label: 'WeChat Pay',
    description: 'WeChat Pay bill export (微信支付账单明细). The header is located automatically.',
    // Real files vary; the parser scans for the real header rather than trusting this.
    skipRows: 16,
    encoding: 'auto',
    columnMap: WECHAT_COLUMN_MAP
  },
  alipay: {
    id: 'alipay',
    label: 'Alipay',
    description: 'Alipay bill export (支付宝电子客户回单). GBK encoded, 24-line preamble.',
    skipRows: 24,
    encoding: 'gb18030',
    columnMap: ALIPAY_COLUMN_MAP
  },
  maybank: {
    id: 'maybank',
    label: 'Maybank',
    description: 'Maybank statement export with separate Debit and Credit columns.',
    skipRows: 0,
    encoding: 'auto',
    columnMap: MAYBANK_COLUMN_MAP
  },
  cimb: {
    id: 'cimb',
    label: 'CIMB',
    description: 'CIMB statement export with separate Debit and Credit columns.',
    skipRows: 0,
    encoding: 'auto',
    columnMap: CIMB_COLUMN_MAP
  }
}

export const IMPORT_PRESET_LIST: ImportPreset[] = Object.values(IMPORT_PRESETS)

export function getPreset(id: ImportPresetId | string): ImportPreset {
  return IMPORT_PRESETS[id as ImportPresetId] ?? IMPORT_PRESETS.generic
}

/**
 * Header keywords used to locate the real header row when a preset's `skipRows`
 * is wrong (which is the normal case for WeChat and Alipay).
 */
export const HEADER_KEYWORDS: Record<ImportPresetId, string[]> = {
  generic: ['date', 'amount', 'description', 'debit', 'credit', 'type'],
  wechat: ['交易时间', '收/支', '金额', '交易对方'],
  alipay: ['交易时间', '收/支', '金额', '交易分类'],
  maybank: ['date', 'description', 'debit', 'credit', 'balance'],
  cimb: ['date', 'description', 'debit', 'credit', 'balance']
}

/**
 * WeChat `收/支` values that must NOT become income or expense.
 *
 * These are internal movements between the user's own accounts (topping up the
 * wallet, withdrawing to a bank, repaying a credit card, buying a wealth
 * product). Treating them as spending would double-count against the bank leg
 * that the user also imports, inflating both income and expense.
 *
 * MATCHED BY EQUALITY, NOT SUBSTRING. The literal string '收/支' is the column
 * HEADER, so a substring test against it would match every row and classify the
 * entire statement as neutral — silently importing nothing. Only an exact match
 * on the cell's own value counts as neutral.
 */
export const NEUTRAL_INCOME_EXPENSE_VALUES = [
  '不计收支',
  '/',
  '-',
  '',
  '中性交易',
  '转账',
  '已转账'
]

/**
 * Values that positively mean income / expense.
 *
 * CJK markers are matched as substrings because a statement may write '收入' or
 * '收入(工资)' and both mean income. English markers are matched on the whole
 * cell, because substring matching would make 'expense' match 'in' and
 * classify every row as income.
 *
 * 'salary' is included because the generic format's Type column is frequently
 * filled with the transaction nature rather than the word "income".
 */
export const INCOME_MARKERS: readonly string[] = ['收入', '收', '贷方', '贷', '存入', '转入', '退款', '利息']
export const INCOME_WORDS: readonly string[] = [
  'income',
  'in',
  'credit',
  'cr',
  'deposit',
  'salary',
  'inflow',
  '+'
]

export const EXPENSE_MARKERS: readonly string[] = ['支出', '支', '借方', '借', '转出', '消费', '扣款']
export const EXPENSE_WORDS: readonly string[] = [
  'expense',
  'out',
  'debit',
  'dr',
  'withdrawal',
  'outflow',
  'payment',
  '-'
]

/**
 * Classify a direction cell.
 *
 * Returns null when the cell carries no usable marker, letting the caller fall
 * back to the sign of the amount rather than inventing a direction.
 */
export function classifyDirection(raw: string): 'income' | 'expense' | null {
  const marker = raw.trim()
  if (marker === '') return null

  if (INCOME_MARKERS.some((value) => marker.includes(value))) return 'income'
  if (EXPENSE_MARKERS.some((value) => marker.includes(value))) return 'expense'

  const lower = marker.toLowerCase()
  if (INCOME_WORDS.includes(lower)) return 'income'
  if (EXPENSE_WORDS.includes(lower)) return 'expense'

  return null
}

/**
 * WeChat `交易类型` values that mirror a bank movement and must be neutralised.
 * Matched as substrings because some carry suffixes (e.g. '转入零钱通-某产品').
 */
export const NEUTRAL_TRANSACTION_TYPES = [
  '零钱充值',
  '零钱提现',
  '转入零钱通',
  '零钱通转出',
  '信用卡还款',
  '购买理财通',
  '财付通还款',
  '财付通',
  '微信红包(单发)' // a red packet sent to yourself is not an expense
]

/**
 * Alipay `交易状态` values that were never settled.
 * '交易关闭' means the order was cancelled; importing it would invent spending
 * that never happened. A refund instead arrives as its own row.
 */
export const ALIPAY_EXCLUDED_STATUS = ['交易关闭', '已关闭', '交易未确认']

/** Alipay statuses that indicate a refund and should import as income. */
export const ALIPAY_REFUND_STATUS = ['退款成功']
