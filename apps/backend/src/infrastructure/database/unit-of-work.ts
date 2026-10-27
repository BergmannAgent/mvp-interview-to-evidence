import type { Pool, PoolClient } from 'pg';

import {
  failure,
  type AppReadContext,
  type AppTransaction,
  type AppUnitOfWork,
  type RepositoryError,
  type RepositoryResult,
  type Result,
} from '../../application/persistence/index.js';
import { createClientSqlExecutor, type SqlExecutor } from './repositories/sql.js';

export interface UnitOfWorkClient extends SqlExecutor {
  release(destroy?: boolean): void;
}

export interface UnitOfWorkPool {
  connect(): Promise<UnitOfWorkClient>;
}

export interface PersistenceContextFactory {
  createReadContext(executor: SqlExecutor): AppReadContext;
  createTransaction(executor: SqlExecutor): AppTransaction;
}

export class PostgresUnitOfWork implements AppUnitOfWork {
  public constructor(
    private readonly pool: UnitOfWorkPool,
    private readonly contexts: PersistenceContextFactory,
  ) {}

  public async read<T>(
    operation: (context: AppReadContext) => Promise<RepositoryResult<T>>,
  ): Promise<RepositoryResult<T>> {
    let client: UnitOfWorkClient;
    try {
      client = await this.pool.connect();
    } catch {
      return failure(unavailable());
    }
    let phase: 'idle' | 'open' | 'committing' | 'closed' = 'idle';
    let destroyClient = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      phase = 'open';
      const result = await operation(this.contexts.createReadContext(client));
      phase = 'committing';
      await client.query('COMMIT');
      phase = 'closed';
      return result;
    } catch {
      let error = phase === 'open' ? internal() : unavailable();
      if (phase === 'open') {
        try {
          await client.query('ROLLBACK');
          phase = 'closed';
        } catch {
          destroyClient = true;
          error = unavailable();
        }
      } else if (phase !== 'closed') {
        destroyClient = true;
      }
      return failure(error);
    } finally {
      client.release(destroyClient);
    }
  }

  public async transaction<T, E = never>(
    operation: (transaction: AppTransaction) => Promise<Result<T, E | RepositoryError>>,
  ): Promise<Result<T, E | RepositoryError>> {
    let client: UnitOfWorkClient;
    try {
      client = await this.pool.connect();
    } catch {
      return failure(unavailable());
    }
    let phase: 'idle' | 'open' | 'committing' | 'closed' = 'idle';
    let destroyClient = false;

    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      phase = 'open';
      const result = await operation(this.contexts.createTransaction(client));
      if (!result.ok) {
        await client.query('ROLLBACK');
        phase = 'closed';
        return result;
      }

      phase = 'committing';
      await client.query('COMMIT');
      phase = 'closed';
      return result;
    } catch {
      let error = phase === 'open' ? internal() : unavailable();
      if (phase === 'open') {
        try {
          await client.query('ROLLBACK');
          phase = 'closed';
        } catch {
          destroyClient = true;
          error = unavailable();
        }
      } else if (phase !== 'closed') {
        // BEGIN and COMMIT failures leave connection state ambiguous.
        destroyClient = true;
      }
      return failure(error);
    } finally {
      client.release(destroyClient);
    }
  }
}

export function createPgUnitOfWorkPool(pool: Pool): UnitOfWorkPool {
  return {
    async connect(): Promise<UnitOfWorkClient> {
      const client = await pool.connect();
      return wrapPgClient(client);
    },
  };
}

function wrapPgClient(client: PoolClient): UnitOfWorkClient {
  const executor = createClientSqlExecutor(client);
  return {
    query: executor.query.bind(executor),
    release(destroy = false): void {
      client.release(destroy);
    },
  };
}

function unavailable(): RepositoryError {
  return { code: 'unavailable', retryable: true };
}

function internal(): RepositoryError {
  return { code: 'internal', retryable: false };
}
