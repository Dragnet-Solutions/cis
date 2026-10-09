// ─── Domain enumerations ─────────────────────────────────────────────────────

export type EditionStatus = 'draft' | 'open' | 'locked' | 'archived';

export type OrganizationType = 'firm' | 'institution' | 'regulator';

export type ParticipationStatus = 'invited' | 'active' | 'completed' | 'withdrawn';

export type CriticalActionStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

/** Standard permission vs. one half of a maker-checker pair. */
export type PermissionType =
  'standard' | 'can_request_critical_action' | 'can_approve_critical_action';

export type InstrumentType = 'survey' | 'institutional' | 'regulator';

/** Respondent categories a sample-sufficiency floor can be set for. */
export type SampleFloorCategory = 'firm' | 'retail' | 'local_institution' | 'foreign_institution';

/** The eight controlled question kinds from the Survey Register. */
export type QuestionKind =
  'scale' | 'single' | 'yesno' | 'select' | 'multi' | 'rank' | 'grid' | 'open';

/** Whether an item is answered once or repeats per rated firm. */
export type QuestionScope = 'shared' | 'firm_specific';

// ─── Core entities ────────────────────────────────────────────────────────────

export type InvestorCategoryServed =
  'retail' | 'local_institutional' | 'foreign_institutional' | 'not_sure';

export interface Organization {
  id: string;
  slug: string;
  displayName: string;
  orgType: OrganizationType;
  isActive: boolean;
  metadata: Record<string, unknown>;
  /** UX-FRM-002: the firm's own declaration of investor categories it serves.
   *  Provably inert — never read by any scoring, eligibility or evidence-pack
   *  code path. Editable at any time, no gate. */
  investorCategoriesServed: InvestorCategoryServed[];
  createdAt: Date;
  updatedAt: Date;
}

