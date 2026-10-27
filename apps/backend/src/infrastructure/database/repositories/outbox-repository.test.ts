import type { MonitoringEvent, VoiceState } from '@orgscience/contracts';
import { describe, expect, it } from 'vitest';

import type { MonitoringEventDraft } from '../../../application/persistence/index.js';
import { PostgresOutboxRepository } from './outbox-repository.js';
import type { SqlExecutor, SqlQueryResult } from './sql.js';

const INTERVIEW_ID = 'interview-1';
const T0 = '2026-08-06T10:00:00.000Z';
const LANGUAGE = 'de' as const;

type InterviewStatusEventDraft = Extract<
  MonitoringEventDraft,
  { readonly type: 'interview.status_changed' }
>;
type VoiceEventDraft = Extract<MonitoringEventDraft, { readonly category: 'voice' }>;
type AiTextDeltaEventDraft = Extract<
  MonitoringEventDraft,
  { readonly type: 'transcript.ai_text_delta' }
>;

interface SqlCall {
  readonly statement: string;
  readonly parameters: readonly unknown[];
}

class ScriptedExecutor implements SqlExecutor {
  public readonly calls: SqlCall[] = [];

  public constructor(private readonly results: SqlQueryResult[]) {}

  public async query(
    statement: string,
    parameters: readonly unknown[] = [],
  ): Promise<SqlQueryResult> {
    this.calls.push({ statement, parameters });
    const result = this.results.shift();
    if (result === undefined) {
      throw new Error(`Unexpected SQL: ${statement}`);
    }
    return result;
  }
}

const result = (rows: readonly unknown[] = [], rowCount = rows.length): SqlQueryResult => ({
  rows,
  rowCount,
});

function draft(eventId = 'event-1', interviewId = INTERVIEW_ID): InterviewStatusEventDraft {
  return {
    eventId,
    interviewId,
    runId: 'run-1',
    occurredAt: T0,
    category: 'interview',
    type: 'interview.status_changed',
    payload: {
      previousStatus: 'ready',
      nextStatus: 'active',
      changedAt: T0,
    },
  };
}

function persisted(eventId: string, sequenceNumber: number, interviewId = INTERVIEW_ID) {
  return {
    ...draft(eventId, interviewId),
    language: LANGUAGE,
    sequenceNumber,
  } satisfies MonitoringEvent;
}

function aiStreamStarted(sequenceNumber: number): MonitoringEvent {
  return {
    eventId: `event-ai-start-${String(sequenceNumber)}`,
    interviewId: INTERVIEW_ID,
    language: LANGUAGE,
    runId: 'run-ai-1',
    sequenceNumber,
    occurredAt: T0,
    category: 'transcript',
    type: 'transcript.ai_text_stream_started',
    payload: {
      utteranceId: 'utterance-ai-1',
      turnId: 'turn-ai-1',
      nextDeltaSequenceNumber: 1,
      startedAt: T0,
    },
  };
}

function aiTextDelta(
  sequenceNumber: number,
  deltaSequenceNumber: number,
  textDelta: string,
): MonitoringEvent {
  return {
    eventId: `event-ai-delta-${String(sequenceNumber)}`,
    interviewId: INTERVIEW_ID,
    language: LANGUAGE,
    runId: 'run-ai-1',
    sequenceNumber,
    occurredAt: T0,
    category: 'transcript',
    type: 'transcript.ai_text_delta',
    payload: {
      utteranceId: 'utterance-ai-1',
      turnId: 'turn-ai-1',
      deltaSequenceNumber,
      textDelta,
    },
  };
}

function voiceEvent(sequenceNumber: number): MonitoringEvent {
  return {
    eventId: `event-voice-${String(sequenceNumber)}`,
    interviewId: INTERVIEW_ID,
    language: LANGUAGE,
    runId: 'run-ai-1',
    sequenceNumber,
    occurredAt: T0,
    category: 'voice',
    type: 'voice.playback_started',
    payload: {
      previousState: 'processing',
      nextState: 'speaking',
      utteranceId: 'utterance-ai-1',
      turnId: 'turn-ai-1',
      provider: 'demo',
    },
  };
}

