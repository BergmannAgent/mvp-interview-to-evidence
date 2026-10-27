import { z } from 'zod';
import { voiceDiagnosticSchema } from './voice-diagnostic.js';

import { agentNameSchema, structuredAgentOutputSchema } from './agents.js';
import { interviewStateSchema, interviewStatusSchema } from './interview.js';
import { DEFAULT_LOCALE, supportedLocaleSchema } from './locale.js';
import {
  canonicalTranscriptTurnSchema,
  finalTranscriptSegmentSchema,
  partialTranscriptTextSchema,
  partialTranscriptSegmentSchema,
  transcriptTextSchema,
  transcriptTechnicalGapSchema,
} from './transcript.js';
import {
  idSchema,
  nonBlankTextSchema,
  sequenceNumberSchema,
  timestampSchema,
} from './primitives.js';

export const monitoringEventCategorySchema = z.enum([
  'interview',
  'workflow',
  'agent',
  'transcript',
  'voice',
  'error',
  'retry',
  'state_update',
]);

export const workflowStepNameSchema = z.enum([
  'receive_user_turn',
  'finalize_user_turn',
  'load_interview_state',
  'coverage_analysis',
  'consistency_analysis',
  'interview_decision',
  'conductor_question_generation',
  'validation',
  'persistence',
  'text_streaming',
  'audio_streaming',
  'state_update',
]);

export const runStatusSchema = z.enum([
  'waiting',
  'running',
  'succeeded',
  'failed',
  'retrying',
  'skipped',
]);

export const modelMetadataSchema = z.strictObject({
  mode: z.enum(['demo', 'provider']),
  provider: nonBlankTextSchema.max(100).nullable(),
  model: nonBlankTextSchema.max(200).nullable(),
});

export const monitoringAgentInputSchema = z
  .strictObject({
    interviewStateVersion: z.number().int().nonnegative(),
    transcriptTurnIds: z.array(idSchema),
    canonicalEntryIds: z.array(idSchema),
    guideQuestionIds: z.array(idSchema),
  })
  .superRefine((input, context) => {
    for (const field of ['transcriptTurnIds', 'canonicalEntryIds', 'guideQuestionIds'] as const) {
      if (new Set(input[field]).size !== input[field].length) {
        addIdentityIssue(context, [field], 'Monitoring agent input references must be unique');
      }
    }
  });

const timedRunShape = {
  status: runStatusSchema,
  startedAt: timestampSchema.nullable(),
  endedAt: timestampSchema.nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  retryCount: z.number().int().nonnegative(),
  errorCode: nonBlankTextSchema.max(100).nullable(),
};

export const workflowStepRunSchema = z
  .strictObject({
    stepRunId: idSchema,
    workflowRunId: idSchema,
    step: workflowStepNameSchema,
    ...timedRunShape,
    inputAvailable: z.boolean(),
    outputAvailable: z.boolean(),
  })
  .superRefine(validateTimedRun);

export const agentRunMetadataSchema = z
  .strictObject({
    agentRunId: idSchema,
    workflowRunId: idSchema,
    agentName: agentNameSchema,
    ...timedRunShape,
    model: modelMetadataSchema,
  })
  .superRefine(validateTimedRun);

const monitoringBaseShape = {
  eventId: idSchema,
  interviewId: idSchema,
  language: supportedLocaleSchema.default(DEFAULT_LOCALE),
  runId: idSchema,
  sequenceNumber: sequenceNumberSchema,
  occurredAt: timestampSchema,
};

const interviewEventSchema = z.strictObject({
  ...monitoringBaseShape,
  category: z.literal('interview'),
  type: z.literal('interview.status_changed'),
  payload: z.strictObject({
    previousStatus: interviewStatusSchema.nullable(),
    nextStatus: interviewStatusSchema,
    changedAt: timestampSchema,
  }),
});

const interviewSectionCompactedEventSchema = z.strictObject({
  ...monitoringBaseShape,
  category: z.literal('interview'),
  type: z.literal('interview.section_compacted'),
  payload: z.strictObject({
    guideId: idSchema,
    sectionId: idSchema,
    sectionTitle: nonBlankTextSchema.max(300),
    sourceThroughSequenceNumber: sequenceNumberSchema,
    factCount: z.number().int().nonnegative(),
    compactedAt: timestampSchema,
  }),
});

