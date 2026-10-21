import { useCallback, useEffect, useState } from 'react';
import type { AdminClient } from '../api/client';
import { ApiError } from '../api/types';
import { isAnswered, outstanding, type SurveyItem } from '@cis/survey';
import { ItemControl } from '../renderer/controls';

/**
 * Preview surface for the shared question renderer — the production React port
 * of UX-X-RENDER-001. Not a respondent journey (those arrive in Phase 3); this
 * confirms every control renders from live Register data and reports its own
 * answered/outstanding state.
 */
export function RendererPage({
  client,
  editionId,
}: {
  client: AdminClient;
  editionId: string;
}): JSX.Element {
  // Every instrument in the Register, in its own order — never a fixed list.
  const [codes, setCodes] = useState<string[]>([]);
  const [code, setCode] = useState<string>('S1');
  const [items, setItems] = useState<SurveyItem[]>([]);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (c: string) => {
      setError(null);
      setAnswers({});
      try {
        setItems(await client.getInstrumentItems(c));
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not load the instrument');
        setItems([]);
      }
    },
    [client],
  );

  useEffect(() => {
    let cancelled = false;
    client.getInstruments(editionId).then(
      (r) => {
        if (!cancelled) setCodes(r.instruments.map((i) => i.code));
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [client, editionId]);

  useEffect(() => {
    void load(code);
  }, [load, code]);

  const firmCount = items.filter((i) => i.scope === 'firm_specific').length;

  return (
    <main>
      <p className="eyebrow">Shared control</p>
      <h1 tabIndex={-1}>Question renderer</h1>
      <p className="lede">
        One renderer. An item record in, the correct control out — options, limits, scale range,
        anchors and grid shape all come from the Register.
      </p>

      <div className="actions" style={{ marginBottom: 14 }}>
        {codes.map((c) => (
          <button
            key={c}
            type="button"
            className={c === code ? 'btn' : 'btn-2'}
            onClick={() => setCode(c)}
          >
            {c}
          </button>
        ))}
      </div>

      {error && <div className="err">{error}</div>}

      <p className="lede" style={{ fontSize: 14 }}>
        {items.length} items ·{' '}
        {firmCount
          ? `${firmCount} asked for each rated firm, ${items.length - firmCount} asked once`
          : 'every item asked once'}
      </p>

      {items.map((item) => {
        const value = answers[item.id];
        const why = outstanding(item, value);
        const ok = isAnswered(item, value);
        return (
          <div className="qcard" key={item.id}>
            <div className="qhead">
              <code>{item.id}</code>
              <span className="meta">
                <span className={`tag ${item.scope === 'firm_specific' ? 'firm' : 'shared'}`}>
                  {item.scope === 'firm_specific' ? 'per rated firm' : 'once'}
                </span>
                {item.isDrgOps && (
                  <span
                    className="tag"
                    style={{ marginLeft: 6, background: '#fff4e5', color: '#8a5a00' }}
                  >
                    DRG-OPS
                  </span>
                )}
              </span>
            </div>
            <div className="qbody">
              <p className="qtext">{item.text}</p>
              <ItemControl
                item={item}
                value={value}
                onChange={(next) => setAnswers((prev) => ({ ...prev, [item.id]: next }))}
              />
              <p className={`qstate ${ok ? 'ok' : 'out'}`}>{ok ? 'Answered' : why}</p>
            </div>
          </div>
        );
      })}
    </main>
  );
}
