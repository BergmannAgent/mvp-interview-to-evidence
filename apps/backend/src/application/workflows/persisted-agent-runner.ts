import { randomUUID } from 'node:crypto';

import {
  type AgentName,
  type ConductorOutput,
  type ConsistencyAnalysisOutput,
  type CoverageAnalysisOutput,
  type InterviewDecisionOutput,
  type ModelMetadata,
  type StructuredAgentOutput,
  type WorkflowStepName,
} from '@orgscience/contracts';
import { buildGuideQuestionCatalog } from '@orgscience/domain';

import {
  type AgentExecutionResult,
  type AgentPromptInput,
  type ConsistencyAnalysisPromptInput,
  type CoverageAnalysisPromptInput,
  type InterviewAgentExecutor,
  type InterviewConductorPromptInput,
  type InterviewDecisionPromptInput,
} from '../agents/index.js';
import {
  success,
  type AppUnitOfWork,
  type MonitoringEventDraft,
  type StoredAgentInput,
  type StoredAgentRun,
  type StoredFailure,
  type StoredStepCheckpoint,
} from '../persistence/index.js';
import { readClock, type Clock } from '../runtime.js';
import type { InterviewTurnWorkflowAgentRunner } from './interview-turn-workflow.js';

interface PersistedAgentRunnerScope {
  readonly interviewId: string;
  readonly workflowRunId: string;
  readonly attemptId: string;
  readonly attemptNumber: number;
}

interface ExecutionSpec<Input extends AgentPromptInput, Output> {
  readonly agentName: AgentName;
  readonly step: WorkflowStepName;
  readonly wrapOutput: (output: Output) => StructuredAgentOutput;
  readonly execute: (
    input: Input,
    context: {
      readonly runId: string;
      readonly workflowRunId: string;
      readonly signal: AbortSignal;
    },
  ) => Promise<AgentExecutionResult<Output>>;
}

export class InterviewWorkflowExecutionError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'InterviewWorkflowExecutionError';
  }
}

export class PersistedInterviewTurnAgentRunner implements InterviewTurnWorkflowAgentRunner {
  private persistenceQueue: Promise<void> = Promise.resolve();

  public constructor(
    private readonly unitOfWork: AppUnitOfWork,
    private readonly clock: Clock,
    private readonly executor: InterviewAgentExecutor,
    private readonly model: ModelMetadata,
    private readonly scope: PersistedAgentRunnerScope,
  ) {}

  public executeCoverageAnalysis(
    input: CoverageAnalysisPromptInput,
    signal: AbortSignal,
  ): Promise<CoverageAnalysisOutput> {
    return this.execute(input, signal, {
      agentName: 'coverage_analysis',
      step: 'coverage_analysis',
      wrapOutput: (output) => ({ agentName: 'coverage_analysis', output }),
      execute: (agentInput, context) => this.executor.executeCoverageAnalysis(agentInput, context),
    });
  }

  public executeConsistencyAnalysis(
    input: ConsistencyAnalysisPromptInput,
    signal: AbortSignal,
  ): Promise<ConsistencyAnalysisOutput> {
    return this.execute(input, signal, {
      agentName: 'consistency_analysis',
      step: 'consistency_analysis',
      wrapOutput: (output) => ({ agentName: 'consistency_analysis', output }),
      execute: (agentInput, context) =>
        this.executor.executeConsistencyAnalysis(agentInput, context),
    });
  }

  public executeInterviewDecision(
    input: InterviewDecisionPromptInput,
    signal: AbortSignal,
  ): Promise<InterviewDecisionOutput> {
    return this.execute(input, signal, {
      agentName: 'interview_decision',
      step: 'interview_decision',
      wrapOutput: (output) => ({ agentName: 'interview_decision', output }),
      execute: (agentInput, context) => this.executor.executeInterviewDecision(agentInput, context),
    });
  }

  public executeInterviewConductor(
    input: InterviewConductorPromptInput,
    signal: AbortSignal,
  ): Promise<ConductorOutput> {
    return this.execute(input, signal, {
      agentName: 'interview_conductor',
      step: 'conductor_question_generation',
      wrapOutput: (output) => ({ agentName: 'interview_conductor', output }),
      execute: (agentInput, context) =>
        this.executor.executeInterviewConductor(agentInput, context),
    });
  }

