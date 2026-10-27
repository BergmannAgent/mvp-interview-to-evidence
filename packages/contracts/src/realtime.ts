import { z } from 'zod';

import { structuredAgentOutputSchema, transcriptFinalizationReportSchema } from './agents.js';
import { guideStructureSchema, type GuideQuestionReference } from './guide.js';
import { interviewStateSchema } from './interview.js';
import {
  agentRunMetadataSchema,
  monitoringAgentInputSchema,
  monitoringEventSchema,
  runStatusSchema,
  voiceStateSchema,
  workflowStepRunSchema,
} from './monitoring.js';
import { idSchema, nonBlankTextSchema, timestampSchema } from './primitives.js';
import {
  canonicalTranscriptSchema,
  finalTranscriptSegmentSchema,
  partialTranscriptTextSchema,
  partialTranscriptSegmentSchema,
} from './transcript.js';

const eventSequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const monitoringEventCursorSchema = z
  .union([
    eventSequenceSchema,
    z
      .string()
      .regex(/^(0|[1-9][0-9]{0,15})$/u, 'Event cursor must be a canonical decimal integer')
      .transform(Number),
  ])
  .pipe(eventSequenceSchema);

export const monitoringStreamQuerySchema = z.strictObject({
  afterSequence: monitoringEventCursorSchema.default(0),
});

export const monitoringStreamReadySchema = z
  .strictObject({
    type: z.literal('monitoring.ready'),
    interviewId: idSchema,
    afterSequence: eventSequenceSchema,
    replayThroughSequence: eventSequenceSchema,
    connectedAt: timestampSchema,
    retryMs: z.number().int().min(250).max(60_000),
  })
  .superRefine((ready, context) => {
    if (ready.afterSequence > ready.replayThroughSequence) {
      context.addIssue({
        code: 'custom',
        message: 'The stream cursor must not exceed its replay high-water mark',
        path: ['afterSequence'],
      });
    }
  });

export const monitoringStreamFaultSchema = z.strictObject({
  type: z.literal('monitoring.stream_fault'),
  interviewId: idSchema,
  reason: z.enum(['event_gap', 'storage_unavailable', 'server_shutdown']),
  highWaterSequence: eventSequenceSchema.nullable(),
  retryable: z.boolean(),
  occurredAt: timestampSchema,
});

export const monitoringSseEventFrameSchema = z
  .strictObject({
    event: z.literal('monitoring'),
    id: z.string().regex(/^[1-9][0-9]{0,15}$/u),
    data: monitoringEventSchema,
  })
  .superRefine((frame, context) => {
    if (Number(frame.id) !== frame.data.sequenceNumber) {
      addIssue(
        context,
        ['id'],
        'The SSE event ID must be the canonical per-interview event sequence',
      );
    }
  });

export const monitoringSseReadyFrameSchema = z.strictObject({
  event: z.literal('ready'),
  data: monitoringStreamReadySchema,
});

export const monitoringSseFaultFrameSchema = z.strictObject({
  event: z.literal('fault'),
  data: monitoringStreamFaultSchema,
});

export const monitoringFailureSchema = z.strictObject({
  code: nonBlankTextSchema.max(100),
  message: nonBlankTextSchema.max(1_000),
  retryable: z.boolean(),
  occurredAt: timestampSchema,
});

export const monitoringWorkflowRunSchema = z
  .strictObject({
    interviewId: idSchema,
    workflowRunId: idSchema,
    attemptId: idSchema,
    jobId: idSchema,
    expectedInterviewStateVersion: z.number().int().nonnegative(),
    attemptNumber: z.number().int().positive(),
    status: runStatusSchema,
    retryCount: z.number().int().nonnegative(),
    startedAt: timestampSchema.nullable(),
    endedAt: timestampSchema.nullable(),
    durationMs: z.number().int().nonnegative().nullable(),
    failure: monitoringFailureSchema.nullable(),
    rejectionReason: nonBlankTextSchema.max(1_000).nullable(),
    appliedAt: timestampSchema.nullable(),
  })
  .superRefine(validateMonitoringRunTiming);

