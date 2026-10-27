import { validateFinalTranscript, type TranscriptAggregate } from '@orgscience/domain';
import { describe, expect, it } from 'vitest';

import {
  failure,
  success,
  type RepositoryResult,
  type StoredAiDelivery,
  type StoredFinalization,
  type TranscriptFinalizationCandidate,
  type TranscriptReader,
} from '../../../application/persistence/index.js';
import {
  fingerprintTranscript,
  PostgresFinalizationRepository,
} from './finalization-repository.js';
import type { SqlExecutor, SqlQueryResult } from './sql.js';

const INTERVIEW_ID = 'interview-finalization-1';
const GUIDE_ID = 'guide-finalization-1';
const MAIN_QUESTION_ID = 'main-1';
const CREATED_AT = '2026-08-06T10:00:00.000Z';
const FINALIZED_AT = '2026-08-06T10:05:00.000Z';
const OFFSET_FINALIZED_AT = '2026-08-06T12:05:00.000+02:00';

const aggregate: TranscriptAggregate = {
  interviewId: INTERVIEW_ID,
  guideId: GUIDE_ID,
  guideQuestionIndex: [
    {
      kind: 'main_question',
      guideId: GUIDE_ID,
      sectionId: 'section-1',
      mainQuestionId: MAIN_QUESTION_ID,
    },
  ],
  nextSequenceNumber: 5,
  entries: [
    {
      kind: 'turn',
      interviewId: INTERVIEW_ID,
      sequenceNumber: 1,
      turnId: 'turn-greeting',
      deliveryEventId: 'delivery-event-greeting',
      speaker: 'ai_interviewer',
      turnType: 'greeting',
      text: 'Guten Tag.',
      occurredAt: CREATED_AT,
      guideReference: null,
      delivery: { status: 'complete' },
    },
    {
      kind: 'turn',
      interviewId: INTERVIEW_ID,
      sequenceNumber: 2,
      turnId: 'turn-question',
      deliveryEventId: 'delivery-event-question',
      speaker: 'ai_interviewer',
      turnType: 'main_question',
      text: 'Welche Rolle haben Sie?',
      occurredAt: '2026-08-06T10:01:00.000Z',
      guideReference: {
        kind: 'main_question',
        guideId: GUIDE_ID,
        sectionId: 'section-1',
        mainQuestionId: MAIN_QUESTION_ID,
      },
      delivery: { status: 'complete' },
    },
    {
      kind: 'turn',
      interviewId: INTERVIEW_ID,
      sequenceNumber: 3,
      turnId: 'turn-answer',
      sourceProvider: 'demo-stt',
      providerEventId: 'provider-event-answer',
      speaker: 'participant',
      turnType: 'participant_answer',
      text: 'Ich leite den Forschungsbereich.',
      occurredAt: '2026-08-06T10:02:00.000Z',
      guideReference: {
        kind: 'main_question',
        guideId: GUIDE_ID,
        sectionId: 'section-1',
        mainQuestionId: MAIN_QUESTION_ID,
      },
      sourceSegmentId: 'segment-answer',
    },
    {
      kind: 'turn',
      interviewId: INTERVIEW_ID,
      sequenceNumber: 4,
      turnId: 'turn-closing',
      deliveryEventId: 'delivery-event-closing',
      speaker: 'ai_interviewer',
      turnType: 'closing',
      text: 'Vielen Dank.',
      occurredAt: '2026-08-06T10:03:00.000Z',
      guideReference: null,
      delivery: { status: 'complete' },
    },
  ],
  partials: [],
  finals: [
    {
      interviewId: INTERVIEW_ID,
      sourceProvider: 'demo-stt',
      utteranceId: 'utterance-answer',
      providerEventId: 'provider-event-answer',
      segmentId: 'segment-answer',
      turnId: 'turn-answer',
      text: 'Ich leite den Forschungsbereich.',
      occurredAt: '2026-08-06T10:02:00.000Z',
      observedAt: '2026-08-06T10:02:00.000Z',
      finalizedAt: '2026-08-06T10:02:00.000Z',
      guideReference: {
        kind: 'main_question',
        guideId: GUIDE_ID,
        sectionId: 'section-1',
        mainQuestionId: MAIN_QUESTION_ID,
      },
    },
  ],
};

