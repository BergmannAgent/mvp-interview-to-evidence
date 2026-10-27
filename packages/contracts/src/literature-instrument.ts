import { z } from 'zod';

export const LITERATURE_INSTRUMENT_SCHEMA_VERSION = 1 as const;
export const LITERATURE_INSTRUMENT_VERSION = '1.0.0' as const;
export const LITERATURE_INSTRUMENT_ITEM_IDS = [
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
export const LITERATURE_INSTRUMENT_REFERENCE_SCORES = [1, 4, 7] as const;

const nonBlankNormalizedTextSchema = z
  .string()
  .min(1)
  .refine((value) => value === value.trim(), 'Text must not contain boundary whitespace')
  .refine((value) => value.normalize('NFC') === value, 'Text must be NFC-normalized')
  .refine((value) => value !== '0', 'The workbook placeholder 0 is not valid content');

const idSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const doiSchema = z.string().regex(/^10\.\d{4,9}\/[\w.()/:;-]+$/iu);
const cellReferenceSchema = z.string().regex(/^[A-Z]+[1-9][0-9]*$/u);
const sourceLocatorSchema = nonBlankNormalizedTextSchema
  .max(500)
  .refine(
    (value) => !/\b(?:workbook|Full_Data|Only_Anchor_V)\b/iu.test(value),
    'Source locators must point to the publication, not back to the workbook',
  )
  .refine(
    (value) =>
      /\d/u.test(value) &&
      /\b(?:abstract|appendix|article|chapter|findings|journal|page|pages|phase|results|section|table)\b/iu.test(
        value,
      ),
    'Source locators must identify a numbered publication position',
  );

const REPAIRED_EMPTY_WORKBOOK_ROWS = new Set([7, 8, 19, 21, 28, 29]);
const REPLACED_INVALID_WORKBOOK_ROWS = new Set([4, 10, 34, 45, 49, 50, 55, 63]);
const REMAPPED_WORKBOOK_ROWS = new Set([
  43, 44, 48, 51, 52, 53, 54, 57, 58, 59, 60, 62, 65, 67, 68, 69,
]);
const EXCLUDED_CONFLICT_WORKBOOK_ROW = 11;

const APPROVED_WORKBOOK_ROWS_BY_ITEM = {
  'rob-01': [7, 8, 5, 6, 3, 4],
  'rob-02': [14, 15, 12, 13, 9, 10],
  'rob-03': [20, 21, 18, 19, 16, 17],
  'rob-04': [28, 29, 26, 27, 22, 24],
  'agi-01': [39, 38, 34, 36, 30, 33],
  'agi-02': [46, 47, 44, 45, 41, 43],
  'agi-03': [52, 53, 50, 51, 48, 49],
  'int-01': [59, 60, 57, 58, 54, 55],
  'int-02': [68, 69, 65, 67, 62, 63],
} as const satisfies Record<
  (typeof LITERATURE_INSTRUMENT_ITEM_IDS)[number],
  readonly [number, number, number, number, number, number]
>;

const APPROVED_SOURCE_IDS_BY_ITEM = {
  'rob-01': [
    'chen-et-al-2021',
    'chen-et-al-2021',
    'mcmanus-2008',
    'witmer-mellinger-2016',
    'chen-et-al-2021',
    'chen-et-al-2021',
  ],
  'rob-02': [
    'mcmanus-2008',
    'mcmanus-2008',
    'mcmanus-2008',
    'mcmanus-2008',
    'chen-et-al-2021',
    'krsmanovic-et-al-2024',
  ],
  'rob-03': [
    'mcmanus-2008',
    'gan-korsgaard-2025',
    'browder-et-al-2024',
    'barasa-et-al-2018',
    'chen-et-al-2021',
    'browder-et-al-2024',
  ],
  'rob-04': [
    'sydnor-et-al-2017',
    'de-vries-hamilton-2021',
    'walker-et-al-2014',
    'walker-et-al-2014',
    'chen-et-al-2021',
    'krsmanovic-et-al-2024',
  ],
  'agi-01': [
    'krsmanovic-et-al-2024',
    'mcmanus-2008',
    'krsmanovic-et-al-2024',
    'schwaiger-2022-dissertation',
    'chen-et-al-2021',
    'mcmanus-2008',
  ],
  'agi-02': [
    'mcmanus-2008',
    'mcmanus-2008',
    'mcmanus-2008',
    'pal-2013-dissertation',
    'chen-et-al-2021',
    'browder-et-al-2024',
  ],
  'agi-03': [
    'mcmanus-2008',
    'mcmanus-2008',
    'krsmanovic-et-al-2024',
    'mcmanus-2008',
    'chen-et-al-2021',
    'krsmanovic-et-al-2024',
  ],
  'int-01': [
    'mcmanus-2008',
    'mcmanus-2008',
    'nilakant-et-al-2013',
    'witmer-mellinger-2016',
    'chen-et-al-2021',
    'walker-et-al-2014',
  ],
  'int-02': [
    'mcmanus-2008',
    'mcmanus-2008',
    'walker-et-al-2014',
    'krsmanovic-et-al-2024',
    'chen-et-al-2021',
    'khurshid-et-al-2021',
  ],
} as const satisfies Record<
  (typeof LITERATURE_INSTRUMENT_ITEM_IDS)[number],
  readonly [string, string, string, string, string, string]
>;

function expectedWorkbookProvenanceStatus(
  row: number,
): 'selected' | 'repaired_empty_slot' | 'remapped_candidate' | 'replaced_invalid_candidate' {
  if (REPAIRED_EMPTY_WORKBOOK_ROWS.has(row)) {
    return 'repaired_empty_slot';
  }
  if (REPLACED_INVALID_WORKBOOK_ROWS.has(row)) {
    return 'replaced_invalid_candidate';
  }
  if (REMAPPED_WORKBOOK_ROWS.has(row)) {
    return 'remapped_candidate';
  }
  return 'selected';
}

const ITEM_SOURCE_LOCATORS = {
  'rob-01': 'Table 4, journal page 465, Robustness item 1',
  'rob-02': 'Table 4, journal page 465, Robustness item 2',
  'rob-03': 'Table 4, journal page 465, Robustness item 3',
  'rob-04': 'Table 4, journal page 465, Robustness item 4',
  'agi-01': 'Table 4, journal page 465, Agility item 1',
  'agi-02': 'Table 4, journal page 465, Agility item 2',
  'agi-03': 'Table 4, journal page 465, Agility item 3',
  'int-01': 'Table 4, journal page 465, Integrity item 1',
  'int-02': 'Table 4, journal page 465, Integrity item 2',
} as const satisfies Record<(typeof LITERATURE_INSTRUMENT_ITEM_IDS)[number], string>;

const sourceSchema = z.strictObject({
  sourceId: idSchema,
  citation: nonBlankNormalizedTextSchema.max(1_000),
  sourceKind: z.enum([
    'scale_development',
    'primary_empirical',
    'systematic_review',
    'doctoral_thesis',
  ]),
  doi: doiSchema.optional(),
  url: z.url().optional(),
  verificationStatus: z.enum([
    'local_primary_checked',
    'publisher_source_checked',
    'repository_source_checked',
  ]),
  verificationNote: nonBlankNormalizedTextSchema.max(1_000),
  localArtifact: z
    .strictObject({
      relativePath: nonBlankNormalizedTextSchema.max(1_000),
      sha256: sha256Schema,
    })
    .optional(),
});

const fullDataProvenanceSchema = z
  .strictObject({
    sheet: z.literal('Full_Data'),
    row: z.number().int().min(3).max(70),
    cells: z.strictObject({
      score: cellReferenceSchema,
      anchor: cellReferenceSchema,
      typicalEvidence: cellReferenceSchema,
      empiricalExample: cellReferenceSchema,
      source: cellReferenceSchema,
      rationale: cellReferenceSchema,
    }),
  })
  .superRefine((provenance, context) => {
    const expectedColumns = {
      score: 'D',
      anchor: 'E',
      typicalEvidence: 'F',
      empiricalExample: 'G',
      source: 'H',
      rationale: 'I',
    } as const;
    for (const [field, column] of Object.entries(expectedColumns)) {
      const expected = `${column}${String(provenance.row)}`;
      if (provenance.cells[field as keyof typeof provenance.cells] !== expected) {
        context.addIssue({
          code: 'custom',
          path: ['cells', field],
          message: `Expected ${expected} for Full_Data row ${String(provenance.row)}`,
        });
      }
    }
  });

const onlyAnchorProvenanceSchema = z
  .strictObject({
    sheet: z.literal('Only_Anchor_V'),
    row: z.number().int().min(3).max(69),
    cells: z.strictObject({
      score: cellReferenceSchema,
      anchor: cellReferenceSchema,
    }),
  })
  .superRefine((provenance, context) => {
    if (provenance.cells.score !== `D${String(provenance.row)}`) {
      context.addIssue({
        code: 'custom',
        path: ['cells', 'score'],
        message: 'Only_Anchor_V score cell must match its row',
      });
    }
    if (provenance.cells.anchor !== `E${String(provenance.row)}`) {
      context.addIssue({
        code: 'custom',
        path: ['cells', 'anchor'],
        message: 'Only_Anchor_V anchor cell must match its row',
      });
    }
  });

const approvedExampleSchema = z.strictObject({
  exampleId: idSchema,
  evidenceKind: z.literal('observed_empirical_evidence'),
  evidenceVerificationStatus: z.literal('source_content_checked'),
  behavioralAnchorDe: nonBlankNormalizedTextSchema.max(1_000),
  typicalEvidenceDe: nonBlankNormalizedTextSchema.max(1_000),
  empiricalEvidenceDe: nonBlankNormalizedTextSchema.max(2_000),
  fitRationaleDe: nonBlankNormalizedTextSchema.max(1_000),
  sourceReference: z.strictObject({
    sourceId: idSchema,
    locator: sourceLocatorSchema,
  }),
  workbookProvenance: z.strictObject({
    status: z.enum([
      'selected',
      'repaired_empty_slot',
      'remapped_candidate',
      'replaced_invalid_candidate',
    ]),
    fullData: fullDataProvenanceSchema,
    onlyAnchor: onlyAnchorProvenanceSchema,
  }),
});

function referenceAnchorSchema<Score extends 1 | 4 | 7>(score: Score) {
  return z.strictObject({
    score: z.literal(score),
    interpretationDe: nonBlankNormalizedTextSchema.max(1_000),
    approvedExamples: z.tuple([approvedExampleSchema, approvedExampleSchema]),
  });
}

const itemSchema = z.strictObject({
  itemId: z.enum(LITERATURE_INSTRUMENT_ITEM_IDS),
  position: z.number().int().min(1).max(9),
  dimensionId: z.enum(['robustness', 'agility', 'integrity']),
  originalStatementEn: nonBlankNormalizedTextSchema.max(500),
  sourceReference: z.strictObject({
    sourceId: z.literal('kantur-iseri-say-2015'),
    locator: sourceLocatorSchema,
  }),
  elicitationQuestionDe: nonBlankNormalizedTextSchema.max(500),
  codingInstructionDe: nonBlankNormalizedTextSchema.max(2_000),
  anchors: z.tuple([referenceAnchorSchema(1), referenceAnchorSchema(4), referenceAnchorSchema(7)]),
});

const dimensionSchema = z.strictObject({
  dimensionId: z.enum(['robustness', 'agility', 'integrity']),
  label: z.enum(['Robustness', 'Agility', 'Integrity']),
  position: z.number().int().min(1).max(3),
  items: z.array(itemSchema),
});

export const literatureInstrumentSchema = z
  .strictObject({
    schemaVersion: z.literal(LITERATURE_INSTRUMENT_SCHEMA_VERSION),
    instrumentId: z.literal('kantur-iseri-say-evidence-rating'),
    instrumentVersion: z.literal(LITERATURE_INSTRUMENT_VERSION),
    classification: z.literal('derived_evidence_rating'),
    language: z.literal('de'),
    approvalStatus: z.literal('pilot_only'),
    sourceScale: z.strictObject({
      kind: z.literal('self_report_likert'),
      minimum: z.literal(1),
      maximum: z.literal(5),
      responseLabels: z.tuple([
        z.literal('strongly_disagree'),
        z.literal('disagree'),
        z.literal('neutral'),
        z.literal('agree'),
        z.literal('strongly_agree'),
      ]),
      sourceId: z.literal('kantur-iseri-say-2015'),
      locator: sourceLocatorSchema,
    }),
    evidenceScale: z.strictObject({
      kind: z.literal('interview_evidence_rating'),
      minimum: z.literal(1),
      maximum: z.literal(7),
      referenceScores: z.tuple([z.literal(1), z.literal(4), z.literal(7)]),
      interpolationPolicy: z.literal('intermediate_scores_require_evidence_between_references'),
      aggregationPolicy: z.literal('no_aggregate_score_defined'),
    }),
    methodologicalSafeguards: z.strictObject({
      missingEvidenceIsNotLowScore: z.literal(true),
      singleStatementIsNotOrganizationalFact: z.literal(true),
      derivedScaleIsNotOriginalValidatedScale: z.literal(true),
      requiresIndependentValidation: z.literal(true),
      anchorsAreParaphrases: z.literal(true),
    }),
    workbookProvenance: z.strictObject({
      fileName: z.literal('Ankerwerte.xlsx'),
      sha256: sha256Schema,
      sourceSheets: z.tuple([z.literal('Full_Data'), z.literal('Only_Anchor_V')]),
      knownEmptyAnchorCells: z.tuple([
        z.literal('E7'),
        z.literal('E8'),
        z.literal('E19'),
        z.literal('E21'),
        z.literal('E28'),
        z.literal('E29'),
      ]),
      excludedConflict: z.literal('Full_Data!D11_vs_I11'),
    }),
    sourceCatalog: z.array(sourceSchema).min(1),
    dimensions: z.array(dimensionSchema),
  })
  .superRefine((instrument, context) => {
    const expectedDimensions = [
      { dimensionId: 'robustness', label: 'Robustness', position: 1, itemCount: 4 },
      { dimensionId: 'agility', label: 'Agility', position: 2, itemCount: 3 },
      { dimensionId: 'integrity', label: 'Integrity', position: 3, itemCount: 2 },
    ] as const;
    if (instrument.dimensions.length !== expectedDimensions.length) {
      context.addIssue({
        code: 'custom',
        path: ['dimensions'],
        message: 'The instrument must contain exactly three dimensions',
      });
    }

    const sourceIds = new Set<string>();
    for (const [index, source] of instrument.sourceCatalog.entries()) {
      if (sourceIds.has(source.sourceId)) {
        context.addIssue({
          code: 'custom',
          path: ['sourceCatalog', index, 'sourceId'],
          message: 'Source IDs must be unique',
        });
      }
      sourceIds.add(source.sourceId);
    }

    const itemIds = new Set<string>();
    const exampleIds = new Set<string>();
    const workbookRows = new Set<number>();
    const onlyAnchorRows = new Set<number>();
    const evidenceKeys = new Set<string>();
    const referencedSourceIds = new Set<string>([instrument.sourceScale.sourceId]);
    const observedItemIds: string[] = [];
    let exampleCount = 0;

    for (const [dimensionIndex, dimension] of instrument.dimensions.entries()) {
      const expected = expectedDimensions[dimensionIndex];
      if (
        expected === undefined ||
        dimension.dimensionId !== expected.dimensionId ||
        dimension.label !== expected.label ||
        dimension.position !== expected.position ||
        dimension.items.length !== expected.itemCount
      ) {
        context.addIssue({
          code: 'custom',
          path: ['dimensions', dimensionIndex],
          message: 'Dimension order, identity, label, position, or item count is invalid',
        });
      }

      for (const [itemIndex, item] of dimension.items.entries()) {
        observedItemIds.push(item.itemId);
        if (item.dimensionId !== dimension.dimensionId) {
          context.addIssue({
            code: 'custom',
            path: ['dimensions', dimensionIndex, 'items', itemIndex, 'dimensionId'],
            message: 'An item must belong to its containing dimension',
          });
        }
        if (item.position !== observedItemIds.length || itemIds.has(item.itemId)) {
          context.addIssue({
            code: 'custom',
            path: ['dimensions', dimensionIndex, 'items', itemIndex, 'position'],
            message: 'Item positions and IDs must be globally ordered and unique',
          });
        }
        itemIds.add(item.itemId);
        referencedSourceIds.add(item.sourceReference.sourceId);
        if (item.sourceReference.locator !== ITEM_SOURCE_LOCATORS[item.itemId]) {
          context.addIssue({
            code: 'custom',
            path: ['dimensions', dimensionIndex, 'items', itemIndex, 'sourceReference', 'locator'],
            message: 'The item source locator must identify its exact row in Kantur Table 4',
          });
        }

        for (const [anchorIndex, anchor] of item.anchors.entries()) {
          if (anchor.score !== LITERATURE_INSTRUMENT_REFERENCE_SCORES[anchorIndex]) {
            context.addIssue({
              code: 'custom',
              path: ['dimensions', dimensionIndex, 'items', itemIndex, 'anchors', anchorIndex],
              message: 'Reference anchors must be ordered 1, 4, 7',
            });
          }
          for (const [exampleIndex, example] of anchor.approvedExamples.entries()) {
            exampleCount += 1;
            const basePath = [
              'dimensions',
              dimensionIndex,
              'items',
              itemIndex,
              'anchors',
              anchorIndex,
              'approvedExamples',
              exampleIndex,
            ];
            const expectedExampleId = `${item.itemId}-${String(anchor.score)}-${exampleIndex === 0 ? 'a' : 'b'}`;
            const exampleSlotIndex = anchorIndex * 2 + exampleIndex;
            if (example.exampleId !== expectedExampleId) {
              context.addIssue({
                code: 'custom',
                path: [...basePath, 'exampleId'],
                message: `Expected stable example ID ${expectedExampleId}`,
              });
            }
            if (exampleIds.has(example.exampleId)) {
              context.addIssue({
                code: 'custom',
                path: [...basePath, 'exampleId'],
                message: 'Approved example IDs must be globally unique',
              });
            }
            exampleIds.add(example.exampleId);
            referencedSourceIds.add(example.sourceReference.sourceId);
            const expectedSourceId = APPROVED_SOURCE_IDS_BY_ITEM[item.itemId][exampleSlotIndex];
            if (
              expectedSourceId === undefined ||
              example.sourceReference.sourceId !== expectedSourceId
            ) {
              context.addIssue({
                code: 'custom',
                path: [...basePath, 'sourceReference', 'sourceId'],
                message: `Expected approved source ${String(expectedSourceId)} for ${expectedExampleId}`,
              });
            }
            if (!sourceIds.has(example.sourceReference.sourceId)) {
              context.addIssue({
                code: 'custom',
                path: [...basePath, 'sourceReference', 'sourceId'],
                message: 'Approved examples must resolve to the source catalog',
              });
            }
            const row = example.workbookProvenance.fullData.row;
            const provenanceStatus = example.workbookProvenance.status;
            const expectedRow = APPROVED_WORKBOOK_ROWS_BY_ITEM[item.itemId][exampleSlotIndex];
            if (expectedRow === undefined || row !== expectedRow) {
              context.addIssue({
                code: 'custom',
                path: [...basePath, 'workbookProvenance', 'fullData', 'row'],
                message: `Expected Full_Data row ${String(expectedRow)} for ${expectedExampleId}`,
              });
            }
            if (row === EXCLUDED_CONFLICT_WORKBOOK_ROW) {
              context.addIssue({
                code: 'custom',
                path: [...basePath, 'workbookProvenance', 'fullData', 'row'],
                message: 'The contradictory Full_Data row 11 may not be approved',
              });
            }
            if (provenanceStatus !== expectedWorkbookProvenanceStatus(row)) {
              context.addIssue({
                code: 'custom',
                path: [...basePath, 'workbookProvenance', 'status'],
                message:
                  'Workbook provenance status does not match the approved source-row decision',
              });
            }
            if (workbookRows.has(row)) {
              context.addIssue({
                code: 'custom',
                path: [...basePath, 'workbookProvenance', 'fullData', 'row'],
                message: 'A Full_Data candidate row may be approved only once',
              });
            }
            workbookRows.add(row);
            const onlyAnchorRow = example.workbookProvenance.onlyAnchor.row;
            const expectedOnlyAnchorRow = row <= 41 ? row : row - 1;
            if (onlyAnchorRow !== expectedOnlyAnchorRow) {
              context.addIssue({
                code: 'custom',
                path: [...basePath, 'workbookProvenance', 'onlyAnchor', 'row'],
                message: `Full_Data row ${String(row)} must map to Only_Anchor_V row ${String(expectedOnlyAnchorRow)}`,
              });
            }
            if (onlyAnchorRows.has(onlyAnchorRow)) {
              context.addIssue({
                code: 'custom',
                path: [...basePath, 'workbookProvenance', 'onlyAnchor', 'row'],
                message: 'An Only_Anchor_V slot may be approved only once',
              });
            }
            onlyAnchorRows.add(onlyAnchorRow);
            const evidenceKey = [
              example.sourceReference.sourceId,
              example.sourceReference.locator,
              example.empiricalEvidenceDe,
            ]
              .map((value) => value.normalize('NFC').toLocaleLowerCase('de'))
              .join('\u0000');
            if (evidenceKeys.has(evidenceKey)) {
              context.addIssue({
                code: 'custom',
                path: [...basePath, 'empiricalEvidenceDe'],
                message: 'The same sourced empirical example may not be approved twice',
              });
            }
            evidenceKeys.add(evidenceKey);
          }
        }
      }
    }

    if (observedItemIds.join('|') !== LITERATURE_INSTRUMENT_ITEM_IDS.join('|')) {
      context.addIssue({
        code: 'custom',
        path: ['dimensions'],
        message: 'The nine stable item IDs must appear in their defined order',
      });
    }
    if (exampleCount !== 54) {
      context.addIssue({
        code: 'custom',
        path: ['dimensions'],
        message: 'The instrument must contain exactly 54 approved examples',
      });
    }
    if (!sourceIds.has(instrument.sourceScale.sourceId)) {
      context.addIssue({
        code: 'custom',
        path: ['sourceScale', 'sourceId'],
        message: 'The source scale must resolve to the source catalog',
      });
    }
    for (const [sourceIndex, source] of instrument.sourceCatalog.entries()) {
      if (
        source.verificationStatus === 'local_primary_checked' &&
        source.localArtifact === undefined
      ) {
        context.addIssue({
          code: 'custom',
          path: ['sourceCatalog', sourceIndex, 'localArtifact'],
          message: 'A locally checked source must include its artifact path and digest',
        });
      }
      if (!referencedSourceIds.has(source.sourceId)) {
        context.addIssue({
          code: 'custom',
          path: ['sourceCatalog', sourceIndex, 'sourceId'],
          message: 'Every catalog source must be referenced by the instrument',
        });
      }
    }
  });

export type LiteratureInstrument = z.infer<typeof literatureInstrumentSchema>;

export const DEFAULT_OR_PROFILE_ENGLISH_OVERLAY_SCHEMA_VERSION = 1 as const;
export const DEFAULT_OR_PROFILE_ENGLISH_OVERLAY_ID = 'default-or-evaluation-profile-en' as const;
export const DEFAULT_OR_PROFILE_ENGLISH_OVERLAY_VERSION = '1.0.0' as const;

function defaultOrProfileTranslationAnchorSchema<Score extends 1 | 2 | 3 | 4 | 5 | 6 | 7>(
  score: Score,
) {
  return z.strictObject({
    score: z.literal(score),
    criterion: nonBlankNormalizedTextSchema.max(4_000),
  });
}

const defaultOrProfileTranslationItemSchema = z.strictObject({
  itemId: z.enum(LITERATURE_INSTRUMENT_ITEM_IDS),
  dimensionId: z.enum(['robustness', 'agility', 'integrity']),
  name: nonBlankNormalizedTextSchema.max(300),
  codingInstruction: nonBlankNormalizedTextSchema.max(4_000),
  anchors: z.tuple([
    defaultOrProfileTranslationAnchorSchema(1),
    defaultOrProfileTranslationAnchorSchema(2),
    defaultOrProfileTranslationAnchorSchema(3),
    defaultOrProfileTranslationAnchorSchema(4),
    defaultOrProfileTranslationAnchorSchema(5),
    defaultOrProfileTranslationAnchorSchema(6),
    defaultOrProfileTranslationAnchorSchema(7),
  ]),
});

const defaultOrEnglishExampleSchema = z.strictObject({
  exampleId: idSchema,
  behavioralAnchor: nonBlankNormalizedTextSchema.max(1_000),
  typicalEvidence: nonBlankNormalizedTextSchema.max(1_000),
  empiricalEvidence: nonBlankNormalizedTextSchema.max(2_000),
  sourceReference: z.strictObject({
    sourceId: idSchema,
    locator: sourceLocatorSchema,
  }),
});

const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);

