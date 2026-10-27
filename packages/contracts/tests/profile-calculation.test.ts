import { describe, expect, it } from 'vitest';

import {
  PROFILE_CALCULATION_LIMITS,
  calculateProfileScores,
  evaluationProfileWeightSchema,
  profileCalculationResultSchema,
  resolveProfileCalculation,
  validateProfileFormula,
  type ProfileCalculationInput,
} from '../src/index.js';

function profile(): ProfileCalculationInput {
  return {
    dimensions: [{ dimensionId: 'a' }, { dimensionId: 'b' }],
    items: [
      { itemId: 'a1', dimensionId: 'a' },
      { itemId: 'a2', dimensionId: 'a' },
      { itemId: 'b1', dimensionId: 'b' },
    ],
  };
}

function formula(expression: string): ProfileCalculationInput {
  return { ...profile(), calculation: { mode: 'formula', expression } };
}

describe('profile calculation', () => {
  it.each(['constructor', 'toString', 'hasOwnProperty'])(
    'treats inherited %s properties as missing scores',
    (itemId) => {
      const input = { dimensions: [{ dimensionId: 'a' }], items: [{ itemId, dimensionId: 'a' }] };
      const result = calculateProfileScores(input, {});
      expect(result.overallAggregate.score).toBeNull();
      expect(result.calculation.status).toBe('not_calculated');
      expect(profileCalculationResultSchema.safeParse(result.calculation).success).toBe(true);
      expect(calculateProfileScores(input, { [itemId]: 6 }).overallAggregate.score).toBe(6);
      expect(
        calculateProfileScores(
          { ...input, calculation: { mode: 'formula', expression: `item("${itemId}")` } },
          {},
        ).overallAggregate.score,
      ).toBe(0);
    },
  );

  it('preserves the legacy flat mean with unequal dimension sizes and omitted defaults', () => {
    const input = profile();
    const result = calculateProfileScores(input, { a1: 6, a2: 6, b1: 2 });

    expect(resolveProfileCalculation(input)).toEqual({ mode: 'weighted_mean' });
    expect(result.overallAggregate.score).toBe(4.67);
    expect(result.dimensions.map((dimension) => dimension.aggregate.score)).toEqual([6, 2]);
    expect(result.calculation.weightedSum).toBe(14);
    expect(result.calculation.weightSum).toBe(3);
    expect(input).not.toHaveProperty('calculation');
    expect(input.items.every((item) => !('weight' in item))).toBe(true);
    expect(profileCalculationResultSchema.parse(result.calculation)).toEqual(result.calculation);
  });

  it('multiplies dimension and item weights overall but uses only item weights within a dimension', () => {
    const input: ProfileCalculationInput = {
      ...profile(),
      dimensions: [
        { dimensionId: 'a', weight: 2 },
        { dimensionId: 'b', weight: 1 },
      ],
      items: [
        { itemId: 'a1', dimensionId: 'a', weight: 1 },
        { itemId: 'a2', dimensionId: 'a', weight: 3 },
        { itemId: 'b1', dimensionId: 'b', weight: 1 },
      ],
    };
    const result = calculateProfileScores(
      input,
      new Map([
        ['a1', 6],
        ['a2', 2],
        ['b1', 4],
      ]),
    );

    expect(result.overallAggregate.score).toBe(3.11);
    expect(result.dimensions.map((dimension) => dimension.aggregate.score)).toEqual([3, 4]);
    expect(result.calculation.items.map((item) => item.effectiveWeight)).toEqual([2, 6, 1]);
    expect(result.calculation.weightedSum).toBe(28);
    expect(result.calculation.weightSum).toBe(9);
  });

  it('excludes missing values and renormalizes the remaining positive weights', () => {
    const result = calculateProfileScores(profile(), { a1: 6, a2: null, b1: undefined });

    expect(result.overallAggregate).toEqual({
      status: 'partial',
      score: 6,
      scoredItemCount: 1,
      unscoredItemCount: 2,
      totalItemCount: 3,
    });
    expect(result.calculation.items.map((item) => item.exclusion)).toEqual([
      null,
      'missing_score',
      'missing_score',
    ]);
    expect(result.calculation.weightSum).toBe(1);
    expect(result.dimensions[1]?.aggregate.score).toBeNull();
  });

  it('reports source coverage separately when all scored items have zero effective weight', () => {
    const input: ProfileCalculationInput = {
      ...profile(),
      dimensions: [
        { dimensionId: 'a', weight: 0 },
        { dimensionId: 'b', weight: 0 },
      ],
    };
    const result = calculateProfileScores(input, { a1: 6, a2: 2, b1: 4 });

    expect(result.overallAggregate).toEqual({
      status: 'complete',
      score: null,
      scoredItemCount: 3,
      unscoredItemCount: 0,
      totalItemCount: 3,
    });
    expect(result.calculation.status).toBe('not_calculated');
    expect(result.calculation.error).toBeNull();
    expect(result.dimensions.map((dimension) => dimension.aggregate.score)).toEqual([4, 4]);
    expect(result.calculation.items.every((item) => item.exclusion === 'zero_weight')).toBe(true);
  });

  it('excludes zero item weights from dimension means as well as the overall mean', () => {
    const input = profile();
    const result = calculateProfileScores(
      {
        ...input,
        items: input.items.map((item) => ({ ...item, weight: item.itemId === 'a1' ? 0 : 1 })),
      },
      { a1: 7, a2: 2, b1: 4 },
    );

    expect(result.overallAggregate.score).toBe(3);
    expect(result.dimensions[0]?.aggregate.score).toBe(2);
    expect(result.overallAggregate.scoredItemCount).toBe(3);
  });

  it('uses missing values as zero only in custom formulas', () => {
    const result = calculateProfileScores(formula('(item("a1") + item("a2")) / 2'), {
      a1: 6,
      a2: null,
    });

    expect(result.overallAggregate.score).toBe(3);
    expect(result.overallAggregate.scoredItemCount).toBe(1);
    expect(result.calculation.references).toEqual([
      { function: 'item', id: 'a1', value: 6, zeroSubstituted: false },
      { function: 'item', id: 'a2', value: 0, zeroSubstituted: true },
    ]);
    expect(result.calculation.items[1]?.score).toBeNull();
  });

  it('allows explicit zero and constants when no source item has a score', () => {
    const missing = calculateProfileScores(formula('item("a1") + dimension("b")'), {});
    const constant = calculateProfileScores(formula('12'), {});

    expect(missing.overallAggregate.status).toBe('not_scored');
    expect(missing.overallAggregate.score).toBe(0);
    expect(missing.calculation.status).toBe('calculated');
    expect(missing.calculation.references.every((reference) => reference.zeroSubstituted)).toBe(
      true,
    );
    expect(constant.overallAggregate.score).toBe(12);
    expect(constant.calculation.references).toEqual([]);
  });

  it('applies dimension weights in a formula only when explicitly referenced', () => {
    const input: ProfileCalculationInput = {
      ...formula('dimension("a") + itemWeight("a1") + dimensionWeight("a")'),
      dimensions: [
        { dimensionId: 'a', weight: 0 },
        { dimensionId: 'b', weight: 8 },
      ],
      items: [
        { itemId: 'a1', dimensionId: 'a', weight: 2 },
        { itemId: 'a2', dimensionId: 'a', weight: 1 },
        { itemId: 'b1', dimensionId: 'b' },
      ],
    };
    const result = calculateProfileScores(input, { a1: 6, a2: 3, b1: 7 });

    expect(result.overallAggregate.score).toBe(7);
    expect(result.calculation.references.map((reference) => reference.value)).toEqual([5, 2, 0]);
    expect(result.calculation.references.every((reference) => !reference.zeroSubstituted)).toBe(
      true,
    );
  });

  it('keeps dimension and other intermediate values unrounded', () => {
    const input: ProfileCalculationInput = {
      calculation: { mode: 'formula', expression: 'dimension("a") * 3' },
      dimensions: [{ dimensionId: 'a' }],
      items: ['a1', 'a2', 'a3'].map((itemId) => ({ itemId, dimensionId: 'a' })),
    };
    const result = calculateProfileScores(input, { a1: 1, a2: 2, a3: 2 });

    expect(result.dimensions[0]?.aggregate.score).toBe(1.67);
    expect(result.overallAggregate.score).toBe(5);
    expect(result.calculation.references[0]?.value).toBe(5 / 3);
    expect(calculateProfileScores(formula('1 / 3'), {}).overallAggregate.score).toBe(0.33);
  });

  it.each([
    ['min(8, max(2, 4)) + abs(-3)', 7],
    ['pow(3, 2) + sqrt(16) + round(1.6)', 15],
    ['-(4 % 3) + +2 * 3 / 2', 2],
    ['-100', -100],
    ['1e308', 1e308],
  ])(
    'evaluates approved arithmetic %s with unrestricted finite results',
    (expression, expected) => {
      const result = calculateProfileScores(formula(expression), {});
      expect(result.overallAggregate.score).toBe(expected);
      expect(profileCalculationResultSchema.safeParse(result.calculation).success).toBe(true);
    },
  );

  it.each([
    ['item("a1") / 0', 'division_by_zero'],
    ['6 % 0', 'division_by_zero'],
    ['sqrt(-1)', 'non_finite_result'],
    ['pow(1e308, 2)', 'non_finite_result'],
  ])('retains item scores and source coverage when %s fails', (expression, code) => {
    const result = calculateProfileScores(formula(expression), { a1: 6, a2: 2, b1: 4 });
    expect(result.calculation.status).toBe('error');
    expect(result.calculation.error?.code).toBe(code);
    expect(result.overallAggregate.score).toBeNull();
    expect(result.overallAggregate.status).toBe('complete');
    expect(result.overallAggregate.scoredItemCount).toBe(3);
    expect(result.calculation.items.map((item) => item.score)).toEqual([6, 2, 4]);
    expect(result.dimensions.map((dimension) => dimension.aggregate.score)).toEqual([4, 4]);
    expect(profileCalculationResultSchema.safeParse(result.calculation).success).toBe(true);
  });

  it.each([
    'globalThis',
    'eval("1")',
    'Function("return 1")()',
    'Math.max(1,2)',
    'item("a1").constructor',
    'item["constructor"]("a1")',
    '({a: 1})',
    '[1,2]',
    '1;2',
    '1,2',
    '1 > 0',
    '1 && 2',
    'true',
    'null',
    '"text"',
    '!1',
    '1 ** 2',
    'item(item("a1"))',
    'item("a1", "a2")',
    'min()',
    'sqrt(1,2)',
    'pow(2)',
    'round(1,2)',
  ])('rejects unapproved syntax %s without executing it', (expression) => {
    expect(validateProfileFormula(formula(expression))?.code).toBe('invalid_formula');
  });

  it.each(['item', 'dimension', 'itemWeight', 'dimensionWeight'])(
    'rejects unknown stable IDs in %s()',
    (name) => {
      expect(validateProfileFormula(formula(`${name}("unknown")`))?.code).toBe('unknown_reference');
    },
  );

  it('enforces expression length, syntax node, and depth limits before execution', () => {
    expect(
      validateProfileFormula(
        formula('1'.padEnd(PROFILE_CALCULATION_LIMITS.maximumExpressionLength + 1)),
      )?.code,
    ).toBe('formula_too_long');
    expect(
      validateProfileFormula(formula(`max(${Array.from({ length: 4_095 }, () => '1').join(',')})`))
        ?.code,
    ).toBe('formula_too_complex');
    expect(validateProfileFormula(formula('-'.repeat(64) + '1'))?.code).toBe('formula_too_deep');
    expect(validateProfileFormula(formula('-'.repeat(63) + '1'))).toBeNull();
    expect(validateProfileFormula(formula('('.repeat(65) + '1' + ')'.repeat(65)))?.code).toBe(
      'formula_too_deep',
    );
    expect(validateProfileFormula(formula('-'.repeat(19_999) + '1'))).not.toBeNull();
  });

  it('rejects non-finite and negative weights and non-integer source scores', () => {
    for (const weight of [-1, NaN, Infinity, -Infinity]) {
      expect(evaluationProfileWeightSchema.safeParse(weight).success).toBe(false);
    }
    for (const weight of [0, 1, 0.25, Number.MAX_VALUE]) {
      expect(evaluationProfileWeightSchema.safeParse(weight).success).toBe(true);
    }
    expect(calculateProfileScores(profile(), { a1: 1.5 }).calculation.error?.code).toBe(
      'invalid_score',
    );
  });

  it('returns a controlled arithmetic error for overflowing effective weights', () => {
    const input: ProfileCalculationInput = {
      dimensions: [{ dimensionId: 'a', weight: Number.MAX_VALUE }],
      items: [{ itemId: 'a1', dimensionId: 'a', weight: Number.MAX_VALUE }],
    };
    const result = calculateProfileScores(input, { a1: 7 });
    expect(result.calculation.error?.code).toBe('non_finite_result');
    expect(result.calculation.items[0]?.effectiveWeight).toBeNull();
    expect(result.calculation.items[0]?.score).toBe(7);
    expect(profileCalculationResultSchema.safeParse(result.calculation).success).toBe(true);
  });

  it('does not mislabel an underflowed positive weight as a configured zero exclusion', () => {
    const input: ProfileCalculationInput = {
      dimensions: [{ dimensionId: 'a', weight: Number.MIN_VALUE }],
      items: [{ itemId: 'a1', dimensionId: 'a', weight: Number.MIN_VALUE }],
    };
    const result = calculateProfileScores(input, { a1: 7 });
    expect(result.calculation.error?.code).toBe('non_finite_result');
    expect(result.calculation.items[0]?.effectiveWeight).toBeNull();
    expect(result.calculation.items[0]?.included).toBe(true);
    expect(result.calculation.items[0]?.exclusion).toBeNull();
    expect(result.overallAggregate.scoredItemCount).toBe(1);
  });
});
