import {
  AiTextStreamSequenceError,
  monitoringEventSchema,
  monitoringLiveStateSchema,
  reduceAiTextStreamEvent,
  type AiTextStreamEvent,
  type AiTextStreamState,
  type MonitoringEvent,
  type MonitoringLiveState,
  type VoiceState,
} from '@orgscience/contracts';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import {
  failure,
  success,
  type MonitoringEventDraft,
  type OutboxBatchWrite,
  type OutboxEventWrite,
  type OutboxReplayPage,
  type RepositoryResult,
} from '../../../application/persistence/index.js';
import type { OutboxRepository } from '../../../application/persistence/ports.js';
import { corruptData, mapDatabaseError } from './repository-errors.js';
import type { SqlExecutor } from './sql.js';

const timestampColumnSchema = z.union([
  z.iso.datetime({ offset: true }),
  z.date().transform((value) => value.toISOString()),
]);

const outboxRowSchema = z.object({
  eventId: z.string().min(1),
  interviewId: z.string().min(1),
  language: z.enum(['de', 'en']).default('de'),
  runId: z.string().min(1),
  sequenceNumber: z.number().int().positive(),
  category: z.string().min(1),
  type: z.string().min(1),
  occurredAt: timestampColumnSchema,
  payload: z.record(z.string(), z.json()),
});

const counterRowSchema = z.object({
  nextEventSequence: z.number().int().positive(),
  language: z.enum(['de', 'en']).default('de'),
});
const allocatedRowSchema = z.object({ allocatedSequence: z.number().int().positive() });
const aiProjectionBoundaryRowSchema = z.object({
  startSequence: z.number().int().positive().nullable(),
  previousType: z
    .enum([
      'transcript.ai_text_stream_started',
      'transcript.ai_text_delta',
      'transcript.ai_text_stream_completed',
      'transcript.ai_text_stream_interrupted',
    ])
    .nullable(),
  hasAiEvents: z.boolean(),
});

const MAX_AI_TEXT_CODE_POINTS = 20_000;
const MAX_CURRENT_AI_STREAM_EVENTS = MAX_AI_TEXT_CODE_POINTS + 2;
const MAX_VOICE_PROJECTION_EVENTS = 50_000;
const TERMINAL_AI_EVENT_TYPES = new Set<MonitoringEvent['type']>([
  'transcript.ai_text_stream_completed',
  'transcript.ai_text_stream_interrupted',
]);

export class PostgresOutboxRepository implements OutboxRepository {
  public constructor(private readonly executor: SqlExecutor) {}

  public async highWater(interviewId: string): Promise<RepositoryResult<number>> {
    try {
      const result = await this.executor.query(
        `SELECT next_event_sequence AS "nextEventSequence"
           FROM app.interview_counters
          WHERE interview_id = $1`,
        [interviewId],
      );
      if (result.rowCount === 0) {
        return failure({ code: 'not_found', resource: 'outbox_event', id: interviewId });
      }
      const parsed = counterRowSchema.safeParse(result.rows[0]);
      return parsed.success
        ? success(parsed.data.nextEventSequence - 1)
        : failure(corruptData('outbox_event', interviewId, parsed.error.message));
    } catch (error: unknown) {
      return databaseFailure(error, interviewId);
    }
  }

  public async replay(
    interviewId: string,
    query: {
      readonly afterSequence: number;
      readonly throughSequence?: number;
      readonly limit: number;
    },
  ): Promise<RepositoryResult<OutboxReplayPage>> {
    if (
      !Number.isInteger(query.afterSequence) ||
      query.afterSequence < 0 ||
      !Number.isInteger(query.limit) ||
      query.limit <= 0 ||
      (query.throughSequence !== undefined &&
        (!Number.isInteger(query.throughSequence) ||
          query.throughSequence < 0 ||
          query.throughSequence < query.afterSequence))
    ) {
      return failure({ code: 'constraint_violation', constraint: 'outbox_replay_query' });
    }
    try {
      const highWater = await this.highWater(interviewId);
      if (!highWater.ok) {
        return highWater;
      }
      if (query.afterSequence > highWater.value) {
        return failure({
          code: 'sequence_conflict',
          interviewId,
          expected: highWater.value,
          actual: query.afterSequence,
        });
      }
      const throughSequence = Math.min(query.throughSequence ?? highWater.value, highWater.value);
      const result = await this.executor.query(
        `SELECT event_id AS "eventId", interview_id AS "interviewId",
                language, run_id AS "runId", sequence_number AS "sequenceNumber",
                category, type, occurred_at AS "occurredAt", payload
           FROM app.event_outbox
          WHERE interview_id = $1
            AND sequence_number > $2
            AND sequence_number <= $3
          ORDER BY sequence_number ASC
          LIMIT $4`,
        [interviewId, query.afterSequence, throughSequence, query.limit + 1],
      );
      const events = parseEvents(result.rows, interviewId);
      if (!events.ok) {
        return events;
      }
      const replayOrderError = validateReplayOrder(
        events.value,
        query.afterSequence,
        throughSequence,
        query.limit,
      );
      if (replayOrderError !== null) {
        return failure(corruptData('outbox_event', interviewId, replayOrderError));
      }
      return success({
        events: events.value.slice(0, query.limit),
        highWaterSequence: throughSequence,
        hasMore: events.value.length > query.limit,
      });
    } catch (error: unknown) {
      return databaseFailure(error, interviewId);
    }
  }

