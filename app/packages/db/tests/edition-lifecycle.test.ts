/**
 * Edition lifecycle integration tests — runs against a real Postgres database.
 * AT-01 dry run: proves two editions can coexist without schema forks.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import {
  createEdition,
  getEditionById,
  getEditionByLabel,
  updateEditionStatus,
  lockEdition,
  createInstrumentDefinition,
  createInstrumentDefinitionVersion,
  createEditionInstrumentSnapshot,
  getEditionInstrumentSnapshots,
  createUser,
  createCriticalAction,
  approveCriticalAction,
} from '../src';
import { getTestPool, runMigrations, truncateAllTables, closeTestPool } from './setup';

let pool: Pool;

beforeAll(async () => {
  pool = getTestPool();
  await runMigrations();
});

beforeEach(async () => {
  await truncateAllTables(pool);
});

afterAll(async () => {
  await closeTestPool();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function seedTwoUsers() {
  const maker = await createUser(pool, {
    email: 'maker@example.com',
    passwordHash: '$argon2id$test',
    displayName: 'Maker User',
  });
  const checker = await createUser(pool, {
    email: 'checker@example.com',
    passwordHash: '$argon2id$test',
    displayName: 'Checker User',
  });
  return { maker, checker };
}

async function seedInstrumentWithVersion(userId: string) {
  const def = await createInstrumentDefinition(pool, { code: 'S1', name: 'Survey 1' });
  const ver = await createInstrumentDefinitionVersion(pool, {
    instrumentDefinitionId: def.id,
    versionNumber: 1,
    schemaSnapshot: { sections: [] },
    createdBy: userId,
  });
  return { def, ver };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Edition lifecycle', () => {
  it('creates an edition in draft status', async () => {
    const edition = await createEdition(pool, { label: '2026' });

    expect(edition.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(edition.label).toBe('2026');
    expect(edition.status).toBe('draft');
    expect(edition.lockedAt).toBeNull();
    expect(edition.lockedBy).toBeNull();
    expect(edition.priorEditionId).toBeNull();
  });

  it('transitions edition from draft → open', async () => {
    const edition = await createEdition(pool, { label: '2026' });
    const opened = await updateEditionStatus(pool, edition.id, 'open');

    expect(opened.status).toBe('open');
    expect(opened.updatedAt.getTime()).toBeGreaterThanOrEqual(edition.updatedAt.getTime());
  });

  it('freezes an instrument snapshot onto an edition', async () => {
    const { maker } = await seedTwoUsers();
    const edition = await createEdition(pool, { label: '2026' });
    const { ver } = await seedInstrumentWithVersion(maker.id);

    const snapshot = await createEditionInstrumentSnapshot(pool, {
      editionId: edition.id,
      instrumentDefinitionVersionId: ver.id,
      frozenBy: maker.id,
    });

    expect(snapshot.editionId).toBe(edition.id);
    expect(snapshot.instrumentDefinitionVersionId).toBe(ver.id);
    expect(snapshot.frozenBy).toBe(maker.id);

    const snapshots = await getEditionInstrumentSnapshots(pool, edition.id);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.instrumentDefinitionVersionId).toBe(ver.id);
  });

  it('locks an edition via maker-checker approval', async () => {
    const { maker, checker } = await seedTwoUsers();
    const edition = await createEdition(pool, { label: '2026' });
    await updateEditionStatus(pool, edition.id, 'open');

    const action = await createCriticalAction(pool, {
      actionType: 'edition:lock',
      requestedBy: maker.id,
      payload: { editionId: edition.id },
      editionId: edition.id,
    });

    expect(action.status).toBe('pending');
    expect(action.requestedBy).toBe(maker.id);

    const approved = await approveCriticalAction(pool, action.id, checker.id);
    expect(approved.status).toBe('approved');
    expect(approved.approvedBy).toBe(checker.id);

    // Now actually lock the edition
    const locked = await lockEdition(pool, edition.id, checker.id);
    expect(locked.status).toBe('locked');
    expect(locked.lockedBy).toBe(checker.id);
    expect(locked.lockedAt).not.toBeNull();
  });

  it('retrieves an edition by ID', async () => {
    const edition = await createEdition(pool, { label: '2026' });
    const found = await getEditionById(pool, edition.id);

    expect(found).not.toBeNull();
    expect(found?.id).toBe(edition.id);
  });

  it('returns null for a non-existent edition', async () => {
    const found = await getEditionById(pool, '00000000-0000-0000-0000-000000000000');
    expect(found).toBeNull();
  });
});

// ─── AT-01 dry run ────────────────────────────────────────────────────────────
// Architecture Test AT-01: a hypothetical 2027-DRAFT edition can exist
// alongside a frozen 2026 edition without any schema change, table fork, or
// touching the 2026 rows. This is the core multi-year non-regression guarantee.

describe('AT-01 dry run — multi-year coexistence', () => {
  it('2026 and 2027-DRAFT editions coexist with separate instrument snapshots', async () => {
    const { maker, checker } = await seedTwoUsers();

    // ── Set up 2026 ──────────────────────────────────────────────────────────
    const edition2026 = await createEdition(pool, { label: '2026' });
    await updateEditionStatus(pool, edition2026.id, 'open');

    const s1def = await createInstrumentDefinition(pool, { code: 'S1', name: 'Survey 1' });
    const s1v1 = await createInstrumentDefinitionVersion(pool, {
      instrumentDefinitionId: s1def.id,
      versionNumber: 1,
      schemaSnapshot: { year: 2026, sections: ['A', 'B'] },
      createdBy: maker.id,
    });

    await createEditionInstrumentSnapshot(pool, {
      editionId: edition2026.id,
      instrumentDefinitionVersionId: s1v1.id,
      frozenBy: maker.id,
    });

    const lockAction2026 = await createCriticalAction(pool, {
      actionType: 'edition:lock',
      requestedBy: maker.id,
      payload: { editionId: edition2026.id },
      editionId: edition2026.id,
    });
    await approveCriticalAction(pool, lockAction2026.id, checker.id);
    await lockEdition(pool, edition2026.id, checker.id);

    // ── Create 2027-DRAFT alongside 2026 ─────────────────────────────────────
    // Uses the same schema — no new tables, no forks, just new rows.
    const edition2027 = await createEdition(pool, {
      label: '2027-DRAFT',
      priorEditionId: edition2026.id,
    });

    // 2027 gets its own instrument version (S1 v2 with different questions)
    const s1v2 = await createInstrumentDefinitionVersion(pool, {
      instrumentDefinitionId: s1def.id,
      versionNumber: 2,
      schemaSnapshot: { year: 2027, sections: ['A', 'B', 'C'] }, // new section added
      createdBy: maker.id,
    });

    await createEditionInstrumentSnapshot(pool, {
      editionId: edition2027.id,
      instrumentDefinitionVersionId: s1v2.id,
      frozenBy: maker.id,
    });

    // ── Assertions ────────────────────────────────────────────────────────────

    // 2026 is still locked and intact
    const read2026 = await getEditionById(pool, edition2026.id);
    expect(read2026?.status).toBe('locked');
    expect(read2026?.label).toBe('2026');

    // 2027-DRAFT is draft and links back to 2026 for lineage
    const read2027 = await getEditionByLabel(pool, '2027-DRAFT');
    expect(read2027?.status).toBe('draft');
    expect(read2027?.priorEditionId).toBe(edition2026.id);

    // Each edition has its own snapshot pointing to distinct instrument versions
    const snaps2026 = await getEditionInstrumentSnapshots(pool, edition2026.id);
    const snaps2027 = await getEditionInstrumentSnapshots(pool, edition2027.id);

    expect(snaps2026).toHaveLength(1);
    expect(snaps2027).toHaveLength(1);
    expect(snaps2026[0]?.instrumentDefinitionVersionId).toBe(s1v1.id);
    expect(snaps2027[0]?.instrumentDefinitionVersionId).toBe(s1v2.id);

    // 2026 snapshot still points to v1 — not affected by 2027 having v2
    expect(snaps2026[0]?.instrumentDefinitionVersionId).not.toBe(
      snaps2027[0]?.instrumentDefinitionVersionId,
    );

    // The 2027 schema snapshot has the new section; 2026 still has only A, B
    expect((s1v1.schemaSnapshot as { sections: string[] }).sections).toEqual(['A', 'B']);
    expect((s1v2.schemaSnapshot as { sections: string[] }).sections).toEqual(['A', 'B', 'C']);
  });

  it('locking 2026 does not block creating or modifying 2027-DRAFT', async () => {
    const { maker, checker } = await seedTwoUsers();

    const edition2026 = await createEdition(pool, { label: '2026' });
    await updateEditionStatus(pool, edition2026.id, 'open');
    const lockAction = await createCriticalAction(pool, {
      actionType: 'edition:lock',
      requestedBy: maker.id,
      payload: { editionId: edition2026.id },
      editionId: edition2026.id,
    });
    await approveCriticalAction(pool, lockAction.id, checker.id);
    await lockEdition(pool, edition2026.id, checker.id);

    // This should succeed with no errors
    const edition2027 = await createEdition(pool, {
      label: '2027-DRAFT',
      priorEditionId: edition2026.id,
    });
    await updateEditionStatus(pool, edition2027.id, 'open');

    const read = await getEditionById(pool, edition2027.id);
    expect(read?.status).toBe('open');
  });
});
