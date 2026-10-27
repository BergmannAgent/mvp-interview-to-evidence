import { describe, expect, it } from 'vitest';

import {
  EVALUATION_PROFILE_LIMITS,
  evaluationProfileContentSchema,
  evaluationProfileDocumentSchema,
  evaluationProfileSchema,
} from '../src/evaluation-profile.js';

const NOW = '2026-08-21T09:00:00.000Z';

function content() {
  return {
    name: 'Operational capability',
    description: 'A guide-independent example profile.',
    coderPrompt: 'Assess each item against the supplied evidence and anchors.',
    scale: { minimum: 1 as const, maximum: 7 as const },
    dimensions: [
      { dimensionId: 'delivery', name: 'Delivery', order: 0 },
      { dimensionId: 'learning', name: 'Learning', order: 1 },
    ],
    items: [
      {
        itemId: 'delivery-01',
        dimensionId: 'delivery',
        name: 'Reliable delivery',
        codingInstruction: 'Assess how reliably work is delivered.',
        order: 0,
        anchors: anchors(),
      },
      {
        itemId: 'learning-01',
        dimensionId: 'learning',
        name: 'Learning loops',
        codingInstruction: 'Assess whether experience changes future practice.',
        order: 0,
        anchors: anchors(),
      },
    ],
  };
}

function anchors() {
  return [1, 2, 3, 4, 5, 6, 7].map((score) => ({
    score,
    criterion: `Observable criterion for score ${String(score)}`,
  }));
}

