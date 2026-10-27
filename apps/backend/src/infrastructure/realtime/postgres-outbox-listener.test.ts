import { describe, expect, it, vi } from 'vitest';

import {
  EVENT_OUTBOX_NOTIFICATION_CHANNEL,
  PostgresOutboxListenerCloseError,
  PostgresOutboxListenerStartError,
  PostgresOutboxNotificationListener,
  type PostgresNotificationClient,
  type PostgresNotificationHandlers,
} from './postgres-outbox-listener.js';

class FakeNotificationClient implements PostgresNotificationClient {
  public readonly calls: string[] = [];
  public connectFailure: unknown;
  public listenFailure: unknown;
  public endFailure: unknown;
  public connectGate: Promise<void> | undefined;
  public endGate: Promise<void> | undefined;
  public handlers: PostgresNotificationHandlers | undefined;
  public removedHandlers = 0;
  public endCalls = 0;
  public forceCloseCalls = 0;

  public installHandlers(handlers: PostgresNotificationHandlers): () => void {
    this.calls.push('install_handlers');
    this.handlers = handlers;
    return () => {
      this.removedHandlers += 1;
      if (this.handlers === handlers) this.handlers = undefined;
    };
  }

  public async connect(): Promise<void> {
    this.calls.push('connect');
    if (this.connectGate !== undefined) await this.connectGate;
    if (this.connectFailure !== undefined) throw this.connectFailure;
  }

  public async listen(channel: string): Promise<void> {
    this.calls.push(`listen:${channel}`);
    if (this.listenFailure !== undefined) throw this.listenFailure;
  }

  public async end(): Promise<void> {
    this.calls.push('end');
    this.endCalls += 1;
    if (this.endGate !== undefined) await this.endGate;
    if (this.endFailure !== undefined) throw this.endFailure;
  }

  public forceClose(): void {
    this.forceCloseCalls += 1;
  }

  public emitNotification(channel: string, payload?: string): void {
    this.handlers?.notification({ channel, payload });
  }

  public emitError(error: unknown): void {
    this.handlers?.error(error);
  }

  public emitEnd(): void {
    this.handlers?.end();
  }
}

