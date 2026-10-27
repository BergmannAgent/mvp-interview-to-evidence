import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

describe('paid Realtime simulation CLI guard', () => {
  it.each([
    { args: [] },
    { args: ['--resume', '2026-10-01T19-38-07-094Z-1cd3d41e'] },
    { args: ['--confirm-provider-calls', '--resume', '../../another-report'] },
    { args: ['--confirm-provider-calls', '--unknown'] },
  ])(
    'rejects invalid arguments before opening a backend/provider connection: $args',
    ({ args }) => {
      const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', 'scripts/run-realtime-synthetic-interview.ts', ...args],
        { encoding: 'utf8', timeout: 10_000 },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Usage:');
      expect(result.stdout).toBe('');
    },
  );
});
