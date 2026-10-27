import {
  TranscriptDomainError,
  type AiTranscriptTurn,
  type AiTurnDelivery,
  type AppendAiTurnInput,
  type CanonicalTranscriptEntry,
  type FinalizedParticipantSegment,
  type FinalParticipantSegmentInput,
  type ParticipantTranscriptTurn,
  type PartialSegmentInput,
  type PartialTranscriptSegment,
  type QuestionTurnType,
  type RecordTechnicalGapInput,
  type TranscriptAggregate,
  type TranscriptInvariantIssue,
  type TranscriptInvariantIssueCode,
  type TranscriptSpeaker,
  type TranscriptTechnicalGap,
  type TranscriptTurn,
  type TranscriptTurnType,
} from './model.js';
import { sameGuideReference } from './references.js';

type AiQuestionTranscriptTurn = Extract<AiTranscriptTurn, { readonly turnType: QuestionTurnType }>;

const INTERNAL_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

function hasAtMostCodePoints(value: string, maximum: number): boolean {
  let count = 0;
  const iterator = value[Symbol.iterator]();
  for (let next = iterator.next(); !next.done; next = iterator.next()) {
    count += 1;
    if (count > maximum) return false;
  }
  return true;
}

export const TRANSCRIPT_TEXT_MAX_LENGTH = 20_000;
export const TECHNICAL_GAP_DESCRIPTION_MAX_LENGTH = 1_000;

export function isValidSpeakerTurnType(
  speaker: TranscriptSpeaker,
  turnType: TranscriptTurnType,
): boolean {
  return speaker === 'participant'
    ? turnType === 'participant_answer'
    : turnType !== 'participant_answer';
}

export function assertInterviewRouting(aggregate: TranscriptAggregate, interviewId: string): void {
  assertIdentifier(interviewId, 'interviewId');
  if (interviewId !== aggregate.interviewId) {
    throw new TranscriptDomainError(
      'interview_mismatch',
      `Input for interview ${interviewId} cannot be routed to ${aggregate.interviewId}`,
    );
  }
}

export function assertUniqueEntryId(aggregate: TranscriptAggregate, entryId: string): void {
  if (aggregate.entries.some((entry) => getEntryId(entry) === entryId)) {
    throw new TranscriptDomainError(
      'duplicate_entry_id',
      `Canonical transcript entry ${entryId} already exists`,
    );
  }
}

export function assertAppendTimestamp(aggregate: TranscriptAggregate, timestamp: string): void {
  const previous = aggregate.entries.at(-1);
  if (previous !== undefined && Date.parse(timestamp) < Date.parse(previous.occurredAt)) {
    throw new TranscriptDomainError(
      'timestamp_regression',
      'A canonical transcript entry cannot predate the previous server sequence',
    );
  }
}

export function assertIdentifier(value: string, field: string): void {
  if (value.length > 128 || !INTERNAL_IDENTIFIER_PATTERN.test(value)) {
    throw new TranscriptDomainError(
      'invalid_identifier',
      `${field} must be a bounded opaque identifier without whitespace`,
    );
  }
}

export function assertTranscriptProvider(value: string, field: string): void {
  if (!isNonBlank(value) || !hasAtMostCodePoints(value, 100) || value !== value.trim()) {
    throw new TranscriptDomainError(
      'invalid_identifier',
      `${field} must be a bounded provider identifier without boundary whitespace`,
    );
  }
}

export function assertProviderEventId(value: string, field: string): void {
  if (!isNonBlank(value) || !hasAtMostCodePoints(value, 300) || value !== value.trim()) {
    throw new TranscriptDomainError(
      'invalid_identifier',
      `${field} must be a bounded opaque provider event identifier`,
    );
  }
}

export function assertPartialTranscriptText(value: string): void {
  if (!hasAtMostCodePoints(value, TRANSCRIPT_TEXT_MAX_LENGTH)) {
    throw new TranscriptDomainError(
      'invalid_text',
      `partial segment text must contain at most ${TRANSCRIPT_TEXT_MAX_LENGTH} characters`,
    );
  }
}

export function assertText(value: string, field: string, maxLength: number): void {
  if (!isValidBoundedText(value, maxLength)) {
    throw new TranscriptDomainError(
      'invalid_text',
      `${field} must be non-blank and contain at most ${maxLength} characters`,
    );
  }
}

export function isValidBoundedText(value: string, maxLength: number): boolean {
  return isNonBlank(value) && hasAtMostCodePoints(value, maxLength);
}

export function assertTimestamp(value: string, field: string): void {
  if (!isNonBlank(value) || !Number.isFinite(Date.parse(value))) {
    throw new TranscriptDomainError('invalid_timestamp', `${field} must be a valid timestamp`);
  }
}

export function validateAiDelivery(delivery: AiTurnDelivery, occurredAt: string): void {
  if (delivery.status === 'interrupted') {
    assertTimestamp(delivery.interruptedAt, 'interruptedAt');
    if (Date.parse(delivery.interruptedAt) < Date.parse(occurredAt)) {
      throw new TranscriptDomainError(
        'invalid_delivery',
        'An AI turn cannot be interrupted before it starts',
      );
    }
  }
}

export function samePartialSegment(
  left: PartialTranscriptSegment,
  right: PartialSegmentInput,
): boolean {
  return (
    left.interviewId === right.interviewId &&
    left.sourceProvider === right.sourceProvider &&
    left.utteranceId === right.utteranceId &&
    left.providerEventId === right.providerEventId &&
    left.segmentId === right.segmentId &&
    left.text === right.text &&
    left.revision === right.revision &&
    sameTimestamp(left.observedAt, right.observedAt)
  );
}

