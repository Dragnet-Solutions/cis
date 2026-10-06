import { Pool } from 'pg';
import type {
  InstrumentFamilyCode,
  RegulatorContact,
  RegulatorHistoryEntry,
} from '@cis/shared-types';
import type { InstitutionEngagementStatus } from './mission-board';
import { query } from '../client';

/**
 * Phase 12 (UX-OPS-007) — the regulator engagement record. This owns the
 * per-(edition, institution, family) row that Phase 10 created
 * (`institution_engagement`): its `status` and `target_by` are Phase 10's,
 * and this phase adds the named contact and the issued survey link to the
 * SAME row (no second date field), plus an append-only free-text history
 * table.
 *
 * Phase 19 re-keys every function here from a fixed `RegulatorCode` enum to
 * the (institutionId, familyCode) composite key — a multi-role institution
 * (CSCS: Family C AND Family D) needs two independent rows in the same
 * edition, one per role, and a ninth institution of an existing role needs
 * no code change here.
 *
 * The status/target_by writers here can set `target_by` back to NULL (referral
 * reset) — deliberately distinct from Phase 10's `setInstitutionEngagement`,
 * which COALESCEs and therefore can never clear the date.
 */

export interface RegulatorEngagementRow {
  editionId: string;
  institutionId: string;
  familyCode: InstrumentFamilyCode;
  institutionName: string;
  status: InstitutionEngagementStatus;
  statusChangedAt: Date;
  targetBy: Date | null;
  contact: RegulatorContact | null;
  surveyLink: string | null;
  respondentId: string | null;
}

interface RawRow {
  edition_id: string;
  institution_id: string;
  family_code: InstrumentFamilyCode;
  institution_name: string;
  status: InstitutionEngagementStatus;
  status_changed_at: Date;
  target_by: Date | null;
  contact_who: string | null;
  contact_role: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  contact_how: string | null;
  survey_link: string | null;
  respondent_id: string | null;
}

function mapRow(r: RawRow): RegulatorEngagementRow {
  const contact: RegulatorContact | null =
    r.contact_who === null
      ? null
      : {
          who: r.contact_who,
          role: r.contact_role ?? '',
          email: r.contact_email ?? '',
          phone: r.contact_phone ?? '',
          how: r.contact_how ?? '',
        };
  return {
    editionId: r.edition_id,
    institutionId: r.institution_id,
    familyCode: r.family_code,
    institutionName: r.institution_name,
    status: r.status,
    statusChangedAt: r.status_changed_at,
    targetBy: r.target_by,
    contact,
    surveyLink: r.survey_link,
    respondentId: r.respondent_id,
  };
}

const ROW_SELECT = `
  SELECT e.edition_id, e.institution_id, e.family_code, i.name AS institution_name,
         e.status, e.status_changed_at, e.target_by,
         e.contact_who, e.contact_role, e.contact_email, e.contact_phone, e.contact_how,
         e.survey_link, e.respondent_id
    FROM institution_engagement e
    JOIN institutions i ON i.id = e.institution_id`;

export async function getRegulatorEngagement(
  pool: Pool,
  editionId: string,
  institutionId: string,
  familyCode: InstrumentFamilyCode,
): Promise<RegulatorEngagementRow | null> {
  const res = await query<RawRow>(
    pool,
    `${ROW_SELECT} WHERE e.edition_id = $1 AND e.institution_id = $2 AND e.family_code = $3`,
    [editionId, institutionId, familyCode],
  );
  const row = res.rows[0];
  return row ? mapRow(row) : null;
}

export async function listRegulatorEngagement(
  pool: Pool,
  editionId: string,
): Promise<RegulatorEngagementRow[]> {
  const res = await query<RawRow>(
    pool,
    `${ROW_SELECT} WHERE e.edition_id = $1 ORDER BY e.family_code, i.name`,
    [editionId],
  );
  return res.rows.map(mapRow);
}

