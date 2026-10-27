import {
  idSchema,
  monitoringEventHistoryPageSchema,
  monitoringEventHistoryQuerySchema,
  monitoringEventCursorSchema,
  monitoringSnapshotResponseSchema,
  monitoringStreamQuerySchema,
  type MonitoringSnapshot,
  type MonitoringEventHistoryPage,
  type MonitoringEventHistoryQuery,
} from '@orgscience/contracts';
import { zValidator } from '@hono/zod-validator';
import type { Hono } from 'hono';
import { z } from 'zod';

import type {
  ApplicationResult,
  MonitoringEventStream,
  MonitoringEventStreamRead,
} from '../../application/index.js';
import {
  createApiErrorResponse,
  createApplicationErrorResponse,
  type ErrorResponseClock,
  type HttpEnvironment,
} from './error-response.js';
import {
  DEFAULT_MONITORING_HTTP_STREAM_OPTIONS,
  isMonitoringResetRequired,
  streamMonitoringEventSource,
  validateMonitoringHttpStreamOptions,
  type MonitoringHttpStreamOptions,
} from './monitoring-sse.js';
import { validationHook } from './validation-hook.js';

interface Executor<TInput, TOutput> {
  execute(input: TInput): Promise<ApplicationResult<TOutput>>;
}

export interface MonitoringHttpRouteDependencies {
  readonly clock: ErrorResponseClock;
  readonly getMonitoringSnapshot: Executor<string, MonitoringSnapshot>;
  readonly getMonitoringEventHistory: Executor<
    MonitoringEventHistoryQuery & { readonly interviewId: string },
    MonitoringEventHistoryPage
  >;
  readonly openMonitoringEventStream: Executor<
    { readonly interviewId: string; readonly afterSequence: number; readonly signal?: AbortSignal },
    MonitoringEventStream
  >;
  readonly monitoringStreamOptions?: Partial<MonitoringHttpStreamOptions>;
}

const interviewParamsSchema = z.strictObject({ interviewId: idSchema });

export function registerMonitoringHttpRoutes(
  app: Hono<HttpEnvironment>,
  dependencies: MonitoringHttpRouteDependencies,
): void {
  const monitoringStreamOptions = validateMonitoringHttpStreamOptions({
    ...DEFAULT_MONITORING_HTTP_STREAM_OPTIONS,
    ...dependencies.monitoringStreamOptions,
  });

  app.get(
    '/api/v1/interviews/:interviewId/monitoring',
    zValidator<
      typeof interviewParamsSchema,
      'param',
      HttpEnvironment,
      string,
      ReturnType<typeof validationHook>
    >('param', interviewParamsSchema, validationHook(dependencies.clock)),
    async (context) => {
      const { interviewId } = context.req.valid('param');
      const snapshot = await dependencies.getMonitoringSnapshot.execute(interviewId);
      if (!snapshot.ok) {
        return createApplicationErrorResponse(context, dependencies.clock, snapshot.error);
      }
      return context.json(
        monitoringSnapshotResponseSchema.parse({ snapshot: snapshot.value }),
        200,
      );
    },
  );

  app.get(
    '/api/v1/interviews/:interviewId/event-history',
    zValidator<
      typeof interviewParamsSchema,
      'param',
      HttpEnvironment,
      string,
      ReturnType<typeof validationHook>
    >('param', interviewParamsSchema, validationHook(dependencies.clock)),
    zValidator<
      typeof monitoringEventHistoryQuerySchema,
      'query',
      HttpEnvironment,
      string,
      ReturnType<typeof validationHook>
    >('query', monitoringEventHistoryQuerySchema, validationHook(dependencies.clock)),
    async (context) => {
      if (hasDuplicateHistoryCursorParameters(context.req.url)) {
        return createApiErrorResponse(context, dependencies.clock, {
          status: 400,
          code: 'VALIDATION_ERROR',
          message: 'The monitoring event history query is ambiguous.',
          fieldErrors: [
            {
              path: ['query'],
              code: 'duplicate_parameter',
              message: 'Provide each event history query parameter at most once.',
            },
          ],
        });
      }
      const { interviewId } = context.req.valid('param');
      const query: MonitoringEventHistoryQuery = context.req.valid('query');
      const history = await dependencies.getMonitoringEventHistory.execute({
        interviewId,
        ...query,
      });
      if (!history.ok) {
        return createApplicationErrorResponse(context, dependencies.clock, history.error);
      }
      return context.json(monitoringEventHistoryPageSchema.parse(history.value), 200);
    },
  );

  app.get(
    '/api/v1/interviews/:interviewId/events',
    zValidator<
      typeof interviewParamsSchema,
      'param',
      HttpEnvironment,
      string,
      ReturnType<typeof validationHook>
    >('param', interviewParamsSchema, validationHook(dependencies.clock)),
    async (context) => {
      const { interviewId } = context.req.valid('param');
      const cursor = readMonitoringCursor(context.req.url, context.req.header('last-event-id'));
      if (!cursor.ok) {
        return createApiErrorResponse(context, dependencies.clock, {
          status: 400,
          code: 'VALIDATION_ERROR',
          message: 'The monitoring cursor is invalid.',
          fieldErrors: [
            {
              path: [cursor.field],
              code: 'invalid_cursor',
              message: 'Use one canonical nonnegative decimal event sequence.',
            },
          ],
        });
      }

      const opened = await dependencies.openMonitoringEventStream.execute({
        interviewId,
        afterSequence: cursor.value,
        signal: context.req.raw.signal,
      });
      if (!opened.ok) {
        return createApplicationErrorResponse(context, dependencies.clock, opened.error);
      }

      const eventStream = opened.value;
      let preflight: MonitoringEventStreamRead | undefined;
      if (eventStream.initialAfterSequence < eventStream.initialHighWaterSequence) {
        const firstRead = await eventStream.read();
        if (!firstRead.ok) {
          eventStream.close();
          if (isMonitoringResetRequired(firstRead.error)) {
            return createMonitoringSnapshotResetResponse(context, dependencies.clock);
          }
          return createApplicationErrorResponse(context, dependencies.clock, firstRead.error);
        }
        if (firstRead.value.status === 'closed' && firstRead.value.reason === 'server_shutdown') {
          eventStream.close();
          return createApplicationErrorResponse(context, dependencies.clock, {
            code: 'unavailable',
            retryable: true,
          });
        }
        if (!isValidReplayPreflight(firstRead.value, eventStream)) {
          eventStream.close();
          return createMonitoringSnapshotResetResponse(context, dependencies.clock);
        }
        preflight = firstRead.value;
      }

      return streamMonitoringEventSource(context, {
        clock: dependencies.clock,
        eventStream,
        interviewId,
        options: monitoringStreamOptions,
        ...(preflight === undefined ? {} : { preflight }),
      });
    },
  );
}

