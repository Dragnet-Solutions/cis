import { useRef } from 'react';
import {
  getCanonical,
  setAnswer,
  setComment,
  scaleColumns,
  toggleSelect,
  toggleRank,
  type SurveyItem,
  type GridAnswer,
  type SelectGreatestAnswer,
  type YesNoAnswer,
} from '@cis/survey';
import { useNarrow } from './useNarrow';

interface ControlProps {
  item: SurveyItem;
  a: unknown;
  onAnswer: (a: unknown) => void;
}

function splitAnchors(anchors: string | undefined): [string, string] {
  if (!anchors) return ['', ''];
  const parts = anchors.split(';');
  const lo = (parts[0] ?? '').trim().replace(/\.$/, '');
  const hi = (parts[1] ?? '').trim().replace(/\.$/, '');
  return [lo, hi];
}

/**
 * Scale: a single ARIA radiogroup with roving tabindex (one tab stop), arrow /
 * Home / End navigation. Range and anchors come from data; 0 is a real value.
 * Column count is chosen by target count on a narrow viewport (5×2 / 6-then-5).
 */
function ScaleControl({ item, a, onAnswer }: ControlProps): JSX.Element {
  const narrow = useNarrow();
  const lo = item.scaleMin ?? 1;
  const hi = item.scaleMax ?? 10;
  const count = hi - lo + 1;
  const cols = narrow ? scaleColumns(count) : count;
  const [lowText, highText] = splitAnchors(item.scaleAnchors);
  const value = typeof a === 'number' ? a : undefined;
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const nums: number[] = [];
  for (let v = lo; v <= hi; v++) nums.push(v);

  function onKey(e: React.KeyboardEvent, n: number): void {
    const i = n - lo;
    const last = hi - lo;
    let to: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') to = Math.min(i + 1, last);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') to = Math.max(i - 1, 0);
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = last;
    else if (e.key === ' ' || e.key === 'Enter') {
      onAnswer(n);
      e.preventDefault();
      return;
    }
    if (to === null) return;
    e.preventDefault();
    onAnswer(lo + to);
    refs.current[to]?.focus();
  }

  return (
    <div>
      {item.scaleAnchors && narrow && <p className="ctl-anchor lo">{lowText}</p>}
      <div
        className="ctl-scale"
        role="radiogroup"
        aria-label={item.text}
        style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}
      >
        {nums.map((n, idx) => {
          const checked = value === n;
          return (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={checked || (value === undefined && n === lo) ? 0 : -1}
              ref={(el) => {
                refs.current[idx] = el;
              }}
              onClick={() => onAnswer(n)}
              onKeyDown={(e) => onKey(e, n)}
            >
              {n}
            </button>
          );
        })}
      </div>
      {item.scaleAnchors &&
        (narrow ? (
          <p className="ctl-anchor hi">{highText}</p>
        ) : (
          <p className="ctl-anchors">
            <span>{lowText}</span>
            <span>{highText}</span>
          </p>
        ))}
    </div>
  );
}

function SingleControl({ item, a, onAnswer }: ControlProps): JSX.Element {
  return (
    <>
      {(item.options ?? []).map((opt) => (
        <label key={opt} className={`ctl-choice${a === opt ? ' on' : ''}`}>
          <input
            type="radio"
            name={`q_${item.id}`}
            checked={a === opt}
            onChange={() => onAnswer(opt)}
          />
          <span>{opt}</span>
        </label>
      ))}
    </>
  );
}

