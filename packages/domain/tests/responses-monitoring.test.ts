/**
 * UX-OPS-003 Responses monitoring — Phase 13 DoD (DB-backed).
 *  - Single source of truth: the complete-firm risk shown here and the mission
 *    board's conditions 7/8 read the SAME computation and cannot diverge.
 *  - The participating-firms card carries complete-firm status as its own lines.
 *  - The firm report is TWO dependency rows: combined always viable; category cuts
 *    read "Some suppressed" (never "At risk") when thin.
 *  - Institutional pace counts NET-NEW distinct institutions.
 *  - Card rendering: grey bar, red marker, forecast/shortfall, velocity line,
 *    will-miss/on-track, linking to the board condition.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import {
  createOrganization,
  ensureSeats,
  setSeatState,
  createRespondent,
  insertResponse,
  emitFunnelEvent,
  countDistinctInstitutions,
  countDistinctInstitutionsSince,
} from '@cis/db';
import { seedReferenceData, getResponsesMonitor, getMissionBoard } from '../src';
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

/** Put the edition into an OPEN window so forecasts (and conditions 7/8) evaluate. */
async function openWindow(): Promise<Date> {
  const now = Date.now();
  await pool.query(
    `UPDATE editions SET status='open', survey_open_at=$2, survey_close_at=$3 WHERE id=$1`,
    [editionId, new Date(now - 10 * 86_400_000), new Date(now + 20 * 86_400_000)],
  );
  return new Date(now);
}

/** A firm with DMI-complete answers (S1-Q3, S1-Q8 on S1; S3-Q2 on S3). */
async function dmiCompleteFirm(slug: string): Promise<string> {
  const org = await createOrganization(pool, { slug, displayName: slug, orgType: 'firm' });
  await ensureSeats(pool, editionId, org.id);
  const s1 = await createRespondent(pool, { editionId, instrumentCode: 'S1' });
  await setSeatState(pool, {
    editionId,
    organizationId: org.id,
    seatCode: 'S1',
    state: 'complete',
    respondentId: s1.id,
  });
  for (const [q, a] of [
    ['S1-Q3', '8'],
    ['S1-Q8', '9'],
  ] as const) {
    await insertResponse(pool, {
      editionId,
      respondentId: s1.id,
      questionId: q,
      scope: 'shared',
      ratedFirmId: null,
      answer: { a },
    });
  }
  const s3 = await createRespondent(pool, { editionId, instrumentCode: 'S3' });
  await setSeatState(pool, {
    editionId,
    organizationId: org.id,
    seatCode: 'S3',
    state: 'complete',
    respondentId: s3.id,
  });
  await insertResponse(pool, {
    editionId,
    respondentId: s3.id,
    questionId: 'S3-Q2',
    scope: 'shared',
    ratedFirmId: null,
    answer: { a: '0-10%' },
  });
  return org.id;
}

describe('Single source of truth — complete-firm risk cannot diverge from the board', () => {
  it('the DMI-complete card state and mission-board condition 8 reflect one function', async () => {
    const asOf = await openWindow();
    await dmiCompleteFirm('firm-a');
    await dmiCompleteFirm('firm-b'); // 2 DMI-complete firms — far below the 80 floor

    const monitor = await getResponsesMonitor(pool, editionId, asOf);
    const board = await getMissionBoard(pool, editionId, asOf);

    const firmCard = monitor.cards.find((c) => c.segment === 'firm')!;
    const dmiLine = firmCard.completeFirm!.find((l) => l.metric === 'DMI')!;
    const boardHasDmiCard = board.cards.some((c) => c.conditionId === 8);

    // Both read ctx.dmiCompleteForecast — identical reflection of the same data.
    expect(dmiLine.current).toBe(2);
    expect(dmiLine.state === 'will_miss').toBe(boardHasDmiCard);
    expect(dmiLine.state).toBe('will_miss');
    expect(boardHasDmiCard).toBe(true);
  });
});

describe('Participating-firms card carries complete-firm status as its own lines (§B3)', () => {
  it('exposes OMI and DMI complete lines with their required instruments', async () => {
    const asOf = await openWindow();
    await dmiCompleteFirm('firm-x');
    const monitor = await getResponsesMonitor(pool, editionId, asOf);
    const firmCard = monitor.cards.find((c) => c.segment === 'firm')!;
    expect(firmCard.completeFirm).toHaveLength(2);
    const omi = firmCard.completeFirm!.find((l) => l.metric === 'OMI')!;
    const dmi = firmCard.completeFirm!.find((l) => l.metric === 'DMI')!;
    expect(omi.requiredInstruments).toEqual(['S1', 'S2', 'S3']);
    expect(dmi.requiredInstruments).toEqual(['S1', 'S3']);
    expect(dmi.current).toBe(1); // one DMI-complete firm
    expect(omi.current).toBe(0); // not OMI-complete (no S2 / Compliance answers)
  });
});

