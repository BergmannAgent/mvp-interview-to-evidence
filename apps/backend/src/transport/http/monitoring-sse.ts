import {
  monitoringSseEventFrameSchema,
  monitoringSseFaultFrameSchema,
  monitoringSseReadyFrameSchema,
  timestampSchema,
} from '@orgscience/contracts';
import type { Context } from 'hono';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';

import type {
  ApplicationError,
  MonitoringEventStream,
  MonitoringEventStreamRead,
} from '../../application/index.js';
import type { ErrorResponseClock, HttpEnvironment } from './error-response.js';

export interface MonitoringHttpStreamOptions {
  readonly heartbeatIntervalMs: number;
  readonly retryMs: number;
  readonly writeTimeoutMs: number;
  readonly maximumFrameBytes: number;
}

export const DEFAULT_MONITORING_HTTP_STREAM_OPTIONS: MonitoringHttpStreamOptions = Object.freeze({
  heartbeatIntervalMs: 15_000,
  retryMs: 1_000,
  writeTimeoutMs: 5_000,
  maximumFrameBytes: 262_144,
});

interface MonitoringEventSourceInput {
  readonly clock: ErrorResponseClock;
  readonly eventStream: MonitoringEventStream;
  readonly interviewId: string;
  readonly options: MonitoringHttpStreamOptions;
  readonly preflight?: MonitoringEventStreamRead;
}

export function streamMonitoringEventSource(
  context: Context<HttpEnvironment>,
  input: MonitoringEventSourceInput,
): Response {
  const { clock, eventStream, interviewId, options, preflight } = input;

  return streamSSE(context, async (stream) => {
    stream.onAbort(() => {
      eventStream.close();
    });
    let highWaterSequence = eventStream.initialHighWaterSequence;
    let sequence = eventStream.initialAfterSequence;
    let lastHeartbeatAt = Date.now();
    try {
      const readyFrame = monitoringSseReadyFrameSchema.parse({
        event: 'ready',
        data: {
          type: 'monitoring.ready',
          interviewId,
          afterSequence: eventStream.initialAfterSequence,
          replayThroughSequence: eventStream.initialHighWaterSequence,
          connectedAt: safeClockNow(clock),
          retryMs: options.retryMs,
        },
      });
      await writeSseWithDeadline(
        stream,
        {
          event: readyFrame.event,
          data: serializeFrameData(readyFrame.data, options.maximumFrameBytes),
          retry: options.retryMs,
        },
        options.writeTimeoutMs,
      );

      let nextRead = preflight;
      while (!stream.aborted) {
        const read =
          nextRead === undefined
            ? await eventStream.read()
            : ({ ok: true, value: nextRead } as const);
        nextRead = undefined;
        if (!read.ok) throw new MonitoringStreamReadError(read.error);
        highWaterSequence = read.value.highWaterSequence;
        if (read.value.status === 'closed') {
          if (read.value.reason === 'server_shutdown') {
            throw new MonitoringServerShutdownError();
          }
          break;
        }
        if (read.value.status === 'heartbeat') {
          if (Date.now() - lastHeartbeatAt >= options.heartbeatIntervalMs) {
            await writeWithDeadline(
              stream,
              stream.write(': heartbeat\n\n'),
              options.writeTimeoutMs,
            );
            lastHeartbeatAt = Date.now();
          }
          continue;
        }

        for (const event of read.value.events) {
          if (event.interviewId !== interviewId || event.sequenceNumber !== sequence + 1) {
            throw new MonitoringProtocolError();
          }
          const frame = monitoringSseEventFrameSchema.parse({
            event: 'monitoring',
            id: String(event.sequenceNumber),
            data: event,
          });
          await writeSseWithDeadline(
            stream,
            {
              event: frame.event,
              id: frame.id,
              data: serializeFrameData(frame.data, options.maximumFrameBytes),
            },
            options.writeTimeoutMs,
          );
          sequence = event.sequenceNumber;
        }
      }
    } catch (error: unknown) {
      if (!stream.aborted) {
        const fault = toMonitoringFault(error, interviewId, highWaterSequence, clock);
        try {
          await writeSseWithDeadline(
            stream,
            {
              event: fault.event,
              data: serializeFrameData(fault.data, options.maximumFrameBytes),
            },
            options.writeTimeoutMs,
          );
        } catch {
          stream.abort();
        }
      }
    } finally {
      eventStream.close();
    }
  });
}

