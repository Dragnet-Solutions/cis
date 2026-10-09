// Types mirroring the Fastify route zod schemas (§4 of the Phase 1 brief).
// Dates cross the wire as ISO strings.
import type { EditionPhase } from '../editionPhase';

export type EditionStatus = 'draft' | 'open' | 'locked' | 'archived';

export type SampleFloorCategory = 'firm' | 'retail' | 'local_institution' | 'foreign_institution';

export interface SampleFloor {
  category: SampleFloorCategory;
  floorValue: number;
}

export interface PendingAction {
  id: string;
  reason: string;
  requestedAt: string;
  requestedBy: { id: string; displayName: string; org: string | null };
}

export interface EditionSummary {
  id: string;
  label: string;
  status: EditionStatus;
}

export interface EditionDetail {
  id: string;
  label: string;
  status: EditionStatus;
  surveyOpenAt: string | null;
  /** Study-team-configured launch instant (Phase 19, item 2) — draft-only. */
  plannedOpenAt: string | null;
  surveyCloseAt: string | null;
  lockedAt: string | null;
  frozen: boolean;
  floors: SampleFloor[];
  pendingLock: PendingAction | null;
  /** Set only when the planned launch instant has passed but the instrument
   *  set is not frozen — surface this loudly, never silently. */
  openingProblem: 'launch_date_passed_not_frozen' | null;
}

export interface Instrument {
  code: string;
  name: string;
  respondent: string | null;
  feeds: string | null;
  scored: boolean;
  frozen: boolean;
  questionCount: number | null;
}

export interface DrgOpsQuestion {
  questionCode: string;
  instrumentCode: string;
  instrumentName: string;
}

export interface InstrumentsResponse {
  frozen: boolean;
  pendingFreeze: PendingAction | null;
  instruments: Instrument[];
  drgOps: DrgOpsQuestion[];
}

// Mirrors @cis/shared-types' MissionCard/MissionSeverity — the mission board
// endpoint's real, live-computed output (UX-OPS-001). No illustrative or
// example content belongs here; every field is a real evaluated value.
export type MissionSeverity = 1 | 2 | 3 | 4 | 5 | 6;

export interface MissionCard {
  conditionId: number;
  severity: MissionSeverity;
  whatIsAtRisk: string;
  evidence: string[];
  consequence: string[];
  why: string | null;
  recommendedAction: { label: string; cohort: string; audienceId: string | null } | null;
  expectedImpact?: string;
  projectedShortfall: number;
  kind?: 'mission' | 'methodology_block';
}

export interface MissionBoardResponse {
  cards: MissionCard[];
  phase: EditionPhase;
}

// ─── Scoring & sign-off (UX-ADM-004) ────────────────────────────────────────

export type CalculationRunStatus = 'pending' | 'running' | 'complete' | 'failed';

export interface CalculationRun {
  id: string;
  editionId: string;
  runType: 'eligibility' | 'scoring' | 'comparison';
  status: CalculationRunStatus;
  startedAt: string;
  finishedAt: string | null;
  createdAt: string;
  /** APPROVED once the run was made under the two-person-approved methodology. */
  methodologyVersion?: string | null;
  methodologyStatus?: 'TEST_UNAPPROVED' | 'APPROVED' | null;
}

export type ScoringSignoffState = 'requested' | 'signed_off' | 'superseded' | 'rejected';

export interface ScoringCheckedAccount {
  populationCountsReviewed: boolean;
  floorStatusReviewed: boolean;
  dataQualityFlagsReviewed: boolean;
  notes?: string;
}

export interface ScoringSignoff {
  id: string;
  editionId: string;
  calculationRunId: string;
  state: ScoringSignoffState;
  checkedAccount: ScoringCheckedAccount;
  requestedBy: string;
  requestedAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectedBy: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
}

export interface IndexScoreView {
  metricCode: string;
  score: number | null;
  populationLabel: string;
  effectivePopulation: number | null;
  floor: number | null;
  clearsFloor: boolean | null;
  subFloor: boolean;
  provisional: boolean;
  populationGap: boolean;
}

