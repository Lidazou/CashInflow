import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ExcelJS from 'exceljs'

import { openDatabase, type DatabaseHandle } from '@main/database/connection'
import { Services } from '@main/services'
import { buildTransactionsWorkbook, moneyFormatFor, writeTransactionsXlsx, xlsxFileName } from '@main/services/export'

/**
 * Excel export.
 *
 * The assertions read the workbook BACK with ExcelJS rather than checking that a file
 * exists, because every requirement here is about what is INSIDE the file: a date that is
 * a real date, an amount that is a real number, a frozen header, an auto filter, and a
 * row count that matches the filter the user was looking at.
 *
 * Spec §29–§33 and Scenario E.
 */

let workDir: string
let handle: DatabaseHandle
let services: Services

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'spendwise-xlsx-'))
  handle = openDatabase({ dataDir: workDir })
  services = new Services(handle.db)
})

afterEach(() => {
  try {
    handle.close()
  } catch {
    /* already closed */
  }
  rmSync(workDir, { recursive: true, force: true })
})

function categoryId(name: string, type: 'income' | 'expense'): number {
  const found = services.categories.list({ type }).find((row) => row.name === name)
  if (!found) throw new Error(`Seeded category ${name} is missing`)
  return found.id
}

interface Seeded {
  accountId: number
}

function seed(): Seeded {
  const account = services.accounts.create({ name: 'Maybank', type: 'bank', currency: 'MYR', openingBalance: 0 })
  const food = categoryId('Food', 'expense')
  const transport = categoryId('Transport', 'expense')
  const salary = categoryId('Salary', 'income')

  services.transactions.create({
    accountId: account.id, type: 'expense', amount: 1234, categoryId: food,
    date: '2026-09-28', time: '12:14', merchant: 'Coffee, Tea & Co', note: 'with a note'
  })
  services.transactions.create({
    accountId: account.id, type: 'expense', amount: 40000, categoryId: food,
    date: '2026-09-30', time: null, merchant: 'Dinner', note: null
  })
  services.transactions.create({
    accountId: account.id, type: 'expense', amount: 800, categoryId: transport,
    date: '2026-10-02', time: '08:00', merchant: 'Bus', note: null
  })
  services.transactions.create({
    accountId: account.id, type: 'income', amount: 1200000, categoryId: salary,
    date: '2026-09-29', time: '09:00', merchant: 'September salary', note: null
  })
  return { accountId: account.id }
}

async function readBack(path: string): Promise<ExcelJS.Worksheet> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(readFileSync(path) as unknown as ArrayBuffer)
  const sheet = workbook.worksheets[0]
  if (!sheet) throw new Error('no worksheet')
  return sheet
}