export function isMonitoringResetRequired(error: ApplicationError): boolean {
  return (
    error.code === 'monitoring_cursor_ahead' ||
    error.code === 'monitoring_cursor_stale' ||
    error.code === 'sequence_conflict' ||
    error.code === 'corrupt_data'
  );
}

export function validateMonitoringHttpStreamOptions(
  options: MonitoringHttpStreamOptions,
): MonitoringHttpStreamOptions {
  if (
    !Number.isSafeInteger(options.heartbeatIntervalMs) ||
    options.heartbeatIntervalMs < 10 ||
    options.heartbeatIntervalMs > 60_000 ||
    !Number.isSafeInteger(options.retryMs) ||
    options.retryMs < 250 ||
    options.retryMs > 60_000 ||
    !Number.isSafeInteger(options.writeTimeoutMs) ||
    options.writeTimeoutMs < 10 ||
    options.writeTimeoutMs > 30_000 ||
    !Number.isSafeInteger(options.maximumFrameBytes) ||
    options.maximumFrameBytes < 1_024 ||
    options.maximumFrameBytes > 1_048_576
  ) {
    throw new TypeError('Invalid monitoring HTTP stream options');
  }
  return Object.freeze(options);
}

function serializeFrameData(value: unknown, maximumFrameBytes: number): string {
  const serialized = JSON.stringify(value);
  if (new TextEncoder().encode(serialized).byteLength > maximumFrameBytes) {
    throw new MonitoringProtocolError();
  }
  return serialized;
}

async function writeSseWithDeadline(
  stream: SSEStreamingApi,
  message: Parameters<SSEStreamingApi['writeSSE']>[0],
  timeoutMs: number,
): Promise<void> {
  await writeWithDeadline(stream, stream.writeSSE(message), timeoutMs);
}

async function writeWithDeadline(
  stream: SSEStreamingApi,
  operation: Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolvePromise, rejectPromise) => {
    timeout = setTimeout(() => {
      stream.abort();
      rejectPromise(new MonitoringSlowConsumerError());
    }, timeoutMs);
  });
  try {
    await Promise.race([operation, deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function toMonitoringFault(
  error: unknown,
  interviewId: string,
  highWaterSequence: number,
  clock: ErrorResponseClock,
) {
  let reason: 'event_gap' | 'storage_unavailable' | 'server_shutdown' = 'storage_unavailable';
  let retryable = true;
  if (error instanceof MonitoringServerShutdownError) {
    reason = 'server_shutdown';
  } else if (
    error instanceof MonitoringProtocolError ||
    (error instanceof MonitoringStreamReadError &&
      isMonitoringResetRequired(error.applicationError))
  ) {
    reason = 'event_gap';
    retryable = false;
  }
  return monitoringSseFaultFrameSchema.parse({
    event: 'fault',
    data: {
      type: 'monitoring.stream_fault',
      interviewId,
      reason,
      highWaterSequence,
      retryable,
      occurredAt: safeClockNow(clock),
    },
  });
}

function safeClockNow(clock: ErrorResponseClock): string {
  try {
    const now = timestampSchema.safeParse(clock.now());
    if (now.success) {
      return now.data;
    }
  } catch {
    // Streaming faults remain serializable even if a custom clock fails.
  }
  return new Date().toISOString();
}

class MonitoringStreamReadError extends Error {
  public constructor(public readonly applicationError: ApplicationError) {
    super('Monitoring event stream read failed');
    this.name = 'MonitoringStreamReadError';
  }
}

class MonitoringProtocolError extends Error {
  public constructor() {
    super('Monitoring event stream protocol violation');
    this.name = 'MonitoringProtocolError';
  }
}

class MonitoringSlowConsumerError extends Error {
  public constructor() {
    super('Monitoring event stream consumer missed its write deadline');
    this.name = 'MonitoringSlowConsumerError';
  }
}

class MonitoringServerShutdownError extends Error {
  public constructor() {
    super('Monitoring event stream closed because the server is shutting down');
    this.name = 'MonitoringServerShutdownError';
  }
}
