import { useEffect } from 'react'
import { useAppStore } from '@renderer/store/app'
import { useUiStore } from '@renderer/store/ui'
import { useAction } from '@renderer/hooks/useData'
import { Icon, iconNameOr } from '@renderer/components/Icon'
import { formatMoney } from '@shared/lib/money'
import { formatDate } from '@shared/lib/dates'
import type { TransactionWithRefs } from '@shared/types'
import { categoryColorFor, categoryTint } from '@shared/lib/category-colors'

/**
 * Read-only transaction detail (spec §11).
 *
 * Deliberately read-only rather than an inline editor: the edit form lives in a
 * single place (`AddTransactionDialog`), so validation and transfer handling
 * cannot diverge between two editing surfaces. From here the user chooses Edit
 * or Delete, both of which route to that one implementation.
 */
export function TransactionDetailDialog(): React.JSX.Element | null {
  const transaction = useUiStore((state) => state.detailTransaction)
  const hide = useUiStore((state) => state.hideTransactionDetail)
  const openEditTransaction = useUiStore((state) => state.openEditTransaction)
  const openEditTransfer = useUiStore((state) => state.openEditTransfer)

  const dateFormat = useAppStore((state) => state.settings?.dateFormat ?? 'DD MMM YYYY')
  const refreshData = useAppStore((state) => state.refreshData)
  const { run, pending } = useAction()

  useEffect(() => {
    if (!transaction) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        hide()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [transaction, hide])

  if (!transaction) return null

  const isTransfer = transaction.type === 'transfer'
  const isIncome = transaction.type === 'income'

  async function handleDelete(): Promise<void> {
    if (!transaction) return

    // A transfer has two legs and the service deletes both. Say so before doing
    // it, because the consequence is larger than removing the row on screen.
    const confirmed = window.confirm(
      isTransfer
        ? '删除这笔转账？两个账户都会被更新，这笔资金将不再被记录为已转移。'
        : '删除这笔交易？此操作无法撤销。'
    )
    if (!confirmed) return

    const result = await run(() => window.api.transactionsDelete(transaction.id), {
      successMessage: isTransfer ? '转账已删除。' : '交易已删除。'
    })

    if (result !== null) {
      refreshData()
      hide()
    }
  }

  return (
    <div
      className="dt-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) hide()
      }}
    >
      <div className="dt-dialog" role="dialog" aria-modal="true" aria-labelledby="dt-title">
        <header className="dt-head">
          <h2 id="dt-title" className="dt-title">
            交易详情
          </h2>
          <button type="button" className="btn btn-ghost btn-icon" onClick={hide} aria-label="关闭详情">
            <Icon name="close" />
          </button>
        </header>

        <div className="dt-hero">
          <span
            className="dt-hero__icon"
            style={{
              background: isTransfer
                ? 'var(--bg-inset)'
                : categoryTint(categoryColorFor(transaction.categoryName, transaction.categoryColor)),
              color: categoryColorFor(transaction.categoryName, transaction.categoryColor)
            }}
          >
            <Icon
              name={
                isTransfer
                  ? 'arrow-left-right'
                  : iconNameOr(transaction.categoryIcon, isIncome ? 'trending-up' : 'tag')
              }
              size={20}
            />
          </span>
          <div className="dt-hero__body">
            <p className="dt-hero__merchant">
              {transaction.merchant ?? transaction.categoryName ?? (isTransfer ? '转账' : '交易')}
            </p>
            <p
              className={`dt-hero__amount amount ${
                isTransfer ? 'text-neutral' : isIncome ? 'text-income' : 'text-expense'
              }`}
            >
              {isTransfer ? '' : isIncome ? '+' : '−'}
              {formatMoney(Math.abs(transaction.amount), transaction.accountCurrency)}
            </p>
          </div>
          <span className={`badge ${isTransfer ? 'badge-neutral' : isIncome ? 'badge-income' : 'badge-expense'}`}>
            {isTransfer ? '转账' : isIncome ? '收入' : '支出'}
          </span>
        </div>

        <dl className="dt-rows">
          <DetailRow label="日期" value={formatDate(transaction.date, dateFormat, { weekday: true })} />
          {transaction.time ? <DetailRow label="时间" value={transaction.time} /> : null}
          <DetailRow label={isTransfer ? '转出账户' : '账户'} value={transaction.accountName} />
          {isTransfer ? (
            <DetailRow label="转入账户" value={transaction.counterpartAccountName ?? 'Unknown account'} />
          ) : (
            <DetailRow label="分类" value={transaction.categoryName ?? 'Uncategorised'} />
          )}
          {transaction.merchant ? <DetailRow label="商家" value={transaction.merchant} /> : null}
          {transaction.note ? <DetailRow label="备注" value={transaction.note} /> : null}
          {isTransfer ? (
            <DetailRow label="对应账户" value={transaction.counterpartAccountName ?? '—'} />
          ) : null}
          <DetailRow
            label="记录时间"
            value={new Date(transaction.createdAt).toLocaleString(undefined, {
              dateStyle: 'medium',
              timeStyle: 'short'
            })}
          />
          {transaction.updatedAt !== transaction.createdAt ? (
            <DetailRow
              label="最后修改"
              value={new Date(transaction.updatedAt).toLocaleString(undefined, {
                dateStyle: 'medium',
                timeStyle: 'short'
              })}
            />
          ) : null}
        </dl>

        {isTransfer ? (
          <p className="dt-note">
            <Icon name="info" size={16} />
            <span>
              这笔转账同时记入两个账户，会改变各自余额，但不会计入收入或支出，
              因此不影响你的周期收支统计。
            </span>
          </p>
        ) : null}

        <footer className="dt-foot">
          <button type="button" className="btn btn-danger" onClick={() => void handleDelete()} disabled={pending}>
            <Icon name="trash" size={16} />
            删除
          </button>
          <div className="spacer" />
          <button type="button" className="btn btn-secondary" onClick={hide} disabled={pending}>
            关闭
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={pending}
            onClick={() => {
              // Route transfers through the transfer form so both legs stay in
              // sync; the service rejects editing a single leg as an ordinary
              // transaction.
              if (isTransfer) openEditTransfer(transaction)
              else openEditTransaction(transaction)
              hide()
            }}
          >
            <Icon name="edit" size={16} />
            编辑
          </button>
        </footer>
      </div>

      <style>{DETAIL_CSS}</style>
    </div>
  )
}

function DetailRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="dt-row">
      <dt className="dt-row__label">{label}</dt>
      <dd className="dt-row__value">{value}</dd>
    </div>
  )
}

/**
 * Shared shape for the transaction row context menu, used by the list pages.
 * Kept here so the detail dialog and the lists stay in step.
 */
export function transactionRowActions(
  transaction: TransactionWithRefs,
  handlers: {
    onOpen: (transaction: TransactionWithRefs) => void
    onEdit: (transaction: TransactionWithRefs) => void
    onEditTransfer: (transaction: TransactionWithRefs) => void
  }
): { open: () => void; edit: () => void } {
  return {
    open: () => handlers.onOpen(transaction),
    edit: () => (transaction.type === 'transfer' ? handlers.onEditTransfer(transaction) : handlers.onEdit(transaction))
  }
}

const DETAIL_CSS = `
.dt-overlay {
  position: fixed;
  inset: 0;
  background: var(--bg-scrim);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-6);
  z-index: 70;
}
.dt-dialog {
  width: 100%;
  max-width: 460px;
  max-height: 86vh;
  overflow-y: auto;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-md);
  padding: var(--space-6);
}
.dt-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-5);
}
.dt-title {
  font-size: var(--text-lg);
  font-weight: var(--weight-semibold);
  margin: 0;
  color: var(--text-primary);
}
.dt-hero {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-4);
  background: var(--bg-inset);
  border-radius: var(--radius-lg);
  margin-bottom: var(--space-5);
}
.dt-hero__icon {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: var(--radius-full);
  flex-shrink: 0;
}
.dt-hero__body { flex: 1; min-width: 0; }
.dt-hero__merchant {
  margin: 0;
  font-weight: var(--weight-medium);
  color: var(--text-primary);
  overflow-wrap: anywhere;
}
.dt-hero__amount {
  margin: 2px 0 0;
  font-size: var(--text-xl);
  font-weight: var(--weight-semibold);
}
.dt-rows { margin: 0; display: flex; flex-direction: column; }
.dt-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-4);
  padding: 9px 0;
  border-bottom: 1px solid var(--border-subtle);
}
.dt-row:last-child { border-bottom: none; }
.dt-row__label {
  color: var(--text-secondary);
  font-size: var(--text-sm);
  flex-shrink: 0;
}
.dt-row__value {
  margin: 0;
  color: var(--text-primary);
  font-size: var(--text-sm);
  text-align: right;
  overflow-wrap: anywhere;
}
.dt-note {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  background: var(--bg-inset);
  color: var(--text-secondary);
  font-size: var(--text-sm);
  border-radius: var(--radius-md);
  padding: var(--space-3);
  margin: var(--space-5) 0 0;
}
.dt-foot {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-5);
  padding-top: var(--space-4);
  border-top: 1px solid var(--border-subtle);
}
`
