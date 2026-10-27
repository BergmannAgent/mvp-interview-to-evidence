import {
  canonicalTranscriptEntrySchema,
  followUpQuestionReferenceSchema,
  mainQuestionReferenceSchema,
} from '@orgscience/contracts';
import type {
  CanonicalTranscriptEntry,
  FinalizedParticipantSegment,
  ParticipantTranscriptTurn,
  PartialTranscriptSegment,
  TranscriptGuideQuestionIndexInput,
  TranscriptGuideReference,
} from '@orgscience/domain';
import type { z } from 'zod';

import {
  failure,
  success,
  type RepositoryResult,
  type StoredAiDelivery,
} from '../../../application/persistence/index.js';
import { corruptData } from './repository-errors.js';
import {
  entryRowSchema,
  finalRowSchema,
  guideQuestionRowSchema,
} from './transcript-repository-schemas.js';
import type {
  storedAiDeliveryRowSchema,
  storedPartialRowSchema,
} from './transcript-repository-schemas.js';

export function parseGuideIndex(
  rows: readonly unknown[],
  guideId: string,
  interviewId: string,
): RepositoryResult<TranscriptGuideQuestionIndexInput> {
  const parsed = parseRows(rows, guideQuestionRowSchema, 'transcript', interviewId);
  if (!parsed.ok) {
    return parsed;
  }
  const references: TranscriptGuideReference[] = [];
  const questionIds = new Set<string>();
  const mainQuestions = new Map<string, { readonly sectionId: string }>();
  for (const row of parsed.value) {
    if (row.guideId !== guideId) {
      return failure(
        corruptData('transcript', interviewId, 'Guide question belongs to another guide'),
      );
    }
    const candidate =
      row.kind === 'main_question'
        ? {
            kind: row.kind,
            guideId: row.guideId,
            sectionId: row.sectionId,
            mainQuestionId: row.mainQuestionId,
          }
        : {
            kind: row.kind,
            guideId: row.guideId,
            sectionId: row.sectionId,
            mainQuestionId: row.mainQuestionId,
            followUpQuestionId: row.questionId,
          };
    const reference =
      row.kind === 'main_question'
        ? mainQuestionReferenceSchema.safeParse(candidate)
        : followUpQuestionReferenceSchema.safeParse(candidate);
    if (
      !reference.success ||
      (row.kind === 'main_question' && row.questionId !== row.mainQuestionId) ||
      questionIds.has(row.questionId)
    ) {
      return failure(corruptData('transcript', interviewId, 'Invalid guide question hierarchy'));
    }
    questionIds.add(row.questionId);
    if (row.kind === 'main_question') {
      mainQuestions.set(row.mainQuestionId, { sectionId: row.sectionId });
    }
    references.push(reference.data);
  }
  if (mainQuestions.size === 0) {
    return failure(corruptData('transcript', interviewId, 'Guide index has no main question'));
  }
  for (const reference of references) {
    if (reference.kind !== 'follow_up_question') {
      continue;
    }
    const parent = mainQuestions.get(reference.mainQuestionId);
    if (parent === undefined || parent.sectionId !== reference.sectionId) {
      return failure(corruptData('transcript', interviewId, 'Invalid follow-up parent'));
    }
  }
  return success(references);
}

export function parseEntries(
  rows: readonly unknown[],
  interviewId: string,
  guideId: string,
): RepositoryResult<readonly CanonicalTranscriptEntry[]> {
  const parsedRows = parseRows(rows, entryRowSchema, 'transcript', interviewId);
  if (!parsedRows.ok) {
    return parsedRows;
  }
  const entries: CanonicalTranscriptEntry[] = [];
  for (const row of parsedRows.value) {
    if (row.interviewId !== interviewId) {
      return failure(corruptData('transcript', interviewId, 'Cross-interview transcript row'));
    }
    const candidate = mapEntryRow(row);
    if (!candidate.ok) {
      return failure(corruptData('transcript', row.entryId, candidate.reason));
    }
    const validated = canonicalTranscriptEntrySchema.safeParse(candidate.entry);
    if (!validated.success) {
      return failure(corruptData('transcript', row.entryId, validated.error.message));
    }
    const entry = validated.data as CanonicalTranscriptEntry;
    if (
      entry.kind === 'turn' &&
      entry.guideReference !== null &&
      entry.guideReference.guideId !== guideId
    ) {
      return failure(corruptData('transcript', row.entryId, 'Turn references another guide'));
    }
    entries.push(entry);
  }
  entries.sort((left, right) => left.sequenceNumber - right.sequenceNumber);
  for (let index = 0; index < entries.length; index += 1) {
    if (entries[index]?.sequenceNumber !== index + 1) {
      return failure(
        corruptData('transcript', interviewId, 'Transcript sequences are not contiguous'),
      );
    }
    const previous = entries[index - 1];
    const current = entries[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      Date.parse(current.occurredAt) < Date.parse(previous.occurredAt)
    ) {
      return failure(
        corruptData('transcript', interviewId, 'Transcript timestamps move backwards'),
      );
    }
  }
  return success(entries);
}

