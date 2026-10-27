import {
  agentNameSchema,
  idSchema,
  modelMetadataSchema,
  runStatusSchema,
  structuredAgentOutputSchema,
  workflowStepNameSchema,
} from '@orgscience/contracts';
import { z } from 'zod';

const timestampSchema = z
  .union([z.string(), z.date()])
  .transform((value) => (typeof value === 'string' ? value : value.toISOString()))
  .pipe(z.iso.datetime({ offset: true }));

const nullableTimestampSchema = timestampSchema.nullable();

export const workflowRowSchema = z.strictObject({
  id: idSchema,
  interview_id: idSchema,
  job_id: idSchema,
  mastra_attempt_id: idSchema,
  attempt_number: z.number().int().positive(),
  expected_state_version: z.number().int().nonnegative(),
  status: runStatusSchema,
  retry_count: z.number().int().nonnegative(),
  started_at: nullableTimestampSchema,
  ended_at: nullableTimestampSchema,
  duration_ms: z.number().int().nonnegative().nullable(),
  error_code: z.string().min(1).nullable(),
  error_message: z.string().min(1).nullable(),
  error_retryable: z.boolean().nullable(),
  rejection_reason: z.string().min(1).nullable(),
  applied_at: nullableTimestampSchema,
});

export const storedAgentInputSchema = z.strictObject({
  interviewStateVersion: z.number().int().nonnegative(),
  transcriptTurnIds: z.array(idSchema),
  canonicalEntryIds: z.array(idSchema),
  guideQuestionIds: z.array(idSchema),
});

const stepInputSchema = z.strictObject({
  referencedTranscriptTurnIds: z.array(idSchema),
  referencedGuideQuestionIds: z.array(idSchema),
});

export const stepRowSchema = z.strictObject({
  id: idSchema,
  interview_id: idSchema,
  workflow_run_id: idSchema,
  mastra_attempt_id: idSchema,
  agent_run_id: idSchema.nullable(),
  step: workflowStepNameSchema,
  attempt_number: z.number().int().positive(),
  status: runStatusSchema,
  retry_count: z.number().int().nonnegative(),
  started_at: nullableTimestampSchema,
  ended_at: nullableTimestampSchema,
  duration_ms: z.number().int().nonnegative().nullable(),
  error_code: z.string().min(1).nullable(),
  error_message: z.string().min(1).nullable(),
  error_retryable: z.boolean().nullable(),
  input: stepInputSchema,
  output: structuredAgentOutputSchema.nullable(),
});

export const agentRowSchema = z.strictObject({
  id: idSchema,
  interview_id: idSchema,
  workflow_run_id: idSchema,
  mastra_attempt_id: idSchema,
  agent_name: agentNameSchema,
  invocation_number: z.number().int().positive(),
  status: runStatusSchema,
  retry_count: z.number().int().nonnegative(),
  model_mode: z.enum(['demo', 'provider']),
  model_provider: z.string().min(1).nullable(),
  model_name: z.string().min(1).nullable(),
  started_at: nullableTimestampSchema,
  ended_at: nullableTimestampSchema,
  duration_ms: z.number().int().nonnegative().nullable(),
  error_code: z.string().min(1).nullable(),
  error_message: z.string().min(1).nullable(),
  error_retryable: z.boolean().nullable(),
  input: storedAgentInputSchema,
  output: structuredAgentOutputSchema.nullable(),
});

export const identityRowSchema = z.strictObject({ id: idSchema });

export type WorkflowRow = z.infer<typeof workflowRowSchema>;
export type StepRow = z.infer<typeof stepRowSchema>;
export type AgentRow = z.infer<typeof agentRowSchema>;

export { modelMetadataSchema, runStatusSchema, structuredAgentOutputSchema };
