import { app } from 'electron'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

import type { OcrResult, OcrStatus } from '@shared/types'

/**
 * Receipt text recognition, in a child process, entirely offline.
 *
 * WHY A CHILD PROCESS
 * -------------------
 * tesseract.js opens its own worker thread, and inside Electron's main process that thread never
 * comes up: `createWorker` hangs with no error and no progress event, indefinitely. The identical
 * call under plain Node finishes in 664 ms. Rather than guess at the cause — worker entry
 * resolution, the asar layout, Electron's thread pool — the recogniser runs as a separate
 * process, which sidesteps it and buys three things that matter on their own:
 *
 *   - the engine's memory (a WASM heap plus a ~20 MB language model) is released when the
 *     process exits, instead of being resident for the rest of the session;
 *   - a crash or an out-of-memory in the recogniser cannot take the ledger down with it;
 *   - the heavy dependency never enters the main bundle.
 *
 * WHY IT IS OFFLINE
 * -----------------
 * The language packs ship with the app and the engine is a local WASM build, so no image and no
 * text ever leaves the machine. That is not a nice-to-have here: a receipt is a photograph of
 * somebody's bank statement, and a local-first finance app that quietly uploads one has broken
 * the promise the rest of the product is built on. The only network call this app makes remains
 * the exchange-rate lookup.
 *
 * FIRST RUN IS SLOW, AND SAYS SO
 * ------------------------------
 * Loading ~20 MB of decompressed language data takes a couple of seconds the first time, and the
 * engine caches the decompressed model afterwards (tesseract.js writes it to `cachePath`), so
 * later runs are markedly faster. `warm` reports whether that has happened yet so the interface
 * can say "this one will take a few seconds".
 */

/** Language packs, in the order they are passed to the engine. */
const LANGUAGES = ['chi_sim', 'eng'] as const

/** Refuse anything larger: a phone photo is a few MB, and 40 MB of pixels is a mistake. */
const MAX_IMAGE_BYTES = 40 * 1024 * 1024

/** How long to wait before declaring the recogniser broken rather than slow. */
const RECOGNIZE_TIMEOUT_MS = 180_000

export class OcrService {
  /** Set once a recognition has completed, so the UI can stop warning about the first-run wait. */
  private warmed = false

  /** Where the worker script lives. asarUnpacked in a packaged build — a child process cannot
   *  run a script from inside an asar archive, because Node reads it as a file. */
  private workerPath(): string {
    const packaged = join(process.resourcesPath, 'app.asar.unpacked', 'out', 'main', 'ocr-worker.cjs')
    if (app.isPackaged && existsSync(packaged)) return packaged
    return join(app.getAppPath(), 'out', 'main', 'ocr-worker.cjs')
  }

  /** The one directory the engine is given: it holds every language pack, side by side. */
  private languageDir(): string {
    return join(app.getPath('userData'), 'ocr-langs')
  }

  private cacheDir(): string {
    return join(app.getPath('userData'), 'ocr-cache')
  }

  /**
   * Whether recognition can run at all.
   *
   * Checked by looking for the worker script AND the tesseract dependency, because a build made
   * without the optional OCR packages must report `available: false` rather than fail when a
   * photograph arrives. `require.resolve` is used rather than a bare path so the check follows
   * the same resolution the worker will.
   */
  status(): OcrStatus {
    const worker = this.workerPath()
    if (!existsSync(worker)) {
      return { available: false, languages: [], reason: 'ocr-worker-missing', warm: this.warmed }
    }
    try {
      require.resolve('tesseract.js')
    } catch {
      return { available: false, languages: [], reason: 'engine-missing', warm: this.warmed }
    }
    return { available: true, languages: [...LANGUAGES], reason: null, warm: this.warmed }
  }

  /** Size of a chosen image, so the caller can refuse an absurd one before spending 30s on it. */
  inspect(filePath: string): { exists: boolean; sizeBytes: number | null } {
    try {
      const stats = statSync(filePath)
      return { exists: true, sizeBytes: stats.size }
    } catch {
      return { exists: false, sizeBytes: null }
    }
  }

  /**
   * Recognise the text in an image.
   *
   * Resolves to the raw text and the engine's confidence. It deliberately does NOT parse: turning
   * text into an amount and a date is `parseReceiptText`, which is pure, lives in the renderer
   * bundle, and is tested against captured OCR output. Keeping the split means the parse can be
   * corrected and re-run on the same text without re-reading the image, which is exactly what a
   * user does when the amount is wrong.
   */
  async recognize(filePath: string): Promise<OcrResult> {
    const status = this.status()
    if (!status.available) throw new Error(status.reason ?? 'unavailable')

    const { exists, sizeBytes } = this.inspect(filePath)
    if (!exists) throw new Error('image-not-found')
    if (sizeBytes !== null && sizeBytes > MAX_IMAGE_BYTES) throw new Error('image-too-large')

    const langDir = this.languageDir()
    mkdirSync(langDir, { recursive: true })
    mkdirSync(this.cacheDir(), { recursive: true })

    const started = Date.now()
    const payload = JSON.stringify({
      image: filePath,
      languages: [...LANGUAGES],
      langPath: langDir,
      cachePath: this.cacheDir()
    })

    const raw = await this.runWorker(payload)
    this.warmed = true

    const parsed = JSON.parse(raw) as { text?: string; confidence?: number | null; languages?: string[] }
    return {
      text: parsed.text ?? '',
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : null,
      languages: parsed.languages ?? [...LANGUAGES],
      elapsedMs: Date.now() - started
    }
  }

  /**
   * Run the worker for one image.
   *
   * `ELECTRON_RUN_AS_NODE` is the whole trick: it makes the Electron binary behave as a plain
   * Node interpreter, so the child needs no second runtime installed and the packaged app still
   * has no external dependency. `process.execPath` is that same binary.
   */
  private runWorker(payload: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [this.workerPath()], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })

      let stdout = ''
      let stderr = ''
      let settled = false

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill()
        reject(new Error('recognize-timeout'))
      }, RECOGNIZE_TIMEOUT_MS)

      child.stdout?.on('data', (chunk) => (stdout += String(chunk)))
      child.stderr?.on('data', (chunk) => (stderr += String(chunk)))

      child.on('error', (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      })

      child.on('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (code === 0 && stdout.trim() !== '') return resolve(stdout)
        // The worker writes its reason to stderr; surfacing the tail of it is far more useful
        // than "exit code 1".
        reject(new Error(stderr.trim().split('\n').slice(-3).join(' ') || `worker-exit-${code}`))
      })

      child.stdin?.end(payload)
    })
  }
}
