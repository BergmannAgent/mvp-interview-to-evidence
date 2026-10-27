import { z } from 'zod';

import {
  EVALUATION_PROFILE_LIMITS,
  evaluationProfilePortableSchema,
  evaluationProfileScoreSchema,
} from './evaluation-profile.js';
import { modelMetadataSchema } from './monitoring.js';
import { DEFAULT_LOCALE, supportedLocaleSchema } from './locale.js';
import { mvpSessionStatusSchema } from './session.js';
import { idSchema, nonBlankTextSchema, timestampSchema } from './primitives.js';
import {
  calculateProfileScores,
  evaluationProfileWeightSchema,
  profileCalculationAggregateSchema,
  profileCalculationResultSchema,
} from './profile-calculation.js';

export const PROFILE_EVALUATION_REPORT_SCHEMA_VERSION = 5 as const;

export const PROFILE_EVALUATION_LIMITS = Object.freeze({
  maximumEvidenceReferencesPerBucket: 50,
  maximumMissingInformationEntries: 50,
  maximumEvidenceExcerptLength: 2_000,
  maximumEvidenceInferenceLength: 1_000,
  maximumAdditionalEvidenceSources: 10,
  maximumMissingInformationLength: 500,
  maximumItemRationaleLength: 4_000,
  maximumReportRationaleLength: 3_000,
});

const itemRationaleSchema = nonBlankTextSchema.max(
  PROFILE_EVALUATION_LIMITS.maximumItemRationaleLength,
);
const reportRationaleSchema = nonBlankTextSchema.max(
  PROFILE_EVALUATION_LIMITS.maximumReportRationaleLength,
);

export const profileEvaluationFingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const profileEvaluationTranslationMetadataSchema = z.strictObject({
  overlayId: idSchema,
  overlayVersion: nonBlankTextSchema.max(50),
  overlayFingerprintSha256: profileEvaluationFingerprintSchema,
});
export const profileEvaluationConfidenceSchema = z.number().min(0).max(1);
export const profileEvaluationItemStatusSchema = z.enum([
  'scored',
  'insufficient_evidence',
  'not_applicable',
  'conflicting',
]);

const evidenceSourceShape = {
  turnId: idSchema,
  sequenceNumber: z.number().int().positive(),
  verbatimExcerpt: nonBlankTextSchema
    .max(PROFILE_EVALUATION_LIMITS.maximumEvidenceExcerptLength)
    .refine(
      (excerpt) => excerpt === excerpt.trim(),
      'Evidence excerpts must not contain boundary whitespace',
    ),
};

export const profileEvaluationEvidenceSourceSchema = z.strictObject(evidenceSourceShape);
export const participantDetailSchema = z
  .strictObject({
    value: nonBlankTextSchema.max(300),
    source: profileEvaluationEvidenceSourceSchema,
  })
  .refine((detail) => detail.source.verbatimExcerpt.includes(detail.value), {
    path: ['value'],
    message: 'Participant details must be copied from their quoted source',
  });

export const participantDetailsSchema = z.strictObject({
  age: participantDetailSchema.nullable(),
  position: participantDetailSchema.nullable(),
});

// Historical reports retain their metadata for validation; new provider output has no types.
const profileEvaluationEvidenceTypeSchema = z.enum(['direct', 'indirect']);

const evidenceInferenceSchema = nonBlankTextSchema.max(
  PROFILE_EVALUATION_LIMITS.maximumEvidenceInferenceLength,
);
const additionalEvidenceSourcesSchema = z
  .array(profileEvaluationEvidenceSourceSchema)
  .max(PROFILE_EVALUATION_LIMITS.maximumAdditionalEvidenceSources);

type EvidenceSource = z.infer<typeof profileEvaluationEvidenceSourceSchema>;
type ClassifiedEvidenceFields = EvidenceSource & {
  evidenceType?: 'direct' | 'indirect' | undefined;
  inference?: string | null | undefined;
  additionalSources?: EvidenceSource[] | undefined;
};

function sourceKey(source: EvidenceSource): string {
  return `${source.turnId}\u0000${source.verbatimExcerpt}`;
}

