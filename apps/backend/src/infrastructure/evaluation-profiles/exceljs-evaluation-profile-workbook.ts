import {
  API_ERROR_LIMITS,
  EVALUATION_PROFILE_DOCUMENT_SCHEMA_VERSION,
  EVALUATION_PROFILE_XLSX_HEADERS,
  EVALUATION_PROFILE_XLSX_LEGACY_HEADERS,
  EVALUATION_PROFILE_XLSX_LEGACY_TEMPLATE_VERSION,
  EVALUATION_PROFILE_XLSX_LIMITS,
  EVALUATION_PROFILE_XLSX_MEDIA_TYPE,
  EVALUATION_PROFILE_XLSX_SHEETS,
  EVALUATION_PROFILE_XLSX_TEMPLATE_VERSION,
  evaluationProfileDocumentSchema,
  evaluationProfileXlsxFileNameSchema,
  evaluationProfileXlsxImportPreviewResponseSchema,
  type ApiFieldError,
  type EvaluationProfileAnchor,
  type EvaluationProfileCalculation,
  type EvaluationProfileDimension,
  type EvaluationProfileDocument,
  type EvaluationProfileItem,
  type EvaluationProfileXlsxImportPreviewResponse,
} from '@orgscience/contracts';
import ExcelJS, { type Cell, type Worksheet } from 'exceljs';
import * as saxes from 'saxes';
import * as yauzl from 'yauzl';

import {
  EvaluationProfileXlsxWorkbookError,
  type EvaluationProfileXlsxArtifact,
  type EvaluationProfileXlsxUpload,
  type EvaluationProfileXlsxWorkbook,
} from '../../application/evaluation-profiles/index.js';

const { ValueType } = ExcelJS;

const TEMPLATE_FILE_NAME = `evaluation-profile-template-v${String(EVALUATION_PROFILE_XLSX_TEMPLATE_VERSION)}.xlsx`;
const MAXIMUM_ARCHIVE_ENTRIES = 256;
const MAXIMUM_ARCHIVE_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const MAXIMUM_ARCHIVE_ENTRY_UNCOMPRESSED_BYTES = 32 * 1024 * 1024;
const MAXIMUM_ARCHIVE_RELATIONSHIP_BYTES = 1024 * 1024;
const MAXIMUM_ARCHIVE_XML_ELEMENTS = 100_000;
const MAXIMUM_WORKSHEET_XML_ROWS = EVALUATION_PROFILE_XLSX_LIMITS.maximumAnchorRows;
const MAXIMUM_WORKSHEET_XML_CELLS =
  EVALUATION_PROFILE_XLSX_LIMITS.maximumAnchorRows * EVALUATION_PROFILE_XLSX_HEADERS.items.length;
const MAXIMUM_SHARED_STRING_ITEMS = 20_000;
const ALLOWED_MEDIA_TYPES = new Set([
  '',
  'application/octet-stream',
  EVALUATION_PROFILE_XLSX_MEDIA_TYPE,
]);
const REQUIRED_ARCHIVE_ENTRIES = new Set([
  '[content_types].xml',
  '_rels/.rels',
  'xl/workbook.xml',
  'xl/_rels/workbook.xml.rels',
]);
const FORBIDDEN_ARCHIVE_PATHS = [
  /^customui\//iu,
  /^xl\/activex\//iu,
  /^xl\/connections\.xml$/iu,
  /^xl\/ctrlprops\//iu,
  /^xl\/dialogsheets\//iu,
  /^xl\/charts\//iu,
  /^xl\/comments\d*\.xml$/iu,
  /^xl\/drawings\//iu,
  /^xl\/embeddings\//iu,
  /^xl\/externallinks\//iu,
  /^xl\/macrosheets\//iu,
  /^xl\/media\//iu,
  /^xl\/oleobjects\//iu,
  /^xl\/vbaproject\.bin$/iu,
];
const IGNORED_WORKSHEET_NODES = [
  'autoFilter',
  'conditionalFormatting',
  'drawing',
  'extLst',
  'headerFooter',
  'pageMargins',
  'pageSetup',
  'picture',
  'printOptions',
  'rowBreaks',
  'sheetProtection',
  'tableParts',
] as const;

interface ParsedDimension extends EvaluationProfileDimension {
  readonly sourceRow: number;
}

interface ParsedItemRow {
  readonly itemId: string;
  readonly dimensionId: string;
  readonly name: string;
  readonly codingInstruction: string;
  readonly order: number;
  readonly weight?: number;
  readonly sourceRow: number;
}

type ParsedAnchor = EvaluationProfileAnchor & {
  readonly itemId: string;
  readonly sourceRow: number;
};

interface ParsedProfileRow {
  readonly templateVersion: number;
  readonly profileId: string;
  readonly name: string;
  readonly description: string;
  readonly coderPrompt: string;
  readonly calculation?: EvaluationProfileCalculation;
}

interface ParsedWorkbookRows {
  readonly profile: ParsedProfileRow;
  readonly dimensions: readonly ParsedDimension[];
  readonly items: readonly ParsedItemRow[];
  readonly anchors: readonly ParsedAnchor[];
}

export class ExcelJsEvaluationProfileXlsxWorkbook implements EvaluationProfileXlsxWorkbook {
  public async createTemplate(): Promise<EvaluationProfileXlsxArtifact> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'OrgScience Evaluation Studio';
    workbook.created = new Date('2026-01-01T00:00:00.000Z');
    workbook.modified = new Date('2026-01-01T00:00:00.000Z');

    addInstructionsSheet(workbook);
    addDataSheet(
      workbook,
      EVALUATION_PROFILE_XLSX_SHEETS.profile,
      EVALUATION_PROFILE_XLSX_HEADERS.profile,
      [
        EVALUATION_PROFILE_XLSX_TEMPLATE_VERSION,
        'profile-template',
        'New evaluation profile',
        'Describe the construct evaluated by this profile.',
        'Assess every item using only the available interview evidence.',
        'weighted_mean',
        '',
      ],
    );
    addDataSheet(
      workbook,
      EVALUATION_PROFILE_XLSX_SHEETS.dimensions,
      EVALUATION_PROFILE_XLSX_HEADERS.dimensions,
      ['dimension-1', 'Dimension 1', 0, 1],
    );
    addDataSheet(
      workbook,
      EVALUATION_PROFILE_XLSX_SHEETS.items,
      EVALUATION_PROFILE_XLSX_HEADERS.items,
      [
        'item-1',
        'dimension-1',
        'Item 1',
        'Describe the observable evidence required for this item.',
        0,
        1,
      ],
    );
    const anchors = workbook.addWorksheet(EVALUATION_PROFILE_XLSX_SHEETS.anchors);
    anchors.addRow([...EVALUATION_PROFILE_XLSX_HEADERS.anchors]);
    for (let score = 1; score <= 7; score += 1) {
      anchors.addRow([
        'item-1',
        score,
        `Define the observable criterion for score ${String(score)}.`,
      ]);
    }
    formatDataSheet(anchors, EVALUATION_PROFILE_XLSX_HEADERS.anchors);