export const defaultOrProfileEnglishOverlaySchema = z
  .strictObject({
    schemaVersion: z.literal(DEFAULT_OR_PROFILE_ENGLISH_OVERLAY_SCHEMA_VERSION),
    overlayId: z.literal(DEFAULT_OR_PROFILE_ENGLISH_OVERLAY_ID),
    overlayVersion: z.literal(DEFAULT_OR_PROFILE_ENGLISH_OVERLAY_VERSION),
    language: z.literal('en'),
    classification: z.literal('controlled_translation_of_derived_pilot_instrument'),
    approvalStatus: z.literal('pilot_only'),
    appliesTo: z.strictObject({
      instrumentId: z.literal('kantur-iseri-say-evidence-rating'),
      instrumentVersion: z.literal(LITERATURE_INSTRUMENT_VERSION),
      instrumentFingerprintSha256: sha256Schema,
      interpolationCodebookId: z.literal('or-evidence-interpolation-codebook'),
      interpolationCodebookVersion: z.literal('1.0.0'),
      interpolationCodebookFingerprintSha256: sha256Schema,
    }),
    translationMethod: z.strictObject({
      sourceLanguage: z.literal('de'),
      originalItemStatements: z.literal('primary_source_english_wording_preserved'),
      derivedRuntimeTexts: z.literal('controlled_semantic_translation'),
      validationStatus: z.literal('not_psychometrically_validated'),
      scope: z.literal('complete_or_runtime_texts'),
      method: z.literal('controlled_semantic_translation_with_source_identity_preservation'),
      curator: z.strictObject({
        identity: z.literal('codex-assisted-translation'),
        kind: z.literal('ai_assisted'),
      }),
      reviewer: z.strictObject({
        identity: z.literal('automated-schema-and-parity-review'),
        kind: z.literal('automated_validation'),
      }),
      curatedOn: dateOnlySchema,
      reviewedOn: dateOnlySchema,
      humanReviewStatus: z.literal('pending'),
    }),
    profile: z.strictObject({
      description: nonBlankNormalizedTextSchema.max(2_000),
      coderPrompt: nonBlankNormalizedTextSchema.max(20_000),
      dimensions: z.tuple([
        z.strictObject({ dimensionId: z.literal('robustness'), name: z.literal('Robustness') }),
        z.strictObject({ dimensionId: z.literal('agility'), name: z.literal('Agility') }),
        z.strictObject({ dimensionId: z.literal('integrity'), name: z.literal('Integrity') }),
      ]),
      items: z.tuple([
        defaultOrProfileTranslationItemSchema,
        defaultOrProfileTranslationItemSchema,
        defaultOrProfileTranslationItemSchema,
        defaultOrProfileTranslationItemSchema,
        defaultOrProfileTranslationItemSchema,
        defaultOrProfileTranslationItemSchema,
        defaultOrProfileTranslationItemSchema,
        defaultOrProfileTranslationItemSchema,
        defaultOrProfileTranslationItemSchema,
      ]),
    }),
    rubric: z.strictObject({
      title: nonBlankNormalizedTextSchema.max(300),
      description: nonBlankNormalizedTextSchema.max(2_000),
      examples: z.array(defaultOrEnglishExampleSchema).length(54),
    }),
  })
  .superRefine((overlay, context) => {
    const expectedDimensions = ['robustness', 'agility', 'integrity'] as const;
    for (const [index, expectedItemId] of LITERATURE_INSTRUMENT_ITEM_IDS.entries()) {
      const item = overlay.profile.items[index];
      const expectedDimension = index < 4 ? 'robustness' : index < 7 ? 'agility' : 'integrity';
      if (item?.itemId !== expectedItemId) {
        context.addIssue({
          code: 'custom',
          path: ['profile', 'items', index, 'itemId'],
          message: `Expected translated item ${expectedItemId}`,
        });
      }
      if (item?.dimensionId !== expectedDimension) {
        context.addIssue({
          code: 'custom',
          path: ['profile', 'items', index, 'dimensionId'],
          message: `Translated item ${expectedItemId} belongs to ${expectedDimension}`,
        });
      }
    }
    for (const [index, expectedDimension] of expectedDimensions.entries()) {
      if (overlay.profile.dimensions[index]?.dimensionId !== expectedDimension) {
        context.addIssue({
          code: 'custom',
          path: ['profile', 'dimensions', index, 'dimensionId'],
          message: `Expected translated dimension ${expectedDimension}`,
        });
      }
    }

    const expectedExampleIds = LITERATURE_INSTRUMENT_ITEM_IDS.flatMap((itemId) =>
      LITERATURE_INSTRUMENT_REFERENCE_SCORES.flatMap((score) => [
        `${itemId}-${String(score)}-a`,
        `${itemId}-${String(score)}-b`,
      ]),
    );
    for (const [index, expectedExampleId] of expectedExampleIds.entries()) {
      if (overlay.rubric.examples[index]?.exampleId !== expectedExampleId) {
        context.addIssue({
          code: 'custom',
          path: ['rubric', 'examples', index, 'exampleId'],
          message: `Expected translated example ${expectedExampleId}`,
        });
      }
    }
  });

