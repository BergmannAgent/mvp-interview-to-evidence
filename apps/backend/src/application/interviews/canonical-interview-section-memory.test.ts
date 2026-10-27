import { describe, expect, it, vi } from 'vitest';

import {
  applyCoverageUpdates,
  createDeterministicSectionMemory,
  initializeGuideCoverage,
  type InterviewGuideSnapshot,
  type AiTranscriptTurn,
  type TranscriptGuideReference,
  type TranscriptAggregate,
} from '@orgscience/domain';

import type { InterviewAgentExecutor } from '../agents/index.js';
import {
  failure,
  success,
  type AppReadContext,
  type AppTransaction,
  type AppUnitOfWork,
  type DurableJob,
  type MonitoringEventDraft,
  type PersistedInterview,
  type StoredAiDelivery,
} from '../persistence/index.js';
import { CanonicalInterviewSessionService } from './canonical-interview-session-service.js';
import type { SectionMemoryCompactor } from './section-memory-compactor.js';

const AT = '2026-09-11T12:00:00.000Z';

describe('canonical Realtime section compaction', () => {
  it('commits one memory and event atomically and returns an idempotent context update', async () => {
    const compact = vi.fn((source) => Promise.resolve(createDeterministicSectionMemory(source)));
    const harness = createHarness('interview-compaction-success', { compact });

    const first = await harness.service.reserveRealtimeTurnIntent(
      harness.interviewId,
      nextSectionIntent('intent-section-boundary'),
    );
    const repeated = await harness.service.reserveRealtimeTurnIntent(
      harness.interviewId,
      nextSectionIntent('intent-section-boundary'),
    );

    expect(compact).toHaveBeenCalledOnce();
    expect(harness.state.sectionMemories).toHaveLength(1);
    expect(harness.state.sectionMemories?.[0]).toMatchObject({
      interviewId: harness.interviewId,
      sectionId: 'section-alpha',
      sectionTitle: 'Alpha',
      coveredQuestionIds: ['main-alpha'],
      sourceThroughSequenceNumber: 7,
    });
    expect(
      harness.events.filter((event) => event.type === 'interview.section_compacted'),
    ).toHaveLength(1);
    expect(first.nextAiTurn).toMatchObject({
      turnType: 'main_question',
      questionId: 'main-beta',
    });
    expect(first.contextUpdate).toMatchObject({
      revision: expect.stringMatching(/^section-memory:/u),
      removeConversationItemIds: expect.arrayContaining([
        'item-alpha-question-early',
        'item-alpha-answer-early',
      ]),
    });
    expect(first.contextUpdate?.instructions).toContain('SECTION_MEMORY_DATA');
    expect(repeated.contextUpdate?.revision).toBe(first.contextUpdate?.revision);
  });

  it('continues with raw context when compaction times out', async () => {
    const harness = createHarness(
      'interview-compaction-timeout',
      { compact: () => new Promise<never>(() => undefined) },
      5,
    );
    const canonicalTranscriptBefore = structuredClone(harness.transcript);

    const response = await harness.service.reserveRealtimeTurnIntent(
      harness.interviewId,
      nextSectionIntent('intent-timeout-boundary'),
    );

    expect(response.nextAiTurn).toMatchObject({ questionId: 'main-beta' });
    expect(response.contextUpdate).toBeNull();
    expect(harness.state.sectionMemories ?? []).toHaveLength(0);
    expect(harness.events.some((event) => event.type === 'interview.section_compacted')).toBe(
      false,
    );
    expect(harness.transcript).toEqual(canonicalTranscriptBefore);
  });

  it('continues with raw context when a compactor changes the boundary timestamp', async () => {
    const harness = createHarness('interview-compaction-invalid-time', {
      compact: (source) =>
        Promise.resolve({
          ...createDeterministicSectionMemory(source),
          compactedAt: '2030-01-01T00:00:00.000Z',
        }),
    });

    const response = await harness.service.reserveRealtimeTurnIntent(
      harness.interviewId,
      nextSectionIntent('intent-invalid-time-boundary'),
    );

    expect(response.nextAiTurn).toMatchObject({ questionId: 'main-beta' });
    expect(response.contextUpdate).toBeNull();
    expect(harness.state.sectionMemories ?? []).toHaveLength(0);
    expect(harness.events.some((event) => event.type === 'interview.section_compacted')).toBe(
      false,
    );
  });

  it('keeps identically named sections isolated across concurrent interviews', async () => {
    const first = createHarness('interview-parallel-one');
    const second = createHarness('interview-parallel-two');
    await Promise.all([
      first.service.reserveRealtimeTurnIntent(
        first.interviewId,
        nextSectionIntent('intent-parallel-one'),
      ),
      second.service.reserveRealtimeTurnIntent(
        second.interviewId,
        nextSectionIntent('intent-parallel-two'),
      ),
    ]);

    expect(first.state.sectionMemories?.[0]?.interviewId).toBe(first.interviewId);
    expect(second.state.sectionMemories?.[0]?.interviewId).toBe(second.interviewId);
    expect(first.state.sectionMemories?.[0]?.interviewId).not.toBe(
      second.state.sectionMemories?.[0]?.interviewId,
    );
  });
});