function validateEvidenceClassification(
  evidence: ClassifiedEvidenceFields,
  context: z.RefinementCtx,
): void {
  if (evidence.evidenceType === 'indirect' && evidence.inference == null) {
    context.addIssue({
      code: 'custom',
      path: ['inference'],
      message: 'Indirect evidence requires a short explicit inference',
    });
  }
  if (evidence.evidenceType === 'direct' && evidence.inference != null) {
    context.addIssue({
      code: 'custom',
      path: ['inference'],
      message: 'Only indirect evidence may contain an inference',
    });
  }
  const sources = [evidence, ...(evidence.additionalSources ?? [])];
  if (new Set(sources.map(sourceKey)).size !== sources.length) {
    context.addIssue({
      code: 'custom',
      path: ['additionalSources'],
      message: 'Evidence may not repeat the same source excerpt',
    });
  }
}

export const profileEvaluationEvidenceReferenceSchema = z
  .strictObject({
    ...evidenceSourceShape,
    evidenceType: profileEvaluationEvidenceTypeSchema.optional(),
    inference: evidenceInferenceSchema.nullable().optional(),
    additionalSources: additionalEvidenceSourcesSchema.optional(),
  })
  .superRefine(validateEvidenceClassification);

export const profileEvaluationProviderEvidenceReferenceSchema = z
  .strictObject({
    ...evidenceSourceShape,
    inference: evidenceInferenceSchema.nullable(),
    additionalSources: additionalEvidenceSourcesSchema,
  })
  .superRefine((evidence, context) => {
    const sources = [evidence, ...evidence.additionalSources];
    if (new Set(sources.map(sourceKey)).size !== sources.length) {
      context.addIssue({
        code: 'custom',
        path: ['additionalSources'],
        message: 'Evidence may not repeat the same source excerpt',
      });
    }
  });

function containsUniqueEvidenceSources(references: ClassifiedEvidenceFields[]): boolean {
  return new Set(references.map(sourceKey)).size === references.length;
}

const evidenceReferencesSchema = z
  .array(profileEvaluationEvidenceReferenceSchema)
  .max(PROFILE_EVALUATION_LIMITS.maximumEvidenceReferencesPerBucket)
  .refine(
    containsUniqueEvidenceSources,
    'An evidence bucket may not repeat the same verbatim excerpt',
  );

const providerEvidenceReferencesSchema = z
  .array(profileEvaluationProviderEvidenceReferenceSchema)
  .max(PROFILE_EVALUATION_LIMITS.maximumEvidenceReferencesPerBucket)
  .refine(
    containsUniqueEvidenceSources,
    'An evidence bucket may not repeat the same verbatim excerpt',
  );

const missingInformationSchema = z
  .array(nonBlankTextSchema.max(PROFILE_EVALUATION_LIMITS.maximumMissingInformationLength))
  .max(PROFILE_EVALUATION_LIMITS.maximumMissingInformationEntries);

const itemCodingShape = {
  itemId: idSchema,
  dimensionId: idSchema,
  confidence: profileEvaluationConfidenceSchema,
  supportingEvidence: evidenceReferencesSchema,
  counterEvidence: evidenceReferencesSchema,
  missingInformation: missingInformationSchema,
  rationale: itemRationaleSchema,
};

export const scoredProfileEvaluationItemCodingSchema = z
  .strictObject({
    ...itemCodingShape,
    status: z.literal('scored'),
    score: evaluationProfileScoreSchema,
  })
  .superRefine((item, context) => {
    if (item.supportingEvidence.length + item.counterEvidence.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['supportingEvidence'],
        message: 'A numeric score requires observed supporting or counter evidence',
      });
    }
  });

export const insufficientProfileEvaluationItemCodingSchema = z.strictObject({
  ...itemCodingShape,
  status: z.literal('insufficient_evidence'),
  score: z.null(),
  missingInformation: missingInformationSchema.min(1),
});

export const notApplicableProfileEvaluationItemCodingSchema = z.strictObject({
  ...itemCodingShape,
  status: z.literal('not_applicable'),
  score: z.null(),
});

export const conflictingProfileEvaluationItemCodingSchema = z.strictObject({
  ...itemCodingShape,
  status: z.literal('conflicting'),
  score: z.null(),
  supportingEvidence: evidenceReferencesSchema.min(1),
  counterEvidence: evidenceReferencesSchema.min(1),
});

