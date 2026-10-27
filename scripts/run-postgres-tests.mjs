import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const postgresTestFile = 'apps/backend/src/infrastructure/database/postgres.integration.test.ts';
const vitestCli = resolve(repositoryRoot, 'node_modules/vitest/vitest.mjs');

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
if (databaseUrl === undefined || databaseUrl.length === 0) {
  process.stderr.write(
    'test:postgres requires TEST_DATABASE_URL; PostgreSQL integration tests were not started.\n',
  );
  process.exitCode = 1;
} else if (process.env.ALLOW_TEST_DATABASE_RESET !== 'true') {
  process.stderr.write(
    'test:postgres requires ALLOW_TEST_DATABASE_RESET=true; PostgreSQL integration tests were not started.\n',
  );
  process.exitCode = 1;
} else {
  const result = spawnSync(process.execPath, [vitestCli, 'run', postgresTestFile], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: 'inherit',
  });

  if (result.error !== undefined) {
    process.stderr.write('test:postgres could not start the PostgreSQL integration test runner.\n');
    process.exitCode = 1;
  } else {
    process.exitCode = result.status ?? 1;
  }
}
