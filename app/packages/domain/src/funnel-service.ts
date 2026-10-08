import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { emitFunnelEvent } from '@cis/db';
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
 * The three regulator instruments (I-SEC/I-NGX/I-CSCS) are contextual
 * "Institutional Perspectives" (PUB_10), not institutional-investor responses;
 * their sufficiency is the separate all-three-regulators check, not the
 * local/foreign investor floors. They are Nigerian bodies, so they map to
 * `local_institution` for the funnel's fixed four-value segment, and are
 * excluded from the investor-institution floor counts by instrument code.
 */

const FIRM_INSTRUMENTS = new Set(['S1', 'S2', 'S3']);
const RETAIL_INSTRUMENTS = new Set(['S4']);

export function segmentForInstrument(instrumentCode: string): FunnelSegment {
  if (FIRM_INSTRUMENTS.has(instrumentCode)) return 'firm';
  if (RETAIL_INSTRUMENTS.has(instrumentCode)) return 'retail';
  if (instrumentCode === 'S5a') return 'local_institution';
  if (instrumentCode === 'S5b') return 'foreign_institution';
  // Regulator/contextual instruments (Institutional Perspectives) — see above.
  return 'local_institution';
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
 * survey completion carries the firm id.
 */
export async function emitCompletedForRespondent(
  client: Pool,
  respondent: Respondent,
  opts: { channel?: FunnelChannel; source?: FunnelSource } = {},
): Promise<FunnelEvent> {
  const segment = segmentForInstrument(respondent.instrumentCode);
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
