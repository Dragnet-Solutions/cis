'use strict';

/**
 * D-25 — a grid's columns in the Register's own order.
 *
 * S3-Q4 asks for (a) performance then (b) risk, and the Survey Register lists
 * its grid dimensions in that order. But `grid_dimensions` is JSONB, and JSONB
 * does not keep object key order (it stores shorter keys first), so the
 * renderer read "Risk" before "Performance" and showed the columns the wrong
 * way round. The content itself was always right; only its order was lost.
 *
 * Additive: a `grid_dimension_order` column holding the dimension names in
 * Register order, which the question loader applies. New questions get it on
 * insert. Existing S3-Q4 rows are given the Register's order — only where the
 * stored dimensions are exactly the signed-off Performance/Risk pair, so no
 * content changes and nothing else is touched. A frozen instrument stays
 * frozen: its questions, options and wording are unchanged.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = function (pgm) {
  pgm.sql(`ALTER TABLE instrument_questions ADD COLUMN IF NOT EXISTS grid_dimension_order TEXT[]`);
  pgm.sql(`
    UPDATE instrument_questions
       SET grid_dimension_order = ARRAY['Performance', 'Risk']
     WHERE question_code = 'S3-Q4'
       AND grid_dimension_order IS NULL
       AND grid_dimensions IS NOT NULL
       AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(grid_dimensions) AS k)
           = ARRAY['Performance', 'Risk']
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = function (pgm) {
  pgm.sql(`ALTER TABLE instrument_questions DROP COLUMN IF EXISTS grid_dimension_order`);
};
