/**
 * Scoring & sign-off — Phase 7 (UX-ADM-004) DoD §9.
 *  - Scoring is blocked while the edition is open; succeeds once locked.
 *  - A second run over the same frozen dataset is a new immutable run; the prior
 *    signed run transitions to `superseded` ONLY once the new one is signed off.
 *  - Sign-off needs the structured checked-account, not a bare reason;
 *    requester ≠ approver.
 *  - Per-index populations: OMI = all three seats; DMI = S1+S3; a firm with
 *    S1+S2 (no S3) counts for neither.
 *  - A sub-floor index is flagged and still displayed, not suppressed.
 *  - Superseded runs remain queryable with who/when indefinitely.
 *  - Firm/national report generation is gated on a genuine signed-off run.
 *  - Signing off a new run never alters a report already released.
 *  - Scores are bounded to the 0–100 framework scale (validation_error).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import {
  updateEditionStatus,
  createOrganization,
  ensureSeats,
  setSeatState,
  createCalculationRun,
  insertCalculatedResult,
  listCalculationRuns,
  getSignoff as dbGetSignoff,
  getAuthoritativeSignoff as dbGetAuthoritative,
} from '@cis/db';
import {
  seedReferenceData,
  triggerScoringRun,
  listScoringRuns,
  requestSignoff,
  approveSignoff,
  rejectSignoff,
  getScoreView,
  listSignoffs,
  generateFirmReports,
  ScoringBlockedError,
  SignoffPayloadError,
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

const goodAccount = {
  populationCountsReviewed: true,
  floorStatusReviewed: true,
  dataQualityFlagsReviewed: true,
};

async function lockEdition(): Promise<void> {
  await updateEditionStatus(pool, editionId, 'locked');
}

async function completedRun(hash = 'ds'): Promise<string> {
  const run = await createCalculationRun(pool, {
    editionId,
    runType: 'scoring',
    datasetHash: hash,
    status: 'complete',
  });
  return run.id;
}

async function signOff(runId: string, maker = 'maker', checker = 'checker'): Promise<string> {
  const so = await requestSignoff(pool, {
    editionId,
    calculationRunId: runId,
    requestedBy: maker,
    checkedAccount: goodAccount,
  });
  const approved = await approveSignoff(pool, { signoffId: so.id, approvedBy: checker });
  return approved.id;
}

describe('Scoring trigger — blocked while collection is open', () => {
  it('refuses to run while the edition is open (draft or open), succeeds once locked', async () => {
    // Seed leaves the edition in draft — collection has not even opened.
    await expect(triggerScoringRun(pool, { editionId })).rejects.toBeInstanceOf(
      ScoringBlockedError,
    );

    await updateEditionStatus(pool, editionId, 'open');
    await expect(triggerScoringRun(pool, { editionId })).rejects.toMatchObject({
      code: 'BLOCKED_COLLECTION_OPEN',
    });

    await lockEdition();
    const { run } = await triggerScoringRun(pool, { editionId });
    expect(run.runType).toBe('scoring');
    expect(run.status).toBe('complete');
  });
});

describe('Multiple runs & supersede-on-sign-off', () => {
  it('a second run is a separate immutable record; the prior signed run supersedes only once the new one is signed off', async () => {
    await lockEdition();
    const { run: run1 } = await triggerScoringRun(pool, { editionId });
    const so1 = await signOff(run1.id);

    // A second run over the same frozen dataset — a new, separate run record.
    const { run: run2 } = await triggerScoringRun(pool, { editionId });
    expect(run2.id).not.toBe(run1.id);
    const runs = await listScoringRuns(pool, editionId);
    expect(runs).toHaveLength(2);

    // run2 merely existing must NOT supersede run1's sign-off.
    expect((await dbGetSignoff(pool, so1))?.state).toBe('signed_off');
    expect((await dbGetAuthoritative(pool, editionId))?.calculationRunId).toBe(run1.id);

    // Signing off run2 is the moment run1's sign-off becomes superseded.
    const so2 = await signOff(run2.id);
    expect((await dbGetSignoff(pool, so1))?.state).toBe('superseded');
    expect((await dbGetSignoff(pool, so2))?.state).toBe('signed_off');
    expect((await dbGetAuthoritative(pool, editionId))?.calculationRunId).toBe(run2.id);
  });
});

describe('Structured sign-off payload & maker-checker', () => {
  it('rejects a payload missing a confirmed checklist item (not a bare reason)', async () => {
    await lockEdition();
    const { run } = await triggerScoringRun(pool, { editionId });
    await expect(
      requestSignoff(pool, {
        editionId,
        calculationRunId: run.id,
        requestedBy: 'maker',
        checkedAccount: {
          populationCountsReviewed: true,
          floorStatusReviewed: false, // not confirmed
          dataQualityFlagsReviewed: true,
        },
      }),
    ).rejects.toBeInstanceOf(SignoffPayloadError);
  });

  it('a maker can never approve their own sign-off', async () => {
    await lockEdition();
    const { run } = await triggerScoringRun(pool, { editionId });
    const so = await requestSignoff(pool, {
      editionId,
      calculationRunId: run.id,
      requestedBy: 'adaeze',
      checkedAccount: goodAccount,
    });
    await expect(
      approveSignoff(pool, { signoffId: so.id, approvedBy: 'adaeze' }),
    ).rejects.toMatchObject({ code: 'SELF_APPROVAL' });

    // A different person can.
    const approved = await approveSignoff(pool, { signoffId: so.id, approvedBy: 'segun' });
    expect(approved.state).toBe('signed_off');
    expect(approved.approvedBy).toBe('segun');
  });
});

describe('Reject — the same maker-checker shape as approval', () => {
  it('a maker can never reject their own sign-off', async () => {
    await lockEdition();
    const { run } = await triggerScoringRun(pool, { editionId });
    const so = await requestSignoff(pool, {
      editionId,
      calculationRunId: run.id,
      requestedBy: 'adaeze',
      checkedAccount: goodAccount,
    });
    await expect(
      rejectSignoff(pool, { signoffId: so.id, rejectedBy: 'adaeze', reason: 'Not convincing' }),
    ).rejects.toMatchObject({ code: 'SELF_REJECTION' });

    // A different person can.
    const rejected = await rejectSignoff(pool, {
      signoffId: so.id,
      rejectedBy: 'segun',
      reason: 'Population counts look stale',
    });
    expect(rejected.state).toBe('rejected');
    expect(rejected.rejectedBy).toBe('segun');
    expect(rejected.rejectionReason).toBe('Population counts look stale');
    expect(rejected.rejectedAt).not.toBeNull();
  });

  it('requires a non-empty reason', async () => {
    await lockEdition();
    const { run } = await triggerScoringRun(pool, { editionId });
    const so = await requestSignoff(pool, {
      editionId,
      calculationRunId: run.id,
      requestedBy: 'adaeze',
      checkedAccount: goodAccount,
    });
    await expect(
      rejectSignoff(pool, { signoffId: so.id, rejectedBy: 'segun', reason: '   ' }),
    ).rejects.toBeInstanceOf(SignoffPayloadError);
  });

  it('a rejected sign-off is not live — the run is free for a fresh request', async () => {
    await lockEdition();
    const { run } = await triggerScoringRun(pool, { editionId });
    const so = await requestSignoff(pool, {
      editionId,
      calculationRunId: run.id,
      requestedBy: 'adaeze',
      checkedAccount: goodAccount,
    });
    await rejectSignoff(pool, { signoffId: so.id, rejectedBy: 'segun', reason: 'Try again' });

    const fresh = await requestSignoff(pool, {
      editionId,
      calculationRunId: run.id,
      requestedBy: 'adaeze',
      checkedAccount: goodAccount,
    });
    expect(fresh.state).toBe('requested');
    expect(fresh.id).not.toBe(so.id);

    const approved = await approveSignoff(pool, { signoffId: fresh.id, approvedBy: 'segun' });
    expect(approved.state).toBe('signed_off');
  });

  it('cannot reject a sign-off that is not in the requested state', async () => {
    await lockEdition();
    const { run } = await triggerScoringRun(pool, { editionId });
    const soId = await signOff(run.id, 'adaeze', 'segun');
    await expect(
      rejectSignoff(pool, { signoffId: soId, rejectedBy: 'ada', reason: 'Too late' }),
    ).rejects.toMatchObject({ code: 'NOT_REQUESTED' });
  });
});

describe('Per-index population predicates — configuration, not a shared eligibility set', () => {
  async function firmWithSeats(slug: string, complete: Array<'S1' | 'S2' | 'S3'>) {
    const org = await createOrganization(pool, {
      slug,
      displayName: slug.toUpperCase(),
      orgType: 'firm',
    });
    await ensureSeats(pool, editionId, org.id);
    for (const seat of complete) {
      await setSeatState(pool, {
        editionId,
        organizationId: org.id,
        seatCode: seat,
        state: 'complete',
      });
    }
    return org;
  }

  it('OMI needs all three seats; DMI needs S1+S3; S1+S2-only counts for neither', async () => {
    await firmWithSeats('firm-all', ['S1', 'S2', 'S3']); // OMI ✓  DMI ✓
    await firmWithSeats('firm-s1s3', ['S1', 'S3']); //        OMI ✗  DMI ✓
    await firmWithSeats('firm-s1s2', ['S1', 'S2']); //        OMI ✗  DMI ✗
    await lockEdition();
    const { run } = await triggerScoringRun(pool, { editionId });

    const view = await getScoreView(pool, editionId, run.id);
    const omi = view.find((v) => v.metricCode === 'OMI')!;
    const dmi = view.find((v) => v.metricCode === 'DMI')!;

    expect(omi.effectivePopulation).toBe(1); // only firm-all
    expect(dmi.effectivePopulation).toBe(2); // firm-all + firm-s1s3, never firm-s1s2
  });

  it('investor-side indices are flagged as an unresolved population gap, not given an invented rule', async () => {
    await lockEdition();
    const { run } = await triggerScoringRun(pool, { editionId });
    const view = await getScoreView(pool, editionId, run.id);
    const iei = view.find((v) => v.metricCode === 'IEI')!;
    expect(iei.populationGap).toBe(true);
    expect(iei.effectivePopulation).toBeNull();
  });
});

describe('Score visibility — a sub-floor index is flagged, not hidden', () => {
  it('shows the index with its (sub-floor) population and score, flagged', async () => {
    // One complete firm — far below the 80-firm floor.
    const org = await createOrganization(pool, {
      slug: 'lonely-firm',
      displayName: 'LONELY',
      orgType: 'firm',
    });
    await ensureSeats(pool, editionId, org.id);
    for (const seat of ['S1', 'S2', 'S3'] as const) {
      await setSeatState(pool, {
        editionId,
        organizationId: org.id,
        seatCode: seat,
        state: 'complete',
      });
    }
    await lockEdition();
    const { run } = await triggerScoringRun(pool, { editionId });
    // Attach a real score to OMI so we prove the score is shown, not suppressed.
    await insertCalculatedResult(pool, {
      calculationRunId: run.id,
      subjectType: 'firm',
      subjectId: org.id,
      metricCode: 'OMI',
      value: 61,
      n: 40,
      denominator: 40,
      sufficiencyState: 'REPORTABLE',
    });

    const view = await getScoreView(pool, editionId, run.id);
    const omi = view.find((v) => v.metricCode === 'OMI')!;
    expect(omi.effectivePopulation).toBe(1);
    expect(omi.clearsFloor).toBe(false);
    expect(omi.subFloor).toBe(true); // flagged
    expect(omi.score).toBe(61); // still displayed, not suppressed
  });
});

describe('History — superseded runs remain queryable indefinitely', () => {
  it('keeps every sign-off with who/when, superseded ones included', async () => {
    await lockEdition();
    const { run: run1 } = await triggerScoringRun(pool, { editionId });
    await signOff(run1.id, 'adaeze', 'segun');
    const { run: run2 } = await triggerScoringRun(pool, { editionId });
    await signOff(run2.id, 'adaeze', 'segun');

    const history = await listSignoffs(pool, editionId);
    expect(history).toHaveLength(2);
    const superseded = history.find((h) => h.state === 'superseded')!;
    expect(superseded.requestedBy).toBe('adaeze');
    expect(superseded.approvedBy).toBe('segun');
    expect(superseded.approvedAt).not.toBeNull();
    expect(superseded.supersededAt).not.toBeNull();
  });
});

describe('Report generation is gated on a genuine signed-off run', () => {
  it('firm-report generation refuses a completed-but-unsigned run', async () => {
    await lockEdition();
    const runId = await completedRun('ds-unsigned');
    await expect(
      generateFirmReports(pool, { editionId, scoringRunId: runId }),
    ).rejects.toMatchObject({ code: 'SCORING_RUN_NOT_SIGNED_OFF' });
    // Once signed off, generation is allowed (zero firms here → nothing to produce).
    await signOff(runId);
    const gen = await generateFirmReports(pool, { editionId, scoringRunId: runId });
    expect(gen.zeroFirms).toBe(true);
  });
});

describe('Immutability — a new sign-off never touches an existing run/result', () => {
  it('signing off a later run leaves the earlier run and its results unchanged', async () => {
    await lockEdition();
    const { run: run1 } = await triggerScoringRun(pool, { editionId });
    await signOff(run1.id);
    const before = await listCalculationRuns(pool, editionId, 'scoring');

    const { run: run2 } = await triggerScoringRun(pool, { editionId });
    await signOff(run2.id);

    // run1 itself is untouched (immutable), still present in history.
    const after = await listCalculationRuns(pool, editionId, 'scoring');
    expect(after.some((r) => r.id === run1.id)).toBe(true);
    expect(after.length).toBe(before.length + 1);
  });
});

describe('Scores are bounded to the 0–100 framework scale', () => {
  it('rejects a value outside 0–100 at the data layer (validation_error)', async () => {
    await lockEdition();
    const { run } = await triggerScoringRun(pool, { editionId });
    const org = await createOrganization(pool, {
      slug: 'oob-firm',
      displayName: 'OOB',
      orgType: 'firm',
    });
    await expect(
      insertCalculatedResult(pool, {
        calculationRunId: run.id,
        subjectType: 'firm',
        subjectId: org.id,
        metricCode: 'OMI',
        value: 150, // out of range
        n: 10,
        denominator: 10,
        sufficiencyState: 'REPORTABLE',
      }),
    ).rejects.toThrow(/calculated_results_value_range/);
  });
});