    const body = await workbook.xlsx.writeBuffer({
      useSharedStrings: true,
      useStyles: true,
      zip: { compression: 'DEFLATE', compressionOptions: { level: 6 } },
    });
    return {
      body: new Uint8Array(body),
      contentType: EVALUATION_PROFILE_XLSX_MEDIA_TYPE,
      fileName: TEMPLATE_FILE_NAME,
    };
  }

  public async previewImport(
    upload: EvaluationProfileXlsxUpload,
  ): Promise<EvaluationProfileXlsxImportPreviewResponse> {
    validateUploadMetadata(upload);
    const buffer = Buffer.from(upload.bytes);
    await preflightArchive(buffer);

    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(Uint8Array.from(upload.bytes).buffer, {
        ignoreNodes: [...IGNORED_WORKSHEET_NODES],
      });
    } catch {
      throw workbookError('The uploaded file is not a readable XLSX workbook.', [
        fileIssue('invalid_xlsx', 'The file is not a readable XLSX workbook.'),
      ]);
    }

    const issues = new WorkbookIssueCollector();
    const sheets = validateWorkbookShape(workbook, issues);
    issues.throwIfAny();
    if (sheets === undefined) {
      throw workbookError('The XLSX workbook is missing required worksheets.', []);
    }
    const rows = parseWorkbookRows(sheets, issues);
    issues.throwIfAny();

    const normalized = normalizeDocument(rows, issues);
    issues.throwIfAny();
    const document = validateCanonicalDocument(normalized, rows, issues);
    issues.throwIfAny();

    return evaluationProfileXlsxImportPreviewResponseSchema.parse({
      valid: true,
      document,
      source: {
        fileName: upload.fileName,
        templateVersion: rows.profile.templateVersion,
        dimensions: document.profile.dimensions.length,
        items: document.profile.items.length,
        anchors: document.profile.items.length * 7,
      },
    });
  }
}

function addInstructionsSheet(workbook: ExcelJS.Workbook): void {
  const sheet = workbook.addWorksheet(EVALUATION_PROFILE_XLSX_SHEETS.instructions);
  sheet.addRows([
    [`Evaluation profile XLSX template v${String(EVALUATION_PROFILE_XLSX_TEMPLATE_VERSION)}`],
    ['Keep all worksheet names and header names unchanged.'],
    ['Use zero-based contiguous order values for dimensions and items.'],
    ['Each item must reference an existing dimension_id.'],
    ['Add exactly one Anchors row for every item and every integer score from 1 through 7.'],
    ['All required text cells must contain observable, non-empty criteria.'],
    [
      'Use aggregation_mode weighted_mean or formula; custom_formula is plain text, never an Excel formula.',
    ],
    [
      'Blank weights default to 1; weights must be finite, non-negative numbers. Zero excludes an item from weighted means.',
    ],
    ['The workbook must not contain formulas, hyperlinks, macros, or embedded content.'],
    ['Upload this .xlsx file for preview, then explicitly confirm create or replace.'],
  ]);
  sheet.getColumn(1).width = 100;
  sheet.getRow(1).font = { bold: true, size: 14 };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
}

function addDataSheet(
  workbook: ExcelJS.Workbook,
  name: string,
  headers: readonly string[],
  example: readonly (string | number)[],
): void {
  const sheet = workbook.addWorksheet(name);
  sheet.addRow([...headers]);
  sheet.addRow([...example]);
  formatDataSheet(sheet, headers);
}

function formatDataSheet(sheet: Worksheet, headers: readonly string[]): void {
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4B5F' } };
  headerRow.alignment = { vertical: 'middle' };
  for (const [index, header] of headers.entries()) {
    const column = sheet.getColumn(index + 1);
    column.width = header.includes('prompt') || header.includes('criterion') ? 58 : 24;
  }
}

function validateUploadMetadata(upload: EvaluationProfileXlsxUpload): void {
  const issues: ApiFieldError[] = [];
  const fileName = upload.fileName.trim();
  if (!evaluationProfileXlsxFileNameSchema.safeParse(fileName).success) {
    issues.push({
      path: ['file', 'name'],
      code: 'invalid_file_name',
      message: 'The upload must use a plain file name ending in .xlsx.',
    });
  }
  if (!ALLOWED_MEDIA_TYPES.has(upload.mediaType.trim().toLowerCase())) {
    issues.push({
      path: ['file', 'type'],
      code: 'invalid_file_type',
      message: `The upload must use ${EVALUATION_PROFILE_XLSX_MEDIA_TYPE}.`,
    });
  }
  if (upload.bytes.byteLength === 0) {
    issues.push({ path: ['file'], code: 'empty_file', message: 'The XLSX file is empty.' });
  } else if (upload.bytes.byteLength > EVALUATION_PROFILE_XLSX_LIMITS.maximumFileBytes) {
    issues.push({
      path: ['file', 'size'],
      code: 'file_too_large',
      message: `The XLSX file exceeds ${String(EVALUATION_PROFILE_XLSX_LIMITS.maximumFileBytes)} bytes.`,
    });
  }
  if (
    upload.bytes.byteLength >= 4 &&
    !(
      upload.bytes[0] === 0x50 &&
      upload.bytes[1] === 0x4b &&
      upload.bytes[2] === 0x03 &&
      upload.bytes[3] === 0x04
    )
  ) {
    issues.push({
      path: ['file'],
      code: 'invalid_xlsx_signature',
      message: 'The file does not have an XLSX ZIP signature.',
    });
  }
  if (issues.length > 0) throw workbookError('The XLSX upload is invalid.', issues);
}

async function preflightArchive(buffer: Buffer): Promise<void> {
  const issues = await inspectArchive(buffer);
  if (issues.length > 0) {
    throw workbookError('The XLSX archive failed security validation.', issues);
  }
}

