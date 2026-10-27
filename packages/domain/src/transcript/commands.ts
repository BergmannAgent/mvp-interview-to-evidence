import {
  TranscriptDomainError,
  type AiTranscriptTurn,
  type AiTurnAppendResult,
  type AppendAiTurnInput,
  type FinalIngestionResult,
  type FinalizedParticipantSegment,
  type FinalParticipantSegmentInput,
  type ParticipantTranscriptTurn,
  type PartialIngestionResult,
  type PartialSegmentInput,
  type PartialTranscriptSegment,
  type RecordTechnicalGapInput,
  type TechnicalGapRecordResult,
  type TranscriptAggregate,
  type TranscriptGuideQuestionIndexInput,
  type TranscriptTechnicalGap,
} from './model.js';
import {
  buildGuideQuestionIndex,
  freezeGuideQuestionIndex,
  requireGuideQuestionIndex,
  sameGuideReference,
  type InternalGuideQuestionIndex,
  validateGuideReference,
} from './references.js';
import {
  aiInputToTurn,
  assertAppendTimestamp,
  assertIdentifier,
  assertInterviewRouting,
  assertPartialTranscriptText,
  assertProviderEventId,
  assertText,
  assertTimestamp,
  assertTranscriptProvider,
  assertUniqueEntryId,
  findParticipantProviderEvent,
  isQuestionTurn,
  sameAiTurn,
  sameFinalSegment,
  sameFinalUtterance,
  samePartialSegment,
  sameTechnicalGap,
  TECHNICAL_GAP_DESCRIPTION_MAX_LENGTH,
  TRANSCRIPT_TEXT_MAX_LENGTH,
  validateAiDelivery,
} from './shared.js';

export function createTranscriptAggregate(
  interviewId: string,
  guideId: string,
  guideQuestions: TranscriptGuideQuestionIndexInput,
): TranscriptAggregate {
  assertIdentifier(interviewId, 'interviewId');
  assertIdentifier(guideId, 'guideId');
  const serializedGuideIndex = freezeGuideQuestionIndex(guideQuestions);
  buildGuideQuestionIndex(guideId, serializedGuideIndex);
  return {
    interviewId,
    guideId,
    guideQuestionIndex: serializedGuideIndex,
    nextSequenceNumber: 1,
    entries: [],
    partials: [],
    finals: [],
  };
}

export function ingestPartialParticipantSegment(
  aggregate: TranscriptAggregate,
  input: PartialSegmentInput,
): PartialIngestionResult {
  assertInterviewRouting(aggregate, input.interviewId);
  requireGuideQuestionIndex(aggregate);
  validatePartialInput(input);

  const providerEvent = findParticipantProviderEvent(
    aggregate,
    input.sourceProvider,
    input.providerEventId,
  );
  if (providerEvent !== undefined) {
    if (providerEvent.kind === 'partial' && samePartialSegment(providerEvent.segment, input)) {
      return { status: 'ignored_stale', aggregate };
    }
    throw new TranscriptDomainError(
      'conflicting_partial_event',
      `Provider event ${input.providerEventId} was reused with different transcript data`,
    );
  }

  if (
    aggregate.entries.some(
      (entry) =>
        entry.kind === 'technical_gap' &&
        matchesSpeechSourceIdentity(
          entry,
          input.sourceProvider,
          input.utteranceId,
          input.segmentId,
        ),
    )
  ) {
    return { status: 'ignored_finalized', aggregate };
  }

  if (
    aggregate.finals.some(
      (segment) =>
        segment.sourceProvider === input.sourceProvider &&
        (segment.segmentId === input.segmentId || segment.utteranceId === input.utteranceId),
    )
  ) {
    return { status: 'ignored_finalized', aggregate };
  }

  const existing = aggregate.partials.find(
    (segment) =>
      segment.sourceProvider === input.sourceProvider && segment.segmentId === input.segmentId,
  );
  if (existing !== undefined && existing.utteranceId !== input.utteranceId) {
    throw new TranscriptDomainError(
      'conflicting_partial_segment',
      `Segment ${input.segmentId} cannot move between provider utterances`,
    );
  }
  if (existing !== undefined && input.revision <= existing.revision) {
    return { status: 'ignored_stale', aggregate };
  }

  const partial: PartialTranscriptSegment = { ...input };
  const partials =
    existing === undefined
      ? [...aggregate.partials, partial]
      : aggregate.partials.map((segment) =>
          segment.sourceProvider === input.sourceProvider && segment.segmentId === input.segmentId
            ? partial
            : segment,
        );
  return {
    status: existing === undefined ? 'accepted' : 'updated',
    aggregate: { ...aggregate, partials },
  };
}

