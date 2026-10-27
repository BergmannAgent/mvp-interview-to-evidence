import { describe, expect, it, vi } from 'vitest';

import {
  checkDatabaseReadiness,
  REQUIRED_APPLICATION_SCHEMA_VERSION,
  type DatabaseReadinessQueryPort,
} from './readiness.js';

describe('database readiness', () => {
  it('is ready only when the application schema metadata is exactly current', async () => {
    const query = vi.fn<DatabaseReadinessQueryPort['query']>().mockResolvedValue({
      rows: [{ version: REQUIRED_APPLICATION_SCHEMA_VERSION }],
    });

    await expect(checkDatabaseReadiness({ query })).resolves.toBe('ready');
    expect(query).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith({
      text: expect.stringContaining('"app"."schema_metadata"'),
      values: ['application'],
      query_timeout: 2_000,
    });
  });

  it.each([
    { label: 'missing metadata', rows: [] },
    {
      label: 'old schema',
      rows: [{ version: REQUIRED_APPLICATION_SCHEMA_VERSION - 1 }],
    },
    {
      label: 'future schema',
      rows: [{ version: REQUIRED_APPLICATION_SCHEMA_VERSION + 1 }],
    },
    {
      label: 'invalid version representation',
      rows: [{ version: String(REQUIRED_APPLICATION_SCHEMA_VERSION) }],
    },
    {
      label: 'ambiguous metadata',
      rows: [
        { version: REQUIRED_APPLICATION_SCHEMA_VERSION },
        { version: REQUIRED_APPLICATION_SCHEMA_VERSION },
      ],
    },
  ])('is not ready for $label', async ({ rows }) => {
    const query = vi.fn<DatabaseReadinessQueryPort['query']>().mockResolvedValue({ rows });

    await expect(checkDatabaseReadiness({ query })).resolves.toBe('not_ready');
  });

  it('contains connection and query failures without exposing error details', async () => {
    const secret = 'database-password-that-must-not-escape';
    const query = vi
      .fn<DatabaseReadinessQueryPort['query']>()
      .mockRejectedValue(new Error(`connection failed for ${secret}`));

    const result = await checkDatabaseReadiness({ query });

    expect(result).toBe('not_ready');
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('returns not ready within the configured deadline when the query never settles', async () => {
    vi.useFakeTimers();
    try {
      const query = vi.fn<DatabaseReadinessQueryPort['query']>(() => new Promise(() => undefined));
      const result = checkDatabaseReadiness({ query }, 250);

      await vi.advanceTimersByTimeAsync(250);

      await expect(result).resolves.toBe('not_ready');
      expect(query).toHaveBeenCalledWith(expect.objectContaining({ query_timeout: 250 }));
    } finally {
      vi.useRealTimers();
    }
  });
});
