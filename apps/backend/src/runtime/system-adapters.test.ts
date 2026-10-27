import { createHash } from 'node:crypto';

import { timestampSchema } from '@orgscience/contracts';
import { describe, expect, it } from 'vitest';

import { NodeSha256, SystemClock } from './system-adapters.js';

describe('backend system adapters', () => {
  it('provides contract-valid UTC timestamps with millisecond precision', () => {
    expect(timestampSchema.safeParse(new SystemClock().now()).success).toBe(true);
  });

  it('hashes the exact UTF-8 input as lowercase SHA-256', () => {
    const input = 'Interviewantwort mit Umlaut und Emoji \ud83d\ude00';
    expect(new NodeSha256().digestUtf8(input)).toBe(
      createHash('sha256').update(input, 'utf8').digest('hex'),
    );
  });
});
