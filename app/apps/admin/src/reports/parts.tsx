import type { ReactNode } from 'react';
import type {
  ReportIndexScore,
  ReportIndices,
  ReportNarrativeView,
  ReportPending,
  ReportRating,
} from '../api/types';
import './report.css';

/** Below this many responses a figure is withheld, never shown (the study floor). */
export const FLOOR = 10;

export function Brand(): JSX.Element {
  return (
    <div className="rpt-brand">
      CIS<span>–</span>DRAGNET
    </div>
  );
}

export function Toolbar({
  onBack,
  title,
  children,
}: {
  onBack?: (() => void) | undefined;
  title: string;
  children?: ReactNode;
}): JSX.Element {
  return (
    <div className="rpt-toolbar">
      {onBack ? (
        <button type="button" className="btn-2 small" onClick={onBack}>
          ← Back
        </button>
      ) : (
        <span />
      )}
      <span style={{ fontWeight: 700 }}>{title}</span>
      <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>{children}</span>
    </div>
  );
}

/** The checked AI sentences for one section, as a paragraph — or nothing. */
export function Prose({
  narrative,
  section,
  lead = false,
}: {
  narrative: ReportNarrativeView | null;
  section: string;
  lead?: boolean;
}): JSX.Element | null {
  const text = (narrative?.sentences ?? [])
    .filter((s) => s.section === section && s.finding === null)
    .map((s) => s.text)
    .join(' ');
  if (!text) return null;
  return <p className={lead ? 'rpt-lead' : undefined}>{text}</p>;
}

/**
 * Regenerate the AI narrative (operator only, until the document is published)
 * and download the finished PDF. The PDF waits for a narrative: it is the
 * finished document, never figures alone.
 */
export function NarrativeControls({
  narrative,
  busy,
  onGenerate,
  onDownload,
}: {
  narrative: ReportNarrativeView | null;
  busy: 'generating' | 'downloading' | 'publishing' | null;
  onGenerate?: (() => void) | undefined;
  onDownload: () => void;
}): JSX.Element {
  return (
    <>
      {onGenerate && (
        <button type="button" className="btn-2 small" disabled={busy !== null} onClick={onGenerate}>
          {busy === 'generating'
            ? 'Drafting with AI…'
            : narrative
              ? 'Regenerate AI narrative'
              : 'Generate AI narrative'}
        </button>
      )}
      <button
        type="button"
        className="btn small"
        disabled={busy !== null || !narrative}
        title={narrative ? undefined : 'Available once the analysis has been written'}
        onClick={onDownload}
      >
        {busy === 'downloading' ? 'Preparing PDF…' : 'Download PDF'}
      </button>
    </>
  );
}

/**
 * A failed action; and, for the operator, that drafting is under way or that
 * there is nothing to write about yet.
 */
export function NarrativeStatus({
  narrative,
  error,
  drafting,
  operator = true,
}: {
  narrative: ReportNarrativeView | null;
  error: string | null;
  drafting: boolean;
  operator?: boolean;
}): JSX.Element | null {
  if (error) {
    return (
      <div className="rpt-draft-banner">
        <div className="err" style={{ margin: 0 }}>
          {error}
        </div>
      </div>
    );
  }
  if (!operator) return null;
  if (drafting && !narrative) {
    return (
      <div className="rpt-draft-banner">
        Writing the analysis from these figures — this takes about a minute. The figures below are
        final.
      </div>
    );
  }
  if (!narrative) {
    return (
      <div className="rpt-draft-banner">
        Too few responses to write about yet — the analysis will be written automatically once there
        are.
      </div>
    );
  }
  return null;
}

/** Save a downloaded file under the given name. */
export function saveFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function SectionHead({
  eyebrow,
  title,
  standfirst,
}: {
  eyebrow: string;
  title: string;
  standfirst?: string;
}): JSX.Element {
  return (
    <>
      <p className="rpt-eyebrow">{eyebrow}</p>
      <h2>{title}</h2>
      {standfirst && <p className="rpt-standfirst">{standfirst}</p>}
    </>
  );
}

export function PendingPanel({
  pending,
  title,
}: {
  pending: ReportPending;
  title?: string;
}): JSX.Element {
  return (
    <div className="rpt-pending">
      <b>{title ?? 'Pending methodology sign-off'}</b>
      {pending.note}
    </div>
  );
}

export function Withheld({ what }: { what: string }): JSX.Element {
  return (
    <div className="rpt-pending">
      <b>Too few responses to report</b>
      Fewer than {FLOOR} {what} answered, so this is withheld rather than shown — a figure from so
      few responses would say more about the individuals than about the profession.
    </div>
  );
}

/**
 * One horizontal bar on 0–100. `marker` draws the anonymised benchmark on the
 * same track; a withheld rating (null) shows as withheld, never as zero.
 */
