import { z } from 'zod';

import { mainQuestionReferenceSchema, questionCoverageSchema } from './guide.js';
import { DEFAULT_LOCALE, supportedLocaleSchema } from './locale.js';
import { idSchema, nonBlankTextSchema, timestampSchema } from './primitives.js';

export const INTERVIEW_DISPLAY_NAME_MAX_LENGTH = 200;
export const interviewDisplayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(INTERVIEW_DISPLAY_NAME_MAX_LENGTH);
export const interviewRenameRequestSchema = z.strictObject({
  displayName: interviewDisplayNameSchema.nullable(),
});
export type InterviewRenameRequest = z.infer<typeof interviewRenameRequestSchema>;

export const interviewStatusSchema = z.enum([
  'ready',
  'active',
  'paused',
  'ending',
  'completed',
  'failed',
]);

export const interviewFailureSchema = z.strictObject({
  code: nonBlankTextSchema.max(100),
  message: nonBlankTextSchema.max(1_000),
});

const readyLifecycleSchema = z.strictObject({ status: z.literal('ready') });

const activeLifecycleSchema = z
  .strictObject({
    status: z.literal('active'),
    startedAt: timestampSchema,
    activeSince: timestampSchema,
  })
  .superRefine((state, context) => {
    addTimestampOrderIssue(state.startedAt, state.activeSince, ['activeSince'], context);
  });

const pausedLifecycleSchema = z
  .strictObject({
    status: z.literal('paused'),
    startedAt: timestampSchema,
    pausedAt: timestampSchema,
  })
  .superRefine((state, context) => {
    addTimestampOrderIssue(state.startedAt, state.pausedAt, ['pausedAt'], context);
  });

const endingLifecycleSchema = z
  .strictObject({
    status: z.literal('ending'),
    startedAt: timestampSchema,
    endingAt: timestampSchema,
    endingFrom: z.enum(['active', 'paused']),
  })
  .superRefine((state, context) => {
    addTimestampOrderIssue(state.startedAt, state.endingAt, ['endingAt'], context);
  });

const completedLifecycleSchema = z
  .strictObject({
    status: z.literal('completed'),
    startedAt: timestampSchema,
    endingAt: timestampSchema,
    endedAt: timestampSchema,
  })
  .superRefine((state, context) => {
    addTimestampOrderIssue(state.startedAt, state.endingAt, ['endingAt'], context);
    addTimestampOrderIssue(state.endingAt, state.endedAt, ['endedAt'], context);
  });

const failedLifecycleSchema = z
  .strictObject({
    status: z.literal('failed'),
    startedAt: timestampSchema.nullable(),
    failedAt: timestampSchema,
    failedFrom: z.enum(['ready', 'active', 'paused', 'ending']),
    failure: interviewFailureSchema,
  })
  .superRefine((state, context) => {
    if (state.failedFrom === 'ready' && state.startedAt !== null) {
      context.addIssue({
        code: 'custom',
        message: 'An interview that failed from ready must not have a start timestamp',
        path: ['startedAt'],
      });
    }
    if (state.failedFrom !== 'ready' && state.startedAt === null) {
      context.addIssue({
        code: 'custom',
        message: 'An interview that failed after starting requires a start timestamp',
        path: ['startedAt'],
      });
    }
    if (state.startedAt !== null) {
      addTimestampOrderIssue(state.startedAt, state.failedAt, ['failedAt'], context);
    }
  });

export const interviewLifecycleStateSchema = z.discriminatedUnion('status', [
  readyLifecycleSchema,
  activeLifecycleSchema,
  pausedLifecycleSchema,
  endingLifecycleSchema,
  completedLifecycleSchema,
  failedLifecycleSchema,
]);