export const monitoringWorkflowStepSchema = z
  .strictObject({
    interviewId: idSchema,
    attemptId: idSchema,
    attemptNumber: z.number().int().positive(),
    agentRunId: idSchema.nullable(),
    run: workflowStepRunSchema,
    input: z.strictObject({
      referencedTranscriptTurnIds: z.array(idSchema),
      referencedGuideQuestionIds: z.array(idSchema),
    }),
    structuredOutput: structuredAgentOutputSchema.nullable(),
    failure: monitoringFailureSchema.nullable(),
  })
  .superRefine((step, context) => {
    if (step.run.inputAvailable !== true) {
      addIssue(context, ['run', 'inputAvailable'], 'Persisted workflow steps expose their input');
    }
    if (step.run.outputAvailable !== (step.structuredOutput !== null)) {
      addIssue(
        context,
        ['run', 'outputAvailable'],
        'Workflow output availability must match the structured output',
      );
    }
    const expectedAgentName = agentNameForWorkflowStep(step.run.step);
    const requiresAgentRun = expectedAgentName !== null && step.run.status === 'succeeded';
    if ((step.agentRunId !== null) !== requiresAgentRun) {
      addIssue(
        context,
        ['agentRunId'],
        'A succeeded agent step requires its exact agent run and deterministic steps require none',
      );
    }
    if (
      (expectedAgentName === null && step.structuredOutput !== null) ||
      (step.structuredOutput !== null && step.structuredOutput.agentName !== expectedAgentName)
    ) {
      addIssue(
        context,
        ['structuredOutput'],
        'Workflow structured output must belong to the agent assigned to this step',
      );
    }
    if (
      expectedAgentName !== null &&
      step.run.status === 'succeeded' &&
      step.structuredOutput === null
    ) {
      addIssue(context, ['structuredOutput'], 'A succeeded agent step requires structured output');
    }
    if (step.structuredOutput !== null && step.run.status !== 'succeeded') {
      addIssue(context, ['structuredOutput'], 'Only a succeeded workflow step may expose output');
    }
    validateFailureIdentity(step.run.errorCode, step.failure, context);
  });

export const monitoringAgentRunSchema = z
  .strictObject({
    interviewId: idSchema,
    attemptId: idSchema,
    invocationNumber: z.number().int().positive(),
    run: agentRunMetadataSchema,
    input: monitoringAgentInputSchema,
    structuredOutput: structuredAgentOutputSchema.nullable(),
    failure: monitoringFailureSchema.nullable(),
  })
  .superRefine((agent, context) => {
    if (
      agent.structuredOutput !== null &&
      agent.structuredOutput.agentName !== agent.run.agentName
    ) {
      addIssue(
        context,
        ['structuredOutput', 'agentName'],
        'The structured output must belong to the persisted agent run',
      );
    }
    if (
      agent.run.status === 'succeeded'
        ? agent.structuredOutput === null
        : agent.structuredOutput !== null
    ) {
      addIssue(
        context,
        ['structuredOutput'],
        'Exactly a succeeded agent run exposes structured output',
      );
    }
    validateFailureIdentity(agent.run.errorCode, agent.failure, context);
  });