function inspectArchive(buffer: Buffer): Promise<readonly ApiFieldError[]> {
  return new Promise((resolve) => {
    yauzl.fromBuffer(
      buffer,
      {
        autoClose: true,
        decodeStrings: true,
        lazyEntries: true,
        strictFileNames: true,
        validateEntrySizes: true,
      },
      (openError, archive) => {
        if (openError !== null || archive === undefined) {
          resolve([fileIssue('invalid_xlsx_archive', 'The XLSX ZIP archive is malformed.')]);
          return;
        }

        if (archive.entryCount > MAXIMUM_ARCHIVE_ENTRIES) {
          archive.close();
          resolve([
            fileIssue(
              'too_many_archive_entries',
              `The XLSX archive may contain at most ${String(MAXIMUM_ARCHIVE_ENTRIES)} entries.`,
            ),
          ]);
          return;
        }

        const foundEntries = new Set<string>();
        const issues: ApiFieldError[] = [];
        const xmlComplexity: ArchiveXmlComplexity = { elements: 0, sharedStrings: 0 };
        let compressedBytes = 0;
        let uncompressedBytes = 0;
        let actualUncompressedBytes = 0;
        let settled = false;

        const finish = (result: readonly ApiFieldError[]): void => {
          if (settled) return;
          settled = true;
          archive.close();
          resolve(result);
        };
        const failMalformed = (): void => {
          finish([fileIssue('invalid_xlsx_archive', 'The XLSX ZIP archive is malformed.')]);
        };

        archive.on('error', failMalformed);
        archive.on('entry', (entry: yauzl.Entry) => {
          const normalizedName = entry.fileName.toLowerCase();
          if (foundEntries.has(normalizedName)) {
            issues.push(
              archiveIssue(
                entry.fileName,
                'duplicate_archive_entry',
                'Archive entry names must be unique.',
              ),
            );
          }
          foundEntries.add(normalizedName);
          if (entry.isEncrypted()) {
            issues.push(
              archiveIssue(
                entry.fileName,
                'encrypted_archive_entry',
                'Encrypted entries are forbidden.',
              ),
            );
          }
          if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
            issues.push(
              archiveIssue(
                entry.fileName,
                'unsupported_compression',
                'Only stored or DEFLATE-compressed XLSX entries are supported.',
              ),
            );
          }
          if (FORBIDDEN_ARCHIVE_PATHS.some((pattern) => pattern.test(entry.fileName))) {
            issues.push(
              archiveIssue(
                entry.fileName,
                'forbidden_archive_content',
                'Macros, embedded objects, ActiveX, connections, and external links are forbidden.',
              ),
            );
          }
          if (entry.uncompressedSize > MAXIMUM_ARCHIVE_ENTRY_UNCOMPRESSED_BYTES) {
            issues.push(
              archiveIssue(
                entry.fileName,
                'archive_entry_too_large',
                `An XLSX entry may expand to at most ${String(MAXIMUM_ARCHIVE_ENTRY_UNCOMPRESSED_BYTES)} bytes.`,
              ),
            );
          }
          compressedBytes += entry.compressedSize;
          uncompressedBytes += entry.uncompressedSize;
          if (
            compressedBytes > EVALUATION_PROFILE_XLSX_LIMITS.maximumFileBytes ||
            uncompressedBytes > MAXIMUM_ARCHIVE_UNCOMPRESSED_BYTES
          ) {
            issues.push(
              fileIssue(
                'expanded_archive_too_large',
                `The XLSX archive may expand to at most ${String(MAXIMUM_ARCHIVE_UNCOMPRESSED_BYTES)} bytes.`,
              ),
            );
          }
          if (issues.length > 0) {
            finish(issues);
            return;
          }
          if (entry.fileName.endsWith('/')) {
            archive.readEntry();
            return;
          }

          archive.openReadStream(entry, (streamError, stream) => {
            if (streamError !== null || stream === undefined) {
              failMalformed();
              return;
            }
            let actualEntryBytes = 0;
            const xmlInspection = createArchiveXmlInspection(
              entry.fileName,
              normalizedName,
              xmlComplexity,
            );
            stream.on('data', (chunk: Buffer) => {
              if (settled) return;
              actualEntryBytes += chunk.byteLength;
              actualUncompressedBytes += chunk.byteLength;
              if (
                actualEntryBytes > MAXIMUM_ARCHIVE_ENTRY_UNCOMPRESSED_BYTES ||
                actualUncompressedBytes > MAXIMUM_ARCHIVE_UNCOMPRESSED_BYTES
              ) {
                stream.destroy();
                finish([
                  archiveIssue(
                    entry.fileName,
                    'expanded_archive_too_large',
                    'The XLSX archive expands beyond the permitted byte limits.',
                  ),
                ]);
                return;
              }
              if (xmlInspection !== undefined && actualEntryBytes > xmlInspection.maximumBytes) {
                stream.destroy();
                finish([
                  archiveIssue(
                    entry.fileName,
                    'archive_xml_entry_too_large',
                    'This OOXML metadata entry exceeds the permitted byte limit.',
                  ),
                ]);
                return;
              }
              if (xmlInspection !== undefined) {
                try {
                  xmlInspection.write(chunk);
                } catch (error: unknown) {
                  stream.destroy();
                  finish([xmlInspectionError(entry.fileName, error)]);
                }
              }
            });
            stream.once('error', failMalformed);
            stream.once('end', () => {
              if (settled) return;
              if (xmlInspection !== undefined) {
                try {
                  xmlInspection.close();
                } catch (error: unknown) {
                  finish([xmlInspectionError(entry.fileName, error)]);
                  return;
                }
              }
              archive.readEntry();
            });
            stream.resume();
          });
        });
        archive.on('end', () => {
          const missing = [...REQUIRED_ARCHIVE_ENTRIES].filter(
            (required) => !foundEntries.has(required),
          );
          if (![...foundEntries].some((name) => /^xl\/worksheets\/sheet[^/]*\.xml$/u.test(name))) {
            missing.push('xl/worksheets/sheet*.xml');
          }
          if (missing.length > 0) {
            finish([
              fileIssue(
                'missing_xlsx_parts',
                `The XLSX archive is missing required OOXML parts: ${missing.join(', ')}.`,
              ),
            ]);
            return;
          }
          finish([]);
        });
        archive.readEntry();
      },
    );
  });
}

interface ArchiveXmlComplexity {
  elements: number;
  sharedStrings: number;
}

interface ArchiveXmlInspection {
  readonly maximumBytes: number;
  write(chunk: Buffer): void;
  close(): void;
}

class ArchiveXmlInspectionError extends Error {
  public constructor(readonly issue: ApiFieldError) {
    super(issue.message);
    this.name = 'ArchiveXmlInspectionError';
  }
}

