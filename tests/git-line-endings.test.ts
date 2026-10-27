import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

import { loadSqlMigrations } from '../apps/backend/src/infrastructure/database/migration-runner.js';

it('preserves migration checksums and Bash LF endings with Windows autocrlf enabled', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const source = await loadSqlMigrations(join(root, 'apps/backend/drizzle'));
  const checkout = await mkdtemp(join(tmpdir(), 'orgscience-windows-checkout-'));
  const migrations = join(checkout, 'apps/backend/drizzle');
  const script = join(checkout, 'scripts/restore.sh');
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: checkout, stdio: 'pipe' });
  };
  try {
    await mkdir(migrations, { recursive: true });
    await mkdir(join(checkout, 'scripts'));
    await copyFile(join(root, '.gitattributes'), join(checkout, '.gitattributes'));
    for (const migration of source) {
      await copyFile(
        join(root, 'apps/backend/drizzle', migration.fileName),
        join(migrations, migration.fileName),
      );
    }
    await writeFile(script, '#!/usr/bin/env bash\nset -euo pipefail\n');
    git('init', '--quiet');
    git('config', 'core.autocrlf', 'true');
    git('config', 'core.eol', 'crlf');
    git('add', '.gitattributes', 'apps/backend/drizzle', 'scripts');
    await rm(migrations, { recursive: true });
    await rm(script);
    git('checkout-index', '--all', '--force');

    const restored = await loadSqlMigrations(migrations);
    expect(restored.map(({ id, checksum }) => ({ id, checksum }))).toEqual(
      source.map(({ id, checksum }) => ({ id, checksum })),
    );
    expect(restored.every(({ sql }) => !sql.includes('\r'))).toBe(true);
    expect(await readFile(script, 'utf8')).toBe('#!/usr/bin/env bash\nset -euo pipefail\n');
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }
});
