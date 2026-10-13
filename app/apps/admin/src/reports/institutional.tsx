import type { InstitutionalReading, ReportNarrativeView } from '../api/types';

/**
 * One institution's reading, as a card (Institutional Perspectives, and section
 * 10 of the Industry report). Each instrument is worded for its institution's
 * own mandate, so the card's labels follow the institution's family.
 */

const LENS: Record<string, string> = {
  A: 'Supervision',
  B: 'Trading & membership',
  C: 'Clearing & settlement',
  D: 'Depository & records',
};

const LABELS: Record<string, { freq: string; marks: string; consequence: string }> = {
  A: {
    freq: 'Deficiencies requiring follow-up',
    marks: 'Marks of a firm that performs well',
    consequence: 'Greatest consequence for investor protection',
  },
  B: {
    freq: 'Weaknesses creating exceptions',
    marks: 'Marks of a firm that interacts efficiently',
    consequence: 'Greatest consequence for exchange efficiency',
  },
  C: {
    freq: 'Weaknesses creating exceptions',
    marks: 'Marks of a firm that settles smoothly',
    consequence: 'Greatest consequence for settlement',
  },
  D: {
    freq: 'Exceptions requiring intervention',
    marks: 'Marks of a firm that works well',
    consequence: 'Greatest consequence for account records',
  },
};

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
  const labels = LABELS[r.familyCode] ?? LABELS['D']!;
  const paraphrase = (narrative?.sentences ?? [])
    .filter((s) => s.section === `INST_${r.key}` && s.finding === null)
    .map((s) => s.text)
    .join(' ');
  return (
    <div className="rpt-icard">
      <div className="head">
        <h3>{r.role}</h3>
        <span className="lens">{LENS[r.familyCode] ?? r.familyCode}</span>
      </div>
      <div className="grid">
        <div>
          <p className="k">Most frequently cited issue</p>
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
          <p className="k">{labels.freq}</p>
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
              Overall assessment of the profession’s operational capability:{' '}
              <b>{r.capability.toLowerCase()}</b>.
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
