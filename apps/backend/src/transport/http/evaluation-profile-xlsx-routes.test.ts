import {
  EVALUATION_PROFILE_XLSX_LIMITS,
  EVALUATION_PROFILE_XLSX_MEDIA_TYPE,
  apiErrorEnvelopeSchema,
  evaluationProfileDocumentSchema,
  evaluationProfileXlsxImportPreviewResponseSchema,
  type EvaluationProfileXlsxImportPreviewResponse,
} from '@orgscience/contracts';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import {
  EvaluationProfileXlsxWorkbookError,
  type EvaluationProfileXlsxWorkbook,
} from '../../application/evaluation-profiles/index.js';
import { ExcelJsEvaluationProfileXlsxWorkbook } from '../../infrastructure/evaluation-profiles/index.js';
import type { HttpEnvironment } from './error-response.js';
import { registerEvaluationProfileXlsxHttpRoutes } from './evaluation-profile-xlsx-routes.js';
import { MAXIMUM_EVALUATION_PROFILE_XLSX_REQUEST_BYTES } from './evaluation-profile-xlsx-upload.js';

const NOW = '2026-08-21T17:00:00.000Z';
const REQUEST_ID = 'request-xlsx-import-1';

describe('evaluation profile XLSX HTTP boundary', () => {
  it('downloads the versioned XLSX template with safe binary headers', async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1]);
    const createTemplate = vi.fn(async () => ({
      body: bytes,
      contentType: EVALUATION_PROFILE_XLSX_MEDIA_TYPE,
      fileName: 'evaluation-profile-template-v1.xlsx',
    }));
    const app = xlsxApp(workbook({ createTemplate }));

    const response = await app.request('/api/v1/evaluation-profiles/templates/xlsx');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(EVALUATION_PROFILE_XLSX_MEDIA_TYPE);
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="evaluation-profile-template-v1.xlsx"',
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it('returns a canonical preview from exactly one multipart file without persisting', async () => {
    const expected = preview();
    const previewImport = vi.fn(async () => expected);
    const app = xlsxApp(workbook({ previewImport }));
    const body = new FormData();
    body.append(
      'file',
      new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'profile.xlsx', {
        type: EVALUATION_PROFILE_XLSX_MEDIA_TYPE,
      }),
    );

    const response = await app.request('/api/v1/evaluation-profiles/imports/xlsx/preview', {
      method: 'POST',
      body,
    });

    expect(response.status).toBe(200);
    expect(evaluationProfileXlsxImportPreviewResponseSchema.parse(await response.json())).toEqual(
      expected,
    );
    expect(previewImport).toHaveBeenCalledExactlyOnceWith({
      fileName: 'profile.xlsx',
      mediaType: EVALUATION_PROFILE_XLSX_MEDIA_TYPE,
      bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
    });
  });

  it('downloads and previews the real versioned template through HTTP without a save operation', async () => {
    const app = xlsxApp(new ExcelJsEvaluationProfileXlsxWorkbook());
    const download = await app.request('/api/v1/evaluation-profiles/templates/xlsx');
    const bytes = await download.arrayBuffer();
    const body = new FormData();
    body.append(
      'file',
      new File([bytes], 'evaluation-profile-template-v1.xlsx', {
        type: EVALUATION_PROFILE_XLSX_MEDIA_TYPE,
      }),
    );

    const response = await app.request('/api/v1/evaluation-profiles/imports/xlsx/preview', {
      method: 'POST',
      body,
    });

    expect(download.status).toBe(200);
    expect(response.status).toBe(200);
    expect(
      evaluationProfileXlsxImportPreviewResponseSchema.parse(await response.json()),
    ).toMatchObject({
      valid: true,
      source: { dimensions: 1, items: 1, anchors: 7 },
      document: { profile: { profileId: 'profile-template' } },
    });
  });

  it.each([
    {
      name: 'missing multipart body',
      request: () => ({ method: 'POST' as const }),
      status: 415,
      code: 'invalid_content_type',
    },
    {
      name: 'legacy xls extension',
      request: () => multipartRequest(new File(['legacy'], 'profile.xls')),
      status: 415,
      code: 'invalid_file_name',
    },
    {
      name: 'macro-capable xlsm extension',
      request: () => multipartRequest(new File(['macro'], 'profile.xlsm')),
      status: 415,
      code: 'invalid_file_name',
    },
    {
      name: 'unsupported media type',
      request: () =>
        multipartRequest(new File(['xlsx'], 'profile.xlsx', { type: 'application/vnd.ms-excel' })),
      status: 415,
      code: 'invalid_file_type',
    },
    {
      name: 'extra form field',
      request: () => {
        const body = new FormData();
        body.append('file', new File(['xlsx'], 'profile.xlsx'));
        body.append('mapping', 'automatic');
        return { method: 'POST' as const, body };
      },
      status: 400,
      code: 'invalid_file_count',
    },
  ])('rejects $name before invoking the workbook adapter', async ({ request, status, code }) => {
    const previewImport = vi.fn(async () => preview());
    const response = await xlsxApp(workbook({ previewImport })).request(
      '/api/v1/evaluation-profiles/imports/xlsx/preview',
      request(),
    );

    expect(response.status).toBe(status);
    const error = apiErrorEnvelopeSchema.parse(await response.json()).error;
    expect(error.code).toBe('EVALUATION_PROFILE_IMPORT_INVALID');
    expect(error.fieldErrors).toEqual(expect.arrayContaining([expect.objectContaining({ code })]));
    expect(previewImport).not.toHaveBeenCalled();
  });

  it('uses the import error code for route-level request size rejection', async () => {
    const body = new Uint8Array(MAXIMUM_EVALUATION_PROFILE_XLSX_REQUEST_BYTES + 1);
    const response = await xlsxApp(workbook()).request(
      '/api/v1/evaluation-profiles/imports/xlsx/preview',
      {
        method: 'POST',
        headers: { 'Content-Type': 'multipart/form-data; boundary=oversized' },
        body,
      },
    );

    expect(response.status).toBe(413);
    expect(apiErrorEnvelopeSchema.parse(await response.json()).error).toMatchObject({
      code: 'EVALUATION_PROFILE_IMPORT_INVALID',
      fieldErrors: [expect.objectContaining({ code: 'body_too_large' })],
    });
  });

  it('rejects an XLSX file above the file limit before invoking the workbook adapter', async () => {
    const previewImport = vi.fn(async () => preview());
    const file = new File(
      [new Uint8Array(EVALUATION_PROFILE_XLSX_LIMITS.maximumFileBytes + 1)],
      'oversized.xlsx',
      { type: EVALUATION_PROFILE_XLSX_MEDIA_TYPE },
    );

    const response = await xlsxApp(workbook({ previewImport })).request(
      '/api/v1/evaluation-profiles/imports/xlsx/preview',
      multipartRequest(file),
    );

    expect(response.status).toBe(413);
    expect(apiErrorEnvelopeSchema.parse(await response.json()).error).toMatchObject({
      code: 'EVALUATION_PROFILE_IMPORT_INVALID',
      fieldErrors: [expect.objectContaining({ path: ['file', 'size'], code: 'file_too_large' })],
    });
    expect(previewImport).not.toHaveBeenCalled();
  });

  it('rejects a declared Content-Length above the request limit before reading the body', async () => {
    const previewImport = vi.fn(async () => preview());
    const response = await xlsxApp(workbook({ previewImport })).request(
      '/api/v1/evaluation-profiles/imports/xlsx/preview',
      {
        method: 'POST',
        headers: {
          'Content-Length': String(MAXIMUM_EVALUATION_PROFILE_XLSX_REQUEST_BYTES + 1),
          'Content-Type': 'multipart/form-data; boundary=declared-oversized',
        },
        body: new Uint8Array([1]),
      },
    );

    expect(response.status).toBe(413);
    expect(apiErrorEnvelopeSchema.parse(await response.json()).error).toMatchObject({
      code: 'EVALUATION_PROFILE_IMPORT_INVALID',
      fieldErrors: [expect.objectContaining({ path: ['body'], code: 'body_too_large' })],
    });
    expect(previewImport).not.toHaveBeenCalled();
  });

  it('preserves workbook cell positions while hiding unexpected implementation errors', async () => {
    const located = xlsxApp(
      workbook({
        previewImport: async () => {
          throw new EvaluationProfileXlsxWorkbookError('Invalid workbook.', [
            {
              path: ['sheets', 'Items', 'rows', 3, 'columns', 'B'],
              code: 'unknown_dimension_id',
              message: 'Items!B3 references an unknown dimension.',
            },
          ]);
        },
      }),
    );
    const locatedResponse = await located.request(
      '/api/v1/evaluation-profiles/imports/xlsx/preview',
      multipartRequest(new File(['xlsx'], 'profile.xlsx')),
    );
    expect(locatedResponse.status).toBe(400);
    expect(apiErrorEnvelopeSchema.parse(await locatedResponse.json()).error).toMatchObject({
      code: 'EVALUATION_PROFILE_IMPORT_INVALID',
      fieldErrors: [
        {
          path: ['sheets', 'Items', 'rows', 3, 'columns', 'B'],
          code: 'unknown_dimension_id',
          message: 'Items!B3 references an unknown dimension.',
        },
      ],
    });

    const unexpected = xlsxApp(
      workbook({
        previewImport: async () => {
          throw new Error('private stack and path');
        },
      }),
    );
    const unexpectedResponse = await unexpected.request(
      '/api/v1/evaluation-profiles/imports/xlsx/preview',
      multipartRequest(new File(['xlsx'], 'profile.xlsx')),
    );
    expect(unexpectedResponse.status).toBe(500);
    const text = await unexpectedResponse.text();
    expect(text).not.toContain('private stack and path');
    expect(apiErrorEnvelopeSchema.parse(JSON.parse(text) as unknown).error.code).toBe(
      'INTERNAL_ERROR',
    );
  });
});

