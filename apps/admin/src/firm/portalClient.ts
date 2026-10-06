import { ApiError, type FirmReportContent } from '../api/types';

/**
 * The firm-portal API client — entirely separate from the operator
 * AdminClient (apps/admin/src/api/client.ts). A coordinator session is a
 * distinct claim space from an operator session (see
 * apps/api/src/plugins/auth-plugin.ts), so this client carries its own
 * bearer token and never shares a request path with the operator one.
 */
const BASE = '/api';

interface RequestOptions {
  method?: string;
  body?: unknown;
  token?: string | null;
  headers?: Record<string, string>;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;

  const init: RequestInit = { method: opts.method ?? 'GET', headers };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);

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

// ─── Types ──────────────────────────────────────────────────────────────────

export type SeatCode = 'S1' | 'S2' | 'S3';
export type SeatState = 'empty' | 'invited' | 'started' | 'complete';

export interface SeatAssignment {
  id: string;
  editionId: string;
  organizationId: string;
  seatCode: SeatCode;
  roleLabel: string;
  assignedName: string | null;
  assignedEmail: string | null;
  state: SeatState;
  isSelf: boolean;
  stalledAt: string | null;
  respondentId: string | null;
  linkToken: string;
}

export interface Coordinator {
  id: string;
  organizationId: string;
  name: string;
  role: string | null;
  email: string;
  phone: string | null;
  isLead: boolean;
  accessCode: string;
  revokedAt: string | null;
  createdAt: string;
}

export interface PortalMe {
  coordinator: {
    id: string;
    name: string;
    email: string;
    role: string | null;
    phone: string | null;
    isLead: boolean;
    accessCode: string;
  } | null;
  organization: { id: string; displayName: string; slug: string } | null;
  currentEdition: { id: string; status: 'draft' | 'open' | 'locked' | 'archived' } | null;
}

export interface FirmDirectoryEntry {
  id: string;
  displayName: string;
}

export type OutreachSegment = 'individual' | 'local_institutional' | 'foreign_institutional';

export interface OutreachLink {
  token: string;
  segment: OutreachSegment | null;
  opens: number;
  starts: number;
  finishes: number;
}

export type StandingLabel = 'better' | 'worse' | 'within_margin' | 'unavailable';

export interface FirmIndexResult {
  metricCode: string;
  name: string;
  you: number | null;
  industry: number | null;
  gap: boolean;
  provenance: string;
  standing: StandingLabel;
  unit: string;
}

export interface FirmResults {
  firmId: string;
  editionId: string;
  margin: number;
  indices: FirmIndexResult[];
  retail: { count: number; state: string };
  combinedReportAvailable: true;
}

// ─── Auth (public) ──────────────────────────────────────────────────────────

export const portalAuth = {
  lookup: (email: string) =>
    request<{ branch: 'signin' | 'unclaimed' }>(
      `/portal/auth/lookup?email=${encodeURIComponent(email)}`,
    ),

  login: (email: string, pin: string) =>
    request<{
      token: string;
      coordinator: {
        id: string;
        organizationId: string;
        name: string;
        email: string;
        isLead: boolean;
      };
    }>('/portal/auth/login', { method: 'POST', body: { email, pin } }),

  setPin: (token: string, newPin: string, currentPin?: string) =>
    request<{ ok: true }>('/portal/auth/pin', {
      method: 'POST',
      body: { newPin, ...(currentPin !== undefined ? { currentPin } : {}) },
      token,
    }),
};

// ─── Claim / request an invitation (public) ────────────────────────────────

export const firmPublic = {
  directory: () => request<{ firms: FirmDirectoryEntry[] }>('/firm/directory').then((r) => r.firms),

  claim: (input: {
    organizationId: string;
    contactName: string;
    contactEmail: string;
    mobile: string;
    pin: string;
    role: string;
    privacyConsent: boolean;
    followUpConsent?: boolean;
  }) =>
    request<{
      claim: { id: string; organizationId: string };
      leadCoordinator: { id: string; accessCode: string };
    }>('/firm/claim', { method: 'POST', body: input }),

  requestInvitation: (input: {
    firmName: string;
    name: string;
    designation: string;
    email: string;
    phone: string;
    privacyConsent: boolean;
  }) => request<{ accepted: true }>('/firm/request-invitation', { method: 'POST', body: input }),
};

// ─── Portal (coordinator-authenticated) ────────────────────────────────────

export const portalClient = {
  me: (token: string) => request<PortalMe>('/portal/me', { token }),

  // Team
  listTeam: (token: string) =>
    request<{ coordinators: Coordinator[] }>('/portal/team', { token }).then((r) => r.coordinators),
  addTeamMember: (
    token: string,
    input: { name: string; email: string; role?: string | null; phone?: string | null },
  ) =>
    request<{ coordinator: Coordinator }>('/portal/team', {
      method: 'POST',
      body: input,
      token,
    }).then((r) => r.coordinator),
  handoverLead: (token: string, coordinatorId: string) =>
    request<{
      outgoing: { id: string; isLead: boolean };
      incoming: { id: string; isLead: boolean };
    }>(`/portal/team/${coordinatorId}/handover`, { method: 'POST', token }),
  removeTeamMember: (token: string, coordinatorId: string) =>
    request<{ removed: true }>(`/portal/team/${coordinatorId}`, { method: 'DELETE', token }),

  // Firm profile
  setFollowUpConsent: (token: string, followUpConsent: boolean) =>
    request<{ ok: true }>('/portal/follow-up-consent', {
      method: 'PATCH',
      body: { followUpConsent },
      token,
    }),

  // Seats
  getSeats: (token: string) =>
    request<{ seats: SeatAssignment[] }>('/portal/seats', { token }).then((r) => r.seats),
  assignSeat: (
    token: string,
    seatCode: SeatCode,
    input: { assignedName: string; assignedEmail: string; isSelf?: boolean },
  ) =>
    request<{ seat: SeatAssignment }>(`/portal/seats/${seatCode}/assign`, {
      method: 'POST',
      body: input,
      token,
    }).then((r) => r.seat),
  describeSeatReplacement: (token: string, seatCode: SeatCode) =>
    request<{ state: SeatState; requiresConfirm: boolean; warning: string | null }>(
      `/portal/seats/${seatCode}/replacement`,
      { token },
    ),
  confirmSeatReplacement: (token: string, seatCode: SeatCode) =>
    request<{ seat: SeatAssignment }>(`/portal/seats/${seatCode}/replace`, {
      method: 'POST',
      token,
    }).then((r) => r.seat),
  canInvite: (token: string) =>
    request<{ allowed: boolean; reason: string | null; assignedCount: number }>(
      '/portal/can-invite',
      {
        token,
      },
    ),

  // Outreach
  getOutreach: (token: string) =>
    request<{ links: OutreachLink[] }>('/portal/outreach', { token }).then((r) => r.links),

  // The firm's own report — only once CIS has released it.
  getReport: (token: string, editionId: string) =>
    request<{ released: boolean; report: FirmReportContent | null }>(
      `/portal/editions/${editionId}/report`,
      { token },
    ),

  // Results — reuses the existing, unchanged coordinator-access-code route
  // (apps/api/src/routes/firm-results.ts); the coordinator's own accessCode,
  // from /portal/me, is the credential — a header, not the bearer token.
  getResults: (editionId: string, firmId: string, accessCode: string) =>
    request<FirmResults>(`/editions/${editionId}/firms/${firmId}/results`, {
      headers: { 'x-coordinator-access-code': accessCode },
    }),
};