export const profileEvaluationItemCodingSchema = z.union([
  scoredProfileEvaluationItemCodingSchema,
  insufficientProfileEvaluationItemCodingSchema,
  notApplicableProfileEvaluationItemCodingSchema,
  conflictingProfileEvaluationItemCodingSchema,
]);

export const profileEvaluationCodingOutputSchema = z.strictObject({
  participantDetails: participantDetailsSchema.optional(),
  items: z
    .array(profileEvaluationItemCodingSchema)
    .min(1)
    .max(EVALUATION_PROFILE_LIMITS.maximumItems)
    .refine(
      (items) => new Set(items.map((item) => item.itemId)).size === items.length,
      'Evaluation output may contain each profile item at most once',
    ),
  rationale: reportRationaleSchema,
});

const providerEvidenceBuckets = {
  supportingEvidence: providerEvidenceReferencesSchema,
  counterEvidence: providerEvidenceReferencesSchema,
};

const providerProfileEvaluationItemCodingSchema = z.union([
  scoredProfileEvaluationItemCodingSchema.safeExtend(providerEvidenceBuckets),
  insufficientProfileEvaluationItemCodingSchema.safeExtend(providerEvidenceBuckets),
  notApplicableProfileEvaluationItemCodingSchema.safeExtend(providerEvidenceBuckets),
  conflictingProfileEvaluationItemCodingSchema.safeExtend({
    ...providerEvidenceBuckets,
    supportingEvidence: providerEvidenceReferencesSchema.min(1),
    counterEvidence: providerEvidenceReferencesSchema.min(1),
  }),
]);

// Provider output has generic evidence; persisted reports still accept historical metadata.
export const profileEvaluationProviderCodingOutputSchema =
  profileEvaluationCodingOutputSchema.safeExtend({
    participantDetails: participantDetailsSchema,
    items: z
      .array(providerProfileEvaluationItemCodingSchema)
      .min(1)
      .max(EVALUATION_PROFILE_LIMITS.maximumItems)
      .refine(
        (items) => new Set(items.map((item) => item.itemId)).size === items.length,
        'Evaluation output may contain each profile item at most once',
      ),
  });

export const profileEvaluationAppliedAnchorSchema = z.strictObject({
  score: evaluationProfileScoreSchema,
  criterion: nonBlankTextSchema.max(EVALUATION_PROFILE_LIMITS.maximumAnchorCriterionLength),
});

export const profileEvaluationAggregateSchema = profileCalculationAggregateSchema;

export const profileEvaluationReportItemSchema = z
  .strictObject({
    itemId: idSchema,
    dimensionId: idSchema,
    name: nonBlankTextSchema.max(EVALUATION_PROFILE_LIMITS.maximumItemLabelLength),
    codingInstruction: nonBlankTextSchema.max(
      EVALUATION_PROFILE_LIMITS.maximumCodingInstructionLength,
    ),
    order: z.number().int().nonnegative(),
    weight: evaluationProfileWeightSchema.optional(),
    anchors: z.tuple([
      profileEvaluationAppliedAnchorSchema.extend({ score: z.literal(1) }),
      profileEvaluationAppliedAnchorSchema.extend({ score: z.literal(2) }),
      profileEvaluationAppliedAnchorSchema.extend({ score: z.literal(3) }),
      profileEvaluationAppliedAnchorSchema.extend({ score: z.literal(4) }),
      profileEvaluationAppliedAnchorSchema.extend({ score: z.literal(5) }),
      profileEvaluationAppliedAnchorSchema.extend({ score: z.literal(6) }),
      profileEvaluationAppliedAnchorSchema.extend({ score: z.literal(7) }),
    ]),
    status: profileEvaluationItemStatusSchema,
    score: evaluationProfileScoreSchema.nullable(),
    appliedAnchor: profileEvaluationAppliedAnchorSchema.nullable(),
    confidence: profileEvaluationConfidenceSchema,
    supportingEvidence: evidenceReferencesSchema,
    counterEvidence: evidenceReferencesSchema,
    missingInformation: missingInformationSchema,
    rationale: itemRationaleSchema,
  })
  .superRefine((item, context) => {
    if (item.status === 'scored') {
      if (item.score === null || item.appliedAnchor === null) {
        context.addIssue({
          code: 'custom',
          path: ['appliedAnchor'],
          message: 'A scored report item requires its exact applied anchor',
        });
        return;
      }
      const expected = item.anchors[item.score - 1];
      if (
        expected === undefined ||
        item.appliedAnchor.score !== item.score ||
        item.appliedAnchor.criterion !== expected.criterion
      ) {
        context.addIssue({
          code: 'custom',
          path: ['appliedAnchor'],
          message: 'The applied anchor must exactly match the scored profile anchor',
        });
      }
      if (item.supportingEvidence.length + item.counterEvidence.length === 0) {
        context.addIssue({
          code: 'custom',
          path: ['supportingEvidence'],
          message: 'A numeric score requires observed supporting or counter evidence',
        });
      }
    } else if (item.score !== null || item.appliedAnchor !== null) {
      context.addIssue({
        code: 'custom',
        path: ['score'],
        message: 'A non-score status must not contain a score or applied anchor',
      });
    }
    if (item.status === 'insufficient_evidence' && item.missingInformation.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['missingInformation'],
        message: 'Insufficient evidence requires at least one missing-information entry',
      });
    }
    if (
      item.status === 'conflicting' &&
      (item.supportingEvidence.length === 0 || item.counterEvidence.length === 0)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'Conflicting evidence requires both supporting and counter evidence',
      });
    }
  });

