import { isDeepStrictEqual } from 'node:util';

import {
  idSchema,
  interviewLifecycleStateSchema,
  sectionMemorySchema,
  supportedLocaleSchema,
  timestampSchema,
} from '@orgscience/contracts';
import {
  toInterviewLifecycleSnapshot,
  transitionInterview,
  type GuideCoverageState,
  type InterviewLifecycleAction,
  type InterviewLifecycleSnapshot,
  type InterviewLifecycleState,
  type QuestionCoverage,
  type QuestionCoverageStatus,
} from '@orgscience/domain';
import type { PersistedInterview } from '../../../application/persistence/index.js';
import type { CoverageRow, GuideQuestionShapeRow } from './interview-repository-rows.js';

const ALLOWED_COVERAGE_TRANSITIONS: Readonly<
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

export function validateInterviewInput(
  interviewId: string,
  interview: PersistedInterview,
): string | null {
  if (
    ![
      interviewId,
      interview.interviewId,
      interview.lifecycle.interviewId,
      interview.coverage.interviewId,
    ].every(isInternalId) ||
    interviewId !== interview.interviewId ||
    interviewId !== interview.lifecycle.interviewId ||
    interviewId !== interview.coverage.interviewId
  ) {
    return 'interview_repository_input_identity';
  }
  if (
    ![interview.guideId, interview.lifecycle.guideId, interview.coverage.guideId].every(
      isInternalId,
    ) ||
    interview.guideId !== interview.lifecycle.guideId ||
    interview.guideId !== interview.coverage.guideId
  ) {
    return 'interview_repository_input_guide';
  }
  if (interview.activeWorkflowRunId !== null && !isInternalId(interview.activeWorkflowRunId)) {
    return 'interview_repository_input_identity';
  }
  if (!supportedLocaleSchema.safeParse(interview.language ?? 'de').success) {
    return 'interview_repository_input_language';
  }
  const memories = interview.sectionMemories ?? [];
  if (
    new Set(memories.map((memory) => memory.sectionId)).size !== memories.length ||
    memories.some(
      (memory) =>
        memory.interviewId !== interviewId ||
        memory.guideId !== interview.guideId ||
        !sectionMemorySchema.safeParse(memory).success,
    )
  ) {
    return 'interview_repository_input_section_memories';
  }
  if (
    interview.version !== interview.lifecycle.revision ||
    interview.version < 0 ||
    interview.coverage.revision < 0 ||
    !Number.isInteger(interview.version) ||
    !Number.isInteger(interview.coverage.revision)
  ) {
    return 'interview_repository_input_version';
  }
  if (
    !timestampSchema.safeParse(interview.createdAt).success ||
    !timestampSchema.safeParse(interview.updatedAt).success
  ) {
    return 'interview_repository_input_timestamp';
  }
  if (
    !interviewLifecycleStateSchema.safeParse(toInterviewLifecycleSnapshot(interview.lifecycle))
      .success
  ) {
    return 'interview_repository_input_lifecycle';
  }
  if (!sameTimestamp(interview.createdAt, interview.lifecycle.createdAt)) {
    return 'interview_repository_input_version';
  }
  if (
    Date.parse(interview.updatedAt) < Date.parse(interview.createdAt) ||
    Date.parse(interview.updatedAt) < Date.parse(latestLifecycleTimestamp(interview.lifecycle))
  ) {
    return 'interview_repository_input_timestamp';
  }
  const questionIds = new Set<string>();
  const mainQuestionIds = new Set<string>();
  let currentCount = 0;
  for (const question of interview.coverage.questions) {
    if (
      !isInternalId(question.questionId) ||
      !isInternalId(question.mainQuestionId) ||
      questionIds.has(question.questionId) ||
      (question.kind === 'main' && question.questionId !== question.mainQuestionId) ||
      (question.kind === 'follow_up' && question.questionId === question.mainQuestionId) ||
      (question.updatedAt !== null && !timestampSchema.safeParse(question.updatedAt).success) ||
      !question.referencedTurnIds.every(isInternalId)
    ) {
      return 'interview_repository_input_coverage';
    }
    questionIds.add(question.questionId);
    if (question.kind === 'main') {
      mainQuestionIds.add(question.questionId);
    }
    if (question.status === 'current') {
      currentCount += 1;
    }
    const requiresEvidence =
      question.status === 'partially_answered' ||
      question.status === 'answered' ||
      question.status === 'skipped_already_answered';
    if (
      new Set(question.referencedTurnIds).size !== question.referencedTurnIds.length ||
      (requiresEvidence && question.referencedTurnIds.length === 0) ||
      (question.status === 'not_addressed' && question.referencedTurnIds.length > 0)
    ) {
      return 'interview_repository_input_coverage';
    }
  }
  if (
    interview.coverage.questions.length === 0 ||
    interview.coverage.questions.some(
      (question) => question.kind === 'follow_up' && !mainQuestionIds.has(question.mainQuestionId),
    )
  ) {
    return 'interview_repository_input_coverage';
  }
  return currentCount > 1 ? 'interview_repository_input_current_coverage' : null;
}

