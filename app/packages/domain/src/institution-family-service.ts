import type { InstrumentFamilyCode } from '@cis/shared-types';

/**
 * Phase 19 — the institutional instrument family model:
 *   institution -> institution role -> controlled instrument family/version
 *     -> edition participation -> individual invitation
 *
 * Families are letter-coded and STATIC — the family a role belongs to never
 * changes, only which institutions hold it. The family -> instrument-code
 * mapping below is the one static lookup this phase adds; everything else
 * (which institutions exist, which roles they hold) lives in
 * `institutions`/`institution_roles` so a ninth institution needs no code
 * change here either.
 */

export interface FamilyMeta {
  code: InstrumentFamilyCode;
  label: string;
  /** The relationship phrase for the controlled intro paragraph — "your
   *  institution's {relationship} with licensed stockbroking firms". */
  relationship: string;
  instrumentCode: string;
}

export const FAMILY_META: Record<InstrumentFamilyCode, FamilyMeta> = {
  A: {
    code: 'A',
    label: 'Regulatory / Supervisory',
    relationship: 'supervision and regulatory oversight',
    instrumentCode: 'I-SEC',
  },
  B: {
    code: 'B',
    label: 'Exchange / Market Operator',
    relationship: 'exchange and market operations',
    instrumentCode: 'I-NGX',
  },
  C: {
    code: 'C',
    label: 'Clearing / Settlement',
    relationship: 'clearing and settlement operations',
    instrumentCode: 'I-CSCS',
  },
  D: {
    code: 'D',
    label: 'Depository / Securities-account Infrastructure',
    relationship: 'depository and securities-account services',
    instrumentCode: 'I-DEP',
  },
};

export function instrumentCodeForFamily(familyCode: InstrumentFamilyCode): string {
  return FAMILY_META[familyCode].instrumentCode;
}

/**
 * The common controlled introduction paragraph, parameterised by
 * {INSTITUTION_NAME} and {INSTITUTIONAL_RELATIONSHIP}. This is NEW render-time
 * content (never baked into `instrument_questions` rows, unlike the EXISTING
 * hardcoded institution references already in I-SEC/I-NGX/I-CSCS's Q3/Q5
 * prose, which stay untouched — retrofitting those is out of this phase's
 * scope). Every family, including the three that predate this phase, gets
 * this paragraph rendered the same way.
 */
export function renderInstitutionalIntro(
  institutionName: string,
  familyCode: InstrumentFamilyCode,
): string {
  const relationship = FAMILY_META[familyCode].relationship;
  return (
    `This survey is addressed to ${institutionName}, in its capacity covering ${relationship} ` +
    `for licensed stockbroking firms. Your answers describe your institution's own experience — ` +
    `they are never attributed to any individual firm.`
  );
}
