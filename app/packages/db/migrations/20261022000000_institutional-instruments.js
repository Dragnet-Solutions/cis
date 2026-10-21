'use strict';

/**
 * Institutional instruments I-LCFE, I-NASD and I-FMDQ (client decision,
 * October 2026: "Institutional Instruments for Three New Market Institutions",
 * Dragnet Solutions Limited, September 2026).
 *
 * Additive and idempotent. Never rewrites an existing row's content:
 *
 *  1. Schema: `institution_roles.instrument_code` / `.mandate` (a role may
 *     answer its own bespoke instrument instead of its family's shared one,
 *     and carry its own one-line vantage), and `instrument_questions.scope_gate`
 *     (the Register's item-level scope gate, e.g. Q0 closing on "Rare" /
 *     "Effectively none"). All nullable; NULL keeps today's behaviour.
 *  2. Market Institutions Register: registers Lagos Commodities and Futures
 *     Exchange and NASD OTC Securities Exchange (rows seeded inactive by
 *     Phase 19 — "under CIS review" — are switched on, exactly the data change
 *     that phase anticipated), adds FMDQ Group as ONE entity with one
 *     instrument for this edition (the three FMDQ subsidiary rows are left as
 *     they are: inactive), and points each of the three Family B roles at its
 *     own instrument.
 *  3. Survey Register: on a database whose Register has already been seeded
 *     (I-SEC exists), inserts the three instruments — definition, version 1,
 *     and six items each — from the frozen copy below. A fresh database is
 *     left alone here: `seedReferenceData` loads the full Register (these
 *     three included) from packages/db/src/seed/survey-register-seed.json.
 *     The copy below must equal that file's entries; the integration test
 *     `institutional-instruments.test.ts` fails on any drift.
 *  4. Engagement: one not-started engagement row per new role in every draft
 *     or open edition, so the three appear on the Market Institutions screen
 *     like the existing roles (contacts, links, reminders, tracking).
 *  5. Instrument assignment (UX-OPS-007 v2.10: one registered institution maps
 *     to one bespoke instrument, read from the register): the existing roles'
 *     instruments, previously implied by their family, are written onto the
 *     still-empty `instrument_code` column (SEC → I-SEC, NGX → I-NGX, CSCS
 *     clearing → I-CSCS, CSCS depository → I-DEP). A role with no instrument
 *     shows "Questionnaire not assigned" and cannot be sent a link.
 *  6. `respondents.revoked_recovery_token`: a link replaced by "cancel and
 *     start again" is remembered, so opening it says it no longer works
 *     (UX-INS-003 link_invalidated) rather than "not found".
 *
 * Instruments added to an edition whose instrument set is ALREADY frozen are
 * not frozen by this migration — freezing is a maker-checker action and is
 * never taken on anyone's behalf.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */

const SOURCE_LABEL =
  'Survey Register supplement (CIS_Dragnet_Institutional_Instruments_LCFE_NASD_FMDQ_for_CIS_Review.pdf, 2026-09)';

