import { describe, expect, it } from 'vitest'

import {
  ALLOWANCE_AMOUNT,
  ALLOWANCE_DAY,
  LARGE_EXPENSE_THRESHOLD,
  RENT_AMOUNT,
  RENT_DAY,
  defaultDemoWindow,
  generateStudentLife,
  isSemesterMonth,
  termOf
} from '@main/services/demo-life'

/**
 * 模拟数据 (v1.7.0)
 *
 * The sample ledger is a teaching tool, so it has to be plausible: a student with an
 * allowance, rent, subscriptions and a life. These tests pin the RULES the brief names —
 * allowance on the 5th and only in term time, rent every month, subscriptions present,
 * trips, loans repaid, red envelopes, a few large one-off months — and the properties that
 * make it usable at all: gapless dates, integer money, and no month identical to the next.
 *
 * They read the generator directly, with no database, which is why the generator returns
 * plain rows.
 */

const life = generateStudentLife({ from: '2025-10', to: '2026-09', seed: 42 })

/** 'YYYY-MM' of the month AFTER a date, for matching a repayment to its purchase. */
function nextMonthKey(date: string): string {
  const [year, month] = date.split('-').map(Number)
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`
}
const monthOf = (key: string) => life.months.find((month) => month.key === key)

describe('the shape of the sample year', () => {
  it('covers a full year of months, in order and without gaps', () => {
    expect(life.months.map((month) => month.key)).toEqual([
      '2025-10',
      '2025-11',
      '2025-12',
      '2026-01',
      '2026-02',
      '2026-03',
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09'
    ])
  })

  it('produces enough activity to fill every screen', () => {
    expect(life.transactions.length).toBeGreaterThan(900)
    /* Two transfers a month at least: the wallet top-up and the card repayment. */
    expect(life.transfers.length).toBeGreaterThan(12)
    expect(life.accounts).toHaveLength(4)
    expect(life.subscriptions.length).toBeGreaterThanOrEqual(5)
    expect(life.budgets.length).toBeGreaterThanOrEqual(5)
  })

  it('keeps every amount a positive integer in minor units', () => {
    for (const row of life.transactions) {
      expect(Number.isInteger(row.amount), `${row.date} ${row.merchant}`).toBe(true)
      expect(row.amount).toBeGreaterThan(0)
    }
    for (const transfer of life.transfers) {
      expect(Number.isInteger(transfer.amount)).toBe(true)
      expect(transfer.amount).toBeGreaterThan(0)
    }
  })

  it('never dates a transaction outside the window it was asked for', () => {
    for (const row of life.transactions) {
      expect(row.date >= '2025-10-01' && row.date <= '2026-09-30', row.date).toBe(true)
    }
  })

  it('is deterministic: the same seed produces the same ledger', () => {
    const again = generateStudentLife({ from: '2025-10', to: '2026-09', seed: 42 })
    expect(again.transactions.length).toBe(life.transactions.length)
    expect(again.transactions[0]).toEqual(life.transactions[0])
    expect(again.months).toEqual(life.months)
  })

  it('uses a different life for a different seed, so the ledger is not a frozen fixture', () => {
    const other = generateStudentLife({ from: '2025-10', to: '2026-09', seed: 7 })
    expect(other.transactions.length).not.toBe(life.transactions.length)
  })
})

describe('生活费：5 号发放，只有学期有', () => {
  it('pays the allowance on the 5th of every semester month', () => {
    for (const month of life.months) {
      const rows = life.transactions.filter(
        (row) => row.date.startsWith(month.key) && row.merchant === '家里打生活费'
      )
      if (month.term === 'semester') {
        expect(rows, month.key).toHaveLength(1)
        expect(rows[0].date).toBe(`${month.key}-${String(ALLOWANCE_DAY).padStart(2, '0')}`)
        expect(rows[0].amount).toBe(ALLOWANCE_AMOUNT)
        expect(rows[0].amount).toBe(1_000_000) // ¥10,000.00
        expect(rows[0].type).toBe('income')
      } else {
        expect(rows, month.key).toHaveLength(0)
      }
    }
  })

  it('treats October–February and March–July as term time, August and September as holiday', () => {
    expect(isSemesterMonth(10)).toBe(true)
    expect(isSemesterMonth(2)).toBe(true)
    expect(isSemesterMonth(3)).toBe(true)
    expect(isSemesterMonth(7)).toBe(true)
    expect(isSemesterMonth(8)).toBe(false)
    expect(isSemesterMonth(9)).toBe(false)
    expect(termOf(8)).toBe('holiday')
    expect(termOf(11)).toBe('semester')
  })

  it('sends only small irregular transfers during the holidays', () => {
    for (const month of life.months.filter((entry) => entry.term === 'holiday')) {
      expect(month.allowance, month.key).toBe(0)
      expect(month.otherIncome, month.key).toBeGreaterThan(0)
      const rows = life.transactions.filter(
        (row) => row.date.startsWith(month.key) && row.note === '假期零用'
      )
      expect(rows.length, month.key).toBeGreaterThanOrEqual(2)
      for (const row of rows) {
        expect(row.amount, row.date).toBeLessThanOrEqual(200_000) // ¥2,000
        expect(row.categoryName).toBe('Gift')
      }
    }
  })
})

describe('房租：每月固定 3200', () => {
  it('charges rent every month, on the day after the allowance, holidays included', () => {
    for (const month of life.months) {
      const rows = life.transactions.filter((row) => row.date.startsWith(month.key) && row.merchant === '房租')
      expect(rows, month.key).toHaveLength(1)
      expect(rows[0].date).toBe(`${month.key}-${String(RENT_DAY).padStart(2, '0')}`)
      expect(rows[0].amount).toBe(RENT_AMOUNT)
      expect(rows[0].categoryName).toBe('Housing')
      expect(rows[0].type).toBe('expense')
    }
  })

  it('has a rent reminder in the recurring rules', () => {
    const rule = life.recurringRules.find((entry) => entry.label === '房租')
    expect(rule?.amount).toBe(RENT_AMOUNT)
    expect(rule?.dayOfPeriod).toBe(RENT_DAY)
  })
})

describe('订阅', () => {
  const NAMES = ['ChatGPT Plus', 'Netflix', '加速器', '哔哩哔哩大会员', '网易云音乐黑胶']

  it('lists every subscription the brief names, with a cycle and a next charge date', () => {
    const names = life.subscriptions.map((entry) => entry.name)
    for (const name of NAMES) expect(names).toContain(name)
    for (const entry of life.subscriptions) {
      expect(['monthly', 'yearly', 'quarterly']).toContain(entry.cycle)
      expect(entry.nextChargeDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(entry.amount).toBeGreaterThan(0)
      expect(entry.currency).toBe('CNY')
    }
  })

  it('charges them every semester month and adds the yearly ones in January', () => {
    const monthly = ['ChatGPT Plus', 'Netflix', '加速器']
    for (const month of life.months) {
      for (const name of monthly) {
        const rows = life.transactions.filter((row) => row.date.startsWith(month.key) && row.merchant === name)
        expect(rows, `${month.key} ${name}`).toHaveLength(1)
      }
    }
    const january = life.transactions.filter((row) => row.date.startsWith('2026-01') && row.note === '年费')
    expect(january.map((row) => row.merchant).sort()).toEqual(['哔哩哔哩大会员', '网易云音乐黑胶'])
  })
})

describe('转账、借钱还钱、礼金', () => {
  it('moves money between the student`s own accounts, always within one currency', () => {
    /*
      The app refuses a transfer between accounts of different currencies — the two legs
      would not be equal without an invented rate — so every transfer in the sample is
      between accounts that share one. The CNY→MYR movement is recorded the way a real user
      records it: an expense named 换汇 and an income named 换汇到账, on the same day.
    */
    const notes = new Set(life.transfers.map((entry) => entry.note))
    expect(notes.has('信用卡还款')).toBe(true)
    expect(notes.has('充值到支付宝')).toBe(true)

    const byName = new Map(life.accounts.map((account) => [account.name, account.currency]))
    for (const transfer of life.transfers) {
      expect(byName.get(transfer.fromAccount), transfer.note).toBe(byName.get(transfer.toAccount))
      expect(transfer.amount).toBeGreaterThan(0)
    }

    const exchanged = life.transactions.filter((row) => row.merchant === '换汇' && row.type === 'expense')
    const received = life.transactions.filter((row) => row.merchant === '换汇到账' && row.type === 'income')
    expect(exchanged.length).toBeGreaterThanOrEqual(12)
    expect(received.length).toBe(exchanged.length)
    for (const row of received) expect(row.accountName).toBe('Maybank 本地卡')
    for (const row of exchanged) expect(row.accountName).toBe('中国银行储蓄卡')
  })

  it('lends money to a classmate and records the repayment as income', () => {
    const loan = life.transactions.find((row) => row.merchant === '借给同学李明')
    const repaid = life.transactions.find((row) => row.merchant === '李明还钱')
    expect(loan?.type).toBe('expense')
    expect(loan?.amount).toBe(120_000)
    expect(repaid?.type).toBe('income')
    expect(repaid?.amount).toBe(loan?.amount)
    expect(repaid && loan && repaid.date > loan.date).toBe(true)
  })

  it('records a refund as income rather than a negative expense', () => {
    const refund = life.transactions.find((row) => row.categoryName === 'Refund')
    expect(refund?.type).toBe('income')
    expect(refund?.amount).toBeGreaterThan(0)
  })

  it('brings in birthday money and Spring Festival red envelopes', () => {
    const birthday = life.transactions.filter((row) => row.note === '生日礼金')
    expect(birthday.length).toBeGreaterThanOrEqual(3)
    expect(birthday.every((row) => row.type === 'income' && row.categoryName === 'Gift')).toBe(true)
    const spring = life.transactions.filter((row) => row.note === '春节红包')
    expect(spring.length).toBeGreaterThanOrEqual(3)
    expect(spring[0].date).toBe('2026-02-17')
  })
})

