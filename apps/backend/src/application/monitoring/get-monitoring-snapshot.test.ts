import {
  createReadyInterview,
  createTranscriptAggregate,
  initializeGuideCoverage,
  type InterviewGuideSnapshot,
} from '@orgscience/domain';
import { describe, expect, it } from 'vitest';

import {
  success,
  type AppReadContext,
  type AppTransaction,
  type AppUnitOfWork,
  type PersistedInterview,
  type RepositoryError,
  type RepositoryResult,
  type Result,
  type StoredAgentRun,
  type StoredStepCheckpoint,
  type StoredWorkflowAttempt,
} from '../persistence/index.js';
import { GetMonitoringSnapshotService, projectMonitoringSnapshot } from './index.js';

const NOW = '2026-08-12T09:00:00.000Z';
const INTERVIEW_ID = 'interview-monitoring-1';
const GUIDE_ID = 'guide-monitoring-1';
const WORKFLOW_ID = 'workflow-monitoring-1';
const ATTEMPT_ID = 'attempt-monitoring-1';

const guide: InterviewGuideSnapshot = {
  id: GUIDE_ID,
  sourceLanguage: 'de',
  title: 'Interviewleitfaden',
  sections: [
    {
      id: 'section-1',
      position: 0,
      title: 'Einfuehrung',
      mainQuestions: [
        {
          id: 'main-1',
          position: 0,
          text: 'Welche Rolle haben Sie?',
          followUpQuestions: [],
        },
      ],
    },
  ],
  sourceMarkdown: '# Interviewleitfaden',
  createdAt: NOW,
};

