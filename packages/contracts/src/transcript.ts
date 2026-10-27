import { z } from 'zod';

import {
  followUpQuestionReferenceSchema,
  guideQuestionReferenceSchema,
  mainQuestionReferenceSchema,
} from './guide.js';
import {
  hasAtMostCodePoints,
  idSchema,
  nonBlankTextSchema,
  sequenceNumberSchema,
  timestampSchema,
} from './primitives.js';

export const transcriptSpeakerSchema = z.enum(['ai_interviewer', 'participant']);
export const transcriptTurnTypeSchema = z.enum([
  'greeting',
  'main_question',
  'follow_up_question',
  'clarification_question',
  'participant_answer',
  'transition',
  'closing',
]);

export const transcriptProviderSchema = z
  .string()
  .min(1)
  .refine(
    (value) => hasAtMostCodePoints(value, 100),
    'Provider must contain at most 100 Unicode code points',
  )
  .refine((value) => value === value.trim(), 'Provider must not contain boundary whitespace');

export const providerEventIdSchema = z
  .string()
  .min(1)
  .refine(
    (value) => hasAtMostCodePoints(value, 300),
    'Provider event ID must contain at most 300 Unicode code points',
  )
  .refine(
    (value) => value === value.trim(),
    'Provider event ID must not contain boundary whitespace',
  );

export const partialTranscriptTextSchema = z
  .string()
  .refine(
    (value) => hasAtMostCodePoints(value, 20_000),
    'Transcript text must contain at most 20000 Unicode code points',
  );

export const transcriptTextSchema = nonBlankTextSchema.refine(
  (value) => hasAtMostCodePoints(value, 20_000),
  'Transcript text must contain at most 20000 Unicode code points',
);

export const transcriptGapDescriptionSchema = nonBlankTextSchema.refine(
  (value) => hasAtMostCodePoints(value, 1_000),
  'Transcript gap description must contain at most 1000 Unicode code points',
);

const participantTranscriptSegmentBaseShape = {
  segmentId: idSchema,
  interviewId: idSchema,
  provider: transcriptProviderSchema,
  providerEventId: providerEventIdSchema,
  utteranceId: idSchema,
  speaker: z.literal('participant'),
  text: partialTranscriptTextSchema,
  observedAt: timestampSchema,
};

export const partialTranscriptSegmentSchema = z.strictObject({
  ...participantTranscriptSegmentBaseShape,
  status: z.literal('partial'),
  revision: z.number().int().nonnegative(),
});

export const finalTranscriptSegmentSchema = z
  .strictObject({
    ...participantTranscriptSegmentBaseShape,
    status: z.literal('final'),
    text: transcriptTextSchema,
    finalizedAt: timestampSchema,
  })
  .superRefine((segment, context) => {
    if (Date.parse(segment.finalizedAt) < Date.parse(segment.observedAt)) {
      context.addIssue({
        code: 'custom',
        message: 'Finalized transcript time must not precede observation time',
        path: ['finalizedAt'],
      });
    }
  });

export const transcriptSegmentSchema = z.discriminatedUnion('status', [
  partialTranscriptSegmentSchema,
  finalTranscriptSegmentSchema,
]);

export const aiTurnDeliverySchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('complete') }),
  z.strictObject({
    status: z.literal('interrupted'),
    interruptedAt: timestampSchema,
  }),
]);

const canonicalEntryBaseShape = {
  interviewId: idSchema,
  sequenceNumber: sequenceNumberSchema,
  occurredAt: timestampSchema,
};

const canonicalTurnBaseShape = {
  ...canonicalEntryBaseShape,
  kind: z.literal('turn'),
  turnId: idSchema,
  text: transcriptTextSchema,
};

const aiTurnBaseShape = {
  ...canonicalTurnBaseShape,
  deliveryEventId: providerEventIdSchema,
  speaker: z.literal('ai_interviewer'),
  delivery: aiTurnDeliverySchema,
};

const greetingTurnSchema = z.strictObject({
  ...aiTurnBaseShape,
  turnType: z.literal('greeting'),
  guideReference: z.null(),
});

const mainQuestionTurnSchema = z.strictObject({
  ...aiTurnBaseShape,
  turnType: z.literal('main_question'),
  guideReference: mainQuestionReferenceSchema,
});

const followUpQuestionTurnSchema = z.strictObject({
  ...aiTurnBaseShape,
  turnType: z.literal('follow_up_question'),
  guideReference: followUpQuestionReferenceSchema,
});

const clarificationQuestionTurnSchema = z.strictObject({
  ...aiTurnBaseShape,
  turnType: z.literal('clarification_question'),
  guideReference: guideQuestionReferenceSchema,
});

const participantAnswerTurnSchema = z.strictObject({
  ...canonicalTurnBaseShape,
  speaker: z.literal('participant'),
  turnType: z.literal('participant_answer'),
  guideReference: guideQuestionReferenceSchema.nullable(),
  sourceProvider: transcriptProviderSchema,
  providerEventId: providerEventIdSchema,
  sourceSegmentId: idSchema,
});

const transitionTurnSchema = z.strictObject({
  ...aiTurnBaseShape,
  turnType: z.literal('transition'),
  guideReference: guideQuestionReferenceSchema.nullable(),
});

