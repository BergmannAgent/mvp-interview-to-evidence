import { describe, expect, it } from 'vitest';

import { frontendEntryModulesMatch } from './frontend-build.js';

describe('interview frontend build freshness', () => {
  it('distinguishes the deployed Vite entry from a stale loaded entry', () => {
    const baseHref = 'http://localhost:5273/';

    expect(
      frontendEntryModulesMatch(
        '/assets/index-current.js',
        'http://localhost:5273/assets/index-current.js',
        baseHref,
      ),
    ).toBe(true);
    expect(
      frontendEntryModulesMatch('/assets/index-stale.js', '/assets/index-current.js', baseHref),
    ).toBe(false);
  });
});