const interview: PersistedInterview = {
  interviewId: INTERVIEW_ID,
  guideId: GUIDE_ID,
  language: 'de',
  lifecycle: createReadyInterview({ interviewId: INTERVIEW_ID, guideId: GUIDE_ID, createdAt: NOW }),
  coverage: initializeGuideCoverage(guide, INTERVIEW_ID),
  version: 0,
  activeWorkflowRunId: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const transcript = createTranscriptAggregate(INTERVIEW_ID, GUIDE_ID, [
  {
    kind: 'main_question',
    guideId: GUIDE_ID,
    sectionId: 'section-1',
    mainQuestionId: 'main-1',
  },
]);

const workflow: StoredWorkflowAttempt = {
  interviewId: INTERVIEW_ID,
  workflowRunId: WORKFLOW_ID,
  attemptId: ATTEMPT_ID,
  jobId: 'job-1',
  expectedInterviewVersion: 0,
  attemptNumber: 1,
  status: 'running',
  retryCount: 0,
  startedAt: NOW,
  endedAt: null,
  durationMs: null,
  failure: null,
  rejectionReason: null,
  appliedAt: null,
};

const step: StoredStepCheckpoint = {
  interviewId: INTERVIEW_ID,
  workflowRunId: WORKFLOW_ID,
  attemptId: ATTEMPT_ID,
  stepRunId: 'step-1',
  agentRunId: null,
  step: 'coverage_analysis',
  attemptNumber: 1,
  status: 'running',
  retryCount: 0,
  referencedTranscriptTurnIds: [],
  referencedGuideQuestionIds: ['main-1'],
  structuredOutput: null,
  startedAt: NOW,
  endedAt: null,
  durationMs: null,
  failure: null,
};

const agent: StoredAgentRun = {
  interviewId: INTERVIEW_ID,
  workflowRunId: WORKFLOW_ID,
  attemptId: ATTEMPT_ID,
  agentRunId: 'agent-1',
  agentName: 'coverage_analysis',
  invocationNumber: 1,
  status: 'running',
  model: { mode: 'demo', provider: null, model: null },
  validatedInput: {
    interviewStateVersion: 0,
    transcriptTurnIds: [],
    canonicalEntryIds: [],
    guideQuestionIds: ['main-1'],
  },
  validatedOutput: null,
  startedAt: NOW,
  endedAt: null,
  durationMs: null,
  retryCount: 0,
  failure: null,
};

const activatedWorkflowAgent: StoredAgentRun = {
  ...agent,
  validatedInput: {
    ...agent.validatedInput,
    interviewStateVersion: workflow.expectedInterviewVersion + 1,
  },
};

const source = {
  guide,
  interview,
  transcript,
  workflowRuns: [workflow],
  workflowSteps: [step],
  agentRuns: [agent],
  contradictions: [],
  finalization: null,
  liveState: { voiceState: 'idle' as const, activeAiTextStream: null },
  eventSequence: 7,
};

class SnapshotUnitOfWork implements AppUnitOfWork {
  public reads = 0;

  public constructor(private readonly context: AppReadContext) {}

  public async read<T>(
    operation: (context: AppReadContext) => Promise<RepositoryResult<T>>,
  ): Promise<RepositoryResult<T>> {
    this.reads += 1;
    return operation(this.context);
  }

  public async transaction<T, E = never>(
    operation: (transaction: AppTransaction) => Promise<Result<T, E | RepositoryError>>,
  ): Promise<Result<T, E | RepositoryError>> {
    void operation;
    throw new Error('Unexpected transaction');
  }
}

function snapshotContext(overrides: Partial<AppReadContext> = {}): AppReadContext {
  return {
    interviewSettings: {
      getSettings: async () => success([]),
      listGuides: async () => success([]),
    },
    guides: { getById: async () => success(guide) },
    interviews: {
      load: async () => success(interview),
      listSummaries: async () => {
        throw new Error('Unexpected summary list');
      },
    },
    transcripts: {
      loadAggregate: async () => success(transcript),
      loadAiDelivery: async () => {
        throw new Error('Unexpected AI delivery read');
      },
      listPendingAiDeliveries: async () => {
        throw new Error('Unexpected pending delivery read');
      },
      listQuestionAiDeliveries: async () => {
        throw new Error('Unexpected question delivery read');
      },
    },
    runs: {
      loadWorkflow: async () => {
        throw new Error('Unexpected workflow read');
      },
      listForInterview: async () => success([workflow]),
      loadStep: async () => {
        throw new Error('Unexpected step read');
      },
      listStepsForWorkflow: async () => {
        throw new Error('Unexpected scoped step list');
      },
      listStepsForInterview: async () => success([step]),
      loadAgent: async () => {
        throw new Error('Unexpected agent read');
      },
      listAgentsForWorkflow: async () => {
        throw new Error('Unexpected scoped agent list');
      },
      listAgentsForInterview: async () => success([agent]),
    },
    consistency: {
      loadContradiction: async () => {
        throw new Error('Unexpected contradiction read');
      },
      listContradictions: async () => success([]),
    },
    finalizations: { loadLatest: async () => success(null) },
    evaluations: {
      loadRun: async () => {
        throw new Error('Unexpected evaluation run read');
      },
      findRunByProfile: async () => {
        throw new Error('Unexpected profile evaluation read');
      },
    },
    evaluationProfiles: {
      list: async () => success([]),
      load: async () => {
        throw new Error('Unexpected evaluation profile read');
      },
      loadDefault: async () => {
        throw new Error('Unexpected default evaluation profile read');
      },
    },
    outbox: {
      highWater: async () => success(7),
      loadLiveState: async () => success({ voiceState: 'idle' as const, activeAiTextStream: null }),
      replay: async () => {
        throw new Error('Unexpected replay');
      },
    },
    jobs: {
      load: async () => {
        throw new Error('Unexpected job read');
      },
    },
    ...overrides,
  };
}

describe('GetMonitoringSnapshotService', () => {
  it('accepts agent input from the workflow activation state version', () => {
    const result = projectMonitoringSnapshot(
      {
        ...source,
        agentRuns: [activatedWorkflowAgent],
      },
      NOW,
    );

    expect(result.ok).toBe(true);
  });

  it('preserves the persisted English guide language in the monitoring snapshot', () => {
    const result = projectMonitoringSnapshot(
      {
        ...source,
        guide: { ...guide, sourceLanguage: 'en' },
        interview: { ...interview, language: 'en' },
      },
      NOW,
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        interviewGuide: { sourceLanguage: 'en' },
        interviewState: { language: 'en' },
      },
    });
  });

  it('projects the complete read model with one unit-of-work snapshot and high-water cursor', async () => {
    const unitOfWork = new SnapshotUnitOfWork(snapshotContext());
    const result = await new GetMonitoringSnapshotService(unitOfWork, {
      now: () => NOW,
    }).execute(INTERVIEW_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      interviewState: { interviewId: INTERVIEW_ID, guideId: GUIDE_ID },
      transcript: { interviewId: INTERVIEW_ID, guideId: GUIDE_ID, finalizedAt: null },
      workflowRuns: [{ workflowRunId: WORKFLOW_ID, status: 'running' }],
      workflowSteps: [{ run: { stepRunId: 'step-1', inputAvailable: true } }],
      agentRuns: [{ run: { agentRunId: 'agent-1', agentName: 'coverage_analysis' } }],
      liveState: { voiceState: 'idle', activeAiTextStream: null },
      eventSequence: 7,
      capturedAt: NOW,
    });
    expect(unitOfWork.reads).toBe(1);
  });

  it('loads live state through the captured high-water mark in the same read snapshot', async () => {
    const requestedBoundaries: number[] = [];
    const liveState = {
      voiceState: 'speaking' as const,
      activeAiTextStream: {
        interviewId: INTERVIEW_ID,
        runId: 'run-ai-1',
        utteranceId: 'utterance-ai-1',
        turnId: 'turn-ai-1',
        startedAt: NOW,
        lastDeltaSequenceNumber: 1,
        generatedText: 'Welche Rolle?',
      },
    };
    const unitOfWork = new SnapshotUnitOfWork(
      snapshotContext({
        outbox: {
          highWater: async () => success(12),
          loadLiveState: async (_interviewId, throughSequence) => {
            requestedBoundaries.push(throughSequence);
            return success(liveState);
          },
          replay: async () => {
            throw new Error('Unexpected replay');
          },
        },
      }),
    );

    const result = await new GetMonitoringSnapshotService(unitOfWork, {
      now: () => NOW,
    }).execute(INTERVIEW_ID);

    expect(result).toMatchObject({
      ok: true,
      value: { liveState, eventSequence: 12 },
    });
    expect(requestedBoundaries).toEqual([12]);
    expect(unitOfWork.reads).toBe(1);
  });

  it('fails closed when a persisted run is scoped to another interview', () => {
    const projected = projectMonitoringSnapshot(
      {
        ...source,
        agentRuns: [{ ...agent, interviewId: 'interview-other' }],
      },
      NOW,
    );

    expect(projected).toEqual({
      ok: false,
      error: {
        code: 'application_invariant',
        resource: 'monitoring_snapshot',
        id: INTERVIEW_ID,
        message: 'Persisted monitoring state does not satisfy the shared snapshot contract',
      },
    });
  });

  it('does not open a database read when the runtime clock is invalid', async () => {
    const unitOfWork = new SnapshotUnitOfWork(snapshotContext());
    const result = await new GetMonitoringSnapshotService(unitOfWork, {
      now: () => 'invalid',
    }).execute(INTERVIEW_ID);

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'runtime_dependency_invalid', dependency: 'clock' },
    });
    expect(unitOfWork.reads).toBe(0);
  });
});