const closingTurnSchema = z.strictObject({
  ...aiTurnBaseShape,
  turnType: z.literal('closing'),
  guideReference: z.null(),
});

export const canonicalTranscriptTurnSchema = z.discriminatedUnion('turnType', [
  greetingTurnSchema,
  mainQuestionTurnSchema,
  followUpQuestionTurnSchema,
  clarificationQuestionTurnSchema,
  participantAnswerTurnSchema,
  transitionTurnSchema,
  closingTurnSchema,
]);

export const technicalGapSourceSchema = z.enum(['speech_to_text', 'audio_output', 'transport']);

const transcriptTechnicalGapBaseShape = {
  ...canonicalEntryBaseShape,
  kind: z.literal('technical_gap'),
  gapId: idSchema,
  description: transcriptGapDescriptionSchema,
  relatedSegmentId: idSchema.nullable(),
  sourceEventId: idSchema,
};

export const transcriptTechnicalGapSchema = z.discriminatedUnion('source', [
  z.strictObject({
    ...transcriptTechnicalGapBaseShape,
    source: z.literal('speech_to_text'),
    sourceProvider: transcriptProviderSchema,
    relatedUtteranceId: idSchema,
  }),
  z.strictObject({
    ...transcriptTechnicalGapBaseShape,
    source: z.literal('audio_output'),
    sourceProvider: z.null(),
    relatedUtteranceId: z.null(),
  }),
  z.strictObject({
    ...transcriptTechnicalGapBaseShape,
    source: z.literal('transport'),
    sourceProvider: z.null(),
    relatedUtteranceId: z.null(),
  }),
]);

export const canonicalTranscriptEntrySchema = z.union([
  canonicalTranscriptTurnSchema,
  transcriptTechnicalGapSchema,
]);

export const canonicalTranscriptSchema = z
  .strictObject({
    interviewId: idSchema,
    guideId: idSchema,
    entries: z.array(canonicalTranscriptEntrySchema),
    finalizedAt: timestampSchema.nullable(),
  })
  .superRefine((transcript, context) => {
    const entryIds = new Set<string>();
    let previousTimestamp: string | null = null;

    for (const [index, entry] of transcript.entries.entries()) {
      if (entry.interviewId !== transcript.interviewId) {
        context.addIssue({
          code: 'custom',
          message: 'A transcript entry belongs to a different interview',
          path: ['entries', index, 'interviewId'],
        });
      }
      if (entry.sequenceNumber !== index + 1) {
        context.addIssue({
          code: 'custom',
          message: `Canonical transcript sequences must be contiguous; expected ${index + 1}`,
          path: ['entries', index, 'sequenceNumber'],
        });
      }

      const entryId = entry.kind === 'turn' ? entry.turnId : entry.gapId;
      if (entryIds.has(entryId)) {
        context.addIssue({
          code: 'custom',
          message: 'Canonical transcript entry IDs must be unique',
          path: ['entries', index, entry.kind === 'turn' ? 'turnId' : 'gapId'],
        });
      }
      entryIds.add(entryId);

      if (
        previousTimestamp !== null &&
        Date.parse(entry.occurredAt) < Date.parse(previousTimestamp)
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Canonical transcript timestamps must not move backwards',
          path: ['entries', index, 'occurredAt'],
        });
      }
      previousTimestamp = entry.occurredAt;

      if (
        entry.kind === 'turn' &&
        entry.guideReference !== null &&
        entry.guideReference.guideId !== transcript.guideId
      ) {
        context.addIssue({
          code: 'custom',
          message: 'A transcript turn references a different guide',
          path: ['entries', index, 'guideReference', 'guideId'],
        });
      }
      if (
        entry.kind === 'turn' &&
        entry.speaker === 'ai_interviewer' &&
        entry.delivery.status === 'interrupted' &&
        Date.parse(entry.delivery.interruptedAt) < Date.parse(entry.occurredAt)
      ) {
        context.addIssue({
          code: 'custom',
          message: 'An AI turn cannot be interrupted before it occurs',
          path: ['entries', index, 'delivery', 'interruptedAt'],
        });
      }
    }

    const lastEntry = transcript.entries.at(-1);
    if (
      transcript.finalizedAt !== null &&
      lastEntry !== undefined &&
      Date.parse(transcript.finalizedAt) < Date.parse(lastEntry.occurredAt)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'A transcript cannot be finalized before its final entry',
        path: ['finalizedAt'],
      });
    }
  });

export type TranscriptSpeaker = z.infer<typeof transcriptSpeakerSchema>;
export type TranscriptTurnType = z.infer<typeof transcriptTurnTypeSchema>;
export type PartialTranscriptSegment = z.infer<typeof partialTranscriptSegmentSchema>;
export type FinalTranscriptSegment = z.infer<typeof finalTranscriptSegmentSchema>;
export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>;
export type AiTurnDelivery = z.infer<typeof aiTurnDeliverySchema>;
export type TechnicalGapSource = z.infer<typeof technicalGapSourceSchema>;
export type TranscriptTechnicalGap = z.infer<typeof transcriptTechnicalGapSchema>;
export type CanonicalTranscriptTurn = z.infer<typeof canonicalTranscriptTurnSchema>;
export type CanonicalTranscriptEntry = z.infer<typeof canonicalTranscriptEntrySchema>;
export type CanonicalTranscript = z.infer<typeof canonicalTranscriptSchema>;
