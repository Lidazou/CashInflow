import { addDays } from '@shared/lib/dates'

/**
 * 模拟数据：一个留学生的两年生活 (v1.7.0)
 *
 * WHAT THIS IS
 * ------------
 * A DETERMINISTIC generator for a plausible study-abroad year: an allowance on the 5th of
 * every semester month, rent on the 1st, subscriptions, groceries and Grab rides, a
 * mid-semester trip, a longer holiday trip, money lent to a classmate and paid back, red
 * envelopes at Spring Festival and on a birthday, and a few months with one large
 * one-off purchase. It produces plain rows — no database, no services — so the shape of
 * the year can be tested directly and the same data can be written to the demo ledger.
 *
 * WHY A GENERATOR AND NOT A FIXTURE FILE
 * --------------------------------------
 * The sample ledger has to cover a year of life, teach every screen at once (K-line,
 * daily activity, budgets, subscriptions, statistics, transfers, multi-currency), and
 * stay under a megabyte. A hand-written fixture of 1,500 rows would be unmaintainable and
 * would drift from the schema; rules plus a seeded RNG stay consistent, and `seed` makes
 * the output reproducible so tests and screenshots do not move.
 *
 * THE RULES OF THIS PARTICULAR LIFE
 * ---------------------------------
 *   - Semesters are October–February and March–July. August and September are holidays.
 *   - Allowance ¥10,000 on the 5th, SEMESTER MONTHS ONLY. Holidays bring small irregular
 *     transfers from the parents instead — which is exactly the shape a student's account
 *     has, and exactly what the "spending against income" charts should show.
 *   - Rent ¥3,200 on the 1st, every month, holidays included (the room does not go away).
 *   - The month is spent down to nearly nothing: rent, subscriptions, two top-ups of the
 *     Malaysian card and the day-to-day spending consume the allowance. That is the
 *     brief — this student is 月光族 — and it is what makes the balance chart interesting
 *     rather than a rising line.
 *   - Money moves between the student's own accounts (transfers), and between the student
 *     and a classmate (a loan out, a repayment in). Both are the special cases the app
 *     has to render correctly, so both are present.
 *   - Every month is different: the daily spend varies, the merchants vary, the number of
 *     no-spend days varies, and some months carry an event.
 */

export interface GeneratedAccount {
  name: string
  type: 'cash' | 'bank' | 'wallet' | 'credit_card' | 'other'
  currency: string
  openingBalance: number
  color: string
  icon: string
  note: string
}

export interface GeneratedTransaction {
  accountName: string
  /** Positive magnitude in the account's currency, minor units. */
  amount: number
  type: 'income' | 'expense'
  categoryName: string | null
  date: string
  time: string | null
  merchant: string
  note: string | null
}

export interface GeneratedTransfer {
  fromAccount: string
  toAccount: string
  amount: number
  date: string
  time: string | null
  note: string
}

export interface GeneratedSubscription {
  name: string
  amount: number
  currency: string
  cycle: 'monthly' | 'yearly' | 'quarterly'
  nextChargeDate: string
  accountName: string
  categoryName: string
  note: string | null
}

export interface GeneratedBudget {
  categoryName: string | null
  limitAmount: number
  currency: string
}

export interface GeneratedRecurringRule {
  label: string
  type: 'income' | 'expense'
  amount: number
  accountName: string
  categoryName: string
  merchant: string
  frequency: 'monthly' | 'yearly'
  dayOfPeriod: number
  monthOfYear: number | null
}

export interface MonthSummary {
  key: string
  /** 'semester' | 'holiday' */
  term: 'semester' | 'holiday'
  allowance: number
  otherIncome: number
  /** Spending from the Chinese card and the wallet, CNY minor units. */
  expenseCny: number
  /** Spending from the Malaysian card, MYR minor units. */
  expenseMyr: number
  /** The two added together — indicative only; they are different currencies. */
  expense: number
  /**
   * What the Chinese card actually did this month: income, minus what was spent from it,
   * minus the transfers out of it. THIS is the number that says whether the month was
   * 月光 — `net` alone cannot, because the exchange and the wallet top-up leave the card
   * as transfers and would make every month look like it ended in surplus.
   */
  netCny: number
  /** Income minus the two expense figures, in mixed units. Indicative only. */
  net: number
  closingCny: number
  closingMyr: number
  closingWallet: number
  /** The largest single expense in the month, with its label. */
  largest: { amount: number; label: string } | null
  transactionCount: number
}

export interface StudentLife {
  accounts: GeneratedAccount[]
  transactions: GeneratedTransaction[]
  transfers: GeneratedTransfer[]
  subscriptions: GeneratedSubscription[]
  budgets: GeneratedBudget[]
  recurringRules: GeneratedRecurringRule[]
  months: MonthSummary[]
  /** Closing balance per account name, in its own currency. */
  closing: Record<string, number>
}

export interface StudentLifeOptions {
  /** First month covered, 'YYYY-MM'. */
  from: string
  /** Last month covered, 'YYYY-MM'. */
  to: string
  /** Fixed so the sample ledger is the same on every machine. */
  seed?: number
  /** Today, so the last month stops where real life stops. */
  today?: string
}

/* -------------------------------------------------------------------------- */
/* the rules of this life                                                     */
/* -------------------------------------------------------------------------- */

export const ALLOWANCE_AMOUNT = 1_000_000 // ¥10,000.00
export const ALLOWANCE_DAY = 5
export const RENT_AMOUNT = 320_000 // ¥3,200.00
/** Rent is paid on the 1st, to a landlord, from the Chinese card. */
/**
 * Rent is paid on the 6th — the day after the allowance lands.
 *
 * That is what a student on a monthly allowance actually does, and it is also what makes
 * the month able to end near zero: paying rent on the 1st means carrying a whole month's
 * rent in the account at all times, so the balance can never come back down to a few
 * hundred (which is exactly how this sample was reported as unrealistic in v1.7.1).
 */
