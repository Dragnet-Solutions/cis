'use strict';

/**
 * Phase 19 — Institutional Instrument Families & Closed Engineering Decisions.
 *
 * Re-architects the three hardcoded institutions (SEC/NGX/CSCS) into a
 * genuinely reusable model, per the controlled
 * `CIS_Institutional_Instrument_Families_Register_Extension` v1.1:
 *
 *   institution -> institution role -> controlled instrument family/version
 *     -> edition participation -> individual invitation
 *
 * Adding another institution of an existing role must require NO code
 * change — only new rows in `institutions`/`institution_roles`.
 *
 * institution_engagement and regulator_engagement_history move from a
 * two-part key (edition_id, institution TEXT) to a three-part key
 * (edition_id, institution_id, family_code) — a multi-role institution
 * (Central Securities Clearing System: Family C AND Family D) needs two
 * independent engagement rows in the same edition, one per role.
 *
 * regulator_contacts (Phase 9's provisional mailing-list stub, unrelated to
 * the Phase 12 engagement model) gets the same FK treatment on its
 * hardcoded org_code CHECK, without otherwise changing its behaviour —
 * it is not part of this phase's tested surface.
 *
 * Family D (Depository / Securities-account Infrastructure) content is
 * NOT seeded here — instrument/question DATA is seeded at runtime by
 * packages/db/src/seed/register.ts from survey-register-seed.json, exactly
 * like every other instrument. This migration only adds the schema that
 * lets a Family D engagement exist.
 *
 * Reversible. Schema + reference data (institutions/roles) only — no
 * respondent data is touched.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = async (pgm) => {
  // ── institutions + institution_roles ─────────────────────────────────────
  pgm.createTable('institutions', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    name: { type: 'text', notNull: true, unique: true },
    is_active: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });

  // One institution may hold more than one role (CSCS: Clearing/Settlement
  // AND Depository) — never a single family_code column on institutions.
  pgm.createTable('institution_roles', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    institution_id: {
      type: 'uuid',
      notNull: true,
      references: 'institutions(id)',
      onDelete: 'CASCADE',
    },
    family_code: { type: 'text', notNull: true },
  });
  pgm.addConstraint(
    'institution_roles',
    'institution_roles_family_code_check',
    "CHECK (family_code IN ('A','B','C','D'))",
  );
  pgm.addConstraint(
    'institution_roles',
    'institution_roles_institution_family_unique',
    'UNIQUE (institution_id, family_code)',
  );

  // Seed every institution named in the controlled extension's mapping table.
  // LCFE, NASD OTC and the three FMDQ entities are under CIS review — "not
  // registered and not in collection" per the Engineering Screen Stitching
  // Guide §8 (Phase 21) — seeded inactive; seedInstitutionEngagement skips
  // inactive institutions.
  pgm.sql(`
    INSERT INTO institutions (name, is_active) VALUES
      ('Securities and Exchange Commission', TRUE),
      ('Nigerian Exchange Limited', TRUE),
      ('NASD OTC Securities Exchange', FALSE),
      ('Lagos Commodities and Futures Exchange', FALSE),
      ('FMDQ Securities Exchange Limited', FALSE),
      ('Central Securities Clearing System', TRUE),
      ('FMDQ Clear Limited', FALSE),
      ('FMDQ Depository Limited', FALSE)
  `);
  pgm.sql(`
    INSERT INTO institution_roles (institution_id, family_code)
    SELECT id, 'A' FROM institutions WHERE name = 'Securities and Exchange Commission'
    UNION ALL
    SELECT id, 'B' FROM institutions WHERE name IN (
      'Nigerian Exchange Limited', 'NASD OTC Securities Exchange',
      'Lagos Commodities and Futures Exchange', 'FMDQ Securities Exchange Limited'
    )
    UNION ALL
    SELECT id, 'C' FROM institutions WHERE name IN (
      'Central Securities Clearing System', 'FMDQ Clear Limited'
    )
    UNION ALL
    -- CSCS holds BOTH Family C and Family D — the concrete multi-role case
    -- the controlled document names explicitly.
    SELECT id, 'D' FROM institutions WHERE name IN (
      'Central Securities Clearing System', 'FMDQ Depository Limited'
    )
  `);

  // ── institution_engagement: (edition_id, institution TEXT) →
  //    (edition_id, institution_id, family_code) ───────────────────────────
  pgm.addColumn('institution_engagement', {
    institution_id: { type: 'uuid', references: 'institutions(id)' },
    family_code: { type: 'text' },
  });
  // Migrate the three existing hardcoded rows onto the new key.
  pgm.sql(`
    UPDATE institution_engagement e
       SET institution_id = i.id, family_code = 'A'
      FROM institutions i
     WHERE e.institution = 'SEC' AND i.name = 'Securities and Exchange Commission'
  `);
  pgm.sql(`
    UPDATE institution_engagement e
       SET institution_id = i.id, family_code = 'B'
      FROM institutions i
     WHERE e.institution = 'NGX' AND i.name = 'Nigerian Exchange Limited'
  `);
  pgm.sql(`
    UPDATE institution_engagement e
       SET institution_id = i.id, family_code = 'C'
      FROM institutions i
     WHERE e.institution = 'CSCS' AND i.name = 'Central Securities Clearing System'
  `);
  pgm.dropConstraint('institution_engagement', 'institution_engagement_institution_check', {
    ifExists: true,
  });
  pgm.dropConstraint(
    'institution_engagement',
    'institution_engagement_edition_id_institution_key',
    {
      ifExists: true,
    },
  );
  pgm.sql(`DROP INDEX IF EXISTS institution_engagement_edition_id_institution_key`);
  pgm.dropColumn('institution_engagement', 'institution');
  pgm.alterColumn('institution_engagement', 'institution_id', { notNull: true });
  pgm.alterColumn('institution_engagement', 'family_code', { notNull: true });
  pgm.addConstraint(
    'institution_engagement',
    'institution_engagement_family_code_check',
    "CHECK (family_code IN ('A','B','C','D'))",
  );
  pgm.addConstraint(
    'institution_engagement',
    'institution_engagement_edition_institution_family_unique',
    'UNIQUE (edition_id, institution_id, family_code)',
  );
  // Composite FK: an engagement row may only exist for a role the institution
  // actually holds — the structural form of "adding an institution requires
  // no code change" (it requires only an institution_roles row).
  pgm.addConstraint(
    'institution_engagement',
    'institution_engagement_role_fk',
    'FOREIGN KEY (institution_id, family_code) REFERENCES institution_roles (institution_id, family_code)',
  );

  // ── regulator_engagement_history: same key migration ─────────────────────
  pgm.addColumn('regulator_engagement_history', {
    institution_id: { type: 'uuid', references: 'institutions(id)' },
    family_code: { type: 'text' },
  });
  pgm.sql(`
    UPDATE regulator_engagement_history h
       SET institution_id = i.id, family_code = 'A'
      FROM institutions i
     WHERE h.institution = 'SEC' AND i.name = 'Securities and Exchange Commission'
  `);
  pgm.sql(`
    UPDATE regulator_engagement_history h
       SET institution_id = i.id, family_code = 'B'
      FROM institutions i
     WHERE h.institution = 'NGX' AND i.name = 'Nigerian Exchange Limited'
  `);
  pgm.sql(`
    UPDATE regulator_engagement_history h
       SET institution_id = i.id, family_code = 'C'
      FROM institutions i
     WHERE h.institution = 'CSCS' AND i.name = 'Central Securities Clearing System'
  `);
  pgm.dropConstraint(
    'regulator_engagement_history',
    'regulator_engagement_history_institution_check',
    { ifExists: true },
  );
  pgm.sql(`DROP INDEX IF EXISTS idx_reg_history_lookup`);
  pgm.dropColumn('regulator_engagement_history', 'institution');
  pgm.alterColumn('regulator_engagement_history', 'institution_id', { notNull: true });
  pgm.alterColumn('regulator_engagement_history', 'family_code', { notNull: true });
  pgm.addConstraint(
    'regulator_engagement_history',
    'regulator_engagement_history_family_code_check',
    "CHECK (family_code IN ('A','B','C','D'))",
  );
  pgm.sql(`
    CREATE INDEX idx_reg_history_lookup
      ON regulator_engagement_history (edition_id, institution_id, family_code, created_at)
  `);

  // ── regulator_contacts: drop the hardcoded 3-value CHECK, replace with a
  //    real FK. This table is Phase 9's provisional mailing-list stub for the
  //    "all regulators" invitations audience — genericised for the schema
  //    rule this phase closes, but its audience-resolution behaviour is
  //    unchanged (still one row per institution, org_code retained as a
  //    free-text label for backward compatibility). ─────────────────────────
  pgm.addColumn('regulator_contacts', {
    institution_id: { type: 'uuid', references: 'institutions(id)' },
  });
  pgm.sql(`
    UPDATE regulator_contacts c
       SET institution_id = i.id
      FROM institutions i
     WHERE c.org_code = 'SEC' AND i.name = 'Securities and Exchange Commission'
  `);
  pgm.sql(`
    UPDATE regulator_contacts c
       SET institution_id = i.id
      FROM institutions i
     WHERE c.org_code = 'NGX' AND i.name = 'Nigerian Exchange Limited'
  `);
  pgm.sql(`
    UPDATE regulator_contacts c
       SET institution_id = i.id
      FROM institutions i
     WHERE c.org_code = 'CSCS' AND i.name = 'Central Securities Clearing System'
  `);
  pgm.dropConstraint('regulator_contacts', 'regulator_contacts_org_code_check', { ifExists: true });

  // ── editions.planned_open_at: the edition-opening trigger (item 2) ───────────
  // `survey_open_at` already exists (initial schema) and is set by
  // `openEditionFromDraft` when a draft edition transitions to open — but
  // nothing in the codebase ever calls that path (`markOpened` is never wired
  // to a route or a send). The edition genuinely has no way to open today.
  // `planned_open_at` is the NEW study-team-configured launch instant;
  // `survey_open_at` keeps its existing meaning (the real moment opening
  // happened). Lazy evaluation (edition-service's `evaluateAutoOpen`, run on
  // every edition read) compares the two rather than a cron job.
  pgm.addColumn('editions', {
    planned_open_at: { type: 'timestamptz' },
  });
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = async (pgm) => {
  pgm.dropColumn('editions', 'planned_open_at');

  pgm.addConstraint(
    'regulator_contacts',
    'regulator_contacts_org_code_check',
    "CHECK (org_code IN ('SEC','NGX','CSCS'))",
  );
  pgm.dropColumn('regulator_contacts', 'institution_id');

  pgm.sql(`DROP INDEX IF EXISTS idx_reg_history_lookup`);
  pgm.addColumn('regulator_engagement_history', { institution: { type: 'text' } });
  pgm.sql(`
    UPDATE regulator_engagement_history h
       SET institution = CASE h.family_code
             WHEN 'A' THEN 'SEC' WHEN 'B' THEN 'NGX' WHEN 'C' THEN 'CSCS' ELSE NULL END
  `);
  pgm.alterColumn('regulator_engagement_history', 'institution', { notNull: true });
  pgm.addConstraint(
    'regulator_engagement_history',
    'regulator_engagement_history_institution_check',
    "CHECK (institution IN ('SEC','NGX','CSCS'))",
  );
  pgm.sql(
    `CREATE INDEX idx_reg_history_lookup ON regulator_engagement_history (edition_id, institution, created_at)`,
  );
  pgm.dropColumn('regulator_engagement_history', ['institution_id', 'family_code']);

  pgm.dropConstraint('institution_engagement', 'institution_engagement_role_fk', {
    ifExists: true,
  });
  pgm.dropConstraint(
    'institution_engagement',
    'institution_engagement_edition_institution_family_unique',
    { ifExists: true },
  );
  pgm.dropConstraint('institution_engagement', 'institution_engagement_family_code_check', {
    ifExists: true,
  });
  pgm.addColumn('institution_engagement', { institution: { type: 'text' } });
  pgm.sql(`
    UPDATE institution_engagement e
       SET institution = CASE e.family_code
             WHEN 'A' THEN 'SEC' WHEN 'B' THEN 'NGX' WHEN 'C' THEN 'CSCS' ELSE NULL END
  `);
  pgm.alterColumn('institution_engagement', 'institution', { notNull: true });
  pgm.addConstraint(
    'institution_engagement',
    'institution_engagement_institution_check',
    "CHECK (institution IN ('SEC','NGX','CSCS'))",
  );
  pgm.sql(`
    CREATE UNIQUE INDEX institution_engagement_edition_id_institution_key
      ON institution_engagement (edition_id, institution)
  `);
  pgm.dropColumn('institution_engagement', ['institution_id', 'family_code']);

  pgm.dropTable('institution_roles');
  pgm.dropTable('institutions');
};
