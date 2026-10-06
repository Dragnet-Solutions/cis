import { Pool } from 'pg';
import type {
  FunnelEvent,
  FunnelEventType,
  FunnelSegment,
  FunnelChannel,
  FunnelSource,
} from '@cis/shared-types';
import { query } from '../client';

interface RawFunnelRow {
  event_id: string;
  event_type: FunnelEventType;
  occurred_at: Date;
  edition_id: string;
  segment: FunnelSegment;
  firm_id: string | null;
  institution_ref: string | null;
  channel: FunnelChannel;
  source: FunnelSource;
  response_id: string | null;
}

function mapFunnel(row: RawFunnelRow): FunnelEvent {
  return {
    eventId: row.event_id,
    eventType: row.event_type,
    occurredAt: row.occurred_at,
    editionId: row.edition_id,
    segment: row.segment,
    firmId: row.firm_id,
    institutionRef: row.institution_ref,
    channel: row.channel,
    source: row.source,
    responseId: row.response_id,
  };
}

/**
 * Emit one funnel event. Accepts a pool or a transaction client so a `completed`
 * event can fire from the SAME transaction that finalizes a response — the
 * unique index (one completed per response) is the backstop against drift.
 */
export async function emitFunnelEvent(
  pool: Pool,
  data: {
    eventType: FunnelEventType;
    editionId: string;
    segment: FunnelSegment;
    firmId?: string | null;
    institutionRef?: string | null;
    channel: FunnelChannel;
    source: FunnelSource;
    responseId?: string | null;
  },
): Promise<FunnelEvent> {
  const result = await query<RawFunnelRow>(
    pool,
    `INSERT INTO funnel_event
       (event_type, edition_id, segment, firm_id, institution_ref, channel, source, response_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      data.eventType,
      data.editionId,
      data.segment,
      data.firmId ?? null,
      data.institutionRef ?? null,
      data.channel,
      data.source,
      data.responseId ?? null,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Funnel event insert returned no rows');
  return mapFunnel(row);
}

export async function listFunnelEvents(pool: Pool, editionId: string): Promise<FunnelEvent[]> {
  const result = await query<RawFunnelRow>(
    pool,
    'SELECT * FROM funnel_event WHERE edition_id = $1 ORDER BY occurred_at',
    [editionId],
  );
  return result.rows.map(mapFunnel);
}

/** Completed responses per segment (one completed = one response). */
export async function countCompletedBySegment(
  pool: Pool,
  editionId: string,
): Promise<Record<string, number>> {
  const result = await query<{ segment: string; n: string }>(
    pool,
    `SELECT segment, COUNT(*)::text AS n
       FROM funnel_event
      WHERE edition_id = $1 AND event_type = 'completed'
      GROUP BY segment`,
    [editionId],
  );
  const out: Record<string, number> = {};
  for (const r of result.rows) out[r.segment] = parseInt(r.n, 10);
  return out;
}

/** Completed responses per segment since a cutoff — the velocity numerator
 *  (valid completes in the last 7 days, or since edition open before day 7). */
export async function countCompletedBySegmentSince(
  pool: Pool,
  editionId: string,
  since: Date,
): Promise<Record<string, number>> {
  const result = await query<{ segment: string; n: string }>(
    pool,
    `SELECT segment, COUNT(*)::text AS n
       FROM funnel_event
      WHERE edition_id = $1 AND event_type = 'completed' AND occurred_at >= $2
      GROUP BY segment`,
    [editionId, since],
  );
  const out: Record<string, number> = {};
  for (const r of result.rows) out[r.segment] = parseInt(r.n, 10);
  return out;
}

/** Firms whose FIRST completed seat falls on or after a cutoff — the velocity
 *  numerator for the participating-firms floor, which counts firms (≥1 seat
 *  complete), not seat responses. A firm finishing its second seat in the
 *  window is not a new participating firm. */
export async function countFirmsFirstCompletedSince(
  pool: Pool,
  editionId: string,
  since: Date,
): Promise<number> {
  const result = await query<{ n: string }>(
    pool,
    `SELECT COUNT(*)::text AS n FROM (
       SELECT firm_id FROM funnel_event
        WHERE edition_id = $1 AND event_type = 'completed'
          AND segment = 'firm' AND firm_id IS NOT NULL
        GROUP BY firm_id
       HAVING MIN(occurred_at) >= $2
     ) f`,
    [editionId, since],
  );
  return parseInt(result.rows[0]?.n ?? '0', 10);
}

/** Distinct institutions per institution segment since a cutoff — the velocity
 *  numerator for institutional segments (velocity runs on the DISTINCT count). */
export async function countDistinctInstitutionsSince(
  pool: Pool,
  editionId: string,
  segment: 'local_institution' | 'foreign_institution',
  since: Date,
): Promise<number> {
  const result = await query<{ n: string }>(
    pool,
    `SELECT COUNT(DISTINCT institution_ref)::text AS n
       FROM funnel_event
      WHERE edition_id = $1 AND event_type = 'completed'
        AND segment = $2 AND institution_ref IS NOT NULL AND occurred_at >= $3`,
    [editionId, segment, since],
  );
  return parseInt(result.rows[0]?.n ?? '0', 10);
}

/**
 * Distinct institutions per institution segment — counted by distinct
 * institution_ref, NEVER by response count (many responses from few
 * institutions must not clear a floor).
 */
export async function countDistinctInstitutions(
  pool: Pool,
  editionId: string,
  segment: 'local_institution' | 'foreign_institution',
): Promise<number> {
  const result = await query<{ n: string }>(
    pool,
    `SELECT COUNT(DISTINCT institution_ref)::text AS n
       FROM funnel_event
      WHERE edition_id = $1 AND event_type = 'completed'
        AND segment = $2 AND institution_ref IS NOT NULL`,
    [editionId, segment],
  );
  return parseInt(result.rows[0]?.n ?? '0', 10);
}

/**
 * Firm-attributable completed responses: COUNT(completed WHERE firm_id NOT NULL).
 * Used ONLY for the participating-firm report-dependency check — never to
 * attribute a rating to a firm for scoring.
 */
export async function countAttributable(pool: Pool, editionId: string): Promise<number> {
  const result = await query<{ n: string }>(
    pool,
    `SELECT COUNT(*)::text AS n
       FROM funnel_event
      WHERE edition_id = $1 AND event_type = 'completed' AND firm_id IS NOT NULL`,
    [editionId],
  );
  return parseInt(result.rows[0]?.n ?? '0', 10);
}
