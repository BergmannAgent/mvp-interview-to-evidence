import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { DatabaseConfigurationError, loadDatabaseConfig } from './config.js';
import {
  DatabaseMigrationError,
  createPgMigrationPool,
  runSqlMigrations,
  type DatabaseMigrationErrorCode,
} from './migration-runner.js';
import { createDatabasePool } from './pool.js';

const SAFE_MIGRATION_ID_PATTERN = /^\d{4,}_[a-z0-9][a-z0-9_-]*$/u;
const MIGRATION_ERROR_MESSAGES = {
  connection_failed: 'The database connection required for migrations failed.',
  invalid_migration_file: 'The checked-in migration files are invalid.',
  invalid_migration_history: 'The stored database migration history is invalid.',
  migration_checksum_mismatch: 'An applied migration differs from the checked-in migration file.',
  migration_execution_failed: 'A database migration could not be applied.',
  migration_lock_failed: 'The database migration lock operation failed.',
} as const satisfies Readonly<Record<DatabaseMigrationErrorCode, string>>;

interface MigrationFailureDiagnostic {
  readonly code: DatabaseMigrationErrorCode | 'database_configuration_invalid' | 'unknown_error';
  readonly migrationId: string | null;
  readonly message: string;
}

export interface MigrateApplicationDatabaseOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly migrationDirectory?: string | URL;
}

export async function migrateApplicationDatabase(
  options: MigrateApplicationDatabaseOptions = {},
): Promise<readonly string[]> {
  const config = loadDatabaseConfig(options.environment ?? process.env);
  const databasePool = createDatabasePool(config);

  try {
    const result = await runSqlMigrations(
      createPgMigrationPool(databasePool.pool),
      options.migrationDirectory ?? new URL('../../../drizzle/', import.meta.url),
    );
    return result.appliedMigrationIds;
  } finally {
    await databasePool.close();
  }
}

export function formatMigrationFailure(error: unknown): string {
  let diagnostic: MigrationFailureDiagnostic;
  if (error instanceof DatabaseConfigurationError) {
    diagnostic = {
      code: 'database_configuration_invalid',
      migrationId: null,
      message: 'Database configuration is invalid; check the DATABASE_* settings.',
    };
  } else if (error instanceof DatabaseMigrationError) {
    diagnostic = {
      code: error.code,
      migrationId: safeMigrationId(error.migrationId),
      message: MIGRATION_ERROR_MESSAGES[error.code],
    };
  } else {
    diagnostic = {
      code: 'unknown_error',
      migrationId: null,
      message: 'An unexpected database migration error occurred.',
    };
  }

  return `Application database migration failed: ${JSON.stringify(diagnostic)}`;
}

async function main(): Promise<void> {
  try {
    const appliedMigrationIds = await migrateApplicationDatabase();
    process.stdout.write(
      `Application database migrations complete (${String(appliedMigrationIds.length)} applied).\n`,
    );
  } catch (error: unknown) {
    process.stderr.write(`${formatMigrationFailure(error)}\n`);
    process.exitCode = 1;
  }
}

function safeMigrationId(migrationId: string | null): string | null {
  return migrationId !== null && SAFE_MIGRATION_ID_PATTERN.test(migrationId) ? migrationId : null;
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  await main();
}
