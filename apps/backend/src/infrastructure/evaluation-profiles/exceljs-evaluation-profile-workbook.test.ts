import {
  EVALUATION_PROFILE_XLSX_MEDIA_TYPE,
  EVALUATION_PROFILE_XLSX_LEGACY_HEADERS,
  EVALUATION_PROFILE_XLSX_SHEETS,
  evaluationProfileXlsxImportPreviewResponseSchema,
} from '@orgscience/contracts';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

import { EvaluationProfileXlsxWorkbookError } from '../../application/evaluation-profiles/index.js';
import { ExcelJsEvaluationProfileXlsxWorkbook } from './exceljs-evaluation-profile-workbook.js';

const FILE_NAME = 'evaluation-profile.xlsx';

describe('ExcelJsEvaluationProfileXlsxWorkbook', () => {
  it('generates a deterministic generic template that round-trips into the canonical contract', async () => {
    const adapter = new ExcelJsEvaluationProfileXlsxWorkbook();
    const artifact = await adapter.createTemplate();

    expect(artifact.fileName).toBe('evaluation-profile-template-v2.xlsx');
    expect(artifact.contentType).toBe(EVALUATION_PROFILE_XLSX_MEDIA_TYPE);
    expect(artifact.body.byteLength).toBeGreaterThan(0);

    const preview = await adapter.previewImport(upload(artifact.body, artifact.fileName));
    expect(evaluationProfileXlsxImportPreviewResponseSchema.parse(preview)).toEqual(preview);
    expect(preview.source).toEqual({
      fileName: artifact.fileName,
      templateVersion: 2,
      dimensions: 1,
      items: 1,
      anchors: 7,
    });
    expect(preview.document.profile).toMatchObject({
      profileId: 'profile-template',
      name: 'New evaluation profile',
      scale: { minimum: 1, maximum: 7 },
      calculation: { mode: 'weighted_mean' },
      dimensions: [{ weight: 1 }],
      items: [{ weight: 1 }],
    });
  });

  it('normalizes multiple dimensions and items by explicit zero-based order', async () => {
    const workbook = await loadTemplate();
    replaceData(workbook.getWorksheet(EVALUATION_PROFILE_XLSX_SHEETS.profile), [
      [
        2,
        'profile-general',
        'General profile',
        '',
        'Code only supported interview evidence.',
        'weighted_mean',
        '',
      ],
    ]);
    replaceData(workbook.getWorksheet(EVALUATION_PROFILE_XLSX_SHEETS.dimensions), [
      ['dimension-b', 'Second', 1],
      ['dimension-a', 'First', 0],
    ]);
    replaceData(workbook.getWorksheet(EVALUATION_PROFILE_XLSX_SHEETS.items), [
      ['item-b2', 'dimension-b', 'B second', 'Code B second.', 1],
      ['item-a1', 'dimension-a', 'A first', 'Code A first.', 0],
      ['item-b1', 'dimension-b', 'B first', 'Code B first.', 0],
    ]);
    replaceData(
      workbook.getWorksheet(EVALUATION_PROFILE_XLSX_SHEETS.anchors),
      ['item-b2', 'item-a1', 'item-b1'].flatMap((itemId) =>
        [7, 2, 5, 1, 6, 3, 4].map((score) => [
          itemId,
          score,
          `${itemId} criterion ${String(score)}`,
        ]),
      ),
    );

    const preview = await new ExcelJsEvaluationProfileXlsxWorkbook().previewImport(
      upload(await write(workbook)),
    );

    expect(preview.document.profile.dimensions.map(({ dimensionId }) => dimensionId)).toEqual([
      'dimension-a',
      'dimension-b',
    ]);
    expect(preview.document.profile.items.map(({ itemId }) => itemId)).toEqual([
      'item-a1',
      'item-b1',
      'item-b2',
    ]);
    for (const item of preview.document.profile.items) {
      expect(item.anchors.map(({ score }) => score)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    }
    expect(preview.source).toMatchObject({ dimensions: 2, items: 3, anchors: 21 });
  });

  it('imports exact v1 headers with implicit unit weights and weighted-mean defaults', async () => {
    const workbook = await loadTemplate();
    for (const key of ['profile', 'dimensions', 'items'] as const) {
      const sheet = workbook.getWorksheet(EVALUATION_PROFILE_XLSX_SHEETS[key])!;
      const headers = EVALUATION_PROFILE_XLSX_LEGACY_HEADERS[key];
      sheet.spliceColumns(headers.length + 1, sheet.columnCount - headers.length);
      sheet.getRow(1).values = [...headers];
    }
    workbook.getWorksheet('Profile')!.getCell('A2').value = 1;

    const preview = await new ExcelJsEvaluationProfileXlsxWorkbook().previewImport(
      upload(await write(workbook)),
    );
    expect(preview.source.templateVersion).toBe(1);
    expect(preview.document.schemaVersion).toBe(2);
    if (preview.document.schemaVersion !== 2) throw new Error('Expected current profile document');
    expect(preview.document.profile.calculation).toBeUndefined();
    expect(preview.document.profile.dimensions[0]!.weight).toBeUndefined();
    expect(preview.document.profile.items[0]!.weight).toBeUndefined();
  });

  it('imports a custom expression as inert text and preserves decimal and zero weights', async () => {
    const workbook = await loadTemplate();
    const profile = workbook.getWorksheet('Profile')!;
    profile.getCell('F2').value = 'formula';
    profile.getCell('G2').value = 'item("item-1") * 3 + dimension("dimension-1")';
    workbook.getWorksheet('Dimensions')!.getCell('D2').value = 0.5;
    workbook.getWorksheet('Items')!.getCell('F2').value = 0;

    const preview = await new ExcelJsEvaluationProfileXlsxWorkbook().previewImport(
      upload(await write(workbook)),
    );
    if (preview.document.schemaVersion !== 2) throw new Error('Expected current profile document');
    expect(preview.document.profile.calculation).toEqual({
      mode: 'formula',
      expression: profile.getCell('G2').value,
    });
    expect(preview.document.profile.dimensions[0]!.weight).toBe(0.5);
    expect(preview.document.profile.items[0]!.weight).toBe(0);
  });

  it.each([
    { sheet: 'Profile', cell: 'F2', value: 'unknown', code: 'invalid_aggregation_mode' },
    { sheet: 'Profile', cell: 'G2', value: 'item("item-1")', code: 'unexpected_formula' },
    { sheet: 'Dimensions', cell: 'D2', value: -1, code: 'invalid_weight' },
    { sheet: 'Items', cell: 'F2', value: '2', code: 'invalid_weight' },
  ])(
    'rejects invalid calculation configuration at $sheet!$cell',
    async ({ sheet, cell, value, code }) => {
      const workbook = await loadTemplate();
      workbook.getWorksheet(sheet)!.getCell(cell).value = value;
      const error = await importError(await write(workbook));
      expect(error.fieldErrors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: ['sheets', sheet, 'rows', 2, 'columns', cell[0]], code }),
        ]),
      );
    },
  );

  it('does not accept v2 calculation columns under a v1 version declaration', async () => {
    const workbook = await loadTemplate();
    workbook.getWorksheet('Profile')!.getCell('A2').value = 1;
    const error = await importError(await write(workbook));
    expect(error.fieldErrors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'too_many_columns' })]),
    );
  });

  it.each(['item("unknown")', 'globalThis.process()', '=SUM(1, 2)'])(
    'rejects an invalid plain-text expression %s at Profile!G2',
    async (expression) => {
      const workbook = await loadTemplate();
      const profile = workbook.getWorksheet('Profile')!;
      profile.getCell('F2').value = 'formula';
      profile.getCell('G2').value = expression;
      const error = await importError(await write(workbook));
      expect(error.fieldErrors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: ['sheets', 'Profile', 'rows', 2, 'columns', 'G'] }),
        ]),
      );
    },
  );

  it('rejects actual Excel formulas in the custom formula cell', async () => {
    const workbook = await loadTemplate();
    const profile = workbook.getWorksheet('Profile')!;
    profile.getCell('F2').value = 'formula';
    profile.getCell('G2').value = { formula: '1+2', result: 3 };
    const error = await importError(await write(workbook));
    expect(error.fieldErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['sheets', 'Profile', 'rows', 2, 'columns', 'G'],
          code: 'formula_forbidden',
        }),
      ]),
    );
  });

  it('rejects formulas without consuming their cached result and identifies the exact cell', async () => {
    const workbook = await loadTemplate();
    workbook.getWorksheet(EVALUATION_PROFILE_XLSX_SHEETS.items)!.getCell('D2').value = {
      formula: 'CONCAT("unsafe", " value")',
      result: 'cached value',
    };

    const error = await importError(await write(workbook));
    expect(error.fieldErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['sheets', 'Items', 'rows', 2, 'columns', 'D'],
          code: 'formula_forbidden',
        }),
      ]),
    );
  });

  it.each([
    {
      feature: 'data validation',
      apply: (sheet: ExcelJS.Worksheet) => {
        sheet.getCell('C2').dataValidation = {
          type: 'custom',
          formulae: ['WEBSERVICE("https://example.invalid")'],
        };
      },
    },
    {
      feature: 'conditional formatting',
      apply: (sheet: ExcelJS.Worksheet) => {
        sheet.addConditionalFormatting({
          ref: 'C2',
          rules: [
            {
              type: 'expression',
              priority: 1,
              formulae: ['C2="New evaluation profile"'],
              style: { font: { bold: true } },
            },
          ],
        });
      },
    },
  ])('rejects formula-bearing $feature workbook features', async ({ apply }) => {
    const workbook = await loadTemplate();
    apply(workbook.getWorksheet(EVALUATION_PROFILE_XLSX_SHEETS.profile)!);

    const error = await importError(await write(workbook));
    expect(error.fieldErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['file', 'archive', 'xl/worksheets/sheet2.xml'],
          code: 'worksheet_feature_formula_forbidden',
        }),
      ]),
    );
  });

  it('rejects invalid headers before parsing workbook rows', async () => {
    const workbook = await loadTemplate();
    const dimensions = workbook.getWorksheet(EVALUATION_PROFILE_XLSX_SHEETS.dimensions)!;
    dimensions.getCell('A1').value = 'wrong_header';

    const error = await importError(await write(workbook));
    expect(error.fieldErrors).toEqual([
      expect.objectContaining({
        path: ['sheets', 'Dimensions', 'rows', 1, 'columns', 'A'],
        code: 'invalid_header',
      }),
    ]);
  });

  it('reports unknown dimensions, duplicate IDs, and missing scores by position', async () => {
    const workbook = await loadTemplate();
    const dimensions = workbook.getWorksheet(EVALUATION_PROFILE_XLSX_SHEETS.dimensions)!;
    dimensions.addRow(['dimension-1', 'Duplicate', 1]);
    const items = workbook.getWorksheet(EVALUATION_PROFILE_XLSX_SHEETS.items)!;
    items.getCell('B2').value = 'missing-dimension';
    const anchors = workbook.getWorksheet(EVALUATION_PROFILE_XLSX_SHEETS.anchors)!;
    anchors.spliceRows(8, 1);

    const error = await importError(await write(workbook));
    expect(error.fieldErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['sheets', 'Dimensions', 'rows', 3, 'columns', 'A'],
          code: 'duplicate_dimension_id',
        }),
        expect.objectContaining({
          path: ['sheets', 'Items', 'rows', 2, 'columns', 'B'],
          code: 'unknown_dimension_id',
        }),
        expect.objectContaining({
          path: ['sheets', 'Anchors', 'rows', expect.any(Number), 'columns', 'B'],
          code: 'missing_anchor_score',
        }),
      ]),
    );
  });

  it('rejects foreign legacy layouts rather than interpreting arbitrary Ankerwerte workbooks', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Ankerwerte').addRow(['Dimension', '1', '4', '7']);

    const error = await importError(await write(workbook), 'Ankerwerte.xlsx');
    expect(error.fieldErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ['sheets', 'Ankerwerte'], code: 'unexpected_sheet' }),
        expect.objectContaining({ path: ['sheets', 'Profile'], code: 'missing_sheet' }),
      ]),
    );
  });

  it('rejects macro-capable extensions, disguised non-ZIP bytes, and forbidden archive entries', async () => {
    const adapter = new ExcelJsEvaluationProfileXlsxWorkbook();
    const template = await adapter.createTemplate();

    await expect(
      adapter.previewImport(upload(template.body, 'profile.xlsm')),
    ).rejects.toMatchObject({
      fieldErrors: [expect.objectContaining({ code: 'invalid_file_name' })],
    });
    await expect(
      adapter.previewImport(upload(new TextEncoder().encode('not an xlsx'))),
    ).rejects.toMatchObject({
      fieldErrors: [expect.objectContaining({ code: 'invalid_xlsx_signature' })],
    });

    const forbidden = replaceAscii(template.body, 'xl/theme/theme1.xml', 'xl/embeddings/a.bin');
    await expect(adapter.previewImport(upload(forbidden))).rejects.toMatchObject({
      fieldErrors: [expect.objectContaining({ code: 'forbidden_archive_content' })],
    });
  });

  it('rejects path-like names and unsupported media types at the adapter boundary', async () => {
    const template = await new ExcelJsEvaluationProfileXlsxWorkbook().createTemplate();

    await expect(
      new ExcelJsEvaluationProfileXlsxWorkbook().previewImport({
        ...upload(template.body),
        fileName: '../profile.xlsx',
        mediaType: 'application/vnd.ms-excel',
      }),
    ).rejects.toMatchObject({
      fieldErrors: expect.arrayContaining([
        expect.objectContaining({ code: 'invalid_file_name' }),
        expect.objectContaining({ code: 'invalid_file_type' }),
      ]),
    });
  });

  it('rejects materialized worksheet row bombs during archive preflight', async () => {
    const workbook = await loadTemplate();
    const instructions = workbook.getWorksheet(EVALUATION_PROFILE_XLSX_SHEETS.instructions)!;
    instructions.addRows(
      Array.from({ length: 3_500 }, (_, index) => [`Excess row ${String(index + 1)}`]),
    );

    const error = await importError(await write(workbook));
    expect(error.fieldErrors).toEqual([
      expect.objectContaining({
        code: 'worksheet_xml_too_many_rows',
      }),
    ]);
  });

  it('rejects dense worksheet cell bombs during archive preflight', async () => {
    const workbook = await loadTemplate();
    const instructions = workbook.getWorksheet(EVALUATION_PROFILE_XLSX_SHEETS.instructions)!;
    instructions.spliceRows(1, instructions.rowCount);
    instructions.addRows(
      Array.from({ length: 2_400 }, (_, row) =>
        Array.from({ length: 10 }, (_, column) => `${String(row)}-${String(column)}`),
      ),
    );

    const error = await importError(await write(workbook));
    expect(error.fieldErrors).toEqual([
      expect.objectContaining({
        code: 'worksheet_xml_too_many_cells',
      }),
    ]);
  });

  it('fails fast on sparse rows and columns outside the semantic sheet bounds', async () => {
    const workbook = await loadTemplate();
    const dimensions = workbook.getWorksheet(EVALUATION_PROFILE_XLSX_SHEETS.dimensions)!;
    dimensions.getCell('A100000').value = 'outside-row-limit';
    dimensions.getCell('XFD2').value = 'outside-column-limit';

    const error = await importError(await write(workbook));
    expect(error.fieldErrors).toHaveLength(2);
    expect(error.fieldErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'too_many_rows' }),
        expect.objectContaining({ code: 'too_many_columns' }),
      ]),
    );
  });

  it('decodes XML entities before rejecting external relationships and active content types', async () => {
    const workbook = await loadTemplate();
    workbook.getWorksheet(EVALUATION_PROFILE_XLSX_SHEETS.profile)!.getCell('C2').value = {
      text: 'external',
      hyperlink: 'https://example.invalid',
    };
    const externalRelationship = await write(workbook);
    for (const encodedAttributes of [
      'TargetMode="&#x20;&#69;xternal&#x20;"',
      'xmlns:x="urn:test" x:TargetMode="Internal" TargetMode="External"',
    ]) {
      const mutatedRelationship = await mutateZipEntry(
        externalRelationship,
        'xl/worksheets/_rels/sheet2.xml.rels',
        (xml) => xml.replace('TargetMode="External"', encodedAttributes),
      );
      expect((await importError(mutatedRelationship)).fieldErrors).toEqual([
        expect.objectContaining({ code: 'external_relationship_forbidden' }),
      ]);
    }

    const activeContentType = await mutateZipEntry(
      await write(await loadTemplate()),
      '[Content_Types].xml',
      (xml) =>
        xml.replace('application/xml', 'application/vnd.ms-excel.sheet.macro&#x45;nabled.main+xml'),
    );
    expect((await importError(activeContentType)).fieldErrors).toEqual([
      expect.objectContaining({ code: 'active_content_forbidden' }),
    ]);
  });

  it('rejects embedded images before ExcelJS materializes workbook media', async () => {
    const workbook = await loadTemplate();
    const image = workbook.addImage({
      base64:
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      extension: 'png',
    });
    workbook.getWorksheet(EVALUATION_PROFILE_XLSX_SHEETS.instructions)!.addImage(image, 'B2:C3');

    const error = await importError(await write(workbook));
    expect(error.fieldErrors).toEqual([
      expect.objectContaining({ code: 'forbidden_archive_content' }),
    ]);
  });
});

