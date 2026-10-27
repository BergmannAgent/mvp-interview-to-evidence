import { idSchema, interviewDisplayNameSchema, sectionMemorySchema } from '@orgscience/contracts';
import { z } from 'zod';

export const databaseTimestampSchema = z
  .union([z.string(), z.date()])
  .transform((value) => (typeof value === 'string' ? value : value.toISOString()))
  .pipe(z.iso.datetime({ offset: true }));

const nullableTimestampSchema = databaseTimestampSchema.nullable();

export const stateRowSchema = z.strictObject({
  interview_id: idSchema,
  guide_id: idSchema,
  language: z.enum(['de', 'en']).default('de'),
  interview_created_at: databaseTimestampSchema,
  status: z.enum(['ready', 'active', 'paused', 'ending', 'completed', 'failed']),
  state_version: z.number().int().nonnegative(),
  coverage_version: z.number().int().nonnegative(),
  current_main_question_id: idSchema.nullable(),
  active_workflow_run_id: idSchema.nullable(),
  section_memories: z.array(sectionMemorySchema).default([]),
  state_created_at: databaseTimestampSchema,
  updated_at: databaseTimestampSchema,
  started_at: nullableTimestampSchema,
  active_since: nullableTimestampSchema,
  paused_at: nullableTimestampSchema,
  ending_at: nullableTimestampSchema,
  ending_from: z.enum(['active', 'paused']).nullable(),
  ended_at: nullableTimestampSchema,
  failed_at: nullableTimestampSchema,
  failed_from: z.enum(['ready', 'active', 'paused', 'ending']).nullable(),
  failure_code: z.string().min(1).nullable(),
  failure_message: z.string().min(1).nullable(),
});

export const coverageRowSchema = z.strictObject({
  interview_id: idSchema,
  guide_id: idSchema,
  question_id: idSchema,
  question_kind: z.enum(['main_question', 'follow_up_question']),
  main_question_id: idSchema,
  section_position: z.number().int().nonnegative(),
  main_position: z.number().int().nonnegative(),
  question_position: z.number().int().nonnegative(),
  coverage_status: z
    .enum([
      'not_addressed',
      'current',
      'partially_answered',
      'answered',
      'skipped_already_answered',
    ])
    .nullable(),
  coverage_updated_at: nullableTimestampSchema,
  referenced_turn_id: idSchema.nullable(),
});

export const guideQuestionShapeRowSchema = z.strictObject({
  guide_id: idSchema,
  question_id: idSchema,
  question_kind: z.enum(['main_question', 'follow_up_question']),
  main_question_id: idSchema,
});

export const identityRowSchema = z.strictObject({ interview_id: idSchema });
export const counterRowSchema = z.strictObject({ interview_id: idSchema });
export const coverageIdentityRowSchema = z.strictObject({ question_id: idSchema });
export const coverageReferenceRowSchema = z.strictObject({
  question_id: idSchema,
  turn_id: idSchema,
});
export const versionRowSchema = z.strictObject({
  state_version: z.number().int().nonnegative(),
  updated_at: databaseTimestampSchema,
});
export const transitionGuardRowSchema = stateRowSchema.extend({
  pendingDeliveryId: idSchema.nullable(),
  pendingReservedSequenceNumber: z.number().int().positive().nullable(),
  unresolvedPartialProvider: z.string().min(1).nullable(),
  unresolvedPartialSegmentId: idSchema.nullable(),
  unresolvedPartialUtteranceId: idSchema.nullable(),
});
export const noRowsSchema = z.array(z.never());
export const interviewSummaryRowSchema = z.strictObject({
  interviewId: idSchema,
  guideId: idSchema,
  language: z.enum(['de', 'en']).default('de'),
  displayName: interviewDisplayNameSchema.nullable().optional(),
  guideTitle: z.string().min(1),
  status: z.enum(['ready', 'active', 'paused', 'ending', 'completed', 'failed']),
  currentMainQuestionId: idSchema.nullable(),
  activeWorkflowRunId: idSchema.nullable(),
  createdAt: databaseTimestampSchema,
  updatedAt: databaseTimestampSchema,
  startedAt: nullableTimestampSchema,
});
export const interviewSummaryCursorSchema = z.strictObject({
  createdAt: z.iso.datetime({ offset: true }),
  interviewId: idSchema,
});

export type StateRow = z.infer<typeof stateRowSchema>;
export type CoverageRow = z.infer<typeof coverageRowSchema>;
export type GuideQuestionShapeRow = z.infer<typeof guideQuestionShapeRowSchema>;

export function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.') || '<row>'}: ${issue.message}`)
    .join('; ');
}
