import { resolve } from 'node:path'
import { copyFileSync, mkdirSync } from 'node:fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

/**
 * electron-vite build configuration.
 *
 * Three separate bundles are produced:
 *   src/main     -> out/main/index.js      (Node/Electron main process)
 *   src/preload  -> out/preload/index.js   (isolated context bridge)
 *   src/renderer -> out/renderer/          (React UI, loaded via file://)
 *
 * `externalizeDepsPlugin` keeps runtime `dependencies` (better-sqlite3,
 * exceljs, tesseract.js) out of the main bundle so their native binaries and
 * lazy requires keep working from node_modules inside the packaged app.
 *
 * The OCR worker is COPIED rather than bundled, and that is not a style choice: it runs as a
 * child process, and the main bundle is one file with no module boundaries a child could
 * require. See `src/main/ocr/worker.cjs` for why it is a separate process at all.
 */
function copyOcrWorker(): { name: string; writeBundle: () => void } {
  return {
    name: 'cashinflow:copy-ocr-worker',
    writeBundle() {
      mkdirSync(resolve('out/main'), { recursive: true })
      copyFileSync(resolve('src/main/ocr/worker.cjs'), resolve('out/main/ocr-worker.cjs'))
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), copyOcrWorker()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@main': resolve('src/main')
      }
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].js' }
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') }
      }
    }
  }
})