function createHarness(
  interviewId: string,
  compactor: SectionMemoryCompactor = {
    compact: (source) => Promise.resolve(createDeterministicSectionMemory(source)),
  },
  timeoutMs = 250,
) {
  const guide = guideFor(interviewId);
  const transcript = transcriptFor(interviewId, guide.id);
  let state = activeState(interviewId, guide);
  let pendingDelivery: StoredAiDelivery | null = null;
  let job: DurableJob | null = null;
  const events: MonitoringEventDraft[] = [];

  const transaction = {
    interviews: {
      lock: () => Promise.resolve(success(state)),
      compareAndSwap: (
        _requestedInterviewId: string,
        _expectedVersion: number,
        next: PersistedInterview,
      ) => {
        state = next;
        return Promise.resolve(success(next));
      },
    },
    guides: { getById: () => Promise.resolve(success(guide)) },
    transcripts: {
      loadAiDelivery: (_requestedInterviewId: string, deliveryId: string) =>
        Promise.resolve(
          pendingDelivery?.deliveryId === deliveryId
            ? success(pendingDelivery)
            : failure({ code: 'not_found', resource: 'transcript', id: deliveryId }),
        ),
      listPendingAiDeliveries: () =>
        Promise.resolve(success(pendingDelivery === null ? [] : [pendingDelivery])),
      listQuestionAiDeliveries: () => Promise.resolve(success([])),
      lockAggregate: () => Promise.resolve(success(transcript)),
      reserveAiDelivery: (
        _requestedInterviewId: string,
        expectedSequenceNumber: number,
        reservation: Omit<
          StoredAiDelivery,
          | 'interviewId'
          | 'reservedSequenceNumber'
          | 'status'
          | 'provider'
          | 'providerDeliveryEventId'
          | 'confirmedSpokenText'
          | 'resolvedAt'
          | 'interruptedAt'
        >,
      ) => {
        pendingDelivery = {
          ...reservation,
          interviewId,
          reservedSequenceNumber: expectedSequenceNumber,
          status: 'pending',
          provider: null,
          providerDeliveryEventId: null,
          confirmedSpokenText: null,
          resolvedAt: null,
          interruptedAt: null,
        };
        return Promise.resolve(success({ outcome: 'inserted', value: pendingDelivery }));
      },
    },
    jobs: {
      enqueue: (
        _requestedInterviewId: string,
        input: Parameters<AppTransaction['jobs']['enqueue']>[1],
      ) => {
        job = {
          interviewId,
          jobId: input.jobId,
          kind: input.kind,
          idempotencyKey: input.idempotencyKey,
          sourceTurnId: input.sourceTurnId,
          expectedInterviewVersion: input.expectedInterviewVersion,
          status: 'queued',
          attemptCount: 0,
          maximumAttempts: input.maximumAttempts,
          initialDelayMs: input.initialDelayMs,
          availableAt: AT,
          leaseOwner: null,
          leaseToken: null,
          leaseExpiresAt: null,
          appliedStateVersion: null,
          cancellationReason: null,
          resultDeliveryId: input.resultDeliveryId,
          lastError: null,
          createdAt: AT,
          updatedAt: AT,
          completedAt: null,
        };
        return Promise.resolve(success({ outcome: 'inserted', value: job }));
      },
      claim: () => {
        if (job === null) throw new Error('Expected queued job');
        job = {
          ...job,
          status: 'running',
          attemptCount: 1,
          leaseOwner: 'inline-realtime-worker',
          leaseToken: 'lease-token',
          leaseExpiresAt: AT,
        };
        return Promise.resolve(success(job));
      },
      complete: () => {
        if (job === null) throw new Error('Expected running job');
        return Promise.resolve(success({ outcome: 'inserted', value: job }));
      },
    },
    runs: {
      startWorkflow: (
        _requestedInterviewId: string,
        workflow: Parameters<AppTransaction['runs']['startWorkflow']>[1],
      ) => Promise.resolve(success({ outcome: 'inserted', value: workflow })),
      finishWorkflow: (
        _requestedInterviewId: string,
        _workflowRunId: string,
        _expectedStatus: 'running',
        workflow: Parameters<AppTransaction['runs']['finishWorkflow']>[3],
      ) => Promise.resolve(success(workflow)),
    },
    outbox: {
      appendMany: (_requestedInterviewId: string, drafts: readonly MonitoringEventDraft[]) => {
        events.push(...drafts);
        return Promise.resolve(success([]));
      },
    },
  } as unknown as AppTransaction;

  const readContext = {
    interviews: { load: () => Promise.resolve(success(state)) },
    guides: { getById: () => Promise.resolve(success(guide)) },
    transcripts: {
      loadAggregate: () => Promise.resolve(success(transcript)),
      listPendingAiDeliveries: () =>
        Promise.resolve(success(pendingDelivery === null ? [] : [pendingDelivery])),
    },
    finalizations: { loadLatest: () => Promise.resolve(success(null)) },
  } as unknown as AppReadContext;
  const unitOfWork: AppUnitOfWork = {
    read: (operation) => operation(readContext),
    transaction: (operation) => operation(transaction),
  };
  const service = new CanonicalInterviewSessionService(
    unitOfWork,
    { now: () => AT },
    {} as InterviewAgentExecutor,
    { model: { mode: 'demo', provider: null, model: null }, sectionMemoryTimeoutMs: timeoutMs },
    compactor,
  );
  return {
    interviewId,
    service,
    events,
    transcript,
    get state(): PersistedInterview {
      return state;
    },
  };
}