const workflowStartedEventSchema = z
  .strictObject({
    ...monitoringBaseShape,
    category: z.literal('workflow'),
    type: z.literal('workflow.started'),
    payload: z.strictObject({
      workflowRunId: idSchema,
      status: z.literal('running'),
      startedAt: timestampSchema,
      endedAt: z.null(),
      durationMs: z.null(),
      errorCode: z.null(),
    }),
  })
  .superRefine(validateWorkflowRunIdentity);

const workflowCompletedEventSchema = z
  .strictObject({
    ...monitoringBaseShape,
    category: z.literal('workflow'),
    type: z.literal('workflow.completed'),
    payload: z.strictObject({
      workflowRunId: idSchema,
      status: z.literal('succeeded'),
      startedAt: timestampSchema,
      endedAt: timestampSchema,
      durationMs: z.number().int().nonnegative(),
      errorCode: z.null(),
    }),
  })
  .superRefine(validateWorkflowRunIdentity);

const workflowFailedEventSchema = z
  .strictObject({
    ...monitoringBaseShape,
    category: z.literal('workflow'),
    type: z.literal('workflow.failed'),
    payload: z.strictObject({
      workflowRunId: idSchema,
      status: z.literal('failed'),
      startedAt: timestampSchema,
      endedAt: timestampSchema,
      durationMs: z.number().int().nonnegative(),
      errorCode: nonBlankTextSchema.max(100),
    }),
  })
  .superRefine(validateWorkflowRunIdentity);

const workflowStepEventSchema = z
  .strictObject({
    ...monitoringBaseShape,
    category: z.literal('workflow'),
    type: z.enum(['workflow.step_started', 'workflow.step_completed', 'workflow.step_failed']),
    payload: workflowStepRunSchema,
  })
  .superRefine((event, context) => {
    if (event.runId !== event.payload.stepRunId) {
      addIdentityIssue(context, ['runId'], 'runId must identify the workflow step run');
    }
    const expectedStatus = {
      'workflow.step_started': 'running',
      'workflow.step_completed': 'succeeded',
      'workflow.step_failed': 'failed',
    } as const;
    if (event.payload.status !== expectedStatus[event.type]) {
      addIdentityIssue(context, ['payload', 'status'], 'Event type and step status do not match');
    }
  });

const agentStartedEventSchema = z
  .strictObject({
    ...monitoringBaseShape,
    category: z.literal('agent'),
    type: z.literal('agent.started'),
    payload: z.strictObject({
      run: agentRunMetadataSchema,
      input: monitoringAgentInputSchema,
    }),
  })
  .superRefine((event, context) => {
    validateAgentRunEvent(event, 'running', context);
  });

const agentCompletedEventSchema = z
  .strictObject({
    ...monitoringBaseShape,
    category: z.literal('agent'),
    type: z.literal('agent.completed'),
    payload: z.strictObject({
      run: agentRunMetadataSchema,
      result: structuredAgentOutputSchema,
    }),
  })
  .superRefine((event, context) => {
    validateAgentRunEvent(event, 'succeeded', context);
    if (event.payload.run.agentName !== event.payload.result.agentName) {
      addIdentityIssue(
        context,
        ['payload', 'result', 'agentName'],
        'Agent run and structured output must identify the same agent',
      );
    }
  });

const agentFailedEventSchema = z
  .strictObject({
    ...monitoringBaseShape,
    category: z.literal('agent'),
    type: z.literal('agent.failed'),
    payload: z.strictObject({
      run: agentRunMetadataSchema,
      errorCode: nonBlankTextSchema.max(100),
      message: nonBlankTextSchema.max(1_000),
      retryable: z.boolean(),
    }),
  })
  .superRefine((event, context) => {
    validateAgentRunEvent(event, 'failed', context);
    if (event.payload.run.errorCode !== event.payload.errorCode) {
      addIdentityIssue(
        context,
        ['payload', 'errorCode'],
        'The agent error payload must match the run error code',
      );
    }
  });

const partialTranscriptEventSchema = z
  .strictObject({
    ...monitoringBaseShape,
    category: z.literal('transcript'),
    type: z.literal('transcript.partial_received'),
    payload: partialTranscriptSegmentSchema,
  })
  .superRefine(validateTranscriptPayloadIdentity);

const finalTranscriptSegmentEventSchema = z
  .strictObject({
    ...monitoringBaseShape,
    category: z.literal('transcript'),
    type: z.literal('transcript.final_received'),
    payload: finalTranscriptSegmentSchema,
  })
  .superRefine(validateTranscriptPayloadIdentity);