function createArchiveXmlInspection(
  entryName: string,
  normalizedName: string,
  complexity: ArchiveXmlComplexity,
): ArchiveXmlInspection | undefined {
  if (!normalizedName.endsWith('.xml') && !normalizedName.endsWith('.rels')) return undefined;

  const isRelationship = normalizedName.endsWith('.rels');
  const isContentTypes = normalizedName === '[content_types].xml';
  const isWorksheet = /^xl\/worksheets\/sheet[^/]*\.xml$/u.test(normalizedName);
  const isSharedStrings = normalizedName === 'xl/sharedstrings.xml';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const parser = new saxes.SaxesParser({ xmlns: false, position: false });
  let worksheetRows = 0;
  let worksheetCells = 0;

  const reject = (code: string, message: string): never => {
    throw new ArchiveXmlInspectionError(archiveIssue(entryName, code, message));
  };

  parser.on('doctype', () => {
    reject('ooxml_doctype_forbidden', 'OOXML files must not contain a document type declaration.');
  });
  parser.on('processinginstruction', () => {
    reject(
      'ooxml_processing_instruction_forbidden',
      'OOXML files must not contain processing instructions.',
    );
  });
  parser.on('error', (error) => {
    throw error;
  });
  parser.on('opentag', (tag) => {
    complexity.elements += 1;
    if (complexity.elements > MAXIMUM_ARCHIVE_XML_ELEMENTS) {
      reject(
        'ooxml_too_complex',
        `The XLSX archive may contain at most ${String(MAXIMUM_ARCHIVE_XML_ELEMENTS)} XML elements.`,
      );
    }

    const localName = xmlLocalName(tag.name);
    if (
      isRelationship &&
      localName === 'relationship' &&
      xmlAttribute(tag.attributes, 'targetmode')?.trim().toLowerCase() === 'external'
    ) {
      reject('external_relationship_forbidden', 'External workbook relationships are forbidden.');
    }
    if (
      isContentTypes &&
      Object.values(tag.attributes).some((value) =>
        /(macroenabled|vbaproject|macrosheet|dialogsheet|activex|oleobject)/iu.test(value),
      )
    ) {
      reject(
        'active_content_forbidden',
        'Macro-enabled and active OOXML content types are forbidden.',
      );
    }
    if (isWorksheet) {
      if (localName === 'row') {
        worksheetRows += 1;
        if (worksheetRows > MAXIMUM_WORKSHEET_XML_ROWS) {
          reject(
            'worksheet_xml_too_many_rows',
            `A worksheet may contain at most ${String(MAXIMUM_WORKSHEET_XML_ROWS)} materialized rows.`,
          );
        }
      } else if (localName === 'c') {
        worksheetCells += 1;
        if (worksheetCells > MAXIMUM_WORKSHEET_XML_CELLS) {
          reject(
            'worksheet_xml_too_many_cells',
            `A worksheet may contain at most ${String(MAXIMUM_WORKSHEET_XML_CELLS)} materialized cells.`,
          );
        }
      } else if (localName === 'formula' || localName === 'formula1' || localName === 'formula2') {
        reject(
          'worksheet_feature_formula_forbidden',
          'Data-validation and conditional-formatting formulas are forbidden.',
        );
      }
    }
    if (isSharedStrings && localName === 'si') {
      complexity.sharedStrings += 1;
      if (complexity.sharedStrings > MAXIMUM_SHARED_STRING_ITEMS) {
        reject(
          'shared_strings_too_large',
          `The XLSX archive may contain at most ${String(MAXIMUM_SHARED_STRING_ITEMS)} shared strings.`,
        );
      }
    }
  });

  return {
    maximumBytes:
      isRelationship || isContentTypes
        ? MAXIMUM_ARCHIVE_RELATIONSHIP_BYTES
        : MAXIMUM_ARCHIVE_ENTRY_UNCOMPRESSED_BYTES,
    write(chunk): void {
      parser.write(decoder.decode(chunk, { stream: true }));
    },
    close(): void {
      const remainder = decoder.decode();
      if (remainder.length > 0) parser.write(remainder);
      parser.close();
    },
  };
}

function xmlLocalName(name: string): string {
  const separator = name.lastIndexOf(':');
  return name.slice(separator + 1).toLowerCase();
}

function xmlAttribute(
  attributes: Record<string, string>,
  expectedName: string,
): string | undefined {
  for (const [name, value] of Object.entries(attributes)) {
    if (name.toLowerCase() === expectedName) return value;
  }
  return undefined;
}

function xmlInspectionError(entryName: string, error: unknown): ApiFieldError {
  if (error instanceof ArchiveXmlInspectionError) return error.issue;
  return archiveIssue(
    entryName,
    'invalid_ooxml_xml',
    'An OOXML metadata entry contains invalid XML.',
  );
}