export const RENT_DAY = 6
export const BIRTHDAY = { month: 3, day: 18 }
export const SPRING_FESTIVAL = '2026-02-17'
/** A month with a single expense at or above this is a "special" month. */
export const LARGE_EXPENSE_THRESHOLD = 200_000 // ¥2,000.00

/**
 * Semesters: October–February and March–July.
 *
 * The gap between the two is not a holiday — February and March are both semester months
 * — so the two long breaks of this life are August and September, when the parents stop
 * paying the monthly allowance and send smaller amounts instead.
 */
export function isSemesterMonth(month: number): boolean {
  return month >= 10 || month <= 7 ? month !== 8 && month !== 9 : false
}

export function termOf(month: number): 'semester' | 'holiday' {
  return isSemesterMonth(month) ? 'semester' : 'holiday'
}

/* -------------------------------------------------------------------------- */
/* deterministic randomness                                                   */
/* -------------------------------------------------------------------------- */

/** Mulberry32: small, fast, and identical on every platform. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Random = () => number

const between = (random: Random, low: number, high: number): number =>
  low + Math.floor(random() * (high - low + 1))

const pick = <T>(random: Random, items: readonly T[]): T => items[Math.floor(random() * items.length)]

/* -------------------------------------------------------------------------- */
/* dates                                                                      */
/* -------------------------------------------------------------------------- */

const pad = (value: number): string => String(value).padStart(2, '0')

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate()
}

