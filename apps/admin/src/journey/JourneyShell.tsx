import { useMemo, useRef, useState } from 'react';
import {
  buildJourneySequence,
  firmContextAt,
  isAnswered,
  outstanding,
  type SurveyItem,
} from '@cis/survey';
import { ItemControl } from '../renderer/controls';
import { journeyApi, type DraftRow, type ParticipatingFirm } from './journeyClient';
import { ApiError } from '../api/types';

const key = (qid: string, firmId: string | null): string => `${qid}::${firmId ?? ''}`;

/**
 * THE journey shell — one implementation, reused by every survey-taking journey
 * (S1–S5b and the three institutional instruments). It never hardcodes an
 * instrument: it takes the item set and the chosen rated firms and drives them
 * through the single shared sequencing function (buildJourneySequence), so the
 * multi-firm loop, the shared-then-per-firm ordering, and resume-with-firm-
 * context are identical everywhere.
 *
 * Rules enforced here (not per-instrument):
 *  - one question at a time; a mandatory answer blocks progression (outstanding);
 *  - NO save control — every change autosaves as a draft;
 *  - submission is final only via an explicit review-before-submit step.
 */
export function JourneyShell({
  respondentId,
  items,
  ratedFirmIds,
  firmsById,
  initialDrafts,
  initialStep,
  onSubmitted,
}: {
  respondentId: string;
  items: SurveyItem[];
  ratedFirmIds: string[];
  firmsById: Record<string, ParticipatingFirm>;
  initialDrafts: DraftRow[];
  initialStep: number;
  onSubmitted: () => void;
}): JSX.Element {
  const sequence = useMemo(() => buildJourneySequence(items, ratedFirmIds), [items, ratedFirmIds]);

  const [answers, setAnswers] = useState<Record<string, { a: unknown; c?: string }>>(() => {
    const seed: Record<string, { a: unknown; c?: string }> = {};
    for (const d of initialDrafts) seed[key(d.questionId, d.ratedFirmId)] = d.answer;
    return seed;
  });
  const [step, setStep] = useState(() =>
    Math.min(Math.max(initialStep, 0), Math.max(sequence.length - 1, 0)),
  );
  const [reviewing, setReviewing] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const saveSeq = useRef(0);
  const latest = useRef<
    Record<
      string,
      { qid: string; firmId: string | null; answer: { a: unknown; c?: string }; step: number }
    >
  >({});
  const queue = useRef<Record<string, Promise<void>>>({});
  const failed = useRef<Set<string>>(new Set());

  if (sequence.length === 0) {
    return <p className="lede">This survey has no questions.</p>;
  }

  const current = sequence[step]!;
  const value = answers[key(current.item.id, current.ratedFirmId)];
  const answered = isAnswered(current.item, value);
  const why = outstanding(current.item, value);
  const fc = firmContextAt(sequence, step);
  const firmName =
    current.ratedFirmId && firmsById[current.ratedFirmId]
      ? firmsById[current.ratedFirmId]!.displayName
      : null;

  // Autosave, made safe for flaky connections:
  //  - saves for the same answer run one after another, and each sends the
  //    NEWEST value when it runs, so an older save can never land last;
  //  - a save that fails is remembered and re-sent before submitting, so the
  //    server never holds less than the respondent sees on screen.
  function persist(
    qid: string,
    firmId: string | null,
    next: { a: unknown; c?: string },
    atStep: number,
  ): void {
    const k = key(qid, firmId);
    latest.current[k] = { qid, firmId, answer: next, step: atStep };
    const mine = (saveSeq.current += 1);
    setSaveState('saving');
    const run = (queue.current[k] ?? Promise.resolve()).then(() => saveLatest(k));
    queue.current[k] = run.catch(() => undefined);
    run.then(
      () => {
        if (saveSeq.current === mine) setSaveState('saved');
      },
      (err: unknown) => {
        if (saveSeq.current === mine) {
          setSaveState('error');
          setError(err instanceof ApiError ? err.message : 'Could not save your answer');
        }
      },
    );
  }

  async function saveLatest(k: string): Promise<void> {
    const l = latest.current[k];
    if (!l) return;
    try {
      await journeyApi.saveAnswer(respondentId, {
        questionId: l.qid,
        ratedFirmId: l.firmId,
        answer: l.answer,
        step: l.step,
      });
      failed.current.delete(k);
    } catch (err) {
      failed.current.add(k);
      throw err;
    }
  }

  function onChange(next: unknown): void {
    const envelope = next as { a: unknown; c?: string };
    const k = key(current.item.id, current.ratedFirmId);
    setAnswers((prev) => ({ ...prev, [k]: envelope }));
    void persist(current.item.id, current.ratedFirmId, envelope, step);
  }

  function goNext(): void {
    if (!answered) return;
    if (step + 1 < sequence.length) setStep(step + 1);
    else setReviewing(true);
  }
  function goBack(): void {
    if (reviewing) {
      setReviewing(false);
      return;
    }
    if (step > 0) setStep(step - 1);
  }

  async function doSubmit(): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      // Let in-flight saves settle, then re-send any that failed, so the
      // server's copy matches what the review screen just showed.
      await Promise.all(Object.values(queue.current));
      for (const k of [...failed.current]) await saveLatest(k);
      await journeyApi.submit(respondentId);
      onSubmitted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not submit');
      setSubmitting(false);
    }
  }

  // ── Review-before-submit ─────────────────────────────────────────────────────
  if (reviewing) {
    const gaps = sequence.filter(
      (s) => !isAnswered(s.item, answers[key(s.item.id, s.ratedFirmId)]),
    );
    return (
      <div className="journey">
        <p className="eyebrow">Before you send</p>
        <h1 tabIndex={-1}>Review your answers</h1>
        <p className="lede">
          Nothing is sent until you choose to. Once sent, your answers are final.
        </p>
        {gaps.length > 0 ? (
          <>
            <div className="err">
              {gaps.length} {gaps.length === 1 ? 'question still needs' : 'questions still need'} an
              answer.
            </div>
            <ul className="review-gaps">
              {gaps.map((s) => (
                <li key={key(s.item.id, s.ratedFirmId)}>
                  <button
                    type="button"
                    className="textlink"
                    onClick={() => {
                      setReviewing(false);
                      setStep(sequence.indexOf(s));
                    }}
                  >
                    {s.item.text}
                    {s.ratedFirmId && firmsById[s.ratedFirmId]
                      ? ` — ${firmsById[s.ratedFirmId]!.displayName}`
                      : ''}
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="lede">Everything is answered. You can send your responses now.</p>
        )}
        {error && <div className="err">{error}</div>}
        <div className="actions">
          <button type="button" className="btn-2" onClick={goBack} disabled={submitting}>
            Back
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => void doSubmit()}
            disabled={gaps.length > 0 || submitting}
          >
            {submitting ? 'Sending…' : 'Send my responses'}
          </button>
        </div>
      </div>
    );
  }

  // ── One question at a time ────────────────────────────────────────────────────
  return (
    <div className="journey">
      <div className="journey-progress" aria-hidden="true">
        Question {step + 1} of {sequence.length}
      </div>
      {firmName && (
        <p className="eyebrow">
          About {firmName} {fc.firmCount > 1 ? `· firm ${fc.firmIndex} of ${fc.firmCount}` : ''}
        </p>
      )}
      <div className="qcard">
        <div className="qbody">
          <p className="qtext">{current.item.text}</p>
          <ItemControl item={current.item} value={value} onChange={onChange} />
          {!answered && <p className="qstate out">{why}</p>}
        </div>
      </div>
      <div className="save-indicator" aria-live="polite">
        {saveState === 'saving' && 'Saving…'}
        {saveState === 'saved' && 'Saved'}
        {saveState === 'error' && 'Not saved'}
      </div>
      {error && <div className="err">{error}</div>}
      <div className="actions">
        <button type="button" className="btn-2" onClick={goBack} disabled={step === 0}>
          Back
        </button>
        <button type="button" className="btn" onClick={goNext} disabled={!answered}>
          {step + 1 < sequence.length ? 'Next' : 'Review'}
        </button>
      </div>
    </div>
  );
}