export type DefaultOrProfileEnglishOverlay = z.infer<typeof defaultOrProfileEnglishOverlaySchema>;

export interface DefaultOrProfileEnglishOverlayParityResult {
  readonly compatible: boolean;
  readonly issues: readonly string[];
}

export function checkDefaultOrProfileEnglishOverlayParity(
  overlay: DefaultOrProfileEnglishOverlay,
  instrument: LiteratureInstrument,
): DefaultOrProfileEnglishOverlayParityResult {
  const sourceExamples = instrument.dimensions.flatMap((dimension) =>
    dimension.items.flatMap((item) => item.anchors.flatMap((anchor) => anchor.approvedExamples)),
  );
  const issues: string[] = [];
  for (const [index, source] of sourceExamples.entries()) {
    const translated = overlay.rubric.examples[index];
    if (translated === undefined) {
      issues.push(`Missing translated example ${source.exampleId}.`);
      continue;
    }
    if (translated.exampleId !== source.exampleId) {
      issues.push(`Translated example ${String(index + 1)} must preserve ID ${source.exampleId}.`);
    }
    if (translated.sourceReference.sourceId !== source.sourceReference.sourceId) {
      issues.push(`Translated example ${source.exampleId} must preserve its source ID.`);
    }
    if (translated.sourceReference.locator !== source.sourceReference.locator) {
      issues.push(`Translated example ${source.exampleId} must preserve its source locator.`);
    }
  }
  return { compatible: issues.length === 0, issues };
}