describe('the exported workbook', () => {
  it('writes a real .xlsx file, not a renamed CSV', async () => {
    seed()
    const path = join(workDir, 'out.xlsx')
    const written = await writeTransactionsXlsx(path, services.imports.exportRows({}))
    expect(written).toBe(4)
    expect(statSync(path).size).toBeGreaterThan(1000)

    /* PK zip magic: a real workbook is an OPC package, not text. */
    const head = readFileSync(path).subarray(0, 2).toString('latin1')
    expect(head).toBe('PK')
  })

  it('has the user-facing columns and no internal ones', async () => {
    seed()
    const sheet = await readBack(await writeTo(services.imports.exportRows({})))
    const headers = (sheet.getRow(1).values as unknown[]).slice(1)
    expect(headers).toEqual([
      'Date',
      'Time',
      'Transaction',
      'Category',
      'Type',
      'Amount',
      'Currency',
      'Account',
      'Note'
    ])
    for (const forbidden of ['id', 'transferId', 'importBatchId', 'createdAt', 'updatedAt', 'startAmount']) {
      expect(headers).not.toContain(forbidden)
    }
  })

  it('writes Date as a DATE cell, so it sorts and filters as a date', async () => {
    seed()
    const sheet = await readBack(await writeTo(services.imports.exportRows({})))
    const cell = sheet.getRow(2).getCell(1)
    expect(cell.value).toBeInstanceOf(Date)
    expect(cell.numFmt).toBe('yyyy-mm-dd')
    const date = cell.value as Date
    expect(date.getFullYear()).toBe(2026)
    expect(date.getMonth()).toBe(8)
    expect(date.getDate()).toBe(28)
  })

  it('writes Amount as a NUMBER in major units, with a currency format', async () => {
    seed()
    const sheet = await readBack(await writeTo(services.imports.exportRows({})))
    const amount = sheet.getRow(2).getCell(6)
    expect(typeof amount.value).toBe('number')
    // 1234 minor units of MYR is 12.34 — a number, never the string "RM 12.34".
    expect(amount.value).toBe(-12.34)
    expect(amount.numFmt).toContain('"RM"')
    expect(amount.numFmt).toContain('#,##0.00')
  })

  it('keeps a merchant that contains the delimiter intact', async () => {
    seed()
    const sheet = await readBack(await writeTo(services.imports.exportRows({})))
    expect(sheet.getRow(2).getCell(3).value).toBe('Coffee, Tea & Co')
    expect(sheet.getRow(2).getCell(9).value).toBe('with a note')
  })

  it('freezes the header row and sets an auto filter over the data only', async () => {
    seed()
    const sheet = await readBack(await writeTo(services.imports.exportRows({})))
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 })
    expect(sheet.autoFilter).toBeTruthy()
    // Four data rows: 1..5, so the total row on line 6 is OUTSIDE the filter.
    expect(String(sheet.autoFilter)).toContain('A1:I5')
  })

  it('adds a SUM total over the amount column, outside the filter', async () => {
    seed()
    const sheet = await readBack(await writeTo(services.imports.exportRows({})))
    const totalRow = sheet.getRow(6)
    expect(totalRow.getCell(3).value).toBe('Total')
    const formula = totalRow.getCell(6).value as { formula?: string }
    expect(formula.formula).toBe('SUM(F2:F5)')
  })

  it('gives every column a sensible width', async () => {
    seed()
    const sheet = await readBack(await writeTo(services.imports.exportRows({})))
    const widths = sheet.columns.slice(0, 9).map((column) => column.width ?? 0)
    expect(widths).toHaveLength(9)
    expect(widths.every((width) => width >= 7)).toBe(true)
    // Notes and merchant names need room; a Date column does not.
    expect(widths[0]).toBeLessThan(widths[8])
  })

  it('writes one row per transaction, in the order the query returned', async () => {
    seed()
    const sheet = await readBack(await writeTo(services.imports.exportRows({})))
    const merchants = [2, 3, 4, 5].map((row) => sheet.getRow(row).getCell(3).value)
    expect(merchants).toEqual(['Coffee, Tea & Co', 'September salary', 'Dinner', 'Bus'])
  })

  it('round-trips through the app`s own XLSX reader', async () => {
    seed()
    const path = await writeTo(services.imports.exportRows({}))
    const { readXlsxRows } = await import('@main/services/export')
    const rows = await readXlsxRows(path)
    expect(rows[0]).toContain('Date')
    expect(rows.length).toBe(6)
    // The reader turns the date cell back into the same local day it was written from.
    expect(rows[1][0]).toBe('2026-09-28')
  })
})

/** Write the workbook to a temp path and return it. */
async function writeTo(rows: ReturnType<Services['imports']['exportRows']>): Promise<string> {
  const path = join(workDir, `export-${Math.random().toString(36).slice(2)}.xlsx`)
  await writeTransactionsXlsx(path, rows)
  return path
}