function validateWorkbookShape(
  workbook: ExcelJS.Workbook,
  issues: WorkbookIssueCollector,
):
  | {
      readonly profile: Worksheet;
      readonly dimensions: Worksheet;
      readonly items: Worksheet;
      readonly anchors: Worksheet;
    }
  | undefined {
  const expectedNames = new Set<string>(Object.values(EVALUATION_PROFILE_XLSX_SHEETS));
  for (const sheet of workbook.worksheets) {
    if (!expectedNames.has(sheet.name)) {
      issues.add({
        path: ['sheets', sheet.name],
        code: 'unexpected_sheet',
        message: `Unexpected worksheet "${sheet.name}". Use the versioned template without extra sheets.`,
      });
    }
  }

  const instructions = requiredSheet(workbook, EVALUATION_PROFILE_XLSX_SHEETS.instructions, issues);
  const profile = requiredSheet(workbook, EVALUATION_PROFILE_XLSX_SHEETS.profile, issues);
  const dimensions = requiredSheet(workbook, EVALUATION_PROFILE_XLSX_SHEETS.dimensions, issues);
  const items = requiredSheet(workbook, EVALUATION_PROFILE_XLSX_SHEETS.items, issues);
  const anchors = requiredSheet(workbook, EVALUATION_PROFILE_XLSX_SHEETS.anchors, issues);
  const headers =
    profile?.getCell('A2').value === EVALUATION_PROFILE_XLSX_LEGACY_TEMPLATE_VERSION
      ? EVALUATION_PROFILE_XLSX_LEGACY_HEADERS
      : EVALUATION_PROFILE_XLSX_HEADERS;

  let boundsAreValid = true;
  if (instructions !== undefined) {
    boundsAreValid =
      validateSheetBounds(
        instructions,
        EVALUATION_PROFILE_XLSX_LIMITS.maximumInstructionsRows,
        1,
        issues,
      ) && boundsAreValid;
  }
  if (profile !== undefined) {
    boundsAreValid =
      validateSheetBounds(
        profile,
        EVALUATION_PROFILE_XLSX_LIMITS.maximumProfileRows,
        headers.profile.length,
        issues,
      ) && boundsAreValid;
  }
  if (dimensions !== undefined) {
    boundsAreValid =
      validateSheetBounds(
        dimensions,
        EVALUATION_PROFILE_XLSX_LIMITS.maximumDimensionRows,
        headers.dimensions.length,
        issues,
      ) && boundsAreValid;
  }
  if (items !== undefined) {
    boundsAreValid =
      validateSheetBounds(
        items,
        EVALUATION_PROFILE_XLSX_LIMITS.maximumItemRows,
        headers.items.length,
        issues,
      ) && boundsAreValid;
  }
  if (anchors !== undefined) {
    boundsAreValid =
      validateSheetBounds(
        anchors,
        EVALUATION_PROFILE_XLSX_LIMITS.maximumAnchorRows,
        headers.anchors.length,
        issues,
      ) && boundsAreValid;
  }

  if (
    instructions === undefined ||
    profile === undefined ||
    dimensions === undefined ||
    items === undefined ||
    anchors === undefined ||
    !boundsAreValid
  ) {
    return undefined;
  }

  scanCells(instructions, 1, issues);
  validateHeaders(profile, headers.profile, issues);
  scanCells(profile, headers.profile.length, issues);
  validateHeaders(dimensions, headers.dimensions, issues);
  scanCells(dimensions, headers.dimensions.length, issues);
  validateHeaders(items, headers.items, issues);
  scanCells(items, headers.items.length, issues);
  validateHeaders(anchors, headers.anchors, issues);
  scanCells(anchors, headers.anchors.length, issues);

  return { profile, dimensions, items, anchors };
}

function requiredSheet(
  workbook: ExcelJS.Workbook,
  name: string,
  issues: WorkbookIssueCollector,
): Worksheet | undefined {
  const sheet = workbook.getWorksheet(name);
  if (sheet === undefined) {
    issues.add({
      path: ['sheets', name],
      code: 'missing_sheet',
      message: `Required worksheet "${name}" is missing.`,
    });
  }
  return sheet;
}

function validateSheetBounds(
  sheet: Worksheet,
  maximumRows: number,
  maximumColumns: number,
  issues: WorkbookIssueCollector,
): boolean {
  let valid = true;
  if (sheet.rowCount > maximumRows) {
    valid = false;
    issues.add({
      path: ['sheets', sheet.name, 'rows'],
      code: 'too_many_rows',
      message: `${sheet.name} may contain at most ${String(maximumRows)} rows including its header.`,
    });
  }
  if (sheet.columnCount > maximumColumns) {
    valid = false;
    issues.add({
      path: ['sheets', sheet.name, 'columns'],
      code: 'too_many_columns',
      message: `${sheet.name} may contain at most ${String(maximumColumns)} columns.`,
    });
  }
  return valid;
}

function validateHeaders(
  sheet: Worksheet,
  headers: readonly string[],
  issues: WorkbookIssueCollector,
): void {
  for (const [index, expected] of headers.entries()) {
    const column = index + 1;
    const cell = sheet.getCell(1, column);
    if (cell.value !== expected) {
      issues.add(
        cellIssue(
          sheet,
          1,
          column,
          'invalid_header',
          `${sheet.name}!${cell.address} must contain the exact header "${expected}".`,
        ),
      );
    }
  }
}

function scanCells(sheet: Worksheet, maximumColumns: number, issues: WorkbookIssueCollector): void {
  sheet.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (cell, column) => {
      if (column > maximumColumns) {
        issues.add(
          cellIssue(
            sheet,
            row.number,
            column,
            'unexpected_column',
            `${sheet.name}!${cell.address} is outside the fixed template columns.`,
          ),
        );
      }
      if (cell.type === ValueType.Formula || hasFormula(cell.value)) {
        issues.add(
          cellIssue(
            sheet,
            row.number,
            column,
            'formula_forbidden',
            `${sheet.name}!${cell.address} must not contain a formula.`,
          ),
        );
      } else if (cell.isMerged || !isSupportedScalar(cell.value)) {
        issues.add(
          cellIssue(
            sheet,
            row.number,
            column,
            'unsupported_cell_value',
            `${sheet.name}!${cell.address} must contain plain text or a number.`,
          ),
        );
      }
    });
  });
}

function parseWorkbookRows(
  sheets: {
    readonly profile: Worksheet;
    readonly dimensions: Worksheet;
    readonly items: Worksheet;
    readonly anchors: Worksheet;
  },
  issues: WorkbookIssueCollector,
): ParsedWorkbookRows {
  const profile = parseProfile(sheets.profile, issues);
  const isCurrent = profile.templateVersion === EVALUATION_PROFILE_XLSX_TEMPLATE_VERSION;
  const dimensions: ParsedDimension[] = [];
  for (let row = 2; row <= sheets.dimensions.rowCount; row += 1) {
    if (!rowHasValues(sheets.dimensions, row, EVALUATION_PROFILE_XLSX_HEADERS.dimensions.length)) {
      continue;
    }
    dimensions.push({
      dimensionId: requiredText(sheets.dimensions, row, 1, issues),
      name: requiredText(sheets.dimensions, row, 2, issues),
      order: requiredInteger(sheets.dimensions, row, 3, issues),
      ...(isCurrent ? optionalWeight(sheets.dimensions, row, 4, issues) : {}),
      sourceRow: row,
    });
  }

  const items: ParsedItemRow[] = [];
  for (let row = 2; row <= sheets.items.rowCount; row += 1) {
    if (!rowHasValues(sheets.items, row, EVALUATION_PROFILE_XLSX_HEADERS.items.length)) continue;
    items.push({
      itemId: requiredText(sheets.items, row, 1, issues),
      dimensionId: requiredText(sheets.items, row, 2, issues),
      name: requiredText(sheets.items, row, 3, issues),
      codingInstruction: requiredText(sheets.items, row, 4, issues),
      order: requiredInteger(sheets.items, row, 5, issues),
      ...(isCurrent ? optionalWeight(sheets.items, row, 6, issues) : {}),
      sourceRow: row,
    });
  }

  const anchors: ParsedAnchor[] = [];
  for (let row = 2; row <= sheets.anchors.rowCount; row += 1) {
    if (!rowHasValues(sheets.anchors, row, EVALUATION_PROFILE_XLSX_HEADERS.anchors.length))
      continue;
    const score = requiredInteger(sheets.anchors, row, 2, issues);
    anchors.push({
      itemId: requiredText(sheets.anchors, row, 1, issues),
      score: score as EvaluationProfileAnchor['score'],
      criterion: requiredText(sheets.anchors, row, 3, issues),
      sourceRow: row,
    });
    if (score < 1 || score > 7) {
      issues.add(
        cellIssue(
          sheets.anchors,
          row,
          2,
          'invalid_score',
          `${sheets.anchors.name}!B${String(row)} must be an integer from 1 through 7.`,
        ),
      );
    }
  }

  if (dimensions.length === 0) {
    issues.add(
      cellIssue(
        sheets.dimensions,
        2,
        1,
        'missing_dimension',
        'At least one dimension row is required.',
      ),
    );
  }
  if (items.length === 0) {
    issues.add(cellIssue(sheets.items, 2, 1, 'missing_item', 'At least one item row is required.'));
  }
  return { profile, dimensions, items, anchors };
}

