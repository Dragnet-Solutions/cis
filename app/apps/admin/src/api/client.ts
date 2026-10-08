import type { SurveyItem } from '@cis/survey';
import {
  ApiError,
  type AudienceCategory,
  type BatchReport,
  type Coordinator,
  type EditionDetail,
  type EditionSummary,
  type FirmReport,
  type FirmSummary,
  type IndexScoreView,
  type InstrumentsResponse,
  type InvitationRequestItem,
  type LoginResponse,
  type MessageAudienceKind,
  type MessageBatch,
  type MessageRecipient,
  type MessageTemplate,
  type MissionBoardResponse,
  type NationalReportDetailResponse,
  type NationalReportSection,
  type PeopleResponse,
  type PersonAccess,
  type PersonInput,
  type ReleaseFirmReportsResult,
  type ReminderSchedule,
  type ResponsesMonitor,
  type SampleFloor,
  type ScoringCheckedAccount,
  type ScoringRunsResponse,
  type ScoringSignoff,
  type SendBatchResult,
  type UnfinishedResponse,
  type UploadCheckResult,
  type RegulatorContact,
  type RegulatorFamilyCode,
  type RegulatorView,
  type IndustryReportContent,
  type FirmReportContent,
  type ReportNarrativeView,
} from './types';

// All API calls go through this single typed layer so later admin surfaces
// share it rather than scattering fetch() through components. The base path is
// proxied to the Fastify server (see vite.config.ts).
const BASE = '/api';

interface RequestOptions {
  method?: string;
  body?: unknown;
  token?: string | null;
}

async function baseRequest<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
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