export function ingestFinalParticipantSegment(
  aggregate: TranscriptAggregate,
  input: FinalParticipantSegmentInput,
): FinalIngestionResult {
  assertInterviewRouting(aggregate, input.interviewId);
  const guideIndex = requireGuideQuestionIndex(aggregate);
  validateFinalParticipantInput(input, aggregate.guideId, guideIndex);

  if (
    aggregate.entries.some(
      (entry) =>
        entry.kind === 'technical_gap' &&
        matchesSpeechSourceIdentity(
          entry,
          input.sourceProvider,
          input.utteranceId,
          input.segmentId,
        ),
    )
  ) {
    throw new TranscriptDomainError(
      'conflicting_final_segment',
      `Provider utterance ${input.utteranceId} is already represented by a technical gap`,
    );
  }

  const existingFinal = aggregate.finals.find(
    (segment) =>
      (segment.sourceProvider === input.sourceProvider &&
        (segment.segmentId === input.segmentId ||
          segment.utteranceId === input.utteranceId ||
          segment.providerEventId === input.providerEventId)) ||
      segment.turnId === input.turnId,
  );
  if (existingFinal !== undefined) {
    const stableUtteranceRetry =
      existingFinal.sourceProvider === input.sourceProvider &&
      existingFinal.utteranceId === input.utteranceId;
    if (
      !(stableUtteranceRetry
        ? sameFinalUtterance(existingFinal, input)
        : sameFinalSegment(existingFinal, input))
    ) {
      throw new TranscriptDomainError(
        'conflicting_final_segment',
        'A final segment identity was retried with different content or metadata',
      );
    }
    const existingTurn = aggregate.entries.find(
      (entry): entry is ParticipantTranscriptTurn =>
        entry.kind === 'turn' &&
        entry.speaker === 'participant' &&
        entry.turnId === existingFinal.turnId,
    );
    if (existingTurn === undefined) {
      throw new TranscriptDomainError(
        'conflicting_final_segment',
        `Final segment ${input.segmentId} has no canonical transcript turn`,
      );
    }
    return { status: 'duplicate', aggregate, turn: existingTurn };
  }

  const collidingPartialEvent = aggregate.partials.find(
    (segment) =>
      segment.sourceProvider === input.sourceProvider &&
      segment.providerEventId === input.providerEventId &&
      segment.segmentId !== input.segmentId,
  );
  if (collidingPartialEvent !== undefined) {
    throw new TranscriptDomainError(
      'conflicting_final_segment',
      `Provider event ${input.providerEventId} belongs to another segment`,
    );
  }

  const openQuestion = findOpenQuestion(aggregate);
  if (openQuestion === undefined) {
    throw new TranscriptDomainError(
      'participant_without_question',
      `Participant answer ${input.turnId} has no open interviewer question`,
    );
  }
  if (!sameGuideReference(input.guideReference, openQuestion.guideReference)) {
    throw new TranscriptDomainError(
      'participant_question_reference_mismatch',
      `Participant answer ${input.turnId} does not reference open question ${openQuestion.turnId}`,
    );
  }

  assertUniqueEntryId(aggregate, input.turnId);
  assertAppendTimestamp(aggregate, input.occurredAt);

  const turn: ParticipantTranscriptTurn = {
    kind: 'turn',
    interviewId: input.interviewId,
    sequenceNumber: aggregate.nextSequenceNumber,
    turnId: input.turnId,
    sourceProvider: input.sourceProvider,
    providerEventId: input.providerEventId,
    speaker: 'participant',
    turnType: 'participant_answer',
    text: input.text,
    occurredAt: input.occurredAt,
    guideReference: input.guideReference,
    sourceSegmentId: input.segmentId,
  };
  const finalized: FinalizedParticipantSegment = { ...input };
  return {
    status: 'appended',
    turn,
    aggregate: {
      ...aggregate,
      nextSequenceNumber: aggregate.nextSequenceNumber + 1,
      entries: [...aggregate.entries, turn],
      partials: aggregate.partials.filter(
        (segment) =>
          segment.sourceProvider !== input.sourceProvider ||
          (segment.segmentId !== input.segmentId && segment.utteranceId !== input.utteranceId),
      ),
      finals: [...aggregate.finals, finalized],
    },
  };
}

