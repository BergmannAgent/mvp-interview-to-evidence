import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '..');
const commandPath = resolve(repositoryRoot, 'scripts/run-postgres-tests.mjs');

describe('PostgreSQL integration test command', () => {
  it('fails before starting Vitest when TEST_DATABASE_URL is missing', () => {
    const result = runCommand({
      TEST_DATABASE_URL: '',
      ALLOW_TEST_DATABASE_RESET: 'true',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('requires TEST_DATABASE_URL');
    expect(result.stderr).toContain('tests were not started');
  });

  it('fails before starting Vitest when destructive reset permission is missing', () => {
    const result = runCommand({
      TEST_DATABASE_URL: 'postgresql://postgres:secret@localhost/orgscience_test',
      ALLOW_TEST_DATABASE_RESET: '',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('requires ALLOW_TEST_DATABASE_RESET=true');
    expect(result.stderr).not.toContain('postgresql://');
    expect(result.stderr).not.toContain('secret');
  });
});

function runCommand(environment: Readonly<Record<string, string>>): {
  readonly status: number | null;
  readonly stderr: string;
} {
  const result = spawnSync(process.execPath, [commandPath], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, ...environment },
  });

  if (result.error !== undefined) {
    throw result.error;
  }
  return { status: result.status, stderr: result.stderr };
}
