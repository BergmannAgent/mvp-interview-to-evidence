import { z } from 'zod';

import { modelMetadataSchema } from './monitoring.js';
import {
  idSchema,
  nonBlankTextSchema,
  shortRationaleSchema,
  timestampSchema,
} from './primitives.js';

export const ORGANIZATIONAL_RESILIENCE_REPORT_SCHEMA_VERSION = 2 as const;
export const ORGANIZATIONAL_RESILIENCE_INSTRUMENT_ID = 'kantur-iseri-say-evidence-rating' as const;
export const ORGANIZATIONAL_RESILIENCE_INSTRUMENT_VERSION = '1.0.0' as const;
export const ORGANIZATIONAL_RESILIENCE_ADAPTIVE_MAPPING_ID =
  'adaptive-full-transcript-or-evidence-v1' as const;
export const ORGANIZATIONAL_RESILIENCE_ITEM_IDS = [
  'rob-01',
  'rob-02',
  'rob-03',
  'rob-04',
  'agi-01',
  'agi-02',
  'agi-03',
  'int-01',
  'int-02',
] as const;
export const ORGANIZATIONAL_RESILIENCE_DIMENSIONS = ['robustness', 'agility', 'integrity'] as const;
export const ORGANIZATIONAL_RESILIENCE_REFERENCE_SCORES = [1, 4, 7] as const;
export const ORGANIZATIONAL_RESILIENCE_INTERMEDIATE_SCORES = [2, 3, 5, 6] as const;
export const ORGANIZATIONAL_RESILIENCE_INTERPOLATION_CODEBOOK_ID =
  'or-evidence-interpolation-codebook' as const;
export const ORGANIZATIONAL_RESILIENCE_INTERPOLATION_CODEBOOK_VERSION = '1.0.0' as const;
export const ORGANIZATIONAL_RESILIENCE_RUBRIC_VERSION = 2 as const;

const ORGANIZATIONAL_RESILIENCE_ITEM_DIMENSIONS = {
  'rob-01': 'robustness',
  'rob-02': 'robustness',
  'rob-03': 'robustness',
  'rob-04': 'robustness',
  'agi-01': 'agility',
  'agi-02': 'agility',
  'agi-03': 'agility',
  'int-01': 'integrity',
  'int-02': 'integrity',
} as const satisfies Record<
  (typeof ORGANIZATIONAL_RESILIENCE_ITEM_IDS)[number],
  (typeof ORGANIZATIONAL_RESILIENCE_DIMENSIONS)[number]
>;

const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const normalizedTextSchema = nonBlankTextSchema.refine(
  (value) => value.normalize('NFC') === value,
  'Text must be NFC-normalized',
);

export const organizationalResilienceItemIdSchema = z.enum(ORGANIZATIONAL_RESILIENCE_ITEM_IDS);
export const organizationalResilienceDimensionIdSchema = z.enum(
  ORGANIZATIONAL_RESILIENCE_DIMENSIONS,
);
export const organizationalResilienceScoreSchema = z.number().int().min(1).max(7);
export const organizationalResilienceReferenceScoreSchema = z.union([
  z.literal(1),
  z.literal(4),
  z.literal(7),
]);
export const organizationalResilienceIntermediateScoreSchema = z.union([
  z.literal(2),
  z.literal(3),
  z.literal(5),
  z.literal(6),
]);
export const organizationalResilienceItemStatusSchema = z.enum([
  'scored',
  'insufficient_evidence',
  'not_applicable',
  'conflicting',
]);
export const adversityPhaseSchema = z.enum(['pre_adversity', 'during_adversity', 'post_adversity']);
export const crisisContextModeSchema = z.enum([
  'actual_event',
  'hypothetical',
  'no_crisis_experience',
  'mixed_or_unclear',
]);
export const evidenceDirectionSchema = z.enum(['supporting', 'counter', 'ambiguous']);
export const evidenceSpecificitySchema = z.enum([
  'general_statement',
  'concrete_practice',
  'concrete_event',
  'hypothetical_statement',
  'absence_of_crisis_experience',
]);

function interpolationRuleSchema<
  Score extends 2 | 3 | 5 | 6,
  LowerReference extends 1 | 4,
  UpperReference extends 4 | 7,
  Proximity extends 'lower' | 'upper',
>(
  score: Score,
  lowerReference: LowerReference,
  upperReference: UpperReference,
  proximity: Proximity,
) {
  return z.strictObject({
    ruleId: idSchema,
    score: z.literal(score),
    adjacentReferenceScores: z.tuple([z.literal(lowerReference), z.literal(upperReference)]),
    proximity: z.literal(proximity),
    decisionCriterionDe: normalizedTextSchema.max(1_000),
    exclusionCriterionDe: normalizedTextSchema.max(1_000),
  });
}

export const organizationalResilienceInterpolationRulesSchema = z.tuple([
  interpolationRuleSchema(2, 1, 4, 'lower'),
  interpolationRuleSchema(3, 1, 4, 'upper'),
  interpolationRuleSchema(5, 4, 7, 'lower'),
  interpolationRuleSchema(6, 4, 7, 'upper'),
]);

function runtimeInterpolationRuleSchema<
  Score extends 2 | 3 | 5 | 6,
  LowerReference extends 1 | 4,
  UpperReference extends 4 | 7,
  Proximity extends 'lower' | 'upper',
