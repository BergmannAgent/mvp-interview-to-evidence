import { modelMetadataSchema } from '@orgscience/contracts';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import {
  failure,
  success,
  type RepositoryResult,
  type StoredAgentRun,
  type StoredFailure,
  type StoredStepCheckpoint,
  type StoredWorkflowAttempt,
} from '../../../application/persistence/index.js';
import { corruptData } from './repository-errors.js';
import {
  agentRowSchema,
  identityRowSchema,
  stepRowSchema,
  workflowRowSchema,
  type AgentRow,
  type StepRow,
  type WorkflowRow,
} from './run-repository-schemas.js';
import { validateAgent, validateStep, validateWorkflow } from './run-repository-validation.js';

export function workflowParameters(run: StoredWorkflowAttempt): readonly unknown[] {
  const failed = failureColumns(run.failure);
  return [
    run.workflowRunId,
    run.interviewId,
    run.jobId,
    run.attemptId,
    run.attemptNumber,
    run.expectedInterviewVersion,
    run.status,
    run.retryCount,
    run.startedAt,
    run.endedAt,
    run.durationMs,
    failed.code,
    failed.message,
    failed.retryable,
    run.rejectionReason,
    run.appliedAt,
  ];
}

export function workflowFinishParameters(
  run: StoredWorkflowAttempt,
  expectedStatus: 'running',
): readonly unknown[] {
  const failed = failureColumns(run.failure);
  return [
    run.workflowRunId,
    run.interviewId,
    expectedStatus,
    run.status,
    run.retryCount,
    run.endedAt,
    run.durationMs,
    failed.code,
    failed.message,
    failed.retryable,
    run.rejectionReason,
    run.appliedAt,
    run.jobId,
    run.attemptId,
    run.attemptNumber,
    run.expectedInterviewVersion,
    run.startedAt,
  ];
}

export function stepParameters(
  checkpoint: StoredStepCheckpoint,
  attemptId: string,
): readonly unknown[] {
  const failed = failureColumns(checkpoint.failure);
  const input = {
    referencedTranscriptTurnIds: checkpoint.referencedTranscriptTurnIds,
    referencedGuideQuestionIds: checkpoint.referencedGuideQuestionIds,
  };
  return [
    checkpoint.stepRunId,
    checkpoint.interviewId,
    checkpoint.workflowRunId,
    checkpoint.agentRunId,
    checkpoint.step,
    checkpoint.attemptNumber,
    checkpoint.status,
    checkpoint.retryCount,
    checkpoint.startedAt,
    checkpoint.endedAt,
    checkpoint.durationMs,
    failed.code,
    failed.message,
    failed.retryable,
    JSON.stringify(input),
    checkpoint.structuredOutput === null ? null : JSON.stringify(checkpoint.structuredOutput),
    attemptId,
  ];
}

export function stepFinishParameters(
  checkpoint: StoredStepCheckpoint,
  expectedStatus: 'running',
): readonly unknown[] {
  const failed = failureColumns(checkpoint.failure);
  const input = {
    referencedTranscriptTurnIds: checkpoint.referencedTranscriptTurnIds,
    referencedGuideQuestionIds: checkpoint.referencedGuideQuestionIds,
  };
  return [
    checkpoint.stepRunId,
    checkpoint.interviewId,
    expectedStatus,
    checkpoint.agentRunId,
    checkpoint.status,
    checkpoint.retryCount,
    checkpoint.endedAt,
    checkpoint.durationMs,
    failed.code,
    failed.message,
    failed.retryable,
    checkpoint.structuredOutput === null ? null : JSON.stringify(checkpoint.structuredOutput),
    checkpoint.workflowRunId,
    checkpoint.step,
    checkpoint.attemptNumber,
    checkpoint.startedAt,
    JSON.stringify(input),
    checkpoint.attemptId,
  ];
}

