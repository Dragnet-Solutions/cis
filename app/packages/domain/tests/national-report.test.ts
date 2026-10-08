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
} from '@cis/db';
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
  requestSignoff,
  approveSignoff,
  NationalReportError,
  type SufficiencyContext,
  type DraftFact,
  type SeededClaim,
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
    await expect(approveNational(pool, report.id, 'someone')).rejects.toBeInstanceOf(
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

    const approved = await approveNational(pool, report.id, 'someone-else');
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
    await requestNationalApproval(pool, report.id, {
      requestedBy: 'adaeze',
      reason: 'Checked all ten sections and the suppressed ones.',
    });
    await expect(approveNational(pool, report.id, 'adaeze')).rejects.toMatchObject({
      code: 'SELF_APPROVAL',
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