function dateKey(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(Math.min(day, daysInMonth(year, month)))}`
}

function monthsBetween(from: string, to: string): Array<{ year: number; month: number }> {
  const [fromYear, fromMonth] = from.split('-').map(Number)
  const [toYear, toMonth] = to.split('-').map(Number)
  const out: Array<{ year: number; month: number }> = []
  let year = fromYear
  let month = fromMonth
  while (year < toYear || (year === toYear && month <= toMonth)) {
    out.push({ year, month })
    month += 1
    if (month > 12) {
      month = 1
      year += 1
    }
  }
  return out
}

/* -------------------------------------------------------------------------- */
/* the ordinary texture of a week                                             */
/* -------------------------------------------------------------------------- */

/** Where a student's money actually goes, with the range it lands in (MYR cents). */
const DAILY_SPEND: ReadonlyArray<{
  merchant: string
  category: string
  low: number
  high: number
  /** Time of day it tends to happen, as [fromHour, toHour]. */
  hours: [number, number]
  /** Relative frequency. */
  weight: number
}> = [
  { merchant: '食堂', category: 'Food', low: 800, high: 2200, hours: [11, 13], weight: 12 },
  { merchant: '麻辣烫', category: 'Food', low: 1500, high: 3800, hours: [17, 20], weight: 6 },
  { merchant: 'Grab', category: 'Transport', low: 900, high: 3200, hours: [7, 22], weight: 8 },
  { merchant: '711', category: 'Food', low: 500, high: 1800, hours: [8, 23], weight: 7 },
  { merchant: '超市采购', category: 'Food', low: 3500, high: 12000, hours: [15, 20], weight: 4 },
  { merchant: '奶茶', category: 'Food', low: 700, high: 1600, hours: [13, 18], weight: 6 },
  { merchant: 'KFC', category: 'Food', low: 1800, high: 3600, hours: [12, 20], weight: 4 },
  { merchant: '地铁', category: 'Transport', low: 300, high: 900, hours: [7, 21], weight: 9 },
  { merchant: '书店', category: 'Education', low: 2500, high: 9000, hours: [10, 18], weight: 2 },
  { merchant: '打印店', category: 'Education', low: 300, high: 2500, hours: [9, 19], weight: 3 },
  { merchant: '电影院', category: 'Entertainment', low: 1800, high: 4000, hours: [18, 22], weight: 2 },
  { merchant: '药房', category: 'Health', low: 1200, high: 6500, hours: [10, 20], weight: 2 },
  { merchant: '理发', category: 'Shopping', low: 2500, high: 6000, hours: [10, 19], weight: 1 },
  { merchant: 'Shopee', category: 'Shopping', low: 1500, high: 15000, hours: [20, 23], weight: 3 },
  { merchant: '话费充值', category: 'Bills', low: 3000, high: 5000, hours: [10, 20], weight: 1 }
]


/**
 * Spending that happens at HOME, in CNY, through the wallet.
 *
 * A student abroad still spends in their own currency: takeaway on Meituan, Taobao and
 * Pinduoduo parcels, phone top-ups, textbooks and printing, the occasional clothes and a
 * haircut. This stream is what turns the rest of the monthly allowance into spending
 * rather than into a growing balance — see the "what is left of the allowance" step.
 */
const HOME_SPEND: ReadonlyArray<{
  merchant: string
  category: string
  low: number
  high: number
  hours: [number, number]
  weight: number
}> = [
  { merchant: '美团外卖', category: 'Food', low: 1_800, high: 6_500, hours: [11, 21], weight: 14 },
  { merchant: '饿了么', category: 'Food', low: 1_600, high: 5_800, hours: [11, 22], weight: 8 },
  { merchant: '淘宝', category: 'Shopping', low: 2_500, high: 42_000, hours: [20, 23], weight: 9 },
  { merchant: '拼多多', category: 'Shopping', low: 900, high: 12_000, hours: [21, 23], weight: 5 },
  { merchant: '京东', category: 'Shopping', low: 3_000, high: 36_000, hours: [19, 23], weight: 4 },
  { merchant: '美团买菜', category: 'Food', low: 2_000, high: 9_000, hours: [16, 20], weight: 6 },
  { merchant: '话费充值', category: 'Bills', low: 3_000, high: 10_000, hours: [10, 20], weight: 2 },
  { merchant: '教材书店', category: 'Education', low: 2_800, high: 16_000, hours: [10, 19], weight: 3 },
  { merchant: '打印店', category: 'Education', low: 500, high: 4_000, hours: [9, 19], weight: 4 },
  { merchant: '网课平台', category: 'Education', low: 9_900, high: 39_900, hours: [20, 23], weight: 1 },
  { merchant: '视频网站充值', category: 'Entertainment', low: 1_500, high: 6_800, hours: [20, 23], weight: 2 },
  { merchant: '快递代收', category: 'Other', low: 200, high: 1_500, hours: [12, 19], weight: 3 },
  { merchant: '理发', category: 'Shopping', low: 3_000, high: 9_800, hours: [10, 19], weight: 1 },
  { merchant: '买药', category: 'Health', low: 1_500, high: 12_000, hours: [9, 21], weight: 2 }
]

/**
 * The events that make one month different from the next.
 *
 * Each is anchored to a month offset from the start so the sequence is stable, and they
 * cover everything the brief asks for: a large one-off purchase in several months, a
 * mid-semester trip in each semester, a holiday trip, a loan to a classmate and its
 * repayment, a refund, and a laptop that dies at the worst possible time.
 */
interface LifeEvent {
  /** 'YYYY-MM' */
  month: string
  kind: 'large' | 'trip' | 'loan' | 'loanRepaid' | 'refund' | 'deposit' | 'course'
  label: string
  amount: number
  category: string
  account: string
  day: number
  note: string | null
}

function buildEvents(months: Array<{ year: number; month: number }>): LifeEvent[] {
  const events: LifeEvent[] = []
  const key = (index: number): string => {
    const entry = months[Math.min(index, months.length - 1)]
    return `${entry.year}-${pad(entry.month)}`
  }
  const semesterIndexes = months
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => isSemesterMonth(entry.month))
    .map(({ index }) => index)

  /* --- large one-off purchases: the "something happened" months ------------- */
  const large: Array<[number, string, number, string, string]> = [
    [1, '换 MacBook', 620_000, 'Shopping', '招商银行信用卡'],
    [4, '牙科治疗', 248_000, 'Health', '招商银行信用卡'],
    [7, '回国机票', 356_000, 'Travel', '招商银行信用卡'],
    [10, '手机摔坏了', 289_000, 'Shopping', '招商银行信用卡'],
    [12, '租房押金', 320_000, 'Housing', '中国银行储蓄卡']
  ]
  for (const [index, label, amount, category, account] of large) {
    if (index >= months.length) continue
    events.push({
      month: key(index),
      kind: 'large',
      label,
      amount,
      category,
      account,
      day: 8 + (index % 12),
      note: '突发支出'
    })
  }

  /* --- trips: one per semester, one in the long holiday --------------------- */
  const tripMonths = semesterIndexes.filter((_, position) => position % 3 === 1)
  tripMonths.slice(0, 4).forEach((index, order) => {
    const holiday = order % 2 === 1
    events.push({
      month: key(index),
      kind: 'trip',
      label: holiday ? '假期旅行 · 清迈' : '期中假期 · 槟城',
      amount: holiday ? 268_000 : 148_000,
      category: 'Travel',
      account: '中国银行储蓄卡',
      day: holiday ? 12 : 18,
      note: holiday ? '假期出行：机票+住宿+吃饭' : '期中假期短途旅行'
    })
  })
  for (let index = 0; index < months.length; index += 1) {
    if (!isSemesterMonth(months[index].month) && index > 0 && index + 1 < months.length) {
      events.push({
        month: key(index),
        kind: 'trip',
        label: '暑假旅行 · 曼谷',
        amount: 312_000,
        category: 'Travel',
        account: '中国银行储蓄卡',
        day: 15,
        note: '暑假出行，父母额外给的钱'
      })
      break
    }
  }

  /* --- money lent to a classmate, and paid back ----------------------------- */
  if (months.length > 5) {
    events.push({
      month: key(3),
      kind: 'loan',
      label: '借给同学李明',
      amount: 120_000,
      category: 'Other',
      account: '中国银行储蓄卡',
      day: 21,
      note: '他说下个月还'
    })
    events.push({
      month: key(4),
      kind: 'loanRepaid',
      label: '李明还钱',
      amount: 120_000,
      category: 'Other',
      account: '中国银行储蓄卡',
      day: 16,
      note: '借款归还'
    })
  }

  /* --- a refund, because real ledgers have them ----------------------------- */
  if (months.length > 6) {
    events.push({
      month: key(6),
      kind: 'refund',
      label: 'Shopee 退款',
      amount: 18_900,
      category: 'Refund',
      account: '支付宝',
      day: 14,
      note: '尺码不对，退了'
    })
  }

  /* --- a language course, paid up front ------------------------------------- */
  if (semesterIndexes.length > 2) {
    const index = semesterIndexes[2]
    events.push({
      month: key(index),
      kind: 'course',
      label: '雅思冲刺班',
      amount: 168_000,
      category: 'Education',
      account: '中国银行储蓄卡',
      day: 6,
      note: '一次性付清'
    })
  }

  return events.sort((a, b) => (a.month === b.month ? a.day - b.day : a.month < b.month ? -1 : 1))
}

/* -------------------------------------------------------------------------- */
/* the generator                                                              */
/* -------------------------------------------------------------------------- */

export function generateStudentLife(options: StudentLifeOptions): StudentLife {
  const random = makeRandom(options.seed ?? 20_260_301)
  const months = monthsBetween(options.from, options.to)
  const events = buildEvents(months)

  const accounts: GeneratedAccount[] = [
    {
      name: '中国银行储蓄卡',
      type: 'bank',
      currency: 'CNY',
      openingBalance: 640_000,
      color: '#2563EB',
      icon: 'landmark',
      note: '家里打生活费的卡'
    },
    {
      name: 'Maybank 本地卡',
      type: 'bank',
      currency: 'MYR',
      openingBalance: 120_00,
      color: '#16A34A',
      icon: 'credit-card',
      note: '日常开销用，从国内卡转过来'
    },
    {
      name: '支付宝',
      type: 'wallet',
      currency: 'CNY',
      openingBalance: 86_000,
      color: '#0EA5E9',
      icon: 'wallet',
      note: '订阅和网购'
    },
    {
      name: '招商银行信用卡',
      type: 'credit_card',
      currency: 'CNY',
      openingBalance: 0,
      color: '#DC2626',
      icon: 'credit-card',
      note: '大额消费用，每月还款'
    }
  ]

  const transactions: GeneratedTransaction[] = []
  const transfers: GeneratedTransfer[] = []

  const spend = (entry: Omit<GeneratedTransaction, 'type'>): void => {
    transactions.push({ ...entry, type: 'expense' })
  }
  const earn = (entry: Omit<GeneratedTransaction, 'type'>): void => {
    transactions.push({ ...entry, type: 'income' })
  }

  const closing: Record<string, number> = {}
  for (const account of accounts) closing[account.name] = account.openingBalance

  const monthsOut: MonthSummary[] = []

  /*
    Money from home for a big purchase, queued for the month the BILL arrives.
    Filled while walking a month, drained at the start of the next one.
  */
  const pendingSubsidies: Array<{ month: string; label: string; amount: number }> = []

  /*
    THE TWO CURRENCIES, AND WHY THE LEDGER HAS AN "换汇" PAIR

    The allowance arrives in CNY; the student lives in MYR. The app refuses a transfer
    between accounts of different currencies — deliberately, because the two legs would
    not be equal without an invented rate — so the conversion is recorded the way a real
    user records it: an EXPENSE named 换汇 on the Chinese card, and an INCOME named
    换汇到账 on the Malaysian one, on the same day, for the same money at a fixed nominal
    rate. That keeps every transfer in the sample between accounts of one currency (which
    is what the app can actually represent), and it puts the exchange in the ledger where
    the user can see what moving money abroad costs them.
  */
  const CNY_TO_MYR = 0.6057
  const cnyToMyr = (cny: number): number => Math.round(cny * CNY_TO_MYR)

  /** One stream of day-to-day spending, in one account and one currency. */
  interface SpendStream {
    account: string
    entries: ReadonlyArray<{ merchant: string; category: string; low: number; high: number; hours: [number, number]; weight: number }>
  }

  const LOCAL_STREAM: SpendStream = { account: 'Maybank 本地卡', entries: DAILY_SPEND }
  const HOME_STREAM: SpendStream = { account: '支付宝', entries: HOME_SPEND }

  const streamWeight = (stream: SpendStream): number =>
    stream.entries.reduce((sum, entry) => sum + entry.weight, 0)

  const pickWeighted = (random: Random, stream: SpendStream): (typeof DAILY_SPEND)[number] => {
    let roll = random() * streamWeight(stream)
    for (const entry of stream.entries) {
      roll -= entry.weight
      if (roll <= 0) return entry
    }
    return stream.entries[0]
  }

  for (const { year, month } of months) {
    const key = `${year}-${pad(month)}`
    const semester = isSemesterMonth(month)
    const monthEvents = events.filter((event) => event.month === key)
    let allowance = 0
    let otherIncome = 0
    let expenseCny = 0
    let expenseMyr = 0
    let largest: { amount: number; label: string } | null = null
    const countBefore = transactions.length
    /** Where the Chinese card started the month, for the 月光 measurement at the end. */
    const openingCny = closing['中国银行储蓄卡'] ?? 0
    /*
      This month's cash flows, tracked as they happen, so the "spend what is left" step at
      the end can be sized from the month's INCOME rather than from the balance.

      That distinction is the difference between a student and a trust fund: sizing the
      spending from the balance spends the opening float too, which drains the account over
      a year and produced a negative balance by the thirteenth month in the first version
      of this generator.
    */
    let cashOutMonth = 0

    const note = (account: string, amount: number, sign: number): void => {
      closing[account] = (closing[account] ?? 0) + sign * amount
    }

    /* Money from home that arrives this month, for a purchase made last month. */
    for (const subsidy of pendingSubsidies.filter((entry) => entry.month === key)) {
      earn({
        accountName: '中国银行储蓄卡',
        amount: subsidy.amount,
        categoryName: 'Gift',
        date: dateKey(year, month, 7),
        time: '10:15',
        merchant: subsidy.label,
        note: '大额支出家里帮了一部分'
      })
      note('中国银行储蓄卡', subsidy.amount, 1)
      otherIncome += subsidy.amount
    }

    /* --- the 1st: rent, every month, holidays included ---------------------- */
    spend({
      accountName: '中国银行储蓄卡',
      amount: RENT_AMOUNT,
      categoryName: 'Housing',
      date: dateKey(year, month, RENT_DAY),
      time: '10:00',
      merchant: '房租',
      note: '月租 3200'
    })
    note('中国银行储蓄卡', RENT_AMOUNT, -1)
    expenseCny += RENT_AMOUNT
    cashOutMonth += RENT_AMOUNT
    largest = { amount: RENT_AMOUNT, label: '房租' }

    /* --- the 5th: the allowance, semester months only ----------------------- */
    if (semester) {
      earn({
        accountName: '中国银行储蓄卡',
        amount: ALLOWANCE_AMOUNT,
        categoryName: 'Salary',
        date: dateKey(year, month, ALLOWANCE_DAY),
        time: '09:12',
        merchant: '家里打生活费',
        note: '每月生活费'
      })
      note('中国银行储蓄卡', ALLOWANCE_AMOUNT, 1)
      allowance = ALLOWANCE_AMOUNT
    } else {
      /*
        Holidays: no allowance, and the parents' small transfers have to cover the rent as
        well as the living. Three or four of them, sized so rent plus a lean month fits —
        otherwise a holiday with no allowance simply goes into the red.
      */
      const count = between(random, 3, 4)
      for (let i = 0; i < count; i += 1) {
        const amount = between(random, 120_000, 200_000)
        const day = between(random, 3, daysInMonth(year, month))
        earn({
          accountName: '中国银行储蓄卡',
          amount,
          categoryName: 'Gift',
          date: dateKey(year, month, day),
          time: `${pad(between(random, 10, 21))}:${pad(between(random, 0, 59))}`,
          merchant: pick(random, ['妈妈转账', '爸爸转账', '家里转的', '微信转账']),
          note: '假期零用'
        })
        note('中国银行储蓄卡', amount, 1)
        otherIncome += amount
      }
    }

    /* --- birthday and Spring Festival, before the spending is sized --------- */
    if (month === BIRTHDAY.month) {
      for (const [label, amount, account, dayOffset] of [
        ['妈妈生日红包', 80_000, '中国银行储蓄卡', 0],
        ['爸爸生日红包', 50_000, '中国银行储蓄卡', 0],
        ['室友凑的蛋糕钱', 12_000, '支付宝', 1]
      ] as Array<[string, number, string, number]>) {
        earn({
          accountName: account,
          amount,
          categoryName: 'Gift',
          date: addDays(dateKey(year, month, BIRTHDAY.day), dayOffset),
          time: '12:30',
          merchant: label,
          note: '生日礼金'
        })
        note(account, amount, 1)
        otherIncome += amount
      }
    }
    if (key === SPRING_FESTIVAL.slice(0, 7)) {
      for (const [label, amount, account] of [
        ['爷爷奶奶压岁钱', 100_000, '中国银行储蓄卡'],
        ['外婆压岁钱', 60_000, '支付宝'],
        ['亲戚红包', 30_000, '支付宝']
      ] as Array<[string, number, string]>) {
        earn({
          accountName: account,
          amount,
          categoryName: 'Gift',
          date: SPRING_FESTIVAL,
          time: '19:00',
          merchant: label,
          note: '春节红包'
        })
        note(account, amount, 1)
        otherIncome += amount
      }
    }

    /* --- the month's events, charged where the brief says ------------------- */
    for (const event of monthEvents) {
      const date = dateKey(year, month, event.day)
      const time = `${pad(between(random, 9, 21))}:${pad(between(random, 0, 59))}`

      /*
        A big purchase on the card usually comes with help from home — and it comes in the
        month the BILL is paid, not the month of the purchase.

        The first version dated the subsidy in the purchase month and the repayment in the
        next one, so the card gained the subsidy and lost nothing for a month: four
        subsidies of ~¥2,000 each turned into a permanent addition to the balance. Parents
        sending the money just before the bill is also what actually happens.
      */
      if (event.kind === 'large' && event.account === '招商银行信用卡') {
        const subsidy = Math.round((event.amount * 0.7) / 100) * 100
        const next = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 }
        pendingSubsidies.push({
          month: `${next.year}-${pad(next.month)}`,
          label: `爸妈补贴${event.label.slice(0, 2)}`,
          amount: subsidy
        })
      }

      if (event.kind === 'loanRepaid' || event.kind === 'refund') {
        earn({ accountName: event.account, amount: event.amount, categoryName: event.category, date, time, merchant: event.label, note: event.note })
        note(event.account, event.amount, 1)
        otherIncome += event.amount
        continue
      }
      spend({ accountName: event.account, amount: event.amount, categoryName: event.category, date, time, merchant: event.label, note: event.note })
      note(event.account, event.amount, -1)
      if (event.account === '中国银行储蓄卡') cashOutMonth += event.amount
      if (event.account === '招商银行信用卡') {
        /* Credit, not cash: it leaves this account next month, as a repayment. */
        continue
      }
      expenseCny += event.amount
      if (!largest || event.amount > largest.amount) largest = { amount: event.amount, label: event.label }
    }

    /* --- the credit card bill from LAST month, paid on the 9th -------------- */
    /*
      The repayment is the one place the sample ledger shows a REAL transfer between two of
      the student's own accounts — same currency, both sides visible on the accounts page,
      and neither counted as spending. The card's purchases were charged to the card
      account last month; this month's cash pays for them.
    */
    const monthIndex = months.findIndex((entry) => entry.year === year && entry.month === month)
    const previous = monthIndex > 0 ? months[monthIndex - 1] : null
    const previousKey = previous ? `${previous.year}-${pad(previous.month)}` : null
    const previousCardSpend = previousKey
      ? transactions
          .filter((row) => row.accountName === '招商银行信用卡' && row.date.startsWith(previousKey))
          .reduce((sum, row) => sum + row.amount, 0)
      : 0
    if (previousCardSpend > 0) {
      transfers.push({
        fromAccount: '中国银行储蓄卡',
        toAccount: '招商银行信用卡',
        amount: previousCardSpend,
        date: dateKey(year, month, 9),
        time: '09:40',
        note: '信用卡还款'
      })
      note('中国银行储蓄卡', previousCardSpend, -1)
      /*
        The card's own side of the repayment. The DATABASE gets both legs from the transfer
        row, but this map is the generator's running picture of each account, and leaving
        the receiving side out made the credit card look like it was never repaid — the
        kind of off-by-one-account mistake that shows up as a card balance of minus fifteen
        thousand ringgit.
      */
      note('招商银行信用卡', previousCardSpend, 1)
      cashOutMonth += previousCardSpend
    }

    /* --- day-to-day living, in MYR ------------------------------------------ */
    /*
      Sized to a monthly target rather than left to chance: a student who spends whatever
      the dice say ends up with a negative balance in month three. The target varies by
      term and by month, which is where "every month is different" comes from — not from
      letting the generator run off the rails.
    */
    const localTarget = semester
      ? month === 12 || month === 5 || month === 6
        ? between(random, 240_000, 290_000) // exam months: campus, cheap
        : monthEvents.some((event) => event.kind === 'trip')
          ? between(random, 220_000, 280_000) // away, but the trip is its own line
          : between(random, 290_000, 370_000) // an ordinary month in Kuala Lumpur
      : between(random, 200_000, 270_000) // holidays: fewer Grab rides, still eating
    let localTotal = 0
    const localRows: GeneratedTransaction[] = []
    for (let day = 1; day <= daysInMonth(year, month) && localTotal < localTarget; day += 1) {
      const weekday = new Date(year, month - 1, day).getDay()
      const weekend = weekday === 0 || weekday === 6
      if (random() < (weekend ? 0.1 : 0.16)) continue
      const items = weekend ? between(random, 3, 5) : between(random, 2, 4)
      for (let i = 0; i < items && localTotal < localTarget; i += 1) {
        const entry = pickWeighted(random, LOCAL_STREAM)
        const amount = between(random, entry.low, entry.high)
        localRows.push({
          accountName: LOCAL_STREAM.account,
          amount,
          type: 'expense',
          categoryName: entry.category,
          date: dateKey(year, month, day),
          time: `${pad(between(random, entry.hours[0], entry.hours[1]))}:${pad(between(random, 0, 59))}`,
          merchant: entry.merchant,
          note: null
        })
        localTotal += amount
      }
    }
    transactions.push(...localRows)
    note('Maybank 本地卡', localTotal, -1)
    expenseMyr += localTotal
    for (const row of localRows) {
      if (!largest || row.amount > largest.amount) largest = { amount: row.amount, label: row.merchant }
    }

    /* --- funding the local card: the exchange, in two or three goes ---------- */
    /*
      Sized from the MYR total and rounded UP. Rounding to the nearest thousand left the
      local card drifting a few hundred ringgit into the red most months — the kind of bug
      that surfaces only as a balance nobody can explain.
    */
    const exchangeTotal = Math.max(80_000, Math.ceil(localTotal / CNY_TO_MYR / 1_000) * 1_000)
    const exchanges = exchangeTotal > 200_000 ? 3 : 2
    let exchanged = 0
    for (let i = 0; i < exchanges; i += 1) {
      const share = i === exchanges - 1 ? exchangeTotal - exchanged : Math.round(exchangeTotal / exchanges / 1000) * 1000
      if (share <= 0) continue
      exchanged += share
      const date = dateKey(year, month, [3, 16, 26][i] ?? 20)
      spend({
        accountName: '中国银行储蓄卡',
        amount: share,
        categoryName: 'Other',
        date,
        time: '11:20',
        merchant: '换汇',
        note: '换到本地卡'
      })
      note('中国银行储蓄卡', share, -1)
      expenseCny += share
      cashOutMonth += share
      earn({
        accountName: 'Maybank 本地卡',
        amount: cnyToMyr(share),
        categoryName: 'Other',
        date,
        time: '11:35',
        merchant: '换汇到账',
        note: `按 ${CNY_TO_MYR} 折算`
      })
      note('Maybank 本地卡', cnyToMyr(share), 1)
    }

    /* --- what is left of the allowance, spent at home ----------------------- */
    /*
      THIS IS WHAT MAKES THE MONTH END.

      Rent, the exchange and the subscriptions are the fixed shape of a month; whatever
      remains of the allowance goes into the wallet and is spent in CNY on food delivery,
      Taobao and textbooks, sized so the card finishes the month a `cushion` above where it
      started. Without this step the student accumulates tens of thousands they never
      spend, and the balance chart tells a story about nobody.

      The wallet is topped up by what the month actually needs (its own balance included),
      rather than by a round number that would leave a growing float behind.
    */
    const subscriptionTotal = 14_500 + 7_500 + 3_000 + (month === 1 ? 14_800 + 8_800 : 0)
    /*
      ---- SIZED AGAINST A TARGET END-OF-MONTH BALANCE, NOT AGAINST THE INCOME ----

      Two earlier versions got this wrong in opposite directions, and both looked like a
      different character:

        v1.7.0  sized the spending from the month's INCOME and left the balance alone, so
                every surplus (a subsidy from home, a cheap month) stayed put and the
                account climbed from ¥6,400 to ¥14,074 — a saver, not 月光.
        v1.7.1  sized it from the BALANCE with a floor of rent plus a month's exchange, so
                the account could never come below ~¥5,400 — still several thousand at month
                end, which is not what a student's account looks like on the 28th.

      What it actually looks like: rent goes out right after the allowance arrives, the rest
      is spent down over the month, and the month ends with a few hundred — or, in a tight
      month, with a few hundred OWED on the credit card. So the target is an ending balance
      of under ¥1,000, and there is no floor above that any more.
    */
    const floatTarget = semester ? between(random, 0, 60_000) : between(random, 0, 40_000)
    const walletBalance = closing['支付宝'] ?? 0
    const closingBeforeHome = closing['中国银行储蓄卡'] ?? 0
    const spendable = Math.max(0, closingBeforeHome - floatTarget)
    const homeTarget = Math.max(0, spendable - subscriptionTotal)
    /*
      A month that cannot cover its own fixed costs — the ones carrying last month's laptop
      on the credit card — tops the wallet up by exactly what the subscriptions need and no
      more. Savings absorb the difference, which is what actually happens to a student who
      buys a MacBook; the alternative, a forced minimum top-up, spends money the account
      does not have and drives the wallet negative.
    */
    /*
      Only ever move what the month will actually spend: a top-up larger than the wallet can
      get through leaves a growing float in the wallet instead of in the bank, which is the
      same bug wearing a different hat.
    */
    const walletTopUp =
      spendable > 0
        ? Math.max(0, Math.min(homeTarget + subscriptionTotal - walletBalance + 100, spendable))
        : /* a month that cannot spare anything still has to pay its subscriptions */
          Math.max(0, subscriptionTotal - walletBalance + 100)

    if (walletTopUp > 0) {
      transfers.push({
        fromAccount: '中国银行储蓄卡',
        toAccount: '支付宝',
        amount: walletTopUp,
        date: dateKey(year, month, 2),
        time: '12:05',
        note: '充值到支付宝'
      })
      note('中国银行储蓄卡', walletTopUp, -1)
      note('支付宝', walletTopUp, 1)
    }

    for (const [name, amount, day] of [
      ['ChatGPT Plus', 14_500, 8],
      ['Netflix', 7_500, 11],
      ['加速器', 3_000, 6]
    ] as Array<[string, number, number]>) {
      spend({
        accountName: '支付宝',
        amount,
        categoryName: 'Subscription',
        date: dateKey(year, month, day),
        time: '20:30',
        merchant: name,
        note: '订阅'
      })
      note('支付宝', amount, -1)
      expenseCny += amount
    }
    if (month === 1) {
      for (const [name, amount] of [
        ['哔哩哔哩大会员', 14_800],
        ['网易云音乐黑胶', 8_800]
      ] as Array<[string, number]>) {
        spend({
          accountName: '支付宝',
          amount,
          categoryName: 'Subscription',
          date: dateKey(year, month, 12),
          time: '21:05',
          merchant: name,
          note: '年费'
        })
        note('支付宝', amount, -1)
        expenseCny += amount
      }
    }

    let homeTotal = 0
    for (let day = 1; day <= daysInMonth(year, month) && homeTotal < homeTarget; day += 1) {
      const weekday = new Date(year, month - 1, day).getDay()
      const weekend = weekday === 0 || weekday === 6
      if (random() < (weekend ? 0.14 : 0.26)) continue
      const items = between(random, 2, 4)
      for (let i = 0; i < items && homeTotal < homeTarget; i += 1) {
        const entry = pickWeighted(random, HOME_STREAM)
        const amount = Math.min(between(random, entry.low, entry.high), Math.max(100, homeTarget - homeTotal))
        spend({
          accountName: HOME_STREAM.account,
          amount,
          categoryName: entry.category,
          date: dateKey(year, month, day),
          time: `${pad(between(random, entry.hours[0], entry.hours[1]))}:${pad(between(random, 0, 59))}`,
          merchant: entry.merchant,
          note: null
        })
        note(HOME_STREAM.account, amount, -1)
        homeTotal += amount
      }
    }
    expenseCny += homeTotal

    /*
      ---- THE TIGHT MONTH: A FEW HUNDRED ON THE CARD (花呗/信用卡) ----

      A student who runs out before the month does puts the rest on credit. Two or three
      times a year that is a takeaway order and a supermarket run in the last week, on the
      credit card, which then sits owed until the bill is paid on the 9th of the next month.

      Without this the sample's month always ended at exactly the bank balance, which is
      tidy and wrong: "月光" includes the month where the last week was on credit. The card
      account is allowed to be negative for the same reason a real one is — it is a credit
      line, not a bank account — and the debt stays under a few hundred.
    */
    const tight =
      homeTarget === 0 ||
      homeTotal >= homeTarget - 1_000 ||
      (closing['中国银行储蓄卡'] ?? 0) < 80_000
    if (tight && random() < 0.6) {
      const orders = between(random, 1, 2)
      for (let i = 0; i < orders; i += 1) {
        const amount = between(random, 8_000, 32_000)
        const day = daysInMonth(year, month) - between(random, 1, 6)
        spend({
          accountName: '招商银行信用卡',
          amount,
          categoryName: pick(random, ['Food', 'Shopping', 'Food']),
          date: dateKey(year, month, day),
          time: `${pad(between(random, 19, 23))}:${pad(between(random, 0, 59))}`,
          merchant: pick(random, ['美团外卖', '饿了么', '超市采购', '淘宝']),
          note: '这个月先刷卡'
        })
        note('招商银行信用卡', amount, -1)
      }
    }

    /*
      ---- A SHORT MONTH: THE PARENTS TOP IT UP ----

      Holidays have no allowance and the rent does not stop, so a month can genuinely come
      up short. What happens then — and what this adds — is one more transfer from home,
      sized to clear the gap and leave a small float. It keeps every account solvent without
      inventing a salary or a scholarship, and it is why the holiday months end under ¥1,000
      rather than at minus three thousand.
    */
    const closingNow = closing['中国银行储蓄卡'] ?? 0
    if (closingNow < 0) {
      const bail = -closingNow + between(random, 20_000, 120_000)
      earn({
        accountName: '中国银行储蓄卡',
        amount: bail,
        categoryName: 'Gift',
        date: dateKey(year, month, 26),
        time: '18:40',
        merchant: pick(random, ['妈妈又转了', '爸爸转账', '家里转的']),
        note: '这个月不太够'
      })
      note('中国银行储蓄卡', bail, 1)
      otherIncome += bail
    }

    monthsOut.push({
      key,
      term: semester ? 'semester' : 'holiday',
      allowance,
      otherIncome,
      expenseCny,
      expenseMyr,
      expense: expenseCny + expenseMyr,
      /*
        The Chinese card's OWN movement for the month, measured rather than derived. It is
        the honest 月光 figure: a month whose exchange and wallet top-up emptied the card
        reads as a loss here even though nothing was "spent" in the income-vs-expense
        sense, which is exactly the difference the sample ledger exists to teach.
      */
      netCny: (closing['中国银行储蓄卡'] ?? 0) - openingCny,
      net: allowance + otherIncome - expenseCny - expenseMyr,
      largest,
      transactionCount: transactions.length - countBefore,
      closingCny: closing['中国银行储蓄卡'] ?? 0,
      closingMyr: closing['Maybank 本地卡'] ?? 0,
      closingWallet: closing['支付宝'] ?? walletBalance
    })
  }

  /* --- subscriptions, budgets and reminders: the rest of the app's screens -- */
  const lastMonth = months[months.length - 1]
  const nextMonth = lastMonth.month === 12 ? { year: lastMonth.year + 1, month: 1 } : { year: lastMonth.year, month: lastMonth.month + 1 }
  const nextCharge = (day: number): string => dateKey(nextMonth.year, nextMonth.month, day)

  const subscriptions: GeneratedSubscription[] = [
    { name: 'ChatGPT Plus', amount: 14_500, currency: 'CNY', cycle: 'monthly', nextChargeDate: nextCharge(8), accountName: '支付宝', categoryName: 'Subscription', note: '每月 8 号' },
    { name: 'Netflix', amount: 7_500, currency: 'CNY', cycle: 'monthly', nextChargeDate: nextCharge(11), accountName: '支付宝', categoryName: 'Subscription', note: null },
    { name: '加速器', amount: 3_000, currency: 'CNY', cycle: 'monthly', nextChargeDate: nextCharge(6), accountName: '支付宝', categoryName: 'Subscription', note: '打游戏和查资料用' },
    { name: '哔哩哔哩大会员', amount: 14_800, currency: 'CNY', cycle: 'yearly', nextChargeDate: dateKey(nextMonth.year + 1, 1, 12), accountName: '支付宝', categoryName: 'Subscription', note: '年费，1 月扣' },
    { name: '网易云音乐黑胶', amount: 8_800, currency: 'CNY', cycle: 'yearly', nextChargeDate: dateKey(nextMonth.year + 1, 1, 12), accountName: '支付宝', categoryName: 'Subscription', note: '年费' }
  ]

  const budgets: GeneratedBudget[] = [
    { categoryName: 'Food', limitAmount: 240_000, currency: 'CNY' },
    { categoryName: 'Transport', limitAmount: 60_000, currency: 'CNY' },
    { categoryName: 'Shopping', limitAmount: 80_000, currency: 'CNY' },
    { categoryName: 'Entertainment', limitAmount: 40_000, currency: 'CNY' },
    { categoryName: 'Education', limitAmount: 50_000, currency: 'CNY' },
    { categoryName: null, limitAmount: 900_000, currency: 'CNY' }
  ]

  const recurringRules: GeneratedRecurringRule[] = [
    { label: '房租', type: 'expense', amount: RENT_AMOUNT, accountName: '中国银行储蓄卡', categoryName: 'Housing', merchant: '房租', frequency: 'monthly', dayOfPeriod: RENT_DAY, monthOfYear: null },
    { label: '生活费', type: 'income', amount: ALLOWANCE_AMOUNT, accountName: '中国银行储蓄卡', categoryName: 'Salary', merchant: '家里打生活费', frequency: 'monthly', dayOfPeriod: ALLOWANCE_DAY, monthOfYear: null },
    { label: 'ChatGPT Plus', type: 'expense', amount: 14_500, accountName: '支付宝', categoryName: 'Subscription', merchant: 'ChatGPT Plus', frequency: 'monthly', dayOfPeriod: 8, monthOfYear: null }
  ]

  return {
    accounts,
    transactions: transactions.sort((a, b) => (a.date === b.date ? (a.time ?? '').localeCompare(b.time ?? '') : a.date < b.date ? -1 : 1)),
    transfers,
    subscriptions,
    budgets,
    recurringRules,
    months: monthsOut,
    closing
  }
}

/** The window the sample ledger covers: the last thirteen whole months up to `today`. */
export function defaultDemoWindow(today: string): { from: string; to: string } {
  const [year, month] = today.split('-').map(Number)
  let fromYear = year
  let fromMonth = month - 12
  while (fromMonth <= 0) {
    fromMonth += 12
    fromYear -= 1
  }
  return { from: `${fromYear}-${pad(fromMonth)}`, to: `${year}-${pad(month)}` }
}