function YesNoControl({ item, a, onAnswer }: ControlProps): JSX.Element {
  const cur: YesNoAnswer =
    a && typeof a === 'object' && 'v' in (a as object) ? (a as YesNoAnswer) : { v: '' };
  return (
    <>
      {['Yes', 'No'].map((opt) => (
        <label key={opt} className={`ctl-choice${cur.v === opt ? ' on' : ''}`}>
          <input
            type="radio"
            name={`q_${item.id}`}
            checked={cur.v === opt}
            onChange={() => onAnswer({ v: opt, detail: cur.detail })}
          />
          <span>{opt}</span>
        </label>
      ))}
      {item.conditionalDetailOn && cur.v === item.conditionalDetailOn && (
        <div className="ctl-detail">
          <label htmlFor={`d_${item.id}`}>Briefly, what happened?</label>
          <textarea
            id={`d_${item.id}`}
            value={cur.detail ?? ''}
            onChange={(e) => onAnswer({ v: cur.v, detail: e.target.value })}
          />
        </div>
      )}
    </>
  );
}

function SelectControl({ item, a, onAnswer }: ControlProps): JSX.Element {
  const cap = item.selectUpToN ?? 3;
  const withGreatest = !!item.selectThenGreatest;
  const picked: string[] = Array.isArray(a)
    ? (a as string[])
    : ((a as SelectGreatestAnswer | undefined)?.picked ?? []);
  const greatest = (a as SelectGreatestAnswer | undefined)?.greatest;

  function emit(next: string[], g?: string): void {
    onAnswer(withGreatest ? { picked: next, greatest: g } : next);
  }

  return (
    <>
      <p className="ctl-count">
        Up to {cap}. {picked.length} chosen.
      </p>
      {(item.options ?? []).map((opt) => {
        const on = picked.includes(opt);
        return (
          <label key={opt} className={`ctl-choice${on ? ' on' : ''}`}>
            <input
              type="checkbox"
              checked={on}
              disabled={!on && picked.length >= cap}
              onChange={() => {
                const next = toggleSelect(picked, opt, cap);
                emit(next, greatest && next.includes(greatest) ? greatest : undefined);
              }}
            />
            <span>{opt}</span>
          </label>
        );
      })}
      {withGreatest && picked.length > 0 && (
        <div className="ctl-then">
          <p className="ctl-count">Of those, which carries the greatest consequence?</p>
          {picked.map((opt) => (
            <label key={opt} className={`ctl-choice${greatest === opt ? ' on' : ''}`}>
              <input
                type="radio"
                name={`g_${item.id}`}
                checked={greatest === opt}
                onChange={() => emit(picked, opt)}
              />
              <span>{opt}</span>
            </label>
          ))}
        </div>
      )}
    </>
  );
}

function MultiControl({ item, a, onAnswer }: ControlProps): JSX.Element {
  const cur: string[] = Array.isArray(a) ? (a as string[]) : [];
  return (
    <>
      {(item.options ?? []).map((opt) => {
        const on = cur.includes(opt);
        return (
          <label key={opt} className={`ctl-choice${on ? ' on' : ''}`}>
            <input
              type="checkbox"
              checked={on}
              onChange={() => {
                const next = cur.slice();
                const at = next.indexOf(opt);
                if (at > -1) next.splice(at, 1);
                else next.push(opt);
                onAnswer(next);
              }}
            />
            <span>{opt}</span>
          </label>
        );
      })}
    </>
  );
}

function RankControl({ item, a, onAnswer }: ControlProps): JSX.Element {
  const n = item.rankExactlyN ?? 3;
  const cur: string[] = Array.isArray(a) ? (a as string[]) : [];
  return (
    <>
      <p className="ctl-count">
        {cur.length === n
          ? `${n} chosen, in order. Tap one again to remove it.`
          : `Tap them in order, most significant first. ${cur.length} of ${n}.`}
      </p>
      {(item.options ?? []).map((opt) => {
        const at = cur.indexOf(opt);
        return (
          <button
            key={opt}
            type="button"
            className={`ctl-choice${at > -1 ? ' on' : ''}`}
            onClick={() => onAnswer(toggleRank(cur, opt, n))}
          >
            {at > -1 && <span className="ctl-rankno">{at + 1}</span>}
            <span>{opt}</span>
          </button>
        );
      })}
    </>
  );
}