>(
  score: Score,
  lowerReference: LowerReference,
  upperReference: UpperReference,
  proximity: Proximity,
) {
  return z.strictObject({
    ruleId: idSchema,
    score: z.literal(score),
    adjacentReferenceScores: z.tuple([z.literal(lowerReference), z.literal(upperReference)]),
    proximity: z.literal(proximity),
    decisionCriterion: normalizedTextSchema.max(1_000),
    exclusionCriterion: normalizedTextSchema.max(1_000),
  });
}

export const organizationalResilienceRuntimeInterpolationRulesSchema = z.tuple([
  runtimeInterpolationRuleSchema(2, 1, 4, 'lower'),
  runtimeInterpolationRuleSchema(3, 1, 4, 'upper'),
  runtimeInterpolationRuleSchema(5, 4, 7, 'lower'),
  runtimeInterpolationRuleSchema(6, 4, 7, 'upper'),
]);

const organizationalResilienceInterpolationItemSchema = z.strictObject({
  itemId: organizationalResilienceItemIdSchema,
  rules: organizationalResilienceInterpolationRulesSchema,
});

export const organizationalResilienceInterpolationCodebookSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    codebookId: z.literal(ORGANIZATIONAL_RESILIENCE_INTERPOLATION_CODEBOOK_ID),
    codebookVersion: z.literal(ORGANIZATIONAL_RESILIENCE_INTERPOLATION_CODEBOOK_VERSION),
    classification: z.literal('derived_interpolation_guidance'),
    approvalStatus: z.literal('pilot_only'),
    appliesTo: z.strictObject({
      instrumentId: z.literal(ORGANIZATIONAL_RESILIENCE_INSTRUMENT_ID),
      instrumentVersion: z.literal(ORGANIZATIONAL_RESILIENCE_INSTRUMENT_VERSION),
      instrumentFingerprintSha256: fingerprintSchema,
      referenceScores: z.tuple([z.literal(1), z.literal(4), z.literal(7)]),
    }),
    safeguards: z.strictObject({
      intermediateScoresAreNotReferenceAnchors: z.literal(true),
      missingEvidenceIsNotIntermediateScore: z.literal(true),
      requiresBothAdjacentAnchors: z.literal(true),
      noRoundingOrClamping: z.literal(true),
    }),
    items: z.tuple([
      organizationalResilienceInterpolationItemSchema,
      organizationalResilienceInterpolationItemSchema,
      organizationalResilienceInterpolationItemSchema,
      organizationalResilienceInterpolationItemSchema,
      organizationalResilienceInterpolationItemSchema,
      organizationalResilienceInterpolationItemSchema,
      organizationalResilienceInterpolationItemSchema,
      organizationalResilienceInterpolationItemSchema,
      organizationalResilienceInterpolationItemSchema,
    ]),
  })
  .superRefine((codebook, context) => {
    for (const [itemIndex, expectedItemId] of ORGANIZATIONAL_RESILIENCE_ITEM_IDS.entries()) {
      const item = codebook.items[itemIndex];
      if (item?.itemId !== expectedItemId) {
        context.addIssue({
          code: 'custom',
          path: ['items', itemIndex, 'itemId'],
          message: `Expected interpolation item ${expectedItemId}`,
        });
        continue;
      }
      for (const [ruleIndex, score] of ORGANIZATIONAL_RESILIENCE_INTERMEDIATE_SCORES.entries()) {
        if (item.rules[ruleIndex]?.ruleId !== `${expectedItemId}-score-${String(score)}`) {
          context.addIssue({
            code: 'custom',
            path: ['items', itemIndex, 'rules', ruleIndex, 'ruleId'],
            message: `Expected interpolation rule ${expectedItemId}-score-${String(score)}`,
          });
        }
      }
    }
  });

const organizationalResilienceCalibrationEvidenceSchema = z.strictObject({
  turnIndex: z.number().int().nonnegative(),
  direction: z.enum(['supporting', 'counter']),
  excerpt: normalizedTextSchema.max(2_000),
});

const organizationalResilienceCalibrationCaseSchema = z
  .strictObject({
    caseId: idSchema,
    participantTurns: z.array(normalizedTextSchema.max(5_000)).min(1).max(5),
    expectedStatus: z.enum(['scored', 'insufficient_evidence', 'conflicting']),
    expectedScore: organizationalResilienceScoreSchema.nullable(),
    expectedMatchedReferenceScores: z.array(organizationalResilienceReferenceScoreSchema).max(2),
    expectedRuleId: idSchema.nullable(),
    evidence: z.array(organizationalResilienceCalibrationEvidenceSchema).max(10),
    calibrationRationaleDe: normalizedTextSchema.max(1_000),
  })
  .superRefine((calibrationCase, context) => {
    for (const [evidenceIndex, evidence] of calibrationCase.evidence.entries()) {
      const turn = calibrationCase.participantTurns[evidence.turnIndex];
      if (turn === undefined || !turn.includes(evidence.excerpt)) {
        context.addIssue({
          code: 'custom',
          path: ['evidence', evidenceIndex, 'excerpt'],
          message: 'Calibration evidence must be verbatim in its participant turn',
        });
      }
    }
    if (calibrationCase.expectedStatus !== 'scored') {
      if (
        calibrationCase.expectedScore !== null ||
        calibrationCase.expectedMatchedReferenceScores.length !== 0 ||
        calibrationCase.expectedRuleId !== null
      ) {
        context.addIssue({
          code: 'custom',
          path: ['expectedScore'],
          message: 'A non-scored calibration case cannot define a score, anchors, or rule',
        });
      }
      return;
    }
    if (calibrationCase.expectedScore === null || calibrationCase.evidence.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['expectedScore'],
        message: 'A scored calibration case requires a numeric score and evidence',
      });
      return;
    }
    const score = calibrationCase.expectedScore;
    const expectedReferences =
      score === 1 || score === 4 || score === 7 ? [score] : score < 4 ? [1, 4] : [4, 7];
    if (
      calibrationCase.expectedMatchedReferenceScores.length !== expectedReferences.length ||
      expectedReferences.some(
        (reference, index) => calibrationCase.expectedMatchedReferenceScores[index] !== reference,
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['expectedMatchedReferenceScores'],
        message: 'Calibration references must match the exact or adjacent reference anchors',
      });
    }
    const expectedRuleId =
      score === 1 || score === 4 || score === 7
        ? null
        : `rob-01-score-${String(calibrationCase.expectedScore)}`;
    if (calibrationCase.expectedRuleId !== expectedRuleId) {
      context.addIssue({
        code: 'custom',
        path: ['expectedRuleId'],
        message: 'Calibration rule must match the intermediate score',
      });
    }
  });

export const organizationalResilienceCalibrationFixtureSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    fixtureId: z.literal('or-evidence-calibration-cases'),
    fixtureVersion: z.literal('1.0.0'),
    classification: z.literal('synthetic_pilot_calibration_vignettes'),
    appliesTo: z.strictObject({
      instrumentId: z.literal(ORGANIZATIONAL_RESILIENCE_INSTRUMENT_ID),
      instrumentVersion: z.literal(ORGANIZATIONAL_RESILIENCE_INSTRUMENT_VERSION),
      instrumentFingerprintSha256: fingerprintSchema,
      interpolationCodebookId: z.literal(ORGANIZATIONAL_RESILIENCE_INTERPOLATION_CODEBOOK_ID),
      interpolationCodebookVersion: z.literal(
        ORGANIZATIONAL_RESILIENCE_INTERPOLATION_CODEBOOK_VERSION,
      ),
      interpolationCodebookFingerprintSha256: fingerprintSchema,
    }),
    itemId: z.literal('rob-01'),
    cases: z.tuple([
      organizationalResilienceCalibrationCaseSchema,
      organizationalResilienceCalibrationCaseSchema,
      organizationalResilienceCalibrationCaseSchema,
      organizationalResilienceCalibrationCaseSchema,
      organizationalResilienceCalibrationCaseSchema,
      organizationalResilienceCalibrationCaseSchema,
      organizationalResilienceCalibrationCaseSchema,
      organizationalResilienceCalibrationCaseSchema,
      organizationalResilienceCalibrationCaseSchema,
    ]),
  })
  .superRefine((fixture, context) => {
    const expected = [
      ['scored', 1],
      ['scored', 2],
      ['scored', 3],
      ['scored', 4],
      ['scored', 5],
      ['scored', 6],
      ['scored', 7],
      ['insufficient_evidence', null],
      ['conflicting', null],
    ] as const;
    for (const [index, [status, score]] of expected.entries()) {
      const calibrationCase = fixture.cases[index];
      if (calibrationCase?.expectedStatus !== status || calibrationCase.expectedScore !== score) {
        context.addIssue({
          code: 'custom',
          path: ['cases', index],
          message: `Expected calibration case ${status}/${String(score)}`,
        });
      }
    }
    const conflicting = fixture.cases[8];
    const directions = new Set(conflicting.evidence.map((evidence) => evidence.direction));
    if (!directions.has('supporting') || !directions.has('counter')) {
      context.addIssue({
        code: 'custom',
        path: ['cases', 8, 'evidence'],
        message: 'Conflicting calibration requires supporting and counter evidence',
      });
    }
  });

function evidenceReferenceSchema<Direction extends 'supporting' | 'counter' | 'ambiguous'>(
  direction: Direction,
) {
  return z.strictObject({
    turnId: idSchema,
    sequenceNumber: z.number().int().positive(),
    verbatimExcerpt: normalizedTextSchema.max(2_000),
    phase: adversityPhaseSchema,
    direction: z.literal(direction),
    specificity: evidenceSpecificitySchema,
  });
}

export const supportingEvidenceReferenceSchema = evidenceReferenceSchema('supporting');
export const counterEvidenceReferenceSchema = evidenceReferenceSchema('counter');
export const ambiguousEvidenceReferenceSchema = evidenceReferenceSchema('ambiguous');
export const organizationalResilienceEvidenceReferenceSchema = z.union([
  supportingEvidenceReferenceSchema,
  counterEvidenceReferenceSchema,
  ambiguousEvidenceReferenceSchema,
]);

const evidenceArray = <Schema extends z.ZodType>(schema: Schema) =>
  z
    .array(schema)
    .max(50)
    .refine(
      (references) =>
        new Set(
          references.map((reference) => {
            const value = reference as {
              readonly turnId: string;
              readonly verbatimExcerpt: string;
            };
            return `${value.turnId}\u0000${value.verbatimExcerpt}`;
          }),
        ).size === references.length,
      'Evidence references must not repeat the same turn excerpt',
    );

const matchedAnchorSchema = z.strictObject({
  score: organizationalResilienceReferenceScoreSchema,
  relationship: z.enum(['exact', 'lower_bound', 'upper_bound']),
  interpretation: normalizedTextSchema.max(1_000),
});

