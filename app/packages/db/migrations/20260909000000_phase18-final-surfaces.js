'use strict';

/**
 * Phase 18 — final planned surfaces: investor categories, firm digest,
 * previous editions, help/privacy/about, shared error states + withdrawal.
 *
 * Schema:
 *   organizations.investor_categories_served — a firm's own multi-select
 *     declaration (retail / local institutional / foreign institutional /
 *     not sure). Provably inert: no scoring, eligibility or evidence-pack
 *     query anywhere reads this column. Editable at any time, no gate.
 *
 *   respondents.withdrawn_at — a genuine withdrawal concept, distinct from
 *     Phase 17's reminders_opted_out (which is explicitly NOT withdrawal).
 *     NULL = not withdrawn. Setting it blocks continuing the response and
 *     surfaces the shared "Participation closed or withdrawn" error state.
 *     This is the flag + check only — no self-service withdrawal request
 *     flow is built here (see README §Phase 18 for the scope boundary).
 *
 *   forbidden_phrases — the inverse of required_clauses: phrases that must
 *     NOT appear in a content area's body. Seeded for privacy_notice so an
 *     absolute-anonymity claim ("completely anonymous", "no record is kept")
 *     can never be saved, because a respondent's session can in fact be
 *     linked server-side to their response for recovery/immutability.
 *
 *   governed_config['firm_digest.schedule'] — digest frequency/channel are
 *     implementation configuration per the artefact, not a design decision.
 */

const FORBIDDEN_PHRASES = [
  ['absolute_anon_1', 'completely anonymous'],
  ['absolute_anon_2', 'fully anonymous'],
  ['absolute_anon_3', 'totally anonymous'],
  ['absolute_anon_4', '100% anonymous'],
  ['no_record_kept', 'no record is kept'],
];

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = async (pgm) => {
  // ── UX-FRM-002: investor categories served (inert declaration) ──────────────
  pgm.sql(`
    ALTER TABLE organizations
      ADD COLUMN investor_categories_served TEXT[] NOT NULL DEFAULT '{}'
      CONSTRAINT organizations_investor_categories_valid CHECK (
        investor_categories_served <@ ARRAY['retail','local_institutional','foreign_institutional','not_sure']::text[]
      )
  `);

  // ── UX-X-001: genuine withdrawal, distinct from Phase 17's reminders_opted_out ──
  pgm.sql(`
    ALTER TABLE respondents
      ADD COLUMN withdrawn_at TIMESTAMPTZ
  `);

  // ── UX-X-002: forbidden-phrase check (inverse of required_clauses) ──────────
  pgm.createTable('forbidden_phrases', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    content_area: { type: 'text', notNull: true },
    sub_key: { type: 'text', notNull: true, default: "''" },
    phrase_key: { type: 'text', notNull: true },
    phrase_text: { type: 'text', notNull: true },
  });
  pgm.addConstraint(
    'forbidden_phrases',
    'forbidden_phrases_area_subkey_phrasekey',
    'UNIQUE (content_area, sub_key, phrase_key)',
  );
  for (const [phraseKey, phraseText] of FORBIDDEN_PHRASES) {
    pgm.sql(
      `INSERT INTO forbidden_phrases (content_area, sub_key, phrase_key, phrase_text)
       VALUES ('privacy_notice', '', '${phraseKey}', '${phraseText.replace(/'/g, "''")}')
       ON CONFLICT (content_area, sub_key, phrase_key) DO NOTHING`,
    );
  }

  // ── UX-FRM-DIG-001: digest frequency/channel are governed config ────────────
  pgm.sql(`
    INSERT INTO governed_config (key, value, description)
    VALUES (
      'firm_digest.schedule',
      '{"frequency":"monthly","channel":"email"}',
      'Firm digest push frequency and delivery channel — implementation configuration, not specified by the design.'
    )
    ON CONFLICT (key) DO NOTHING
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = async (pgm) => {
  pgm.sql(`DELETE FROM governed_config WHERE key = 'firm_digest.schedule'`);
  pgm.dropTable('forbidden_phrases');
  pgm.sql(`ALTER TABLE respondents DROP COLUMN withdrawn_at`);
  pgm.sql(`ALTER TABLE organizations DROP COLUMN investor_categories_served`);
};