export const monitoringContradictionSchema = z.strictObject({
  interviewId: idSchema,
  contradictionId: idSchema,
  workflowRunId: idSchema,
  agentRunId: idSchema,
  description: nonBlankTextSchema.max(800),
  suggestedClarificationQuestion: nonBlankTextSchema.max(600),
  shouldClarify: z.boolean(),
  rationale: nonBlankTextSchema.max(800),
  referencedTranscriptTurnIds: z.array(idSchema),
  status: z.enum(['detected', 'asked', 'dismissed', 'resolved']),
  askedTurnId: idSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

const deterministicFinalizationIssueSchema = z.strictObject({
  code: nonBlankTextSchema.max(100),
  message: nonBlankTextSchema.max(1_000),
  entryId: idSchema.nullable(),
});

export const monitoringFinalizationSchema = z.strictObject({
  interviewId: idSchema,
  finalizationId: idSchema,
  interviewStateVersion: z.number().int().nonnegative(),
  agentRunId: idSchema,
  finalizedAt: timestampSchema,
  deterministicValidation: z.strictObject({
    valid: z.boolean(),
    issues: z.array(deterministicFinalizationIssueSchema),
  }),
  agentReport: transcriptFinalizationReportSchema,
  transcriptFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  entryCount: z.number().int().nonnegative(),
  technicalGapCount: z.number().int().nonnegative(),
});

const activeAiTextStreamSchema = z
  .strictObject({
    interviewId: idSchema,
    runId: idSchema,
    utteranceId: idSchema,
    turnId: idSchema,
    startedAt: timestampSchema,
    lastDeltaSequenceNumber: z.number().int().nonnegative().max(20_000),
    generatedText: partialTranscriptTextSchema,
  })
  .superRefine((stream, context) => {
    if ((stream.lastDeltaSequenceNumber === 0) !== (stream.generatedText.length === 0)) {
      addIssue(
        context,
        ['generatedText'],
        'An AI stream without deltas must be empty and accumulated deltas must produce text',
      );
    }
  });

export const monitoringLiveStateSchema = z.strictObject({
  voiceState: voiceStateSchema,
  activeAiTextStream: activeAiTextStreamSchema.nullable(),
});

export const monitoringSnapshotSchema = z
  .strictObject({
    interviewGuide: guideStructureSchema,
    interviewState: interviewStateSchema,
    transcript: canonicalTranscriptSchema,
    partialTranscriptions: z.array(partialTranscriptSegmentSchema),
    finalTranscriptions: z.array(finalTranscriptSegmentSchema),
    workflowRuns: z.array(monitoringWorkflowRunSchema),
    workflowSteps: z.array(monitoringWorkflowStepSchema),
    agentRuns: z.array(monitoringAgentRunSchema),
    contradictions: z.array(monitoringContradictionSchema),
    finalization: monitoringFinalizationSchema.nullable(),
    liveState: monitoringLiveStateSchema,
    eventSequence: eventSequenceSchema,
    capturedAt: timestampSchema,
  })
  .superRefine(validateSnapshotScopes);

export const monitoringSnapshotResponseSchema = z.strictObject({
  snapshot: monitoringSnapshotSchema,
});

interface MonitoringRunTiming {
  readonly status: z.infer<typeof runStatusSchema>;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly durationMs: number | null;
  readonly failure: z.infer<typeof monitoringFailureSchema> | null;
}

function validateMonitoringRunTiming(run: MonitoringRunTiming, context: z.RefinementCtx): void {
  const waiting = run.status === 'waiting';
  const active = run.status === 'running' || run.status === 'retrying';
  const terminal =
    run.status === 'succeeded' || run.status === 'failed' || run.status === 'skipped';
  if (waiting && (run.startedAt !== null || run.endedAt !== null || run.durationMs !== null)) {
    addIssue(context, ['status'], 'A waiting workflow must not contain timing results');
  }
  if (active && (run.startedAt === null || run.endedAt !== null || run.durationMs !== null)) {
    addIssue(context, ['status'], 'An active workflow requires a start and no end result');
  }
  if (terminal && (run.startedAt === null || run.endedAt === null || run.durationMs === null)) {
    addIssue(context, ['status'], 'A terminal workflow requires complete timing metadata');
  }
  if (run.status === 'failed' ? run.failure === null : run.failure !== null) {
    addIssue(context, ['failure'], 'Only a failed workflow may expose a failure');
  }
  if (
    run.startedAt !== null &&
    run.endedAt !== null &&
    Date.parse(run.endedAt) < Date.parse(run.startedAt)
  ) {
    addIssue(context, ['endedAt'], 'A workflow cannot end before it starts');
  }
}

function validateFailureIdentity(
  errorCode: string | null,
  failure: z.infer<typeof monitoringFailureSchema> | null,
  context: z.RefinementCtx,
): void {
  if (errorCode !== (failure?.code ?? null)) {
    addIssue(context, ['failure'], 'Run error metadata must match the persisted failure');
  }
}

function validateSnapshotScopes(
  snapshot: z.infer<typeof monitoringSnapshotSchema>,
  context: z.RefinementCtx,
): void {
  const interviewId = snapshot.interviewState.interviewId;
  const guideId = snapshot.interviewState.guideId;
  if (snapshot.interviewGuide.id !== guideId || snapshot.transcript.guideId !== guideId) {
    addIssue(context, ['interviewGuide', 'id'], 'Snapshot guide scopes must match');
  }
  if (snapshot.transcript.interviewId !== interviewId) {
    addIssue(context, ['transcript', 'interviewId'], 'Snapshot transcript scope must match');
  }
  if (
    snapshot.liveState.activeAiTextStream !== null &&
    snapshot.liveState.activeAiTextStream.interviewId !== interviewId
  ) {
    addIssue(
      context,
      ['liveState', 'activeAiTextStream', 'interviewId'],
      'Active AI text stream scope must match the snapshot interview',
    );
  }

  const guideReferenceKeys = collectGuideReferenceKeys(snapshot.interviewGuide);
  const guideQuestionIds = collectGuideQuestionIds(snapshot.interviewGuide);
  const transcriptEntryIds = new Set<string>();
  const transcriptTurnIds = new Set<string>();
  const transcriptEntryKindById = new Map<string, 'turn' | 'technical_gap'>();
  const participantTurnsBySource = new Map<
    string,
    Extract<(typeof snapshot.transcript.entries)[number], { speaker: 'participant' }>
  >();
  for (const [index, entry] of snapshot.transcript.entries.entries()) {
    const entryId = entry.kind === 'turn' ? entry.turnId : entry.gapId;
    transcriptEntryIds.add(entryId);
    transcriptEntryKindById.set(entryId, entry.kind);
    if (entry.kind === 'turn') {
      transcriptTurnIds.add(entry.turnId);
      if (entry.speaker === 'participant') {
        const sourceIdentity = participantSourceIdentity(
          entry.sourceProvider,
          entry.providerEventId,
        );
        if (participantTurnsBySource.has(sourceIdentity)) {
          addIssue(
            context,
            ['transcript', 'entries', index],
            'Participant transcript source identities must be unique',
          );
        }
        participantTurnsBySource.set(sourceIdentity, entry);
      }
      if (
        entry.guideReference !== null &&
        !guideReferenceKeys.has(guideReferenceKey(entry.guideReference))
      ) {
        addIssue(
          context,
          ['transcript', 'entries', index, 'guideReference'],
          'Transcript guide reference is missing from the snapshot guide',
        );
      }
    }
  }
  for (const [index, coverage] of snapshot.interviewState.coverage.entries()) {
    if (!guideReferenceKeys.has(guideReferenceKey(coverage.question))) {
      addIssue(
        context,
        ['interviewState', 'coverage', index, 'question'],
        'Coverage guide reference is missing from the snapshot guide',
      );
    }
    validateReferences(
      coverage.transcriptTurnIds,
      transcriptTurnIds,
      ['interviewState', 'coverage', index, 'transcriptTurnIds'],
      'Coverage transcript evidence is missing from the snapshot transcript',
      context,
    );
  }
  if (
    snapshot.interviewState.currentMainQuestion !== null &&
    !guideReferenceKeys.has(guideReferenceKey(snapshot.interviewState.currentMainQuestion))
  ) {
    addIssue(
      context,
      ['interviewState', 'currentMainQuestion'],
      'Current main question is missing from the snapshot guide',
    );
  }

  const workflowById = new Map(snapshot.workflowRuns.map((run) => [run.workflowRunId, run]));
  const agentById = new Map(snapshot.agentRuns.map((agent) => [agent.run.agentRunId, agent]));
  if (workflowById.size !== snapshot.workflowRuns.length) {
    addIssue(context, ['workflowRuns'], 'Workflow run IDs must be unique');
  }
  if (agentById.size !== snapshot.agentRuns.length) {
    addIssue(context, ['agentRuns'], 'Agent run IDs must be unique');
  }
  if (
    snapshot.interviewState.activeWorkflowRunId !== null &&
    !workflowById.has(snapshot.interviewState.activeWorkflowRunId)
  ) {
    addIssue(context, ['interviewState', 'activeWorkflowRunId'], 'Active workflow is missing');
  }

  const partialIds = new Set<string>();
  const partialProviderEventIds = new Set<string>();
  for (const [index, segment] of snapshot.partialTranscriptions.entries()) {
    const segmentIdentity = transcriptSegmentIdentity(segment.provider, segment.segmentId);
    const providerEventIdentity = participantSourceIdentity(
      segment.provider,
      segment.providerEventId,
    );
    if (
      segment.interviewId !== interviewId ||
      partialIds.has(segmentIdentity) ||
      partialProviderEventIds.has(providerEventIdentity)
    ) {
      addIssue(context, ['partialTranscriptions', index, 'interviewId'], 'Partial scope mismatch');
    }
    partialIds.add(segmentIdentity);
    partialProviderEventIds.add(providerEventIdentity);
  }
  const finalIds = new Set<string>();
  const finalProviderEventIds = new Set<string>();
  const finalUtteranceIds = new Set<string>();
  for (const [index, segment] of snapshot.finalTranscriptions.entries()) {
    const segmentIdentity = transcriptSegmentIdentity(segment.provider, segment.segmentId);
    const providerEventIdentity = participantSourceIdentity(
      segment.provider,
      segment.providerEventId,
    );
    const utteranceIdentity = transcriptSegmentIdentity(segment.provider, segment.utteranceId);
    const participantTurn = participantTurnsBySource.get(providerEventIdentity);
    if (
      segment.interviewId !== interviewId ||
      finalIds.has(segmentIdentity) ||
      finalProviderEventIds.has(providerEventIdentity) ||
      finalUtteranceIds.has(utteranceIdentity) ||
      participantTurn === undefined ||
      participantTurn.sourceSegmentId !== segment.segmentId ||
      participantTurn.text !== segment.text
    ) {
      addIssue(context, ['finalTranscriptions', index, 'interviewId'], 'Final scope mismatch');
    }
    finalIds.add(segmentIdentity);
    finalProviderEventIds.add(providerEventIdentity);
    finalUtteranceIds.add(utteranceIdentity);
  }
  for (const [index, segment] of snapshot.partialTranscriptions.entries()) {
    if (
      finalIds.has(transcriptSegmentIdentity(segment.provider, segment.segmentId)) ||
      finalUtteranceIds.has(transcriptSegmentIdentity(segment.provider, segment.utteranceId)) ||
      finalProviderEventIds.has(
        participantSourceIdentity(segment.provider, segment.providerEventId),
      )
    ) {
      addIssue(
        context,
        ['partialTranscriptions', index],
        'An unresolved partial must not overlap a final STT segment',
      );
    }
  }
  for (const [sourceIdentity] of participantTurnsBySource) {
    if (!finalProviderEventIds.has(sourceIdentity)) {
      addIssue(
        context,
        ['finalTranscriptions'],
        'Every canonical participant turn requires its final STT segment',
      );
    }
  }
  for (const [index, run] of snapshot.workflowRuns.entries()) {
    if (run.interviewId !== interviewId) {
      addIssue(context, ['workflowRuns', index, 'interviewId'], 'Workflow scope mismatch');
    }
  }
  const stepIds = new Set<string>();
  for (const [index, step] of snapshot.workflowSteps.entries()) {
    const workflow = workflowById.get(step.run.workflowRunId);
    if (
      step.interviewId !== interviewId ||
      stepIds.has(step.run.stepRunId) ||
      workflow === undefined ||
      step.attemptId !== workflow.attemptId ||
      step.attemptNumber !== workflow.attemptNumber
    ) {
      addIssue(context, ['workflowSteps', index], 'Workflow step scope mismatch');
    }
    validateReferences(
      step.input.referencedTranscriptTurnIds,
      transcriptTurnIds,
      ['workflowSteps', index, 'input', 'referencedTranscriptTurnIds'],
      'Workflow transcript evidence is missing from the snapshot transcript',
      context,
    );
    validateReferences(
      step.input.referencedGuideQuestionIds,
      guideQuestionIds,
      ['workflowSteps', index, 'input', 'referencedGuideQuestionIds'],
      'Workflow guide evidence is missing from the snapshot guide',
      context,
    );
    if (step.agentRunId !== null) {
      const matchingAgent = agentById.get(step.agentRunId);
      const expectedAgentName = agentNameForWorkflowStep(step.run.step);
      if (
        matchingAgent === undefined ||
        matchingAgent.attemptId !== step.attemptId ||
        matchingAgent.run.workflowRunId !== step.run.workflowRunId ||
        matchingAgent.run.agentName !== expectedAgentName ||
        (step.run.status === 'succeeded' && matchingAgent.run.status !== 'succeeded') ||
        (step.run.status === 'succeeded' &&
          step.structuredOutput !== null &&
          (matchingAgent.structuredOutput === null ||
            !sameStructuredValue(matchingAgent.structuredOutput, step.structuredOutput)))
      ) {
        addIssue(
          context,
          ['workflowSteps', index, 'agentRunId'],
          'Workflow step attribution must match its exact persisted agent run',
        );
      }
    }
    stepIds.add(step.run.stepRunId);
  }
  for (const [index, agent] of snapshot.agentRuns.entries()) {
    const workflow = workflowById.get(agent.run.workflowRunId);
    const agentUsesWorkflowState =
      workflow !== undefined &&
      (agent.input.interviewStateVersion === workflow.expectedInterviewStateVersion ||
        agent.input.interviewStateVersion === workflow.expectedInterviewStateVersion + 1);
    if (
      agent.interviewId !== interviewId ||
      workflow === undefined ||
      agent.attemptId !== workflow.attemptId ||
      !agentUsesWorkflowState
    ) {
      addIssue(context, ['agentRuns', index], 'Agent run scope mismatch');
    }
    validateReferences(
      agent.input.transcriptTurnIds,
      transcriptTurnIds,
      ['agentRuns', index, 'input', 'transcriptTurnIds'],
      'Agent transcript input is missing from the snapshot transcript',
      context,
    );
    if (agent.structuredOutput !== null) {
      validateAgentOutputReferences(
        agent.structuredOutput,
        transcriptTurnIds,
        transcriptEntryKindById,
        guideReferenceKeys,
        ['agentRuns', index, 'structuredOutput'],
        context,
      );
    }
    validateReferences(
      agent.input.canonicalEntryIds,
      transcriptEntryIds,
      ['agentRuns', index, 'input', 'canonicalEntryIds'],
      'Agent canonical input is missing from the snapshot transcript',
      context,
    );
    validateReferences(
      agent.input.guideQuestionIds,
      guideQuestionIds,
      ['agentRuns', index, 'input', 'guideQuestionIds'],
      'Agent guide input is missing from the snapshot guide',
      context,
    );
  }
  const contradictionIds = new Set<string>();
  for (const [index, contradiction] of snapshot.contradictions.entries()) {
    const agent = agentById.get(contradiction.agentRunId);
    if (
      contradiction.interviewId !== interviewId ||
      contradictionIds.has(contradiction.contradictionId) ||
      !workflowById.has(contradiction.workflowRunId) ||
      agent === undefined ||
      agent.run.workflowRunId !== contradiction.workflowRunId
    ) {
      addIssue(context, ['contradictions', index], 'Contradiction scope mismatch');
    }
    validateReferences(
      contradiction.referencedTranscriptTurnIds,
      transcriptTurnIds,
      ['contradictions', index, 'referencedTranscriptTurnIds'],
      'Contradiction evidence is missing from the snapshot transcript',
      context,
    );
    if (contradiction.askedTurnId !== null && !transcriptTurnIds.has(contradiction.askedTurnId)) {
      addIssue(
        context,
        ['contradictions', index, 'askedTurnId'],
        'Contradiction question turn is missing from the snapshot transcript',
      );
    }
    contradictionIds.add(contradiction.contradictionId);
  }
  if (snapshot.finalization !== null) {
    const finalizationAgent = agentById.get(snapshot.finalization.agentRunId);
    if (
      snapshot.finalization.interviewId !== interviewId ||
      snapshot.interviewState.lifecycle.status !== 'completed' ||
      finalizationAgent?.run.agentName !== 'transcript_finalization' ||
      finalizationAgent.run.status !== 'succeeded' ||
      finalizationAgent.structuredOutput?.agentName !== 'transcript_finalization' ||
      !sameStructuredValue(
        finalizationAgent.structuredOutput?.output,
        snapshot.finalization.agentReport,
      ) ||
      !snapshot.finalization.deterministicValidation.valid ||
      snapshot.finalization.deterministicValidation.issues.length !== 0 ||
      snapshot.transcript.finalizedAt !== snapshot.finalization.finalizedAt ||
      snapshot.finalization.interviewStateVersion !== snapshot.interviewState.version ||
      snapshot.finalization.entryCount !== snapshot.transcript.entries.length ||
      snapshot.finalization.technicalGapCount !==
        snapshot.transcript.entries.filter((entry) => entry.kind === 'technical_gap').length
    ) {
      addIssue(context, ['finalization'], 'Finalization scope or timestamp mismatch');
    }
    const checkedEntries = snapshot.finalization.agentReport.checkedCanonicalEntries;
    if (
      checkedEntries.length !== transcriptEntryIds.size ||
      checkedEntries.some((entry) => transcriptEntryKindById.get(entry.entryId) !== entry.kind)
    ) {
      addIssue(
        context,
        ['finalization', 'agentReport', 'checkedCanonicalEntries'],
        'Finalization must check every canonical transcript entry with its persisted kind',
      );
    }
    for (const [index, issue] of snapshot.finalization.deterministicValidation.issues.entries()) {
      if (issue.entryId !== null && !transcriptEntryIds.has(issue.entryId)) {
        addIssue(
          context,
          ['finalization', 'deterministicValidation', 'issues', index, 'entryId'],
          'Finalization validation issue references a missing canonical entry',
        );
      }
    }
  } else if (snapshot.transcript.finalizedAt !== null) {
    addIssue(context, ['transcript', 'finalizedAt'], 'Finalized transcript requires metadata');
  }
}

function collectGuideReferenceKeys(guide: z.infer<typeof guideStructureSchema>): Set<string> {
  const references = new Set<string>();
  for (const section of guide.sections) {
    for (const mainQuestion of section.mainQuestions) {
      references.add(`main:${guide.id}:${section.id}:${mainQuestion.id}`);
      for (const followUp of mainQuestion.followUpQuestions) {
        references.add(`follow_up:${guide.id}:${section.id}:${mainQuestion.id}:${followUp.id}`);
      }
    }
  }
  return references;
}

function collectGuideQuestionIds(guide: z.infer<typeof guideStructureSchema>): Set<string> {
  const ids = new Set<string>();
  for (const section of guide.sections) {
    for (const mainQuestion of section.mainQuestions) {
      ids.add(mainQuestion.id);
      for (const followUp of mainQuestion.followUpQuestions) ids.add(followUp.id);
    }
  }
  return ids;
}

function guideReferenceKey(reference: GuideQuestionReference): string {
  return reference.kind === 'main_question'
    ? `main:${reference.guideId}:${reference.sectionId}:${reference.mainQuestionId}`
    : `follow_up:${reference.guideId}:${reference.sectionId}:${reference.mainQuestionId}:${reference.followUpQuestionId}`;
}

function transcriptSegmentIdentity(provider: string, segmentId: string): string {
  return JSON.stringify([provider, segmentId]);
}

function participantSourceIdentity(provider: string, providerEventId: string): string {
  return JSON.stringify([provider, providerEventId]);
}

function agentNameForWorkflowStep(
  step: z.infer<typeof workflowStepRunSchema>['step'],
): z.infer<typeof structuredAgentOutputSchema>['agentName'] | null {
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

function sameStructuredValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateReferences(
  references: readonly string[],
  available: ReadonlySet<string>,
  path: PropertyKey[],
  message: string,
  context: z.RefinementCtx,
): void {
  for (const [index, reference] of references.entries()) {
    if (!available.has(reference)) addIssue(context, [...path, index], message);
  }
}

function validateAgentOutputReferences(
  output: z.infer<typeof structuredAgentOutputSchema>,
  transcriptTurnIds: ReadonlySet<string>,
  transcriptEntryKindById: ReadonlyMap<string, 'turn' | 'technical_gap'>,
  guideReferenceKeys: ReadonlySet<string>,
  path: PropertyKey[],
  context: z.RefinementCtx,
): void {
  if (output.agentName === 'transcript_finalization') {
    for (const [index, entry] of output.output.checkedCanonicalEntries.entries()) {
      if (transcriptEntryKindById.get(entry.entryId) !== entry.kind) {
        addIssue(
          context,
          [...path, 'output', 'checkedCanonicalEntries', index],
          'Agent finalization entry is missing from the snapshot transcript',
        );
      }
    }
    return;
  }
  validateReferences(
    output.output.referencedTranscriptTurnIds,
    transcriptTurnIds,
    [...path, 'output', 'referencedTranscriptTurnIds'],
    'Agent output evidence is missing from the snapshot transcript',
    context,
  );
  if (output.agentName === 'coverage_analysis') {
    for (const [index, finding] of output.output.findings.entries()) {
      validateGuideReference(
        finding.question,
        guideReferenceKeys,
        [...path, 'output', 'findings', index, 'question'],
        context,
      );
    }
  } else if (output.agentName === 'interview_decision') {
    for (const [index, question] of output.output.consideredQuestions.entries()) {
      validateGuideReference(
        question,
        guideReferenceKeys,
        [...path, 'output', 'consideredQuestions', index],
        context,
      );
    }
  } else if (output.agentName === 'interview_conductor' && output.output.action === 'ask') {
    validateGuideReference(
      output.output.question.guideReference,
      guideReferenceKeys,
      [...path, 'output', 'question', 'guideReference'],
      context,
    );
  }
}

function validateGuideReference(
  reference: GuideQuestionReference,
  available: ReadonlySet<string>,
  path: PropertyKey[],
  context: z.RefinementCtx,
): void {
  if (!available.has(guideReferenceKey(reference))) {
    addIssue(context, path, 'Agent guide reference is missing from the snapshot guide');
  }
}

function addIssue(context: z.RefinementCtx, path: PropertyKey[], message: string): void {
  context.addIssue({ code: 'custom', path, message });
}

export type MonitoringEventCursor = z.infer<typeof monitoringEventCursorSchema>;
export type MonitoringStreamQuery = z.infer<typeof monitoringStreamQuerySchema>;
export type MonitoringStreamReady = z.infer<typeof monitoringStreamReadySchema>;
export type MonitoringStreamFault = z.infer<typeof monitoringStreamFaultSchema>;
export type MonitoringSseEventFrame = z.infer<typeof monitoringSseEventFrameSchema>;
export type MonitoringSseReadyFrame = z.infer<typeof monitoringSseReadyFrameSchema>;
export type MonitoringSseFaultFrame = z.infer<typeof monitoringSseFaultFrameSchema>;
export type MonitoringFailure = z.infer<typeof monitoringFailureSchema>;
export type MonitoringWorkflowRun = z.infer<typeof monitoringWorkflowRunSchema>;
export type MonitoringWorkflowStep = z.infer<typeof monitoringWorkflowStepSchema>;
export type MonitoringAgentRun = z.infer<typeof monitoringAgentRunSchema>;
export type MonitoringContradiction = z.infer<typeof monitoringContradictionSchema>;
export type MonitoringFinalization = z.infer<typeof monitoringFinalizationSchema>;
export type MonitoringLiveState = z.infer<typeof monitoringLiveStateSchema>;
export type MonitoringSnapshot = z.infer<typeof monitoringSnapshotSchema>;
export type MonitoringSnapshotResponse = z.infer<typeof monitoringSnapshotResponseSchema>;
