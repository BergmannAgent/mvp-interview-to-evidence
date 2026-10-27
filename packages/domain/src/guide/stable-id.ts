type GuideEntityKind = 'guide' | 'section' | 'main-question' | 'follow-up';

export const STABLE_GUIDE_ID_VERSION = 'v1' as const;

export function normalizeGuideIdentityPart(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

export function createStableGuideEntityId(
  kind: GuideEntityKind,
  hierarchy: readonly string[],
  occurrence: number,
): string {
  const identity = [
    STABLE_GUIDE_ID_VERSION,
    kind,
    ...hierarchy.map(normalizeGuideIdentityPart),
    String(occurrence),
  ].join('\u001f');

  return `${kind}:${STABLE_GUIDE_ID_VERSION}:${hashIdentity(identity)}`;
}

function hashIdentity(identity: string): string {
  const first = fnv1a(identity, 0x811c9dc5);
  const second = fnv1a(identity, 0x9e3779b9);

  return `${toHashPart(first)}${toHashPart(second)}`;
}

function fnv1a(value: string, seed: number): number {
  let hash = seed;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return hash >>> 0;
}

function toHashPart(value: number): string {
  return value.toString(36).padStart(7, '0');
}