const deterministicValidation = validateFinalTranscript(aggregate);
const canonicalTurnIds = aggregate.entries.flatMap((entry) =>
  entry.kind === 'turn' ? [entry.turnId] : [],
);
const report = {
  status: 'valid' as const,
  checkedCanonicalEntries: aggregate.entries.map((entry) => ({
    entryId: entry.kind === 'turn' ? entry.turnId : entry.gapId,
    kind: entry.kind,
  })),
  checks: {
    chronologyValid: true,
    sequenceValid: true,
    speakerAssignmentsValid: true,
    noDuplicateTurns: true,
  },
  issues: [],
  rationale: 'All canonical entries were checked without discrepancies.',
};

const STT_GAP_ID = 'gap-stt-lost-answer-1';
const sttGapAggregate: TranscriptAggregate = {
  ...aggregate,
  nextSequenceNumber: 5,
  entries: [
    aggregate.entries[0]!,
    aggregate.entries[1]!,
    {
      kind: 'technical_gap',
      interviewId: INTERVIEW_ID,
      sequenceNumber: 3,
      gapId: STT_GAP_ID,
      sourceEventId: 'stt-gap-event-1',
      source: 'speech_to_text',
      sourceProvider: 'demo-stt',
      relatedUtteranceId: 'utterance-lost-answer',
      description: 'The participant answer could not be transcribed.',
      relatedSegmentId: 'segment-lost-answer',
      occurredAt: '2026-08-06T10:02:00.000Z',
    },
    { ...aggregate.entries[3]!, sequenceNumber: 4 },
  ],
  partials: [],
  finals: [],
};
const sttGapValidation = validateFinalTranscript(sttGapAggregate);
const sttGapReport: TranscriptFinalizationCandidate['agentReport'] = {
  ...report,
  status: 'valid_with_gaps',
  checkedCanonicalEntries: sttGapAggregate.entries.map((entry) => ({
    entryId: entry.kind === 'turn' ? entry.turnId : entry.gapId,
    kind: entry.kind,
  })),
  issues: [
    {
      code: 'technical_gap',
      severity: 'warning',
      canonicalEntryIds: [STT_GAP_ID],
      description: 'The canonical transcript preserves the lost STT answer interval.',
    },
  ],
  rationale: 'All canonical entries were checked and the STT gap remains explicit.',
};

const candidate: TranscriptFinalizationCandidate = {
  interviewId: INTERVIEW_ID,
  finalizationId: 'finalization-1',
  stateVersion: 4,
  agentRunId: 'agent-finalization-1',
  finalizedAt: FINALIZED_AT,
  deterministicValidation,
  agentReport: report,
};

class ScriptedExecutor implements SqlExecutor {
  readonly calls: Array<{ readonly sql: string; readonly parameters: readonly unknown[] }> = [];

  public constructor(private readonly results: SqlQueryResult[]) {}

  public async query(sql: string, parameters: readonly unknown[] = []): Promise<SqlQueryResult> {
    this.calls.push({ sql, parameters });
    const result = this.results.shift();
    if (result === undefined) throw new Error('Unexpected SQL query');
    return result;
  }
}

const transcriptReader: TranscriptReader = {
  async loadAggregate(): Promise<RepositoryResult<TranscriptAggregate>> {
    return success(aggregate);
  },
  async loadAiDelivery(): Promise<RepositoryResult<StoredAiDelivery>> {
    return failure({ code: 'not_found', resource: 'transcript', id: 'delivery' });
  },
  async listPendingAiDeliveries(): Promise<RepositoryResult<readonly StoredAiDelivery[]>> {
    return success([]);
  },
  async listQuestionAiDeliveries(): Promise<RepositoryResult<readonly StoredAiDelivery[]>> {
    return success([]);
  },
};

function lockedState(overrides: Partial<Record<string, unknown>> = {}): SqlQueryResult {
  return {
    rows: [
      {
        stateVersion: 4,
        status: 'completed',
        endedAt: '2026-08-06T10:04:00.000Z',
        pendingDeliveryCount: 0,
        ...overrides,
      },
    ],
    rowCount: 1,
  };
}

