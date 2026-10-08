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

export type { PreviousEditionEntry };

export interface OrganisationDescriptions {
  cis: string;
  dragnet: string;
}

function parseOrganisationDescriptions(body: string | null): OrganisationDescriptions {
  if (!body) return { cis: '', dragnet: '' };
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    return {
      cis: typeof parsed['cis'] === 'string' ? (parsed['cis'] as string) : '',
      dragnet: typeof parsed['dragnet'] === 'string' ? (parsed['dragnet'] as string) : '',
    };
  } catch {
    return { cis: '', dragnet: '' };
  }
}

function parseHelpText(body: string | null): string {
  if (!body) return '';
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    return typeof parsed['general'] === 'string' ? (parsed['general'] as string) : '';
  } catch {
    return '';
  }
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
