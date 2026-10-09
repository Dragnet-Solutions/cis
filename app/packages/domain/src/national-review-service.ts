import { Pool } from 'pg';
import {
  getFindingReportId,
  getNarrativeCheckerHealth,
  getNationalReport,
  insertNarrativeCheckerHealth,
  insertReviewSentence,
  listReviewItems,
  type NarrativeCheckerHealth,
  type NarrativeFact,
  type ReviewItem,
} from '@cis/db';
import type { ReviewDisposition } from '@cis/shared-types';
import {
  ADVERSARY_HEALTH_THRESHOLD,
  disposeFinding,
  NationalReportError,
  narrativeUnderReview,
} from './national-report-service';
import {
  checkNarrativeSentence,
  ensureIndustryNarrative,
  getIndustryNarrative,
  type NarrativeModel,
} from './report-narrative-service';

/**
 * The national report's sentence-level review, run on the real draft: the
 * Industry report's AI narrative (report-narrative-service.ts).
 *
 * - Every sentence of the narrative in force is recorded against the report;
 *   each sentence the checker held back is a FINDING a person must decide on —
 *   agree it stays out, or disagree with a reason, which puts it back in.
 * - The checker is measured before its silence is trusted: a set of planted
 *   errors, built from this draft's own facts, is run through the very checker
 *   that judged the draft. Approval needs it to catch at least the threshold
 *   share (a clean draft and a broken checker look identical otherwise).
 *
 * A redraft is a new narrative, so it gets a fresh review: decisions are never
 * carried over to different words.
 */

export interface NationalReview {
  /** The narrative under review; null while there is nothing written to review. */
  narrativeId: string | null;
  model: string | null;
  draftedAt: Date | null;
  items: ReviewItem[];
  health: NarrativeCheckerHealth | null;
}

/**
 * Planted errors, one per rule the checker enforces, written against the
 * draft's own facts so the measurement is of THIS draft's checking. Each is a
 * sentence the checker must hold back.
 */
export function plantedErrors(facts: NarrativeFact[]): Array<{ text: string; factIds: string[] }> {
  const numbered = facts.find((f) => f.state === 'REPORTABLE' && f.numbers.length > 0);
  const banded = facts.find((f) => f.state === 'BANDED');
  const directional = facts.find((f) => /\b(higher|lower)\b/i.test(f.statement));
  const planted: Array<{ text: string; factIds: string[] }> = [
    { text: 'Firms in the study performed strongly this edition.', factIds: [] },
    { text: 'Most firms now meet the standard.', factIds: ['NOT.A.FACT'] },
  ];
  if (numbered) {
    let invented = Math.max(...numbered.numbers) + 17;
    while (numbered.numbers.includes(invented)) invented += 1;
    planted.push(
      { text: `${invented}% of respondents report this.`, factIds: [numbered.id] },
      { text: 'Half of respondents report this.', factIds: [numbered.id] },
      { text: 'This happens because firms lack staff.', factIds: [numbered.id] },
      { text: 'This could worsen next year.', factIds: [numbered.id] },
    );
  }
  if (banded) planted.push({ text: 'This reading applies to 40% of them.', factIds: [banded.id] });
  if (directional) {
    const n = directional.numbers.find((x) => x !== 100) ?? 5;
    planted.push({ text: `The gap is ${n} points.`, factIds: [directional.id] });
  }
  return planted;
}

/** Run the planted errors through the narrative checker: how many it caught. */
export function measureChecker(facts: NarrativeFact[]): { seeded: number; detected: number } {
  const factsById = new Map(facts.map((f) => [f.id, f]));
  const planted = plantedErrors(facts);
  const detected = planted.filter((p) => checkNarrativeSentence(p, factsById) !== null).length;
  return { seeded: planted.length, detected };
}

