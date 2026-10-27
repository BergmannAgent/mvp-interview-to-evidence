import { describe, expect, it } from 'vitest';

import {
  EVALUATION_PROFILE_XLSX_FILE_EXTENSION,
  EVALUATION_PROFILE_XLSX_HEADERS,
  EVALUATION_PROFILE_XLSX_LEGACY_HEADERS,
  EVALUATION_PROFILE_XLSX_LIMITS,
  EVALUATION_PROFILE_XLSX_MEDIA_TYPE,
  EVALUATION_PROFILE_XLSX_SHEETS,
  EVALUATION_PROFILE_XLSX_TEMPLATE_VERSION,
  EVALUATION_PROFILE_XLSX_UPLOAD_FIELD,
  evaluationProfileXlsxImportPreviewResponseSchema,
} from '../src/evaluation-profile-xlsx.js';

function document() {
  return {
    schemaVersion: 1 as const,
    profile: {
      profileId: 'generic-capabilities',
      name: 'Generic capabilities',
      description: 'A guide-independent example.',
      coderPrompt: 'Code only evidence that is present in the final transcript.',
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
          codingInstruction: 'Assess reliable delivery.',
          order: 0,
          anchors: anchors('delivery'),
        },
        {
          itemId: 'delivery-02',
          dimensionId: 'delivery',
          name: 'Delivery recovery',
          codingInstruction: 'Assess recovery after delivery failures.',
          order: 1,
          anchors: anchors('recovery'),
        },
        {
          itemId: 'learning-01',
          dimensionId: 'learning',
          name: 'Learning loops',
          codingInstruction: 'Assess whether experience changes future practice.',
          order: 0,
          anchors: anchors('learning'),
        },
      ],
    },
  };
}

function anchors(subject: string) {
  return [1, 2, 3, 4, 5, 6, 7].map((score) => ({
    score,
    criterion: `${subject} criterion for score ${String(score)}`,
  }));
}

function preview() {
  return {
    valid: true as const,
    document: document(),
    source: {
      fileName: 'generic-evaluation-profile.xlsx',
      templateVersion: 1 as const,
      dimensions: 2,
      items: 3,
      anchors: 21,
    },
  };
}

describe('evaluation profile XLSX contracts', () => {
  it('fixes a versioned generic workbook layout and bounded upload surface', () => {
    expect(EVALUATION_PROFILE_XLSX_TEMPLATE_VERSION).toBe(2);
    expect(EVALUATION_PROFILE_XLSX_MEDIA_TYPE).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(EVALUATION_PROFILE_XLSX_FILE_EXTENSION).toBe('.xlsx');
    expect(EVALUATION_PROFILE_XLSX_UPLOAD_FIELD).toBe('file');
    expect(EVALUATION_PROFILE_XLSX_SHEETS).toEqual({
      instructions: 'Instructions',
      profile: 'Profile',
      dimensions: 'Dimensions',
      items: 'Items',
      anchors: 'Anchors',
    });
    expect(EVALUATION_PROFILE_XLSX_HEADERS).toEqual({
      profile: [
        'template_version',
        'profile_id',
        'name',
        'description',
        'coder_prompt',
        'aggregation_mode',
        'custom_formula',
      ],
      dimensions: ['dimension_id', 'name', 'order', 'weight'],
      items: ['item_id', 'dimension_id', 'name', 'coding_instruction', 'order', 'weight'],
      anchors: ['item_id', 'score', 'criterion'],
    });
    expect(EVALUATION_PROFILE_XLSX_LIMITS).toMatchObject({
      maximumFileBytes: 10 * 1024 * 1024,
      maximumProfileRows: 2,
      maximumDimensionRows: 51,
      maximumItemRows: 501,
      maximumAnchorRows: 3_501,
    });
    expect(Object.isFrozen(EVALUATION_PROFILE_XLSX_HEADERS.items)).toBe(true);
    expect(EVALUATION_PROFILE_XLSX_LEGACY_HEADERS.profile).toEqual([
      'template_version',
      'profile_id',
      'name',
      'description',
      'coder_prompt',
    ]);
  });

  it('accepts a valid canonical preview with multiple ordered dimensions and items', () => {
    const parsed = evaluationProfileXlsxImportPreviewResponseSchema.parse(preview());

    expect(parsed.document.profile.dimensions.map(({ dimensionId }) => dimensionId)).toEqual([
      'delivery',
      'learning',
    ]);
    expect(parsed.document.profile.items.map(({ itemId }) => itemId)).toEqual([
      'delivery-01',
      'delivery-02',
      'learning-01',
    ]);
    expect(
      parsed.document.profile.items.flatMap(({ anchors: itemAnchors }) => itemAnchors),
    ).toHaveLength(21);
  });

  it('rejects incorrect source counts instead of trusting preview metadata', () => {
    for (const [field, value] of [
      ['dimensions', 1],
      ['items', 2],
      ['anchors', 20],
    ] as const) {
      const candidate = preview();
      candidate.source[field] = value;
      const parsed = evaluationProfileXlsxImportPreviewResponseSchema.safeParse(candidate);

      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues).toContainEqual(
          expect.objectContaining({ path: ['source', field] }),
        );
      }
    }
  });

  it('rejects unsupported extensions, template versions, and unknown transport fields', () => {
    for (const fileName of [
      'profile.xls',
      'profile.xlsm',
      'profile.csv',
      '../profile.xlsx',
      'folder/profile.xlsx',
      'profile\u0000.xlsx',
    ]) {
      const candidate = preview();
      candidate.source.fileName = fileName;
      expect(evaluationProfileXlsxImportPreviewResponseSchema.safeParse(candidate).success).toBe(
        false,
      );
    }

    expect(
      evaluationProfileXlsxImportPreviewResponseSchema.safeParse({
        ...preview(),
        source: { ...preview().source, templateVersion: 3 },
      }).success,
    ).toBe(false);
    expect(
      evaluationProfileXlsxImportPreviewResponseSchema.safeParse({
        ...preview(),
        guideId: 'forbidden',
      }).success,
    ).toBe(false);
    expect(
      evaluationProfileXlsxImportPreviewResponseSchema.safeParse({
        ...preview(),
        source: { ...preview().source, locale: 'de' },
      }).success,
    ).toBe(false);
  });

  it('accepts current and legacy source versions but keeps calculation configuration canonical', () => {
    for (const templateVersion of [1, 2]) {
      const candidate = {
        ...preview(),
        document: {
          ...document(),
          schemaVersion: 2,
          profile: {
            ...document().profile,
            calculation: { mode: 'formula', expression: 'item("delivery-01") * 2' },
            dimensions: document().profile.dimensions.map((dimension) => ({
              ...dimension,
              weight: 0.5,
            })),
            items: document().profile.items.map((item) => ({ ...item, weight: 0 })),
          },
        },
        source: { ...preview().source, templateVersion },
      };
      expect(evaluationProfileXlsxImportPreviewResponseSchema.parse(candidate)).toMatchObject(
        candidate,
      );
    }
  });
});