describe('evaluation profile contracts', () => {
  it('accepts arbitrary dimensions and exactly seven ordered anchors', () => {
    const parsed = evaluationProfileContentSchema.parse(content());
    expect(parsed.items[0]?.anchors.map(({ score }) => score)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('rejects missing scores, duplicate IDs, unknown dimensions, and ambiguous ordering', () => {
    expect(evaluationProfileContentSchema.safeParse({ ...content(), dimensions: [] }).success).toBe(
      false,
    );
    expect(evaluationProfileContentSchema.safeParse({ ...content(), items: [] }).success).toBe(
      false,
    );

    const missingAnchor = structuredClone(content());
    missingAnchor.items[0]?.anchors.pop();
    expect(evaluationProfileContentSchema.safeParse(missingAnchor).success).toBe(false);

    const duplicateScore = structuredClone(content());
    duplicateScore.items[0]!.anchors[1]!.score = 1;
    expect(evaluationProfileContentSchema.safeParse(duplicateScore).success).toBe(false);

    const duplicateDimension = structuredClone(content());
    duplicateDimension.dimensions[1]!.dimensionId = 'delivery';
    expect(evaluationProfileContentSchema.safeParse(duplicateDimension).success).toBe(false);

    const unknownDimension = structuredClone(content());
    unknownDimension.items[0]!.dimensionId = 'unknown';
    expect(evaluationProfileContentSchema.safeParse(unknownDimension).success).toBe(false);

    const invalidOrder = structuredClone(content());
    invalidOrder.items[0]!.order = 4;
    expect(evaluationProfileContentSchema.safeParse(invalidOrder).success).toBe(false);

    const interleaved = structuredClone(content());
    interleaved.items.push({
      ...structuredClone(interleaved.items[0]!),
      itemId: 'delivery-02',
      order: 1,
    });
    expect(evaluationProfileContentSchema.safeParse(interleaved).success).toBe(false);

    const duplicateItem = structuredClone(content());
    duplicateItem.items[1]!.itemId = 'delivery-01';
    expect(evaluationProfileContentSchema.safeParse(duplicateItem).success).toBe(false);

    const invalidScore = structuredClone(content());
    invalidScore.items[0]!.anchors[3]!.score = 3.5;
    expect(evaluationProfileContentSchema.safeParse(invalidScore).success).toBe(false);

    for (const score of [0, 8]) {
      const outsideScale = structuredClone(content());
      outsideScale.items[0]!.anchors[0]!.score = score;
      expect(evaluationProfileContentSchema.safeParse(outsideScale).success).toBe(false);
    }
  });

  it('rejects guide, locale, model, and editable system fields', () => {
    for (const forbiddenField of [
      'guideId',
      'locale',
      'model',
      'provider',
      'apiKey',
      'temperature',
      'timeout',
      'retry',
      'systemPrompt',
      'guardrails',
    ]) {
      expect(
        evaluationProfileContentSchema.safeParse({
          ...content(),
          [forbiddenField]: 'forbidden',
        }).success,
      ).toBe(false);
    }

    const guideBoundItem = content();
    expect(
      evaluationProfileContentSchema.safeParse({
        ...guideBoundItem,
        items: [{ ...guideBoundItem.items[0], guideQuestionIds: ['question-1'] }],
      }).success,
    ).toBe(false);
  });

  it('validates profile timestamps and the portable JSON document', () => {
    expect(
      evaluationProfileSchema.safeParse({
        profileId: 'profile-example',
        ...content(),
        isDefault: false,
        createdAt: NOW,
        updatedAt: NOW,
      }).success,
    ).toBe(true);
    expect(
      evaluationProfileDocumentSchema.safeParse({
        schemaVersion: 1,
        profile: { profileId: 'profile-example', ...content(), description: undefined },
      }).success,
    ).toBe(true);

    const invalidDocument = content();
    invalidDocument.items[0]!.dimensionId = 'not-present';
    expect(
      evaluationProfileDocumentSchema.safeParse({
        schemaVersion: 1,
        profile: { profileId: 'profile-example', ...invalidDocument },
      }).success,
    ).toBe(false);
  });

  it('keeps profile IDs independent from HTTP route names', () => {
    for (const profileId of ['guardrails', 'template.json', 'imports']) {
      expect(
        evaluationProfileDocumentSchema.safeParse({
          schemaVersion: 1,
          profile: { profileId, ...content() },
        }).success,
      ).toBe(true);
    }
  });

  it('accepts v2 weights and formulas without adding omitted defaults to legacy profiles', () => {
    const legacy = evaluationProfileContentSchema.parse(content());
    expect(legacy).not.toHaveProperty('calculation');
    expect(legacy.dimensions[0]).not.toHaveProperty('weight');
    expect(legacy.items[0]).not.toHaveProperty('weight');
    const current = {
      profileId: 'weighted',
      ...content(),
      calculation: {
        mode: 'formula',
        expression: 'item("delivery-01") + dimensionWeight("learning")',
      },
      dimensions: content().dimensions.map((dimension) => ({ ...dimension, weight: 2 })),
      items: content().items.map((item) => ({ ...item, weight: 0.5 })),
    };
    expect(evaluationProfileDocumentSchema.parse({ schemaVersion: 2, profile: current })).toEqual({
      schemaVersion: 2,
      profile: current,
    });
    expect(
      evaluationProfileDocumentSchema.safeParse({ schemaVersion: 1, profile: current }).success,
    ).toBe(false);
    expect(
      evaluationProfileDocumentSchema.safeParse({
        schemaVersion: 2,
        profile: { ...current, calculation: { mode: 'formula', expression: 'item("removed")' } },
      }).success,
    ).toBe(false);
  });

  it('rejects negative or non-finite weights and reports a stable formula-error path', () => {
    for (const weight of [-1, Infinity, NaN]) {
      expect(
        evaluationProfileContentSchema.safeParse({
          ...content(),
          dimensions: content().dimensions.map((dimension) => ({ ...dimension, weight })),
        }).success,
      ).toBe(false);
      expect(
        evaluationProfileContentSchema.safeParse({
          ...content(),
          items: content().items.map((item) => ({ ...item, weight })),
        }).success,
      ).toBe(false);
    }
    const invalid = evaluationProfileContentSchema.safeParse({
      ...content(),
      calculation: { mode: 'formula', expression: 'item("unknown")' },
    });
    expect(invalid.success).toBe(false);
    if (!invalid.success) {
      expect(invalid.error.issues).toContainEqual(
        expect.objectContaining({
          path: ['calculation', 'expression'],
          params: { calculationErrorCode: 'unknown_reference' },
        }),
      );
    }
  });

  it('uses the same transport-safe byte projection before and after persistence', () => {
    const nearLimit = contentWithSerializedBytes(
      EVALUATION_PROFILE_LIMITS.maximumSerializedBytes - 32,
    );
    expect(JSON.stringify(nearLimit).length).toBe(
      EVALUATION_PROFILE_LIMITS.maximumSerializedBytes - 32,
    );
    expect(evaluationProfileContentSchema.safeParse(nearLimit).success).toBe(true);
    expect(
      evaluationProfileDocumentSchema.safeParse({
        schemaVersion: 1,
        profile: { profileId: 'p'.repeat(128), ...nearLimit },
      }).success,
    ).toBe(true);
    expect(
      evaluationProfileSchema.safeParse({
        profileId: 'p'.repeat(128),
        ...nearLimit,
        isDefault: false,
        createdAt: NOW,
        updatedAt: NOW,
      }).success,
    ).toBe(true);

    const oversized = structuredClone(nearLimit);
    oversized.items[499]!.anchors[6]!.criterion += 'x'.repeat(64);
    const parsedOversized = evaluationProfileContentSchema.safeParse(oversized);
    expect(parsedOversized.success).toBe(false);
    if (!parsedOversized.success) {
      expect(parsedOversized.error.issues).toContainEqual(
        expect.objectContaining({
          code: 'custom',
          message: expect.stringContaining('maximum byte size'),
        }),
      );
    }
  });
});

function contentWithSerializedBytes(targetBytes: number) {
  const escapedCriterion = '\\'.repeat(2_400);
  const candidate = {
    ...content(),
    dimensions: [{ dimensionId: 'large', name: 'Large dimension', order: 0 }],
    items: Array.from({ length: 500 }, (_, order) => ({
      itemId: `large-${String(order)}`,
      dimensionId: 'large',
      name: `Large item ${String(order)}`,
      codingInstruction: escapedCriterion,
      order,
      anchors: [1, 2, 3, 4, 5, 6, 7].map((score) => ({
        score,
        criterion: escapedCriterion,
      })),
    })),
  };
  let remaining = targetBytes - JSON.stringify(candidate).length;
  if (remaining < 0) throw new Error('Boundary fixture base exceeds its target');

  for (const item of candidate.items) {
    const instructionGrowth = Math.min(4_000 - item.codingInstruction.length, remaining);
    item.codingInstruction += 'x'.repeat(instructionGrowth);
    remaining -= instructionGrowth;
    for (const anchor of item.anchors) {
      const anchorGrowth = Math.min(4_000 - anchor.criterion.length, remaining);
      anchor.criterion += 'x'.repeat(anchorGrowth);
      remaining -= anchorGrowth;
    }
    if (remaining === 0) break;
  }
  if (remaining !== 0) throw new Error('Boundary fixture cannot reach its target');
  return candidate;
}