describe('PostgresOutboxNotificationListener', () => {
  it('connects before LISTEN, starts idempotently, and publishes validated interview IDs', async () => {
    const client = new FakeNotificationClient();
    const signal = vi.fn();
    const listener = new PostgresOutboxNotificationListener(() => client, { signal });

    const firstStart = listener.start();
    const secondStart = listener.start();
    expect(secondStart).toBe(firstStart);
    await firstStart;
    client.emitNotification(EVENT_OUTBOX_NOTIFICATION_CHANNEL, 'interview-1');

    expect(client.calls.slice(0, 3)).toEqual([
      'install_handlers',
      'connect',
      `listen:${EVENT_OUTBOX_NOTIFICATION_CHANNEL}`,
    ]);
    expect(signal).toHaveBeenCalledOnce();
    expect(signal).toHaveBeenCalledWith('interview-1');
    await listener.close();
  });

  it('ignores wrong channels and absent, padded, JSON, or invalid payloads', async () => {
    const client = new FakeNotificationClient();
    const signal = vi.fn();
    const listener = new PostgresOutboxNotificationListener(() => client, { signal });
    await listener.start();

    client.emitNotification('another_channel', 'interview-1');
    client.emitNotification(EVENT_OUTBOX_NOTIFICATION_CHANNEL);
    for (const payload of [' interview-1', '{"interviewId":"interview-1"}', '', 'invalid id']) {
      client.emitNotification(EVENT_OUTBOX_NOTIFICATION_CHANNEL, payload);
    }

    expect(signal).not.toHaveBeenCalled();
    await listener.close();
  });

  it('contains publisher and diagnostics failures inside notification callbacks', async () => {
    const client = new FakeNotificationClient();
    const error = vi.fn(() => {
      throw new Error('diagnostics failed');
    });
    const listener = new PostgresOutboxNotificationListener(
      () => client,
      {
        signal: () => {
          throw new Error('publisher failed');
        },
      },
      { error },
    );
    await listener.start();

    expect(() => {
      client.emitNotification(EVENT_OUTBOX_NOTIFICATION_CHANNEL, 'interview-1');
    }).not.toThrow();
    expect(error).toHaveBeenCalledWith({ phase: 'publisher', errorClass: 'error' });
    await listener.close();
  });

  it.each(['connect', 'listen'] as const)(
    'recovers from %s startup failures with a fresh client',
    async (phase) => {
      const failedClient = new FakeNotificationClient();
      const recoveredClient = new FakeNotificationClient();
      const secret = 'postgresql://user:secret@database/interview';
      if (phase === 'connect') failedClient.connectFailure = new Error(secret);
      else failedClient.listenFailure = new Error(secret);
      const error = vi.fn();
      const clients = [failedClient, recoveredClient];
      const factory = vi.fn(() => {
        const client = clients.shift();
        if (client === undefined) throw new Error('unexpected reconnect');
        return client;
      });
      const delay = vi.fn(async () => undefined);
      const listener = new PostgresOutboxNotificationListener(
        factory,
        { signal: vi.fn() },
        { error },
        {
          initialDelayMs: 10,
          maximumDelayMs: 20,
          jitter: (delayMs) => delayMs,
          delay,
        },
      );

      await expect(listener.start()).resolves.toBeUndefined();
      expect(error).toHaveBeenCalledWith({ phase, errorClass: 'error' });
      expect(JSON.stringify(error.mock.calls)).not.toContain(secret);
      expect(factory).toHaveBeenCalledTimes(2);
      expect(failedClient.endCalls).toBe(1);
      expect(recoveredClient.calls).toContain(`listen:${EVENT_OUTBOX_NOTIFICATION_CHANNEL}`);
      expect(delay).toHaveBeenCalledWith(10, expect.any(AbortSignal));

      await listener.close();
      expect(recoveredClient.endCalls).toBe(1);
    },
  );

  it('recovers from runtime connection loss and suppresses notifications from the old client', async () => {
    const firstClient = new FakeNotificationClient();
    const recoveredClient = new FakeNotificationClient();
    const clients = [firstClient, recoveredClient];
    const signal = vi.fn();
    const error = vi.fn();
    const listener = new PostgresOutboxNotificationListener(
      () => {
        const client = clients.shift();
        if (client === undefined) throw new Error('unexpected reconnect');
        return client;
      },
      { signal },
      { error },
      { delay: async () => undefined },
    );
    await listener.start();

    const staleHandlers = firstClient.handlers;
    expect(() => firstClient.emitError(new Error('socket lost'))).not.toThrow();
    await vi.waitFor(() => {
      expect(recoveredClient.calls).toContain(`listen:${EVENT_OUTBOX_NOTIFICATION_CHANNEL}`);
    });
    staleHandlers?.notification({
      channel: EVENT_OUTBOX_NOTIFICATION_CHANNEL,
      payload: 'interview-1',
    });
    recoveredClient.emitNotification(EVENT_OUTBOX_NOTIFICATION_CHANNEL, 'interview-2');

    expect(error).toHaveBeenCalledWith({ phase: 'runtime', errorClass: 'error' });
    expect(signal).toHaveBeenCalledOnce();
    expect(signal).toHaveBeenCalledWith('interview-2');
    await listener.close();
  });

  it('does not create a replacement until the disconnected client has ended', async () => {
    let releaseEnd: (() => void) | undefined;
    const firstClient = new FakeNotificationClient();
    firstClient.endGate = new Promise<void>((resolvePromise) => {
      releaseEnd = resolvePromise;
    });
    const recoveredClient = new FakeNotificationClient();
    const factory = vi
      .fn<() => PostgresNotificationClient>()
      .mockReturnValueOnce(firstClient)
      .mockReturnValueOnce(recoveredClient);
    const listener = new PostgresOutboxNotificationListener(
      factory,
      { signal: vi.fn() },
      undefined,
      {
        delay: async () => undefined,
      },
    );
    await listener.start();

    firstClient.emitEnd();
    await vi.waitFor(() => expect(firstClient.endCalls).toBe(1));
    expect(factory).toHaveBeenCalledOnce();
    expect(recoveredClient.calls).toEqual([]);

    releaseEnd?.();
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(2));
    await listener.close();
  });

  it('force-closes cleanup at its deadline and reconnects without an unhandled late rejection', async () => {
    let rejectEnd: ((error: Error) => void) | undefined;
    const firstClient = new FakeNotificationClient();
    firstClient.endGate = new Promise<void>((_resolvePromise, rejectPromise) => {
      rejectEnd = rejectPromise;
    });
    const recoveredClient = new FakeNotificationClient();
    const factory = vi
      .fn<() => PostgresNotificationClient>()
      .mockReturnValueOnce(firstClient)
      .mockReturnValueOnce(recoveredClient);
    let expireFirstCleanup: (() => void) | undefined;
    let markCleanupStarted: (() => void) | undefined;
    const firstCleanupStarted = new Promise<void>((resolvePromise) => {
      markCleanupStarted = resolvePromise;
    });
    let cleanupDelayCalls = 0;
    const error = vi.fn();
    const listener = new PostgresOutboxNotificationListener(
      factory,
      { signal: vi.fn() },
      { error },
      {
        cleanupTimeoutMs: 25,
        delay: async () => undefined,
        cleanupDelay: (delayMs, signal) => {
          expect(delayMs).toBe(25);
          cleanupDelayCalls += 1;
          if (cleanupDelayCalls === 1) markCleanupStarted?.();
          return new Promise<void>((resolvePromise) => {
            const finish = (): void => {
              signal.removeEventListener('abort', finish);
              resolvePromise();
            };
            if (signal.aborted) {
              finish();
              return;
            }
            signal.addEventListener('abort', finish, { once: true });
            if (cleanupDelayCalls === 1) expireFirstCleanup = finish;
          });
        },
      },
    );
    await listener.start();

    firstClient.emitEnd();
    await firstCleanupStarted;
    expect(factory).toHaveBeenCalledOnce();
    expireFirstCleanup?.();

    await vi.waitFor(() => {
      expect(recoveredClient.calls).toContain(`listen:${EVENT_OUTBOX_NOTIFICATION_CHANNEL}`);
    });
    expect(firstClient.forceCloseCalls).toBe(1);
    expect(firstClient.removedHandlers).toBe(1);
    expect(error).toHaveBeenCalledWith({ phase: 'close', errorClass: 'error' });

    rejectEnd?.(new Error('late private cleanup failure'));
    await Promise.resolve();
    await listener.close();
  });

  it('uses bounded exponential retry delays', async () => {
    const clients = Array.from({ length: 4 }, () => new FakeNotificationClient());
    for (const client of clients.slice(0, 3)) client.connectFailure = new Error('offline');
    const pendingClients = [...clients];
    const observedDelays: number[] = [];
    const listener = new PostgresOutboxNotificationListener(
      () => {
        const client = pendingClients.shift();
        if (client === undefined) throw new Error('unexpected reconnect');
        return client;
      },
      { signal: vi.fn() },
      undefined,
      {
        initialDelayMs: 10,
        maximumDelayMs: 25,
        multiplier: 2,
        jitter: (delayMs) => delayMs,
        delay: async (delayMs) => {
          observedDelays.push(delayMs);
        },
      },
    );

    await listener.start();
    expect(observedDelays).toEqual([10, 20, 25]);
    await listener.close();
  });

  it('escalates retries across short-lived connections and resets only after stability', async () => {
    const clients = Array.from({ length: 4 }, () => new FakeNotificationClient());
    const pendingClients = [...clients];
    const observedDelays: number[] = [];
    let nowMs = 0;
    const listener = new PostgresOutboxNotificationListener(
      () => {
        const client = pendingClients.shift();
        if (client === undefined) throw new Error('unexpected reconnect');
        return client;
      },
      { signal: vi.fn() },
      undefined,
      {
        initialDelayMs: 10,
        maximumDelayMs: 40,
        multiplier: 2,
        stableConnectionMs: 100,
        jitter: (delayMs) => delayMs,
        delay: async (delayMs) => {
          observedDelays.push(delayMs);
        },
        now: () => nowMs,
      },
    );
    await listener.start();

    nowMs = 10;
    clients[0]?.emitEnd();
    await vi.waitFor(() => {
      expect(clients[1]?.calls).toContain(`listen:${EVENT_OUTBOX_NOTIFICATION_CHANNEL}`);
    });

    nowMs = 20;
    clients[1]?.emitEnd();
    await vi.waitFor(() => {
      expect(clients[2]?.calls).toContain(`listen:${EVENT_OUTBOX_NOTIFICATION_CHANNEL}`);
    });

    nowMs = 120;
    clients[2]?.emitEnd();
    await vi.waitFor(() => {
      expect(clients[3]?.calls).toContain(`listen:${EVENT_OUTBOX_NOTIFICATION_CHANNEL}`);
    });

    expect(observedDelays).toEqual([10, 20, 10]);
    await listener.close();
  });

  it('cancels a pending retry on shutdown without creating another client', async () => {
    const failedClient = new FakeNotificationClient();
    failedClient.connectFailure = new Error('offline');
    const factory = vi.fn(() => failedClient);
    let retryStarted: (() => void) | undefined;
    const retryStartedPromise = new Promise<void>((resolvePromise) => {
      retryStarted = resolvePromise;
    });
    const listener = new PostgresOutboxNotificationListener(
      factory,
      { signal: vi.fn() },
      undefined,
      {
        delay: async (_delayMs, signal) => {
          retryStarted?.();
          await new Promise<void>((resolvePromise) => {
            signal.addEventListener('abort', () => resolvePromise(), { once: true });
          });
        },
      },
    );

    const start = listener.start();
    await retryStartedPromise;
    const close = listener.close();

    await expect(start).rejects.toEqual(new PostgresOutboxListenerStartError('closed'));
    await expect(close).resolves.toBeUndefined();
    expect(factory).toHaveBeenCalledOnce();
    expect(failedClient.endCalls).toBe(1);
  });

  it('closes idempotently, removes handlers, and ignores late notifications', async () => {
    const client = new FakeNotificationClient();
    const signal = vi.fn();
    const listener = new PostgresOutboxNotificationListener(() => client, { signal });
    await listener.start();
    const handlers = client.handlers;

    const firstClose = listener.close();
    const secondClose = listener.close();
    expect(secondClose).toBe(firstClose);
    await firstClose;
    handlers?.notification({
      channel: EVENT_OUTBOX_NOTIFICATION_CHANNEL,
      payload: 'interview-1',
    });

    expect(client.endCalls).toBe(1);
    expect(client.removedHandlers).toBe(1);
    expect(signal).not.toHaveBeenCalled();
    await expect(listener.start()).rejects.toEqual(new PostgresOutboxListenerStartError('closed'));
  });

  it('does not connect after close-before-start and skips LISTEN in a close/connect race', async () => {
    const closedClient = new FakeNotificationClient();
    const closedListener = new PostgresOutboxNotificationListener(() => closedClient, {
      signal: vi.fn(),
    });
    await closedListener.close();
    await expect(closedListener.start()).rejects.toEqual(
      new PostgresOutboxListenerStartError('closed'),
    );
    expect(closedClient.calls).toEqual([]);

    let releaseConnect: (() => void) | undefined;
    const racingClient = new FakeNotificationClient();
    racingClient.connectGate = new Promise<void>((resolvePromise) => {
      releaseConnect = resolvePromise;
    });
    const racingListener = new PostgresOutboxNotificationListener(() => racingClient, {
      signal: vi.fn(),
    });
    const start = racingListener.start();
    const close = racingListener.close();
    releaseConnect?.();

    await expect(start).rejects.toEqual(new PostgresOutboxListenerStartError('closed'));
    await expect(close).resolves.toBeUndefined();
    expect(racingClient.calls).not.toContain(`listen:${EVENT_OUTBOX_NOTIFICATION_CHANNEL}`);
    expect(racingClient.endCalls).toBe(1);
  });

  it('sanitizes close failures and exposes a synchronous force-close escape hatch', async () => {
    const client = new FakeNotificationClient();
    client.endFailure = new Error('secret close detail');
    const error = vi.fn();
    const listener = new PostgresOutboxNotificationListener(
      () => client,
      { signal: vi.fn() },
      { error },
    );
    await listener.start();

    await expect(listener.close()).rejects.toBeInstanceOf(PostgresOutboxListenerCloseError);
    expect(error).toHaveBeenCalledWith({ phase: 'close', errorClass: 'error' });
    listener.forceClose();
    expect(client.forceCloseCalls).toBe(1);
  });
});