export function agentParameters(run: StoredAgentRun): readonly unknown[] {
  const failed = failureColumns(run.failure);
  return [
    run.agentRunId,
    run.interviewId,
    run.workflowRunId,
    run.agentName,
    run.invocationNumber,
    run.status,
    run.retryCount,
    run.model.mode,
    run.model.provider,
    run.model.model,
    run.startedAt,
    run.endedAt,
    run.durationMs,
    failed.code,
    failed.message,
    failed.retryable,
    JSON.stringify(run.validatedInput),
    run.validatedOutput === null ? null : JSON.stringify(run.validatedOutput),
    run.attemptId,
  ];
}

export function agentFinishParameters(
  run: StoredAgentRun,
  expectedStatus: 'running',
): readonly unknown[] {
  const failed = failureColumns(run.failure);
  return [
    run.agentRunId,
    run.interviewId,
    expectedStatus,
    run.status,
    run.retryCount,
    run.endedAt,
    run.durationMs,
    failed.code,
    failed.message,
    failed.retryable,
    run.validatedOutput === null ? null : JSON.stringify(run.validatedOutput),
    run.workflowRunId,
    run.agentName,
    run.invocationNumber,
    run.model.mode,
    run.model.provider,
    run.model.model,
    run.startedAt,
    JSON.stringify(run.validatedInput),
    run.attemptId,
  ];
}

export function normalizeWorkflowAttempt(run: StoredWorkflowAttempt): StoredWorkflowAttempt {
  return {
    ...run,
    startedAt: normalizeNullableTimestamp(run.startedAt),
    endedAt: normalizeNullableTimestamp(run.endedAt),
    failure: normalizeFailure(run.failure),
    appliedAt: normalizeNullableTimestamp(run.appliedAt),
  };
}

export function normalizeStepCheckpoint(checkpoint: StoredStepCheckpoint): StoredStepCheckpoint {
  return {
    ...checkpoint,
    startedAt: normalizeNullableTimestamp(checkpoint.startedAt),
    endedAt: normalizeNullableTimestamp(checkpoint.endedAt),
    failure: normalizeFailure(checkpoint.failure),
  };
}

export function normalizeAgentRun(run: StoredAgentRun): StoredAgentRun {
  return {
    ...run,
    startedAt: normalizeNullableTimestamp(run.startedAt),
    endedAt: normalizeNullableTimestamp(run.endedAt),
    failure: normalizeFailure(run.failure),
  };
}

export function sameWorkflowAttempt(
  left: StoredWorkflowAttempt,
  right: StoredWorkflowAttempt,
): boolean {
  return isDeepStrictEqual(normalizeWorkflowAttempt(left), normalizeWorkflowAttempt(right));
}

export function sameStepCheckpoint(
  left: StoredStepCheckpoint,
  right: StoredStepCheckpoint,
): boolean {
  return isDeepStrictEqual(normalizeStepCheckpoint(left), normalizeStepCheckpoint(right));
}

export function sameAgentRun(left: StoredAgentRun, right: StoredAgentRun): boolean {
  return isDeepStrictEqual(normalizeAgentRun(left), normalizeAgentRun(right));
}

export function parseIdentityRows(
  rows: readonly unknown[],
  rowCount: number,
  resource: 'workflow_run' | 'agent_run',
  id: string,
): RepositoryResult<readonly { readonly id: string }[]> {
  const parsed = z.array(identityRowSchema).safeParse(rows);
  return parsed.success && parsed.data.length === rowCount
    ? success(parsed.data)
    : failure(corruptData(resource, id, 'Invalid insert result'));
}

export function parseSingleWorkflow(
  rows: readonly unknown[],
  rowCount: number,
  interviewId: string,
  workflowRunId: string,
): RepositoryResult<StoredWorkflowAttempt> {
  const parsed = parseWorkflowRows(rows, rowCount, interviewId);
  if (!parsed.ok) return parsed;
  const workflow = parsed.value[0];
  return parsed.value.length === 1 && workflow?.workflowRunId === workflowRunId
    ? success(workflow)
    : failure(corruptData('workflow_run', workflowRunId, 'Workflow identity mismatch'));
}

