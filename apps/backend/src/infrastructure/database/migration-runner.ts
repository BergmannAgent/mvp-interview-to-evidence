import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Pool } from 'pg';
import { z } from 'zod';

const MIGRATION_FILE_PATTERN = /^(?<order>\d{4,})_[a-z0-9][a-z0-9_-]*\.sql$/u;
const MIGRATION_LOCK_NAMESPACE = 1_651_473_985;
const MIGRATION_LOCK_RESOURCE = 1;

const CREATE_MIGRATION_TABLE_SQL = `
CREATE TABLE app.__drizzle_migrations (
  id text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
)`;
const FIND_MIGRATION_TABLE_SQL = "SELECT to_regclass('app.__drizzle_migrations')::text AS relation";
const FIND_APP_SCHEMA_SQL = "SELECT to_regnamespace('app')::text AS schema_name";
const LOAD_APPLIED_MIGRATIONS_SQL = 'SELECT id, checksum FROM app.__drizzle_migrations ORDER BY id';
const INSERT_APPLIED_MIGRATION_SQL =
  'INSERT INTO app.__drizzle_migrations (id, checksum) VALUES ($1, $2)';
const ACQUIRE_MIGRATION_LOCK_SQL = 'SELECT pg_advisory_lock($1::integer, $2::integer)';
const RELEASE_MIGRATION_LOCK_SQL =
  'SELECT pg_advisory_unlock($1::integer, $2::integer) AS unlocked';

const appliedMigrationRowSchema = z.strictObject({
  id: z.string().min(1),
  checksum: z.string().regex(/^[a-f0-9]{64}$/u),
});

export interface SqlMigration {
  readonly id: string;
  readonly order: number;
  readonly fileName: string;
  readonly checksum: string;
  readonly sql: string;
}

export interface MigrationQueryResult {
  readonly rows: readonly unknown[];
  readonly rowCount: number | null;
}

export interface MigrationClient {
  query(sql: string, parameters?: readonly unknown[]): Promise<MigrationQueryResult>;
  release(destroy?: boolean): void;
}

export interface MigrationPool {
  connect(): Promise<MigrationClient>;
}

export interface MigrationRunResult {
  readonly appliedMigrationIds: readonly string[];
  readonly previouslyAppliedMigrationIds: readonly string[];
}

export type DatabaseMigrationErrorCode =
  | 'connection_failed'
  | 'invalid_migration_file'
  | 'invalid_migration_history'
  | 'migration_checksum_mismatch'
  | 'migration_execution_failed'
  | 'migration_lock_failed';

export class DatabaseMigrationError extends Error {
  public readonly code: DatabaseMigrationErrorCode;
  public readonly migrationId: string | null;

  public constructor(
    code: DatabaseMigrationErrorCode,
    message: string,
    migrationId: string | null = null,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'DatabaseMigrationError';
    this.code = code;
    this.migrationId = migrationId;
  }
}

