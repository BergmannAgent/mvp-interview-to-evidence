import {
  TranscriptDomainError,
  type FollowUpQuestionGuideReference,
  type MainQuestionGuideReference,
  type TranscriptAggregate,
  type TranscriptGuideQuestionIndexInput,
  type TranscriptGuideReference,
  type TranscriptInvariantIssue,
  type TranscriptTurn,
} from './model.js';

export interface InternalGuideQuestionIndex {
  readonly mainQuestionsById: ReadonlyMap<string, MainQuestionGuideReference>;
  readonly followUpQuestionsById: ReadonlyMap<string, FollowUpQuestionGuideReference>;
}

export function buildGuideQuestionIndex(
  guideId: string,
  guideQuestions: TranscriptGuideQuestionIndexInput,
): InternalGuideQuestionIndex {
  const mainQuestionsById = new Map<string, MainQuestionGuideReference>();
  const followUpQuestionsById = new Map<string, FollowUpQuestionGuideReference>();
  const questionIds = new Set<string>();

  for (const reference of guideQuestions) {
    if (!isValidGuideReference(reference)) {
      throw new TranscriptDomainError(
        'invalid_guide_index',
        'The guide question index contains an invalid reference',
      );
    }
    if (reference.guideId !== guideId) {
      throw new TranscriptDomainError(
        'guide_mismatch',
        `Indexed guide reference ${reference.guideId} does not match ${guideId}`,
      );
    }
    const questionId =
      reference.kind === 'main_question' ? reference.mainQuestionId : reference.followUpQuestionId;
    if (questionIds.has(questionId)) {
      throw new TranscriptDomainError(
        'invalid_guide_index',
        `Guide question ID ${questionId} is duplicated`,
      );
    }
    questionIds.add(questionId);
    if (reference.kind === 'main_question') {
      mainQuestionsById.set(reference.mainQuestionId, Object.freeze({ ...reference }));
    }
  }

  if (mainQuestionsById.size === 0) {
    throw new TranscriptDomainError(
      'invalid_guide_index',
      'The guide question index must contain at least one main question',
    );
  }

  for (const reference of guideQuestions) {
    if (reference.kind !== 'follow_up_question') {
      continue;
    }
    const parent = mainQuestionsById.get(reference.mainQuestionId);
    if (parent === undefined) {
      throw new TranscriptDomainError(
        'invalid_guide_index',
        `Follow-up ${reference.followUpQuestionId} has no indexed parent main question`,
      );
    }
    if (parent.sectionId !== reference.sectionId || parent.guideId !== reference.guideId) {
      throw new TranscriptDomainError(
        'invalid_guide_index',
        `Follow-up ${reference.followUpQuestionId} is assigned to the wrong parent`,
      );
    }
    followUpQuestionsById.set(reference.followUpQuestionId, Object.freeze({ ...reference }));
  }

  return Object.freeze({ mainQuestionsById, followUpQuestionsById });
}

export function requireGuideQuestionIndex(
  aggregate: TranscriptAggregate,
): InternalGuideQuestionIndex {
  return buildGuideQuestionIndex(aggregate.guideId, aggregate.guideQuestionIndex);
}

export function freezeGuideQuestionIndex(
  guideQuestions: TranscriptGuideQuestionIndexInput,
): TranscriptGuideQuestionIndexInput {
  return Object.freeze(
    guideQuestions.map((reference) =>
      reference.kind === 'main_question'
        ? Object.freeze({ ...reference })
        : Object.freeze({ ...reference }),
    ),
  );
}

export function validateGuideReference(
  reference: TranscriptGuideReference | null,
  aggregateGuideId: string,
  guideIndex: InternalGuideQuestionIndex,
): void {
  if (!isValidGuideReference(reference)) {
    throw new TranscriptDomainError(
      'invalid_guide_reference',
      'Guide references require a valid kind and non-empty guide/question IDs',
    );
  }
  if (reference !== null && reference.guideId !== aggregateGuideId) {
    throw new TranscriptDomainError(
      'guide_mismatch',
      `Guide reference ${reference.guideId} does not match aggregate ${aggregateGuideId}`,
    );
  }
  if (reference !== null) {
    assertKnownGuideQuestion(reference, guideIndex);
  }
}

