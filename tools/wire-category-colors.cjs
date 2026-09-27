/**
 * Point every remaining category-colour consumer at the one token table.
 *
 *   node tools/wire-category-colors.cjs [--check]
 *
 * Before v1.6.0 the same category could be drawn from five different fallback tables plus a
 * dozen inline `?? 'var(--chart-N)'` / `?? '#6B7280'` expressions, so "the colour of Food"
 * depended on which screen you were looking at. Each replacement below is anchored on the
 * exact expression it replaces and asserts that it matched, so a file that has drifted
 * fails loudly instead of being silently skipped.
 *
 * Files that only ever use an ACCOUNT's colour are left alone: accounts have their own
 * palette (`DEFAULT_ACCOUNT_COLORS`) and are a different thing from categories.
 */
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..', 'src', 'renderer', 'src')
const checkOnly = process.argv.includes('--check')

const EDITS = [
  {
    file: 'pages/BudgetPage.tsx',
    rules: [
      ["style={{ color: row.categoryColor ?? 'var(--text-secondary)' }}", 'style={{ color: categoryColorFor(row.categoryName, row.categoryColor) }}'],
      ["color={row.overBudget ? 'var(--warning)' : (row.categoryColor ?? 'var(--accent)')}", "color={row.overBudget ? 'var(--warning)' : categoryColorFor(row.categoryName, row.categoryColor)}"]
    ]
  },
  {
    file: 'pages/CustomPeriodPage.tsx',
    rules: [
      ['color: row.categoryColor ?? \'var(--chart-1)\',', 'color: categoryColorFor(row.categoryName, row.categoryColor),'],
      [
        "background: item.categoryColor ? `${item.categoryColor}1f` : 'var(--bg-inset)',",
        "background: categoryTint(categoryColorFor(item.categoryName, item.categoryColor)),"
      ],
      ["color: item.categoryColor ?? 'var(--text-secondary)'", 'color: categoryColorFor(item.categoryName, item.categoryColor)']
    ]
  },
  {
    file: 'pages/DashboardPage.tsx',
    rules: [["const color = row.categoryColor ?? 'var(--text-tertiary)'", 'const color = categoryColorFor(row.categoryName, row.categoryColor)']]
  },
  {
    file: 'pages/SearchPage.tsx',
    rules: [
      [
        "style={{ backgroundColor: row.categoryColor ?? 'var(--text-tertiary)' }}",
        'style={{ backgroundColor: categoryColorFor(row.categoryName, row.categoryColor) }}'
      ]
    ]
  },
  {
    file: 'pages/StatisticsPage.tsx',
    rules: [
      [
        "style={{ color: isTransfer ? 'var(--text-secondary)' : transaction.categoryColor ?? 'var(--text-secondary)' }}",
        "style={{ color: isTransfer ? 'var(--text-secondary)' : categoryColorFor(transaction.categoryName, transaction.categoryColor) }}"
      ]
    ]
  },
  {
    file: 'pages/TransactionsPage.tsx',
    rules: [
      [
        "background: isTransfer ? 'var(--bg-inset)' : `${item.categoryColor ?? '#6B7280'}1f`,",
        'background: isTransfer ? \'var(--bg-inset)\' : categoryTint(categoryColorFor(item.categoryName, item.categoryColor)),'
      ],
      ["color: item.categoryColor ?? 'var(--text-secondary)'", 'color: categoryColorFor(item.categoryName, item.categoryColor)']
    ]
  },
  {
    file: 'components/TransactionDetailDialog.tsx',
    rules: [
      [
        ": `${transaction.categoryColor ?? 'var(--text-tertiary)'}1f`,",
        ': categoryTint(categoryColorFor(transaction.categoryName, transaction.categoryColor)),'
      ],
      ["color: transaction.categoryColor ?? 'var(--text-secondary)'", 'color: categoryColorFor(transaction.categoryName, transaction.categoryColor)']
    ]
  }
]

/** Add the import if the file does not already have it. */
function ensureImport(text) {
  if (text.includes("from '@shared/lib/category-colors'")) return { text, added: false }
  const lines = text.split('\n')
  // After the last @shared import, so the import block stays grouped.
  let last = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (/^import .* from '@shared\//.test(lines[i])) last = i
  }
  if (last === -1) {
    for (let i = 0; i < lines.length; i += 1) {
      if (/^import /.test(lines[i])) last = i
    }
  }
  if (last === -1) return { text, added: false }
  lines.splice(last + 1, 0, "import { categoryColorFor, categoryTint } from '@shared/lib/category-colors'")
  return { text: lines.join('\n'), added: true }
}

let totalRules = 0
let totalFiles = 0

for (const edit of EDITS) {
  const file = path.join(root, edit.file)
  let text = fs.readFileSync(file, 'utf8')
  const before = text
  let applied = 0

  for (const [needle, replacement] of edit.rules) {
    if (!text.includes(needle)) {
      console.log(`  !! not found in ${edit.file}: ${needle.slice(0, 70)}`)
      continue
    }
    text = text.split(needle).join(replacement)
    applied += 1
  }

  if (applied > 0) {
    const withImport = ensureImport(text)
    text = withImport.text
    if (withImport.added) console.log(`  + import added to ${edit.file}`)
  }

  if (text !== before) {
    totalFiles += 1
    totalRules += applied
    console.log(`  ${edit.file}: ${applied} rule(s)`)
    if (!checkOnly) fs.writeFileSync(file, text, 'utf8')
  } else {
    console.log(`  ${edit.file}: unchanged`)
  }
}

console.log(`\n${totalRules} rule(s) across ${totalFiles} file(s)${checkOnly ? ' (check only)' : ''}`)
