import type { MonitoringEvent } from '@orgscience/contracts';

import type { ApplicationResult } from '../errors.js';
import {
  failure,
  success,
  type AppUnitOfWork,
  type RepositoryError,
} from '../persistence/index.js';
import type {
  MonitoringSignalCloseReason,
  MonitoringSignalHub,
  MonitoringSignalSubscription,
} from './realtime-signals.js';

export interface MonitoringEventStreamOptions {
  readonly pollIntervalMs: number;
  readonly replayPageSize: number;
  readonly maximumReplayEvents: number;
}

export type MonitoringEventStreamRead =
  | {
      readonly status: 'events';
      readonly events: readonly MonitoringEvent[];
      readonly highWaterSequence: number;
    }
  | {
      readonly status: 'heartbeat';
      readonly highWaterSequence: number;
    }
  | {
      readonly status: 'closed';
      readonly highWaterSequence: number;
      readonly reason: 'client_closed' | 'server_shutdown';
    };

export interface MonitoringEventStream {
  readonly interviewId: string;
  readonly initialAfterSequence: number;
  readonly initialHighWaterSequence: number;
  read(): Promise<ApplicationResult<MonitoringEventStreamRead>>;
  close(): void;
}

const defaultOptions: MonitoringEventStreamOptions = {
  pollIntervalMs: 1_000,
  replayPageSize: 250,
  maximumReplayEvents: 50_000,
};

export class OpenMonitoringEventStreamService {
  readonly #options: MonitoringEventStreamOptions;

  public constructor(
    private readonly unitOfWork: AppUnitOfWork,
    private readonly signals: MonitoringSignalHub,
    options: Partial<MonitoringEventStreamOptions> = {},
  ) {
    this.#options = validateOptions({ ...defaultOptions, ...options });
  }

  public async execute(input: {
    readonly interviewId: string;
    readonly afterSequence: number;
    readonly signal?: AbortSignal;
  }): Promise<ApplicationResult<MonitoringEventStream>> {
    if (!Number.isSafeInteger(input.afterSequence) || input.afterSequence < 0) {
      return failure({
        code: 'application_validation',
        field: 'afterSequence',
        message: 'The monitoring cursor must be a nonnegative safe integer',
      });
    }

    if (input.signal?.aborted === true) {
      return failure({ code: 'unavailable', retryable: true });
    }

    const subscription = this.signals.subscribe(input.interviewId);
    if (subscription === null) {
      return failure({ code: 'unavailable', retryable: true });
    }
    let requestAborted = false;
    const abortListener = (): void => {
      requestAborted = true;
      subscription.close('client_closed');
    };
    input.signal?.addEventListener('abort', abortListener, { once: true });
    const removeAbortListener = (): void => {
      input.signal?.removeEventListener('abort', abortListener);
    };
    const highWater = await this.unitOfWork.read(async ({ interviews, outbox }) => {
      const interview = await interviews.load(input.interviewId);
      return interview.ok ? outbox.highWater(input.interviewId) : interview;
    });
    if (!highWater.ok) {
      subscription.close();
      removeAbortListener();
      return highWater;
    }
    if (requestAborted) {
      subscription.close();
      removeAbortListener();
      return failure({ code: 'unavailable', retryable: true });
    }
    if (input.afterSequence > highWater.value) {
      subscription.close();
      removeAbortListener();
      return failure({
        code: 'monitoring_cursor_ahead',
        interviewId: input.interviewId,
        cursor: input.afterSequence,
        highWaterSequence: highWater.value,
      });
    }
    if (highWater.value - input.afterSequence > this.#options.maximumReplayEvents) {
      subscription.close();
      removeAbortListener();
      return failure({
        code: 'monitoring_cursor_stale',
        interviewId: input.interviewId,
        cursor: input.afterSequence,
        highWaterSequence: highWater.value,
        maximumReplayEvents: this.#options.maximumReplayEvents,
      });
    }

    return success(
      new MonitoringEventStreamSession(
        input.interviewId,
        input.afterSequence,
        highWater.value,
        this.unitOfWork,
        subscription,
        this.#options,
        () => requestAborted,
        removeAbortListener,
      ),
    );
  }
}

class MonitoringEventStreamSession implements MonitoringEventStream {
  public readonly interviewId: string;
  public readonly initialAfterSequence: number;
  public readonly initialHighWaterSequence: number;

  readonly #unitOfWork: AppUnitOfWork;
  readonly #subscription: MonitoringSignalSubscription;
  readonly #options: MonitoringEventStreamOptions;
  #cursor: number;
  #highWaterSequence: number;
  #closeReason: MonitoringSignalCloseReason | null = null;
  #readInProgress = false;
  readonly #wasRequestAborted: () => boolean;
  readonly #removeAbortListener: () => void;

  public constructor(
    interviewId: string,
    afterSequence: number,
    highWaterSequence: number,
    unitOfWork: AppUnitOfWork,
    subscription: MonitoringSignalSubscription,
    options: MonitoringEventStreamOptions,
    wasRequestAborted: () => boolean,
    removeAbortListener: () => void,
  ) {
    this.interviewId = interviewId;
    this.initialAfterSequence = afterSequence;
    this.initialHighWaterSequence = highWaterSequence;
    this.#cursor = afterSequence;
    this.#highWaterSequence = highWaterSequence;
    this.#unitOfWork = unitOfWork;
    this.#subscription = subscription;
    this.#options = options;
    this.#wasRequestAborted = wasRequestAborted;
    this.#removeAbortListener = removeAbortListener;
  }