export function validatePersistedGuideReference(
  reference: TranscriptGuideReference | null,
  guideId: string,
  guideIndex: InternalGuideQuestionIndex | undefined,
  entryId: string,
  issues: TranscriptInvariantIssue[],
): void {
  if (!isValidGuideReference(reference)) {
    issues.push({
      code: 'invalid_guide_reference',
      message: `Record ${entryId} has an invalid guide reference`,
      entryId,
    });
  } else if (reference !== null && reference.guideId !== guideId) {
    issues.push({
      code: 'guide_mismatch',
      message: `Record ${entryId} references another guide`,
      entryId,
    });
  } else if (reference !== null && guideIndex !== undefined) {
    validateGuideQuestionMembership(reference, guideIndex, entryId, issues);
  }
}

export function validateGuideQuestionMembership(
  reference: TranscriptGuideReference,
  guideIndex: InternalGuideQuestionIndex,
  entryId: string,
  issues: TranscriptInvariantIssue[],
): void {
  const indexed =
    reference.kind === 'main_question'
      ? guideIndex.mainQuestionsById.get(reference.mainQuestionId)
      : guideIndex.followUpQuestionsById.get(reference.followUpQuestionId);
  if (indexed === undefined) {
    issues.push({
      code: 'unknown_guide_question',
      message: `Record ${entryId} references an unknown guide question`,
      entryId,
    });
  } else if (!sameGuideReference(indexed, reference)) {
    issues.push({
      code: 'guide_question_mismatch',
      message: `Record ${entryId} has the wrong guide-question association`,
      entryId,
    });
  }
}

export function isValidGuideReference(reference: TranscriptGuideReference | null): boolean {
  if (reference === null) {
    return true;
  }
  if (
    !isNonBlank(reference.guideId) ||
    !isNonBlank(reference.sectionId) ||
    !isNonBlank(reference.mainQuestionId)
  ) {
    return false;
  }
  return reference.kind === 'main_question'
    ? !('followUpQuestionId' in reference)
    : reference.kind === 'follow_up_question' && isNonBlank(reference.followUpQuestionId);
}

export function guideReferenceMatchesTurnType(entry: TranscriptTurn): boolean {
  if (entry.speaker === 'participant') {
    return true;
  }
  switch (entry.turnType) {
    case 'greeting':
    case 'closing':
      return entry.guideReference === null;
    case 'main_question':
      return entry.guideReference?.kind === 'main_question';
    case 'follow_up_question':
      return entry.guideReference?.kind === 'follow_up_question';
    case 'clarification_question':
      return entry.guideReference !== null;
    case 'transition':
      return true;
  }
}

export function sameGuideReference(
  left: TranscriptGuideReference | null,
  right: TranscriptGuideReference | null,
): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  if (
    left.kind !== right.kind ||
    left.guideId !== right.guideId ||
    left.sectionId !== right.sectionId ||
    left.mainQuestionId !== right.mainQuestionId
  ) {
    return false;
  }
  return (
    left.kind === 'main_question' ||
    (right.kind === 'follow_up_question' && left.followUpQuestionId === right.followUpQuestionId)
  );
}

function assertKnownGuideQuestion(
  reference: TranscriptGuideReference,
  guideIndex: InternalGuideQuestionIndex,
): void {
  const indexed =
    reference.kind === 'main_question'
      ? guideIndex.mainQuestionsById.get(reference.mainQuestionId)
      : guideIndex.followUpQuestionsById.get(reference.followUpQuestionId);
  if (indexed === undefined) {
    throw new TranscriptDomainError(
      'unknown_guide_question',
      `Guide question ${getGuideQuestionId(reference)} is not indexed`,
    );
  }
  if (!sameGuideReference(indexed, reference)) {
    throw new TranscriptDomainError(
      'guide_question_mismatch',
      `Guide question ${getGuideQuestionId(reference)} has the wrong structural association`,
    );
  }
}

function getGuideQuestionId(reference: TranscriptGuideReference): string {
  return reference.kind === 'main_question'
    ? reference.mainQuestionId
    : reference.followUpQuestionId;
}

function isNonBlank(value: string): boolean {
  return value.trim().length > 0;
}
