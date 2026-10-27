import {
  type AiTranscriptTurn,
  type CanonicalTranscriptEntry,
  type FinalizedParticipantSegment,
  type ParticipantTranscriptTurn,
  type QuestionTurnType,
  type TranscriptAggregate,
  type TranscriptInvariantIssue,
  type TranscriptValidationOptions,
  type TranscriptValidationResult,
  type TranscriptTurn,
} from './model.js';
import {
  buildGuideQuestionIndex,
  guideReferenceMatchesTurnType,
  isValidGuideReference,
  validateGuideQuestionMembership,
  validatePersistedGuideReference,
  sameGuideReference,
  type InternalGuideQuestionIndex,
} from './references.js';
import {
  addIssue,
  TECHNICAL_GAP_DESCRIPTION_MAX_LENGTH,
  TRANSCRIPT_TEXT_MAX_LENGTH,
  finalSegmentMatchesTurn,
  getEntryId,
  isValidBoundedText,
  isQuestionTurn,
  isValidSpeakerTurnType,
} from './shared.js';

type AiQuestionTranscriptTurn = Extract<AiTranscriptTurn, { readonly turnType: QuestionTurnType }>;

export function validateFinalTranscript(
  aggregate: TranscriptAggregate,
  options: TranscriptValidationOptions = {},
): TranscriptValidationResult {
  const issues: TranscriptInvariantIssue[] = [];
  let guideIndex: InternalGuideQuestionIndex | undefined;
  try {
    guideIndex = buildGuideQuestionIndex(aggregate.guideId, aggregate.guideQuestionIndex);
  } catch (error: unknown) {
    addIssue(
      issues,
      'invalid_guide_question_index',
      error instanceof Error ? error.message : 'The guide question index is invalid',
      null,
    );
  }
  if (aggregate.interviewId.trim().length === 0) {
    addIssue(issues, 'invalid_interview_id', 'Interview ID must not be empty', null);
  }
  if (aggregate.guideId.trim().length === 0) {
    addIssue(issues, 'invalid_guide_id', 'Guide ID must not be empty', null);
  }
  if (aggregate.nextSequenceNumber !== aggregate.entries.length + 1) {
    addIssue(
      issues,
      'invalid_next_sequence',
      'nextSequenceNumber must immediately follow the last canonical entry',
      null,
    );
  }

  const entryIds = new Set<string>();
  const deliveryEventIds = new Set<string>();
  const gapSourceEventIds = new Set<string>();
  let previousTimestamp = Number.NEGATIVE_INFINITY;
  for (const [index, entry] of aggregate.entries.entries()) {
    const entryId = getEntryId(entry);
    if (entry.sequenceNumber !== index + 1) {
      addIssue(
        issues,
        'non_monotonic_sequence',
        `Entry ${entryId} has sequence ${entry.sequenceNumber}; expected ${index + 1}`,
        entryId,
      );
    }
    if (entryIds.has(entryId)) {
      addIssue(issues, 'duplicate_entry_id', `Entry ID ${entryId} is duplicated`, entryId);
    }
    entryIds.add(entryId);
    if (entry.interviewId !== aggregate.interviewId) {
      addIssue(
        issues,
        'interview_mismatch',
        `Entry ${entryId} belongs to another interview`,
        entryId,
      );
    }
    const parsedTimestamp = Date.parse(entry.occurredAt);
    if (!Number.isFinite(parsedTimestamp)) {
      addIssue(issues, 'invalid_timestamp', `Entry ${entryId} has an invalid timestamp`, entryId);
    } else if (parsedTimestamp < previousTimestamp) {
      addIssue(
        issues,
        'timestamp_regression',
        `Entry ${entryId} is timestamped before an earlier sequence`,
        entryId,
      );
    } else {
      previousTimestamp = parsedTimestamp;
    }
    validateCanonicalEntry(entry, aggregate.guideId, guideIndex, issues);

    if (entry.kind === 'turn' && entry.speaker === 'ai_interviewer') {
      if (deliveryEventIds.has(entry.deliveryEventId)) {
        addIssue(
          issues,
          'duplicate_delivery_event_id',
          `AI delivery event ${entry.deliveryEventId} is duplicated`,
          entryId,
        );
      }
      deliveryEventIds.add(entry.deliveryEventId);
    } else if (entry.kind === 'technical_gap') {
      const sourceEventKey = sourceIdentityKey(entry.sourceProvider, entry.sourceEventId);
      if (gapSourceEventIds.has(sourceEventKey)) {
        addIssue(
          issues,
          'duplicate_source_event_id',
          `Gap source event ${entry.sourceEventId} is duplicated`,
          entryId,
        );
      }
      gapSourceEventIds.add(sourceEventKey);
    }
  }

  validateSegmentInvariants(aggregate, guideIndex, issues);
  validateConversationGrammar(aggregate, options, issues);
  return { valid: issues.length === 0, issues };
}

