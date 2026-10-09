import { Pool } from 'pg';
import {
  insertEvidencePack,
  insertEvidencePackFact,
  getCalculatedResult,
  getDrgOpsQuestionCodes,
  getInstitutionalQuestionCodes,
  INDEX_CODES,
  withTransaction,
} from '@cis/db';
import type {
  EvidencePack,
  EvidencePackFact,
  ReportType,
  ReportSection,
  SufficiencyState,
} from '@cis/shared-types';
import { DomainError } from './errors';
import { assertRunOfficialUsable } from './candidate-scoring-service';
import { isSegmentGroupReconstructable } from './sufficiency-service';

/**
 * Evidence-pack construction — the reporting-facing boundary. Every rule in
 * EVIDENCE_PACK_CONTRACT is enforced HERE, at construction time, as a hard
 * validation (not a downstream filter). A pack that violates any rule is
 * rejected before a single row is written.
 */
export class EvidencePackError extends DomainError {
  constructor(message: string, code: string) {
    super(message, code);
  }
}

const PUBLIC_SECTIONS: ReportSection[] = [
  'PUB_01',
  'PUB_02',
  'PUB_03',
  'PUB_04',
  'PUB_05',
  'PUB_06',
  'PUB_07',
  'PUB_08',
  'PUB_09',
  'PUB_10',
];
const FIRM_SECTIONS: ReportSection[] = ['FRM_01', 'FRM_02', 'FRM_03', 'FRM_04'];
/** Guaranteed to every participating firm regardless of volume — never suppressible. */
const GUARANTEED_FIRM_SECTIONS: ReportSection[] = ['FRM_01', 'FRM_02', 'FRM_03'];

const INDEX_SET = new Set<string>(INDEX_CODES as readonly string[]);

export interface FactInput {
  sectionId: ReportSection;
  metricCode?: string | null;
  sufficiencyState: SufficiencyState;
  value?: number | null;
  band?: string | null;
  sourceResultId?: string | null;
  sourceQuestionIds?: string[];
  /**
   * Phase 21 §2.1 (v0.15) — identifies this fact as one member of a segment
   * breakdown (e.g. a firm-size or region cut) sharing one group id, so the
   * non-reconstructability check can see every sibling together. Facts
   * without a `segmentGroupId` are not checked against each other.
   */
  segmentGroupId?: string;
  /** Marks this fact as its group's TOTAL row, rather than one segment. */
  isSegmentTotal?: boolean;
}

export interface BuildPackInput {
  calculationRunId: string;
  reportType: ReportType;
  subjectType: 'firm' | 'market';
  subjectId: string;
  facts: FactInput[];
}

/**
 * Validate and persist an evidence pack. Rejections:
 *  - a section not valid for the report type (closed set);
 *  - any DRG-OPS source question id (reuses the Phase 2 flag);
 *  - institutional response data used as an index input (and, for a firm report,
 *    ANY institutional source — no firm institutional cuts exist);
 *  - a BANDED fact carrying a point value; a SUPPRESSED fact carrying value/band;
 *  - a guaranteed firm section (FRM_01/02/03) arriving SUPPRESSED (Acceptance
 *    Test 8: a builder error, not a data outcome);
 *  - a firm-scoped pack citing another firm's result (cross-firm leak).
 */
