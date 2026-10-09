/**
 * Edition service integration tests (real Postgres). Covers the Phase 1 DoD:
 *  - sample floors editable in draft, rejected once open
 *  - closing date editable while not locked
 *  - markOpened fails unless frozen; fires exactly once
 *  - lock goes through maker-checker; self-approve rejected
 *  - locking is one-way (no reopen path)
 *  - every floor/date/lock change writes an audit record
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { getEditionById, listSampleFloors, updateEditionStatus, createUser } from '@cis/db';
import { loadRbacContext, MakerCheckerViolationError, PermissionDeniedError } from '@cis/auth';
import {
  seedReferenceData,
  setSampleFloor,
  setClosingDate,
  markOpened,
  requestLock,
  decideLock,
  requestFreeze,
  decideFreeze,
  EditionStateError,
  InstrumentsNotFrozenError,
  InvalidReasonError,
} from '../src';
import { getTestPool, runMigrations, truncateAllTables, closeTestPool } from '../../db/tests/setup';

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

async function seedAndContexts() {
  const seed = await seedReferenceData(pool);
  const maker = await loadRbacContext(pool, seed.makerUserId);
  const checker = await loadRbacContext(pool, seed.checkerUserId);
  return { seed, maker, checker };
}

async function auditCount(entityType: string, entityId: string, actionType: string) {
  const r = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM audit_log
     WHERE entity_type=$1 AND entity_id=$2 AND action_type=$3`,
    [entityType, entityId, actionType],
  );
  return parseInt(r.rows[0]?.c ?? '0', 10);
}

/** Freeze the instruments via a valid maker-checker cycle. */
async function freezeInstruments(
  editionId: string,
  maker: Awaited<ReturnType<typeof loadRbacContext>>,
  checker: Awaited<ReturnType<typeof loadRbacContext>>,
) {
  const action = await requestFreeze(pool, maker, editionId, 'Pilot complete, wording confirmed');
  await decideFreeze(pool, checker, editionId, action.id, { approved: true });
}

describe('Sample floors', () => {
  it('can be edited while the edition is in draft, and writes an audit record', async () => {
    const { seed, maker } = await seedAndContexts();
    const floor = await setSampleFloor(pool, maker, seed.editionId, 'firm', 90);
    expect(floor.floorValue).toBe(90);

    const floors = await listSampleFloors(pool, seed.editionId);
    expect(floors.find((f) => f.category === 'firm')?.floorValue).toBe(90);

    expect(await auditCount('edition_sample_floor', floor.id, 'edition.sample_floor.changed')).toBe(
      1,
    );
  });

  it('are rejected once the edition is open', async () => {
    const { seed, maker } = await seedAndContexts();
    await updateEditionStatus(pool, seed.editionId, 'open');
    await expect(setSampleFloor(pool, maker, seed.editionId, 'firm', 90)).rejects.toBeInstanceOf(
      EditionStateError,
    );
  });
});

describe('Closing date', () => {
  it('is editable in draft and audited', async () => {
    const { seed, maker } = await seedAndContexts();
    const updated = await setClosingDate(
      pool,
      maker,
      seed.editionId,
      new Date('2026-12-15T00:00:00Z'),
    );
    expect(updated.surveyCloseAt?.toISOString().startsWith('2026-12-15')).toBe(true);
    expect(await auditCount('edition', seed.editionId, 'edition.closing_date.changed')).toBe(1);
  });

  it('is still editable while collecting (open), per the artefact', async () => {
    const { seed, maker } = await seedAndContexts();
    await updateEditionStatus(pool, seed.editionId, 'open');
    const updated = await setClosingDate(
      pool,
      maker,
      seed.editionId,
      new Date('2026-12-20T00:00:00Z'),
    );
    expect(updated.surveyCloseAt?.toISOString().startsWith('2026-12-20')).toBe(true);
  });

  it('is rejected once the edition is locked', async () => {
    const { seed, maker } = await seedAndContexts();
    await updateEditionStatus(pool, seed.editionId, 'locked');
    await expect(
      setClosingDate(pool, maker, seed.editionId, new Date('2026-12-20T00:00:00Z')),
    ).rejects.toBeInstanceOf(EditionStateError);
  });
});

