/**
 * Firm report generation & release — Phase 6 (E08) DoD §8.
 *  - FRM_01/02/03 guaranteed (never suppressed); FRM_04 three-state at 9/15/30.
 *  - Atomic per-report release: one failing report doesn't block the others; the
 *    failed one is HELD, not excluded.
 *  - Release ordering: blocked until the national report is approved.
 *  - Immutability: a released report cannot be edited or recalled; a correction
 *    is a new version.
 *  - Zero participating firms is a distinct "nothing to produce" state.
 *  - Release is a critical action (maker-checker): one person requests it with
 *    a reason, a DIFFERENT person approves, every covered report opened by one
 *    of the two first; approving releases. No one approves a report alone.
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
  insertReportNarrative,
  createCoordinator,
} from '@cis/db';
import { loadRbacContext, MakerCheckerViolationError, type RbacContext } from '@cis/auth';
import {
  seedReferenceData,
  getRetailCutThresholds,
  cutStateFor,
  generateFirmReports,
  openFirmReport,
  requestFirmReportRelease,
  decideFirmReportRelease,
  getPendingFirmReportRelease,
  regenerateFirmReport,
  releaseFirmReports,
  correctFirmReport,
  buildEvidencePack,
  requestSignoff,
  approveSignoff,
  getFirmNarrative,
  generateFirmNarrative,
  getReleasedFirmReport,
  queueReleaseNotices,
  publishIndustryReport,
  generateIndustryNarrative,
  getPublishedIndustryReport,
  type NarrativeModel,
  type ReleaseOptions,
} from '../src';
import { getTestPool, runMigrations, truncateAllTables, closeTestPool } from '../../db/tests/setup';

let pool: Pool;
let editionId: string;
let scoringRunId: string;
let maker: RbacContext;
let checker: RbacContext;

beforeAll(async () => {
  pool = getTestPool();
  await runMigrations();
});
beforeEach(async () => {
  await truncateAllTables(pool);
  const seed = await seedReferenceData(pool);
  editionId = seed.editionId;
  maker = await loadRbacContext(pool, seed.makerUserId);
  checker = await loadRbacContext(pool, seed.checkerUserId);
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
/** The only way a firm report is approved: the maker opens the reports and
 *  requests release with a reason; the checker approves, which releases. */
async function releaseViaMakerChecker(reportIds: string[], options?: ReleaseOptions) {
  for (const id of reportIds) await openFirmReport(pool, id, maker.userId);
  const action = await requestFirmReportRelease(pool, maker, editionId, {
    reason: 'Every report read; national report approved',
    reportIds,
  });
  return decideFirmReportRelease(
    pool,
    checker,
    editionId,
    action.id,
    { approved: true },
    {},
    options,
  );
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
    // Approve (and so release) the one that generated.
    const okReport = gen.reports.find((r) => r.organizationId === a.id)!;
    await approveNationalFor();

    const { release: result } = await releaseViaMakerChecker([okReport.id]);
    if (!result) throw new Error('approval should have released');
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
    const report = gen.reports.find((r) => r.organizationId === a.id)!;
    // No approved national report yet: neither approving the release nor a
    // direct release goes through, and the report stays unapproved.
    await expect(releaseViaMakerChecker([report.id])).rejects.toMatchObject({
      code: 'NATIONAL_NOT_APPROVED',
    });
    expect((await getFirmReport(pool, report.id))?.approvalState).toBe('pending');
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
    await approveNationalFor();
    const { release } = await releaseViaMakerChecker([report.id]);
    const releasedReport = release!.released[0]!;

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
    await approveNationalFor();
    const { release } = await releaseViaMakerChecker([report.id]);
    const releasedReport = release!.released[0]!;

    await expect(regenerateFirmReport(pool, releasedReport.id)).rejects.toMatchObject({
      code: 'ALREADY_RELEASED',
    });
    // Never even reached the DB's own trigger — the release state is unchanged.
    expect((await getFirmReport(pool, releasedReport.id))?.releaseState).toBe('released');
  });
});

