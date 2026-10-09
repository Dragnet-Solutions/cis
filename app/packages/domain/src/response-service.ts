import { Pool } from 'pg';
import {
  getRespondentById,
  getInstrumentItems,
  insertResponse,
  markRespondentSubmitted,
  withTransaction,
} from '@cis/db';
import { requiresConsent, type AnswerValue, type SurveyItem } from '@cis/survey';
import type { Response } from '@cis/shared-types';
import { DomainError } from './errors';
import { emitCompletedForRespondent } from './funnel-service';

/** A survey requiring consent was submitted without an accepted consent gate. */
export class ConsentRequiredError extends DomainError {
  constructor(instrumentCode: string) {
    super(
      `Consent has not been accepted for ${instrumentCode}; the survey cannot be submitted`,
      'CONSENT_REQUIRED',
    );
  }
}

/** An answer was supplied for a question in the wrong scope bucket. */
export class ResponseScopeError extends DomainError {
  constructor(message: string) {
    super(message, 'RESPONSE_SCOPE');
  }
}

export interface SubmitResponsesInput {
  editionId: string;
  respondentId: string;
  /** questionId → answer, for shared (answered-once) items. */
  sharedAnswers: Record<string, AnswerValue>;
  /**
   * ratedFirmId → (questionId → answer), for firm-specific items. Each rated
   * firm is one the respondent independently selected. A shared answer is never
   * copied in here, and the respondent's recruiting firm is never added unless
   * it appears as a key because it was independently chosen to be rated.
   */
  firmAnswers: Record<string, Record<string, AnswerValue>>;
}

function indexByScope(items: SurveyItem[]): {
  shared: Map<string, SurveyItem>;
  firm: Map<string, SurveyItem>;
} {
  const shared = new Map<string, SurveyItem>();
  const firm = new Map<string, SurveyItem>();
  for (const item of items) {
    if (item.scope === 'firm_specific') firm.set(item.id, item);
    else shared.set(item.id, item);
  }
  return { shared, firm };
}

/**
 * Store a respondent's answers as immutable response rows, split by scope:
 * shared items once (no rated firm), firm-specific items once per rated firm.
 * The split is driven by each item's `scope`, never by a per-instrument branch.
 *
 * Guarantees enforced here:
 *  - consent gate: a consent-requiring instrument cannot be submitted unless the
 *    respondent has accepted consent;
 *  - scope integrity: a shared answer is stored once with no rated firm; a
 *    firm-specific answer is stored per explicitly-provided rated firm;
 *  - no shared-answer copying across firms, and the recruiting firm is never
 *    auto-treated as a rated firm;
 *  - immutability: rows are inserted, never overwritten (DB-enforced too).
 */
export async function submitResponses(
  pool: Pool,
  input: SubmitResponsesInput,
): Promise<Response[]> {
  const respondent = await getRespondentById(pool, input.respondentId);
  if (!respondent) throw new DomainError('Respondent not found', 'RESPONDENT_NOT_FOUND');
  if (respondent.editionId !== input.editionId) {
    throw new ResponseScopeError('Respondent does not belong to the given edition');
  }

  if (requiresConsent(respondent.instrumentCode) && !respondent.consentAccepted) {
    throw new ConsentRequiredError(respondent.instrumentCode);
  }

  const items = await getInstrumentItems(pool, respondent.instrumentCode);
  const { shared, firm } = indexByScope(items);

  // Validate scope buckets before writing anything.
  for (const qid of Object.keys(input.sharedAnswers)) {
    if (!shared.has(qid)) {
      throw new ResponseScopeError(`${qid} is not a shared item of ${respondent.instrumentCode}`);
    }
  }
  for (const [firmId, answers] of Object.entries(input.firmAnswers)) {
    for (const qid of Object.keys(answers)) {
      if (!firm.has(qid)) {
        throw new ResponseScopeError(
          `${qid} is not a firm-specific item of ${respondent.instrumentCode} (firm ${firmId})`,
        );
      }
    }
  }

  return withTransaction(pool, async (client) => {
    const written: Response[] = [];
    for (const [qid, answer] of Object.entries(input.sharedAnswers)) {
      written.push(
        await insertResponse(client as unknown as Pool, {
          editionId: input.editionId,
          respondentId: input.respondentId,
          questionId: qid,
          scope: 'shared',
          ratedFirmId: null,
          answer,
        }),
      );
    }
    for (const [firmId, answers] of Object.entries(input.firmAnswers)) {
      for (const [qid, answer] of Object.entries(answers)) {
        written.push(
          await insertResponse(client as unknown as Pool, {
            editionId: input.editionId,
            respondentId: input.respondentId,
            questionId: qid,
            scope: 'firm_specific',
            ratedFirmId: firmId,
            answer,
          }),
        );
      }
    }
    await markRespondentSubmitted(client as unknown as Pool, input.respondentId);
    // One completed funnel event per response, in the same transaction.
    await emitCompletedForRespondent(client as unknown as Pool, respondent, { source: 'direct' });
    return written;
  });
}
