/**
 * Find classes used in JSX that no stylesheet defines.
 *
 * WHY THIS EXISTS
 * ---------------
 * The v1.4 design pass rewrote `global.css` wholesale. That silently orphaned a set of
 * component classes whose rules lived there — `.rate-ticker__list` among them, which
 * is why the dashboard's exchange rates stacked vertically instead of sitting on one
 * row. An unstyled class is invisible in review: the markup is unchanged, the app
 * still renders, and a list that became a column looks like a design decision rather
 * than a deleted rule.
 *
 * This scans every `className` string in the renderer, collects the classes that any
 * stylesheet in the project defines (global CSS, component-local style blocks), and
 * reports the difference. A hit is either a missing rule or a class that is only ever
 * targeted by a descendant selector — both worth a look.
 *
 * Usage: node tools/audit-classes.cjs
 */
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const SRC = path.join(ROOT, 'src', 'renderer', 'src')
const GLOBAL_CSS = path.join(SRC, 'styles', 'global.css')

function walk(dir, ext, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, ext, out)
    else if (entry.name.endsWith(ext)) out.push(full)
  }
  return out
}

/** Every class name mentioned in a chunk of CSS, including inside selectors. */
function classesInCss(css) {
  const found = new Set()
  // Strip comments first: a class named in prose is not a rule.
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const match of withoutComments.matchAll(/\.([a-zA-Z][\w-]*)/g)) found.add(match[1])
  return found
}

const defined = classesInCss(fs.readFileSync(GLOBAL_CSS, 'utf8'))
const cssFileCount = { global: 1, local: 0 }

// Component-local styles live in `const X_STYLES = \`...\`` template literals.
for (const file of walk(SRC, '.tsx')) {
  const text = fs.readFileSync(file, 'utf8')
  for (const match of text.matchAll(/=\s*`([\s\S]*?)`/g)) {
    const body = match[1]
    // Only template literals that look like stylesheets.
    if (!/\{[\s\S]*:[\s\S]*;/.test(body) || !body.includes('--')) continue
    for (const name of classesInCss(body)) defined.add(name)
    cssFileCount.local += 1
  }
}

/** Classes referenced from JSX, as plain strings and inside template literals. */
const used = new Map()
for (const file of walk(SRC, '.tsx')) {
  const text = fs.readFileSync(file, 'utf8')
  const add = (raw, line) => {
    for (const name of raw.split(/\s+/)) {
      // Skip interpolations, conditionals and obviously non-class tokens.
      if (!name || !/^[a-zA-Z][\w-]*$/.test(name)) continue
      if (!used.has(name)) used.set(name, [])
      used.get(name).push(`${path.relative(ROOT, file)}:${line}`)
    }
  }

  text.split('\n').forEach((line, index) => {
    for (const match of line.matchAll(/className="([^"]*)"/g)) add(match[1], index + 1)
    for (const match of line.matchAll(/className=\{`([^`]*)`\}/g)) add(match[1], index + 1)
  })
}

const orphans = []
for (const [name, where] of used) {
  if (defined.has(name)) continue
  // Ignore tokens that are clearly not class names but appear in template literals.
  if (/^\d/.test(name)) continue
  orphans.push({ name, where })
}

console.log(
  `scanned ${used.size} classes used in JSX against ${defined.size} defined across global.css + ${cssFileCount.local} local style block(s)`
)

if (orphans.length === 0) {
  console.log('audit-classes: every used class has a rule')
  process.exit(0)
}

console.log(`\n${orphans.length} class(es) with no rule anywhere:\n`)
for (const orphan of orphans.sort((a, b) => a.name.localeCompare(b.name))) {
  const unique = [...new Set(orphan.where)].slice(0, 3)
  console.log(`  ${orphan.name}`)
  for (const where of unique) console.log(`      ${where}`)
}
console.log('\nEach is either a missing rule or a descendant-only target. Both are worth a look.')
process.exit(0)