/** A binary download (the report PDF). Errors still arrive as the JSON envelope. */
export async function requestBlob(path: string, token: string | null): Promise<Blob> {
  const res = await fetch(`${BASE}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    const text = await res.text();
    let message = `Request failed (${res.status})`;
    try {
      const data = JSON.parse(text) as { message?: unknown };
      if (data.message) message = String(data.message);
    } catch {
      // not JSON — keep the status message
    }
    throw new ApiError(res.status, message);
  }
  return res.blob();
}

export function login(email: string, password: string): Promise<LoginResponse> {
  return baseRequest<LoginResponse>('/auth/login', { method: 'POST', body: { email, password } });
}

export interface AdminClient {
  listEditions(): Promise<EditionSummary[]>;
  getEdition(id: string): Promise<EditionDetail>;
  setFloors(id: string, floors: SampleFloor[]): Promise<{ floors: SampleFloor[] }>;
  setClosingDate(id: string, closingDate: string): Promise<{ surveyCloseAt: string | null }>;
  setOpeningDate(id: string, openDate: string | null): Promise<{ plannedOpenAt: string | null }>;
  requestLock(id: string, reason: string): Promise<{ criticalActionId: string }>;
  decideLock(
    id: string,
    actionId: string,
    approved: boolean,
    rejectionReason?: string,
  ): Promise<{ status: 'approved' | 'rejected'; editionStatus: string }>;
  getInstruments(id: string): Promise<InstrumentsResponse>;
  getMissionBoard(id: string): Promise<MissionBoardResponse>;
  // Scoring & sign-off (UX-ADM-004)
  triggerScoringRun(id: string): Promise<{ run: unknown }>;
  getScoringRuns(id: string): Promise<ScoringRunsResponse>;
  getScoreView(id: string, runId: string): Promise<{ scores: IndexScoreView[] }>;
  // Who requests/approves/rejects is always the signed-in operator; the server
  // takes it from the session, so no identity is passed here.
  requestSignoff(
    id: string,
    runId: string,
    checkedAccount: ScoringCheckedAccount,
  ): Promise<{ signoff: ScoringSignoff }>;
  approveSignoff(signoffId: string): Promise<{ signoff: ScoringSignoff }>;
  rejectSignoff(signoffId: string, reason: string): Promise<{ signoff: ScoringSignoff }>;
  // National report (UX-ADM-005)
  generateNationalReport(
    id: string,
    scoringRunId: string,
    context: {
      segments: Record<string, { meets: boolean; thin: boolean }>;
      regulatorsEngaged: number;
    },
  ): Promise<{ reportId: string; sections: NationalReportSection[] }>;
  getLatestNationalReport(id: string): Promise<{ report: { id: string } | null }>;
  getSufficiency(id: string): Promise<{
    sufficiency: Record<string, { counted: number; floor: number; meets: boolean }>;
  }>;
  getNationalReport(reportId: string): Promise<NationalReportDetailResponse>;
  openNationalDraft(reportId: string): Promise<{ opened: boolean }>;
  requestNationalApproval(reportId: string, reason: string): Promise<{ requested: boolean }>;
  approveNationalReport(reportId: string): Promise<{ status: string }>;
  // Firm reports (UX-ADM-006)
  // Regulators (UX-OPS-007) — one record per (institution, family) role.
  getRegulators(id: string): Promise<{ regulators: RegulatorView[] }>;
  getRegulator(
    id: string,
    institutionId: string,
    family: RegulatorFamilyCode,
  ): Promise<{ regulator: RegulatorView }>;
  saveRegulatorContact(
    id: string,
    institutionId: string,
    family: RegulatorFamilyCode,
    contact: RegulatorContact,
  ): Promise<{ regulator: RegulatorView }>;
  issueRegulatorLink(
    id: string,
    institutionId: string,
    family: RegulatorFamilyCode,
    targetBy: string,
  ): Promise<{ regulator: RegulatorView }>;
  remindRegulator(
    id: string,
    institutionId: string,
    family: RegulatorFamilyCode,
    textOnly: boolean,
  ): Promise<{ regulator: RegulatorView }>;
  declineRegulator(
    id: string,
    institutionId: string,
    family: RegulatorFamilyCode,
  ): Promise<{ regulator: RegulatorView }>;
  reopenRegulator(
    id: string,
    institutionId: string,
    family: RegulatorFamilyCode,
  ): Promise<{ regulator: RegulatorView }>;
  addRegulatorHistory(
    id: string,
    institutionId: string,
    family: RegulatorFamilyCode,
    entry: string,
  ): Promise<{ regulator: RegulatorView }>;
  getFirmReports(id: string): Promise<{
    reports: FirmReport[];
    notices: Record<string, { sent: number; logged: number; failed: number; queued: number }>;
  }>;
  publishIndustryReport(id: string): Promise<{ publishedAt: string }>;
  // Report documents — content computed from submitted responses.
  getIndustryReport(id: string): Promise<IndustryReportContent>;
  getFirmReport(id: string, firmId: string): Promise<FirmReportContent>;
  generateIndustryNarrative(id: string): Promise<{ narrative: ReportNarrativeView }>;
  generateFirmNarrative(id: string, firmId: string): Promise<{ narrative: ReportNarrativeView }>;
  ensureIndustryNarrative(id: string): Promise<{ narrative: ReportNarrativeView | null }>;
  ensureFirmNarrative(
    id: string,
    firmId: string,
  ): Promise<{ narrative: ReportNarrativeView | null }>;
  /** The finished report as a PDF file (server-rendered). */
  downloadIndustryPdf(id: string): Promise<Blob>;
  downloadFirmPdf(id: string, firmId: string): Promise<Blob>;
  generateFirmReports(id: string, scoringRunId: string): Promise<unknown>;
  approveFirmReport(reportId: string): Promise<{ approvalState: string }>;
  regenerateFirmReport(reportId: string): Promise<{ report: FirmReport }>;
  releaseFirmReports(id: string): Promise<ReleaseFirmReportsResult>;
  // Invitations (UX-OPS-002)
  listAudiences(id: string): Promise<{ audiences: AudienceCategory[] }>;
  resolveFirmNames(
    id: string,
    firmNames: string[],
  ): Promise<{ resolved: Record<string, string | null> }>;
  listMessageTemplates(id: string): Promise<{ templates: MessageTemplate[] }>;
  saveMessageTemplate(
    id: string,
    body: {
      name: string;
      subject: string;
      body: string;
      audienceKind: MessageAudienceKind;
      requiresCode?: boolean;
    },
  ): Promise<{ template: MessageTemplate }>;
  validateUpload(
    id: string,
    templateId: string,
    rows: Array<{ firmName: string; email: string; organizationId?: string | null }>,
  ): Promise<UploadCheckResult>;
  sendInvitationBatch(
    id: string,
    body: {
      templateId: string;
      audienceId: string;
      uploadRows?: Array<{ firmName: string; email: string; organizationId?: string | null }>;
    },
  ): Promise<SendBatchResult>;
  listInvitationBatches(id: string): Promise<{ batches: MessageBatch[] }>;
  getInvitationBatchReport(batchId: string): Promise<{ report: BatchReport }>;
  getBouncedRecipients(batchId: string): Promise<{ bounced: MessageRecipient[] }>;
  listInvitationRequests(
    id: string,
    includeResolved?: boolean,
  ): Promise<{ requests: InvitationRequestItem[] }>;
  resolveInvitationRequest(
    requestId: string,
    resolution: 'code_issued' | 'marked_done',
    reissueTemplateId?: string,
  ): Promise<{ request: InvitationRequestItem }>;
  getInstrumentItems(code: string): Promise<SurveyItem[]>;
  requestFreeze(id: string, reason: string): Promise<{ criticalActionId: string }>;
  decideFreeze(
    id: string,
    actionId: string,
    approved: boolean,
    rejectionReason?: string,
  ): Promise<{ status: 'approved' | 'rejected'; frozen: boolean }>;
  // Firm coordinator team (UX-FRM-007) — ordinary account admin, not maker-checker.
  listFirms(): Promise<FirmSummary[]>;
  listCoordinators(orgId: string): Promise<Coordinator[]>;
  createLeadCoordinator(
    orgId: string,
    body: { name: string; email: string; role?: string; phone?: string },
  ): Promise<Coordinator>;
  addCoordinator(
    orgId: string,
    body: { name: string; email: string; role?: string; phone?: string },
  ): Promise<Coordinator>;
  setCoordinatorPin(
    orgId: string,
    coordinatorId: string,
    body: { newPin: string; currentPin?: string },
  ): Promise<{ ok: boolean }>;
  handoverLead(
    orgId: string,
    body: { actingCoordinatorId: string; newLeadCoordinatorId: string },
  ): Promise<{
    outgoing: { id: string; isLead: boolean };
    incoming: { id: string; isLead: boolean };
  }>;
  removeCoordinator(orgId: string, coordinatorId: string): Promise<{ removed: boolean }>;
  // People & Access (UX-OPS-006)
  getPeople(): Promise<PeopleResponse>;
  addPerson(input: PersonInput): Promise<{ person: PersonAccess }>;
  updatePersonRights(userId: string, input: PersonInput): Promise<{ person: PersonAccess }>;
  removePerson(userId: string): Promise<{ removed: boolean }>;
  // Responses monitoring (UX-OPS-003)
  getResponsesMonitor(editionId: string): Promise<ResponsesMonitor>;
  // Reminder timing (UX-OPS-004)
  getUnfinished(editionId: string): Promise<UnfinishedResponse>;
  setReminderSchedule(schedule: ReminderSchedule): Promise<{ schedule: ReminderSchedule }>;
  setReminderCap(cap: number): Promise<{ cap: number }>;
  /** Generic escape hatch — used by surfaces that call many endpoints without adding per-method stubs. */
  get<T = unknown>(path: string): Promise<T>;
  post<T = unknown>(path: string, body: unknown): Promise<T>;
  put<T = unknown>(path: string, body: unknown): Promise<T>;
}

/** Build a client bound to an auth token. */
/** Seconds-since-epoch expiry of a JWT, or null when it cannot be read. */
export function tokenExpiry(token: string): number | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const payload = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))) as {
      exp?: unknown;
    };
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

// Renew once less than this much of the token's life remains (tokens last 8h).
const REFRESH_WHEN_REMAINING_MS = 4 * 60 * 60 * 1000;

export interface SessionHooks {
  /** A renewed token was issued; persist it. */
  onToken?: (token: string) => void;
  /** The server no longer accepts the session; sign the operator out. */
  onUnauthorized?: () => void;
}

export function createClient(token: string | null, hooks: SessionHooks = {}): AdminClient {
  let refreshing = false;

  // Every call below goes through this wrapper: it renews a token that is past
  // half its life (a sliding session, so active work is never cut off at a
  // fixed 8h), and turns a rejected session into a sign-out instead of an
  // "Invalid session" error left on whatever screen happened to be open.
  const request = async <T>(path: string, opts: RequestOptions = {}): Promise<T> => {
    if (token && !refreshing && hooks.onToken) {
      const exp = tokenExpiry(token);
      if (exp !== null && exp * 1000 - Date.now() < REFRESH_WHEN_REMAINING_MS) {
        refreshing = true;
        const onToken = hooks.onToken;
        void baseRequest<{ token: string }>('/auth/refresh', { method: 'POST', token })
          .then((r) => onToken(r.token))
          .catch(() => {
            refreshing = false;
          });
      }
    }
    try {
      return await baseRequest<T>(path, opts);
    } catch (err) {
      if (opts.token && err instanceof ApiError && err.statusCode === 401) {
        hooks.onUnauthorized?.();
      }
      throw err;
    }
  };

  return {
    listEditions: () => request('/editions', { token }),
    getEdition: (id) => request(`/editions/${id}`, { token }),
    setFloors: (id, floors) =>
      request(`/editions/${id}/floors`, { method: 'PATCH', body: { floors }, token }),
    setClosingDate: (id, closingDate) =>
      request(`/editions/${id}/closing-date`, {
        method: 'PATCH',
        body: { closingDate },
        token,
      }),
    setOpeningDate: (id, openDate) =>
      request(`/editions/${id}/opening-date`, {
        method: 'PATCH',
        body: { openDate },
        token,
      }),
    requestLock: (id, reason) =>
      request(`/editions/${id}/lock/request`, { method: 'POST', body: { reason }, token }),
    decideLock: (id, actionId, approved, rejectionReason) =>
      request(`/editions/${id}/lock/${actionId}/decide`, {
        method: 'POST',
        body: { approved, rejectionReason },
        token,
      }),
    getInstruments: (id) => request(`/editions/${id}/instruments`, { token }),
    getMissionBoard: (id) => request(`/editions/${id}/mission-board`, { token }),
    triggerScoringRun: (id) => request(`/editions/${id}/scoring-runs`, { method: 'POST', token }),
    getScoringRuns: (id) => request(`/editions/${id}/scoring-runs`, { token }),
    getScoreView: (id, runId) => request(`/editions/${id}/scoring-runs/${runId}/scores`, { token }),
    requestSignoff: (id, runId, checkedAccount) =>
      request(`/editions/${id}/scoring-runs/${runId}/signoff/request`, {
        method: 'POST',
        body: { checkedAccount },
        token,
      }),
    approveSignoff: (signoffId) =>
      request(`/scoring-signoffs/${signoffId}/approve`, {
        method: 'POST',
        body: {},
        token,
      }),
    rejectSignoff: (signoffId, reason) =>
      request(`/scoring-signoffs/${signoffId}/reject`, {
        method: 'POST',
        body: { reason },
        token,
      }),
    generateNationalReport: (id, scoringRunId, context) =>
      request(`/editions/${id}/national-report`, {
        method: 'POST',
        body: { scoringRunId, context },
        token,
      }),
    getLatestNationalReport: (id) => request(`/editions/${id}/national-report`, { token }),
    getSufficiency: (id) => request(`/editions/${id}/sufficiency`, { token }),
    getNationalReport: (reportId) => request(`/national-reports/${reportId}`, { token }),
    openNationalDraft: (reportId) =>
      request(`/national-reports/${reportId}/open`, { method: 'POST', token }),
    requestNationalApproval: (reportId, reason) =>
      request(`/national-reports/${reportId}/request-approval`, {
        method: 'POST',
        body: { reason },
        token,
      }),
    approveNationalReport: (reportId) =>
      request(`/national-reports/${reportId}/approve`, {
        method: 'POST',
        body: {},
        token,
      }),
    getRegulators: (id) => request(`/editions/${id}/regulators`, { token }),
    getRegulator: (id, inst, fam) =>
      request(`/editions/${id}/regulators/${inst}/${fam}`, { token }),
    saveRegulatorContact: (id, inst, fam, contact) =>
      request(`/editions/${id}/regulators/${inst}/${fam}/contact`, {
        method: 'PUT',
        body: contact,
        token,
      }),
    issueRegulatorLink: (id, inst, fam, targetBy) =>
      request(`/editions/${id}/regulators/${inst}/${fam}/issue-link`, {
        method: 'POST',
        body: { targetBy },
        token,
      }),
    remindRegulator: (id, inst, fam, textOnly) =>
      request(
        `/editions/${id}/regulators/${inst}/${fam}/${textOnly ? 'text-reminder' : 'reminder'}`,
        { method: 'POST', token },
      ),
    declineRegulator: (id, inst, fam) =>
      request(`/editions/${id}/regulators/${inst}/${fam}/decline`, { method: 'POST', token }),
    reopenRegulator: (id, inst, fam) =>
      request(`/editions/${id}/regulators/${inst}/${fam}/reopen`, { method: 'POST', token }),
    addRegulatorHistory: (id, inst, fam, entry) =>
      request(`/editions/${id}/regulators/${inst}/${fam}/history`, {
        method: 'POST',
        body: { entry },
        token,
      }),
    getFirmReports: (id) => request(`/editions/${id}/firm-reports`, { token }),
    getIndustryReport: (id) => request(`/editions/${id}/reports/industry`, { token }),
    getFirmReport: (id, firmId) => request(`/editions/${id}/firms/${firmId}/report`, { token }),
    generateIndustryNarrative: (id) =>
      request(`/editions/${id}/reports/industry/narrative`, { method: 'POST', token }),
    generateFirmNarrative: (id, firmId) =>
      request(`/editions/${id}/firms/${firmId}/report/narrative`, { method: 'POST', token }),
    ensureIndustryNarrative: (id) =>
      request(`/editions/${id}/reports/industry/narrative/ensure`, { method: 'POST', token }),
    ensureFirmNarrative: (id, firmId) =>
      request(`/editions/${id}/firms/${firmId}/report/narrative/ensure`, {
        method: 'POST',
        token,
      }),
    publishIndustryReport: (id) =>
      request(`/editions/${id}/reports/industry/publish`, { method: 'POST', token }),
    downloadIndustryPdf: (id) => requestBlob(`/editions/${id}/reports/industry/pdf`, token),
    downloadFirmPdf: (id, firmId) =>
      requestBlob(`/editions/${id}/firms/${firmId}/report/pdf`, token),
    generateFirmReports: (id, scoringRunId) =>
      request(`/editions/${id}/firm-reports/generate`, {
        method: 'POST',
        body: { scoringRunId },
        token,
      }),
    approveFirmReport: (reportId) =>
      request(`/firm-reports/${reportId}/approve`, { method: 'POST', token }),
    regenerateFirmReport: (reportId) =>
      request(`/firm-reports/${reportId}/regenerate`, { method: 'POST', token }),
    releaseFirmReports: (id) =>
      request(`/editions/${id}/firm-reports/release`, { method: 'POST', token }),
    listAudiences: (id) => request(`/editions/${id}/invitations/audiences`, { token }),
    resolveFirmNames: (id, firmNames) =>
      request(`/editions/${id}/invitations/resolve-firm-names`, {
        method: 'POST',
        body: { firmNames },
        token,
      }),
    listMessageTemplates: (id) => request(`/editions/${id}/invitations/templates`, { token }),
    saveMessageTemplate: (id, body) =>
      request(`/editions/${id}/invitations/templates`, { method: 'POST', body, token }),
    validateUpload: (id, templateId, rows) =>
      request(`/editions/${id}/invitations/validate-upload`, {
        method: 'POST',
        body: { templateId, rows },
        token,
      }),
    sendInvitationBatch: (id, body) =>
      request(`/editions/${id}/invitations/send`, { method: 'POST', body, token }),
    listInvitationBatches: (id) => request(`/editions/${id}/invitations/batches`, { token }),
    getInvitationBatchReport: (batchId) =>
      request(`/invitations/batches/${batchId}/report`, { token }),
    getBouncedRecipients: (batchId) =>
      request(`/invitations/batches/${batchId}/bounced`, { token }),
    listInvitationRequests: (id, includeResolved) =>
      request(
        `/editions/${id}/invitations/requests${includeResolved ? '?includeResolved=true' : ''}`,
        { token },
      ),
    resolveInvitationRequest: (requestId, resolution, reissueTemplateId) =>
      request(`/invitations/requests/${requestId}/resolve`, {
        method: 'POST',
        body: { resolution, ...(reissueTemplateId ? { reissueTemplateId } : {}) },
        token,
      }),
    getInstrumentItems: (code) =>
      request<{ items: SurveyItem[] }>(`/instruments/${encodeURIComponent(code)}/items`, {
        token,
      }).then((r) => r.items),
    requestFreeze: (id, reason) =>
      request(`/editions/${id}/instruments/freeze/request`, {
        method: 'POST',
        body: { reason },
        token,
      }),
    decideFreeze: (id, actionId, approved, rejectionReason) =>
      request(`/editions/${id}/instruments/freeze/${actionId}/decide`, {
        method: 'POST',
        body: { approved, rejectionReason },
        token,
      }),
    listFirms: () => request<{ firms: FirmSummary[] }>('/firms', { token }).then((r) => r.firms),
    listCoordinators: (orgId) =>
      request<{ coordinators: Coordinator[] }>(`/firms/${orgId}/coordinators`, { token }).then(
        (r) => r.coordinators,
      ),
    createLeadCoordinator: (orgId, body) =>
      request<{ coordinator: Coordinator }>(`/firms/${orgId}/coordinators/lead`, {
        method: 'POST',
        body,
        token,
      }).then((r) => r.coordinator),
    addCoordinator: (orgId, body) =>
      request<{ coordinator: Coordinator }>(`/firms/${orgId}/coordinators`, {
        method: 'POST',
        body,
        token,
      }).then((r) => r.coordinator),
    setCoordinatorPin: (orgId, coordinatorId, body) =>
      request(`/firms/${orgId}/coordinators/${coordinatorId}/pin`, {
        method: 'POST',
        body,
        token,
      }),
    handoverLead: (orgId, body) =>
      request(`/firms/${orgId}/coordinators/handover`, { method: 'POST', body, token }),
    removeCoordinator: (orgId, coordinatorId) =>
      request(`/firms/${orgId}/coordinators/${coordinatorId}`, { method: 'DELETE', token }),
    getPeople: () => request('/people', { token }),
    addPerson: (input) => request('/people', { method: 'POST', body: input, token }),
    updatePersonRights: (userId, input) =>
      request(`/people/${userId}`, { method: 'PATCH', body: input, token }),
    removePerson: (userId) => request(`/people/${userId}`, { method: 'DELETE', token }),
    getResponsesMonitor: (editionId) =>
      request(`/editions/${editionId}/responses-monitor`, { token }),
    getUnfinished: (editionId) => request(`/editions/${editionId}/unfinished`, { token }),
    setReminderSchedule: (schedule) =>
      request('/reminders/schedule', { method: 'PUT', body: schedule, token }),
    setReminderCap: (cap) => request('/reminders/cap', { method: 'PUT', body: { cap }, token }),
    get: <T = unknown>(path: string) => request<T>(path, { token }),
    post: <T = unknown>(path: string, body: unknown) =>
      request<T>(path, { method: 'POST', body, token }),
    put: <T = unknown>(path: string, body: unknown) =>
      request<T>(path, { method: 'PUT', body, token }),
  };
}