function mapEntryRow(
  row: z.infer<typeof entryRowSchema>,
):
  { readonly ok: true; readonly entry: unknown } | { readonly ok: false; readonly reason: string } {
  if (row.kind === 'technical_gap') {
    if (
      row.gapSource === null ||
      row.gapDescription === null ||
      row.sourceEventId === null ||
      (row.gapSource === 'speech_to_text') !== (row.gapProvider !== null)
    ) {
      return { ok: false, reason: 'Technical gap subtype is missing' };
    }
    return {
      ok: true,
      entry: {
        kind: row.kind,
        interviewId: row.interviewId,
        sequenceNumber: row.sequenceNumber,
        gapId: row.entryId,
        sourceProvider: row.gapProvider,
        sourceEventId: row.sourceEventId,
        source: row.gapSource,
        description: row.gapDescription,
        occurredAt: row.occurredAt,
        relatedSegmentId: row.relatedSegmentId,
        relatedUtteranceId: row.relatedUtteranceId,
      },
    };
  }
  if (row.speaker === null || row.turnType === null || row.text === null) {
    return { ok: false, reason: 'Transcript turn subtype is missing' };
  }
  const reference = mapGuideReference(row);
  if (!reference.ok) {
    return reference;
  }
  if (row.speaker === 'participant') {
    if (
      row.turnType !== 'participant_answer' ||
      row.sourceProvider === null ||
      row.providerEventId === null ||
      row.sourceSegmentId === null
    ) {
      return { ok: false, reason: 'Participant turn identity is missing' };
    }
    return {
      ok: true,
      entry: {
        kind: 'turn',
        interviewId: row.interviewId,
        sequenceNumber: row.sequenceNumber,
        turnId: row.entryId,
        sourceProvider: row.sourceProvider,
        providerEventId: row.providerEventId,
        speaker: row.speaker,
        turnType: row.turnType,
        text: row.text,
        occurredAt: row.occurredAt,
        guideReference: reference.value,
        sourceSegmentId: row.sourceSegmentId,
      },
    };
  }
  if (row.sourceProvider !== null || row.deliveryEventId === null || row.deliveryStatus === null) {
    return { ok: false, reason: 'AI turn delivery identity is missing' };
  }
  return {
    ok: true,
    entry: {
      kind: 'turn',
      interviewId: row.interviewId,
      sequenceNumber: row.sequenceNumber,
      turnId: row.entryId,
      deliveryEventId: row.deliveryEventId,
      speaker: row.speaker,
      turnType: row.turnType,
      text: row.text,
      occurredAt: row.occurredAt,
      guideReference: reference.value,
      delivery:
        row.deliveryStatus === 'complete'
          ? { status: 'complete' }
          : { status: 'interrupted', interruptedAt: row.interruptedAt },
    },
  };
}

function mapGuideReference(
  row: z.infer<typeof entryRowSchema>,
):
  | { readonly ok: true; readonly value: TranscriptGuideReference | null }
  | { readonly ok: false; readonly reason: string } {
  if (row.guideId === null && row.questionId === null) {
    return { ok: true, value: null };
  }
  if (
    row.guideId === null ||
    row.questionId === null ||
    row.questionKind === null ||
    row.questionSectionId === null ||
    row.questionMainQuestionId === null
  ) {
    return { ok: false, reason: 'Guide reference join is incomplete' };
  }
  if (row.questionKind === 'main_question' && row.questionId !== row.questionMainQuestionId) {
    return { ok: false, reason: 'Main-question reference identity is inconsistent' };
  }
  const candidate =
    row.questionKind === 'main_question'
      ? {
          kind: row.questionKind,
          guideId: row.guideId,
          sectionId: row.questionSectionId,
          mainQuestionId: row.questionMainQuestionId,
        }
      : {
          kind: row.questionKind,
          guideId: row.guideId,
          sectionId: row.questionSectionId,
          mainQuestionId: row.questionMainQuestionId,
          followUpQuestionId: row.questionId,
        };
  const parsed =
    row.questionKind === 'main_question'
      ? mainQuestionReferenceSchema.safeParse(candidate)
      : followUpQuestionReferenceSchema.safeParse(candidate);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, reason: parsed.error.message };
}

