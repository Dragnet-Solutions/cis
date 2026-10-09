/**
 * Phase 15 — UX-ADM-CNT-001 Managed Wording Admin.
 *
 * Three new tables:
 *   content_versions — immutable draft rows (never overwritten)
 *   content_live     — one live pointer per (content_area, sub_key)
 *   required_clauses — governed marker phrases that must remain present
 *
 * Initial seeds:
 *   - Invitation landing statements: seeded from PublicLanding.tsx current text
 *   - Organisation descriptions: empty first version
 *   - Help text: empty first version
 *   - Required clauses for load-bearing areas
 *   - Participant message templates seeded into message_templates (Phase 9 table)
 *     — the participant-audience rows Phase 9 left as a stub
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = async (pgm) => {
  pgm.createTable('content_versions', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    content_area: { type: 'text', notNull: true },
    sub_key: { type: 'text', notNull: true, default: "''" },
    body: { type: 'text', notNull: true },
    version_number: { type: 'integer', notNull: true },
    created_by: { type: 'uuid', references: 'users(id)', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });
  pgm.createIndex('content_versions', ['content_area', 'sub_key', 'version_number'], {
    unique: true,
  });

  pgm.createTable('content_live', {
    content_area: { type: 'text', notNull: true },
    sub_key: { type: 'text', notNull: true, default: "''" },
    version_id: {
      type: 'uuid',
      notNull: true,
      references: 'content_versions(id)',
      onDelete: 'RESTRICT',
    },
    published_by: { type: 'uuid', references: 'users(id)', onDelete: 'SET NULL' },
    published_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });
  pgm.addConstraint('content_live', 'content_live_pkey', 'PRIMARY KEY (content_area, sub_key)');

  pgm.createTable('required_clauses', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    content_area: { type: 'text', notNull: true },
    sub_key: { type: 'text', notNull: true, default: "''" },
    clause_key: { type: 'text', notNull: true },
    clause_text: { type: 'text', notNull: true },
  });
  pgm.addConstraint(
    'required_clauses',
    'required_clauses_area_subkey_clausekey',
    'UNIQUE (content_area, sub_key, clause_key)',
  );

  // ── Participant message templates (Phase 9 table, participant-audience rows) ──
  // Phase 9 seeded firm templates only. These participant stubs are the base
  // that the wording surface can edit; bodies are kept minimal and placeholder-safe.
  pgm.sql(`
    INSERT INTO message_templates (id, edition_id, name, subject, body, audience_kind, requires_code, created_at, updated_at)
    SELECT
      gen_random_uuid(),
      e.id,
      t.name,
      t.subject,
      t.body,
      'participant',
      false,
      NOW(),
      NOW()
    FROM (SELECT id FROM editions ORDER BY created_at LIMIT 1) e,
    (VALUES
      (
        'Retail survey invitation',
        'Your experience with your broker — the 2026 benchmark',
        'You have been invited to share your experience for the independent Nigerian Capital Market Brokerage Benchmark.

Your answers are anonymous. No broker is told whether you took part, and your name is never shared with any firm.

Start your survey: {{survey_link}}

If you did not expect this invitation, you can disregard this message.'
      ),
      (
        'Retail survey reminder',
        'A reminder: your broker experience survey',
        'You started the benchmark survey but have not yet submitted your answers.

Complete your survey: {{survey_link}}

The survey closes on {{close_date}}. If you have already submitted your answers, thank you — no further action is needed.'
      )
    ) AS t(name, subject, body)
    WHERE NOT EXISTS (
      SELECT 1 FROM message_templates mt
        JOIN editions ed ON ed.id = mt.edition_id
       WHERE mt.audience_kind = 'participant'
         AND ed.id = e.id
    )
  `);

  // ── Seed initial content_versions and content_live for non-template areas ──
  pgm.sql(`
    WITH v AS (
      INSERT INTO content_versions (content_area, sub_key, body, version_number)
      VALUES
        (
          'invitation_landing',
          '',
          '{"heading":"The Nigerian Capital Market Brokerage Benchmark","lede":"An independent read on how brokers serve their clients — built from the people who actually use them.","firmCta":"Firm participation →","resultsPlaceholder":"Published results for the current edition will appear here once the study closes and the numbers clear the sample-sufficiency floor."}',
          1
        ),
        (
          'organisation_descriptions',
          '',
          '{"description":""}',
          1
        ),
        (
          'help_text',
          '',
          '{"general":""}',
          1
        )
      RETURNING id, content_area
    )
    INSERT INTO content_live (content_area, sub_key, version_id)
    SELECT content_area, '', id FROM v
  `);

  // ── Required clauses (load-bearing areas) ──
  pgm.sql(`
    INSERT INTO required_clauses (content_area, sub_key, clause_key, clause_text) VALUES
      -- Privacy notice: the core data-protection statement from Phase 3 PAT-011
      ('privacy_notice', '', 'data_separation', 'kept separate from your answers'),
      -- Invitation landing: independence claim is load-bearing for the benchmark's credibility
      ('invitation_landing', '', 'independence', 'independent'),
      -- Participant templates: the survey link placeholder must remain or the link won't be sent
      ('participant_templates', 'Retail survey invitation', 'survey_link', '{{survey_link}}'),
      ('participant_templates', 'Retail survey reminder', 'survey_link', '{{survey_link}}')
    ON CONFLICT (content_area, sub_key, clause_key) DO NOTHING
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = async (pgm) => {
  // Remove participant templates seeded above
  pgm.sql(`
    DELETE FROM message_templates
    WHERE audience_kind = 'participant'
      AND name IN ('Retail survey invitation', 'Retail survey reminder')
  `);
  pgm.dropTable('required_clauses');
  pgm.dropTable('content_live');
  pgm.dropTable('content_versions');
};
