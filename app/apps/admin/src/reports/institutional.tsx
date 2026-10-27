import type { InstitutionalReading, ReportNarrativeView } from '../api/types';

/**
 * One institution's reading, as a card (Institutional Perspectives, and section
 * 10 of the Industry report). Each instrument is worded for its institution's
 * own mandate, so every label on the card is that instrument's own question,
 * read from the Register — never a fixed per-family label, which misdescribed
 * any institution the family wording did not fit (an LCFE card reading
 * "exchange efficiency").
 */

const COUNT_WORDS = [
  'no',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
];
/** A count in words ("six"), or digits past ten. */
export const inWords = (n: number): string => COUNT_WORDS[n] ?? String(n);
const capFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Institutions that responded but have no reading: their scope question (Q0
 * "Rare" / "Effectively none") closed the survey. They count as contributing
 * and are described as out of scope, so "six contributed" never sits beside
 * five readings unexplained (BUG-17).
 */
export function outOfScope<T extends { name: string }>(
  contributors: T[],
  readings: InstitutionalReading[],
): T[] {
  const read = new Set(readings.map((r) => r.role));
  return contributors.filter((c) => !read.has(c.name));
}

const listCodes = (xs: string[]) =>
  xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;

/** The neutral note for institutions out of scope this edition, or null. */
export function outOfScopeNote(codes: string[]): string | null {
  if (codes.length === 0) return null;
  const one = codes.length === 1;
  return `${listCodes(codes)} responded, but reported too little direct operational contact with stockbroking firms this edition to give a reading. ${one ? 'It is' : 'They are'} counted as contributing; no reading is shown for ${one ? 'it' : 'them'}.`;
}

/**
 * The participation sentence: contributed, then how many gave a reading, so the
 * counts always agree with the readings shown.
 */
export function participationLine(
  p: { invited: number; contributed: number },
  readingCount: number,
  outOfScopeCodes: string[],
): string {
  if (p.invited === 0) return 'No institution has been invited to give a reading yet.';
  const base = `${capFirst(inWords(p.contributed))} of ${inWords(p.invited)} invited institution${p.invited === 1 ? '' : 's'} contributed.`;
  if (outOfScopeCodes.length === 0) return base;
  return `${base} ${capFirst(inWords(readingCount))} gave a reading; ${listCodes(outOfScopeCodes)} ${outOfScopeCodes.length === 1 ? 'was' : 'were'} out of scope this edition.`;
}

/** Neutral labels for a reading frozen before per-instrument labels existed. */
const NEUTRAL_LABELS = {
  issue: 'Most frequently cited issue',
  frequency: 'How often weaknesses need its attention',
  marks: 'Marks of a firm that works well with it',
  consequence: 'Greatest consequence',
  capability: 'Overall assessment of the profession’s operational capability',
};

/** The card's labels: the reading's own instrument wording where present. */
export function cardLabels(r: InstitutionalReading): typeof NEUTRAL_LABELS {
  const own = r.labels;
  return {
    issue: own?.issue || NEUTRAL_LABELS.issue,
    frequency: own?.frequency || NEUTRAL_LABELS.frequency,
    marks: own?.marks || NEUTRAL_LABELS.marks,
    consequence: own?.consequence || NEUTRAL_LABELS.consequence,
    capability: own?.capability || NEUTRAL_LABELS.capability,
  };
}

/** Section 10 groups readings by role (the instruments document: with six
 *  institutions, the section groups by role rather than listing individually).
 *  Groups keep the order in which roles first appear. */
export function groupByRole(
  readings: InstitutionalReading[],
): Array<{ role: string; readings: InstitutionalReading[] }> {
  const groups: Array<{ role: string; readings: InstitutionalReading[] }> = [];
  for (const r of readings) {
    const role = r.roleLabel ?? 'Market institutions';
    let g = groups.find((x) => x.role === role);
    if (!g) {
      g = { role, readings: [] };
      groups.push(g);
    }
    g.readings.push(r);
  }
  return groups;
}

/** All readings, grouped by role, each group headed by its role. */
export function InstitutionGroups({
  readings,
  narrative,
}: {
  readings: InstitutionalReading[];
  narrative: ReportNarrativeView | null;
}): JSX.Element {
  return (
    <>
      {groupByRole(readings).map((g) => (
        <div key={g.role} className="rpt-igroup">
          <p className="rpt-eyebrow">{g.role}</p>
          {g.readings.map((r) => (
            <InstitutionCard key={r.key} reading={r} narrative={narrative} />
          ))}
        </div>
      ))}
    </>
  );
}

const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const joined = (xs: string[]) =>
  xs.length <= 1
    ? (xs[0] ?? '')
    : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`.toLowerCase();

export function InstitutionCard({
  reading: r,
  narrative,
}: {
  reading: InstitutionalReading;
  narrative: ReportNarrativeView | null;
}): JSX.Element {
  const labels = cardLabels(r);
  const paraphrase = (narrative?.sentences ?? [])
    .filter((s) => s.section === `INST_${r.key}` && s.finding === null)
    .map((s) => s.text)
    .join(' ');
  return (
    <div className="rpt-icard">
      <div className="head">
        <h3>{r.role}</h3>
        <span className="lens">{r.vantage}</span>
      </div>
      <div className="grid">
        <div>
          <p className="k">{labels.issue}</p>
          <p>
            {r.issue.greatest ? (
              <>
                <b>{sentence(r.issue.greatest)}</b>
                {r.issue.others.length > 0 && <>, alongside {joined(r.issue.others)}</>}.
              </>
            ) : (
              'No recurring issue named.'
            )}
          </p>
        </div>
        <div>
          <p className="k">{labels.frequency}</p>
          <p>{r.frequency ? <b>{r.frequency}</b> : 'Not stated.'}</p>
        </div>
        <div>
          <p className="k">{labels.marks}</p>
          <p>{r.marks.length ? `${sentence(joined(r.marks))}.` : 'Not stated.'}</p>
        </div>
        <div>
          <p className="k">{labels.consequence}</p>
          <p>
            {r.consequence.greatest ? <b>{sentence(r.consequence.greatest)}</b> : 'Not stated.'}
          </p>
        </div>
      </div>
      {(paraphrase || r.capability) && (
        <div className="foot">
          {paraphrase && <p className="para">{paraphrase}</p>}
          {r.capability && (
            <p className="cap">
              {labels.capability} <b>{sentence(r.capability)}</b>.
            </p>
          )}
          {paraphrase && (
            <p className="tag">Our characterisation of the {r.code} vantage · not a quotation</p>
          )}
        </div>
      )}
    </div>
  );
}
