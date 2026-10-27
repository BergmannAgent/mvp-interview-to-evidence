import { z } from 'zod';

import {
  EVALUATION_PROFILE_LIMITS,
  evaluationProfileDocumentSchema,
} from './evaluation-profile.js';

export const EVALUATION_PROFILE_XLSX_TEMPLATE_VERSION = 2 as const;
export const EVALUATION_PROFILE_XLSX_LEGACY_TEMPLATE_VERSION = 1 as const;

export const EVALUATION_PROFILE_XLSX_MEDIA_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' as const;
export const EVALUATION_PROFILE_XLSX_FILE_EXTENSION = '.xlsx' as const;
export const EVALUATION_PROFILE_XLSX_UPLOAD_FIELD = 'file' as const;

export const EVALUATION_PROFILE_XLSX_SHEETS = Object.freeze({
  instructions: 'Instructions',
  profile: 'Profile',
  dimensions: 'Dimensions',
  items: 'Items',
  anchors: 'Anchors',
} as const);

export const EVALUATION_PROFILE_XLSX_HEADERS = Object.freeze({
  profile: Object.freeze([
    'template_version',
    'profile_id',
    'name',
    'description',
    'coder_prompt',
    'aggregation_mode',
    'custom_formula',
  ] as const),
  dimensions: Object.freeze(['dimension_id', 'name', 'order', 'weight'] as const),
  items: Object.freeze([
    'item_id',
    'dimension_id',
    'name',
    'coding_instruction',
    'order',
    'weight',
  ] as const),
  anchors: Object.freeze(['item_id', 'score', 'criterion'] as const),
} as const);

export const EVALUATION_PROFILE_XLSX_LEGACY_HEADERS = Object.freeze({
  profile: Object.freeze([
    'template_version',
    'profile_id',
    'name',
    'description',
    'coder_prompt',
  ] as const),
  dimensions: Object.freeze(['dimension_id', 'name', 'order'] as const),
  items: Object.freeze(['item_id', 'dimension_id', 'name', 'coding_instruction', 'order'] as const),
  anchors: Object.freeze(['item_id', 'score', 'criterion'] as const),
} as const);

export const EVALUATION_PROFILE_XLSX_LIMITS = Object.freeze({
  maximumFileBytes: 10 * 1024 * 1024,
  maximumFileNameLength: 255,
  maximumInstructionsRows: 100,
  maximumProfileRows: 2,
  maximumDimensionRows: EVALUATION_PROFILE_LIMITS.maximumDimensions + 1,
  maximumItemRows: EVALUATION_PROFILE_LIMITS.maximumItems + 1,
  maximumAnchorRows: EVALUATION_PROFILE_LIMITS.maximumItems * 7 + 1,
} as const);

export const evaluationProfileXlsxFileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(EVALUATION_PROFILE_XLSX_LIMITS.maximumFileNameLength)
  .refine(
    (fileName) => isPlainFileName(fileName),
    'File name must not contain paths or control characters',
  )
  .refine(
    (fileName) => fileName.toLowerCase().endsWith(EVALUATION_PROFILE_XLSX_FILE_EXTENSION),
    `File name must end with ${EVALUATION_PROFILE_XLSX_FILE_EXTENSION}`,
  );

function isPlainFileName(fileName: string): boolean {
  return (
    !fileName.includes('/') &&
    !fileName.includes('\\') &&
    [...fileName].every((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 32 && (codePoint < 127 || codePoint > 159);
    })
  );
}

export const evaluationProfileXlsxImportSourceSchema = z.strictObject({
  fileName: evaluationProfileXlsxFileNameSchema,
  templateVersion: z.union([
    z.literal(EVALUATION_PROFILE_XLSX_TEMPLATE_VERSION),
    z.literal(EVALUATION_PROFILE_XLSX_LEGACY_TEMPLATE_VERSION),
  ]),
  dimensions: z.number().int().min(1).max(EVALUATION_PROFILE_LIMITS.maximumDimensions),
  items: z.number().int().min(1).max(EVALUATION_PROFILE_LIMITS.maximumItems),
  anchors: z
    .number()
    .int()
    .min(7)
    .max(EVALUATION_PROFILE_LIMITS.maximumItems * 7),
});

export const evaluationProfileXlsxImportPreviewResponseSchema = z
  .strictObject({
    valid: z.literal(true),
    document: evaluationProfileDocumentSchema,
    source: evaluationProfileXlsxImportSourceSchema,
  })
  .superRefine((preview, context) => {
    const dimensionCount = preview.document.profile.dimensions.length;
    const itemCount = preview.document.profile.items.length;
    const anchorCount = preview.document.profile.items.reduce(
      (total, item) => total + item.anchors.length,
      0,
    );

    for (const [field, actual, expected] of [
      ['dimensions', preview.source.dimensions, dimensionCount],
      ['items', preview.source.items, itemCount],
      ['anchors', preview.source.anchors, anchorCount],
    ] as const) {
      if (actual !== expected) {
        context.addIssue({
          code: 'custom',
          path: ['source', field],
          message: `Source ${field} count must match the canonical profile document`,
        });
      }
    }
  });

export type EvaluationProfileXlsxImportSource = z.infer<
  typeof evaluationProfileXlsxImportSourceSchema
>;
export type EvaluationProfileXlsxImportPreviewResponse = z.infer<
  typeof evaluationProfileXlsxImportPreviewResponseSchema
>;