const itemCodingBase = {
  itemId: organizationalResilienceItemIdSchema,
  dimensionId: organizationalResilienceDimensionIdSchema,
  confidence: z.number().min(0).max(1),
  supportingEvidence: evidenceArray(supportingEvidenceReferenceSchema),
  counterEvidence: evidenceArray(counterEvidenceReferenceSchema),
  ambiguousEvidence: evidenceArray(ambiguousEvidenceReferenceSchema),
  missingInformation: z.array(normalizedTextSchema.max(500)).max(50),
  appliedInterpolationRuleId: idSchema.nullable().optional(),
  rationale: shortRationaleSchema,
};

export const scoredOrganizationalResilienceItemSchema = z
  .strictObject({
    ...itemCodingBase,
    status: z.literal('scored'),
    score: organizationalResilienceScoreSchema,
    matchedAnchors: z.array(matchedAnchorSchema).min(1).max(2),
  })
  .superRefine((item, context) => {
    if (item.supportingEvidence.length + item.counterEvidence.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['supportingEvidence'],
        message: 'A numeric score requires supporting or counter evidence',
      });
    }
    const scores = new Set(item.matchedAnchors.map((anchor) => anchor.score));
    if (scores.size !== item.matchedAnchors.length) {
      context.addIssue({
        code: 'custom',
        path: ['matchedAnchors'],
        message: 'Matched anchor scores must be unique',
      });
    }
    const required =
      item.score === 1 || item.score === 4 || item.score === 7
        ? [item.score]
        : item.score < 4
          ? [1, 4]
          : [4, 7];
    if (
      scores.size !== required.length ||
      required.some((score) => !scores.has(score as 1 | 4 | 7))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['matchedAnchors'],
        message: 'Intermediate scores require both adjacent reference anchors',
      });
    }
  });

export const insufficientEvidenceOrganizationalResilienceItemSchema = z.strictObject({
  ...itemCodingBase,
  status: z.literal('insufficient_evidence'),
  score: z.null(),
  matchedAnchors: z.array(matchedAnchorSchema).length(0),
  missingInformation: z.array(normalizedTextSchema.max(500)).min(1).max(50),
});

export const notApplicableOrganizationalResilienceItemSchema = z.strictObject({
  ...itemCodingBase,
  status: z.literal('not_applicable'),
  score: z.null(),
  matchedAnchors: z.array(matchedAnchorSchema).length(0),
});

export const conflictingOrganizationalResilienceItemSchema = z.strictObject({
  ...itemCodingBase,
  status: z.literal('conflicting'),
  score: z.null(),
  matchedAnchors: z.array(matchedAnchorSchema).length(0),
  supportingEvidence: evidenceArray(supportingEvidenceReferenceSchema).min(1),
  counterEvidence: evidenceArray(counterEvidenceReferenceSchema).min(1),
});

export const organizationalResilienceItemCodingSchema = z.union([
  scoredOrganizationalResilienceItemSchema,
  insufficientEvidenceOrganizationalResilienceItemSchema,
  notApplicableOrganizationalResilienceItemSchema,
  conflictingOrganizationalResilienceItemSchema,
]);

type EvidenceBearingItem = Pick<
  z.infer<typeof organizationalResilienceItemCodingSchema>,
  'supportingEvidence' | 'counterEvidence' | 'ambiguousEvidence'
>;

export function deriveOrganizationalResilienceEvidenceQuality(
  items: readonly EvidenceBearingItem[],
): {
  readonly level: 'not_assessable' | 'low' | 'medium' | 'high';
  readonly concreteEvidenceCount: number;
  readonly totalEvidenceCount: number;
} {
  const evidenceConcreteByKey = new Map<string, boolean>();

  for (const item of items) {
    for (const reference of [
      ...item.supportingEvidence,
      ...item.counterEvidence,
      ...item.ambiguousEvidence,
    ]) {
      const key = JSON.stringify([reference.turnId, reference.verbatimExcerpt]);
      const isConcrete =
        reference.specificity === 'concrete_practice' || reference.specificity === 'concrete_event';
      const prior = evidenceConcreteByKey.get(key);
      evidenceConcreteByKey.set(key, prior === undefined ? isConcrete : prior && isConcrete);
    }
  }

  const totalEvidenceCount = evidenceConcreteByKey.size;
  const concreteEvidenceCount = [...evidenceConcreteByKey.values()].filter(Boolean).length;
  const concreteRatio = totalEvidenceCount === 0 ? 0 : concreteEvidenceCount / totalEvidenceCount;
  const level =
    totalEvidenceCount === 0
      ? 'not_assessable'
      : concreteRatio >= 2 / 3
        ? 'high'
        : concreteRatio >= 1 / 3
          ? 'medium'
          : 'low';

  return { level, concreteEvidenceCount, totalEvidenceCount };
}

export const crisisContextSchema = z.strictObject({
  mode: crisisContextModeSchema,
  summary: normalizedTextSchema.max(2_000),
  eventLabel: normalizedTextSchema.max(300).nullable(),
  evidence: z.array(organizationalResilienceEvidenceReferenceSchema).max(20),
});

export const processPhaseCodingSchema = z.strictObject({
  phase: adversityPhaseSchema,
  status: z.enum(['covered', 'partially_covered', 'not_covered']),
  summary: normalizedTextSchema.max(1_000),
  evidence: z.array(organizationalResilienceEvidenceReferenceSchema).max(50),
});

