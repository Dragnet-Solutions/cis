import { Pool } from 'pg';
import { query } from '../client';

/**
 * Read side of the audit trail (D-07). audit_log is append-only (an immutable
 * trigger blocks UPDATE/DELETE) and is written only through @cis/audit's
 * writeAudit — nothing here writes, edits or deletes.
 */

export interface AuditLogFilter {
  /** Inclusive lower bound on occurred_at. */
  from?: Date | null;
  /** Exclusive upper bound on occurred_at. */
  to?: Date | null;
  actorId?: string | null;
  actionType?: string | null;
  entityType?: string | null;
  editionId?: string | null;
}

export interface AuditLogRow {
  id: string;
  occurredAt: Date;
  actorId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  actionType: string;
  entityType: string;
  entityId: string | null;
  /** A human name for the item, where one is cheap to find. */
  entityLabel: string | null;
  editionId: string | null;
  editionLabel: string | null;
  oldValue: Record<string, unknown> | null;
  newValue: Record<string, unknown> | null;
  reason: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}

interface RawAuditRow {
  id: string;
  occurred_at: Date;
  actor_id: string | null;
  actor_name: string | null;
  actor_email: string | null;
  action_type: string;
  entity_type: string;
  entity_id: string | null;
  entity_label: string | null;
  edition_id: string | null;
  edition_label: string | null;
  old_value: Record<string, unknown> | null;
  new_value: Record<string, unknown> | null;
  reason: string | null;
  ip_address: string | null;
  user_agent: string | null;
}

function mapRow(r: RawAuditRow): AuditLogRow {
  return {
    id: r.id,
    occurredAt: r.occurred_at,
    actorId: r.actor_id,
    actorName: r.actor_name,
    actorEmail: r.actor_email,
    actionType: r.action_type,
    entityType: r.entity_type,
    entityId: r.entity_id,
    entityLabel: r.entity_label,
    editionId: r.edition_id,
    editionLabel: r.edition_label,
    oldValue: r.old_value,
    newValue: r.new_value,
    reason: r.reason,
    ipAddress: r.ip_address,
    userAgent: r.user_agent,
  };
}

/** Parameterised WHERE clause for a filter; `params` is appended to. */
function whereFor(filter: AuditLogFilter, params: unknown[]): string {
  const clauses: string[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    clauses.push(sql.replace('?', `$${params.length}`));
  };
  if (filter.from) add('a.occurred_at >= ?', filter.from);
  if (filter.to) add('a.occurred_at < ?', filter.to);
  if (filter.actorId) add('a.actor_id = ?', filter.actorId);
  if (filter.actionType) add('a.action_type = ?', filter.actionType);
  if (filter.entityType) add('a.entity_type = ?', filter.entityType);
  if (filter.editionId) add('a.edition_id = ?', filter.editionId);
  return clauses.length ? clauses.join(' AND ') : 'TRUE';
}

/**
 * One page of the audit trail, newest first, keyset-paginated on
 * (occurred_at, id). `cursor` is the id of the last row of the previous page;
 * its position is read back from the table, so there is no timestamp
 * precision to lose in a client-held cursor.
 */
export async function listAuditLog(
  pool: Pool,
  filter: AuditLogFilter,
  opts: { cursor?: string | null; limit: number },
): Promise<AuditLogRow[]> {
  const params: unknown[] = [];
  let where = whereFor(filter, params);
  if (opts.cursor) {
    params.push(opts.cursor);
    const c = `$${params.length}`;
    where += ` AND (a.occurred_at, a.id) < (SELECT occurred_at, id FROM audit_log WHERE id = ${c})`;
  }
  params.push(opts.limit);
  const res = await query<RawAuditRow>(
    pool,
    `SELECT a.id, a.occurred_at, a.actor_id,
            u.display_name AS actor_name, u.email AS actor_email,
            a.action_type, a.entity_type, a.entity_id,
            CASE a.entity_type
                WHEN 'edition' THEN (SELECT e.label FROM editions e WHERE e.id = a.entity_id)
                WHEN 'organization' THEN
                  (SELECT o.display_name FROM organizations o WHERE o.id = a.entity_id)
                WHEN 'user' THEN (SELECT x.display_name FROM users x WHERE x.id = a.entity_id)
                WHEN 'critical_action' THEN
                  (SELECT c.action_type FROM critical_actions c WHERE c.id = a.entity_id)
            END AS entity_label,
            a.edition_id, ed.label AS edition_label,
            a.old_value, a.new_value, a.reason,
            host(a.ip_address) AS ip_address, a.user_agent
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.actor_id
       LEFT JOIN editions ed ON ed.id = a.edition_id
      WHERE ${where}
      ORDER BY a.occurred_at DESC, a.id DESC
      LIMIT $${params.length}`,
    params,
  );
  return res.rows.map(mapRow);
}

/** The choices for the filter controls, read from the data itself. */
export async function listAuditFacets(pool: Pool): Promise<{
  actionTypes: string[];
  entityTypes: string[];
  actors: Array<{ id: string; name: string; email: string }>;
}> {
  const [actions, entities, actors] = await Promise.all([
    query<{ v: string }>(pool, `SELECT DISTINCT action_type AS v FROM audit_log ORDER BY 1`),
    query<{ v: string }>(pool, `SELECT DISTINCT entity_type AS v FROM audit_log ORDER BY 1`),
    query<{ id: string; name: string; email: string }>(
      pool,
      `SELECT u.id, u.display_name AS name, u.email
         FROM users u
        WHERE EXISTS (SELECT 1 FROM audit_log a WHERE a.actor_id = u.id)
        ORDER BY u.display_name`,
    ),
  ]);
  return {
    actionTypes: actions.rows.map((r) => r.v),
    entityTypes: entities.rows.map((r) => r.v),
    actors: actors.rows,
  };
}
