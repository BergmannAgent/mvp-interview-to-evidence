import type {
  AiTranscriptTurn,
  FinalizedParticipantSegment,
  ParticipantTranscriptTurn,
  PartialTranscriptSegment,
  TranscriptGuideReference,
  TranscriptTechnicalGap,
} from '@orgscience/domain';
import { describe, expect, it } from 'vitest';

import type {
  AiDeliveryReservation,
  GappedAiDeliveryWrite,
  ResolvedAiTurnWrite,
  SpeechRecognitionSource,
  StoredAiDelivery,
} from '../../../application/persistence/index.js';
import { PostgresTranscriptRepository } from './transcript-repository.js';
import {
  partialInputSchema,
  speechRecognitionSourceSchema,
} from './transcript-repository-schemas.js';
import type { SqlExecutor, SqlQueryResult } from './sql.js';

const INTERVIEW_ID = 'interview-1';
const GUIDE_ID = 'guide-1';
const T0 = '2026-08-06T10:00:00.000Z';
const T1 = '2026-08-06T10:01:00.000Z';
const T2 = '2026-08-06T10:02:00.000Z';
const SOURCE: SpeechRecognitionSource = { provider: 'demo-stt', utteranceId: 'utterance-1' };
const NATIVE_EVENT_PREFIX = 'projects/acme/playout/evt:abc+def=@?/';
const NATIVE_PROVIDER_EVENT_ID = `${NATIVE_EVENT_PREFIX}${'x'.repeat(
  300 - NATIVE_EVENT_PREFIX.length,
)}`;

interface SqlCall {
  readonly statement: string;
  readonly parameters: readonly unknown[];
}

class ScriptedExecutor implements SqlExecutor {
  public readonly calls: SqlCall[] = [];

  public constructor(private readonly results: Array<SqlQueryResult | Error>) {}

  public async query(
    statement: string,
    parameters: readonly unknown[] = [],
  ): Promise<SqlQueryResult> {
    this.calls.push({ statement, parameters });
    const next = this.results.shift();
    if (next === undefined) throw new Error(`Unexpected SQL: ${statement}`);
    if (next instanceof Error) throw next;
    return next;
  }
}

const result = (rows: readonly unknown[] = [], rowCount = rows.length): SqlQueryResult => ({
  rows,
  rowCount,
});

const mainReference = {
  kind: 'main_question' as const,
  guideId: GUIDE_ID,
  sectionId: 'section-1',
  mainQuestionId: 'main-1',
};

const followUpReference = {
  kind: 'follow_up_question' as const,
  guideId: GUIDE_ID,
  sectionId: 'section-1',
  mainQuestionId: 'main-1',
  followUpQuestionId: 'follow-up-1',
};

const guideRows = [
  {
    guideId: GUIDE_ID,
    questionId: 'main-1',
    sectionId: 'section-1',
    kind: 'main_question',
    mainQuestionId: 'main-1',
  },
];

const followUpGuideRow = {
  guideId: GUIDE_ID,
  questionId: 'follow-up-1',
  sectionId: 'section-1',
  kind: 'follow_up_question',
  mainQuestionId: 'main-1',
};

function entryRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    interviewId: INTERVIEW_ID,
    sequenceNumber: 1,
    entryId: 'turn-1',
    kind: 'turn',
    occurredAt: T0,
    speaker: null,
    turnType: null,
    text: null,
    guideId: null,
    questionId: null,
    sourceProvider: null,
    providerEventId: null,
    sourceSegmentId: null,
    deliveryEventId: null,
    deliveryStatus: null,
    interruptedAt: null,
    questionKind: null,
    questionSectionId: null,
    questionMainQuestionId: null,
    gapSource: null,
    gapProvider: null,
    gapDescription: null,
    relatedSegmentId: null,
    relatedUtteranceId: null,
    sourceEventId: null,
    ...overrides,
  };
}

function openMainQuestionRow(): Record<string, unknown> {
  return entryRow({
    sequenceNumber: 1,
    entryId: 'ai-main-1',
    occurredAt: T0,
    speaker: 'ai_interviewer',
    turnType: 'main_question',
    text: 'What is your role?',
    guideId: GUIDE_ID,
    questionId: 'main-1',
    deliveryEventId: 'delivery-main-1',
    deliveryStatus: 'complete',
    questionKind: 'main_question',
    questionSectionId: 'section-1',
    questionMainQuestionId: 'main-1',
  });
}

function guardRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    interviewId: INTERVIEW_ID,
    status: 'active',
    nextSequenceNumber: 1,
    isFinalized: false,
    pendingDeliveryId: null,
    pendingReservedSequenceNumber: null,
    lastSequenceNumber: null,
    lastOccurredAt: null,
    ...overrides,
  };
}

function reservation(overrides: Partial<AiDeliveryReservation> = {}): AiDeliveryReservation {
  return {
    deliveryId: 'delivery-record-1',
    jobId: 'job-1',
    workflowRunId: 'workflow-1',
    turnId: 'ai-turn-1',
    utteranceId: 'ai-utterance-1',
    turnType: 'greeting',
    guideReference: null,
    proposedText: 'Welcome to the interview.',
    createdAt: T0,
    ...overrides,
  };
}

function deliveryRow(
  storedReservation: AiDeliveryReservation,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const reference = storedReservation.guideReference;
  return {
    interviewId: INTERVIEW_ID,
    deliveryId: storedReservation.deliveryId,
    jobId: storedReservation.jobId,
    workflowRunId: storedReservation.workflowRunId,
    turnId: storedReservation.turnId,
    utteranceId: storedReservation.utteranceId,
    reservedSequenceNumber: 1,
    turnType: storedReservation.turnType,
    guideId: reference?.guideId ?? null,
    questionId:
      reference === null
        ? null
        : reference.kind === 'main_question'
          ? reference.mainQuestionId
          : reference.followUpQuestionId,
    questionKind: reference?.kind ?? null,
    questionSectionId: reference?.sectionId ?? null,
    questionMainQuestionId: reference?.mainQuestionId ?? null,
    proposedText: storedReservation.proposedText,
    planningMetadata: storedReservation.planningMetadata ?? null,
    status: 'pending',
    provider: null,
    providerDeliveryEventId: null,
    confirmedSpokenText: null,
    createdAt: storedReservation.createdAt,
    resolvedAt: null,
    interruptedAt: null,
    ...overrides,
  };
}

function pendingDelivery(storedReservation = reservation()): StoredAiDelivery {
  return {
    ...storedReservation,
    interviewId: INTERVIEW_ID,
    reservedSequenceNumber: 1,
    status: 'pending',
    provider: null,
    providerDeliveryEventId: null,
    confirmedSpokenText: null,
    resolvedAt: null,
    interruptedAt: null,
  };
}

