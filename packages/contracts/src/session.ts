import { z } from 'zod';

import { guideQuestionReferenceSchema } from './guide.js';
import { DEFAULT_LOCALE, supportedLocaleSchema } from './locale.js';
import { idSchema, nonBlankTextSchema, timestampSchema } from './primitives.js';
import { transcriptSpeakerSchema, transcriptTurnTypeSchema } from './transcript.js';

export const mvpRealtimeContextUpdateSchema = z.strictObject({
  revision: idSchema,
  instructions: nonBlankTextSchema.max(500_000),
  removeConversationItemIds: z.array(nonBlankTextSchema.max(300)).max(2_000),
});

export const mvpSessionStatusSchema = z.enum(['ready', 'active', 'paused', 'completed']);

export const mvpTranscriptTurnSchema = z.strictObject({
  turnId: idSchema,
  interviewId: idSchema,
  sequenceNumber: z.number().int().positive(),
  speaker: transcriptSpeakerSchema,
  turnType: transcriptTurnTypeSchema,
  text: nonBlankTextSchema.max(20_000),
  occurredAt: timestampSchema,
  guideReference: guideQuestionReferenceSchema.nullable(),
  interrupted: z.boolean().default(false),
});

export const mvpTranscriptGapSchema = z.strictObject({
  gapId: idSchema,
  interviewId: idSchema,
  sequenceNumber: z.number().int().positive(),
  source: z.enum(['speech_to_text', 'audio_output', 'transport']),
  description: nonBlankTextSchema.max(1_000),
  occurredAt: timestampSchema,
});

export const mvpCurrentQuestionSchema = z.strictObject({
  questionId: idSchema,
  sectionId: idSchema,
  sectionTitle: nonBlankTextSchema.max(300),
  kind: z.enum(['main', 'follow_up']),
  text: nonBlankTextSchema.max(2_000),
  reference: guideQuestionReferenceSchema,
});

export const mvpInterviewSessionSchema = z.strictObject({
  interviewId: idSchema,
  guideId: idSchema,
  language: supportedLocaleSchema.default(DEFAULT_LOCALE),
  guideTitle: nonBlankTextSchema.max(300),
  status: mvpSessionStatusSchema,
  stateVersion: z.number().int().nonnegative().default(0),
  currentQuestionIndex: z.number().int().nonnegative(),
  totalQuestions: z.number().int().positive(),
  currentQuestion: mvpCurrentQuestionSchema.nullable(),
  startedAt: timestampSchema.nullable(),
  endedAt: timestampSchema.nullable(),
  updatedAt: timestampSchema,
  partialTranscript: nonBlankTextSchema.max(20_000).nullable(),
  transcript: z.array(mvpTranscriptTurnSchema),
  technicalGaps: z.array(mvpTranscriptGapSchema).default([]),
  finalizedAt: timestampSchema.nullable().default(null),
});

export const mvpSessionCommandResponseSchema = z.strictObject({
  session: mvpInterviewSessionSchema,
  newAiTurns: z.array(mvpTranscriptTurnSchema),
});

export const mvpParticipantTurnRequestSchema = z.strictObject({
  clientEventId: idSchema,
  text: nonBlankTextSchema.max(20_000),
  occurredAt: timestampSchema.optional(),
  sourceProvider: z.enum(['text_input', 'openai_realtime']),
});

export const mvpPartialTranscriptRequestSchema = z.strictObject({
  text: nonBlankTextSchema.max(20_000).nullable(),
  itemId: idSchema.optional(),
  providerEventId: idSchema.optional(),
  revision: z.number().int().positive().optional(),
});

export const voiceSessionRequestSchema = z.strictObject({
  language: supportedLocaleSchema.optional(),
});

export const voiceSessionResponseSchema = z.strictObject({
  clientSecret: nonBlankTextSchema,
  expiresAt: z.number().int().positive(),
  sessionId: nonBlankTextSchema,
  model: nonBlankTextSchema,
});

export const mvpRealtimeAiTurnRequestSchema = z.strictObject({
  deliveryId: idSchema,
  clientEventId: idSchema,
  text: nonBlankTextSchema.max(20_000),
  occurredAt: timestampSchema.optional(),
  turnType: z.enum([
    'greeting',
    'main_question',
    'follow_up_question',
    'clarification_question',
    'transition',
    'closing',
  ]),
  questionId: idSchema.nullable().optional(),
});

