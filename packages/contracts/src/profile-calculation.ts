import jsep from 'jsep';
import { z } from 'zod';

import { idSchema, nonBlankTextSchema } from './primitives.js';

export const PROFILE_CALCULATION_LIMITS = Object.freeze({
  maximumExpressionLength: 20_000,
  maximumAstNodes: 4_096,
  maximumAstDepth: 64,
});

export const evaluationProfileWeightSchema = z.number().finite().nonnegative();
export const evaluationProfileCalculationSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('weighted_mean') }),
  z.strictObject({
    mode: z.literal('formula'),
    expression: nonBlankTextSchema.max(PROFILE_CALCULATION_LIMITS.maximumExpressionLength),
  }),
]);

export const profileCalculationErrorCodeSchema = z.enum([
  'invalid_formula',
  'unknown_reference',
  'formula_too_long',
  'formula_too_complex',
  'formula_too_deep',
  'division_by_zero',
  'non_finite_result',
  'invalid_score',
]);
export const profileCalculationErrorSchema = z.strictObject({
  code: profileCalculationErrorCodeSchema,
  message: nonBlankTextSchema.max(1_000),
});

export const profileCalculationAggregateSchema = z
  .strictObject({
    status: z.enum(['complete', 'partial', 'not_scored']),
    score: z.number().finite().nullable(),
    scoredItemCount: z.number().int().nonnegative(),
    unscoredItemCount: z.number().int().nonnegative(),
    totalItemCount: z.number().int().positive(),
  })
  .superRefine((aggregate, context) => {
    if (aggregate.scoredItemCount + aggregate.unscoredItemCount !== aggregate.totalItemCount) {
      context.addIssue({
        code: 'custom',
        path: ['totalItemCount'],
        message: 'Aggregate item counts must add up to the total',
      });
    }
    const expectedStatus =
      aggregate.scoredItemCount === 0
        ? 'not_scored'
        : aggregate.unscoredItemCount === 0
          ? 'complete'
          : 'partial';
    if (aggregate.status !== expectedStatus) {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'Aggregate status must match its scored and unscored counts',
      });
    }
  });

export const profileCalculationItemTraceSchema = z.strictObject({
  itemId: idSchema,
  dimensionId: idSchema,
  score: z.number().int().min(1).max(7).nullable(),
  itemWeight: evaluationProfileWeightSchema,
  dimensionWeight: evaluationProfileWeightSchema,
  effectiveWeight: evaluationProfileWeightSchema.nullable(),
  included: z.boolean(),
  exclusion: z.enum(['missing_score', 'zero_weight']).nullable(),
});
export const profileCalculationDimensionTraceSchema = z.strictObject({
  dimensionId: idSchema,
  weight: evaluationProfileWeightSchema,
  result: z.number().finite().nullable(),
  unroundedResult: z.number().finite().nullable(),
  weightedSum: z.number().finite().nullable(),
  weightSum: evaluationProfileWeightSchema.nullable(),
});
export const profileCalculationReferenceTraceSchema = z.strictObject({
  function: z.enum(['item', 'dimension', 'itemWeight', 'dimensionWeight']),
  id: idSchema,
  value: z.number().finite(),
  zeroSubstituted: z.boolean(),
});
export const profileCalculationResultSchema = z.strictObject({
  mode: z.enum(['weighted_mean', 'formula']),
  status: z.enum(['calculated', 'not_calculated', 'error']),
  result: z.number().finite().nullable(),
  unroundedResult: z.number().finite().nullable(),
  expression: z.string().max(PROFILE_CALCULATION_LIMITS.maximumExpressionLength).nullable(),
  error: profileCalculationErrorSchema.nullable(),
  items: z.array(profileCalculationItemTraceSchema).max(500),
  dimensions: z.array(profileCalculationDimensionTraceSchema).max(50),
  references: z
    .array(profileCalculationReferenceTraceSchema)
    .max(PROFILE_CALCULATION_LIMITS.maximumAstNodes),
  weightedSum: z.number().finite().nullable(),
  weightSum: evaluationProfileWeightSchema.nullable(),
});