describe('markOpened (internal transition)', () => {
  it('fails if the instruments are not frozen', async () => {
    const { seed } = await seedAndContexts();
    await expect(markOpened(pool, seed.editionId)).rejects.toBeInstanceOf(
      InstrumentsNotFrozenError,
    );
    const edition = await getEditionById(pool, seed.editionId);
    expect(edition?.status).toBe('draft');
  });

  it('succeeds once instruments are frozen, and fires exactly once', async () => {
    const { seed, maker, checker } = await seedAndContexts();
    await freezeInstruments(seed.editionId, maker, checker);

    const opened = await markOpened(pool, seed.editionId, { actorId: seed.makerUserId });
    expect(opened.status).toBe('open');
    expect(opened.surveyOpenAt).not.toBeNull();
    expect(await auditCount('edition', seed.editionId, 'edition.opened')).toBe(1);

    // Single-fire: a second call must fail because it is no longer in draft.
    await expect(markOpened(pool, seed.editionId)).rejects.toBeInstanceOf(EditionStateError);
  });
});

describe('Lock the results (maker-checker)', () => {
  it('requires a reason of at least 4 characters', async () => {
    const { seed, maker } = await seedAndContexts();
    await updateEditionStatus(pool, seed.editionId, 'open');
    await expect(requestLock(pool, maker, seed.editionId, 'no')).rejects.toBeInstanceOf(
      InvalidReasonError,
    );
  });

  it('lets a maker request and a different person approve, locking the edition', async () => {
    const { seed, maker, checker } = await seedAndContexts();
    await updateEditionStatus(pool, seed.editionId, 'open');

    const action = await requestLock(pool, maker, seed.editionId, 'Collection window ended');
    expect(action.status).toBe('pending');

    const { edition } = await decideLock(pool, checker, seed.editionId, action.id, {
      approved: true,
    });
    expect(edition.status).toBe('locked');
    expect(edition.lockedBy).toBe(seed.checkerUserId);
    expect(await auditCount('edition', seed.editionId, 'edition.locked')).toBe(1);
  });

  it('rejects a self-approval by the requester (maker-checker violation)', async () => {
    const { seed, maker } = await seedAndContexts();
    await updateEditionStatus(pool, seed.editionId, 'open');
    const action = await requestLock(pool, maker, seed.editionId, 'Collection window ended');
    await expect(
      decideLock(pool, maker, seed.editionId, action.id, { approved: true }),
    ).rejects.toBeInstanceOf(MakerCheckerViolationError);
    // Edition must remain open — the invalid decision changed nothing.
    const edition = await getEditionById(pool, seed.editionId);
    expect(edition?.status).toBe('open');
  });

  it('requires request permission', async () => {
    const { seed } = await seedAndContexts();
    await updateEditionStatus(pool, seed.editionId, 'open');
    const stranger = await createUser(pool, {
      email: 'stranger@nowhere.example',
      passwordHash: '$argon2id$test',
      displayName: 'Stranger',
    });
    const strangerRbac = await loadRbacContext(pool, stranger.id);
    await expect(
      requestLock(pool, strangerRbac, seed.editionId, 'Trying to lock'),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});

describe('Locking is one-way', () => {
  it('has no code path that reopens a locked edition', async () => {
    const { seed, maker, checker } = await seedAndContexts();
    await updateEditionStatus(pool, seed.editionId, 'open');
    const action = await requestLock(pool, maker, seed.editionId, 'Collection window ended');
    await decideLock(pool, checker, seed.editionId, action.id, { approved: true });

    // No reopen service exists; markOpened cannot resurrect a locked edition
    // (it only fires from draft), and mutations are refused.
    await expect(markOpened(pool, seed.editionId)).rejects.toBeInstanceOf(EditionStateError);
    await expect(
      setClosingDate(pool, maker, seed.editionId, new Date('2027-01-01T00:00:00Z')),
    ).rejects.toBeInstanceOf(EditionStateError);

    const edition = await getEditionById(pool, seed.editionId);
    expect(edition?.status).toBe('locked');
  });
});
