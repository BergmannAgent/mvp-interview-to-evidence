import { describe, expect, it } from 'vitest';

import { compactSectionWithTimeout } from './section-memory-compactor.js';

describe('section-memory compactor boundary', () => {
  it('times out without waiting for a stalled compactor', async () => {
    const startedAt = Date.now();
    await expect(
      compactSectionWithTimeout(
        { compact: () => new Promise(() => undefined) },
        {} as Parameters<typeof compactSectionWithTimeout>[1],
        5,
      ),
    ).rejects.toThrow(/timed out/u);
    expect(Date.now() - startedAt).toBeLessThan(250);
  });

  it('rejects malformed output instead of persisting it', async () => {
    await expect(
      compactSectionWithTimeout(
        { compact: async () => ({ score: 7 }) },
        {} as Parameters<typeof compactSectionWithTimeout>[1],
        50,
      ),
    ).rejects.toThrow();
  });
});
