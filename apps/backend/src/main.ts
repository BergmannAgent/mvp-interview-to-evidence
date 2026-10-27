import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

import { serve, type ServerType } from '@hono/node-server';

import { DatabaseConfigurationError } from './infrastructure/database/config.js';
import {
  createBackendComposition,
  type BackendComposition,
  type RuntimeDiagnostics,
} from './runtime/composition.js';
import { HttpRuntimeConfigurationError } from './runtime/http-config.js';
import { ModelRuntimeConfigurationError } from './runtime/model-config.js';
import { RealtimeRuntimeConfigurationError } from './runtime/realtime-config.js';

export interface RuntimeLogger {
  info(entry: Readonly<Record<string, unknown>>): void;
  error(entry: Readonly<Record<string, unknown>>): void;
}

export interface RunningBackend {
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

export interface ShutdownResources {
  beginShutdown?(): void;
  close(): Promise<void>;
  forceClose(): void;
}

export class BackendShutdownDeadlineError extends Error {
  public constructor() {
    super('Backend shutdown deadline exceeded');
    this.name = 'BackendShutdownDeadlineError';
  }
}

export async function startBackend(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  logger: RuntimeLogger = processLogger,
): Promise<RunningBackend> {
  const diagnostics: RuntimeDiagnostics = {
    databasePoolError: ({ database, errorClass }) => {
      logger.error({ event: 'backend.database_client_error', database, errorClass });
    },
    unhandledHttpError: ({ requestId, method, path, errorClass }) => {
      logger.error({ event: 'backend.http_unhandled_error', requestId, method, path, errorClass });
    },
    realtimeListenerError: ({ phase, errorClass }) => {
      logger.error({ event: 'backend.realtime_listener_error', phase, errorClass });
    },
  };
  const composition = createBackendComposition(environment, diagnostics);

  let listening: { readonly server: ServerType; readonly port: number };
  try {
    listening = await listen(composition);
  } catch (error: unknown) {
    await composition.close();
    throw error;
  }

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= closeRuntime(
      listening.server,
      composition,
      composition.http.shutdownTimeoutMs,
    );
    return closePromise;
  };
  listening.server.on('error', (error: unknown) => {
    logger.error({ event: 'backend.server_error', errorClass: classifyRuntimeError(error) });
  });
  logger.info({
    event: 'backend.listening',
    host: composition.http.host,
    port: listening.port,
  });

  return {
    host: composition.http.host,
    port: listening.port,
    close,
  };
}

export function classifyStartupFailure(error: unknown): string {
  if (error instanceof DatabaseConfigurationError) {
    return 'database_configuration_invalid';
  }
  if (error instanceof HttpRuntimeConfigurationError) {
    return 'http_configuration_invalid';
  }
  if (error instanceof RealtimeRuntimeConfigurationError) {
    return 'realtime_configuration_invalid';
  }
  if (error instanceof ModelRuntimeConfigurationError) {
    return 'model_configuration_invalid';
  }
  return 'backend_start_failed';
}

async function listen(
  composition: BackendComposition,
): Promise<{ readonly server: ServerType; readonly port: number }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const onError = (error: unknown): void => {
      rejectPromise(error);
    };
    const server = serve(
      {
        fetch: composition.app.fetch,
        hostname: composition.http.host,
        port: composition.http.port,
      },
      (address) => {
        server.off('error', onError);
        resolvePromise({ server, port: address.port });
      },
    );
    server.once('error', onError);
  });
}

