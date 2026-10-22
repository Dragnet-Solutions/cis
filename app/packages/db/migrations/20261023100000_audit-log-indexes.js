'use strict';

/**
 * D-07 — indexes for the Audit screen's filters and paging.
 *
 * audit_log already has indexes on occurred_at DESC, actor_id, edition_id and
 * (entity_type, entity_id). Missing: the action-type filter, and a tiebreak on
 * id for the keyset page order (occurred_at DESC, id DESC).
 *
 * Indexes only, additive and reversible. Built CONCURRENTLY outside a
 * transaction so a large audit_log is not write-locked while they build; each
 * statement runs on its own (CONCURRENTLY cannot share a multi-statement query).
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = function (pgm) {
  pgm.noTransaction();
  pgm.sql(
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_log_action_type
       ON audit_log (action_type, occurred_at DESC)`,
  );
  pgm.sql(
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_log_occurred_id
       ON audit_log (occurred_at DESC, id DESC)`,
  );
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = function (pgm) {
  pgm.noTransaction();
  pgm.sql(`DROP INDEX CONCURRENTLY IF EXISTS idx_audit_log_occurred_id`);
  pgm.sql(`DROP INDEX CONCURRENTLY IF EXISTS idx_audit_log_action_type`);
};
