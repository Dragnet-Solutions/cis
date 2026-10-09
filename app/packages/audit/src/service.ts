import { Pool } from 'pg';
import { _insertAuditLogEntry } from '@cis/db';
import type { AuditLogEntry } from '@cis/shared-types';

/**
 * Parameters for writing an audit record.
 * This is the single gateway — no other code may write to audit_log directly.
 */
export interface WriteAuditParams {
  /** null for system/background actions with no human actor */
  actorId: string | null;
  actionType: string;
  entityType: string;
  entityId?: string | null;
  /** Attach to an edition when the action is edition-scoped */
  editionId?: string | null;
  oldValue?: Record<string, unknown> | null;
  newValue?: Record<string, unknown> | null;
  reason?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Write an immutable audit record. This is the only sanctioned way to insert
 * into audit_log. Feature services must import and call this function — they
 * must not construct raw INSERT statements against audit_log themselves.
 */
export async function writeAudit(pool: Pool, params: WriteAuditParams): Promise<string> {
  return _insertAuditLogEntry(pool, {
    actorId: params.actorId ?? null,
    actionType: params.actionType,
    entityType: params.entityType,
    entityId: params.entityId ?? null,
    editionId: params.editionId ?? null,
    oldValue: params.oldValue ?? null,
    newValue: params.newValue ?? null,
    reason: params.reason ?? null,
    ipAddress: params.ipAddress ?? null,
    userAgent: params.userAgent ?? null,
  });
}

/** Read audit entries for a specific entity (for display/reporting). */
export async function getAuditEntriesForEntity(
  pool: Pool,
  entityType: string,
  entityId: string,
): Promise<AuditLogEntry[]> {
  const result = await pool.query<{
    id: string;
    actor_id: string | null;
    action_type: string;
    entity_type: string;
    entity_id: string | null;
    edition_id: string | null;
    old_value: Record<string, unknown> | null;
    new_value: Record<string, unknown> | null;
    reason: string | null;
    occurred_at: Date;
    ip_address: string | null;
    user_agent: string | null;
  }>(
    `SELECT * FROM audit_log
     WHERE entity_type = $1 AND entity_id = $2
     ORDER BY occurred_at DESC`,
    [entityType, entityId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    actorId: row.actor_id,
    actionType: row.action_type,
    entityType: row.entity_type,
    entityId: row.entity_id,
    editionId: row.edition_id,
    oldValue: row.old_value,
    newValue: row.new_value,
    reason: row.reason,
    occurredAt: row.occurred_at,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
  }));
}
