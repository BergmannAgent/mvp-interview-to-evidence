import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as backend from './index.js';

const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url));
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
  readonly exports?: unknown;
};

describe('backend public surface', () => {
  it('exports only application-level runtime helpers', () => {
    expect(Object.keys(backend).sort()).toEqual(['failure', 'success']);
  });

  it('allows only the package root and blocks infrastructure deep imports', () => {
    expect(packageJson.exports).toEqual({
      '.': {
        types: './dist/index.d.ts',
        default: './dist/index.js',
      },
    });
  });
});
