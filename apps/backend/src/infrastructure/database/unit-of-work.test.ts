import { describe, expect, it } from 'vitest';

import {
  failure,
  success,
  type AppReadContext,
  type AppTransaction,
  type RepositoryError,
} from '../../application/persistence/index.js';
import {
  PostgresUnitOfWork,
  type PersistenceContextFactory,
  type UnitOfWorkClient,
  type UnitOfWorkPool,
} from './unit-of-work.js';

const unusedContext = {} as AppReadContext & AppTransaction;

function harness(failingStatement?: string): {
  readonly calls: string[];
  readonly releases: boolean[];
  readonly unitOfWork: PostgresUnitOfWork;
} {
  const calls: string[] = [];
  const releases: boolean[] = [];
  const client: UnitOfWorkClient = {
    async query(statement) {
      calls.push(statement);
      if (statement === failingStatement) {
        throw new Error(`Injected ${statement} failure`);
      }
      return { rows: [], rowCount: 0 };
    },
    release(destroy = false) {
      releases.push(destroy);
    },
  };
  const pool: UnitOfWorkPool = {
    async connect() {
      return client;
    },
  };
  const contexts: PersistenceContextFactory = {
    createReadContext: () => unusedContext,
    createTransaction: () => unusedContext,
  };
  return { calls, releases, unitOfWork: new PostgresUnitOfWork(pool, contexts) };
}

describe('PostgresUnitOfWork', () => {
  it('commits only successful results', async () => {
    const test = harness();

    await expect(test.unitOfWork.transaction(async () => success('stored'))).resolves.toEqual(
      success('stored'),
    );
    expect(test.calls).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ', 'COMMIT']);
    expect(test.releases).toEqual([false]);
  });

  it('rolls back an explicit failure without replacing it', async () => {
    const test = harness();
    const error: RepositoryError = {
      code: 'stale_version',
      interviewId: 'interview-1',
      expected: 2,
      actual: 3,
    };

    await expect(test.unitOfWork.transaction(async () => failure(error))).resolves.toEqual(
      failure(error),
    );
    expect(test.calls).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ', 'ROLLBACK']);
    expect(test.releases).toEqual([false]);
  });

  it('rolls back a rejected operation and returns a non-retryable internal error', async () => {
    const test = harness();

    await expect(
      test.unitOfWork.transaction(async () => {
        throw new Error('application failure');
      }),
    ).resolves.toEqual(failure({ code: 'internal', retryable: false }));
    expect(test.calls).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ', 'ROLLBACK']);
    expect(test.releases).toEqual([false]);
  });

  it('destroys a client when rollback fails', async () => {
    const test = harness('ROLLBACK');

    await test.unitOfWork.transaction(async () => {
      throw new Error('application failure');
    });
    expect(test.calls).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ', 'ROLLBACK']);
    expect(test.releases).toEqual([true]);
  });

  it('destroys a client without attempting rollback after an ambiguous commit failure', async () => {
    const test = harness('COMMIT');

    await expect(test.unitOfWork.transaction(async () => success('stored'))).resolves.toEqual(
      failure({ code: 'unavailable', retryable: true }),
    );
    expect(test.calls).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ', 'COMMIT']);
    expect(test.releases).toEqual([true]);
  });

  it('maps connection failures without trying to release a missing client', async () => {
    const contexts: PersistenceContextFactory = {
      createReadContext: () => unusedContext,
      createTransaction: () => unusedContext,
    };
    const pool: UnitOfWorkPool = {
      async connect() {
        throw new Error('database offline');
      },
    };
    const unitOfWork = new PostgresUnitOfWork(pool, contexts);

    await expect(unitOfWork.read(async () => success('unused'))).resolves.toEqual(
      failure({ code: 'unavailable', retryable: true }),
    );
    await expect(unitOfWork.transaction(async () => success('unused'))).resolves.toEqual(
      failure({ code: 'unavailable', retryable: true }),
    );
  });

  it('uses a connection-scoped read context and always releases it', async () => {
    const test = harness();

    await expect(test.unitOfWork.read(async () => success('loaded'))).resolves.toEqual(
      success('loaded'),
    );
    expect(test.calls).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'COMMIT']);
    expect(test.releases).toEqual([false]);
  });

  it('destroys a read client when the operation rejects', async () => {
    const test = harness();

    await expect(
      test.unitOfWork.read(async () => {
        throw new Error('read failed');
      }),
    ).resolves.toEqual(failure({ code: 'internal', retryable: false }));
    expect(test.calls).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'ROLLBACK']);
    expect(test.releases).toEqual([false]);
  });
});
