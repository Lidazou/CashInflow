import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * Vitest configuration.
 *
 * Kept as .mjs (not .ts) on purpose: Vite bundles a TypeScript config by
 * spawning esbuild in a child process, which is blocked in confined
 * environments. A plain JS config is loaded directly with no child process.
 *
 * Tests cover the pure logic and the SQLite data layer. The database tests use a
 * real temporary SQLite file per suite, so migrations, CHECK constraints,
 * foreign keys and aggregate queries are exercised for real rather than mocked —
 * a test that mocks the database cannot catch a schema mistake.
 */
const root = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(root, 'src/shared'),
      '@main': resolve(root, 'src/main')
    }
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks'
  }
})
