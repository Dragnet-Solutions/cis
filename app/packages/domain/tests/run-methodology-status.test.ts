/**
 * Every calculation run is stamped with its methodology status when it is made
 * (go-live blocker), enforced by the database itself. CIS approves the scoring
 * methodology offline (BUG-02), so the scoring trigger's run — made by the
 * versioned methodology — is official without a platform approval record. The
 * provisional placeholder and any unstamped run stay TEST_UNAPPROVED until an
 * approval exists, and a TEST_UNAPPROVED run can never be signed off.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { createCalculationRun, getCalculationRun, updateEditionStatus } from '@cis/db';
import {
  seedReferenceData,
  triggerScoringRun,
  runScoring,
  runEligibility,
  requestSignoff,
  CandidateScoringError,
} from '../src';
import { getTestPool, runMigrations, truncateAllTables, closeTestPool } from '../../db/tests/setup';
import { approveMethodologyForTests } from '../../db/tests/methodology-approval';

let pool: Pool;
let editionId: string;

beforeAll(async () => {
  pool = getTestPool();
  await runMigrations();
});
beforeEach(async () => {
  await truncateAllTables(pool);
  editionId = (await seedReferenceData(pool)).editionId;
  await updateEditionStatus(pool, editionId, 'locked');
});
afterAll(async () => {
  await closeTestPool();
});

const account = {
  populationCountsReviewed: true,
  floorStatusReviewed: true,
  dataQualityFlagsReviewed: true,
};

describe('Before the methodology is approved', () => {
  it('the scoring trigger makes an official run without waiting on an approval record (BUG-02)', async () => {
    const { run } = await triggerScoringRun(pool, { editionId });
    expect(run.methodologyStatus).toBe('APPROVED');
    expect(run.methodologyVersion).toMatch(/^CIS-SCORE-2026@/);
    // The provisional placeholder is still never official.
    const { run: placeholder } = await runScoring(pool, { editionId });
    expect((await getCalculationRun(pool, placeholder.id))?.methodologyStatus).toBe(
      'TEST_UNAPPROVED',
    );
  });

  it('a run inserted without a status is stamped TEST_UNAPPROVED by the database', async () => {
    const run = await createCalculationRun(pool, {
      editionId,
      runType: 'scoring',
      datasetHash: 'ds-blank',
    });
    expect(run.methodologyStatus).toBe('TEST_UNAPPROVED');
    const eligibility = await runEligibility(pool, editionId);
    expect(eligibility.run.methodologyStatus).toBe('TEST_UNAPPROVED');
    const { rows } = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM calculation_runs WHERE methodology_status IS NULL`,
    );
    expect(rows[0]?.n).toBe('0');
  });

  it('refuses a run stamped APPROVED while no approval exists', async () => {
    await expect(
      createCalculationRun(pool, {
        editionId,
        runType: 'scoring',
        datasetHash: 'ds-forged',
        methodologyStatus: 'APPROVED',
      }),
    ).rejects.toThrow(/cannot be APPROVED/);
  });

  it('refuses to sign off a TEST_UNAPPROVED run', async () => {
    const { run } = await runScoring(pool, { editionId });
    await expect(
      requestSignoff(pool, {
        editionId,
        calculationRunId: run.id,
        requestedBy: 'maker',
        checkedAccount: account,
      }),
    ).rejects.toBeInstanceOf(CandidateScoringError);
    await expect(
      requestSignoff(pool, {
        editionId,
        calculationRunId: run.id,
        requestedBy: 'maker',
        checkedAccount: account,
      }),
    ).rejects.toMatchObject({ code: 'TEST_UNAPPROVED_RUN' });
  });

  it('a run’s status can never be changed afterwards', async () => {
    const { run } = await runScoring(pool, { editionId });
    await expect(
      pool.query(`UPDATE calculation_runs SET methodology_status = 'APPROVED' WHERE id = $1`, [
        run.id,
      ]),
    ).rejects.toThrow(/fixed when the run is made/);
  });
});

describe('After two people approve the methodology', () => {
  it('runs are stamped APPROVED, but the placeholder stays TEST_UNAPPROVED', async () => {
    await approveMethodologyForTests(pool);
    const blank = await createCalculationRun(pool, {
      editionId,
      runType: 'scoring',
      datasetHash: 'ds-after',
    });
    expect(blank.methodologyStatus).toBe('APPROVED');

    const { run: official } = await triggerScoringRun(pool, { editionId });
    expect(official.methodologyStatus).toBe('APPROVED');

    // The placeholder is never the approved methodology.
    const { run: placeholder } = await runScoring(pool, { editionId });
    expect(placeholder.methodologyStatus).toBe('TEST_UNAPPROVED');
    await expect(
      requestSignoff(pool, {
        editionId,
        calculationRunId: placeholder.id,
        requestedBy: 'maker',
        checkedAccount: account,
      }),
    ).rejects.toMatchObject({ code: 'TEST_UNAPPROVED_RUN' });
  });

  it('a run made before the approval stays TEST_UNAPPROVED and cannot be signed off', async () => {
    const before = await createCalculationRun(pool, {
      editionId,
      runType: 'scoring',
      datasetHash: 'ds-before',
    });
    await approveMethodologyForTests(pool);
    expect((await getCalculationRun(pool, before.id))?.methodologyStatus).toBe('TEST_UNAPPROVED');
    await expect(
      requestSignoff(pool, {
        editionId,
        calculationRunId: before.id,
        requestedBy: 'maker',
        checkedAccount: account,
      }),
    ).rejects.toMatchObject({ code: 'TEST_UNAPPROVED_RUN' });
  });
});
