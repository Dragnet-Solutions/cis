'use strict';

/**
 * The national report's sentence-level review, connected to the AI narrative.
 *
 * The draft under review is the Industry report's narrative in force: each of
 * its sentences is recorded against the report with the narrative it came
 * from (`narrative_id`), its position in that narrative (`narrative_index`)
 * and its section, so a redraft starts a fresh review instead of inheriting
 * dispositions made on different words. Checker health is likewise measured
 * against that narrative's own facts.
 *
 * Additive and reversible: three nullable columns on the sentences table, one
 * on adversary_health. Earlier rows keep NULL.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = function (pgm) {
  pgm.sql(`
    ALTER TABLE national_report_sentences
      ADD COLUMN narrative_id    UUID REFERENCES report_narratives(id),
      ADD COLUMN narrative_index INTEGER,
      ADD COLUMN section         TEXT
  `);
  pgm.sql(`
    CREATE UNIQUE INDEX uq_nr_sentences_narrative_index
      ON national_report_sentences (national_report_id, narrative_id, narrative_index)
      WHERE narrative_id IS NOT NULL
  `);
  pgm.sql(
    `ALTER TABLE adversary_health ADD COLUMN narrative_id UUID REFERENCES report_narratives(id)`,
  );
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = function (pgm) {
  pgm.sql(`ALTER TABLE adversary_health DROP COLUMN IF EXISTS narrative_id`);
  pgm.sql(`DROP INDEX IF EXISTS uq_nr_sentences_narrative_index`);
  pgm.sql(`
    ALTER TABLE national_report_sentences
      DROP COLUMN IF EXISTS section,
      DROP COLUMN IF EXISTS narrative_index,
      DROP COLUMN IF EXISTS narrative_id
  `);
};
