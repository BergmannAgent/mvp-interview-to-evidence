import { describe, expect, it } from 'vitest';

import {
  apiErrorEnvelopeSchema,
  monitoringAgentRunSchema,
  monitoringEventCursorSchema,
  monitoringSnapshotSchema,
  monitoringSseEventFrameSchema,
  monitoringSseFaultFrameSchema,
  monitoringSseReadyFrameSchema,
  monitoringStreamFaultSchema,
  monitoringStreamQuerySchema,
  monitoringStreamReadySchema,
  monitoringWorkflowRunSchema,
  monitoringWorkflowStepSchema,
  type GuideQuestionReference,
} from '../src/index.js';

const NOW = '2026-08-12T08:00:00.000Z';
const LATER = '2026-08-12T08:00:01.000Z';
const IDS = {
  guide: 'guide-1',
  section: 'section-1',
  question: 'question-1',
  interview: 'interview-1',
  workflow: 'workflow-1',
  attempt: 'attempt-1',
  job: 'job-1',
  step: 'step-1',
  agent: 'agent-1',
  request: 'request-1',
} as const;

const guideReference = {
  kind: 'main_question',
  guideId: IDS.guide,
  sectionId: IDS.section,
  mainQuestionId: IDS.question,
} as const;

const snapshot = {
  interviewGuide: {
    id: IDS.guide,
    title: 'Interviewleitfaden',
    sections: [
      {
        id: IDS.section,
        position: 0,
        title: 'Einfuehrung',
        mainQuestions: [
          {
            id: IDS.question,
            position: 0,
            text: 'Welche Rolle haben Sie?',
            followUpQuestions: [],
          },
        ],
      },
    ],
  },
  interviewState: {
    interviewId: IDS.interview,
    guideId: IDS.guide,
    lifecycle: { status: 'ready' },
    currentMainQuestion: null,
    coverage: [
      {
        question: guideReference,
        status: 'not_addressed',
        transcriptTurnIds: [],
      },
    ],
    activeWorkflowRunId: null,
    version: 0,
    createdAt: NOW,
    updatedAt: NOW,
  },
  transcript: {
    interviewId: IDS.interview,
    guideId: IDS.guide,
    entries: [],
    finalizedAt: null,
  },
  partialTranscriptions: [],
  finalTranscriptions: [],
  workflowRuns: [],
  workflowSteps: [],
  agentRuns: [],
  contradictions: [],
  finalization: null,
  liveState: { voiceState: 'idle', activeAiTextStream: null },
  eventSequence: 1,
  capturedAt: NOW,
} as const;