function hasDuplicateHistoryCursorParameters(requestUrl: string): boolean {
  const parameters = new URL(requestUrl).searchParams;
  return (
    parameters.getAll('afterSequence').length > 1 ||
    parameters.getAll('throughSequence').length > 1 ||
    parameters.getAll('limit').length > 1
  );
}

export {
  DEFAULT_MONITORING_HTTP_STREAM_OPTIONS,
  type MonitoringHttpStreamOptions,
} from './monitoring-sse.js';

function readMonitoringCursor(
  requestUrl: string,
  lastEventId: string | undefined,
):
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly field: 'afterSequence' | 'last-event-id' } {
  const parameters = new URL(requestUrl).searchParams;
  if (
    [...parameters.keys()].some((key) => key !== 'afterSequence') ||
    parameters.getAll('afterSequence').length > 1
  ) {
    return { ok: false, field: 'afterSequence' };
  }
  if (lastEventId !== undefined) {
    const parsedHeader = monitoringEventCursorSchema.safeParse(lastEventId);
    return parsedHeader.success
      ? { ok: true, value: parsedHeader.data }
      : { ok: false, field: 'last-event-id' };
  }
  const parsedQuery = monitoringStreamQuerySchema.safeParse(
    parameters.has('afterSequence') ? { afterSequence: parameters.get('afterSequence') } : {},
  );
  if (!parsedQuery.success) return { ok: false, field: 'afterSequence' };
  return { ok: true, value: parsedQuery.data.afterSequence };
}

function isValidReplayPreflight(
  read: MonitoringEventStreamRead,
  eventStream: MonitoringEventStream,
): boolean {
  if (
    read.status !== 'events' ||
    read.events.length === 0 ||
    read.highWaterSequence !== eventStream.initialHighWaterSequence
  ) {
    return false;
  }
  let expectedSequence = eventStream.initialAfterSequence + 1;
  for (const event of read.events) {
    if (
      event.interviewId !== eventStream.interviewId ||
      event.sequenceNumber !== expectedSequence
    ) {
      return false;
    }
    expectedSequence += 1;
  }
  return true;
}

function createMonitoringSnapshotResetResponse(
  context: Parameters<typeof createApiErrorResponse>[0],
  clock: ErrorResponseClock,
): Response {
  return createApiErrorResponse(context, clock, {
    status: 409,
    code: 'SNAPSHOT_RESET_REQUIRED',
    message: 'Persisted monitoring history is not contiguous. Refresh the snapshot.',
    fieldErrors: [
      {
        path: ['afterSequence'],
        code: 'event_gap',
        message: 'The requested replay window cannot be delivered contiguously.',
      },
    ],
  });
}