function agentRow(
  output: TranscriptFinalizationCandidate['agentReport'] = report,
  overrides: Partial<Record<string, unknown>> = {},
): SqlQueryResult {
  const checkedCanonicalEntryIds = output.checkedCanonicalEntries.map((entry) => entry.entryId);
  const checkedTurnIds = output.checkedCanonicalEntries.flatMap((entry) =>
    entry.kind === 'turn' ? [entry.entryId] : [],
  );
  return {
    rows: [
      {
        status: 'succeeded',
        agentName: 'transcript_finalization',
        endedAt: '2026-08-06T10:04:30.000Z',
        input: {
          interviewStateVersion: candidate.stateVersion,
          transcriptTurnIds: checkedTurnIds,
          canonicalEntryIds: checkedCanonicalEntryIds,
          guideQuestionIds: [MAIN_QUESTION_ID],
        },
        output: { agentName: 'transcript_finalization', output },
        ...overrides,
      },
    ],
    rowCount: 1,
  };
}

function stored(): StoredFinalization {
  return {
    ...candidate,
    transcriptFingerprint: fingerprintTranscript(INTERVIEW_ID, GUIDE_ID, aggregate.entries),
    entryCount: aggregate.entries.length,
    technicalGapCount: 0,
  };
}

function storedRow(value: StoredFinalization): Record<string, unknown> {
  return {
    interview_id: value.interviewId,
    finalization_id: value.finalizationId,
    state_version: value.stateVersion,
    agent_run_id: value.agentRunId,
    validation_status: 'valid',
    entry_count: value.entryCount,
    technical_gap_count: value.technicalGapCount,
    deterministic_issues: value.deterministicValidation.issues,
    agent_report: value.agentReport,
    canonical_digest: value.transcriptFingerprint,
    finalized_at: value.finalizedAt,
  };
}