function voiceStateEvent(
  sequenceNumber: number,
  previousState: 'idle' | 'listening' | 'processing' | 'speaking' | 'interrupted' | 'failed',
  nextState: 'idle' | 'listening' | 'processing' | 'speaking' | 'interrupted' | 'failed',
): MonitoringEvent {
  return {
    eventId: `event-voice-state-${String(sequenceNumber)}`,
    interviewId: INTERVIEW_ID,
    language: LANGUAGE,
    runId: 'run-ai-1',
    sequenceNumber,
    occurredAt: T0,
    category: 'voice',
    type: 'voice.state_changed',
    payload: {
      previousState,
      nextState,
      utteranceId: null,
      turnId: null,
      provider: 'demo',
    },
  };
}

function voiceStateDraft(
  eventId: string,
  previousState: VoiceState,
  nextState: VoiceState,
): VoiceEventDraft {
  return {
    eventId,
    interviewId: INTERVIEW_ID,
    runId: 'run-ai-1',
    occurredAt: T0,
    category: 'voice',
    type: 'voice.state_changed',
    payload: {
      previousState,
      nextState,
      utteranceId: null,
      turnId: null,
      provider: 'demo',
    },
  };
}

function aiTextDeltaDraft(
  eventId: string,
  deltaSequenceNumber: number,
  textDelta: string,
): AiTextDeltaEventDraft {
  return {
    eventId,
    interviewId: INTERVIEW_ID,
    runId: 'run-ai-1',
    occurredAt: T0,
    category: 'transcript',
    type: 'transcript.ai_text_delta',
    payload: {
      utteranceId: 'utterance-ai-1',
      turnId: 'turn-ai-1',
      deltaSequenceNumber,
      textDelta,
    },
  };
}

function aiStreamCompleted(sequenceNumber: number, generatedText: string): MonitoringEvent {
  return {
    eventId: `event-ai-completed-${String(sequenceNumber)}`,
    interviewId: INTERVIEW_ID,
    language: LANGUAGE,
    runId: 'run-ai-1',
    sequenceNumber,
    occurredAt: T0,
    category: 'transcript',
    type: 'transcript.ai_text_stream_completed',
    payload: {
      utteranceId: 'utterance-ai-1',
      turnId: 'turn-ai-1',
      lastDeltaSequenceNumber: 1,
      generatedText,
      confirmedSpokenText: generatedText,
      completedAt: T0,
    },
  };
}

function appendResults(sequenceNumber: number): SqlQueryResult[] {
  return [
    result([{ nextEventSequence: sequenceNumber }]),
    result(),
    result([{ allocatedSequence: sequenceNumber }]),
    result([], 1),
  ];
}

