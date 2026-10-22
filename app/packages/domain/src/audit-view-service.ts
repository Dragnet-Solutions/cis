/**
 * D-07 — the audit screen: read-only access to audit_log.
 *
 * Who: operators holding the setup right (edition:manage) or the Dragnet right
 * (access:dragnet). Enforced here on every call, not just by hiding the nav.
 *
 * Read-only: there is no edit or delete path. The one write is the audit
 * record of an export itself (`audit.exported`, with the filter and row count).
 */
import { Pool } from 'pg';
import { listAuditLog, listAuditFacets, type AuditLogFilter, type AuditLogRow } from '@cis/db';
import { hasPermission, loadRbacContext, PermissionDeniedError } from '@cis/auth';
import { writeAudit } from '@cis/audit';
import { DomainError } from './errors';
import type { ActorContext } from './edition-service';

export const AUDIT_PAGE_SIZE = 100;
/** Most rows one CSV export may carry; a wider filter is refused, not cut short. */
export const AUDIT_EXPORT_CAP = 50_000;
const EXPORT_BATCH = 5_000;

export class AuditExportTooLargeError extends DomainError {
  constructor() {
    super(
      `This filter matches more than ${AUDIT_EXPORT_CAP.toLocaleString('en-GB')} audit entries, ` +
        'more than one export can carry. Narrow the date range or add a person or action filter, ' +
        'and export in parts.',
      'AUDIT_EXPORT_TOO_LARGE',
    );
  }
}

/** The raw filter as it arrives on the query string. Dates are YYYY-MM-DD
 *  (whole days, `to` inclusive) or full ISO instants. */
export interface AuditQuery {
  from?: string;
  to?: string;
  actorId?: string;
  action?: string;
  entityType?: string;
  editionId?: string;
}

const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function parseBound(value: string | undefined, end: boolean): Date | null {
  if (!value) return null;
  const d = new Date(DAY_ONLY.test(value) ? `${value}T00:00:00.000Z` : value);
  if (Number.isNaN(d.getTime())) {
    throw new DomainError(`"${value}" is not a date`, 'AUDIT_BAD_DATE');
  }
  // A whole-day `to` includes that day.
  if (end && DAY_ONLY.test(value)) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

export function toAuditFilter(q: AuditQuery): AuditLogFilter {
  return {
    from: parseBound(q.from, false),
    to: parseBound(q.to, true),
    actorId: q.actorId || null,
    actionType: q.action || null,
    entityType: q.entityType || null,
    editionId: q.editionId || null,
  };
}

async function assertAuditAccess(pool: Pool, userId: string): Promise<void> {
  const rbac = await loadRbacContext(pool, userId);
  if (!hasPermission(rbac, 'edition:manage') && !hasPermission(rbac, 'access:dragnet')) {
    throw new PermissionDeniedError(userId, 'audit:view (edition:manage or access:dragnet)');
  }
}

export interface AuditPage {
  entries: AuditLogRow[];
  /** Pass back as `cursor` for the next (older) page; null on the last page. */
  nextCursor: string | null;
}

export async function getAuditPage(
  pool: Pool,
  userId: string,
  q: AuditQuery,
  cursor?: string | null,
): Promise<AuditPage> {
  await assertAuditAccess(pool, userId);
  const rows = await listAuditLog(pool, toAuditFilter(q), {
    cursor: cursor ?? null,
    limit: AUDIT_PAGE_SIZE + 1,
  });
  const more = rows.length > AUDIT_PAGE_SIZE;
  const entries = more ? rows.slice(0, AUDIT_PAGE_SIZE) : rows;
  return { entries, nextCursor: more ? entries[entries.length - 1]!.id : null };
}

export async function getAuditFacets(
  pool: Pool,
  userId: string,
): Promise<Awaited<ReturnType<typeof listAuditFacets>>> {
  await assertAuditAccess(pool, userId);
  return listAuditFacets(pool);
}

/**
 * One CSV cell: a value a spreadsheet would run as a formula (leading = + - @,
 * or a tab / carriage return) is prefixed with an apostrophe, and every cell
 * is quoted.
 */
export function auditCsvCell(value: string | null | undefined): string {
  const v = value ?? '';
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return `"${safe.replace(/"/g, '""')}"`;
}

const CSV_HEADER = [
  'time',
  'actor_name',
  'actor_email',
  'action',
  'entity_type',
  'entity_id',
  'entity_label',
  'edition',
  'old_value',
  'new_value',
  'reason',
  'ip_address',
  'user_agent',
];

function csvLine(r: AuditLogRow): string {
  return [
    r.occurredAt.toISOString(),
    r.actorName ?? (r.actorId ? r.actorId : 'system'),
    r.actorEmail,
    r.actionType,
    r.entityType,
    r.entityId,
    r.entityLabel,
    r.editionLabel,
    r.oldValue ? JSON.stringify(r.oldValue) : '',
    r.newValue ? JSON.stringify(r.newValue) : '',
    r.reason,
    r.ipAddress,
    r.userAgent,
  ]
    .map(auditCsvCell)
    .join(',');
}

/** The download filename for a filter: audit-<from>-<to>.csv. */
export function auditCsvFilename(q: AuditQuery): string {
  const day = (v: string | undefined, fallback: string) =>
    v ? v.slice(0, 10).replace(/[^0-9-]/g, '') : fallback;
  return `audit-${day(q.from, 'start')}-${day(q.to, 'now')}.csv`;
}

/**
 * The CURRENT filter as CSV, read in keyset pages server-side. Refused (not
 * truncated) beyond AUDIT_EXPORT_CAP rows. The export is itself audited.
 */
export async function exportAuditCsv(
  pool: Pool,
  userId: string,
  q: AuditQuery,
  ctx: ActorContext = {},
): Promise<{ csv: string; rows: number; filename: string }> {
  await assertAuditAccess(pool, userId);
  const filter = toAuditFilter(q);
  const lines: string[] = [CSV_HEADER.join(',')];
  let cursor: string | null = null;
  let count = 0;
  for (;;) {
    const batch: AuditLogRow[] = await listAuditLog(pool, filter, { cursor, limit: EXPORT_BATCH });
    if (batch.length === 0) break;
    count += batch.length;
    if (count > AUDIT_EXPORT_CAP) throw new AuditExportTooLargeError();
    for (const r of batch) lines.push(csvLine(r));
    if (batch.length < EXPORT_BATCH) break;
    cursor = batch[batch.length - 1]!.id;
  }

  await writeAudit(pool, {
    actorId: userId,
    actionType: 'audit.exported',
    entityType: 'audit_log',
    editionId: filter.editionId ?? null,
    newValue: { filter: { ...q }, rows: count },
    ipAddress: ctx.ipAddress ?? null,
    userAgent: ctx.userAgent ?? null,
  });

  return { csv: `${lines.join('\r\n')}\r\n`, rows: count, filename: auditCsvFilename(q) };
}