export type EvaluationProfileCalculation = z.infer<typeof evaluationProfileCalculationSchema>;
export type ProfileCalculationErrorCode = z.infer<typeof profileCalculationErrorCodeSchema>;
export type ProfileCalculationError = z.infer<typeof profileCalculationErrorSchema>;
export type ProfileCalculationAggregate = z.infer<typeof profileCalculationAggregateSchema>;
export type ProfileCalculationItemTrace = z.infer<typeof profileCalculationItemTraceSchema>;
export type ProfileCalculationDimensionTrace = z.infer<
  typeof profileCalculationDimensionTraceSchema
>;
export type ProfileCalculationReferenceTrace = z.infer<
  typeof profileCalculationReferenceTraceSchema
>;
export type ProfileCalculationResult = z.infer<typeof profileCalculationResultSchema>;

export interface ProfileCalculationInput {
  readonly calculation?: EvaluationProfileCalculation | undefined;
  readonly dimensions: readonly {
    readonly dimensionId: string;
    readonly weight?: number | undefined;
  }[];
  readonly items: readonly {
    readonly itemId: string;
    readonly dimensionId: string;
    readonly weight?: number | undefined;
  }[];
}

export interface ProfileCalculatedScores {
  dimensions: { dimensionId: string; aggregate: ProfileCalculationAggregate }[];
  overallAggregate: ProfileCalculationAggregate;
  calculation: ProfileCalculationResult;
}

type ReferenceFunction = ProfileCalculationReferenceTrace['function'];
type MathFunction = 'min' | 'max' | 'abs' | 'pow' | 'sqrt' | 'round';
type FormulaNode =
  | { type: 'number'; value: number }
  | { type: 'unary'; operator: '+' | '-'; argument: FormulaNode }
  | {
      type: 'binary';
      operator: '+' | '-' | '*' | '/' | '%';
      left: FormulaNode;
      right: FormulaNode;
    }
  | { type: 'reference'; function: ReferenceFunction; id: string }
  | { type: 'math'; function: MathFunction; arguments: FormulaNode[] };

class CalculationFailure extends Error {
  constructor(readonly detail: ProfileCalculationError) {
    super(detail.message);
  }
}

function fail(code: ProfileCalculationErrorCode, message: string): never {
  throw new CalculationFailure({ code, message });
}

export function resolveProfileCalculation(
  profile: Pick<ProfileCalculationInput, 'calculation'>,
): EvaluationProfileCalculation {
  return profile.calculation ?? { mode: 'weighted_mean' };
}

export function validateProfileFormula(
  profile: ProfileCalculationInput,
): ProfileCalculationError | null {
  const configuration = resolveProfileCalculation(profile);
  if (configuration.mode === 'weighted_mean') return null;
  try {
    parseFormula(configuration.expression, profile);
    return null;
  } catch (error) {
    return calculationError(error);
  }
}

function parseFormula(expression: string, profile: ProfileCalculationInput): FormulaNode {
  if (expression.length > PROFILE_CALCULATION_LIMITS.maximumExpressionLength) {
    fail('formula_too_long', 'The formula exceeds 20,000 characters.');
  }
  if (expression.trim().length === 0) fail('invalid_formula', 'A formula is required.');

  // Limit parser recursion before parsing; quoted stable IDs do not contribute to nesting.
  let nesting = 0;
  let quote: string | null = null;
  let escaped = false;
  for (const character of expression) {
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === '(' || character === '[') {
      nesting += 1;
      if (nesting > PROFILE_CALCULATION_LIMITS.maximumAstDepth) {
        fail('formula_too_deep', 'The formula exceeds 64 levels of nesting.');
      }
    } else if (character === ')' || character === ']') nesting -= 1;
  }

  let parsed: jsep.Expression;
  try {
    parsed = jsep(expression);
  } catch (error) {
    if (error instanceof RangeError) {
      fail('formula_too_deep', 'The formula exceeds 64 levels of nesting.');
    }
    fail('invalid_formula', 'The formula has invalid mathematical syntax.');
  }
  const pending = [{ node: parsed, depth: 1 }];
  let count = 0;
  while (pending.length > 0) {
    const entry = pending.pop()!;
    count += 1;
    if (count > PROFILE_CALCULATION_LIMITS.maximumAstNodes) {
      fail('formula_too_complex', 'The formula exceeds 4,096 syntax nodes.');
    }
    if (entry.depth > PROFILE_CALCULATION_LIMITS.maximumAstDepth) {
      fail('formula_too_deep', 'The formula exceeds 64 levels of nesting.');
    }
    const children = nodeChildren(entry.node);
    for (const node of children) pending.push({ node, depth: entry.depth + 1 });
  }
  return normalizeNode(parsed, profile);
}

