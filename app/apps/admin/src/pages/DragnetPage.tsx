import { useState, useEffect } from 'react';
import type { AdminClient } from '../api/client';

/**
 * UX-ADM-007 — Dragnet Internal Analysis (Phase 16).
 *
 * NOT PART OF THE STUDY. This is Dragnet's own commercial analysis tool.
 * The persistent non-dismissible banner below communicates this.
 *
 * Two structurally separate tabs:
 *   Firm maturity — per-firm OMI/DMI, tier, and consented contact (if any).
 *   Operational friction — aggregate-only DRG-OPS responses, no firm identifier.
 *
 * The join boundary is enforced at the API layer. No contact field appears for
 * firms without follow-up consent — absent, not masked.
 */

interface FirmRow {
  organizationId: string;
  firmName: string;
  omi: number | null;
  dmi: number | null;
  tier: 'top' | 'middle' | 'bottom' | null;
  contact: { name: string; role: string | null; email: string } | null;
}

interface FrictionRow {
  questionCode: string;
  promptText: string;
  answerValue: string;
  count: number;
  pct: number;
}

type SortKey = 'firmName' | 'omi' | 'dmi' | 'tier';
type SortDir = 'asc' | 'desc';

const TIER_ORDER = { top: 0, middle: 1, bottom: 2 };

function sortFirms(rows: FirmRow[], key: SortKey, dir: SortDir): FirmRow[] {
  return [...rows].sort((a, b) => {
    let cmp = 0;
    if (key === 'firmName') {
      cmp = a.firmName.localeCompare(b.firmName);
    } else if (key === 'omi') {
      cmp = (a.omi ?? -1) - (b.omi ?? -1);
    } else if (key === 'dmi') {
      cmp = (a.dmi ?? -1) - (b.dmi ?? -1);
    } else {
      const at = a.tier ? TIER_ORDER[a.tier] : 99;
      const bt = b.tier ? TIER_ORDER[b.tier] : 99;
      cmp = at - bt;
    }
    return dir === 'asc' ? cmp : -cmp;
  });
}

function defaultDir(key: SortKey): SortDir {
  return key === 'firmName' ? 'asc' : 'desc';
}