function upload(bytes: Uint8Array, fileName = FILE_NAME) {
  return { fileName, mediaType: EVALUATION_PROFILE_XLSX_MEDIA_TYPE, bytes };
}

async function loadTemplate(): Promise<ExcelJS.Workbook> {
  const artifact = await new ExcelJsEvaluationProfileXlsxWorkbook().createTemplate();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Uint8Array.from(artifact.body).buffer);
  return workbook;
}

function replaceData(
  sheet: ExcelJS.Worksheet | undefined,
  rows: readonly (readonly unknown[])[],
): void {
  if (sheet === undefined) throw new Error('Expected template sheet');
  sheet.spliceRows(
    2,
    Math.max(0, sheet.rowCount - 1),
    ...rows.map((row) => [...row] as ExcelJS.CellValue[]),
  );
}

async function write(workbook: ExcelJS.Workbook): Promise<Uint8Array> {
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

async function importError(
  bytes: Uint8Array,
  fileName = FILE_NAME,
): Promise<EvaluationProfileXlsxWorkbookError> {
  try {
    await new ExcelJsEvaluationProfileXlsxWorkbook().previewImport(upload(bytes, fileName));
  } catch (error: unknown) {
    if (error instanceof EvaluationProfileXlsxWorkbookError) return error;
    throw error;
  }
  throw new Error('Expected XLSX import to fail');
}

async function mutateZipEntry(
  bytes: Uint8Array,
  entryName: string,
  mutate: (contents: string) => string,
): Promise<Uint8Array> {
  const archive = await JSZip.loadAsync(bytes);
  const entry = archive.file(entryName);
  if (entry === null) throw new Error(`Expected ZIP entry ${entryName}`);
  const contents = await entry.async('string');
  const mutated = mutate(contents);
  if (mutated === contents) throw new Error(`Expected ZIP entry ${entryName} to change`);
  archive.file(entryName, mutated);
  return archive.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

function replaceAscii(bytes: Uint8Array, from: string, to: string): Uint8Array {
  if (from.length !== to.length) throw new Error('Replacement must preserve ZIP entry name length');
  const result = Uint8Array.from(bytes);
  const source = new TextEncoder().encode(from);
  const target = new TextEncoder().encode(to);
  let replacements = 0;
  for (let offset = 0; offset <= result.length - source.length; offset += 1) {
    if (!source.every((value, index) => result[offset + index] === value)) continue;
    result.set(target, offset);
    replacements += 1;
  }
  if (replacements < 2) throw new Error('Expected local and central ZIP entry names');
  return result;
}