const INSTRUMENTS = [
  {
    code: 'I-LCFE',
    meta: {
      name: 'Lagos Commodities and Futures Exchange',
      respondent: 'Lagos Commodities and Futures Exchange',
      feeds: 'Contextual only',
      scored: false,
      instrument_type: 'regulator',
      strap: 'Commodities and derivatives view',
      audience:
        'senior staff who deal directly with stockbroking firms trading or clearing on the Exchange',
      length: 'about 8 minutes',
      source: 'CIS_Dragnet_Institutional_Instruments_LCFE_NASD_FMDQ_for_CIS_Review.pdf',
      item_notes: {
        'I-LCFE-Q0': 'Gate applies. See Scope gate rule below.',
      },
      role: {
        institution: 'Lagos Commodities and Futures Exchange',
        family_code: 'B',
      },
    },
    items: [
      {
        question_id: 'I-LCFE-Q0',
        kind: 'single',
        text: 'How much direct operational dealing does the Exchange have with licensed stockbroking firms?',
        scope: 'shared',
        is_drg_ops: false,
        scored: false,
        options: ['Regular and substantial', 'Occasional', 'Rare', 'Effectively none'],
        scope_gate: {
          close_on: ['Rare', 'Effectively none'],
          decision:
            "Controlled decision (CIS sign-off, 21 October 2026): the Q0 scope gate in CIS_Dragnet_Institutional_Instruments_LCFE_NASD_FMDQ_for_CIS_Review.pdf, 'Scope gate rule'. If Q0 is answered Rare or Effectively none, the instrument closes on a neutral thank-you, no further items are presented, no attributed Section 10 passage is generated, and the institution is recorded as responded and listed among contributors. Expressly supersedes SV-010 section 4a (no branching in the Register) for the instruments that carry Q0.",
        },
      },
      {
        question_id: 'I-LCFE-Q1',
        kind: 'select',
        text: 'Which firm-level operational issues most frequently disrupt participation in commodities and derivatives markets?',
        scope: 'shared',
        is_drg_ops: false,
        scored: false,
        options: [
          'Margin and collateral management',
          'Contract specification and order errors',
          'Settlement and delivery coordination',
          'Documentation and onboarding',
          'Manual processes',
          'System and technology integration',
          'Communication delays',
          'Client suitability and risk disclosure',
          'Staff competence in derivatives',
          'Other',
        ],
        select_up_to_n: 3,
        has_optional_comment: 1,
        select_then_greatest: 1,
      },
      {
        question_id: 'I-LCFE-Q2',
        kind: 'single',
        text: 'How frequently do firm-level operational weaknesses create exceptions the Exchange must manage?',
        scope: 'shared',
        is_drg_ops: false,
        scored: false,
        options: ['Very frequently', 'Frequently', 'Occasionally', 'Rarely', 'Never'],
        has_optional_comment: 1,
      },
      {
        question_id: 'I-LCFE-Q3',
        kind: 'select',
        text: 'Which characteristics consistently distinguish firms that participate most effectively in these markets?',
        scope: 'shared',
        is_drg_ops: false,
        scored: false,
        options: [
          'Margin and collateral discipline',
          'Product and contract understanding',
          'Technology and system integration',
          'Operational discipline',
          'Documentation quality',
          'Timeliness',
          'Communication',
          'Risk management',
          'Staff competence',
          'Other',
        ],
        select_up_to_n: 3,
        has_optional_comment: 1,
      },
      {
        question_id: 'I-LCFE-Q4',
        kind: 'select',
        text: 'Which firm-level operational weaknesses carry the greatest consequences for market integrity here?',
        scope: 'shared',
        is_drg_ops: false,
        scored: false,
        options: [
          'Margin and collateral management',
          'Contract specification and order errors',
          'Settlement and delivery coordination',
          'Documentation and onboarding',
          'Manual processes',
          'System and technology integration',
          'Communication delays',
          'Client suitability and risk disclosure',
          'Staff competence in derivatives',
          'Other',
        ],
        select_up_to_n: 3,
        has_optional_comment: 1,
        select_then_greatest: 1,
      },
      {
        question_id: 'I-LCFE-Q5',
        kind: 'single',
        text: "Based on the Exchange's direct interactions with participating stockbroking firms, how would you assess the overall operational capability of the sector today?",
        scope: 'shared',
        is_drg_ops: false,
        scored: false,
        options: ['Very weak', 'Weak', 'Adequate', 'Strong', 'Very strong'],
        has_optional_comment: 1,
      },
    ],
  },
  {
    code: 'I-NASD',
    meta: {
      name: 'NASD OTC Securities Exchange',
      respondent: 'NASD OTC Securities Exchange',
      feeds: 'Contextual only',
      scored: false,
      instrument_type: 'regulator',
      strap: 'OTC market view',
      audience:
        'senior staff who deal directly with participating institutions in OTC trading and settlement',
      length: 'about 8 minutes',
      source: 'CIS_Dragnet_Institutional_Instruments_LCFE_NASD_FMDQ_for_CIS_Review.pdf',
      role: {
        institution: 'NASD OTC Securities Exchange',
        family_code: 'B',
      },
    },
    items: [
      {
        question_id: 'I-NASD-Q0',
        kind: 'single',
        text: 'How much direct operational dealing does NASD have with licensed stockbroking firms?',
        scope: 'shared',
        is_drg_ops: false,
        scored: false,
        options: ['Regular and substantial', 'Occasional', 'Rare', 'Effectively none'],
        scope_gate: {
          close_on: ['Rare', 'Effectively none'],
          decision:
            "Controlled decision (CIS sign-off, 21 October 2026): the Q0 scope gate in CIS_Dragnet_Institutional_Instruments_LCFE_NASD_FMDQ_for_CIS_Review.pdf, 'Scope gate rule'. If Q0 is answered Rare or Effectively none, the instrument closes on a neutral thank-you, no further items are presented, no attributed Section 10 passage is generated, and the institution is recorded as responded and listed among contributors. Expressly supersedes SV-010 section 4a (no branching in the Register) for the instruments that carry Q0.",
        },
      },
      {
        question_id: 'I-NASD-Q1',
        kind: 'select',
        text: 'Which firm-level operational issues most frequently affect OTC trading and settlement?',
        scope: 'shared',
        is_drg_ops: false,
        scored: false,
        options: [
          'Trade reporting accuracy and timeliness',
          'Price discovery and quotation discipline',
          'Settlement coordination',
          'Documentation and record keeping',
          'Unlisted-security transfer processing',
          'Manual processes',
          'System and technology integration',
          'Communication delays',
          'Staff competence',
          'Other',
        ],
        select_up_to_n: 3,
        has_optional_comment: 1,
        select_then_greatest: 1,
      },
      {
        question_id: 'I-NASD-Q2',
        kind: 'single',
        text: 'How frequently do firm-level operational weaknesses create exceptions NASD must manage?',
        scope: 'shared',
        is_drg_ops: false,
        scored: false,
        options: ['Very frequently', 'Frequently', 'Occasionally', 'Rarely', 'Never'],
        has_optional_comment: 1,
      },
      {
        question_id: 'I-NASD-Q3',
        kind: 'select',
        text: 'Which characteristics consistently distinguish firms that operate most effectively in the OTC market?',
        scope: 'shared',
        is_drg_ops: false,
        scored: false,
        options: [
          'Trade-reporting discipline',
          'Documentation quality',
          'Settlement reliability',
          'Technology and systems',
          'Operational discipline',
          'Communication',
          'Client servicing',
          'Corporate governance',
          'Staff competence',
          'Other',
        ],
        select_up_to_n: 3,
        has_optional_comment: 1,
      },
      {
        question_id: 'I-NASD-Q4',
        kind: 'select',
        text: 'Which firm-level operational weaknesses carry the greatest consequences for OTC market efficiency?',
        scope: 'shared',
        is_drg_ops: false,
        scored: false,
        options: [
          'Trade reporting accuracy and timeliness',
          'Price discovery and quotation discipline',
          'Settlement coordination',
          'Documentation and record keeping',
          'Unlisted-security transfer processing',
          'Manual processes',
          'System and technology integration',
          'Communication delays',
          'Staff competence',
          'Other',
        ],
        select_up_to_n: 3,
        has_optional_comment: 1,
        select_then_greatest: 1,
      },
      {
        question_id: 'I-NASD-Q5',
        kind: 'single',
        text: "Based on NASD's direct interactions with participating firms, how would you assess the overall operational capability of the sector today?",
        scope: 'shared',
        is_drg_ops: false,
        scored: false,
        options: ['Very weak', 'Weak', 'Adequate', 'Strong', 'Very strong'],
        has_optional_comment: 1,
      },
    ],
  },
  {
    code: 'I-FMDQ',
    meta: {
      name: 'FMDQ Group',
      respondent: 'FMDQ Group',
      feeds: 'Contextual only',
      scored: false,
      instrument_type: 'regulator',
      strap: 'Fixed income, currencies and post-trade view',
      audience:
        "senior staff who deal directly with stockbroking firms across FMDQ's exchange, clearing and depository functions",
      length: 'about 8 minutes',
      source: 'CIS_Dragnet_Institutional_Instruments_LCFE_NASD_FMDQ_for_CIS_Review.pdf',
      registration_note:
        'For v1 the rule is simply applied: one registered FMDQ entity, one bespoke instrument, one attributed passage. If FMDQ later registers as three separate entities, three instruments are created at that point under the same rule. Nothing waits on that.',
      role: {
        institution: 'FMDQ Group',
        family_code: 'B',
      },
    },
    items: [
      {
        question_id: 'I-FMDQ-Q0',
        kind: 'single',
        text: 'How much direct operational dealing does FMDQ have with licensed stockbroking firms?',
        scope: 'shared',
        is_drg_ops: false,
        scored: false,
        options: ['Regular and substantial', 'Occasional', 'Rare', 'Effectively none'],
        scope_gate: {
          close_on: ['Rare', 'Effectively none'],
          decision:
            "Controlled decision (CIS sign-off, 21 October 2026): the Q0 scope gate in CIS_Dragnet_Institutional_Instruments_LCFE_NASD_FMDQ_for_CIS_Review.pdf, 'Scope gate rule'. If Q0 is answered Rare or Effectively none, the instrument closes on a neutral thank-you, no further items are presented, no attributed Section 10 passage is generated, and the institution is recorded as responded and listed among contributors. Expressly supersedes SV-010 section 4a (no branching in the Register) for the instruments that carry Q0.",
        },
      },
      {
        question_id: 'I-FMDQ-Q1',
        kind: 'select',
        text: "Which firm-level operational issues most frequently affect firms' participation across FMDQ's markets and post-trade services?",
        scope: 'shared',
        is_drg_ops: false,
        scored: false,
        options: [
          'Trade reporting and confirmation',
          'Settlement coordination',
          'Collateral and margin management',
          'Account and record accuracy',
          'Corporate-actions and asset-servicing processing',
          'Documentation and onboarding',
          'Manual processes',
          'System and technology integration',
          'Staff competence in fixed income and currencies',
          'Other',
        ],
        select_up_to_n: 3,
        has_optional_comment: 1,
        select_then_greatest: 1,
      },
      {
        question_id: 'I-FMDQ-Q2',
        kind: 'single',
        text: 'How frequently do firm-level operational weaknesses create exceptions FMDQ must manage?',
        scope: 'shared',
        is_drg_ops: false,
        scored: false,
        options: ['Very frequently', 'Frequently', 'Occasionally', 'Rarely', 'Never'],
        has_optional_comment: 1,
      },
      {
        question_id: 'I-FMDQ-Q3',
        kind: 'select',
        text: "Which characteristics consistently distinguish firms that operate most effectively across FMDQ's markets and services?",
        scope: 'shared',
        is_drg_ops: false,
        scored: false,
        options: [
          'Trade and settlement accuracy',
          'Reconciliation discipline',
          'Collateral management',
          'Technology and system integration',
          'Documentation quality',
          'Operational controls',
          'Communication',
          'Corporate governance',
          'Staff competence',
          'Other',
        ],
        select_up_to_n: 3,
        has_optional_comment: 1,
      },
      {
        question_id: 'I-FMDQ-Q4',
        kind: 'select',
        text: 'Which firm-level operational weaknesses carry the greatest consequences for market and post-trade integrity?',
        scope: 'shared',
        is_drg_ops: false,
        scored: false,
        options: [
          'Trade reporting and confirmation',
          'Settlement coordination',
          'Collateral and margin management',
          'Account and record accuracy',
          'Corporate-actions and asset-servicing processing',
          'Documentation and onboarding',
          'Manual processes',
          'System and technology integration',
          'Staff competence in fixed income and currencies',
          'Other',
        ],
        select_up_to_n: 3,
        has_optional_comment: 1,
        select_then_greatest: 1,
      },
      {
        question_id: 'I-FMDQ-Q5',
        kind: 'single',
        text: "Based on FMDQ's direct interactions with participating stockbroking firms, how would you assess the overall operational capability of the sector today?",
        scope: 'shared',
        is_drg_ops: false,
        scored: false,
        options: ['Very weak', 'Weak', 'Adequate', 'Strong', 'Very strong'],
        has_optional_comment: 1,
      },
    ],
  },
];

