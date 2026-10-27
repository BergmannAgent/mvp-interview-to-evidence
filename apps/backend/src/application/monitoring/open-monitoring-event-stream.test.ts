import type { MonitoringEvent } from '@orgscience/contracts';
import { describe, expect, it } from 'vitest';

import { InMemoryRealtimeSignalHub } from '../../infrastructure/realtime/signal-hub.js';
import {
  failure,
  success,
  type AppReadContext,
  type AppTransaction,
  type AppUnitOfWork,
  type OutboxReader,
  type RepositoryError,
  type RepositoryResult,
  type Result,
} from '../persistence/index.js';
import { OpenMonitoringEventStreamService } from './open-monitoring-event-stream.js';

const INTERVIEW_ID = 'interview-1';
const NOW = '2026-08-12T10:00:00.000Z';

function event(sequenceNumber: number): MonitoringEvent {
  return {
    eventId: `event-${String(sequenceNumber)}`,
    interviewId: INTERVIEW_ID,
    language: 'de',
    runId: `run-${String(sequenceNumber)}`,
    sequenceNumber,
    occurredAt: NOW,
    category: 'interview',
    type: 'interview.status_changed',
    payload: {
      previousStatus: sequenceNumber === 1 ? null : 'ready',
      nextStatus: 'ready',
      changedAt: NOW,
    },
  };
}

class MemoryOutbox implements OutboxReader {
  public events: MonitoringEvent[] = [];
  public highWaterHook: (() => void) | undefined;
  public highWaterGate: Promise<void> | undefined;
  public replayGate: Promise<void> | undefined;
  public replayCalls = 0;
  public forcedError: RepositoryError | undefined;

  public async highWater(interviewId: string): Promise<RepositoryResult<number>> {
    if (interviewId !== INTERVIEW_ID) {
      return failure({ code: 'not_found', resource: 'outbox_event', id: interviewId });
    }
    this.highWaterHook?.();
    this.highWaterHook = undefined;
    await this.highWaterGate;
    return success(this.events.at(-1)?.sequenceNumber ?? 0);
  }

  public async replay(
    interviewId: string,
    query: {
      readonly afterSequence: number;
      readonly throughSequence?: number;
      readonly limit: number;
    },
  ): Promise<
    RepositoryResult<{
      readonly events: readonly MonitoringEvent[];
      readonly highWaterSequence: number;
      readonly hasMore: boolean;
    }>
  > {
    this.replayCalls += 1;
    const replayGate = this.replayGate;
    this.replayGate = undefined;
    await replayGate;
    if (this.forcedError !== undefined) return failure(this.forcedError);
    if (interviewId !== INTERVIEW_ID) {
      return failure({ code: 'not_found', resource: 'outbox_event', id: interviewId });
    }
    const currentHighWater = this.events.at(-1)?.sequenceNumber ?? 0;
    if (query.afterSequence > currentHighWater) {
      return failure({
        code: 'sequence_conflict',
        interviewId,
        expected: currentHighWater,
        actual: query.afterSequence,
      });
    }
    const throughSequence = Math.min(query.throughSequence ?? currentHighWater, currentHighWater);
    const matching = this.events.filter(
      (candidate) =>
        candidate.sequenceNumber > query.afterSequence &&
        candidate.sequenceNumber <= throughSequence,
    );
    return success({
      events: matching.slice(0, query.limit),
      highWaterSequence: throughSequence,
      hasMore: matching.length > query.limit,
    });
  }
}

class OutboxUnitOfWork implements AppUnitOfWork {
  public constructor(
    private readonly outbox: OutboxReader,
    private readonly interviewExists = true,
  ) {}

  public async read<T>(
    operation: (context: AppReadContext) => Promise<RepositoryResult<T>>,
  ): Promise<RepositoryResult<T>> {
    return operation({
      outbox: this.outbox,
      interviews: {
        load: async (interviewId: string) =>
          this.interviewExists
            ? success({ interviewId })
            : failure({ code: 'not_found', resource: 'interview', id: interviewId }),
      },
    } as AppReadContext);
  }

  public async transaction<T, E = never>(
    operation: (transaction: AppTransaction) => Promise<Result<T, E | RepositoryError>>,
  ): Promise<Result<T, E | RepositoryError>> {
    void operation;
    throw new Error('Unexpected transaction');
  }
}

function service(outbox: MemoryOutbox, hub: InMemoryRealtimeSignalHub) {
  return new OpenMonitoringEventStreamService(new OutboxUnitOfWork(outbox), hub, {
    pollIntervalMs: 10,
    replayPageSize: 2,
    maximumReplayEvents: 10,
  });
}

