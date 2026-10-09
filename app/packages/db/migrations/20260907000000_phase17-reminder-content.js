'use strict';

/**
 * Phase 17 — UX-RET-007 v2.3 Reminder & Recovery Message Content.
 *
 * Schema:
 *   respondents.reminders_opted_out — structurally separate from consent/participation.
 *   Tapping STOP sets this flag; it never changes submitted_at, consent_accepted, or
 *   any other participation-status field. A stopped respondent remains fully eligible
 *   to return and complete their response.
 *
 * Content:
 *   Seeds the reminder_content area into content_versions + content_live with seven
 *   sub-keys. These are editable via Phase 15's managed-content admin surface.
 *   No WhatsApp variants — superseded by text/SMS platform-wide (DEC-010).
 */

const SUB_KEYS = [
  {
    sub_key: 'first_message_email',
    body: JSON.stringify({
      subject: 'Your survey is still open',
      body: 'You started the investor survey and did not finish. That is completely fine — your answers are saved and nothing has been lost.',
      cta: 'Continue my survey',
    }),
  },
  {
    sub_key: 'first_message_text',
    // No STOP. URL on its own line. Fixed text + 70-char URL ≤ 160.
    body: 'Your investor survey answers are saved. Pick up where you stopped:\n{{recovery_url}}',
  },
  {
    sub_key: 'reminder_email',
    body: JSON.stringify({
      subject: 'Your survey is still open',
      body: 'Your investor survey is still waiting, and your answers are still saved. {{progress_wording}}',
      cta: 'Continue my survey',
      stop_link_text: 'Stop these reminders',
    }),
  },
  {
    sub_key: 'reminder_text',
    // {{stop_line}} is filled in by assembleReminderText: empty on a
    // respondent's first reminder, "Reply STOP to stop reminders." on every
    // one after it (DEC-012). Fixed text + 70-char URL ≤ 160 either way.
    body: 'Your investor survey is still waiting. Answers saved.\n{{recovery_url}}{{stop_line}}',
  },
  {
    sub_key: 'reminders_stopped',
    body: JSON.stringify({
      heading: 'We will not remind you again.',
      body: 'Stopping reminders does not withdraw you from the study and does not delete anything. You can still return and complete your survey whenever you like.',
      study_home_cta: 'Return to the survey home',
      recovery_link_cta: 'Return using your original link',
    }),
  },
  {
    sub_key: 'already_submitted',
    body: JSON.stringify({
      heading: 'You have already finished this one.',
      body: 'This reminder was sent before your response came in. Nothing further is needed. Your response is in and reminders have stopped.',
    }),
  },
  {
    sub_key: 'link_tapped',
    body: JSON.stringify({
      heading: 'Continuing…',
      body: 'Straight back to where you stopped.',
    }),
  },
];

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = async (pgm) => {
  // ── reminders_opted_out: structurally separate from consent/participation ─────
  pgm.sql(`
    ALTER TABLE respondents
      ADD COLUMN reminders_opted_out BOOLEAN NOT NULL DEFAULT FALSE
  `);

  // ── reminder_content area: seven sub-keys, seeded as initial live versions ────
  for (const { sub_key, body } of SUB_KEYS) {
    pgm.sql(`
      WITH v AS (
        INSERT INTO content_versions (content_area, sub_key, body, version_number)
        VALUES ('reminder_content', '${sub_key}', '${body.replace(/'/g, "''")}', 1)
        RETURNING id
      )
      INSERT INTO content_live (content_area, sub_key, version_id)
      SELECT 'reminder_content', '${sub_key}', id FROM v
    `);
  }
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = async (pgm) => {
  pgm.sql(`
    DELETE FROM content_live WHERE content_area = 'reminder_content'
  `);
  pgm.sql(`
    DELETE FROM content_versions WHERE content_area = 'reminder_content'
  `);
  pgm.sql(`
    ALTER TABLE respondents DROP COLUMN reminders_opted_out
  `);
};
