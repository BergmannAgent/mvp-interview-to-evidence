import { Socket } from 'node:net';
import { performance } from 'node:perf_hooks';

import { idSchema } from '@orgscience/contracts';
import { Client, type Notification } from 'pg';

import type { DatabaseConfig } from '../database/config.js';
import type { RealtimeSignalPublisher } from './signal-hub.js';

export const EVENT_OUTBOX_NOTIFICATION_CHANNEL = 'orgscience_event_outbox';

export interface PostgresOutboxListenerDiagnostics {
  error(input: {
    readonly phase: 'connect' | 'listen' | 'runtime' | 'publisher' | 'close';
    readonly errorClass: 'error' | 'non_error';
  }): void;
}

export interface PostgresNotificationHandlers {
  readonly error: (error: unknown) => void;
  readonly notification: (notification: {
    readonly channel: string;
    readonly payload?: string | undefined;
  }) => void;
  readonly end: () => void;
}

export interface PostgresNotificationClient {
  installHandlers(handlers: PostgresNotificationHandlers): () => void;
  connect(): Promise<void>;
  listen(channel: string): Promise<void>;
  end(): Promise<void>;
  forceClose(): void;
}

export type PostgresNotificationClientFactory = () => PostgresNotificationClient;

export interface PostgresOutboxListenerRetryOptions {
  readonly initialDelayMs?: number;
  readonly maximumDelayMs?: number;
  readonly multiplier?: number;
  readonly cleanupTimeoutMs?: number;
  readonly stableConnectionMs?: number;
  readonly jitter?: (delayMs: number, retryNumber: number) => number;
  readonly delay?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  readonly cleanupDelay?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  readonly now?: () => number;
}

export class PostgresOutboxListenerStartError extends Error {
  public constructor(public readonly phase: 'connect' | 'listen' | 'closed') {
    super('The PostgreSQL outbox notification listener could not start');
    this.name = 'PostgresOutboxListenerStartError';
  }
}

export class PostgresOutboxListenerCloseError extends Error {
  public constructor() {
    super('The PostgreSQL outbox notification listener could not close');
    this.name = 'PostgresOutboxListenerCloseError';
  }
}

export class PostgresOutboxNotificationListener {
  #startPromise: Promise<void> | undefined;
  #resolveStart: (() => void) | undefined;
  #rejectStart: ((error: PostgresOutboxListenerStartError) => void) | undefined;
  #startSettled = false;
  #supervisorPromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;
  #currentAttempt: ConnectionAttempt | undefined;
  #latestClient: PostgresNotificationClient | undefined;
  readonly #stopController = new AbortController();
  readonly #retry: RequiredRetryOptions;
  #closing = false;
  #forceCloseStarted = false;

  public constructor(
    private readonly clientFactory: PostgresNotificationClientFactory,
    private readonly publisher: RealtimeSignalPublisher,
    private readonly diagnostics: PostgresOutboxListenerDiagnostics = silentDiagnostics,
    retryOptions: PostgresOutboxListenerRetryOptions = {},
  ) {
    this.#retry = normalizeRetryOptions(retryOptions);
  }

