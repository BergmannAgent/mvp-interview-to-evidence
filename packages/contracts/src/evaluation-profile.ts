import { z } from 'zod';

import { idSchema, nonBlankTextSchema, timestampSchema } from './primitives.js';
import {
  evaluationProfileCalculationSchema,
  evaluationProfileWeightSchema,
  validateProfileFormula,
  type EvaluationProfileCalculation,
} from './profile-calculation.js';

export const EVALUATION_PROFILE_DOCUMENT_SCHEMA_VERSION = 2 as const;

export const EVALUATION_PROFILE_LIMITS = Object.freeze({
  maximumDimensions: 50,
  maximumItems: 500,
  maximumNameLength: 120,
  maximumDescriptionLength: 2_000,
  maximumItemLabelLength: 300,
  maximumCodingInstructionLength: 4_000,
  maximumAnchorCriterionLength: 4_000,
  maximumCoderPromptLength: 20_000,
  maximumSerializedBytes: 19 * 1024 * 1024,
});

export const evaluationProfileScoreSchema = z.number().int().min(1).max(7);

const optionalTextSchema = (maximum: number) => z.string().trim().max(maximum);
const nameSchema = (maximum: number) => z.string().trim().min(1).max(maximum);

export const evaluationProfileDimensionSchema = z.strictObject({
  dimensionId: idSchema,
  name: nameSchema(EVALUATION_PROFILE_LIMITS.maximumNameLength),
  order: z.number().int().nonnegative(),
  weight: evaluationProfileWeightSchema.optional(),
});

function evaluationProfileAnchorSchema<Score extends 1 | 2 | 3 | 4 | 5 | 6 | 7>(score: Score) {
  return z.strictObject({
    score: z.literal(score),
    criterion: nonBlankTextSchema.max(EVALUATION_PROFILE_LIMITS.maximumAnchorCriterionLength),
  });
}

export const evaluationProfileAnchorsSchema = z.tuple([
  evaluationProfileAnchorSchema(1),
  evaluationProfileAnchorSchema(2),
  evaluationProfileAnchorSchema(3),
  evaluationProfileAnchorSchema(4),
  evaluationProfileAnchorSchema(5),
  evaluationProfileAnchorSchema(6),
  evaluationProfileAnchorSchema(7),
]);

export const evaluationProfileItemSchema = z.strictObject({
  itemId: idSchema,
  dimensionId: idSchema,
  name: nameSchema(EVALUATION_PROFILE_LIMITS.maximumItemLabelLength),
  codingInstruction: nonBlankTextSchema.max(
    EVALUATION_PROFILE_LIMITS.maximumCodingInstructionLength,
  ),
  order: z.number().int().nonnegative(),
  anchors: evaluationProfileAnchorsSchema,
  weight: evaluationProfileWeightSchema.optional(),
});

const evaluationProfileContentShape = {
  name: nameSchema(EVALUATION_PROFILE_LIMITS.maximumNameLength),
  description: optionalTextSchema(EVALUATION_PROFILE_LIMITS.maximumDescriptionLength).default(''),
  coderPrompt: nonBlankTextSchema.max(EVALUATION_PROFILE_LIMITS.maximumCoderPromptLength),
  calculation: evaluationProfileCalculationSchema.optional(),
  scale: z.strictObject({
    minimum: z.literal(1),
    maximum: z.literal(7),
  }),
  dimensions: z
    .array(evaluationProfileDimensionSchema)
    .min(1)
    .max(EVALUATION_PROFILE_LIMITS.maximumDimensions),
  items: z.array(evaluationProfileItemSchema).min(1).max(EVALUATION_PROFILE_LIMITS.maximumItems),
};

