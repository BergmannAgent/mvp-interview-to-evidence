import { z } from 'zod';

import { modelMetadataSchema } from './monitoring.js';
import { organizationalResilienceRubricSchema } from './organizational-resilience-evaluation.js';
import {
  profileEvaluationExportFormatSchema,
  profileEvaluationExportQuerySchema,
  profileEvaluationFailureSchema,
  profileEvaluationReportSchema,
  profileEvaluationSnapshotResponseSchema,
  profileEvaluationSnapshotSchema,
  profileEvaluationStartRequestSchema,
} from './profile-evaluation.js';
import {
  idSchema,
  nonBlankTextSchema,
  shortRationaleSchema,
  timestampSchema,
} from './primitives.js';

export const EVALUATION_SCHEMA_VERSION = 1 as const;
export const EVALUATION_RUN_STALE_AFTER_MS = 5 * 60 * 1_000;

export const EVALUATION_LIMITS = Object.freeze({
  maximumItems: 500,
  maximumGuideQuestionsPerItem: 100,
  maximumEvidenceReferencesPerItem: 50,
  maximumMissingInformationEntries: 50,
});

export const likertScoreSchema = z.number().int().min(1).max(5);
export const evaluationConfidenceSchema = z.number().min(0).max(1);
export const evaluationFingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/u);

const rubricAnchorLabelSchema = nonBlankTextSchema.max(120);
const rubricAnchorDescriptionSchema = nonBlankTextSchema.max(1_000);

function rubricAnchorSchema<Score extends 1 | 2 | 3 | 4 | 5>(score: Score) {
  return z.strictObject({
    score: z.literal(score),
    label: rubricAnchorLabelSchema,
    description: rubricAnchorDescriptionSchema,
  });
}

export const evaluationRubricItemSchema = z.strictObject({
  itemId: idSchema,
  label: nonBlankTextSchema.max(200),
  construct: nonBlankTextSchema.max(300),
  codingInstruction: nonBlankTextSchema.max(2_000),
  guideQuestionIds: z
    .array(idSchema)
    .min(1)
    .max(EVALUATION_LIMITS.maximumGuideQuestionsPerItem)
    .refine((ids) => new Set(ids).size === ids.length, 'Guide question references must be unique'),
  anchors: z.tuple([
    rubricAnchorSchema(1),
    rubricAnchorSchema(2),
    rubricAnchorSchema(3),
    rubricAnchorSchema(4),
    rubricAnchorSchema(5),
  ]),
});

export const evaluationRubricSchema = z
  .strictObject({
    schemaVersion: z.literal(EVALUATION_SCHEMA_VERSION),
    rubricId: idSchema,
    guideId: idSchema,
    version: z.number().int().positive(),
    title: nonBlankTextSchema.max(300),
    description: nonBlankTextSchema.max(2_000),
    scale: z.strictObject({
      kind: z.literal('ordinal_1_5'),
      minimum: z.literal(1),
      maximum: z.literal(5),
    }),
    items: z.array(evaluationRubricItemSchema).min(1).max(EVALUATION_LIMITS.maximumItems),
  })
  .superRefine((rubric, context) => {
    const itemIds = new Set<string>();
    for (const [index, item] of rubric.items.entries()) {
      if (itemIds.has(item.itemId)) {
        context.addIssue({
          code: 'custom',
          path: ['items', index, 'itemId'],
          message: 'Rubric item IDs must be unique',
        });
      }
      itemIds.add(item.itemId);
    }
  });

const verbatimEvidenceExcerptSchema = nonBlankTextSchema
  .max(2_000)
  .refine(
    (excerpt) => excerpt === excerpt.trim(),
    'Evidence excerpts must not contain boundary whitespace',
  );

export const evaluationEvidenceReferenceSchema = z.strictObject({
  turnId: idSchema,
  sequenceNumber: z.number().int().positive(),
  verbatimExcerpt: verbatimEvidenceExcerptSchema,
});

const evidenceReferencesSchema = z
  .array(evaluationEvidenceReferenceSchema)
  .max(EVALUATION_LIMITS.maximumEvidenceReferencesPerItem)
  .refine(
    (references) =>
      new Set(
        references.map((reference) => `${reference.turnId}\u0000${reference.verbatimExcerpt}`),
      ).size === references.length,
    'An item may not repeat the same verbatim evidence excerpt',
  );

const missingInformationSchema = z
  .array(nonBlankTextSchema.max(500))
  .max(EVALUATION_LIMITS.maximumMissingInformationEntries);

