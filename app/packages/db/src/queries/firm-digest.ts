import { Pool } from 'pg';
import { query } from '../client';

/**
 * UX-FRM-DIG-001 — firm digest aggregates.
 *
 * This file is a deliberately narrow surface: every function here returns
 * COUNTS or STATE FLAGS only. None joins to `responses`, `respondent_drafts`,
 * or any other table that carries answer content, and none selects a
 * `respondent_id` or `question_id`. This is a structural guarantee, not a
 * convention — a digest can never leak individual response content because
 * the queries that assemble it are incapable of returning it.
 */

export interface FirmSegmentContribution {
  retail: number;
  localInstitutional: number;
  foreignInstitutional: number;
}

/**
 * Counts of COMPLETED responses attributable to this firm's outreach, by
 * investor segment. Reuses Phase 5's `firm_id IS NOT NULL` attributable-count
 * constraint (Phase 5 §6/§8) — a count only, never used to determine which
 * specific investor rated the firm.
 */
export async function getFirmSegmentContributionCounts(
  pool: Pool,
  editionId: string,
  organizationId: string,
): Promise<FirmSegmentContribution> {
  const res = await query<{ segment: string; n: string }>(
    pool,
    `SELECT segment, COUNT(*)::text AS n
       FROM funnel_event
      WHERE edition_id = $1
        AND firm_id = $2
        AND event_type = 'completed'
      GROUP BY segment`,
    [editionId, organizationId],
  );
  const counts: FirmSegmentContribution = {
    retail: 0,
    localInstitutional: 0,
    foreignInstitutional: 0,
  };
  for (const row of res.rows) {
    const n = Number(row.n);
    if (row.segment === 'retail') counts.retail = n;
    else if (row.segment === 'local_institution') counts.localInstitutional = n;
    else if (row.segment === 'foreign_institution') counts.foreignInstitutional = n;
  }
  return counts;
}