/** Persist the named contact on the engagement row (does not touch survey state). */
export async function saveRegulatorContact(
  pool: Pool,
  editionId: string,
  institutionId: string,
  familyCode: InstrumentFamilyCode,
  contact: RegulatorContact,
): Promise<RegulatorEngagementRow> {
  const res = await query<{ id: string }>(
    pool,
    `UPDATE institution_engagement
        SET contact_who = $4, contact_role = $5, contact_email = $6,
            contact_phone = $7, contact_how = $8, updated_at = NOW()
      WHERE edition_id = $1 AND institution_id = $2 AND family_code = $3
      RETURNING id`,
    [
      editionId,
      institutionId,
      familyCode,
      contact.who,
      contact.role,
      contact.email,
      contact.phone,
      contact.how,
    ],
  );
  if (!res.rows[0]) {
    throw new Error(`institution_engagement ${institutionId}/${familyCode} not found`);
  }
  const row = await getRegulatorEngagement(pool, editionId, institutionId, familyCode);
  if (!row) throw new Error(`institution_engagement ${institutionId}/${familyCode} not found`);
  return row;
}

/**
 * Record the issued survey link: status → 'invited', the study-team `targetBy`
 * date, the survey link string and the respondent id that backs it. `targetBy`
 * is set explicitly (no COALESCE) so it is exactly the study-team value.
 *
 * `targetBy` is a plain 'YYYY-MM-DD' string, deliberately never a JS `Date`
 * object, here. `target_by` is a DATE column — a calendar date, not an
 * instant — and `pg` serializes an outgoing `Date` parameter using the
 * process's LOCAL timezone components (see node-postgres's `dateToString`).
 * In any timezone behind UTC, a UTC-midnight `Date` for "2026-09-01" formats
 * as local "2026-08-31 …-05", and a DATE column silently drops that trailing
 * offset — storing the wrong day. Passing the already-validated string
 * bypasses that serialization entirely, so the day stored is exactly the day
 * the study team typed.
 */
export async function setRegulatorSurveyIssued(
  pool: Pool,
  editionId: string,
  institutionId: string,
  familyCode: InstrumentFamilyCode,
  data: { targetBy: string; surveyLink: string; respondentId: string },
): Promise<RegulatorEngagementRow> {
  const res = await query<{ id: string }>(
    pool,
    `UPDATE institution_engagement
        SET status = 'invited', status_changed_at = NOW(),
            target_by = $4, survey_link = $5, respondent_id = $6, updated_at = NOW()
      WHERE edition_id = $1 AND institution_id = $2 AND family_code = $3
      RETURNING id`,
    [editionId, institutionId, familyCode, data.targetBy, data.surveyLink, data.respondentId],
  );
  if (!res.rows[0]) {
    throw new Error(`institution_engagement ${institutionId}/${familyCode} not found`);
  }
  const row = await getRegulatorEngagement(pool, editionId, institutionId, familyCode);
  if (!row) throw new Error(`institution_engagement ${institutionId}/${familyCode} not found`);
  return row;
}

/** Set the engagement status only (e.g. 'confirmed' on submission, 'declined'). */
export async function setRegulatorStatus(
  pool: Pool,
  editionId: string,
  institutionId: string,
  familyCode: InstrumentFamilyCode,
  status: InstitutionEngagementStatus,
): Promise<RegulatorEngagementRow> {
  const res = await query<{ id: string }>(
    pool,
    `UPDATE institution_engagement
        SET status = $4, status_changed_at = NOW(), updated_at = NOW()
      WHERE edition_id = $1 AND institution_id = $2 AND family_code = $3
      RETURNING id`,
    [editionId, institutionId, familyCode, status],
  );
  if (!res.rows[0]) {
    throw new Error(`institution_engagement ${institutionId}/${familyCode} not found`);
  }
  const row = await getRegulatorEngagement(pool, editionId, institutionId, familyCode);
  if (!row) throw new Error(`institution_engagement ${institutionId}/${familyCode} not found`);
  return row;
}

