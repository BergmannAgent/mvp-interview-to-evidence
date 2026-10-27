import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { connect, createServer as createNetServer } from 'node:net';

import { livenessResponseSchema } from '@orgscience/contracts';
import { describe, expect, it, vi } from 'vitest';

import { DatabaseConfigurationError } from './infrastructure/database/config.js';
import {
  BackendShutdownDeadlineError,
  classifyStartupFailure,
  closeRuntime,
  drainServer,
  startBackend,
  type RuntimeLogger,
} from './main.js';
import { HttpRuntimeConfigurationError } from './runtime/http-config.js';
import { ModelRuntimeConfigurationError } from './runtime/model-config.js';
import { RealtimeRuntimeConfigurationError } from './runtime/realtime-config.js';

describe('backend Node runtime', () => {
  it('serves the Hono application and closes idempotently without a database connection', async () => {
    const port = await reserveAvailablePort();
    const logger: RuntimeLogger = { info: vi.fn(), error: vi.fn() };
    const running = await startBackend(
      {
        BACKEND_HOST: '127.0.0.1',
        BACKEND_PORT: String(port),
        HTTP_ALLOWED_ORIGINS: 'http://localhost:5173',
        DATABASE_URL: 'postgresql://interview:interview@127.0.0.1:1/interview',
        DATABASE_CONNECTION_TIMEOUT_MS: '100',
      },
      logger,
    );

    try {
      const response = await fetch(`http://127.0.0.1:${String(running.port)}/health/live`);
      expect(response.status).toBe(200);
      expect(livenessResponseSchema.safeParse(await response.json()).success).toBe(true);
      expect(logger.info).toHaveBeenCalledWith({
        event: 'backend.listening',
        host: '127.0.0.1',
        port,
      });
    } finally {
      const firstClose = running.close();
      const secondClose = running.close();
      expect(secondClose).toBe(firstClose);
      await firstClose;
    }
  });

  it('classifies startup failures without serializing configuration contents', () => {
    expect(classifyStartupFailure(new DatabaseConfigurationError(['secret']))).toBe(
      'database_configuration_invalid',
    );
    expect(classifyStartupFailure(new HttpRuntimeConfigurationError(['secret']))).toBe(
      'http_configuration_invalid',
    );
    expect(classifyStartupFailure(new RealtimeRuntimeConfigurationError(['secret']))).toBe(
      'realtime_configuration_invalid',
    );
    expect(classifyStartupFailure(new ModelRuntimeConfigurationError(['secret']))).toBe(
      'model_configuration_invalid',
    );
    expect(classifyStartupFailure(new Error('secret'))).toBe('backend_start_failed');
  });

  it('forces an incomplete active request closed after the configured drain deadline', async () => {
    let markRequestStarted: (() => void) | undefined;
    const requestStarted = new Promise<void>((resolvePromise) => {
      markRequestStarted = resolvePromise;
    });
    const server = createHttpServer(() => {
      markRequestStarted?.();
    });
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once('error', rejectPromise);
      server.listen(0, '127.0.0.1', resolvePromise);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Test HTTP server did not expose a TCP address');
    }

    const socket = connect(address.port, '127.0.0.1');
    await once(socket, 'connect');
    socket.write('POST /slow HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\nx');
    await requestStarted;
    const socketClosed = once(socket, 'close');

    const startedAt = Date.now();
    await drainServer(server, 25);
    await socketClosed;

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(socket.destroyed).toBe(true);
  });

  it('force-closes resources when their normal close never settles', async () => {
    const server = createHttpServer();
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once('error', rejectPromise);
      server.listen(0, '127.0.0.1', resolvePromise);
    });
    const close = vi.fn(() => new Promise<void>(() => undefined));
    const forceClose = vi.fn();

    const startedAt = Date.now();
    await expect(closeRuntime(server, { close, forceClose }, 25)).rejects.toBeInstanceOf(
      BackendShutdownDeadlineError,
    );

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(close).toHaveBeenCalledOnce();
    expect(forceClose).toHaveBeenCalledOnce();
    expect(server.listening).toBe(false);
  });

  it('signals long-lived realtime sessions before waiting for the HTTP server to drain', async () => {
    const server = createHttpServer();
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once('error', rejectPromise);
      server.listen(0, '127.0.0.1', resolvePromise);
    });
    const beginShutdown = vi.fn();
    const close = vi.fn(async () => undefined);
    const forceClose = vi.fn();

    await closeRuntime(server, { beginShutdown, close, forceClose }, 1_000);

    expect(beginShutdown).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(beginShutdown.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER).toBeLessThan(
      close.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(forceClose).not.toHaveBeenCalled();
    expect(server.listening).toBe(false);
  });
});

async function reserveAvailablePort(): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createNetServer();
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        rejectPromise(new Error('Could not reserve a TCP port'));
        return;
      }
      server.close((error) => {
        if (error) {
          rejectPromise(error);
          return;
        }
        resolvePromise(address.port);
      });
    });
  });
}
