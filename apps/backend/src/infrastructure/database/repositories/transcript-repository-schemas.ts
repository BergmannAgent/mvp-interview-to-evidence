import {
  followUpQuestionReferenceSchema,
  guideQuestionReferenceSchema,
  idSchema,
  mainQuestionReferenceSchema,
  mvpRealtimePlanningMetadataSchema,
  partialTranscriptSegmentSchema,
  providerEventIdSchema,
  timestampSchema,
  transcriptTextSchema,
  transcriptProviderSchema,
} from '@orgscience/contracts';
import { z } from 'zod';

export const timestampColumnSchema = z.union([
  z.iso.datetime({ offset: true }),
  z.date().transform((value) => value.toISOString()),
]);

export const timestampInputSchema = timestampSchema;

const nullableTimestampColumnSchema = timestampColumnSchema.nullable();

export const aggregateHeaderRowSchema = z.object({
  interviewId: z.string().min(1),
  guideId: z.string().min(1),
  nextSequenceNumber: z.number().int().positive(),
});

export const transcriptWriteGuardRowSchema = z.object({
  interviewId: z.string().min(1),
  status: z.enum(['ready', 'active', 'paused', 'ending', 'completed', 'failed']),
  nextSequenceNumber: z.number().int().positive(),
  isFinalized: z.boolean(),
  pendingDeliveryId: z.string().min(1).nullable(),
  pendingReservedSequenceNumber: z.number().int().positive().nullable(),
  lastSequenceNumber: z.number().int().positive().nullable(),
  lastOccurredAt: nullableTimestampColumnSchema,
});

export const transcriptMutationVersionRowSchema = z.object({
  transcriptMutationVersion: z.number().int().nonnegative(),
});

export const guideQuestionRowSchema = z.object({
  guideId: z.string().min(1),
  questionId: z.string().min(1),
  sectionId: z.string().min(1),
  kind: z.enum(['main_question', 'follow_up_question']),
  mainQuestionId: z.string().min(1),
});

export const entryRowSchema = z.object({
  interviewId: z.string().min(1),
  sequenceNumber: z.number().int().positive(),
  entryId: z.string().min(1),
  kind: z.enum(['turn', 'technical_gap']),
  occurredAt: timestampColumnSchema,
  speaker: z.enum(['ai_interviewer', 'participant']).nullable(),
  turnType: z
    .enum([
      'greeting',
      'main_question',
      'follow_up_question',
      'clarification_question',
      'participant_answer',
      'transition',
      'closing',
    ])
    .nullable(),
  text: z.string().nullable(),
  guideId: z.string().nullable(),
  questionId: z.string().nullable(),
  sourceProvider: transcriptProviderSchema.nullable(),
  providerEventId: providerEventIdSchema.nullable(),
  sourceSegmentId: idSchema.nullable(),
  deliveryEventId: providerEventIdSchema.nullable(),
  deliveryStatus: z.enum(['complete', 'interrupted']).nullable(),
  interruptedAt: nullableTimestampColumnSchema,
  questionKind: z.enum(['main_question', 'follow_up_question']).nullable(),
  questionSectionId: z.string().nullable(),
  questionMainQuestionId: z.string().nullable(),
  gapSource: z.enum(['speech_to_text', 'audio_output', 'transport']).nullable(),
  gapProvider: z.string().nullable(),
  gapDescription: z.string().nullable(),
  relatedSegmentId: z.string().nullable(),
  relatedUtteranceId: z.string().nullable(),
  sourceEventId: z.string().nullable(),
});

export const finalRowSchema = z.object({
  interviewId: idSchema,
  sourceProvider: transcriptProviderSchema,
  utteranceId: idSchema,
  providerEventId: providerEventIdSchema,
  segmentId: idSchema,
  turnId: idSchema,
  text: transcriptTextSchema,
  observedAt: timestampColumnSchema,
  finalizedAt: timestampColumnSchema,
});

export const segmentResolutionRowSchema = z.object({
  providerEventFinalSegmentId: z.string().min(1).nullable(),
  isFinalized: z.boolean(),
  hasGap: z.boolean(),
});

export const partialInputSchema = partialTranscriptSegmentSchema
  .omit({ provider: true, speaker: true, status: true })
  .extend({ sourceProvider: transcriptProviderSchema });