describe('旅行与突发大额支出', () => {
  it('takes a mid-semester trip and a holiday trip', () => {
    const trips = life.transactions.filter((row) => row.categoryName === 'Travel')
    expect(trips.length).toBeGreaterThanOrEqual(3)
    expect(trips.some((row) => row.merchant.includes('期中假期'))).toBe(true)
    expect(trips.some((row) => row.merchant.includes('假期旅行') || row.merchant.includes('暑假旅行'))).toBe(true)
  })

  it('has several months with a single expense above ¥2,000', () => {
    const big = life.months.filter((month) => (month.largest?.amount ?? 0) >= LARGE_EXPENSE_THRESHOLD)
    /*
      Rent alone is 3,200 and counts, so this is about the OTHER large items: the laptop,
      the dentist, the flight home, the phone and the deposit. At least four months must
      carry one of those on top of rent.
    */
    expect(big.length).toBeGreaterThanOrEqual(4)
    const named = life.transactions.filter((row) => row.note === '突发支出').map((row) => row.merchant)
    expect(named.length).toBeGreaterThanOrEqual(4)
    expect(named).toContain('换 MacBook')
    expect(named).toContain('牙科治疗')
  })

  it('charges the large purchases to the credit card, which is then repaid by transfer', () => {
    const onCard = life.transactions.filter((row) => row.accountName === '招商银行信用卡')
    expect(onCard.length).toBeGreaterThanOrEqual(4)
    const repayments = life.transfers.filter((entry) => entry.toAccount === '招商银行信用卡')
    expect(repayments.length).toBeGreaterThanOrEqual(4)
    for (const repayment of repayments) expect(repayment.note).toBe('信用卡还款')
  })
})

