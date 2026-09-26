import { useCallback, useMemo, useState } from 'react'
import { useAppStore } from '@renderer/store/app'
import { useAction, useAsync } from '@renderer/hooks/useData'
import { Icon } from '@renderer/components/Icon'
import { formatMoney } from '@shared/lib/money'
import { formatDate } from '@shared/lib/dates'
import type { AccountWithBalance, ImportPreview, ImportPresetId, ImportRow } from '@shared/types'

/**
 * Import transactions (spec §20 and §21).
 *
 * FLOW: Select file → Parse → Preview → Detect duplicates → User confirmation → Import.
 *
 * Nothing touches the database until the user presses Import. Parsing and preview
 * happen entirely in memory, so a mis-selected preset or a wrong date format can
 * be corrected without any cleanup afterwards.
 *
 * The MVP deliberately does NOT claim direct bank, WeChat or Alipay API access.
 * Everything works from a statement the user exported themselves.
 */

const PRESETS: Array<{ id: ImportPresetId; label: string; description: string }> = [
  { id: 'generic', label: 'Custom CSV', description: 'Auto-detect columns in any CSV or XLSX export.' },
  { id: 'wechat', label: 'WeChat Pay', description: '微信支付账单明细 — header located automatically.' },
  { id: 'alipay', label: 'Alipay', description: '支付宝电子客户回单 — GBK encoded, 24-line preamble.' },
  { id: 'maybank', label: 'Maybank', description: 'Separate Debit and Credit columns.' },
  { id: 'cimb', label: 'CIMB', description: 'Separate Debit and Credit columns.' }
]

type Step = 'select' | 'preview' | 'done'

