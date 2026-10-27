import { describe, expect, it } from 'vitest';

import { DatabaseConfigurationError } from './config.js';
import { DatabaseMigrationError } from './migration-runner.js';
import { formatMigrationFailure } from './migrate.js';

describe('migration command diagnostics', () => {
  it('reports an actionable configuration code without exposing an invalid URL', () => {
    const output = formatMigrationFailure(
      new DatabaseConfigurationError([
        'DATABASE_URL: postgresql://admin:configuration-secret@database/app',
      ]),
    );

    expect(readDiagnostic(output)).toEqual({
      code: 'database_configuration_invalid',
      migrationId: null,
      message: 'Database configuration is invalid; check the DATABASE_* settings.',
    });
    expect(output).not.toContain('postgresql://');
    expect(output).not.toContain('configuration-secret');
  });

  it('reports a checksum failure and its safe migration ID using a controlled message', () => {
    const output = formatMigrationFailure(
      new DatabaseMigrationError(
        'migration_checksum_mismatch',
        'checksum mismatch includes checksum-secret',
        '0001_add_interviews',
      ),
    );

    expect(readDiagnostic(output)).toEqual({
      code: 'migration_checksum_mismatch',
      migrationId: '0001_add_interviews',
      message: 'An applied migration differs from the checked-in migration file.',
    });
    expect(output).not.toContain('checksum-secret');
  });

  it('does not expose an SQL error, cause, or unsafe migration identifier', () => {
    const output = formatMigrationFailure(
      new DatabaseMigrationError(
        'migration_execution_failed',
        'SQL failed with password sql-secret',
        'unsafe-id:sql-secret',
        new Error('postgresql://admin:sql-secret@database/app'),
      ),
    );

    expect(readDiagnostic(output)).toEqual({
      code: 'migration_execution_failed',
      migrationId: null,
      message: 'A database migration could not be applied.',
    });
    expect(output).not.toContain('sql-secret');
    expect(output).not.toContain('postgresql://');
    expect(output).not.toContain('stack');
    expect(output).not.toContain('cause');
  });

  it('uses a generic diagnostic for unknown failures without exposing their content', () => {
    const output = formatMigrationFailure(
      new Error('unknown-secret at postgresql://admin:unknown-secret@database/app'),
    );

    expect(readDiagnostic(output)).toEqual({
      code: 'unknown_error',
      migrationId: null,
      message: 'An unexpected database migration error occurred.',
    });
    expect(output).not.toContain('unknown-secret');
    expect(output).not.toContain('postgresql://');
  });
});

function readDiagnostic(output: string): unknown {
  const separator = ': ';
  const jsonStart = output.indexOf(separator);
  if (jsonStart === -1) {
    throw new Error('Migration diagnostic did not contain structured JSON');
  }
  return JSON.parse(output.slice(jsonStart + separator.length)) as unknown;
}