function validateCanonicalEntry(
  entry: CanonicalTranscriptEntry,
  guideId: string,
  guideIndex: InternalGuideQuestionIndex | undefined,
  issues: TranscriptInvariantIssue[],
): void {
  const entryId = getEntryId(entry);
  if (entry.kind === 'technical_gap') {
    if (!isValidBoundedText(entry.description, TECHNICAL_GAP_DESCRIPTION_MAX_LENGTH)) {
      addIssue(
        issues,
        'invalid_text',
        `Technical gap ${entryId} has invalid description text`,
        entryId,
      );
    }
    return;
  }
  if (!isValidBoundedText(entry.text, TRANSCRIPT_TEXT_MAX_LENGTH)) {
    addIssue(issues, 'invalid_text', `Turn ${entryId} has invalid text`, entryId);
  }
  if (!isValidSpeakerTurnType(entry.speaker, entry.turnType)) {
    addIssue(
      issues,
      'invalid_speaker_turn_type',
      `Turn ${entryId} combines an invalid speaker and turn type`,
      entryId,
    );
  }
  if (entry.speaker === 'ai_interviewer' && entry.delivery.status === 'interrupted') {
    const interruptedAt = Date.parse(entry.delivery.interruptedAt);
    if (!Number.isFinite(interruptedAt) || interruptedAt < Date.parse(entry.occurredAt)) {
      addIssue(
        issues,
        'invalid_interruption',
        `Turn ${entryId} has invalid interruption metadata`,
        entryId,
      );
    }
  }
  if (!isValidGuideReference(entry.guideReference)) {
    addIssue(
      issues,
      'invalid_guide_reference',
      `Turn ${entryId} has an invalid guide reference`,
      entryId,
    );
  } else if (entry.guideReference !== null && entry.guideReference.guideId !== guideId) {
    addIssue(issues, 'guide_mismatch', `Turn ${entryId} references another guide`, entryId);
  } else if (entry.guideReference !== null && guideIndex !== undefined) {
    validateGuideQuestionMembership(entry.guideReference, guideIndex, entryId, issues);
  }
  if (!guideReferenceMatchesTurnType(entry)) {
    addIssue(
      issues,
      'invalid_guide_reference',
      `Turn ${entryId} has a guide reference incompatible with ${entry.turnType}`,
      entryId,
    );
  }
}

