import {
  buildGuideQuestionCatalog,
  GuideCatalogError,
  type GuideQuestionCatalogEntry,
} from '../guide/catalog.js';
import type { ParsedInterviewGuide } from '../guide/types.js';

export type CoverageTimestamp = string;

export type CoverageQuestionKind = 'main' | 'follow_up';

export type QuestionCoverageStatus =
  'not_addressed' | 'current' | 'partially_answered' | 'answered' | 'skipped_already_answered';

type OpenQuestionCoverageStatus = Extract<
  QuestionCoverageStatus,
  'not_addressed' | 'current' | 'partially_answered'
>;

export interface QuestionCoverage {
  readonly questionId: string;
  readonly kind: CoverageQuestionKind;
  readonly mainQuestionId: string;
  readonly status: QuestionCoverageStatus;
  readonly referencedTurnIds: readonly string[];
  readonly updatedAt: CoverageTimestamp | null;
}

export interface GuideCoverageState {
  readonly interviewId: string;
  readonly guideId: string;
  readonly revision: number;
  readonly questions: readonly QuestionCoverage[];
}

export interface CoverageUpdate {
  readonly questionId: string;
  readonly status: QuestionCoverageStatus;
  readonly referencedTurnIds: readonly string[];
  readonly at: CoverageTimestamp;
}

export interface ApplyCoverageInput {
  readonly interviewId: string;
  readonly guideId: string;
  readonly expectedRevision: number;
  readonly updates: readonly CoverageUpdate[];
}

export type CoverageDomainErrorCode =
  | 'invalid_guide'
  | 'invalid_interview'
  | 'guide_mismatch'
  | 'interview_mismatch'
  | 'stale_revision'
  | 'unknown_question'
  | 'duplicate_update'
  | 'invalid_status_transition'
  | 'invalid_evidence'
  | 'invalid_timestamp'
  | 'multiple_current_questions'
  | 'invalid_coverage_state';

export class CoverageDomainError extends Error {
  public readonly code: CoverageDomainErrorCode;

  public constructor(code: CoverageDomainErrorCode, message: string) {
    super(message);
    this.name = 'CoverageDomainError';
    this.code = code;
  }
}

export interface OpenCoverageQuestion {
  readonly sectionId: string;
  readonly mainQuestionId: string;
  readonly questionId: string;
  readonly kind: CoverageQuestionKind;
  readonly text: string;
  readonly status: OpenQuestionCoverageStatus;
}

const OPEN_STATUSES = new Set<QuestionCoverageStatus>([
  'not_addressed',
  'current',
  'partially_answered',
]);

const ALLOWED_STATUS_TRANSITIONS: Readonly<
  Record<QuestionCoverageStatus, ReadonlySet<QuestionCoverageStatus>>
> = {
  not_addressed: new Set([
    'not_addressed',
    'current',
    'partially_answered',
    'answered',
    'skipped_already_answered',
  ]),
  current: new Set(['current', 'partially_answered', 'answered', 'skipped_already_answered']),
  partially_answered: new Set([
    'current',
    'partially_answered',
    'answered',
    'skipped_already_answered',
  ]),
  answered: new Set(['answered']),
  skipped_already_answered: new Set(['skipped_already_answered']),
};

export function initializeGuideCoverage(
  guide: ParsedInterviewGuide,
  interviewId: string,
): GuideCoverageState {
  const guideQuestions = requireGuideQuestionCatalog(guide);
  if (interviewId.trim().length === 0) {
    throw new CoverageDomainError(
      'invalid_interview',
      'Coverage must belong to a non-empty interview ID',
    );
  }

  return {
    interviewId,
    guideId: guide.id,
    revision: 0,
    questions: guideQuestions.map((question) => ({
      questionId: question.questionId,
      kind: question.kind,
      mainQuestionId: question.mainQuestionId,
      status: 'not_addressed',
      referencedTurnIds: [],
      updatedAt: null,
    })),
  };
}

