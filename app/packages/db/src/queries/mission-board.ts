import { Pool } from 'pg';
import type { InstrumentFamilyCode } from '@cis/shared-types';
import { query } from '../client';
import { listActiveInstitutionRoles } from './institutions';

/**
 * Mission-board persistent state. Only `institution_engagement` is stored;
 * segment state and firm state are computed fresh each cycle by the domain
 * evaluator from funnel_event and Phase 4/5 tables, so they are read here as
 * one-shot aggregates, never written.
 */

// ─── institution_engagement ─────────────────────────────────────────────────

export type InstitutionEngagementStatus =
  'not_started' | 'invited' | 'in_progress' | 'confirmed' | 'declined';

export interface InstitutionEngagement {
  id: string;
  editionId: string;
  institutionId: string;
  familyCode: InstrumentFamilyCode;
  /** Joined display name — condition 16 and the mission board need it without
   *  a second lookup. */
  institutionName: string;
  status: InstitutionEngagementStatus;
  statusChangedAt: Date;
  /** DECISION NEEDED — study-team-set date, NULL until entered. */
  targetBy: Date | null;
}

interface RawEngRow {
  id: string;
  edition_id: string;
  institution_id: string;
  family_code: InstrumentFamilyCode;
  institution_name: string;
  status: InstitutionEngagementStatus;
  status_changed_at: Date;
  target_by: Date | null;
}

function mapEng(r: RawEngRow): InstitutionEngagement {
  return {
    id: r.id,
    editionId: r.edition_id,
    institutionId: r.institution_id,
    familyCode: r.family_code,
    institutionName: r.institution_name,
    status: r.status,
    statusChangedAt: r.status_changed_at,
    targetBy: r.target_by,
  };
}

const ENG_SELECT = `
  SELECT e.id, e.edition_id, e.institution_id, e.family_code, e.status,
         e.status_changed_at, e.target_by, i.name AS institution_name
    FROM institution_engagement e
    JOIN institutions i ON i.id = e.institution_id`;

/** Seed one engagement row per (institution, family) role CIS has actually
 *  registered — status not_started, target_by NULL (DECISION NEEDED;
 *  condition 16 stays inert until a real date is set). A ninth institution of
 *  an existing role needs no code change here: it is picked up from
 *  `institution_roles`, once registered (`is_active = TRUE`; §8 of the Screen
 *  Stitching Guide — LCFE, NASD and the FMDQ entities are "under CIS review
 *  and not registered and not in collection" and get no row until then). */
export async function seedInstitutionEngagement(pool: Pool, editionId: string): Promise<void> {
  const roles = await listActiveInstitutionRoles(pool);
  for (const role of roles) {
    await query(
      pool,
      `INSERT INTO institution_engagement (edition_id, institution_id, family_code)
       VALUES ($1,$2,$3)
       ON CONFLICT (edition_id, institution_id, family_code) DO NOTHING`,
      [editionId, role.institutionId, role.familyCode],
    );
  }
}

export async function listInstitutionEngagement(
  pool: Pool,
  editionId: string,
): Promise<InstitutionEngagement[]> {
  const res = await query<RawEngRow>(
    pool,
    `${ENG_SELECT} WHERE e.edition_id = $1 ORDER BY e.family_code, i.name`,
    [editionId],
  );
  return res.rows.map(mapEng);
}

export async function setInstitutionEngagement(
  pool: Pool,
  editionId: string,
  institutionId: string,
  familyCode: InstrumentFamilyCode,
  data: { status?: InstitutionEngagementStatus; targetBy?: Date | null },
): Promise<InstitutionEngagement> {
  const res = await query<{ id: string }>(
    pool,
    `UPDATE institution_engagement
        SET status = COALESCE($4, status),
            status_changed_at = CASE WHEN $4 IS NOT NULL THEN NOW() ELSE status_changed_at END,
            target_by = COALESCE($5, target_by),
            updated_at = NOW()
      WHERE edition_id = $1 AND institution_id = $2 AND family_code = $3
      RETURNING id`,
    [editionId, institutionId, familyCode, data.status ?? null, data.targetBy ?? null],
  );
  const id = res.rows[0]?.id;
  if (!id) throw new Error(`institution_engagement ${institutionId}/${familyCode} not found`);
  const full = await query<RawEngRow>(pool, `${ENG_SELECT} WHERE e.id = $1`, [id]);
  const row = full.rows[0];
  if (!row) throw new Error(`institution_engagement ${institutionId}/${familyCode} not found`);
  return mapEng(row);
}

