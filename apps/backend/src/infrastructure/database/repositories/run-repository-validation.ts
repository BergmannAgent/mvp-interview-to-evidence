import {
  idSchema,
  modelMetadataSchema,
  structuredAgentOutputSchema,
  timestampSchema,
} from '@orgscience/contracts';
import type { AgentName, RunStatus, WorkflowStepName } from '@orgscience/contracts';

import {
  failure,
  type RepositoryResult,
  type StoredAgentRun,
  type StoredFailure,
  type StoredStepCheckpoint,
  type StoredWorkflowAttempt,
} from '../../../application/persistence/index.js';
import { storedAgentInputSchema } from './run-repository-schemas.js';

export function validateWorkflow(interviewId: string, run: StoredWorkflowAttempt): string | null {
  if (!isInternalId(interviewId) || run.interviewId !== interviewId) {
    return 'workflow_interview_scope';
  }
  if (
    ![run.workflowRunId, run.attemptId, run.jobId].every(isInternalId) ||
    !isPositiveInteger(run.attemptNumber) ||
    !isNonnegativeInteger(run.expectedInterviewVersion) ||
    !isNonnegativeInteger(run.retryCount)
  ) {
    return 'workflow_identity_or_counter';
  }
  const timed = validateTimedRun(run);
  if (timed !== null) return timed;
  return (run.appliedAt !== null && !timestampSchema.safeParse(run.appliedAt).success) ||
    (run.rejectionReason !== null && !isNonBlankString(run.rejectionReason)) ||
    (run.appliedAt !== null && (run.status !== 'succeeded' || run.rejectionReason !== null))
    ? 'workflow_applied_shape'
    : null;
}

export function validateStep(
  interviewId: string,
  attemptId: string,
  checkpoint: StoredStepCheckpoint,
): string | null {
  if (
    !isInternalId(interviewId) ||
    !isInternalId(attemptId) ||
    checkpoint.interviewId !== interviewId ||
    checkpoint.attemptId !== attemptId
  ) {
    return 'workflow_step_scope';
  }
  if (
    ![checkpoint.workflowRunId, checkpoint.stepRunId].every(isInternalId) ||
    (checkpoint.agentRunId !== null && !isInternalId(checkpoint.agentRunId)) ||
    !isPositiveInteger(checkpoint.attemptNumber) ||
    !isNonnegativeInteger(checkpoint.retryCount)
  ) {
    return 'workflow_step_identity_or_counter';
  }
  if (
    !unique(checkpoint.referencedTranscriptTurnIds) ||
    !unique(checkpoint.referencedGuideQuestionIds)
  ) {
    return 'workflow_step_duplicate_references';
  }
  if (
    checkpoint.structuredOutput !== null &&
    !structuredAgentOutputSchema.safeParse(checkpoint.structuredOutput).success
  ) {
    return 'workflow_step_invalid_output';
  }
  const expectedAgentName = agentNameForStep(checkpoint.step);
  if (
    (checkpoint.status !== 'succeeded' &&
      (checkpoint.structuredOutput !== null || checkpoint.agentRunId !== null)) ||
    (expectedAgentName === null &&
      checkpoint.status === 'succeeded' &&
      (checkpoint.structuredOutput !== null || checkpoint.agentRunId !== null)) ||
    (expectedAgentName !== null &&
      checkpoint.status === 'succeeded' &&
      (checkpoint.agentRunId === null ||
        checkpoint.structuredOutput === null ||
        checkpoint.structuredOutput.agentName !== expectedAgentName))
  ) {
    return 'workflow_step_output_shape';
  }
  return validateTimedRun(checkpoint);
}

export function validateAgent(interviewId: string, run: StoredAgentRun): string | null {
  if (!isInternalId(interviewId) || run.interviewId !== interviewId) {
    return 'agent_interview_scope';
  }
  if (
    ![run.workflowRunId, run.attemptId, run.agentRunId].every(isInternalId) ||
    !isPositiveInteger(run.invocationNumber) ||
    !isNonnegativeInteger(run.retryCount)
  ) {
    return 'agent_identity_or_counter';
  }
  if (!modelMetadataSchema.safeParse(run.model).success) return 'agent_model';
  if (
    !storedAgentInputSchema.safeParse(run.validatedInput).success ||
    !unique(run.validatedInput.transcriptTurnIds) ||
    !unique(run.validatedInput.canonicalEntryIds) ||
    !unique(run.validatedInput.guideQuestionIds)
  ) {
    return 'agent_input';
  }
  if (
    run.validatedOutput !== null &&
    (!structuredAgentOutputSchema.safeParse(run.validatedOutput).success ||
      run.validatedOutput.agentName !== run.agentName)
  ) {
    return 'agent_output';
  }
  if (run.status === 'succeeded' ? run.validatedOutput === null : run.validatedOutput !== null) {
    return 'agent_output_shape';
  }
  return validateTimedRun(run);
}

export function agentNameForStep(step: WorkflowStepName): AgentName | null {
  switch (step) {
    case 'coverage_analysis':
      return 'coverage_analysis';
    case 'consistency_analysis':
      return 'consistency_analysis';
    case 'interview_decision':
      return 'interview_decision';
    case 'conductor_question_generation':
      return 'interview_conductor';
    default:
      return null;
  }
}

export function isTerminal(status: RunStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'skipped';
}

export function constraint<T>(name: string): RepositoryResult<T> {
  return failure({ code: 'constraint_violation', constraint: name });
}

export function duplicate<T>(
  resource: 'workflow_run' | 'agent_run',
  identity: string,
): RepositoryResult<T> {
  return failure({ code: 'duplicate_conflict', resource, identity });
}

function validateTimedRun(run: {
  readonly status: RunStatus;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly durationMs: number | null;
  readonly failure: StoredFailure | null;
}): string | null {
  if (
    (run.startedAt !== null && !timestampSchema.safeParse(run.startedAt).success) ||
    (run.endedAt !== null && !timestampSchema.safeParse(run.endedAt).success)
  ) {
    return 'run_timestamp';
  }
  if (run.durationMs !== null && !isNonnegativeInteger(run.durationMs)) {
    return 'run_duration';
  }
  if (run.status === 'waiting') {
    if (run.startedAt !== null || run.endedAt !== null || run.durationMs !== null) {
      return 'run_waiting_timing';
    }
  } else if (run.status === 'running' || run.status === 'retrying') {
    if (run.startedAt === null || run.endedAt !== null || run.durationMs !== null) {
      return 'run_active_timing';
    }
  } else if (run.startedAt === null || run.endedAt === null || run.durationMs === null) {
    return 'run_terminal_timing';
  }
  if ((run.status === 'failed') !== (run.failure !== null)) return 'run_failure_shape';
  if (run.failure !== null) {
    if (
      !isNonBlankString(run.failure.code) ||
      !isNonBlankString(run.failure.message) ||
      typeof run.failure.retryable !== 'boolean' ||
      !timestampSchema.safeParse(run.failure.occurredAt).success
    ) {
      return 'run_failure_shape';
    }
    if (Date.parse(run.failure.occurredAt) !== Date.parse(run.endedAt ?? '')) {
      return 'run_failure_timestamp';
    }
  }
  if (
    run.startedAt !== null &&
    run.endedAt !== null &&
    Date.parse(run.endedAt) < Date.parse(run.startedAt)
  ) {
    return 'run_time_order';
  }
  return null;
}

function unique(values: readonly string[]): boolean {
  return values.every(isInternalId) && new Set(values).size === values.length;
}

function isInternalId(value: string): boolean {
  return idSchema.safeParse(value).success;
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function isNonnegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