export default function ImportPage(): React.JSX.Element {
  const refreshData = useAppStore((state) => state.refreshData)
  const pushToast = useAppStore((state) => state.pushToast)
  const dateFormat = useAppStore((state) => state.settings?.dateFormat ?? 'DD MMM YYYY')
  const baseCurrency = useAppStore((state) => state.settings?.baseCurrency ?? 'MYR')
  const { run, pending } = useAction()

  const [step, setStep] = useState<Step>('select')
  const [presetId, setPresetId] = useState<ImportPresetId>('generic')
  const [filePath, setFilePath] = useState<string | null>(null)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [parseError, setParseError] = useState<string | null>(null)
  const [defaultAccountId, setDefaultAccountId] = useState<number | null>(null)
  const [createMissingCategories, setCreateMissingCategories] = useState(true)
  const [result, setResult] = useState<{ imported: number; skipped: number; created: string[] } | null>(null)

  const { data: accounts } = useAsync<AccountWithBalance[]>(() => window.api.accountsList(), [])

  const runParse = useCallback(
    async (path: string, preset: ImportPresetId) => {
      setParseError(null)
      setPreview(null)
      try {
        const parsed = await window.api.importParse(path, preset)
        if (parsed.fatalError) {
          setParseError(parsed.fatalError)
          setStep('select')
          return
        }
        setPreview(parsed)
        setStep('preview')
      } catch (error) {
        setParseError(error instanceof Error ? error.message : 'The file could not be read.')
        setStep('select')
      }
    },
    []
  )

  async function handlePickFile(): Promise<void> {
    setParseError(null)
    try {
      const picked = await window.api.importPickFile()
      if (picked.canceled || !picked.filePath) return
      setFilePath(picked.filePath)
      await runParse(picked.filePath, presetId)
    } catch (error) {
      setParseError(error instanceof Error ? error.message : 'The file could not be opened.')
    }
  }

  /** Re-parse when the user changes preset after choosing a file. */
  async function handlePresetChange(next: ImportPresetId): Promise<void> {
    setPresetId(next)
    if (filePath) await runParse(filePath, next)
  }

  function setRowResolution(index: number, resolution: ImportRow['resolution']): void {
    setPreview((current) => {
      if (!current) return current
      const rows = current.rows.map((row) => (row.index === index ? { ...row, resolution } : row))
      return {
        ...current,
        rows,
        importableCount: rows.filter((row) => row.errors.length === 0 && row.resolution === 'import').length
      }
    })
  }

  function setAllResolution(resolution: ImportRow['resolution'], onlyDuplicates = false): void {
    setPreview((current) => {
      if (!current) return current
      const rows = current.rows.map((row) => {
        if (row.errors.length > 0) return row
        if (onlyDuplicates && row.duplicateOf === null) return row
        return { ...row, resolution }
      })
      return {
        ...current,
        rows,
        importableCount: rows.filter((row) => row.errors.length === 0 && row.resolution === 'import').length
      }
    })
  }

  const totals = useMemo(() => {
    if (!preview) return { income: 0, expense: 0 }
    let income = 0
    let expense = 0
    for (const row of preview.rows) {
      if (row.errors.length > 0 || row.resolution !== 'import' || row.amount === null) continue
      if (row.type === 'income') income += row.amount
      else expense += row.amount
    }
    return { income, expense }
  }, [preview])

  async function handleCommit(): Promise<void> {
    if (!preview) return

    const toImport = preview.rows.filter((row) => row.errors.length === 0 && row.resolution === 'import')
    if (toImport.length === 0) {
      pushToast({ tone: 'info', message: 'There is nothing selected to import.' })
      return
    }

    const committed = await run(
      () =>
        window.api.importCommit({
          fileName: preview.fileName,
          presetId: preview.presetId,
          rows: toImport,
          defaultAccountId,
          createMissingCategories
        }),
      { successMessage: `Imported ${toImport.length} transaction(s).` }
    )

    if (committed === null) return

    setResult({
      imported: committed.imported,
      skipped: committed.skipped,
      created: committed.createdCategories
    })
    setStep('done')
    refreshData()
  }

  function reset(): void {
    setStep('select')
    setPreview(null)
    setResult(null)
    setFilePath(null)
    setParseError(null)
  }

  return (
    <div className="imp">
      <header className="imp__head">
        <h1 className="imp__title">Import transactions</h1>
        <p className="muted">
          Bring in a statement you exported from your bank, WeChat Pay or Alipay. Nothing is saved until you confirm.
        </p>
      </header>

      {/* --- step indicator ---------------------------------------------- */}
      <ol className="imp__steps" aria-label="Import progress">
        {(['Select file', 'Parse', 'Preview', 'Check duplicates', 'Confirm'] as const).map((label, index) => {
          const activeIndex = step === 'select' ? (filePath ? 1 : 0) : step === 'preview' ? 2 : 4
          const state = index < activeIndex ? 'done' : index === activeIndex ? 'current' : 'todo'
          return (
            <li key={label} className={`imp__step is-${state}`}>
              <span className="imp__stepDot">{state === 'done' ? <Icon name="check" size={12} /> : index + 1}</span>
              <span className="imp__stepLabel">{label}</span>
            </li>
          )
        })}
      </ol>

      {/* --- preset selection -------------------------------------------- */}
      {step === 'select' ? (
        <div className="card imp__panel">
          <h2 className="card-title">1. Choose the statement format</h2>
          <div className="imp__presets">
            {PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className={`imp__preset ${presetId === preset.id ? 'is-active' : ''}`}
                aria-pressed={presetId === preset.id}
                onClick={() => void handlePresetChange(preset.id)}
              >
                <span className="imp__presetLabel">{preset.label}</span>
                <span className="imp__presetDesc">{preset.description}</span>
              </button>
            ))}
          </div>

          <h2 className="card-title" style={{ marginTop: 'var(--space-5)' }}>
            2. Select the file
          </h2>
          <div className="imp__pick">
            <button type="button" className="btn btn-primary" onClick={() => void handlePickFile()}>
              <Icon name="import" size={16} />
              Select file…
            </button>
            {filePath ? <span className="muted truncate">{filePath}</span> : <span className="muted">CSV or XLSX</span>}
          </div>

          <p className="imp__hint">
            <Icon name="info" size={16} />
            <span>
              CashInflow cannot connect to your bank, WeChat or Alipay directly. Export a statement from the app or
              website first, then import the file here. Header rows are located automatically, so a preamble or a
              summary footer will not confuse the importer.
            </span>
          </p>

          {parseError ? (
            <p className="imp__error" role="alert">
              <Icon name="alert" size={16} />
              <span>{parseError}</span>
            </p>
          ) : null}
        </div>
      ) : null}

      {/* --- preview ------------------------------------------------------ */}
      {step === 'preview' && preview ? (
        <>
          <div className="card imp__summary">
            <div className="imp__summaryFile">
              <Icon name="inbox" size={18} />
              <div>
                <p className="imp__fileName">{preview.fileName}</p>
                <p className="muted imp__fileMeta">
                  {preview.kind.toUpperCase()} · {preview.rows.length} row(s) · format:{' '}
                  {PRESETS.find((preset) => preset.id === preview.presetId)?.label}
                </p>
              </div>
            </div>

            <div className="imp__counts">
              <Count label="Ready to import" value={preview.importableCount} tone="income" />
              <Count label="Possible duplicates" value={preview.duplicateCount} tone="warning" />
              <Count label="Cannot import" value={preview.errorCount} tone="expense" />
            </div>
          </div>

          {preview.notices.length > 0 ? (
            <div className="card imp__notices">
              {preview.notices.map((notice) => (
                <p key={notice} className="imp__notice">
                  <Icon name="info" size={15} />
                  <span>{notice}</span>
                </p>
              ))}
            </div>
          ) : null}

          {/* --- options ------------------------------------------------- */}
          <div className="card imp__options">
            <div className="imp__option">
              <label className="field-label" htmlFor="imp-account">
                Account for rows without one
              </label>
              <select
                id="imp-account"
                className="select"
                value={defaultAccountId ?? ''}
                onChange={(event) => setDefaultAccountId(event.target.value ? Number(event.target.value) : null)}
              >
                <option value="">Use the account named in the file, or ask</option>
                {(accounts ?? []).map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name} ({account.currency})
                  </option>
                ))}
              </select>
              <p className="field-hint">
                Statements usually name the account. If a row has none and no default is chosen, the import will stop
                and tell you which row was a problem.
              </p>
            </div>

            <label className="imp__check">
              <input
                type="checkbox"
                checked={createMissingCategories}
                onChange={(event) => setCreateMissingCategories(event.target.checked)}
              />
              <span>
                Create categories that do not exist yet
                <span className="muted"> — rows keep their original category names.</span>
              </span>
            </label>
          </div>

          {/* --- batch actions ------------------------------------------- */}
          <div className="imp__actions">
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setAllResolution('import')}>
              Select all
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setAllResolution('skip')}>
              Deselect all
            </button>
            {preview.duplicateCount > 0 ? (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setAllResolution('skip', true)}
              >
                Skip all {preview.duplicateCount} duplicate(s)
              </button>
            ) : null}
            <div className="spacer" />
            <span className="muted imp__totals">
              Selected: <span className="text-income amount">+{formatMoney(totals.income, baseCurrency)}</span>{' '}
              <span className="text-expense amount">−{formatMoney(totals.expense, baseCurrency)}</span>
            </span>
          </div>

          {/* --- rows ---------------------------------------------------- */}
          <div className="card imp__tableWrap">
            <table className="table imp__table">
              <thead>
                <tr>
                  <th scope="col" style={{ width: 44 }}>
                    <span className="visually-hidden">Include</span>
                  </th>
                  <th scope="col">Date</th>
                  <th scope="col">Description</th>
                  <th scope="col">Category</th>
                  <th scope="col">Account</th>
                  <th scope="col" className="num">
                    Amount
                  </th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row) => {
                  const hasError = row.errors.length > 0
                  const isDuplicate = row.duplicateOf !== null
                  return (
                    <tr key={row.index} className={hasError ? 'is-error' : isDuplicate ? 'is-duplicate' : ''}>
                      <td>
                        <input
                          type="checkbox"
                          checked={row.resolution === 'import' && !hasError}
                          disabled={hasError}
                          aria-label={`Import row ${row.index + 1}`}
                          onChange={(event) =>
                            setRowResolution(row.index, event.target.checked ? 'import' : 'skip')
                          }
                        />
                      </td>
                      <td className="num">{row.date ? formatDate(row.date, dateFormat) : '—'}</td>
                      <td className="truncate imp__cellDesc">{row.description || '—'}</td>
                      <td className="truncate">{row.categoryName ?? '—'}</td>
                      <td className="truncate">{row.accountName ?? '—'}</td>
                      <td className={`num ${row.type === 'income' ? 'text-income' : 'text-expense'}`}>
                        {row.amount === null
                          ? '—'
                          : `${row.type === 'income' ? '+' : '−'}${formatMoney(row.amount, baseCurrency)}`}
                      </td>
                      <td>
                        {hasError ? (
                          <span className="badge badge-expense" title={row.errors.join(' ')}>
                            {row.errors[0]}
                          </span>
                        ) : isDuplicate ? (
                          <span
                            className="badge badge-neutral"
                            title={row.duplicateOf?.reason ?? 'Possible duplicate'}
                          >
                            {row.duplicateOf?.confidence === 1 ? 'Duplicate' : 'Possible duplicate'}
                          </span>
                        ) : row.warnings.length > 0 ? (
                          <span className="badge badge-neutral" title={row.warnings.join(' ')}>
                            Check
                          </span>
                        ) : (
                          <span className="badge badge-income">OK</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <p className="imp__hint">
            <Icon name="shield" size={16} />
            <span>
              Duplicates are matched on the provider&rsquo;s transaction id when the file has one, and otherwise on the
              date, amount and description. Rows flagged as duplicates are unticked but you can still include them — a
              genuine second coffee on the same day is not an error.
            </span>
          </p>

          <div className="imp__footer">
            <button type="button" className="btn btn-secondary" onClick={reset} disabled={pending}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void handleCommit()}
              disabled={pending || preview.importableCount === 0}
            >
              {pending ? 'Importing…' : `Import ${preview.importableCount} transaction(s)`}
            </button>
          </div>
        </>
      ) : null}

      {/* --- done --------------------------------------------------------- */}
      {step === 'done' && result ? (
        <div className="card imp__panel">
          <div className="imp__doneIcon">
            <Icon name="check" size={22} />
          </div>
          <h2 className="imp__doneTitle">Import complete</h2>
          <p className="muted">
            {result.imported} transaction(s) added
            {result.skipped > 0 ? `, ${result.skipped} skipped` : ''}.
          </p>
          {result.created.length > 0 ? (
            <p className="muted">
              New categories created: {result.created.join(', ')}.
            </p>
          ) : null}
          <p className="muted">
            This import is recorded in Import history in Settings, where you can roll the whole batch back if it was
            not what you intended.
          </p>
          <div className="row" style={{ marginTop: 'var(--space-4)' }}>
            <button type="button" className="btn btn-primary" onClick={reset}>
              Import another file
            </button>
          </div>
        </div>
      ) : null}

      <style>{IMPORT_CSS}</style>
    </div>
  )
}

