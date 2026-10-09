export {
  setClosingDate,
  setSurveyOpenAt,
  evaluateAutoOpen,
  setSampleFloor,
  markOpened,
  requestLock,
  decideLock,
  EDITION_LOCK_ACTION,
  EDITION_MANAGE_PERMISSION,
} from './edition-service';
export type { ActorContext, LockDecision, AutoOpenResult } from './edition-service';

export { requestFreeze, decideFreeze, INSTRUMENT_FREEZE_ACTION } from './instrument-service';
export type { FreezeDecision } from './instrument-service';

export {
  DomainError,
  EditionStateError,
  InstrumentsNotFrozenError,
  InvalidReasonError,
  CriticalActionStateError,
  MIN_REASON_LENGTH,
} from './errors';

export { seedReferenceData } from './seed';
export type { SeededReferenceData } from './seed';

export { submitResponses, ConsentRequiredError, ResponseScopeError } from './response-service';
export type { SubmitResponsesInput } from './response-service';

export {
  startJourney,
  registerContact,
  setRatedFirms,
  saveDraftAnswer,
  getResume,
  getResumeByToken,
  submitJourney,
  createReferral,
  createColleagueInvite,
  ReviewGapError,
} from './journey-service';
export type { ContactInput, ResumeState } from './journey-service';

export {
  createLeadCoordinator,
  addCoordinator,
  setCoordinatorPin,
  handOverLead,
  removeCoordinator,
  listCoordinators,
  FirmTeamError,
  PinVerificationError,
} from './firm-team-service';

export {
  claimSpace,
  recordFollowUpConsent,
  requestInvitation,
  getSeats,
  assignSeat,
  replacementCost,
  describeSeatReplacement,
  confirmSeatReplacement,
  updateSeatState,
  canInviteClients,
  getSeatStatus,
  ensureOutreachLinks,
  getOutreachVolumes,
  listOutreachLinksForFirm,
  FirmPortalError,
  PrivacyConsentRequiredError,
  AlreadyClaimedError,
  SeatConflictError,
  getSeatEntryContext,
  startSeatEntry,
  completeSeatEntry,
  SeatLinkNotFoundError,
  resolveOutreachToken,
  recordOutreachEvent,
  OutreachLinkNotFoundError,
} from './firm-portal-service';
export type {
  ClaimInput,
  InvitationRequest,
  SeatEntryContext,
  OutreachLinkContext,
} from './firm-portal-service';

export {
  coordinatorLogin,
  CoordinatorAuthError,
  InvalidCoordinatorCredentialsError,
} from './coordinator-auth-service';

// ── Phase 5: scoring, sufficiency, analytics & evidence ──────────────────────
export {
  segmentForInstrument,
  institutionRefFor,
  emitCompletedForRespondent,
} from './funnel-service';
export {
  computeSufficiency,
  bandForProportion,
  SUPPRESS_BELOW,
  REPORTABLE_AT,
  segmentDisplayState,
  isSegmentGroupReconstructable,
} from './sufficiency-service';
export type { ReconstructabilityMember } from './sufficiency-service';
export {
  isFirmEligible,
  eligibleFirmIds,
  runEligibility,
  currentSegmentSufficiency,
} from './eligibility-service';
export type { EligibilityRunResult } from './eligibility-service';
export { datasetHashFor, runScoring } from './calculation-service';
export type { ScoringRunResult } from './calculation-service';
export { buildEvidencePack, EvidencePackError } from './evidence-pack-service';
export type { FactInput, BuildPackInput } from './evidence-pack-service';
export { setReportDependency, evaluateReportDependencies } from './report-dependency-service';
export type { DependencyEvaluation, SufficiencyRule } from './report-dependency-service';

// ── Phase 6: AI reporting, review & publication ──────────────────────────────
export {
  NATIONAL_SECTIONS,
  assertSectionId,
  evaluateSection,
  generateNationalReport,
  isUnsupportedByConstruction,
  checkSentence,
  saveNationalDraft,
  runChecker,
  runAdversaryHealth,
  ADVERSARY_HEALTH_THRESHOLD,
  disposeFinding,
  nationalApprovalPreconditions,
  openDraft,
  requestNationalApproval,
  approveNational,
  getSections,
  NationalReportError,
} from './national-report-service';
export type {
  SectionSpec,
  SufficiencyContext,
  DraftFact,
  DraftSentence,
  SeededClaim,
  ApprovalPreconditions,
} from './national-report-service';

export {
  getRetailCutThresholds,
  cutStateFor,
  generateFirmReports,
  approveFirmReport,
  regenerateFirmReport,
  releaseFirmReports,
  correctFirmReport,
  getFirmReports,
  FirmReportError,
} from './firm-report-service';
export type { RetailCutThresholds, GenerationResult, ReleaseResult } from './firm-report-service';