function preview(): EvaluationProfileXlsxImportPreviewResponse {
  const document = evaluationProfileDocumentSchema.parse({
    schemaVersion: 1,
    profile: {
      profileId: 'profile-xlsx',
      name: 'XLSX profile',
      description: '',
      coderPrompt: 'Code only transcript evidence.',
      scale: { minimum: 1, maximum: 7 },
      dimensions: [{ dimensionId: 'dimension-1', name: 'Dimension', order: 0 }],
      items: [
        {
          itemId: 'item-1',
          dimensionId: 'dimension-1',
          name: 'Item',
          codingInstruction: 'Code this item.',
          order: 0,
          anchors: [1, 2, 3, 4, 5, 6, 7].map((score) => ({
            score,
            criterion: `Criterion ${String(score)}`,
          })),
        },
      ],
    },
  });
  return evaluationProfileXlsxImportPreviewResponseSchema.parse({
    valid: true,
    document,
    source: {
      fileName: 'profile.xlsx',
      templateVersion: 1,
      dimensions: 1,
      items: 1,
      anchors: 7,
    },
  });
}

function workbook(
  overrides: Partial<EvaluationProfileXlsxWorkbook> = {},
): EvaluationProfileXlsxWorkbook {
  return {
    createTemplate: async () => ({
      body: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
      contentType: EVALUATION_PROFILE_XLSX_MEDIA_TYPE,
      fileName: 'evaluation-profile-template-v1.xlsx',
    }),
    previewImport: async () => preview(),
    ...overrides,
  };
}

function xlsxApp(workbooks: EvaluationProfileXlsxWorkbook): Hono<HttpEnvironment> {
  const app = new Hono<HttpEnvironment>();
  app.use('*', async (context, next) => {
    context.set('requestId', REQUEST_ID);
    await next();
  });
  registerEvaluationProfileXlsxHttpRoutes(app, {
    clock: { now: () => NOW },
    workbooks,
  });
  return app;
}

function multipartRequest(file: File): { readonly method: 'POST'; readonly body: FormData } {
  const body = new FormData();
  body.append('file', file);
  return { method: 'POST', body };
}