  public start(): Promise<void> {
    if (this.#closing) return Promise.reject(new PostgresOutboxListenerStartError('closed'));
    if (this.#startPromise === undefined) {
      this.#startPromise = new Promise<void>((resolvePromise, rejectPromise) => {
        this.#resolveStart = resolvePromise;
        this.#rejectStart = rejectPromise;
      });
      this.#supervisorPromise = this.supervise().catch((error: unknown) => {
        if (!this.#closing) this.report('runtime', error);
        this.rejectStart(new PostgresOutboxListenerStartError('connect'));
      });
    }
    return this.#startPromise;
  }

  public close(): Promise<void> {
    this.#closing = true;
    this.#stopController.abort();
    this.rejectStart(new PostgresOutboxListenerStartError('closed'));
    this.disconnect(this.#currentAttempt);
    this.#closePromise ??= this.closeOnce();
    return this.#closePromise;
  }

  public forceClose(): void {
    if (this.#forceCloseStarted) return;
    this.#forceCloseStarted = true;
    this.#closing = true;
    this.#stopController.abort();
    this.rejectStart(new PostgresOutboxListenerStartError('closed'));
    const attempt = this.#currentAttempt;
    this.disconnect(attempt);
    this.removeHandlers(attempt);
    try {
      (attempt?.client ?? this.#latestClient)?.forceClose();
    } catch {
      // The absolute process shutdown deadline takes precedence over cleanup diagnostics.
    }
  }

  private async supervise(): Promise<void> {
    let retryNumber = 0;
    while (!this.#closing) {
      const attempt = await this.openAttempt();
      if (attempt === undefined) {
        if (this.#closing) break;
        retryNumber += 1;
        if (!(await this.waitBeforeRetry(retryNumber))) break;
        continue;
      }

      this.resolveStart();
      await attempt.disconnected;
      const connectionWasStable = this.connectionWasStable(attempt);
      await this.cleanup(attempt);
      if (this.#closing) break;
      retryNumber = connectionWasStable ? 1 : retryNumber + 1;
      if (!(await this.waitBeforeRetry(retryNumber))) break;
    }
    this.rejectStart(new PostgresOutboxListenerStartError('closed'));
  }

  private async openAttempt(): Promise<ConnectionAttempt | undefined> {
    let client: PostgresNotificationClient;
    try {
      client = this.clientFactory();
    } catch (error: unknown) {
      if (!this.#closing) this.report('connect', error);
      return undefined;
    }

    const attempt = createConnectionAttempt(client);
    this.#latestClient = client;
    this.#currentAttempt = attempt;
    let phase: 'connect' | 'listen' = 'connect';
    try {
      attempt.removeHandlers = client.installHandlers({
        error: (error) => {
          if (!this.disconnect(attempt) || this.#closing) return;
          this.report('runtime', error);
        },
        notification: (notification) => {
          this.handleNotification(attempt, notification);
        },
        end: () => {
          this.disconnect(attempt);
        },
      });
      await client.connect();
      if (this.#closing) {
        await this.cleanup(attempt);
        return undefined;
      }
      phase = 'listen';
      await client.listen(EVENT_OUTBOX_NOTIFICATION_CHANNEL);
      if (this.#closing) {
        await this.cleanup(attempt);
        return undefined;
      }
      attempt.activeSinceMs = this.readRetryClock();
      attempt.active = true;
      return attempt;
    } catch (error: unknown) {
      if (!this.#closing) this.report(phase, error);
      this.disconnect(attempt);
      await this.cleanup(attempt);
      return undefined;
    }
  }

  private async closeOnce(): Promise<void> {
    const attempt = this.#currentAttempt;
    if (attempt !== undefined) await this.cleanup(attempt);
    await this.#supervisorPromise;
    if (attempt?.endFailed === true) throw new PostgresOutboxListenerCloseError();
  }

  private handleNotification(
    attempt: ConnectionAttempt,
    notification: {
      readonly channel: string;
      readonly payload?: string | undefined;
    },
  ): void {
    if (
      this.#closing ||
      this.#currentAttempt !== attempt ||
      !attempt.active ||
      notification.channel !== EVENT_OUTBOX_NOTIFICATION_CHANNEL
    ) {
      return;
    }
    const interviewId = idSchema.safeParse(notification.payload);
    if (!interviewId.success) return;
    try {
      this.publisher.signal(interviewId.data);
    } catch (error: unknown) {
      this.report('publisher', error);
    }
  }

  private disconnect(attempt: ConnectionAttempt | undefined): boolean {
    if (attempt === undefined || attempt.disconnectStarted) return false;
    attempt.disconnectStarted = true;
    attempt.active = false;
    attempt.resolveDisconnected();
    return true;
  }

  private cleanup(attempt: ConnectionAttempt): Promise<void> {
    attempt.cleanupPromise ??= this.cleanupOnce(attempt);
    return attempt.cleanupPromise;
  }

  private async cleanupOnce(attempt: ConnectionAttempt): Promise<void> {
    this.disconnect(attempt);
    try {
      const outcome = await this.endBeforeCleanupDeadline(attempt.client);
      if (outcome.status === 'failed') {
        attempt.endFailed = true;
        this.report('close', outcome.error);
      } else if (outcome.status === 'timed_out' || outcome.status === 'deadline_failed') {
        attempt.endFailed = true;
        this.report(
          'close',
          outcome.status === 'deadline_failed'
            ? outcome.error
            : new PostgresOutboxListenerCleanupTimeoutError(),
        );
        this.removeHandlers(attempt);
        try {
          attempt.client.forceClose();
        } catch (error: unknown) {
          this.report('close', error);
        }
      }
    } finally {
      this.removeHandlers(attempt);
      if (this.#currentAttempt === attempt) this.#currentAttempt = undefined;
    }
  }

  private async endBeforeCleanupDeadline(
    client: PostgresNotificationClient,
  ): Promise<CleanupOutcome> {
    const deadlineController = new AbortController();
    const ended = Promise.resolve()
      .then(() => client.end())
      .then<CleanupOutcome, CleanupOutcome>(
        () => ({ status: 'ended' }),
        (error: unknown) => ({ status: 'failed', error }),
      );
    const deadline = Promise.resolve()
      .then(() => this.#retry.cleanupDelay(this.#retry.cleanupTimeoutMs, deadlineController.signal))
      .then<CleanupOutcome, CleanupOutcome>(
        () => ({ status: 'timed_out' }),
        (error: unknown) => ({ status: 'deadline_failed', error }),
      );

    const outcome = await Promise.race([ended, deadline]);
    deadlineController.abort();
    return outcome;
  }

  private removeHandlers(attempt: ConnectionAttempt | undefined): void {
    if (attempt === undefined || attempt.handlersRemoved) return;
    attempt.handlersRemoved = true;
    const removeHandlers = attempt.removeHandlers;
    attempt.removeHandlers = undefined;
    try {
      removeHandlers?.();
    } catch {
      // Handler cleanup is best-effort after the client has ended.
    }
  }

  private async waitBeforeRetry(retryNumber: number): Promise<boolean> {
    if (this.#closing) return false;
    const exponentialDelay = Math.min(
      this.#retry.maximumDelayMs,
      this.#retry.initialDelayMs * this.#retry.multiplier ** (retryNumber - 1),
    );
    let delayMs = exponentialDelay;
    try {
      delayMs = this.#retry.jitter(exponentialDelay, retryNumber);
    } catch (error: unknown) {
      this.report('runtime', error);
    }
    delayMs = Math.min(this.#retry.maximumDelayMs, Math.max(0, Math.round(delayMs)));
    try {
      await this.#retry.delay(delayMs, this.#stopController.signal);
    } catch (error: unknown) {
      if (!this.#closing) {
        this.report('runtime', error);
        await abortableDelay(delayMs, this.#stopController.signal);
      }
    }
    return !this.#closing;
  }

  private connectionWasStable(attempt: ConnectionAttempt): boolean {
    if (attempt.activeSinceMs === undefined) return false;
    return this.readRetryClock() - attempt.activeSinceMs >= this.#retry.stableConnectionMs;
  }

  private readRetryClock(): number {
    try {
      const now = this.#retry.now();
      if (Number.isFinite(now)) return now;
      this.report('runtime', new TypeError('Realtime retry clock returned a non-finite value'));
    } catch (error: unknown) {
      this.report('runtime', error);
    }
    return performance.now();
  }

  private resolveStart(): void {
    if (this.#startSettled) return;
    this.#startSettled = true;
    this.#resolveStart?.();
    this.clearStartSettlementHandlers();
  }

  private rejectStart(error: PostgresOutboxListenerStartError): void {
    if (this.#startSettled || this.#startPromise === undefined) return;
    this.#startSettled = true;
    this.#rejectStart?.(error);
    this.clearStartSettlementHandlers();
  }

  private clearStartSettlementHandlers(): void {
    this.#resolveStart = undefined;
    this.#rejectStart = undefined;
  }

  private report(
    phase: Parameters<PostgresOutboxListenerDiagnostics['error']>[0]['phase'],
    error: unknown,
  ): void {
    try {
      this.diagnostics.error({
        phase,
        errorClass: error instanceof Error ? 'error' : 'non_error',
      });
    } catch {
      // Diagnostics must never interrupt the durable polling fallback.
    }
  }
}

export function createPostgresOutboxNotificationListener(
  config: DatabaseConfig,
  publisher: RealtimeSignalPublisher,
  diagnostics: PostgresOutboxListenerDiagnostics = silentDiagnostics,
  retryOptions: PostgresOutboxListenerRetryOptions = {},
): PostgresOutboxNotificationListener {
  return new PostgresOutboxNotificationListener(
    () => new NodePostgresNotificationClient(config),
    publisher,
    diagnostics,
    retryOptions,
  );
}

class NodePostgresNotificationClient implements PostgresNotificationClient {
  readonly #socket = new Socket();
  readonly #client: Client;
  readonly #queryTimeoutMs: number;

  public constructor(config: DatabaseConfig) {
    this.#queryTimeoutMs = config.connectionTimeoutMs;
    this.#client = new Client({
      application_name: `${config.applicationName}-realtime-listener`.slice(0, 100),
      connectionString: config.connectionString,
      connectionTimeoutMillis: config.connectionTimeoutMs,
      keepAlive: true,
      stream: () => this.#socket,
    });
  }

  public installHandlers(handlers: PostgresNotificationHandlers): () => void {
    const notificationHandler = (notification: Notification): void => {
      handlers.notification(notification);
    };
    this.#client.on('error', handlers.error);
    this.#client.on('notification', notificationHandler);
    this.#client.on('end', handlers.end);
    return () => {
      this.#client.removeListener('error', handlers.error);
      this.#client.removeListener('notification', notificationHandler);
      this.#client.removeListener('end', handlers.end);
    };
  }

  public async connect(): Promise<void> {
    await this.#client.connect();
  }

  public async listen(channel: string): Promise<void> {
    if (channel !== EVENT_OUTBOX_NOTIFICATION_CHANNEL) {
      throw new TypeError('Unsupported PostgreSQL notification channel');
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.#client.query(`LISTEN "${EVENT_OUTBOX_NOTIFICATION_CHANNEL}"`),
        new Promise<never>((_resolvePromise, rejectPromise) => {
          timeout = setTimeout(() => {
            this.#socket.destroy();
            rejectPromise(new Error('PostgreSQL LISTEN deadline exceeded'));
          }, this.#queryTimeoutMs);
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  public async end(): Promise<void> {
    await this.#client.end();
  }

  public forceClose(): void {
    this.#socket.destroy();
    void this.#client.end().catch(() => undefined);
  }
}

const silentDiagnostics: PostgresOutboxListenerDiagnostics = {
  error: () => undefined,
};

interface ConnectionAttempt {
  readonly client: PostgresNotificationClient;
  readonly disconnected: Promise<void>;
  readonly resolveDisconnected: () => void;
  active: boolean;
  activeSinceMs: number | undefined;
  disconnectStarted: boolean;
  endFailed: boolean;
  handlersRemoved: boolean;
  removeHandlers: (() => void) | undefined;
  cleanupPromise: Promise<void> | undefined;
}

interface RequiredRetryOptions {
  readonly initialDelayMs: number;
  readonly maximumDelayMs: number;
  readonly multiplier: number;
  readonly cleanupTimeoutMs: number;
  readonly stableConnectionMs: number;
  readonly jitter: (delayMs: number, retryNumber: number) => number;
  readonly delay: (delayMs: number, signal: AbortSignal) => Promise<void>;
  readonly cleanupDelay: (delayMs: number, signal: AbortSignal) => Promise<void>;
  readonly now: () => number;
}

type CleanupOutcome =
  | { readonly status: 'ended' }
  | { readonly status: 'failed'; readonly error: unknown }
  | { readonly status: 'timed_out' }
  | { readonly status: 'deadline_failed'; readonly error: unknown };

function createConnectionAttempt(client: PostgresNotificationClient): ConnectionAttempt {
  let resolveDisconnected: (() => void) | undefined;
  const disconnected = new Promise<void>((resolvePromise) => {
    resolveDisconnected = resolvePromise;
  });
  return {
    client,
    disconnected,
    resolveDisconnected: () => resolveDisconnected?.(),
    active: false,
    activeSinceMs: undefined,
    disconnectStarted: false,
    endFailed: false,
    handlersRemoved: false,
    removeHandlers: undefined,
    cleanupPromise: undefined,
  };
}

function normalizeRetryOptions(options: PostgresOutboxListenerRetryOptions): RequiredRetryOptions {
  const initialDelayMs = options.initialDelayMs ?? 250;
  const maximumDelayMs = options.maximumDelayMs ?? 30_000;
  const multiplier = options.multiplier ?? 2;
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? 5_000;
  const stableConnectionMs = options.stableConnectionMs ?? 30_000;
  if (!Number.isFinite(initialDelayMs) || initialDelayMs < 0) {
    throw new TypeError('initialDelayMs must be a non-negative finite number');
  }
  if (!Number.isFinite(maximumDelayMs) || maximumDelayMs < initialDelayMs) {
    throw new TypeError('maximumDelayMs must be finite and at least initialDelayMs');
  }
  if (!Number.isFinite(multiplier) || multiplier < 1) {
    throw new TypeError('multiplier must be a finite number of at least one');
  }
  if (!Number.isFinite(cleanupTimeoutMs) || cleanupTimeoutMs < 1) {
    throw new TypeError('cleanupTimeoutMs must be a positive finite number');
  }
  if (!Number.isFinite(stableConnectionMs) || stableConnectionMs < 0) {
    throw new TypeError('stableConnectionMs must be a non-negative finite number');
  }
  return {
    initialDelayMs,
    maximumDelayMs,
    multiplier,
    cleanupTimeoutMs,
    stableConnectionMs,
    jitter: options.jitter ?? defaultRetryJitter,
    delay: options.delay ?? abortableDelay,
    cleanupDelay: options.cleanupDelay ?? abortableDelay,
    now: options.now ?? (() => performance.now()),
  };
}

function defaultRetryJitter(delayMs: number): number {
  const halfDelay = delayMs / 2;
  return halfDelay + Math.random() * halfDelay;
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || delayMs === 0) return Promise.resolve();
  return new Promise<void>((resolvePromise) => {
    const timeout = setTimeout(finish, delayMs);
    signal.addEventListener('abort', finish, { once: true });

    function finish(): void {
      clearTimeout(timeout);
      signal.removeEventListener('abort', finish);
      resolvePromise();
    }
  });
}

class PostgresOutboxListenerCleanupTimeoutError extends Error {
  public constructor() {
    super('PostgreSQL notification client cleanup deadline exceeded');
    this.name = 'PostgresOutboxListenerCleanupTimeoutError';
  }
}
