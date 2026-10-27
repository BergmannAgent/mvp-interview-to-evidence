import { once } from 'node:events';
import { createServer as createNetServer, type Socket } from 'node:net';

import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import type { DatabaseConfig } from './config.js';
import { createDatabasePool, ManagedDatabasePool, type ClosablePool } from './pool.js';

class FakeClosablePool implements ClosablePool {
  public closeCount = 0;

  public async end(): Promise<void> {
    this.closeCount += 1;
  }
}

describe('managed database pool', () => {
  it('closes the underlying pool exactly once', async () => {
    const rawPool = new FakeClosablePool();
    const managed = new ManagedDatabasePool(rawPool, 'postgresql://db/interview');

    expect(managed.closed).toBe(false);
    const firstClose = managed.close();
    const secondClose = managed.close();

    expect(firstClose).toBe(secondClose);
    await Promise.all([firstClose, secondClose]);
    expect(rawPool.closeCount).toBe(1);
    expect(managed.closed).toBe(true);
    expect(managed.redactedConnectionString).toBe('postgresql://db/interview');
  });

  it('force-closes tracked active clients exactly once', async () => {
    const rawPool = new FakeClosablePool();
    const forceCloseAll = vi.fn();
    const managed = new ManagedDatabasePool(rawPool, 'postgresql://db/interview', {
      forceCloseAll,
    });

    managed.forceClose();
    managed.forceClose();
    await managed.close();

    expect(rawPool.closeCount).toBe(1);
    expect(forceCloseAll).toHaveBeenCalledOnce();
    expect(managed.closed).toBe(true);
  });

  it('reports idle-client errors without exposing database credentials or error contents', async () => {
    const secret = 'database-password-that-must-not-escape';
    const clientError = vi.fn();
    const managed = createDatabasePool(databaseConfig(secret), { clientError });

    expect(() => {
      managed.pool.emit('error', new Error(`connection failed for ${secret}`), {} as PoolClient);
    }).not.toThrow();

    expect(clientError).toHaveBeenCalledOnce();
    expect(clientError).toHaveBeenCalledWith({
      database: 'postgresql://localhost/interview?<redacted>',
      errorClass: 'error',
    });
    expect(JSON.stringify(clientError.mock.calls)).not.toContain(secret);
    await managed.close();
  });

  it('contains diagnostics failures raised while handling an idle-client error', async () => {
    const managed = createDatabasePool(databaseConfig('secret'), {
      clientError: () => {
        throw new Error('diagnostics failed');
      },
    });

    expect(() => {
      managed.pool.emit('error', new Error('database unavailable'), {} as PoolClient);
    }).not.toThrow();
    await managed.close();
  });

  it('force-closes a client that is still waiting for the PostgreSQL handshake', async () => {
    const sockets = new Set<Socket>();
    const server = createNetServer((socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once('error', rejectPromise);
      server.listen(0, '127.0.0.1', resolvePromise);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Blackhole test server did not expose a TCP address');
    }
    const accepted = once(server, 'connection');
    const managed = createDatabasePool({
      ...databaseConfig('secret'),
      connectionString: `postgresql://interview:secret@127.0.0.1:${String(address.port)}/interview`,
      connectionTimeoutMs: 5_000,
    });
    const pendingConnect = managed.pool.connect();

    try {
      await accepted;
      const startedAt = Date.now();
      managed.forceClose();

      await expect(withTimeout(managed.close(), 500)).resolves.toBeUndefined();
      await expect(pendingConnect).rejects.toBeInstanceOf(Error);
      expect(Date.now() - startedAt).toBeLessThan(500);
      expect(managed.closed).toBe(true);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
  });
});

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolvePromise, rejectPromise) => {
        timer = setTimeout(() => rejectPromise(new Error('Test operation timed out')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function databaseConfig(password: string): DatabaseConfig {
  return {
    connectionString: `postgresql://interview:${password}@localhost/interview?sslmode=require`,
    redactedConnectionString: 'postgresql://localhost/interview?<redacted>',
    maximumPoolSize: 2,
    idleTimeoutMs: 1_000,
    connectionTimeoutMs: 100,
    readinessTimeoutMs: 100,
    applicationName: 'orgscience-pool-test',
  };
}