function parseProfile(sheet: Worksheet, issues: WorkbookIssueCollector): ParsedProfileRow {
  if (!rowHasValues(sheet, 2, EVALUATION_PROFILE_XLSX_HEADERS.profile.length)) {
    issues.add(
      cellIssue(sheet, 2, 1, 'missing_profile', 'Profile row 2 must contain the profile data.'),
    );
  }
  for (let row = 3; row <= sheet.rowCount; row += 1) {
    if (rowHasValues(sheet, row, EVALUATION_PROFILE_XLSX_HEADERS.profile.length)) {
      issues.add(
        cellIssue(
          sheet,
          row,
          1,
          'unexpected_profile_row',
          `${sheet.name} must contain exactly one data row.`,
        ),
      );
    }
  }
  const templateVersion = requiredInteger(sheet, 2, 1, issues);
  if (
    templateVersion !== EVALUATION_PROFILE_XLSX_TEMPLATE_VERSION &&
    templateVersion !== EVALUATION_PROFILE_XLSX_LEGACY_TEMPLATE_VERSION
  ) {
    issues.add(
      cellIssue(
        sheet,
        2,
        1,
        'unsupported_template_version',
        'Profile!A2 must be template version 1 or 2 with its exact versioned headers.',
      ),
    );
  }
  return {
    templateVersion,
    profileId: requiredText(sheet, 2, 2, issues),
    name: requiredText(sheet, 2, 3, issues),
    description: optionalText(sheet, 2, 4, issues),
    coderPrompt: requiredText(sheet, 2, 5, issues),
    ...(templateVersion === EVALUATION_PROFILE_XLSX_TEMPLATE_VERSION
      ? { calculation: parseCalculation(sheet, issues) }
      : {}),
  };
}

function normalizeDocument(
  rows: ParsedWorkbookRows,
  issues: WorkbookIssueCollector,
): EvaluationProfileDocument {
  const dimensionIds = new Map<string, ParsedDimension>();
  const dimensionOrders = new Map<number, ParsedDimension>();
  for (const dimension of rows.dimensions) {
    const priorId = dimensionIds.get(dimension.dimensionId);
    if (priorId !== undefined) {
      issues.add(
        positionedIssue(
          EVALUATION_PROFILE_XLSX_SHEETS.dimensions,
          dimension.sourceRow,
          1,
          'duplicate_dimension_id',
          `Dimension ID "${dimension.dimensionId}" is already used at row ${String(priorId.sourceRow)}.`,
        ),
      );
    } else {
      dimensionIds.set(dimension.dimensionId, dimension);
    }
    const priorOrder = dimensionOrders.get(dimension.order);
    if (priorOrder !== undefined) {
      issues.add(
        positionedIssue(
          EVALUATION_PROFILE_XLSX_SHEETS.dimensions,
          dimension.sourceRow,
          3,
          'duplicate_dimension_order',
          `Dimension order ${String(dimension.order)} is already used at row ${String(priorOrder.sourceRow)}.`,
        ),
      );
    } else {
      dimensionOrders.set(dimension.order, dimension);
    }
  }
  const sortedDimensions = [...rows.dimensions].sort((left, right) => left.order - right.order);
  for (const [index, dimension] of sortedDimensions.entries()) {
    if (dimension.order !== index) {
      issues.add(
        positionedIssue(
          EVALUATION_PROFILE_XLSX_SHEETS.dimensions,
          dimension.sourceRow,
          3,
          'non_contiguous_dimension_order',
          `Dimension order must be contiguous and zero-based; expected ${String(index)}.`,
        ),
      );
    }
  }

  const itemIds = new Map<string, ParsedItemRow>();
  const itemOrders = new Map<string, ParsedItemRow>();
  for (const item of rows.items) {
    const prior = itemIds.get(item.itemId);
    if (prior !== undefined) {
      issues.add(
        positionedIssue(
          EVALUATION_PROFILE_XLSX_SHEETS.items,
          item.sourceRow,
          1,
          'duplicate_item_id',
          `Item ID "${item.itemId}" is already used at row ${String(prior.sourceRow)}.`,
        ),
      );
    } else {
      itemIds.set(item.itemId, item);
    }
    if (!dimensionIds.has(item.dimensionId)) {
      issues.add(
        positionedIssue(
          EVALUATION_PROFILE_XLSX_SHEETS.items,
          item.sourceRow,
          2,
          'unknown_dimension_id',
          `Dimension ID "${item.dimensionId}" does not exist in Dimensions.`,
        ),
      );
    }
    const orderKey = `${item.dimensionId}\u0000${String(item.order)}`;
    const priorOrder = itemOrders.get(orderKey);
    if (priorOrder !== undefined) {
      issues.add(
        positionedIssue(
          EVALUATION_PROFILE_XLSX_SHEETS.items,
          item.sourceRow,
          5,
          'duplicate_item_order',
          `Item order ${String(item.order)} for dimension "${item.dimensionId}" is already used at row ${String(priorOrder.sourceRow)}.`,
        ),
      );
    } else {
      itemOrders.set(orderKey, item);
    }
  }
  for (const dimension of sortedDimensions) {
    const dimensionItems = rows.items
      .filter((item) => item.dimensionId === dimension.dimensionId)
      .sort((left, right) => left.order - right.order);
    if (dimensionItems.length === 0) {
      issues.add(
        positionedIssue(
          EVALUATION_PROFILE_XLSX_SHEETS.dimensions,
          dimension.sourceRow,
          1,
          'dimension_without_items',
          `Dimension "${dimension.dimensionId}" must contain at least one item.`,
        ),
      );
    }
    for (const [index, item] of dimensionItems.entries()) {
      if (item.order !== index) {
        issues.add(
          positionedIssue(
            EVALUATION_PROFILE_XLSX_SHEETS.items,
            item.sourceRow,
            5,
            'non_contiguous_item_order',
            `Item order within dimension "${dimension.dimensionId}" must be contiguous and zero-based; expected ${String(index)}.`,
          ),
        );
      }
    }
  }

  const anchorsByItem = new Map<string, Map<number, ParsedAnchor>>();
  for (const anchor of rows.anchors) {
    if (!itemIds.has(anchor.itemId)) {
      issues.add(
        positionedIssue(
          EVALUATION_PROFILE_XLSX_SHEETS.anchors,
          anchor.sourceRow,
          1,
          'unknown_item_id',
          `Item ID "${anchor.itemId}" does not exist in Items.`,
        ),
      );
      continue;
    }
    const itemAnchors = anchorsByItem.get(anchor.itemId) ?? new Map<number, ParsedAnchor>();
    const prior = itemAnchors.get(anchor.score);
    if (prior !== undefined) {
      issues.add(
        positionedIssue(
          EVALUATION_PROFILE_XLSX_SHEETS.anchors,
          anchor.sourceRow,
          2,
          'duplicate_anchor_score',
          `Score ${String(anchor.score)} for item "${anchor.itemId}" is already defined at row ${String(prior.sourceRow)}.`,
        ),
      );
    } else {
      itemAnchors.set(anchor.score, anchor);
      anchorsByItem.set(anchor.itemId, itemAnchors);
    }
  }
  const missingAnchorRow = Math.min(
    rows.anchors.length + 2,
    EVALUATION_PROFILE_XLSX_LIMITS.maximumAnchorRows,
  );
  for (const item of rows.items) {
    const itemAnchors = anchorsByItem.get(item.itemId);
    for (let score = 1; score <= 7; score += 1) {
      if (itemAnchors?.has(score) !== true) {
        issues.add(
          positionedIssue(
            EVALUATION_PROFILE_XLSX_SHEETS.anchors,
            missingAnchorRow,
            2,
            'missing_anchor_score',
            `Add an Anchors row for item "${item.itemId}" and score ${String(score)}.`,
          ),
        );
      }
    }
  }
  issues.throwIfAny();

  const dimensions: EvaluationProfileDimension[] = sortedDimensions.map(
    ({ dimensionId, name, order, weight }) => ({
      dimensionId,
      name,
      order,
      ...(weight === undefined ? {} : { weight }),
    }),
  );
  const items: EvaluationProfileItem[] = sortedDimensions.flatMap((dimension) =>
    rows.items
      .filter((item) => item.dimensionId === dimension.dimensionId)
      .sort((left, right) => left.order - right.order)
      .map((item) => ({
        itemId: item.itemId,
        dimensionId: item.dimensionId,
        name: item.name,
        codingInstruction: item.codingInstruction,
        order: item.order,
        ...(item.weight === undefined ? {} : { weight: item.weight }),
        anchors: [...(anchorsByItem.get(item.itemId)?.values() ?? [])]
          .sort((left, right) => left.score - right.score)
          .map(({ score, criterion }) => ({
            score,
            criterion,
          })) as EvaluationProfileItem['anchors'],
      })),
  );

  return {
    schemaVersion: EVALUATION_PROFILE_DOCUMENT_SCHEMA_VERSION,
    profile: {
      profileId: rows.profile.profileId,
      name: rows.profile.name,
      description: rows.profile.description,
      coderPrompt: rows.profile.coderPrompt,
      ...(rows.profile.calculation === undefined ? {} : { calculation: rows.profile.calculation }),
      scale: { minimum: 1, maximum: 7 },
      dimensions,
      items,
    },
  };
}

