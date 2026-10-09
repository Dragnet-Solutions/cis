'use strict';

/**
 * Report delivery — what a firm (or the public) actually receives, and the
 * notice that tells them it is there.
 *
 * `report_publications` freezes a document at the moment it leaves CIS: a firm
 * report when it is released, the Industry report when the national report is
 * approved. It pins the exact narrative that went out, so a later redraft can
 * never change what a firm or the public was given. One row per document,
 * permanent — a publication is never edited or withdrawn.
 *
 * `email_outbox` is every notice the system sends, kept whether or not a mail
 * server is configured: `sent` once delivered, `logged` when no mail server is
 * set (recorded, not sent), `failed` with the reason when delivery was tried and
 * refused. The release itself never waits on, or is undone by, a notice.
 *
 * Additive and reversible. Schema only.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = function (pgm) {
  pgm.sql(`
    CREATE TABLE report_publications (
      id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      edition_id     UUID        NOT NULL REFERENCES editions(id),
      kind           TEXT        NOT NULL CHECK (kind IN ('industry', 'firm')),
      subject_id     UUID        REFERENCES organizations(id),
      firm_report_id UUID        REFERENCES firm_reports(id),
      narrative_id   UUID        NOT NULL REFERENCES report_narratives(id),
      published_by   TEXT        NOT NULL,
      published_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK ((kind = 'firm') = (subject_id IS NOT NULL)),
      CHECK ((kind = 'firm') = (firm_report_id IS NOT NULL))
    )
  `);
  pgm.sql(`
    CREATE UNIQUE INDEX uq_report_publications_document
      ON report_publications
         (edition_id, kind, COALESCE(subject_id, '00000000-0000-0000-0000-000000000000'))
  `);
  pgm.sql(`
    CREATE OR REPLACE FUNCTION prevent_report_publication_change()
    RETURNS TRIGGER AS $$
    BEGIN
      RAISE EXCEPTION 'report_publication % is permanent: % is not permitted', OLD.id, TG_OP;
    END;
    $$ LANGUAGE plpgsql
  `);
  pgm.sql(`
    CREATE TRIGGER report_publications_no_change
      BEFORE UPDATE OR DELETE ON report_publications
      FOR EACH ROW EXECUTE FUNCTION prevent_report_publication_change()
  `);

  pgm.sql(`
    CREATE TABLE email_outbox (
      id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      kind         TEXT        NOT NULL,
      ref_id       UUID,
      to_address   TEXT        NOT NULL,
      subject      TEXT        NOT NULL,
      body_text    TEXT        NOT NULL,
      status       TEXT        NOT NULL DEFAULT 'queued'
                               CHECK (status IN ('queued', 'sent', 'logged', 'failed')),
      error        TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      attempted_at TIMESTAMPTZ
    )
  `);
  pgm.sql(`CREATE INDEX idx_email_outbox_ref ON email_outbox (kind, ref_id)`);
  pgm.sql(
    `CREATE INDEX idx_email_outbox_queued ON email_outbox (created_at) WHERE status = 'queued'`,
  );
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = function (pgm) {
  pgm.sql(`DROP TABLE IF EXISTS email_outbox`);
  pgm.sql(`DROP TABLE IF EXISTS report_publications`);
  pgm.sql(`DROP FUNCTION IF EXISTS prevent_report_publication_change()`);
};
