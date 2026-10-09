import { Pool } from 'pg';
import type { CriticalAction, CriticalActionStatus } from '@cis/shared-types';
import { query } from '../client';

interface RawCriticalActionRow {
  id: string;
  action_type: string;
  status: string;
  requested_by: string;
  requested_at: Date;
  approved_by: string | null;
  approved_at: Date | null;
  rejected_by: string | null;
  rejected_at: Date | null;
  rejection_reason: string | null;
  payload: Record<string, unknown>;
  edition_id: string | null;
}

function mapCriticalAction(row: RawCriticalActionRow): CriticalAction {
  return {
    id: row.id,
    actionType: row.action_type,
    status: row.status as CriticalActionStatus,
    requestedBy: row.requested_by,
    requestedAt: row.requested_at,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    rejectedBy: row.rejected_by,
    rejectedAt: row.rejected_at,
    rejectionReason: row.rejection_reason,
    payload: row.payload,
    editionId: row.edition_id,
  };
}

export async function createCriticalAction(
  pool: Pool,
  data: {
    actionType: string;
    requestedBy: string;
    payload: Record<string, unknown>;
    editionId?: string | null;
  },
): Promise<CriticalAction> {
  const result = await query<RawCriticalActionRow>(
    pool,
    `INSERT INTO critical_actions (action_type, requested_by, payload, edition_id)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [data.actionType, data.requestedBy, JSON.stringify(data.payload), data.editionId ?? null],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Critical action insert returned no rows');
  return mapCriticalAction(row);
}

export async function getCriticalActionById(
  pool: Pool,
  id: string,
): Promise<CriticalAction | null> {
  const result = await query<RawCriticalActionRow>(
    pool,
    'SELECT * FROM critical_actions WHERE id = $1',
    [id],
  );
  const row = result.rows[0];
  return row ? mapCriticalAction(row) : null;
}

/** The most recent still-pending action of a given type for an edition, if any. */
export async function getPendingCriticalActionForEdition(
  pool: Pool,
  editionId: string,
  actionType: string,
): Promise<CriticalAction | null> {
  const result = await query<RawCriticalActionRow>(
    pool,
    `SELECT * FROM critical_actions
     WHERE edition_id = $1 AND action_type = $2 AND status = 'pending'
     ORDER BY requested_at DESC
     LIMIT 1`,
    [editionId, actionType],
  );
  const row = result.rows[0];
  return row ? mapCriticalAction(row) : null;
}

export async function approveCriticalAction(
  pool: Pool,
  id: string,
  approvedBy: string,
): Promise<CriticalAction> {
  // The DB CHECK constraint also enforces approved_by != requested_by,
  // but we check here for a meaningful error message.
  const action = await getCriticalActionById(pool, id);
  if (!action) throw new Error(`Critical action ${id} not found`);
  if (action.status !== 'pending') {
    throw new Error(`Critical action ${id} is not pending (status: ${action.status})`);
  }
  if (action.requestedBy === approvedBy) {
    throw new Error(
      'Maker-checker violation: the same user cannot both request and approve a critical action',
    );
  }

  const result = await query<RawCriticalActionRow>(
    pool,
    `UPDATE critical_actions
     SET status = 'approved', approved_by = $1, approved_at = NOW()
     WHERE id = $2 AND status = 'pending' AND requested_by != $1
     RETURNING *`,
    [approvedBy, id],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(
      `Failed to approve critical action ${id}: maker-checker constraint or concurrent update`,
    );
  }
  return mapCriticalAction(row);
}

export async function rejectCriticalAction(
  pool: Pool,
  id: string,
  rejectedBy: string,
  reason: string,
): Promise<CriticalAction> {
  const action = await getCriticalActionById(pool, id);
  if (!action) throw new Error(`Critical action ${id} not found`);
  if (action.status !== 'pending') {
    throw new Error(`Critical action ${id} is not pending (status: ${action.status})`);
  }
  if (action.requestedBy === rejectedBy) {
    throw new Error('Maker-checker violation: the same user cannot both request and reject');
  }

  const result = await query<RawCriticalActionRow>(
    pool,
    `UPDATE critical_actions
     SET status = 'rejected', rejected_by = $1, rejected_at = NOW(), rejection_reason = $2
     WHERE id = $3 AND status = 'pending' AND requested_by != $1
     RETURNING *`,
    [rejectedBy, reason, id],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`Failed to reject critical action ${id}`);
  return mapCriticalAction(row);
}

/** Internal-only write to audit log — only callable from @cis/audit package. */
export async function _insertAuditLogEntry(
  pool: Pool,
  data: {
    actorId: string | null;
    actionType: string;
    entityType: string;
    entityId: string | null;
    editionId: string | null;
    oldValue: Record<string, unknown> | null;
    newValue: Record<string, unknown> | null;
    reason: string | null;
    ipAddress: string | null;
    userAgent: string | null;
  },
): Promise<string> {
  const result = await query<{ id: string }>(
    pool,
    `INSERT INTO audit_log
       (actor_id, action_type, entity_type, entity_id, edition_id,
        old_value, new_value, reason, ip_address, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id`,
    [
      data.actorId,
      data.actionType,
      data.entityType,
      data.entityId,
      data.editionId,
      data.oldValue ? JSON.stringify(data.oldValue) : null,
      data.newValue ? JSON.stringify(data.newValue) : null,
      data.reason,
      data.ipAddress,
      data.userAgent,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Audit log insert returned no rows');
  return row.id;
}
