/**
 * D-15 — create the next edition from this one's configuration.
 *
 * Needs the setup right (edition:manage). Not maker-checker: nothing is sent,
 * frozen or published, and the new edition is a draft that is reviewed (its
 * questionnaires frozen by a maker-checker request) before it can open. The
 * creation is audited (`edition.next_created`).
 *
 * Only one draft edition at a time: refused while another draft exists.
 *
 * Dates: shifted forward one year (planned launch, last day for returns, and
 * each institution's "expected back by"), all still editable on the draft.
 *
 * Every table carrying edition_id, and what happens to it:
 *
 *   COPIED
 *   - edition_sample_floors ......... the four floors, same values
 *   - message_templates ............. every template (firm and participant
 *                                     wording), same name/subject/body
 *   - edition_participation ......... firms in the register that are active
 *                                     and were not withdrawn: enrolled 'active',
 *                                     as the CSV import enrols them
 *   - institution_engagement ........ one row per registered (institution,
 *                                     family) role, fresh state: no contact,
 *                                     link or respondent; the source's target
 *                                     date carried forward one year
 *   - editions.prior_edition_id ..... set to the source edition
 *
 *   NOT COPIED (per-edition activity or results)
 *   - edition_instrument_snapshots .. the new edition starts UNFROZEN; the
 *                                     current instrument definitions are what
 *                                     it will freeze (definitions are global)
 *   - critical_actions, audit_log
 *   - respondents, responses, outreach_links, seat_assignments, funnel_event
 *   - firm_invitations, invitation_requests, message_batches, message_recipients
 *   - regulator_engagement_history, reminder_send
 *   - calculation_runs, comparison_runs, scoring_signoffs
 *   - national_reports, report_narratives, report_publications, report_snapshots,
 *     firm_reports, firm_report_release_history
 *
 *   NOT EDITION-SCOPED (shared by every edition already, nothing to copy)
 *   - instrument_definitions / _versions / instrument_questions (questionnaires)
 *   - governed_config (reminder schedule and cap, consent copy, link TTLs)
 *   - content_versions / content_live / required_clauses (managed wording)
 *   - institutions, institution_roles (families and questionnaire assignment)
 *   - organizations, users, permissions, metric_definitions, report_dependency
 */
import { Pool } from 'pg';
import {
  getEditionById,
  listEditions,
  withTransaction,
  seedInstitutionEngagement,
  type PoolClient,
} from '@cis/db';
import { requirePermission, type RbacContext } from '@cis/auth';
import { writeAudit } from '@cis/audit';
import type { Edition } from '@cis/shared-types';
import { EditionStateError, DomainError } from './errors';
import { EDITION_MANAGE_PERMISSION, type ActorContext } from './edition-service';

export interface NextEditionResult {
  edition: Edition;
  copied: {
    floors: number;
    templates: number;
    participants: number;
    institutionRoles: number;
  };
}

/** The suggested label for the edition after `label`: next year if it is one. */
export function nextEditionLabel(label: string): string {
  const m = /^(.*?)(\d{4})(\D*)$/.exec(label.trim());
  return m ? `${m[1]}${Number(m[2]) + 1}${m[3]}` : `${label.trim()} (next)`;
}

/**
 * The edition that already follows `source`, if any: one created from it, or
 * one already carrying the label its next edition would get. Any status — an
 * open or locked next edition counts as much as a draft (QA E03).
 */
export function followingEdition(editions: readonly Edition[], source: Edition): Edition | null {
  const suggested = nextEditionLabel(source.label).toLowerCase();
  return (
    editions.find((e) => e.id !== source.id && e.priorEditionId === source.id) ??
    editions.find((e) => e.id !== source.id && e.label.toLowerCase() === suggested) ??
    null
  );
}

function plusOneYear(d: Date | null): Date | null {
  if (!d) return null;
  const next = new Date(d.getTime());
  next.setUTCFullYear(next.getUTCFullYear() + 1);
  return next;
}