function validateProfileContent(
  profile: {
    readonly name: string;
    readonly description: string;
    readonly coderPrompt: string;
    readonly scale: { readonly minimum: 1; readonly maximum: 7 };
    readonly dimensions: readonly z.infer<typeof evaluationProfileDimensionSchema>[];
    readonly items: readonly z.infer<typeof evaluationProfileItemSchema>[];
    readonly calculation?: EvaluationProfileCalculation | undefined;
  },
  context: z.RefinementCtx,
): void {
  const dimensionIds = new Set<string>();
  for (const [index, dimension] of profile.dimensions.entries()) {
    if (dimensionIds.has(dimension.dimensionId)) {
      context.addIssue({
        code: 'custom',
        path: ['dimensions', index, 'dimensionId'],
        message: 'Dimension IDs must be unique',
      });
    }
    dimensionIds.add(dimension.dimensionId);
    if (dimension.order !== index) {
      context.addIssue({
        code: 'custom',
        path: ['dimensions', index, 'order'],
        message: 'Dimension order must match its zero-based array position',
      });
    }
  }

  const itemIds = new Set<string>();
  const nextOrderByDimension = new Map<string, number>();
  for (const [index, item] of profile.items.entries()) {
    if (itemIds.has(item.itemId)) {
      context.addIssue({
        code: 'custom',
        path: ['items', index, 'itemId'],
        message: 'Item IDs must be unique',
      });
    }
    itemIds.add(item.itemId);

    if (!dimensionIds.has(item.dimensionId)) {
      context.addIssue({
        code: 'custom',
        path: ['items', index, 'dimensionId'],
        message: 'Items must reference an existing dimension',
      });
      continue;
    }

    const expectedOrder = nextOrderByDimension.get(item.dimensionId) ?? 0;
    if (item.order !== expectedOrder) {
      context.addIssue({
        code: 'custom',
        path: ['items', index, 'order'],
        message: 'Item order must be contiguous within its dimension',
      });
    }
    nextOrderByDimension.set(item.dimensionId, expectedOrder + 1);
  }

  for (const [index, dimension] of profile.dimensions.entries()) {
    if ((nextOrderByDimension.get(dimension.dimensionId) ?? 0) === 0) {
      context.addIssue({
        code: 'custom',
        path: ['dimensions', index, 'dimensionId'],
        message: 'Every dimension must contain at least one item',
      });
    }
  }

  const canonicalItemIds = profile.dimensions.flatMap((dimension) =>
    profile.items
      .filter((item) => item.dimensionId === dimension.dimensionId)
      .toSorted((left, right) => left.order - right.order)
      .map((item) => item.itemId),
  );
  for (const [index, item] of profile.items.entries()) {
    if (canonicalItemIds[index] !== item.itemId) {
      context.addIssue({
        code: 'custom',
        path: ['items', index, 'order'],
        message: 'Items must be grouped by dimension order and then by item order',
      });
    }
  }

  const formulaError = validateProfileFormula(profile);
  if (formulaError !== null) {
    context.addIssue({
      code: 'custom',
      path: ['calculation', 'expression'],
      message: formulaError.message,
      params: { calculationErrorCode: formulaError.code },
    });
  }

  if (
    utf8ByteLength(JSON.stringify(editableContentProjection(profile))) >
    EVALUATION_PROFILE_LIMITS.maximumSerializedBytes
  ) {
    context.addIssue({
      code: 'custom',
      path: [],
      message: 'The serialized evaluation profile exceeds the maximum byte size',
    });
  }
}