  private async execute<Input extends AgentPromptInput, Output>(
    input: Input,
    signal: AbortSignal,
    spec: ExecutionSpec<Input, Output>,
  ): Promise<Output> {
    const startedAt = this.now();
    const agentRunId = randomUUID();
    const stepRunId = randomUUID();
    const validatedInput = toStoredInput(input);
    const agent = runningAgent(
      this.scope,
      agentRunId,
      spec.agentName,
      this.model,
      validatedInput,
      startedAt,
    );
    const step = runningStep(this.scope, stepRunId, spec.step, validatedInput, startedAt);
    await this.persistStart(agent, step);

    const result = await spec.execute(input, {
      runId: agentRunId,
      workflowRunId: this.scope.workflowRunId,
      signal,
    });
    const endedAt = this.now();
    const durationMs = elapsedMilliseconds(startedAt, endedAt);

    if (!result.ok) {
      const failure: StoredFailure = { ...result.error, occurredAt: endedAt };
      await this.persistFailure(
        { ...agent, status: 'failed', endedAt, durationMs, failure },
        { ...step, status: 'failed', endedAt, durationMs, failure },
      );
      throw new InterviewWorkflowExecutionError(
        result.error.code,
        result.error.message,
        result.error.retryable,
      );
    }
    if (!sameModel(result.model, this.model)) {
      const failure: StoredFailure = {
        code: 'model_metadata_mismatch',
        message: 'The agent returned model metadata that differs from its configured runtime.',
        retryable: false,
        occurredAt: endedAt,
      };
      await this.persistFailure(
        { ...agent, status: 'failed', endedAt, durationMs, failure },
        { ...step, status: 'failed', endedAt, durationMs, failure },
      );
      throw new InterviewWorkflowExecutionError(failure.code, failure.message, false);
    }

    const structuredOutput = spec.wrapOutput(result.output);
    await this.persistSuccess(
      {
        ...agent,
        status: 'succeeded',
        validatedOutput: structuredOutput,
        endedAt,
        durationMs,
        retryCount: result.repairCount,
      },
      {
        ...step,
        status: 'succeeded',
        agentRunId,
        structuredOutput,
        endedAt,
        durationMs,
        retryCount: result.repairCount,
      },
    );
    return result.output;
  }

  private async persistStart(agent: StoredAgentRun, step: StoredStepCheckpoint): Promise<void> {
    await this.serializePersistence(async () => {
      const result = await this.unitOfWork.transaction(async (transaction) => {
        const stepWrite = await transaction.runs.saveStepCheckpoint(
          this.scope.interviewId,
          this.scope.attemptId,
          step,
        );
        if (!stepWrite.ok) return stepWrite;
        const agentWrite = await transaction.runs.startAgent(this.scope.interviewId, agent);
        if (!agentWrite.ok) return agentWrite;
        const events = await transaction.outbox.appendMany(this.scope.interviewId, [
          stepEvent('workflow.step_started', step),
          agentStartedEvent(agent),
        ]);
        return events.ok ? success(undefined) : events;
      });
      if (!result.ok) throw persistenceFailure(result.error.code);
    });
  }

  private async persistSuccess(agent: StoredAgentRun, step: StoredStepCheckpoint): Promise<void> {
    await this.serializePersistence(async () => {
      const result = await this.unitOfWork.transaction(async (transaction) => {
        const agentWrite = await transaction.runs.finishAgent(
          this.scope.interviewId,
          agent.agentRunId,
          'running',
          agent,
        );
        if (!agentWrite.ok) return agentWrite;
        const stepWrite = await transaction.runs.finishStep(
          this.scope.interviewId,
          step.stepRunId,
          'running',
          step,
        );
        if (!stepWrite.ok) return stepWrite;
        const events = await transaction.outbox.appendMany(this.scope.interviewId, [
          agentCompletedEvent(agent),
          stepEvent('workflow.step_completed', step),
        ]);
        return events.ok ? success(undefined) : events;
      });
      if (!result.ok) throw persistenceFailure(result.error.code);
    });
  }

  private async persistFailure(agent: StoredAgentRun, step: StoredStepCheckpoint): Promise<void> {
    await this.serializePersistence(async () => {
      const result = await this.unitOfWork.transaction(async (transaction) => {
        const agentWrite = await transaction.runs.finishAgent(
          this.scope.interviewId,
          agent.agentRunId,
          'running',
          agent,
        );
        if (!agentWrite.ok) return agentWrite;
        const stepWrite = await transaction.runs.finishStep(
          this.scope.interviewId,
          step.stepRunId,
          'running',
          step,
        );
        if (!stepWrite.ok) return stepWrite;
        const events = await transaction.outbox.appendMany(this.scope.interviewId, [
          agentFailedEvent(agent),
          stepEvent('workflow.step_failed', step),
        ]);
        return events.ok ? success(undefined) : events;
      });
      if (!result.ok) throw persistenceFailure(result.error.code);
    });
  }

  private serializePersistence(operation: () => Promise<void>): Promise<void> {
    const queued = this.persistenceQueue.then(operation);
    this.persistenceQueue = queued.catch(() => undefined);
    return queued;
  }

  private now(): string {
    const now = readClock(this.clock);
    if (!now.ok) throw persistenceFailure(now.error.code);
    return now.value;
  }
}

function toStoredInput(input: AgentPromptInput): StoredAgentInput {
  return {
    interviewStateVersion: input.interviewStateVersion,
    transcriptTurnIds: input.transcript.entries.flatMap((entry) =>
      entry.kind === 'turn' ? [entry.turnId] : [],
    ),
    canonicalEntryIds: input.transcript.entries.map((entry) =>
      entry.kind === 'turn' ? entry.turnId : entry.gapId,
    ),
    guideQuestionIds: buildGuideQuestionCatalog(input.guide).map((question) => question.questionId),
  };
}