// ─── Per-firm funnel state (computed read, never stored) ─────────────────────

export interface FirmFunnelRow {
  firmId: string;
  firmName: string;
  invitedAt: Date | null;
  claimedAt: Date | null;
  assignedSeats: number;
  openedSeats: number;
  completedSeats: number;
  lastFunnelActivity: Date | null;
}

/**
 * Per-firm firm-side funnel state assembled from the live tables:
 *   invited   — earliest invitation recipient row this edition
 *   claimed   — firm_claims row
 *   assigned  — seats with state <> 'empty'
 *   opened    — seats with state in ('started','complete')  [the "silent" claimed→assigned
 *               stage stays observable because assigned and opened are counted separately]
 *   completed — seats with state 'complete'
 *   lastFunnelActivity — most recent funnel_event for this firm_id
 */
export async function getFirmFunnelRows(pool: Pool, editionId: string): Promise<FirmFunnelRow[]> {
  const res = await query<{
    firm_id: string;
    firm_name: string;
    invited_at: Date | null;
    claimed_at: Date | null;
    assigned_seats: string;
    opened_seats: string;
    completed_seats: string;
    last_activity: Date | null;
  }>(
    pool,
    `SELECT o.id AS firm_id, o.display_name AS firm_name,
            inv.invited_at,
            fc.claimed_at,
            COALESCE(s.assigned_seats, 0)::text  AS assigned_seats,
            COALESCE(s.opened_seats, 0)::text     AS opened_seats,
            COALESCE(s.completed_seats, 0)::text  AS completed_seats,
            act.last_activity
       FROM organizations o
       LEFT JOIN (
         SELECT r.organization_id, MIN(b.sent_at) AS invited_at
           FROM message_recipients r JOIN message_batches b ON b.id = r.batch_id
          WHERE r.edition_id = $1 AND r.organization_id IS NOT NULL
          GROUP BY r.organization_id
       ) inv ON inv.organization_id = o.id
       LEFT JOIN firm_claims fc ON fc.organization_id = o.id
       LEFT JOIN (
         SELECT organization_id,
                COUNT(*) FILTER (WHERE state <> 'empty')                 AS assigned_seats,
                COUNT(*) FILTER (WHERE state IN ('started','complete'))  AS opened_seats,
                COUNT(*) FILTER (WHERE state = 'complete')               AS completed_seats
           FROM seat_assignments WHERE edition_id = $1
          GROUP BY organization_id
       ) s ON s.organization_id = o.id
       LEFT JOIN (
         SELECT firm_id, MAX(occurred_at) AS last_activity
           FROM funnel_event WHERE edition_id = $1 AND firm_id IS NOT NULL
          GROUP BY firm_id
       ) act ON act.firm_id = o.id
      WHERE o.org_type = 'firm' AND o.is_active = TRUE
      ORDER BY o.display_name`,
    [editionId],
  );
  return res.rows.map((r) => ({
    firmId: r.firm_id,
    firmName: r.firm_name,
    invitedAt: r.invited_at,
    claimedAt: r.claimed_at,
    assignedSeats: parseInt(r.assigned_seats, 10),
    openedSeats: parseInt(r.opened_seats, 10),
    completedSeats: parseInt(r.completed_seats, 10),
    lastFunnelActivity: r.last_activity,
  }));
}

/**
 * Per-firm operational-maturity score for the firm-tier heatmap. INFERENCE
 * (flagged in README): the score is each firm's own answer to S1-Q2 ("overall
 * operational maturity today", 1–10), read through the firm's S1 seat's
 * respondent. Firms with no such answer are omitted (untiered).
 */
export async function getFirmMaturityScores(
  pool: Pool,
  editionId: string,
): Promise<Array<{ firmId: string; score: number }>> {
  const res = await query<{ firm_id: string; score: string | null }>(
    pool,
    `SELECT sa.organization_id AS firm_id,
            (resp.answer->>'a') AS score
       FROM seat_assignments sa
       JOIN responses resp ON resp.respondent_id = sa.respondent_id
      WHERE sa.edition_id = $1 AND sa.seat_code = 'S1' AND sa.respondent_id IS NOT NULL
        AND resp.question_id = 'S1-Q2'`,
    [editionId],
  );
  const out: Array<{ firmId: string; score: number }> = [];
  for (const r of res.rows) {
    const n = r.score === null ? NaN : Number(r.score);
    if (!Number.isNaN(n)) out.push({ firmId: r.firm_id, score: n });
  }
  return out;
}

