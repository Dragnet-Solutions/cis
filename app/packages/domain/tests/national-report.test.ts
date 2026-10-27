/**
 * National report review & approval — Phase 6 (E08) DoD §8.
 *  - Ten sections, a closed set; the generator cannot produce an eleventh.
 *  - Section-level sufficiency: §2 caveats when thin, §7 suppresses below floor,
 *    §10 requires all three regulators (fails with two).
 *  - A sentence with no fact IDs is unsupported by construction, not opinion.
 *  - Adversary health gates approval (seeded-claim detection ≥ threshold).
 *  - Four approval preconditions, each independently testable; reject needs a reason.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import {
  createCalculationRun,
  listSections,
  listFindingsForReport,
  getLatestNationalReportForEdition,
  getNationalReport,
  getCriticalActionById,
} from '@cis/db';
import { loadRbacContext, MakerCheckerViolationError, type RbacContext } from '@cis/auth';
import {
  seedReferenceData,
  NATIONAL_SECTIONS,
  assertSectionId,
  evaluateSection,
  generateNationalReport,
  isUnsupportedByConstruction,
  checkSentence,
  saveNationalDraft,
  runChecker,
  runAdversaryHealth,
  disposeFinding,
  nationalApprovalPreconditions,
  openDraft,
  requestNationalApproval,
  approveNational,
  getPendingNationalApproval,
  NATIONAL_REPORT_APPROVAL_ACTION,
  requestSignoff,
  approveSignoff,
  NationalReportError,
  prepareNationalReview,
  getNationalReview,
  decideFinding,
  measureChecker,
  getIndustryNarrative,
  generateIndustryNarrative,
  type NarrativeModel,
  type SufficiencyContext,
  type DraftFact,
  type SeededClaim,
} from '../src';
import { getTestPool, runMigrations, truncateAllTables, closeTestPool } from '../../db/tests/setup';
import { approveMethodologyForTests } from '../../db/tests/methodology-approval';

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
  await approveMethodologyForTests(pool);
  const seed = await seedReferenceData(pool);
  editionId = seed.editionId;
  maker = await loadRbacContext(pool, seed.makerUserId);
  checker = await loadRbacContext(pool, seed.checkerUserId);
  const run = await createCalculationRun(pool, {
    editionId,
    runType: 'scoring',
    datasetHash: 'ds-test',
    status: 'complete',
  });
  scoringRunId = run.id;
  // Phase 7: a run backs a report only once it is genuinely SIGNED OFF (not
  // merely completed). Sign it off through the real maker-checker flow.
  await signOffRun(scoringRunId);
});

/** Request + approve a sign-off for a run via the real UX-ADM-004 flow. */
async function signOffRun(runId: string): Promise<void> {
  const so = await requestSignoff(pool, {
    editionId,
    calculationRunId: runId,
    requestedBy: 'maker',
    checkedAccount: {
      populationCountsReviewed: true,
      floorStatusReviewed: true,
      dataQualityFlagsReviewed: true,
    },
  });
  await approveSignoff(pool, { signoffId: so.id, approvedBy: 'checker' });
}
afterAll(async () => {
  await closeTestPool();
});

const fullContext = (): SufficiencyContext => ({
  segments: {
    retail: { meets: true, thin: false },
    local_institution: { meets: true, thin: false },
    foreign_institution: { meets: true, thin: false },
  },
  regulatorsEngaged: 3,
});

describe('Ten sections — a closed set', () => {
  it('has exactly ten, all with contract IDs', () => {
    expect(NATIONAL_SECTIONS).toHaveLength(10);
    expect(NATIONAL_SECTIONS.map((s) => s.id)).toContain('PUB_10_INSTITUTIONAL_PERSPECTIVES');
  });
  it('rejects a section outside the closed set (no eleventh)', () => {
    expect(() => assertSectionId('PUB_11_SOMETHING')).toThrow(/not one of the ten/);
  });
  it('the generator produces exactly the ten catalogue sections', async () => {
    const { report } = await generateNationalReport(pool, {
      editionId,
      scoringRunId,
      context: fullContext(),
    });
    const sections = await listSections(pool, report.id);
    expect(sections).toHaveLength(10);
    // The DB CHECK is the backstop — the section-id column only accepts the ten.
    expect(new Set(sections.map((s) => s.sectionId)).size).toBe(10);
  });
});