export async function createNextEdition(
  pool: Pool,
  rbac: RbacContext,
  sourceEditionId: string,
  input: { label?: string | null } = {},
  ctx: ActorContext = {},
): Promise<NextEditionResult> {
  requirePermission(rbac, EDITION_MANAGE_PERMISSION);

  const source = await getEditionById(pool, sourceEditionId);
  if (!source) throw new EditionStateError(`Edition ${sourceEditionId} not found`);

  const label = (input.label ?? '').trim() || nextEditionLabel(source.label);
  if (label.length > 40) {
    throw new DomainError('The edition label is too long (40 characters at most)', 'EDITION_LABEL');
  }

  const editions = await listEditions(pool);
  const draft = editions.find((e) => e.status === 'draft');
  if (draft) {
    throw new EditionStateError(
      `The ${draft.label} edition is already in draft. Only one draft edition can exist at a time — set that one up instead.`,
    );
  }
  if (editions.some((e) => e.label.toLowerCase() === label.toLowerCase())) {
    throw new EditionStateError(`An edition called ${label} already exists`);
  }
  // Whatever its status — an open or locked next edition counts as much as a
  // draft (QA E03).
  const following = editions.find((e) => e.id !== source.id && e.priorEditionId === source.id);
  if (following) {
    throw new EditionStateError(
      `The ${following.label} edition already follows ${source.label}. Start the next one from ${following.label} instead.`,
    );
  }

  const result = await withTransaction(pool, async (client: PoolClient) => {
    const created = await client.query<{ id: string }>(
      `INSERT INTO editions (label, status, prior_edition_id, planned_open_at, survey_close_at)
       VALUES ($1, 'draft', $2, $3, $4)
       RETURNING id`,
      [
        label,
        source.id,
        plusOneYear(source.plannedOpenAt ?? source.surveyOpenAt),
        plusOneYear(source.surveyCloseAt),
      ],
    );
    const id = created.rows[0]!.id;

    const floors = await client.query(
      `INSERT INTO edition_sample_floors (edition_id, category, floor_value)
       SELECT $1, category, floor_value FROM edition_sample_floors WHERE edition_id = $2`,
      [id, source.id],
    );
    const templates = await client.query(
      `INSERT INTO message_templates
         (edition_id, name, subject, body, audience_kind, requires_code, created_by)
       SELECT $1, name, subject, body, audience_kind, requires_code, $3
         FROM message_templates WHERE edition_id = $2`,
      [id, source.id, rbac.userId],
    );
    const participants = await client.query(
      `INSERT INTO edition_participation (edition_id, organization_id, status)
       SELECT $1, ep.organization_id, 'active'
         FROM edition_participation ep
         JOIN organizations o ON o.id = ep.organization_id
        WHERE ep.edition_id = $2 AND ep.status <> 'withdrawn' AND o.is_active = TRUE`,
      [id, source.id],
    );
    // One fresh row per registered (institution, family) role, then the
    // source's "expected back by" carried forward a year where it had one.
    await seedInstitutionEngagement(client as unknown as Pool, id);
    await client.query(
      `UPDATE institution_engagement n
          SET target_by = (s.target_by + INTERVAL '1 year')::date
         FROM institution_engagement s
        WHERE n.edition_id = $1 AND s.edition_id = $2
          AND s.institution_id = n.institution_id AND s.family_code = n.family_code
          AND s.target_by IS NOT NULL`,
      [id, source.id],
    );
    const roles = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM institution_engagement WHERE edition_id = $1`,
      [id],
    );

    const copied = {
      floors: floors.rowCount ?? 0,
      templates: templates.rowCount ?? 0,
      participants: participants.rowCount ?? 0,
      institutionRoles: Number(roles.rows[0]!.n),
    };

    await writeAudit(client as unknown as Pool, {
      actorId: rbac.userId,
      actionType: 'edition.next_created',
      entityType: 'edition',
      entityId: id,
      editionId: id,
      newValue: {
        label,
        status: 'draft',
        sourceEditionId: source.id,
        sourceLabel: source.label,
        copied,
      },
      ipAddress: ctx.ipAddress ?? null,
      userAgent: ctx.userAgent ?? null,
    });
    return { id, copied };
  });

  const edition = await getEditionById(pool, result.id);
  return { edition: edition!, copied: result.copied };
}