export function toStoredAiDelivery(
  row: z.infer<typeof storedAiDeliveryRowSchema>,
): RepositoryResult<StoredAiDelivery> {
  const reference = mapGuideReferenceParts(row);
  if (!reference.ok) {
    return failure(corruptData('transcript', row.deliveryId, reference.reason));
  }
  if (!referenceMatchesTurnType(row.turnType, reference.value)) {
    return failure(
      corruptData('transcript', row.deliveryId, 'AI delivery guide reference is inconsistent'),
    );
  }
  if (!validDeliveryResolution(row)) {
    return failure(
      corruptData('transcript', row.deliveryId, 'AI delivery resolution metadata is inconsistent'),
    );
  }
  return success({
    interviewId: row.interviewId,
    deliveryId: row.deliveryId,
    jobId: row.jobId,
    workflowRunId: row.workflowRunId,
    turnId: row.turnId,
    utteranceId: row.utteranceId,
    reservedSequenceNumber: row.reservedSequenceNumber,
    turnType: row.turnType,
    guideReference: reference.value,
    proposedText: row.proposedText,
    ...(row.planningMetadata == null ? {} : { planningMetadata: row.planningMetadata }),
    createdAt: row.createdAt,
    status: row.status,
    provider: row.provider,
    providerDeliveryEventId: row.providerDeliveryEventId,
    confirmedSpokenText: row.confirmedSpokenText,
    resolvedAt: row.resolvedAt,
    interruptedAt: row.interruptedAt,
  });
}

export function parseFinals(
  rows: readonly unknown[],
  entries: readonly CanonicalTranscriptEntry[],
  interviewId: string,
): RepositoryResult<readonly FinalizedParticipantSegment[]> {
  const parsed = parseRows(rows, finalRowSchema, 'transcript', interviewId);
  if (!parsed.ok) {
    return parsed;
  }
  const finals: FinalizedParticipantSegment[] = [];
  for (const row of parsed.value) {
    const turn = entries.find(
      (entry): entry is ParticipantTranscriptTurn =>
        entry.kind === 'turn' && entry.speaker === 'participant' && entry.turnId === row.turnId,
    );
    if (
      row.interviewId !== interviewId ||
      turn === undefined ||
      turn.text !== row.text ||
      turn.sourceProvider !== row.sourceProvider ||
      turn.providerEventId !== row.providerEventId ||
      turn.sourceSegmentId !== row.segmentId ||
      Date.parse(row.observedAt) < Date.parse(turn.occurredAt) ||
      Date.parse(row.finalizedAt) < Date.parse(row.observedAt)
    ) {
      return failure(corruptData('transcript', row.turnId, 'Final segment and turn disagree'));
    }
    finals.push({
      interviewId,
      sourceProvider: row.sourceProvider,
      utteranceId: row.utteranceId,
      providerEventId: row.providerEventId,
      segmentId: row.segmentId,
      turnId: row.turnId,
      text: row.text,
      occurredAt: turn.occurredAt,
      observedAt: row.observedAt,
      finalizedAt: row.finalizedAt,
      guideReference: turn.guideReference,
    });
  }
  return success(finals);
}

export function parseRows<Output>(
  rows: readonly unknown[],
  schema: z.ZodType<Output>,
  resource: 'transcript',
  id: string,
): RepositoryResult<readonly Output[]> {
  const values: Output[] = [];
  for (const row of rows) {
    const parsed = schema.safeParse(row);
    if (!parsed.success) {
      return failure(corruptData(resource, id, parsed.error.message));
    }
    values.push(parsed.data);
  }
  return success(values);
}

export function parseSingleRow<Output>(
  rows: readonly unknown[],
  schema: z.ZodType<Output>,
  resource: 'transcript',
  id: string,
): RepositoryResult<Output> {
  if (rows.length === 0) {
    return failure({ code: 'not_found', resource, id });
  }
  const parsed = schema.safeParse(rows[0]);
  return parsed.success
    ? success(parsed.data)
    : failure(corruptData(resource, id, parsed.error.message));
}