export const organizationalResilienceCodingOutputSchema = z
  .strictObject({
    crisisContext: crisisContextSchema,
    processPhases: z.array(processPhaseCodingSchema).length(3),
    items: z.array(organizationalResilienceItemCodingSchema).length(9),
    rationale: shortRationaleSchema,
  })
  .superRefine((output, context) => {
    const expectedPhases = ['pre_adversity', 'during_adversity', 'post_adversity'] as const;
    for (const [index, expected] of expectedPhases.entries()) {
      if (output.processPhases[index]?.phase !== expected) {
        context.addIssue({
          code: 'custom',
          path: ['processPhases', index, 'phase'],
          message: `Expected phase ${expected} at position ${String(index)}`,
        });
      }
    }
    for (const [index, expected] of ORGANIZATIONAL_RESILIENCE_ITEM_IDS.entries()) {
      if (output.items[index]?.itemId !== expected) {
        context.addIssue({
          code: 'custom',
          path: ['items', index, 'itemId'],
          message: `Expected item ${expected} at position ${String(index)}`,
        });
      }
    }
  });

const approvedAnchorExampleSchema = z.strictObject({
  exampleId: idSchema,
  behavioralAnchor: normalizedTextSchema.max(1_000),
  typicalEvidence: normalizedTextSchema.max(1_000),
  empiricalEvidence: normalizedTextSchema.max(2_000),
  sourceId: idSchema,
  sourceLocator: normalizedTextSchema.max(500),
});

const rubricReferenceAnchorSchema = z.strictObject({
  score: organizationalResilienceReferenceScoreSchema,
  interpretation: normalizedTextSchema.max(1_000),
  approvedExamples: z.tuple([approvedAnchorExampleSchema, approvedAnchorExampleSchema]),
});

export const organizationalResilienceRubricItemSchema = z.strictObject({
  itemId: organizationalResilienceItemIdSchema,
  dimensionId: organizationalResilienceDimensionIdSchema,
  position: z.number().int().min(1).max(9),
  label: normalizedTextSchema.max(300),
  originalStatementEn: normalizedTextSchema.max(500),
  elicitationQuestion: normalizedTextSchema.max(500),
  codingInstruction: normalizedTextSchema.max(2_000),
  guideQuestionIds: z.array(idSchema).max(100),
  phases: z.array(adversityPhaseSchema).min(1).max(3),
  anchors: z.tuple([
    rubricReferenceAnchorSchema.extend({ score: z.literal(1) }),
    rubricReferenceAnchorSchema.extend({ score: z.literal(4) }),
    rubricReferenceAnchorSchema.extend({ score: z.literal(7) }),
  ]),
  interpolationRules: organizationalResilienceRuntimeInterpolationRulesSchema.optional(),
});

export const organizationalResilienceRubricSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    kind: z.literal('organizational_resilience_evidence_1_7'),
    rubricId: idSchema,
    guideId: idSchema,
    version: z.number().int().positive(),
    title: normalizedTextSchema.max(300),
    description: normalizedTextSchema.max(2_000),
    instrument: z.strictObject({
      instrumentId: z.literal(ORGANIZATIONAL_RESILIENCE_INSTRUMENT_ID),
      instrumentVersion: z.literal(ORGANIZATIONAL_RESILIENCE_INSTRUMENT_VERSION),
      instrumentFingerprint: fingerprintSchema,
      classification: z.literal('derived_evidence_rating'),
    }),
    mapping: z.strictObject({
      mappingId: idSchema,
      mappingVersion: nonBlankTextSchema.max(50),
      mappingFingerprint: fingerprintSchema,
    }),
    scale: z.strictObject({
      kind: z.literal('ordinal_1_7'),
      minimum: z.literal(1),
      maximum: z.literal(7),
      referenceScores: z.tuple([z.literal(1), z.literal(4), z.literal(7)]),
      interpolationCodebook: z
        .strictObject({
          codebookId: z.literal(ORGANIZATIONAL_RESILIENCE_INTERPOLATION_CODEBOOK_ID),
          codebookVersion: z.literal(ORGANIZATIONAL_RESILIENCE_INTERPOLATION_CODEBOOK_VERSION),
          fingerprintSha256: fingerprintSchema,
          classification: z.literal('derived_interpolation_guidance'),
          approvalStatus: z.literal('pilot_only'),
        })
        .optional(),
    }),
    dimensions: z.tuple([
      z.strictObject({
        dimensionId: z.literal('robustness'),
        label: z.literal('Robustness'),
        itemIds: z.tuple([
          z.literal('rob-01'),
          z.literal('rob-02'),
          z.literal('rob-03'),
          z.literal('rob-04'),
        ]),
      }),
      z.strictObject({
        dimensionId: z.literal('agility'),
        label: z.literal('Agility'),
        itemIds: z.tuple([z.literal('agi-01'), z.literal('agi-02'), z.literal('agi-03')]),
      }),
      z.strictObject({
        dimensionId: z.literal('integrity'),
        label: z.literal('Integrity'),
        itemIds: z.tuple([z.literal('int-01'), z.literal('int-02')]),
      }),
    ]),
    items: z.tuple([
      organizationalResilienceRubricItemSchema,
      organizationalResilienceRubricItemSchema,
      organizationalResilienceRubricItemSchema,
      organizationalResilienceRubricItemSchema,
      organizationalResilienceRubricItemSchema,
      organizationalResilienceRubricItemSchema,
      organizationalResilienceRubricItemSchema,
      organizationalResilienceRubricItemSchema,
      organizationalResilienceRubricItemSchema,
    ]),
  })
  .superRefine((rubric, context) => {
    if (rubric.version >= ORGANIZATIONAL_RESILIENCE_RUBRIC_VERSION) {
      if (rubric.scale.interpolationCodebook === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['scale', 'interpolationCodebook'],
          message: 'Rubric version 2 requires a versioned interpolation codebook',
        });
      }
      for (const [itemIndex, item] of rubric.items.entries()) {
        if (item.interpolationRules === undefined) {
          context.addIssue({
            code: 'custom',
            path: ['items', itemIndex, 'interpolationRules'],
            message: 'Rubric version 2 requires interpolation rules for every item',
          });
          continue;
        }
        for (const [ruleIndex, score] of ORGANIZATIONAL_RESILIENCE_INTERMEDIATE_SCORES.entries()) {
          if (
            item.interpolationRules[ruleIndex]?.ruleId !== `${item.itemId}-score-${String(score)}`
          ) {
            context.addIssue({
              code: 'custom',
              path: ['items', itemIndex, 'interpolationRules', ruleIndex, 'ruleId'],
              message: `Expected interpolation rule ${item.itemId}-score-${String(score)}`,
            });
          }
        }
      }
    }
    for (const [index, expected] of ORGANIZATIONAL_RESILIENCE_ITEM_IDS.entries()) {
      const item = rubric.items[index];
      if (item?.itemId !== expected || item.position !== index + 1) {
        context.addIssue({
          code: 'custom',
          path: ['items', index],
          message: `Expected ordered rubric item ${expected}`,
        });
      }
      const expectedDimension = index < 4 ? 'robustness' : index < 7 ? 'agility' : 'integrity';
      if (item?.dimensionId !== expectedDimension) {
        context.addIssue({
          code: 'custom',
          path: ['items', index, 'dimensionId'],
          message: `Item ${expected} belongs to ${expectedDimension}`,
        });
      }
      if (
        rubric.mapping.mappingId !== ORGANIZATIONAL_RESILIENCE_ADAPTIVE_MAPPING_ID &&
        item?.guideQuestionIds.length === 0
      ) {
        context.addIssue({
          code: 'custom',
          path: ['items', index, 'guideQuestionIds'],
          message: 'Only the adaptive full-transcript mapping may omit guide question hints',
        });
      }
    }
  });

