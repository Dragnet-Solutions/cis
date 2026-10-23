import { Fragment, useCallback, useEffect, useState } from 'react';
import type { AdminClient } from '../api/client';
import { ApiError, type AuditEntry, type AuditFacets, type EditionSummary } from '../api/types';

/**
 * Setup › Audit (D-07): the audit trail, read-only. Who may see it (setup or
 * Dragnet right) is decided by the server; this screen shows its refusal.
 */

export interface AuditFilter {
  from: string;
  to: string;
  actorId: string;
  action: string;
  entityType: string;
  editionId: string;
}

export const EMPTY_FILTER: AuditFilter = {
  from: '',
  to: '',
  actorId: '',
  action: '',
  entityType: '',
  editionId: '',
};

/** The filter (and page cursor) as the API's query string; empty fields left out. */
export function auditQueryString(filter: AuditFilter, cursor?: string | null): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(filter)) if (v) q.set(k, v);
  if (cursor) q.set('cursor', cursor);
  return q.toString();
}

/** A value as one short line: compact JSON, cut at `max` characters. */
export function compactJson(value: Record<string, unknown> | null, max = 80): string {
  if (!value) return '—';
  const s = JSON.stringify(value);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** The download name the server also gives: audit-<from>-<to>.csv. */
export function auditFilename(filter: AuditFilter): string {
  return `audit-${filter.from || 'start'}-${filter.to || 'now'}.csv`;
}

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function AuditPage({
  client,
  editions,
}: {
  client: AdminClient;
  editions: EditionSummary[];
}): JSX.Element {
  const [draft, setDraft] = useState<AuditFilter>(EMPTY_FILTER);
  const [filter, setFilter] = useState<AuditFilter>(EMPTY_FILTER);
  const [facets, setFacets] = useState<AuditFacets | null>(null);
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  /** Cursors of the pages before the current one (for "Newer"). */
  const [stack, setStack] = useState<Array<string | null>>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    client
      .getAuditFacets()
      .then(setFacets)
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.statusCode === 403) setDenied(true);
      });
  }, [client]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const page = await client.getAudit(auditQueryString(filter, cursor));
      setEntries(page.entries);
      setNextCursor(page.nextCursor);
    } catch (err) {
      if (err instanceof ApiError && err.statusCode === 403) setDenied(true);
      else setError(err instanceof ApiError ? err.message : 'Could not load the audit trail');
    }
  }, [client, filter, cursor]);

  useEffect(() => {
    void load();
  }, [load]);

  if (denied) {
    return (
      <main>
        <p className="eyebrow">Setup</p>
        <h1 tabIndex={-1}>Audit</h1>
        <div className="warnbox">
          <b>The audit trail needs the setup right or the Dragnet right.</b>
          <p style={{ margin: '6px 0 0' }}>Ask whoever manages People to grant one of them.</p>
        </div>
      </main>
    );
  }

  const apply = () => {
    setStack([]);
    setCursor(null);
    setOpen(null);
    setFilter(draft);
  };
  const reset = () => {
    setDraft(EMPTY_FILTER);
    setStack([]);
    setCursor(null);
    setFilter(EMPTY_FILTER);
  };
  const older = () => {
    if (!nextCursor) return;
    setStack((s) => [...s, cursor]);
    setCursor(nextCursor);
  };
  const newer = () => {
    setCursor(stack[stack.length - 1] ?? null);
    setStack(stack.slice(0, -1));
  };

  async function exportCsv(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const blob = await client.downloadAuditCsv(auditQueryString(filter));
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = auditFilename(filter);
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not export the audit trail');
    } finally {
      setBusy(false);
    }
  }

  const set = (k: keyof AuditFilter) => (e: { target: { value: string } }) =>
    setDraft((d) => ({ ...d, [k]: e.target.value }));
  const pageNo = stack.length + 1;

  return (
    <main className="audit">
      <p className="eyebrow">Setup</p>
      <h1 tabIndex={-1}>Audit</h1>
      <p className="lede">
        Every recorded action, newest first. Read-only: nothing here can be changed or removed.
      </p>

      <section className="stage">
        <div className="stagebody">
          <div className="audit-filters">
            <div className="field">
              <label htmlFor="a-from">From</label>
              <input id="a-from" type="date" value={draft.from} onChange={set('from')} />
            </div>
            <div className="field">
              <label htmlFor="a-to">To (inclusive)</label>
              <input id="a-to" type="date" value={draft.to} onChange={set('to')} />
            </div>
            <div className="field">
              <label htmlFor="a-actor">Person</label>
              <select id="a-actor" value={draft.actorId} onChange={set('actorId')}>
                <option value="">Anyone</option>
                {facets?.actors.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.email})
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="a-action">Action</label>
              <select id="a-action" value={draft.action} onChange={set('action')}>
                <option value="">Any action</option>
                {facets?.actionTypes.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="a-entity">Item type</label>
              <select id="a-entity" value={draft.entityType} onChange={set('entityType')}>
                <option value="">Any item</option>
                {facets?.entityTypes.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="a-edition">Edition</label>
              <select id="a-edition" value={draft.editionId} onChange={set('editionId')}>
                <option value="">Any edition</option>
                {editions.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="actions">
            <button type="button" className="btn" onClick={apply}>
              Show
            </button>
            <button type="button" className="btn-2" onClick={reset}>
              Clear filters
            </button>
            <button
              type="button"
              className="btn-2"
              disabled={busy}
              onClick={() => void exportCsv()}
            >
              {busy ? 'Exporting…' : 'Export CSV of this filter'}
            </button>
          </div>
        </div>
      </section>

      {error && <div className="err">{error}</div>}

      {!entries ? (
        <p>Loading…</p>
      ) : entries.length === 0 ? (
        <p>No recorded actions match this filter.</p>
      ) : (
        <div className="tablewrap">
          <table className="audit-table">
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Person</th>
                <th scope="col">Action</th>
                <th scope="col">Item</th>
                <th scope="col">Old value</th>
                <th scope="col">New value</th>
                <th scope="col">Reason</th>
                <th scope="col">
                  <span className="audit-sr">Details</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <Fragment key={e.id}>
                  <tr>
                    <td className="audit-nowrap">{when(e.occurredAt)}</td>
                    <td>
                      {e.actor ? (
                        <>
                          {e.actor.name ?? 'Unknown'}
                          <br />
                          <small>{e.actor.email}</small>
                        </>
                      ) : (
                        <small>System</small>
                      )}
                    </td>
                    <td>
                      <code>{e.action}</code>
                    </td>
                    <td>
                      {e.entityType}
                      {e.entityLabel ? ` · ${e.entityLabel}` : ''}
                      {e.entityId && (
                        <>
                          <br />
                          <small className="audit-mono">{e.entityId}</small>
                        </>
                      )}
                    </td>
                    <td>
                      <code className="audit-json">{compactJson(e.oldValue)}</code>
                    </td>
                    <td>
                      <code className="audit-json">{compactJson(e.newValue)}</code>
                    </td>
                    <td>{e.reason ?? '—'}</td>
                    <td>
                      <button
                        type="button"
                        className="textlink"
                        aria-expanded={open === e.id}
                        onClick={() => setOpen(open === e.id ? null : e.id)}
                      >
                        {open === e.id ? 'Hide' : 'More'}
                      </button>
                    </td>
                  </tr>
                  {open === e.id && (
                    <tr className="audit-detail">
                      <td colSpan={8}>
                        <dl className="kv">
                          <dt>Old value</dt>
                          <dd>
                            <pre>{e.oldValue ? JSON.stringify(e.oldValue, null, 2) : '—'}</pre>
                          </dd>
                          <dt>New value</dt>
                          <dd>
                            <pre>{e.newValue ? JSON.stringify(e.newValue, null, 2) : '—'}</pre>
                          </dd>
                          <dt>Edition</dt>
                          <dd>{e.editionLabel ?? '—'}</dd>
                          <dt>IP address</dt>
                          <dd>{e.ipAddress ?? '—'}</dd>
                          <dt>Browser</dt>
                          <dd>{e.userAgent ?? '—'}</dd>
                        </dl>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="actions">
        <button type="button" className="btn-2" disabled={stack.length === 0} onClick={newer}>
          Newer
        </button>
        <span className="audit-pageno">Page {pageNo}</span>
        <button type="button" className="btn-2" disabled={!nextCursor} onClick={older}>
          Older
        </button>
      </div>
    </main>
  );
}