export const mvpRealtimeInterruptedAiTurnRequestSchema = z.strictObject({
  deliveryId: idSchema,
  clientEventId: idSchema,
  generatedText: z.string().max(20_000),
  confirmedSpokenText: z.string().max(20_000),
  occurredAt: timestampSchema.optional(),
});

export const mvpRealtimeGapRequestSchema = z.strictObject({
  sourceEventId: idSchema,
  source: z.enum(['speech_to_text', 'transport']),
  description: nonBlankTextSchema.max(1_000),
  occurredAt: timestampSchema.optional(),
  itemId: idSchema.nullable().optional(),
});

export const mvpRealtimeAnswerDispositionSchema = z.enum([
  'answered',
  'partial',
  'off_topic',
  'question_misunderstood',
  'dont_know',
  'declined',
  'not_applicable',
  'already_answered',
]);

export const mvpRealtimeRequestedEvidenceTypeSchema = z.enum([
  'example',
  'responsibility',
  'actor',
  'action',
  'sequence',
  'outcome',
  'timeframe',
  'contradiction',
]);

export const mvpRealtimePlanningMetadataSchema = z.strictObject({
  purpose: z.enum(['clarification', 'repeat']),
  sourceParticipantTurnId: idSchema,
  answerDisposition: mvpRealtimeAnswerDispositionSchema,
  missingAspect: nonBlankTextSchema.max(300).nullable(),
  requestedEvidenceType: mvpRealtimeRequestedEvidenceTypeSchema.nullable(),
});

export const mvpRealtimeTurnIntentRequestSchema = z
  .strictObject({
    clientEventId: idSchema,
    action: z.enum([
      'ask_main_question',
      'ask_follow_up_question',
      'ask_clarification_question',
      'repeat_question',
      'complete_interview',
    ]),
    questionId: idSchema.nullable(),
    spokenText: nonBlankTextSchema.max(600),
    answerDisposition: mvpRealtimeAnswerDispositionSchema,
    missingAspect: nonBlankTextSchema.max(300).nullable(),
    requestedEvidenceType: mvpRealtimeRequestedEvidenceTypeSchema.nullable(),
    repairAttempt: z.number().int().min(0).max(1).optional(),
  })
  .superRefine((intent, context) => {
    const questionMarkCount = (intent.spokenText.match(/\?/g) ?? []).length;
    if (intent.action === 'complete_interview') {
      if (intent.questionId !== null) {
        context.addIssue({
          code: 'custom',
          message: 'A completion intent must not reference a guide question',
          path: ['questionId'],
        });
      }
      if (questionMarkCount > 0) {
        context.addIssue({
          code: 'custom',
          message: 'A completion intent must not contain a question',
          path: ['spokenText'],
        });
      }
      if (intent.spokenText.includes('\n') || intent.spokenText.includes('\r')) {
        context.addIssue({
          code: 'custom',
          message: 'A completion intent must be a single-line utterance',
          path: ['spokenText'],
        });
      }
      if (intent.missingAspect !== null || intent.requestedEvidenceType !== null) {
        context.addIssue({
          code: 'custom',
          message: 'A completion intent must not contain a clarification objective',
          path: ['missingAspect'],
        });
      }
      return;
    }

    if (intent.questionId === null) {
      context.addIssue({
        code: 'custom',
        message: 'A question intent must reference a guide question',
        path: ['questionId'],
      });
    }
    if (
      intent.spokenText.includes('\n') ||
      intent.spokenText.includes('\r') ||
      questionMarkCount !== 1 ||
      !intent.spokenText.trim().endsWith('?')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'A question intent must contain exactly one single-line question',
        path: ['spokenText'],
      });
    }
    if (intent.action === 'ask_clarification_question') {
      if (
        intent.answerDisposition !== 'partial' &&
        intent.requestedEvidenceType !== 'contradiction'
      ) {
        context.addIssue({
          code: 'custom',
          message: 'A clarification requires a partial answer or a contradiction',
          path: ['answerDisposition'],
        });
      }
      if (intent.missingAspect === null || intent.requestedEvidenceType === null) {
        context.addIssue({
          code: 'custom',
          message: 'A clarification requires one explicit missing aspect and evidence type',
          path: ['missingAspect'],
        });
      }
    } else if (intent.missingAspect !== null || intent.requestedEvidenceType !== null) {
      context.addIssue({
        code: 'custom',
        message: 'Only a clarification intent may contain a clarification objective',
        path: ['missingAspect'],
      });
    }
    if (
      intent.action === 'repeat_question' &&
      intent.answerDisposition !== 'off_topic' &&
      intent.answerDisposition !== 'question_misunderstood'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'A repetition requires an off-topic or misunderstood answer',
        path: ['answerDisposition'],
      });
    }
  });

