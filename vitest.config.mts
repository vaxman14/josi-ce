import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    // Each suite spins its own in-memory Postgres; running them in one process
    // keeps memory sane on the low-end hardware CE targets.
    // PGlite/WASM teardown in worker threads crashes Node on Windows (0xC0000005).
    // Keep the same serial suites, isolated in processes on Windows instead.
    pool: process.platform === 'win32' ? 'forks' : 'threads',
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    include: ['packages/**/test/**/*.test.ts', 'apps/**/test/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./apps/web/src', import.meta.url)),
      '@josi-ce/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
      '@josi-ce/auth': fileURLToPath(new URL('./packages/auth/src/index.ts', import.meta.url)),
      '@josi-ce/llm': fileURLToPath(new URL('./packages/llm/src/index.ts', import.meta.url)),
      '@josi-ce/agent': fileURLToPath(new URL('./packages/agent/src/index.ts', import.meta.url)),
      '@josi-ce/connectors': fileURLToPath(new URL('./packages/connectors/src/index.ts', import.meta.url)),
      '@josi-ce/mail': fileURLToPath(new URL('./packages/mail/src/index.ts', import.meta.url)),
      '@josi-ce/channels': fileURLToPath(new URL('./packages/channels/src/index.ts', import.meta.url)),
      '@josi-ce/storage': fileURLToPath(new URL('./packages/storage/src/index.ts', import.meta.url)),
      '@josi-ce/ops': fileURLToPath(new URL('./packages/ops/src/index.ts', import.meta.url)),
      '@josi-ce/persona': fileURLToPath(new URL('./packages/persona/src/index.ts', import.meta.url)),
    },
  },
});