function GridControl({ item, a, onAnswer }: ControlProps): JSX.Element {
  const narrow = useNarrow();
  const cur: GridAnswer = a && typeof a === 'object' ? (a as GridAnswer) : {};
  const cols = item.gridDimensions ? Object.keys(item.gridDimensions) : ['Rating'];
  const rows = item.gridRows ?? [];

  function optionsFor(col: string): string[] {
    if (item.gridDimensions) return item.gridDimensions[col] ?? [];
    if (item.gridScale) {
      const out: string[] = [];
      for (let i = item.gridScale.min; i <= item.gridScale.max; i++) out.push(String(i));
      return out;
    }
    return item.options ?? [];
  }

  function set(row: string, col: string, value: string): void {
    const next: GridAnswer = JSON.parse(JSON.stringify(cur));
    next[row] = { ...(next[row] ?? {}), [col]: value };
    onAnswer(next);
  }

  // A plain render function, not a nested component: a component declared in
  // here is a new type on every render, so React would remount every select
  // after each answer and drop keyboard focus to the page body.
  function renderSelect(row: string, col: string): JSX.Element {
    return (
      <select
        aria-label={`${row} — ${col}`}
        value={cur[row]?.[col] ?? ''}
        onChange={(e) => set(row, col, e.target.value)}
      >
        <option value="">Choose…</option>
        {optionsFor(col).map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }

  if (narrow) {
    return (
      <>
        {rows.map((row) => (
          <div key={row} className="ctl-gridcard">
            <p className="ctl-gridrow">{row}</p>
            {cols.map((c) => (
              <div key={c} className="ctl-gridfield">
                {(item.gridDimensions || cols.length > 1) && <label>{c}</label>}
                {renderSelect(row, c)}
              </div>
            ))}
          </div>
        ))}
      </>
    );
  }

  return (
    <div className="ctl-gridwrap">
      <table>
        <thead>
          <tr>
            <th scope="col" />
            {cols.map((c) => (
              <th key={c} scope="col">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row}>
              <th scope="row">{row}</th>
              {cols.map((c) => (
                <td key={c}>{renderSelect(row, c)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OpenControl({ item, a, onAnswer }: ControlProps): JSX.Element {
  return (
    <textarea
      className="ctl-open"
      aria-label={item.text}
      value={typeof a === 'string' ? a : ''}
      onChange={(e) => onAnswer(e.target.value)}
    />
  );
}

const CONTROLS: Record<SurveyItem['kind'], (p: ControlProps) => JSX.Element> = {
  scale: ScaleControl,
  single: SingleControl,
  yesno: YesNoControl,
  select: SelectControl,
  multi: MultiControl,
  rank: RankControl,
  grid: GridControl,
  open: OpenControl,
};

/**
 * Renders the correct control for an item and the optional comment box. The
 * control only ever reads/writes the answer half; the comment box only the
 * comment half — the canonical {a, c} envelope is applied here at the boundary,
 * and each writer reads the *current* other half (functional state update).
 */
export function ItemControl({
  item,
  value,
  onChange,
}: {
  item: SurveyItem;
  value: unknown;
  onChange: (next: unknown) => void;
}): JSX.Element {
  const Control = CONTROLS[item.kind];
  const cur = getCanonical(value);
  return (
    <div data-qid={item.id}>
      <Control item={item} a={cur.a} onAnswer={(ans) => onChange(setAnswer(value, ans))} />
      {item.hasOptionalComment && item.kind !== 'open' && (
        <div className="ctl-comment">
          <label htmlFor={`c_${item.id}`}>
            Anything you want to add <span className="opt">— optional</span>
          </label>
          <textarea
            id={`c_${item.id}`}
            value={cur.c}
            onChange={(e) => onChange(setComment(value, e.target.value))}
          />
        </div>
      )}
    </div>
  );
}