export interface Edition {
  id: string;
  label: string;
  status: EditionStatus;
  surveyOpenAt: Date | null;
  /** Phase 19 (item 2) — the study-team-configured launch instant. Distinct
   *  from `surveyOpenAt` (the real moment opening happened): this is the
   *  plan, that is the fact. Lazy-evaluated (no cron) on edition reads. */
  plannedOpenAt: Date | null;
  surveyCloseAt: Date | null;
  resultsPublishedAt: Date | null;
  priorEditionId: string | null;
  lockedAt: Date | null;
  lockedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface EditionParticipation {
  id: string;
  editionId: string;
  organizationId: string;
  status: ParticipationStatus;
  invitedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface InstrumentDefinition {
  id: string;
  code: string;
  name: string;
  instrumentType: InstrumentType;
  /**
   * Whether this instrument's answers may ever feed a calculation/index.
   * This is a real gate (enforced when calculation definitions are built in
   * Phase 4), not a UI badge. Six survey instruments are scored; the three
   * regulator/contextual instruments are not.
   */
  scored: boolean;
  createdAt: Date;
}

/**
 * A single question within an instrument.
 *
 * `is_drg_ops` marks a Dragnet operational question folded invisibly into a
 * scored instrument's flow. DRG-OPS questions are never scored, carry no
 * respondent-visible marker distinguishing them from signed questions, and
 * must never surface in any public/firm-facing report or evidence pack. That
 * exclusion is enforced structurally by the public-question query layer.
 *
 * Phase 1 seeds only illustrative/placeholder content (flagged via
 * `isPlaceholder`). The controlled question bank arrives in Phase 2 from the
 * Survey Register — this table's shape exists now so the DRG-OPS exclusion is
 * provable today.
 */
export interface InstrumentQuestion {
  id: string;
  instrumentDefinitionId: string;
  questionCode: string;
  promptText: string;
  kind: QuestionKind;
  scope: QuestionScope;
  displayOrder: number;
  scored: boolean;
  isDrgOps: boolean;
  isPlaceholder: boolean;
  options: string[] | null;
  scaleMin: number | null;
  scaleMax: number | null;
  scaleAnchors: string | null;
  rankExactlyN: number | null;
  selectUpToN: number | null;
  hasOptionalComment: boolean;
  answerOptional: boolean;
  conditionalDetailOn: string | null;
  selectThenGreatest: boolean;
  gridRows: string[] | null;
  gridDimensions: Record<string, string[]> | null;
  gridScale: { min: number; max: number } | null;
  createdAt: Date;
}

/** A recorded survey respondent (one instrument, one edition). */
export interface Respondent {
  id: string;
  editionId: string;
  instrumentCode: string;
  /** How the respondent arrived — the source/recruiting firm. Distinct from any rated firm. */
  recruitingFirmId: string | null;
  submittedAt: Date | null;
  consentAccepted: boolean;
  /** Ordered list of firms this respondent chose to rate (multi-firm loop). */
  ratedFirmIds: string[];
  /** Current step index in the journey sequence, for resume. */
  resumeStep: number;
  /** Referral lineage (respondent → respondent). Never a firm — a referral never
   *  inherits the referrer's source firm attribution. */
  referredByRespondentId: string | null;
  /** Institution name (institutional respondents), for grouping only — never published. */
  institutionName: string | null;
  contactChannel: 'email' | 'text' | 'both' | 'none' | null;
  contactEmail: string | null;
  contactPhone: string | null;
  /** Token for the emailed/device-bound recovery link. */
  recoveryToken: string | null;
  /** Report-delivery preference; changeable post-submit without touching answers. */
  reportDelivery: string | null;
  /** UX-X-001: a genuine withdrawal, distinct from Phase 17's reminders_opted_out
   *  (which is explicitly NOT withdrawal). NULL = not withdrawn. */
  withdrawnAt: Date | null;
  createdAt: Date;
}

/** A mutable in-progress answer (autosave). Frozen into `responses` on submit. */
export interface RespondentDraft {
  id: string;
  respondentId: string;
  questionId: string;
  scope: QuestionScope;
  ratedFirmId: string | null;
  answer: { a: unknown; c?: string };
  updatedAt: Date;
}

/** A firm coordinator (ordinary account admin — not a maker-checker action). */
export interface FirmCoordinator {
  id: string;
  organizationId: string;
  name: string;
  role: string | null;
  email: string;
  phone: string | null;
  isLead: boolean;
  accessCode: string;
  revokedAt: Date | null;
  createdAt: Date;
}

/** The three outreach audiences a firm segments its own client list into. */
export type OutreachSegment = 'individual' | 'local_institutional' | 'foreign_institutional';

/** Outreach-link tracking. Counters only — never joinable to a response, and
 *  deliberately no "invitations sent" figure (the platform never sees a client
 *  list, so it cannot observe an invitation count). */
export interface OutreachLink {
  id: string;
  editionId: string;
  organizationId: string;
  token: string;
  segment: OutreachSegment | null;
  opens: number;
  starts: number;
  finishes: number;
  createdAt: Date;
}

/** The four states a firm survey seat can be in. Why a started seat stopped is
 *  deliberately not a state — it does not change the coordinator's one action. */
export type SeatState = 'empty' | 'invited' | 'started' | 'complete';

/** One of the three firm-side survey seats (S1/S2/S3) for a firm in an edition.
 *  Carries assignment + state ONLY — never any answer content. */
export interface SeatAssignment {
  id: string;
  editionId: string;
  organizationId: string;
  /** The firm survey instrument this seat owns. */
  seatCode: 'S1' | 'S2' | 'S3';
  /** Human role that owns the seat (MD / Compliance / Operations). */
  roleLabel: string;
  assignedName: string | null;
  assignedEmail: string | null;
  state: SeatState;
  /** The coordinator's own seat (assigned from the role they gave at setup). */
  isSelf: boolean;
  /** When a started seat went quiet (display string), else null. */
  stalledAt: string | null;
  /** Link to the response record for STATE tracking only — no answer access. */
  respondentId: string | null;
  /** Opaque, unguessable — the entry-point link a coordinator hands to this
   *  seat's occupant carries this, never the seat's own (stable) id.
   *  Regenerated on every assign and every clear, so a stale link (held by a
   *  replaced occupant) resolves to nothing. */
  linkToken: string;
  createdAt: Date;
  updatedAt: Date;
}

/** One firm's claim on its permanent space. One row per firm (one firm, one
 *  space). The claiming contact is shown masked and is not editable here. */
export interface FirmClaim {
  id: string;
  organizationId: string;
  claimedAt: Date;
  claimingContactName: string;
  claimingContactEmail: string;
  leadCoordinatorId: string | null;
  privacyConsent: boolean;
  /** Optional; gates nothing. The only basis on which a firm may be approached
   *  commercially (UX-ADM-007 filters on it). */
  followUpConsent: boolean;
  createdAt: Date;
}

/** A raw, immutable answer record. */
export interface Response {
  id: string;
  editionId: string;
  respondentId: string;
  /** Register question ID, stored verbatim, never dropped. */
  questionId: string;
  scope: QuestionScope;
  /** The firm being rated (firm-specific items only); null for shared items. */
  ratedFirmId: string | null;
  /** Canonical answer envelope { a, c }. */
  answer: { a: unknown; c?: string };
  createdAt: Date;
}

/**
 * Sample-sufficiency floor for one respondent category in one edition.
 * Editable only while the parent edition is in draft — setting or changing a
 * floor after collection has opened is prohibited (it would let someone choose
 * what is reportable after seeing what the data says).
 */
export interface EditionSampleFloor {
  id: string;
  editionId: string;
  category: SampleFloorCategory;
  floorValue: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface InstrumentDefinitionVersion {
  id: string;
  instrumentDefinitionId: string;
  versionNumber: number;
  /** Skeleton now; populated with full question schema in Phase 2. */
  schemaSnapshot: Record<string, unknown>;
  isFrozen: boolean;
  createdAt: Date;
  createdBy: string | null;
  frozenAt: Date | null;
  frozenBy: string | null;
}

export interface EditionInstrumentSnapshot {
  id: string;
  editionId: string;
  instrumentDefinitionVersionId: string;
  frozenAt: Date;
  frozenBy: string | null;
}

// ─── Analytics, scoring, sufficiency & evidence (Phase 5) ──────────────────────

export type FunnelEventType = 'invited' | 'opened' | 'started' | 'completed';
export type FunnelSegment = 'retail' | 'local_institution' | 'foreign_institution' | 'firm';
export type FunnelChannel = 'email' | 'sms' | 'qr' | 'portal' | 'direct';
export type FunnelSource = 'invitation' | 'colleague_share' | 'participant_referral' | 'direct';

/** One funnel event. Append-only; one `completed` per response. `firmId` is the
 *  register identifier, never a name; `institutionRef` is an opaque token. */
export interface FunnelEvent {
  eventId: string;
  eventType: FunnelEventType;
  occurredAt: Date;
  editionId: string;
  segment: FunnelSegment;
  firmId: string | null;
  institutionRef: string | null;
  channel: FunnelChannel;
  source: FunnelSource;
  responseId: string | null;
}

/** Versioned configuration for an index/sub-component — which question IDs feed
 *  it and what aggregation/weighting applies. Not a formula in code. */
export interface MetricDefinition {
  id: string;
  metricCode: string;
  version: number;
  config: {
    questionIds: string[];
    aggregation: string;
    weights?: Record<string, number>;
    [k: string]: unknown;
  };
  isProvisional: boolean;
  isActive: boolean;
  description: string | null;
  createdAt: Date;
}

export type CalculationRunType = 'eligibility' | 'scoring' | 'comparison';
export type CalculationRunStatus = 'pending' | 'running' | 'complete' | 'failed';

/** Whether a run's methodology is approved for official use. NULL = a legacy/
 *  normal run (pre-Phase-11, treated as usable). `TEST_UNAPPROVED` runs are
 *  barred structurally from official evidence packs / AI generation / released
 *  reports (Phase 11, CIS-SCORE-2026 v0.14 build note §2 — reaffirmed
 *  unchanged in v0.15, Phase 21 §2.4). */
export type MethodologyStatus = 'TEST_UNAPPROVED' | 'APPROVED';

/** Immutable run record. A correction is a new run, never an edit. */
export interface CalculationRun {
  id: string;
  editionId: string;
  runType: CalculationRunType;
  methodologyVersion: string | null;
  datasetHash: string;
  status: CalculationRunStatus;
  methodologyStatus: MethodologyStatus | null;
  startedAt: Date;
  finishedAt: Date | null;
  createdAt: Date;
}

/** The closed set of sufficiency states. NOT_CALCULABLE (Phase 11) is a
 *  methodology block — distinct from SUPPRESSED (a data problem). */
export type SufficiencyState =
  'REPORTABLE' | 'DIRECTIONAL' | 'BANDED' | 'SUPPRESSED' | 'NOT_CALCULABLE';

/**
 * Phase 21 §2.1 (v0.15) — a segment's STANDALONE display state, derived from
 * the same sufficiency floor as `SufficiencyState` (never a re-implemented
 * threshold): REPORTABLE and SUPPRESSED map directly; DIRECTIONAL and BANDED
 * both collapse to SHOWN_DIRECTIONALLY (a segment is shown, but not at full
 * precision — the distinction between a directional point value and a banded
 * proportion is a presentation detail, not a display-eligibility one).
 * NOT_CALCULABLE also collapses to SUPPRESSED — a segment with no result is
 * displayed no differently than one withheld for volume.
 *
 * This is deliberately a SEPARATE decision from a segment's POOLING
 * eligibility (`PooledSegmentInput.reportabilityFloor` in
 * `candidate-scoring-service.ts`): a segment excluded from a pooled headline
 * is not thereby SUPPRESSED for standalone display, and vice versa.
 */
export type SegmentDisplayState = 'REPORTABLE' | 'SHOWN_DIRECTIONALLY' | 'SUPPRESSED';

export type SubjectType = 'firm' | 'segment' | 'market';

/** Phase 22 (§9) — a pooled public headline's structured composition
 *  disclosure: which segments actually contributed and their achieved unit
 *  count. A non-contributing segment is OMITTED from this array entirely —
 *  never present with a zero count. */
export interface CalculatedResultComposition {
  segment: string;
  label: string;
  count: number;
}

/** Immutable calculation result. BANDED carries a band, never a point value;
 *  SUPPRESSED carries neither value nor band. `composition` is populated only
 *  for a pooled public headline result (`subjectType: 'market'`, `metricCode`
 *  IEI/ICI) — null for every other result. */
export interface CalculatedResult {
  id: string;
  calculationRunId: string;
  subjectType: SubjectType;
  subjectId: string;
  metricCode: string;
  value: number | null;
  band: string | null;
  n: number;
  denominator: number;
  sufficiencyState: SufficiencyState;
  reason: string | null;
  composition: CalculatedResultComposition[] | null;
  createdAt: Date;
}

/** Per-firm / per-segment eligibility, computed and persisted before scoring. */
export interface EligibilityResult {
  id: string;
  calculationRunId: string;
  subjectType: 'firm' | 'segment';
  subjectId: string;
  segment: string | null;
  counted: number;
  floor: number;
  eligible: boolean;
  createdAt: Date;
}

/** Runtime config: which segments a report output depends on, and the rule. */
export interface ReportDependency {
  outputId: string;
  dependsOn: string[];
  sufficiencyRule: string;
  enabled: boolean;
  /** For a firm-referencing output: the exact firm-side instruments it needs
   *  (UX-OPS-003 §B7). e.g. OMI = [S1,S2,S3] (complete firms), DMI = [S1,S3]
   *  (DMI-complete). Null for investor-only outputs. */
  requiredInstruments: string[] | null;
  updatedAt: Date;
}

/** The closed set of report sections. */
export type ReportSection =
  | 'PUB_01'
  | 'PUB_02'
  | 'PUB_03'
  | 'PUB_04'
  | 'PUB_05'
  | 'PUB_06'
  | 'PUB_07'
  | 'PUB_08'
  | 'PUB_09'
  | 'PUB_10'
  | 'FRM_01'
  | 'FRM_02'
  | 'FRM_03'
  | 'FRM_04';

export type ReportType = 'PUBLIC_REPORT' | 'FIRM_REPORT';

export interface EvidencePack {
  id: string;
  calculationRunId: string;
  reportType: ReportType;
  subjectType: 'firm' | 'market';
  subjectId: string;
  createdAt: Date;
}

/** One fact in an evidence pack, with its source chain for traceability. */
export interface EvidencePackFact {
  id: string;
  packId: string;
  sectionId: ReportSection;
  metricCode: string | null;
  sufficiencyState: SufficiencyState;
  value: number | null;
  band: string | null;
  sourceResultId: string | null;
  sourceQuestionIds: string[];
  createdAt: Date;
}

// ─── AI reporting, review & publication (Phase 6) ──────────────────────────────

/** The ten national-report sections — the closed set of EVIDENCE_PACK_CONTRACT
 *  IDs. Prose names drift between documents; IDs do not, and the generator may
 *  not extend this set. */
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

/** publishable | caveated (§2, thin but shown) | suppressed (§7/§10, below floor). */
export type SectionSufficiencyDisposition = 'publishable' | 'caveated' | 'suppressed';

/** The three review dispositions, matching EVIDENCE_PACK_CONTRACT exactly. */
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
  requestedAt: Date | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  createdAt: Date;
}

export interface NationalReportSection {
  id: string;
  nationalReportId: string;
  sectionId: NationalReportSectionId;
  disposition: SectionSufficiencyDisposition;
  reason: string | null;
  createdAt: Date;
}

export interface NationalReportSentence {
  id: string;
  nationalReportId: string;
  ordinal: number;
  text: string;
  factIds: string[];
  createdAt: Date;
}

export interface NationalReportFinding {
  id: string;
  sentenceId: string;
  kind: string;
  why: string;
  createdAt: Date;
}

export interface NationalReportDisposition {
  id: string;
  findingId: string;
  disposition: ReviewDisposition;
  reason: string | null;
  disposedBy: string;
  disposedAt: Date;
}

export interface AdversaryHealth {
  id: string;
  nationalReportId: string;
  seededTotal: number;
  detected: number;
  thresholdRate: number;
  healthy: boolean;
  checkedAt: Date;
}

/** The retail-cut state for a firm report (FRM_04 gating). */
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
  releasedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FirmReportReleaseHistory {
  id: string;
  firmReportId: string;
  editionId: string;
  organizationId: string;
  action: 'released' | 'held' | 'regenerated';
  reason: string | null;
  occurredAt: Date;
}

// ─── Scoring sign-off (Phase 7 — UX-ADM-004) ───────────────────────────────────

/**
 * The sign-off record's lifecycle. `requested` = a maker submitted the
 * structured account; `signed_off` = a different person approved (this run is
 * authoritative); `superseded` = a LATER run was signed off, so this one is no
 * longer authoritative but stays visible in the history; `rejected` = a
 * different person declined the request, with a reason — the run remains
 * un-authoritative and a fresh request may be submitted for it.
 */
export type ScoringSignoffState = 'requested' | 'signed_off' | 'superseded' | 'rejected';

/**
 * The STRUCTURED account of what the signer verified — "the record is the
 * check". Distinct from the generic maker-checker reason field used elsewhere:
 * a bare free-text box is explicitly not enough. Each checklist item the signer
 * confirms is a distinct boolean; `notes` is optional colour, never a substitute
 * for the confirmations.
 */
export interface ScoringCheckedAccount {
  /** The per-index effective population counts were reviewed. */
  populationCountsReviewed: boolean;
  /** Each index's floor-clear / sub-floor status was reviewed. */
  floorStatusReviewed: boolean;
  /** Any known data-quality flags were reviewed. */
  dataQualityFlagsReviewed: boolean;
  /** Optional free-text detail, kept with the run permanently. */
  notes?: string;
}

/** A sign-off request/approval over a scoring calculation_run. */
export interface ScoringSignoff {
  id: string;
  editionId: string;
  calculationRunId: string;
  state: ScoringSignoffState;
  checkedAccount: ScoringCheckedAccount;
  requestedBy: string;
  requestedAt: Date;
  approvedBy: string | null;
  approvedAt: Date | null;
  supersededBy: string | null;
  supersededAt: Date | null;
  rejectedBy: string | null;
  rejectedAt: Date | null;
  rejectionReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ─── People & Access (Phase 8 — UX-OPS-006) ─────────────────────────────────────

/** The seven access rights a person can hold. `view` is universal and not
 *  editable; `dragnet` is Dragnet-organisation only. */
export type AccessRightKey = 'view' | 'send' | 'regs' | 'setup' | 'request' | 'approve' | 'dragnet';

/** The organisations that share the one operator pool. */
export type AccessOrg = 'CIS' | 'Dragnet';

/** A person who can sign in to study operations, with their resolved rights. */
export interface PersonAccess {
  userId: string;
  name: string;
  email: string;
  organization: AccessOrg;
  /** The seven rights, each true/false. `view` is always true. */
  rights: Record<AccessRightKey, boolean>;
  /** Convenience flags derived from rights. */
  canRequest: boolean;
  canApprove: boolean;
}

// ─── Invitations (Phase 9 — UX-OPS-002) ─────────────────────────────────────────

/** Which kind of audience a template targets — decides whether {{code}} is required. */
export type MessageAudienceKind = 'firm' | 'participant' | 'regulator' | 'upload';

export interface MessageTemplate {
  id: string;
  editionId: string;
  name: string;
  subject: string;
  body: string;
  audienceKind: MessageAudienceKind;
  /** True for a firm template that carries an invitation code (claim/reminder/
   *  reissue) — saving is blocked unless the body contains {{code}}. */
  requiresCode: boolean;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** delivery_state is the always-available core report. */
export type MessageDeliveryState = 'sent' | 'delivered' | 'bounced';

export interface MessageBatch {
  id: string;
  editionId: string;
  templateId: string;
  audienceId: string;
  audienceLabel: string;
  sendingService: string;
  sentBy: string | null;
  sentAt: Date;
  createdAt: Date;
}

export interface MessageRecipient {
  id: string;
  batchId: string;
  editionId: string;
  organizationId: string | null;
  recipientEmail: string | null;
  firmName: string | null;
  code: string | null;
  deliveryState: MessageDeliveryState;
  /** NULL = the sending service did not report opens (not "zero opens"). An open
   *  is a floor, never a reader count. */
  openedAt: Date | null;
  /** A click is a real, reliable event. */
  clickedAt: Date | null;
  createdAt: Date;
}

/** One category shown on the surface, with its audiences and live counts. */
export interface AudienceCategory {
  key: 'firms' | 'regs' | 'parts' | 'other';
  label: string;
  audiences: Array<{ id: string; label: string; sub: string; count: number | null }>;
}

/** A batch's delivery report. `opensReported`/`clicksReported` say whether the
 *  provider supplied those columns at all — false means render them absent,
 *  never as zero. */
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
  /** Diagnostic split kept distinct: channel/spam vs. message content. */
  deliveredNeverOpened: number;
  openedNotClicked: number;
}

/** One of the four file-validation problems (no fifth register-match check). */
export type UploadCheckKind =
  'no_address' | 'malformed_address' | 'in_file_duplicate' | 'already_sent';

export interface UploadCheckResult {
  validRows: Array<{ firmName: string; email: string }>;
  problems: Array<{ kind: UploadCheckKind; row: number; value: string }>;
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
  resolvedAt: Date | null;
  createdAt: Date;
}

// ─── Mission board (Phase 10 — UX-OPS-001) ───────────────────────────────────

export type MissionSegment = 'firm' | 'retail' | 'local_institution' | 'foreign_institution';

/** A segment's forecast state, computed fresh each cycle — never stored. */
export interface SegmentForecast {
  segment: MissionSegment;
  target: number;
  current: number;
  daysElapsed: number;
  daysRemaining: number;
  /** Undefined on day 0 (no forecast alerts that day). */
  velocity: number | null;
  requiredVelocity: number | null;
  forecastAtClose: number | null;
  projectedShortfall: number;
  atRisk: boolean;
}

/** The six severity ranks (brief §5), rank 1 most consequential. */
export type MissionSeverity = 1 | 2 | 3 | 4 | 5 | 6;

/** One mission card — exactly six fields (brief §9). `expectedImpact` is omitted
 *  (undefined) when there isn't enough history to compute it — never zero. A
 *  `mission` card with no `recommendedAction` never reaches the board; a
 *  `methodology_block` card (Phase 11) carries NO action and is exempt from that
 *  filter — it must display so the team knows an output is blocked, not merely
 *  low, and cannot be actioned by chasing respondents. */
export type MissionCardKind = 'mission' | 'methodology_block';

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
  /** Defaults to 'mission'. A 'methodology_block' card has no remediation. */
  kind?: MissionCardKind;
}

/** The four edition phases the rail is aware of. */
export type EditionPhase = 'before_launch' | 'collection_open' | 'closing_week' | 'closed';

// ─── Institutional instrument families (Phase 19) ─────────────────────────────

/**
 * The four controlled instrument families: A (Regulatory/Supervisory),
 * B (Exchange/Market Operator), C (Clearing/Settlement), D (Depository /
 * Securities-account Infrastructure). Replaces the old fixed three-code
 * `RegulatorCode` enum: adding a ninth institution of an existing role is a
 * new `institutions`/`institution_roles` row, never a code change.
 */
export type InstrumentFamilyCode = 'A' | 'B' | 'C' | 'D';

export interface Institution {
  id: string;
  name: string;
  isActive: boolean;
  createdAt: Date;
}

/** One role an institution holds — the (institutionId, familyCode) composite
 *  key used across engagement, contacts and the I-{code} survey instruments.
 *  An institution may hold more than one (CSCS: Family C and Family D). */
export interface InstitutionRole {
  institutionId: string;
  familyCode: InstrumentFamilyCode;
}

// ─── Regulator engagement (Phase 12 — UX-OPS-007) ─────────────────────────────

/**
 * A regulator's named contact — the ONE deliberate place in the organiser estate
 * that holds a named individual outside the firm register, because engagement is
 * a relationship. Never tokenised or anonymised.
 */
export interface RegulatorContact {
  who: string;
  role: string;
  email: string;
  phone: string;
  /** "How we got to them" — a plain note for whoever picks the relationship up next. */
  how: string;
}

/** The surface's own reading of where a regulator is, derived from its engagement
 *  row: no contact → contact added → invited → (confirmed | declined). */
export type RegulatorSurveyState =
  'no_contact' | 'contact_added' | 'invited' | 'confirmed' | 'declined';

/** One append-only, free-text history entry (a phone call produces free text, not
 *  a taxonomy). */
export interface RegulatorHistoryEntry {
  id: string;
  entry: string;
  createdAt: Date;
}

/** The whole per-(edition, regulator) engagement record for the surface. */
export interface RegulatorEngagementView {
  institutionId: string;
  familyCode: InstrumentFamilyCode;
  /** The institution's display name (e.g. "Securities and Exchange Commission"). */
  name: string;
  mandate: string;
  /** The Phase 10 engagement status this maps onto. */
  status: 'not_started' | 'invited' | 'in_progress' | 'confirmed' | 'declined';
  state: RegulatorSurveyState;
  contact: RegulatorContact | null;
  surveyLink: string | null;
  targetBy: string | null;
  overdue: boolean;
  /** What this regulator is waiting for — the reason to open it, not just a label. */
  nextStep: string;
  history: RegulatorHistoryEntry[];
}

// ─── RBAC ────────────────────────────────────────────────────────────────────

export interface User {
  id: string;
  email: string;
  /** Never returned to the client. */
  passwordHash: string;
  displayName: string;
  /** Organisation the user belongs to (e.g. 'CIS', 'Dragnet'). */
  organization: string | null;
  isActive: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Role {
  id: string;
  name: string;
  description: string | null;
  createdAt: Date;
}

export interface Permission {
  id: string;
  code: string;
  description: string | null;
  permissionType: PermissionType;
  /** For critical-action permissions: which action_type this applies to. */
  actionScope: string | null;
  createdAt: Date;
}

// ─── Maker-checker ────────────────────────────────────────────────────────────

export interface CriticalAction {
  id: string;
  actionType: string;
  status: CriticalActionStatus;
  requestedBy: string;
  requestedAt: Date;
  approvedBy: string | null;
  approvedAt: Date | null;
  rejectedBy: string | null;
  rejectedAt: Date | null;
  rejectionReason: string | null;
  payload: Record<string, unknown>;
  editionId: string | null;
}

// ─── Audit ────────────────────────────────────────────────────────────────────

export interface AuditLogEntry {
  id: string;
  actorId: string | null;
  actionType: string;
  entityType: string;
  entityId: string | null;
  editionId: string | null;
  oldValue: Record<string, unknown> | null;
  newValue: Record<string, unknown> | null;
  reason: string | null;
  occurredAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
}

// ─── API response shapes ──────────────────────────────────────────────────────

export interface ApiResponse<T> {
  data: T;
}

export interface ApiError {
  error: string;
  message: string;
  statusCode: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}

// ─── Session / auth ───────────────────────────────────────────────────────────

export interface SessionPayload {
  sub: string;
  email: string;
  displayName: string;
  org: string | null;
  kind: 'operator';
}

/** A firm coordinator's session — a distinct claim shape from `SessionPayload`
 *  so a coordinator token can never be mistaken for, or misused as, operator
 *  access (or vice versa). `sub` resolves to `firm_coordinators.id`, never
 *  `users.id`. */
export interface CoordinatorSessionPayload {
  sub: string;
  organizationId: string;
  email: string;
  kind: 'coordinator';
}