describe('Section-level sufficiency — different rules that look alike', () => {
  it('§2 caveats a thin segment (not suppressed)', () => {
    const ctx = fullContext();
    ctx.segments['foreign_institution'] = { meets: false, thin: true };
    const spec = NATIONAL_SECTIONS.find((s) => s.id === 'PUB_02_SEGMENT_IEI_ICI')!;
    expect(evaluateSection(spec, ctx).disposition).toBe('caveated');
  });
  it('§7 suppresses outright below floor', () => {
    const ctx = fullContext();
    ctx.segments['foreign_institution'] = { meets: false, thin: true };
    const spec = NATIONAL_SECTIONS.find((s) => s.id === 'PUB_07_LOCAL_VS_FOREIGN')!;
    expect(evaluateSection(spec, ctx).disposition).toBe('suppressed');
  });
  it(
    "FOLLOWUP v0.15 — §7 is the codebase's one cross-segment comparison, and it already " +
      'implements the new privacy.standalone_segment_display.shown_directionally rule ' +
      '("prohibit cross-segment comparison unless all compared segments clear floor"): ' +
      'publishes only once BOTH segments clear the (REPORTABLE) floor, suppresses if either ' +
      'is merely thin/SHOWN_DIRECTIONALLY, and suppresses if BOTH are',
    () => {
      const spec = NATIONAL_SECTIONS.find((s) => s.id === 'PUB_07_LOCAL_VS_FOREIGN')!;
      expect(evaluateSection(spec, fullContext()).disposition).toBe('publishable');

      const oneThin = fullContext();
      oneThin.segments['local_institution'] = { meets: false, thin: true };
      expect(evaluateSection(spec, oneThin).disposition).toBe('suppressed');

      const bothThin = fullContext();
      bothThin.segments['local_institution'] = { meets: false, thin: true };
      bothThin.segments['foreign_institution'] = { meets: false, thin: true };
      expect(evaluateSection(spec, bothThin).disposition).toBe('suppressed');
    },
  );
  it('§10 requires all three regulators — two is not the module', () => {
    const spec = NATIONAL_SECTIONS.find((s) => s.id === 'PUB_10_INSTITUTIONAL_PERSPECTIVES')!;
    expect(evaluateSection(spec, { ...fullContext(), regulatorsEngaged: 2 }).disposition).toBe(
      'suppressed',
    );
    expect(evaluateSection(spec, { ...fullContext(), regulatorsEngaged: 3 }).disposition).toBe(
      'publishable',
    );
  });
  it('§10 needs every market institution taking part, not a fixed three (QA #9)', () => {
    const spec = NATIONAL_SECTIONS.find((s) => s.id === 'PUB_10_INSTITUTIONAL_PERSPECTIVES')!;
    const six = { ...fullContext(), regulatorsRequired: 6 };
    const partial = evaluateSection(spec, { ...six, regulatorsEngaged: 3 });
    expect(partial.disposition).toBe('suppressed');
    // Named in its unit: market institutions, as the form labels it (BUG-05).
    expect(partial.reason).toContain('3 of 6 market institutions engaged');
    expect(evaluateSection(spec, { ...six, regulatorsEngaged: 6 }).disposition).toBe('publishable');
    // No market institution registered at all is never "all of them".
    expect(
      evaluateSection(spec, { ...fullContext(), regulatorsRequired: 0, regulatorsEngaged: 0 })
        .disposition,
    ).toBe('suppressed');
  });
});

describe('Sentence-level review', () => {
  it('a sentence with no fact IDs is unsupported by construction', () => {
    const sentence = {
      ordinal: 1,
      text: 'The weakest performers are the smaller firms.',
      factIds: [],
    };
    expect(isUnsupportedByConstruction(sentence)).toBe(true);
    const finding = checkSentence(sentence, new Map());
    expect(finding?.kind).toBe('NO SUPPORTING FACT IDS');
  });
  it('flags a BANDED fact reported as a point value', () => {
    const facts = new Map<string, DraftFact>([['P', { id: 'P', state: 'BANDED' }]]);
    const finding = checkSentence(
      { ordinal: 1, text: 'Nearly 30 per cent of investors reduced investing.', factIds: ['P'] },
      facts,
    );
    expect(finding?.kind).toBe('BANDED FACT REPORTED AS A POINT VALUE');
  });
  it('does not flag a well-supported factual sentence', () => {
    const facts = new Map<string, DraftFact>([['O', { id: 'O', state: 'REPORTABLE' }]]);
    const finding = checkSentence(
      { ordinal: 1, text: 'Operational maturity stands at 61.0 out of 100.', factIds: ['O'] },
      facts,
    );
    expect(finding).toBeNull();
  });
});