export function applyCoverageUpdates(
  guide: ParsedInterviewGuide,
  state: GuideCoverageState,
  input: ApplyCoverageInput,
): GuideCoverageState {
  const guideQuestions = requireGuideQuestionCatalog(guide);
  validateCoverageState(guide, state, guideQuestions);

  if (input.interviewId !== state.interviewId) {
    throw new CoverageDomainError(
      'interview_mismatch',
      'Coverage updates and state must belong to the same interview',
    );
  }
  if (input.guideId !== guide.id || state.guideId !== guide.id) {
    throw new CoverageDomainError(
      'guide_mismatch',
      'Coverage updates, state, and questions must belong to the same guide',
    );
  }
  if (input.expectedRevision !== state.revision) {
    throw new CoverageDomainError(
      'stale_revision',
      `Expected coverage revision ${input.expectedRevision}, but current revision is ${state.revision}`,
    );
  }

  const knownQuestionIds = new Set(guideQuestions.map((question) => question.questionId));
  const updateIds = new Set<string>();
  for (const update of input.updates) {
    if (!knownQuestionIds.has(update.questionId)) {
      throw new CoverageDomainError(
        'unknown_question',
        `Question ${update.questionId} does not belong to guide ${guide.id}`,
      );
    }
    if (updateIds.has(update.questionId)) {
      throw new CoverageDomainError(
        'duplicate_update',
        `Question ${update.questionId} occurs more than once in one coverage update`,
      );
    }
    updateIds.add(update.questionId);
    validateCoverageUpdate(update);
  }

  const updatesById = new Map(input.updates.map((update) => [update.questionId, update]));
  const questions = state.questions.map((existing) => {
    const update = updatesById.get(existing.questionId);
    if (update === undefined) {
      return existing;
    }
    if (!ALLOWED_STATUS_TRANSITIONS[existing.status].has(update.status)) {
      throw new CoverageDomainError(
        'invalid_status_transition',
        `Coverage for ${existing.questionId} cannot move from ${existing.status} to ${update.status}`,
      );
    }

    return {
      ...existing,
      status: update.status,
      referencedTurnIds: mergeUnique(existing.referencedTurnIds, update.referencedTurnIds),
      updatedAt: update.at,
    };
  });

  if (questions.filter((question) => question.status === 'current').length > 1) {
    throw new CoverageDomainError(
      'multiple_current_questions',
      'Only one guide question may be current at a time',
    );
  }

  return {
    interviewId: state.interviewId,
    guideId: state.guideId,
    revision: state.revision + 1,
    questions,
  };
}

export function selectNextOpenMainQuestion(
  guide: ParsedInterviewGuide,
  state: GuideCoverageState,
): OpenCoverageQuestion | null {
  const indexedQuestions = requireGuideQuestionCatalog(guide);
  validateCoverageState(guide, state, indexedQuestions);
  const coverageById = new Map(state.questions.map((question) => [question.questionId, question]));
  const orderedMainQuestions = indexedQuestions.filter((question) => question.kind === 'main');

  return selectByStatusPriority(orderedMainQuestions, coverageById);
}

export function selectNextOpenFollowUpQuestion(
  guide: ParsedInterviewGuide,
  state: GuideCoverageState,
  mainQuestionId: string,
): OpenCoverageQuestion | null {
  const indexedQuestions = requireGuideQuestionCatalog(guide);
  validateCoverageState(guide, state, indexedQuestions);
  const mainQuestion = indexedQuestions.find(
    (question) => question.questionId === mainQuestionId && question.kind === 'main',
  );
  if (mainQuestion === undefined) {
    throw new CoverageDomainError(
      'unknown_question',
      `Main question ${mainQuestionId} does not belong to guide ${guide.id}`,
    );
  }

  const coverageById = new Map(state.questions.map((question) => [question.questionId, question]));
  const followUps = indexedQuestions.filter(
    (question) =>
      question.kind === 'follow_up' && question.mainQuestionId === mainQuestion.questionId,
  );
  return selectByStatusPriority(followUps, coverageById);
}

export function selectNextOpenQuestion(
  guide: ParsedInterviewGuide,
  state: GuideCoverageState,
): OpenCoverageQuestion | null {
  const indexedQuestions = requireGuideQuestionCatalog(guide);
  validateCoverageState(guide, state, indexedQuestions);
  const coverageById = new Map(state.questions.map((question) => [question.questionId, question]));
  return selectByStatusPriority(indexedQuestions, coverageById);
}

