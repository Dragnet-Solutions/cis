import { Pool } from 'pg';
import type {
  NationalReport,
  NationalReportStatus,
  NationalReportSection,
  NationalReportSectionId,
  SectionSufficiencyDisposition,
  NationalReportSentence,
  NationalReportFinding,
  NationalReportDisposition,
  ReviewDisposition,
  AdversaryHealth,
} from '@cis/shared-types';
import { query } from '../client';

// ─── national_reports ──────────────────────────────────────────────────────────

interface RawReportRow {
  id: string;
  edition_id: string;
  scoring_run_id: string;
  status: NationalReportStatus;
  draft_opened: boolean;
  requested_by: string | null;
  requested_reason: string | null;
  requested_at: Date | null;
  approved_by: string | null;
  approved_at: Date | null;
  created_at: Date;
}

function mapReport(r: RawReportRow): NationalReport {
  return {
    id: r.id,
    editionId: r.edition_id,
    scoringRunId: r.scoring_run_id,
    status: r.status,
    draftOpened: r.draft_opened,
    requestedBy: r.requested_by,
    requestedReason: r.requested_reason,
    requestedAt: r.requested_at,
    approvedBy: r.approved_by,
    approvedAt: r.approved_at,
    createdAt: r.created_at,
  };
}

export async function createNationalReport(
  pool: Pool,
  data: { editionId: string; scoringRunId: string },
): Promise<NationalReport> {
  const res = await query<RawReportRow>(
    pool,
    `INSERT INTO national_reports (edition_id, scoring_run_id) VALUES ($1,$2) RETURNING *`,
    [data.editionId, data.scoringRunId],
  );
  const row = res.rows[0];
  if (!row) throw new Error('National report insert returned no rows');
  return mapReport(row);
}

export async function getNationalReport(pool: Pool, id: string): Promise<NationalReport | null> {
  const res = await query<RawReportRow>(pool, 'SELECT * FROM national_reports WHERE id = $1', [id]);
  const row = res.rows[0];
  return row ? mapReport(row) : null;
}

/** The most recently created report for an edition, or null if none exists yet.
 *  A caller that already has a report id should use `getNationalReport` instead
 *  — this exists so a fresh page load can discover the current report without
 *  the frontend having to remember an id across sessions. */
export async function getLatestNationalReportForEdition(
  pool: Pool,
  editionId: string,
): Promise<NationalReport | null> {
  const res = await query<RawReportRow>(
    pool,
    'SELECT * FROM national_reports WHERE edition_id = $1 ORDER BY created_at DESC LIMIT 1',
    [editionId],
  );
  const row = res.rows[0];
  return row ? mapReport(row) : null;
}

export async function markDraftOpened(pool: Pool, id: string): Promise<void> {
  await query(pool, 'UPDATE national_reports SET draft_opened = TRUE WHERE id = $1', [id]);
}

export async function setNationalRequest(
  pool: Pool,
  id: string,
  data: { requestedBy: string; requestedReason: string },
): Promise<void> {
  await query(
    pool,
    `UPDATE national_reports
        SET requested_by = $2, requested_reason = $3, requested_at = NOW()
      WHERE id = $1`,
    [id, data.requestedBy, data.requestedReason],
  );
}