describe('Delivery: what leaves CIS, frozen as it left', () => {
  const draftFor = (firmId: string, text: string) =>
    insertReportNarrative(pool, {
      editionId,
      kind: 'firm',
      subjectId: firmId,
      sentences: [
        { section: 'SUMMARY', text, factIds: ['X'], finding: null },
        {
          section: 'SUMMARY',
          text: 'A sentence the checker held back.',
          factIds: ['X'],
          finding: { kind: 'SPECULATIVE', why: 'test' },
        },
      ],
      facts: [],
      model: 'fake-model',
      createdBy: 'op@cis.example',
    });

  it('releases a report only with its analysis, frozen; one that cannot be prepared is held', async () => {
    const a = await participatingFirm('firm-prepared');
    const b = await participatingFirm('firm-unprepared');
    const gen = await generateFirmReports(pool, { editionId, scoringRunId });
    await approveNationalFor();
    const drafted = await draftFor(a.id, 'The analysis as released.');

    // Approving the release (two people) runs it, with the analysis prepared.
    const { release: result } = await releaseViaMakerChecker(
      gen.reports.map((r) => r.id),
      {
        releasedBy: 'op@cis.example',
        prepare: async (r) => {
          if (r.organizationId === b.id) throw new Error('the model is unavailable');
          return { narrativeId: drafted.id };
        },
      },
    );
    if (!result) throw new Error('approval should have released');
    expect(result.released.map((r) => r.organizationId)).toEqual([a.id]);
    expect(result.held[0]?.report.organizationId).toBe(b.id);
    expect(result.held[0]?.reason).toMatch(/written analysis could not be prepared/);

    // A later draft never changes what the firm was given, and cannot be made.
    await draftFor(a.id, 'A later redraft.');
    expect((await getFirmNarrative(pool, editionId, a.id))?.id).toBe(drafted.id);
    const model: NarrativeModel = { name: 'fake', complete: async () => '{}' };
    await expect(
      generateFirmNarrative(pool, editionId, a.id, model, 'op@cis.example'),
    ).rejects.toMatchObject({ code: 'ALREADY_PUBLISHED' });

    // The firm sees its released report: passed sentences only, no drafter.
    const released = await getReleasedFirmReport(pool, editionId, a.id);
    expect(released?.narrative?.sentences.map((x) => x.text)).toEqual([
      'The analysis as released.',
    ]);
    expect(JSON.stringify(released)).not.toContain('op@cis.example');
    // The held firm sees nothing.
    expect(await getReleasedFirmReport(pool, editionId, b.id)).toBeNull();
  });

  it('tells each released firm’s coordinators where to find it — and nothing else', async () => {
    const a = await participatingFirm('firm-notice');
    await createCoordinator(pool, {
      organizationId: a.id,
      name: 'Ngozi',
      email: 'ngozi@firm-notice.example',
      accessCode: 'NOTICE-1',
      isLead: true,
    });
    const gen = await generateFirmReports(pool, { editionId, scoringRunId });
    await approveNationalFor();
    const { release } = await releaseViaMakerChecker(gen.reports.map((r) => r.id));
    const released = release!.released;

    expect(await queueReleaseNotices(pool, released, 'https://cis.example/firm')).toBe(1);
    const { rows } = await pool.query<{ to_address: string; body_text: string; status: string }>(
      'SELECT to_address, body_text, status FROM email_outbox',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.to_address).toBe('ngozi@firm-notice.example');
    expect(rows[0]!.status).toBe('queued');
    expect(rows[0]!.body_text).toContain('https://cis.example/firm');
    expect(rows[0]!.body_text).toContain('FIRM-NOTICE');
  });

  it('publishes the Industry report only once the national report is approved, then freezes it', async () => {
    const model: NarrativeModel = {
      name: 'fake-model',
      complete: async () =>
        JSON.stringify({
          sections: { EXEC: [{ text: 'The published analysis.', factIds: ['PART.firm'] }] },
        }),
    };
    await expect(
      publishIndustryReport(pool, editionId, () => model, 'op@cis.example'),
    ).rejects.toMatchObject({ code: 'NATIONAL_NOT_APPROVED' });
    await expect(getPublishedIndustryReport(pool, editionId)).rejects.toMatchObject({
      code: 'NOT_PUBLISHED',
    });

    await approveNationalFor();
    const first = await publishIndustryReport(pool, editionId, () => model, 'op@cis.example');
    const again = await publishIndustryReport(pool, editionId, () => model, 'op@cis.example');
    expect(again.id).toBe(first.id);

    const published = await getPublishedIndustryReport(pool, editionId);
    expect(published.narrative?.sentences.map((x) => x.text)).toEqual(['The published analysis.']);
    await expect(
      generateIndustryNarrative(pool, editionId, model, 'op@cis.example'),
    ).rejects.toMatchObject({ code: 'ALREADY_PUBLISHED' });
  });
});