export function parseWorkflowRows(
  rows: readonly unknown[],
  rowCount: number,
  interviewId: string,
): RepositoryResult<readonly StoredWorkflowAttempt[]> {
  const parsed = z.array(workflowRowSchema).safeParse(rows);
  if (!parsed.success || parsed.data.length !== rowCount) {
    return failure(corruptData('workflow_run', interviewId, 'Invalid workflow row list'));
  }
  const attempts: StoredWorkflowAttempt[] = [];
  for (const row of parsed.data) {
    if (row.interview_id !== interviewId) {
      return failure(corruptData('workflow_run', row.id, 'Workflow interview scope mismatch'));
    }
    const converted = workflowFromRow(row);
    if (!converted.ok) return converted;
    attempts.push(converted.value);
  }
  return success(attempts);
}

export function parseSingleStep(
  rows: readonly unknown[],
  rowCount: number,
  interviewId: string,
  stepRunId: string,
): RepositoryResult<StoredStepCheckpoint> {
  const parsed = parseStepRows(rows, rowCount, interviewId);
  if (!parsed.ok) return parsed;
  const checkpoint = parsed.value[0];
  return parsed.value.length === 1 && checkpoint?.stepRunId === stepRunId
    ? success(checkpoint)
    : failure(corruptData('workflow_run', stepRunId, 'Step checkpoint identity mismatch'));
}

export function parseStepRows(
  rows: readonly unknown[],
  rowCount: number,
  interviewId: string,
  workflowRunId?: string,
): RepositoryResult<readonly StoredStepCheckpoint[]> {
  const parsed = z.array(stepRowSchema).safeParse(rows);
  if (!parsed.success || parsed.data.length !== rowCount) {
    return failure(corruptData('workflow_run', workflowRunId ?? interviewId, 'Invalid step rows'));
  }
  const checkpoints: StoredStepCheckpoint[] = [];
  for (const row of parsed.data) {
    if (
      row.interview_id !== interviewId ||
      (workflowRunId !== undefined && row.workflow_run_id !== workflowRunId)
    ) {
      return failure(corruptData('workflow_run', row.id, 'Step checkpoint scope mismatch'));
    }
    const checkpoint = stepFromRow(row);
    if (!checkpoint.ok) return checkpoint;
    checkpoints.push(checkpoint.value);
  }
  return success(checkpoints);
}

export function parseSingleAgent(
  rows: readonly unknown[],
  rowCount: number,
  interviewId: string,
  agentRunId: string,
): RepositoryResult<StoredAgentRun> {
  const parsed = parseAgentRows(rows, rowCount, interviewId);
  if (!parsed.ok) return parsed;
  const run = parsed.value[0];
  return parsed.value.length === 1 && run?.agentRunId === agentRunId
    ? success(run)
    : failure(corruptData('agent_run', agentRunId, 'Agent identity mismatch'));
}

export function parseAgentRows(
  rows: readonly unknown[],
  rowCount: number,
  interviewId: string,
  workflowRunId?: string,
): RepositoryResult<readonly StoredAgentRun[]> {
  const parsed = z.array(agentRowSchema).safeParse(rows);
  if (!parsed.success || parsed.data.length !== rowCount) {
    return failure(corruptData('agent_run', workflowRunId ?? interviewId, 'Invalid agent rows'));
  }
  const runs: StoredAgentRun[] = [];
  for (const row of parsed.data) {
    if (
      row.interview_id !== interviewId ||
      (workflowRunId !== undefined && row.workflow_run_id !== workflowRunId)
    ) {
      return failure(corruptData('agent_run', row.id, 'Agent run scope mismatch'));
    }
    const run = agentFromRow(row);
    if (!run.ok) return run;
    runs.push(run.value);
  }
  return success(runs);
}

