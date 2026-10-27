import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DatabaseMigrationError,
  loadSqlMigrations,
  runSqlMigrations,
  type MigrationClient,
  type MigrationPool,
  type MigrationQueryResult,
} from './migration-runner.js';

interface RecordedQuery {
  readonly sql: string;
  readonly parameters: readonly unknown[] | undefined;
}

class FakeMigrationClient implements MigrationClient {
  public readonly queries: RecordedQuery[] = [];
  public appliedRows: readonly unknown[] = [];
  public migrationTableExists = false;
  public appSchemaExists = false;
  public failingSql: string | undefined;
  public released = false;
  public destroyed = false;

  public async query(sql: string, parameters?: readonly unknown[]): Promise<MigrationQueryResult> {
    this.queries.push({ sql, parameters });
    if (sql === this.failingSql) {
      throw new Error('injected migration failure');
    }
    if (sql.startsWith('SELECT id, checksum')) {
      return { rows: this.appliedRows, rowCount: this.appliedRows.length };
    }
    if (sql.includes("to_regclass('app.__drizzle_migrations')")) {
      return {
        rows: [{ relation: this.migrationTableExists ? 'app.__drizzle_migrations' : null }],
        rowCount: 1,
      };
    }
    if (sql.includes("to_regnamespace('app')")) {
      return { rows: [{ schema_name: this.appSchemaExists ? 'app' : null }], rowCount: 1 };
    }
    if (sql.includes('pg_advisory_unlock')) {
      return { rows: [{ unlocked: true }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  public release(destroy = false): void {
    this.released = true;
    this.destroyed = destroy;
  }
}

class FakeMigrationPool implements MigrationPool {
  public constructor(public readonly client: FakeMigrationClient) {}

  public async connect(): Promise<MigrationClient> {
    return this.client;
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('SQL migration loading', () => {
  it('loads the committed bootstrap migration that owns the app schema', async () => {
    const migrations = await loadSqlMigrations(new URL('../../../drizzle/', import.meta.url));

    expect(migrations[0]).toMatchObject({ order: 0, id: '0000_initial_app_schema' });
    expect(migrations[0]?.sql).toContain('CREATE SCHEMA "app";');
  });

  it('loads checked-in migration naming order and stable SHA-256 checksums', async () => {
    const directory = await migrationDirectory({
      '0001_second.sql': 'CREATE TABLE app.second (id text PRIMARY KEY);\n',
      '0000_first.sql': 'CREATE TABLE app.first (id text PRIMARY KEY);\n',
    });

    const migrations = await loadSqlMigrations(directory);

    expect(migrations.map((migration) => migration.id)).toEqual(['0000_first', '0001_second']);
    expect(migrations[0]?.checksum).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(migrations)).toBe(true);
  });

  it('rejects invalid names, duplicate orders, and empty SQL', async () => {
    const invalidName = await migrationDirectory({ 'initial.sql': 'SELECT 1;' });
    await expect(loadSqlMigrations(invalidName)).rejects.toMatchObject({
      code: 'invalid_migration_file',
    });

    const duplicateOrder = await migrationDirectory({
      '0000_first.sql': 'SELECT 1;',
      '0000_second.sql': 'SELECT 2;',
    });
    await expect(loadSqlMigrations(duplicateOrder)).rejects.toMatchObject({
      code: 'invalid_migration_file',
    });

    const missingOrder = await migrationDirectory({
      '0000_first.sql': 'SELECT 1;',
      '0002_third.sql': 'SELECT 3;',
    });
    await expect(loadSqlMigrations(missingOrder)).rejects.toMatchObject({
      code: 'invalid_migration_file',
    });

    const empty = await migrationDirectory({ '0000_empty.sql': '  \n' });
    await expect(loadSqlMigrations(empty)).rejects.toMatchObject({
      code: 'invalid_migration_file',
    });

    const noSql = await migrationDirectory({ 'README.md': 'No migrations here.' });
    await expect(loadSqlMigrations(noSql)).rejects.toMatchObject({
      code: 'invalid_migration_file',
    });
  });
});

describe('SQL migration execution', () => {
  it('holds one advisory lock and commits each pending migration with its checksum', async () => {
    const migrationSql = 'CREATE TABLE app.example (id text PRIMARY KEY);\n';
    const directory = await migrationDirectory({ '0000_initial.sql': migrationSql });
    const client = new FakeMigrationClient();

    const result = await runSqlMigrations(new FakeMigrationPool(client), directory);
    const statements = client.queries.map((query) => query.sql);

    expect(result).toEqual({
      appliedMigrationIds: ['0000_initial'],
      previouslyAppliedMigrationIds: [],
    });
    expect(statements[0]).toContain('pg_advisory_lock');
    expect(statements).toEqual(expect.arrayContaining(['BEGIN', migrationSql, 'COMMIT']));
    expect(statements.indexOf('BEGIN')).toBeLessThan(statements.indexOf(migrationSql));
    expect(statements.indexOf(migrationSql)).toBeLessThan(statements.indexOf('COMMIT'));
    expect(client.queries.find((query) => query.sql.startsWith('INSERT INTO'))?.parameters).toEqual(
      ['0000_initial', expect.stringMatching(/^[a-f0-9]{64}$/u)],
    );
    expect(statements.at(-1)).toContain('pg_advisory_unlock');
    expect(client.released).toBe(true);
    expect(client.destroyed).toBe(false);
  });

  it('skips an unchanged applied prefix and refuses a changed applied migration', async () => {
    const directory = await migrationDirectory({ '0000_initial.sql': 'SELECT 1;\n' });
    const [migration] = await loadSqlMigrations(directory);
    expect(migration).toBeDefined();

    const unchangedClient = new FakeMigrationClient();
    unchangedClient.migrationTableExists = true;
    unchangedClient.appliedRows = [{ id: migration!.id, checksum: migration!.checksum }];
    const unchanged = await runSqlMigrations(new FakeMigrationPool(unchangedClient), directory);
    expect(unchanged.previouslyAppliedMigrationIds).toEqual(['0000_initial']);
    expect(unchangedClient.queries.map((query) => query.sql)).not.toContain('BEGIN');

    await writeFile(join(directory, '0000_initial.sql'), 'SELECT 2;\n', 'utf8');
    const changedClient = new FakeMigrationClient();
    changedClient.migrationTableExists = true;
    changedClient.appliedRows = [{ id: migration!.id, checksum: migration!.checksum }];

    await expect(
      runSqlMigrations(new FakeMigrationPool(changedClient), directory),
    ).rejects.toMatchObject({
      code: 'migration_checksum_mismatch',
      migrationId: '0000_initial',
    });
    expect(changedClient.queries.map((query) => query.sql)).not.toContain('BEGIN');
    expect(changedClient.queries.at(-1)?.sql).toContain('pg_advisory_unlock');
    expect(changedClient.released).toBe(true);
  });

  it('applies only migrations after an unchanged stored prefix', async () => {
    const nextMigrationSql = 'ALTER TABLE app.example ADD COLUMN version integer;\n';
    const directory = await migrationDirectory({
      '0000_initial.sql': 'CREATE TABLE app.example (id text PRIMARY KEY);\n',
      '0001_next.sql': nextMigrationSql,
    });
    const migrations = await loadSqlMigrations(directory);
    const client = new FakeMigrationClient();
    client.migrationTableExists = true;
    client.appliedRows = [{ id: migrations[0]!.id, checksum: migrations[0]!.checksum }];

    await expect(runSqlMigrations(new FakeMigrationPool(client), directory)).resolves.toEqual({
      appliedMigrationIds: ['0001_next'],
      previouslyAppliedMigrationIds: ['0000_initial'],
    });
    expect(client.queries.map((query) => query.sql)).toContain(nextMigrationSql);
    expect(client.queries.filter((query) => query.sql === 'BEGIN')).toHaveLength(1);
  });

  it('rolls back a failed migration before unlocking and reports its identity', async () => {
    const migrationSql = 'CREATE TABLE app.failure (id text PRIMARY KEY);\n';
    const directory = await migrationDirectory({ '0000_failure.sql': migrationSql });
    const client = new FakeMigrationClient();
    client.migrationTableExists = true;
    client.failingSql = migrationSql;

    let failure: unknown;
    try {
      await runSqlMigrations(new FakeMigrationPool(client), directory);
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(DatabaseMigrationError);
    expect(failure).toMatchObject({
      code: 'migration_execution_failed',
      migrationId: '0000_failure',
    });
    const statements = client.queries.map((query) => query.sql);
    expect(statements).toContain('ROLLBACK');
    expect(statements).not.toContain('COMMIT');
    expect(statements.indexOf('ROLLBACK')).toBeLessThan(
      statements.findIndex((statement) => statement.includes('pg_advisory_unlock')),
    );
    expect(client.released).toBe(true);
  });

  it('rejects non-prefix history while still releasing the advisory lock', async () => {
    const directory = await migrationDirectory({
      '0000_initial.sql': 'SELECT 1;\n',
      '0001_next.sql': 'SELECT 2;\n',
    });
    const migrations = await loadSqlMigrations(directory);
    const client = new FakeMigrationClient();
    client.migrationTableExists = true;
    client.appliedRows = [{ id: migrations[1]!.id, checksum: migrations[1]!.checksum }];

    await expect(runSqlMigrations(new FakeMigrationPool(client), directory)).rejects.toMatchObject({
      code: 'invalid_migration_history',
    });
    expect(client.queries.at(-1)?.sql).toContain('pg_advisory_unlock');
    expect(client.released).toBe(true);
  });

  it('refuses to adopt an existing app schema without migration metadata', async () => {
    const directory = await migrationDirectory({ '0000_initial.sql': 'SELECT 1;\n' });
    const client = new FakeMigrationClient();
    client.appSchemaExists = true;

    await expect(runSqlMigrations(new FakeMigrationPool(client), directory)).rejects.toMatchObject({
      code: 'invalid_migration_history',
    });
    expect(client.queries.map((query) => query.sql)).not.toContain('BEGIN');
    expect(client.queries.at(-1)?.sql).toContain('pg_advisory_unlock');
  });
});

async function migrationDirectory(files: Readonly<Record<string, string>>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'orgscience-migrations-'));
  temporaryDirectories.push(directory);
  await Promise.all(
    Object.entries(files).map(([fileName, content]) =>
      writeFile(join(directory, fileName), content, 'utf8'),
    ),
  );
  return directory;
}