describe('OpenMonitoringEventStreamService', () => {
  it('subscribes before high-water capture and replays an event committed in that window', async () => {
    const outbox = new MemoryOutbox();
    const hub = new InMemoryRealtimeSignalHub();
    outbox.highWaterHook = () => {
      outbox.events.push(event(1));
      hub.signal(INTERVIEW_ID);
    };

    const opened = await service(outbox, hub).execute({
      interviewId: INTERVIEW_ID,
      afterSequence: 0,
    });

    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.initialHighWaterSequence).toBe(1);
    await expect(opened.value.read()).resolves.toMatchObject({
      ok: true,
      value: { status: 'events', events: [{ sequenceNumber: 1 }] },
    });
    opened.value.close();
  });

  it('paginates a fixed replay window and then delivers newer signaled events once', async () => {
    const outbox = new MemoryOutbox();
    outbox.events.push(event(1), event(2), event(3));
    const hub = new InMemoryRealtimeSignalHub();
    const opened = await service(outbox, hub).execute({
      interviewId: INTERVIEW_ID,
      afterSequence: 0,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    await expect(opened.value.read()).resolves.toMatchObject({
      ok: true,
      value: { status: 'events', events: [{ sequenceNumber: 1 }, { sequenceNumber: 2 }] },
    });
    await expect(opened.value.read()).resolves.toMatchObject({
      ok: true,
      value: { status: 'events', events: [{ sequenceNumber: 3 }] },
    });

    outbox.events.push(event(4));
    hub.signal(INTERVIEW_ID);
    await expect(opened.value.read()).resolves.toMatchObject({
      ok: true,
      value: { status: 'events', events: [{ sequenceNumber: 4 }] },
    });
    opened.value.close();
  });

  it('recovers a missed notification through bounded periodic polling', async () => {
    const outbox = new MemoryOutbox();
    outbox.events.push(event(1));
    const hub = new InMemoryRealtimeSignalHub();
    const opened = await service(outbox, hub).execute({
      interviewId: INTERVIEW_ID,
      afterSequence: 1,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    outbox.events.push(event(2));
    await expect(opened.value.read()).resolves.toMatchObject({
      ok: true,
      value: { status: 'events', events: [{ sequenceNumber: 2 }] },
    });
    opened.value.close();
  });

  it('feeds multiple monitoring tabs independently without cross-interview state', async () => {
    const outbox = new MemoryOutbox();
    outbox.events.push(event(1));
    const hub = new InMemoryRealtimeSignalHub();
    const streamService = service(outbox, hub);
    const [first, second] = await Promise.all([
      streamService.execute({ interviewId: INTERVIEW_ID, afterSequence: 1 }),
      streamService.execute({ interviewId: INTERVIEW_ID, afterSequence: 1 }),
    ]);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    outbox.events.push(event(2));
    hub.signal(INTERVIEW_ID);
    const [firstRead, secondRead] = await Promise.all([first.value.read(), second.value.read()]);
    expect(firstRead).toMatchObject({
      ok: true,
      value: { status: 'events', events: [{ sequenceNumber: 2 }] },
    });
    expect(secondRead).toMatchObject({
      ok: true,
      value: { status: 'events', events: [{ sequenceNumber: 2 }] },
    });
    first.value.close();
    second.value.close();
    expect(hub.subscriberCount).toBe(0);
  });

  it('returns an explicit reset error and cleans up when a cursor is ahead', async () => {
    const outbox = new MemoryOutbox();
    outbox.events.push(event(1));
    const hub = new InMemoryRealtimeSignalHub();

    const opened = await service(outbox, hub).execute({
      interviewId: INTERVIEW_ID,
      afterSequence: 2,
    });

    expect(opened).toEqual({
      ok: false,
      error: {
        code: 'monitoring_cursor_ahead',
        interviewId: INTERVIEW_ID,
        cursor: 2,
        highWaterSequence: 1,
      },
    });
    expect(hub.subscriberCount).toBe(0);
  });

  it('does not open a stream for a missing interview and releases its provisional subscription', async () => {
    const outbox = new MemoryOutbox();
    const hub = new InMemoryRealtimeSignalHub();
    const streamService = new OpenMonitoringEventStreamService(
      new OutboxUnitOfWork(outbox, false),
      hub,
      { pollIntervalMs: 10, replayPageSize: 2, maximumReplayEvents: 10 },
    );

    await expect(
      streamService.execute({ interviewId: 'interview-missing', afterSequence: 0 }),
    ).resolves.toEqual({
      ok: false,
      error: { code: 'not_found', resource: 'interview', id: 'interview-missing' },
    });
    expect(hub.subscriberCount).toBe(0);
  });

  it('releases its provisional subscription when the request aborts during high-water capture', async () => {
    const outbox = new MemoryOutbox();
    const hub = new InMemoryRealtimeSignalHub();
    let releaseHighWater: (() => void) | undefined;
    outbox.highWaterGate = new Promise<void>((resolve) => {
      releaseHighWater = resolve;
    });
    const controller = new AbortController();

    const opening = service(outbox, hub).execute({
      interviewId: INTERVIEW_ID,
      afterSequence: 0,
      signal: controller.signal,
    });
    await Promise.resolve();
    expect(hub.subscriberCount).toBe(1);

    controller.abort();
    expect(hub.subscriberCount).toBe(0);
    releaseHighWater?.();
    await expect(opening).resolves.toEqual({
      ok: false,
      error: { code: 'unavailable', retryable: true },
    });
  });

  it('requires a fresh snapshot instead of replaying an unbounded backlog', async () => {
    const outbox = new MemoryOutbox();
    outbox.events.push(...Array.from({ length: 11 }, (_, index) => event(index + 1)));
    const hub = new InMemoryRealtimeSignalHub();

    const opened = await service(outbox, hub).execute({
      interviewId: INTERVIEW_ID,
      afterSequence: 0,
    });

    expect(opened).toEqual({
      ok: false,
      error: {
        code: 'monitoring_cursor_stale',
        interviewId: INTERVIEW_ID,
        cursor: 0,
        highWaterSequence: 11,
        maximumReplayEvents: 10,
      },
    });
    expect(hub.subscriberCount).toBe(0);
  });

  it('unblocks a pending read when the tab disconnects or the server begins shutdown', async () => {
    const outbox = new MemoryOutbox();
    const hub = new InMemoryRealtimeSignalHub();
    const opened = await service(outbox, hub).execute({
      interviewId: INTERVIEW_ID,
      afterSequence: 0,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const pending = opened.value.read();
    hub.close();
    await expect(pending).resolves.toEqual({
      ok: true,
      value: { status: 'closed', highWaterSequence: 0, reason: 'server_shutdown' },
    });
  });

  it('stops replaying a backlog immediately after client cancellation', async () => {
    const outbox = new MemoryOutbox();
    outbox.events.push(event(1), event(2), event(3));
    const hub = new InMemoryRealtimeSignalHub();
    const controller = new AbortController();
    const opened = await service(outbox, hub).execute({
      interviewId: INTERVIEW_ID,
      afterSequence: 0,
      signal: controller.signal,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    await expect(opened.value.read()).resolves.toMatchObject({
      ok: true,
      value: { status: 'events', events: [{ sequenceNumber: 1 }, { sequenceNumber: 2 }] },
    });
    expect(outbox.replayCalls).toBe(1);

    controller.abort();
    await expect(opened.value.read()).resolves.toEqual({
      ok: true,
      value: { status: 'closed', highWaterSequence: 3, reason: 'client_closed' },
    });
    expect(outbox.replayCalls).toBe(1);
  });

  it('discards a replay page when cancellation arrives during its database read', async () => {
    const outbox = new MemoryOutbox();
    outbox.events.push(event(1), event(2), event(3));
    let releaseReplay: (() => void) | undefined;
    outbox.replayGate = new Promise<void>((resolve) => {
      releaseReplay = resolve;
    });
    const hub = new InMemoryRealtimeSignalHub();
    const controller = new AbortController();
    const opened = await service(outbox, hub).execute({
      interviewId: INTERVIEW_ID,
      afterSequence: 0,
      signal: controller.signal,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const pendingRead = opened.value.read();
    await Promise.resolve();
    controller.abort();
    releaseReplay?.();

    await expect(pendingRead).resolves.toEqual({
      ok: true,
      value: { status: 'closed', highWaterSequence: 3, reason: 'client_closed' },
    });
    expect(outbox.replayCalls).toBe(1);
  });

  it('does not query a replay page after server shutdown', async () => {
    const outbox = new MemoryOutbox();
    outbox.events.push(event(1), event(2), event(3));
    const hub = new InMemoryRealtimeSignalHub();
    const opened = await service(outbox, hub).execute({
      interviewId: INTERVIEW_ID,
      afterSequence: 0,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    hub.close();
    await expect(opened.value.read()).resolves.toEqual({
      ok: true,
      value: { status: 'closed', highWaterSequence: 3, reason: 'server_shutdown' },
    });
    expect(outbox.replayCalls).toBe(0);
  });

  it('contains a persisted replay corruption instead of emitting partial history', async () => {
    const outbox = new MemoryOutbox();
    outbox.events.push(event(1));
    outbox.forcedError = {
      code: 'corrupt_data',
      resource: 'outbox_event',
      id: INTERVIEW_ID,
      reason: 'missing sequence',
    };
    const hub = new InMemoryRealtimeSignalHub();
    const opened = await service(outbox, hub).execute({
      interviewId: INTERVIEW_ID,
      afterSequence: 0,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    await expect(opened.value.read()).resolves.toEqual({
      ok: false,
      error: outbox.forcedError,
    });
    opened.value.close();
  });
});