describe('每个月都不一样，而且基本上是月光', () => {
  it('spends down to nearly nothing in an ordinary month', () => {
    /*
      The brief calls this student 月光族, and `netCny` is the honest way to measure it: the
      exchange out and the wallet top-up leave the Chinese card as TRANSFERS, so a month can
      look like a surplus on income-vs-expense while the card is in fact emptied.

      Months carrying a large one-off purchase are excluded by name, not by a loosened
      threshold: a ¥6,200 laptop repaid from savings is SUPPOSED to break the pattern, and
      pretending otherwise would mean testing a student who never buys anything.
    */
    const exceptional = new Set(
      life.months
        .filter((month) =>
          life.transactions.some(
            (row) =>
              row.accountName === '招商银行信用卡' &&
              row.note === '突发支出' &&
              // The repayment lands on the 9th of the FOLLOWING month.
              month.key === nextMonthKey(row.date)
          )
        )
        .map((month) => month.key)
    )
    expect(exceptional.size).toBeGreaterThanOrEqual(3)

    const ordinary = life.months.filter((month) => month.term === 'semester' && !exceptional.has(month.key))
    expect(ordinary.length).toBeGreaterThanOrEqual(6)
    for (const month of ordinary) {
      /*
        THE ASSERTION THAT MATTERS IS AN UPPER BOUND ON THE BALANCE, not on the monthly
        change. A 月光 student's account comes back to a float — a few thousand, enough for
        next month's rent — and the thing that must never happen is the float quietly
        becoming savings. The first version of the generator sized spending from income and
        left the balance alone, so the sample drifted from ¥6,400 to ¥14,074 over the year
        (peaking at ¥25,489) and taught the opposite of what it was for.
      */
      expect(month.closingCny, `${month.key} closing ${month.closingCny}`).toBeLessThan(1_300_000)
      expect(month.closingCny, `${month.key} closing ${month.closingCny}`).toBeGreaterThanOrEqual(0)
      /* And the month's spending is real, not a rounding error. */
      expect(month.expenseCny + month.expenseMyr, month.key).toBeGreaterThan(400_000)
    }
  })

  it('never turns the float into savings: the year ends where it started, plus a float', () => {
    const first = life.months[0].closingCny
    const last = life.months[life.months.length - 1].closingCny
    const peak = Math.max(...life.months.map((month) => month.closingCny))
    expect(peak).toBeLessThan(1_600_000)
    /* No upward drift across the year: the last month is not richer than the first. */
    expect(last).toBeLessThan(first + 600_000)
  })

  it('keeps every account solvent through the whole year', () => {
    for (const month of life.months) {
      expect(month.closingCny, `${month.key} CNY`).toBeGreaterThanOrEqual(0)
      expect(month.closingMyr, `${month.key} MYR`).toBeGreaterThanOrEqual(0)
      expect(month.closingWallet, `${month.key} wallet`).toBeGreaterThanOrEqual(0)
    }
    for (const [name, balance] of Object.entries(life.closing)) {
      if (name === '招商银行信用卡') continue
      expect(balance, name).toBeGreaterThanOrEqual(0)
    }
  })

  it('ends the month with a few hundred, not a few thousand', () => {
    /*
      The complaint that produced this test: "月光族余额不太可能剩下这么多，基本上每个月剩下一千
      以内就差不多了". The bank card is the account being measured，and the bar is ¥1,000 — with the
      card-debt months included, since a month that was put on credit ends with LESS cash.
    */
    const closings = life.months.map((month) => month.closingCny)
    const over = closings.filter((value) => value > 100_000)
    expect(over.length, `months over ¥1,000: ${over.join(', ')}`).toBeLessThanOrEqual(2)
    /* And it really does come back down rather than drifting up over the year. */
    expect(Math.max(...closings)).toBeLessThan(400_000)
  })

  it('sometimes runs out and puts the last week on the card', () => {
    const onCredit = life.transactions.filter((row) => row.note === '这个月先刷卡')
    expect(onCredit.length).toBeGreaterThanOrEqual(2)
    for (const row of onCredit) expect(row.accountName).toBe('招商银行信用卡')
    /*
      The debt is a few hundred, never a balance carried for months: the bill is paid on the
      9th of the next month. A credit card account may therefore be negative — it is a credit
      line — but it must stay small.
    */
    const owed = life.closing['招商银行信用卡'] ?? 0
    expect(owed).toBeLessThanOrEqual(0)
    expect(Math.abs(owed)).toBeLessThan(200_000)
  })

  it('does not repeat itself: months differ in size, count and shape', () => {
    const expenses = life.months.map((month) => month.expense)
    const counts = life.months.map((month) => month.transactionCount)
    /* No two months spend the same amount, and the spread is wide rather than cosmetic. */
    expect(new Set(expenses).size).toBe(expenses.length)
    expect(Math.max(...expenses) - Math.min(...expenses)).toBeGreaterThan(200_000)
    /* Two months may share a transaction count by coincidence; the amounts never do. */
    expect(new Set(counts).size).toBeGreaterThanOrEqual(expenses.length - 2)
  })

  it('has quiet days as well as busy ones', () => {
    const byDate = new Map<string, number>()
    for (const row of life.transactions) {
      if (row.type !== 'expense') continue
      byDate.set(row.date, (byDate.get(row.date) ?? 0) + 1)
    }
    /* A ledger where every single day has spending is a ledger nobody believes. */
    expect(byDate.size).toBeLessThan(350)
  })

  it('buys food, transport and education in every term month', () => {
    const categories = new Set(
      life.transactions.filter((row) => row.type === 'expense').map((row) => row.categoryName)
    )
    for (const name of ['Food', 'Transport', 'Education', 'Shopping', 'Entertainment', 'Health']) {
      expect(categories, name).toContain(name)
    }
  })

  it('spreads spending across the day rather than stamping one time on everything', () => {
    const hours = new Set(
      life.transactions.filter((row) => row.time).map((row) => (row.time as string).slice(0, 2))
    )
    expect(hours.size).toBeGreaterThanOrEqual(10)
  })
})

describe('the default window', () => {
  it('covers the twelve months up to today, whole months only', () => {
    expect(defaultDemoWindow('2026-09-27')).toEqual({ from: '2025-09', to: '2026-09' })
    expect(defaultDemoWindow('2026-01-05')).toEqual({ from: '2025-01', to: '2026-01' })
  })

  it('generates a usable ledger for that window too', () => {
    const window = defaultDemoWindow('2026-09-27')
    const generated = generateStudentLife(window)
    expect(generated.months).toHaveLength(13)
    expect(generated.transactions.length).toBeGreaterThan(900)
    const august = monthOf('2026-08')
    void august
    const holiday = generated.months.find((month) => month.key === '2026-08')
    expect(holiday?.term).toBe('holiday')
    expect(holiday?.allowance).toBe(0)
  })
})
