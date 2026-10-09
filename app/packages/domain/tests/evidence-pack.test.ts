/**
 * Evidence-pack construction integration tests — Phase 5 (E07) DoD §9.
 * Every rule in EVIDENCE_PACK_CONTRACT is a literal acceptance test: the builder
 * REJECTS a DRG-OPS source id, a BANDED fact with a point value, a suppressed
 * guaranteed firm section, institutional data as an index input, and a cross-firm
 * leak — and accepts a valid pack.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import {
  createOrganization,
  ensureSeats,
  setSeatState,
  getDrgOpsQuestionCodes,
  getInstitutionalQuestionCodes,
  listCalculatedResults,
} from '@cis/db';
import { seedReferenceData, runScoring, buildEvidencePack, EvidencePackError } from '../src';
import { getTestPool, runMigrations, truncateAllTables, closeTestPool } from '../../db/tests/setup';

let pool: Pool;
let editionId: string;
let runId: string;
let firmAId: string;
let firmBId: string;

beforeAll(async () => {
  pool = getTestPool();
  await runMigrations();
});
beforeEach(async () => {
  await truncateAllTables(pool);
  const seed = await seedReferenceData(pool);
  editionId = seed.editionId;
  const a = await createOrganization(pool, {
    slug: 'firm-a',
    displayName: 'FIRM A',
    orgType: 'firm',
  });
  const b = await createOrganization(pool, {
    slug: 'firm-b',
    displayName: 'FIRM B',
    orgType: 'firm',
  });
  firmAId = a.id;
  firmBId = b.id;
  for (const org of [a.id, b.id]) {
    await ensureSeats(pool, editionId, org);
    await setSeatState(pool, { editionId, organizationId: org, seatCode: 'S1', state: 'complete' });
  }
  const { run } = await runScoring(pool, { editionId });
  runId = run.id;
});
afterAll(async () => {
  await closeTestPool();
});

const firmPack = (facts: Parameters<typeof buildEvidencePack>[1]['facts']) => ({
  calculationRunId: runId,
  reportType: 'FIRM_REPORT' as const,
  subjectType: 'firm' as const,
  subjectId: firmAId,
  facts,
});

describe('Valid packs', () => {
  it('accepts a firm report with guaranteed sections and a gated FRM_04', async () => {
    const { pack, facts } = await buildEvidencePack(
      pool,
      firmPack([
        { sectionId: 'FRM_01', sufficiencyState: 'REPORTABLE', value: 1 },
        { sectionId: 'FRM_02', sufficiencyState: 'REPORTABLE', value: 2 },
        { sectionId: 'FRM_03', sufficiencyState: 'DIRECTIONAL', value: 3 },
        { sectionId: 'FRM_04', sufficiencyState: 'SUPPRESSED' }, // gated section may be suppressed
      ]),
    );
    expect(pack.id).toBeTruthy();
    expect(facts).toHaveLength(4);
  });
});

describe('Rejections', () => {
  it('rejects a DRG-OPS source id', async () => {
    const drgOps = await getDrgOpsQuestionCodes(pool);
    expect(drgOps.length).toBeGreaterThan(0);
    await expect(
      buildEvidencePack(
        pool,
        firmPack([
          {
            sectionId: 'FRM_01',
            sufficiencyState: 'REPORTABLE',
            value: 1,
            sourceQuestionIds: [drgOps[0]!],
          },
        ]),
      ),
    ).rejects.toMatchObject({ code: 'DRG_OPS_IN_PACK' });
  });

  it('rejects a BANDED fact carrying a point value', async () => {
    await expect(
      buildEvidencePack(
        pool,
        firmPack([{ sectionId: 'FRM_04', sufficiencyState: 'BANDED', value: 0.3 }]),
      ),
    ).rejects.toMatchObject({ code: 'BANDED_WITH_VALUE' });
  });

  it('rejects a suppressed guaranteed firm section (Acceptance Test 8)', async () => {
    await expect(
      buildEvidencePack(pool, firmPack([{ sectionId: 'FRM_01', sufficiencyState: 'SUPPRESSED' }])),
    ).rejects.toMatchObject({ code: 'GUARANTEED_SECTION_SUPPRESSED' });
  });

  it('rejects institutional response data used as an index input', async () => {
    const inst = await getInstitutionalQuestionCodes(pool);
    expect(inst.length).toBeGreaterThan(0);
    await expect(
      buildEvidencePack(pool, {
        calculationRunId: runId,
        reportType: 'PUBLIC_REPORT',
        subjectType: 'market',
        subjectId: 'market',
        facts: [
          {
            sectionId: 'PUB_01',
            metricCode: 'OMI',
            sufficiencyState: 'REPORTABLE',
            value: 5,
            sourceQuestionIds: [inst[0]!],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'INSTITUTIONAL_AS_INDEX' });
  });

  it('rejects a firm report that contains an institutional cut', async () => {
    const inst = await getInstitutionalQuestionCodes(pool);
    await expect(
      buildEvidencePack(
        pool,
        firmPack([
          {
            sectionId: 'FRM_02',
            sufficiencyState: 'REPORTABLE',
            value: 1,
            sourceQuestionIds: [inst[0]!],
          },
        ]),
      ),
    ).rejects.toMatchObject({ code: 'FIRM_INSTITUTIONAL_CUT' });
  });

  it('rejects a cross-firm leak (firm pack citing another firm’s result)', async () => {
    // A calculated result belonging to firm B.
    const results = await listCalculatedResults(pool, runId);
    const firmBResult = results.find((r) => r.subjectId === firmBId)!;
    expect(firmBResult).toBeTruthy();
    await expect(
      buildEvidencePack(
        pool,
        firmPack([
          {
            sectionId: 'FRM_01',
            sufficiencyState: 'REPORTABLE',
            value: 1,
            sourceResultId: firmBResult.id,
          },
        ]),
      ),
    ).rejects.toMatchObject({ code: 'CROSS_FIRM_LEAK' });
  });

  it('rejects a section that does not belong to the report type', async () => {
    await expect(
      buildEvidencePack(
        pool,
        firmPack([{ sectionId: 'PUB_01', sufficiencyState: 'REPORTABLE', value: 1 }]),
      ),
    ).rejects.toMatchObject({ code: 'SECTION_INVALID' });
  });
});

describe('Phase 21 §2.1 — segment non-reconstructability', () => {
  it('rejects a segment group whose lone SUPPRESSED member is reconstructable from an exact total', async () => {
    await expect(
      buildEvidencePack(
        pool,
        firmPack([
          { sectionId: 'FRM_04', sufficiencyState: 'REPORTABLE', value: 50, segmentGroupId: 'cut' },
          { sectionId: 'FRM_04', sufficiencyState: 'REPORTABLE', value: 30, segmentGroupId: 'cut' },
          { sectionId: 'FRM_04', sufficiencyState: 'SUPPRESSED', segmentGroupId: 'cut' },
          {
            sectionId: 'FRM_04',
            sufficiencyState: 'REPORTABLE',
            value: 90,
            segmentGroupId: 'cut',
            isSegmentTotal: true,
          },
        ]),
      ),
    ).rejects.toMatchObject({ code: 'SUPPRESSED_SEGMENT_RECONSTRUCTABLE' });
  });

  it('accepts the same segments once the group total is withheld', async () => {
    const { facts } = await buildEvidencePack(
      pool,
      firmPack([
        { sectionId: 'FRM_04', sufficiencyState: 'REPORTABLE', value: 50, segmentGroupId: 'cut' },
        { sectionId: 'FRM_04', sufficiencyState: 'REPORTABLE', value: 30, segmentGroupId: 'cut' },
        { sectionId: 'FRM_04', sufficiencyState: 'SUPPRESSED', segmentGroupId: 'cut' },
      ]),
    );
    expect(facts).toHaveLength(3);
  });

  it('accepts a group with two SUPPRESSED segments alongside an exact total', async () => {
    const { facts } = await buildEvidencePack(
      pool,
      firmPack([
        { sectionId: 'FRM_04', sufficiencyState: 'REPORTABLE', value: 50, segmentGroupId: 'cut' },
        { sectionId: 'FRM_04', sufficiencyState: 'SUPPRESSED', segmentGroupId: 'cut' },
        { sectionId: 'FRM_04', sufficiencyState: 'SUPPRESSED', segmentGroupId: 'cut' },
        {
          sectionId: 'FRM_04',
          sufficiencyState: 'REPORTABLE',
          value: 90,
          segmentGroupId: 'cut',
          isSegmentTotal: true,
        },
      ]),
    );
    expect(facts).toHaveLength(4);
  });
});

describe('EvidencePackError type', () => {
  it('is a domain error carrying a code', async () => {
    try {
      await buildEvidencePack(
        pool,
        firmPack([{ sectionId: 'FRM_01', sufficiencyState: 'SUPPRESSED' }]),
      );
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EvidencePackError);
    }
  });
});