function nodeChildren(node: jsep.Expression): jsep.Expression[] {
  switch (node.type) {
    case 'Literal':
    case 'Identifier':
      return [];
    case 'UnaryExpression':
      return [(node as jsep.UnaryExpression).argument];
    case 'BinaryExpression': {
      const binary = node as jsep.BinaryExpression;
      return [binary.left, binary.right];
    }
    case 'CallExpression': {
      const call = node as jsep.CallExpression;
      return [call.callee, ...call.arguments];
    }
    default:
      fail('invalid_formula', 'Only numeric arithmetic and approved functions are allowed.');
  }
}

function normalizeNode(node: jsep.Expression, profile: ProfileCalculationInput): FormulaNode {
  if (node.type === 'Literal') {
    const value = (node as jsep.Literal).value;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      fail('invalid_formula', 'Only finite numeric literals are allowed outside references.');
    }
    return { type: 'number', value };
  }
  if (node.type === 'UnaryExpression') {
    const unary = node as jsep.UnaryExpression;
    if (unary.operator !== '+' && unary.operator !== '-') {
      fail('invalid_formula', 'Only unary plus and minus are allowed.');
    }
    return {
      type: 'unary',
      operator: unary.operator,
      argument: normalizeNode(unary.argument, profile),
    };
  }
  if (node.type === 'BinaryExpression') {
    const binary = node as jsep.BinaryExpression;
    if (
      binary.operator !== '+' &&
      binary.operator !== '-' &&
      binary.operator !== '*' &&
      binary.operator !== '/' &&
      binary.operator !== '%'
    ) {
      fail('invalid_formula', 'Only +, -, *, /, and % are allowed.');
    }
    return {
      type: 'binary',
      operator: binary.operator,
      left: normalizeNode(binary.left, profile),
      right: normalizeNode(binary.right, profile),
    };
  }
  if (node.type !== 'CallExpression') {
    fail('invalid_formula', 'Only numeric arithmetic and approved functions are allowed.');
  }
  const call = node as jsep.CallExpression;
  if (call.callee.type !== 'Identifier') {
    fail('invalid_formula', 'Object access and dynamic function calls are forbidden.');
  }
  const name = (call.callee as jsep.Identifier).name;
  if (
    name === 'item' ||
    name === 'dimension' ||
    name === 'itemWeight' ||
    name === 'dimensionWeight'
  ) {
    const argument = call.arguments[0];
    if (
      call.arguments.length !== 1 ||
      argument?.type !== 'Literal' ||
      typeof (argument as jsep.Literal).value !== 'string'
    ) {
      fail('invalid_formula', 'Reference functions require one quoted stable ID.');
    }
    const id = (argument as jsep.Literal).value as string;
    const exists =
      name === 'item' || name === 'itemWeight'
        ? profile.items.some((item) => item.itemId === id)
        : profile.dimensions.some((dimension) => dimension.dimensionId === id);
    if (!exists)
      fail('unknown_reference', 'The formula references an unknown item or dimension ID.');
    return { type: 'reference', function: name, id };
  }
  if (
    name !== 'min' &&
    name !== 'max' &&
    name !== 'abs' &&
    name !== 'pow' &&
    name !== 'sqrt' &&
    name !== 'round'
  ) {
    fail('invalid_formula', 'The formula calls an unapproved function.');
  }
  const validCount =
    name === 'min' || name === 'max'
      ? call.arguments.length >= 1
      : call.arguments.length === (name === 'pow' ? 2 : 1);
  if (!validCount) fail('invalid_formula', 'A mathematical function has the wrong argument count.');
  return {
    type: 'math',
    function: name,
    arguments: call.arguments.map((argument) => normalizeNode(argument, profile)),
  };
}