describe('PostgresOutboxRepository', () => {
  it('locks the event counter and assigns its sequence before a parameterized insert', async () => {
    const executor = new ScriptedExecutor(appendResults(3));
    const event = draft();

    const appended = await new PostgresOutboxRepository(executor).append(INTERVIEW_ID, event);

    expect(appended).toEqual({
      ok: true,
      value: {
        outcome: 'inserted',
        value: { ...event, language: LANGUAGE, sequenceNumber: 3 },
      },
    });
    expect(executor.calls[0]?.statement).toContain('FROM app.interview_state st');
    expect(executor.calls[0]?.statement).toContain('FOR UPDATE OF st, c');
    expect(executor.calls[0]?.parameters).toEqual([INTERVIEW_ID]);
    expect(executor.calls[2]?.statement).toContain('next_event_sequence + 1');
    expect(executor.calls[3]?.statement).toContain('app.event_outbox');
    expect(executor.calls[3]?.statement).toContain('$9');
    expect(executor.calls[3]?.parameters).toEqual([
      'event-1',
      INTERVIEW_ID,
      LANGUAGE,
      'run-1',
      3,
      'interview',
      'interview.status_changed',
      T0,
      event.payload,
    ]);
  });

  it('treats equivalent occurredAt offsets as the same instant without allocating', async () => {
    const existing = persisted('event-1', 2);
    const retryExecutor = new ScriptedExecutor([
      result([{ nextEventSequence: 3 }]),
      result([existing]),
    ]);
    const equivalentInstant = {
      ...draft(),
      occurredAt: '2026-08-06T12:00:00.000+02:00',
    } satisfies MonitoringEventDraft;
    const retry = await new PostgresOutboxRepository(retryExecutor).append(
      INTERVIEW_ID,
      equivalentInstant,
    );

    expect(retry).toEqual({ ok: true, value: { outcome: 'existing', value: existing } });
    expect(retryExecutor.calls).toHaveLength(2);

    const changedInstantExecutor = new ScriptedExecutor([
      result([{ nextEventSequence: 3 }]),
      result([existing]),
    ]);
    const changedInstant = await new PostgresOutboxRepository(changedInstantExecutor).append(
      INTERVIEW_ID,
      { ...draft(), occurredAt: '2026-08-06T10:00:01.000Z' },
    );
    expect(changedInstant).toEqual({
      ok: false,
      error: { code: 'duplicate_conflict', resource: 'outbox_event', identity: 'event-1' },
    });
  });

  it('rejects a duplicate event id when the payload changes', async () => {
    const existing = persisted('event-1', 2);

    const conflictExecutor = new ScriptedExecutor([
      result([{ nextEventSequence: 3 }]),
      result([existing]),
    ]);
    const changed: MonitoringEventDraft = {
      ...draft(),
      payload: {
        previousStatus: 'ready',
        nextStatus: 'active',
        changedAt: '2026-08-06T10:00:01.000Z',
      },
    };
    const conflict = await new PostgresOutboxRepository(conflictExecutor).append(
      INTERVIEW_ID,
      changed,
    );

    expect(conflict).toEqual({
      ok: false,
      error: { code: 'duplicate_conflict', resource: 'outbox_event', identity: 'event-1' },
    });
  });

  it('rejects a stale voice transition under the locked event counter', async () => {
    const executor = new ScriptedExecutor([
      result([{ nextEventSequence: 2 }]),
      result(),
      result([voiceStateEvent(1, 'idle', 'processing')]),
      result([{ startSequence: null, previousType: null, hasAiEvents: false }]),
    ]);

    const appended = await new PostgresOutboxRepository(executor).append(
      INTERVIEW_ID,
      voiceStateDraft('event-voice-stale', 'idle', 'listening'),
    );

    expect(appended).toEqual({
      ok: false,
      error: {
        code: 'constraint_violation',
        constraint: 'monitoring_event_state_transition',
      },
    });
    expect(executor.calls.some((call) => call.statement.includes('next_event_sequence + 1'))).toBe(
      false,
    );
  });

  it('rejects a duplicate AI delta sequence before allocating an outbox sequence', async () => {
    const executor = new ScriptedExecutor([
      result([{ nextEventSequence: 3 }]),
      result(),
      result(),
      result([{ startSequence: 1, previousType: null, hasAiEvents: true }]),
      result([aiStreamStarted(1), aiTextDelta(2, 1, 'Welche ')]),
    ]);

    const appended = await new PostgresOutboxRepository(executor).append(
      INTERVIEW_ID,
      aiTextDeltaDraft('event-ai-delta-stale', 1, 'Rolle?'),
    );

    expect(appended).toEqual({
      ok: false,
      error: {
        code: 'constraint_violation',
        constraint: 'monitoring_event_state_transition',
      },
    });
    expect(executor.calls.some((call) => call.statement.includes('next_event_sequence + 1'))).toBe(
      false,
    );
  });

  it('replays only the requested interview window in sequence order with a stable high-water mark', async () => {
    const executor = new ScriptedExecutor([
      result([{ nextEventSequence: 6 }]),
      result([persisted('event-2', 2), persisted('event-3', 3), persisted('event-4', 4)]),
    ]);

    const replayed = await new PostgresOutboxRepository(executor).replay(INTERVIEW_ID, {
      afterSequence: 1,
      throughSequence: 4,
      limit: 2,
    });

    expect(replayed).toEqual({
      ok: true,
      value: {
        events: [persisted('event-2', 2), persisted('event-3', 3)],
        highWaterSequence: 4,
        hasMore: true,
      },
    });
    expect(executor.calls[1]?.statement).toContain('WHERE interview_id = $1');
    expect(executor.calls[1]?.statement).toContain('sequence_number > $2');
    expect(executor.calls[1]?.statement).toContain('sequence_number <= $3');
    expect(executor.calls[1]?.statement).toContain('ORDER BY sequence_number ASC');
    expect(executor.calls[1]?.parameters).toEqual([INTERVIEW_ID, 1, 4, 3]);
  });

  it('reconstructs bounded voice and active AI text state at the requested high-water mark', async () => {
    const executor = new ScriptedExecutor([
      result([voiceStateEvent(1, 'idle', 'processing'), voiceEvent(4)]),
      result([{ startSequence: 2, previousType: null, hasAiEvents: true }]),
      result([aiStreamStarted(2), aiTextDelta(3, 1, 'Welche '), aiTextDelta(5, 2, 'Rolle?')]),
    ]);

    const projected = await new PostgresOutboxRepository(executor).loadLiveState(INTERVIEW_ID, 5);

    expect(projected).toEqual({
      ok: true,
      value: {
        voiceState: 'speaking',
        activeAiTextStream: {
          interviewId: INTERVIEW_ID,
          runId: 'run-ai-1',
          utteranceId: 'utterance-ai-1',
          turnId: 'turn-ai-1',
          startedAt: T0,
          lastDeltaSequenceNumber: 2,
          generatedText: 'Welche Rolle?',
        },
      },
    });
    expect(executor.calls[0]?.statement).toContain("category = 'voice'");
    expect(executor.calls[0]?.statement).toContain('sequence_number <= $2');
    expect(executor.calls[0]?.parameters).toEqual([INTERVIEW_ID, 5, 50_001]);
    expect(executor.calls[2]?.statement).toContain('sequence_number >= $2');
    expect(executor.calls[2]?.statement).toContain('sequence_number <= $3');
    expect(executor.calls[2]?.parameters.slice(0, 3)).toEqual([INTERVIEW_ID, 2, 5]);
  });

  it('uses neutral live state when no persisted voice or AI stream event exists', async () => {
    const executor = new ScriptedExecutor([
      result(),
      result([{ startSequence: null, previousType: null, hasAiEvents: false }]),
    ]);

    const projected = await new PostgresOutboxRepository(executor).loadLiveState(INTERVIEW_ID, 0);

    expect(projected).toEqual({
      ok: true,
      value: { voiceState: 'idle', activeAiTextStream: null },
    });
    expect(executor.calls).toHaveLength(2);
  });

  it('fails closed when the first persisted voice event does not begin at idle', async () => {
    const executor = new ScriptedExecutor([result([voiceEvent(1)])]);

    const projected = await new PostgresOutboxRepository(executor).loadLiveState(INTERVIEW_ID, 1);

    expect(projected).toMatchObject({
      ok: false,
      error: { code: 'corrupt_data', resource: 'outbox_event', id: INTERVIEW_ID },
    });
    expect(executor.calls).toHaveLength(1);
  });

  it('fails closed when persisted voice transitions do not connect', async () => {
    const executor = new ScriptedExecutor([
      result([
        voiceStateEvent(1, 'idle', 'processing'),
        voiceStateEvent(2, 'interrupted', 'listening'),
      ]),
    ]);

    const projected = await new PostgresOutboxRepository(executor).loadLiveState(INTERVIEW_ID, 2);

    expect(projected).toMatchObject({
      ok: false,
      error: { code: 'corrupt_data', resource: 'outbox_event', id: INTERVIEW_ID },
    });
    expect(executor.calls).toHaveLength(1);
  });

  it('does not expose an AI text stream after its matching terminal event', async () => {
    const executor = new ScriptedExecutor([
      result(),
      result([{ startSequence: 2, previousType: null, hasAiEvents: true }]),
      result([
        aiStreamStarted(2),
        aiTextDelta(3, 1, 'Welche Rolle?'),
        aiStreamCompleted(4, 'Welche Rolle?'),
      ]),
    ]);

    const projected = await new PostgresOutboxRepository(executor).loadLiveState(INTERVIEW_ID, 4);

    expect(projected).toEqual({
      ok: true,
      value: { voiceState: 'idle', activeAiTextStream: null },
    });
  });

  it('fails closed when persisted AI deltas are out of order', async () => {
    const executor = new ScriptedExecutor([
      result(),
      result([{ startSequence: 2, previousType: null, hasAiEvents: true }]),
      result([aiStreamStarted(2), aiTextDelta(3, 2, 'wrong sequence')]),
    ]);

    const projected = await new PostgresOutboxRepository(executor).loadLiveState(INTERVIEW_ID, 3);

    expect(projected).toMatchObject({
      ok: false,
      error: { code: 'corrupt_data', resource: 'outbox_event', id: INTERVIEW_ID },
    });
  });

  it('fails closed when a persisted AI delta changes stream identity', async () => {
    const changedIdentity = aiTextDelta(3, 1, 'Welche Rolle?');
    const executor = new ScriptedExecutor([
      result(),
      result([{ startSequence: 2, previousType: null, hasAiEvents: true }]),
      result([
        aiStreamStarted(2),
        { ...changedIdentity, payload: { ...changedIdentity.payload, turnId: 'turn-other' } },
      ]),
    ]);

    const projected = await new PostgresOutboxRepository(executor).loadLiveState(INTERVIEW_ID, 3);

    expect(projected).toMatchObject({
      ok: false,
      error: { code: 'corrupt_data', resource: 'outbox_event', id: INTERVIEW_ID },
    });
  });

  it('fails closed when a new AI stream starts before the prior stream terminates', async () => {
    const executor = new ScriptedExecutor([
      result(),
      result([
        {
          startSequence: 4,
          previousType: 'transcript.ai_text_delta',
          hasAiEvents: true,
        },
      ]),
    ]);

    const projected = await new PostgresOutboxRepository(executor).loadLiveState(INTERVIEW_ID, 5);

    expect(projected).toMatchObject({
      ok: false,
      error: { code: 'corrupt_data', resource: 'outbox_event', id: INTERVIEW_ID },
    });
    expect(executor.calls).toHaveLength(2);
  });

  it('rejects a cross-interview replay row as corrupt data', async () => {
    const executor = new ScriptedExecutor([
      result([{ nextEventSequence: 2 }]),
      result([persisted('event-1', 1, 'interview-2')]),
    ]);

    const replayed = await new PostgresOutboxRepository(executor).replay(INTERVIEW_ID, {
      afterSequence: 0,
      limit: 10,
    });

    expect(replayed).toMatchObject({
      ok: false,
      error: { code: 'corrupt_data', resource: 'outbox_event', id: INTERVIEW_ID },
    });
  });

  it('rejects replay rows that violate the requested monotone sequence window', async () => {
    const executor = new ScriptedExecutor([
      result([{ nextEventSequence: 4 }]),
      result([persisted('event-3', 3), persisted('event-2', 2)]),
    ]);

    const replayed = await new PostgresOutboxRepository(executor).replay(INTERVIEW_ID, {
      afterSequence: 1,
      limit: 10,
    });

    expect(replayed).toMatchObject({
      ok: false,
      error: { code: 'corrupt_data', resource: 'outbox_event', id: INTERVIEW_ID },
    });
  });

  it('rejects a replay gap even when the returned rows remain strictly increasing', async () => {
    const executor = new ScriptedExecutor([
      result([{ nextEventSequence: 5 }]),
      result([persisted('event-2', 2), persisted('event-4', 4)]),
    ]);

    const replayed = await new PostgresOutboxRepository(executor).replay(INTERVIEW_ID, {
      afterSequence: 1,
      limit: 10,
    });

    expect(replayed).toMatchObject({
      ok: false,
      error: { code: 'corrupt_data', resource: 'outbox_event', id: INTERVIEW_ID },
    });
  });

  it('rejects an empty replay when the captured window contains persisted sequences', async () => {
    const executor = new ScriptedExecutor([result([{ nextEventSequence: 3 }]), result()]);

    const replayed = await new PostgresOutboxRepository(executor).replay(INTERVIEW_ID, {
      afterSequence: 0,
      throughSequence: 2,
      limit: 10,
    });

    expect(replayed).toMatchObject({
      ok: false,
      error: { code: 'corrupt_data', resource: 'outbox_event', id: INTERVIEW_ID },
    });
  });

  it('rejects a missing tail sequence when a bounded page should reach high-water', async () => {
    const executor = new ScriptedExecutor([
      result([{ nextEventSequence: 4 }]),
      result([persisted('event-1', 1), persisted('event-2', 2)]),
    ]);

    const replayed = await new PostgresOutboxRepository(executor).replay(INTERVIEW_ID, {
      afterSequence: 0,
      throughSequence: 3,
      limit: 10,
    });

    expect(replayed).toMatchObject({
      ok: false,
      error: { code: 'corrupt_data', resource: 'outbox_event', id: INTERVIEW_ID },
    });
  });

  it('returns a sequence conflict when a reconnect cursor is ahead of persisted history', async () => {
    const executor = new ScriptedExecutor([result([{ nextEventSequence: 4 }])]);

    const replayed = await new PostgresOutboxRepository(executor).replay(INTERVIEW_ID, {
      afterSequence: 4,
      limit: 10,
    });

    expect(replayed).toEqual({
      ok: false,
      error: {
        code: 'sequence_conflict',
        interviewId: INTERVIEW_ID,
        expected: 3,
        actual: 4,
      },
    });
    expect(executor.calls).toHaveLength(1);
  });

  it('rejects a requested replay boundary below its cursor', async () => {
    const executor = new ScriptedExecutor([result([{ nextEventSequence: 5 }])]);

    const replayed = await new PostgresOutboxRepository(executor).replay(INTERVIEW_ID, {
      afterSequence: 3,
      throughSequence: 2,
      limit: 10,
    });

    expect(replayed).toEqual({
      ok: false,
      error: { code: 'constraint_violation', constraint: 'outbox_replay_query' },
    });
    expect(executor.calls).toHaveLength(0);
  });

  it('rejects an allocated sequence that disagrees with the locked counter', async () => {
    const executor = new ScriptedExecutor([
      result([{ nextEventSequence: 3 }]),
      result(),
      result([{ allocatedSequence: 4 }]),
    ]);

    const appended = await new PostgresOutboxRepository(executor).append(INTERVIEW_ID, draft());

    expect(appended).toMatchObject({
      ok: false,
      error: { code: 'corrupt_data', resource: 'outbox_event', id: INTERVIEW_ID },
    });
    expect(executor.calls).toHaveLength(3);
  });

  it('keeps appendMany sequences monotone when the caller supplies one transaction executor', async () => {
    const executor = new ScriptedExecutor([...appendResults(1), ...appendResults(2)]);
    const events = [draft('event-1'), draft('event-2')];

    const appended = await new PostgresOutboxRepository(executor).appendMany(INTERVIEW_ID, events);

    expect(appended).toEqual({
      ok: true,
      value: [
        {
          outcome: 'inserted',
          value: { ...events[0], language: LANGUAGE, sequenceNumber: 1 },
        },
        {
          outcome: 'inserted',
          value: { ...events[1], language: LANGUAGE, sequenceNumber: 2 },
        },
      ],
    });
    expect(executor.calls.filter((call) => call.statement.includes('FOR UPDATE'))).toHaveLength(2);
  });

  it('preserves mixed appendMany outcomes so publishers can exclude historical events', async () => {
    const existing = persisted('event-existing', 1);
    const executor = new ScriptedExecutor([
      ...appendResults(3),
      result([{ nextEventSequence: 4 }]),
      result([existing]),
    ]);
    const events = [draft('event-new'), draft('event-existing')];

    const appended = await new PostgresOutboxRepository(executor).appendMany(INTERVIEW_ID, events);

    expect(appended).toEqual({
      ok: true,
      value: [
        {
          outcome: 'inserted',
          value: { ...events[0], language: LANGUAGE, sequenceNumber: 3 },
        },
        { outcome: 'existing', value: existing },
      ],
    });
    expect(
      appended.ok
        ? appended.value
            .filter((write) => write.outcome === 'inserted')
            .map((write) => write.value.sequenceNumber)
        : [],
    ).toEqual([3]);
  });

  it('rejects cross-interview event input before querying the database', async () => {
    const executor = new ScriptedExecutor([]);

    const appended = await new PostgresOutboxRepository(executor).append(
      INTERVIEW_ID,
      draft('event-1', 'interview-2'),
    );

    expect(appended).toEqual({
      ok: false,
      error: { code: 'constraint_violation', constraint: 'monitoring_event_contract' },
    });
    expect(executor.calls).toEqual([]);
  });
});
