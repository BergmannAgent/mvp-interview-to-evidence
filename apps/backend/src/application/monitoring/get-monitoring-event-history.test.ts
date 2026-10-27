import type { MonitoringEvent } from '@orgscience/contracts';
import { describe, expect, it } from 'vitest';

import {
  failure,
  success,
  type AppReadContext,
  type AppTransaction,
  type AppUnitOfWork,
  type RepositoryError,
  type RepositoryResult,
  type Result,
} from '../persistence/index.js';
import { GetMonitoringEventHistoryService } from './get-monitoring-event-history.js';

const INTERVIEW_ID = 'interview-history-1';
const NOW = '2026-08-12T11:00:00.000Z';

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

class HistoryUnitOfWork implements AppUnitOfWork {
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

describe('GetMonitoringEventHistoryService', () => {
  it('returns a bounded persisted page with a resumable continuation cursor', async () => {
    const events = [event(1), event(2), event(3)];
    let replayQuery: unknown;
    const unitOfWork = new HistoryUnitOfWork({
      interviews: { load: async () => success({ interviewId: INTERVIEW_ID }) },
      outbox: {
        replay: async (
          _interviewId: string,
          query: { readonly afterSequence: number; readonly limit: number },
        ) => {
          replayQuery = query;
          return success({ events: events.slice(0, 2), highWaterSequence: 3, hasMore: true });
        },
      },
    } as unknown as AppReadContext);

    await expect(
      new GetMonitoringEventHistoryService(unitOfWork).execute({
        interviewId: INTERVIEW_ID,
        afterSequence: 0,
        throughSequence: null,
        limit: 2,
      }),
    ).resolves.toEqual({
      ok: true,
      value: {
        interviewId: INTERVIEW_ID,
        afterSequence: 0,
        highWaterSequence: 3,
        events: events.slice(0, 2),
        hasMore: true,
        nextAfterSequence: 2,
      },
    });
    expect(replayQuery).toEqual({ afterSequence: 0, limit: 2 });
    expect(unitOfWork.reads).toBe(1);
  });

  it('does not read the outbox for a missing interview', async () => {
    let replayed = false;
    const unitOfWork = new HistoryUnitOfWork({
      interviews: {
        load: async () => failure({ code: 'not_found', resource: 'interview', id: INTERVIEW_ID }),
      },
      outbox: {
        replay: async () => {
          replayed = true;
          throw new Error('Unexpected replay');
        },
      },
    } as unknown as AppReadContext);

    await expect(
      new GetMonitoringEventHistoryService(unitOfWork).execute({
        interviewId: INTERVIEW_ID,
        afterSequence: 0,
        throughSequence: null,
        limit: 100,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(replayed).toBe(false);
  });

  it('rejects invalid internal bounds before opening a database read', async () => {
    const unitOfWork = new HistoryUnitOfWork({} as unknown as AppReadContext);
    const service = new GetMonitoringEventHistoryService(unitOfWork);

    await expect(
      service.execute({
        interviewId: INTERVIEW_ID,
        afterSequence: -1,
        throughSequence: null,
        limit: 100,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'application_validation' } });
    await expect(
      service.execute({
        interviewId: INTERVIEW_ID,
        afterSequence: 0,
        throughSequence: null,
        limit: 501,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'application_validation' } });
    await expect(
      service.execute({
        interviewId: INTERVIEW_ID,
        afterSequence: 2,
        throughSequence: 1,
        limit: 100,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'application_validation' } });
    expect(unitOfWork.reads).toBe(0);
  });

  it('maps a repository cursor conflict to the monitoring reset contract', async () => {
    const unitOfWork = new HistoryUnitOfWork({
      interviews: { load: async () => success({ interviewId: INTERVIEW_ID }) },
      outbox: {
        replay: async () =>
          failure({
            code: 'sequence_conflict',
            interviewId: INTERVIEW_ID,
            expected: 2,
            actual: 3,
          }),
      },
    } as unknown as AppReadContext);

    await expect(
      new GetMonitoringEventHistoryService(unitOfWork).execute({
        interviewId: INTERVIEW_ID,
        afterSequence: 3,
        throughSequence: null,
        limit: 100,
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'monitoring_cursor_ahead',
        interviewId: INTERVIEW_ID,
        cursor: 3,
        highWaterSequence: 2,
      },
    });
  });

  it('keeps subsequent pages on the first page high-water boundary', async () => {
    let replayQuery: unknown;
    const unitOfWork = new HistoryUnitOfWork({
      interviews: { load: async () => success({ interviewId: INTERVIEW_ID }) },
      outbox: {
        replay: async (
          _interviewId: string,
          query: {
            readonly afterSequence: number;
            readonly throughSequence?: number;
            readonly limit: number;
          },
        ) => {
          replayQuery = query;
          return success({ events: [event(3)], highWaterSequence: 3, hasMore: false });
        },
      },
    } as unknown as AppReadContext);

    await expect(
      new GetMonitoringEventHistoryService(unitOfWork).execute({
        interviewId: INTERVIEW_ID,
        afterSequence: 2,
        throughSequence: 3,
        limit: 100,
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { highWaterSequence: 3, hasMore: false },
    });
    expect(replayQuery).toEqual({ afterSequence: 2, throughSequence: 3, limit: 100 });
  });
});