describe('Scenario E: the export follows the current filter', () => {
  it('exports only the filtered category', async () => {
    seed()
    const food = categoryId('Food', 'expense')
    const rows = services.imports.exportRows({ categoryIds: [food] })
    expect(rows.map((row) => row.merchant)).toEqual(['Coffee, Tea & Co', 'Dinner'])
    const sheet = await readBack(await writeTo(rows))
    const merchants = [2, 3].map((row) => sheet.getRow(row).getCell(3).value)
    expect(merchants).toEqual(['Coffee, Tea & Co', 'Dinner'])
    expect(sheet.actualRowCount).toBe(4) // header + 2 rows + total
  })

  it('exports only the filtered period', async () => {
    seed()
    const rows = services.imports.exportRows({ from: '2026-09-01', to: '2026-09-30' })
    expect(rows.map((row) => row.merchant)).toEqual(['Coffee, Tea & Co', 'September salary', 'Dinner'])
  })

  it('combines period and category, which is what the ring click produces', async () => {
    seed()
    const food = categoryId('Food', 'expense')
    const rows = services.imports.exportRows({ from: '2026-09-01', to: '2026-09-30', categoryIds: [food] })
    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row.categoryName === 'Food')).toBe(true)
  })

  it('filters by amount magnitude, so a RM 100 expense still matches "at least RM 100"', async () => {
    seed()
    const rows = services.imports.exportRows({ minAmount: 40000 })
    // Amounts stay SIGNED in the row (the sheet formats the sign); the FILTER compares
    // magnitudes, which is what makes a RM 100 expense match "at least RM 100".
    expect(rows.map((row) => row.amount).sort((a, b) => a - b)).toEqual([-40000, 1200000])
  })

  it('exports an empty result as a header and no total row', async () => {
    seed()
    const sheet = await readBack(await writeTo(services.imports.exportRows({ categoryIds: [999] })))
    expect(sheet.getRow(1).getCell(1).value).toBe('Date')
    expect(sheet.getRow(2).getCell(1).value ?? null).toBeNull()
    expect(sheet.autoFilter).toBeUndefined()
  })
})

describe('file names and number formats', () => {
  it('names a single month by its month', () => {
    expect(xlsxFileName({ from: '2026-09-01', to: '2026-09-30' })).toBe('CashInflow_Transactions_2026-09.xlsx')
  })

  it('names a single day by its day', () => {
    expect(xlsxFileName({ from: '2026-09-28', to: '2026-09-28' })).toBe('CashInflow_Transactions_2026-09-28.xlsx')
  })

  it('names a cross-month range by both ends', () => {
    expect(xlsxFileName({ from: '2026-09-15', to: '2026-10-14' })).toBe(
      'CashInflow_Transactions_2026-09-15_2026-10-14.xlsx'
    )
  })

  it('always produces an .xlsx name, even with no range at all', () => {
    expect(xlsxFileName({})).toMatch(/^CashInflow_Transactions_\d{4}-\d{2}-\d{2}\.xlsx$/)
  })

  it('uses the currency`s own decimals: 2 for MYR, none for JPY', () => {
    expect(moneyFormatFor('MYR')).toContain('#,##0.00')
    expect(moneyFormatFor('JPY')).not.toContain('.')
    expect(moneyFormatFor('JPY')).toContain('"¥"')
  })

  it('writes a zero-decimal currency without a decimal point', async () => {
    const account = services.accounts.create({ name: 'Tokyo', type: 'bank', currency: 'JPY', openingBalance: 0 })
    services.transactions.create({
      accountId: account.id, type: 'expense', amount: 1500, categoryId: null,
      date: '2026-09-28', time: null, merchant: 'Ramen', note: null
    })
    const sheet = await readBack(await writeTo(services.imports.exportRows({})))
    expect(sheet.getRow(2).getCell(6).value).toBe(-1500)
  })
})

describe('the workbook builder on its own', () => {
  it('can build without touching the disk, which is what makes it testable', () => {
    const workbook = buildTransactionsWorkbook([], { sheetName: 'Empty' })
    expect(workbook.worksheets[0].name).toBe('Empty')
    expect(workbook.worksheets[0].rowCount).toBe(1)
  })
})