export const profileEvaluationReportDimensionSchema = z.strictObject({
  dimensionId: idSchema,
  name: nonBlankTextSchema.max(EVALUATION_PROFILE_LIMITS.maximumNameLength),
  order: z.number().int().nonnegative(),
  weight: evaluationProfileWeightSchema.optional(),
  aggregate: profileEvaluationAggregateSchema,
  items: z.array(profileEvaluationReportItemSchema).min(1),
});

export const evaluationSourceTranscriptSchema = z.strictObject({
  interviewStatus: mvpSessionStatusSchema,
  finalized: z.boolean(),
  snapshotAt: timestampSchema,
  turnCount: z.number().int().nonnegative(),
  ignoredPartial: z.boolean(),
});

export const profileEvaluationReportSchema = z
  .strictObject({
    schemaVersion: z.literal(PROFILE_EVALUATION_REPORT_SCHEMA_VERSION),
    reportKind: z.literal('evaluation_profile_report'),
    evaluationId: idSchema,
    interviewId: idSchema,
    profileId: idSchema,
    profileName: nonBlankTextSchema.max(EVALUATION_PROFILE_LIMITS.maximumNameLength),
    profileUpdatedAt: timestampSchema,
    profileFingerprint: profileEvaluationFingerprintSchema,
    transcriptFingerprint: profileEvaluationFingerprintSchema,
    language: supportedLocaleSchema.default(DEFAULT_LOCALE),
    profileTranslation: profileEvaluationTranslationMetadataSchema.nullable().default(null),
    promptVersion: idSchema,
    model: modelMetadataSchema,
    profile: evaluationProfilePortableSchema,
    dimensions: z.array(profileEvaluationReportDimensionSchema).min(1),
    overallAggregate: profileEvaluationAggregateSchema,
    calculation: profileCalculationResultSchema,
    rationale: reportRationaleSchema,
    evaluatedAt: timestampSchema,
    sourceTranscript: evaluationSourceTranscriptSchema.optional(),
    legacyEvidenceNotice: nonBlankTextSchema.max(1_000).optional(),
    participantDetails: participantDetailsSchema.optional(),
  })
  .superRefine((report, context) => {
    if (report.language === 'de' && report.profileTranslation !== null) {
      context.addIssue({
        code: 'custom',
        path: ['profileTranslation'],
        message: 'A German report may not claim an English profile translation overlay',
      });
    }
    if (
      report.profile.profileId !== report.profileId ||
      report.profile.name !== report.profileName
    ) {
      context.addIssue({
        code: 'custom',
        path: ['profile'],
        message: 'The profile snapshot must match the report profile identity',
      });
    }

    const expectedCalculation = calculateProfileScores(
      report.profile,
      new Map(
        report.dimensions.flatMap((dimension) =>
          dimension.items.map((item) => [item.itemId, item.score] as const),
        ),
      ),
    );

    for (const [dimensionIndex, dimension] of report.dimensions.entries()) {
      const sourceDimension = report.profile.dimensions[dimensionIndex];
      if (
        sourceDimension === undefined ||
        dimension.dimensionId !== sourceDimension.dimensionId ||
        dimension.name !== sourceDimension.name ||
        dimension.order !== sourceDimension.order ||
        dimension.weight !== sourceDimension.weight
      ) {
        context.addIssue({
          code: 'custom',
          path: ['dimensions', dimensionIndex],
          message: 'Report dimensions must exactly preserve profile order and identity',
        });
      }
      const sourceItems = report.profile.items.filter(
        (item) => item.dimensionId === dimension.dimensionId,
      );
      for (const [itemIndex, item] of dimension.items.entries()) {
        const sourceItem = sourceItems[itemIndex];
        if (
          sourceItem === undefined ||
          item.itemId !== sourceItem.itemId ||
          item.dimensionId !== sourceItem.dimensionId ||
          item.name !== sourceItem.name ||
          item.codingInstruction !== sourceItem.codingInstruction ||
          item.order !== sourceItem.order ||
          item.weight !== sourceItem.weight ||
          JSON.stringify(item.anchors) !== JSON.stringify(sourceItem.anchors)
        ) {
          context.addIssue({
            code: 'custom',
            path: ['dimensions', dimensionIndex, 'items', itemIndex],
            message: 'Report items must exactly snapshot the selected profile',
          });
        }
      }
      if (dimension.items.length !== sourceItems.length) {
        context.addIssue({
          code: 'custom',
          path: ['dimensions', dimensionIndex, 'items'],
          message: 'Every profile item must appear exactly once in its report dimension',
        });
      }
      validateAggregate(
        dimension.aggregate,
        expectedCalculation.dimensions[dimensionIndex]?.aggregate,
        ['dimensions', dimensionIndex, 'aggregate'],
        context,
      );
    }
    if (report.dimensions.length !== report.profile.dimensions.length) {
      context.addIssue({
        code: 'custom',
        path: ['dimensions'],
        message: 'Every profile dimension must appear exactly once in the report',
      });
    }
    validateAggregate(
      report.overallAggregate,
      expectedCalculation.overallAggregate,
      ['overallAggregate'],
      context,
    );
    if (JSON.stringify(report.calculation) !== JSON.stringify(expectedCalculation.calculation)) {
      context.addIssue({
        code: 'custom',
        path: ['calculation'],
        message: 'The calculation trace must equal the deterministic server calculation',
      });
    }
  });