export function DragnetPage({
  client,
  editionId,
}: {
  client: AdminClient;
  editionId: string;
}): JSX.Element {
  const [activeTab, setActiveTab] = useState<'maturity' | 'friction'>('maturity');
  const [firms, setFirms] = useState<FirmRow[]>([]);
  const [friction, setFriction] = useState<FrictionRow[]>([]);
  const [sortKey, setSortKey] = useState<SortKey>('omi');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const [matRes, frictRes] = await Promise.all([
          client.get<{ firms: FirmRow[] }>(`/editions/${editionId}/dragnet/maturity`),
          client.get<{ friction: FrictionRow[] }>(`/editions/${editionId}/dragnet/friction`),
        ]);
        if (cancelled) return;
        setFirms(matRes.firms);
        setFriction(frictRes.friction);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load dragnet data');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, editionId]);

  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(defaultDir(key));
    }
  }

  function sortIndicator(key: SortKey): string {
    if (key !== sortKey) return '';
    return sortDir === 'asc' ? ' ↑' : ' ↓';
  }

  const sortedFirms = sortFirms(firms, sortKey, sortDir);
  const hasConsented = firms.some((f) => f.contact !== null);

  // Group friction rows by question
  const frictionByQuestion = new Map<string, { promptText: string; rows: FrictionRow[] }>();
  for (const row of friction) {
    if (!frictionByQuestion.has(row.questionCode)) {
      frictionByQuestion.set(row.questionCode, { promptText: row.promptText, rows: [] });
    }
    frictionByQuestion.get(row.questionCode)!.rows.push(row);
  }

  return (
    <main style={{ padding: '1.5rem' }}>
      {/* Persistent non-dismissible internal-use banner */}
      <div
        role="status"
        aria-label="Internal use notice"
        style={{
          background: '#fff3cd',
          border: '2px solid #856404',
          borderRadius: 4,
          padding: '0.75rem 1rem',
          marginBottom: '1.5rem',
          fontWeight: 500,
        }}
      >
        <strong>Internal use only — not part of the study output.</strong> This surface is
        Dragnet&rsquo;s commercial analysis tool, built on the MOU&rsquo;s revenue-sharing terms
        with CIS. Maturity findings and operational friction data must not be combined, and firm
        contact details appear only where follow-up consent was given.
      </div>

      <h2 style={{ marginTop: 0 }}>Dragnet Internal Analysis</h2>

      {error && <div className="err">{error}</div>}
      {loading && <p>Loading&hellip;</p>}

      {!loading && !error && (
        <>
          <div style={{ display: 'flex', gap: 8, marginBottom: '1rem' }}>
            <button
              type="button"
              onClick={() => setActiveTab('maturity')}
              style={{
                fontWeight: activeTab === 'maturity' ? 700 : undefined,
                textDecoration: activeTab === 'maturity' ? 'underline' : undefined,
              }}
            >
              Firm maturity
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('friction')}
              style={{
                fontWeight: activeTab === 'friction' ? 700 : undefined,
                textDecoration: activeTab === 'friction' ? 'underline' : undefined,
              }}
            >
              Operational friction
            </button>
          </div>

          {activeTab === 'maturity' && (
            <>
              <div style={{ marginBottom: '0.75rem' }}>
                <a
                  href={`/api/editions/${editionId}/dragnet/maturity.csv`}
                  download="dragnet-maturity.csv"
                >
                  Download CSV
                </a>
                <span style={{ marginLeft: 8, fontSize: '0.85em', color: '#555' }}>
                  ({firms.length} firms — reflects current sort)
                </span>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th
                        style={{ textAlign: 'left', cursor: 'pointer', padding: '6px 8px' }}
                        onClick={() => handleSort('firmName')}
                      >
                        Firm name{sortIndicator('firmName')}
                      </th>
                      <th
                        style={{ cursor: 'pointer', padding: '6px 8px' }}
                        onClick={() => handleSort('omi')}
                      >
                        OMI{sortIndicator('omi')}
                      </th>
                      <th
                        style={{ cursor: 'pointer', padding: '6px 8px' }}
                        onClick={() => handleSort('dmi')}
                      >
                        DMI{sortIndicator('dmi')}
                      </th>
                      <th
                        style={{ cursor: 'pointer', padding: '6px 8px' }}
                        onClick={() => handleSort('tier')}
                      >
                        Tier{sortIndicator('tier')}
                      </th>
                      {hasConsented && (
                        <>
                          <th style={{ padding: '6px 8px' }}>Contact name</th>
                          <th style={{ padding: '6px 8px' }}>Role</th>
                          <th style={{ padding: '6px 8px' }}>Email</th>
                        </>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedFirms.map((firm) => (
                      <tr key={firm.organizationId} style={{ borderTop: '1px solid #ddd' }}>
                        <td style={{ padding: '6px 8px' }}>{firm.firmName}</td>
                        <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                          {firm.omi !== null ? Math.round(firm.omi) : '—'}
                        </td>
                        <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                          {firm.dmi !== null ? Math.round(firm.dmi) : '—'}
                        </td>
                        <td style={{ padding: '6px 8px', textAlign: 'center' }}>
                          {firm.tier ?? '—'}
                        </td>
                        {hasConsented && (
                          <>
                            <td style={{ padding: '6px 8px' }}>{firm.contact?.name ?? ''}</td>
                            <td style={{ padding: '6px 8px' }}>{firm.contact?.role ?? ''}</td>
                            <td style={{ padding: '6px 8px' }}>{firm.contact?.email ?? ''}</td>
                          </>
                        )}
                      </tr>
                    ))}
                    {sortedFirms.length === 0 && (
                      <tr>
                        <td
                          colSpan={hasConsented ? 7 : 4}
                          style={{ padding: '1rem', textAlign: 'center', color: '#888' }}
                        >
                          No firms found for this edition.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {activeTab === 'friction' && (
            <div>
              <p style={{ fontSize: '0.9em', color: '#555', marginBottom: '1rem' }}>
                Aggregate responses to operational friction questions (DRG-OPS). No firm identifier
                is attached to any response shown here.
              </p>
              {frictionByQuestion.size === 0 && (
                <p style={{ color: '#888' }}>No operational friction responses recorded yet.</p>
              )}
              {Array.from(frictionByQuestion.entries()).map(([code, { promptText, rows }]) => (
                <div key={code} style={{ marginBottom: '1.5rem' }}>
                  <h4 style={{ marginBottom: 4 }}>
                    {code}: {promptText}
                  </h4>
                  <table style={{ borderCollapse: 'collapse', width: '100%', maxWidth: 500 }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: 'left', padding: '4px 8px' }}>Answer</th>
                        <th style={{ padding: '4px 8px' }}>Count</th>
                        <th style={{ padding: '4px 8px' }}>%</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.answerValue} style={{ borderTop: '1px solid #eee' }}>
                          <td style={{ padding: '4px 8px' }}>{r.answerValue}</td>
                          <td style={{ padding: '4px 8px', textAlign: 'right' }}>{r.count}</td>
                          <td style={{ padding: '4px 8px', textAlign: 'right' }}>{r.pct}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </main>
  );
}