/**
 * Full referral reset: status → 'not_started', clear `target_by`, the survey link
 * and the respondent link. Deliberately sets `target_by` to NULL — a new lead
 * time must be set again once a fresh link is issued.
 */
export async function clearRegulatorSurvey(
  pool: Pool,
  editionId: string,
  institutionId: string,
  familyCode: InstrumentFamilyCode,
): Promise<RegulatorEngagementRow> {
  const res = await query<{ id: string }>(
    pool,
    `UPDATE institution_engagement
        SET status = 'not_started', status_changed_at = NOW(),
            target_by = NULL, survey_link = NULL, respondent_id = NULL, updated_at = NOW()
      WHERE edition_id = $1 AND institution_id = $2 AND family_code = $3
      RETURNING id`,
    [editionId, institutionId, familyCode],
  );
  if (!res.rows[0]) {
    throw new Error(`institution_engagement ${institutionId}/${familyCode} not found`);
  }
  const row = await getRegulatorEngagement(pool, editionId, institutionId, familyCode);
  if (!row) throw new Error(`institution_engagement ${institutionId}/${familyCode} not found`);
  return row;
}

// ─── Append-only free-text history ─────────────────────────────────────────────

export async function addRegulatorHistory(
  pool: Pool,
  editionId: string,
  institutionId: string,
  familyCode: InstrumentFamilyCode,
  entry: string,
): Promise<RegulatorHistoryEntry> {
  const res = await query<{ id: string; entry: string; created_at: Date }>(
    pool,
    `INSERT INTO regulator_engagement_history (edition_id, institution_id, family_code, entry)
     VALUES ($1, $2, $3, $4)
     RETURNING id, entry, created_at`,
    [editionId, institutionId, familyCode, entry],
  );
  const row = res.rows[0];
  if (!row) throw new Error('regulator history insert returned no rows');
  return { id: row.id, entry: row.entry, createdAt: row.created_at };
}

/**
 * A regulator's survey was submitted through its link: move the role that
 * issued that link to 'confirmed' and say so in its history. Called inside the
 * submission transaction, so the engagement can never disagree with the
 * survey. Only a live invitation moves — a declined or already-confirmed role,
 * or a respondent that backs no engagement, is left alone. Returns whether a
 * role was confirmed.
 */
export async function confirmEngagementForSubmittedRespondent(
  pool: Pool,
  respondentId: string,
): Promise<boolean> {
  const res = await query<{
    edition_id: string;
    institution_id: string;
    family_code: InstrumentFamilyCode;
  }>(
    pool,
    `UPDATE institution_engagement
        SET status = 'confirmed', status_changed_at = NOW(), updated_at = NOW()
      WHERE respondent_id = $1 AND status IN ('invited', 'in_progress')
      RETURNING edition_id, institution_id, family_code`,
    [respondentId],
  );
  const row = res.rows[0];
  if (!row) return false;
  await addRegulatorHistory(
    pool,
    row.edition_id,
    row.institution_id,
    row.family_code,
    'Submitted through their survey link. Their answers form part of the Institutional Perspectives section.',
  );
  return true;
}

export async function listRegulatorHistory(
  pool: Pool,
  editionId: string,
  institutionId: string,
  familyCode: InstrumentFamilyCode,
): Promise<RegulatorHistoryEntry[]> {
  const res = await query<{ id: string; entry: string; created_at: Date }>(
    pool,
    `SELECT id, entry, created_at
       FROM regulator_engagement_history
      WHERE edition_id = $1 AND institution_id = $2 AND family_code = $3
      ORDER BY created_at DESC, id DESC`,
    [editionId, institutionId, familyCode],
  );
  return res.rows.map((r) => ({ id: r.id, entry: r.entry, createdAt: r.created_at }));
}
