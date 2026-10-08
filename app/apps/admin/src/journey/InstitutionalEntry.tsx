import { useState } from 'react';
import { journeyApi, type ParticipatingFirm } from './journeyClient';
import { ApiError } from '../api/types';

/**
 * Institutional / regulator entry (UX-INS-001/002, and UX-INS-003 as ONE
 * implementation with three regulator variants). Question content is bound to
 * the Phase 2 Register by instrument code — never transcribed here. The
 * institution name is collected for grouping only and is never published; a
 * colleague's responses are independent and not linked to the inviter.
 */

export type RegulatorVariant = 'I-SEC' | 'I-NGX' | 'I-CSCS' | 'I-DEP';

/** What a respondent sees on the review selector — never the raw instrument code. */
export const VARIANT_LABEL: Record<RegulatorVariant, string> = {
  'I-SEC': 'SEC',
  'I-NGX': 'NGX',
  'I-CSCS': 'CSCS',
  'I-DEP': 'Depository',
};

const VARIANTS: Record<RegulatorVariant, { title: string; blurb: string }> = {
  'I-SEC': {
    title: 'Securities & Exchange Commission review',
    blurb: 'Your institution’s view of the market’s regulatory environment.',
  },
  'I-NGX': {
    title: 'Nigerian Exchange (NGX) review',
    blurb: 'Your institution’s view of the exchange and its market operations.',
  },
  'I-CSCS': {
    title: 'CSCS review',
    blurb: 'Your institution’s view of clearing, settlement and depository services.',
  },
  'I-DEP': {
    title: 'Depository review',
    blurb: 'Your institution’s view of depository and securities-account services.',
  },
};

export function InstitutionalEntry({
  editionId,
  instrumentCode,
  onStarted,
  isColleagueInvite,
}: {
  editionId: string;
  instrumentCode: string;
  onStarted: (respondentId: string, firms: ParticipatingFirm[]) => void;
  isColleagueInvite?: boolean;
}): JSX.Element {
  const variant = (VARIANTS as Record<string, { title: string; blurb: string }>)[instrumentCode];
  const [institutionName, setInstitutionName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function begin(): Promise<void> {
    setError(null);
    if (!institutionName.trim()) {
      setError('Please enter your institution’s name.');
      return;
    }
    setBusy(true);
    try {
      const { respondentId } = isColleagueInvite
        ? await journeyApi.colleagueInvite({
            editionId,
            instrumentCode,
            institutionName: institutionName.trim(),
          })
        : await journeyApi.start({
            editionId,
            instrumentCode,
            institutionName: institutionName.trim(),
          });
      // Institutional journeys rate no firms — the shared shell handles the
      // firm-less sequence identically.
      onStarted(respondentId, []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start the survey');
      setBusy(false);
    }
  }

  return (
    <div className="journey">
      <p className="eyebrow">Institutional review</p>
      <h1 tabIndex={-1}>{variant ? variant.title : 'Institutional questionnaire'}</h1>
      <p className="lede">{variant ? variant.blurb : 'Your institution’s view.'}</p>

      <div className="field">
        <label htmlFor="inst-entry-name">Your institution’s name</label>
        <input
          id="inst-entry-name"
          value={institutionName}
          onChange={(e) => setInstitutionName(e.target.value)}
        />
      </div>
      <p className="lede" style={{ fontSize: 13 }}>
        Used only to group responses from the same institution — it is never published, and your
        answers are not linked to any colleague’s.
      </p>

      {error && <div className="err">{error}</div>}

      <div className="actions">
        <button type="button" className="btn" onClick={() => void begin()} disabled={busy}>
          {busy ? 'Starting…' : 'Start'}
        </button>
      </div>
    </div>
  );
}
