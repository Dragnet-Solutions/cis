/**
 * Released reports are frozen (go-live blocker): a released firm report and the
 * published Industry report are served from the snapshot stored when they left
 * CIS. Signing off a later run with different numbers changes drafts, never
 * what a firm or the public was given; a correction is a new version with its
 * own snapshot.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import {
  createOrganization,
  ensureSeats,
  setSeatState,
  createCalculationRun,
  insertCalculatedResult,
  createNationalReport,
  approveNationalReport,
  insertReportNarrative,
  getFirmReportSnapshot,
  getIndustryReportSnapshot,
} from '@cis/db';
import { loadRbacContext, type RbacContext } from '@cis/auth';
import {
  seedReferenceData,
  generateFirmReports,
  openFirmReport,
  requestFirmReportRelease,
  decideFirmReportRelease,
  correctFirmReport,
  requestSignoff,
  approveSignoff,
  buildFirmReportContent,
  buildIndustryReportContent,
  getReleasedFirmReport,
  publishIndustryReport,
  getPublishedIndustryReport,
  releasedFirmReportContent,
  type NarrativeModel,
  type ReleaseOptions,
} from '../src';
import { getTestPool, runMigrations, truncateAllTables, closeTestPool } from '../../db/tests/setup';
import { approveMethodologyForTests } from '../../db/tests/methodology-approval';

let pool: Pool;
let editionId: string;
let maker: RbacContext;
let checker: RbacContext;
let firmId: string;

beforeAll(async () => {
  pool = getTestPool();
  await runMigrations();
});
beforeEach(async () => {
  await truncateAllTables(pool);
  await approveMethodologyForTests(pool);
  const seed = await seedReferenceData(pool);
  editionId = seed.editionId;
  maker = await loadRbacContext(pool, seed.makerUserId);
  checker = await loadRbacContext(pool, seed.checkerUserId);
  const org = await createOrganization(pool, {
    slug: 'frozen-firm',
    displayName: 'Frozen Firm',
    orgType: 'firm',
  });
  firmId = org.id;
  await ensureSeats(pool, editionId, firmId);
  await setSeatState(pool, {
    editionId,
    organizationId: firmId,
    seatCode: 'S1',
    state: 'complete',
  });
});
afterAll(async () => {
  await closeTestPool();
});

/** A signed-off run whose OMI is `firmOmi` for the firm and `industryOmi` for
 *  the industry (from enough firms to clear the floor). */
async function signedRun(firmOmi: number, industryOmi: number): Promise<string> {
  const run = await createCalculationRun(pool, {
    editionId,
    runType: 'scoring',
    datasetHash: `ds-${firmOmi}-${industryOmi}`,
  });
  expect(run.methodologyStatus).toBe('APPROVED');
  await insertCalculatedResult(pool, {
    calculationRunId: run.id,
    subjectType: 'firm',
    subjectId: firmId,
    metricCode: 'OMI',
    value: firmOmi,
    n: 3,
    denominator: 3,
    sufficiencyState: 'REPORTABLE',
  });
  await insertCalculatedResult(pool, {
    calculationRunId: run.id,
    subjectType: 'market',
    subjectId: 'INDUSTRY',
    metricCode: 'OMI',
    value: industryOmi,
    n: 100,
    denominator: 100,
    sufficiencyState: 'REPORTABLE',
  });
  const so = await requestSignoff(pool, {
    editionId,
    calculationRunId: run.id,
    requestedBy: 'maker',
    checkedAccount: {
      populationCountsReviewed: true,
      floorStatusReviewed: true,
      dataQualityFlagsReviewed: true,
    },
  });
  await approveSignoff(pool, { signoffId: so.id, approvedBy: 'checker' });
  return run.id;
}

type Scores = Array<{ code: string; value: number | null }> | null;
const omi = (indices: unknown, scope: 'firm' | 'industry'): number | null => {
  const reported = indices as { firm?: Scores; industry?: Scores };
  const list = scope === 'firm' ? reported.firm : reported.industry;
  return list?.find((s) => s.code === 'OMI')?.value ?? null;
};

async function releaseThroughMakerChecker(reportIds: string[]) {
  const narrative = await insertReportNarrative(pool, {
    editionId,
    kind: 'firm',
    subjectId: firmId,
    sentences: [{ section: 'SUMMARY', text: 'The analysis.', factIds: ['X'], finding: null }],
    facts: [],
    model: 'fake-model',
    createdBy: 'op@cis.example',
  });
  const options: ReleaseOptions = {
    releasedBy: 'op@cis.example',
    prepare: async () => ({ narrativeId: narrative.id }),
  };
  for (const id of reportIds) await openFirmReport(pool, id, maker.userId);
  const action = await requestFirmReportRelease(pool, maker, editionId, {
    reason: 'Every report read against the signed run',
    reportIds,
  });
  const { release } = await decideFirmReportRelease(
    pool,
    checker,
    editionId,
    action.id,
    { approved: true },
    {},
    options,
  );
  return release;
}

