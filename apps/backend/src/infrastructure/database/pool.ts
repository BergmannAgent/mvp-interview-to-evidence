import { Socket } from 'node:net';

import { Client, Pool, type ClientConfig } from 'pg';

import type { DatabaseConfig } from './config.js';

export interface ClosablePool {
  end(): Promise<void>;
}

interface ForceReleasableDatabaseClient {
  forceRelease(): void;
}

export interface DatabasePoolDiagnostics {
  clientError(input: {
    readonly database: string;
    readonly errorClass: 'error' | 'non_error';
  }): void;
}

export interface DatabaseClientTracker {
  forceCloseAll(): void;
}

export class ManagedDatabasePool<TPool extends ClosablePool> {
  public readonly pool: TPool;

  readonly #redactedConnectionString: string;
  readonly #clientTracker: DatabaseClientTracker;
  #closePromise: Promise<void> | undefined;
  #closed = false;
  #forceCloseStarted = false;

  public constructor(
    pool: TPool,
    redactedConnectionString: string,
    clientTracker: DatabaseClientTracker = silentClientTracker,
  ) {
    this.pool = pool;
    this.#redactedConnectionString = redactedConnectionString;
    this.#clientTracker = clientTracker;
  }

  public get redactedConnectionString(): string {
    return this.#redactedConnectionString;
  }

  public get closed(): boolean {
    return this.#closed;
  }

  public close(): Promise<void> {
    this.#closePromise ??= this.pool.end().then(() => {
      this.#closed = true;
    });
    return this.#closePromise;
  }

  public forceClose(): void {
    if (this.#forceCloseStarted) return;
    this.#forceCloseStarted = true;

    try {
      void this.close().catch(() => undefined);
    } catch {
      // Forced shutdown is best-effort and must not replace the process deadline.
    }
    this.#clientTracker.forceCloseAll();
  }
}

export function createDatabasePool(
  config: DatabaseConfig,
  diagnostics: DatabasePoolDiagnostics = silentPoolDiagnostics,
): ManagedDatabasePool<Pool> {
  const reportClientError = createClientErrorReporter(config, diagnostics);
  const clientTracker = new TrackedDatabaseClients(reportClientError);
  const TrackedClient = createTrackedClientConstructor(clientTracker);
  const pool = new Pool({
    application_name: config.applicationName,
    connectionString: config.connectionString,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    idleTimeoutMillis: config.idleTimeoutMs,
    keepAlive: true,
    max: config.maximumPoolSize,
    Client: TrackedClient,
    stream: () => clientTracker.createSocket(),
  });

  pool.on('error', (error) => {
    reportClientError(error);
  });

  return new ManagedDatabasePool(pool, config.redactedConnectionString, clientTracker);
}

const silentPoolDiagnostics: DatabasePoolDiagnostics = {
  clientError: () => undefined,
};

const silentClientTracker: DatabaseClientTracker = {
  forceCloseAll: () => undefined,
};

class TrackedDatabaseClients implements DatabaseClientTracker {
  readonly #clients = new Set<ForceReleasableDatabaseClient>();
  readonly #sockets = new Set<Socket>();
  readonly #reportClientError: (error: unknown) => void;
  #forceCloseStarted = false;

  public constructor(reportClientError: (error: unknown) => void) {
    this.#reportClientError = reportClientError;
  }

  public register(client: Client & ForceReleasableDatabaseClient): void {
    this.#clients.add(client);
    client.on('error', this.#reportClientError);
    client.once('end', () => {
      this.#clients.delete(client);
      client.removeListener('error', this.#reportClientError);
    });
  }

  public createSocket(): Socket {
    const socket = new Socket();
    this.#sockets.add(socket);
    socket.once('close', () => this.#sockets.delete(socket));
    if (this.#forceCloseStarted) {
      queueMicrotask(() => socket.destroy());
    }
    return socket;
  }

  public forceCloseAll(): void {
    this.#forceCloseStarted = true;
    for (const socket of this.#sockets) socket.destroy();
    for (const client of this.#clients) client.forceRelease();
  }
}

function createTrackedClientConstructor(tracker: TrackedDatabaseClients): new () => Client {
  return class TrackedClient extends Client {
    readonly #safeRelease = (error?: Error | boolean): void => {
      if (!this.#checkedOut) return;
      this.#checkedOut = false;
      const release = this.#poolRelease;
      this.#poolRelease = undefined;
      release?.(error);
    };
    #poolRelease: ((error?: Error | boolean) => void) | undefined;
    #checkedOut = false;

    public constructor(config?: string | ClientConfig) {
      super(config);
      tracker.register(this);
    }

    public get release(): (error?: Error | boolean) => void {
      return this.#safeRelease;
    }

    public set release(release: (error?: Error | boolean) => void) {
      this.#poolRelease = release;
      this.#checkedOut = true;
    }

    public forceRelease(): void {
      this.#safeRelease(true);
    }
  };
}

function createClientErrorReporter(
  config: DatabaseConfig,
  diagnostics: DatabasePoolDiagnostics,
): (error: unknown) => void {
  const reportedErrors = new WeakSet<object>();
  return (error: unknown): void => {
    if (typeof error === 'object' && error !== null) {
      if (reportedErrors.has(error)) return;
      reportedErrors.add(error);
    }
    try {
      diagnostics.clientError({
        database: config.redactedConnectionString,
        errorClass: error instanceof Error ? 'error' : 'non_error',
      });
    } catch {
      // Diagnostics must not turn a recoverable database-client failure into a process crash.
    }
  };
}
