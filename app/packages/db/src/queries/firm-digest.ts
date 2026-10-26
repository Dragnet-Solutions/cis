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
 * Counts of SUBMITTED investor responses attributable to this firm's outreach
 * (the respondent came in through the firm's own link: `recruiting_firm_id`),
 * by investor segment — a count only, never used to determine which specific
 * investor rated the firm.
 *
 * Read from `respondents`, not the funnel: an investor completion is recorded
 * on the funnel with no firm (one response may rate several firms), so a
 * funnel count by firm was always zero for real submissions (QA E12).
 */
export async function getFirmSegmentContributionCounts(
  pool: Pool,
  editionId: string,
  organizationId: string,
): Promise<FirmSegmentContribution> {
  const res = await query<{ segment: string; n: string }>(
    pool,
    `SELECT CASE instrument_code
              WHEN 'S4' THEN 'retail'
              WHEN 'S5a' THEN 'local_institution'
              WHEN 'S5b' THEN 'foreign_institution'
            END AS segment,
            COUNT(*)::text AS n
       FROM respondents
      WHERE edition_id = $1
        AND recruiting_firm_id = $2
        AND submitted_at IS NOT NULL
        AND instrument_code IN ('S4', 'S5a', 'S5b')
      GROUP BY instrument_code`,
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