function validateSegmentInvariants(
  aggregate: TranscriptAggregate,
  guideIndex: InternalGuideQuestionIndex | undefined,
  issues: TranscriptInvariantIssue[],
): void {
  const finalBySegmentId = new Map<string, FinalizedParticipantSegment>();
  const finalProviderEventIds = new Set<string>();
  const finalUtteranceIds = new Set<string>();
  const gappedUtteranceIds = new Set<string>();
  const gappedSegmentIds = new Set<string>();
  for (const entry of aggregate.entries) {
    if (entry.kind !== 'technical_gap' || entry.source !== 'speech_to_text') continue;
    const utteranceKey = sourceIdentityKey(entry.sourceProvider, entry.relatedUtteranceId);
    if (gappedUtteranceIds.has(utteranceKey)) {
      addIssue(
        issues,
        'duplicate_utterance_id',
        `Gap utterance ${entry.relatedUtteranceId} is duplicated`,
        entry.gapId,
      );
    }
    gappedUtteranceIds.add(utteranceKey);
    if (entry.relatedSegmentId === null) continue;
    const segmentKey = sourceIdentityKey(entry.sourceProvider, entry.relatedSegmentId);
    if (gappedSegmentIds.has(segmentKey)) {
      addIssue(
        issues,
        'duplicate_segment_id',
        `Gap segment ${entry.relatedSegmentId} is duplicated`,
        entry.gapId,
      );
    }
    gappedSegmentIds.add(segmentKey);
  }
  for (const finalSegment of aggregate.finals) {
    if (finalSegment.interviewId !== aggregate.interviewId) {
      addIssue(
        issues,
        'interview_mismatch',
        `Final segment ${finalSegment.segmentId} belongs to another interview`,
        finalSegment.turnId,
      );
    }
    const finalSegmentKey = sourceIdentityKey(finalSegment.sourceProvider, finalSegment.segmentId);
    const finalProviderEventKey = sourceIdentityKey(
      finalSegment.sourceProvider,
      finalSegment.providerEventId,
    );
    const finalUtteranceKey = sourceIdentityKey(
      finalSegment.sourceProvider,
      finalSegment.utteranceId,
    );
    if (finalBySegmentId.has(finalSegmentKey)) {
      addIssue(
        issues,
        'duplicate_segment_id',
        `Final segment ${finalSegment.segmentId} is duplicated`,
        finalSegment.turnId,
      );
    }
    if (finalProviderEventIds.has(finalProviderEventKey)) {
      addIssue(
        issues,
        'duplicate_provider_event_id',
        `Final provider event ${finalSegment.providerEventId} is duplicated`,
        finalSegment.turnId,
      );
    }
    if (finalUtteranceIds.has(finalUtteranceKey)) {
      addIssue(
        issues,
        'duplicate_utterance_id',
        `Final utterance ${finalSegment.utteranceId} is duplicated`,
        finalSegment.turnId,
      );
    }
    if (gappedUtteranceIds.has(finalUtteranceKey) || gappedSegmentIds.has(finalSegmentKey)) {
      addIssue(
        issues,
        'conflicting_finalization_record',
        `Final source ${finalSegment.segmentId}/${finalSegment.utteranceId} is already represented by a technical gap`,
        finalSegment.turnId,
      );
    }
    finalProviderEventIds.add(finalProviderEventKey);
    finalUtteranceIds.add(finalUtteranceKey);
    finalBySegmentId.set(finalSegmentKey, finalSegment);
    validatePersistedGuideReference(
      finalSegment.guideReference,
      aggregate.guideId,
      guideIndex,
      finalSegment.turnId,
      issues,
    );
    const turn = aggregate.entries.find(
      (entry): entry is ParticipantTranscriptTurn =>
        entry.kind === 'turn' &&
        entry.speaker === 'participant' &&
        entry.sourceProvider === finalSegment.sourceProvider &&
        entry.sourceSegmentId === finalSegment.segmentId,
    );
    if (turn === undefined) {
      addIssue(
        issues,
        'orphan_finalization_record',
        `Final segment ${finalSegment.segmentId} has no participant turn`,
        finalSegment.turnId,
      );
    } else if (!finalSegmentMatchesTurn(finalSegment, turn)) {
      addIssue(
        issues,
        'conflicting_finalization_record',
        `Final segment ${finalSegment.segmentId} differs from its participant turn`,
        turn.turnId,
      );
    }
  }

  const participantSourceSegmentIds = new Set<string>();
  const participantProviderEventIds = new Set<string>();
  for (const entry of aggregate.entries) {
    if (entry.kind !== 'turn' || entry.speaker !== 'participant') {
      continue;
    }
    const sourceSegmentKey = sourceIdentityKey(entry.sourceProvider, entry.sourceSegmentId);
    const providerEventKey = sourceIdentityKey(entry.sourceProvider, entry.providerEventId);
    if (participantSourceSegmentIds.has(sourceSegmentKey)) {
      addIssue(
        issues,
        'duplicate_participant_source_segment',
        `Multiple participant turns use source segment ${entry.sourceSegmentId}`,
        entry.turnId,
      );
    }
    participantSourceSegmentIds.add(sourceSegmentKey);
    if (participantProviderEventIds.has(providerEventKey)) {
      addIssue(
        issues,
        'duplicate_provider_event_id',
        `Participant provider event ${entry.providerEventId} is duplicated`,
        entry.turnId,
      );
    }
    participantProviderEventIds.add(providerEventKey);
    if (!finalBySegmentId.has(sourceSegmentKey)) {
      addIssue(
        issues,
        'missing_finalization_record',
        `Participant turn ${entry.turnId} has no final segment record`,
        entry.turnId,
      );
    }
  }

  const partialIds = new Set<string>();
  const partialProviderEventIds = new Set<string>();
  for (const partial of aggregate.partials) {
    if (partial.interviewId !== aggregate.interviewId) {
      addIssue(
        issues,
        'interview_mismatch',
        `Partial segment ${partial.segmentId} belongs to another interview`,
        null,
      );
    }
    const partialSegmentKey = sourceIdentityKey(partial.sourceProvider, partial.segmentId);
    const partialProviderEventKey = sourceIdentityKey(
      partial.sourceProvider,
      partial.providerEventId,
    );
    const partialUtteranceKey = sourceIdentityKey(partial.sourceProvider, partial.utteranceId);
    if (partialIds.has(partialSegmentKey)) {
      addIssue(
        issues,
        'duplicate_segment_id',
        `Partial segment ${partial.segmentId} is duplicated`,
        null,
      );
    }
    if (
      partialProviderEventIds.has(partialProviderEventKey) ||
      finalProviderEventIds.has(partialProviderEventKey)
    ) {
      addIssue(
        issues,
        'duplicate_provider_event_id',
        `Provider event ${partial.providerEventId} is duplicated`,
        null,
      );
    }
    partialIds.add(partialSegmentKey);
    partialProviderEventIds.add(partialProviderEventKey);
    if (
      finalBySegmentId.has(partialSegmentKey) ||
      finalUtteranceIds.has(partialUtteranceKey) ||
      gappedUtteranceIds.has(partialUtteranceKey)
    ) {
      addIssue(
        issues,
        'late_partial_segment',
        `Partial segment ${partial.segmentId} remains after finalization`,
        null,
      );
    } else {
      addIssue(
        issues,
        'unresolved_partial_segment',
        `Partial segment ${partial.segmentId} has not been finalized or marked as a gap`,
        null,
      );
    }
  }
}