const canonicalTurnEventSchema = z
  .strictObject({
    ...monitoringBaseShape,
    category: z.literal('transcript'),
    type: z.literal('transcript.turn_persisted'),
    payload: canonicalTranscriptTurnSchema,
  })
  .superRefine(validateTranscriptPayloadIdentity);

const technicalGapPersistedEventSchema = z
  .strictObject({
    ...monitoringBaseShape,
    category: z.literal('transcript'),
    type: z.literal('transcript.gap_persisted'),
    payload: transcriptTechnicalGapSchema,
  })
  .superRefine(validateTranscriptPayloadIdentity);

const transcriptFinalizedEventSchema = z.strictObject({
  ...monitoringBaseShape,
  category: z.literal('transcript'),
  type: z.literal('transcript.finalized'),
  payload: z.strictObject({
    entryCount: z.number().int().nonnegative(),
    technicalGapCount: z.number().int().nonnegative(),
    finalizedAt: timestampSchema,
  }),
});

const aiTextStreamBaseShape = {
  utteranceId: idSchema,
  turnId: idSchema,
};

const aiTextStreamStartedEventSchema = z.strictObject({
  ...monitoringBaseShape,
  category: z.literal('transcript'),
  type: z.literal('transcript.ai_text_stream_started'),
  payload: z.strictObject({
    ...aiTextStreamBaseShape,
    nextDeltaSequenceNumber: z.literal(1),
    startedAt: timestampSchema,
  }),
});

const aiTextDeltaEventSchema = z.strictObject({
  ...monitoringBaseShape,
  category: z.literal('transcript'),
  type: z.literal('transcript.ai_text_delta'),
  payload: z.strictObject({
    ...aiTextStreamBaseShape,
    deltaSequenceNumber: sequenceNumberSchema,
    textDelta: z.string().min(1).max(4_000),
  }),
});

const aiTextStreamCompletedEventSchema = z.strictObject({
  ...monitoringBaseShape,
  category: z.literal('transcript'),
  type: z.literal('transcript.ai_text_stream_completed'),
  payload: z.strictObject({
    ...aiTextStreamBaseShape,
    lastDeltaSequenceNumber: z.number().int().nonnegative(),
    generatedText: transcriptTextSchema,
    confirmedSpokenText: transcriptTextSchema,
    completedAt: timestampSchema,
  }),
});

const aiTextStreamInterruptedEventSchema = z
  .strictObject({
    ...monitoringBaseShape,
    category: z.literal('transcript'),
    type: z.literal('transcript.ai_text_stream_interrupted'),
    payload: z.strictObject({
      ...aiTextStreamBaseShape,
      lastDeltaSequenceNumber: z.number().int().nonnegative(),
      generatedText: transcriptTextSchema,
      confirmedSpokenText: partialTranscriptTextSchema,
      interruptedAt: timestampSchema,
    }),
  })
  .superRefine((event, context) => {
    if (!event.payload.generatedText.startsWith(event.payload.confirmedSpokenText)) {
      addIdentityIssue(
        context,
        ['payload', 'confirmedSpokenText'],
        'Interrupted spoken text must be an exact prefix of generated text',
      );
    }
  });

export const voiceStateSchema = z.enum([
  'idle',
  'listening',
  'processing',
  'speaking',
  'interrupted',
  'failed',
]);

