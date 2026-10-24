export type {
  QuestionKind,
  QuestionScope,
  SurveyItem,
  AnswerValue,
  YesNoAnswer,
  SelectGreatestAnswer,
  GridAnswer,
  ScopeGate,
} from './types';
export { getCanonical, putCanonical, setAnswer, setComment } from './answer';
export {
  scaleColumns,
  isAnswered,
  outstanding,
  describeAnswer,
  sharedItems,
  perFirmItems,
  requiresConsent,
  toggleSelect,
  toggleRank,
} from './logic';
export { buildJourneySequence, firmContextAt } from './sequence';
export type { JourneyStep, FirmContext } from './sequence';
export { closesScope, applyScopeGate } from './scope-gate';
export { STUDY_NAME } from './brand';
export type { ScopeGatedSteps } from './scope-gate';