  public async loadLiveState(
    interviewId: string,
    throughSequence: number,
  ): Promise<RepositoryResult<MonitoringLiveState>> {
    if (!Number.isSafeInteger(throughSequence) || throughSequence < 0) {
      return failure({ code: 'constraint_violation', constraint: 'outbox_live_state_query' });
    }

    try {
      const voiceResult = await this.executor.query(
        `SELECT event_id AS "eventId", interview_id AS "interviewId",
                language, run_id AS "runId", sequence_number AS "sequenceNumber",
                category, type, occurred_at AS "occurredAt", payload
           FROM app.event_outbox
          WHERE interview_id = $1
            AND sequence_number <= $2
            AND category = 'voice'
          ORDER BY sequence_number ASC
          LIMIT $3`,
        [interviewId, throughSequence, MAX_VOICE_PROJECTION_EVENTS + 1],
      );
      if (voiceResult.rows.length > MAX_VOICE_PROJECTION_EVENTS) {
        return failure(
          corruptData('outbox_event', interviewId, 'Voice state history exceeds projection bounds'),
        );
      }
      const voiceEvents = parseEvents(voiceResult.rows, interviewId);
      if (!voiceEvents.ok) return voiceEvents;
      const voiceState = projectVoiceState(voiceEvents.value, interviewId, throughSequence);
      if (!voiceState.ok) return voiceState;

      const boundaryResult = await this.executor.query(
        `WITH latest_start AS (
           SELECT sequence_number
             FROM app.event_outbox
            WHERE interview_id = $1
              AND sequence_number <= $2
              AND type = 'transcript.ai_text_stream_started'
            ORDER BY sequence_number DESC
            LIMIT 1
         )
         SELECT
           (SELECT sequence_number FROM latest_start) AS "startSequence",
           (SELECT type
              FROM app.event_outbox
             WHERE interview_id = $1
               AND sequence_number < (SELECT sequence_number FROM latest_start)
               AND type IN (
                 'transcript.ai_text_stream_started',
                 'transcript.ai_text_delta',
                 'transcript.ai_text_stream_completed',
                 'transcript.ai_text_stream_interrupted'
               )
             ORDER BY sequence_number DESC
             LIMIT 1) AS "previousType",
           EXISTS (
             SELECT 1
               FROM app.event_outbox
              WHERE interview_id = $1
                AND sequence_number <= $2
                AND type IN (
                  'transcript.ai_text_stream_started',
                  'transcript.ai_text_delta',
                  'transcript.ai_text_stream_completed',
                  'transcript.ai_text_stream_interrupted'
                )
           ) AS "hasAiEvents"`,
        [interviewId, throughSequence],
      );
      const boundary = aiProjectionBoundaryRowSchema.safeParse(boundaryResult.rows[0]);
      if (boundaryResult.rowCount !== 1 || !boundary.success) {
        return failure(
          corruptData(
            'outbox_event',
            interviewId,
            boundary.success ? 'Missing AI projection boundary' : boundary.error.message,
          ),
        );
      }
      if (boundary.data.hasAiEvents && boundary.data.startSequence === null) {
        return failure(
          corruptData('outbox_event', interviewId, 'AI text event exists without a stream start'),
        );
      }
      if (
        boundary.data.previousType !== null &&
        !TERMINAL_AI_EVENT_TYPES.has(boundary.data.previousType)
      ) {
        return failure(
          corruptData(
            'outbox_event',
            interviewId,
            'A new AI text stream started before the previous stream terminated',
          ),
        );
      }

      let activeAiTextStream: MonitoringLiveState['activeAiTextStream'] = null;
      if (boundary.data.startSequence !== null) {
        const aiResult = await this.executor.query(
          `SELECT event_id AS "eventId", interview_id AS "interviewId",
                  language, run_id AS "runId", sequence_number AS "sequenceNumber",
                  category, type, occurred_at AS "occurredAt", payload
             FROM app.event_outbox
            WHERE interview_id = $1
              AND sequence_number >= $2
              AND sequence_number <= $3
              AND type IN (
                'transcript.ai_text_stream_started',
                'transcript.ai_text_delta',
                'transcript.ai_text_stream_completed',
                'transcript.ai_text_stream_interrupted'
              )
            ORDER BY sequence_number ASC
            LIMIT $4`,
          [
            interviewId,
            boundary.data.startSequence,
            throughSequence,
            MAX_CURRENT_AI_STREAM_EVENTS + 1,
          ],
        );
        if (aiResult.rows.length > MAX_CURRENT_AI_STREAM_EVENTS) {
          return failure(
            corruptData('outbox_event', interviewId, 'AI text stream exceeds projection bounds'),
          );
        }
        const aiEvents = parseEvents(aiResult.rows, interviewId);
        if (!aiEvents.ok) return aiEvents;
        const projected = projectActiveAiTextStream(
          aiEvents.value,
          interviewId,
          boundary.data.startSequence,
          throughSequence,
        );
        if (!projected.ok) return projected;
        activeAiTextStream = projected.value;
      }

      const parsed = monitoringLiveStateSchema.safeParse({
        voiceState: voiceState.value,
        activeAiTextStream,
      });
      return parsed.success
        ? success(parsed.data)
        : failure(corruptData('outbox_event', interviewId, parsed.error.message));
    } catch (error: unknown) {
      return databaseFailure(error, interviewId);
    }
  }