// ── Phase 7: scoring sign-off (UX-ADM-004) ───────────────────────────────────
export {
  triggerScoringRun,
  listScoringRuns,
  validateCheckedAccount,
  requestSignoff,
  approveSignoff,
  rejectSignoff,
  getScoreView,
  hasSignedOffRun,
  getAuthoritativeSignoff,
  listSignoffs,
  getSignoff,
  ScoringSignoffError,
  ScoringBlockedError,
  SignoffPayloadError,
} from './scoring-signoff-service';
export type { ScoringSurfaceState, IndexScoreView } from './scoring-signoff-service';

// ── Phase 8: People & Access (UX-OPS-006) ────────────────────────────────────
export {
  listPeople,
  countApprovers,
  addPerson,
  updatePersonRights,
  removePerson,
  CRITICAL_ACTIONS,
  ACCESS_RIGHT_META,
  APPROVER_FLOOR,
  PeopleAccessError,
} from './people-access-service';

// ── Phase 9: Invitations (UX-OPS-002) ────────────────────────────────────────
export {
  listAudiences,
  listMessageTemplates,
  saveTemplate,
  validateUploadFile,
  sendBatch,
  getBatches,
  getBatchReport,
  submitInvitationRequest,
  getInvitationRequests,
  resolveInvitationRequest,
  resolveFirmNameToOrg,
  resolveFirmNamesToOrgs,
  getBouncedRecipients,
  getFirmAudienceState,
  RECORDING_SENDING_SERVICE,
  ZeptomailSendingService,
  ingestZeptomailEvent,
  InvitationsError,
} from './invitations-service';
export type { SendingService, OutgoingMessage, SendResult } from './invitations-service';

// ── Phase 10: Mission board (UX-OPS-001) ─────────────────────────────────────
export {
  velocity,
  requiredVelocity,
  forecastAtClose,
  projectedShortfall,
  atRisk,
  buildSegmentForecast,
  diagnoseFirmFunnel,
  firstQuartile,
  tierCoverageUneven,
} from './mission-forecast';
export type { FirmFunnelInput, FunnelDiagnosis, FirmFunnelState } from './mission-forecast';
export {
  CONDITIONS,
  evaluateBoard,
  buildBoardContext,
  getMissionBoard,
  editionPhase,
  remediationForCohort,
  MissionBoardError,
} from './mission-board-service';
export type { BoardContext, RemediationCohort } from './mission-board-service';

// ── Phase 11: Candidate scoring methodology (CIS-SCORE-2026 v0.15) ────────────
export {
  isSubstantive,
  applyTransform,
  scoreItem,
  scoreS3Q4Composite,
  transformFor,
} from './scoring-transforms';
export {
  assertRunOfficialUsable,
  dmiCompleteFirmIds,
  omiCompleteFirmIds,
  missingOmiRoleCounts,
  firmDmiScores,
  retailIeiEligible,
  retailIciEligible,
  localIeiEligible,
  localIciEligible,
  foreignIeiEligible,
  foreignIciEligible,
  retailIeiRelationshipScore,
  retailIciRelationshipScore,
  localIeiRelationshipScore,
  localIciRelationshipScore,
  foreignIeiUnitScore,
  foreignIciUnitScore,
  foreignIeiFirmSpecificObservation,
  foreignIciFirmSpecificObservation,
  retailInvestorObservations,
  localInvestorObservations,
  foreignInvestorUnitScores,
  foreignInvestorFirmObservations,
  investorSegmentUnitScores,
  firmInvestorScores,
  runInvestorPooling,
  firmSpecificInvestorAnswers,
  pooledHeadline,
  industrySeiState,
  canCompareHeadlinesDirectly,
  computeLikeForLike,
  recordLikeForLikeComparison,
  recordInvestorLikeForLike,
  runCandidateScoring,
  CandidateScoringError,
} from './candidate-scoring-service';
export type {
  PooledSegmentInput,
  PooledHeadline,
  IndustrySeiState,
  EditionSegmentEvidence,
  LikeForLike,
  CandidateRunResult,
  RetailIeiAnswers,
  RetailIciAnswers,
  LocalIeiAnswers,
  LocalIciAnswers,
  ForeignIeiAnswers,
  ForeignIciAnswers,
  ForeignInstitutionRaw,
  InvestorRelationshipObservation,
  ForeignInvestorUnit,
  InvestorSegmentUnitScores,
  FirmInvestorScore,
  InvestorPoolingResult,
} from './candidate-scoring-service';

// ── Phase 14: Firm private results (UX-FRM-RES-001) ──────────────────────────
export {
  getFirmResults,
  standing,
  isGapIndex,
  withinActiveBrokerWindow,
  ACTIVE_BROKER_MONTHS,
  FirmResultsError,
  FirmResultsAccessError,
} from './firm-results-service';
export type {
  FirmResults,
  FirmIndexResult,
  FirmRetailCut,
  StandingLabel,
} from './firm-results-service';

// ── Phase 13: Responses monitoring (UX-OPS-003) ──────────────────────────────
export { getResponsesMonitor, getRetailCutForDisplay } from './responses-monitoring-service';
export type {
  SegmentCard,
  SegmentCardState,
  CompleteFirmLine,
  DependencyRow,
  DependencyDisplayState,
  ResponsesMonitor,
} from './responses-monitoring-service';