type CanonicalJsonValue =
  null | boolean | number | string | CanonicalJsonValue[] | CanonicalJsonObject;
interface CanonicalJsonObject {
  readonly [key: string]: CanonicalJsonValue;
}

function canonicalizeValue(value: unknown): CanonicalJsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Canonical JSON cannot contain non-finite numbers');
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalizeValue);
  }
  if (typeof value === 'object') {
    const result: Record<string, CanonicalJsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined) {
        throw new TypeError('Canonical JSON cannot contain undefined values');
      }
      result[key] = canonicalizeValue(child);
    }
    return result;
  }
  throw new TypeError(`Unsupported canonical JSON value: ${typeof value}`);
}

export function canonicalizeLiteratureInstrument(instrument: LiteratureInstrument): string {
  return JSON.stringify(canonicalizeValue(instrument));
}

export function canonicalizeDefaultOrProfileEnglishOverlay(
  overlay: DefaultOrProfileEnglishOverlay,
): string {
  return JSON.stringify(canonicalizeValue(overlay));
}

export function parseLiteratureInstrumentFingerprintSidecar(
  serializedSidecar: string,
  expectedFileName: string,
): string {
  const normalized = serializedSidecar.replace(/\r\n/gu, '\n');
  const match = /^([a-f0-9]{64}) {2}([^\n]+)\n$/u.exec(normalized);
  if (match === null || match[2] !== expectedFileName) {
    throw new TypeError('Invalid literature instrument fingerprint sidecar');
  }
  const digest = match[1];
  if (digest === undefined) {
    throw new TypeError('Invalid literature instrument fingerprint sidecar');
  }
  return digest;
}