function editableContentProjection(profile: {
  readonly name: string;
  readonly description: string;
  readonly coderPrompt: string;
  readonly scale: { readonly minimum: 1; readonly maximum: 7 };
  readonly dimensions: readonly z.infer<typeof evaluationProfileDimensionSchema>[];
  readonly items: readonly z.infer<typeof evaluationProfileItemSchema>[];
  readonly calculation?: EvaluationProfileCalculation | undefined;
}) {
  return {
    name: profile.name,
    description: profile.description,
    coderPrompt: profile.coderPrompt,
    scale: profile.scale,
    dimensions: profile.dimensions,
    items: profile.items,
    ...(profile.calculation === undefined ? {} : { calculation: profile.calculation }),
  };
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

export const evaluationProfileContentSchema = z
  .strictObject(evaluationProfileContentShape)
  .superRefine(validateProfileContent);

export const evaluationProfileSchema = z
  .strictObject({
    profileId: idSchema,
    ...evaluationProfileContentShape,
    isDefault: z.boolean(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .superRefine((profile, context) => {
    validateProfileContent(profile, context);
    if (Date.parse(profile.updatedAt) < Date.parse(profile.createdAt)) {
      context.addIssue({
        code: 'custom',
        path: ['updatedAt'],
        message: 'Profile update time must not predate its creation time',
      });
    }
  });

export const evaluationProfileSummarySchema = z.strictObject({
  profileId: idSchema,
  name: evaluationProfileContentShape.name,
  description: evaluationProfileContentShape.description,
  isDefault: z.boolean(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export const evaluationProfileCreateRequestSchema = z.strictObject({
  profile: evaluationProfileContentSchema,
});

export const evaluationProfileUpdateRequestSchema = z.strictObject({
  profile: evaluationProfileContentSchema,
  expectedUpdatedAt: timestampSchema,
});

export const evaluationProfileDuplicateRequestSchema = z.strictObject({
  name: nameSchema(EVALUATION_PROFILE_LIMITS.maximumNameLength),
});

export const evaluationProfileDeleteQuerySchema = z.strictObject({
  expectedUpdatedAt: timestampSchema,
});

export const evaluationProfileResponseSchema = z.strictObject({
  profile: evaluationProfileSchema,
});

export const evaluationProfileListResponseSchema = z.strictObject({
  profiles: z.array(evaluationProfileSummarySchema),
});

export const evaluationProfilePortableSchema = z
  .strictObject({
    profileId: idSchema,
    ...evaluationProfileContentShape,
  })
  .superRefine(validateProfileContent);

export const evaluationProfilePortableV1Schema = z
  .strictObject({ profileId: idSchema, ...evaluationProfileContentShape })
  .omit({ calculation: true })
  .extend({
    dimensions: z
      .array(evaluationProfileDimensionSchema.omit({ weight: true }))
      .min(1)
      .max(EVALUATION_PROFILE_LIMITS.maximumDimensions),
    items: z
      .array(evaluationProfileItemSchema.omit({ weight: true }))
      .min(1)
      .max(EVALUATION_PROFILE_LIMITS.maximumItems),
  })
  .superRefine(validateProfileContent);

export const evaluationProfileDocumentSchema = z.discriminatedUnion('schemaVersion', [
  z.strictObject({ schemaVersion: z.literal(1), profile: evaluationProfilePortableV1Schema }),
  z.strictObject({
    schemaVersion: z.literal(EVALUATION_PROFILE_DOCUMENT_SCHEMA_VERSION),
    profile: evaluationProfilePortableSchema,
  }),
]);

export const evaluationProfileImportRequestSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('create'),
    document: evaluationProfileDocumentSchema,
  }),
  z.strictObject({
    mode: z.literal('replace'),
    targetProfileId: idSchema,
    expectedUpdatedAt: timestampSchema,
    document: evaluationProfileDocumentSchema,
  }),
]);

export const evaluationProfileImportPreviewResponseSchema = z.strictObject({
  valid: z.literal(true),
  profile: evaluationProfilePortableSchema,
});

export const evaluationProfileLockedGuardrailsSchema = z.strictObject({
  evidenceSource: z.literal('final_participant_turns_only'),
  exactQuotesRequired: z.literal(true),
  validTurnReferencesRequired: z.literal(true),
  fabricatedContentForbidden: z.literal(true),
  hiddenChainOfThoughtForbidden: z.literal(true),
  structuredOutputLocked: z.literal(true),
  scoreRangeLocked: z.literal('integer_1_7_or_non_score'),
  aggregationLocked: z.literal(true),
});

export const evaluationProfileLockedGuardrailsResponseSchema = z.strictObject({
  guardrails: evaluationProfileLockedGuardrailsSchema,
});

export type EvaluationProfileScore = z.infer<typeof evaluationProfileScoreSchema>;
export type EvaluationProfileAnchor = z.infer<typeof evaluationProfileAnchorsSchema>[number];
export type EvaluationProfileDimension = z.infer<typeof evaluationProfileDimensionSchema>;
export type EvaluationProfileItem = z.infer<typeof evaluationProfileItemSchema>;
export type EvaluationProfileContent = z.infer<typeof evaluationProfileContentSchema>;
export type EvaluationProfile = z.infer<typeof evaluationProfileSchema>;
export type EvaluationProfileSummary = z.infer<typeof evaluationProfileSummarySchema>;
export type EvaluationProfilePortable = z.infer<typeof evaluationProfilePortableSchema>;
export type EvaluationProfileCreateRequest = z.infer<typeof evaluationProfileCreateRequestSchema>;
export type EvaluationProfileUpdateRequest = z.infer<typeof evaluationProfileUpdateRequestSchema>;
export type EvaluationProfileDuplicateRequest = z.infer<
  typeof evaluationProfileDuplicateRequestSchema
>;
export type EvaluationProfileDeleteQuery = z.infer<typeof evaluationProfileDeleteQuerySchema>;
export type EvaluationProfileDocument = z.infer<typeof evaluationProfileDocumentSchema>;
export type EvaluationProfileImportRequest = z.infer<typeof evaluationProfileImportRequestSchema>;
export type EvaluationProfileResponse = z.infer<typeof evaluationProfileResponseSchema>;
export type EvaluationProfileListResponse = z.infer<typeof evaluationProfileListResponseSchema>;
export type EvaluationProfileImportPreviewResponse = z.infer<
  typeof evaluationProfileImportPreviewResponseSchema
>;
export type EvaluationProfileLockedGuardrails = z.infer<
  typeof evaluationProfileLockedGuardrailsSchema
>;
export type EvaluationProfileLockedGuardrailsResponse = z.infer<
  typeof evaluationProfileLockedGuardrailsResponseSchema
>;
