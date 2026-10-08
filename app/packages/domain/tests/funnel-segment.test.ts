/**
 * Part A (Phase 5 fix): funnel_event.segment for institutional completions is
 * derived from the completed instrument, not a uniform default. S5a is a local
 * institutional investor journey (UX-INS-001), S5b a foreign one (UX-INS-002) —
 * they feed two different sufficiency floors, so a uniform default would corrupt
 * both counts in opposite directions.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { createRespondent, listFunnelEvents } from '@cis/db';
import { seedReferenceData, submitResponses, segmentForInstrument } from '../src';
import { getTestPool, runMigrations, truncateAllTables, closeTestPool } from '../../db/tests/setup';

let pool: Pool;
let editionId: string;

beforeAll(async () => {
  pool = getTestPool();
  await runMigrations();
});
beforeEach(async () => {
  await truncateAllTables(pool);
  editionId = (await seedReferenceData(pool)).editionId;
});
afterAll(async () => {
  await closeTestPool();
});

describe('segmentForInstrument (pure derivation)', () => {
  it('maps each instrument to its segment, S5a≠S5b', () => {
    expect(segmentForInstrument('S1')).toBe('firm');
    expect(segmentForInstrument('S4')).toBe('retail');
    expect(segmentForInstrument('S5a')).toBe('local_institution');
    expect(segmentForInstrument('S5b')).toBe('foreign_institution');
  });
});

describe('institutional completions derive the correct funnel segment', () => {
  it('an S5a completion is local_institution and an S5b completion is foreign_institution', async () => {
    const localR = await createRespondent(pool, {
      editionId,
      instrumentCode: 'S5a',
      consentAccepted: true,
      institutionName: 'A Local Pension Fund',
    });
    await submitResponses(pool, {
      editionId,
      respondentId: localR.id,
      sharedAnswers: {},
      firmAnswers: {},
    });

    const foreignR = await createRespondent(pool, {
      editionId,
      instrumentCode: 'S5b',
      consentAccepted: true,
      institutionName: 'A Foreign Asset Manager',
    });
    await submitResponses(pool, {
      editionId,
      respondentId: foreignR.id,
      sharedAnswers: {},
      firmAnswers: {},
    });

    const events = await listFunnelEvents(pool, editionId);
    const local = events.find((e) => e.responseId === localR.id);
    const foreign = events.find((e) => e.responseId === foreignR.id);

    expect(local?.segment).toBe('local_institution');
    // The whole point of the fix: an S5b completion is NOT local_institution.
    expect(foreign?.segment).toBe('foreign_institution');
    expect(foreign?.segment).not.toBe('local_institution');
    // And they carry distinct institution tokens (counted by distinct ref).
    expect(local?.institutionRef).toBeTruthy();
    expect(foreign?.institutionRef).toBeTruthy();
    expect(local?.institutionRef).not.toBe(foreign?.institutionRef);
  });
});