const evaluationItemResultBaseShape = {
  itemId: idSchema,
  confidence: evaluationConfidenceSchema,
  rationale: shortRationaleSchema,
};

export const scoredEvaluationItemResultSchema = z.strictObject({
  ...evaluationItemResultBaseShape,
  status: z.literal('scored'),
  score: likertScoreSchema,
  evidence: evidenceReferencesSchema.min(1),
  missingInformation: missingInformationSchema,
});

export const insufficientEvidenceItemResultSchema = z.strictObject({
  ...evaluationItemResultBaseShape,
  status: z.literal('insufficient_evidence'),
  score: z.null(),
  evidence: evidenceReferencesSchema,
  missingInformation: missingInformationSchema.min(1),
});

export const evaluationItemResultSchema = z.union([
  scoredEvaluationItemResultSchema,
  insufficientEvidenceItemResultSchema,
]);

const evaluationItemsSchema = z
  .array(evaluationItemResultSchema)
  .min(1)
  .max(EVALUATION_LIMITS.maximumItems)
  .refine(
    (items) => new Set(items.map((item) => item.itemId)).size === items.length,
    'Evaluation output may contain each rubric item at most once',
  );

const evaluationCodingOutputShape = {
  items: evaluationItemsSchema,
  rationale: shortRationaleSchema,
};

export const evaluationCodingOutputSchema = z.strictObject(evaluationCodingOutputShape);

export const legacyEvaluationReportSchema = z.strictObject({
  schemaVersion: z.literal(EVALUATION_SCHEMA_VERSION),
  evaluationId: idSchema,
  interviewId: idSchema,
  guideId: idSchema,
  rubricId: idSchema,
  rubricVersion: z.number().int().positive(),
  rubricFingerprint: evaluationFingerprintSchema,
  transcriptFingerprint: evaluationFingerprintSchema,
  promptVersion: idSchema,
  model: modelMetadataSchema,
  ...evaluationCodingOutputShape,
  evaluatedAt: timestampSchema,
});

export const evaluationReportSchema = profileEvaluationReportSchema;

export const persistedEvaluationRubricSchema = z.union([
  evaluationRubricSchema,
  organizationalResilienceRubricSchema,
]);

export const evaluationFailureSchema = profileEvaluationFailureSchema;
export const evaluationSnapshotSchema = profileEvaluationSnapshotSchema;

export const evaluationRubricImportRequestSchema = z.strictObject({
  rubric: evaluationRubricSchema,
});

export const evaluationStartRequestSchema = profileEvaluationStartRequestSchema;
export const evaluationExportFormatSchema = profileEvaluationExportFormatSchema;
export const evaluationExportQuerySchema = profileEvaluationExportQuerySchema;

export const evaluationRubricImportResponseSchema = z.strictObject({
  outcome: z.enum(['inserted', 'existing']),
  rubric: evaluationRubricSchema,
});

export const evaluationSnapshotResponseSchema = profileEvaluationSnapshotResponseSchema;

export type LikertScore = z.infer<typeof likertScoreSchema>;
export type EvaluationRubricItem = z.infer<typeof evaluationRubricItemSchema>;
export type EvaluationRubric = z.infer<typeof evaluationRubricSchema>;
export type PersistedEvaluationRubric = z.infer<typeof persistedEvaluationRubricSchema>;
export type EvaluationEvidenceReference = z.infer<typeof evaluationEvidenceReferenceSchema>;
export type ScoredEvaluationItemResult = z.infer<typeof scoredEvaluationItemResultSchema>;
export type InsufficientEvidenceItemResult = z.infer<typeof insufficientEvidenceItemResultSchema>;
export type EvaluationItemResult = z.infer<typeof evaluationItemResultSchema>;
export type EvaluationCodingOutput = z.infer<typeof evaluationCodingOutputSchema>;
export type LegacyEvaluationReport = z.infer<typeof legacyEvaluationReportSchema>;
export type EvaluationReport = z.infer<typeof evaluationReportSchema>;
export type EvaluationFailure = z.infer<typeof evaluationFailureSchema>;
export type EvaluationSnapshot = z.infer<typeof evaluationSnapshotSchema>;
export type EvaluationRubricImportRequest = z.infer<typeof evaluationRubricImportRequestSchema>;
export type EvaluationStartRequest = z.infer<typeof evaluationStartRequestSchema>;
export type EvaluationExportFormat = z.infer<typeof evaluationExportFormatSchema>;
