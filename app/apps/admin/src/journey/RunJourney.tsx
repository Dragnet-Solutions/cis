import { useEffect, useState } from 'react';
import { JourneyShell } from './JourneyShell';
import { journeyApi, type ParticipatingFirm, type ResumeState } from './journeyClient';
import { ApiError } from '../api/types';

/**
 * Loads a journey's resume state (items, saved drafts, and — crucially — the
 * exact firm context the respondent left off at) and hands it to the one shared
 * shell. Used for both a freshly-started journey and a resumed one, so resume is
 * not a separate code path.
 */
export function RunJourney({
  respondentId,
  firms,
  onSubmitted,
}: {
  respondentId: string;
  firms: ParticipatingFirm[];
  onSubmitted: () => void;
}): JSX.Element {
  const [state, setState] = useState<ResumeState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const s = await journeyApi.resume(respondentId);
        if (!cancelled) setState(s);
      } catch (err) {
        if (!cancelled)
          setError(err instanceof ApiError ? err.message : 'Could not load the survey');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [respondentId]);

  if (error) return <div className="err">{error}</div>;
  if (!state) return <p className="lede">Loading your survey…</p>;

  const firmsById: Record<string, ParticipatingFirm> = {};
  for (const f of firms) firmsById[f.id] = f;

  return (
    <JourneyShell
      respondentId={respondentId}
      items={state.items}
      ratedFirmIds={state.respondent.ratedFirmIds}
      firmsById={firmsById}
      initialDrafts={state.drafts}
      initialStep={state.respondent.resumeStep}
      onSubmitted={onSubmitted}
    />
  );
}