export const interviewStateSchema = z
  .strictObject({
    interviewId: idSchema,
    guideId: idSchema,
    language: supportedLocaleSchema.default(DEFAULT_LOCALE),
    lifecycle: interviewLifecycleStateSchema,
    currentMainQuestion: mainQuestionReferenceSchema.nullable(),
    coverage: z.array(questionCoverageSchema),
    activeWorkflowRunId: idSchema.nullable(),
    version: z.number().int().nonnegative(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .superRefine((state, context) => {
    addTimestampOrderIssue(state.createdAt, state.updatedAt, ['updatedAt'], context);

    const lifecycleTimestamps = getLifecycleTimestamps(state.lifecycle);
    for (const [field, value] of lifecycleTimestamps) {
      addTimestampOrderIssue(state.createdAt, value, ['lifecycle', field], context);
      addTimestampOrderIssue(value, state.updatedAt, ['updatedAt'], context);
    }

    if (state.currentMainQuestion !== null && state.currentMainQuestion.guideId !== state.guideId) {
      context.addIssue({
        code: 'custom',
        message: 'The current main question must belong to the interview guide',
        path: ['currentMainQuestion', 'guideId'],
      });
    }

    const coverageQuestions = new Set<string>();
    const currentCoverageIndexes: number[] = [];
    for (const [index, coverage] of state.coverage.entries()) {
      if (coverage.question.guideId !== state.guideId) {
        context.addIssue({
          code: 'custom',
          message: 'Coverage must reference the interview guide',
          path: ['coverage', index, 'question', 'guideId'],
        });
      }
      const key = questionReferenceKey(coverage.question);
      if (coverageQuestions.has(key)) {
        context.addIssue({
          code: 'custom',
          message: 'Each guide question may have only one coverage record',
          path: ['coverage', index, 'question'],
        });
      }
      coverageQuestions.add(key);

      const transcriptTurnIds = new Set<string>();
      for (const [turnIndex, turnId] of coverage.transcriptTurnIds.entries()) {
        if (transcriptTurnIds.has(turnId)) {
          context.addIssue({
            code: 'custom',
            message: 'Coverage transcript turn IDs must be unique',
            path: ['coverage', index, 'transcriptTurnIds', turnIndex],
          });
        }
        transcriptTurnIds.add(turnId);
      }

      if (coverage.status === 'current') {
        currentCoverageIndexes.push(index);
      }
    }
    if (currentCoverageIndexes.length > 1) {
      context.addIssue({
        code: 'custom',
        message: 'Only one guide question may be current',
        path: ['coverage'],
      });
    }

    if (state.currentMainQuestion === null) {
      if (currentCoverageIndexes.length > 0) {
        context.addIssue({
          code: 'custom',
          message: 'A current coverage record requires a current main question',
          path: ['currentMainQuestion'],
        });
      }
      return;
    }

    if (currentCoverageIndexes.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'The current main question requires exactly one current coverage record',
        path: ['coverage'],
      });
      return;
    }

    if (currentCoverageIndexes.length === 1) {
      const currentCoverageIndex = currentCoverageIndexes[0];
      if (currentCoverageIndex === undefined) return;
      const currentCoverage = state.coverage[currentCoverageIndex];
      if (
        currentCoverage !== undefined &&
        !belongsToMainQuestion(currentCoverage.question, state.currentMainQuestion)
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Current coverage must belong to the current main question',
          path: ['coverage', currentCoverageIndex, 'question'],
        });
      }
    }
  });

function addTimestampOrderIssue(
  earlier: string,
  later: string,
  path: PropertyKey[],
  context: z.RefinementCtx,
): void {
  if (Date.parse(later) < Date.parse(earlier)) {
    context.addIssue({
      code: 'custom',
      message: 'Lifecycle timestamps must not move backwards',
      path,
    });
  }
}

function getLifecycleTimestamps(
  lifecycle: z.infer<typeof interviewLifecycleStateSchema>,
): readonly (readonly [string, string])[] {
  switch (lifecycle.status) {
    case 'ready':
      return [];
    case 'active':
      return [
        ['startedAt', lifecycle.startedAt],
        ['activeSince', lifecycle.activeSince],
      ];
    case 'paused':
      return [
        ['startedAt', lifecycle.startedAt],
        ['pausedAt', lifecycle.pausedAt],
      ];
    case 'ending':
      return [
        ['startedAt', lifecycle.startedAt],
        ['endingAt', lifecycle.endingAt],
      ];
    case 'completed':
      return [
        ['startedAt', lifecycle.startedAt],
        ['endingAt', lifecycle.endingAt],
        ['endedAt', lifecycle.endedAt],
      ];
    case 'failed':
      return lifecycle.startedAt === null
        ? [['failedAt', lifecycle.failedAt]]
        : [
            ['startedAt', lifecycle.startedAt],
            ['failedAt', lifecycle.failedAt],
          ];
  }
}

function questionReferenceKey(
  reference: z.infer<typeof mainQuestionReferenceSchema> | { readonly kind: string },
): string {
  return JSON.stringify(reference);
}

function belongsToMainQuestion(
  question: z.infer<typeof questionCoverageSchema>['question'],
  mainQuestion: z.infer<typeof mainQuestionReferenceSchema>,
): boolean {
  return (
    question.guideId === mainQuestion.guideId &&
    question.sectionId === mainQuestion.sectionId &&
    question.mainQuestionId === mainQuestion.mainQuestionId
  );
}

export type InterviewStatus = z.infer<typeof interviewStatusSchema>;
export type InterviewFailure = z.infer<typeof interviewFailureSchema>;
export type InterviewLifecycleState = z.infer<typeof interviewLifecycleStateSchema>;
export type InterviewState = z.infer<typeof interviewStateSchema>;
