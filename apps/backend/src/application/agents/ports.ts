import {
  idSchema,
  type AgentName,
  type ConductorOutput,
  type ConsistencyAnalysisOutput,
  type CoverageAnalysisOutput,
  type InterviewDecisionOutput,
  type ModelMetadata,
  type TranscriptFinalizationReport,
} from '@orgscience/contracts';

import type {
  AgentPromptInput,
  ConsistencyAnalysisPromptInput,
  CoverageAnalysisPromptInput,
  InterviewConductorPromptInput,
  InterviewDecisionPromptInput,
  TranscriptFinalizationPromptInput,
} from './input-schemas.js';

export const AGENT_FAILURE_CODES = [
  'aborted',
  'timeout',
  'rate_limited',
  'provider_error',
  'invalid_input',
  'invalid_output',
  'guardrail_rejected',
] as const;

export type AgentFailureCode = (typeof AGENT_FAILURE_CODES)[number];

export interface AgentExecutionFailure {
  readonly code: AgentFailureCode;
  readonly message: string;
  readonly retryable: boolean;
}

export type AgentExecutionResult<Output> =
  | {
      readonly ok: true;
      readonly output: Output;
      readonly model: ModelMetadata;
      readonly repairCount: number;
    }
  | {
      readonly ok: false;
      readonly error: AgentExecutionFailure;
      readonly model: ModelMetadata;
      readonly repairCount: number;
    };

export interface AgentExecutionContext {
  readonly runId: string;
  readonly workflowRunId: string;
  readonly signal: AbortSignal;
}

export function isValidAgentExecutionContext(context: unknown): context is AgentExecutionContext {
  if (typeof context !== 'object' || context === null) return false;
  if (!('runId' in context) || !('workflowRunId' in context) || !('signal' in context)) {
    return false;
  }
  return (
    idSchema.safeParse(context.runId).success &&
    idSchema.safeParse(context.workflowRunId).success &&
    context.signal instanceof AbortSignal
  );
}

export function executionContextOwnsInput(
  input: Pick<AgentPromptInput, 'agentName' | 'interviewState'>,
  context: AgentExecutionContext,
): boolean {
  return (
    input.agentName === 'transcript_finalization' ||
    input.interviewState.activeWorkflowRunId === context.workflowRunId
  );
}

export interface InterviewAgentExecutor {
  readonly mode: ModelMetadata['mode'];

  executeCoverageAnalysis(
    input: CoverageAnalysisPromptInput,
    context: AgentExecutionContext,
  ): Promise<AgentExecutionResult<CoverageAnalysisOutput>>;

  executeConsistencyAnalysis(
    input: ConsistencyAnalysisPromptInput,
    context: AgentExecutionContext,
  ): Promise<AgentExecutionResult<ConsistencyAnalysisOutput>>;

  executeInterviewDecision(
    input: InterviewDecisionPromptInput,
    context: AgentExecutionContext,
  ): Promise<AgentExecutionResult<InterviewDecisionOutput>>;

  executeInterviewConductor(
    input: InterviewConductorPromptInput,
    context: AgentExecutionContext,
  ): Promise<AgentExecutionResult<ConductorOutput>>;

  executeTranscriptFinalization(
    input: TranscriptFinalizationPromptInput,
    context: AgentExecutionContext,
  ): Promise<AgentExecutionResult<TranscriptFinalizationReport>>;
}

export type AgentPromptInputFor<Name extends AgentName> = Extract<
  AgentPromptInput,
  { readonly agentName: Name }
>;
