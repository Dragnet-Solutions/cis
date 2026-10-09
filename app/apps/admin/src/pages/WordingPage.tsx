import { useState, useEffect, useCallback } from 'react';
import type { AdminClient } from '../api/client';

/**
 * UX-ADM-CNT-001 — Setup — wording (Phase 15).
 * Faithful port of the v1.1 artefact. Manages six content areas:
 *   Privacy notice, Participant message templates, Firm outreach copy,
 *   Invitation landing statements, Organisation descriptions, Help text.
 *
 * Real separation: Save draft creates an immutable version row; Publish wording
 * promotes a specific saved draft to live. The server enforces required-clause
 * presence; the UI shows the server's validation error when a save or publish
 * is blocked.
 *
 * Permission: edition:manage (Phase 8's `setup` right), enforced server-side.
 * No maker-checker gate — wording changes are reversible via version history.
 */

const LOAD_BEARING = new Set(['privacy_notice', 'participant_templates', 'invitation_landing']);

interface AreaInfo {
  area: string;
  label: string;
  isTemplateArea: boolean;
  subKeys?: Array<{ name: string; subject: string }>;
}

interface ContentVersion {
  id: string;
  versionNumber: number;
  body: string;
  createdAt: string;
  createdBy: string | null;
}

interface ContentState {
  liveBody: string | null;
  liveVersionId: string | null;
  versions: ContentVersion[];
}

