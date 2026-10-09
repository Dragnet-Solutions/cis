import { Pool } from 'pg';
import { query } from '../client';

/**
 * The national report's sentence-level review of the AI narrative: each
 * sentence of the narrative under review, the checker's finding on it (if
 * any) and the reviewer's disposition of that finding.
 */

export interface ReviewItem {
  sentenceId: string;
  narrativeIndex: number;
  section: string | null;
  text: string;
  factIds: string[];
  finding: { id: string; kind: string; why: string } | null;
  disposition: {
    disposition: 'ACCEPT_AND_EDIT' | 'REJECT_WITH_REASON' | 'SUPPRESS_CLAIM';
    reason: string | null;
    disposedBy: string;
    disposedAt: Date;
  } | null;
}

interface RawItemRow {
  sentence_id: string;
  narrative_index: number;
  section: string | null;
  text: string;
  fact_ids: string[];
  finding_id: string | null;
  kind: string | null;
  why: string | null;
  disposition: 'ACCEPT_AND_EDIT' | 'REJECT_WITH_REASON' | 'SUPPRESS_CLAIM' | null;
  reason: string | null;
  disposed_by: string | null;
  disposed_at: Date | null;
}

export async function listReviewItems(
  pool: Pool,
  nationalReportId: string,
  narrativeId: string,
): Promise<ReviewItem[]> {
  const res = await query<RawItemRow>(
    pool,
    `SELECT s.id AS sentence_id, s.narrative_index, s.section, s.text, s.fact_ids,
            f.id AS finding_id, f.kind, f.why,
            d.disposition, d.reason, d.disposed_by, d.disposed_at
       FROM national_report_sentences s
       LEFT JOIN national_report_findings f ON f.sentence_id = s.id
       LEFT JOIN national_report_dispositions d ON d.finding_id = f.id
      WHERE s.national_report_id = $1 AND s.narrative_id = $2
      ORDER BY s.narrative_index`,
    [nationalReportId, narrativeId],
  );
  return res.rows.map((r) => ({
    sentenceId: r.sentence_id,
    narrativeIndex: r.narrative_index,
    section: r.section,
    text: r.text,
    factIds: r.fact_ids,
    finding: r.finding_id ? { id: r.finding_id, kind: r.kind ?? '', why: r.why ?? '' } : null,
    disposition:
      r.disposition && r.disposed_by && r.disposed_at
        ? {
            disposition: r.disposition,
            reason: r.reason,
            disposedBy: r.disposed_by,
            disposedAt: r.disposed_at,
          }
        : null,
  }));
}

/** Record one narrative sentence for review, with the checker's finding if it has one. */
export async function insertReviewSentence(
  pool: Pool,
  data: {
    nationalReportId: string;
    narrativeId: string;
    narrativeIndex: number;
    section: string;
    text: string;
    factIds: string[];
    finding: { kind: string; why: string } | null;
  },
): Promise<void> {
  const res = await query<{ id: string }>(
    pool,
    `INSERT INTO national_report_sentences
       (national_report_id, ordinal, text, fact_ids, narrative_id, narrative_index, section)
     VALUES ($1, $2, $3, $4, $5, $2, $6)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      data.nationalReportId,
      data.narrativeIndex,
      data.text,
      JSON.stringify(data.factIds),
      data.narrativeId,
      data.section,
    ],
  );
  const id = res.rows[0]?.id;
  if (id && data.finding) {
    await query(
      pool,
      `INSERT INTO national_report_findings (sentence_id, kind, why) VALUES ($1, $2, $3)`,
      [id, data.finding.kind, data.finding.why],
    );
  }
}

/** The narratives a report has a review recorded for, newest first. */
export async function listReviewedNarrativeIds(
  pool: Pool,
  nationalReportId: string,
): Promise<string[]> {
  const res = await query<{ narrative_id: string }>(
    pool,
    `SELECT narrative_id FROM national_report_sentences
      WHERE national_report_id = $1 AND narrative_id IS NOT NULL
      GROUP BY narrative_id
      ORDER BY MAX(created_at) DESC`,
    [nationalReportId],
  );
  return res.rows.map((r) => r.narrative_id);
}

export interface NarrativeCheckerHealth {
  seededTotal: number;
  detected: number;
  thresholdRate: number;
  healthy: boolean;
  checkedAt: Date;
}

export async function insertNarrativeCheckerHealth(
  pool: Pool,
  data: {
    nationalReportId: string;
    narrativeId: string;
    seededTotal: number;
    detected: number;
    thresholdRate: number;
    healthy: boolean;
  },
): Promise<void> {
  await query(
    pool,
    `INSERT INTO adversary_health
       (national_report_id, seeded_total, detected, threshold_rate, healthy, narrative_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      data.nationalReportId,
      data.seededTotal,
      data.detected,
      data.thresholdRate,
      data.healthy,
      data.narrativeId,
    ],
  );
}

export async function getNarrativeCheckerHealth(
  pool: Pool,
  nationalReportId: string,
  narrativeId: string,
): Promise<NarrativeCheckerHealth | null> {
  const res = await query<{
    seeded_total: number;
    detected: number;
    threshold_rate: string;
    healthy: boolean;
    checked_at: Date;
  }>(
    pool,
    `SELECT seeded_total, detected, threshold_rate, healthy, checked_at FROM adversary_health
      WHERE national_report_id = $1 AND narrative_id = $2
      ORDER BY checked_at DESC LIMIT 1`,
    [nationalReportId, narrativeId],
  );
  const r = res.rows[0];
  return r
    ? {
        seededTotal: r.seeded_total,
        detected: r.detected,
        thresholdRate: Number(r.threshold_rate),
        healthy: r.healthy,
        checkedAt: r.checked_at,
      }
    : null;
}

/**
 * Sentences of a narrative whose checker finding a reviewer REJECTED with a
 * reason (the checker was wrong): by position in the narrative. Such a
 * sentence is shown in the report despite the finding.
 */
export async function listOverriddenNarrativeIndices(
  pool: Pool,
  narrativeId: string,
): Promise<number[]> {
  const res = await query<{ narrative_index: number }>(
    pool,
    `SELECT DISTINCT s.narrative_index
       FROM national_report_sentences s
       JOIN national_report_findings f ON f.sentence_id = s.id
       JOIN national_report_dispositions d ON d.finding_id = f.id
      WHERE s.narrative_id = $1 AND d.disposition = 'REJECT_WITH_REASON'`,
    [narrativeId],
  );
  return res.rows.map((r) => r.narrative_index);
}

/** The finding's report, so a disposition can be checked against the right report. */
export async function getFindingReportId(pool: Pool, findingId: string): Promise<string | null> {
  const res = await query<{ national_report_id: string }>(
    pool,
    `SELECT s.national_report_id FROM national_report_findings f
       JOIN national_report_sentences s ON s.id = f.sentence_id
      WHERE f.id = $1`,
    [findingId],
  );
  return res.rows[0]?.national_report_id ?? null;
}