describe('Adversary health gates approval', () => {
  const seeded: SeededClaim[] = [
    { sentence: { ordinal: 1, text: 'No basis here.', factIds: [] }, facts: [] },
    { sentence: { ordinal: 2, text: 'The weakest are smaller firms.', factIds: [] }, facts: [] },
    {
      sentence: { ordinal: 3, text: 'Lower maturity causes more complaints.', factIds: ['D'] },
      facts: [{ id: 'D', state: 'REPORTABLE' }],
    },
    {
      sentence: { ordinal: 4, text: 'Nearly 30 per cent moved assets.', factIds: ['P'] },
      facts: [{ id: 'P', state: 'BANDED' }],
    },
  ];

  it('a checker that catches the seeded claims is healthy', async () => {
    const { report } = await generateNationalReport(pool, {
      editionId,
      scoringRunId,
      context: fullContext(),
    });
    const health = await runAdversaryHealth(pool, report.id, seeded);
    expect(health.detected).toBe(seeded.length);
    expect(health.healthy).toBe(true);
  });

  it('blocks approval when the checker misses seeded claims (below threshold)', async () => {
    const { report } = await generateNationalReport(pool, {
      editionId,
      scoringRunId,
      context: fullContext(),
    });
    // Seed claims the heuristic checker cannot catch (supported-looking) → low rate.
    const missable: SeededClaim[] = [
      {
        sentence: { ordinal: 1, text: 'The market is fine.', factIds: ['X'] },
        facts: [{ id: 'X', state: 'REPORTABLE' }],
      },
      {
        sentence: { ordinal: 2, text: 'All is well.', factIds: ['Y'] },
        facts: [{ id: 'Y', state: 'REPORTABLE' }],
      },
      { sentence: { ordinal: 3, text: 'No basis.', factIds: [] }, facts: [] },
    ];
    const health = await runAdversaryHealth(pool, report.id, missable);
    expect(health.healthy).toBe(false);
    await openDraft(pool, report.id);
    const pre = await nationalApprovalPreconditions(pool, report.id);
    expect(pre.checkerHealthy).toBe(false);
    expect(pre.ok).toBe(false);
    await expect(
      requestNationalApproval(pool, maker, report.id, { reason: 'Checked every section.' }),
    ).rejects.toBeInstanceOf(NationalReportError);
    await expect(approveNational(pool, checker, report.id)).rejects.toBeInstanceOf(
      NationalReportError,
    );
  });
});