export async function buildEvidencePack(
  pool: Pool,
  input: BuildPackInput,
): Promise<{ pack: EvidencePack; facts: EvidencePackFact[] }> {
  // Hard methodology gate (Phase 11, build note §2): a run produced under a
  // TEST_UNAPPROVED methodology can never back an official evidence pack. This is
  // a construction-time validation failure, structurally before any other check.
  await assertRunOfficialUsable(pool, input.calculationRunId, 'an official evidence pack');

  const validSections = input.reportType === 'PUBLIC_REPORT' ? PUBLIC_SECTIONS : FIRM_SECTIONS;
  const drgOps = new Set(await getDrgOpsQuestionCodes(pool));
  const institutional = new Set(await getInstitutionalQuestionCodes(pool));

  for (const fact of input.facts) {
    const src = fact.sourceQuestionIds ?? [];

    if (!validSections.includes(fact.sectionId)) {
      throw new EvidencePackError(
        `Section ${fact.sectionId} is not valid for a ${input.reportType}`,
        'SECTION_INVALID',
      );
    }

    // DRG-OPS exclusion — pack-construction-time, never a downstream filter.
    for (const q of src) {
      if (drgOps.has(q)) {
        throw new EvidencePackError(
          `Evidence pack rejected: ${q} is a DRG-OPS source and must never appear in a pack`,
          'DRG_OPS_IN_PACK',
        );
      }
    }

    // Institutional data is contextual only. It is never an index input, and a
    // firm report carries no institutional cut at all (market-level only).
    const usesInstitutional = src.some((q) => institutional.has(q));
    if (usesInstitutional) {
      if (fact.metricCode && INDEX_SET.has(fact.metricCode)) {
        throw new EvidencePackError(
          'Institutional response data cannot be used as an index input',
          'INSTITUTIONAL_AS_INDEX',
        );
      }
      if (input.reportType === 'FIRM_REPORT') {
        throw new EvidencePackError(
          'A firm report cannot contain an institutional cut',
          'FIRM_INSTITUTIONAL_CUT',
        );
      }
    }

    // BANDED never carries a point value; SUPPRESSED carries neither.
    if (fact.sufficiencyState === 'BANDED' && fact.value !== null && fact.value !== undefined) {
      throw new EvidencePackError(
        'A BANDED fact must carry a band, never a point value',
        'BANDED_WITH_VALUE',
      );
    }
    if (
      fact.sufficiencyState === 'SUPPRESSED' &&
      ((fact.value !== null && fact.value !== undefined) ||
        (fact.band !== null && fact.band !== undefined))
    ) {
      throw new EvidencePackError(
        'A SUPPRESSED fact must not carry a value or band',
        'SUPPRESSED_WITH_DATA',
      );
    }

    // A guaranteed firm section can never be suppressed (Acceptance Test 8).
    if (
      GUARANTEED_FIRM_SECTIONS.includes(fact.sectionId) &&
      fact.sufficiencyState === 'SUPPRESSED'
    ) {
      throw new EvidencePackError(
        `${fact.sectionId} is guaranteed to every participating firm and can never be SUPPRESSED`,
        'GUARANTEED_SECTION_SUPPRESSED',
      );
    }

    // Cross-firm leak: a firm-scoped pack may only cite its own subject's results.
    if (input.reportType === 'FIRM_REPORT' && fact.sourceResultId) {
      const result = await getCalculatedResult(pool, fact.sourceResultId);
      if (result && result.subjectType === 'firm' && result.subjectId !== input.subjectId) {
        throw new EvidencePackError(
          'A firm-scoped pack cannot expose another firm’s result',
          'CROSS_FIRM_LEAK',
        );
      }
    }
  }

  // Strict non-reconstructability (Phase 21 §2.1): a SUPPRESSED segment must
  // never be back-out-able by subtracting every other exact sibling from a
  // shown group total. Checked per `segmentGroupId`, across the whole pack —
  // this is a construction-time rejection, not a downstream filter, exactly
  // like every other EVIDENCE_PACK_CONTRACT rule above.
  const segmentGroups = new Map<string, FactInput[]>();
  for (const fact of input.facts) {
    if (!fact.segmentGroupId) continue;
    const members = segmentGroups.get(fact.segmentGroupId) ?? [];
    members.push(fact);
    segmentGroups.set(fact.segmentGroupId, members);
  }
  for (const [groupId, members] of segmentGroups) {
    if (
      isSegmentGroupReconstructable(
        members.map((m) => ({
          ...(m.isSegmentTotal !== undefined ? { isTotal: m.isSegmentTotal } : {}),
          sufficiencyState: m.sufficiencyState,
        })),
      )
    ) {
      throw new EvidencePackError(
        `Segment group "${groupId}" is reconstructable: its single SUPPRESSED segment can be ` +
          'derived by subtracting every other exact sibling from the shown total',
        'SUPPRESSED_SEGMENT_RECONSTRUCTABLE',
      );
    }
  }

  return withTransaction(pool, async (client) => {
    const c = client as unknown as Pool;
    const pack = await insertEvidencePack(c, {
      calculationRunId: input.calculationRunId,
      reportType: input.reportType,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
    });
    const facts: EvidencePackFact[] = [];
    for (const fact of input.facts) {
      facts.push(
        await insertEvidencePackFact(c, {
          packId: pack.id,
          sectionId: fact.sectionId,
          metricCode: fact.metricCode ?? null,
          sufficiencyState: fact.sufficiencyState,
          value: fact.value ?? null,
          band: fact.band ?? null,
          sourceResultId: fact.sourceResultId ?? null,
          sourceQuestionIds: fact.sourceQuestionIds ?? [],
        }),
      );
    }
    return { pack, facts };
  });
}