function sourceIdentityKey(sourceProvider: string | null, identity: string): string {
  return JSON.stringify([sourceProvider, identity]);
}

function validateConversationGrammar(
  aggregate: TranscriptAggregate,
  options: TranscriptValidationOptions,
  issues: TranscriptInvariantIssue[],
): void {
  const turns = aggregate.entries.filter((entry): entry is TranscriptTurn => entry.kind === 'turn');
  const greetings = turns.filter(
    (turn): turn is AiTranscriptTurn =>
      turn.speaker === 'ai_interviewer' && turn.turnType === 'greeting',
  );
  if (greetings.length === 0) {
    addIssue(issues, 'missing_greeting', 'A final transcript requires one greeting', null);
  } else {
    if (greetings.length > 1) {
      addIssue(
        issues,
        'multiple_greetings',
        'A final transcript must contain exactly one greeting',
        greetings[1]?.turnId ?? null,
      );
    }
    if (turns[0]?.turnId !== greetings[0]?.turnId) {
      addIssue(
        issues,
        'greeting_not_first',
        'The greeting must be the first conversation turn',
        greetings[0]?.turnId ?? null,
      );
    }
  }

  const mainQuestions = turns.filter(
    (turn): turn is AiTranscriptTurn & { readonly turnType: 'main_question' } =>
      turn.speaker === 'ai_interviewer' && turn.turnType === 'main_question',
  );
  if (mainQuestions.length === 0) {
    addIssue(
      issues,
      'missing_main_question',
      'A final transcript requires at least one main question',
      null,
    );
  }

  let previousTurn: TranscriptTurn | undefined;
  let pendingQuestion: AiQuestionTranscriptTurn | undefined;
  const answeredMainQuestionIds = new Set<string>();
  const gappedMainQuestionIds = new Set<string>();
  let previousEntry: CanonicalTranscriptEntry | undefined;
  for (const entry of aggregate.entries) {
    if (entry.kind === 'technical_gap') {
      if (
        entry.source === 'speech_to_text' &&
        pendingQuestion !== undefined &&
        previousEntry?.kind === 'turn' &&
        previousEntry.turnId === pendingQuestion.turnId
      ) {
        if (pendingQuestion.turnType === 'main_question') {
          gappedMainQuestionIds.add(pendingQuestion.guideReference.mainQuestionId);
        }
        pendingQuestion = undefined;
      }
      previousEntry = entry;
      continue;
    }
    const turn = entry;
    if (isQuestionTurn(turn)) {
      if (pendingQuestion !== undefined) {
        addIssue(
          issues,
          'unanswered_question_before_next_question',
          `Question ${pendingQuestion.turnId} was replaced before receiving an answer or STT gap`,
          pendingQuestion.turnId,
        );
      }
      pendingQuestion = turn;
    } else if (turn.speaker === 'participant') {
      if (previousTurn?.speaker === 'participant') {
        addIssue(
          issues,
          'consecutive_participant_answers',
          'Participant answers cannot occur consecutively',
          turn.turnId,
        );
      }
      if (pendingQuestion === undefined) {
        addIssue(
          issues,
          'participant_without_question',
          'A participant answer must follow an interviewer question',
          turn.turnId,
        );
      } else {
        if (!sameGuideReference(turn.guideReference, pendingQuestion.guideReference)) {
          addIssue(
            issues,
            'participant_question_reference_mismatch',
            `Participant answer ${turn.turnId} does not reference question ${pendingQuestion.turnId}`,
            turn.turnId,
          );
        }
        answeredMainQuestionIds.add(pendingQuestion.guideReference.mainQuestionId);
        pendingQuestion = undefined;
      }
      if (turn.guideReference !== null) {
        answeredMainQuestionIds.add(turn.guideReference.mainQuestionId);
      }
    }
    previousTurn = turn;
    previousEntry = turn;
  }

  if (pendingQuestion !== undefined) {
    addIssue(
      issues,
      'unanswered_last_question',
      `Question ${pendingQuestion.turnId} has no subsequent participant answer`,
      pendingQuestion.turnId,
    );
  }

  const closings = turns.filter(
    (turn): turn is AiTranscriptTurn =>
      turn.speaker === 'ai_interviewer' && turn.turnType === 'closing',
  );
  if (closings.length === 0) {
    addIssue(issues, 'missing_closing', 'A final transcript requires one closing', null);
  } else {
    if (closings.length > 1) {
      addIssue(
        issues,
        'multiple_closings',
        'A final transcript must contain exactly one closing',
        closings[1]?.turnId ?? null,
      );
    }
    const finalEntry = aggregate.entries.at(-1);
    if (
      finalEntry?.kind !== 'turn' ||
      finalEntry.speaker !== 'ai_interviewer' ||
      finalEntry.turnType !== 'closing'
    ) {
      addIssue(
        issues,
        'closing_not_terminal',
        'The closing must be the final canonical transcript entry',
        closings.at(-1)?.turnId ?? null,
      );
    }
  }

  const requiredMainQuestionIds =
    options.requiredMainQuestionIds ??
    aggregate.guideQuestionIndex
      .filter((reference) => reference.kind === 'main_question')
      .map((reference) => reference.mainQuestionId);
  const askedMainQuestionIds = new Set(
    mainQuestions.map((turn) => turn.guideReference.mainQuestionId),
  );
  const requireAnswers = options.requireAnswersForRequiredMainQuestions ?? true;
  for (const mainQuestionId of new Set(requiredMainQuestionIds)) {
    if (!askedMainQuestionIds.has(mainQuestionId)) {
      addIssue(
        issues,
        'missing_required_main_question',
        `Required main question ${mainQuestionId} was not asked`,
        null,
      );
    } else if (
      requireAnswers &&
      !answeredMainQuestionIds.has(mainQuestionId) &&
      !gappedMainQuestionIds.has(mainQuestionId)
    ) {
      addIssue(
        issues,
        'unanswered_required_main_question',
        `Required main question ${mainQuestionId} has no participant answer`,
        null,
      );
    }
  }
}
