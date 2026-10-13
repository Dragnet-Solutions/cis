import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    pool: 'forks',
    // One worker, files in sequence: the pg_advisory_lock held by
    // node-pg-migrate (packages/db/tests/setup.ts) is never double-acquired.
    maxWorkers: 1,
  },
});
