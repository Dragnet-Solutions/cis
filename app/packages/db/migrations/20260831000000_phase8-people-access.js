'use strict';

/**
 * Phase 8 — Setup: People & Access (RBAC admin) (UX-OPS-006).
 *
 * The admin surface that manages WHO holds the `request` / `approve` rights that
 * gate the six critical actions the platform has enforced since Phase 0 — and
 * the other five access rights besides. It adds NO new critical action and
 * changes NONE of the six's own logic.
 *
 * The existing RBAC model is role→permission→user_roles. This phase adds a
 * per-PERSON direct grant so an operator can hand a single named person a
 * specific right without inventing a bespoke role each time:
 *
 *   `user_permissions` — a direct (user, permission) grant, unioned with the
 *   role-based grants by getUserPermissions. This keeps the Phase 1 edition-lock
 *   maker-checker path working unchanged (it reads the same permission set),
 *   while giving this surface a clean per-person write model.
 *
 * The seven rights (view/send/regs/setup/request/approve/dragnet) are seeded as
 * canonical permission rows by a parameterized loader (data, not schema), so the
 * three that gate not-yet-built surfaces (send/regs/dragnet) need no second RBAC
 * migration when those surfaces arrive. `request`/`approve` reuse Phase 0's
 * can_request/​can_approve_critical_action types with a NULL action_scope
 * (= any of the six), so this surface manages access without touching the
 * actions' shape.
 *
 * Reversible. Schema only.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = function (pgm) {
  // ── user_permissions ─────────────────────────────────────────────────────────
  // A direct grant of one permission to one person. Unioned with role_permissions
  // by getUserPermissions. granted_by records the operator who made the grant
  // (nullable so a seed/break-glass grant with no operator is representable).
  pgm.sql(`
    CREATE TABLE user_permissions (
      user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      permission_id UUID        NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
      granted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      granted_by    UUID        REFERENCES users(id),
      PRIMARY KEY (user_id, permission_id)
    )
  `);
  pgm.sql(`CREATE INDEX idx_user_permissions_perm ON user_permissions(permission_id)`);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = function (pgm) {
  pgm.sql(`DROP TABLE IF EXISTS user_permissions`);
};
