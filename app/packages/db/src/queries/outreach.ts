import { Pool } from 'pg';
import type { OutreachLink, OutreachSegment } from '@cis/shared-types';
import { query } from '../client';

interface RawOutreachRow {
  id: string;
  edition_id: string;
  organization_id: string;
  token: string;
  segment: OutreachSegment | null;
  opens: number;
  starts: number;
  finishes: number;
  created_at: Date;
}

function mapOutreach(row: RawOutreachRow): OutreachLink {
  return {
    id: row.id,
    editionId: row.edition_id,
    organizationId: row.organization_id,
    token: row.token,
    segment: row.segment,
    opens: row.opens,
    starts: row.starts,
    finishes: row.finishes,
    createdAt: row.created_at,
  };
}

export async function createOutreachLink(
  pool: Pool,
  data: {
    editionId: string;
    organizationId: string;
    token: string;
    segment?: OutreachSegment | null;
  },
): Promise<OutreachLink> {
  const result = await query<RawOutreachRow>(
    pool,
    `INSERT INTO outreach_links (edition_id, organization_id, token, segment)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [data.editionId, data.organizationId, data.token, data.segment ?? null],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Outreach link insert returned no rows');
  return mapOutreach(row);
}

export async function incrementOutreach(
  pool: Pool,
  token: string,
  field: 'opens' | 'starts' | 'finishes',
): Promise<void> {
  // Field is a fixed union, not user input — safe to select the column name.
  const column = field === 'opens' ? 'opens' : field === 'starts' ? 'starts' : 'finishes';
  await query(pool, `UPDATE outreach_links SET ${column} = ${column} + 1 WHERE token = $1`, [
    token,
  ]);
}

/**
 * Resolve a single outreach link by its own token — the public, respondent-
 * facing lookup a `?ref=<token>` link uses to find which edition/firm/segment
 * it belongs to. Returns the full row (including counts) because callers so
 * far are all trusted internal ones; the public route built on top of this
 * exposes only editionId/organizationId/segment, never the counts.
 */
export async function getOutreachLinkByToken(
  pool: Pool,
  token: string,
): Promise<OutreachLink | null> {
  const result = await query<RawOutreachRow>(
    pool,
    'SELECT * FROM outreach_links WHERE token = $1',
    [token],
  );
  const row = result.rows[0];
  return row ? mapOutreach(row) : null;
}

/** List a firm's outreach links (one per segment). Counters only. */
export async function listFirmOutreachLinks(
  pool: Pool,
  editionId: string,
  organizationId: string,
): Promise<OutreachLink[]> {
  const result = await query<RawOutreachRow>(
    pool,
    `SELECT * FROM outreach_links
      WHERE edition_id = $1 AND organization_id = $2
      ORDER BY segment`,
    [editionId, organizationId],
  );
  return result.rows.map(mapOutreach);
}

/** Organization ids that have created any client-outreach link this edition —
 *  i.e. firms that have started reaching their own clients. For the noreach /
 *  complete invitation audiences. */
export async function listOrganizationIdsWithOutreach(
  pool: Pool,
  editionId: string,
): Promise<string[]> {
  const result = await query<{ organization_id: string }>(
    pool,
    'SELECT DISTINCT organization_id FROM outreach_links WHERE edition_id = $1',
    [editionId],
  );
  return result.rows.map((r) => r.organization_id);
}

/**
 * A firm's own outreach performance — AGGREGATE COUNTS ONLY. There is no column
 * or accessor linking an outreach link to a response, so this cannot correlate
 * a specific response to a specific link. There is deliberately no invitation
 * count: the platform never receives a client list and cannot observe one.
 */
export async function getFirmOutreachSummary(
  pool: Pool,
  editionId: string,
  organizationId: string,
): Promise<{ links: number; opens: number; starts: number; finishes: number }> {
  const result = await query<{
    links: string;
    opens: string;
    starts: string;
    finishes: string;
  }>(
    pool,
    `SELECT COUNT(*)::text AS links,
            COALESCE(SUM(opens),0)::text     AS opens,
            COALESCE(SUM(starts),0)::text    AS starts,
            COALESCE(SUM(finishes),0)::text  AS finishes
       FROM outreach_links
      WHERE edition_id = $1 AND organization_id = $2`,
    [editionId, organizationId],
  );
  const row = result.rows[0];
  return {
    links: parseInt(row?.links ?? '0', 10),
    opens: parseInt(row?.opens ?? '0', 10),
    starts: parseInt(row?.starts ?? '0', 10),
    finishes: parseInt(row?.finishes ?? '0', 10),
  };
}

/**
 * Per-segment volumes for a firm — opens/starts/finishes ONLY, one row per
 * segment. Same non-joinability guarantee as the summary: no response can be
 * correlated to a link, and no invitation count exists.
 */
export async function getFirmOutreachBySegment(
  pool: Pool,
  editionId: string,
  organizationId: string,
): Promise<
  Array<{ segment: OutreachSegment | null; opens: number; starts: number; finishes: number }>
> {
  const result = await query<{
    segment: OutreachSegment | null;
    opens: string;
    starts: string;
    finishes: string;
  }>(
    pool,
    `SELECT segment,
            COALESCE(SUM(opens),0)::text    AS opens,
            COALESCE(SUM(starts),0)::text   AS starts,
            COALESCE(SUM(finishes),0)::text AS finishes
       FROM outreach_links
      WHERE edition_id = $1 AND organization_id = $2
      GROUP BY segment
      ORDER BY segment`,
    [editionId, organizationId],
  );
  return result.rows.map((r) => ({
    segment: r.segment,
    opens: parseInt(r.opens, 10),
    starts: parseInt(r.starts, 10),
    finishes: parseInt(r.finishes, 10),
  }));
}
