/**
 * The OCR worker, run as a CHILD PROCESS rather than an in-process worker thread.
 *
 * WHY IT IS A SEPARATE PROCESS
 * ----------------------------
 * tesseract.js in Node opens its own worker thread, and inside Electron's main process that
 * thread never comes up: `createWorker` hangs with no error and no progress event, forever.
 * The identical call from plain Node finishes in 664 ms. Rather than guess at the cause — the
 * worker entry resolution, the asar layout, Electron's own thread pool — the child process
 * sidesteps it, and it buys three things that matter independently of the bug:
 *
 *   - the OCR engine's memory (the WASM heap plus a ~30 MB language model) is released when the
 *     process exits, instead of staying resident in the app for the rest of the session;
 *   - a crash or an out-of-memory in the recogniser cannot take the ledger with it;
 *   - the heavy dependency never enters the main bundle.
 *
 * Protocol: one JSON request on STDIN, one line of JSON on stdout, error text on stderr.
 *
 *   echo '{"image":"C:\\...\\a.png"}' | node out/main/ocr-worker.cjs
 *
 * STDIN rather than argv on purpose: the request contains a Windows path with backslashes, and
 * every shell between here and there has an opinion about quoting those. A pipe has none.
 *
 * The copy in `out/` is written by the `copy-ocr-worker` plugin in electron.vite.config.ts and
 * unpacked from the asar by electron-builder.yml. Both are required: a child process cannot run
 * a script that lives inside an asar archive.
 */
const { mkdirSync, copyFileSync, existsSync } = require('node:fs')
const { join } = require('node:path')

function fail(message) {
  process.stderr.write(String(message))
  process.exit(1)
}

/** The request, from stdin (preferred) or argv (for a quick manual run). */
function readRequest() {
  if (process.argv[2]) return JSON.parse(process.argv[2])
  return new Promise((resolve, reject) => {
    let body = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => (body += chunk))
    process.stdin.on('end', () => {
      try {
        resolve(JSON.parse(body))
      } catch (error) {
        reject(new Error('request on stdin is not JSON: ' + (error && error.message)))
      }
    })
    process.stdin.on('error', reject)
  })
}

async function main() {
  const request = await readRequest()
  const image = request.image
  if (!image) fail('no image given')
  if (!existsSync(image)) fail('image not found: ' + image)

  let createWorker
  try {
    ;({ createWorker } = require('tesseract.js'))
  } catch (error) {
    fail('tesseract.js is not installed: ' + (error && error.message))
  }

  /*
    Assemble one language directory.

    `langPath` is a SINGLE path and the file for language X is fetched as `langPath + X +
    '.traineddata.gz'`, so two separate npm data packages cannot both be pointed at. The
    packages ship the trained data next to their own index.js, and this copies each one into
    the shared directory the engine is given.
  */
  const languages = Array.isArray(request.languages) && request.languages.length > 0 ? request.languages : ['chi_sim', 'eng']
  const langDir = request.langPath
  if (langDir) {
    mkdirSync(langDir, { recursive: true })
    for (const code of languages) {
      const source = require.resolve(`@tesseract.js-data/${code}/package.json`)
      const from = join(source, '..', '4.0.0', `${code}.traineddata.gz`)
      const to = join(langDir, `${code}.traineddata.gz`)
      if (existsSync(from) && !existsSync(to)) copyFileSync(from, to)
    }
  }

  const worker = await createWorker(languages, 1, {
    ...(langDir ? { langPath: langDir } : {}),
    gzip: true,
    ...(request.cachePath ? { cachePath: request.cachePath } : {}),
    logger: () => {}
  })

  const { data } = await worker.recognize(image)
  await worker.terminate()

  process.stdout.write(
    JSON.stringify({
      text: data.text ?? '',
      confidence: typeof data.confidence === 'number' ? data.confidence : null,
      languages
    })
  )
  process.exit(0)
}

main().catch((error) => {
  fail(error && error.stack ? error.stack : String(error))
})
