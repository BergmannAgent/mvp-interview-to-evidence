import { z } from 'zod';

import { interviewGuideSchema } from './guide.js';
import {
  interviewDisplayNameSchema,
  interviewStateSchema,
  interviewStatusSchema,
} from './interview.js';
import { DEFAULT_LOCALE, supportedLocaleSchema } from './locale.js';
import { idSchema, nonBlankTextSchema, timestampSchema } from './primitives.js';

const persistenceOutcomeSchema = z.enum(['inserted', 'existing']);

const databaseReadinessSchema = z.strictObject({
  database: z.literal('ready'),
});

const databaseNotReadySchema = z.strictObject({
  database: z.literal('not_ready'),
});

const opaqueCursorSchema = z
  .string()
  .min(1)
  .max(1_024)
  .regex(/^[A-Za-z0-9_-]+$/u, 'Cursor must be an opaque base64url value');

const pageLimitSchema = z
  .union([
    z.number().int(),
    z
      .string()
      .regex(/^[1-9][0-9]{0,2}$/u, 'Limit must be a positive decimal integer')
      .transform(Number),
  ])
  .pipe(z.number().int().min(1).max(100));

export const livenessResponseSchema = z.strictObject({
  status: z.literal('ok'),
  checkedAt: timestampSchema,
});

export const readinessResponseSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ready'),
    checkedAt: timestampSchema,
    checks: databaseReadinessSchema,
  }),
  z.strictObject({
    status: z.literal('not_ready'),
    checkedAt: timestampSchema,
    checks: databaseNotReadySchema,
  }),
]);

export const guideImportResponseSchema = z.strictObject({
  outcome: persistenceOutcomeSchema,
  interviewGuide: interviewGuideSchema,
});

export const guideResponseSchema = z.strictObject({
  interviewGuide: interviewGuideSchema,
});

export const interviewCreateRequestSchema = z.strictObject({
  interviewId: idSchema,
  guideId: idSchema,
  language: supportedLocaleSchema.default(DEFAULT_LOCALE),
});

export const interviewCreateResponseSchema = z.strictObject({
  outcome: persistenceOutcomeSchema,
  interviewState: interviewStateSchema,
});

export const interviewDetailResponseSchema = z.strictObject({
  interviewState: interviewStateSchema,
});

export const interviewSummarySchema = z
  .strictObject({
    interviewId: idSchema,
    guideId: idSchema,
    language: supportedLocaleSchema.default(DEFAULT_LOCALE),
    guideTitle: nonBlankTextSchema.max(300),
    displayName: interviewDisplayNameSchema.nullable().optional(),
    status: interviewStatusSchema,
    currentMainQuestionId: idSchema.nullable(),
    activeWorkflowRunId: idSchema.nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    startedAt: timestampSchema.nullable(),
  })
  .superRefine((summary, context) => {
    if (Date.parse(summary.updatedAt) < Date.parse(summary.createdAt)) {
      context.addIssue({
        code: 'custom',
        message: 'The interview summary update must not predate creation',
        path: ['updatedAt'],
      });
    }
    if (
      summary.startedAt !== null &&
      (Date.parse(summary.startedAt) < Date.parse(summary.createdAt) ||
        Date.parse(summary.startedAt) > Date.parse(summary.updatedAt))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'The interview summary start must fall within its persisted lifetime',
        path: ['startedAt'],
      });
    }
    if (summary.status === 'ready' && summary.startedAt !== null) {
      context.addIssue({
        code: 'custom',
        message: 'A ready interview must not have a start timestamp',
        path: ['startedAt'],
      });
    }
    if (
      ['active', 'paused', 'ending', 'completed'].includes(summary.status) &&
      summary.startedAt === null
    ) {
      context.addIssue({
        code: 'custom',
        message: `A ${summary.status} interview must have a start timestamp`,
        path: ['startedAt'],
      });
    }
  });

export const interviewSummaryPageSchema = z.strictObject({
  interviews: z.array(interviewSummarySchema).max(100),
  nextCursor: opaqueCursorSchema.nullable(),
});

export const interviewResponseSchema = z.strictObject({ interview: interviewSummarySchema });

export const interviewListQuerySchema = z.strictObject({
  after: opaqueCursorSchema.nullable().default(null),
  limit: pageLimitSchema.default(20),
});

export type LivenessResponse = z.infer<typeof livenessResponseSchema>;
export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;
export type GuideImportResponse = z.infer<typeof guideImportResponseSchema>;
export type GuideResponse = z.infer<typeof guideResponseSchema>;
export type InterviewCreateRequest = z.infer<typeof interviewCreateRequestSchema>;
export type InterviewCreateResponse = z.infer<typeof interviewCreateResponseSchema>;
export type InterviewDetailResponse = z.infer<typeof interviewDetailResponseSchema>;
export type InterviewSummary = z.infer<typeof interviewSummarySchema>;
export type InterviewResponse = z.infer<typeof interviewResponseSchema>;
export type InterviewSummaryPage = z.infer<typeof interviewSummaryPageSchema>;
export type InterviewListQuery = z.infer<typeof interviewListQuerySchema>;