function workflowFromRow(row: WorkflowRow): RepositoryResult<StoredWorkflowAttempt> {
  const failed = failureFromColumns(
    row.error_code,
    row.error_message,
    row.error_retryable,
    row.ended_at,
  );
  if (!failed.ok) return failure(corruptData('workflow_run', row.id, failed.reason));
  const attempt: StoredWorkflowAttempt = {
    interviewId: row.interview_id,
    workflowRunId: row.id,
    attemptId: row.mastra_attempt_id,
    jobId: row.job_id,
    expectedInterviewVersion: row.expected_state_version,
    attemptNumber: row.attempt_number,
    status: row.status,
    retryCount: row.retry_count,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: row.duration_ms,
    failure: failed.value,
    rejectionReason: row.rejection_reason,
    appliedAt: row.applied_at,
  };
  const issue = validateWorkflow(row.interview_id, attempt);
  return issue === null ? success(attempt) : failure(corruptData('workflow_run', row.id, issue));
}

function stepFromRow(row: StepRow): RepositoryResult<StoredStepCheckpoint> {
  const failed = failureFromColumns(
    row.error_code,
    row.error_message,
    row.error_retryable,
    row.ended_at,
  );
  if (!failed.ok) return failure(corruptData('workflow_run', row.id, failed.reason));
  const checkpoint: StoredStepCheckpoint = {
    interviewId: row.interview_id,
    workflowRunId: row.workflow_run_id,
    attemptId: row.mastra_attempt_id,
    stepRunId: row.id,
    agentRunId: row.agent_run_id,
    step: row.step,
    attemptNumber: row.attempt_number,
    status: row.status,
    retryCount: row.retry_count,
    referencedTranscriptTurnIds: row.input.referencedTranscriptTurnIds,
    referencedGuideQuestionIds: row.input.referencedGuideQuestionIds,
    structuredOutput: row.output,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: row.duration_ms,
    failure: failed.value,
  };
  const issue = validateStep(row.interview_id, row.mastra_attempt_id, checkpoint);
  return issue === null ? success(checkpoint) : failure(corruptData('workflow_run', row.id, issue));
}

function agentFromRow(row: AgentRow): RepositoryResult<StoredAgentRun> {
  const failed = failureFromColumns(
    row.error_code,
    row.error_message,
    row.error_retryable,
    row.ended_at,
  );
  if (!failed.ok) return failure(corruptData('agent_run', row.id, failed.reason));
  const model = modelMetadataSchema.safeParse({
    mode: row.model_mode,
    provider: row.model_provider,
    model: row.model_name,
  });
  if (!model.success) return failure(corruptData('agent_run', row.id, 'Invalid model metadata'));
  const run: StoredAgentRun = {
    interviewId: row.interview_id,
    workflowRunId: row.workflow_run_id,
    attemptId: row.mastra_attempt_id,
    agentRunId: row.id,
    agentName: row.agent_name,
    invocationNumber: row.invocation_number,
    status: row.status,
    model: model.data,
    validatedInput: row.input,
    validatedOutput: row.output,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: row.duration_ms,
    retryCount: row.retry_count,
    failure: failed.value,
  };
  const issue = validateAgent(row.interview_id, run);
  return issue === null ? success(run) : failure(corruptData('agent_run', row.id, issue));
}

function failureColumns(failed: StoredFailure | null): {
  readonly code: string | null;
  readonly message: string | null;
  readonly retryable: boolean | null;
} {
  return failed === null
    ? { code: null, message: null, retryable: null }
    : { code: failed.code, message: failed.message, retryable: failed.retryable };
}

function normalizeFailure(failure: StoredFailure | null): StoredFailure | null {
  return failure === null
    ? null
    : { ...failure, occurredAt: normalizeTimestamp(failure.occurredAt) };
}

function normalizeNullableTimestamp(value: string | null): string | null {
  return value === null ? null : normalizeTimestamp(value);
}

function normalizeTimestamp(value: string): string {
  return new Date(value).toISOString();
}

function failureFromColumns(
  code: string | null,
  message: string | null,
  retryable: boolean | null,
  occurredAt: string | null,
):
  | { readonly ok: true; readonly value: StoredFailure | null }
  | { readonly ok: false; readonly reason: string } {
  if (code === null && message === null && retryable === null) return { ok: true, value: null };
  if (code === null || message === null || retryable === null || occurredAt === null) {
    return { ok: false, reason: 'Incomplete stored failure' };
  }
  return { ok: true, value: { code, message, retryable, occurredAt } };
}