describe('PostgresFinalizationRepository', () => {
  it('rejects non-string finalization timestamps before SQL', async () => {
    const executor = new ScriptedExecutor([]);
    const invalid: TranscriptFinalizationCandidate = {
      ...candidate,
      finalizedAt: new Date(FINALIZED_AT) as unknown as string,
    };

    await expect(
      new PostgresFinalizationRepository(executor, transcriptReader).store(INTERVIEW_ID, invalid),
    ).resolves.toEqual({
      ok: false,
      error: { code: 'constraint_violation', constraint: 'finalization_timestamp' },
    });
    expect(executor.calls).toHaveLength(0);
  });

  it('derives immutable counts and fingerprint from the locked canonical transcript', async () => {
    const executor = new ScriptedExecutor([
      lockedState(),
      agentRow(),
      { rows: [{ finalization_id: candidate.finalizationId }], rowCount: 1 },
    ]);

    const result = await new PostgresFinalizationRepository(executor, transcriptReader).store(
      INTERVIEW_ID,
      candidate,
    );

    expect(result).toEqual({ ok: true, value: { outcome: 'inserted', value: stored() } });
    expect(executor.calls[0]?.sql).toContain('for update of st, c');
    expect(executor.calls[2]?.parameters).toContain(stored().transcriptFingerprint);
  });

  it.each([
    ['wrong state version', { stateVersion: 3 }],
    ['unfinished lifecycle', { status: 'ending' }],
    ['pending delivery', { pendingDeliveryCount: 1 }],
    ['missing completion timestamp', { endedAt: null }],
    ['completion after finalization', { endedAt: '2026-08-06T10:06:00.000Z' }],
  ])('rejects %s before storing', async (_label, state) => {
    const executor = new ScriptedExecutor([lockedState(state)]);
    const result = await new PostgresFinalizationRepository(executor, transcriptReader).store(
      INTERVIEW_ID,
      candidate,
    );
    expect(result).toEqual({
      ok: false,
      error: { code: 'constraint_violation', constraint: 'finalization_locked_state' },
    });
  });

  it('rejects a report whose checked entries do not equal the canonical source', async () => {
    const changed: TranscriptFinalizationCandidate = {
      ...candidate,
      agentReport: { ...report, checkedCanonicalEntries: report.checkedCanonicalEntries.slice(1) },
    };
    const executor = new ScriptedExecutor([lockedState()]);
    const result = await new PostgresFinalizationRepository(executor, transcriptReader).store(
      INTERVIEW_ID,
      changed,
    );
    expect(result).toEqual({
      ok: false,
      error: { code: 'constraint_violation', constraint: 'finalization_canonical_transcript' },
    });
  });

  it('rejects a spoofed valid report when a required guide main question is absent', async () => {
    const incompleteAggregate: TranscriptAggregate = {
      ...aggregate,
      guideQuestionIndex: [
        ...aggregate.guideQuestionIndex,
        {
          kind: 'main_question',
          guideId: GUIDE_ID,
          sectionId: 'section-2',
          mainQuestionId: 'main-2',
        },
      ],
    };
    expect(validateFinalTranscript(incompleteAggregate).issues).toContainEqual(
      expect.objectContaining({ code: 'missing_required_main_question' }),
    );
    const incompleteReader: TranscriptReader = {
      ...transcriptReader,
      async loadAggregate(): Promise<RepositoryResult<TranscriptAggregate>> {
        return success(incompleteAggregate);
      },
    };
    const result = await new PostgresFinalizationRepository(
      new ScriptedExecutor([lockedState()]),
      incompleteReader,
    ).store(INTERVIEW_ID, candidate);

    expect(result).toEqual({
      ok: false,
      error: { code: 'constraint_violation', constraint: 'finalization_canonical_transcript' },
    });
  });

  it('rejects an agent output that differs from the proposed final report', async () => {
    const changedReport = { ...report, rationale: 'A different explicit rationale.' };
    const executor = new ScriptedExecutor([lockedState(), agentRow(changedReport)]);
    const result = await new PostgresFinalizationRepository(executor, transcriptReader).store(
      INTERVIEW_ID,
      candidate,
    );
    expect(result).toEqual({
      ok: false,
      error: { code: 'constraint_violation', constraint: 'finalization_agent_provenance' },
    });
  });

  it.each([
    ['an agent run that ended after finalization', { endedAt: '2026-08-06T10:05:00.001Z' }],
    [
      'an agent run for another state version',
      {
        input: {
          interviewStateVersion: candidate.stateVersion - 1,
          transcriptTurnIds: canonicalTurnIds,
          canonicalEntryIds: report.checkedCanonicalEntries.map((entry) => entry.entryId),
          guideQuestionIds: [MAIN_QUESTION_ID],
        },
      },
    ],
    [
      'an agent run with reordered transcript provenance',
      {
        input: {
          interviewStateVersion: candidate.stateVersion,
          transcriptTurnIds: [...canonicalTurnIds].reverse(),
          canonicalEntryIds: report.checkedCanonicalEntries.map((entry) => entry.entryId),
          guideQuestionIds: [MAIN_QUESTION_ID],
        },
      },
    ],
  ])('rejects %s', async (_label, agentOverrides) => {
    const executor = new ScriptedExecutor([lockedState(), agentRow(report, agentOverrides)]);
    const result = await new PostgresFinalizationRepository(executor, transcriptReader).store(
      INTERVIEW_ID,
      candidate,
    );
    expect(result).toEqual({
      ok: false,
      error: { code: 'constraint_violation', constraint: 'finalization_agent_provenance' },
    });
  });

  it('stores a valid transcript with an explicitly reported canonical technical gap', async () => {
    const gapId = 'gap-audio-1';
    const gappedAggregate: TranscriptAggregate = {
      ...aggregate,
      nextSequenceNumber: 6,
      entries: [
        ...aggregate.entries.slice(0, 3),
        {
          kind: 'technical_gap',
          interviewId: INTERVIEW_ID,
          sequenceNumber: 4,
          gapId,
          sourceEventId: 'audio-gap-event-1',
          source: 'audio_output',
          sourceProvider: null,
          relatedUtteranceId: null,
          description: 'A short audio delivery interval could not be confirmed.',
          relatedSegmentId: null,
          occurredAt: '2026-08-06T10:02:30.000Z',
        },
        { ...aggregate.entries[3]!, sequenceNumber: 5 },
      ],
    };
    const validation = validateFinalTranscript(gappedAggregate);
    expect(validation).toEqual({ valid: true, issues: [] });
    const gapReport = {
      ...report,
      status: 'valid_with_gaps' as const,
      checkedCanonicalEntries: gappedAggregate.entries.map((entry) => ({
        entryId: entry.kind === 'turn' ? entry.turnId : entry.gapId,
        kind: entry.kind,
      })),
      issues: [
        {
          code: 'technical_gap' as const,
          severity: 'warning' as const,
          canonicalEntryIds: [gapId],
          description: 'The canonical transcript preserves the recorded technical gap.',
        },
      ],
      rationale: 'All canonical entries were checked and the recorded gap remains explicit.',
    };
    const gappedCandidate: TranscriptFinalizationCandidate = {
      ...candidate,
      deterministicValidation: validation,
      agentReport: gapReport,
    };
    const gappedReader: TranscriptReader = {
      ...transcriptReader,
      async loadAggregate(): Promise<RepositoryResult<TranscriptAggregate>> {
        return success(gappedAggregate);
      },
    };
    const executor = new ScriptedExecutor([
      lockedState(),
      agentRow(gapReport),
      { rows: [{ finalization_id: candidate.finalizationId }], rowCount: 1 },
    ]);

    const result = await new PostgresFinalizationRepository(executor, gappedReader).store(
      INTERVIEW_ID,
      gappedCandidate,
    );

    expect(result).toEqual({
      ok: true,
      value: {
        outcome: 'inserted',
        value: {
          ...gappedCandidate,
          transcriptFingerprint: fingerprintTranscript(
            INTERVIEW_ID,
            GUIDE_ID,
            gappedAggregate.entries,
          ),
          entryCount: 5,
          technicalGapCount: 1,
        },
      },
    });
    expect(executor.calls[2]?.parameters).toContain('valid_with_gaps');
  });

  it('stores a lost participant answer as an exact canonical STT gap', async () => {
    expect(sttGapValidation).toEqual({ valid: true, issues: [] });
    const sttGapCandidate: TranscriptFinalizationCandidate = {
      ...candidate,
      deterministicValidation: sttGapValidation,
      agentReport: sttGapReport,
    };
    const sttGapReader: TranscriptReader = {
      ...transcriptReader,
      async loadAggregate(): Promise<RepositoryResult<TranscriptAggregate>> {
        return success(sttGapAggregate);
      },
    };
    const executor = new ScriptedExecutor([
      lockedState(),
      agentRow(sttGapReport),
      { rows: [{ finalization_id: candidate.finalizationId }], rowCount: 1 },
    ]);

    const result = await new PostgresFinalizationRepository(executor, sttGapReader).store(
      INTERVIEW_ID,
      sttGapCandidate,
    );

    expect(result).toEqual({
      ok: true,
      value: {
        outcome: 'inserted',
        value: {
          ...sttGapCandidate,
          transcriptFingerprint: fingerprintTranscript(
            INTERVIEW_ID,
            GUIDE_ID,
            sttGapAggregate.entries,
          ),
          entryCount: 4,
          technicalGapCount: 1,
        },
      },
    });
    expect(JSON.parse(String(executor.calls[2]?.parameters[8]))).toEqual(sttGapReport);
  });

  it.each([
    [
      'omits the canonical STT gap ID',
      sttGapReport.checkedCanonicalEntries
        .map((entry) => entry.entryId)
        .filter((entryId) => entryId !== STT_GAP_ID),
    ],
    [
      'reorders canonical entries including the STT gap ID',
      [...sttGapReport.checkedCanonicalEntries.map((entry) => entry.entryId)].reverse(),
    ],
  ])('rejects agent provenance that %s', async (_label, canonicalEntryIds) => {
    const sttGapCandidate: TranscriptFinalizationCandidate = {
      ...candidate,
      deterministicValidation: sttGapValidation,
      agentReport: sttGapReport,
    };
    const sttGapReader: TranscriptReader = {
      ...transcriptReader,
      async loadAggregate(): Promise<RepositoryResult<TranscriptAggregate>> {
        return success(sttGapAggregate);
      },
    };
    const transcriptTurnIds = sttGapReport.checkedCanonicalEntries.flatMap((entry) =>
      entry.kind === 'turn' ? [entry.entryId] : [],
    );
    const executor = new ScriptedExecutor([
      lockedState(),
      agentRow(sttGapReport, {
        input: {
          interviewStateVersion: candidate.stateVersion,
          transcriptTurnIds,
          canonicalEntryIds,
          guideQuestionIds: [MAIN_QUESTION_ID],
        },
      }),
    ]);

    const result = await new PostgresFinalizationRepository(executor, sttGapReader).store(
      INTERVIEW_ID,
      sttGapCandidate,
    );

    expect(result).toEqual({
      ok: false,
      error: { code: 'constraint_violation', constraint: 'finalization_agent_provenance' },
    });
  });

  it('rejects a gap report that does not cover every canonical gap exactly once', async () => {
    const gapId = 'gap-audio-1';
    const gappedAggregate: TranscriptAggregate = {
      ...aggregate,
      nextSequenceNumber: 6,
      entries: [
        ...aggregate.entries.slice(0, 3),
        {
          kind: 'technical_gap',
          interviewId: INTERVIEW_ID,
          sequenceNumber: 4,
          gapId,
          sourceEventId: 'audio-gap-event-1',
          source: 'audio_output',
          sourceProvider: null,
          relatedUtteranceId: null,
          description: 'A short audio delivery interval could not be confirmed.',
          relatedSegmentId: null,
          occurredAt: '2026-08-06T10:02:30.000Z',
        },
        { ...aggregate.entries[3]!, sequenceNumber: 5 },
      ],
    };
    const invalidGapReport = {
      ...report,
      status: 'valid_with_gaps' as const,
      checkedCanonicalEntries: gappedAggregate.entries.map((entry) => ({
        entryId: entry.kind === 'turn' ? entry.turnId : entry.gapId,
        kind: entry.kind,
      })),
      issues: [
        {
          code: 'technical_gap' as const,
          severity: 'warning' as const,
          canonicalEntryIds: ['turn-greeting'],
          description: 'Incorrectly references a turn.',
        },
      ],
      rationale: 'The report is intentionally invalid for this test.',
    };
    const gappedReader: TranscriptReader = {
      ...transcriptReader,
      async loadAggregate(): Promise<RepositoryResult<TranscriptAggregate>> {
        return success(gappedAggregate);
      },
    };
    const result = await new PostgresFinalizationRepository(
      new ScriptedExecutor([lockedState()]),
      gappedReader,
    ).store(INTERVIEW_ID, {
      ...candidate,
      deterministicValidation: validateFinalTranscript(gappedAggregate),
      agentReport: invalidGapReport,
    });

    expect(result).toEqual({
      ok: false,
      error: { code: 'constraint_violation', constraint: 'finalization_agent_report' },
    });
  });

  it('returns the exact existing row for an idempotent retry', async () => {
    const value = stored();
    const executor = new ScriptedExecutor([
      lockedState(),
      agentRow(),
      { rows: [], rowCount: 0 },
      { rows: [storedRow(value)], rowCount: 1 },
    ]);
    await expect(
      new PostgresFinalizationRepository(executor, transcriptReader).store(INTERVIEW_ID, candidate),
    ).resolves.toEqual({ ok: true, value: { outcome: 'existing', value } });
  });

  it('returns the UTC database row when an idempotent retry uses an equivalent ISO offset', async () => {
    const value = stored();
    const offsetCandidate: TranscriptFinalizationCandidate = {
      ...candidate,
      finalizedAt: OFFSET_FINALIZED_AT,
    };
    const executor = new ScriptedExecutor([
      lockedState(),
      agentRow(),
      { rows: [], rowCount: 0 },
      { rows: [storedRow(value)], rowCount: 1 },
    ]);

    await expect(
      new PostgresFinalizationRepository(executor, transcriptReader).store(
        INTERVIEW_ID,
        offsetCandidate,
      ),
    ).resolves.toEqual({ ok: true, value: { outcome: 'existing', value } });
  });

  it('does not treat a non-timestamp finalization difference as an idempotent retry', async () => {
    const changed = { ...stored(), agentRunId: 'agent-finalization-other' };
    const executor = new ScriptedExecutor([
      lockedState(),
      agentRow(),
      { rows: [], rowCount: 0 },
      { rows: [storedRow(changed)], rowCount: 1 },
    ]);

    await expect(
      new PostgresFinalizationRepository(executor, transcriptReader).store(INTERVIEW_ID, candidate),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'duplicate_conflict',
        resource: 'finalization',
        identity: INTERVIEW_ID,
      },
    });
  });

  it('loads the persisted canonical finalization', async () => {
    const value = stored();
    const executor = new ScriptedExecutor([{ rows: [storedRow(value)], rowCount: 1 }]);
    await expect(
      new PostgresFinalizationRepository(executor, transcriptReader).loadLatest(INTERVIEW_ID),
    ).resolves.toEqual(success(value));
  });

  it('rejects a persisted finalization fingerprint that does not match the canonical transcript', async () => {
    const value = stored();
    const executor = new ScriptedExecutor([
      {
        rows: [storedRow({ ...value, transcriptFingerprint: '0'.repeat(64) })],
        rowCount: 1,
      },
    ]);

    await expect(
      new PostgresFinalizationRepository(executor, transcriptReader).loadLatest(INTERVIEW_ID),
    ).resolves.toMatchObject({ ok: false, error: { code: 'corrupt_data' } });
  });
});