const voiceEventSchema = z
  .strictObject({
    ...monitoringBaseShape,
    category: z.literal('voice'),
    type: z.enum([
      'voice.state_changed',
      'voice.playback_started',
      'voice.playback_completed',
      'voice.playback_interrupted',
    ]),
    payload: z.strictObject({
      previousState: voiceStateSchema,
      nextState: voiceStateSchema,
      utteranceId: idSchema.nullable(),
      turnId: idSchema.nullable(),
      provider: nonBlankTextSchema.max(100),
    }),
  })
  .superRefine((event, context) => {
    const requiresUtterance = event.type !== 'voice.state_changed';
    if (
      requiresUtterance &&
      (event.payload.utteranceId === null || event.payload.turnId === null)
    ) {
      addIdentityIssue(
        context,
        ['payload', 'utteranceId'],
        'Playback events require utterance and turn identities',
      );
    }

    const expectedTransition = {
      'voice.playback_started': { nextState: 'speaking' },
      'voice.playback_completed': { previousState: 'speaking', nextState: 'listening' },
      'voice.playback_interrupted': { previousState: 'speaking', nextState: 'interrupted' },
    } as const;
    if (event.type === 'voice.state_changed') {
      const allowedStateChanges: Readonly<
        Record<z.infer<typeof voiceStateSchema>, ReadonlySet<z.infer<typeof voiceStateSchema>>>
      > = {
        idle: new Set(['listening', 'processing', 'failed']),
        listening: new Set(['processing', 'failed']),
        processing: new Set(['speaking', 'failed']),
        speaking: new Set(['listening', 'interrupted', 'failed']),
        interrupted: new Set(['listening', 'processing', 'failed']),
        failed: new Set(['idle']),
      };
      if (!allowedStateChanges[event.payload.previousState].has(event.payload.nextState)) {
        addIdentityIssue(
          context,
          ['payload', 'nextState'],
          'This voice state transition is invalid',
        );
      }
      return;
    }

    const expected = expectedTransition[event.type];
    if (
      event.type === 'voice.playback_started' &&
      event.payload.previousState !== 'idle' &&
      event.payload.previousState !== 'processing'
    ) {
      addIdentityIssue(
        context,
        ['payload', 'previousState'],
        'Playback may start only from idle or processing',
      );
    }
    if ('previousState' in expected && event.payload.previousState !== expected.previousState) {
      addIdentityIssue(
        context,
        ['payload', 'previousState'],
        `Expected previous voice state ${expected.previousState}`,
      );
    }
    if (event.payload.nextState !== expected.nextState) {
      addIdentityIssue(
        context,
        ['payload', 'nextState'],
        `Expected next voice state ${expected.nextState}`,
      );
    }
  });

const errorEventSchema = z.strictObject({
  ...monitoringBaseShape,
  category: z.literal('error'),
  type: z.literal('error.occurred'),
  payload: z.strictObject({
    source: z.enum(['interview', 'workflow', 'agent', 'transcript', 'voice', 'storage']),
    diagnostic: voiceDiagnosticSchema.optional(),
    code: nonBlankTextSchema.max(100),
    message: nonBlankTextSchema.max(1_000),
    retryable: z.boolean(),
  }),
});

const retryEventSchema = z
  .strictObject({
    ...monitoringBaseShape,
    category: z.literal('retry'),
    type: z.enum(['retry.scheduled', 'retry.started', 'retry.exhausted']),
    payload: z.strictObject({
      target: z.enum(['workflow_step', 'agent', 'voice_provider']),
      targetRunId: idSchema,
      attempt: z.number().int().positive(),
      maximumAttempts: z.number().int().positive(),
      delayMs: z.number().int().nonnegative(),
      errorCode: nonBlankTextSchema.max(100),
    }),
  })
  .superRefine((event, context) => {
    if (event.runId !== event.payload.targetRunId) {
      addIdentityIssue(context, ['runId'], 'runId must identify the retried run');
    }
    if (event.payload.attempt > event.payload.maximumAttempts) {
      addIdentityIssue(
        context,
        ['payload', 'attempt'],
        'A retry attempt cannot exceed maximumAttempts',
      );
    }
    if (
      event.type === 'retry.exhausted' &&
      event.payload.attempt !== event.payload.maximumAttempts
    ) {
      addIdentityIssue(
        context,
        ['payload', 'attempt'],
        'An exhausted retry must be the final allowed attempt',
      );
    }
  });

const stateUpdateEventSchema = z
  .strictObject({
    ...monitoringBaseShape,
    category: z.literal('state_update'),
    type: z.literal('state.updated'),
    payload: z.strictObject({
      previousVersion: z.number().int().nonnegative(),
      nextVersion: z.number().int().positive(),
      state: interviewStateSchema,
    }),
  })
  .superRefine((event, context) => {
    if (event.payload.nextVersion !== event.payload.previousVersion + 1) {
      addIdentityIssue(
        context,
        ['payload', 'nextVersion'],
        'State versions must advance by exactly one',
      );
    }
    if (event.payload.state.version !== event.payload.nextVersion) {
      addIdentityIssue(
        context,
        ['payload', 'state', 'version'],
        'The embedded state version must equal nextVersion',
      );
    }
    if (event.payload.state.interviewId !== event.interviewId) {
      addIdentityIssue(
        context,
        ['payload', 'state', 'interviewId'],
        'The embedded state must belong to the event interview',
      );
    }
  });

