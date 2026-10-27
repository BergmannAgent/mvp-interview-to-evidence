import {
  monitoringSnapshotSchema,
  type MonitoringAgentRun,
  type MonitoringContradiction,
  type MonitoringFinalization,
  type MonitoringLiveState,
  type MonitoringSnapshot,
  type MonitoringWorkflowRun,
  type MonitoringWorkflowStep,
} from '@orgscience/contracts';
import type { TranscriptAggregate } from '@orgscience/domain';

import type { ApplicationResult } from '../errors.js';
import {
  failure,
  success,
  type AppUnitOfWork,
  type PersistedInterview,
  type StoredAgentRun,
  type StoredContradiction,
  type StoredFinalization,
  type StoredStepCheckpoint,
  type StoredWorkflowAttempt,
} from '../persistence/index.js';
import { readClock, type Clock } from '../runtime.js';
import { projectInterviewView } from '../interviews/interview-view.js';

interface MonitoringSnapshotSource {
  readonly guide: Parameters<typeof projectInterviewView>[1];
  readonly interview: PersistedInterview;
  readonly transcript: TranscriptAggregate;
  readonly workflowRuns: readonly StoredWorkflowAttempt[];
  readonly workflowSteps: readonly StoredStepCheckpoint[];
  readonly agentRuns: readonly StoredAgentRun[];
  readonly contradictions: readonly StoredContradiction[];
  readonly finalization: StoredFinalization | null;
  readonly liveState: MonitoringLiveState;
  readonly eventSequence: number;
}

export class GetMonitoringSnapshotService {
  public constructor(
    private readonly unitOfWork: AppUnitOfWork,
    private readonly clock: Clock,
  ) {}

  public async execute(interviewId: string): Promise<ApplicationResult<MonitoringSnapshot>> {
    const capturedAt = readClock(this.clock);
    if (!capturedAt.ok) return capturedAt;

    const source = await this.unitOfWork.read(async (context) => {
      const interview = await context.interviews.load(interviewId);
      if (!interview.ok) return interview;
      const guide = await context.guides.getById(interview.value.guideId);
      if (!guide.ok) return guide;
      const transcript = await context.transcripts.loadAggregate(interviewId);
      if (!transcript.ok) return transcript;
      const workflowRuns = await context.runs.listForInterview(interviewId);
      if (!workflowRuns.ok) return workflowRuns;
      const workflowSteps = await context.runs.listStepsForInterview(interviewId);
      if (!workflowSteps.ok) return workflowSteps;
      const agentRuns = await context.runs.listAgentsForInterview(interviewId);
      if (!agentRuns.ok) return agentRuns;
      const contradictions = await context.consistency.listContradictions(interviewId);
      if (!contradictions.ok) return contradictions;
      const finalization = await context.finalizations.loadLatest(interviewId);
      if (!finalization.ok) return finalization;
      const highWater = await context.outbox.highWater(interviewId);
      if (!highWater.ok) return highWater;
      const liveState = await context.outbox.loadLiveState(interviewId, highWater.value);
      if (!liveState.ok) return liveState;

      return success({
        guide: guide.value,
        interview: interview.value,
        transcript: transcript.value,
        workflowRuns: workflowRuns.value,
        workflowSteps: workflowSteps.value,
        agentRuns: agentRuns.value,
        contradictions: contradictions.value,
        finalization: finalization.value,
        liveState: liveState.value,
        eventSequence: highWater.value,
      });
    });
    return source.ok ? projectMonitoringSnapshot(source.value, capturedAt.value) : source;
  }
}