export async function approveNationalReport(
  pool: Pool,
  id: string,
  approvedBy: string,
): Promise<NationalReport> {
  const res = await query<RawReportRow>(
    pool,
    `UPDATE national_reports
        SET status = 'approved', approved_by = $2, approved_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [id, approvedBy],
  );
  const row = res.rows[0];
  if (!row) throw new Error(`National report ${id} not found`);
  return mapReport(row);
}

/** Whether the edition has an approved national report (release-ordering gate). */
export async function hasApprovedNationalReport(pool: Pool, editionId: string): Promise<boolean> {
  const res = await query<{ n: string }>(
    pool,
    `SELECT COUNT(*)::text AS n FROM national_reports WHERE edition_id = $1 AND status = 'approved'`,
    [editionId],
  );
  return parseInt(res.rows[0]?.n ?? '0', 10) > 0;
}

// ─── previous editions (UX-PUB-002) ─────────────────────────────────────────

export interface PreviousEditionEntry {
  editionId: string;
  editionLabel: string;
  reportId: string;
  publicationStatus: 'approved';
  approvedAt: Date;
  /** "Original publication" for the first approved report of an edition, or a
   *  supersession note for a later correction. Corrections are a NEW approved
   *  row (Phase 6/11's immutability principle) — never a silent overwrite. */
  lineageNote: string;
}

/**
 * Published (approved) national reports for every edition OTHER than the
 * current one, oldest-to-newest within each edition so corrections read as a
 * sequence. Read-only — no new mutation logic, reuses exactly what Phase 6's
 * approval flow already produces.
 */
export async function getPreviousPublishedEditions(
  pool: Pool,
  currentEditionId: string | null,
): Promise<PreviousEditionEntry[]> {
  const res = await query<{
    edition_id: string;
    edition_label: string;
    report_id: string;
    approved_at: Date;
  }>(
    pool,
    `SELECT nr.edition_id, e.label AS edition_label, nr.id AS report_id, nr.approved_at
       FROM national_reports nr
       JOIN editions e ON e.id = nr.edition_id
      WHERE nr.status = 'approved'
        AND ($1::uuid IS NULL OR nr.edition_id <> $1)
      ORDER BY e.label ASC, nr.approved_at ASC`,
    [currentEditionId],
  );

  const seenForEdition = new Map<string, Date>();
  return res.rows.map((row) => {
    const prior = seenForEdition.get(row.edition_id);
    seenForEdition.set(row.edition_id, row.approved_at);
    const lineageNote = prior
      ? `Correction — supersedes the version approved on ${prior.toISOString().slice(0, 10)}.`
      : 'Original publication for this edition.';
    return {
      editionId: row.edition_id,
      editionLabel: row.edition_label,
      reportId: row.report_id,
      publicationStatus: 'approved' as const,
      approvedAt: row.approved_at,
      lineageNote,
    };
  });
}

// ─── sections ────────────────────────────────────────────────────────────────

interface RawSectionRow {
  id: string;
  national_report_id: string;
  section_id: NationalReportSectionId;
  disposition: SectionSufficiencyDisposition;
  reason: string | null;
  created_at: Date;
}

function mapSection(r: RawSectionRow): NationalReportSection {
  return {
    id: r.id,
    nationalReportId: r.national_report_id,
    sectionId: r.section_id,
    disposition: r.disposition,
    reason: r.reason,
    createdAt: r.created_at,
  };
}

export async function insertSection(
  pool: Pool,
  data: {
    nationalReportId: string;
    sectionId: NationalReportSectionId;
    disposition: SectionSufficiencyDisposition;
    reason?: string | null;
  },
): Promise<NationalReportSection> {
  const res = await query<RawSectionRow>(
    pool,
    `INSERT INTO national_report_sections (national_report_id, section_id, disposition, reason)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [data.nationalReportId, data.sectionId, data.disposition, data.reason ?? null],
  );
  const row = res.rows[0];
  if (!row) throw new Error('Section insert returned no rows');
  return mapSection(row);
}

export async function listSections(
  pool: Pool,
  nationalReportId: string,
): Promise<NationalReportSection[]> {
  const res = await query<RawSectionRow>(
    pool,
    'SELECT * FROM national_report_sections WHERE national_report_id = $1 ORDER BY section_id',
    [nationalReportId],
  );
  return res.rows.map(mapSection);
}

// ─── sentences ─────────────────────────────────────────────────────────────────

interface RawSentenceRow {
  id: string;
  national_report_id: string;
  ordinal: number;
  text: string;
  fact_ids: string[];
  created_at: Date;
}

function mapSentence(r: RawSentenceRow): NationalReportSentence {
  return {
    id: r.id,
    nationalReportId: r.national_report_id,
    ordinal: r.ordinal,
    text: r.text,
    factIds: r.fact_ids,
    createdAt: r.created_at,
  };
}