/** The instruments the original roles already answered, now explicit. */
const EXISTING_ASSIGNMENTS = [
  ['Securities and Exchange Commission', 'A', 'I-SEC'],
  ['Nigerian Exchange Limited', 'B', 'I-NGX'],
  ['Central Securities Clearing System', 'C', 'I-CSCS'],
  ['Central Securities Clearing System', 'D', 'I-DEP'],
];

const NEW_INSTITUTIONS = [
  'Lagos Commodities and Futures Exchange',
  'NASD OTC Securities Exchange',
  'FMDQ Group',
];

/** SQL string literal (standard_conforming_strings is on). */
function lit(v) {
  if (v === null || v === undefined) return 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}
function jsonLit(v) {
  return v === null || v === undefined ? 'NULL' : `${lit(JSON.stringify(v))}::jsonb`;
}

exports.up = async (pgm) => {
  // ── 1. Schema ─────────────────────────────────────────────────────────────
  pgm.sql(`
    ALTER TABLE institution_roles
      ADD COLUMN IF NOT EXISTS instrument_code TEXT,
      ADD COLUMN IF NOT EXISTS mandate TEXT
  `);
  pgm.sql(`ALTER TABLE instrument_questions ADD COLUMN IF NOT EXISTS scope_gate JSONB`);
  pgm.sql(`ALTER TABLE respondents ADD COLUMN IF NOT EXISTS revoked_recovery_token TEXT`);
  pgm.sql(
    `CREATE INDEX IF NOT EXISTS idx_respondents_revoked_token ON respondents (revoked_recovery_token)`,
  );

  // ── 2. Market Institutions Register ─────────────────────────────────────────
  pgm.sql(`
    INSERT INTO institutions (name, is_active)
    VALUES ${NEW_INSTITUTIONS.map((n) => `(${lit(n)}, TRUE)`).join(', ')}
    ON CONFLICT (name) DO NOTHING
  `);
  pgm.sql(`
    UPDATE institutions SET is_active = TRUE
     WHERE name IN (${NEW_INSTITUTIONS.map(lit).join(', ')}) AND is_active = FALSE
  `);
  for (const inst of INSTRUMENTS) {
    const role = inst.meta.role;
    pgm.sql(`
      INSERT INTO institution_roles (institution_id, family_code)
      SELECT id, ${lit(role.family_code)} FROM institutions WHERE name = ${lit(role.institution)}
      ON CONFLICT (institution_id, family_code) DO NOTHING
    `);
    pgm.sql(`
      UPDATE institution_roles r
         SET instrument_code = ${lit(inst.code)}, mandate = COALESCE(r.mandate, ${lit(inst.meta.strap)})
        FROM institutions i
       WHERE i.id = r.institution_id AND i.name = ${lit(role.institution)}
         AND r.family_code = ${lit(role.family_code)} AND r.instrument_code IS NULL
    `);
  }

  // Existing roles: their instrument was implied by their family; make it the
  // explicit register assignment (fills a column added above; NULLs only).
  for (const [institution, family, code] of EXISTING_ASSIGNMENTS) {
    pgm.sql(`
      UPDATE institution_roles r
         SET instrument_code = ${lit(code)}
        FROM institutions i
       WHERE i.id = r.institution_id AND i.name = ${lit(institution)}
         AND r.family_code = ${lit(family)} AND r.instrument_code IS NULL
    `);
  }

  // ── 3. Survey Register (only where the Register is already seeded) ──────────
  for (const inst of INSTRUMENTS) {
    const m = inst.meta;
    pgm.sql(`
      INSERT INTO instrument_definitions (code, name, instrument_type, scored)
      SELECT ${lit(inst.code)}, ${lit(m.name)}, ${lit(m.instrument_type)}, ${m.scored ? 'TRUE' : 'FALSE'}
       WHERE EXISTS (SELECT 1 FROM instrument_definitions WHERE code = 'I-SEC')
      ON CONFLICT (code) DO NOTHING
    `);
    const { name, respondent, feeds, scored, instrument_type, role, ...details } = m;
    const snapshot = {
      respondent,
      feeds,
      questionCount: inst.items.length,
      placeholder: false,
      registerPayloadSource: 'interim_seed',
      registerPayloadSchemaVersion: '1.0',
      source: SOURCE_LABEL,
      details,
    };
    pgm.sql(`
      INSERT INTO instrument_definition_versions
        (instrument_definition_id, version_number, schema_snapshot)
      SELECT id, 1, ${jsonLit(snapshot)} FROM instrument_definitions WHERE code = ${lit(inst.code)}
      ON CONFLICT (instrument_definition_id, version_number) DO NOTHING
    `);
    inst.items.forEach((q, i) => {
      pgm.sql(`
        INSERT INTO instrument_questions
          (instrument_definition_id, question_code, prompt_text, kind, scope, display_order,
           scored, is_drg_ops, is_placeholder, options, select_up_to_n, has_optional_comment,
           select_then_greatest, scope_gate)
        SELECT id, ${lit(q.question_id)}, ${lit(q.text)}, ${lit(q.kind)}, ${lit(q.scope)}, ${i + 1},
               ${q.scored ? 'TRUE' : 'FALSE'}, ${q.is_drg_ops ? 'TRUE' : 'FALSE'}, FALSE,
               ${jsonLit(q.options)}, ${q.select_up_to_n ?? 'NULL'},
               ${q.has_optional_comment === 1 ? 'TRUE' : 'FALSE'},
               ${q.select_then_greatest === 1 ? 'TRUE' : 'FALSE'},
               ${jsonLit(q.scope_gate ? { closeOn: q.scope_gate.close_on, decision: q.scope_gate.decision } : null)}
          FROM instrument_definitions WHERE code = ${lit(inst.code)}
        ON CONFLICT (question_code) DO NOTHING
      `);
    });
  }

  // ── 4. Engagement rows for live editions ───────────────────────────────────
  pgm.sql(`
    INSERT INTO institution_engagement (edition_id, institution_id, family_code)
    SELECT e.id, r.institution_id, r.family_code
      FROM editions e
     CROSS JOIN institution_roles r
      JOIN institutions i ON i.id = r.institution_id
     WHERE e.status IN ('draft', 'open')
       AND i.is_active = TRUE
       AND i.name IN (${NEW_INSTITUTIONS.map(lit).join(', ')})
    ON CONFLICT (edition_id, institution_id, family_code) DO NOTHING
  `);
};

