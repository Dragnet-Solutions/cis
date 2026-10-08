/**
 * Firm report generation & release — Phase 6 (E08) DoD §8.
 *  - FRM_01/02/03 guaranteed (never suppressed); FRM_04 three-state at 9/15/30.
 *  - Atomic per-report release: one failing report doesn't block the others; the
 *    failed one is HELD, not excluded.
 *  - Release ordering: blocked until the national report is approved.
 *  - Immutability: a released report cannot be edited or recalled; a correction
 *    is a new version.
 *  - Zero participating firms is a distinct "nothing to produce" state.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import {
  createOrganization,
  ensureSeats,
  setSeatState,
  createCalculationRun,
  createNationalReport,
  approveNationalReport,
  listReleaseHistory,
  getFirmReport,
} from '@cis/db';
import {
  seedReferenceData,
  getRetailCutThresholds,
  cutStateFor,
  generateFirmReports,
  approveFirmReport,
  regenerateFirmReport,
  releaseFirmReports,
  correctFirmReport,
  buildEvidencePack,
  requestSignoff,
  approveSignoff,
} from '../src';
import { getTestPool, runMigrations, truncateAllTables, closeTestPool } from '../../db/tests/setup';

let pool: Pool;
let editionId: string;
let scoringRunId: string;

beforeAll(async () => {
  pool = getTestPool();
  await runMigrations();
});
beforeEach(async () => {
  await truncateAllTables(pool);
  editionId = (await seedReferenceData(pool)).editionId;
  const run = await createCalculationRun(pool, {
    editionId,
    runType: 'scoring',
    datasetHash: 'ds',
    status: 'complete',
  });
  scoringRunId = run.id;
  // Phase 7: firm reports can only be generated from a genuinely SIGNED-OFF run.
  const so = await requestSignoff(pool, {
    editionId,
    calculationRunId: scoringRunId,
    requestedBy: 'maker',
    checkedAccount: {
      populationCountsReviewed: true,
      floorStatusReviewed: true,
      dataQualityFlagsReviewed: true,
    },
  });
  await approveSignoff(pool, { signoffId: so.id, approvedBy: 'checker' });
});
afterAll(async () => {
  await closeTestPool();
});

async function firm(slug: string) {
  return createOrganization(pool, { slug, displayName: slug.toUpperCase(), orgType: 'firm' });
}
async function participatingFirm(slug: string) {
  const org = await firm(slug);
  await ensureSeats(pool, editionId, org.id);
  await setSeatState(pool, {
    editionId,
    organizationId: org.id,
    seatCode: 'S1',
    state: 'complete',
  });
  return org;
}
async function approveNationalFor() {
  const nr = await createNationalReport(pool, { editionId, scoringRunId });
  await approveNationalReport(pool, nr.id, 'checker');
}

describe('FRM_04 three-state threshold (governed, provisional)', () => {
  it('is none below 10, directional 10–29, unlocked 30+', async () => {
    const t = await getRetailCutThresholds(pool);
    expect(t.provisional).toBe(true);
    expect(cutStateFor(9, t)).toBe('none');
    expect(cutStateFor(15, t)).toBe('directional');
    expect(cutStateFor(30, t)).toBe('unlocked');
  });
});

describe('The guarantee: FRM_01/02/03 never withheld', () => {
  it('a participating firm with zero retail responses still gets a report (cut none)', async () => {
    const a = await participatingFirm('firm-thin');
    const gen = await generateFirmReports(pool, { editionId, scoringRunId });
    const report = gen.reports.find((r) => r.organizationId === a.id)!;
    expect(report).toBeTruthy();
    expect(report.generationState).toBe('generated'); // combined report produced
    expect(report.cutState).toBe('none'); // only the retail cut is gated
  });

  it('the evidence-pack builder refuses to suppress a guaranteed section', async () => {
    const a = await participatingFirm('firm-guard');
    // A guaranteed section arriving SUPPRESSED is a builder error, not a data outcome.
    await expect(
      buildEvidencePack(pool, {
        calculationRunId: scoringRunId,
        reportType: 'FIRM_REPORT',
        subjectType: 'firm',
        subjectId: a.id,
        facts: [{ sectionId: 'FRM_01', sufficiencyState: 'SUPPRESSED' }],
      }),
    ).rejects.toMatchObject({ code: 'GUARANTEED_SECTION_SUPPRESSED' });
  });
});

describe('Generation & reconciliation', () => {
  it('produces one report per participating firm and reconciles to the count', async () => {
    await participatingFirm('firm-1');
    await participatingFirm('firm-2');
    await firm('firm-nonparticipating'); // no complete seat → not eligible
    const gen = await generateFirmReports(pool, { editionId, scoringRunId });
    expect(gen.zeroFirms).toBe(false);
    expect(gen.expectedCount).toBe(2);
    expect(gen.reports).toHaveLength(2);
    expect(gen.reconciled).toBe(true);
  });

  it('zero participating firms is a distinct "nothing to produce" state', async () => {
    const gen = await generateFirmReports(pool, { editionId, scoringRunId });
    expect(gen.zeroFirms).toBe(true);
    expect(gen.reports).toHaveLength(0);
    expect(gen.reconciled).toBe(true); // not a suppression, not a failure
  });
});

describe('Atomic per-report release', () => {
  it('one failed report is held, not excluded, and does not block the others', async () => {
    const a = await participatingFirm('firm-ok');
    const b = await participatingFirm('firm-fail');
    const gen = await generateFirmReports(pool, {
      editionId,
      scoringRunId,
      failFor: [b.id],
    });
    // Approve the one that generated.
    const okReport = gen.reports.find((r) => r.organizationId === a.id)!;
    await approveFirmReport(pool, okReport.id);
    await approveNationalFor();

    const result = await releaseFirmReports(pool, editionId);
    expect(result.released.map((r) => r.organizationId)).toEqual([a.id]);
    expect(result.held.map((h) => h.report.organizationId)).toContain(b.id);
    // The held one is held, not excluded — recorded in the permanent history.
    const history = await listReleaseHistory(pool, editionId);
    expect(history.some((h) => h.organizationId === b.id && h.action === 'held')).toBe(true);
    expect(history.some((h) => h.organizationId === a.id && h.action === 'released')).toBe(true);
  });
});

describe('Release ordering', () => {
  it('release is blocked until the national report is approved', async () => {
    const a = await participatingFirm('firm-order');
    const gen = await generateFirmReports(pool, { editionId, scoringRunId });
    await approveFirmReport(pool, gen.reports.find((r) => r.organizationId === a.id)!.id);
    // No approved national report yet.
    await expect(releaseFirmReports(pool, editionId)).rejects.toMatchObject({
      code: 'NATIONAL_NOT_APPROVED',
    });
  });
});

describe('Immutability of a released report', () => {
  it('a released report cannot be edited or recalled; a correction is a new version', async () => {
    const a = await participatingFirm('firm-immutable');
    const gen = await generateFirmReports(pool, { editionId, scoringRunId });
    const report = gen.reports.find((r) => r.organizationId === a.id)!;
    await approveFirmReport(pool, report.id);
    await approveNationalFor();
    const { released } = await releaseFirmReports(pool, editionId);
    const releasedReport = released[0]!;

    // The DB blocks any update/delete to a released row.
    await expect(
      pool.query(`UPDATE firm_reports SET retail_n = 999 WHERE id = $1`, [releasedReport.id]),
    ).rejects.toThrow(/released and immutable/);
    await expect(
      pool.query(`DELETE FROM firm_reports WHERE id = $1`, [releasedReport.id]),
    ).rejects.toThrow(/released and immutable/);

    // A correction is a new, separately-versioned report; the released one stands.
    const corrected = await correctFirmReport(pool, {
      editionId,
      organizationId: a.id,
      scoringRunId,
    });
    expect(corrected.version).toBe(releasedReport.version + 1);
    expect((await getFirmReport(pool, releasedReport.id))?.releaseState).toBe('released');
  });
});

describe('Regeneration — retrying a failed report, never a released one', () => {
  it('retries a failed report back to generated, recording it in the release history', async () => {
    const a = await participatingFirm('firm-retry');
    const gen = await generateFirmReports(pool, { editionId, scoringRunId, failFor: [a.id] });
    const report = gen.reports.find((r) => r.organizationId === a.id)!;
    expect(report.generationState).toBe('failed');

    const regenerated = await regenerateFirmReport(pool, report.id);
    expect(regenerated.generationState).toBe('generated');
    const history = await listReleaseHistory(pool, editionId);
    expect(history.some((h) => h.organizationId === a.id && h.action === 'regenerated')).toBe(true);
  });

  it('refuses to regenerate an already-released report, with a clean domain error', async () => {
    const a = await participatingFirm('firm-released-retry');
    const gen = await generateFirmReports(pool, { editionId, scoringRunId });
    const report = gen.reports.find((r) => r.organizationId === a.id)!;
    await approveFirmReport(pool, report.id);
    await approveNationalFor();
    const { released } = await releaseFirmReports(pool, editionId);
    const releasedReport = released[0]!;

    await expect(regenerateFirmReport(pool, releasedReport.id)).rejects.toMatchObject({
      code: 'ALREADY_RELEASED',
    });
    // Never even reached the DB's own trigger — the release state is unchanged.
    expect((await getFirmReport(pool, releasedReport.id))?.releaseState).toBe('released');
  });
});