describe('Releasing the firm reports is two-person (maker-checker)', () => {
  async function twoGeneratedReports() {
    const a = await participatingFirm('firm-mc-a');
    const b = await participatingFirm('firm-mc-b');
    const gen = await generateFirmReports(pool, { editionId, scoringRunId });
    const ra = gen.reports.find((r) => r.organizationId === a.id)!;
    const rb = gen.reports.find((r) => r.organizationId === b.id)!;
    return { ra, rb };
  }

  it('one request covers every generated report; the checker approves and they release', async () => {
    const { ra, rb } = await twoGeneratedReports();
    await approveNationalFor();
    // The maker reads one, the checker reads the other — between them, both.
    await openFirmReport(pool, ra.id, maker.userId);
    const action = await requestFirmReportRelease(pool, maker, editionId, {
      reason: 'Both reports read; figures match the signed run',
    });
    expect(action.status).toBe('pending');
    expect((action.payload['reportIds'] as string[]).sort()).toEqual([ra.id, rb.id].sort());
    expect((await getPendingFirmReportRelease(pool, editionId))?.id).toBe(action.id);
    await openFirmReport(pool, rb.id, checker.userId);

    const result = await decideFirmReportRelease(pool, checker, editionId, action.id, {
      approved: true,
    });
    expect(result.action.status).toBe('approved');
    expect(result.action.approvedBy).toBe(checker.userId);
    expect(result.release?.released.map((r) => r.id).sort()).toEqual([ra.id, rb.id].sort());
    for (const id of [ra.id, rb.id]) {
      const r = await getFirmReport(pool, id);
      expect(r?.approvalState).toBe('approved');
      expect(r?.releaseState).toBe('released');
    }
    // Recorded in the audit log: the request and the approval.
    const audit = await pool.query<{ action_type: string; actor_id: string }>(
      `SELECT action_type, actor_id FROM audit_log WHERE entity_id = $1 ORDER BY occurred_at`,
      [action.id],
    );
    expect(audit.rows.map((r) => r.action_type)).toEqual([
      'critical_action.requested',
      'critical_action.approved',
    ]);
  });

  it('a maker can never approve their own request', async () => {
    const { ra } = await twoGeneratedReports();
    await approveNationalFor();
    await openFirmReport(pool, ra.id, maker.userId);
    const action = await requestFirmReportRelease(pool, maker, editionId, {
      reason: 'Read and ready',
      reportIds: [ra.id],
    });
    await expect(
      decideFirmReportRelease(pool, maker, editionId, action.id, { approved: true }),
    ).rejects.toBeInstanceOf(MakerCheckerViolationError);
    expect((await getFirmReport(pool, ra.id))?.approvalState).toBe('pending');
    expect((await getFirmReport(pool, ra.id))?.releaseState).toBe('unreleased');
    // The database refuses it too, even by direct SQL.
    await expect(
      pool.query(`UPDATE critical_actions SET status='approved', approved_by=$1 WHERE id=$2`, [
        maker.userId,
        action.id,
      ]),
    ).rejects.toThrow(/maker_checker_no_self_approval/);
  });

  it('a request needs a reason', async () => {
    await twoGeneratedReports();
    await expect(
      requestFirmReportRelease(pool, maker, editionId, { reason: '  ' }),
    ).rejects.toMatchObject({ code: 'INVALID_REASON' });
    await expect(
      requestFirmReportRelease(pool, maker, editionId, { reason: 'ok' }),
    ).rejects.toMatchObject({ code: 'INVALID_REASON' });
    expect(await getPendingFirmReportRelease(pool, editionId)).toBeNull();
  });

  it('approval needs every covered report opened by the requester or the approver', async () => {
    const { ra, rb } = await twoGeneratedReports();
    await approveNationalFor();
    await openFirmReport(pool, ra.id, maker.userId);
    const action = await requestFirmReportRelease(pool, maker, editionId, {
      reason: 'Release both',
    });
    // rb has been opened by nobody: refused, nothing approved or released.
    await expect(
      decideFirmReportRelease(pool, checker, editionId, action.id, { approved: true }),
    ).rejects.toMatchObject({ code: 'NOT_OPENED', message: expect.stringMatching(/FIRM-MC-B/) });
    expect((await getFirmReport(pool, ra.id))?.approvalState).toBe('pending');
    expect((await getFirmReport(pool, rb.id))?.approvalState).toBe('pending');
    // Once the checker opens it, the same request can be approved.
    await openFirmReport(pool, rb.id, checker.userId);
    const result = await decideFirmReportRelease(pool, checker, editionId, action.id, {
      approved: true,
    });
    expect(result.release?.released).toHaveLength(2);
  });

  it('a rejection approves nothing and frees the edition for a fresh request', async () => {
    const { ra } = await twoGeneratedReports();
    const action = await requestFirmReportRelease(pool, maker, editionId, {
      reason: 'Release both',
    });
    await expect(
      requestFirmReportRelease(pool, maker, editionId, { reason: 'Again' }),
    ).rejects.toMatchObject({ code: 'CRITICAL_ACTION_STATE' });
    const result = await decideFirmReportRelease(pool, checker, editionId, action.id, {
      approved: false,
      rejectionReason: 'Beta figures look wrong',
    });
    expect(result.action.status).toBe('rejected');
    expect(result.release).toBeNull();
    expect((await getFirmReport(pool, ra.id))?.approvalState).toBe('pending');
    expect(await getPendingFirmReportRelease(pool, editionId)).toBeNull();
  });

  it('requesting and approving need the critical-action rights', async () => {
    const { ra } = await twoGeneratedReports();
    const noRights: RbacContext = { userId: maker.userId, permissions: [] };
    await expect(
      requestFirmReportRelease(pool, noRights, editionId, { reason: 'Release' }),
    ).rejects.toMatchObject({ name: 'PermissionDeniedError' });
    await approveNationalFor();
    await openFirmReport(pool, ra.id, maker.userId);
    const action = await requestFirmReportRelease(pool, maker, editionId, { reason: 'Release' });
    await expect(
      decideFirmReportRelease(
        pool,
        { userId: checker.userId, permissions: [] },
        editionId,
        action.id,
        { approved: true },
      ),
    ).rejects.toMatchObject({ name: 'PermissionDeniedError' });
  });
});