function Count({ label, value, tone }: { label: string; value: number; tone: 'income' | 'warning' | 'expense' }): React.JSX.Element {
  return (
    <div className={`imp__count is-${tone}`}>
      <span className="imp__countValue amount">{value}</span>
      <span className="imp__countLabel">{label}</span>
    </div>
  )
}

const IMPORT_CSS = `
.imp { display: flex; flex-direction: column; gap: var(--space-5); padding-bottom: var(--space-8); }
.imp__head { display: flex; flex-direction: column; gap: 2px; }
.imp__title { font-size: var(--text-2xl); font-weight: var(--weight-semibold); margin: 0; color: var(--text-primary); }
.imp__head p { margin: 0; font-size: var(--text-sm); max-width: 70ch; }
.imp__steps {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-4);
  list-style: none;
  margin: 0;
  padding: 0;
}
.imp__step { display: flex; align-items: center; gap: var(--space-2); font-size: var(--text-xs); }
.imp__stepDot {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: var(--radius-full);
  border: 1px solid var(--border-default);
  color: var(--text-tertiary);
  font-size: 11px;
  font-weight: var(--weight-semibold);
}
.imp__step.is-done .imp__stepDot { background: var(--income-subtle); border-color: transparent; color: var(--income); }
.imp__step.is-current .imp__stepDot { background: var(--accent); border-color: transparent; color: var(--text-on-accent); }
.imp__step.is-current .imp__stepLabel { color: var(--text-primary); font-weight: var(--weight-medium); }
.imp__stepLabel { color: var(--text-tertiary); }
.imp__panel { display: flex; flex-direction: column; gap: var(--space-3); }
.imp__presets { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: var(--space-2); }
.imp__preset {
  display: flex;
  flex-direction: column;
  gap: 3px;
  text-align: left;
  padding: var(--space-3);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-surface);
  cursor: pointer;
  font: inherit;
  transition: border-color var(--duration-fast) var(--ease-out), background var(--duration-fast) var(--ease-out);
}
.imp__preset:hover { background: var(--bg-hover); }
.imp__preset.is-active { border-color: var(--accent); background: var(--accent-subtle); }
.imp__presetLabel { font-size: var(--text-sm); font-weight: var(--weight-medium); color: var(--text-primary); }
.imp__presetDesc { font-size: var(--text-xs); color: var(--text-secondary); }
.imp__pick { display: flex; align-items: center; gap: var(--space-3); min-width: 0; }
.imp__hint,
.imp__error,
.imp__notice {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  font-size: var(--text-sm);
  border-radius: var(--radius-md);
  padding: var(--space-3);
  margin: 0;
}
.imp__hint { background: var(--bg-inset); color: var(--text-secondary); }
.imp__error { background: var(--expense-subtle); color: var(--expense); }
.imp__notices { display: flex; flex-direction: column; gap: var(--space-2); }
.imp__notice { background: var(--bg-inset); color: var(--text-secondary); }
.imp__summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-5);
  flex-wrap: wrap;
}
.imp__summaryFile { display: flex; align-items: center; gap: var(--space-3); min-width: 0; }
.imp__fileName { margin: 0; font-weight: var(--weight-medium); color: var(--text-primary); overflow-wrap: anywhere; }
.imp__fileMeta { margin: 2px 0 0; font-size: var(--text-xs); }
.imp__counts { display: flex; gap: var(--space-5); }
.imp__count { display: flex; flex-direction: column; align-items: flex-end; }
.imp__countValue { font-size: var(--text-xl); font-weight: var(--weight-semibold); }
.imp__countLabel { font-size: var(--text-xs); color: var(--text-secondary); }
.imp__count.is-income .imp__countValue { color: var(--income); }
.imp__count.is-warning .imp__countValue { color: var(--warning); }
.imp__count.is-expense .imp__countValue { color: var(--expense); }
.imp__options { display: flex; flex-direction: column; gap: var(--space-4); }
.imp__option { display: flex; flex-direction: column; gap: var(--space-1); max-width: 420px; }
.imp__check { display: flex; align-items: flex-start; gap: var(--space-2); font-size: var(--text-sm); cursor: pointer; }
.imp__actions { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.imp__totals { font-size: var(--text-sm); }
.imp__tableWrap { padding: 0; overflow: hidden; }
.imp__table { width: 100%; }
.imp__table th { position: sticky; top: 0; background: var(--bg-surface); }
.imp__cellDesc { max-width: 260px; }
.imp__table tr.is-error { background: var(--expense-subtle); }
.imp__table tr.is-duplicate { background: var(--warning-subtle); }
.imp__footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-3);
  padding-top: var(--space-2);
}
.imp__doneIcon {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: var(--radius-full);
  background: var(--income-subtle);
  color: var(--income);
}
.imp__doneTitle { margin: var(--space-3) 0 0; font-size: var(--text-lg); font-weight: var(--weight-semibold); }
`