export async function insertSentence(
  pool: Pool,
  data: { nationalReportId: string; ordinal: number; text: string; factIds: string[] },
): Promise<NationalReportSentence> {
  const res = await query<RawSentenceRow>(
    pool,
    `INSERT INTO national_report_sentences (national_report_id, ordinal, text, fact_ids)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [data.nationalReportId, data.ordinal, data.text, JSON.stringify(data.factIds)],
  );
  const row = res.rows[0];
  if (!row) throw new Error('Sentence insert returned no rows');
  return mapSentence(row);
}

export async function listSentences(
  pool: Pool,
  nationalReportId: string,
): Promise<NationalReportSentence[]> {
  const res = await query<RawSentenceRow>(
    pool,
    'SELECT * FROM national_report_sentences WHERE national_report_id = $1 ORDER BY ordinal',
    [nationalReportId],
  );
  return res.rows.map(mapSentence);
}

// ─── findings + dispositions ─────────────────────────────────────────────────

interface RawFindingRow {
  id: string;
  sentence_id: string;
  kind: string;
  why: string;
  created_at: Date;
}

function mapFinding(r: RawFindingRow): NationalReportFinding {
  return {
    id: r.id,
    sentenceId: r.sentence_id,
    kind: r.kind,
    why: r.why,
    createdAt: r.created_at,
  };
}

export async function insertFinding(
  pool: Pool,
  data: { sentenceId: string; kind: string; why: string },
): Promise<NationalReportFinding> {
  const res = await query<RawFindingRow>(
    pool,
    `INSERT INTO national_report_findings (sentence_id, kind, why) VALUES ($1,$2,$3) RETURNING *`,
    [data.sentenceId, data.kind, data.why],
  );
  const row = res.rows[0];
  if (!row) throw new Error('Finding insert returned no rows');
  return mapFinding(row);
}

/** Every finding for a report, joined through its sentences. */
export async function listFindingsForReport(
  pool: Pool,
  nationalReportId: string,
): Promise<NationalReportFinding[]> {
  const res = await query<RawFindingRow>(
    pool,
    `SELECT f.* FROM national_report_findings f
       JOIN national_report_sentences s ON s.id = f.sentence_id
      WHERE s.national_report_id = $1
      ORDER BY f.created_at`,
    [nationalReportId],
  );
  return res.rows.map(mapFinding);
}

interface RawDispositionRow {
  id: string;
  finding_id: string;
  disposition: ReviewDisposition;
  reason: string | null;
  disposed_by: string;
  disposed_at: Date;
}

function mapDisposition(r: RawDispositionRow): NationalReportDisposition {
  return {
    id: r.id,
    findingId: r.finding_id,
    disposition: r.disposition,
    reason: r.reason,
    disposedBy: r.disposed_by,
    disposedAt: r.disposed_at,
  };
}

/**
 * Record a disposition for a finding. A REJECT_WITH_REASON without a reason is
 * refused at the data layer (a CHECK constraint) — not just by the form.
 */
export async function insertDisposition(
  pool: Pool,
  data: {
    findingId: string;
    disposition: ReviewDisposition;
    reason?: string | null;
    disposedBy: string;
  },
): Promise<NationalReportDisposition> {
  const res = await query<RawDispositionRow>(
    pool,
    `INSERT INTO national_report_dispositions (finding_id, disposition, reason, disposed_by)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (finding_id) DO UPDATE
       SET disposition = EXCLUDED.disposition, reason = EXCLUDED.reason,
           disposed_by = EXCLUDED.disposed_by, disposed_at = NOW()
     RETURNING *`,
    [data.findingId, data.disposition, data.reason ?? null, data.disposedBy],
  );
  const row = res.rows[0];
  if (!row) throw new Error('Disposition insert returned no rows');
  return mapDisposition(row);
}

export async function listDispositionsForReport(
  pool: Pool,
  nationalReportId: string,
): Promise<NationalReportDisposition[]> {
  const res = await query<RawDispositionRow>(
    pool,
    `SELECT d.* FROM national_report_dispositions d
       JOIN national_report_findings f ON f.id = d.finding_id
       JOIN national_report_sentences s ON s.id = f.sentence_id
      WHERE s.national_report_id = $1`,
    [nationalReportId],
  );
  return res.rows.map(mapDisposition);
}

// ─── adversary health ──────────────────────────────────────────────────────────

interface RawHealthRow {
  id: string;
  national_report_id: string;
  seeded_total: number;
  detected: number;
  threshold_rate: string;
  healthy: boolean;
  checked_at: Date;
}

function mapHealth(r: RawHealthRow): AdversaryHealth {
  return {
    id: r.id,
    nationalReportId: r.national_report_id,
    seededTotal: r.seeded_total,
    detected: r.detected,
    thresholdRate: Number(r.threshold_rate),
    healthy: r.healthy,
    checkedAt: r.checked_at,
  };
}

export async function insertAdversaryHealth(
  pool: Pool,
  data: {
    nationalReportId: string;
    seededTotal: number;
    detected: number;
    thresholdRate: number;
    healthy: boolean;
  },
): Promise<AdversaryHealth> {
  const res = await query<RawHealthRow>(
    pool,
    `INSERT INTO adversary_health (national_report_id, seeded_total, detected, threshold_rate, healthy)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [data.nationalReportId, data.seededTotal, data.detected, data.thresholdRate, data.healthy],
  );
  const row = res.rows[0];
  if (!row) throw new Error('Adversary health insert returned no rows');
  return mapHealth(row);
}

export async function getLatestAdversaryHealth(
  pool: Pool,
  nationalReportId: string,
): Promise<AdversaryHealth | null> {
  const res = await query<RawHealthRow>(
    pool,
    `SELECT * FROM adversary_health WHERE national_report_id = $1 ORDER BY checked_at DESC LIMIT 1`,
    [nationalReportId],
  );
  const row = res.rows[0];
  return row ? mapHealth(row) : null;
}