export function WordingPage({ client }: { client: AdminClient }): JSX.Element {
  const [areas, setAreas] = useState<AreaInfo[]>([]);
  const [selectedArea, setSelectedArea] = useState<string>('');
  const [selectedSubKey, setSelectedSubKey] = useState<string>('_');
  const [state, setState] = useState<ContentState | null>(null);
  const [editorText, setEditorText] = useState('');
  const [savedDraftId, setSavedDraftId] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; kind: 'ok' | 'err' | '' }>({ text: '', kind: '' });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const res = (await client.get('/managed-content')) as { areas: AreaInfo[] };
        setAreas(res.areas);
        if (res.areas[0]) {
          setSelectedArea(res.areas[0].area);
          setSelectedSubKey(
            res.areas[0].isTemplateArea && res.areas[0].subKeys?.[0]
              ? res.areas[0].subKeys[0].name
              : '_',
          );
        }
      } catch {
        setMsg({ text: 'Failed to load content areas.', kind: 'err' });
      }
    })();
  }, [client]);

  const loadState = useCallback(
    async (area: string, subKey: string) => {
      if (!area) return;
      setLoading(true);
      setMsg({ text: '', kind: '' });
      setSavedDraftId(null);
      try {
        const res = (await client.get(
          `/managed-content/${area}/${encodeURIComponent(subKey)}`,
        )) as ContentState;
        setState(res);
        setEditorText(res.liveBody ?? '');
      } catch {
        setMsg({ text: 'Failed to load content.', kind: 'err' });
      } finally {
        setLoading(false);
      }
    },
    [client],
  );

  useEffect(() => {
    if (selectedArea) void loadState(selectedArea, selectedSubKey);
  }, [selectedArea, selectedSubKey, loadState]);

  const currentArea = areas.find((a) => a.area === selectedArea);

  function handleAreaChange(area: string): void {
    setSelectedArea(area);
    const info = areas.find((a) => a.area === area);
    const firstSub = info?.isTemplateArea && info.subKeys?.[0] ? info.subKeys[0].name : '_';
    setSelectedSubKey(firstSub);
  }

  async function handleSaveDraft(): Promise<void> {
    if (!selectedArea || !editorText.trim()) {
      setMsg({ text: 'Required wording cannot be empty.', kind: 'err' });
      return;
    }
    setLoading(true);
    setMsg({ text: '', kind: '' });
    try {
      const res = (await client.post(
        `/managed-content/${selectedArea}/${encodeURIComponent(selectedSubKey)}/drafts`,
        { body: editorText },
      )) as { version: ContentVersion };
      setSavedDraftId(res.version.id);
      setMsg({ text: `Draft saved (v${res.version.versionNumber}).`, kind: 'ok' });
      await loadState(selectedArea, selectedSubKey);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Save failed.';
      setMsg({ text: message, kind: 'err' });
    } finally {
      setLoading(false);
    }
  }

  async function handlePublish(versionId?: string): Promise<void> {
    const id = versionId ?? savedDraftId ?? state?.liveVersionId;
    if (!id) {
      setMsg({ text: 'Save a draft before publishing.', kind: 'err' });
      return;
    }
    setLoading(true);
    setMsg({ text: '', kind: '' });
    try {
      await client.post(
        `/managed-content/${selectedArea}/${encodeURIComponent(selectedSubKey)}/drafts/${id}/publish`,
        {},
      );
      setMsg({ text: 'Published with version history.', kind: 'ok' });
      setSavedDraftId(null);
      await loadState(selectedArea, selectedSubKey);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Publish failed.';
      setMsg({ text: message, kind: 'err' });
    } finally {
      setLoading(false);
    }
  }

  const isLoadBearing = LOAD_BEARING.has(selectedArea);

  return (
    <main>
      <p className="eyebrow">Setup · Wording</p>
      <h1 tabIndex={-1}>Managed wording</h1>
      <p className="lede">
        Edit operational and public-facing wording without a software release. Instrument questions
        remain controlled elsewhere.
      </p>

      <section className="card">
        <div className="row">
          <div className="field">
            <label htmlFor="content-area">Content area</label>
            <select
              id="content-area"
              value={selectedArea}
              onChange={(e) => handleAreaChange(e.target.value)}
              disabled={loading}
            >
              {areas.map((a) => (
                <option key={a.area} value={a.area}>
                  {a.label}
                </option>
              ))}
            </select>
          </div>

          {currentArea?.isTemplateArea && (currentArea.subKeys?.length ?? 0) > 0 && (
            <div className="field">
              <label htmlFor="template-name">Template</label>
              <select
                id="template-name"
                value={selectedSubKey}
                onChange={(e) => setSelectedSubKey(e.target.value)}
                disabled={loading}
              >
                {currentArea.subKeys?.map((sk) => (
                  <option key={sk.name} value={sk.name}>
                    {sk.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        <div className="field">
          <label htmlFor="wording-body">Current wording</label>
          <textarea
            id="wording-body"
            rows={10}
            value={editorText}
            onChange={(e) => {
              setEditorText(e.target.value);
              setSavedDraftId(null);
            }}
            disabled={loading}
            style={{ fontFamily: 'inherit', width: '100%', maxWidth: 'none' }}
          />
        </div>

        {isLoadBearing && (
          <div className="note" style={{ marginTop: 8 }}>
            <b>Load-bearing content.</b> Required statements may be reworded but cannot be deleted.
            The save action blocks if a required statement is removed.
          </div>
        )}

        <div className="actions" style={{ marginTop: 12 }}>
          <button
            type="button"
            className="btn"
            onClick={() => void handleSaveDraft()}
            disabled={loading}
          >
            Save draft
          </button>
          <button
            type="button"
            className="btn-2"
            onClick={() => void handlePublish()}
            disabled={loading}
            title={
              savedDraftId
                ? 'Publish the draft you just saved'
                : state?.liveVersionId
                  ? 'Publish the current live version'
                  : 'Save a draft first'
            }
          >
            Publish wording
          </button>
        </div>

        {msg.text && (
          <p
            className={msg.kind === 'err' ? 'warnbox' : 'note'}
            style={{ marginTop: 8 }}
            role={msg.kind === 'err' ? 'alert' : 'status'}
          >
            {msg.text}
          </p>
        )}
      </section>

      {(state?.versions.length ?? 0) > 0 && (
        <section className="card" style={{ marginTop: 16 }}>
          <h2>Version history</h2>
          <table className="tablewrap" style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '6px 8px' }}>Version</th>
                <th style={{ textAlign: 'left', padding: '6px 8px' }}>Saved</th>
                <th style={{ textAlign: 'left', padding: '6px 8px' }}>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {state?.versions.map((v) => (
                <tr key={v.id} style={{ borderTop: '1px solid var(--polish-line, #e2e2e2)' }}>
                  <td style={{ padding: '6px 8px' }}>v{v.versionNumber}</td>
                  <td style={{ padding: '6px 8px', color: 'var(--muted, #667784)', fontSize: 13 }}>
                    {new Date(v.createdAt).toLocaleString()}
                  </td>
                  <td style={{ padding: '6px 8px' }}>
                    {v.id === state.liveVersionId && (
                      <span className="pill" style={{ background: '#e6f4ea', color: '#1e7e34' }}>
                        Live
                      </span>
                    )}
                  </td>
                  <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                    {v.id !== state.liveVersionId && (
                      <button
                        type="button"
                        className="btn-2"
                        style={{ fontSize: 12, padding: '4px 10px' }}
                        onClick={() => void handlePublish(v.id)}
                        disabled={loading}
                      >
                        Publish this version
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </main>
  );
}