  public async read(): Promise<ApplicationResult<MonitoringEventStreamRead>> {
    const closeReason = this.observeCloseReason();
    if (closeReason !== null) return success(this.finishClose(closeReason));
    if (this.#readInProgress) {
      return failure({
        code: 'application_invariant',
        resource: 'monitoring_stream',
        id: this.interviewId,
        message: 'A monitoring stream permits only one active read',
      });
    }
    this.#readInProgress = true;
    try {
      if (this.#cursor < this.#highWaterSequence) return await this.replayPage();

      const wake = await this.#subscription.wait(this.#options.pollIntervalMs);
      const wakeCloseReason = this.observeCloseReason();
      if (wake === 'closed' || wakeCloseReason !== null) {
        return success(this.finishClose(wakeCloseReason ?? 'client_closed'));
      }

      const highWater = await this.#unitOfWork.read(({ outbox }) =>
        outbox.highWater(this.interviewId),
      );
      const postReadCloseReason = this.observeCloseReason();
      if (postReadCloseReason !== null) {
        return success(this.finishClose(postReadCloseReason));
      }
      if (!highWater.ok) return highWater;
      if (this.#cursor > highWater.value) return this.cursorAhead(highWater.value);
      if (highWater.value - this.#cursor > this.#options.maximumReplayEvents) {
        return failure({
          code: 'monitoring_cursor_stale',
          interviewId: this.interviewId,
          cursor: this.#cursor,
          highWaterSequence: highWater.value,
          maximumReplayEvents: this.#options.maximumReplayEvents,
        });
      }
      this.#highWaterSequence = highWater.value;
      return this.#cursor < this.#highWaterSequence
        ? await this.replayPage()
        : success({ status: 'heartbeat', highWaterSequence: this.#highWaterSequence });
    } finally {
      this.#readInProgress = false;
    }
  }

  public close(): void {
    this.finishClose('client_closed');
  }

  private async replayPage(): Promise<ApplicationResult<MonitoringEventStreamRead>> {
    const initialCloseReason = this.observeCloseReason();
    if (initialCloseReason !== null) return success(this.finishClose(initialCloseReason));
    const replay = await this.#unitOfWork.read(({ outbox }) =>
      outbox.replay(this.interviewId, {
        afterSequence: this.#cursor,
        throughSequence: this.#highWaterSequence,
        limit: this.#options.replayPageSize,
      }),
    );
    const postReplayCloseReason = this.observeCloseReason();
    if (postReplayCloseReason !== null) return success(this.finishClose(postReplayCloseReason));
    if (!replay.ok) return this.normalizeReplayError(replay.error);

    const events = replay.value.events;
    const last = events.at(-1);
    if (last === undefined) {
      return failure({
        code: 'corrupt_data',
        resource: 'outbox_event',
        id: this.interviewId,
        reason: 'Replay returned no event below the captured high-water mark',
      });
    }
    this.#cursor = last.sequenceNumber;
    return success({
      status: 'events',
      events,
      highWaterSequence: this.#highWaterSequence,
    });
  }

  private normalizeReplayError(
    error: RepositoryError,
  ): ApplicationResult<MonitoringEventStreamRead> {
    return error.code === 'sequence_conflict' ? this.cursorAhead(error.expected) : failure(error);
  }

  private cursorAhead(highWaterSequence: number): ApplicationResult<MonitoringEventStreamRead> {
    return failure({
      code: 'monitoring_cursor_ahead',
      interviewId: this.interviewId,
      cursor: this.#cursor,
      highWaterSequence,
    });
  }

  private closedRead(reason: 'client_closed' | 'server_shutdown'): MonitoringEventStreamRead {
    return { status: 'closed', highWaterSequence: this.#highWaterSequence, reason };
  }

  private observeCloseReason(): MonitoringSignalCloseReason | null {
    if (this.#closeReason !== null) return this.#closeReason;
    if (this.#wasRequestAborted()) return 'client_closed';
    return this.#subscription.getCloseReason();
  }

  private finishClose(reason: MonitoringSignalCloseReason): MonitoringEventStreamRead {
    if (this.#closeReason === null) this.#closeReason = reason;
    this.#removeAbortListener();
    this.#subscription.close(this.#closeReason);
    return this.closedRead(this.#closeReason);
  }
}

function validateOptions(options: MonitoringEventStreamOptions): MonitoringEventStreamOptions {
  if (
    !Number.isSafeInteger(options.pollIntervalMs) ||
    options.pollIntervalMs < 10 ||
    options.pollIntervalMs > 60_000 ||
    !Number.isSafeInteger(options.replayPageSize) ||
    options.replayPageSize < 1 ||
    options.replayPageSize > 1_000 ||
    !Number.isSafeInteger(options.maximumReplayEvents) ||
    options.maximumReplayEvents < options.replayPageSize ||
    options.maximumReplayEvents > 1_000_000
  ) {
    throw new TypeError('Invalid monitoring event stream options');
  }
  return Object.freeze(options);
}
