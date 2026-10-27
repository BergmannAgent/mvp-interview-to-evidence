export interface CanonicalIngressTiming {
  readonly occurredAt: string;
  readonly resolvedAt: string;
}

/**
 * Keeps client/provider clocks from moving the canonical transcript into the future while
 * preserving the ordering already established by the server-owned transcript.
 */
export function resolveCanonicalIngressTiming(
  externalOccurredAt: string | undefined,
  receivedAt: string,
  notBeforeAt?: string,
): CanonicalIngressTiming {
  const boundedExternalTimestamp =
    externalOccurredAt === undefined || Date.parse(externalOccurredAt) > Date.parse(receivedAt)
      ? receivedAt
      : externalOccurredAt;
  const occurredAt =
    notBeforeAt === undefined || Date.parse(boundedExternalTimestamp) >= Date.parse(notBeforeAt)
      ? boundedExternalTimestamp
      : notBeforeAt;

  return {
    occurredAt,
    resolvedAt: Date.parse(receivedAt) >= Date.parse(occurredAt) ? receivedAt : occurredAt,
  };
}