export const profileEvaluationFailureSchema = z.strictObject({
  code: nonBlankTextSchema.max(100),
  message: nonBlankTextSchema.max(1_000),
  retryable: z.boolean(),
});

const runIdentityShape = {
  evaluationId: idSchema,
  interviewId: idSchema,
  profileId: idSchema,
  profileFingerprint: profileEvaluationFingerprintSchema,
  language: supportedLocaleSchema.default(DEFAULT_LOCALE),
};

const profileEvaluationNotStartedSnapshotSchema = z.strictObject({
  status: z.literal('not_started'),
  interviewId: idSchema,
  profileId: idSchema,
  profileFingerprint: profileEvaluationFingerprintSchema,
  language: supportedLocaleSchema.default(DEFAULT_LOCALE),
  report: z.null(),
  failure: z.null(),
});

const profileEvaluationRunningSnapshotSchema = z.strictObject({
  status: z.literal('running'),
  ...runIdentityShape,
  startedAt: timestampSchema,
  report: z.null(),
  failure: z.null(),
});

const profileEvaluationCompletedSnapshotSchema = z.strictObject({
  status: z.literal('completed'),
  ...runIdentityShape,
  startedAt: timestampSchema,
  completedAt: timestampSchema,
  report: profileEvaluationReportSchema,
  failure: z.null(),
});

const profileEvaluationFailedSnapshotSchema = z.strictObject({
  status: z.literal('failed'),
  ...runIdentityShape,
  startedAt: timestampSchema,
  failedAt: timestampSchema,
  report: z.null(),
  failure: profileEvaluationFailureSchema,
});