function calculationError(error: unknown): ProfileCalculationError {
  return error instanceof CalculationFailure
    ? error.detail
    : { code: 'invalid_formula', message: 'The formula has invalid mathematical syntax.' };
}

function finite(value: number): number {
  if (!Number.isFinite(value))
    fail('non_finite_result', 'The calculation produced a non-finite value.');
  return value;
}

function roundResult(value: number): number {
  const rounded = Math.abs(value) > Number.MAX_VALUE / 100 ? value : Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function aggregate(
  scores: readonly (number | null)[],
  score: number | null,
): ProfileCalculationAggregate {
  const scoredItemCount = scores.filter((value) => value !== null).length;
  return {
    status:
      scoredItemCount === 0
        ? 'not_scored'
        : scoredItemCount === scores.length
          ? 'complete'
          : 'partial',
    score,
    scoredItemCount,
    unscoredItemCount: scores.length - scoredItemCount,
    totalItemCount: scores.length,
  };
}

export function calculateProfileScores(
  profile: ProfileCalculationInput,
  scoresByItem:
    ReadonlyMap<string, number | null> | Readonly<Record<string, number | null | undefined>>,
): ProfileCalculatedScores {
  const configuration = resolveProfileCalculation(profile);
  const scoreAt = (id: string): number | null => {
    const value =
      scoresByItem instanceof Map
        ? scoresByItem.get(id)
        : Object.hasOwn(scoresByItem, id)
          ? (scoresByItem as Readonly<Record<string, number | null | undefined>>)[id]
          : undefined;
    return value ?? null;
  };
  const dimensionsById = new Map(
    profile.dimensions.map((dimension) => [dimension.dimensionId, dimension]),
  );
  const items: ProfileCalculationItemTrace[] = profile.items.map((item) => {
    const score = scoreAt(item.itemId);
    const itemWeight = item.weight ?? 1;
    const dimensionWeight = dimensionsById.get(item.dimensionId)?.weight ?? 1;
    const zeroWeight = itemWeight === 0 || dimensionWeight === 0;
    const effectiveWeight = zeroWeight ? 0 : itemWeight * dimensionWeight;
    return {
      itemId: item.itemId,
      dimensionId: item.dimensionId,
      score,
      itemWeight,
      dimensionWeight,
      effectiveWeight:
        Number.isFinite(effectiveWeight) && (zeroWeight || effectiveWeight > 0)
          ? effectiveWeight
          : null,
      included: score !== null && !zeroWeight,
      exclusion: score === null ? 'missing_score' : zeroWeight ? 'zero_weight' : null,
    };
  });
  let error: ProfileCalculationError | null = null;
  if (
    items.some(
      (item) =>
        item.score !== null && (!Number.isInteger(item.score) || item.score < 1 || item.score > 7),
    )
  ) {
    error = {
      code: 'invalid_score',
      message: 'Item scores must be integers from 1 through 7 or missing.',
    };
  }
  const dimensionTraces: ProfileCalculationDimensionTrace[] = profile.dimensions.map(
    (dimension) => {
      const contributions = items.filter(
        (item) =>
          item.dimensionId === dimension.dimensionId && item.score !== null && item.itemWeight > 0,
      );
      const weightSum = contributions.reduce((sum, item) => sum + item.itemWeight, 0);
      const weightedSum = contributions.reduce(
        (sum, item) => sum + item.score! * item.itemWeight,
        0,
      );
      const unroundedResult =
        weightSum > 0 && Number.isFinite(weightedSum) && Number.isFinite(weightSum)
          ? weightedSum / weightSum
          : null;
      return {
        dimensionId: dimension.dimensionId,
        weight: dimension.weight ?? 1,
        result: unroundedResult === null ? null : roundResult(unroundedResult),
        unroundedResult,
        weightedSum: Number.isFinite(weightedSum) ? weightedSum : null,
        weightSum: Number.isFinite(weightSum) ? weightSum : null,
      };
    },
  );
  const references: ProfileCalculationReferenceTrace[] = [];
  let unroundedResult: number | null = null;
  let weightedSum: number | null = null;
  let weightSum: number | null = null;
  if (error === null) {
    try {
      if (configuration.mode === 'weighted_mean') {
        const contributions = items.filter((item) => item.included);
        if (contributions.some((item) => item.effectiveWeight === null)) finite(Infinity);
        weightSum = finite(contributions.reduce((sum, item) => sum + item.effectiveWeight!, 0));
        weightedSum = finite(
          contributions.reduce((sum, item) => sum + item.score! * item.effectiveWeight!, 0),
        );
        unroundedResult = weightSum === 0 ? null : finite(weightedSum / weightSum);
      } else {
        const formula = parseFormula(configuration.expression, profile);
        const itemById = new Map(items.map((item) => [item.itemId, item]));
        const dimensionById = new Map(
          dimensionTraces.map((dimension) => [dimension.dimensionId, dimension]),
        );
        const reference = (name: ReferenceFunction, id: string): number => {
          let raw: number | null;
          if (name === 'item') raw = itemById.get(id)!.score;
          else if (name === 'itemWeight') raw = itemById.get(id)!.itemWeight;
          else if (name === 'dimensionWeight') raw = dimensionById.get(id)!.weight;
          else {
            const dimension = dimensionById.get(id)!;
            if (dimension.weightSum === null || dimension.weightedSum === null) finite(Infinity);
            raw = dimension.unroundedResult;
          }
          const value = finite(raw ?? 0);
          references.push({ function: name, id, value, zeroSubstituted: raw === null });
          return value;
        };
        unroundedResult = finite(evaluateFormula(formula, reference));
      }
    } catch (failure) {
      error = calculationError(failure);
      unroundedResult = null;
    }
  }
  const result = unroundedResult === null ? null : roundResult(unroundedResult);
  const calculation: ProfileCalculationResult = {
    mode: configuration.mode,
    status: error !== null ? 'error' : result === null ? 'not_calculated' : 'calculated',
    result,
    unroundedResult,
    expression: configuration.mode === 'formula' ? configuration.expression : null,
    error,
    items,
    dimensions: dimensionTraces,
    references,
    weightedSum,
    weightSum,
  };
  return {
    dimensions: dimensionTraces.map((dimension) => ({
      dimensionId: dimension.dimensionId,
      aggregate: aggregate(
        items
          .filter((item) => item.dimensionId === dimension.dimensionId)
          .map((item) => item.score),
        dimension.result,
      ),
    })),
    overallAggregate: aggregate(
      items.map((item) => item.score),
      result,
    ),
    calculation,
  };
}

function evaluateFormula(
  node: FormulaNode,
  reference: (name: ReferenceFunction, id: string) => number,
): number {
  if (node.type === 'number') return node.value;
  if (node.type === 'reference') return reference(node.function, node.id);
  if (node.type === 'unary') {
    const value = evaluateFormula(node.argument, reference);
    return finite(node.operator === '-' ? -value : value);
  }
  if (node.type === 'binary') {
    const left = evaluateFormula(node.left, reference);
    const right = evaluateFormula(node.right, reference);
    if ((node.operator === '/' || node.operator === '%') && right === 0) {
      fail('division_by_zero', 'Division or remainder by zero is undefined.');
    }
    switch (node.operator) {
      case '+':
        return finite(left + right);
      case '-':
        return finite(left - right);
      case '*':
        return finite(left * right);
      case '/':
        return finite(left / right);
      case '%':
        return finite(left % right);
    }
  }
  const arguments_ = node.arguments.map((argument) => evaluateFormula(argument, reference));
  switch (node.function) {
    case 'min':
      return finite(Math.min(...arguments_));
    case 'max':
      return finite(Math.max(...arguments_));
    case 'abs':
      return finite(Math.abs(arguments_[0]!));
    case 'pow':
      return finite(Math.pow(arguments_[0]!, arguments_[1]!));
    case 'sqrt':
      return finite(Math.sqrt(arguments_[0]!));
    case 'round':
      return finite(Math.round(arguments_[0]!));
  }
}
