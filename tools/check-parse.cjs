/**
 * Guard: TypeScript must PARSE, not merely type-check.
 *
 * WHY THIS EXISTS
 * ---------------
 * Component styles in this codebase are plain CSS held in JS template literals
 * (`const STYLES = \`...\``). A backtick anywhere inside one of those literals —
 * in a CSS comment, or as a CSS `content` value — terminates the literal early,
 * and the failure is nasty out of proportion to its cause:
 *
 *   - `tsc` reports a syntax error pointing at prose rather than at the character;
 *   - the bundler dies with a stream error several frames deep in esbuild, naming
 *     no file, so the cause is invisible from the build output;
 *   - and the build then leaves the PREVIOUS bundle in place. The app still starts
 *     and still serves a page — just without the change. That happened twice while
 *     building the K-line view: the chart was verified against a bundle that did
 *     not contain it.
 *
 * WHY IT CALLS tsc RATHER THAN COUNTING BACKTICKS
 * ----------------------------------------------
 * Two hand-written scanners were tried first and both were wrong: one could never
 * fire (a premature backtick becomes the literal's end, so the body looks
 * balanced), and its replacement mis-tracked apostrophes inside prose comments and
 * reported files that were provably fine. Getting lexical analysis right is a
 * solved problem, and the compiler is already here — so this runs `tsc` with
 * syntax-error reporting and looks ONLY for parse failures, ignoring type errors
 * entirely. It costs about a second and cannot disagree with the build.
 *
 * The point is to run it BEFORE the bundler: a parse failure that reaches
 * `vite build` is reported as an esbuild stream error with no file name.
 *
 * Usage:  node tools/check-parse.cjs          (exit 1 on any syntax error)
 *         node tools/check-parse.cjs --verbose (also print timing)
 */
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const verbose = process.argv.includes('--verbose')

/**
 * TypeScript diagnostic codes that mean "this is not valid syntax". Everything
 * else tsc reports is a type error, which `npm run typecheck` owns and which must
 * NOT fail this guard — otherwise the guard duplicates the type check and gets
 * disabled the first time someone has a red type error they are mid-way through
 * fixing.
 */
const SYNTAX_CODES = new Set([
  1002, // Unterminated string literal
  1003, // Identifier expected
  1005, // ';' expected  (what a truncated template literal usually produces)
  1009, // Trailing comma not allowed
  1010, // '*/' expected
  1109, // Expression expected
  1128, // Declaration or statement expected
  1136, // Property assignment expected
  1160, // Unterminated template literal
  1161, // Unterminated regular expression literal
  1382, // Unexpected token
  1434, // Unexpected keyword or identifier
  17008, // JSX element has no corresponding closing tag
  17015 // Expected corresponding JSX closing tag
])

const CONFIGS = ['tsconfig.node.json', 'tsconfig.web.json']

/**
 * The local tsc entry point, invoked through node rather than through a shell.
 *
 * `execFileSync('npx', [...], { shell: true })` works but is a deprecation warning
 * waiting to happen, and building a shell command line out of arguments is the thing
 * that warning is about. Resolving the script and running it with the current node
 * binary avoids the shell entirely.
 */
const TSC = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')

let failed = false

for (const config of CONFIGS) {
  const started = Date.now()
  let output = ''

  try {
    output = execFileSync(process.execPath, [TSC, '-p', config, '--noEmit'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (error) {
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`
  }

  const elapsed = Date.now() - started
  const syntaxErrors = output
    .split(/\r?\n/)
    .filter((line) => /error TS\d+:/.test(line))
    .map((line) => {
      const match = line.match(/error (TS\d+):/)
      return match ? { code: Number(match[1].slice(2)), line } : null
    })
    .filter((entry) => entry && SYNTAX_CODES.has(entry.code))

  if (verbose) console.log(`${config}: parsed in ${elapsed}ms`)

  if (syntaxErrors.length > 0) {
    failed = true
    console.error(`\n${config}: ${syntaxErrors.length} syntax error(s)`)
    for (const error of syntaxErrors.slice(0, 12)) console.error('  ' + error.line.trim())
  }
}

if (failed) {
  console.error(
    '\nA syntax error means the bundler will fail with an opaque stream error and may' +
      '\nleave the previous bundle in place. Fix this before building.'
  )
  process.exit(1)
}

console.log('check-parse: clean')
