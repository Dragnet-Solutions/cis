/**
 * D-25 — S3-Q4's columns read performance, then risk, as the question asks
 * (real Postgres). JSONB had been returning them Risk-first; the additive
 * migration records the Register's order for questions already in the
 * database, without changing any content.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { seedSurveyRegister, getInstrumentItems } from '../src';
import { getTestPool, runMigrations, truncateAllTables, closeTestPool } from './setup';

const MIGRATION = '../migrations/20261024000000_grid-dimension-order.js';

let pool: Pool;

beforeAll(async () => {
  pool = getTestPool();
  await runMigrations();
});
beforeEach(async () => {
  await truncateAllTables(pool);
  await seedSurveyRegister(pool);
});
afterAll(async () => {
  await closeTestPool();
});

async function s3q4Columns(): Promise<string[]> {
  const item = (await getInstrumentItems(pool, 'S3')).find((i) => i.id === 'S3-Q4')!;
  return Object.keys(item.gridDimensions ?? {});
}

describe('S3-Q4 grid columns (D-25)', () => {
  it('a freshly seeded question keeps the Register order', async () => {
    expect(await s3q4Columns()).toEqual(['Performance', 'Risk']);
  });

  it('the migration restores the order on a question stored before it, content untouched', async () => {
    const before = await pool.query(
      `SELECT grid_dimensions FROM instrument_questions WHERE question_code = 'S3-Q4'`,
    );
    // As an existing database looks: no recorded order, so JSONB's own order.
    await pool.query(`UPDATE instrument_questions SET grid_dimension_order = NULL`);
    expect(await s3q4Columns()).toEqual(['Risk', 'Performance']);

    const mod = (await import(MIGRATION)) as { up: (pgm: unknown) => void };
    const statements: string[] = [];
    mod.up({ sql: (sql: string) => statements.push(sql) });
    for (const sql of statements) await pool.query(sql);

    expect(await s3q4Columns()).toEqual(['Performance', 'Risk']);
    const after = await pool.query(
      `SELECT grid_dimensions FROM instrument_questions WHERE question_code = 'S3-Q4'`,
    );
    expect(after.rows).toEqual(before.rows);
  });
});
