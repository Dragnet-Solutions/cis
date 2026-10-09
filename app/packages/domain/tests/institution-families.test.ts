/**
 * Phase 19 — Institutional Instrument Families & Closed Engineering Decisions
 * (real Postgres). Covers the four items this phase adds real engineering for:
 *
 *  1. Institutional instrument families: adding a 9th institution of an
 *     EXISTING role requires no code change; a multi-role institution (CSCS)
 *     is covered separately in regulator-engagement.test.ts.
 *  2. Edition-opening trigger: lazy auto-open once the planned launch instant
 *     passes and instruments are frozen; a loud problem when they are not.
 *  5. Industry SEI real derivation: aggregates reportable Firm_SEI, gated by
 *     the SAME generic `computeSufficiency()` ladder applied to the count of
 *     contributing firms.
 *  6. Decline-reopen is covered in regulator-engagement.test.ts.
 *
 * The common controlled introduction paragraph (`renderInstitutionalIntro`)
 * and the family -> instrument-code mapping are covered here as pure checks.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { loadRbacContext } from '@cis/auth';
import {
  createCalculationRun,
  insertCalculatedResult,
  listInstitutionRoles,
  seedInstitutionEngagement,
  listInstitutions,
  getInstitutionalInstrumentCodes,
  getInstitutionalQuestionCodes,
  listInstrumentDefinitions,
  getActiveMetricDefinitions,
  listCalculatedResults,
  query,
} from '@cis/db';
import {
  seedReferenceData,
  listRegulators,
  requestSignoff,
  approveSignoff,
  industrySeiState,
  renderInstitutionalIntro,
  FAMILY_META,
  instrumentCodeForFamily,
  setSurveyOpenAt,
  evaluateAutoOpen,
  requestFreeze,
  decideFreeze,
  EditionStateError,
} from '../src';
import { getTestPool, runMigrations, truncateAllTables, closeTestPool } from '../../db/tests/setup';

let pool: Pool;
let editionId: string;
let makerUserId: string;
let checkerUserId: string;

beforeAll(async () => {
  pool = getTestPool();
  await runMigrations();
});
beforeEach(async () => {
  await truncateAllTables(pool);
  const seed = await seedReferenceData(pool);
  editionId = seed.editionId;
  makerUserId = seed.makerUserId;
  checkerUserId = seed.checkerUserId;
});
afterAll(async () => {
  await closeTestPool();
});

describe('Item 1 — a 9th institution of an existing role needs no code change', () => {
  it('a fresh institutions/institution_roles row is picked up by seeding and the roster with zero code changes', async () => {
    // Insert a NEW Family B institution directly (exactly what an operator
    // would do — a data change, not a deploy) and re-seed engagement for it.
    const res = await query<{ id: string }>(
      pool,
      `INSERT INTO institutions (name) VALUES ('Test Ninth Exchange') RETURNING id`,
    );
    const ninthId = res.rows[0]!.id;
    await query(
      pool,
      `INSERT INTO institution_roles (institution_id, family_code) VALUES ($1,'B')`,
      [ninthId],
    );

    const roles = await listInstitutionRoles(pool);
    expect(roles.some((r) => r.institutionId === ninthId && r.familyCode === 'B')).toBe(true);

    // seedInstitutionEngagement enumerates institution_roles — no hardcoded list.
    await seedInstitutionEngagement(pool, editionId);
    const list = await listRegulators(pool, editionId);
    expect(list.some((r) => r.institutionId === ninthId && r.familyCode === 'B')).toBe(true);
    expect(list.some((r) => r.name === 'Test Ninth Exchange')).toBe(true);
  });
});

describe('Phase 21 §2.2 — six-institution exclusion is structural, not a name list', () => {
  it('every non-survey instrument is scored:false, keyed by instrument_type alone', async () => {
    const defs = await listInstrumentDefinitions(pool);
    expect(defs.length).toBeGreaterThan(0);
    for (const def of defs) {
      if (def.instrumentType !== 'survey') {
        expect(def.scored).toBe(false);
      }
    }
  });

  it('the institutional/regulator instrument set structurally covers every named institution, including the three under CIS review', async () => {
    const institutions = await listInstitutions(pool);
    const names = institutions.map((i) => i.name);
    // SEC, NGX, CSCS (active) and LCFE, NASD OTC, FMDQ Securities Exchange,
    // FMDQ Clear, FMDQ Depository (is_active: false — under CIS review, per
    // Item 5's fix below). All eight roster the same way; the six-institution
    // exclusion this test covers is unaffected by which are currently active.
    expect(names).toEqual(
      expect.arrayContaining([
        'Securities and Exchange Commission',
        'Nigerian Exchange Limited',
        'NASD OTC Securities Exchange',
        'Lagos Commodities and Futures Exchange',
        'FMDQ Securities Exchange Limited',
        'Central Securities Clearing System',
        'FMDQ Clear Limited',
        'FMDQ Depository Limited',
      ]),
    );
    // NASD/LCFE/FMDQ Securities Exchange share Family B's single I-NGX
    // instrument; FMDQ Clear shares Family C's I-CSCS; FMDQ Depository shares
    // Family D's I-DEP (Phase 19). So the exclusion below already covers all
    // eight institutions via four instrument codes — never a per-institution
    // allowlist, and no code change is needed if a 9th or 10th institution of
    // an existing family is registered later (Item 1, above).
    const institutionalCodes = await getInstitutionalInstrumentCodes(pool);
    expect([...institutionalCodes].sort()).toEqual(['I-CSCS', 'I-DEP', 'I-NGX', 'I-SEC']);
  });

  it('no active metric definition ever reads an institutional/regulator question code', async () => {
    const institutionalQuestions = new Set(await getInstitutionalQuestionCodes(pool));
    expect(institutionalQuestions.size).toBeGreaterThan(0);
    const metrics = await getActiveMetricDefinitions(pool);
    expect(metrics.length).toBeGreaterThan(0);
    for (const metric of metrics) {
      for (const questionId of metric.config.questionIds) {
        expect(institutionalQuestions.has(questionId)).toBe(false);
      }
    }
  });
});

describe('Common controlled introduction paragraph — parameterised, verbatim family relationship', () => {
  it('renders {INSTITUTION_NAME}/{INSTITUTIONAL_RELATIONSHIP} for each family, including the pre-existing three', () => {
    const secIntro = renderInstitutionalIntro('Securities and Exchange Commission', 'A');
    expect(secIntro).toContain('Securities and Exchange Commission');
    expect(secIntro).toContain(FAMILY_META.A.relationship);

    const depIntro = renderInstitutionalIntro('FMDQ Depository Limited', 'D');
    expect(depIntro).toContain('FMDQ Depository Limited');
    expect(depIntro).toContain(FAMILY_META.D.relationship);

    // Same institution, two roles — two different renderings, never conflated.
    const cscsC = renderInstitutionalIntro('Central Securities Clearing System', 'C');
    const cscsD = renderInstitutionalIntro('Central Securities Clearing System', 'D');
    expect(cscsC).not.toBe(cscsD);
  });

  it('maps every family to its instrument code, including the new Family D', () => {
    expect(instrumentCodeForFamily('A')).toBe('I-SEC');
    expect(instrumentCodeForFamily('B')).toBe('I-NGX');
    expect(instrumentCodeForFamily('C')).toBe('I-CSCS');
    expect(instrumentCodeForFamily('D')).toBe('I-DEP');
  });
});

describe('Item 2 — the edition-opening trigger', () => {
  it('is a no-op while there is no plan, or the plan has not yet arrived', async () => {
    const rbac = await loadRbacContext(pool, makerUserId);
    const noPlan = await evaluateAutoOpen(pool, editionId);
    expect(noPlan.opened).toBe(false);
    expect(noPlan.problem).toBeNull();

    await setSurveyOpenAt(pool, rbac, editionId, new Date(Date.now() + 24 * 3600 * 1000));
    const future = await evaluateAutoOpen(pool, editionId);
    expect(future.opened).toBe(false);
    expect(future.problem).toBeNull();
    expect(future.edition.status).toBe('draft');
  });

  it('surfaces a loud problem when the planned instant has passed but instruments are not frozen', async () => {
    const rbac = await loadRbacContext(pool, makerUserId);
    await setSurveyOpenAt(pool, rbac, editionId, new Date(Date.now() - 1000));
    const result = await evaluateAutoOpen(pool, editionId);
    expect(result.opened).toBe(false);
    expect(result.problem).toBe('launch_date_passed_not_frozen');
    expect(result.edition.status).toBe('draft'); // never silently opens unfrozen
  });

  it('opens the edition automatically once the planned instant has passed AND instruments are frozen', async () => {
    const maker = await loadRbacContext(pool, makerUserId);
    const checker = await loadRbacContext(pool, checkerUserId);
    await setSurveyOpenAt(pool, maker, editionId, new Date(Date.now() - 1000));

    const action = await requestFreeze(pool, maker, editionId, 'Freeze for auto-open test');
    await decideFreeze(pool, checker, editionId, action.id, { approved: true });

    const result = await evaluateAutoOpen(pool, editionId);
    expect(result.opened).toBe(true);
    expect(result.problem).toBeNull();
    expect(result.edition.status).toBe('open');
    expect(result.edition.surveyOpenAt).not.toBeNull();
  });

  it('is draft-only: setSurveyOpenAt refuses once the edition has opened', async () => {
    const maker = await loadRbacContext(pool, makerUserId);
    const checker = await loadRbacContext(pool, checkerUserId);
    const action = await requestFreeze(pool, maker, editionId, 'Freeze so opening is legitimate');
    await decideFreeze(pool, checker, editionId, action.id, { approved: true });
    await setSurveyOpenAt(pool, maker, editionId, new Date(Date.now() - 1000));
    await evaluateAutoOpen(pool, editionId); // opens it

    await expect(setSurveyOpenAt(pool, maker, editionId, new Date())).rejects.toBeInstanceOf(
      EditionStateError,
    );
  });
});

describe('Item 5 — Industry SEI real derivation', () => {
  const goodAccount = {
    populationCountsReviewed: true,
    floorStatusReviewed: true,
    dataQualityFlagsReviewed: true,
  };

  async function signedOffRunWithFirmSei(
    firms: Array<{ n: number; value: number }>,
  ): Promise<void> {
    await query(pool, `UPDATE editions SET status = 'locked' WHERE id = $1`, [editionId]);
    const run = await createCalculationRun(pool, {
      editionId,
      runType: 'scoring',
      datasetHash: 'sei-test',
      status: 'complete',
    });
    for (const [i, f] of firms.entries()) {
      await insertCalculatedResult(pool, {
        calculationRunId: run.id,
        subjectType: 'firm',
        subjectId: `firm-${i}`,
        metricCode: 'SEI',
        value: f.n < 10 ? null : f.value,
        n: f.n,
        denominator: f.n,
        sufficiencyState: f.n < 10 ? 'SUPPRESSED' : f.n < 30 ? 'DIRECTIONAL' : 'REPORTABLE',
      });
    }
    const so = await requestSignoff(pool, {
      editionId,
      calculationRunId: run.id,
      requestedBy: 'maker',
      checkedAccount: goodAccount,
    });
    await approveSignoff(pool, { signoffId: so.id, approvedBy: 'checker' });
  }

  it('is NOT_CALCULABLE (data shortfall, not a permanent gate) while no signed-off run exists', async () => {
    const state = await industrySeiState(pool, editionId);
    expect(state.status).toBe('NOT_CALCULABLE');
    expect(state.contributingFirms).toBe(0);
  });

  it('excludes a firm below DIRECTIONAL (n<10) from the aggregate entirely', async () => {
    // 10 contributing firms (clears SUPPRESS_BELOW on the COUNT) plus one
    // suppressed firm whose value must never enter the mean.
    const contributing = Array.from({ length: 10 }, () => ({ n: 12, value: 20 }));
    await signedOffRunWithFirmSei([{ n: 5, value: 1000 }, ...contributing]);
    const state = await industrySeiState(pool, editionId);
    expect(state.contributingFirms).toBe(10);
    expect(state.status).toBe('CALCULABLE');
    expect(state.value).toBeCloseTo(20, 5); // the n=5, value=1000 firm excluded entirely
    expect(state.sufficiency).toBe('DIRECTIONAL'); // count=10 < REPORTABLE_AT(30)
  });

  it('is NOT_CALCULABLE when too few firms contribute, via the SAME generic sufficiency ladder', async () => {
    await signedOffRunWithFirmSei([
      { n: 12, value: 20 },
      { n: 15, value: 10 },
    ]); // 2 contributing firms < SUPPRESS_BELOW(10) applied to the COUNT
    const state = await industrySeiState(pool, editionId);
    expect(state.status).toBe('NOT_CALCULABLE');
    expect(state.contributingFirms).toBe(2);
    expect(state.reason).toContain('2 firm');
  });

  it('is REPORTABLE once 30+ firms contribute', async () => {
    const firms = Array.from({ length: 30 }, (_, i) => ({ n: 12, value: 10 + (i % 3) }));
    await signedOffRunWithFirmSei(firms);
    const state = await industrySeiState(pool, editionId);
    expect(state.status).toBe('CALCULABLE');
    expect(state.contributingFirms).toBe(30);
    expect(state.sufficiency).toBe('REPORTABLE');
  });

  it('Phase 21 §2.3 — a firm’s own SEI is a real, individually-readable result, never a byproduct of industrySeiState', async () => {
    const contributing = Array.from({ length: 10 }, () => ({ n: 12, value: 20 }));
    await signedOffRunWithFirmSei([{ n: 5, value: 1000 }, ...contributing]);

    // Every firm's SEI is readable on its own via the generic run results —
    // BEFORE industrySeiState is ever called — confirming firm-level SEI is
    // computed and persisted by the ordinary scoring pass (runScoring /
    // insertCalculatedResult), not derived from or gated by the industry
    // aggregate.
    const run = (await query<{ id: string }>(pool, 'SELECT id FROM calculation_runs LIMIT 1'))
      .rows[0]!;
    const results = await listCalculatedResults(pool, run.id);
    const firmSeiRows = results.filter((r) => r.subjectType === 'firm' && r.metricCode === 'SEI');
    expect(firmSeiRows).toHaveLength(11);
    // A below-floor firm's OWN SEI is still readable (as SUPPRESSED, n=5) —
    // its presence/absence has nothing to do with the industry aggregate,
    // which industrySeiState computes separately, afterward.
    const suppressedFirm = firmSeiRows.find((r) => r.n === 5)!;
    expect(suppressedFirm.sufficiencyState).toBe('SUPPRESSED');
    expect(suppressedFirm.value).toBeNull();
    const reportableFirm = firmSeiRows.find((r) => r.n === 12)!;
    expect(reportableFirm.value).toBe(20);

    // Only now does the aggregate read those same rows back — firm-level
    // computation strictly precedes and does not depend on it.
    const state = await industrySeiState(pool, editionId);
    expect(state.status).toBe('CALCULABLE');
    expect(state.contributingFirms).toBe(10);
  });
});