describe('PostgresTranscriptRepository', () => {
  it('persists planning metadata, reads it by question, and rejects a changed retry', async () => {
    const requested = reservation({
      turnType: 'clarification_question',
      guideReference: mainReference,
      planningMetadata: {
        purpose: 'clarification',
        sourceParticipantTurnId: 'participant-source',
        answerDisposition: 'partial',
        missingAspect: 'first concrete action',
        requestedEvidenceType: 'action',
      },
    });
    const executor = new ScriptedExecutor([
      result(),
      result([guardRow()]),
      result(),
      result([{ allocatedSequence: 1 }]),
      result([], 1),
    ]);
    const stored = await new PostgresTranscriptRepository(executor).reserveAiDelivery(
      INTERVIEW_ID,
      1,
      requested,
    );
    expect(stored).toMatchObject({
      ok: true,
      value: { value: { planningMetadata: requested.planningMetadata } },
    });
    expect(executor.calls.at(-1)?.parameters.at(-1)).toBe(
      JSON.stringify(requested.planningMetadata),
    );

    const reader = new ScriptedExecutor([result([deliveryRow(requested)])]);
    expect(
      await new PostgresTranscriptRepository(reader).listQuestionAiDeliveries(
        INTERVIEW_ID,
        'main-1',
      ),
    ).toMatchObject({ ok: true, value: [{ planningMetadata: requested.planningMetadata }] });
    expect(reader.calls[0]?.parameters).toEqual([INTERVIEW_ID, 'main-1']);
    expect(reader.calls[0]?.statement).toContain('d.question_id = $2');
    const retry = new ScriptedExecutor([result([deliveryRow(requested)])]);
    expect(
      await new PostgresTranscriptRepository(retry).reserveAiDelivery(INTERVIEW_ID, 1, {
        ...requested,
        planningMetadata: {
          purpose: 'repeat',
          sourceParticipantTurnId: 'participant-source',
          answerDisposition: 'off_topic',
          missingAspect: null,
          requestedEvidenceType: null,
        },
      }),
    ).toMatchObject({ ok: false, error: { code: 'duplicate_conflict' } });
  });

  it('loads canonical next sequence at a pending reserved slot and scopes partial resolution by provider', async () => {
    const reserved = reservation();
    const executor = new ScriptedExecutor([
      result([{ interviewId: INTERVIEW_ID, guideId: GUIDE_ID, nextSequenceNumber: 2 }]),
      result(guideRows),
      result(),
      result([deliveryRow(reserved)]),
      result(),
      result(),
    ]);

    const loaded = await new PostgresTranscriptRepository(executor).loadAggregate(INTERVIEW_ID);

    expect(loaded).toMatchObject({ ok: true, value: { nextSequenceNumber: 1, entries: [] } });
    expect(executor.calls[3]?.statement).toContain("d.status = 'pending'");
    expect(executor.calls[5]?.statement).toContain('f.provider = p.provider');
    expect(executor.calls[5]?.statement).toContain('DISTINCT ON (p.provider, p.segment_id)');
  });

  it('reserves the counter before a pending delivery under the shared state-first lock', async () => {
    const requested = reservation();
    const executor = new ScriptedExecutor([
      result(),
      result([guardRow()]),
      result(),
      result([{ allocatedSequence: 1 }]),
      result([], 1),
    ]);

    const stored = await new PostgresTranscriptRepository(executor).reserveAiDelivery(
      INTERVIEW_ID,
      1,
      requested,
    );

    expect(stored).toEqual({
      ok: true,
      value: { outcome: 'inserted', value: pendingDelivery(requested) },
    });
    expect(executor.calls[1]?.statement).toContain('FROM app.interview_state st');
    expect(executor.calls[1]?.statement).toContain('FOR UPDATE OF st, c');
    expect(executor.calls[3]?.statement).toContain('next_transcript_sequence + 1');
    expect(executor.calls[4]?.statement).toContain("$11, 'pending', $12");
  });

  it('rejects every malformed internal AI-delivery identity before issuing SQL', async () => {
    const identityFields = [
      'deliveryId',
      'jobId',
      'workflowRunId',
      'turnId',
      'utteranceId',
    ] as const;
    const malformedIds = [' leading', 'internal space', 'native/id', 'x'.repeat(129)] as const;

    for (const field of identityFields) {
      for (const malformedId of malformedIds) {
        const executor = new ScriptedExecutor([]);
        const stored = await new PostgresTranscriptRepository(executor).reserveAiDelivery(
          INTERVIEW_ID,
          1,
          reservation({ [field]: malformedId }),
        );

        expect(stored).toMatchObject({ ok: false, error: { code: 'duplicate_conflict' } });
        expect(executor.calls, `${field}=${malformedId}`).toHaveLength(0);
      }
    }

    for (const malformedInterviewId of malformedIds) {
      const executor = new ScriptedExecutor([]);
      const stored = await new PostgresTranscriptRepository(executor).reserveAiDelivery(
        malformedInterviewId,
        1,
        reservation(),
      );

      expect(stored).toMatchObject({ ok: false, error: { code: 'duplicate_conflict' } });
      expect(executor.calls, `interviewId=${malformedInterviewId}`).toHaveLength(0);
    }
  });

  it('rejects runtime Date objects at string-only timestamp write boundaries', async () => {
    const reservationExecutor = new ScriptedExecutor([]);
    await expect(
      new PostgresTranscriptRepository(reservationExecutor).reserveAiDelivery(
        INTERVIEW_ID,
        1,
        reservation({ createdAt: new Date(T0) as unknown as string }),
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: 'duplicate_conflict' } });
    expect(reservationExecutor.calls).toHaveLength(0);

    const requested = reservation();
    const turn: AiTranscriptTurn = {
      kind: 'turn',
      interviewId: INTERVIEW_ID,
      sequenceNumber: 1,
      turnId: requested.turnId,
      deliveryEventId: 'provider-playout-date',
      speaker: 'ai_interviewer',
      turnType: 'greeting',
      text: requested.proposedText,
      occurredAt: T1,
      guideReference: null,
      delivery: { status: 'complete' },
    };
    const resolutionExecutor = new ScriptedExecutor([result([deliveryRow(requested)])]);
    await expect(
      new PostgresTranscriptRepository(resolutionExecutor).resolveAiDelivery(INTERVIEW_ID, {
        deliveryId: requested.deliveryId,
        provider: 'demo-voice',
        providerDeliveryEventId: turn.deliveryEventId,
        resolvedAt: new Date(T2) as unknown as string,
        turn,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'duplicate_conflict' } });
    expect(resolutionExecutor.calls).toHaveLength(1);
  });

  it('accepts maximum-length internal AI-delivery identities and proposed text', async () => {
    const maxId = (prefix: string): string => `${prefix}${'x'.repeat(128 - prefix.length)}`;
    const requested = reservation({
      deliveryId: maxId('delivery-'),
      jobId: maxId('job-'),
      workflowRunId: maxId('workflow-'),
      turnId: maxId('turn-'),
      utteranceId: maxId('utterance-'),
      proposedText: 'x'.repeat(20_000),
    });
    const executor = new ScriptedExecutor([
      result(),
      result([guardRow()]),
      result(),
      result([{ allocatedSequence: 1 }]),
      result([], 1),
    ]);

    const stored = await new PostgresTranscriptRepository(executor).reserveAiDelivery(
      INTERVIEW_ID,
      1,
      requested,
    );

    expect(stored).toEqual({
      ok: true,
      value: { outcome: 'inserted', value: pendingDelivery(requested) },
    });
  });

  it.each([
    ['blank', '   '],
    ['overlong', 'x'.repeat(20_001)],
  ])('rejects %s proposed AI text before issuing SQL', async (_label, proposedText) => {
    const executor = new ScriptedExecutor([]);

    await expect(
      new PostgresTranscriptRepository(executor).reserveAiDelivery(
        INTERVIEW_ID,
        1,
        reservation({ proposedText }),
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: 'duplicate_conflict' } });
    expect(executor.calls).toHaveLength(0);
  });

  it('returns an exact pending reservation and exposes it for recovery without another lock', async () => {
    const requested = reservation();
    const row = deliveryRow(requested);
    const retryExecutor = new ScriptedExecutor([result([row])]);

    await expect(
      new PostgresTranscriptRepository(retryExecutor).reserveAiDelivery(INTERVIEW_ID, 1, requested),
    ).resolves.toEqual({
      ok: true,
      value: { outcome: 'existing', value: pendingDelivery(requested) },
    });
    expect(retryExecutor.calls).toHaveLength(1);

    const offsetRetry = { ...requested, createdAt: '2026-08-06T12:00:00.000+02:00' };
    await expect(
      new PostgresTranscriptRepository(new ScriptedExecutor([result([row])])).reserveAiDelivery(
        INTERVIEW_ID,
        1,
        offsetRetry,
      ),
    ).resolves.toEqual({
      ok: true,
      value: { outcome: 'existing', value: pendingDelivery(requested) },
    });

    const recoveryExecutor = new ScriptedExecutor([result([row])]);
    await expect(
      new PostgresTranscriptRepository(recoveryExecutor).listPendingAiDeliveries(INTERVIEW_ID),
    ).resolves.toEqual({ ok: true, value: [pendingDelivery(requested)] });
  });

  it.each([
    {
      label: 'complete',
      proposedText: '  Grüße, 東京! Ça va?  ',
      heardText: '  Grüße, 東京! Ça va?  ',
      delivery: { status: 'complete' as const },
    },
    {
      label: 'interrupted',
      proposedText: '  Grüße, 東京! Ça va? Weiter.  ',
      heardText: '  Grüße, 東京! Ça va? ',
      delivery: { status: 'interrupted' as const, interruptedAt: T1 },
    },
  ])(
    'resolves a $label delivery exactly at its reserved sequence with heard-only text',
    async (sample) => {
      const requested = reservation({ proposedText: sample.proposedText });
      const turn: AiTranscriptTurn = {
        kind: 'turn',
        interviewId: INTERVIEW_ID,
        sequenceNumber: 1,
        turnId: requested.turnId,
        deliveryEventId: NATIVE_PROVIDER_EVENT_ID,
        speaker: 'ai_interviewer',
        turnType: 'greeting',
        text: sample.heardText,
        occurredAt: T1,
        guideReference: null,
        delivery: sample.delivery,
      };
      const write: ResolvedAiTurnWrite = {
        deliveryId: requested.deliveryId,
        provider: 'demo-voice',
        providerDeliveryEventId: turn.deliveryEventId,
        resolvedAt: T2,
        turn,
      };
      const executor = new ScriptedExecutor([
        result([deliveryRow(requested)]),
        result([
          guardRow({
            nextSequenceNumber: 2,
            pendingDeliveryId: requested.deliveryId,
            pendingReservedSequenceNumber: 1,
          }),
        ]),
        result([deliveryRow(requested)]),
        result([{ deliveryId: requested.deliveryId }]),
        result([], 1),
        result([], 1),
      ]);

      const resolved = await new PostgresTranscriptRepository(executor).resolveAiDelivery(
        INTERVIEW_ID,
        write,
      );

      expect(resolved).toEqual({ ok: true, value: { outcome: 'inserted', value: turn } });
      expect(executor.calls.some((call) => call.statement.includes('ALLOCATE'))).toBe(false);
      expect(executor.calls[3]?.parameters).toContain(sample.heardText);
      expect(executor.calls[3]?.parameters).toContain(NATIVE_PROVIDER_EVENT_ID);
      expect(executor.calls[5]?.parameters).toContain(sample.heardText);
      expect(executor.calls[5]?.parameters).toContain(NATIVE_PROVIDER_EVENT_ID);
      if (sample.label === 'interrupted') {
        expect(executor.calls[3]?.parameters).not.toContain(sample.proposedText);
        expect(executor.calls[5]?.parameters).not.toContain(sample.proposedText);
      }
    },
  );

  it.each([
    ['punctuation', '  Grüße, 東京! Ça va!  '],
    ['case', '  grüße, 東京! Ça va?  '],
    ['whitespace', ' Grüße, 東京! Ça va?  '],
    ['diacritic normalization', '  Gru\u0308ße, 東京! Ça va?  '],
    ['non-Latin text', '  Grüße, 东京! Ça va?  '],
  ])(
    'rejects a complete delivery with a %s mismatch before persistence',
    async (_label, heardText) => {
      const requested = reservation({ proposedText: '  Grüße, 東京! Ça va?  ' });
      const turn: AiTranscriptTurn = {
        kind: 'turn',
        interviewId: INTERVIEW_ID,
        sequenceNumber: 1,
        turnId: requested.turnId,
        deliveryEventId: 'provider-playout-1',
        speaker: 'ai_interviewer',
        turnType: 'greeting',
        text: heardText,
        occurredAt: T1,
        guideReference: null,
        delivery: { status: 'complete' },
      };
      const executor = new ScriptedExecutor([result([deliveryRow(requested)])]);

      const resolved = await new PostgresTranscriptRepository(executor).resolveAiDelivery(
        INTERVIEW_ID,
        {
          deliveryId: requested.deliveryId,
          provider: 'demo-voice',
          providerDeliveryEventId: turn.deliveryEventId,
          resolvedAt: T2,
          turn,
        },
      );

      expect(resolved).toMatchObject({ ok: false, error: { code: 'duplicate_conflict' } });
      expect(executor.calls).toHaveLength(1);
    },
  );

  it.each([
    ['leading boundary whitespace', ' demo-voice'],
    ['trailing boundary whitespace', 'demo-voice '],
    ['more than 100 characters', 'x'.repeat(101)],
  ])('rejects an AI delivery provider with %s without mutating state', async (_label, provider) => {
    const requested = reservation();
    const turn: AiTranscriptTurn = {
      kind: 'turn',
      interviewId: INTERVIEW_ID,
      sequenceNumber: 1,
      turnId: requested.turnId,
      deliveryEventId: 'provider-playout-1',
      speaker: 'ai_interviewer',
      turnType: 'greeting',
      text: requested.proposedText,
      occurredAt: T1,
      guideReference: null,
      delivery: { status: 'complete' },
    };
    const executor = new ScriptedExecutor([result([deliveryRow(requested)])]);

    const resolved = await new PostgresTranscriptRepository(executor).resolveAiDelivery(
      INTERVIEW_ID,
      {
        deliveryId: requested.deliveryId,
        provider,
        providerDeliveryEventId: turn.deliveryEventId,
        resolvedAt: T2,
        turn,
      },
    );

    expect(resolved).toMatchObject({ ok: false, error: { code: 'duplicate_conflict' } });
    expect(executor.calls).toHaveLength(1);
  });

  it('rejects a persisted interrupted delivery with blank confirmed speech as corrupt data', async () => {
    const requested = reservation();
    const turn: AiTranscriptTurn = {
      kind: 'turn',
      interviewId: INTERVIEW_ID,
      sequenceNumber: 1,
      turnId: requested.turnId,
      deliveryEventId: 'provider-playout-1',
      speaker: 'ai_interviewer',
      turnType: 'greeting',
      text: 'Welcome',
      occurredAt: T1,
      guideReference: null,
      delivery: { status: 'interrupted', interruptedAt: T1 },
    };
    const executor = new ScriptedExecutor([
      result([
        deliveryRow(requested, {
          status: 'interrupted',
          provider: 'demo-voice',
          providerDeliveryEventId: turn.deliveryEventId,
          confirmedSpokenText: '   ',
          resolvedAt: T2,
          interruptedAt: T1,
        }),
      ]),
    ]);

    const resolved = await new PostgresTranscriptRepository(executor).resolveAiDelivery(
      INTERVIEW_ID,
      {
        deliveryId: requested.deliveryId,
        provider: 'demo-voice',
        providerDeliveryEventId: turn.deliveryEventId,
        resolvedAt: T2,
        turn,
      },
    );

    expect(resolved).toMatchObject({ ok: false, error: { code: 'corrupt_data' } });
    expect(executor.calls).toHaveLength(1);
  });

  it('returns an exact resolved-delivery retry without taking another write lock', async () => {
    const requested = reservation();
    const turn: AiTranscriptTurn = {
      kind: 'turn',
      interviewId: INTERVIEW_ID,
      sequenceNumber: 1,
      turnId: requested.turnId,
      deliveryEventId: 'provider-playout-1',
      speaker: 'ai_interviewer',
      turnType: 'greeting',
      text: requested.proposedText,
      occurredAt: T1,
      guideReference: null,
      delivery: { status: 'complete' },
    };
    const write: ResolvedAiTurnWrite = {
      deliveryId: requested.deliveryId,
      provider: 'demo-voice',
      providerDeliveryEventId: turn.deliveryEventId,
      resolvedAt: T2,
      turn,
    };
    const executor = new ScriptedExecutor([
      result([
        deliveryRow(requested, {
          status: 'complete',
          provider: write.provider,
          providerDeliveryEventId: write.providerDeliveryEventId,
          confirmedSpokenText: turn.text,
          resolvedAt: write.resolvedAt,
        }),
      ]),
      ...aggregateResults([
        entryRow({
          entryId: turn.turnId,
          occurredAt: turn.occurredAt,
          speaker: turn.speaker,
          turnType: turn.turnType,
          text: turn.text,
          deliveryEventId: turn.deliveryEventId,
          deliveryStatus: turn.delivery.status,
        }),
      ]),
    ]);

    const offsetWrite: ResolvedAiTurnWrite = {
      ...write,
      resolvedAt: '2026-08-06T12:02:00.000+02:00',
      turn: { ...turn, occurredAt: '2026-08-06T12:01:00.000+02:00' },
    };
    await expect(
      new PostgresTranscriptRepository(executor).resolveAiDelivery(INTERVIEW_ID, offsetWrite),
    ).resolves.toEqual({ ok: true, value: { outcome: 'existing', value: turn } });
    expect(executor.calls.every((call) => !call.statement.includes('FOR UPDATE'))).toBe(true);
  });

  it('closes an abandoned reserved delivery as a technical gap at the reserved sequence', async () => {
    const requested = reservation();
    const gap: TranscriptTechnicalGap = {
      kind: 'technical_gap',
      interviewId: INTERVIEW_ID,
      sequenceNumber: 1,
      gapId: 'gap-1',
      sourceEventId: 'recovery-timeout-1',
      source: 'audio_output',
      sourceProvider: null,
      relatedUtteranceId: null,
      description: 'Audio playout confirmation was unavailable.',
      occurredAt: T1,
      relatedSegmentId: null,
    };
    const write: GappedAiDeliveryWrite = {
      deliveryId: requested.deliveryId,
      status: 'gapped',
      resolvedAt: T2,
      gap,
    };
    const executor = new ScriptedExecutor([
      result([deliveryRow(requested)]),
      result([
        guardRow({
          nextSequenceNumber: 2,
          pendingDeliveryId: requested.deliveryId,
          pendingReservedSequenceNumber: 1,
        }),
      ]),
      result([deliveryRow(requested)]),
      result([{ deliveryId: requested.deliveryId }]),
      result([], 1),
      result([], 1),
    ]);

    const stored = await new PostgresTranscriptRepository(executor).gapAiDelivery(
      INTERVIEW_ID,
      write,
    );

    expect(stored).toEqual({ ok: true, value: { outcome: 'inserted', value: gap } });
    expect(executor.calls[3]?.statement).toContain('status = $3');
    expect(executor.calls[4]?.parameters[1]).toBe(1);
    expect(
      executor.calls.every((call) => !call.statement.includes('next_transcript_sequence + 1')),
    ).toBe(true);
    expect(
      executor.calls.every(
        (call) => !call.statement.includes('UPDATE app.transcript_partial_events'),
      ),
    ).toBe(true);
  });

  it('returns an exact gapped-delivery retry without taking another write lock', async () => {
    const requested = reservation();
    const gap: TranscriptTechnicalGap = {
      kind: 'technical_gap',
      interviewId: INTERVIEW_ID,
      sequenceNumber: 1,
      gapId: 'gap-1',
      sourceEventId: 'recovery-timeout-1',
      source: 'audio_output',
      sourceProvider: null,
      relatedUtteranceId: null,
      description: 'Audio playout confirmation was unavailable.',
      occurredAt: T1,
      relatedSegmentId: null,
    };
    const write: GappedAiDeliveryWrite = {
      deliveryId: requested.deliveryId,
      status: 'gapped',
      resolvedAt: T2,
      gap,
    };
    const executor = new ScriptedExecutor([
      result([deliveryRow(requested, { status: write.status, resolvedAt: write.resolvedAt })]),
      ...aggregateResults([
        entryRow({
          entryId: gap.gapId,
          kind: gap.kind,
          occurredAt: gap.occurredAt,
          gapSource: gap.source,
          gapDescription: gap.description,
          relatedSegmentId: gap.relatedSegmentId,
          relatedUtteranceId: gap.relatedUtteranceId,
          sourceEventId: gap.sourceEventId,
        }),
      ]),
    ]);

    const offsetWrite: GappedAiDeliveryWrite = {
      ...write,
      resolvedAt: '2026-08-06T12:02:00.000+02:00',
      gap: { ...gap, occurredAt: '2026-08-06T12:01:00.000+02:00' },
    };
    await expect(
      new PostgresTranscriptRepository(executor).gapAiDelivery(INTERVIEW_ID, offsetWrite),
    ).resolves.toEqual({ ok: true, value: { outcome: 'existing', value: gap } });
    expect(executor.calls.every((call) => !call.statement.includes('FOR UPDATE'))).toBe(true);
  });

  it('blocks a participant final while an AI sequence remains pending', async () => {
    const { final, turn } = participantWrite();
    const executor = new ScriptedExecutor([
      result(),
      result(),
      result([
        guardRow({
          nextSequenceNumber: 2,
          pendingDeliveryId: 'delivery-record-1',
          pendingReservedSequenceNumber: 1,
        }),
      ]),
      result(),
      result(),
    ]);

    const stored = await new PostgresTranscriptRepository(executor).appendParticipantFinal(
      INTERVIEW_ID,
      1,
      SOURCE,
      final,
      turn,
    );

    expect(stored).toEqual({
      ok: false,
      error: {
        code: 'pending_ai_delivery',
        interviewId: INTERVIEW_ID,
        deliveryId: 'delivery-record-1',
        reservedSequenceNumber: 1,
      },
    });
    expect(
      executor.calls.every((call) => !call.statement.includes('next_transcript_sequence + 1')),
    ).toBe(true);
  });

  it('persists participant source identity and resolves only that provider partial', async () => {
    const { final, turn } = participantWrite({ sequenceNumber: 2 });
    const executor = new ScriptedExecutor([
      result(),
      result(),
      result([
        guardRow({
          nextSequenceNumber: 2,
          lastSequenceNumber: 1,
          lastOccurredAt: T0,
        }),
      ]),
      result(),
      result(),
      ...aggregateResults([openMainQuestionRow()]),
      result([{ allocatedSequence: 2 }]),
      result([], 1),
      result([], 1),
      result([], 1),
      result([], 1),
    ]);

    const stored = await new PostgresTranscriptRepository(executor).appendParticipantFinal(
      INTERVIEW_ID,
      2,
      SOURCE,
      final,
      turn,
    );

    expect(stored).toEqual({ ok: true, value: { outcome: 'inserted', value: turn } });
    expect(executor.calls[13]?.parameters).toEqual([
      INTERVIEW_ID,
      turn.turnId,
      turn.text,
      GUIDE_ID,
      'main-1',
      SOURCE.provider,
      turn.providerEventId,
      turn.sourceSegmentId,
    ]);
    expect(executor.calls[14]?.parameters).toEqual([
      INTERVIEW_ID,
      SOURCE.provider,
      final.providerEventId,
      final.segmentId,
      SOURCE.utteranceId,
      final.turnId,
      final.text,
      final.observedAt,
      final.finalizedAt,
    ]);
    expect(executor.calls[15]?.parameters).toEqual([
      INTERVIEW_ID,
      turn.sourceSegmentId,
      'ignored_finalized',
      SOURCE.provider,
      SOURCE.utteranceId,
    ]);
    expect(executor.calls[15]?.statement).toContain('provider = $4');
  });

  it('rejects a participant reference that differs from the open question before allocation', async () => {
    const { final, turn } = participantWrite({
      sequenceNumber: 2,
      guideReference: followUpReference,
    });
    const executor = new ScriptedExecutor([
      result(),
      result(),
      result([
        guardRow({
          nextSequenceNumber: 2,
          lastSequenceNumber: 1,
          lastOccurredAt: T0,
        }),
      ]),
      result(),
      result(),
      ...aggregateResults([openMainQuestionRow()], [...guideRows, followUpGuideRow]),
    ]);

    const stored = await new PostgresTranscriptRepository(executor).appendParticipantFinal(
      INTERVIEW_ID,
      2,
      SOURCE,
      final,
      turn,
    );

    expect(stored).toEqual({
      ok: false,
      error: {
        code: 'constraint_violation',
        constraint: 'transcript_participant_question_reference_mismatch',
      },
    });
    expect(executor.calls[2]?.statement).toContain('FOR UPDATE OF st, c');
    expect(
      executor.calls.every(
        (call) =>
          !call.statement.includes('next_transcript_sequence + 1') &&
          !call.statement.startsWith('INSERT'),
      ),
    ).toBe(true);
  });

  it('rejects a participant final without an open question before allocation', async () => {
    const { final, turn } = participantWrite();
    const executor = new ScriptedExecutor([
      result(),
      result(),
      result([guardRow()]),
      result(),
      result(),
      ...aggregateResults([]),
    ]);

    const stored = await new PostgresTranscriptRepository(executor).appendParticipantFinal(
      INTERVIEW_ID,
      1,
      SOURCE,
      final,
      turn,
    );

    expect(stored).toEqual({
      ok: false,
      error: {
        code: 'constraint_violation',
        constraint: 'transcript_participant_without_question',
      },
    });
    expect(executor.calls[2]?.statement).toContain('FOR UPDATE OF st, c');
    expect(
      executor.calls.every(
        (call) =>
          !call.statement.includes('next_transcript_sequence + 1') &&
          !call.statement.startsWith('INSERT'),
      ),
    ).toBe(true);
  });

  it('records an STT gap with provider scope and leaves other providers untouched', async () => {
    const gap: TranscriptTechnicalGap = {
      kind: 'technical_gap',
      interviewId: INTERVIEW_ID,
      sequenceNumber: 1,
      gapId: 'gap-stt-1',
      sourceEventId: 'stt-gap-event-1',
      source: 'speech_to_text',
      sourceProvider: SOURCE.provider,
      relatedUtteranceId: SOURCE.utteranceId,
      description: 'The final STT segment was unavailable.',
      occurredAt: T1,
      relatedSegmentId: 'segment-shared',
    };
    const executor = new ScriptedExecutor([
      result(),
      result([guardRow()]),
      result(),
      result(),
      result([{ allocatedSequence: 1 }]),
      result([], 1),
      result([], 1),
      result([], 1),
    ]);

    const stored = await new PostgresTranscriptRepository(executor).appendTechnicalGap(
      INTERVIEW_ID,
      1,
      gap,
    );

    expect(stored).toEqual({ ok: true, value: { outcome: 'inserted', value: gap } });
    expect(executor.calls[6]?.parameters).toEqual([
      INTERVIEW_ID,
      gap.gapId,
      gap.source,
      SOURCE.provider,
      gap.description,
      gap.relatedSegmentId,
      gap.relatedUtteranceId,
      gap.sourceEventId,
    ]);
    expect(executor.calls[7]?.parameters).toEqual([
      INTERVIEW_ID,
      gap.relatedSegmentId,
      'ignored_finalized',
      SOURCE.provider,
      SOURCE.utteranceId,
    ]);
  });

  it('rejects an STT gap after the same provider segment was finalized', async () => {
    const gap: TranscriptTechnicalGap = {
      kind: 'technical_gap',
      interviewId: INTERVIEW_ID,
      sequenceNumber: 2,
      gapId: 'gap-after-final',
      sourceEventId: 'stt-gap-after-final',
      source: 'speech_to_text',
      sourceProvider: SOURCE.provider,
      relatedUtteranceId: 'different-gap-utterance',
      description: 'A late gap must not replace the final transcript.',
      occurredAt: T2,
      relatedSegmentId: 'segment-1',
    };
    const executor = new ScriptedExecutor([
      result(),
      result([
        guardRow({
          nextSequenceNumber: 2,
          lastSequenceNumber: 1,
          lastOccurredAt: T1,
        }),
      ]),
      result(),
      result([{ turnId: 'answer-1' }]),
    ]);

    const stored = await new PostgresTranscriptRepository(executor).appendTechnicalGap(
      INTERVIEW_ID,
      2,
      gap,
    );

    expect(stored).toEqual({
      ok: false,
      error: {
        code: 'duplicate_conflict',
        resource: 'transcript',
        identity: `${SOURCE.provider}:different-gap-utterance`,
      },
    });
    expect(executor.calls[1]?.statement).toContain('FOR UPDATE OF st, c');
    expect(executor.calls[3]?.statement).toContain('app.transcript_final_segments');
    expect(executor.calls[3]?.statement).toContain('segment_id = $4');
    expect(executor.calls[3]?.parameters).toEqual([
      INTERVIEW_ID,
      SOURCE.provider,
      'different-gap-utterance',
      gap.relatedSegmentId,
    ]);
    expect(
      executor.calls.every(
        (call) =>
          !call.statement.includes('next_transcript_sequence + 1') &&
          !call.statement.startsWith('INSERT'),
      ),
    ).toBe(true);
  });

  it('rejects a canonical write when the interview lifecycle has failed', async () => {
    const gap: TranscriptTechnicalGap = {
      kind: 'technical_gap',
      interviewId: INTERVIEW_ID,
      sequenceNumber: 1,
      gapId: 'gap-after-failure',
      sourceEventId: 'transport-gap-after-failure',
      source: 'transport',
      sourceProvider: null,
      relatedUtteranceId: null,
      description: 'This write must remain non-canonical.',
      occurredAt: T1,
      relatedSegmentId: null,
    };
    const executor = new ScriptedExecutor([
      result(),
      result([guardRow({ status: 'failed' })]),
      result(),
    ]);

    await expect(
      new PostgresTranscriptRepository(executor).appendTechnicalGap(INTERVIEW_ID, 1, gap),
    ).resolves.toEqual({
      ok: false,
      error: { code: 'transcript_finalized', interviewId: INTERVIEW_ID },
    });
    expect(
      executor.calls.every(
        (call) =>
          !call.statement.includes('next_transcript_sequence + 1') &&
          !call.statement.startsWith('INSERT'),
      ),
    ).toBe(true);
  });

  it.each([
    ['an STT gap without a provider', 'speech_to_text', null],
    ['a non-STT gap with a provider', 'transport', SOURCE.provider],
  ] as const)('rejects %s', async (_label, source, provider) => {
    const gap = {
      kind: 'technical_gap',
      interviewId: INTERVIEW_ID,
      sequenceNumber: 1,
      gapId: 'gap-invalid-provider',
      sourceEventId: 'gap-event-invalid-provider',
      source,
      sourceProvider: provider,
      description: 'Invalid source-provider shape.',
      occurredAt: T1,
      relatedSegmentId: 'segment-1',
    } as unknown as TranscriptTechnicalGap;
    const executor = new ScriptedExecutor([]);

    await expect(
      new PostgresTranscriptRepository(executor).appendTechnicalGap(INTERVIEW_ID, 1, gap),
    ).resolves.toEqual({
      ok: false,
      error: { code: 'duplicate_conflict', resource: 'transcript', identity: gap.gapId },
    });
    expect(executor.calls).toHaveLength(0);
  });

  it('deduplicates a final STT utterance even when transport identities change', async () => {
    const stored = participantWrite();
    const retry = participantWrite({
      providerEventId: 'provider-final-retry',
      segmentId: 'segment-retry',
      turnId: 'answer-retry',
      sequenceNumber: 2,
    });
    const executor = new ScriptedExecutor(existingParticipantResults(stored));

    const resultValue = await new PostgresTranscriptRepository(executor).appendParticipantFinal(
      INTERVIEW_ID,
      2,
      SOURCE,
      retry.final,
      retry.turn,
    );

    expect(resultValue).toEqual({
      ok: true,
      value: { outcome: 'existing', value: stored.turn },
    });
    expect(executor.calls.every((call) => !call.statement.includes('FOR UPDATE'))).toBe(true);
  });

  it('rejects conflicting content for an already finalized provider utterance', async () => {
    const stored = participantWrite();
    const conflicting = participantWrite({
      providerEventId: 'provider-final-retry',
      segmentId: 'segment-retry',
      turnId: 'answer-retry',
      sequenceNumber: 2,
      text: 'Conflicting participant text.',
    });
    const executor = new ScriptedExecutor(existingParticipantResults(stored));

    await expect(
      new PostgresTranscriptRepository(executor).appendParticipantFinal(
        INTERVIEW_ID,
        2,
        SOURCE,
        conflicting.final,
        conflicting.turn,
      ),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'duplicate_conflict',
        resource: 'transcript',
        identity: `${SOURCE.provider}:${SOURCE.utteranceId}`,
      },
    });
    expect(executor.calls.every((call) => !call.statement.includes('FOR UPDATE'))).toBe(true);
  });

  it('rejects changed STT timing metadata for an already finalized utterance', async () => {
    const stored = participantWrite();
    const conflicting = participantWrite({
      observedAt: T2,
      finalizedAt: T2,
      sequenceNumber: 2,
    });
    const executor = new ScriptedExecutor(existingParticipantResults(stored));

    await expect(
      new PostgresTranscriptRepository(executor).appendParticipantFinal(
        INTERVIEW_ID,
        2,
        SOURCE,
        conflicting.final,
        conflicting.turn,
      ),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'duplicate_conflict',
        resource: 'transcript',
        identity: `${SOURCE.provider}:${SOURCE.utteranceId}`,
      },
    });
  });

  it.each([
    ['completed lifecycle', { status: 'completed' }],
    ['failed lifecycle', { status: 'failed' }],
    ['stored finalization', { status: 'ending', isFinalized: true }],
  ] as const)('rejects a new reservation after %s', async (_label, guardOverrides) => {
    const requested = reservation();
    const executor = new ScriptedExecutor([result(), result([guardRow(guardOverrides)]), result()]);

    const stored = await new PostgresTranscriptRepository(executor).reserveAiDelivery(
      INTERVIEW_ID,
      1,
      requested,
    );

    expect(stored).toEqual({
      ok: false,
      error: { code: 'transcript_finalized', interviewId: INTERVIEW_ID },
    });
    expect(executor.calls).toHaveLength(3);
  });

  it('rejects timestamp regression before mutating the transcript counter', async () => {
    const requested = reservation({ createdAt: T1 });
    const executor = new ScriptedExecutor([
      result(),
      result([
        guardRow({
          nextSequenceNumber: 2,
          lastSequenceNumber: 1,
          lastOccurredAt: T2,
        }),
      ]),
      result(),
    ]);

    const stored = await new PostgresTranscriptRepository(executor).reserveAiDelivery(
      INTERVIEW_ID,
      2,
      requested,
    );

    expect(stored).toEqual({
      ok: false,
      error: { code: 'constraint_violation', constraint: 'transcript_timestamp_regression' },
    });
    expect(
      executor.calls.every((call) => !call.statement.includes('next_transcript_sequence + 1')),
    ).toBe(true);
  });

  it('advances the transcript mutation fence after accepting a partial under the shared lock', async () => {
    const partial = participantPartial();
    const executor = new ScriptedExecutor([
      result(),
      result([guardRow()]),
      result(),
      result([{ providerEventFinalSegmentId: null, isFinalized: false, hasGap: false }]),
      result(),
      result([], 1),
      result([{ transcriptMutationVersion: 1 }]),
    ]);

    await expect(
      new PostgresTranscriptRepository(executor).upsertPartial(INTERVIEW_ID, SOURCE, partial),
    ).resolves.toEqual({
      ok: true,
      value: { outcome: 'inserted', value: partial },
    });

    expect(executor.calls[1]?.statement).toContain('FOR UPDATE OF st, c');
    expect(executor.calls[5]?.statement).toContain('INSERT INTO app.transcript_partial_events');
    expect(executor.calls[6]).toMatchObject({
      parameters: [INTERVIEW_ID],
    });
    expect(executor.calls[6]?.statement).toContain(
      'transcript_mutation_version = transcript_mutation_version + 1',
    );
    expect(executor.calls[6]?.statement).toContain(
      'RETURNING transcript_mutation_version AS "transcriptMutationVersion"',
    );
  });

  it('advances the transcript mutation fence after replacing an accepted partial revision', async () => {
    const partial = {
      ...participantPartial(),
      providerEventId: 'partial-event-2',
      revision: 2,
      observedAt: T2,
    };
    const executor = new ScriptedExecutor([
      result(),
      result([guardRow()]),
      result(),
      result([{ providerEventFinalSegmentId: null, isFinalized: false, hasGap: false }]),
      result([
        {
          ...participantPartial(),
          provider: SOURCE.provider,
          disposition: 'accepted',
        },
      ]),
      result([], 1),
      result([], 1),
      result([{ transcriptMutationVersion: 8 }]),
    ]);

    await expect(
      new PostgresTranscriptRepository(executor).upsertPartial(INTERVIEW_ID, SOURCE, partial),
    ).resolves.toEqual({
      ok: true,
      value: { outcome: 'updated', value: partial },
    });

    expect(executor.calls[5]?.statement).toContain("SET disposition = 'ignored_stale'");
    expect(executor.calls[6]?.statement).toContain('INSERT INTO app.transcript_partial_events');
    expect(executor.calls[7]?.statement).toContain(
      'transcript_mutation_version = transcript_mutation_version + 1',
    );
  });

  it('ignores a late partial for a finalized utterance even when transport IDs change', async () => {
    const partial: PartialTranscriptSegment = {
      interviewId: INTERVIEW_ID,
      sourceProvider: SOURCE.provider,
      utteranceId: SOURCE.utteranceId,
      providerEventId: 'partial-event-late',
      segmentId: 'segment-late',
      text: '  exact partial  ',
      revision: 1,
      observedAt: T1,
    };
    const executor = new ScriptedExecutor([
      result(),
      result([guardRow()]),
      result(),
      result([{ providerEventFinalSegmentId: null, isFinalized: true, hasGap: false }]),
      result([], 1),
    ]);

    const stored = await new PostgresTranscriptRepository(executor).upsertPartial(
      INTERVIEW_ID,
      SOURCE,
      partial,
    );

    expect(stored).toEqual({
      ok: true,
      value: { outcome: 'ignored_finalized', value: partial },
    });
    expect(executor.calls[4]?.parameters).toContain('  exact partial  ');
    expect(executor.calls[4]?.parameters).toContain('ignored_finalized');
    expect(executor.calls[3]?.parameters).toEqual([
      INTERVIEW_ID,
      SOURCE.provider,
      partial.segmentId,
      partial.providerEventId,
      SOURCE.utteranceId,
    ]);
    expect(executor.calls[3]?.statement).toContain('f.utterance_id = $5');
  });

  it('ignores a late partial and rejects a late final for a gapped source identity', async () => {
    const partial = { ...participantPartial(), segmentId: 'late-gap-segment' };
    const partialExecutor = new ScriptedExecutor([
      result(),
      result([guardRow()]),
      result(),
      result([{ providerEventFinalSegmentId: null, isFinalized: false, hasGap: true }]),
      result([], 1),
    ]);
    await expect(
      new PostgresTranscriptRepository(partialExecutor).upsertPartial(
        INTERVIEW_ID,
        SOURCE,
        partial,
      ),
    ).resolves.toEqual({
      ok: true,
      value: { outcome: 'ignored_finalized', value: partial },
    });
    expect(partialExecutor.calls[4]?.parameters).toContain('ignored_finalized');
    expect(partialExecutor.calls[3]?.statement).toContain('g.related_utterance_id = $5');

    const source = { provider: SOURCE.provider, utteranceId: 'different-final-utterance' };
    const write = participantWrite();
    const final = { ...write.final, utteranceId: source.utteranceId };
    const turn = write.turn;
    const finalExecutor = new ScriptedExecutor([result(), result([{ gapId: 'gap-stt-1' }])]);
    await expect(
      new PostgresTranscriptRepository(finalExecutor).appendParticipantFinal(
        INTERVIEW_ID,
        1,
        source,
        final,
        turn,
      ),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'duplicate_conflict',
        resource: 'transcript',
        identity: `${SOURCE.provider}:${source.utteranceId}`,
      },
    });
    expect(finalExecutor.calls).toHaveLength(2);
    expect(finalExecutor.calls[1]?.statement).toContain('related_segment_id = $4');
    expect(finalExecutor.calls[1]?.parameters).toEqual([
      INTERVIEW_ID,
      SOURCE.provider,
      source.utteranceId,
      final.segmentId,
    ]);
  });

  it('rejects reuse of a partial segment by another utterance', async () => {
    const source = { provider: SOURCE.provider, utteranceId: 'another-utterance' };
    const partial = {
      ...participantPartial(),
      utteranceId: source.utteranceId,
      providerEventId: 'partial-event-another-utterance',
      revision: 2,
    };
    const executor = new ScriptedExecutor([
      result(),
      result([guardRow()]),
      result(),
      result([{ providerEventFinalSegmentId: null, isFinalized: false, hasGap: false }]),
      result([
        {
          ...participantPartial(),
          provider: SOURCE.provider,
          disposition: 'accepted',
        },
      ]),
    ]);

    await expect(
      new PostgresTranscriptRepository(executor).upsertPartial(INTERVIEW_ID, source, partial),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'duplicate_conflict',
        resource: 'transcript',
        identity: partial.segmentId,
      },
    });
  });

  it('treats equivalent timestamp offsets as idempotent source retries', async () => {
    const storedPartial = participantPartial();
    const offsetPartial = {
      ...storedPartial,
      observedAt: '2026-08-06T12:01:00.000+02:00',
    };
    const partialExecutor = new ScriptedExecutor([
      result([
        {
          ...storedPartial,
          provider: SOURCE.provider,
          disposition: 'accepted',
        },
      ]),
    ]);
    await expect(
      new PostgresTranscriptRepository(partialExecutor).upsertPartial(
        INTERVIEW_ID,
        SOURCE,
        offsetPartial,
      ),
    ).resolves.toEqual({
      ok: true,
      value: { outcome: 'existing', value: offsetPartial },
    });

    const stored = participantWrite();
    const retry = participantWrite({
      occurredAt: '2026-08-06T12:01:00.000+02:00',
      observedAt: '2026-08-06T12:01:00.000+02:00',
      finalizedAt: '2026-08-06T12:01:00.000+02:00',
    });
    await expect(
      new PostgresTranscriptRepository(
        new ScriptedExecutor(existingParticipantResults(stored)),
      ).appendParticipantFinal(INTERVIEW_ID, 1, SOURCE, retry.final, retry.turn),
    ).resolves.toEqual({
      ok: true,
      value: { outcome: 'existing', value: stored.turn },
    });
  });

  it('rejects a partial whose provider source disagrees with its payload', async () => {
    const partial = { ...participantPartial(), sourceProvider: 'other-stt' };
    const executor = new ScriptedExecutor([]);

    await expect(
      new PostgresTranscriptRepository(executor).upsertPartial(INTERVIEW_ID, SOURCE, partial),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'duplicate_conflict',
        resource: 'transcript',
        identity: partial.providerEventId,
      },
    });
    expect(executor.calls).toHaveLength(0);
  });

  it.each([
    ['empty', ''],
    ['whitespace-only', '   '],
    ['maximum-length', 'x'.repeat(20_000)],
  ] as const)(
    'persists a %s partial exactly as allowed by the shared contract',
    async (_, text) => {
      const partial = {
        ...participantPartial(),
        providerEventId: NATIVE_PROVIDER_EVENT_ID,
        text,
      };
      const executor = new ScriptedExecutor([
        result(),
        result([guardRow()]),
        result(),
        result([{ providerEventFinalSegmentId: null, isFinalized: false, hasGap: false }]),
        result(),
        result([], 1),
        result([{ transcriptMutationVersion: 1 }]),
      ]);

      const stored = await new PostgresTranscriptRepository(executor).upsertPartial(
        INTERVIEW_ID,
        SOURCE,
        partial,
      );

      expect(stored).toMatchObject({ ok: true, value: { outcome: 'inserted' } });
      expect(executor.calls[5]?.parameters[2]).toBe(NATIVE_PROVIDER_EVENT_ID);
      expect(executor.calls[5]?.parameters[6]).toBe(text);
    },
  );

  it('mirrors shared partial identifier and text boundaries without normalization', () => {
    const partial = participantPartial();
    const maxInternalId = `i${'x'.repeat(127)}`;
    const maxProvider = 'p'.repeat(100);
    const maxProviderEvent = 'e'.repeat(300);

    expect(
      partialInputSchema.parse({
        ...partial,
        interviewId: maxInternalId,
        sourceProvider: maxProvider,
        utteranceId: maxInternalId,
        providerEventId: maxProviderEvent,
        segmentId: maxInternalId,
        text: '',
      }),
    ).toMatchObject({ providerEventId: maxProviderEvent, text: '' });
    expect(
      speechRecognitionSourceSchema.parse({ provider: maxProvider, utteranceId: maxInternalId }),
    ).toEqual({ provider: maxProvider, utteranceId: maxInternalId });

    const invalidPartials = [
      { ...partial, interviewId: '' },
      { ...partial, interviewId: ' interview-1' },
      { ...partial, sourceProvider: ' demo-stt' },
      { ...partial, sourceProvider: 'p'.repeat(101) },
      { ...partial, utteranceId: '' },
      { ...partial, utteranceId: 'utterance/1' },
      { ...partial, utteranceId: `u${'x'.repeat(128)}` },
      { ...partial, providerEventId: '' },
      { ...partial, providerEventId: ' provider-event' },
      { ...partial, providerEventId: 'e'.repeat(301) },
      { ...partial, segmentId: '' },
      { ...partial, segmentId: 'segment 1' },
      { ...partial, segmentId: `s${'x'.repeat(128)}` },
      { ...partial, text: 'x'.repeat(20_001) },
    ];

    for (const invalid of invalidPartials) {
      expect(partialInputSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('maps a concurrent identical partial insert race to a retryable serialization failure', async () => {
    const partial = participantPartial();
    const uniqueRace = Object.assign(new Error('concurrent unique insert'), {
      code: '23505',
      constraint: 'transcript_partial_events_pk',
    });
    const executor = new ScriptedExecutor([
      result(),
      result([guardRow()]),
      result(),
      result([{ providerEventFinalSegmentId: null, isFinalized: false, hasGap: false }]),
      result(),
      uniqueRace,
    ]);

    await expect(
      new PostgresTranscriptRepository(executor).upsertPartial(INTERVIEW_ID, SOURCE, partial),
    ).resolves.toEqual({
      ok: false,
      error: { code: 'serialization_failure', retryable: true },
    });
  });

  it.each([
    ['completed lifecycle', { status: 'completed' }],
    ['failed lifecycle', { status: 'failed' }],
    ['stored finalization', { status: 'ending', isFinalized: true }],
  ] as const)(
    'audits a partial as ignored_finalized after %s under the shared lock',
    async (_label, guardOverrides) => {
      const partial = participantPartial();
      const executor = new ScriptedExecutor([
        result(),
        result([guardRow(guardOverrides)]),
        result(),
        result([], 1),
      ]);

      await expect(
        new PostgresTranscriptRepository(executor).upsertPartial(INTERVIEW_ID, SOURCE, partial),
      ).resolves.toEqual({
        ok: true,
        value: { outcome: 'ignored_finalized', value: partial },
      });
      expect(executor.calls[1]?.statement).toContain('FROM app.interview_state st');
      expect(executor.calls[1]?.statement).toContain('FOR UPDATE OF st, c');
      expect(executor.calls[3]?.parameters).toContain('ignored_finalized');
    },
  );

  it('retrieves an audited closed-interview partial deterministically without relocking', async () => {
    const partial = participantPartial();
    const executor = new ScriptedExecutor([
      result([
        {
          ...partial,
          provider: SOURCE.provider,
          utteranceId: SOURCE.utteranceId,
          disposition: 'ignored_finalized',
        },
      ]),
    ]);

    await expect(
      new PostgresTranscriptRepository(executor).upsertPartial(INTERVIEW_ID, SOURCE, partial),
    ).resolves.toEqual({
      ok: true,
      value: { outcome: 'ignored_finalized', value: partial },
    });
    expect(executor.calls).toHaveLength(1);
  });
});

function participantPartial(): PartialTranscriptSegment {
  return {
    interviewId: INTERVIEW_ID,
    sourceProvider: SOURCE.provider,
    utteranceId: SOURCE.utteranceId,
    providerEventId: 'partial-event-1',
    segmentId: 'segment-1',
    text: '  exact partial  ',
    revision: 1,
    observedAt: T1,
  };
}

function participantWrite(
  overrides: {
    readonly providerEventId?: string;
    readonly segmentId?: string;
    readonly turnId?: string;
    readonly sequenceNumber?: number;
    readonly text?: string;
    readonly occurredAt?: string;
    readonly observedAt?: string;
    readonly finalizedAt?: string;
    readonly guideReference?: TranscriptGuideReference | null;
  } = {},
): { readonly final: FinalizedParticipantSegment; readonly turn: ParticipantTranscriptTurn } {
  const providerEventId = overrides.providerEventId ?? 'provider-final-1';
  const segmentId = overrides.segmentId ?? 'segment-1';
  const turnId = overrides.turnId ?? 'answer-1';
  const final: FinalizedParticipantSegment = {
    interviewId: INTERVIEW_ID,
    sourceProvider: SOURCE.provider,
    utteranceId: SOURCE.utteranceId,
    providerEventId,
    segmentId,
    turnId,
    text: overrides.text ?? 'Exact participant text.',
    occurredAt: overrides.occurredAt ?? T1,
    observedAt: overrides.observedAt ?? T1,
    finalizedAt: overrides.finalizedAt ?? T1,
    guideReference: overrides.guideReference ?? mainReference,
  };
  return {
    final,
    turn: {
      kind: 'turn',
      interviewId: INTERVIEW_ID,
      sequenceNumber: overrides.sequenceNumber ?? 1,
      turnId,
      sourceProvider: SOURCE.provider,
      providerEventId,
      speaker: 'participant',
      turnType: 'participant_answer',
      text: final.text,
      occurredAt: final.occurredAt,
      guideReference: final.guideReference,
      sourceSegmentId: segmentId,
    },
  };
}

function aggregateResults(
  entries: readonly Record<string, unknown>[],
  questions: readonly Record<string, unknown>[] = guideRows,
): SqlQueryResult[] {
  return [
    result([
      {
        interviewId: INTERVIEW_ID,
        guideId: GUIDE_ID,
        nextSequenceNumber: entries.length + 1,
      },
    ]),
    result(questions),
    result(entries),
    result(),
    result(),
    result(),
  ];
}

function existingParticipantResults(stored: {
  readonly final: FinalizedParticipantSegment;
  readonly turn: ParticipantTranscriptTurn;
}): SqlQueryResult[] {
  return [
    result([
      {
        provider: SOURCE.provider,
        utteranceId: SOURCE.utteranceId,
        providerEventId: stored.final.providerEventId,
        segmentId: stored.final.segmentId,
        turnId: stored.final.turnId,
      },
    ]),
    result([{ interviewId: INTERVIEW_ID, guideId: GUIDE_ID, nextSequenceNumber: 2 }]),
    result(guideRows),
    result([
      entryRow({
        entryId: stored.turn.turnId,
        occurredAt: stored.turn.occurredAt,
        speaker: 'participant',
        turnType: 'participant_answer',
        text: stored.turn.text,
        guideId: GUIDE_ID,
        questionId: 'main-1',
        providerEventId: stored.turn.providerEventId,
        sourceSegmentId: stored.turn.sourceSegmentId,
        sourceProvider: SOURCE.provider,
        questionKind: 'main_question',
        questionSectionId: 'section-1',
        questionMainQuestionId: 'main-1',
      }),
    ]),
    result(),
    result([
      {
        interviewId: INTERVIEW_ID,
        sourceProvider: SOURCE.provider,
        utteranceId: stored.final.utteranceId,
        providerEventId: stored.final.providerEventId,
        segmentId: stored.final.segmentId,
        turnId: stored.final.turnId,
        text: stored.final.text,
        observedAt: stored.final.observedAt,
        finalizedAt: stored.final.finalizedAt,
      },
    ]),
    result(),
  ];
}