describe('monitoring realtime contracts', () => {
  it('normalizes canonical decimal cursors and rejects ambiguous or unsafe values', () => {
    expect(monitoringEventCursorSchema.parse(0)).toBe(0);
    expect(monitoringEventCursorSchema.parse('42')).toBe(42);
    expect(monitoringStreamQuerySchema.parse({})).toEqual({ afterSequence: 0 });
    expect(monitoringStreamQuerySchema.parse({ afterSequence: '12' })).toEqual({
      afterSequence: 12,
    });

    for (const invalid of ['', '-1', '+1', '01', '1.0', '9007199254740992', -1, 1.5]) {
      expect(monitoringEventCursorSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('requires a ready frame cursor at or below the captured replay high-water mark', () => {
    const ready = {
      type: 'monitoring.ready',
      interviewId: IDS.interview,
      afterSequence: 3,
      replayThroughSequence: 5,
      connectedAt: NOW,
      retryMs: 1_000,
    } as const;
    expect(monitoringStreamReadySchema.safeParse(ready).success).toBe(true);
    expect(
      monitoringStreamReadySchema.safeParse({
        ...ready,
        afterSequence: 6,
      }).success,
    ).toBe(false);
  });

  it('keeps stream faults strict and free of internal diagnostic fields', () => {
    const fault = {
      type: 'monitoring.stream_fault',
      interviewId: IDS.interview,
      reason: 'storage_unavailable',
      highWaterSequence: null,
      retryable: true,
      occurredAt: NOW,
    } as const;
    expect(monitoringStreamFaultSchema.safeParse(fault).success).toBe(true);
    expect(
      monitoringStreamFaultSchema.safeParse({ ...fault, stack: 'private stack trace' }).success,
    ).toBe(false);
  });

  it('uses the canonical event sequence as the only resumable SSE event ID', () => {
    const event = {
      eventId: 'event-7',
      interviewId: IDS.interview,
      runId: 'run-7',
      sequenceNumber: 7,
      occurredAt: NOW,
      category: 'interview',
      type: 'interview.status_changed',
      payload: {
        previousStatus: 'ready',
        nextStatus: 'active',
        changedAt: NOW,
      },
    } as const;

    expect(
      monitoringSseEventFrameSchema.safeParse({ event: 'monitoring', id: '7', data: event })
        .success,
    ).toBe(true);
    for (const invalidId of ['07', '8', event.eventId]) {
      expect(
        monitoringSseEventFrameSchema.safeParse({
          event: 'monitoring',
          id: invalidId,
          data: event,
        }).success,
      ).toBe(false);
    }
  });

  it('keeps ready and fault control frames non-resumable and schema bounded', () => {
    const ready = {
      event: 'ready',
      data: {
        type: 'monitoring.ready',
        interviewId: IDS.interview,
        afterSequence: 3,
        replayThroughSequence: 5,
        connectedAt: NOW,
        retryMs: 1_000,
      },
    } as const;
    const fault = {
      event: 'fault',
      data: {
        type: 'monitoring.stream_fault',
        interviewId: IDS.interview,
        reason: 'server_shutdown',
        highWaterSequence: 5,
        retryable: true,
        occurredAt: NOW,
      },
    } as const;

    expect(monitoringSseReadyFrameSchema.safeParse(ready).success).toBe(true);
    expect(monitoringSseFaultFrameSchema.safeParse(fault).success).toBe(true);
    expect(monitoringSseReadyFrameSchema.safeParse({ ...ready, id: '5' }).success).toBe(false);
    expect(monitoringSseFaultFrameSchema.safeParse({ ...fault, id: '5' }).success).toBe(false);
  });

  it('validates an interview-scoped snapshot and rejects mixed interview data', () => {
    expect(monitoringSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(
      monitoringSnapshotSchema.safeParse({
        ...snapshot,
        transcript: { ...snapshot.transcript, interviewId: 'interview-2' },
      }).success,
    ).toBe(false);
    expect(
      monitoringSnapshotSchema.safeParse({
        ...snapshot,
        transcript: { ...snapshot.transcript, finalizedAt: LATER },
      }).success,
    ).toBe(false);
  });

  it('bounds an active AI text projection and keeps it scoped to the snapshot interview', () => {
    const activeAiTextStream = {
      interviewId: IDS.interview,
      runId: 'run-ai-1',
      utteranceId: 'utterance-ai-1',
      turnId: 'turn-ai-1',
      startedAt: NOW,
      lastDeltaSequenceNumber: 1,
      generatedText: 'Welche Rolle?',
    } as const;
    const active = {
      ...snapshot,
      liveState: { voiceState: 'speaking', activeAiTextStream },
    } as const;

    expect(monitoringSnapshotSchema.safeParse(active).success).toBe(true);
    expect(
      monitoringSnapshotSchema.safeParse({
        ...active,
        liveState: {
          ...active.liveState,
          activeAiTextStream: { ...activeAiTextStream, interviewId: 'interview-other' },
        },
      }).success,
    ).toBe(false);
    expect(
      monitoringSnapshotSchema.safeParse({
        ...active,
        liveState: {
          ...active.liveState,
          activeAiTextStream: { ...activeAiTextStream, lastDeltaSequenceNumber: 0 },
        },
      }).success,
    ).toBe(false);
    expect(
      monitoringSnapshotSchema.safeParse({
        ...active,
        liveState: {
          ...active.liveState,
          activeAiTextStream: {
            ...activeAiTextStream,
            generatedText: '',
          },
        },
      }).success,
    ).toBe(false);
  });

  it('scopes partial and final segment identities to their STT provider', () => {
    const partial = transcriptSegmentFixture('partial', 'provider-a');
    const partialFromAnotherProvider = transcriptSegmentFixture('partial', 'provider-b');
    const final = transcriptSegmentFixture('final', 'provider-a');
    const finalFromAnotherProvider = transcriptSegmentFixture('final', 'provider-b');
    const providerScopedSnapshot = {
      ...snapshot,
      transcript: {
        ...snapshot.transcript,
        entries: [participantTurnFixture('provider-a', 1), participantTurnFixture('provider-b', 2)],
      },
      partialTranscriptions: [
        { ...partial, segmentId: 'partial-shared', utteranceId: 'partial-utterance' },
        {
          ...partialFromAnotherProvider,
          segmentId: 'partial-shared',
          utteranceId: 'partial-utterance',
        },
      ],
      finalTranscriptions: [final, finalFromAnotherProvider],
    } as const;

    expect(monitoringSnapshotSchema.safeParse(providerScopedSnapshot).success).toBe(true);
    expect(
      monitoringSnapshotSchema.safeParse({
        ...providerScopedSnapshot,
        partialTranscriptions: [partial, partial],
      }).success,
    ).toBe(false);
    expect(
      monitoringSnapshotSchema.safeParse({
        ...providerScopedSnapshot,
        partialTranscriptions: [partial],
      }).success,
    ).toBe(false);
    expect(
      monitoringSnapshotSchema.safeParse({
        ...providerScopedSnapshot,
        partialTranscriptions: [
          {
            ...partial,
            segmentId: 'partial-distinct-segment',
            utteranceId: 'partial-distinct-utterance',
            providerEventId: final.providerEventId,
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      monitoringSnapshotSchema.safeParse({
        ...providerScopedSnapshot,
        finalTranscriptions: [final, final],
      }).success,
    ).toBe(false);
    expect(
      monitoringSnapshotSchema.safeParse({
        ...providerScopedSnapshot,
        transcript: snapshot.transcript,
      }).success,
    ).toBe(false);
    expect(
      monitoringSnapshotSchema.safeParse({
        ...providerScopedSnapshot,
        finalTranscriptions: [final],
      }).success,
    ).toBe(false);
    expect(
      monitoringSnapshotSchema.safeParse({
        ...providerScopedSnapshot,
        finalTranscriptions: [{ ...final, text: 'Abweichender Text' }, finalFromAnotherProvider],
      }).success,
    ).toBe(false);

    expect(
      monitoringSnapshotSchema.safeParse({
        ...snapshot,
        partialTranscriptions: [
          {
            ...partial,
            segmentId: 'segment-partial-1',
            providerEventId: 'provider-event-partial-1',
            utteranceId: 'utterance-shared',
          },
          {
            ...partial,
            segmentId: 'segment-partial-2',
            providerEventId: 'provider-event-partial-2',
            utteranceId: 'utterance-shared',
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('ties workflow, step, and agent details to validated timing and output metadata', () => {
    const workflow = {
      interviewId: IDS.interview,
      workflowRunId: IDS.workflow,
      attemptId: IDS.attempt,
      jobId: IDS.job,
      expectedInterviewStateVersion: 0,
      attemptNumber: 1,
      status: 'running',
      retryCount: 0,
      startedAt: NOW,
      endedAt: null,
      durationMs: null,
      failure: null,
      rejectionReason: null,
      appliedAt: null,
    } as const;
    expect(monitoringWorkflowRunSchema.safeParse(workflow).success).toBe(true);
    expect(
      monitoringWorkflowRunSchema.safeParse({
        ...workflow,
        status: 'failed',
        endedAt: LATER,
        durationMs: 1_000,
      }).success,
    ).toBe(false);

    const step = {
      interviewId: IDS.interview,
      attemptId: IDS.attempt,
      attemptNumber: 1,
      agentRunId: null,
      run: {
        stepRunId: IDS.step,
        workflowRunId: IDS.workflow,
        step: 'coverage_analysis',
        status: 'running',
        startedAt: NOW,
        endedAt: null,
        durationMs: null,
        retryCount: 0,
        errorCode: null,
        inputAvailable: true,
        outputAvailable: false,
      },
      input: {
        referencedTranscriptTurnIds: [],
        referencedGuideQuestionIds: [IDS.question],
      },
      structuredOutput: null,
      failure: null,
    } as const;
    expect(monitoringWorkflowStepSchema.safeParse(step).success).toBe(true);
    expect(
      monitoringWorkflowStepSchema.safeParse({
        ...step,
        run: { ...step.run, outputAvailable: true },
      }).success,
    ).toBe(false);

    const agent = {
      interviewId: IDS.interview,
      attemptId: IDS.attempt,
      invocationNumber: 1,
      run: {
        agentRunId: IDS.agent,
        workflowRunId: IDS.workflow,
        agentName: 'coverage_analysis',
        status: 'running',
        startedAt: NOW,
        endedAt: null,
        durationMs: null,
        retryCount: 0,
        errorCode: null,
        model: { mode: 'demo', provider: null, model: null },
      },
      input: {
        interviewStateVersion: 0,
        transcriptTurnIds: [],
        canonicalEntryIds: [],
        guideQuestionIds: [IDS.question],
      },
      structuredOutput: null,
      failure: null,
    } as const;
    expect(monitoringAgentRunSchema.safeParse(agent).success).toBe(true);
  });

  it('rejects broken snapshot run relationships and unresolved evidence references', () => {
    const workflow = workflowFixture();
    const step = workflowStepFixture();
    const agent = agentRunFixture();
    const valid = {
      ...snapshot,
      workflowRuns: [workflow],
      workflowSteps: [step],
      agentRuns: [agent],
    } as const;

    expect(monitoringSnapshotSchema.safeParse(valid).success).toBe(true);
    expect(
      monitoringSnapshotSchema.safeParse({
        ...valid,
        workflowRuns: [workflow, workflow],
      }).success,
    ).toBe(false);
    expect(
      monitoringSnapshotSchema.safeParse({
        ...valid,
        workflowSteps: [{ ...step, attemptId: 'attempt-other' }],
      }).success,
    ).toBe(false);
    expect(
      monitoringSnapshotSchema.safeParse({
        ...valid,
        workflowSteps: [
          {
            ...step,
            input: { ...step.input, referencedGuideQuestionIds: ['question-missing'] },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      monitoringSnapshotSchema.safeParse({
        ...valid,
        agentRuns: [
          {
            ...agent,
            input: { ...agent.input, transcriptTurnIds: ['turn-missing'] },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      monitoringSnapshotSchema.safeParse({
        ...valid,
        agentRuns: [
          {
            ...agent,
            input: { ...agent.input, interviewStateVersion: 1 },
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      monitoringSnapshotSchema.safeParse({
        ...valid,
        agentRuns: [
          {
            ...agent,
            input: { ...agent.input, interviewStateVersion: 2 },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('binds agent workflow-step outputs to the same guide, attempt, and result', () => {
    const workflow = workflowFixture();
    const output = coverageOutputFixture(guideReference);
    const step = succeededWorkflowStepFixture(output);
    const agent = succeededAgentRunFixture(output);
    const valid = {
      ...snapshot,
      workflowRuns: [workflow],
      workflowSteps: [step],
      agentRuns: [agent],
    } as const;

    expect(monitoringSnapshotSchema.safeParse(valid).success).toBe(true);
    expect(monitoringSnapshotSchema.safeParse({ ...valid, agentRuns: [] }).success).toBe(false);
    const identicalAlternative = {
      ...agent,
      invocationNumber: 2,
      run: { ...agent.run, agentRunId: 'agent-alternative' },
    } as const;
    expect(
      monitoringSnapshotSchema.safeParse({
        ...valid,
        agentRuns: [agent, identicalAlternative],
      }).success,
    ).toBe(true);
    expect(
      monitoringSnapshotSchema.safeParse({
        ...valid,
        workflowSteps: [{ ...step, agentRunId: 'agent-missing' }],
        agentRuns: [agent, identicalAlternative],
      }).success,
    ).toBe(false);
    expect(
      monitoringSnapshotSchema.safeParse({
        ...valid,
        workflowSteps: [
          {
            ...step,
            structuredOutput: coverageOutputFixture(guideReference, 'Andere Begruendung.'),
          },
        ],
      }).success,
    ).toBe(false);

    const foreignOutput = coverageOutputFixture({
      ...guideReference,
      guideId: 'guide-foreign',
    });
    expect(
      monitoringSnapshotSchema.safeParse({
        ...snapshot,
        workflowRuns: [workflow],
        agentRuns: [succeededAgentRunFixture(foreignOutput)],
      }).success,
    ).toBe(false);
    expect(
      monitoringWorkflowStepSchema.safeParse({
        ...step,
        structuredOutput: {
          agentName: 'consistency_analysis',
          output: {
            contradictions: [],
            referencedTranscriptTurnIds: [],
            rationale: 'Keine Widersprueche.',
          },
        },
      }).success,
    ).toBe(false);
  });

  it('exposes an explicit snapshot-reset API code without weakening the envelope', () => {
    expect(
      apiErrorEnvelopeSchema.safeParse({
        error: {
          code: 'SNAPSHOT_RESET_REQUIRED',
          message: 'Refresh the monitoring snapshot.',
          requestId: IDS.request,
          occurredAt: NOW,
          retryable: false,
          fieldErrors: [],
        },
      }).success,
    ).toBe(true);
  });
});

function workflowFixture() {
  return {
    interviewId: IDS.interview,
    workflowRunId: IDS.workflow,
    attemptId: IDS.attempt,
    jobId: IDS.job,
    expectedInterviewStateVersion: 0,
    attemptNumber: 1,
    status: 'running',
    retryCount: 0,
    startedAt: NOW,
    endedAt: null,
    durationMs: null,
    failure: null,
    rejectionReason: null,
    appliedAt: null,
  } as const;
}

function transcriptSegmentFixture(status: 'partial' | 'final', provider: string) {
  const common = {
    segmentId: 'segment-shared',
    interviewId: IDS.interview,
    provider,
    providerEventId:
      status === 'partial' ? `partial-provider-event-${provider}` : `provider-event-${provider}`,
    utteranceId: `utterance-${provider}`,
    speaker: 'participant',
    text: 'Eine Antwort',
    observedAt: NOW,
  } as const;
  return status === 'partial'
    ? { ...common, status, revision: 0 }
    : { ...common, status, finalizedAt: LATER };
}

function participantTurnFixture(provider: string, sequenceNumber: number) {
  return {
    kind: 'turn',
    turnId: `turn-${provider}`,
    interviewId: IDS.interview,
    sequenceNumber,
    speaker: 'participant',
    text: 'Eine Antwort',
    occurredAt: NOW,
    turnType: 'participant_answer',
    guideReference: null,
    sourceProvider: provider,
    providerEventId: `provider-event-${provider}`,
    sourceSegmentId: 'segment-shared',
  } as const;
}

function workflowStepFixture() {
  return {
    interviewId: IDS.interview,
    attemptId: IDS.attempt,
    attemptNumber: 1,
    agentRunId: null,
    run: {
      stepRunId: IDS.step,
      workflowRunId: IDS.workflow,
      step: 'coverage_analysis',
      status: 'running',
      startedAt: NOW,
      endedAt: null,
      durationMs: null,
      retryCount: 0,
      errorCode: null,
      inputAvailable: true,
      outputAvailable: false,
    },
    input: {
      referencedTranscriptTurnIds: [],
      referencedGuideQuestionIds: [IDS.question],
    },
    structuredOutput: null,
    failure: null,
  } as const;
}

function agentRunFixture() {
  return {
    interviewId: IDS.interview,
    attemptId: IDS.attempt,
    invocationNumber: 1,
    run: {
      agentRunId: IDS.agent,
      workflowRunId: IDS.workflow,
      agentName: 'coverage_analysis',
      status: 'running',
      startedAt: NOW,
      endedAt: null,
      durationMs: null,
      retryCount: 0,
      errorCode: null,
      model: { mode: 'demo', provider: null, model: null },
    },
    input: {
      interviewStateVersion: 0,
      transcriptTurnIds: [],
      canonicalEntryIds: [],
      guideQuestionIds: [IDS.question],
    },
    structuredOutput: null,
    failure: null,
  } as const;
}

function coverageOutputFixture(
  question: GuideQuestionReference,
  rationale = 'Die Frage wurde noch nicht behandelt.',
) {
  return {
    agentName: 'coverage_analysis',
    output: {
      findings: [
        {
          question,
          status: 'not_addressed',
          transcriptTurnIds: [],
          openAspects: ['Eine Antwort fehlt.'],
          rationale,
        },
      ],
      referencedTranscriptTurnIds: [],
      rationale,
    },
  } as const;
}

function succeededWorkflowStepFixture(output: ReturnType<typeof coverageOutputFixture>) {
  const step = workflowStepFixture();
  return {
    ...step,
    agentRunId: IDS.agent,
    run: {
      ...step.run,
      status: 'succeeded',
      endedAt: LATER,
      durationMs: 1_000,
      outputAvailable: true,
    },
    structuredOutput: output,
  } as const;
}

function succeededAgentRunFixture(output: ReturnType<typeof coverageOutputFixture>) {
  const agent = agentRunFixture();
  return {
    ...agent,
    run: {
      ...agent.run,
      status: 'succeeded',
      endedAt: LATER,
      durationMs: 1_000,
    },
    structuredOutput: output,
  } as const;
}
