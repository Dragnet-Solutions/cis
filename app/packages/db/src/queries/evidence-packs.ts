import { Pool } from 'pg';
import type {
  EvidencePack,
  EvidencePackFact,
  ReportType,
  ReportSection,
  SufficiencyState,
} from '@cis/shared-types';
import { query } from '../client';

interface RawPackRow {
  id: string;
  calculation_run_id: string;
  report_type: ReportType;
  subject_type: 'firm' | 'market';
  subject_id: string;
  created_at: Date;
}

function mapPack(row: RawPackRow): EvidencePack {
  return {
    id: row.id,
    calculationRunId: row.calculation_run_id,
    reportType: row.report_type,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    createdAt: row.created_at,
  };
}

interface RawFactRow {
  id: string;
  pack_id: string;
  section_id: ReportSection;
  metric_code: string | null;
  sufficiency_state: SufficiencyState;
  value: string | null;
  band: string | null;
  source_result_id: string | null;
  source_question_ids: string[];
  created_at: Date;
}

function mapFact(row: RawFactRow): EvidencePackFact {
  return {
    id: row.id,
    packId: row.pack_id,
    sectionId: row.section_id,
    metricCode: row.metric_code,
    sufficiencyState: row.sufficiency_state,
    value: row.value === null ? null : Number(row.value),
    band: row.band,
    sourceResultId: row.source_result_id,
    sourceQuestionIds: row.source_question_ids,
    createdAt: row.created_at,
  };
}

export async function insertEvidencePack(
  pool: Pool,
  data: {
    calculationRunId: string;
    reportType: ReportType;
    subjectType: 'firm' | 'market';
    subjectId: string;
  },
): Promise<EvidencePack> {
  const result = await query<RawPackRow>(
    pool,
    `INSERT INTO evidence_packs (calculation_run_id, report_type, subject_type, subject_id)
     VALUES ($1,$2,$3,$4)
     RETURNING *`,
    [data.calculationRunId, data.reportType, data.subjectType, data.subjectId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Evidence pack insert returned no rows');
  return mapPack(row);
}

export async function insertEvidencePackFact(
  pool: Pool,
  data: {
    packId: string;
    sectionId: ReportSection;
    metricCode?: string | null;
    sufficiencyState: SufficiencyState;
    value?: number | null;
    band?: string | null;
    sourceResultId?: string | null;
    sourceQuestionIds?: string[];
  },
): Promise<EvidencePackFact> {
  const result = await query<RawFactRow>(
    pool,
    `INSERT INTO evidence_pack_facts
       (pack_id, section_id, metric_code, sufficiency_state, value, band, source_result_id, source_question_ids)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      data.packId,
      data.sectionId,
      data.metricCode ?? null,
      data.sufficiencyState,
      data.value ?? null,
      data.band ?? null,
      data.sourceResultId ?? null,
      JSON.stringify(data.sourceQuestionIds ?? []),
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Evidence pack fact insert returned no rows');
  return mapFact(row);
}

export async function listPackFacts(pool: Pool, packId: string): Promise<EvidencePackFact[]> {
  const result = await query<RawFactRow>(
    pool,
    'SELECT * FROM evidence_pack_facts WHERE pack_id = $1 ORDER BY section_id',
    [packId],
  );
  return result.rows.map(mapFact);
}

export async function getEvidencePack(pool: Pool, id: string): Promise<EvidencePack | null> {
  const result = await query<RawPackRow>(pool, 'SELECT * FROM evidence_packs WHERE id = $1', [id]);
  const row = result.rows[0];
  return row ? mapPack(row) : null;
}