export function Bar({
  label,
  value,
  tone = 'blue',
  suffix = '',
  marker,
  markerLabel,
  compareText,
}: {
  label: string;
  value: number | null;
  tone?: 'blue' | 'rust' | 'green' | 'gold';
  suffix?: string;
  marker?: number | null | undefined;
  markerLabel?: string | undefined;
  compareText?: string | undefined;
}): JSX.Element {
  return (
    <div className="rpt-bar">
      <span className="lab">{label}</span>
      <span className="track">
        {value !== null && (
          <span
            className={`fill ${tone === 'blue' ? '' : tone}`}
            style={{ width: `${Math.max(2, Math.min(100, value))}%`, display: 'block' }}
          />
        )}
        {marker !== undefined && marker !== null && (
          <>
            <span className="mark" style={{ left: `${marker}%` }} />
            {markerLabel && (
              <span className="mark-label" style={{ left: `${marker}%` }}>
                {markerLabel}
              </span>
            )}
          </>
        )}
      </span>
      {value === null ? (
        <span className="num withheld">withheld</span>
      ) : (
        <span className="num">
          {value}
          {suffix}
          {compareText && <small> / {compareText}</small>}
        </span>
      )}
    </div>
  );
}

/** A rating's display value, or the reason it is not shown. */
export function show(r: ReportRating): string {
  return r.value === null ? `withheld (n=${r.n})` : String(r.value);
}

export const gapOf = (a: ReportRating, b: ReportRating): number | null =>
  a.value === null || b.value === null ? null : a.value - b.value;

/** A gap with its direction always visible: +17, −4, 0, or — when withheld. */
export const signed = (gap: number | null): string =>
  gap === null ? '—' : gap > 0 ? `+${gap}` : gap < 0 ? `−${Math.abs(gap)}` : '0';

/** A signed gap pill: up (green), down (rust), or within the margin (grey). */
export function GapPill({ gap, margin = 0 }: { gap: number | null; margin?: number }): JSX.Element {
  if (gap === null) return <span className="gap-pill even">—</span>;
  const cls = gap === 0 || Math.abs(gap) < margin ? 'even' : gap > 0 ? 'up' : '';
  return (
    <span className={`gap-pill ${cls}`}>
      {gap > 0 ? '+' : gap < 0 ? '−' : ''}
      {Math.abs(gap)}
    </span>
  );
}

export function Cover({
  eyebrow,
  title,
  sub,
  right,
  prepared,
  watermark,
  meta,
}: {
  eyebrow: string;
  title: ReactNode;
  sub: string;
  right: ReactNode;
  prepared?: string;
  watermark: string;
  meta: Array<[string, string]>;
}): JSX.Element {
  return (
    <div className="rpt-cover">
      <div className="rpt-watermark" aria-hidden="true">
        {watermark}
      </div>
      <div className="rpt-mast">
        <Brand />
        {right}
      </div>
      <p className="rpt-eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      {prepared && <p className="rpt-prepared">Prepared for: {prepared}</p>}
      <p className="rpt-sub">{sub}</p>
      <div className="rpt-meta">
        {meta.map(([k, v]) => (
          <span key={k}>
            <b>{k}</b>
            {v}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * The five index scores as cards — the signed run's figures under the approved
 * methodology, or "Pending" with the notice while it is not approved. `compare`
 * (firm report) shows the industry figure beside the firm's own.
 */
export function IndexCards({
  indices,
  scores,
  compare,
}: {
  indices: ReportIndices;
  scores: ReportIndexScore[] | null;
  compare?: ReportIndexScore[] | undefined;
}): JSX.Element {
  if (indices.state !== 'reported' || !scores) {
    return (
      <>
        <div className="rpt-cards">
          {['OMI', 'DMI', 'IEI', 'ICI', 'SEI'].map((k) => (
            <div key={k}>
              <div className="k">{k}</div>
              <div className="v">Pending</div>
              <div className="s">Methodology sign-off</div>
            </div>
          ))}
        </div>
        {indices.state !== 'reported' && <PendingPanel pending={indices} />}
      </>
    );
  }
  return (
    <>
      <div className="rpt-cards">
        {scores.map((x) => {
          const other = compare?.find((y) => y.code === x.code);
          return (
            <div key={x.code}>
              <div className="k">
                {x.code} · {x.name}
              </div>
              <div className="v">{x.value === null ? '—' : x.value}</div>
              <div className="s">
                {other
                  ? `Industry ${other.value === null ? '—' : other.value}`
                  : x.value === null
                    ? 'Not calculable'
                    : 'of 100'}
              </div>
            </div>
          );
        })}
      </div>
      <ul className="rpt-note" style={{ paddingLeft: 18 }}>
        {scores
          .filter((x) => x.note)
          .map((x) => (
            <li key={x.code}>
              <b>{x.code}:</b> {x.note}
            </li>
          ))}
      </ul>
      <p className="rpt-note">
        Scored 0–100 by the approved methodology ({indices.methodology}), from the signed scoring
        run.
      </p>
    </>
  );
}