describe('Approval preconditions — four, independently', () => {
  async function reportWithFinding() {
    const { report } = await generateNationalReport(pool, {
      editionId,
      scoringRunId,
      context: fullContext(),
    });
    await saveNationalDraft(pool, report.id, [
      { ordinal: 1, text: 'The weakest performers are the smaller firms.', factIds: [] },
    ]);
    await runChecker(pool, report.id, []);
    return report;
  }

  it('blocks until signed run + draft opened + all findings disposed + checker healthy', async () => {
    const report = await reportWithFinding();

    // Nothing done yet: draft not opened, finding undisposed, no health record.
    let pre = await nationalApprovalPreconditions(pool, report.id);
    expect(pre.signedScoringRun).toBe(true);
    expect(pre.draftOpened).toBe(false);
    expect(pre.allFindingsDisposed).toBe(false);
    expect(pre.checkerHealthy).toBe(false);
    expect(pre.ok).toBe(false);

    await openDraft(pool, report.id);
    await runAdversaryHealth(pool, report.id, [
      { sentence: { ordinal: 1, text: 'No basis.', factIds: [] }, facts: [] },
    ]);
    const findings = await listFindingsForReport(pool, report.id);
    await disposeFinding(pool, {
      findingId: findings[0]!.id,
      disposition: 'SUPPRESS_CLAIM',
      disposedBy: 'reviewer',
    });

    pre = await nationalApprovalPreconditions(pool, report.id);
    expect(pre.ok).toBe(true);

    await requestNationalApproval(pool, maker, report.id, {
      reason: 'Checked all ten sections and the suppressed ones.',
    });
    await openDraft(pool, report.id, checker.userId);
    const approved = await approveNational(pool, checker, report.id);
    expect(approved.status).toBe('approved');
  });

  it('rejection requires a reason (data-layer)', async () => {
    const report = await reportWithFinding();
    const findings = await listFindingsForReport(pool, report.id);
    await expect(
      disposeFinding(pool, {
        findingId: findings[0]!.id,
        disposition: 'REJECT_WITH_REASON',
        disposedBy: 'reviewer',
      }),
    ).rejects.toBeInstanceOf(NationalReportError);
  });

  it('a completed-but-unsigned run does NOT count as signed (Phase 6 integration fix)', async () => {
    // A fresh completed run with no sign-off record — the old proxy would have
    // treated `status === complete` as signed; the real check must not.
    const unsigned = await createCalculationRun(pool, {
      editionId,
      runType: 'scoring',
      datasetHash: 'ds-unsigned',
      status: 'complete',
    });
    const { report } = await generateNationalReport(pool, {
      editionId,
      scoringRunId: unsigned.id,
      context: fullContext(),
    });
    const pre = await nationalApprovalPreconditions(pool, report.id);
    expect(pre.signedScoringRun).toBe(false);
    expect(pre.reasons).toContain('No signed-off scoring run.');

    // Once that run is signed off, the same report's precondition flips true.
    await signOffRun(unsigned.id);
    const after = await nationalApprovalPreconditions(pool, report.id);
    expect(after.signedScoringRun).toBe(true);
  });

  it('forbids self-approval (maker ≠ checker)', async () => {
    const report = await reportWithFinding();
    await openDraft(pool, report.id);
    await runAdversaryHealth(pool, report.id, [
      { sentence: { ordinal: 1, text: 'No basis.', factIds: [] }, facts: [] },
    ]);
    const findings = await listFindingsForReport(pool, report.id);
    await disposeFinding(pool, {
      findingId: findings[0]!.id,
      disposition: 'ACCEPT_AND_EDIT',
      disposedBy: 'adaeze',
    });
    await requestNationalApproval(pool, maker, report.id, {
      reason: 'Checked all ten sections and the suppressed ones.',
    });
    await openDraft(pool, report.id, maker.userId);
    await expect(approveNational(pool, maker, report.id)).rejects.toBeInstanceOf(
      MakerCheckerViolationError,
    );
    expect((await getNationalReport(pool, report.id))?.status).not.toBe('approved');
  });
});

describe('Approval needs a pending request from a different person (go-live blocker)', () => {
  async function readyReport() {
    const { report } = await generateNationalReport(pool, {
      editionId,
      scoringRunId,
      context: fullContext(),
    });
    await saveNationalDraft(pool, report.id, [
      { ordinal: 1, text: 'The weakest performers are the smaller firms.', factIds: [] },
    ]);
    await runChecker(pool, report.id, []);
    await runAdversaryHealth(pool, report.id, [
      { sentence: { ordinal: 1, text: 'No basis.', factIds: [] }, facts: [] },
    ]);
    const findings = await listFindingsForReport(pool, report.id);
    await disposeFinding(pool, {
      findingId: findings[0]!.id,
      disposition: 'SUPPRESS_CLAIM',
      disposedBy: 'reviewer',
    });
    await openDraft(pool, report.id, checker.userId);
    expect((await nationalApprovalPreconditions(pool, report.id)).ok).toBe(true);
    return report;
  }

  it('refuses approval when nobody has requested it, even with every precondition met', async () => {
    const report = await readyReport();
    await expect(approveNational(pool, checker, report.id)).rejects.toMatchObject({
      code: 'NO_PENDING_REQUEST',
    });
    expect((await getNationalReport(pool, report.id))?.status).not.toBe('approved');
  });

  it('records the request as a pending critical action and approves only through it', async () => {
    const report = await readyReport();
    const action = await requestNationalApproval(pool, maker, report.id, {
      reason: 'Read every section and the suppressed claim.',
    });
    expect(action.actionType).toBe(NATIONAL_REPORT_APPROVAL_ACTION);
    expect(action.status).toBe('pending');
    expect(action.requestedBy).toBe(maker.userId);
    expect(action.payload['reportId']).toBe(report.id);
    expect((await getPendingNationalApproval(pool, report.id))?.id).toBe(action.id);

    // A second request for the same draft is refused while one waits.
    await expect(
      requestNationalApproval(pool, checker, report.id, { reason: 'Asking again for this.' }),
    ).rejects.toMatchObject({ code: 'CRITICAL_ACTION_STATE' });

    const approved = await approveNational(pool, checker, report.id);
    expect(approved.status).toBe('approved');
    const decided = await getCriticalActionById(pool, action.id);
    expect(decided?.status).toBe('approved');
    expect(decided?.approvedBy).toBe(checker.userId);
    // Nothing left pending; approving again is refused.
    expect(await getPendingNationalApproval(pool, report.id)).toBeNull();
    await expect(approveNational(pool, checker, report.id)).rejects.toBeInstanceOf(
      NationalReportError,
    );
  });

  it('the approver must have opened the draft themselves', async () => {
    const report = await readyReport();
    // The maker opened it and asks; the second person has not opened it.
    const { report: other } = await generateNationalReport(pool, {
      editionId,
      scoringRunId,
      context: fullContext(),
    });
    expect(other.id).not.toBe(report.id);
    await saveNationalDraft(pool, other.id, [
      { ordinal: 1, text: 'The weakest performers are the smaller firms.', factIds: [] },
    ]);
    await runChecker(pool, other.id, []);
    await runAdversaryHealth(pool, other.id, [
      { sentence: { ordinal: 1, text: 'No basis.', factIds: [] }, facts: [] },
    ]);
    const findings = await listFindingsForReport(pool, other.id);
    await disposeFinding(pool, {
      findingId: findings[0]!.id,
      disposition: 'SUPPRESS_CLAIM',
      disposedBy: 'reviewer',
    });
    await openDraft(pool, other.id, maker.userId);
    await requestNationalApproval(pool, maker, other.id, {
      reason: 'Read every section of this draft.',
    });
    await expect(approveNational(pool, checker, other.id)).rejects.toMatchObject({
      code: 'NOT_OPENED',
    });
    await openDraft(pool, other.id, checker.userId);
    expect((await approveNational(pool, checker, other.id)).status).toBe('approved');
  });

  it('a request for one report does not let another report be approved', async () => {
    const report = await readyReport();
    await requestNationalApproval(pool, maker, report.id, {
      reason: 'Read every section and the suppressed claim.',
    });
    const { report: other } = await generateNationalReport(pool, {
      editionId,
      scoringRunId,
      context: fullContext(),
    });
    await expect(approveNational(pool, checker, other.id)).rejects.toMatchObject({
      code: 'NO_PENDING_REQUEST',
    });
  });
});

