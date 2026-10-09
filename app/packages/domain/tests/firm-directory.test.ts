/**
 * Firm directory import — loading the participating firms from a CSV before
 * launch: validation, duplicate detection, a dry-run preview that writes
 * nothing, all-or-nothing import, audit, and the "Change the setup" right.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { createOrganization, listOrganizations } from '@cis/db';
import { loadRbacContext, type RbacContext } from '@cis/auth';
import {
  seedReferenceData,
  importFirmDirectory,
  parseCsv,
  slugifyFirmName,
  MAX_IMPORT_ROWS,
} from '../src';
import { getTestPool, runMigrations, truncateAllTables, closeTestPool } from '../../db/tests/setup';

let pool: Pool;
let operator: RbacContext;

beforeAll(async () => {
  pool = getTestPool();
  await runMigrations();
});
beforeEach(async () => {
  await truncateAllTables(pool);
  const seed = await seedReferenceData(pool);
  operator = await loadRbacContext(pool, seed.makerUserId);
});
afterAll(async () => {
  await closeTestPool();
});

const firmNames = async () =>
  (await listOrganizations(pool)).filter((o) => o.orgType === 'firm').map((o) => o.displayName);

describe('Reading the file', () => {
  it('parses quoted fields, doubled quotes, CRLF and a BOM', () => {
    expect(parseCsv('﻿name,slug\r\n"Smith, Jones & Co","smith-jones"\r\n"A ""B"" C",\n')).toEqual([
      ['name', 'slug'],
      ['Smith, Jones & Co', 'smith-jones'],
      ['A "B" C', ''],
    ]);
  });

  it('derives a slug from the name', () => {
    expect(slugifyFirmName('[Test] 02 Beta Brokerage')).toBe('test-02-beta-brokerage');
    expect(slugifyFirmName('Smith & Jones Ltd.')).toBe('smith-and-jones-ltd');
  });
});

describe('Preview (dry run)', () => {
  it('lists what would be added and writes nothing', async () => {
    const csv = 'name\nAlpha Securities\nBeta Brokerage\n\n';
    const result = await importFirmDirectory(pool, operator, csv, { dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.added).toBe(0);
    expect(result.totalRows).toBe(2);
    expect(result.toAdd.map((r) => [r.name, r.slug])).toEqual([
      ['Alpha Securities', 'alpha-securities'],
      ['Beta Brokerage', 'beta-brokerage'],
    ]);
    expect(await firmNames()).toEqual([]);
  });

  it('reports rows it cannot read, with their line numbers', async () => {
    const csv = 'name,slug\nGood Firm,\n,orphan-slug\nBad Slug Firm,Not A Slug!\n';
    const result = await importFirmDirectory(pool, operator, csv, { dryRun: true });
    expect(result.toAdd.map((r) => r.name)).toEqual(['Good Firm']);
    expect(result.errors.map((e) => e.line)).toEqual([3, 4]);
  });

  it('refuses a file without a name column', async () => {
    const result = await importFirmDirectory(pool, operator, 'firm\nAlpha\n', { dryRun: true });
    expect(result.errors).toHaveLength(1);
    expect(result.toAdd).toHaveLength(0);
  });

  it('refuses a file that is too long', async () => {
    const rows = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `Firm ${i}`);
    const result = await importFirmDirectory(pool, operator, `name\n${rows.join('\n')}`, {
      dryRun: true,
    });
    expect(result.errors.some((e) => /at most/.test(e.message))).toBe(true);
  });
});

describe('Duplicates are skipped, never added twice', () => {
  it('detects firms already in the directory by name or slug, and repeats in the file', async () => {
    await createOrganization(pool, {
      slug: 'alpha-securities',
      displayName: 'Alpha Securities',
      orgType: 'firm',
    });
    await createOrganization(pool, { slug: 'gamma', displayName: 'Gamma Old', orgType: 'firm' });
    const csv = [
      'name,slug',
      'ALPHA  securities,', // same name, different case and spacing
      'Gamma Capital,gamma', // slug already taken
      'Delta Partners,',
      'Delta Partners,', // repeats line 4
      'Delta Two,delta-partners', // slug repeats line 4
    ].join('\n');
    const result = await importFirmDirectory(pool, operator, csv, { dryRun: false });
    expect(result.added).toBe(1);
    expect(result.toAdd.map((r) => r.name)).toEqual(['Delta Partners']);
    expect(result.duplicates.map((d) => d.line)).toEqual([2, 3, 5, 6]);
    expect((await firmNames()).sort()).toEqual(['Alpha Securities', 'Delta Partners', 'Gamma Old']);

    // Importing the same file again adds nothing.
    const again = await importFirmDirectory(pool, operator, csv, { dryRun: false });
    expect(again.added).toBe(0);
    expect(await firmNames()).toHaveLength(3);
  });
});

describe('Import', () => {
  it('adds every new firm and audits each one', async () => {
    const result = await importFirmDirectory(
      pool,
      operator,
      'name\nAlpha Securities\nBeta Brokerage\n',
      { dryRun: false },
    );
    expect(result.added).toBe(2);
    expect((await firmNames()).sort()).toEqual(['Alpha Securities', 'Beta Brokerage']);
    const audit = await pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM audit_log
        WHERE action_type = 'firm_directory.firm_added' AND actor_id = $1`,
      [operator.userId],
    );
    expect(audit.rows[0]?.c).toBe('2');
  });

  it('imports nothing when any line cannot be read', async () => {
    await expect(
      importFirmDirectory(pool, operator, 'name,slug\nAlpha,\nBeta,BAD SLUG\n', { dryRun: false }),
    ).rejects.toMatchObject({ code: 'IMPORT_INVALID' });
    expect(await firmNames()).toEqual([]);
  });

  it('needs the "Change the setup" right, even to preview', async () => {
    const noRights: RbacContext = { userId: operator.userId, permissions: [] };
    for (const dryRun of [true, false]) {
      await expect(
        importFirmDirectory(pool, noRights, 'name\nAlpha\n', { dryRun }),
      ).rejects.toMatchObject({ name: 'PermissionDeniedError' });
    }
    expect(await firmNames()).toEqual([]);
  });
});
