import {
  interviewGuideSchema,
  interviewStateSchema,
  type GuideQuestionReference,
  type InterviewState,
  type MainQuestionReference,
} from '@orgscience/contracts';
import {
  buildGuideQuestionCatalog,
  toInterviewLifecycleSnapshot,
  type InterviewGuideSnapshot,
  type QuestionCoverage,
} from '@orgscience/domain';

import { failure, success, type PersistedInterview } from '../persistence/index.js';
import type { ApplicationResult } from '../errors.js';

export function projectInterviewView(
  interview: PersistedInterview,
  guide: InterviewGuideSnapshot,
): ApplicationResult<InterviewState> {
  const guideValidation = interviewGuideSchema.safeParse(guide);
  if (!guideValidation.success || guide.id !== interview.guideId) {
    return invalidView(interview.interviewId, 'Interview guide is invalid or mismatched');
  }
  if (
    interview.lifecycle.interviewId !== interview.interviewId ||
    interview.lifecycle.guideId !== interview.guideId ||
    interview.lifecycle.revision !== interview.version ||
    interview.coverage.interviewId !== interview.interviewId ||
    interview.coverage.guideId !== interview.guideId
  ) {
    return invalidView(interview.interviewId, 'Persisted interview scopes or versions are invalid');
  }

  const questionCatalog = buildGuideQuestionCatalog(guide);
  const coverageById = new Map(
    interview.coverage.questions.map((coverage) => [coverage.questionId, coverage]),
  );
  if (
    coverageById.size !== questionCatalog.length ||
    interview.coverage.questions.length !== questionCatalog.length
  ) {
    return invalidView(interview.interviewId, 'Coverage must contain every guide question once');
  }

  const coverage: InterviewState['coverage'] = [];
  let currentMainQuestion: MainQuestionReference | null = null;
  for (const indexed of questionCatalog) {
    const questionId = indexed.questionId;
    const persisted = coverageById.get(questionId);
    const reference: GuideQuestionReference = indexed.reference;
    if (persisted === undefined || !coverageMatchesReference(persisted, reference)) {
      return invalidView(
        interview.interviewId,
        `Coverage does not match guide question ${questionId}`,
      );
    }

    coverage.push({
      question: reference,
      status: persisted.status,
      transcriptTurnIds: [...persisted.referencedTurnIds],
    });
    if (persisted.status === 'current') {
      if (currentMainQuestion !== null) {
        return invalidView(interview.interviewId, 'More than one current question is persisted');
      }
      currentMainQuestion = {
        kind: 'main_question',
        guideId: guide.id,
        sectionId: indexed.sectionId,
        mainQuestionId: indexed.mainQuestionId,
      };
    }
  }

  const projected = interviewStateSchema.safeParse({
    interviewId: interview.interviewId,
    guideId: interview.guideId,
    language: interview.language ?? 'de',
    lifecycle: toInterviewLifecycleSnapshot(interview.lifecycle),
    currentMainQuestion,
    coverage,
    activeWorkflowRunId: interview.activeWorkflowRunId,
    version: interview.version,
    createdAt: interview.createdAt,
    updatedAt: interview.updatedAt,
  });
  return projected.success
    ? success(projected.data)
    : invalidView(interview.interviewId, 'Interview view does not satisfy the shared contract');
}

function coverageMatchesReference(
  coverage: QuestionCoverage,
  reference: GuideQuestionReference,
): boolean {
  return reference.kind === 'main_question'
    ? coverage.kind === 'main' &&
        coverage.questionId === reference.mainQuestionId &&
        coverage.mainQuestionId === reference.mainQuestionId
    : coverage.kind === 'follow_up' &&
        coverage.questionId === reference.followUpQuestionId &&
        coverage.mainQuestionId === reference.mainQuestionId;
}

function invalidView(interviewId: string, message: string): ApplicationResult<never> {
  return failure({
    code: 'application_invariant',
    resource: 'interview_view',
    id: interviewId,
    message,
  });
}
