import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    pool: 'forks',
    poolOptions: {
      forks: {
        // All integration test files share one process so the module-level
        // migration singleton in packages/db/tests/setup.ts is shared, and the
        // pg_advisory_lock held by node-pg-migrate is never double-acquired.
        singleFork: true,
      },
    },
  },
});
