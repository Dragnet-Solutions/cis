import { Pool } from 'pg';
import { query } from '../client';

/**
 * A person's decision on a finding the narrative checker raised on a firm
 * report's AI narrative (BUG-20 / BUG-03): agree it stays out, or overturn it
 * with a reason. Keyed by narrative and sentence index; permanent.
 */
export interface FirmNarrativeDecision {
  narrativeId: string;
  narrativeIndex: number;
  disposition: 'SUPPRESS_CLAIM' | 'REJECT_WITH_REASON';
  reason: string | null;
  decidedBy: string;
  decidedAt: Date;
}

interface RawDecisionRow {
  narrative_id: string;
  narrative_index: number;
  disposition: 'SUPPRESS_CLAIM' | 'REJECT_WITH_REASON';
  reason: string | null;
  decided_by: string;
  decided_at: Date;
}

export async function listFirmNarrativeDecisions(
  pool: Pool,
  narrativeId: string,
): Promise<FirmNarrativeDecision[]> {
  const res = await query<RawDecisionRow>(
    pool,
    `SELECT narrative_id, narrative_index, disposition, reason, decided_by, decided_at
       FROM firm_narrative_decisions
      WHERE narrative_id = $1
      ORDER BY narrative_index`,
    [narrativeId],
  );
  return res.rows.map((r) => ({
    narrativeId: r.narrative_id,
    narrativeIndex: r.narrative_index,
    disposition: r.disposition,
    reason: r.reason,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at,
  }));
}

/** Record a decision. Null when one was already recorded for that sentence. */
export async function insertFirmNarrativeDecision(
  pool: Pool,
  data: {
    narrativeId: string;
    narrativeIndex: number;
    disposition: 'SUPPRESS_CLAIM' | 'REJECT_WITH_REASON';
    reason: string | null;
    decidedBy: string;
  },
): Promise<FirmNarrativeDecision | null> {
  const res = await query<RawDecisionRow>(
    pool,
    `INSERT INTO firm_narrative_decisions
       (narrative_id, narrative_index, disposition, reason, decided_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (narrative_id, narrative_index) DO NOTHING
     RETURNING narrative_id, narrative_index, disposition, reason, decided_by, decided_at`,
    [data.narrativeId, data.narrativeIndex, data.disposition, data.reason, data.decidedBy],
  );
  const r = res.rows[0];
  return r
    ? {
        narrativeId: r.narrative_id,
        narrativeIndex: r.narrative_index,
        disposition: r.disposition,
        reason: r.reason,
        decidedBy: r.decided_by,
        decidedAt: r.decided_at,
      }
    : null;
}
