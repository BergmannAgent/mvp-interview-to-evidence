import type { Pool, PoolClient } from 'pg';

export interface SqlQueryResult {
  readonly rows: readonly unknown[];
  readonly rowCount: number;
}

export interface SqlExecutor {
  query(statement: string, parameters?: readonly unknown[]): Promise<SqlQueryResult>;
}

export function createPoolSqlExecutor(pool: Pool): SqlExecutor {
  return createSqlExecutor((statement, parameters) =>
    pool.query<Record<string, unknown>>(statement, [...parameters]),
  );
}

export function createClientSqlExecutor(client: PoolClient): SqlExecutor {
  return createSqlExecutor((statement, parameters) =>
    client.query<Record<string, unknown>>(statement, [...parameters]),
  );
}

function createSqlExecutor(
  execute: (
    statement: string,
    parameters: readonly unknown[],
  ) => Promise<{ readonly rows: readonly unknown[]; readonly rowCount: number | null }>,
): SqlExecutor {
  return {
    async query(statement, parameters = []): Promise<SqlQueryResult> {
      const result = await execute(statement, parameters);
      return {
        rows: result.rows,
        rowCount: result.rowCount ?? 0,
      };
    },
  };
}
