import { describe, expect, it } from 'vitest';

import { resolveCanonicalIngressTiming } from './canonical-ingress-timing.js';

const RECEIVED_AT = '2026-09-04T13:51:29.199Z';

describe('canonical ingress timing', () => {
  it('caps a provider timestamp ahead of the backend receipt clock', () => {
    expect(
      resolveCanonicalIngressTiming(
        '2026-09-04T13:51:29.224Z',
        RECEIVED_AT,
        '2026-09-04T13:51:28.900Z',
      ),
    ).toEqual({ occurredAt: RECEIVED_AT, resolvedAt: RECEIVED_AT });
  });

  it('preserves an earlier provider timestamp while resolving at server receipt', () => {
    expect(
      resolveCanonicalIngressTiming(
        '2026-09-04T13:51:29.100Z',
        RECEIVED_AT,
        '2026-09-04T13:51:29.000Z',
      ),
    ).toEqual({
      occurredAt: '2026-09-04T13:51:29.100Z',
      resolvedAt: RECEIVED_AT,
    });
  });

  it('keeps legacy transcript ordering when the previous canonical entry is later', () => {
    const previousOccurredAt = '2026-09-04T13:51:30.000Z';

    expect(
      resolveCanonicalIngressTiming('2026-09-04T13:51:29.100Z', RECEIVED_AT, previousOccurredAt),
    ).toEqual({
      occurredAt: previousOccurredAt,
      resolvedAt: previousOccurredAt,
    });
  });
});