export async function loadSqlMigrations(directory: string | URL): Promise<readonly SqlMigration[]> {
  let directoryPath: string;
  try {
    directoryPath = typeof directory === 'string' ? directory : fileURLToPath(directory);
  } catch (error: unknown) {
    throw new DatabaseMigrationError(
      'invalid_migration_file',
      'The application migration directory URL is invalid',
      null,
      error,
    );
  }
  let entries;
  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch (error: unknown) {
    throw new DatabaseMigrationError(
      'invalid_migration_file',
      'The application migration directory could not be read',
      null,
      error,
    );
  }

  const sqlFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .sort((left, right) => left.name.localeCompare(right.name));
  const migrations: SqlMigration[] = [];
  const orders = new Set<number>();

  for (const entry of sqlFiles) {
    const match = MIGRATION_FILE_PATTERN.exec(entry.name);
    const orderText = match?.groups?.order;
    if (orderText === undefined) {
      throw new DatabaseMigrationError(
        'invalid_migration_file',
        `Migration file ${entry.name} must use the format 0000_description.sql`,
      );
    }
    const order = Number(orderText);
    if (!Number.isSafeInteger(order) || orders.has(order) || order !== migrations.length) {
      throw new DatabaseMigrationError(
        'invalid_migration_file',
        `Migration file ${entry.name} has an invalid, duplicate, or non-contiguous order`,
      );
    }

    let bytes: Buffer;
    try {
      bytes = await readFile(join(directoryPath, entry.name));
    } catch (error: unknown) {
      throw new DatabaseMigrationError(
        'invalid_migration_file',
        `Migration file ${entry.name} could not be read`,
        null,
        error,
      );
    }
    let sql: string;
    try {
      sql = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (error: unknown) {
      throw new DatabaseMigrationError(
        'invalid_migration_file',
        `Migration file ${entry.name} is not valid UTF-8`,
        null,
        error,
      );
    }
    if (sql.trim().length === 0) {
      throw new DatabaseMigrationError(
        'invalid_migration_file',
        `Migration file ${entry.name} must not be empty`,
      );
    }

    orders.add(order);
    migrations.push(
      Object.freeze({
        id: entry.name.slice(0, -'.sql'.length),
        order,
        fileName: entry.name,
        checksum: createHash('sha256').update(bytes).digest('hex'),
        sql,
      }),
    );
  }

  if (migrations.length === 0) {
    throw new DatabaseMigrationError(
      'invalid_migration_file',
      'The application migration directory contains no SQL migrations',
    );
  }

  return Object.freeze(migrations);
}

export async function runSqlMigrations(
  pool: MigrationPool,
  directory: string | URL,
): Promise<MigrationRunResult> {
  const migrations = await loadSqlMigrations(directory);
  let client: MigrationClient;
  try {
    client = await pool.connect();
  } catch (error: unknown) {
    throw new DatabaseMigrationError(
      'connection_failed',
      'Could not connect to the application database for migrations',
      null,
      error,
    );
  }

  let lockAcquired = false;
  let destroyConnection = false;
  let outcome: MigrationRunResult | undefined;
  let failure: unknown;

  try {
    await client.query(ACQUIRE_MIGRATION_LOCK_SQL, [
      MIGRATION_LOCK_NAMESPACE,
      MIGRATION_LOCK_RESOURCE,
    ]);
    lockAcquired = true;
    outcome = await applyMigrationsWithLock(client, migrations);
  } catch (error: unknown) {
    failure = normalizeMigrationError(error);
    if (!lockAcquired) {
      destroyConnection = true;
    }
  }

  if (lockAcquired) {
    try {
      const unlockResult = await client.query(RELEASE_MIGRATION_LOCK_SQL, [
        MIGRATION_LOCK_NAMESPACE,
        MIGRATION_LOCK_RESOURCE,
      ]);
      const firstRow = unlockResult.rows[0];
      if (!isRecord(firstRow) || firstRow.unlocked !== true) {
        throw new Error('PostgreSQL did not release the application migration lock');
      }
    } catch (error: unknown) {
      destroyConnection = true;
      if (failure === undefined) {
        failure = new DatabaseMigrationError(
          'migration_lock_failed',
          'Could not release the application migration lock',
          null,
          error,
        );
      }
    }
  }

  try {
    client.release(destroyConnection);
  } catch (error: unknown) {
    if (failure === undefined) {
      failure = new DatabaseMigrationError(
        'connection_failed',
        'Could not release the application migration connection',
        null,
        error,
      );
    }
  }

  if (failure !== undefined) {
    throw failure;
  }
  if (outcome === undefined) {
    throw new DatabaseMigrationError(
      'migration_execution_failed',
      'Application migrations ended without a result',
    );
  }
  return outcome;
}

export function createPgMigrationPool(pool: Pool): MigrationPool {
  return {
    async connect(): Promise<MigrationClient> {
      const client = await pool.connect();
      return {
        async query(sql, parameters): Promise<MigrationQueryResult> {
          const result =
            parameters === undefined
              ? await client.query<Record<string, unknown>>(sql)
              : await client.query<Record<string, unknown>>(sql, [...parameters]);
          return { rows: result.rows, rowCount: result.rowCount };
        },
        release(destroy = false): void {
          client.release(destroy);
        },
      };
    },
  };
}

async function applyMigrationsWithLock(
  client: MigrationClient,
  migrations: readonly SqlMigration[],
): Promise<MigrationRunResult> {
  const migrationTableResult = await client.query(FIND_MIGRATION_TABLE_SQL);
  const migrationTableExists = readNullableTextColumn(
    migrationTableResult.rows,
    'relation',
    'migration table lookup',
  );

  if (migrationTableExists === null) {
    const appSchemaResult = await client.query(FIND_APP_SCHEMA_SQL);
    const appSchemaExists = readNullableTextColumn(
      appSchemaResult.rows,
      'schema_name',
      'application schema lookup',
    );
    if (appSchemaExists !== null) {
      throw new DatabaseMigrationError(
        'invalid_migration_history',
        'The app schema exists without application migration metadata',
      );
    }

    const [initialMigration, ...remainingMigrations] = migrations;
    if (initialMigration === undefined) {
      throw new DatabaseMigrationError(
        'invalid_migration_file',
        'An initial application migration is required',
      );
    }
    await applySingleMigration(client, initialMigration, true);
    const appliedMigrationIds = [initialMigration.id];
    for (const migration of remainingMigrations) {
      await applySingleMigration(client, migration, false);
      appliedMigrationIds.push(migration.id);
    }
    return Object.freeze({
      appliedMigrationIds: Object.freeze(appliedMigrationIds),
      previouslyAppliedMigrationIds: Object.freeze([]),
    });
  }

  const appliedResult = await client.query(LOAD_APPLIED_MIGRATIONS_SQL);
  const parsedRows = z.array(appliedMigrationRowSchema).safeParse(appliedResult.rows);
  if (!parsedRows.success) {
    throw new DatabaseMigrationError(
      'invalid_migration_history',
      'Stored application migration metadata is malformed',
    );
  }

  const appliedRows = parsedRows.data;
  if (appliedRows.length > migrations.length) {
    throw new DatabaseMigrationError(
      'invalid_migration_history',
      'The database contains migrations that are absent from this application build',
    );
  }

  for (const [index, applied] of appliedRows.entries()) {
    const local = migrations[index];
    if (local === undefined || local.id !== applied.id) {
      throw new DatabaseMigrationError(
        'invalid_migration_history',
        'Applied application migrations are not a prefix of the checked-in migration history',
        applied.id,
      );
    }
    if (local.checksum !== applied.checksum) {
      throw new DatabaseMigrationError(
        'migration_checksum_mismatch',
        `Applied migration ${applied.id} differs from the checked-in file`,
        applied.id,
      );
    }
  }

  const pending = migrations.slice(appliedRows.length);
  const appliedMigrationIds: string[] = [];
  for (const migration of pending) {
    await applySingleMigration(client, migration, false);
    appliedMigrationIds.push(migration.id);
  }

  return Object.freeze({
    appliedMigrationIds: Object.freeze(appliedMigrationIds),
    previouslyAppliedMigrationIds: Object.freeze(appliedRows.map((row) => row.id)),
  });
}

async function applySingleMigration(
  client: MigrationClient,
  migration: SqlMigration,
  createMetadataTable: boolean,
): Promise<void> {
  let transactionStarted = false;
  try {
    await client.query('BEGIN');
    transactionStarted = true;
    await client.query(migration.sql);
    if (createMetadataTable) {
      await client.query(CREATE_MIGRATION_TABLE_SQL);
    }
    await client.query(INSERT_APPLIED_MIGRATION_SQL, [migration.id, migration.checksum]);
    await client.query('COMMIT');
    transactionStarted = false;
  } catch (error: unknown) {
    let cause = error;
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError: unknown) {
        cause = new AggregateError(
          [error, rollbackError],
          `Migration ${migration.id} failed and rollback also failed`,
        );
      }
    }
    throw new DatabaseMigrationError(
      'migration_execution_failed',
      `Application migration ${migration.id} failed`,
      migration.id,
      cause,
    );
  }
}

function normalizeMigrationError(error: unknown): DatabaseMigrationError {
  return error instanceof DatabaseMigrationError
    ? error
    : new DatabaseMigrationError(
        'migration_execution_failed',
        'Application migration execution failed',
        null,
        error,
      );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNullableTextColumn(
  rows: readonly unknown[],
  column: string,
  operation: string,
): string | null {
  const row = rows[0];
  if (!isRecord(row) || !(column in row)) {
    throw new DatabaseMigrationError(
      'invalid_migration_history',
      `PostgreSQL returned malformed ${operation} metadata`,
    );
  }
  const value = row[column];
  if (value !== null && typeof value !== 'string') {
    throw new DatabaseMigrationError(
      'invalid_migration_history',
      `PostgreSQL returned malformed ${operation} metadata`,
    );
  }
  return value;
}