function nextSectionIntent(clientEventId: string) {
  return {
    clientEventId,
    action: 'ask_main_question' as const,
    questionId: 'main-beta',
    spokenText: 'Was geschieht in der naechsten Phase?',
    answerDisposition: 'answered' as const,
    missingAspect: null,
    requestedEvidenceType: null,
  };
}

function guideFor(identity: string): InterviewGuideSnapshot {
  return {
    id: `guide:${identity}`,
    sourceLanguage: 'de',
    title: 'Dynamischer Leitfaden',
    sourceMarkdown: '# Dynamischer Leitfaden',
    createdAt: AT,
    sections: [
      {
        id: 'section-alpha',
        position: 0,
        title: 'Alpha',
        mainQuestions: [
          { id: 'main-alpha', position: 0, text: 'Was geschah zuerst?', followUpQuestions: [] },
        ],
      },
      {
        id: 'section-beta',
        position: 1,
        title: 'Beta',
        mainQuestions: [
          {
            id: 'main-beta',
            position: 0,
            text: 'Was geschieht in der naechsten Phase?',
            followUpQuestions: [],
          },
        ],
      },
    ],
  };
}

function activeState(interviewId: string, guide: InterviewGuideSnapshot): PersistedInterview {
  const initialized = initializeGuideCoverage(guide, interviewId);
  const coverage = applyCoverageUpdates(guide, initialized, {
    interviewId,
    guideId: guide.id,
    expectedRevision: initialized.revision,
    updates: [{ questionId: 'main-alpha', status: 'current', referencedTurnIds: [], at: AT }],
  });
  return {
    interviewId,
    guideId: guide.id,
    language: 'de',
    lifecycle: {
      status: 'active',
      interviewId,
      guideId: guide.id,
      createdAt: AT,
      revision: 1,
      startedAt: AT,
      activeSince: AT,
    },
    coverage,
    version: 1,
    activeWorkflowRunId: null,
    createdAt: AT,
    updatedAt: AT,
  };
}