export function appendAiTranscriptTurn(
  aggregate: TranscriptAggregate,
  input: AppendAiTurnInput,
): AiTurnAppendResult {
  assertInterviewRouting(aggregate, input.interviewId);
  const guideIndex = requireGuideQuestionIndex(aggregate);
  validateAiTurnInput(input, aggregate.guideId, guideIndex);

  const existing = aggregate.entries.find(
    (entry): entry is AiTranscriptTurn =>
      entry.kind === 'turn' &&
      entry.speaker === 'ai_interviewer' &&
      (entry.turnId === input.turnId || entry.deliveryEventId === input.deliveryEventId),
  );
  if (existing !== undefined) {
    if (!sameAiTurn(existing, input)) {
      throw new TranscriptDomainError(
        'conflicting_ai_turn',
        'An AI turn identity was retried with different content or metadata',
      );
    }
    return { status: 'duplicate', aggregate, turn: existing };
  }

  assertUniqueEntryId(aggregate, input.turnId);
  assertAppendTimestamp(aggregate, input.occurredAt);
  const turn = aiInputToTurn(input, aggregate.nextSequenceNumber);
  return {
    status: 'appended',
    turn,
    aggregate: {
      ...aggregate,
      nextSequenceNumber: aggregate.nextSequenceNumber + 1,
      entries: [...aggregate.entries, turn],
    },
  };
}

export function recordTranscriptTechnicalGap(
  aggregate: TranscriptAggregate,
  input: RecordTechnicalGapInput,
): TechnicalGapRecordResult {
  assertInterviewRouting(aggregate, input.interviewId);
  requireGuideQuestionIndex(aggregate);
  validateGapInput(input);

  if (
    input.source === 'speech_to_text' &&
    aggregate.finals.some(
      (segment) =>
        segment.sourceProvider === input.sourceProvider &&
        (segment.utteranceId === input.relatedUtteranceId ||
          (input.relatedSegmentId !== null && segment.segmentId === input.relatedSegmentId)),
    )
  ) {
    throw new TranscriptDomainError(
      'conflicting_gap',
      `Provider utterance ${input.relatedUtteranceId} is already represented by a final segment`,
    );
  }

  const existing = aggregate.entries.find(
    (entry): entry is TranscriptTechnicalGap =>
      entry.kind === 'technical_gap' &&
      (entry.gapId === input.gapId ||
        (entry.sourceProvider === input.sourceProvider &&
          entry.sourceEventId === input.sourceEventId) ||
        (entry.source === 'speech_to_text' &&
          input.source === 'speech_to_text' &&
          matchesSpeechSourceIdentity(
            entry,
            input.sourceProvider,
            input.relatedUtteranceId,
            input.relatedSegmentId,
          ))),
  );
  if (existing !== undefined) {
    if (!sameTechnicalGap(existing, input)) {
      throw new TranscriptDomainError(
        'conflicting_gap',
        'A technical gap identity was retried with different content or metadata',
      );
    }
    return { status: 'duplicate', aggregate, gap: existing };
  }

  assertUniqueEntryId(aggregate, input.gapId);
  assertAppendTimestamp(aggregate, input.occurredAt);
  const gap: TranscriptTechnicalGap = {
    ...input,
    kind: 'technical_gap',
    sequenceNumber: aggregate.nextSequenceNumber,
  };
  return {
    status: 'appended',
    gap,
    aggregate: {
      ...aggregate,
      nextSequenceNumber: aggregate.nextSequenceNumber + 1,
      entries: [...aggregate.entries, gap],
      partials:
        input.source !== 'speech_to_text'
          ? aggregate.partials
          : aggregate.partials.filter(
              (segment) =>
                segment.sourceProvider !== input.sourceProvider ||
                (segment.segmentId !== input.relatedSegmentId &&
                  segment.utteranceId !== input.relatedUtteranceId),
            ),
    },
  };
}