  public async append(
    interviewId: string,
    event: MonitoringEventDraft,
  ): Promise<RepositoryResult<OutboxEventWrite>> {
    const prevalidated = monitoringEventSchema.safeParse({ ...event, sequenceNumber: 1 });
    if (!prevalidated.success || prevalidated.data.interviewId !== interviewId) {
      return failure({ code: 'constraint_violation', constraint: 'monitoring_event_contract' });
    }
    try {
      const locked = await this.executor.query(
        `SELECT c.next_event_sequence AS "nextEventSequence", i.language
           FROM app.interview_state st
           JOIN app.interview_counters c ON c.interview_id = st.interview_id
           JOIN app.interviews i ON i.id = st.interview_id
          WHERE st.interview_id = $1
          FOR UPDATE OF st, c`,
        [interviewId],
      );
      if (locked.rowCount === 0) {
        return failure({ code: 'not_found', resource: 'outbox_event', id: interviewId });
      }
      const counter = counterRowSchema.safeParse(locked.rows[0]);
      if (!counter.success) {
        return failure(corruptData('outbox_event', interviewId, counter.error.message));
      }

      const existingResult = await this.executor.query(
        `SELECT event_id AS "eventId", interview_id AS "interviewId",
                language, run_id AS "runId", sequence_number AS "sequenceNumber",
                category, type, occurred_at AS "occurredAt", payload
           FROM app.event_outbox
          WHERE event_id = $1`,
        [event.eventId],
      );
      if (existingResult.rowCount > 0) {
        const existing = parseEvents(existingResult.rows, interviewId, false);
        if (!existing.ok) {
          return existing;
        }
        const persisted = existing.value[0];
        if (persisted === undefined) {
          return failure(corruptData('outbox_event', event.eventId, 'Missing existing event'));
        }
        return persisted.interviewId === interviewId && sameDraft(persisted, event)
          ? success({ outcome: 'existing', value: persisted })
          : duplicateConflict(event.eventId);
      }

      const stateTransition = await this.validateStatefulTransition(
        interviewId,
        counter.data.nextEventSequence - 1,
        prevalidated.data,
      );
      if (!stateTransition.ok) {
        return stateTransition;
      }

      const allocationResult = await this.executor.query(
        `UPDATE app.interview_counters
            SET next_event_sequence = next_event_sequence + 1
          WHERE interview_id = $1
          RETURNING next_event_sequence - 1 AS "allocatedSequence"`,
        [interviewId],
      );
      const allocation = allocatedRowSchema.safeParse(allocationResult.rows[0]);
      if (
        allocationResult.rowCount !== 1 ||
        !allocation.success ||
        allocation.data.allocatedSequence !== counter.data.nextEventSequence
      ) {
        return failure(
          corruptData('outbox_event', interviewId, 'Event sequence allocation failed'),
        );
      }

      const validated = monitoringEventSchema.safeParse({
        ...event,
        language: counter.data.language,
        sequenceNumber: allocation.data.allocatedSequence,
      });
      if (!validated.success) {
        return failure({ code: 'constraint_violation', constraint: 'monitoring_event_contract' });
      }
      const persisted = validated.data;
      await this.executor.query(
        `INSERT INTO app.event_outbox (
           event_id, interview_id, language, run_id, sequence_number,
           category, type, occurred_at, payload
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          persisted.eventId,
          persisted.interviewId,
          persisted.language,
          persisted.runId,
          persisted.sequenceNumber,
          persisted.category,
          persisted.type,
          persisted.occurredAt,
          persisted.payload,
        ],
      );
      return success({ outcome: 'inserted', value: persisted });
    } catch (error: unknown) {
      return databaseFailure(error, event.eventId);
    }
  }

  private async validateStatefulTransition(
    interviewId: string,
    currentHighWater: number,
    event: MonitoringEvent,
  ): Promise<RepositoryResult<void>> {
    if (event.category !== 'voice' && !isAiTextStreamEvent(event)) {
      return success(undefined);
    }

    const current = await this.loadLiveState(interviewId, currentHighWater);
    if (!current.ok) {
      return current;
    }

    if (event.category === 'voice') {
      return event.payload.previousState === current.value.voiceState
        ? success(undefined)
        : failure({
            code: 'constraint_violation',
            constraint: 'monitoring_event_state_transition',
          });
    }

    const active = current.value.activeAiTextStream;
    const state: AiTextStreamState | null =
      active === null
        ? null
        : {
            status: 'streaming',
            interviewId: active.interviewId,
            runId: active.runId,
            utteranceId: active.utteranceId,
            turnId: active.turnId,
            lastDeltaSequenceNumber: active.lastDeltaSequenceNumber,
            generatedText: active.generatedText,
          };
    try {
      const next = reduceAiTextStreamEvent(state, event);
      return Array.from(next.generatedText).length <= MAX_AI_TEXT_CODE_POINTS
        ? success(undefined)
        : failure({
            code: 'constraint_violation',
            constraint: 'monitoring_event_state_transition',
          });
    } catch (error: unknown) {
      if (error instanceof AiTextStreamSequenceError) {
        return failure({
          code: 'constraint_violation',
          constraint: 'monitoring_event_state_transition',
        });
      }
      throw error;
    }
  }

  public async appendMany(
    interviewId: string,
    events: readonly MonitoringEventDraft[],
  ): Promise<RepositoryResult<OutboxBatchWrite>> {
    const writes: OutboxEventWrite[] = [];
    for (const event of events) {
      const result = await this.append(interviewId, event);
      if (!result.ok) {
        return result;
      }
      writes.push(result.value);
    }
    return success(writes);
  }
}

export function createPostgresOutboxRepository(executor: SqlExecutor): OutboxRepository {
  return new PostgresOutboxRepository(executor);
}

function parseEvents(
  rows: readonly unknown[],
  expectedInterviewId: string,
  enforceInterviewScope = true,
): RepositoryResult<readonly MonitoringEvent[]> {
  const events: MonitoringEvent[] = [];
  for (const row of rows) {
    const parsedRow = outboxRowSchema.safeParse(row);
    if (!parsedRow.success) {
      return failure(corruptData('outbox_event', expectedInterviewId, parsedRow.error.message));
    }
    if (enforceInterviewScope && parsedRow.data.interviewId !== expectedInterviewId) {
      return failure(
        corruptData('outbox_event', expectedInterviewId, 'Cross-interview outbox row'),
      );
    }
    const parsedEvent = monitoringEventSchema.safeParse(parsedRow.data);
    if (!parsedEvent.success) {
      return failure(
        corruptData('outbox_event', parsedRow.data.eventId, parsedEvent.error.message),
      );
    }
    events.push(parsedEvent.data);
  }
  return success(events);
}

function sameDraft(persisted: MonitoringEvent, draft: MonitoringEventDraft): boolean {
  const persistedDraft = {
    eventId: persisted.eventId,
    interviewId: persisted.interviewId,
    runId: persisted.runId,
    category: persisted.category,
    type: persisted.type,
    payload: persisted.payload,
  };
  const normalizedDraft = monitoringEventSchema.safeParse({ ...draft, sequenceNumber: 1 });
  return normalizedDraft.success
    ? Date.parse(persisted.occurredAt) === Date.parse(normalizedDraft.data.occurredAt) &&
        isDeepStrictEqual(persistedDraft, {
          eventId: normalizedDraft.data.eventId,
          interviewId: normalizedDraft.data.interviewId,
          runId: normalizedDraft.data.runId,
          category: normalizedDraft.data.category,
          type: normalizedDraft.data.type,
          payload: normalizedDraft.data.payload,
        })
    : false;
}

function validateReplayOrder(
  events: readonly MonitoringEvent[],
  afterSequence: number,
  throughSequence: number,
  pageLimit: number,
): string | null {
  let previousSequence = afterSequence;
  for (const event of events) {
    if (event.sequenceNumber !== previousSequence + 1 || event.sequenceNumber > throughSequence) {
      return 'Replay rows are outside the requested contiguous sequence window';
    }
    previousSequence = event.sequenceNumber;
  }
  if (previousSequence < throughSequence && events.length <= pageLimit) {
    return 'Replay window contains a missing event sequence';
  }
  return null;
}

function projectVoiceState(
  events: readonly MonitoringEvent[],
  interviewId: string,
  throughSequence: number,
): RepositoryResult<VoiceState> {
  let state: VoiceState = 'idle';
  let previousSequence = 0;
  for (const event of events) {
    if (
      event.category !== 'voice' ||
      event.sequenceNumber <= previousSequence ||
      event.sequenceNumber > throughSequence ||
      event.payload.previousState !== state
    ) {
      return failure(
        corruptData(
          'outbox_event',
          interviewId,
          'Voice events do not form one ordered state transition chain',
        ),
      );
    }
    state = event.payload.nextState;
    previousSequence = event.sequenceNumber;
  }
  return success(state);
}

function projectActiveAiTextStream(
  events: readonly MonitoringEvent[],
  interviewId: string,
  startSequence: number,
  throughSequence: number,
): RepositoryResult<MonitoringLiveState['activeAiTextStream']> {
  let state: AiTextStreamState | null = null;
  let startedAt: string | null = null;
  let previousOutboxSequence = startSequence - 1;
  let accumulatedCodePoints = 0;

  try {
    for (const event of events) {
      if (
        event.sequenceNumber <= previousOutboxSequence ||
        event.sequenceNumber > throughSequence ||
        !isAiTextStreamEvent(event)
      ) {
        throw new AiTextStreamSequenceError('AI text projection events are out of order or type');
      }
      if (state === null && event.sequenceNumber !== startSequence) {
        throw new AiTextStreamSequenceError(
          'AI text projection does not begin at its stream start',
        );
      }
      if (event.type === 'transcript.ai_text_stream_started') {
        startedAt = event.payload.startedAt;
      } else if (event.type === 'transcript.ai_text_delta') {
        accumulatedCodePoints += Array.from(event.payload.textDelta).length;
        if (accumulatedCodePoints > MAX_AI_TEXT_CODE_POINTS) {
          throw new AiTextStreamSequenceError('AI text stream exceeds the transcript text bound');
        }
      }
      state = reduceAiTextStreamEvent(state, event);
      previousOutboxSequence = event.sequenceNumber;
    }
  } catch (error: unknown) {
    const reason =
      error instanceof AiTextStreamSequenceError
        ? error.message
        : 'AI text stream projection failed unexpectedly';
    return failure(corruptData('outbox_event', interviewId, reason));
  }

  if (state === null || startedAt === null) {
    return failure(
      corruptData('outbox_event', interviewId, 'AI text stream projection is missing its start'),
    );
  }
  return success(
    state.status === 'streaming'
      ? {
          interviewId: state.interviewId,
          runId: state.runId,
          utteranceId: state.utteranceId,
          turnId: state.turnId,
          startedAt,
          lastDeltaSequenceNumber: state.lastDeltaSequenceNumber,
          generatedText: state.generatedText,
        }
      : null,
  );
}

function isAiTextStreamEvent(event: MonitoringEvent): event is AiTextStreamEvent {
  return (
    event.type === 'transcript.ai_text_stream_started' ||
    event.type === 'transcript.ai_text_delta' ||
    event.type === 'transcript.ai_text_stream_completed' ||
    event.type === 'transcript.ai_text_stream_interrupted'
  );
}

function duplicateConflict(identity: string): RepositoryResult<never> {
  return failure({ code: 'duplicate_conflict', resource: 'outbox_event', identity });
}

function databaseFailure(error: unknown, identity: string): RepositoryResult<never> {
  return failure(mapDatabaseError(error, { resource: 'outbox_event', identity }));
}
