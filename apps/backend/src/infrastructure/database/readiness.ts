export const REQUIRED_APPLICATION_SCHEMA_VERSION = 15;

export type DatabaseReadinessStatus = 'ready' | 'not_ready';

export interface DatabaseReadinessQueryResult {
  readonly rows: readonly Readonly<Record<string, unknown>>[];
}

export interface DatabaseReadinessQueryPort {
  query(query: {
    readonly text: string;
    readonly values: string[];
    readonly query_timeout: number;
  }): Promise<DatabaseReadinessQueryResult>;
}

const readinessQuery = `
  SELECT "version"
  FROM "app"."schema_metadata"
  WHERE "component" = $1
`;

export async function checkDatabaseReadiness(
  database: DatabaseReadinessQueryPort,
  timeoutMs = 2_000,
): Promise<DatabaseReadinessStatus> {
  try {
    const result = await withinTimeout(
      database.query({
        text: readinessQuery,
        values: ['application'],
        query_timeout: timeoutMs,
      }),
      timeoutMs,
    );
    if (result.rows.length !== 1) {
      return 'not_ready';
    }

    return result.rows[0]?.version === REQUIRED_APPLICATION_SCHEMA_VERSION ? 'ready' : 'not_ready';
  } catch {
    return 'not_ready';
  }
}

async function withinTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error('Database readiness deadline exceeded'));
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