function findOpenQuestion(
  aggregate: TranscriptAggregate,
):
  | Extract<
      AiTranscriptTurn,
      { readonly turnType: 'main_question' | 'follow_up_question' | 'clarification_question' }
    >
  | undefined {
  let openQuestion:
    | Extract<
        AiTranscriptTurn,
        { readonly turnType: 'main_question' | 'follow_up_question' | 'clarification_question' }
      >
    | undefined;
  let previousEntry: TranscriptAggregate['entries'][number] | undefined;

  for (const entry of aggregate.entries) {
    if (entry.kind === 'technical_gap') {
      if (
        entry.source === 'speech_to_text' &&
        openQuestion !== undefined &&
        previousEntry?.kind === 'turn' &&
        previousEntry.turnId === openQuestion.turnId
      ) {
        openQuestion = undefined;
      }
      previousEntry = entry;
      continue;
    }
    if (isQuestionTurn(entry)) {
      openQuestion = entry;
    } else if (entry.speaker === 'participant') {
      openQuestion = undefined;
    }
    previousEntry = entry;
  }

  return openQuestion;
}

function validatePartialInput(input: PartialSegmentInput): void {
  assertTranscriptProvider(input.sourceProvider, 'sourceProvider');
  assertIdentifier(input.utteranceId, 'utteranceId');
  assertProviderEventId(input.providerEventId, 'providerEventId');
  assertIdentifier(input.segmentId, 'segmentId');
  assertPartialTranscriptText(input.text);
  assertTimestamp(input.observedAt, 'observedAt');
  if (!Number.isInteger(input.revision) || input.revision < 0) {
    throw new TranscriptDomainError(
      'invalid_revision',
      'A partial transcript revision must be a non-negative integer',
    );
  }
}

function validateFinalParticipantInput(
  input: FinalParticipantSegmentInput,
  aggregateGuideId: string,
  guideIndex: InternalGuideQuestionIndex,
): void {
  assertTranscriptProvider(input.sourceProvider, 'sourceProvider');
  assertIdentifier(input.utteranceId, 'utteranceId');
  assertProviderEventId(input.providerEventId, 'providerEventId');
  assertIdentifier(input.segmentId, 'segmentId');
  assertIdentifier(input.turnId, 'turnId');
  assertText(input.text, 'final participant text', TRANSCRIPT_TEXT_MAX_LENGTH);
  assertTimestamp(input.occurredAt, 'occurredAt');
  assertTimestamp(input.observedAt, 'observedAt');
  assertTimestamp(input.finalizedAt, 'finalizedAt');
  if (
    Date.parse(input.observedAt) < Date.parse(input.occurredAt) ||
    Date.parse(input.finalizedAt) < Date.parse(input.observedAt)
  ) {
    throw new TranscriptDomainError(
      'invalid_timestamp',
      'Participant source timestamps must follow occurredAt <= observedAt <= finalizedAt',
    );
  }
  validateGuideReference(input.guideReference, aggregateGuideId, guideIndex);
}

function validateAiTurnInput(
  input: AppendAiTurnInput,
  aggregateGuideId: string,
  guideIndex: InternalGuideQuestionIndex,
): void {
  assertIdentifier(input.turnId, 'turnId');
  assertProviderEventId(input.deliveryEventId, 'deliveryEventId');
  assertText(input.spokenText, 'spokenText', TRANSCRIPT_TEXT_MAX_LENGTH);
  assertTimestamp(input.occurredAt, 'occurredAt');
  validateGuideReference(input.guideReference, aggregateGuideId, guideIndex);
  validateAiDelivery(input.delivery, input.occurredAt);
}

function validateGapInput(input: RecordTechnicalGapInput): void {
  assertIdentifier(input.gapId, 'gapId');
  assertIdentifier(input.sourceEventId, 'sourceEventId');
  assertText(input.description, 'technical gap description', TECHNICAL_GAP_DESCRIPTION_MAX_LENGTH);
  assertTimestamp(input.occurredAt, 'occurredAt');
  if (input.source === 'speech_to_text') {
    assertTranscriptProvider(input.sourceProvider, 'sourceProvider');
    assertIdentifier(input.relatedUtteranceId, 'relatedUtteranceId');
  }
  if (input.relatedSegmentId !== null) {
    assertIdentifier(input.relatedSegmentId, 'relatedSegmentId');
  }
}

function matchesSpeechSourceIdentity(
  gap: TranscriptTechnicalGap,
  provider: string,
  utteranceId: string,
  segmentId: string | null,
): boolean {
  return (
    gap.source === 'speech_to_text' &&
    gap.sourceProvider === provider &&
    (gap.relatedUtteranceId === utteranceId ||
      (segmentId !== null && gap.relatedSegmentId === segmentId))
  );
}