export function validateInterviewTransition(
  current: PersistedInterview,
  next: PersistedInterview,
): string | null {
  if ((current.language ?? 'de') !== (next.language ?? 'de')) {
    return 'interview_repository_language_immutable';
  }
  const currentMemories = current.sectionMemories ?? [];
  const nextMemories = next.sectionMemories ?? [];
  if (
    currentMemories.length > nextMemories.length ||
    currentMemories.some((memory, index) => !isDeepStrictEqual(memory, nextMemories[index]))
  ) {
    return 'interview_repository_section_memories_immutable';
  }
  const lifecycleError = validateLifecycleTransition(current.lifecycle, next.lifecycle);
  if (lifecycleError !== null) {
    return lifecycleError;
  }
  return validateCoverageTransition(current.coverage, next.coverage);
}

export function validateCoverageAgainstPersistedGuide(
  coverage: GuideCoverageState,
  guideId: string,
  rows: readonly (CoverageRow | GuideQuestionShapeRow)[],
): string | null {
  if (rows.length === 0 || coverage.guideId !== guideId) {
    return 'interview_repository_guide_coverage';
  }

  const persistedQuestions = new Map<
    string,
    { readonly kind: QuestionCoverage['kind']; readonly mainQuestionId: string }
  >();
  for (const row of rows) {
    if (row.guide_id !== guideId) {
      return 'interview_repository_guide_coverage';
    }
    const persisted = {
      kind: row.question_kind === 'main_question' ? ('main' as const) : ('follow_up' as const),
      mainQuestionId: row.main_question_id,
    };
    const existing = persistedQuestions.get(row.question_id);
    if (existing !== undefined && !isDeepStrictEqual(existing, persisted)) {
      return 'interview_repository_guide_coverage';
    }
    persistedQuestions.set(row.question_id, persisted);
  }

  if (persistedQuestions.size !== coverage.questions.length) {
    return 'interview_repository_guide_coverage';
  }
  for (const question of coverage.questions) {
    const persisted = persistedQuestions.get(question.questionId);
    if (
      persisted === undefined ||
      persisted.kind !== question.kind ||
      persisted.mainQuestionId !== question.mainQuestionId
    ) {
      return 'interview_repository_guide_coverage';
    }
  }
  return null;
}

function latestLifecycleTimestamp(lifecycle: InterviewLifecycleState): string {
  switch (lifecycle.status) {
    case 'ready':
      return lifecycle.createdAt;
    case 'active':
      return lifecycle.activeSince;
    case 'paused':
      return lifecycle.pausedAt;
    case 'ending':
      return lifecycle.endingAt;
    case 'completed':
      return lifecycle.endedAt;
    case 'failed':
      return lifecycle.failedAt;
  }
}

export function lifecycleColumns(lifecycle: InterviewLifecycleState): readonly (string | null)[] {
  switch (lifecycle.status) {
    case 'ready':
      return [null, null, null, null, null, null, null, null, null, null];
    case 'active':
      return [
        lifecycle.startedAt,
        lifecycle.activeSince,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
      ];
    case 'paused':
      return [
        lifecycle.startedAt,
        null,
        lifecycle.pausedAt,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
      ];
    case 'ending':
      return [
        lifecycle.startedAt,
        null,
        null,
        lifecycle.endingAt,
        lifecycle.endingFrom,
        null,
        null,
        null,
        null,
        null,
      ];
    case 'completed':
      return [
        lifecycle.startedAt,
        null,
        null,
        lifecycle.endingAt,
        null,
        lifecycle.endedAt,
        null,
        null,
        null,
        null,
      ];
    case 'failed':
      return [
        lifecycle.startedAt,
        null,
        null,
        null,
        null,
        null,
        lifecycle.failedAt,
        lifecycle.failedFrom,
        lifecycle.failure.code,
        lifecycle.failure.message,
      ];
  }
}