describe('A released firm report is frozen', () => {
  it('keeps its figures when a later run is signed off; a correction is a new version', async () => {
    const runA = await signedRun(40, 55);
    const gen = await generateFirmReports(pool, { editionId, scoringRunId: runA });
    const v1 = gen.reports[0]!;
    const nr = await createNationalReport(pool, { editionId, scoringRunId: runA });
    await approveNationalReport(pool, nr.id, 'checker');

    const release = await releaseThroughMakerChecker([v1.id]);
    expect(release?.released.map((r) => r.id)).toEqual([v1.id]);

    // Frozen at release: content, run and methodology version stored.
    const snapshot = await getFirmReportSnapshot(pool, v1.id);
    expect(snapshot?.scoringRunId).toBe(runA);
    expect(snapshot?.methodologyStatus).toBe('APPROVED');
    expect(snapshot?.firmReportVersion).toBe(1);
    expect(omi((snapshot?.content as { indices: unknown }).indices, 'firm')).toBe(40);

    const before = await getReleasedFirmReport(pool, editionId, firmId);
    expect(omi(before?.indices, 'firm')).toBe(40);

    // A newer run, with different numbers, is signed off.
    const runB = await signedRun(90, 70);

    // What the firm was given does not change.
    const after = await getReleasedFirmReport(pool, editionId, firmId);
    expect(omi(after?.indices, 'firm')).toBe(40);
    expect(after?.generatedAt).toBe(before?.generatedAt);

    // A correction is a new, unreleased version: a live draft from the new run.
    const v2 = await correctFirmReport(pool, {
      editionId,
      organizationId: firmId,
      scoringRunId: runB,
    });
    expect(v2.version).toBe(2);
    const draft = await buildFirmReportContent(pool, editionId, firmId);
    expect(draft.report.releaseState).not.toBe('released');
    expect(omi(draft.indices, 'firm')).toBe(90);
    // ...while the released one still reads as released.
    expect(omi((await getReleasedFirmReport(pool, editionId, firmId))?.indices, 'firm')).toBe(40);

    // Releasing the correction freezes it in turn; the first stays as it was.
    await releaseThroughMakerChecker([v2.id]);
    expect(omi((await getReleasedFirmReport(pool, editionId, firmId))?.indices, 'firm')).toBe(90);
    expect((await getFirmReportSnapshot(pool, v2.id))?.scoringRunId).toBe(runB);
    expect(omi((await getFirmReportSnapshot(pool, v1.id))?.content['indices'], 'firm')).toBe(40);
  });

  it('a snapshot can never be edited or deleted', async () => {
    const runA = await signedRun(40, 55);
    const gen = await generateFirmReports(pool, { editionId, scoringRunId: runA });
    const nr = await createNationalReport(pool, { editionId, scoringRunId: runA });
    await approveNationalReport(pool, nr.id, 'checker');
    await releaseThroughMakerChecker([gen.reports[0]!.id]);
    await expect(pool.query(`UPDATE report_snapshots SET content = '{}'::jsonb`)).rejects.toThrow(
      /permanent/,
    );
    await expect(pool.query(`DELETE FROM report_snapshots`)).rejects.toThrow(/permanent/);
  });

  it('a report released before snapshots existed is frozen from its own run on first read', async () => {
    const runA = await signedRun(40, 55);
    const gen = await generateFirmReports(pool, { editionId, scoringRunId: runA });
    const nr = await createNationalReport(pool, { editionId, scoringRunId: runA });
    await approveNationalReport(pool, nr.id, 'checker');
    await releaseThroughMakerChecker([gen.reports[0]!.id]);
    // Simulate a legacy release: no snapshot yet (bypass the permanence trigger).
    await pool.query(`ALTER TABLE report_snapshots DISABLE TRIGGER report_snapshots_no_change`);
    await pool.query(`DELETE FROM report_snapshots`);
    await pool.query(`ALTER TABLE report_snapshots ENABLE TRIGGER report_snapshots_no_change`);

    await signedRun(90, 70);
    // First read freezes from the report's OWN run (A), not the latest sign-off.
    const read = await releasedFirmReportContent(pool, editionId, firmId);
    expect(omi(read?.content.indices, 'firm')).toBe(40);
    expect(read?.snapshot.scoringRunId).toBe(runA);
  });
});

describe('The published Industry report is frozen', () => {
  it('keeps its figures when a later run is signed off; the live draft moves on', async () => {
    const runA = await signedRun(40, 55);
    const nr = await createNationalReport(pool, { editionId, scoringRunId: runA });
    await approveNationalReport(pool, nr.id, 'checker');
    const model: NarrativeModel = {
      name: 'fake-model',
      complete: async () =>
        JSON.stringify({
          sections: { EXEC: [{ text: 'The published analysis.', factIds: ['PART.firm'] }] },
        }),
    };
    await publishIndustryReport(pool, editionId, () => model, 'op@cis.example');

    const snapshot = await getIndustryReportSnapshot(pool, editionId);
    expect(snapshot?.scoringRunId).toBe(runA);
    expect(snapshot?.nationalReportId).toBe(nr.id);
    expect(omi((await getPublishedIndustryReport(pool, editionId)).indices, 'industry')).toBe(55);

    await signedRun(90, 70);
    expect(omi((await getPublishedIndustryReport(pool, editionId)).indices, 'industry')).toBe(55);
    // The live content (what a new draft would be built from) reflects the new run.
    expect(omi((await buildIndustryReportContent(pool, editionId)).indices, 'industry')).toBe(70);
  });
});