export const profileEvaluationSnapshotSchema = z
  .discriminatedUnion('status', [
    profileEvaluationNotStartedSnapshotSchema,
    profileEvaluationRunningSnapshotSchema,
    profileEvaluationCompletedSnapshotSchema,
    profileEvaluationFailedSnapshotSchema,
  ])
  .superRefine((snapshot, context) => {
    if (snapshot.status === 'completed') {
      if (
        snapshot.report.evaluationId !== snapshot.evaluationId ||
        snapshot.report.interviewId !== snapshot.interviewId ||
        snapshot.report.profileId !== snapshot.profileId ||
        snapshot.report.profileFingerprint !== snapshot.profileFingerprint ||
        snapshot.report.language !== snapshot.language
      ) {
        context.addIssue({
          code: 'custom',
          path: ['report'],
          message: 'A completed evaluation snapshot and report must have identical scope',
        });
      }
      if (
        Date.parse(snapshot.completedAt) < Date.parse(snapshot.startedAt) ||
        snapshot.report.evaluatedAt !== snapshot.completedAt
      ) {
        context.addIssue({
          code: 'custom',
          path: ['completedAt'],
          message: 'Evaluation completion must follow its start and match the report timestamp',
        });
      }
    }
    if (
      snapshot.status === 'failed' &&
      Date.parse(snapshot.failedAt) < Date.parse(snapshot.startedAt)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['failedAt'],
        message: 'Evaluation failure must not predate its start',
      });
    }
  });

export const profileEvaluationSelectionQuerySchema = z.strictObject({
  profileId: idSchema.optional(),
});

export const profileEvaluationStartRequestSchema = z.strictObject({
  profileId: idSchema.optional(),
});

export const profileEvaluationExportFormatSchema = z.enum(['json', 'csv', 'markdown', 'html']);

export const profileEvaluationExportQuerySchema = z.strictObject({
  format: profileEvaluationExportFormatSchema,
  profileId: idSchema.optional(),
});

export const profileEvaluationSnapshotResponseSchema = z.strictObject({
  evaluation: profileEvaluationSnapshotSchema,
});

export type ProfileEvaluationEvidenceReference = z.infer<
  typeof profileEvaluationEvidenceReferenceSchema
>;
export type ProfileEvaluationTranslationMetadata = z.infer<
  typeof profileEvaluationTranslationMetadataSchema
>;
export type ProfileEvaluationItemStatus = z.infer<typeof profileEvaluationItemStatusSchema>;
export type ProfileEvaluationItemCoding = z.infer<typeof profileEvaluationItemCodingSchema>;
export type ProfileEvaluationCodingOutput = z.infer<typeof profileEvaluationCodingOutputSchema>;
export type ProfileEvaluationAppliedAnchor = z.infer<typeof profileEvaluationAppliedAnchorSchema>;
export type ProfileEvaluationAggregate = z.infer<typeof profileEvaluationAggregateSchema>;
export type ProfileEvaluationReportItem = z.infer<typeof profileEvaluationReportItemSchema>;
export type ProfileEvaluationReportDimension = z.infer<
  typeof profileEvaluationReportDimensionSchema
>;
export type ProfileEvaluationReport = z.infer<typeof profileEvaluationReportSchema>;
export type ProfileEvaluationFailure = z.infer<typeof profileEvaluationFailureSchema>;
export type ProfileEvaluationSnapshot = z.infer<typeof profileEvaluationSnapshotSchema>;
export type ProfileEvaluationSelectionQuery = z.infer<typeof profileEvaluationSelectionQuerySchema>;
export type ProfileEvaluationStartRequest = z.infer<typeof profileEvaluationStartRequestSchema>;
export type ProfileEvaluationExportFormat = z.infer<typeof profileEvaluationExportFormatSchema>;
export type ProfileEvaluationExportQuery = z.infer<typeof profileEvaluationExportQuerySchema>;

function validateAggregate(
  aggregate: z.infer<typeof profileEvaluationAggregateSchema>,
  expected: z.infer<typeof profileEvaluationAggregateSchema> | undefined,
  path: (string | number)[],
  context: z.RefinementCtx,
): void {
  if (JSON.stringify(aggregate) !== JSON.stringify(expected)) {
    context.addIssue({
      code: 'custom',
      path,
      message: 'Report aggregates must equal the deterministic server calculation',
    });
  }
}
