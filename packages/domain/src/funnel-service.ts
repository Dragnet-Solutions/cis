import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { emitFunnelEvent } from '@cis/db';
import { FAMILY_META } from './institution-family-service';
import type {
  FunnelEvent,
  FunnelSegment,
  FunnelChannel,
  FunnelSource,
  Respondent,
} from '@cis/shared-types';

/**
 * Funnel event emission. The `completed` event fires from the SAME transaction
 * that finalizes a response, so the stream can never drift from `responses`.
 * One completed event per response — a respondent rating four firms is ONE
 * completed response, not four.
 *
 * The instrument→segment mapping below is explicit and fully determined by the
 * completed instrument code — never a uniform default. The local vs. foreign
 * institutional split is the whole reason S5a (UX-INS-001) and S5b (UX-INS-002)
 * were built as separate journeys in Phase 3, and it drives two different
 * sufficiency floors (25 distinct local vs. 15 distinct foreign institutions).
 * A uniform default would silently corrupt both counts in opposite directions —
 * exactly the class of silent sufficiency error the evidence-pack architecture
 * exists to prevent — so segment is derived here, at the point the event is
 * written:
 *   S1/S2/S3 → firm            S4 → retail
 *   S5a      → local_institution   S5b → foreign_institution
 * The regulator / market-infrastructure instruments (I-SEC, I-NGX, I-CSCS,
 * I-DEP — the institutional families in institution-family-service) are
 * contextual "Institutional Perspectives" (PUB_10), not institutional-investor
 * responses. Their sufficiency is the separate all-regulators check over
 * `institution_engagement`, never the local/foreign investor floors, so they
 * have NO funnel segment: `segmentForInstrument` returns null and no
 * `completed` funnel event is written for them. (They used to be mapped to
 * `local_institution`, so a regulator's answer counted as a local
 * institutional investor; the @cis/db count queries also exclude any such
 * historic rows by instrument type.)
 */

const FIRM_INSTRUMENTS = new Set(['S1', 'S2', 'S3']);
const RETAIL_INSTRUMENTS = new Set(['S4']);
const REGULATOR_INSTRUMENTS = new Set(Object.values(FAMILY_META).map((f) => f.instrumentCode));

/** Whether an instrument is a regulator / market-infrastructure instrument. */
export function isRegulatorInstrument(instrumentCode: string): boolean {
  return REGULATOR_INSTRUMENTS.has(instrumentCode);
}

/**
 * The funnel segment a completed instrument belongs to, or null for an
 * instrument that belongs to no participation segment — the regulator
 * instruments, and any code this mapping does not know (never a default).
 */
export function segmentForInstrument(instrumentCode: string): FunnelSegment | null {
  if (FIRM_INSTRUMENTS.has(instrumentCode)) return 'firm';
  if (RETAIL_INSTRUMENTS.has(instrumentCode)) return 'retail';
  if (instrumentCode === 'S5a') return 'local_institution';
  if (instrumentCode === 'S5b') return 'foreign_institution';
  return null;
}

/** Investor-side instruments (retail, local or foreign institutional) — the
 *  respondents reminders and the Unfinished view are about. Firm seats and
 *  regulators are neither. */
export function isInvestorInstrument(instrumentCode: string): boolean {
  const segment = segmentForInstrument(instrumentCode);
  return segment !== null && segment !== 'firm';
}

/** An opaque, stable token for an institution name — no name is ever stored on
 *  the funnel. Institutions are counted by distinct token. */
export function institutionRefFor(institutionName: string | null): string | null {
  if (!institutionName || !institutionName.trim()) return null;
  return createHash('sha256')
    .update(institutionName.trim().toLowerCase())
    .digest('hex')
    .slice(0, 32);
}

/**
 * Emit the single `completed` funnel event for a respondent submission. Called
 * inside the response-finalizing transaction. `firmId` stays null for retail/
 * institutional completions (one response, however many firms rated); a firm-
 * survey completion carries the firm id. A regulator submission belongs to no
 * participation segment, so nothing is emitted for it (returns null).
 */
export async function emitCompletedForRespondent(
  client: Pool,
  respondent: Respondent,
  opts: { channel?: FunnelChannel; source?: FunnelSource } = {},
): Promise<FunnelEvent | null> {
  const segment = segmentForInstrument(respondent.instrumentCode);
  if (segment === null) return null;
  return emitFunnelEvent(client, {
    eventType: 'completed',
    editionId: respondent.editionId,
    segment,
    firmId: segment === 'firm' ? respondent.recruitingFirmId : null,
    institutionRef:
      segment === 'local_institution' || segment === 'foreign_institution'
        ? institutionRefFor(respondent.institutionName)
        : null,
    channel: opts.channel ?? 'portal',
    source: opts.source ?? 'direct',
    responseId: respondent.id,
  });
}
