/**
 * Part A (Phase 5 fix): funnel_event.segment for institutional completions is
 * derived from the completed instrument, not a uniform default. S5a is a local
 * institutional investor journey (UX-INS-001), S5b a foreign one (UX-INS-002) —
 * they feed two different sufficiency floors, so a uniform default would corrupt
 * both counts in opposite directions.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import {
  createRespondent,
  listFunnelEvents,
  emitFunnelEvent,
  countDistinctInstitutions,
  countDistinctInstitutionsSince,
  countCompletedBySegment,
  countCompletedBySegmentSince,
} from '@cis/db';
import {
  seedReferenceData,
  submitResponses,
  segmentForInstrument,
  isRegulatorInstrument,
  isInvestorInstrument,
  institutionRefFor,
  currentSegmentSufficiency,
  getResponsesMonitor,
} from '../src';
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

/**
 * Regulator submissions (I-SEC / I-NGX / I-CSCS / I-DEP) are Institutional
 * Perspectives context, never institutional-investor participation. They used
 * to be written as `local_institution`, so the SEC and NGX answering showed
 * "Local institutions 2 of 1" with no S5a response at all.
 */
describe('regulator submissions never count toward an investor segment', () => {
  it('maps no regulator instrument to a segment', () => {
    for (const code of ['I-SEC', 'I-NGX', 'I-CSCS', 'I-DEP']) {
      expect(segmentForInstrument(code)).toBeNull();
      expect(isRegulatorInstrument(code)).toBe(true);
      expect(isInvestorInstrument(code)).toBe(false);
    }
    expect(isInvestorInstrument('S5a')).toBe(true);
    expect(isInvestorInstrument('S1')).toBe(false);
    expect(isRegulatorInstrument('S5a')).toBe(false);
  });

  async function submit(instrumentCode: string, institutionName: string): Promise<string> {
    const r = await createRespondent(pool, {
      editionId,
      instrumentCode,
      consentAccepted: true,
      institutionName,
    });
    await submitResponses(pool, {
      editionId,
      respondentId: r.id,
      sharedAnswers: {},
      firmAnswers: {},
    });
    return r.id;
  }

  it('writes no funnel event and leaves every institution count at the S5a total', async () => {
    const sec = await submit('I-SEC', 'Securities and Exchange Commission');
    const ngx = await submit('I-NGX', 'Nigerian Exchange Limited');
    await submit('S5a', 'A Local Pension Fund');

    const events = await listFunnelEvents(pool, editionId);
    expect(events.find((e) => e.responseId === sec)).toBeUndefined();
    expect(events.find((e) => e.responseId === ngx)).toBeUndefined();

    expect(await countDistinctInstitutions(pool, editionId, 'local_institution')).toBe(1);
    expect((await countCompletedBySegment(pool, editionId))['local_institution']).toBe(1);

    // Sufficiency (national report, report dependencies) and monitoring read the same.
    const sufficiency = await currentSegmentSufficiency(pool, editionId);
    expect(sufficiency['local_institution']!.counted).toBe(1);
    const monitor = await getResponsesMonitor(pool, editionId, new Date());
    expect(monitor.cards.find((c) => c.segment === 'local_institution')!.current).toBe(1);
  });

  it('excludes a regulator event written by an earlier build as local_institution', async () => {
    const sec = await createRespondent(pool, {
      editionId,
      instrumentCode: 'I-SEC',
      consentAccepted: true,
      institutionName: 'Securities and Exchange Commission',
    });
    await emitFunnelEvent(pool, {
      eventType: 'completed',
      editionId,
      segment: 'local_institution',
      institutionRef: institutionRefFor('Securities and Exchange Commission'),
      channel: 'portal',
      source: 'direct',
      responseId: sec.id,
    });
    const since = new Date(Date.now() - 86_400_000);

    expect(await countDistinctInstitutions(pool, editionId, 'local_institution')).toBe(0);
    expect(await countDistinctInstitutionsSince(pool, editionId, 'local_institution', since)).toBe(
      0,
    );
    expect((await countCompletedBySegment(pool, editionId))['local_institution']).toBeUndefined();
    expect(
      (await countCompletedBySegmentSince(pool, editionId, since))['local_institution'],
    ).toBeUndefined();
    expect((await currentSegmentSufficiency(pool, editionId))['local_institution']!.counted).toBe(
      0,
    );
  });
});
