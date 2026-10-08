import { defineWorkspace } from 'vitest/config';

const DB_URL =
  process.env['DATABASE_URL'] ?? 'postgres://cis:cis_test_password@localhost:5433/cis_test';

// All integration test projects share one DB — run files sequentially to avoid races.
export default defineWorkspace([
  {
    test: {
      name: 'integration',
      include: [
        'packages/db/tests/**/*.test.ts',
        'packages/audit/tests/**/*.test.ts',
        'packages/auth/tests/**/*.test.ts',
        'packages/domain/tests/**/*.test.ts',
        'packages/survey/tests/**/*.test.ts',
        'apps/api/tests/**/*.test.ts',
      ],
      globals: true,
      environment: 'node',
      testTimeout: 30_000,
      hookTimeout: 60_000,
      fileParallelism: false,
      pool: 'forks',
      poolOptions: {
        forks: {
          singleFork: true,
        },
      },
      env: {
        DATABASE_URL: DB_URL,
        JWT_SECRET: 'test-secret-at-least-32-characters-long-for-tests',
      },
    },
  },
  {
    // Pure front-end model logic (no DB, no DOM) — e.g. the firm portal model,
    // where the three confirmed UX-FRM-001 defect fixes are regression-tested.
    test: {
      name: 'unit',
      include: ['apps/admin/src/**/*.test.ts'],
      globals: true,
      environment: 'node',
    },
  },
]);