export interface ScoringRunsResponse {
  runs: CalculationRun[];
  signoffs: ScoringSignoff[];
  authoritative: ScoringSignoff | null;
  /** Display name per operator identifier on the sign-off rows. */
  operatorNames: Record<string, string>;
}

// ─── Invitations (UX-OPS-002) ───────────────────────────────────────────────

export type MessageAudienceKind = 'firm' | 'participant' | 'regulator' | 'upload';

export interface MessageTemplate {
  id: string;
  editionId: string;
  name: string;
  subject: string;
  body: string;
  audienceKind: MessageAudienceKind;
  requiresCode: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export type MessageDeliveryState = 'sent' | 'delivered' | 'bounced';

export interface MessageBatch {
  id: string;
  editionId: string;
  templateId: string;
  audienceId: string;
  audienceLabel: string;
  sendingService: string;
  sentBy: string | null;
  sentAt: string;
  createdAt: string;
}

export interface AudienceCategory {
  key: 'firms' | 'regs' | 'parts' | 'other';
  label: string;
  audiences: Array<{ id: string; label: string; sub: string; count: number | null }>;
}

export interface BatchReport {
  batch: MessageBatch;
  templateName: string;
  firms: number;
  delivered: number;
  bounced: number;
  opened: number;
  clicked: number;
  opensReported: boolean;
  clicksReported: boolean;
  deliveredNeverOpened: number;
  openedNotClicked: number;
}

export type UploadCheckKind =
  'no_address' | 'malformed_address' | 'in_file_duplicate' | 'already_sent';

export interface UploadCheckResult {
  validRows: Array<{ firmName: string; email: string }>;
  problems: Array<{ kind: UploadCheckKind; row: number; value: string }>;
}

export interface MessageRecipient {
  id: string;
  batchId: string;
  organizationId: string | null;
  recipientEmail: string | null;
  firmName: string | null;
  deliveryState: MessageDeliveryState;
}

export interface InvitationRequestItem {
  id: string;
  editionId: string;
  organizationId: string | null;
  firmName: string;
  requesterName: string;
  role: string | null;
  email: string;
  phone: string | null;
  flag: string | null;
  resolved: boolean;
  resolution: 'code_issued' | 'marked_done' | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

export interface SendBatchResult {
  batchId: string;
  attempted: number;
  sent: number;
  skippedDuplicates: number;
}

export interface FirmSummary {
  id: string;
  displayName: string;
  slug: string;
}

/** What a firm directory import would do (dry run) or did. */
export interface FirmImportResult {
  dryRun: boolean;
  totalRows: number;
  added: number;
  toAdd: Array<{ line: number; name: string; slug: string }>;
  duplicates: Array<{ line: number; name: string; slug: string; reason: string }>;
  errors: Array<{ line: number; message: string }>;
  /** Firms enrolled in the edition (null when no edition was given). */
  enrolled: number | null;
  enrolmentNote: string | null;
}

// ─── National report (UX-ADM-005) ───────────────────────────────────────────

export type NationalReportSectionId =
  | 'PUB_01_HEADLINE_INDICES'
  | 'PUB_02_SEGMENT_IEI_ICI'
  | 'PUB_03_OPERATIONAL_FRICTIONS'
  | 'PUB_04_INVESTOR_FRUSTRATIONS'
  | 'PUB_05_MATURITY_HEATMAP'
  | 'PUB_06_CONFIDENCE_AND_PARTICIPATION'
  | 'PUB_07_LOCAL_VS_FOREIGN'
  | 'PUB_08_CROSS_INDUSTRY_BENCHMARK'
  | 'PUB_09_SERVICE_EXCELLENCE_GAP'
  | 'PUB_10_INSTITUTIONAL_PERSPECTIVES';

export type SectionSufficiencyDisposition = 'publishable' | 'caveated' | 'suppressed';
export type ReviewDisposition = 'ACCEPT_AND_EDIT' | 'REJECT_WITH_REASON' | 'SUPPRESS_CLAIM';
export type NationalReportStatus = 'draft' | 'approved';

export interface NationalReport {
  id: string;
  editionId: string;
  scoringRunId: string;
  status: NationalReportStatus;
  draftOpened: boolean;
  requestedBy: string | null;
  requestedReason: string | null;
  requestedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
}

export interface NationalReportSection {
  id: string;
  nationalReportId: string;
  sectionId: NationalReportSectionId;
  disposition: SectionSufficiencyDisposition;
  reason: string | null;
  /** Human name of the section, e.g. "The five headline scores". */
  name?: string;
}

export interface NationalApprovalPreconditions {
  signedScoringRun: boolean;
  draftOpened: boolean;
  /** A written draft (the AI narrative) has been recorded for review. */
  draftReviewable?: boolean;
  allFindingsDisposed: boolean;
  checkerHealthy: boolean;
  ok: boolean;
  reasons: string[];
}

/** The sentence-level review of the national report's draft (the AI narrative). */
export interface NationalReview {
  narrativeId: string | null;
  model: string | null;
  draftedAt: string | null;
  items: Array<{
    sentenceId: string;
    narrativeIndex: number;
    section: string | null;
    text: string;
    factIds: string[];
    finding: { id: string; kind: string; why: string } | null;
    disposition: {
      disposition: 'ACCEPT_AND_EDIT' | 'REJECT_WITH_REASON' | 'SUPPRESS_CLAIM';
      reason: string | null;
      disposedBy: string;
      disposedAt: string;
    } | null;
  }>;
  health: {
    seededTotal: number;
    detected: number;
    thresholdRate: number;
    healthy: boolean;
    checkedAt: string;
  } | null;
}

export interface NationalReportDetailResponse {
  report: NationalReport;
  sections: NationalReportSection[];
  preconditions: NationalApprovalPreconditions;
  /** Display name per operator identifier on the report. */
  operatorNames: Record<string, string>;
}

// ─── Firm reports (UX-ADM-006) ──────────────────────────────────────────────

export type FirmReportCutState = 'none' | 'directional' | 'unlocked';
export type FirmReportGenerationState = 'pending' | 'generating' | 'generated' | 'failed';
export type FirmReportApprovalState = 'pending' | 'approved';
export type FirmReportReleaseState = 'unreleased' | 'held' | 'released';

export interface FirmReport {
  id: string;
  editionId: string;
  organizationId: string;
  scoringRunId: string;
  version: number;
  retailN: number;
  cutState: FirmReportCutState;
  generationState: FirmReportGenerationState;
  approvalState: FirmReportApprovalState;
  releaseState: FirmReportReleaseState;
  heldReason: string | null;
}

/** A request to release firm reports, awaiting a second person. */
export interface PendingFirmReportRelease extends PendingAction {
  reportIds: string[];
}

export interface FirmReportReleaseDecision extends Partial<ReleaseFirmReportsResult> {
  status: 'approved' | 'rejected';
  /** Set when the reports were approved but the release then failed. */
  releaseError: string | null;
}

export interface ReleaseFirmReportsResult {
  /** How the release notices to the firms' coordinators went. */
  notified: { sent: number; logged: number; failed: number };
  released: string[];
  held: { organizationId: string; reason: string }[];
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

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  org: string | null;
  hasDragnetRight: boolean;
}

export interface LoginResponse {
  token: string;
  user: AuthUser;
}

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// ─── People & Access (UX-OPS-006) ───────────────────────────────────────────

export type AccessRightKey = 'view' | 'send' | 'regs' | 'setup' | 'request' | 'approve' | 'dragnet';
export type AccessOrg = 'CIS' | 'Dragnet';

export interface PersonAccess {
  userId: string;
  name: string;
  email: string;
  organization: AccessOrg;
  rights: Record<AccessRightKey, boolean>;
  canRequest: boolean;
  canApprove: boolean;
}

export interface PeopleResponse {
  people: PersonAccess[];
  approvers: number;
  criticalActions: Array<{ action: string; where: string; why: string }>;
}

export interface PersonInput {
  name: string;
  email: string;
  organization: AccessOrg;
  rights: Partial<Record<Exclude<AccessRightKey, 'view'>, boolean>>;
}

// ─── Responses monitoring (UX-OPS-003) ──────────────────────────────────────

export type SegmentCardState = 'on_track' | 'will_miss' | 'closed';

export interface CompleteFirmLine {
  metric: 'OMI' | 'DMI';
  requiredInstruments: string[];
  current: number;
  forecast: number | null;
  state: SegmentCardState;
}

export interface SegmentCard {
  segment: string;
  label: string;
  current: number;
  target: number;
  greyBarPct: number;
  redMarkerPct: number | null;
  forecast: number | null;
  shortfall: number;
  velocity: number | null;
  requiredVelocity: number | null;
  daysRemaining: number;
  state: SegmentCardState;
  boardConditionId: number;
  completeFirm?: CompleteFirmLine[];
}

export type DependencyDisplayState = 'guaranteed' | 'some_suppressed' | 'at_risk' | 'on_track';

export interface DependencyRow {
  outputId: string;
  dependsOn: string[];
  requiredInstruments: string[] | null;
  enabled: boolean;
  displayState: DependencyDisplayState;
  note: string;
  /** Regulator-dependent outputs only: regulators that have responded, of those required. */
  regulators?: { confirmed: number; required: number };
}

export interface ResponsesMonitor {
  cards: SegmentCard[];
  dependencies: DependencyRow[];
  funnelDiagnosis: unknown;
  industrySeiNotCalculable: boolean;
}

// ─── Reminder timing (UX-OPS-004) ───────────────────────────────────────────

export interface ReminderStepConfig {
  step: number;
  kind: 'relative' | 'before_close';
  days?: number;
  beforeCloseDays?: number;
  enabled: boolean;
}

export interface ReminderSchedule {
  steps: ReminderStepConfig[];
}

export interface UnfinishedStats {
  unfinished: number;
  reachable: number;
  unreachable: number;
}

export interface DropoffBucket {
  questionId: string;
  /** The question's wording, or a plain description — never the raw code. */
  label: string;
  surveyName: string | null;
  count: number;
  peak: boolean;
}

export interface UnfinishedResponse {
  stats: UnfinishedStats;
  dropoff: DropoffBucket[];
  schedule: ReminderSchedule;
  cap: number;
}

// ─── Regulators (UX-OPS-007) ────────────────────────────────────────────────

export type RegulatorFamilyCode = 'A' | 'B' | 'C' | 'D';

export interface RegulatorContact {
  who: string;
  role: string;
  email: string;
  phone: string;
  /** "How we got to them" — a note for whoever picks the relationship up next. */
  how: string;
}

export type RegulatorSurveyState =
  'no_contact' | 'contact_added' | 'invited' | 'confirmed' | 'declined';

/** One (institution, family) role — CSCS holding two roles is two of these. */
export interface RegulatorView {
  institutionId: string;
  familyCode: RegulatorFamilyCode;
  name: string;
  mandate: string;
  status: 'not_started' | 'invited' | 'in_progress' | 'confirmed' | 'declined';
  state: RegulatorSurveyState;
  contact: RegulatorContact | null;
  /** The API resume path, `/journeys/resume/<token>` — not a respondent URL. */
  surveyLink: string | null;
  targetBy: string | null;
  overdue: boolean;
  nextStep: string;
  /** Newest first. */
  history: Array<{ id: string; entry: string; createdAt: string }>;
}

// ─── Report documents (Industry report, private Firm report) ────────────────

/** A share of respondents citing something (0–100) and how many cited it. */
export interface ReportShare {
  label: string;
  pct: number;
  count: number;
}

/** An average rating on 0–100; null when there are too few ratings to show (n < 10). */
export interface ReportRating {
  value: number | null;
  n: number;
}

/** One index score as a report shows it. */
export interface ReportIndexScore {
  code: string;
  name: string;
  value: number | null;
  n: number | null;
  note: string | null;
}

/** The five indices from the signed run made under the approved methodology. */
export interface ReportIndicesReported {
  state: 'reported';
  methodology: string;
  runId: string;
  industry: ReportIndexScore[];
  firm: ReportIndexScore[] | null;
  segments: Array<{ segment: string; label: string; iei: ReportRating; ici: ReportRating }>;
  tiers: Array<{ tier: string; firms: number; omi: number; dmi: number | null }> | null;
  tiersNote: string | null;
}

export type ReportIndices = ReportPending | ReportIndicesReported;

export interface ReportPending {
  state: 'pending_methodology';
  note: string;
}

/** One institution's reading, in one of its roles (Institutional Perspectives). */
export interface InstitutionalReading {
  key: string;
  role: string;
  code: string;
  familyCode: string;
  vantage: string;
  responses: number;
  topIssues: ReportShare[];
  issue: { greatest: string | null; others: string[] };
  frequency: string | null;
  marks: string[];
  consequence: { greatest: string | null; others: string[] };
  capability: string | null;
}

/** The AI-drafted narrative in force for a report document. */
export interface ReportNarrativeView {
  model: string;
  createdAt: string;
  /** Operator views only — never sent with a released or published report. */
  createdBy?: string;
  sentences: Array<{
    section: string;
    text: string;
    factIds: string[];
    /** Set when the checker held the sentence back — never rendered in the report. */
    finding: { kind: string; why: string } | null;
  }>;
}

export interface IndustryReportContent {
  edition: { id: string; label: string; status: string };
  generatedAt: string;
  sections: Array<{
    id: string;
    name: string;
    disposition: 'publishable' | 'caveated' | 'suppressed';
    reason: string | null;
  }> | null;
  participation: Array<{
    segment: string;
    label: string;
    target: number;
    achieved: number;
    meets: boolean;
  }>;
  indices: ReportIndices;
  frictions: { base: number; items: ReportShare[] } | null;
  frustrations: { base: number; items: ReportShare[] } | null;
  participationImpact: { base: number; items: ReportShare[] } | null;
  confidenceLevers: { base: number; items: ReportShare[] } | null;
  localVsForeign: {
    localN: number;
    foreignN: number;
    rows: Array<{ label: string; local: ReportRating; foreign: ReportRating }>;
  };
  comparators: {
    base: number;
    rows: Array<{ comparator: string; better: number; same: number; worse: number; n: number }>;
  } | null;
  selfVsInvestors: { firmSelfBelief: ReportRating; investorExperience: ReportRating };
  institutional: InstitutionalReading[];
  institutionalParticipation: { invited: number; contributed: number };
  institutionalThemes: { themes: Array<{ theme: string; codes: string[] }>; standsApart: string[] };
  narrative: ReportNarrativeView | null;
  /** When the document left CIS (released to its firm / published); then final. */
  publishedAt?: string | null;
}

export interface FirmReportContent {
  edition: { id: string; label: string; status: string };
  generatedAt: string;
  firm: { id: string; name: string };
  report: {
    retailN: number;
    cutState: 'none' | 'directional' | 'unlocked';
    approvalState: string;
    releaseState: string;
  };
  margin: number;
  indices: ReportIndices;
  dimensions: Array<{
    key: 'ease' | 'responsiveness' | 'transparency' | 'trust';
    label: string;
    firm: ReportRating;
    industry: ReportRating;
    sources: string;
  }>;
  selfVsInvestors: {
    firmSelfBelief: ReportRating;
    investorExperience: ReportRating;
    industrySelfBelief: ReportRating;
    industryInvestorExperience: ReportRating;
  };
  retailCut: {
    state: 'none' | 'directional' | 'unlocked';
    n: number;
    dimensions: Array<{ label: string; firm: ReportRating; industry: ReportRating }>;
  };
  agenda: Array<{ title: string; detail: string; priority: 'high' | 'medium' | 'sustain' }>;
  narrative: ReportNarrativeView | null;
  /** When the document left CIS (released to its firm / published); then final. */
  publishedAt?: string | null;
}

/** The scoring methodology's two-person approval (Runbook §5.2). */
export interface MethodologyApprovalView {
  methodology: { id: string; version: string };
  approved: {
    actionId: string;
    requestedBy: string;
    approvedBy: string;
    approvedAt: string;
    reason: string;
  } | null;
  pending: { actionId: string; requestedBy: string; requestedAt: string; reason: string } | null;
  viewerId: string;
  operatorNames: Record<string, string>;
}
