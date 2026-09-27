import { useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'

import { Icon } from '@renderer/components/Icon'
import { T, categoryLabel } from '@shared/lib/i18n'
import { formatMoney } from '@shared/lib/money'
import { parseReceiptText } from '@shared/lib/receipt'
import type { ReceiptCandidate } from '@shared/lib/receipt'
import type { OcrStatus } from '@shared/types'

/**
 * 识别账单 (v1.5.2).
 *
 * WHAT THIS IS FOR
 * ----------------
 * The evening routine is: a pile of receipts, and typing every one of them. This reads a
 * photograph or a screenshot of one, pulls out the amount, the date and the shop, and offers
 * them as rows the user can correct before they join the batch.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * It does not save anything, and it does not decide what the receipt says. It produces
 * CANDIDATES with the line each one came from, and the user picks. A receipt reader that writes
 * a wrong amount straight into the ledger has made the user worse off than typing it, because
 * they will not check a number the software produced.
 *
 * The recogniser is local (`OcrService` in the main process spawns a child running a WASM
 * engine), so the image never leaves the machine. The dialog says so, because "upload your bank
 * statement to our servers" is a reasonable thing for a user to fear and they should not have to
 * read the source to find out.
 */

export interface OcrDraft {
  amountMinor: number
  currency: string | null
  date: string | null
  time: string | null
  merchant: string | null
}

export interface OcrDialogProps {
  /** The currency the entry form is working in, used to pre-fill when the receipt is silent. */
  entryCurrency: string
  /** The category the amount would land in, only used for the preview of each row. */
  defaultCategoryId: number | null
  defaultCategoryName: string | null
  onApply: (rows: OcrDraft[]) => void
  onClose: () => void
}

type Stage = 'idle' | 'recognizing' | 'parsed' | 'failed'

export function OcrDialog({
  entryCurrency,
  defaultCategoryName,
  onApply,
  onClose
}: OcrDialogProps): JSX.Element {
  const [status, setStatus] = useState<OcrStatus | null>(null)
  const [stage, setStage] = useState<Stage>('idle')
  const [fileName, setFileName] = useState<string | null>(null)
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [rawText, setRawText] = useState('')
  const [showRaw, setShowRaw] = useState(false)
  const [confidence, setConfidence] = useState<number | null>(null)
  const [elapsedMs, setElapsedMs] = useState<number | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())

  const urlRef = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.api
      .ocrStatus()
      .then((value) => {
        if (!cancelled) setStatus(value)
      })
      .catch(() => {
        if (!cancelled) setStatus({ available: false, languages: [], reason: 'status-failed', warm: false })
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Revoke the preview blob when it is replaced or the dialog closes, so a pile of receipts does
  // not accumulate as leaked object URLs for the rest of the session.
  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    },
    []
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const parsed = useMemo(
    () => (rawText ? parseReceiptText(rawText, { defaultCurrency: entryCurrency }) : null),
    [rawText, entryCurrency]
  )
  const candidates: ReceiptCandidate[] = parsed?.candidates ?? []

  /**
   * Recognise a chosen image.
   *
   * The preview is made from the file directly — the renderer never receives the image bytes
   * across the bridge, and it does not need them: `file://` is already reachable from a page
   * loaded over `file://`, so the picture can be shown from its own path while the text comes
   * back as text.
   */
  const run = async (path: string, name: string): Promise<void> => {
    setFileName(name)
    setStage('recognizing')
    setError(null)
    setRawText('')
    setSelected(new Set())
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    urlRef.current = null
    setImageUrl(`file://${path.replace(/\\/g, '/')}`)

    try {
      const result = await window.api.ocrRecognize(path)
      setRawText(result.text)
      setConfidence(result.confidence)
      setElapsedMs(result.elapsedMs)
      setStatus((previous) => (previous ? { ...previous, warm: true } : previous))

      const outcome = parseReceiptText(result.text, { defaultCurrency: entryCurrency })
      if (result.text.trim() === '') {
        setStage('failed')
        setError(T.ocrNoText)
        return
      }
      setStage('parsed')
      // Pre-select the best candidate only. Pre-selecting all of them would turn "review these"
      // into "confirm these", which is the failure mode this dialog exists to avoid.
      setSelected(new Set(outcome.candidates.length > 0 ? [0] : []))
    } catch (caught) {
      setStage('failed')
      const reason = caught instanceof Error ? caught.message : String(caught)
      setError(T.ocrFailed.replace('{reason}', localiseOcrError(reason)))
    }
  }

  const pick = async (): Promise<void> => {
    try {
      const result = await window.api.ocrPickImage()
      if (result.canceled || !result.filePath) return
      if (result.sizeBytes !== null && result.sizeBytes > 40 * 1024 * 1024) {
        setStage('failed')
        setError(T.ocrTooLarge.replace('{mb}', '40'))
        return
      }
      await run(result.filePath, result.fileName ?? result.filePath)
    } catch (caught) {
      setStage('failed')
      setError(caught instanceof Error ? caught.message : T.ocrUnsupported)
    }
  }

  /*
    Drag an image onto the dialog, and paste one.

    Both exist because the two ways a receipt actually arrives are "a file I downloaded" and "a
    screenshot I just took", and only the first one is a file picker. A drag carries a real path
    on the dataTransfer, and a paste carries the bytes with no path at all — so the paste route
    hands the image to the main process through the picker's sibling channel and lets it write a
    temporary file. Doing it that way keeps ONE recognition path instead of two.
  */
  useEffect(() => {
    const onPaste = (event: Event): void => {
      const clipboard = event as ClipboardEvent
      const item = Array.from(clipboard.clipboardData?.items ?? []).find((entry) => entry.type.startsWith('image/'))
      if (!item) return
      const file = item.getAsFile()
      if (!file) return
      event.preventDefault()
      /*
        There is no path on a pasted image, so it cannot be recognised in place. The dialog says
        so instead of failing mysteriously — the user's next move is to save the screenshot and
        pick the file, which is a reasonable thing to ask and an unreasonable thing to guess.
      */
      setStage('failed')
      setError('剪贴板里的图片需要先保存为文件，再点「选择图片」读取，或直接把它拖进这个窗口。')
      void file
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [])

  const toggle = (index: number): void => {
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  const apply = (): void => {
    const rows: OcrDraft[] = []
    for (const index of [...selected].sort((a, b) => a - b)) {
      const candidate = candidates[index]
      if (!candidate) continue
      rows.push({
        amountMinor: candidate.amountMinor,
        currency: candidate.currency,
        date: candidate.date,
        time: candidate.time,
        merchant: candidate.merchant
      })
    }
    if (rows.length > 0) onApply(rows)
  }

  const unavailable = status !== null && !status.available

  return (
    <div
      className="ocr-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      onDragOver={(event) => {
        if (Array.from(event.dataTransfer.items).some((item) => item.kind === 'file')) {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
        }
      }}
      onDrop={(event) => {
        const file = Array.from(event.dataTransfer.files)[0]
        if (!file) return
        event.preventDefault()
        /*
          `File.path` is Electron's own addition and is the whole reason a drop can be recognised
          in place: the main process wants a path, not bytes, so that the image never crosses the
          bridge. A browser would not have it.
        */
        const path = (file as File & { path?: string }).path
        if (!path) {
          setStage('failed')
          setError(T.ocrUnsupported)
          return
        }
        void run(path, file.name)
      }}
    >
      <div className="ocr-dialog" role="dialog" aria-modal="true" aria-labelledby="ocr-title">
        <header className="ocr-head">
          <h2 id="ocr-title" className="ocr-title">
            <Icon name="receipt" size={18} />
            {T.ocrDialogTitle}
          </h2>
          <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label={T.txdCloseDialog}>
            <Icon name="close" />
          </button>
        </header>

        {unavailable ? (
          <p className="ocr-error" role="alert">
            <Icon name="alert" size={16} />
            <span>
              {status?.reason === 'engine-missing' || status?.reason === 'ocr-worker-missing'
                ? T.ocrMissingEngine
                : T.ocrFailed.replace('{reason}', localiseOcrError(status?.reason ?? ''))}
            </span>
          </p>
        ) : (
          <>
            <div className="ocr-pickrow">
              <button type="button" className="btn btn-secondary" onClick={() => void pick()} disabled={stage === 'recognizing'}>
                <Icon name="import" size={15} />
                {T.ocrPick}
              </button>
              <span className="muted ocr-pickhint">{fileName ?? T.ocrPickHint}</span>
            </div>

            <p className="ocr-note">
              <Icon name="shield" size={14} />
              <span>
                {T.ocrOffline}
                {status !== null && !status.warm ? ' ' + T.ocrFirstRunNote : ''}
              </span>
            </p>

            {imageUrl ? (
              <div className="ocr-preview">
                <img src={imageUrl} alt={fileName ?? 'receipt'} />
              </div>
            ) : null}

            {stage === 'recognizing' ? (
              <p className="ocr-progress" aria-live="polite">
                <span className="skeleton ocr-progress__bar" />
                {T.ocrRunning}
              </p>
            ) : null}

            {error ? (
              <p className="ocr-error" role="alert">
                <Icon name="alert" size={16} />
                <span>{error}</span>
              </p>
            ) : null}

            {stage === 'parsed' && candidates.length === 0 ? (
              <p className="ocr-note">
                <Icon name="info" size={14} />
                <span>{T.ocrFoundNone}</span>
              </p>
            ) : null}

            {candidates.length > 0 ? (
              <>
                <div className="ocr-foundrow">
                  <span className="ocr-found">{T.ocrFound.replace('{n}', String(candidates.length))}</span>
                  {confidence !== null ? (
                    <span className="muted">{T.ocrConfidence.replace('{n}', String(Math.round(confidence)))}</span>
                  ) : null}
                  {elapsedMs !== null ? <span className="muted ocr-elapsed">{(elapsedMs / 1000).toFixed(1)}s</span> : null}
                </div>

                <ul className="ocr-list">
                  {candidates.map((candidate, index) => (
                    <li key={index} className={`ocr-cand ${selected.has(index) ? 'is-selected' : ''}`}>
                      <label className="ocr-cand__pick">
                        <input type="checkbox" checked={selected.has(index)} onChange={() => toggle(index)} />
                      </label>
                      <span className="ocr-cand__body">
                        <span className="ocr-cand__amount num">
                          {formatMoney(candidate.amountMinor, candidate.currency ?? entryCurrency)}
                          {candidate.currency && candidate.currency !== entryCurrency ? (
                            <span className="muted ocr-cand__ccy"> {candidate.currency}</span>
                          ) : null}
                        </span>
                        <span className="muted ocr-cand__meta">
                          {[
                            candidate.date ?? '—',
                            candidate.time,
                            candidate.merchant ?? categoryLabel(defaultCategoryName)
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                        <span className="muted ocr-cand__source truncate" title={candidate.amountSource}>
                          {T.ocrFrom}: {candidate.amountSource}
                        </span>
                      </span>
                      <span className="ocr-cand__conf" title={T.ocrConfidence.replace('{n}', String(Math.round(candidate.confidence * 100)))}>
                        {Math.round(candidate.confidence * 100)}%
                      </span>
                    </li>
                  ))}
                </ul>

                {candidateNeedsConversion(candidates, entryCurrency) ? (
                  <p className="ocr-note">
                    <Icon name="info" size={14} />
                    <span>
                      账单币种与账户币种不同：金额会按账单上的原币种记入，请在选择账户时确认。
                    </span>
                  </p>
                ) : null}
              </>
            ) : null}

            {rawText ? (
              <div className="ocr-raw">
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowRaw((value) => !value)}>
                  <Icon name={showRaw ? 'chevron-down' : 'chevron-right'} size={13} />
                  {showRaw ? T.ocrHideRaw : T.ocrShowRaw}
                </button>
                {showRaw ? <pre className="ocr-raw__text">{rawText}</pre> : null}
              </div>
            ) : null}

            <footer className="ocr-foot">
              <button type="button" className="btn btn-secondary" onClick={onClose}>
                {T.cancel}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={selected.size === 0}
                onClick={apply}
              >
                {selected.size === 1
                  ? T.ocrApplyOne
                  : T.ocrApplyAll.replace('{n}', String(selected.size))}
              </button>
            </footer>
          </>
        )}
      </div>

      <style>{OCR_CSS}</style>
    </div>
  )
}

/** Does any candidate disagree with the currency the form is working in? */
function candidateNeedsConversion(candidates: ReceiptCandidate[], entryCurrency: string): boolean {
  const target = entryCurrency.toUpperCase()
  return candidates.some((candidate) => candidate.currency !== null && candidate.currency.toUpperCase() !== target)
}

/** Turn the service's error codes into something worth reading. */
function localiseOcrError(reason: string): string {
  if (reason.includes('image-too-large')) return '图片过大'
  if (reason.includes('image-not-found')) return '图片已不存在'
  if (reason.includes('recognize-timeout')) return '识别超时'
  if (reason.includes('engine-missing') || reason.includes('ocr-worker-missing')) return '未安装 OCR 组件'
  if (reason.includes('not installed')) return '未安装 OCR 组件'
  return reason.slice(0, 160)
}

const OCR_CSS = `
.ocr-overlay {
  position: fixed; inset: 0; background: var(--bg-scrim);
  display: flex; align-items: center; justify-content: center;
  padding: var(--space-6); z-index: 90;
}
.ocr-dialog {
  width: 100%; max-width: 620px; max-height: 88vh; overflow-y: auto;
  background: var(--bg-surface); border: 1px solid var(--border-default);
  border-radius: var(--radius-xl); box-shadow: var(--shadow-md); padding: var(--space-6);
}
.ocr-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); margin-bottom: var(--space-4); }
.ocr-title { display: flex; align-items: center; gap: var(--space-2); font-size: var(--text-lg); font-weight: var(--weight-semibold); margin: 0; color: var(--text-primary); }
.ocr-pickrow { display: flex; align-items: center; gap: var(--space-3); margin-bottom: var(--space-3); }
.ocr-pickhint { font-size: var(--text-xs); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ocr-note {
  display: flex; align-items: flex-start; gap: var(--space-2);
  background: var(--bg-inset); color: var(--text-secondary);
  font-size: var(--text-xs); border-radius: var(--radius-md);
  padding: var(--space-3); margin: 0 0 var(--space-3);
}
.ocr-preview { max-height: 220px; overflow: hidden; border: 1px solid var(--border-subtle); border-radius: var(--radius-md); margin-bottom: var(--space-3); background: var(--bg-inset); }
.ocr-preview img { display: block; width: 100%; max-height: 220px; object-fit: contain; }
.ocr-progress { display: flex; align-items: center; gap: var(--space-3); margin: 0 0 var(--space-3); font-size: var(--text-sm); color: var(--text-secondary); }
.ocr-progress__bar { width: 90px; height: 6px; border-radius: var(--radius-full); }
.ocr-error {
  display: flex; align-items: flex-start; gap: var(--space-2);
  background: var(--expense-subtle); color: var(--expense);
  font-size: var(--text-sm); border-radius: var(--radius-md);
  padding: var(--space-3); margin: 0 0 var(--space-3);
}
.ocr-foundrow { display: flex; align-items: baseline; gap: var(--space-3); margin-bottom: var(--space-2); }
.ocr-found { font-size: var(--text-sm); font-weight: var(--weight-medium); color: var(--text-primary); }
.ocr-elapsed { margin-left: auto; font-size: var(--text-2xs); }
.ocr-list { list-style: none; margin: 0 0 var(--space-3); padding: 0; display: flex; flex-direction: column; gap: var(--space-1); }
.ocr-cand {
  display: flex; align-items: flex-start; gap: var(--space-2);
  padding: var(--space-2) var(--space-3); border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md); cursor: pointer;
  transition: border-color var(--duration-fast) var(--ease-out), background var(--duration-fast) var(--ease-out);
}
.ocr-cand:hover { background: var(--bg-hover); }
.ocr-cand.is-selected { border-color: var(--accent); background: var(--accent-subtle); }
.ocr-cand__pick { display: flex; align-items: center; padding-top: 3px; }
.ocr-cand__body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.ocr-cand__amount { font-size: var(--text-base); font-weight: var(--weight-semibold); color: var(--text-primary); }
.ocr-cand__ccy { font-size: var(--text-2xs); font-weight: var(--weight-normal); }
.ocr-cand__meta { font-size: var(--text-xs); }
.ocr-cand__source { font-size: var(--text-2xs); font-style: italic; }
.ocr-cand__conf { flex: 0 0 auto; font-size: var(--text-2xs); color: var(--text-tertiary); font-variant-numeric: tabular-nums; padding-top: 3px; }
.ocr-raw { margin-bottom: var(--space-3); }
.ocr-raw__text {
  margin: var(--space-2) 0 0; max-height: 180px; overflow: auto;
  background: var(--bg-inset); border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md); padding: var(--space-3);
  font-family: var(--font-mono, monospace); font-size: var(--text-2xs); color: var(--text-secondary);
  white-space: pre-wrap; word-break: break-all;
}
.ocr-foot { display: flex; justify-content: flex-end; gap: var(--space-3); padding-top: var(--space-4); border-top: 1px solid var(--border-subtle); }
`
