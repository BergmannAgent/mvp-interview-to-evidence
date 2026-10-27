import { evaluationProfileXlsxImportPreviewResponseSchema } from '@orgscience/contracts';
import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import {
  EvaluationProfileXlsxWorkbookError,
  type EvaluationProfileXlsxWorkbook,
} from '../../application/evaluation-profiles/index.js';
import {
  createApiErrorResponse,
  type ErrorResponseClock,
  type HttpEnvironment,
} from './error-response.js';
import {
  MAXIMUM_EVALUATION_PROFILE_XLSX_REQUEST_BYTES,
  readEvaluationProfileXlsxUpload,
} from './evaluation-profile-xlsx-upload.js';

export interface EvaluationProfileXlsxHttpRouteDependencies {
  readonly clock: ErrorResponseClock;
  readonly workbooks: EvaluationProfileXlsxWorkbook;
}

export function registerEvaluationProfileXlsxHttpRoutes(
  app: Hono<HttpEnvironment>,
  dependencies: EvaluationProfileXlsxHttpRouteDependencies,
): void {
  app.get('/api/v1/evaluation-profiles/templates/xlsx', async (context) => {
    try {
      const artifact = await dependencies.workbooks.createTemplate();
      context.header('Content-Type', artifact.contentType);
      context.header('Content-Disposition', `attachment; filename="${artifact.fileName}"`);
      context.header('Cache-Control', 'no-store');
      context.header('X-Content-Type-Options', 'nosniff');
      return context.body(Uint8Array.from(artifact.body).buffer, 200);
    } catch {
      return createApiErrorResponse(context, dependencies.clock, {
        status: 500,
        code: 'INTERNAL_ERROR',
        message: 'The XLSX template could not be generated.',
      });
    }
  });

  app.post(
    '/api/v1/evaluation-profiles/imports/xlsx/preview',
    bodyLimit({
      maxSize: MAXIMUM_EVALUATION_PROFILE_XLSX_REQUEST_BYTES,
      onError: (context) =>
        createApiErrorResponse(context, dependencies.clock, {
          status: 413,
          code: 'EVALUATION_PROFILE_IMPORT_INVALID',
          message: 'The XLSX upload exceeds the maximum request size.',
          fieldErrors: [
            {
              path: ['body'],
              code: 'body_too_large',
              message: 'The multipart request body is too large.',
            },
          ],
        }),
    }),
    async (context) => {
      const upload = await readEvaluationProfileXlsxUpload(context.req.raw);
      if (!upload.ok) {
        return createApiErrorResponse(context, dependencies.clock, {
          status: upload.status,
          code: 'EVALUATION_PROFILE_IMPORT_INVALID',
          message: upload.message,
          fieldErrors: upload.fieldErrors,
        });
      }

      try {
        const preview = await dependencies.workbooks.previewImport(upload.value);
        return context.json(evaluationProfileXlsxImportPreviewResponseSchema.parse(preview), 200);
      } catch (error: unknown) {
        if (error instanceof EvaluationProfileXlsxWorkbookError) {
          return createApiErrorResponse(context, dependencies.clock, {
            status: 400,
            code: 'EVALUATION_PROFILE_IMPORT_INVALID',
            message: error.message,
            fieldErrors: error.fieldErrors,
          });
        }
        return createApiErrorResponse(context, dependencies.clock, {
          status: 500,
          code: 'INTERNAL_ERROR',
          message: 'The XLSX import preview could not be generated.',
        });
      }
    },
  );
}
