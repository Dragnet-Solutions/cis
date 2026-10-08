import type { SurveyItem } from '@cis/survey';
import { ApiError } from '../api/types';

/**
 * Respondent-facing API client. UNAUTHENTICATED by design — a respondent has no
 * operator account and never touches the admin portal. The respondent id and
 * the recovery token are the only handles into a journey.
 */
const BASE = '/api';

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  const data: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message =
      data && typeof data === 'object' && 'message' in data
        ? String((data as { message: unknown }).message)
        : `Request failed (${res.status})`;
    throw new ApiError(res.status, message);
  }
  return data as T;
}

export interface ConsentContent {
  provisional?: boolean;
  notice: string;
  expansionTitle: string;
  expansion: string;
  checkboxLabel: string;
}

export interface ParticipatingFirm {
  id: string;
  displayName: string;
  slug: string;
}

export interface FirmContext {
  ratedFirmId: string | null;
  firmIndex: number;
  firmCount: number;
}

export interface DraftRow {
  questionId: string;
  ratedFirmId: string | null;
  answer: { a: unknown; c?: string };
}

export interface ResumeState {
  respondent: {
    id: string;
    instrumentCode: string;
    ratedFirmIds: string[];
    resumeStep: number;
    consentAccepted: boolean;
    recoveryToken: string | null;
  };
  items: SurveyItem[];
  drafts: DraftRow[];
  firmContext: FirmContext;
}

export const journeyApi = {
  context: () =>
    request<{
      editionId: string | null;
      editionLabel: string | null;
      resultsSectionVisible: boolean;
    }>('/journeys/context'),

  consentContent: () =>
    request<{ consent: ConsentContent | null; recoveryTtlSeconds: number | null }>(
      '/journeys/consent-content',
    ),

  participatingFirms: (editionId: string) =>
    request<{ firms: ParticipatingFirm[] }>(
      `/journeys/editions/${editionId}/participating-firms`,
    ).then((r) => r.firms),

  start: (body: {
    editionId: string;
    instrumentCode: string;
    recruitingFirmId?: string | null;
    institutionName?: string | null;
  }) => request<{ respondentId: string }>('/journeys', 'POST', body),

  contact: (
    respondentId: string,
    body: {
      consentAccepted: boolean;
      channel: 'email' | 'text' | 'both' | 'none';
      email?: string | null;
      phone?: string | null;
    },
  ) =>
    request<{ respondentId: string; recoveryToken: string | null }>(
      `/journeys/${respondentId}/contact`,
      'POST',
      body,
    ),

  ratedFirms: (respondentId: string, firmIds: string[]) =>
    request<{ ratedFirmIds: string[] }>(`/journeys/${respondentId}/rated-firms`, 'POST', {
      firmIds,
    }),

  saveAnswer: (
    respondentId: string,
    body: {
      questionId: string;
      ratedFirmId: string | null;
      answer: { a: unknown; c?: string };
      step?: number;
    },
  ) => request<{ draft: DraftRow }>(`/journeys/${respondentId}/answers`, 'PUT', body),

  resume: (respondentId: string) => request<ResumeState>(`/journeys/${respondentId}/resume`),

  resumeByToken: (token: string) =>
    request<
      | ({ kind: 'resume' } & ResumeState)
      | { kind: 'already_submitted' }
      | { kind: 'participation_closed' }
    >(`/journeys/resume/${encodeURIComponent(token)}`),

  submit: (respondentId: string) =>
    request<{ submitted: boolean; responseCount: number }>(
      `/journeys/${respondentId}/submit`,
      'POST',
    ),

  reportDelivery: (
    respondentId: string,
    body: { reportDelivery: string; email?: string | null; phone?: string | null },
  ) =>
    request<{ reportDelivery: string | null }>(
      `/journeys/${respondentId}/report-delivery`,
      'PATCH',
      body,
    ),

  referral: (respondentId: string, body: { editionId: string; instrumentCode: string }) =>
    request<{ respondentId: string }>(`/journeys/${respondentId}/referral`, 'POST', body),

  colleagueInvite: (body: { editionId: string; instrumentCode: string; institutionName: string }) =>
    request<{ respondentId: string }>('/journeys/colleague-invite', 'POST', body),

  publicContent: () =>
    request<{
      privacyNotice: string;
      organisationDescriptions: { cis: string; dragnet: string };
      helpText: string;
    }>('/public-content'),

  // A firm's own S1/S2/S3 seat entry point (Task D, Part 6) — same public,
  // unauthenticated trust model, identified by the seat's link token rather
  // than a journey id.
  firmSeatContext: (linkToken: string) =>
    request<{
      editionId: string;
      organizationId: string;
      seatCode: 'S1' | 'S2' | 'S3';
      roleLabel: string;
      state: 'empty' | 'invited' | 'started' | 'complete';
      editionStatus: 'draft' | 'open' | 'locked' | 'archived';
    }>(`/firm-seats/${encodeURIComponent(linkToken)}/context`),

  firmSeatStart: (linkToken: string) =>
    request<{ respondentId: string; editionId: string; seatCode: string }>(
      `/firm-seats/${encodeURIComponent(linkToken)}/start`,
      'POST',
    ),

  firmSeatComplete: (linkToken: string) =>
    request<{ ok: true }>(`/firm-seats/${encodeURIComponent(linkToken)}/complete`, 'POST'),

  // A firm's outreach link (Task E) — resolving which edition/firm/segment a
  // `?ref=<token>` link belongs to, and recording the real opens/starts/
  // finishes events `ensureOutreachLinks`/`getOutreachVolumes` always
  // supported reading but nothing ever wrote. Best-effort: a failed event
  // call is never allowed to interrupt the respondent's own navigation.
  outreachContext: (token: string) =>
    request<{
      editionId: string;
      organizationId: string;
      segment: 'individual' | 'local_institutional' | 'foreign_institutional';
    }>(`/outreach/${encodeURIComponent(token)}/context`),

  outreachEvent: (token: string, event: 'opens' | 'starts' | 'finishes') =>
    request<{ ok: true }>(`/outreach/${encodeURIComponent(token)}/event`, 'POST', { event }).catch(
      () => undefined,
    ),

  previousEditions: (currentEditionId: string | null) =>
    request<{
      editions: Array<{
        editionId: string;
        editionLabel: string;
        reportId: string;
        publicationStatus: string;
        approvedAt: string;
        lineageNote: string;
      }>;
    }>(
      `/public-content/previous-editions${
        currentEditionId ? `?currentEditionId=${encodeURIComponent(currentEditionId)}` : ''
      }`,
    ).then((r) => r.editions),
};
