import { useEffect, useMemo, useRef, useState } from 'react';
import {
  applyScopeGate,
  buildJourneySequence,
  closesScope,
  describeAnswer,
  firmContextAt,
  getCanonical,
  isAnswered,
  outstanding,
  resumeStepOf,
  type SurveyItem,
} from '@cis/survey';
import { ItemControl } from '../renderer/controls';
import { afterSave, type AfterSave } from './scopeClose';
import {
  isAlreadySubmitted,
  journeyApi,
  type DraftRow,
  type ParticipatingFirm,
  type SavedAnswer,
} from './journeyClient';
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
 *  - submission is final only via an explicit review-before-submit step —
 *    except a scope gate's closing answer (Q0 "Rare" / "Effectively none"),
 *    which ends the survey on the answer itself and goes straight to the
 *    thank-you (D-21);
 *  - a resumed journey opens where it left off, worked out from the saved
 *    answers (D-23).
 */
export function JourneyShell({
  respondentId,
  items,
  ratedFirmIds,
  firmsById,
  initialDrafts,
  onSubmitted,
}: {
  respondentId: string;
  items: SurveyItem[];
  ratedFirmIds: string[];
  firmsById: Record<string, ParticipatingFirm>;
  initialDrafts: DraftRow[];
  onSubmitted: (outcome: { closedByScopeGate: boolean }) => void;
}): JSX.Element {
  const fullSequence = useMemo(
    () => buildJourneySequence(items, ratedFirmIds),
    [items, ratedFirmIds],
  );

  const [answers, setAnswers] = useState<Record<string, { a: unknown; c?: string }>>(() => {
    const seed: Record<string, { a: unknown; c?: string }> = {};
    for (const d of initialDrafts) seed[key(d.questionId, d.ratedFirmId)] = d.answer;
    return seed;
  });
  // The scope-gate route (shared with the server): a gate answered with a
  // closing option ends the journey there — nothing after it is shown.
  const gated = applyScopeGate(fullSequence, (s) => answers[key(s.item.id, s.ratedFirmId)]);
  const sequence = gated.steps;
  // Resume where the saved answers say, not at a stored step number: a reload
  // or another device lands on the first question still to answer (D-23).
  const [rawStep, setStep] = useState(() =>
    resumeStepOf(sequence, (s) => answers[key(s.item.id, s.ratedFirmId)]),
  );
  // Clamped every render: a closing gate answer can shorten the journey under
  // a resume point that was further on.
  const step = Math.min(rawStep, Math.max(sequence.length - 1, 0));
  const [reviewing, setReviewing] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /** A closing gate answer is being sent: the thank-you follows. */
  const [finishing, setFinishing] = useState(false);
  const saveSeq = useRef(0);
  const latest = useRef<
    Record<
      string,
      { qid: string; firmId: string | null; answer: { a: unknown; c?: string }; step: number }
    >
  >({});
  const queue = useRef<Record<string, Promise<void>>>({});
  const failed = useRef<Set<string>>(new Set());
  const closedOnOpen = useRef(gated.closedAt !== null);

  // Opened on a survey whose gate already closed but was never sent (saved
  // before the gate ended surveys on the answer): send it now, so it can
  // never sit unsent behind questions the server will refuse.
  useEffect(() => {
    if (closedOnOpen.current) {
      closedOnOpen.current = false;
      setFinishing(true);
      void doSubmit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (sequence.length === 0) {
    return <p className="lede">This survey has no questions.</p>;
  }

  const current = sequence[step]!;
  /** The current item is a scope gate whose answer closes the survey. */
  const closesHere = gated.closedAt !== null && current === sequence[sequence.length - 1];
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
  ): Promise<SavedAnswer | undefined> {
    const k = key(qid, firmId);
    latest.current[k] = { qid, firmId, answer: next, step: atStep };
    const mine = (saveSeq.current += 1);
    setSaveState('saving');
    const run = (queue.current[k] ?? Promise.resolve()).then(() => saveLatest(k));
    queue.current[k] = run.then(
      () => undefined,
      () => undefined,
    );
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
    return run;
  }

  async function saveLatest(k: string): Promise<SavedAnswer | undefined> {
    const l = latest.current[k];
    if (!l) return undefined;
    try {
      const saved = await journeyApi.saveAnswer(respondentId, {
        questionId: l.qid,
        ratedFirmId: l.firmId,
        answer: l.answer,
        step: l.step,
      });
      failed.current.delete(k);
      return saved;
    } catch (err) {
      failed.current.add(k);
      throw err;
    }
  }

  function onChange(next: unknown): void {
    const envelope = next as { a: unknown; c?: string };
    const k = key(current.item.id, current.ratedFirmId);
    setAnswers((prev) => ({ ...prev, [k]: envelope }));
    const saving = persist(current.item.id, current.ratedFirmId, envelope, step);
    // A closing gate answer ends the survey on the answer itself (D-21): the
    // server sends it with the save, and the thank-you follows — never the
    // next question.
    if (closesScope(current.item, envelope)) {
      setFinishing(true);
      const item = current.item;
      const act = (next: AfterSave): void => {
        if (next === 'thank-you') onSubmitted({ closedByScopeGate: true });
        // This render's `gated` predates the closing answer: say so.
        else if (next === 'submit') void doSubmit(true);
        else setFinishing(false);
      };
      saving.then(
        (saved) => act(afterSave(item, envelope, { saved })),
        (error: unknown) => act(afterSave(item, envelope, { error })),
      );
    }
  }

  function goNext(): void {
    if (!answered) return;
    // A closing scope-gate answer ends the survey immediately: it is sent as
    // complete, with no review of questions that were never asked.
    if (closesHere) {
      void doSubmit();
      return;
    }
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

  async function doSubmit(closedByGate = gated.closedAt !== null): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      // Let in-flight saves settle, then re-send any that failed, so the
      // server's copy matches what the review screen just showed.
      await Promise.all(Object.values(queue.current));
      for (const k of [...failed.current]) await saveLatest(k);
      await journeyApi.submit(respondentId);
      onSubmitted({ closedByScopeGate: closedByGate });
    } catch (err) {
      // Already sent (the closing answer's own save, a second tab): done.
      if (isAlreadySubmitted(err)) {
        onSubmitted({ closedByScopeGate: closedByGate });
        return;
      }
      setError(err instanceof ApiError ? err.message : 'Could not submit');
      setSubmitting(false);
      setFinishing(false);
    }
  }

  if (finishing) {
    return (
      <div className="journey" aria-busy="true">
        <p className="lede">Thank you — finishing…</p>
      </div>
    );
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
          <p className="lede">Everything is answered. Check your answers below, then send them.</p>
        )}
        <ol className="review-answers">
          {sequence.map((s, i) => {
            const v = answers[key(s.item.id, s.ratedFirmId)];
            const shown = describeAnswer(s.item, v);
            const comment = getCanonical(v).c.trim();
            const firm =
              s.ratedFirmId && firmsById[s.ratedFirmId]
                ? firmsById[s.ratedFirmId]!.displayName
                : null;
            return (
              <li key={key(s.item.id, s.ratedFirmId)}>
                <p className="review-q">
                  {firm && <span className="review-firm">{firm} · </span>}
                  {s.item.text}
                </p>
                <p className="review-a">{shown || <em>No answer</em>}</p>
                {comment && <p className="review-c">Your comment: {comment}</p>}
                <button
                  type="button"
                  className="textlink"
                  onClick={() => {
                    setReviewing(false);
                    setStep(i);
                  }}
                  disabled={submitting}
                >
                  Change
                </button>
              </li>
            );
          })}
        </ol>
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
        <button type="button" className="btn" onClick={goNext} disabled={!answered || submitting}>
          {closesHere
            ? submitting
              ? 'Sending…'
              : 'Finish'
            : step + 1 < sequence.length
              ? 'Next'
              : 'Review'}
        </button>
      </div>
    </div>
  );
}
