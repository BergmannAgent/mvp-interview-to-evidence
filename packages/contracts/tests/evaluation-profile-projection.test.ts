import { describe, expect, it } from 'vitest';

import {
  evaluationProfileCodingDocumentOf,
  evaluationProfileContentOf,
  evaluationProfileFingerprintDocumentOf,
  evaluationProfilePortableOf,
} from '../src/evaluation-profile-projection.js';
import {
  evaluationProfileDocumentSchema,
  evaluationProfilePortableSchema,
  type EvaluationProfilePortable,
} from '../src/evaluation-profile.js';

function profile(): EvaluationProfilePortable {
  return evaluationProfilePortableSchema.parse({
    profileId: 'test-profile',
    name: 'Example',
    description: 'Test profile',
    coderPrompt: 'Use the evidence and anchors.',
    scale: { minimum: 1, maximum: 7 },
    dimensions: [{ dimensionId: 'delivery', name: 'Delivery', order: 0 }],
    items: [
      {
        itemId: 'delivery-01',
        dimensionId: 'delivery',
        name: 'Reliability',
        codingInstruction: 'Assess reliability.',
        order: 0,
        anchors: Array.from({ length: 7 }, (_, i) => ({
          score: i + 1,
          criterion: `Criterion ${String(i + 1)}`,
        })),
      },
    ],
  });
}

describe('profile boundary projections', () => {
  it('retains the exact legacy fingerprint document for implicit and explicit default weights', () => {
    const original = profile();
    const legacy = { schemaVersion: 1, profile: original };
    expect(evaluationProfileFingerprintDocumentOf(original)).toEqual(legacy);
    expect(
      evaluationProfileFingerprintDocumentOf({
        ...original,
        calculation: { mode: 'weighted_mean' },
        dimensions: original.dimensions.map((d) => ({ ...d, weight: 1 })),
        items: original.items.map((i) => ({ ...i, weight: 1 })),
      }),
    ).toEqual(legacy);
  });

  it('canonicalizes nondefault settings and distinguishes formulas from weighted averages', () => {
    const original = profile();
    const weighted = {
      ...original,
      dimensions: original.dimensions.map((d) => ({ ...d, weight: 2 })),
    };
    const document = evaluationProfileFingerprintDocumentOf(weighted);
    expect(document.schemaVersion).toBe(2);
    expect(document.profile.items[0]).toHaveProperty('weight', 1);
    expect(document).toEqual(
      evaluationProfileFingerprintDocumentOf({
        ...weighted,
        calculation: { mode: 'weighted_mean' },
        items: original.items.map((i) => ({ ...i, weight: 1 })),
      }),
    );
    expect(
      evaluationProfileFingerprintDocumentOf({
        ...original,
        calculation: { mode: 'formula', expression: 'item("delivery-01")' },
      }),
    ).not.toEqual(document);
    expect(evaluationProfileDocumentSchema.safeParse(document).success).toBe(true);
  });

  it('preserves all editable fields while stripping calculation controls from coding input', () => {
    const original = profile();
    const configured: EvaluationProfilePortable = {
      ...original,
      calculation: { mode: 'formula', expression: 'item("delivery-01") * 10' },
      dimensions: original.dimensions.map((d) => ({ ...d, weight: 3 })),
      items: original.items.map((i) => ({ ...i, weight: 0 })),
    };
    expect(evaluationProfilePortableOf(configured)).toEqual(configured);
    expect(evaluationProfileContentOf(configured)).not.toHaveProperty('profileId');
    expect(evaluationProfileContentOf(configured)).toHaveProperty(
      'calculation',
      configured.calculation,
    );
    const coding = evaluationProfileCodingDocumentOf(configured);
    expect(coding).toEqual({ schemaVersion: 1, profile: original });
    expect(evaluationProfileDocumentSchema.safeParse(coding).success).toBe(true);
  });
});
