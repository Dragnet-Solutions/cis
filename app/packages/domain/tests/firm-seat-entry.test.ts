/**
 * The real S1/S2/S3 seat entry point — Task D, Part 6. A firm seat is not a
 * special case at the journey layer (startJourney is already fully generic);
 * what's new here is purely the seat-linking wiring, and the guarantee that a
 * stale link (from before a reassignment) resolves to nothing.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { createOrganization, getSeat } from '@cis/db';
import {
  getSeats,
  assignSeat,
  confirmSeatReplacement,
  getSeatEntryContext,
  startSeatEntry,
  completeSeatEntry,
  SeatLinkNotFoundError,
  FirmPortalError,
  seedReferenceData,
} from '../src';
import { getTestPool, runMigrations, truncateAllTables, closeTestPool } from '../../db/tests/setup';

let pool: Pool;
let orgId: string;
let editionId: string;

beforeAll(async () => {
  pool = getTestPool();
  await runMigrations();
});
beforeEach(async () => {
  await truncateAllTables(pool);
  const seed = await seedReferenceData(pool);
  editionId = seed.editionId;
  const org = await createOrganization(pool, {
    slug: 'seat-entry-firm',
    displayName: 'Seat Entry Firm',
    orgType: 'firm',
  });
  orgId = org.id;
  await getSeats(pool, editionId, orgId);
});
afterAll(async () => {
  await closeTestPool();
});

describe('getSeatEntryContext', () => {
  it('resolves a valid link token to state-only context, never a name or email', async () => {
    const seat = await assignSeat(pool, {
      editionId,
      organizationId: orgId,
      seatCode: 'S1',
      assignedName: 'Jane MD',
      assignedEmail: 'jane@seat-entry-firm.example',
    });
    const ctx = await getSeatEntryContext(pool, seat.linkToken);
    expect(ctx).toEqual({
      editionId,
      organizationId: orgId,
      seatCode: 'S1',
      roleLabel: 'MD or Chief Executive',
      state: 'invited',
      editionStatus: expect.any(String),
    });
    expect(ctx).not.toHaveProperty('assignedName');
    expect(ctx).not.toHaveProperty('respondentId');
  });

  it('throws SeatLinkNotFoundError for an unknown token', async () => {
    await expect(
      getSeatEntryContext(pool, '00000000-0000-0000-0000-000000000000'),
    ).rejects.toBeInstanceOf(SeatLinkNotFoundError);
  });
});

describe('A reassigned seat retires its old link', () => {
  it("the previous occupant's link no longer resolves to anything after a replacement", async () => {
    const seat = await assignSeat(pool, {
      editionId,
      organizationId: orgId,
      seatCode: 'S2',
      assignedName: 'Old Compliance',
      assignedEmail: 'old@seat-entry-firm.example',
    });
    const oldToken = seat.linkToken;

    await confirmSeatReplacement(pool, editionId, orgId, 'S2');
    const reassigned = await assignSeat(pool, {
      editionId,
      organizationId: orgId,
      seatCode: 'S2',
      assignedName: 'New Compliance',
      assignedEmail: 'new@seat-entry-firm.example',
    });

    expect(reassigned.linkToken).not.toBe(oldToken);
    await expect(getSeatEntryContext(pool, oldToken)).rejects.toBeInstanceOf(SeatLinkNotFoundError);
    // The new link works.
    const ctx = await getSeatEntryContext(pool, reassigned.linkToken);
    expect(ctx.state).toBe('invited');
  });
});

describe('startSeatEntry', () => {
  it('starts a real journey and links it back to the seat, moving it to started', async () => {
    const seat = await assignSeat(pool, {
      editionId,
      organizationId: orgId,
      seatCode: 'S3',
      assignedName: 'Ops Person',
      assignedEmail: 'ops@seat-entry-firm.example',
    });

    const result = await startSeatEntry(pool, seat.linkToken);
    expect(result.editionId).toBe(editionId);
    expect(result.seatCode).toBe('S3');
    expect(result.respondentId).toBeTruthy();

    const row = await getSeat(pool, editionId, orgId, 'S3');
    expect(row?.state).toBe('started');
    expect(row?.respondentId).toBe(result.respondentId);
  });

  // A started seat resumes its own respondent (the link is the seat's
  // credential); only a completed seat is refused.
  it('resumes a started seat and refuses a completed one', async () => {
    const seat = await assignSeat(pool, {
      editionId,
      organizationId: orgId,
      seatCode: 'S1',
      assignedName: 'Jane MD',
      assignedEmail: 'jane2@seat-entry-firm.example',
    });
    const first = await startSeatEntry(pool, seat.linkToken);
    const again = await startSeatEntry(pool, seat.linkToken);
    expect(again.respondentId).toBe(first.respondentId);

    await completeSeatEntry(pool, seat.linkToken);
    await expect(startSeatEntry(pool, seat.linkToken)).rejects.toBeInstanceOf(FirmPortalError);
  });
});

describe('completeSeatEntry', () => {
  it('moves a started seat to complete', async () => {
    const seat = await assignSeat(pool, {
      editionId,
      organizationId: orgId,
      seatCode: 'S1',
      assignedName: 'Jane MD',
      assignedEmail: 'jane3@seat-entry-firm.example',
    });
    await startSeatEntry(pool, seat.linkToken);
    await completeSeatEntry(pool, seat.linkToken);

    const row = await getSeat(pool, editionId, orgId, 'S1');
    expect(row?.state).toBe('complete');
  });
});