// ── Phase 13: Reminder timing (UX-OPS-004) ───────────────────────────────────
export {
  getReminderSchedule,
  setReminderSchedule,
  getReminderCap,
  setReminderCap,
  triggerTimeFor,
  nextDueReminder,
  scheduleDueReminders,
  getUnfinishedStats,
  getDropoffHistogram,
  ReminderTimingError,
} from './reminder-timing-service';
export type {
  ReminderStepConfig,
  ReminderSchedule,
  DueReminder,
  UnfinishedStats,
  DropoffBucket,
} from './reminder-timing-service';

// ── Phase 12: Regulator engagement (UX-OPS-007) ──────────────────────────────
// Phase 19: re-keyed from a fixed RegulatorCode enum to (institutionId,
// familyCode); adds reopenDeclined (item 6, access:regs-gated).
export {
  listRegulators,
  getRegulator,
  saveContact,
  issueSurveyLink,
  sendReminder,
  sendTextReminder,
  markDeclined,
  markSubmitted,
  reopenDeclined,
  recordHistory,
  listInstitutionRoster,
  renderInstitutionalIntro,
  RegulatorEngagementError,
} from './regulator-engagement-service';

// ── Phase 19: Institutional instrument families ──────────────────────────────
export { FAMILY_META, instrumentCodeForFamily } from './institution-family-service';
export type { FamilyMeta } from './institution-family-service';

// ── Phase 16: Dragnet Internal Analysis (UX-ADM-007) ─────────────────────────
export {
  getDragnetMaturity,
  getDragnetFriction,
  getDragnetMaturityCsv,
  DragnetPermissionError,
} from './dragnet-service';
export type { FirmMaturityEntry, FirmTier } from './dragnet-service';

// ── Phase 15: Managed wording (UX-ADM-CNT-001) ───────────────────────────────
export {
  CONTENT_AREAS,
  getContentState,
  listTemplateSubKeys,
  saveDraft,
  publishDraft,
  ManagedContentError,
  ManagedContentPermissionError,
} from './managed-content-service';
export type { ContentArea, ContentState, TemplateSubKey } from './managed-content-service';

// ── Phase 17: Reminder content (UX-RET-007) ──────────────────────────────────
export {
  computeProgressWording,
  getReminderContent,
  stopReminders,
  assembleReminderText,
  assembleReminderEmail,
  assembleFirstMessageText,
  ReminderContentError,
} from './reminder-content-service';
export type { ReminderSubKey, RespondentProgress } from './reminder-content-service';

// ── Phase 18: Investor categories (UX-FRM-002) ───────────────────────────────
export {
  updateInvestorCategoriesServed,
  InvestorCategoriesError,
} from './investor-categories-service';

// ── Phase 18: Firm digest (UX-FRM-DIG-001) ───────────────────────────────────
export {
  assembleFirmDigest,
  sendFirmDigest,
  getFirmDigestSchedule,
  setFirmDigestSchedule,
  FirmDigestError,
} from './firm-digest-service';
export type {
  FirmDigest,
  FirmDigestSchedule,
  FirmDigestSendResult,
  FirmAttentionState,
} from './firm-digest-service';

// ── Phase 18: Public content — help/privacy/about + previous editions
//    (UX-X-002, UX-PUB-002) ──────────────────────────────────────────────────
export { getPublicContent, listPreviousPublishedEditions } from './public-content-service';
export type {
  PublicContent,
  OrganisationDescriptions,
  PreviousEditionEntry,
} from './public-content-service';

// ── Phase 18: Shared error states + withdrawal (UX-X-001) ───────────────────
export {
  ERROR_STATES,
  ERROR_STATE_COPY,
  getErrorStateCopy,
  withdrawRespondent,
  ParticipationClosedError,
} from './shared-error-service';
export type { ErrorStateKind, ErrorStateCopy } from './shared-error-service';
export {
  buildIndustryReportContent,
  buildFirmReportContent,
  ReportContentError,
  institutionalThemes,
  withheldSections,
  ratingByRespondent,
  type IndustryReportContent,
  type FirmReportContent,
  type InstitutionalReading,
} from './report-content-service';
export {
  generateIndustryNarrative,
  generateFirmNarrative,
  getIndustryNarrative,
  getFirmNarrative,
  ensureIndustryNarrative,
  ensureFirmNarrative,
  narrativeDue,
  industryNarrativeFacts,
  industryFacts,
  firmFacts,
  checkNarrativeSentence,
  sectionFinding,
  parseModelSections,
  buildNarrativePrompt,
  ReportNarrativeError,
  ReportPublicationError,
  type NarrativeModel,
} from './report-narrative-service';
export {
  prepareNationalReview,
  getNationalReview,
  decideFinding,
  plantedErrors,
  measureChecker,
  type NationalReview,
} from './national-review-service';
export {
  publishIndustryReport,
  getPublishedIndustryReport,
  getReleasedFirmReport,
  queueReleaseNotices,
  publicNarrative,
  type PublicNarrative,
} from './report-publication-service';