export const monitoringEventSchema = z.union([
  interviewEventSchema,
  interviewSectionCompactedEventSchema,
  workflowStartedEventSchema,
  workflowCompletedEventSchema,
  workflowFailedEventSchema,
  workflowStepEventSchema,
  agentStartedEventSchema,
  agentCompletedEventSchema,
  agentFailedEventSchema,
  partialTranscriptEventSchema,
  finalTranscriptSegmentEventSchema,
  canonicalTurnEventSchema,
  technicalGapPersistedEventSchema,
  transcriptFinalizedEventSchema,
  aiTextStreamStartedEventSchema,
  aiTextDeltaEventSchema,
  aiTextStreamCompletedEventSchema,
  aiTextStreamInterruptedEventSchema,
  voiceEventSchema,
  errorEventSchema,
  retryEventSchema,
  stateUpdateEventSchema,
]);

function validateTranscriptPayloadIdentity(
  event: { readonly interviewId: string; readonly payload: { readonly interviewId: string } },
  context: z.RefinementCtx,
): void {
  if (event.payload.interviewId !== event.interviewId) {
    addIdentityIssue(
      context,
      ['payload', 'interviewId'],
      'The transcript payload must belong to the event interview',
    );
  }
}

interface TimedRun {
  readonly status: z.infer<typeof runStatusSchema>;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly durationMs: number | null;
  readonly errorCode: string | null;
}

function validateTimedRun(run: TimedRun, context: z.RefinementCtx): void {
  const notStarted = run.status === 'waiting';
  const active = run.status === 'running' || run.status === 'retrying';
  const successful = run.status === 'succeeded' || run.status === 'skipped';

  if (notStarted && (run.startedAt !== null || run.endedAt !== null || run.durationMs !== null)) {
    addIdentityIssue(context, ['status'], 'A waiting run must not contain timing results');
  }
  if (active && (run.startedAt === null || run.endedAt !== null || run.durationMs !== null)) {
    addIdentityIssue(context, ['status'], 'An active run requires a start but no end result');
  }
  if (
    (successful || run.status === 'failed') &&
    (run.startedAt === null || run.endedAt === null || run.durationMs === null)
  ) {
    addIdentityIssue(context, ['status'], 'A terminal run requires complete timing metadata');
  }
  if (successful && run.errorCode !== null) {
    addIdentityIssue(context, ['errorCode'], 'A successful run cannot contain an error code');
  }
  if (run.status === 'failed' && run.errorCode === null) {
    addIdentityIssue(context, ['errorCode'], 'A failed run requires an error code');
  }
  if (
    run.startedAt !== null &&
    run.endedAt !== null &&
    Date.parse(run.endedAt) < Date.parse(run.startedAt)
  ) {
    addIdentityIssue(context, ['endedAt'], 'A run cannot end before it starts');
  }
}

function validateWorkflowRunIdentity(
  event: { readonly runId: string; readonly payload: { readonly workflowRunId: string } },
  context: z.RefinementCtx,
): void {
  if (event.runId !== event.payload.workflowRunId) {
    addIdentityIssue(context, ['runId'], 'runId must identify the workflow run');
  }
}

function validateAgentRunEvent(
  event: {
    readonly runId: string;
    readonly payload: { readonly run: z.infer<typeof agentRunMetadataSchema> };
  },
  expectedStatus: 'running' | 'succeeded' | 'failed',
  context: z.RefinementCtx,
): void {
  if (event.runId !== event.payload.run.agentRunId) {
    addIdentityIssue(context, ['runId'], 'runId must identify the agent run');
  }
  if (event.payload.run.status !== expectedStatus) {
    addIdentityIssue(
      context,
      ['payload', 'run', 'status'],
      'Event type and agent status do not match',
    );
  }
}

function addIdentityIssue(context: z.RefinementCtx, path: PropertyKey[], message: string): void {
  context.addIssue({ code: 'custom', message, path });
}

export type MonitoringEventCategory = z.infer<typeof monitoringEventCategorySchema>;
export type WorkflowStepName = z.infer<typeof workflowStepNameSchema>;
export type RunStatus = z.infer<typeof runStatusSchema>;
export type ModelMetadata = z.infer<typeof modelMetadataSchema>;
export type MonitoringAgentInput = z.infer<typeof monitoringAgentInputSchema>;
export type WorkflowStepRun = z.infer<typeof workflowStepRunSchema>;
export type AgentRunMetadata = z.infer<typeof agentRunMetadataSchema>;
export type VoiceState = z.infer<typeof voiceStateSchema>;
export type MonitoringEvent = z.infer<typeof monitoringEventSchema>;