const reportItemCatalogEntrySchema = z.strictObject({
  itemLabel: normalizedTextSchema.max(300),
  itemId: organizationalResilienceItemIdSchema,
  dimensionId: organizationalResilienceDimensionIdSchema,
  originalStatementEn: normalizedTextSchema.max(500),
  referenceAnchors: z.tuple([
    z.strictObject({ score: z.literal(1), interpretation: normalizedTextSchema.max(1_000) }),
    z.strictObject({ score: z.literal(4), interpretation: normalizedTextSchema.max(1_000) }),
    z.strictObject({ score: z.literal(7), interpretation: normalizedTextSchema.max(1_000) }),
  ]),
});

const dimensionReportSchema = z.strictObject({
  dimensionId: organizationalResilienceDimensionIdSchema,
  label: z.enum(['Robustness', 'Agility', 'Integrity']),
  status: z.enum(['complete', 'partial', 'not_scored']),
  score: z.number().min(1).max(7).nullable(),
  scoredItemCount: z.number().int().nonnegative(),
  totalItemCount: z.number().int().positive(),
  itemIds: z.array(organizationalResilienceItemIdSchema).min(1),
});

export const organizationalResilienceReportSchema = z
  .strictObject({
    schemaVersion: z.literal(ORGANIZATIONAL_RESILIENCE_REPORT_SCHEMA_VERSION),
    reportKind: z.literal('organizational_resilience_evidence_report'),
    evaluationId: idSchema,
    interviewId: idSchema,
    guideId: idSchema,
    rubricId: idSchema,
    rubricVersion: z.number().int().positive(),
    rubricFingerprint: fingerprintSchema,
    transcriptFingerprint: fingerprintSchema,
    promptVersion: idSchema,
    model: modelMetadataSchema,
    instrument: organizationalResilienceRubricSchema.shape.instrument,
    mapping: organizationalResilienceRubricSchema.shape.mapping,
    crisisContext: crisisContextSchema,
    processPhases: organizationalResilienceCodingOutputSchema.shape.processPhases,
    dimensions: z.tuple([dimensionReportSchema, dimensionReportSchema, dimensionReportSchema]),
    itemCatalog: z.tuple([
      reportItemCatalogEntrySchema,
      reportItemCatalogEntrySchema,
      reportItemCatalogEntrySchema,
      reportItemCatalogEntrySchema,
      reportItemCatalogEntrySchema,
      reportItemCatalogEntrySchema,
      reportItemCatalogEntrySchema,
      reportItemCatalogEntrySchema,
      reportItemCatalogEntrySchema,
    ]),
    items: z.tuple([
      organizationalResilienceItemCodingSchema,
      organizationalResilienceItemCodingSchema,
      organizationalResilienceItemCodingSchema,
      organizationalResilienceItemCodingSchema,
      organizationalResilienceItemCodingSchema,
      organizationalResilienceItemCodingSchema,
      organizationalResilienceItemCodingSchema,
      organizationalResilienceItemCodingSchema,
      organizationalResilienceItemCodingSchema,
    ]),
    overallScore: z.number().min(1).max(7).nullable(),
    quality: z.strictObject({
      evidenceCoverage: z.strictObject({
        scoredItemCount: z.number().int().min(0).max(9),
        totalItemCount: z.literal(9),
        ratio: z.number().min(0).max(1),
      }),
      evidenceQuality: z.strictObject({
        level: z.enum(['not_assessable', 'low', 'medium', 'high']),
        concreteEvidenceCount: z.number().int().nonnegative(),
        totalEvidenceCount: z.number().int().nonnegative(),
      }),
      coderAgreement: z.strictObject({
        status: z.literal('not_measured'),
        explanation: normalizedTextSchema.max(500),
      }),
    }),
    methodology: z.strictObject({
      classification: z.literal('derived_evidence_rating'),
      sourceScale: z.strictObject({
        kind: z.literal('self_report_likert'),
        minimum: z.literal(1),
        maximum: z.literal(5),
      }),
      evidenceScale: z.strictObject({
        kind: z.literal('interview_evidence_rating'),
        minimum: z.literal(1),
        maximum: z.literal(7),
        referenceScores: z.tuple([z.literal(1), z.literal(4), z.literal(7)]),
        interpolationCodebook:
          organizationalResilienceRubricSchema.shape.scale.shape.interpolationCodebook,
      }),
      limitations: z.array(normalizedTextSchema.max(1_000)).min(1).max(20),
    }),
    rationale: shortRationaleSchema,
    evaluatedAt: timestampSchema,
  })
  .superRefine((report, context) => {
    const expectedDimensions = [
      {
        dimensionId: 'robustness',
        label: 'Robustness',
        itemIds: ['rob-01', 'rob-02', 'rob-03', 'rob-04'],
      },
      {
        dimensionId: 'agility',
        label: 'Agility',
        itemIds: ['agi-01', 'agi-02', 'agi-03'],
      },
      { dimensionId: 'integrity', label: 'Integrity', itemIds: ['int-01', 'int-02'] },
    ] as const;
    for (const [index, expectedItemId] of ORGANIZATIONAL_RESILIENCE_ITEM_IDS.entries()) {
      const item = report.items[index];
      const catalog = report.itemCatalog[index];
      const expectedDimension = ORGANIZATIONAL_RESILIENCE_ITEM_DIMENSIONS[expectedItemId];
      if (item?.itemId !== expectedItemId || catalog?.itemId !== expectedItemId) {
        context.addIssue({
          code: 'custom',
          path: ['items', index, 'itemId'],
          message: `Expected report item ${expectedItemId}`,
        });
      }
      if (item !== undefined && item.dimensionId !== expectedDimension) {
        context.addIssue({
          code: 'custom',
          path: ['items', index, 'dimensionId'],
          message: `Report item ${expectedItemId} belongs to ${expectedDimension}`,
        });
      }
      if (catalog !== undefined && catalog.dimensionId !== expectedDimension) {
        context.addIssue({
          code: 'custom',
          path: ['itemCatalog', index, 'dimensionId'],
          message: `Report catalog item ${expectedItemId} belongs to ${expectedDimension}`,
        });
      }
      if (report.rubricVersion >= ORGANIZATIONAL_RESILIENCE_RUBRIC_VERSION && item !== undefined) {
        const expectedRuleId =
          item.status === 'scored' && item.score !== 1 && item.score !== 4 && item.score !== 7
            ? `${item.itemId}-score-${String(item.score)}`
            : null;
        const hasInvalidRuleProvenance =
          expectedRuleId === null
            ? item.appliedInterpolationRuleId !== undefined &&
              item.appliedInterpolationRuleId !== null
            : item.appliedInterpolationRuleId !== expectedRuleId;
        if (hasInvalidRuleProvenance) {
          context.addIssue({
            code: 'custom',
            path: ['items', index, 'appliedInterpolationRuleId'],
            message: 'Report interpolation rule provenance must match its item score',
          });
        }
      }
    }

    if (
      report.rubricVersion >= ORGANIZATIONAL_RESILIENCE_RUBRIC_VERSION &&
      report.methodology.evidenceScale.interpolationCodebook === undefined
    ) {
      context.addIssue({
        code: 'custom',
        path: ['methodology', 'evidenceScale', 'interpolationCodebook'],
        message: 'Rubric version 2 reports require interpolation codebook provenance',
      });
    }

    for (const [index, expected] of expectedDimensions.entries()) {
      const dimension = report.dimensions[index];
      if (
        dimension === undefined ||
        dimension.dimensionId !== expected.dimensionId ||
        dimension.label !== expected.label ||
        dimension.itemIds.join('|') !== expected.itemIds.join('|')
      ) {
        context.addIssue({
          code: 'custom',
          path: ['dimensions', index],
          message: `Expected ordered dimension ${expected.dimensionId}`,
        });
        continue;
      }
      const scores = report.items
        .filter((item) => item.dimensionId === expected.dimensionId && item.score !== null)
        .map((item) => item.score as number);
      const expectedStatus =
        scores.length === expected.itemIds.length
          ? 'complete'
          : scores.length === 0
            ? 'not_scored'
            : 'partial';
      const expectedScore = scores.length === 0 ? null : roundedMean(scores);
      if (
        dimension.scoredItemCount !== scores.length ||
        dimension.totalItemCount !== expected.itemIds.length ||
        dimension.status !== expectedStatus ||
        dimension.score !== expectedScore
      ) {
        context.addIssue({
          code: 'custom',
          path: ['dimensions', index],
          message: 'Dimension result must be the deterministic projection of its item scores',
        });
      }
    }

    const allScores = report.items.flatMap((item) => (item.score === null ? [] : [item.score]));
    const expectedOverall = allScores.length === 9 ? roundedMean(allScores) : null;
    if (report.overallScore !== expectedOverall) {
      context.addIssue({
        code: 'custom',
        path: ['overallScore'],
        message: 'Overall score is allowed only when all nine items are scored',
      });
    }
    if (
      report.quality.evidenceCoverage.scoredItemCount !== allScores.length ||
      report.quality.evidenceCoverage.ratio !== allScores.length / 9
    ) {
      context.addIssue({
        code: 'custom',
        path: ['quality', 'evidenceCoverage'],
        message: 'Evidence coverage must match the number of scored items',
      });
    }

    const expectedEvidenceQuality = deriveOrganizationalResilienceEvidenceQuality(report.items);
    for (const field of ['level', 'concreteEvidenceCount', 'totalEvidenceCount'] as const) {
      if (report.quality.evidenceQuality[field] !== expectedEvidenceQuality[field]) {
        context.addIssue({
          code: 'custom',
          path: ['quality', 'evidenceQuality', field],
          message: 'Evidence quality must be derived from globally unique item evidence excerpts',
        });
      }
    }
  });

