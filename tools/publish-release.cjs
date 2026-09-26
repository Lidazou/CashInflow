/**
 * Publish a GitHub Release and upload its assets.
 *
 * Used instead of the GitHub CLI (not installed here) and instead of Actions
 * (the release assets are ~117 MB each and live on this machine, not in CI).
 *
 * Usage:
 *   node tools/publish-release.cjs <tag> <titleFile> <notesFile> <asset> [asset...]
 *
 * The token is read from a file path in GITHUB_TOKEN_FILE rather than an
 * argument, so it never appears in a process listing or in shell history. The
 * file is expected to hold `password=<token>` from the credential helper.
 */
const fs = require('node:fs')
const path = require('node:path')

const API = 'https://api.github.com'
const REPO = 'Lidazou/CashInflow'

function readToken() {
  const file = process.env.GITHUB_TOKEN_FILE
  if (!file) throw new Error('GITHUB_TOKEN_FILE is not set')
  const raw = fs.readFileSync(file, 'utf8')
  const match = raw.match(/^password=(.+)$/m)
  if (!match) throw new Error('no password= line in the token file')
  return match[1].trim()
}

const token = readToken()

async function api(method, url, body, extraHeaders = {}) {
  const response = await fetch(url.startsWith('http') ? url : API + url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'CashInflow-release-script',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...extraHeaders
    },
    body: body ? JSON.stringify(body) : undefined
  })

  const text = await response.text()
  let parsed = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = text
  }

  if (!response.ok) {
    throw new Error(`${method} ${url} -> ${response.status}\n${text.slice(0, 600)}`)
  }
  return parsed
}

async function main() {
  const [tag, titleFile, notesFile, ...assets] = process.argv.slice(2)
  if (!tag || !titleFile || !notesFile || assets.length === 0) {
    throw new Error('usage: publish-release.cjs <tag> <titleFile> <notesFile> <asset...>')
  }

  const title = fs.readFileSync(titleFile, 'utf8').trim()
  const notes = fs.readFileSync(notesFile, 'utf8')

  // Reuse an existing release for this tag if the previous attempt got partway:
  // re-running must not fail with a 422 that hides which step actually broke.
  let release = null
  try {
    release = await api('GET', `/repos/${REPO}/releases/tags/${tag}`)
    console.log('release already exists:', release.html_url)
  } catch {
    release = await api('POST', `/repos/${REPO}/releases`, {
      tag_name: tag,
      target_commitish: 'main',
      name: title,
      body: notes,
      draft: false,
      prerelease: false
    })
    console.log('created release:', release.html_url)
  }

  const existing = new Map((release.assets ?? []).map((a) => [a.name, a.id]))

  for (const asset of assets) {
    const name = path.basename(asset)
    const size = fs.statSync(asset).size

    if (existing.has(name)) {
      console.log(`deleting previous upload of ${name}`)
      await api('DELETE', `/repos/${REPO}/releases/assets/${existing.get(name)}`)
    }

    console.log(`uploading ${name} (${(size / 1048576).toFixed(2)} MB)...`)
    const uploadUrl = `https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`
    const response = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(size),
        'User-Agent': 'CashInflow-release-script'
      },
      body: fs.readFileSync(asset),
      duplex: 'half'
    })

    const text = await response.text()
    if (!response.ok) throw new Error(`upload of ${name} failed: ${response.status}\n${text.slice(0, 600)}`)
    const uploaded = JSON.parse(text)
    console.log(`  -> ${uploaded.browser_download_url}  (${uploaded.state})`)
  }

  const final = await api('GET', `/repos/${REPO}/releases/tags/${tag}`)
  console.log('\nrelease:', final.html_url)
  for (const asset of final.assets) {
    console.log(`  ${asset.name}  ${asset.size} bytes  downloads=${asset.download_count}`)
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error('FAILED:', error.message)
    process.exit(1)
  }
)