function validateCanonicalDocument(
  candidate: EvaluationProfileDocument,
  rows: ParsedWorkbookRows,
  issues: WorkbookIssueCollector,
): EvaluationProfileDocument {
  const parsed = evaluationProfileDocumentSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;

  const sortedDimensions = [...rows.dimensions].sort((left, right) => left.order - right.order);
  const sortedItems = sortedDimensions.flatMap((dimension) =>
    rows.items
      .filter((item) => item.dimensionId === dimension.dimensionId)
      .sort((left, right) => left.order - right.order),
  );
  const anchorLookup = new Map(
    rows.anchors.map((anchor) => [`${anchor.itemId}\u0000${String(anchor.score)}`, anchor]),
  );

  for (const issue of parsed.error.issues) {
    const path = issue.path;
    const profileField = path[1];
    if (path[0] === 'profile' && profileField === 'calculation') {
      issues.add(
        positionedIssue(
          EVALUATION_PROFILE_XLSX_SHEETS.profile,
          2,
          path[2] === 'mode' ? 6 : 7,
          issue.code,
          issue.message,
        ),
      );
      continue;
    }
    if (path[0] === 'profile' && typeof profileField === 'string') {
      const profileHeader = toProfileHeader(profileField);
      const profileColumn =
        profileHeader === undefined
          ? -1
          : EVALUATION_PROFILE_XLSX_HEADERS.profile.indexOf(profileHeader);
      if (profileColumn >= 0) {
        issues.add(
          positionedIssue(
            EVALUATION_PROFILE_XLSX_SHEETS.profile,
            2,
            profileColumn + 1,
            issue.code,
            issue.message,
          ),
        );
        continue;
      }
    }

    if (path[0] === 'profile' && path[1] === 'dimensions' && typeof path[2] === 'number') {
      const dimension = sortedDimensions[path[2]];
      const column = dimensionColumn(path[3]);
      if (dimension !== undefined && column !== undefined) {
        issues.add(
          positionedIssue(
            EVALUATION_PROFILE_XLSX_SHEETS.dimensions,
            dimension.sourceRow,
            column,
            issue.code,
            issue.message,
          ),
        );
        continue;
      }
    }

    if (path[0] === 'profile' && path[1] === 'items' && typeof path[2] === 'number') {
      const item = sortedItems[path[2]];
      if (item !== undefined && path[3] === 'anchors' && typeof path[4] === 'number') {
        const anchor = anchorLookup.get(`${item.itemId}\u0000${String(path[4] + 1)}`);
        if (anchor !== undefined) {
          issues.add(
            positionedIssue(
              EVALUATION_PROFILE_XLSX_SHEETS.anchors,
              anchor.sourceRow,
              path[5] === 'criterion' ? 3 : 2,
              issue.code,
              issue.message,
            ),
          );
          continue;
        }
      }
      const column = itemColumn(path[3]);
      if (item !== undefined && column !== undefined) {
        issues.add(
          positionedIssue(
            EVALUATION_PROFILE_XLSX_SHEETS.items,
            item.sourceRow,
            column,
            issue.code,
            issue.message,
          ),
        );
        continue;
      }
    }

    issues.add({ path: ['file'], code: issue.code, message: issue.message });
  }
  return candidate;
}