export function projectMonitoringSnapshot(
  source: MonitoringSnapshotSource,
  capturedAt: string,
): ApplicationResult<MonitoringSnapshot> {
  const interviewState = projectInterviewView(source.interview, source.guide);
  if (!interviewState.ok) return interviewState;

  const candidate = {
    interviewGuide: {
      id: source.guide.id,
      sourceLanguage: source.guide.sourceLanguage ?? 'de',
      title: source.guide.title,
      sections: source.guide.sections,
    },
    interviewState: interviewState.value,
    transcript: {
      interviewId: source.transcript.interviewId,
      guideId: source.transcript.guideId,
      entries: source.transcript.entries,
      finalizedAt: source.finalization?.finalizedAt ?? null,
    },
    partialTranscriptions: source.transcript.partials.map((partial) => ({
      segmentId: partial.segmentId,
      interviewId: partial.interviewId,
      provider: partial.sourceProvider,
      providerEventId: partial.providerEventId,
      utteranceId: partial.utteranceId,
      speaker: 'participant' as const,
      text: partial.text,
      observedAt: partial.observedAt,
      status: 'partial' as const,
      revision: partial.revision,
    })),
    finalTranscriptions: source.transcript.finals.map((final) => ({
      segmentId: final.segmentId,
      interviewId: final.interviewId,
      provider: final.sourceProvider,
      providerEventId: final.providerEventId,
      utteranceId: final.utteranceId,
      speaker: 'participant' as const,
      text: final.text,
      observedAt: final.observedAt,
      status: 'final' as const,
      finalizedAt: final.finalizedAt,
    })),
    workflowRuns: source.workflowRuns.map(toMonitoringWorkflowRun),
    workflowSteps: source.workflowSteps.map(toMonitoringWorkflowStep),
    agentRuns: source.agentRuns.map(toMonitoringAgentRun),
    contradictions: source.contradictions.map(toMonitoringContradiction),
    finalization:
      source.finalization === null ? null : toMonitoringFinalization(source.finalization),
    liveState: source.liveState,
    eventSequence: source.eventSequence,
    capturedAt,
  };
  const parsed = monitoringSnapshotSchema.safeParse(candidate);
  if (!parsed.success) {
    console.error(
      JSON.stringify({
        event: 'monitoring.snapshot_contract_error',
        interviewId: source.interview.interviewId,
        issues: parsed.error.issues.map((issue) => ({
          code: issue.code,
          path: issue.path.join('.'),
          message: issue.message,
        })),
      }),
    );
  }
  return parsed.success
    ? success(parsed.data)
    : failure({
        code: 'application_invariant',
        resource: 'monitoring_snapshot',
        id: source.interview.interviewId,
        message: 'Persisted monitoring state does not satisfy the shared snapshot contract',
      });
}

function toMonitoringWorkflowRun(run: StoredWorkflowAttempt): MonitoringWorkflowRun {
  return {
    interviewId: run.interviewId,
    workflowRunId: run.workflowRunId,
    attemptId: run.attemptId,
    jobId: run.jobId,
    expectedInterviewStateVersion: run.expectedInterviewVersion,
    attemptNumber: run.attemptNumber,
    status: run.status,
    retryCount: run.retryCount,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    durationMs: run.durationMs,
    failure: run.failure,
    rejectionReason: run.rejectionReason,
    appliedAt: run.appliedAt,
  };
}

function toMonitoringWorkflowStep(step: StoredStepCheckpoint): MonitoringWorkflowStep {
  return {
    interviewId: step.interviewId,
    attemptId: step.attemptId,
    attemptNumber: step.attemptNumber,
    agentRunId: step.agentRunId,
    run: {
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
    input: {
      referencedTranscriptTurnIds: [...step.referencedTranscriptTurnIds],
      referencedGuideQuestionIds: [...step.referencedGuideQuestionIds],
    },
    structuredOutput: step.structuredOutput,
    failure: step.failure,
  };
}

function toMonitoringAgentRun(agent: StoredAgentRun): MonitoringAgentRun {
  return {
    interviewId: agent.interviewId,
    attemptId: agent.attemptId,
    invocationNumber: agent.invocationNumber,
    run: {
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
    },
    input: {
      interviewStateVersion: agent.validatedInput.interviewStateVersion,
      transcriptTurnIds: [...agent.validatedInput.transcriptTurnIds],
      canonicalEntryIds: [...agent.validatedInput.canonicalEntryIds],
      guideQuestionIds: [...agent.validatedInput.guideQuestionIds],
    },
    structuredOutput: agent.validatedOutput,
    failure: agent.failure,
  };
}

function toMonitoringContradiction(contradiction: StoredContradiction): MonitoringContradiction {
  return {
    interviewId: contradiction.interviewId,
    contradictionId: contradiction.contradictionId,
    workflowRunId: contradiction.workflowRunId,
    agentRunId: contradiction.agentRunId,
    description: contradiction.description,
    suggestedClarificationQuestion: contradiction.suggestedClarificationQuestion,
    shouldClarify: contradiction.shouldClarify,
    rationale: contradiction.rationale,
    referencedTranscriptTurnIds: [...contradiction.referencedTranscriptTurnIds],
    status: contradiction.status,
    askedTurnId: contradiction.askedTurnId,
    createdAt: contradiction.createdAt,
    updatedAt: contradiction.updatedAt,
  };
}

function toMonitoringFinalization(finalization: StoredFinalization): MonitoringFinalization {
  return {
    interviewId: finalization.interviewId,
    finalizationId: finalization.finalizationId,
    interviewStateVersion: finalization.stateVersion,
    agentRunId: finalization.agentRunId,
    finalizedAt: finalization.finalizedAt,
    deterministicValidation: {
      valid: finalization.deterministicValidation.valid,
      issues: finalization.deterministicValidation.issues.map((issue) => ({ ...issue })),
    },
    agentReport: finalization.agentReport,
    transcriptFingerprint: finalization.transcriptFingerprint,
    entryCount: finalization.entryCount,
    technicalGapCount: finalization.technicalGapCount,
  };
}