export const mvpRealtimeTurnRejectionSchema = z.strictObject({
  reason: nonBlankTextSchema.max(600),
});

export const mvpRealtimeTurnPlanSchema = z.strictObject({
  deliveryId: idSchema,
  workflowRunId: idSchema,
  text: nonBlankTextSchema.max(20_000),
  turnType: z.enum([
    'greeting',
    'main_question',
    'follow_up_question',
    'clarification_question',
    'transition',
    'closing',
  ]),
  questionId: idSchema.nullable(),
  guideReference: guideQuestionReferenceSchema.nullable(),
});

export const mvpRealtimeCommandResponseSchema = z.strictObject({
  session: mvpInterviewSessionSchema,
  newAiTurns: z.array(mvpTranscriptTurnSchema).default([]),
  nextAiTurn: mvpRealtimeTurnPlanSchema.nullable(),
  contextUpdate: mvpRealtimeContextUpdateSchema.nullable().optional(),
  rejection: mvpRealtimeTurnRejectionSchema.optional(),
});

export const mvpRealtimeAppendResponseSchema = z.strictObject({
  session: mvpInterviewSessionSchema,
  turn: mvpTranscriptTurnSchema.nullable(),
  inserted: z.boolean(),
  nextAiTurn: mvpRealtimeTurnPlanSchema.nullable(),
});

export const mvpRealtimeCompleteRequestSchema = z.strictObject({
  occurredAt: timestampSchema.optional(),
});

export type MvpInterviewSession = z.infer<typeof mvpInterviewSessionSchema>;
export type MvpSessionCommandResponse = z.infer<typeof mvpSessionCommandResponseSchema>;
export type MvpParticipantTurnRequest = z.infer<typeof mvpParticipantTurnRequestSchema>;
export type MvpPartialTranscriptRequest = z.infer<typeof mvpPartialTranscriptRequestSchema>;
export type MvpRealtimeAiTurnRequest = z.infer<typeof mvpRealtimeAiTurnRequestSchema>;
export type MvpTranscriptTurn = z.infer<typeof mvpTranscriptTurnSchema>;
export type MvpTranscriptGap = z.infer<typeof mvpTranscriptGapSchema>;
export type MvpRealtimeTurnPlan = z.infer<typeof mvpRealtimeTurnPlanSchema>;
export type MvpRealtimeCommandResponse = z.infer<typeof mvpRealtimeCommandResponseSchema>;
export type MvpRealtimeContextUpdate = z.infer<typeof mvpRealtimeContextUpdateSchema>;
export type MvpRealtimeAppendResponse = z.infer<typeof mvpRealtimeAppendResponseSchema>;
export type MvpRealtimeInterruptedAiTurnRequest = z.infer<
  typeof mvpRealtimeInterruptedAiTurnRequestSchema
>;
export type MvpRealtimeGapRequest = z.infer<typeof mvpRealtimeGapRequestSchema>;
export type MvpRealtimeTurnIntentRequest = z.infer<typeof mvpRealtimeTurnIntentRequestSchema>;
export type MvpRealtimeAnswerDisposition = z.infer<typeof mvpRealtimeAnswerDispositionSchema>;
export type MvpRealtimePlanningMetadata = z.infer<typeof mvpRealtimePlanningMetadataSchema>;
export type MvpRealtimeTurnRejection = z.infer<typeof mvpRealtimeTurnRejectionSchema>;
export type MvpRealtimeRequestedEvidenceType = z.infer<
  typeof mvpRealtimeRequestedEvidenceTypeSchema
>;