function runningAgent(
  scope: PersistedAgentRunnerScope,
  agentRunId: string,
  agentName: AgentName,
  model: ModelMetadata,
  validatedInput: StoredAgentInput,
  startedAt: string,
): StoredAgentRun {
  return {
    interviewId: scope.interviewId,
    workflowRunId: scope.workflowRunId,
    attemptId: scope.attemptId,
    agentRunId,
    agentName,
    invocationNumber: 1,
    status: 'running',
    model,
    validatedInput,
    validatedOutput: null,
    startedAt,
    endedAt: null,
    durationMs: null,
    retryCount: 0,
    failure: null,
  };
}

function runningStep(
  scope: PersistedAgentRunnerScope,
  stepRunId: string,
  step: WorkflowStepName,
  input: StoredAgentInput,
  startedAt: string,
): StoredStepCheckpoint {
  return {
    interviewId: scope.interviewId,
    workflowRunId: scope.workflowRunId,
    attemptId: scope.attemptId,
    stepRunId,
    agentRunId: null,
    step,
    attemptNumber: scope.attemptNumber,
    status: 'running',
    retryCount: 0,
    referencedTranscriptTurnIds: input.transcriptTurnIds,
    referencedGuideQuestionIds: input.guideQuestionIds,
    structuredOutput: null,
    startedAt,
    endedAt: null,
    durationMs: null,
    failure: null,
  };
}

function agentStartedEvent(agent: StoredAgentRun): MonitoringEventDraft {
  return {
    eventId: randomUUID(),
    interviewId: agent.interviewId,
    runId: agent.agentRunId,
    occurredAt: agent.startedAt!,
    category: 'agent',
    type: 'agent.started',
    payload: {
      run: agentRunMetadata(agent),
      input: {
        interviewStateVersion: agent.validatedInput.interviewStateVersion,
        transcriptTurnIds: [...agent.validatedInput.transcriptTurnIds],
        canonicalEntryIds: [...agent.validatedInput.canonicalEntryIds],
        guideQuestionIds: [...agent.validatedInput.guideQuestionIds],
      },
    },
  } satisfies MonitoringEventDraft;
}

function agentCompletedEvent(agent: StoredAgentRun): MonitoringEventDraft {
  return {
    eventId: randomUUID(),
    interviewId: agent.interviewId,
    runId: agent.agentRunId,
    occurredAt: agent.endedAt!,
    category: 'agent',
    type: 'agent.completed',
    payload: { run: agentRunMetadata(agent), result: agent.validatedOutput! },
  } satisfies MonitoringEventDraft;
}

function agentFailedEvent(agent: StoredAgentRun): MonitoringEventDraft {
  return {
    eventId: randomUUID(),
    interviewId: agent.interviewId,
    runId: agent.agentRunId,
    occurredAt: agent.endedAt!,
    category: 'agent',
    type: 'agent.failed',
    payload: {
      run: agentRunMetadata(agent),
      errorCode: agent.failure!.code,
      message: agent.failure!.message,
      retryable: agent.failure!.retryable,
    },
  } satisfies MonitoringEventDraft;
}

function stepEvent(
  type: 'workflow.step_started' | 'workflow.step_completed' | 'workflow.step_failed',
  step: StoredStepCheckpoint,
): MonitoringEventDraft {
  return {
    eventId: randomUUID(),
    interviewId: step.interviewId,
    runId: step.stepRunId,
    occurredAt: step.endedAt ?? step.startedAt!,
    category: 'workflow',
    type,
    payload: {
      stepRunId: step.stepRunId,
      workflowRunId: step.workflowRunId,
      step: step.step,
      status: step.status,
      startedAt: step.startedAt,
      endedAt: step.endedAt,
      durationMs: step.durationMs,
      retryCount: step.retryCount,
      errorCode: step.failure?.code ?? null,
      inputAvailable: true,
      outputAvailable: step.structuredOutput !== null,
    },
  } as MonitoringEventDraft;
}

function agentRunMetadata(agent: StoredAgentRun) {
  return {
    agentRunId: agent.agentRunId,
    workflowRunId: agent.workflowRunId,
    agentName: agent.agentName,
    status: agent.status,
    startedAt: agent.startedAt,
    endedAt: agent.endedAt,
    durationMs: agent.durationMs,
    retryCount: agent.retryCount,
    errorCode: agent.failure?.code ?? null,
    model: agent.model,
  };
}

function elapsedMilliseconds(startedAt: string, endedAt: string): number {
  return Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
}

function sameModel(left: ModelMetadata, right: ModelMetadata): boolean {
  return left.mode === right.mode && left.provider === right.provider && left.model === right.model;
}

function persistenceFailure(code: string): InterviewWorkflowExecutionError {
  return new InterviewWorkflowExecutionError(
    code,
    'The interview workflow state could not be persisted.',
    false,
  );
}