/**
 * Seed/reconcile the Year-1 reporting-dependency map (brief §3.3). Ten outputs,
 * each expressed as a rule over segment state so methodology validation can
 * refine it without a build. Idempotent (upsert per output).
 */
export async function seedMissionBoardDependencies(pool: Pool): Promise<void> {
  // `required` names the firm-side instruments a firm-referencing output needs
  // (UX-OPS-003 §B7): OMI = complete firms (S1+S2+S3); DMI = DMI-complete (S1+S3).
  // Investor-only outputs declare none (null). The firm report is split into TWO
  // rows (§B4): the guaranteed combined report, and the per-firm category cuts —
  // which are DESIGNED suppression, never an "at risk" state.
  const rows: Array<{
    outputId: string;
    dependsOn: string[];
    rule: string;
    required?: string[] | null;
  }> = [
    { outputId: 'OMI', dependsOn: ['firm'], rule: 'at_risk(firm)', required: ['S1', 'S2', 'S3'] },
    { outputId: 'DMI', dependsOn: ['firm'], rule: 'at_risk(firm)', required: ['S1', 'S3'] },
    { outputId: 'IEI_ICI_HEADLINE', dependsOn: ['retail'], rule: 'at_risk(retail)' },
    {
      outputId: 'IEI_ICI_BY_SEGMENT',
      dependsOn: ['retail', 'local_institution', 'foreign_institution'],
      rule: 'at_risk(retail) OR at_risk(local_institution) OR at_risk(foreign_institution)',
    },
    {
      outputId: 'SEI_GAP',
      dependsOn: ['firm', 'retail'],
      rule: 'at_risk(firm) OR at_risk(retail)',
      required: ['S1', 'S2', 'S3'],
    },
    {
      outputId: 'LOCAL_VS_FOREIGN',
      dependsOn: ['local_institution', 'foreign_institution'],
      rule: 'at_risk(local_institution) OR at_risk(foreign_institution)',
    },
    {
      outputId: 'FIRM_TIER_HEATMAP',
      dependsOn: ['firm'],
      rule: 'tier_coverage_uneven',
      required: ['S1'],
    },
    {
      // The guaranteed combined firm report — FRM_01/02/03 to every participating
      // firm regardless of volume. "At risk" here means THIN, not withheld.
      outputId: 'PARTICIPATING_FIRM_REPORT',
      dependsOn: ['firm'],
      rule: 'guaranteed_combined_report_thin_not_withheld',
      required: ['S1', 'S2', 'S3'],
    },
    {
      // The per-firm category cuts (FRM_04 retail cut). Per-firm suppression is
      // DESIGNED sufficiency gating — it reads "Some suppressed", never "At risk".
      outputId: 'PARTICIPATING_FIRM_REPORT_CATEGORY_CUTS',
      dependsOn: ['retail'],
      rule: 'per_firm_category_suppression_by_design',
    },
    { outputId: 'TOP_INVESTOR_FRUSTRATIONS', dependsOn: ['retail'], rule: 'at_risk(retail)' },
    {
      outputId: 'INSTITUTIONAL_PERSPECTIVES',
      dependsOn: ['local_institution', 'foreign_institution'],
      rule: 'any_institution_late_against_target',
    },
  ];
  for (const r of rows) {
    await query(
      pool,
      `INSERT INTO report_dependency (output_id, depends_on, sufficiency_rule, enabled, required_instruments)
       VALUES ($1,$2,$3,TRUE,$4)
       ON CONFLICT (output_id) DO UPDATE
         SET depends_on = EXCLUDED.depends_on, sufficiency_rule = EXCLUDED.sufficiency_rule,
             required_instruments = EXCLUDED.required_instruments, updated_at = NOW()`,
      [
        r.outputId,
        JSON.stringify(r.dependsOn),
        r.rule,
        r.required ? JSON.stringify(r.required) : null,
      ],
    );
  }
}