function requiredText(
  sheet: Worksheet,
  row: number,
  column: number,
  issues: WorkbookIssueCollector,
): string {
  const value = sheet.getCell(row, column).value;
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  issues.add(
    cellIssue(
      sheet,
      row,
      column,
      'required_text',
      `${sheet.name}!${sheet.getCell(row, column).address} must contain non-empty plain text.`,
    ),
  );
  return '';
}

function optionalText(
  sheet: Worksheet,
  row: number,
  column: number,
  issues: WorkbookIssueCollector,
): string {
  const value = sheet.getCell(row, column).value;
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'string') return value.trim();
  issues.add(
    cellIssue(
      sheet,
      row,
      column,
      'plain_text_required',
      `${sheet.name}!${sheet.getCell(row, column).address} must contain plain text or be empty.`,
    ),
  );
  return '';
}

function requiredInteger(
  sheet: Worksheet,
  row: number,
  column: number,
  issues: WorkbookIssueCollector,
): number {
  const value = sheet.getCell(row, column).value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  issues.add(
    cellIssue(
      sheet,
      row,
      column,
      'integer_required',
      `${sheet.name}!${sheet.getCell(row, column).address} must contain a non-negative integer.`,
    ),
  );
  return -1;
}

function optionalWeight(
  sheet: Worksheet,
  row: number,
  column: number,
  issues: WorkbookIssueCollector,
): { readonly weight?: number } {
  const value = sheet.getCell(row, column).value;
  if (value === null || value === undefined || value === '') return {};
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return { weight: value };
  }
  issues.add(
    cellIssue(
      sheet,
      row,
      column,
      'invalid_weight',
      `${sheet.name}!${sheet.getCell(row, column).address} must contain a finite, non-negative number or be empty.`,
    ),
  );
  return {};
}

function parseCalculation(
  sheet: Worksheet,
  issues: WorkbookIssueCollector,
): EvaluationProfileCalculation {
  const mode = optionalText(sheet, 2, 6, issues) || 'weighted_mean';
  const expression = optionalText(sheet, 2, 7, issues);
  if (mode === 'formula') {
    if (expression.length === 0) {
      issues.add(
        cellIssue(
          sheet,
          2,
          7,
          'required_formula',
          'Profile!G2 must contain a plain-text calculation expression.',
        ),
      );
    }
    return { mode, expression };
  }
  if (mode !== 'weighted_mean') {
    issues.add(
      cellIssue(
        sheet,
        2,
        6,
        'invalid_aggregation_mode',
        'Profile!F2 must contain weighted_mean or formula.',
      ),
    );
  }
  if (expression.length > 0) {
    issues.add(
      cellIssue(
        sheet,
        2,
        7,
        'unexpected_formula',
        'Profile!G2 must be empty in weighted_mean mode.',
      ),
    );
  }
  return { mode: 'weighted_mean' };
}

function rowHasValues(sheet: Worksheet, row: number, columns: number): boolean {
  for (let column = 1; column <= columns; column += 1) {
    const value = sheet.getCell(row, column).value;
    if (value !== null && value !== undefined && value !== '') return true;
  }
  return false;
}

function hasFormula(value: Cell['value']): boolean {
  return (
    typeof value === 'object' && value !== null && ('formula' in value || 'sharedFormula' in value)
  );
}

function isSupportedScalar(value: Cell['value']): boolean {
  return (
    value === null || value === undefined || typeof value === 'string' || typeof value === 'number'
  );
}

function toProfileHeader(
  field: string,
): (typeof EVALUATION_PROFILE_XLSX_HEADERS.profile)[number] | undefined {
  switch (field) {
    case 'profileId':
      return 'profile_id';
    case 'coderPrompt':
      return 'coder_prompt';
    case 'name':
    case 'description':
      return field;
    default:
      return undefined;
  }
}

function dimensionColumn(field: PropertyKey | undefined): number | undefined {
  switch (field) {
    case 'dimensionId':
      return 1;
    case 'name':
      return 2;
    case 'order':
      return 3;
    case 'weight':
      return 4;
    default:
      return undefined;
  }
}

function itemColumn(field: PropertyKey | undefined): number | undefined {
  switch (field) {
    case 'itemId':
      return 1;
    case 'dimensionId':
      return 2;
    case 'name':
      return 3;
    case 'codingInstruction':
      return 4;
    case 'order':
      return 5;
    case 'weight':
      return 6;
    default:
      return undefined;
  }
}

function cellIssue(
  sheet: Worksheet,
  row: number,
  column: number,
  code: string,
  message: string,
): ApiFieldError {
  return positionedIssue(sheet.name, row, column, code, message);
}

function positionedIssue(
  sheet: string,
  row: number,
  column: number,
  code: string,
  message: string,
): ApiFieldError {
  return {
    path: ['sheets', sheet, 'rows', row, 'columns', excelColumnName(column)],
    code,
    message,
  };
}

function archiveIssue(entry: string, code: string, message: string): ApiFieldError {
  return { path: ['file', 'archive', entry], code, message };
}

function fileIssue(code: string, message: string): ApiFieldError {
  return { path: ['file'], code, message };
}

function excelColumnName(column: number): string {
  let remaining = column;
  let name = '';
  while (remaining > 0) {
    const remainder = (remaining - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return name;
}

function workbookError(
  message: string,
  fieldErrors: readonly ApiFieldError[],
): EvaluationProfileXlsxWorkbookError {
  return new EvaluationProfileXlsxWorkbookError(message, fieldErrors);
}

class WorkbookIssueCollector {
  readonly #issues: ApiFieldError[] = [];
  readonly #keys = new Set<string>();

  public add(issue: ApiFieldError): void {
    if (this.#issues.length >= API_ERROR_LIMITS.maximumFieldErrors) return;
    const key = `${issue.path.join('\u0000')}\u0000${issue.code}`;
    if (this.#keys.has(key)) return;
    this.#keys.add(key);
    this.#issues.push(issue);
  }

  public throwIfAny(): void {
    if (this.#issues.length > 0) {
      throw workbookError('The XLSX workbook does not match template version 1.', this.#issues);
    }
  }
}