function requireGuideQuestionCatalog(
  guide: ParsedInterviewGuide,
): readonly GuideQuestionCatalogEntry[] {
  try {
    return buildGuideQuestionCatalog(guide);
  } catch (error: unknown) {
    if (error instanceof GuideCatalogError) {
      throw new CoverageDomainError('invalid_guide', error.message);
    }
    throw error;
  }
}

function validateCoverageState(
  guide: ParsedInterviewGuide,
  state: GuideCoverageState,
  guideQuestions: readonly GuideQuestionCatalogEntry[],
): void {
  if (state.interviewId.trim().length === 0) {
    throw new CoverageDomainError(
      'invalid_interview',
      'Coverage state must belong to a non-empty interview ID',
    );
  }
  if (state.guideId !== guide.id || state.revision < 0 || !Number.isInteger(state.revision)) {
    throw new CoverageDomainError(
      'guide_mismatch',
      'Coverage state does not belong to this guide or has an invalid revision',
    );
  }
  if (state.questions.length !== guideQuestions.length) {
    throw new CoverageDomainError(
      'invalid_coverage_state',
      'Coverage state must contain every guide question exactly once',
    );
  }

  const stateById = new Map<string, QuestionCoverage>();
  for (const question of state.questions) {
    if (stateById.has(question.questionId)) {
      throw new CoverageDomainError(
        'invalid_coverage_state',
        `Coverage contains duplicate question ${question.questionId}`,
      );
    }
    stateById.set(question.questionId, question);
  }
  for (const guideQuestion of guideQuestions) {
    const coverage = stateById.get(guideQuestion.questionId);
    if (
      coverage === undefined ||
      coverage.kind !== guideQuestion.kind ||
      coverage.mainQuestionId !== guideQuestion.mainQuestionId
    ) {
      throw new CoverageDomainError(
        'invalid_coverage_state',
        `Coverage does not match guide question ${guideQuestion.questionId}`,
      );
    }
  }
  if (state.questions.filter((question) => question.status === 'current').length > 1) {
    throw new CoverageDomainError(
      'multiple_current_questions',
      'Only one guide question may be current at a time',
    );
  }
}

function validateCoverageUpdate(update: CoverageUpdate): void {
  if (!isValidTimestamp(update.at)) {
    throw new CoverageDomainError(
      'invalid_timestamp',
      `Coverage update for ${update.questionId} requires a valid timestamp`,
    );
  }
  if (
    update.referencedTurnIds.some((turnId) => turnId.trim().length === 0) ||
    new Set(update.referencedTurnIds).size !== update.referencedTurnIds.length
  ) {
    throw new CoverageDomainError(
      'invalid_evidence',
      `Coverage update for ${update.questionId} contains invalid turn references`,
    );
  }
  const requiresEvidence =
    update.status === 'partially_answered' ||
    update.status === 'answered' ||
    update.status === 'skipped_already_answered';
  if (requiresEvidence && update.referencedTurnIds.length === 0) {
    throw new CoverageDomainError(
      'invalid_evidence',
      `Coverage status ${update.status} requires at least one transcript turn`,
    );
  }
  if (update.status === 'not_addressed' && update.referencedTurnIds.length > 0) {
    throw new CoverageDomainError(
      'invalid_evidence',
      'Coverage status not_addressed must not reference transcript turns',
    );
  }
}

function selectByStatusPriority(
  questions: readonly GuideQuestionCatalogEntry[],
  coverageById: ReadonlyMap<string, QuestionCoverage>,
): OpenCoverageQuestion | null {
  const statusPriority: readonly OpenQuestionCoverageStatus[] = [
    'current',
    'partially_answered',
    'not_addressed',
  ];
  for (const status of statusPriority) {
    for (const question of questions) {
      const coverage = coverageById.get(question.questionId);
      if (coverage !== undefined && coverage.status === status && OPEN_STATUSES.has(status)) {
        return {
          sectionId: question.sectionId,
          mainQuestionId: question.mainQuestionId,
          questionId: question.questionId,
          kind: question.kind,
          text: question.text,
          status,
        };
      }
    }
  }
  return null;
}

function mergeUnique(left: readonly string[], right: readonly string[]): readonly string[] {
  return [...new Set([...left, ...right])];
}

function isValidTimestamp(value: string): boolean {
  return value.trim().length > 0 && Number.isFinite(Date.parse(value));
}