/**
 * Reverses only what is still untouched: engagement rows nobody has worked on,
 * and instrument content no respondent and no frozen edition refers to. The
 * institutions stay registered (rows are never deleted); the two Phase 19
 * rows go back to inactive.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = async (pgm) => {
  const names = NEW_INSTITUTIONS.map(lit).join(', ');
  const codes = INSTRUMENTS.map((i) => lit(i.code)).join(', ');
  pgm.sql(`
    DELETE FROM institution_engagement e
     USING institutions i
     WHERE i.id = e.institution_id AND i.name IN (${names})
       AND e.status = 'not_started' AND e.contact_who IS NULL AND e.respondent_id IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM regulator_engagement_history h
          WHERE h.edition_id = e.edition_id AND h.institution_id = e.institution_id
            AND h.family_code = e.family_code)
  `);
  pgm.sql(`
    DELETE FROM instrument_questions q
     USING instrument_definitions d
     WHERE d.id = q.instrument_definition_id AND d.code IN (${codes})
       AND NOT EXISTS (SELECT 1 FROM respondents r WHERE r.instrument_code = d.code)
       AND NOT EXISTS (
         SELECT 1 FROM edition_instrument_snapshots s
           JOIN instrument_definition_versions v ON v.id = s.instrument_definition_version_id
          WHERE v.instrument_definition_id = d.id)
  `);
  pgm.sql(`
    DELETE FROM instrument_definition_versions v
     USING instrument_definitions d
     WHERE d.id = v.instrument_definition_id AND d.code IN (${codes})
       AND NOT EXISTS (SELECT 1 FROM instrument_questions q WHERE q.instrument_definition_id = d.id)
       AND NOT EXISTS (
         SELECT 1 FROM edition_instrument_snapshots s WHERE s.instrument_definition_version_id = v.id)
  `);
  pgm.sql(`
    DELETE FROM instrument_definitions d
     WHERE d.code IN (${codes})
       AND NOT EXISTS (SELECT 1 FROM instrument_definition_versions v WHERE v.instrument_definition_id = d.id)
  `);
  pgm.sql(`
    UPDATE institutions SET is_active = FALSE
     WHERE name IN ('Lagos Commodities and Futures Exchange', 'NASD OTC Securities Exchange')
       AND NOT EXISTS (SELECT 1 FROM institution_engagement e WHERE e.institution_id = institutions.id)
  `);
  pgm.sql(`ALTER TABLE instrument_questions DROP COLUMN IF EXISTS scope_gate`);
  pgm.sql(`DROP INDEX IF EXISTS idx_respondents_revoked_token`);
  pgm.sql(`ALTER TABLE respondents DROP COLUMN IF EXISTS revoked_recovery_token`);
  pgm.sql(`
    ALTER TABLE institution_roles
      DROP COLUMN IF EXISTS instrument_code,
      DROP COLUMN IF EXISTS mandate
  `);
};
