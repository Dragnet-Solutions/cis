import { Pool } from 'pg';
import { query } from '../client';

export interface ContentVersion {
  id: string;
  contentArea: string;
  subKey: string;
  body: string;
  versionNumber: number;
  createdBy: string | null;
  createdAt: Date;
}

export interface ContentLive {
  contentArea: string;
  subKey: string;
  versionId: string;
  publishedBy: string | null;
  publishedAt: Date;
  version: ContentVersion;
}

export interface RequiredClause {
  id: string;
  contentArea: string;
  subKey: string;
  clauseKey: string;
  clauseText: string;
}

interface RawVersion {
  id: string;
  content_area: string;
  sub_key: string;
  body: string;
  version_number: number;
  created_by: string | null;
  created_at: Date;
}

interface RawLive {
  content_area: string;
  sub_key: string;
  version_id: string;
  published_by: string | null;
  published_at: Date;
  v_id: string;
  v_content_area: string;
  v_sub_key: string;
  v_body: string;
  v_version_number: number;
  v_created_by: string | null;
  v_created_at: Date;
}

function mapVersion(r: RawVersion): ContentVersion {
  return {
    id: r.id,
    contentArea: r.content_area,
    subKey: r.sub_key,
    body: r.body,
    versionNumber: r.version_number,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

export async function getNextVersionNumber(
  pool: Pool,
  contentArea: string,
  subKey: string,
): Promise<number> {
  const result = await query<{ n: number | null }>(
    pool,
    `SELECT MAX(version_number) AS n FROM content_versions
      WHERE content_area = $1 AND sub_key = $2`,
    [contentArea, subKey],
  );
  return (result.rows[0]?.n ?? 0) + 1;
}

export async function insertContentVersion(
  pool: Pool,
  contentArea: string,
  subKey: string,
  body: string,
  createdBy: string | null,
): Promise<ContentVersion> {
  const nextNum = await getNextVersionNumber(pool, contentArea, subKey);
  const result = await query<RawVersion>(
    pool,
    `INSERT INTO content_versions (content_area, sub_key, body, version_number, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [contentArea, subKey, body, nextNum, createdBy],
  );
  const row = result.rows[0];
  if (!row) throw new Error('insertContentVersion: no row returned');
  return mapVersion(row);
}

export async function listContentVersions(
  pool: Pool,
  contentArea: string,
  subKey: string,
): Promise<ContentVersion[]> {
  const result = await query<RawVersion>(
    pool,
    `SELECT * FROM content_versions
      WHERE content_area = $1 AND sub_key = $2
      ORDER BY version_number DESC`,
    [contentArea, subKey],
  );
  return result.rows.map(mapVersion);
}

export async function getContentVersion(
  pool: Pool,
  versionId: string,
): Promise<ContentVersion | null> {
  const result = await query<RawVersion>(pool, 'SELECT * FROM content_versions WHERE id = $1', [
    versionId,
  ]);
  const row = result.rows[0];
  return row ? mapVersion(row) : null;
}

/** Upsert the live pointer for a content area+sub_key to point to a specific version. */
export async function setContentLive(
  pool: Pool,
  contentArea: string,
  subKey: string,
  versionId: string,
  publishedBy: string | null,
): Promise<void> {
  await query(
    pool,
    `INSERT INTO content_live (content_area, sub_key, version_id, published_by, published_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (content_area, sub_key) DO UPDATE
       SET version_id = EXCLUDED.version_id,
           published_by = EXCLUDED.published_by,
           published_at = NOW()`,
    [contentArea, subKey, versionId, publishedBy],
  );
}

export async function getLiveContent(
  pool: Pool,
  contentArea: string,
  subKey: string,
): Promise<ContentLive | null> {
  const result = await query<RawLive>(
    pool,
    `SELECT
       cl.content_area, cl.sub_key, cl.version_id, cl.published_by, cl.published_at,
       cv.id AS v_id, cv.content_area AS v_content_area, cv.sub_key AS v_sub_key,
       cv.body AS v_body, cv.version_number AS v_version_number,
       cv.created_by AS v_created_by, cv.created_at AS v_created_at
     FROM content_live cl
     JOIN content_versions cv ON cv.id = cl.version_id
     WHERE cl.content_area = $1 AND cl.sub_key = $2`,
    [contentArea, subKey],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    contentArea: row.content_area,
    subKey: row.sub_key,
    versionId: row.version_id,
    publishedBy: row.published_by,
    publishedAt: row.published_at,
    version: {
      id: row.v_id,
      contentArea: row.v_content_area,
      subKey: row.v_sub_key,
      body: row.v_body,
      versionNumber: row.v_version_number,
      createdBy: row.v_created_by,
      createdAt: row.v_created_at,
    },
  };
}

export async function getRequiredClauses(
  pool: Pool,
  contentArea: string,
  subKey: string,
): Promise<RequiredClause[]> {
  const result = await query<{
    id: string;
    content_area: string;
    sub_key: string;
    clause_key: string;
    clause_text: string;
  }>(pool, `SELECT * FROM required_clauses WHERE content_area = $1 AND sub_key = $2`, [
    contentArea,
    subKey,
  ]);
  return result.rows.map((r) => ({
    id: r.id,
    contentArea: r.content_area,
    subKey: r.sub_key,
    clauseKey: r.clause_key,
    clauseText: r.clause_text,
  }));
}

// ─── Forbidden phrases (UX-X-002) — the inverse of required_clauses ─────────

export interface ForbiddenPhrase {
  id: string;
  contentArea: string;
  subKey: string;
  phraseKey: string;
  phraseText: string;
}

/**
 * Phrases that must NOT appear in a content area's body. Seeded for
 * privacy_notice: an absolute-anonymity claim would be factually wrong, since
 * a respondent's session can be linked server-side to their response for
 * recovery/immutability purposes (never exposed to firms or the public, but
 * real nonetheless).
 */
export async function getForbiddenPhrases(
  pool: Pool,
  contentArea: string,
  subKey: string,
): Promise<ForbiddenPhrase[]> {
  const result = await query<{
    id: string;
    content_area: string;
    sub_key: string;
    phrase_key: string;
    phrase_text: string;
  }>(pool, `SELECT * FROM forbidden_phrases WHERE content_area = $1 AND sub_key = $2`, [
    contentArea,
    subKey,
  ]);
  return result.rows.map((r) => ({
    id: r.id,
    contentArea: r.content_area,
    subKey: r.sub_key,
    phraseKey: r.phrase_key,
    phraseText: r.phrase_text,
  }));
}

/**
 * Seed Phase 15 managed-content defaults. Idempotent via ON CONFLICT DO NOTHING.
 * Call after seedReferenceData for tests; mirrors what the Phase 15 migration does
 * for production deployments.
 */
export async function seedManagedContentDefaults(
  pool: Pool,
  editionId: string,
  systemUserId: string,
): Promise<void> {
  const clauses: Array<[string, string, string, string]> = [
    ['privacy_notice', '', 'data_separation', 'kept separate from your answers'],
    ['invitation_landing', '', 'independence', 'independent'],
    ['participant_templates', 'Retail survey invitation', 'survey_link', '{{survey_link}}'],
    ['participant_templates', 'Retail survey reminder', 'survey_link', '{{survey_link}}'],
  ];
  for (const [area, sk, key, text] of clauses) {
    await query(
      pool,
      `INSERT INTO required_clauses (content_area, sub_key, clause_key, clause_text)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (content_area, sub_key, clause_key) DO NOTHING`,
      [area, sk, key, text],
    );
  }

  const participantTemplates: Array<{ name: string; subject: string; body: string }> = [
    {
      name: 'Retail survey invitation',
      subject: 'You have been invited to complete a brief survey',
      body: 'Dear participant,\n\nYou have been selected to complete a brief survey as part of the 2026 benchmark study. Please follow the link to complete your survey: {{survey_link}}\n\nThank you.',
    },
    {
      name: 'Retail survey reminder',
      subject: 'Reminder: your survey is still outstanding',
      body: 'Dear participant,\n\nThis is a reminder that your survey is still outstanding. Please follow the link to complete your survey: {{survey_link}}\n\nThank you.',
    },
  ];
  for (const t of participantTemplates) {
    await query(
      pool,
      `INSERT INTO message_templates (edition_id, name, subject, body, audience_kind, requires_code, created_by)
       VALUES ($1, $2, $3, $4, 'participant', FALSE, $5)
       ON CONFLICT DO NOTHING`,
      [editionId, t.name, t.subject, t.body, systemUserId],
    );
  }

  const landingBody =
    'The Nigerian Capital Market Brokerage Benchmark is an independent read on service quality ' +
    'across the industry. Your responses are kept confidential and contribute to an independent ' +
    'study published by the Capital Markets Authority.';

  const existing = await query<{ id: string }>(
    pool,
    `SELECT id FROM content_versions WHERE content_area = 'invitation_landing' AND sub_key = '' LIMIT 1`,
  );
  if (existing.rows.length === 0) {
    const versionRes = await query<{ id: string }>(
      pool,
      `INSERT INTO content_versions (content_area, sub_key, body, version_number, created_by)
       VALUES ('invitation_landing', '', $1, 1, $2)
       RETURNING id`,
      [landingBody, systemUserId],
    );
    const versionId = versionRes.rows[0]?.id;
    if (versionId) {
      await query(
        pool,
        `INSERT INTO content_live (content_area, sub_key, version_id, published_by)
         VALUES ('invitation_landing', '', $1, $2)
         ON CONFLICT (content_area, sub_key) DO NOTHING`,
        [versionId, systemUserId],
      );
    }
  }

  // reminder_content (Phase 17): seeded by the production migration, but that
  // seed lives in content_live/content_versions — tables truncateAllTables()
  // wipes between tests. Re-seed the same seven sub-keys here so any test
  // that truncates and calls seedReferenceData (which calls this function)
  // still finds live reminder content, exactly like invitation_landing above.
  const reminderSubKeys: Array<{ subKey: string; body: string }> = [
    {
      subKey: 'first_message_email',
      body: JSON.stringify({
        subject: 'Your survey is still open',
        body: 'You started the investor survey and did not finish. That is completely fine — your answers are saved and nothing has been lost.',
        cta: 'Continue my survey',
      }),
    },
    {
      subKey: 'first_message_text',
      body: 'Your investor survey answers are saved. Pick up where you stopped:\n{{recovery_url}}',
    },
    {
      subKey: 'reminder_email',
      body: JSON.stringify({
        subject: 'Your survey is still open',
        body: 'Your investor survey is still waiting, and your answers are still saved. {{progress_wording}}',
        cta: 'Continue my survey',
        stop_link_text: 'Stop these reminders',
      }),
    },
    {
      // {{stop_line}} is filled in by assembleReminderText — empty on a
      // respondent's first reminder, "Reply STOP to stop reminders." on every
      // one after it (DEC-012). Never hardcode STOP into this body.
      subKey: 'reminder_text',
      body: 'Your investor survey is still waiting. Answers saved.\n{{recovery_url}}{{stop_line}}',
    },
    {
      subKey: 'reminders_stopped',
      body: JSON.stringify({
        heading: 'We will not remind you again.',
        body: 'Stopping reminders does not withdraw you from the study and does not delete anything. You can still return and complete your survey whenever you like.',
        study_home_cta: 'Return to the survey home',
        recovery_link_cta: 'Return using your original link',
      }),
    },
    {
      subKey: 'already_submitted',
      body: JSON.stringify({
        heading: 'You have already finished this one.',
        body: 'This reminder was sent before your response came in. Nothing further is needed. Your response is in and reminders have stopped.',
      }),
    },
    {
      subKey: 'link_tapped',
      body: JSON.stringify({ heading: 'Continuing…', body: 'Straight back to where you stopped.' }),
    },
  ];
  for (const { subKey, body } of reminderSubKeys) {
    const existingReminder = await query<{ id: string }>(
      pool,
      `SELECT id FROM content_versions WHERE content_area = 'reminder_content' AND sub_key = $1 LIMIT 1`,
      [subKey],
    );
    if (existingReminder.rows.length > 0) continue;
    const versionRes = await query<{ id: string }>(
      pool,
      `INSERT INTO content_versions (content_area, sub_key, body, version_number, created_by)
       VALUES ('reminder_content', $1, $2, 1, $3)
       RETURNING id`,
      [subKey, body, systemUserId],
    );
    const versionId = versionRes.rows[0]?.id;
    if (versionId) {
      await query(
        pool,
        `INSERT INTO content_live (content_area, sub_key, version_id, published_by)
         VALUES ('reminder_content', $1, $2, $3)
         ON CONFLICT (content_area, sub_key) DO NOTHING`,
        [subKey, versionId, systemUserId],
      );
    }
  }
}