export function currentMainQuestionId(coverage: GuideCoverageState): string | null {
  const current = coverage.questions.find((question) => question.status === 'current');
  return current?.mainQuestionId ?? null;
}

export function serializeInterview(interview: PersistedInterview): string {
  return JSON.stringify({
    interviewId: interview.interviewId,
    guideId: interview.guideId,
    language: interview.language ?? 'de',
    sectionMemories: interview.sectionMemories ?? [],
    lifecycle: normalizeLifecycleSnapshot(interview.lifecycle),
    coverage: {
      interviewId: interview.coverage.interviewId,
      guideId: interview.coverage.guideId,
      revision: interview.coverage.revision,
      questions: interview.coverage.questions
        .map((question) => ({
          questionId: question.questionId,
          kind: question.kind,
          mainQuestionId: question.mainQuestionId,
          status: question.status,
          referencedTurnIds: [...question.referencedTurnIds].sort(),
          updatedAt: question.updatedAt === null ? null : normalizeTimestamp(question.updatedAt),
        }))
        .sort((left, right) => left.questionId.localeCompare(right.questionId)),
    },
    version: interview.version,
    activeWorkflowRunId: interview.activeWorkflowRunId,
    createdAt: normalizeTimestamp(interview.createdAt),
    updatedAt: normalizeTimestamp(interview.updatedAt),
  });
}

function validateLifecycleTransition(
  current: InterviewLifecycleState,
  next: InterviewLifecycleState,
): string | null {
  if (
    current.interviewId !== next.interviewId ||
    current.guideId !== next.guideId ||
    !sameTimestamp(current.createdAt, next.createdAt) ||
    next.revision !== current.revision + 1
  ) {
    return 'interview_repository_lifecycle_transition';
  }
  if (current.status === 'completed' || current.status === 'failed') {
    return 'interview_repository_terminal_state';
  }
  if (current.status === next.status) {
    return isDeepStrictEqual(normalizeLifecycleSnapshot(current), normalizeLifecycleSnapshot(next))
      ? null
      : 'interview_repository_lifecycle_transition';
  }

  const action = lifecycleActionFor(current, next);
  if (action === null) {
    return 'interview_repository_lifecycle_transition';
  }
  const transitioned = transitionInterview(current, action);
  return transitioned.ok && lifecycleStatesEqual(transitioned.state, next)
    ? null
    : 'interview_repository_lifecycle_transition';
}

function lifecycleActionFor(
  current: InterviewLifecycleState,
  next: InterviewLifecycleState,
): InterviewLifecycleAction | null {
  switch (next.status) {
    case 'active':
      if (current.status === 'ready') return { type: 'start', at: next.activeSince };
      if (current.status === 'paused') return { type: 'resume', at: next.activeSince };
      return null;
    case 'paused':
      return current.status === 'active' ? { type: 'pause', at: next.pausedAt } : null;
    case 'ending':
      return current.status === 'active' || current.status === 'paused'
        ? { type: 'begin_ending', at: next.endingAt }
        : null;
    case 'completed':
      return current.status === 'ending' ? { type: 'complete', at: next.endedAt } : null;
    case 'failed':
      return {
        type: 'fail',
        at: next.failedAt,
        failure: next.failure,
      };
    case 'ready':
      return null;
  }
}

function validateCoverageTransition(
  current: GuideCoverageState,
  next: GuideCoverageState,
): string | null {
  if (next.revision === current.revision) {
    return coverageQuestionsEqual(current.questions, next.questions)
      ? null
      : 'interview_repository_coverage_transition';
  }
  if (next.revision !== current.revision + 1) {
    return 'interview_repository_coverage_transition';
  }

  const currentById = new Map(current.questions.map((question) => [question.questionId, question]));
  const hasReplacementCurrent = next.questions.some(
    (question) =>
      question.status === 'current' && currentById.get(question.questionId)?.status !== 'current',
  );
  const hasVacatedCurrent = next.questions.some(
    (question) =>
      currentById.get(question.questionId)?.status === 'current' && question.status !== 'current',
  );
  const isDeliveryRecoverySwap = hasReplacementCurrent && hasVacatedCurrent;
  for (const question of next.questions) {
    const previous = currentById.get(question.questionId);
    if (
      previous === undefined ||
      !isAllowedCoverageTransition(previous, question, isDeliveryRecoverySwap) ||
      previous.referencedTurnIds.some((turnId) => !question.referencedTurnIds.includes(turnId))
    ) {
      return 'interview_repository_coverage_transition';
    }

    const changed = !coverageQuestionEqual(previous, question);
    if (changed && question.updatedAt === null) {
      return 'interview_repository_coverage_transition';
    }
  }
  return null;
}

