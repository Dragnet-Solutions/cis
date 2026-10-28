/**
 * UX-X-002 (Help, privacy and about) and UX-PUB-002 (Previous editions).
 *
 * Both are read-only public consumers of state other phases already built:
 * UX-X-002 renders Phase 15's managed content (no wording hardcoded here),
 * and UX-PUB-002 lists Phase 6's approved national reports for editions other
 * than the current one. Neither needs any new mutation logic.
 */

import { Pool } from 'pg';
import { getPreviousPublishedEditions, type PreviousEditionEntry } from '@cis/db';
import { getContentState } from './managed-content-service';
import { DEFAULT_SUPPORT_EMAIL } from './email-templates';

export type { PreviousEditionEntry };

export interface OrganisationDescriptions {
  cis: string;
  dragnet: string;
}

/**
 * BUG-04: the wording Product supplied (27 Oct) for the public pages, used
 * wherever the operators have not published their own. Published wording
 * always wins; an area left empty, or a field left blank, falls back here, so
 * the public pages are never blank.
 */
export const DEFAULT_PUBLIC_CONTENT: {
  organisationDescriptions: OrganisationDescriptions;
  helpText: string;
} = {
  organisationDescriptions: {
    cis: 'The Chartered Institute of Stockbrokers is the professional body for stockbroking in Nigeria, and co-convenes the CIS-Dragnet Benchmark Study.',
    dragnet:
      'Dragnet Solutions Limited is the study’s delivery partner, running the survey platform, analysis and reporting for the CIS-Dragnet Benchmark Study.',
  },
  helpText: `Questions about the study or your survey? Email ${DEFAULT_SUPPORT_EMAIL}. Your answers are confidential and reported only in aggregate; no firm or person is named.`,
};

function nonBlank(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

function parseJson(body: string | null): Record<string, unknown> {
  if (!body) return {};
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseOrganisationDescriptions(body: string | null): OrganisationDescriptions {
  const parsed = parseJson(body);
  const fallback = DEFAULT_PUBLIC_CONTENT.organisationDescriptions;
  return {
    cis: nonBlank(parsed['cis']) ?? fallback.cis,
    dragnet: nonBlank(parsed['dragnet']) ?? fallback.dragnet,
  };
}

function parseHelpText(body: string | null): string {
  return nonBlank(parseJson(body)['general']) ?? DEFAULT_PUBLIC_CONTENT.helpText;
}

export interface PublicContent {
  privacyNotice: string;
  organisationDescriptions: OrganisationDescriptions;
  helpText: string;
}

/**
 * Everything UX-X-002 shows, read from Phase 15's managed-content system.
 * privacy_notice resolves through governed_config (Phase 15's own routing);
 * organisation_descriptions and help_text resolve through content_live.
 * Changing content in the admin wording surface is reflected here with no
 * code change — this function only reads the current live body.
 */
export async function getPublicContent(pool: Pool): Promise<PublicContent> {
  const [privacy, orgDescriptions, help] = await Promise.all([
    getContentState(pool, 'privacy_notice', ''),
    getContentState(pool, 'organisation_descriptions', ''),
    getContentState(pool, 'help_text', ''),
  ]);
  return {
    privacyNotice: privacy.liveBody ?? '',
    organisationDescriptions: parseOrganisationDescriptions(orgDescriptions.liveBody),
    helpText: parseHelpText(help.liveBody),
  };
}

/**
 * UX-PUB-002 — published national reports for editions other than the
 * current one. Year 1 returns an empty array (the design's specified empty
 * state); the query already supports a second edition with no further
 * backend changes once one exists.
 */
export async function listPreviousPublishedEditions(
  pool: Pool,
  currentEditionId: string | null,
): Promise<PreviousEditionEntry[]> {
  return getPreviousPublishedEditions(pool, currentEditionId);
}