export const partialRowSchema = partialInputSchema.extend({
  observedAt: timestampColumnSchema,
});

export const speechRecognitionSourceSchema = z.object({
  provider: transcriptProviderSchema,
  utteranceId: idSchema,
});

export const storedPartialRowSchema = partialRowSchema.extend({
  provider: transcriptProviderSchema,
  utteranceId: idSchema,
  disposition: z.enum(['accepted', 'updated', 'ignored_stale', 'ignored_finalized']),
});

export const storedFinalSourceRowSchema = z.object({
  provider: z.string().min(1),
  utteranceId: z.string().min(1),
});

export const finalIdentityRowSchema = z.object({
  provider: transcriptProviderSchema,
  utteranceId: idSchema,
  providerEventId: providerEventIdSchema,
  segmentId: idSchema,
  turnId: idSchema,
});

export const gapIdentityRowSchema = z.object({
  gapId: z.string().min(1),
  provider: z.string().min(1).nullable(),
  source: z.enum(['speech_to_text', 'audio_output', 'transport']),
  description: z.string().min(1),
  relatedSegmentId: z.string().min(1).nullable(),
  relatedUtteranceId: z.string().min(1).nullable(),
  sourceEventId: z.string().min(1),
  sequenceNumber: z.number().int().positive(),
  occurredAt: timestampColumnSchema,
});

export const gappedSourceIdentityRowSchema = z.object({
  gapId: z.string().min(1),
});

export const finalizedSourceIdentityRowSchema = z.object({
  turnId: z.string().min(1),
});

export const storedAiDeliveryRowSchema = z.object({
  interviewId: idSchema,
  deliveryId: idSchema,
  jobId: idSchema,
  workflowRunId: idSchema,
  turnId: idSchema,
  utteranceId: idSchema,
  reservedSequenceNumber: z.number().int().positive(),
  turnType: z.enum([
    'greeting',
    'main_question',
    'follow_up_question',
    'clarification_question',
    'transition',
    'closing',
  ]),
  guideId: idSchema.nullable(),
  questionId: idSchema.nullable(),
  questionKind: z.enum(['main_question', 'follow_up_question']).nullable(),
  questionSectionId: idSchema.nullable(),
  questionMainQuestionId: idSchema.nullable(),
  proposedText: transcriptTextSchema,
  planningMetadata: mvpRealtimePlanningMetadataSchema.nullable().optional(),
  status: z.enum(['pending', 'complete', 'interrupted', 'gapped', 'cancelled']),
  provider: transcriptProviderSchema.nullable(),
  providerDeliveryEventId: providerEventIdSchema.nullable(),
  confirmedSpokenText: transcriptTextSchema.nullable(),
  createdAt: timestampColumnSchema,
  resolvedAt: nullableTimestampColumnSchema,
  interruptedAt: nullableTimestampColumnSchema,
});

export const aiDeliveryReservationInputSchema = z.object({
  deliveryId: idSchema,
  jobId: idSchema,
  workflowRunId: idSchema,
  turnId: idSchema,
  utteranceId: idSchema,
  turnType: z.enum([
    'greeting',
    'main_question',
    'follow_up_question',
    'clarification_question',
    'transition',
    'closing',
  ]),
  guideReference: guideQuestionReferenceSchema.nullable(),
  proposedText: transcriptTextSchema,
  planningMetadata: mvpRealtimePlanningMetadataSchema.nullable().optional(),
  createdAt: timestampInputSchema,
});

export const sequenceRowSchema = z.object({ allocatedSequence: z.number().int().positive() });
export const currentSequenceRowSchema = z.object({
  nextSequenceNumber: z.number().int().positive(),
});

export const finalInputSchema = z.object({
  interviewId: idSchema,
  sourceProvider: transcriptProviderSchema,
  utteranceId: idSchema,
  providerEventId: providerEventIdSchema,
  segmentId: idSchema,
  turnId: idSchema,
  text: transcriptTextSchema,
  occurredAt: timestampInputSchema,
  observedAt: timestampInputSchema,
  finalizedAt: timestampInputSchema,
  guideReference: z.union([mainQuestionReferenceSchema, followUpQuestionReferenceSchema, z.null()]),
});