function isAllowedCoverageTransition(
  previous: QuestionCoverage,
  next: QuestionCoverage,
  isDeliveryRecoverySwap: boolean,
): boolean {
  if (ALLOWED_COVERAGE_TRANSITIONS[previous.status].has(next.status)) return true;

  if (!isDeliveryRecoverySwap) return false;

  // Delivery recovery atomically restores the previously answered source
  // question and rolls back the selected question that was never spoken.
  if (previous.status === 'answered' && next.status === 'current') return true;
  return previous.status === 'current' && next.status === 'not_addressed'
    ? previous.referencedTurnIds.length === 0 && next.referencedTurnIds.length === 0
    : false;
}

function coverageQuestionsEqual(
  left: readonly QuestionCoverage[],
  right: readonly QuestionCoverage[],
): boolean {
  if (left.length !== right.length) return false;
  const rightById = new Map(right.map((question) => [question.questionId, question]));
  return left.every((question) => {
    const candidate = rightById.get(question.questionId);
    return candidate !== undefined && coverageQuestionEqual(question, candidate);
  });
}

function coverageQuestionEqual(left: QuestionCoverage, right: QuestionCoverage): boolean {
  return (
    left.questionId === right.questionId &&
    left.kind === right.kind &&
    left.mainQuestionId === right.mainQuestionId &&
    left.status === right.status &&
    sameNullableTimestamp(left.updatedAt, right.updatedAt) &&
    sameStringSet(left.referencedTurnIds, right.referencedTurnIds)
  );
}

function sameNullableTimestamp(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right;
  return sameTimestamp(left, right);
}

function sameTimestamp(left: string, right: string): boolean {
  return Date.parse(left) === Date.parse(right);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function isInternalId(value: string): boolean {
  return idSchema.safeParse(value).success;
}

function lifecycleStatesEqual(
  left: InterviewLifecycleState,
  right: InterviewLifecycleState,
): boolean {
  return (
    left.interviewId === right.interviewId &&
    left.guideId === right.guideId &&
    left.revision === right.revision &&
    sameTimestamp(left.createdAt, right.createdAt) &&
    isDeepStrictEqual(normalizeLifecycleSnapshot(left), normalizeLifecycleSnapshot(right))
  );
}

function normalizeLifecycleSnapshot(
  lifecycle: InterviewLifecycleState,
): InterviewLifecycleSnapshot {
  const snapshot = toInterviewLifecycleSnapshot(lifecycle);
  switch (snapshot.status) {
    case 'ready':
      return snapshot;
    case 'active':
      return {
        ...snapshot,
        startedAt: normalizeTimestamp(snapshot.startedAt),
        activeSince: normalizeTimestamp(snapshot.activeSince),
      };
    case 'paused':
      return {
        ...snapshot,
        startedAt: normalizeTimestamp(snapshot.startedAt),
        pausedAt: normalizeTimestamp(snapshot.pausedAt),
      };
    case 'ending':
      return {
        ...snapshot,
        startedAt: normalizeTimestamp(snapshot.startedAt),
        endingAt: normalizeTimestamp(snapshot.endingAt),
      };
    case 'completed':
      return {
        ...snapshot,
        startedAt: normalizeTimestamp(snapshot.startedAt),
        endingAt: normalizeTimestamp(snapshot.endingAt),
        endedAt: normalizeTimestamp(snapshot.endedAt),
      };
    case 'failed':
      return {
        ...snapshot,
        startedAt: snapshot.startedAt === null ? null : normalizeTimestamp(snapshot.startedAt),
        failedAt: normalizeTimestamp(snapshot.failedAt),
      };
  }
}

function normalizeTimestamp(value: string): string {
  return new Date(value).toISOString();
}