function roundedMean(values: readonly number[]): number {
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100;
}

type CanonicalJsonValue =
  null | boolean | number | string | CanonicalJsonValue[] | CanonicalJsonObject;
interface CanonicalJsonObject {
  readonly [key: string]: CanonicalJsonValue;
}

function canonicalizeValue(value: unknown): CanonicalJsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new TypeError('Canonical JSON cannot contain non-finite numbers');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalizeValue);
  if (typeof value === 'object') {
    const result: Record<string, CanonicalJsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined)
        throw new TypeError('Canonical JSON cannot contain undefined values');
      result[key] = canonicalizeValue(child);
    }
    return result;
  }
  throw new TypeError(`Unsupported canonical JSON value: ${typeof value}`);
}

export function canonicalizeOrganizationalResilienceInterpolationCodebook(
  codebook: OrganizationalResilienceInterpolationCodebook,
): string {
  return JSON.stringify(canonicalizeValue(codebook));
}

export function parseOrganizationalResilienceInterpolationCodebookFingerprintSidecar(
  serializedSidecar: string,
  expectedFileName: string,
): string {
  const normalized = serializedSidecar.replace(/\r\n/gu, '\n');
  const match = /^([a-f0-9]{64}) {2}([^\n]+)\n$/u.exec(normalized);
  if (match === null || match[2] !== expectedFileName || match[1] === undefined) {
    throw new TypeError('Invalid interpolation codebook fingerprint sidecar');
  }
  return match[1];
}