export function sameFinalUtterance(
  left: FinalizedParticipantSegment,
  right: FinalizedParticipantSegment | FinalParticipantSegmentInput,
): boolean {
  return (
    left.interviewId === right.interviewId &&
    left.sourceProvider === right.sourceProvider &&
    left.utteranceId === right.utteranceId &&
    left.text === right.text &&
    sameTimestamp(left.occurredAt, right.occurredAt) &&
    sameTimestamp(left.observedAt, right.observedAt) &&
    sameTimestamp(left.finalizedAt, right.finalizedAt) &&
    sameGuideReference(left.guideReference, right.guideReference)
  );
}

export function sameFinalSegment(
  left: FinalizedParticipantSegment,
  right: FinalizedParticipantSegment | FinalParticipantSegmentInput,
): boolean {
  return (
    sameFinalUtterance(left, right) &&
    left.providerEventId === right.providerEventId &&
    left.segmentId === right.segmentId &&
    left.turnId === right.turnId
  );
}

export function sameAiTurn(turn: AiTranscriptTurn, input: AppendAiTurnInput): boolean {
  return (
    turn.interviewId === input.interviewId &&
    turn.turnId === input.turnId &&
    turn.deliveryEventId === input.deliveryEventId &&
    turn.turnType === input.turnType &&
    turn.text === input.spokenText &&
    sameTimestamp(turn.occurredAt, input.occurredAt) &&
    sameGuideReference(turn.guideReference, input.guideReference) &&
    sameAiDelivery(turn.delivery, input.delivery)
  );
}

export function sameTechnicalGap(
  gap: TranscriptTechnicalGap,
  input: RecordTechnicalGapInput,
): boolean {
  return (
    gap.interviewId === input.interviewId &&
    gap.gapId === input.gapId &&
    gap.sourceProvider === input.sourceProvider &&
    gap.sourceEventId === input.sourceEventId &&
    gap.source === input.source &&
    gap.description === input.description &&
    sameTimestamp(gap.occurredAt, input.occurredAt) &&
    gap.relatedSegmentId === input.relatedSegmentId &&
    gap.relatedUtteranceId === input.relatedUtteranceId
  );
}

export function aiInputToTurn(input: AppendAiTurnInput, sequenceNumber: number): AiTranscriptTurn {
  return {
    kind: 'turn',
    interviewId: input.interviewId,
    sequenceNumber,
    turnId: input.turnId,
    deliveryEventId: input.deliveryEventId,
    speaker: 'ai_interviewer',
    turnType: input.turnType,
    text: input.spokenText,
    occurredAt: input.occurredAt,
    guideReference: input.guideReference,
    delivery: input.delivery,
  } as AiTranscriptTurn;
}

export function findParticipantProviderEvent(
  aggregate: TranscriptAggregate,
  sourceProvider: string,
  providerEventId: string,
):
  | { readonly kind: 'partial'; readonly segment: PartialTranscriptSegment }
  | { readonly kind: 'final'; readonly segment: FinalizedParticipantSegment }
  | undefined {
  const partial = aggregate.partials.find(
    (segment) =>
      segment.sourceProvider === sourceProvider && segment.providerEventId === providerEventId,
  );
  if (partial !== undefined) {
    return { kind: 'partial', segment: partial };
  }
  const final = aggregate.finals.find(
    (segment) =>
      segment.sourceProvider === sourceProvider && segment.providerEventId === providerEventId,
  );
  return final === undefined ? undefined : { kind: 'final', segment: final };
}

export function finalSegmentMatchesTurn(
  final: FinalizedParticipantSegment,
  turn: ParticipantTranscriptTurn,
): boolean {
  return (
    final.interviewId === turn.interviewId &&
    final.sourceProvider === turn.sourceProvider &&
    final.providerEventId === turn.providerEventId &&
    final.segmentId === turn.sourceSegmentId &&
    final.turnId === turn.turnId &&
    final.text === turn.text &&
    sameTimestamp(final.occurredAt, turn.occurredAt) &&
    sameGuideReference(final.guideReference, turn.guideReference)
  );
}

export function getEntryId(entry: CanonicalTranscriptEntry): string {
  return entry.kind === 'turn' ? entry.turnId : entry.gapId;
}

export function isQuestionTurn(turn: TranscriptTurn): turn is AiQuestionTranscriptTurn {
  return (
    turn.speaker === 'ai_interviewer' &&
    (turn.turnType === 'main_question' ||
      turn.turnType === 'follow_up_question' ||
      turn.turnType === 'clarification_question')
  );
}

export function addIssue(
  issues: TranscriptInvariantIssue[],
  code: TranscriptInvariantIssueCode,
  message: string,
  entryId: string | null,
): void {
  issues.push({ code, message, entryId });
}

function sameAiDelivery(left: AiTurnDelivery, right: AiTurnDelivery): boolean {
  return (
    left.status === right.status &&
    (left.status === 'complete' ||
      (right.status === 'interrupted' && sameTimestamp(left.interruptedAt, right.interruptedAt)))
  );
}

export function sameTimestamp(left: string, right: string): boolean {
  return Date.parse(left) === Date.parse(right);
}

function isNonBlank(value: string): boolean {
  return value.trim().length > 0;
}