export async function closeRuntime(
  server: ServerType,
  resources: ShutdownResources,
  timeoutMs: number,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  let shutdownError: Error | undefined;
  try {
    resources.beginShutdown?.();
  } catch {
    shutdownError = new Error('Backend resource shutdown initialization failed');
  }
  const serverShutdown = await settleBeforeDeadline(() => requestServerClose(server), deadline);
  if (serverShutdown === 'deadline_exceeded') {
    forceRuntimeClose(server, resources);
    throw new BackendShutdownDeadlineError();
  }
  if (serverShutdown === 'failed') {
    shutdownError = new Error('Backend server shutdown failed');
    forceServerClose(server);
  }

  const resourceShutdown = await settleBeforeDeadline(() => resources.close(), deadline);
  if (resourceShutdown === 'deadline_exceeded') {
    forceRuntimeClose(server, resources);
    throw new BackendShutdownDeadlineError();
  }
  if (resourceShutdown === 'failed') {
    shutdownError ??= new Error('Backend resource shutdown failed');
    forceResourcesClose(resources);
  }
  if (shutdownError !== undefined) {
    throw shutdownError;
  }
}

export async function drainServer(server: ServerType, timeoutMs: number): Promise<void> {
  const outcome = await settleBeforeDeadline(
    () => requestServerClose(server),
    performance.now() + timeoutMs,
  );
  if (outcome === 'deadline_exceeded') {
    forceServerClose(server);
    return;
  }
  if (outcome === 'failed') {
    forceServerClose(server);
    throw new Error('Server shutdown failed');
  }
}

type ShutdownOutcome = 'completed' | 'failed' | 'deadline_exceeded';

async function settleBeforeDeadline(
  operation: () => Promise<void>,
  deadline: number,
): Promise<ShutdownOutcome> {
  const remainingMs = deadline - performance.now();
  if (remainingMs <= 0) return 'deadline_exceeded';

  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const completion = Promise.resolve()
    .then(operation)
    .then<ShutdownOutcome, ShutdownOutcome>(
      () => 'completed',
      () => 'failed',
    );
  const timeout = new Promise<ShutdownOutcome>((resolvePromise) => {
    deadlineTimer = setTimeout(() => {
      resolvePromise('deadline_exceeded');
    }, remainingMs);
  });

  const outcome = await Promise.race([completion, timeout]);
  if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
  return outcome;
}

function requestServerClose(server: ServerType): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    try {
      server.close((error?: Error) => {
        if (error === undefined) resolvePromise();
        else rejectPromise(error);
      });
      if ('closeIdleConnections' in server) server.closeIdleConnections();
    } catch (error: unknown) {
      rejectPromise(error);
    }
  });
}

function forceRuntimeClose(server: ServerType, resources: ShutdownResources): void {
  forceServerClose(server);
  forceResourcesClose(resources);
}

function forceServerClose(server: ServerType): void {
  try {
    if ('closeAllConnections' in server) server.closeAllConnections();
  } catch {
    // The absolute shutdown deadline has already elapsed.
  }
}

function forceResourcesClose(resources: ShutdownResources): void {
  try {
    resources.forceClose();
  } catch {
    // The absolute shutdown deadline must not be extended by cleanup diagnostics.
  }
}

function classifyRuntimeError(error: unknown): 'error' | 'non_error' {
  return error instanceof Error ? 'error' : 'non_error';
}

const processLogger: RuntimeLogger = {
  info: (entry) => {
    process.stdout.write(`${JSON.stringify(entry)}\n`);
  },
  error: (entry) => {
    process.stderr.write(`${JSON.stringify(entry)}\n`);
  },
};

async function main(): Promise<void> {
  let running: RunningBackend;
  try {
    running = await startBackend();
  } catch (error: unknown) {
    processLogger.error({ event: 'backend.start_failed', code: classifyStartupFailure(error) });
    process.exitCode = 1;
    return;
  }

  let shutdownStarted = false;
  const shutdown = (signal: 'SIGINT' | 'SIGTERM'): void => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    processLogger.info({ event: 'backend.shutdown_started', signal });
    void running
      .close()
      .then(() => {
        processLogger.info({ event: 'backend.shutdown_complete' });
      })
      .catch(() => {
        processLogger.error({ event: 'backend.shutdown_failed' });
        process.exitCode = 1;
      });
  };
  process.once('SIGINT', () => {
    shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    shutdown('SIGTERM');
  });
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  await main();
}