export async function getNationalReview(pool: Pool, reportId: string): Promise<NationalReview> {
  const report = await getNationalReport(pool, reportId);
  if (!report) throw new NationalReportError('Report not found', 'NOT_FOUND');
  const narrativeId = await narrativeUnderReview(pool, report.editionId);
  if (!narrativeId) {
    return { narrativeId: null, model: null, draftedAt: null, items: [], health: null };
  }
  const narrative = await getIndustryNarrative(pool, report.editionId);
  return {
    narrativeId,
    model: narrative?.model ?? null,
    draftedAt: narrative?.createdAt ?? null,
    items: await listReviewItems(pool, reportId, narrativeId),
    health: await getNarrativeCheckerHealth(pool, reportId, narrativeId),
  };
}

/**
 * Make the review current: draft the narrative if it is due, record its
 * sentences and findings for review, and measure the checker on it. Idempotent
 * — a narrative already recorded is left as it is, with its decisions. An
 * approved report's review is final and is never touched.
 */
export async function prepareNationalReview(
  pool: Pool,
  reportId: string,
  model: () => NarrativeModel,
  preparedBy: string,
): Promise<NationalReview> {
  const report = await getNationalReport(pool, reportId);
  if (!report) throw new NationalReportError('Report not found', 'NOT_FOUND');
  if (report.status === 'approved') return getNationalReview(pool, reportId);

  const narrative = await ensureIndustryNarrative(pool, report.editionId, model, preparedBy);
  if (!narrative) return getNationalReview(pool, reportId);

  if ((await listReviewItems(pool, reportId, narrative.id)).length === 0) {
    for (const [index, sentence] of narrative.sentences.entries()) {
      await insertReviewSentence(pool, {
        nationalReportId: reportId,
        narrativeId: narrative.id,
        narrativeIndex: index,
        section: sentence.section,
        text: sentence.text,
        factIds: sentence.factIds,
        finding: sentence.finding,
      });
    }
  }
  if (!(await getNarrativeCheckerHealth(pool, reportId, narrative.id))) {
    const { seeded, detected } = measureChecker(narrative.facts);
    await insertNarrativeCheckerHealth(pool, {
      nationalReportId: reportId,
      narrativeId: narrative.id,
      seededTotal: seeded,
      detected,
      thresholdRate: ADVERSARY_HEALTH_THRESHOLD,
      healthy: seeded > 0 && detected / seeded >= ADVERSARY_HEALTH_THRESHOLD,
    });
  }
  return getNationalReview(pool, reportId);
}

/**
 * A reviewer's decision on one finding. SUPPRESS_CLAIM: agree, the sentence
 * stays out. REJECT_WITH_REASON: the checker was wrong — the sentence is shown,
 * and the reason is kept. The reviewer comes from the session.
 */
export async function decideFinding(
  pool: Pool,
  data: {
    reportId: string;
    findingId: string;
    disposition: ReviewDisposition;
    reason: string | null;
    decidedBy: string;
  },
): Promise<void> {
  const report = await getNationalReport(pool, data.reportId);
  if (!report) throw new NationalReportError('Report not found', 'NOT_FOUND');
  if (report.status === 'approved') {
    throw new NationalReportError('The report is approved; its review is final.', 'APPROVED');
  }
  if ((await getFindingReportId(pool, data.findingId)) !== data.reportId) {
    throw new NationalReportError('That finding is not part of this report.', 'NOT_FOUND');
  }
  const narrativeId = await narrativeUnderReview(pool, report.editionId);
  const item = narrativeId
    ? (await listReviewItems(pool, data.reportId, narrativeId)).find(
        (i) => i.finding?.id === data.findingId,
      )
    : undefined;
  if (item?.disposition) {
    throw new NationalReportError(
      'A decision has already been recorded on this finding.',
      'DECIDED',
    );
  }
  await disposeFinding(pool, {
    findingId: data.findingId,
    disposition: data.disposition,
    reason: data.reason,
    disposedBy: data.decidedBy,
  });
}