describe('Firm-report dependency is two rows (§B4)', () => {
  it('combined is always viable; category cuts read "Some suppressed", never "At risk"', async () => {
    const asOf = await openWindow(); // no retail responses → retail is thin
    const monitor = await getResponsesMonitor(pool, editionId, asOf);

    const combined = monitor.dependencies.find((d) => d.outputId === 'PARTICIPATING_FIRM_REPORT')!;
    const cuts = monitor.dependencies.find(
      (d) => d.outputId === 'PARTICIPATING_FIRM_REPORT_CATEGORY_CUTS',
    )!;
    expect(combined.displayState).toBe('guaranteed');
    expect(cuts.displayState).toBe('some_suppressed');
    // The at-risk vocabulary must never appear on either firm-report row.
    expect(combined.displayState).not.toBe('at_risk');
    expect(cuts.displayState).not.toBe('at_risk');

    // §B7: firm-referencing outputs declare their required instruments.
    const omi = monitor.dependencies.find((d) => d.outputId === 'OMI')!;
    expect(omi.requiredInstruments).toEqual(['S1', 'S2', 'S3']);
    const dmi = monitor.dependencies.find((d) => d.outputId === 'DMI')!;
    expect(dmi.requiredInstruments).toEqual(['S1', 'S3']);
  });
});

describe('Institutional pace counts NET-NEW distinct institutions (§B5)', () => {
  it('a second response from an already-counted institution does not inflate current or velocity', async () => {
    const asOf = await openWindow();
    // Two completed events, SAME institution_ref — one distinct institution.
    for (let i = 0; i < 2; i++) {
      await emitFunnelEvent(pool, {
        eventType: 'completed',
        editionId,
        segment: 'local_institution',
        institutionRef: 'INST-TOKEN-1',
        channel: 'portal',
        source: 'direct',
      });
    }
    expect(await countDistinctInstitutions(pool, editionId, 'local_institution')).toBe(1);
    const since = new Date(asOf.getTime() - 7 * 86_400_000);
    expect(await countDistinctInstitutionsSince(pool, editionId, 'local_institution', since)).toBe(
      1,
    );

    const monitor = await getResponsesMonitor(pool, editionId, asOf);
    const local = monitor.cards.find((c) => c.segment === 'local_institution')!;
    expect(local.current).toBe(1); // NOT 2
  });
});

describe('Card rendering (§B6) — grey bar, red marker, forecast, velocity, state, board link', () => {
  it('renders the retail card from seeded completions and links to (not duplicates) the board', async () => {
    const asOf = await openWindow();
    for (let i = 0; i < 5; i++) {
      await emitFunnelEvent(pool, {
        eventType: 'completed',
        editionId,
        segment: 'retail',
        channel: 'portal',
        source: 'direct',
      });
    }
    const monitor = await getResponsesMonitor(pool, editionId, asOf);
    const retail = monitor.cards.find((c) => c.segment === 'retail')!;
    expect(retail.current).toBe(5);
    expect(retail.target).toBe(1111);
    expect(retail.greyBarPct).toBeCloseTo((5 / 1111) * 100, 4);
    expect(retail.redMarkerPct).not.toBeNull();
    expect(retail.state).toBe('will_miss'); // 5 of 1111 with days left → forecast misses
    expect(retail.boardConditionId).toBe(2); // links to the retail Engine-1 card
    // The card reports a state; it carries no action of its own (that's the board).
    expect(retail).not.toHaveProperty('recommendedAction');
  });
});

// Regression (E2E, 2026-09-30): the participating-firms card counted completed
// SEAT surveys against a floor measured in FIRMS — three seats from one firm
// read as three firms ("9 of 3" with three firms fully complete).
describe('Participating firms are counted as firms, not seat responses', () => {
  it('two firms with two completed seats each count as 2, not 4', async () => {
    const asOf = await openWindow();
    for (const slug of ['count-firm-a', 'count-firm-b']) {
      const firmId = await dmiCompleteFirm(slug);
      for (let seat = 0; seat < 2; seat++) {
        await emitFunnelEvent(pool, {
          eventType: 'completed',
          editionId,
          segment: 'firm',
          firmId,
          channel: 'portal',
          source: 'direct',
        });
      }
    }

    const monitor = await getResponsesMonitor(pool, editionId, asOf);
    const firmCard = monitor.cards.find((c) => c.segment === 'firm')!;
    expect(firmCard.current).toBe(2);
  });
});