function transcriptFor(interviewId: string, guideId: string): TranscriptAggregate {
  const reference = {
    kind: 'main_question',
    guideId,
    sectionId: 'section-alpha',
    mainQuestionId: 'main-alpha',
  } as const;
  return {
    interviewId,
    guideId,
    guideQuestionIndex: [
      reference,
      {
        kind: 'main_question',
        guideId,
        sectionId: 'section-beta',
        mainQuestionId: 'main-beta',
      },
    ],
    nextSequenceNumber: 8,
    partials: [],
    finals: [],
    entries: [
      aiTurn(interviewId, 1, 'item-greeting', 'greeting', 'Guten Tag.', null),
      aiTurn(
        interviewId,
        2,
        'item-alpha-question-early',
        'main_question',
        'Was geschah zuerst?',
        reference,
      ),
      participantTurn(interviewId, 3, 'item-alpha-answer-early', 'Eine fruehe Aussage.', reference),
      aiTurn(
        interviewId,
        4,
        'item-alpha-question-middle',
        'clarification_question',
        'Wer war beteiligt?',
        reference,
      ),
      participantTurn(
        interviewId,
        5,
        'item-alpha-answer-middle',
        'Das Kernteam war beteiligt.',
        reference,
      ),
      aiTurn(
        interviewId,
        6,
        'item-alpha-question-late',
        'clarification_question',
        'Was war das Ergebnis?',
        reference,
      ),
      participantTurn(
        interviewId,
        7,
        'item-alpha-answer-late',
        'Der Ablauf wurde stabilisiert.',
        reference,
      ),
    ],
  };
}

function aiTurn(
  interviewId: string,
  sequenceNumber: number,
  deliveryEventId: string,
  turnType: 'greeting' | 'main_question' | 'clarification_question',
  text: string,
  guideReference: TranscriptGuideReference | null,
): AiTranscriptTurn {
  const base = {
    kind: 'turn' as const,
    interviewId,
    turnId: `turn-${sequenceNumber}`,
    sequenceNumber,
    occurredAt: AT,
    deliveryEventId,
    speaker: 'ai_interviewer' as const,
    text,
    delivery: { status: 'complete' as const },
  };
  if (turnType === 'greeting') return { ...base, turnType, guideReference: null };
  if (guideReference === null) throw new Error('Question turns require a guide reference');
  if (turnType === 'main_question') {
    if (guideReference.kind !== 'main_question') throw new Error('Expected a main reference');
    return { ...base, turnType, guideReference };
  }
  return { ...base, turnType, guideReference };
}

function participantTurn(
  interviewId: string,
  sequenceNumber: number,
  itemId: string,
  text: string,
  guideReference: TranscriptGuideReference,
) {
  return {
    kind: 'turn' as const,
    interviewId,
    turnId: `turn-${sequenceNumber}`,
    sequenceNumber,
    occurredAt: AT,
    sourceProvider: 'openai_realtime',
    providerEventId: itemId,
    sourceSegmentId: itemId,
    speaker: 'participant' as const,
    turnType: 'participant_answer' as const,
    text,
    guideReference,
  };
}