export function isOrganizationalResilienceCalibrationFixtureCompatible(
  fixture: OrganizationalResilienceCalibrationFixture,
  codebook: OrganizationalResilienceInterpolationCodebook,
  codebookFingerprint: string,
): boolean {
  return (
    fixture.appliesTo.instrumentId === codebook.appliesTo.instrumentId &&
    fixture.appliesTo.instrumentVersion === codebook.appliesTo.instrumentVersion &&
    fixture.appliesTo.instrumentFingerprintSha256 ===
      codebook.appliesTo.instrumentFingerprintSha256 &&
    fixture.appliesTo.interpolationCodebookId === codebook.codebookId &&
    fixture.appliesTo.interpolationCodebookVersion === codebook.codebookVersion &&
    fixture.appliesTo.interpolationCodebookFingerprintSha256 === codebookFingerprint
  );
}

type ScoreBearingItem = Pick<OrganizationalResilienceItemCoding, 'score'>;

export interface OrganizationalResilienceScoreDistribution {
  readonly byScore: Readonly<Record<OrganizationalResilienceScore, number>>;
  readonly scoredItemCount: number;
  readonly unscoredItemCount: number;
  readonly referenceAnchorCount: number;
  readonly intermediateScoreCount: number;
  readonly referenceAnchorRatio: number | null;
}

export function deriveOrganizationalResilienceScoreDistribution(
  items: readonly ScoreBearingItem[],
): OrganizationalResilienceScoreDistribution {
  const byScore: Record<OrganizationalResilienceScore, number> = {
    1: 0,
    2: 0,
    3: 0,
    4: 0,
    5: 0,
    6: 0,
    7: 0,
  };
  let unscoredItemCount = 0;
  for (const item of items) {
    if (item.score === null) unscoredItemCount += 1;
    else byScore[item.score] = (byScore[item.score] ?? 0) + 1;
  }
  const count = (score: OrganizationalResilienceScore): number => byScore[score] ?? 0;
  const referenceAnchorCount = count(1) + count(4) + count(7);
  const intermediateScoreCount = count(2) + count(3) + count(5) + count(6);
  const scoredItemCount = referenceAnchorCount + intermediateScoreCount;
  return {
    byScore,
    scoredItemCount,
    unscoredItemCount,
    referenceAnchorCount,
    intermediateScoreCount,
    referenceAnchorRatio: scoredItemCount === 0 ? null : referenceAnchorCount / scoredItemCount,
  };
}

export type OrganizationalResilienceScore = z.infer<typeof organizationalResilienceScoreSchema>;
export type OrganizationalResilienceInterpolationCodebook = z.infer<
  typeof organizationalResilienceInterpolationCodebookSchema
>;
export type OrganizationalResilienceCalibrationFixture = z.infer<
  typeof organizationalResilienceCalibrationFixtureSchema
>;
export type OrganizationalResilienceEvidenceReference = z.infer<
  typeof organizationalResilienceEvidenceReferenceSchema
>;
export type OrganizationalResilienceItemCoding = z.infer<
  typeof organizationalResilienceItemCodingSchema
>;
export type OrganizationalResilienceCodingOutput = z.infer<
  typeof organizationalResilienceCodingOutputSchema
>;
export type OrganizationalResilienceRubric = z.infer<typeof organizationalResilienceRubricSchema>;
export type OrganizationalResilienceReport = z.infer<typeof organizationalResilienceReportSchema>;
