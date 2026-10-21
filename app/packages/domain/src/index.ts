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

export {
  requestFreeze,
  decideFreeze,
  INSTRUMENT_FREEZE_ACTION,
  RegisterContentIncompleteError,
} from './instrument-service';
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
  CollectionClosedError,
  RegulatorLinkRequiredError,
  ScopeClosedError,
  LinkInvalidatedError,
  acceptsResponses,
  assertCollectionOpen,
  getPublicConsentContent,
  SURVEY_RESUME_EMAIL_KIND,
} from './journey-service';
export type { ContactInput, ResumeState, PublicConsentContent } from './journey-service';

export {
  createLeadCoordinator,
  addCoordinator,
  setCoordinatorPin,
  handOverLead,
  removeCoordinator,
  listCoordinators,
  FirmTeamError,
  PinVerificationError,
  COORDINATOR_WELCOME_EMAIL_KIND,
  COORDINATOR_PIN_SET_EMAIL_KIND,
} from './firm-team-service';
export type { CoordinatorNotify } from './firm-team-service';

export {
  importFirmDirectory,
  planFirmImport,
  parseCsv,
  slugifyFirmName,
  MAX_IMPORT_ROWS,
} from './firm-directory-service';
export type { FirmImportRow, FirmImportPlan, FirmImportResult } from './firm-directory-service';

export {
  claimSpace,
  recordFollowUpConsent,
  requestInvitation,
  getSeats,
  assignSeat,
  SEAT_ASSIGNED_EMAIL_KIND,
  FIRM_SPACE_CLAIMED_EMAIL_KIND,
  TEST_FIRM_PREFIX,
  firmClaimWithoutInviteAllowed,
  InvitationRequiredError,
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
  SeatNotify,
  SeatEntryContext,
  OutreachLinkContext,
} from './firm-portal-service';

export {
  inviteFirm,
  sendInvitationAgain,
  revokeInvitation,
  listInvitations,
  listInvitationsWithLinks,
  pendingInvitationsCsv,
  bulkInviteFirms,
  lookupInvitation,
  isFirmClaimed,
  createFirmInvitationRecord,
  ensureFirmInvitationRecord,
  invitationLink,
  invitationState,
  firmInviteTtlDays,
  FIRM_INVITATION_EMAIL_KIND,
  FirmInvitationError,
} from './firm-invitation-service';
export type {
  InviteContext,
  InvitationLookup,
  FirmInvitationView,
  FirmInvitationLinkView,
  BulkInviteInput,
  BulkInviteResult,
  FirmInvitationState,
  FirmInvitationDelivery,
  FirmInvitationErrorCode,
  FirmInvitationRecordInput,
} from './firm-invitation-service';

export {
  coordinatorLogin,
  CoordinatorAuthError,
  InvalidCoordinatorCredentialsError,
} from './coordinator-auth-service';

// ── Phase 5: scoring, sufficiency, analytics & evidence ──────────────────────
export {
  segmentForInstrument,
  isInvestorInstrument,
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
  getPendingNationalApproval,
  NATIONAL_REPORT_APPROVAL_ACTION,
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
  openFirmReport,
  requestFirmReportRelease,
  decideFirmReportRelease,
  getPendingFirmReportRelease,
  FIRM_REPORT_RELEASE_ACTION,
  regenerateFirmReport,
  releaseFirmReports,
  correctFirmReport,
  getFirmReports,
  FirmReportError,
} from './firm-report-service';
export type {
  RetailCutThresholds,
  GenerationResult,
  ReleaseResult,
  ReleaseOptions,
  FirmReportReleaseDecision,
  FirmReportReleaseDecisionResult,
} from './firm-report-service';

// ── Phase 7: scoring sign-off (UX-ADM-004) ───────────────────────────────────
export {
  triggerScoringRun,
  listScoringRuns,
  validateCheckedAccount,
  requestSignoff,
  approveSignoff,
  rejectSignoff,
  getScoreView,
  completeFirmsForIndex,
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
  PeopleAccessForbiddenError,
  ACCESS_MANAGER_RIGHT,
  ACCESS_MANAGER_PERMISSION,
  assertCanManagePeople,
  peopleViewerAccess,
  sendPasswordLink,
} from './people-access-service';
export {
  issuePasswordSetLink,
  getPasswordSetLinkInfo,
  consumePasswordSetLink,
  hashPasswordSetToken,
  PasswordSetError,
  OPERATOR_SET_PASSWORD_EMAIL_KIND,
  INVITE_LINK_TTL_MS,
  RESET_LINK_TTL_MS,
} from './password-set-service';
export {
  checkPasswordPolicy,
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  type PasswordProblem,
} from './password-policy';

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
  ingestOutboxDeliveryEvent,
  renderTemplateText,
  INVITATION_BATCH_EMAIL_KIND,
  INVITATION_REQUEST_EMAIL_KIND,
  InvitationsError,
} from './invitations-service';
export type {
  SendingService,
  OutgoingMessage,
  SendResult,
  SendOutcome,
  OutboxDeliveryEvent,
} from './invitations-service';

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
  industrySeiFromFirms,
  canCompareHeadlinesDirectly,
  computeLikeForLike,
  recordLikeForLikeComparison,
  recordInvestorLikeForLike,
  runCandidateScoring,
  firmOmiScores,
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
  RESPONDENT_REMINDER_EMAIL_KIND,
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
  REGULATOR_SURVEY_LINK_EMAIL_KIND,
  REGULATOR_REMINDER_EMAIL_KIND,
} from './regulator-engagement-service';

// ── Phase 19: Institutional instrument families ──────────────────────────────
export {
  FAMILY_META,
  instrumentCodeForFamily,
  instrumentCodeForRole,
  isRegulatorInstrument,
} from './institution-family-service';
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
  FIRM_DIGEST_EMAIL_KIND,
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
export {
  freezeFirmReport,
  freezeIndustryReport,
  releasedFirmReportContent,
  publishedIndustryReportContent,
} from './report-snapshot-service';

// ── Email content (every notice is queued through queueNotice) ──────────────
export {
  renderEmailHtml,
  renderEmailText,
  textToHtml,
  escapeHtml,
  queueNotice,
  type EmailAction,
  type EmailContent,
  type Notice,
} from './email-content';

// ── Scoring methodology approval (two-person) ────────────────────────────────
export {
  METHODOLOGY_APPROVAL_ACTION,
  getMethodologyApproval,
  isMethodologyApproved,
  requestMethodologyApproval,
  decideMethodologyApproval,
  type MethodologyApprovalState,
} from './methodology-approval-service';
