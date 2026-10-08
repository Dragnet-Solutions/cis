/**
 * People & Access — Phase 8 (UX-OPS-006) DoD §10.
 *  - Two-approver floor ENFORCED on both routes (removal, un-tick approve),
 *    server-side; both succeed once a third approver exists.
 *  - Dragnet right rejected server-side for a CIS person.
 *  - Self-removal rejected regardless of rights.
 *  - Zero-people vs. too-few-approvers are distinct, independently reachable.
 *  - Email format + duplicate (excluding the record being edited) rejection.
 *  - Critical-action permission snapshot: a request stands even if the
 *    requester's rights change afterwards (safe-reading default).
 *  - Regression: the six critical actions' own logic is untouched.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { getUserByEmail, getPermissionByCode, revokePermissionFromUser } from '@cis/db';
import { loadRbacContext, requestCriticalAction, approveCriticalActionWithRbac } from '@cis/auth';
import {
  seedReferenceData,
  listPeople,
  countApprovers,
  addPerson,
  updatePersonRights,
  removePerson,
} from '../src';
import { getTestPool, runMigrations, truncateAllTables, closeTestPool } from '../../db/tests/setup';

let pool: Pool;
let editionId: string;
let makerId: string; // Adaeze, CIS — holds approve
let checkerId: string; // Segun, Dragnet — holds approve

beforeAll(async () => {
  pool = getTestPool();
  await runMigrations();
});
beforeEach(async () => {
  await truncateAllTables(pool);
  const seeded = await seedReferenceData(pool);
  editionId = seeded.editionId;
  makerId = seeded.makerUserId;
  checkerId = seeded.checkerUserId;
});
afterAll(async () => {
  await closeTestPool();
});

const rights = (partial: Record<string, boolean>) => partial;

describe('Baseline roster', () => {
  it('opens at exactly the two-approver floor', async () => {
    expect(await countApprovers(pool)).toBe(2);
    const people = await listPeople(pool);
    expect(people).toHaveLength(2);
    expect(people.every((p) => p.rights.view)).toBe(true);
  });
});

describe('Two-approver floor — enforced on both routes', () => {
  it('un-ticking approve on one of exactly two approvers is refused server-side', async () => {
    await expect(
      updatePersonRights(pool, {
        userId: checkerId,
        name: 'Segun Oyegbesan',
        email: 'segun.oyegbesan@dragnet.example',
        organization: 'Dragnet',
        rights: rights({ approve: false, request: true, setup: true }),
        actorId: makerId,
      }),
    ).rejects.toMatchObject({ code: 'APPROVER_FLOOR' });
  });

  it('removing one of exactly two approvers is refused server-side', async () => {
    await expect(removePerson(pool, { userId: checkerId, actorId: makerId })).rejects.toMatchObject(
      { code: 'APPROVER_FLOOR' },
    );
  });

  it('both succeed once a third approver exists', async () => {
    await addPerson(pool, {
      name: 'Third Approver',
      email: 'third@dragnet.example',
      organization: 'Dragnet',
      rights: rights({ approve: true }),
      actorId: makerId,
    });
    expect(await countApprovers(pool)).toBe(3);

    // Now un-ticking approve on the checker is allowed (two remain).
    const updated = await updatePersonRights(pool, {
      userId: checkerId,
      name: 'Segun Oyegbesan',
      email: 'segun.oyegbesan@dragnet.example',
      organization: 'Dragnet',
      rights: rights({ approve: false }),
      actorId: makerId,
    });
    expect(updated.rights.approve).toBe(false);
    expect(await countApprovers(pool)).toBe(2);

    // And removing an approver is allowed while two still remain... add another first.
    await addPerson(pool, {
      name: 'Fourth Approver',
      email: 'fourth@cis.example',
      organization: 'CIS',
      rights: rights({ approve: true }),
      actorId: makerId,
    });
    expect(await countApprovers(pool)).toBe(3);
    const fourth = await getUserByEmail(pool, 'fourth@cis.example');
    await removePerson(pool, { userId: fourth!.id, actorId: makerId });
    expect(await countApprovers(pool)).toBe(2);
  });
});

describe('Dragnet-only right', () => {
  it('rejects dragnet:true on a CIS person server-side', async () => {
    await expect(
      addPerson(pool, {
        name: 'CIS Analyst',
        email: 'analyst@cis.example',
        organization: 'CIS',
        rights: rights({ dragnet: true }),
        actorId: makerId,
      }),
    ).rejects.toMatchObject({ code: 'DRAGNET_CIS' });
  });

  it('allows dragnet on a Dragnet person', async () => {
    const p = await addPerson(pool, {
      name: 'Dragnet Analyst',
      email: 'analyst@dragnet.example',
      organization: 'Dragnet',
      rights: rights({ dragnet: true }),
      actorId: makerId,
    });
    expect(p.rights.dragnet).toBe(true);
  });
});

describe('Self-removal', () => {
  it('rejects a person removing their own access regardless of rights', async () => {
    await expect(removePerson(pool, { userId: makerId, actorId: makerId })).rejects.toMatchObject({
      code: 'SELF_REMOVAL',
    });
  });
});

describe('Zero-people vs too-few-approvers are distinct', () => {
  it('too-few-approvers is reachable only by SEEDING (the surface refuses to create it), and stays recoverable while people remain', async () => {
    // The surface will not take the estate below two approvers by any route — so
    // a one-approver state can only arrive from a configuration set elsewhere.
    // Simulate that by revoking the checker's approve grant directly, bypassing
    // the surface's guard, then assert the surface still shows the roster and the
    // state is recoverable (grant someone else approve).
    const approvePerm = await getPermissionByCode(pool, 'critical:approve');
    await revokePermissionFromUser(pool, checkerId, approvePerm!.id);

    expect(await countApprovers(pool)).toBe(1); // only the maker approves now
    const people = await listPeople(pool);
    expect(people.length).toBeGreaterThan(0); // people remain → recoverable here

    // Recovery from within the surface: grant a second person approve again.
    await updatePersonRights(pool, {
      userId: checkerId,
      name: 'Segun Oyegbesan',
      email: 'segun.oyegbesan@dragnet.example',
      organization: 'Dragnet',
      rights: rights({ approve: true, request: true, setup: true }),
      actorId: makerId,
    });
    expect(await countApprovers(pool)).toBe(2);
  });

  it('zero-people is a different, distinguishable state', async () => {
    // Reachable in the data; the surface refuses to create it, but a listing of
    // an empty roster is the honest signal and carries no in-service recovery.
    await truncateAllTables(pool);
    const people = await listPeople(pool);
    expect(people).toHaveLength(0);
    expect(await countApprovers(pool)).toBe(0);
  });
});

describe('Email validation', () => {
  it('rejects a malformed email', async () => {
    await expect(
      addPerson(pool, {
        name: 'Bad Email',
        email: 'not-an-email',
        organization: 'CIS',
        rights: rights({}),
        actorId: makerId,
      }),
    ).rejects.toMatchObject({ code: 'EMAIL_INVALID' });
  });

  it('rejects a duplicate email against another person', async () => {
    await expect(
      addPerson(pool, {
        name: 'Clash',
        email: 'adaeze.okoro@cis.example', // maker's seeded email
        organization: 'CIS',
        rights: rights({}),
        actorId: makerId,
      }),
    ).rejects.toMatchObject({ code: 'EMAIL_DUPLICATE' });
  });

  it('allows an edit that keeps the same email (excludes the record being edited)', async () => {
    const p = await addPerson(pool, {
      name: 'Keeper',
      email: 'keeper@cis.example',
      organization: 'CIS',
      rights: rights({ setup: true }),
      actorId: makerId,
    });
    const updated = await updatePersonRights(pool, {
      userId: p.userId,
      name: 'Keeper Renamed',
      email: 'keeper@cis.example', // unchanged — must not be a duplicate error
      organization: 'CIS',
      rights: rights({ setup: false, send: true }),
      actorId: makerId,
    });
    expect(updated.name).toBe('Keeper Renamed');
    expect(updated.rights.send).toBe(true);
    expect(updated.rights.setup).toBe(false);
  });
});

describe('Incomplete payload is refused server-side', () => {
  it('rejects a blank name', async () => {
    await expect(
      addPerson(pool, {
        name: '   ',
        email: 'blank@cis.example',
        organization: 'CIS',
        rights: rights({}),
        actorId: makerId,
      }),
    ).rejects.toMatchObject({ code: 'NAME_REQUIRED' });
  });
});

describe('Critical-action permission snapshot (safe-reading default)', () => {
  it('a request stands for approval even if the requester loses request rights afterwards', async () => {
    // Add a third approver so we can strip the maker's rights without breaching
    // the approver floor.
    await addPerson(pool, {
      name: 'Third Approver',
      email: 'third@dragnet.example',
      organization: 'Dragnet',
      rights: rights({ approve: true }),
      actorId: makerId,
    });

    // The maker requests an edition lock (holds critical:request).
    const rbacMaker = await loadRbacContext(pool, makerId);
    const action = await requestCriticalAction(pool, rbacMaker, {
      actionType: 'edition:lock',
      payload: { reason: 'locking' },
      editionId,
    });

    // Now revoke the maker's request right entirely.
    const reqPerm = await getPermissionByCode(pool, 'critical:request');
    await revokePermissionFromUser(pool, makerId, reqPerm!.id);
    // (edition-lock scoped request also came from the seeded role — strip it too
    //  so the maker truly no longer holds any request right.)
    const scoped = await getPermissionByCode(pool, 'edition:lock:request');
    if (scoped) await revokePermissionFromUser(pool, makerId, scoped.id);

    // The pending request is evaluated against rights held WHEN MADE, so a
    // different approver can still approve it — approval never re-checks the
    // requester's current rights.
    const rbacChecker = await loadRbacContext(pool, checkerId);
    const approved = await approveCriticalActionWithRbac(pool, rbacChecker, action.id);
    expect(approved.status).toBe('approved');
  });
});

describe('Regression — the six critical actions still gate through the same primitive', () => {
  it('a granted approve right lets a different person approve; self-approval still blocked', async () => {
    const rbacMaker = await loadRbacContext(pool, makerId);
    const action = await requestCriticalAction(pool, rbacMaker, {
      actionType: 'instrument:freeze',
      payload: {},
      editionId,
    });
    // Maker cannot approve their own (unchanged maker-checker constraint).
    await expect(approveCriticalActionWithRbac(pool, rbacMaker, action.id)).rejects.toThrow();
    // The checker (holds approve) can.
    const rbacChecker = await loadRbacContext(pool, checkerId);
    const approved = await approveCriticalActionWithRbac(pool, rbacChecker, action.id);
    expect(approved.status).toBe('approved');
  });
});
