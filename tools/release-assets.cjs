/**
 * Rename a release asset / verify the published assets over HTTP.
 *
 * A one-off maintenance helper, kept because the alternative is clicking through the web UI:
 * `publish-release.cjs` uploads under the basename it is given, and getting that wrong is a
 * one-line fix here rather than a re-upload of 233 MB.
 *
 *   node tools/release-assets.cjs <tag>                 # list + verify every asset URL
 *   node tools/release-assets.cjs <tag> --rename a b    # rename asset a to b
 */
const fs = require('node:fs')

const API = 'https://api.github.com'
const REPO = 'Lidazou/CashInflow'

const token = (() => {
  const file = process.env.GITHUB_TOKEN_FILE
  if (!file) return null
  const match = fs.readFileSync(file, 'utf8').match(/^password=(.+)$/m)
  return match ? match[1].trim() : null
})()

async function api(method, url, body) {
  const response = await fetch(url.startsWith('http') ? url : API + url, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'CashInflow-release-script',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${method} ${url} -> ${response.status} ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : null
}

async function main() {
  const [tag, flag, from, to] = process.argv.slice(2)
  if (!tag) throw new Error('usage: node tools/release-assets.cjs <tag> [--rename a b]')

  const release = await api('GET', `/repos/${REPO}/releases/tags/${tag}`)

  if (flag === '--rename') {
    const asset = release.assets.find((entry) => entry.name === from)
    if (!asset) throw new Error(`no asset named ${from}; have: ${release.assets.map((a) => a.name).join(', ')}`)
    await api('PATCH', `/repos/${REPO}/releases/assets/${asset.id}`, { name: to })
    console.log(`renamed ${from} -> ${to}`)
  }

  const after = flag === '--rename' ? await api('GET', `/repos/${REPO}/releases/tags/${tag}`) : release
  console.log(`\nrelease: ${after.html_url}`)
  for (const asset of after.assets) {
    const head = await fetch(asset.browser_download_url, { method: 'HEAD' })
    console.log(
      `  ${asset.name.padEnd(36)} ${String(asset.size).padStart(10)} bytes  HTTP ${head.status}`
    )
  }
}

main().catch((error) => {
  console.error('FAILED:', error.message)
  process.exit(1)
})