/**
 * ADM-005 live-wiring fix — `getLatestNationalReportForEdition` lets a fresh
 * admin page load discover the current report for an edition without the
 * frontend having to remember a report id across sessions (there was
 * previously no way to look a report up except by its own id). Backs the new
 * `GET /editions/:id/national-report` route.
 */
describe('getLatestNationalReportForEdition (ADM-005 live-wiring)', () => {
  it('returns null when no report has been generated for the edition yet', async () => {
    const found = await getLatestNationalReportForEdition(pool, editionId);
    expect(found).toBeNull();
  });

  it('returns the most recently created report when more than one exists', async () => {
    const { report: first } = await generateNationalReport(pool, {
      editionId,
      scoringRunId,
      context: fullContext(),
    });

    const secondRun = await createCalculationRun(pool, {
      editionId,
      runType: 'scoring',
      datasetHash: 'ds-second',
      status: 'complete',
    });
    await signOffRun(secondRun.id);
    const { report: second } = await generateNationalReport(pool, {
      editionId,
      scoringRunId: secondRun.id,
      context: fullContext(),
    });

    const found = await getLatestNationalReportForEdition(pool, editionId);
    expect(found?.id).toBe(second.id);
    expect(found?.id).not.toBe(first.id);
  });
});

describe('Reviewing the AI narrative as the national draft (D23)', () => {
  // A draft with one sentence that passes and one the checker holds back.
  const model = (
    text = 'The study was designed around 80 participating firms.',
  ): NarrativeModel => ({
    name: 'fake-model',
    complete: async () =>
      JSON.stringify({
        sections: {
          EXEC: [
            { text, factIds: ['PART.firm'] },
            { text: 'Firms joined because the study matters.', factIds: ['PART.firm'] },
          ],
        },
      }),
  });

  async function reportReadyToReview() {
    const { report } = await generateNationalReport(pool, {
      editionId,
      scoringRunId,
      context: fullContext(),
    });
    return report;
  }

  it('records the narrative for review, with the held-back sentence as a finding', async () => {
    const report = await reportReadyToReview();
    // Nothing drafted yet: there is no draft to review.
    expect((await nationalApprovalPreconditions(pool, report.id)).reasons).toContain(
      'There is no written draft to review yet.',
    );

    const review = await prepareNationalReview(pool, report.id, () => model(), 'op@cis.example');
    expect(review.items).toHaveLength(2);
    expect(review.items.filter((i) => i.finding)).toHaveLength(1);
    expect(review.health?.healthy).toBe(true);

    // Preparing again changes nothing (no redraft, no duplicate rows).
    const again = await prepareNationalReview(
      pool,
      report.id,
      () => {
        throw new Error('no model call expected');
      },
      'op@cis.example',
    );
    expect(again.items).toHaveLength(2);
  });

  it('can be approved once opened, every finding decided and the checker proven', async () => {
    const report = await reportReadyToReview();
    await prepareNationalReview(pool, report.id, () => model(), 'op@cis.example');
    await openDraft(pool, report.id);

    let pre = await nationalApprovalPreconditions(pool, report.id);
    expect(pre.draftReviewable).toBe(true);
    expect(pre.checkerHealthy).toBe(true);
    expect(pre.allFindingsDisposed).toBe(false);
    expect(pre.ok).toBe(false);

    const finding = (await getNationalReview(pool, report.id)).items.find((i) => i.finding)!;
    await decideFinding(pool, {
      reportId: report.id,
      findingId: finding.finding!.id,
      disposition: 'SUPPRESS_CLAIM',
      reason: null,
      decidedBy: 'reviewer@cis.example',
    });
    await expect(
      decideFinding(pool, {
        reportId: report.id,
        findingId: finding.finding!.id,
        disposition: 'SUPPRESS_CLAIM',
        reason: null,
        decidedBy: 'reviewer@cis.example',
      }),
    ).rejects.toMatchObject({ code: 'DECIDED' });

    pre = await nationalApprovalPreconditions(pool, report.id);
    expect(pre.ok).toBe(true);
    await requestNationalApproval(pool, maker, report.id, {
      reason: 'Read every section and decided the one finding.',
    });
    await openDraft(pool, report.id, checker.userId);
    expect((await approveNational(pool, checker, report.id)).status).toBe('approved');
  });

  it('puts a sentence back when a reviewer rejects its finding with a reason', async () => {
    const report = await reportReadyToReview();
    await prepareNationalReview(pool, report.id, () => model(), 'op@cis.example');
    const finding = (await getNationalReview(pool, report.id)).items.find((i) => i.finding)!;
    await expect(
      decideFinding(pool, {
        reportId: report.id,
        findingId: finding.finding!.id,
        disposition: 'REJECT_WITH_REASON',
        reason: null,
        decidedBy: 'reviewer@cis.example',
      }),
    ).rejects.toBeInstanceOf(NationalReportError);
    await decideFinding(pool, {
      reportId: report.id,
      findingId: finding.finding!.id,
      disposition: 'REJECT_WITH_REASON',
      reason: 'The respondents themselves give this as their reason.',
      decidedBy: 'reviewer@cis.example',
    });
    const shown = (await getIndustryNarrative(pool, editionId))!.sentences.filter(
      (x) => x.finding === null,
    );
    expect(shown.map((x) => x.text)).toContain('Firms joined because the study matters.');
  });

  it('starts a fresh review when the narrative is redrafted', async () => {
    const report = await reportReadyToReview();
    await prepareNationalReview(pool, report.id, () => model(), 'op@cis.example');
    await openDraft(pool, report.id);
    await generateIndustryNarrative(pool, editionId, model('A redraft.'), 'op@cis.example');
    const pre = await nationalApprovalPreconditions(pool, report.id);
    expect(pre.draftReviewable).toBe(false);
    const review = await prepareNationalReview(pool, report.id, () => model(), 'op@cis.example');
    expect(review.items.map((i) => i.text)).toContain('A redraft.');
  });

  it('measures the checker against errors planted in the draft’s own facts', () => {
    const facts = [
      {
        id: 'A',
        state: 'REPORTABLE',
        statement: '33% of firms (5 of 15) cite X.',
        numbers: [33, 5, 15],
      },
      { id: 'B', state: 'BANDED', statement: 'The SEC names X.', numbers: [] },
      {
        id: 'C',
        state: 'REPORTABLE',
        statement: 'Firms 60/100, investors 56/100 — a gap of 4 points, firms higher.',
        numbers: [60, 56, 4, 100],
      },
    ];
    const { seeded, detected } = measureChecker(facts);
    expect(seeded).toBe(8);
    expect(detected).toBe(8);
  });
});