export function toPartial(row: z.infer<typeof storedPartialRowSchema>): PartialTranscriptSegment {
  return {
    interviewId: row.interviewId,
    sourceProvider: row.sourceProvider,
    utteranceId: row.utteranceId,
    providerEventId: row.providerEventId,
    segmentId: row.segmentId,
    text: row.text,
    revision: row.revision,
    observedAt: row.observedAt,
  };
}

export function questionId(reference: TranscriptGuideReference | null): string | null {
  return reference === null
    ? null
    : reference.kind === 'main_question'
      ? reference.mainQuestionId
      : reference.followUpQuestionId;
}

export function entryId(entry: CanonicalTranscriptEntry): string {
  return entry.kind === 'turn' ? entry.turnId : entry.gapId;
}

export function referenceMatchesTurnType(
  turnType: StoredAiDelivery['turnType'],
  reference: TranscriptGuideReference | null,
): boolean {
  if (turnType === 'greeting' || turnType === 'closing') return reference === null;
  if (turnType === 'main_question') return reference?.kind === 'main_question';
  if (turnType === 'follow_up_question') return reference?.kind === 'follow_up_question';
  if (turnType === 'clarification_question') return reference !== null;
  return true;
}

function mapGuideReferenceParts(row: {
  readonly guideId: string | null;
  readonly questionId: string | null;
  readonly questionKind: 'main_question' | 'follow_up_question' | null;
  readonly questionSectionId: string | null;
  readonly questionMainQuestionId: string | null;
}):
  | { readonly ok: true; readonly value: TranscriptGuideReference | null }
  | { readonly ok: false; readonly reason: string } {
  if (row.guideId === null && row.questionId === null) return { ok: true, value: null };
  if (
    row.guideId === null ||
    row.questionId === null ||
    row.questionKind === null ||
    row.questionSectionId === null ||
    row.questionMainQuestionId === null
  ) {
    return { ok: false, reason: 'Guide reference join is incomplete' };
  }
  if (row.questionKind === 'main_question' && row.questionId !== row.questionMainQuestionId) {
    return { ok: false, reason: 'Main-question reference identity is inconsistent' };
  }
  const candidate =
    row.questionKind === 'main_question'
      ? {
          kind: row.questionKind,
          guideId: row.guideId,
          sectionId: row.questionSectionId,
          mainQuestionId: row.questionMainQuestionId,
        }
      : {
          kind: row.questionKind,
          guideId: row.guideId,
          sectionId: row.questionSectionId,
          mainQuestionId: row.questionMainQuestionId,
          followUpQuestionId: row.questionId,
        };
  const parsed =
    row.questionKind === 'main_question'
      ? mainQuestionReferenceSchema.safeParse(candidate)
      : followUpQuestionReferenceSchema.safeParse(candidate);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, reason: parsed.error.message };
}

function validDeliveryResolution(row: z.infer<typeof storedAiDeliveryRowSchema>): boolean {
  if (row.resolvedAt !== null && Date.parse(row.resolvedAt) < Date.parse(row.createdAt))
    return false;
  if (row.status === 'pending') {
    return (
      row.provider === null &&
      row.providerDeliveryEventId === null &&
      row.confirmedSpokenText === null &&
      row.resolvedAt === null &&
      row.interruptedAt === null
    );
  }
  if (row.status === 'complete') {
    return (
      row.provider !== null &&
      row.providerDeliveryEventId !== null &&
      row.confirmedSpokenText !== null &&
      row.confirmedSpokenText.trim().length > 0 &&
      row.confirmedSpokenText === row.proposedText &&
      row.resolvedAt !== null &&
      row.interruptedAt === null
    );
  }
  if (row.status === 'interrupted') {
    return (
      row.provider !== null &&
      row.providerDeliveryEventId !== null &&
      row.confirmedSpokenText !== null &&
      row.proposedText.startsWith(row.confirmedSpokenText) &&
      row.resolvedAt !== null &&
      row.interruptedAt !== null &&
      Date.parse(row.interruptedAt) <= Date.parse(row.resolvedAt)
    );
  }
  return (
    row.provider === null &&
    row.providerDeliveryEventId === null &&
    row.confirmedSpokenText === null &&
    row.resolvedAt !== null &&
    row.interruptedAt === null
  );
}
