import {
  evaluationExportQuerySchema,
  evaluationSnapshotResponseSchema,
  idSchema,
  profileEvaluationSelectionQuerySchema,
  profileEvaluationStartRequestSchema,
  type EvaluationSnapshot,
} from '@orgscience/contracts';
import { zValidator } from '@hono/zod-validator';
import type { Hono } from 'hono';
import { z } from 'zod';

import {
  EvaluationServiceError,
  type EvaluationExportArtifact,
} from '../../application/evaluations/index.js';
import {
  createApiErrorResponse,
  type ErrorResponseClock,
  type HttpEnvironment,
} from './error-response.js';
import { validationHook } from './validation-hook.js';

interface EvaluationHttpService {
  get(interviewId: string, profileId?: string): Promise<EvaluationSnapshot>;
  run(interviewId: string, profileId?: string): Promise<EvaluationSnapshot>;
  retry(interviewId: string, profileId?: string): Promise<EvaluationSnapshot>;
  export(
    interviewId: string,
    format: unknown,
    profileId?: string,
  ): Promise<EvaluationExportArtifact>;
}

export interface EvaluationHttpRouteDependencies {
  readonly clock: ErrorResponseClock;
  readonly evaluation: EvaluationHttpService;
}

const interviewParamsSchema = z.strictObject({ interviewId: idSchema });

export function registerEvaluationHttpRoutes(
  app: Hono<HttpEnvironment>,
  dependencies: EvaluationHttpRouteDependencies,
): void {
  app.get(
    '/api/v1/interviews/:interviewId/evaluation',
    zValidator<
      typeof interviewParamsSchema,
      'param',
      HttpEnvironment,
      string,
      ReturnType<typeof validationHook>
    >('param', interviewParamsSchema, validationHook(dependencies.clock)),
    zValidator<
      typeof profileEvaluationSelectionQuerySchema,
      'query',
      HttpEnvironment,
      string,
      ReturnType<typeof validationHook>
    >('query', profileEvaluationSelectionQuerySchema, validationHook(dependencies.clock)),
    async (context) => {
      try {
        const evaluation = await dependencies.evaluation.get(
          context.req.valid('param').interviewId,
          context.req.valid('query').profileId,
        );
        return context.json(evaluationSnapshotResponseSchema.parse({ evaluation }), 200);
      } catch (error: unknown) {
        return evaluationErrorResponse(context, dependencies.clock, error);
      }
    },
  );

  app.post(
    '/api/v1/interviews/:interviewId/evaluation',
    zValidator<
      typeof interviewParamsSchema,
      'param',
      HttpEnvironment,
      string,
      ReturnType<typeof validationHook>
    >('param', interviewParamsSchema, validationHook(dependencies.clock)),
    zValidator<
      typeof profileEvaluationStartRequestSchema,
      'json',
      HttpEnvironment,
      string,
      ReturnType<typeof validationHook>
    >('json', profileEvaluationStartRequestSchema, validationHook(dependencies.clock)),
    async (context) => {
      try {
        const evaluation = await dependencies.evaluation.run(
          context.req.valid('param').interviewId,
          context.req.valid('json').profileId,
        );
        return context.json(evaluationSnapshotResponseSchema.parse({ evaluation }), 200);
      } catch (error: unknown) {
        return evaluationErrorResponse(context, dependencies.clock, error);
      }
    },
  );

  app.post(
    '/api/v1/interviews/:interviewId/evaluation/retry',
    zValidator<
      typeof interviewParamsSchema,
      'param',
      HttpEnvironment,
      string,
      ReturnType<typeof validationHook>
    >('param', interviewParamsSchema, validationHook(dependencies.clock)),
    zValidator<
      typeof profileEvaluationStartRequestSchema,
      'json',
      HttpEnvironment,
      string,
      ReturnType<typeof validationHook>
    >('json', profileEvaluationStartRequestSchema, validationHook(dependencies.clock)),
    async (context) => {
      try {
        const evaluation = await dependencies.evaluation.retry(
          context.req.valid('param').interviewId,
          context.req.valid('json').profileId,
        );
        return context.json(evaluationSnapshotResponseSchema.parse({ evaluation }), 200);
      } catch (error: unknown) {
        return evaluationErrorResponse(context, dependencies.clock, error);
      }
    },
  );

  app.get(
    '/api/v1/interviews/:interviewId/evaluation/export',
    zValidator<
      typeof interviewParamsSchema,
      'param',
      HttpEnvironment,
      string,
      ReturnType<typeof validationHook>
    >('param', interviewParamsSchema, validationHook(dependencies.clock)),
    zValidator<
      typeof evaluationExportQuerySchema,
      'query',
      HttpEnvironment,
      string,
      ReturnType<typeof validationHook>
    >('query', evaluationExportQuerySchema, validationHook(dependencies.clock)),
    async (context) => {
      try {
        const artifact = await dependencies.evaluation.export(
          context.req.valid('param').interviewId,
          context.req.valid('query').format,
          context.req.valid('query').profileId,
        );
        context.header('Content-Type', artifact.contentType);
        context.header(
          'Content-Disposition',
          `${context.req.valid('query').format === 'html' ? 'inline' : 'attachment'}; filename="${artifact.fileName}"`,
        );
        context.header('Cache-Control', 'no-store');
        context.header('X-Content-Type-Options', 'nosniff');
        if (context.req.valid('query').format === 'html') {
          context.header(
            'Content-Security-Policy',
            "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
          );
        }
        return context.body(artifact.body, 200);
      } catch (error: unknown) {
        return evaluationErrorResponse(context, dependencies.clock, error);
      }
    },
  );
}

function evaluationErrorResponse(
  context: Parameters<typeof createApiErrorResponse>[0],
  clock: ErrorResponseClock,
  error: unknown,
): Response {
  if (!(error instanceof EvaluationServiceError)) {
    return createApiErrorResponse(context, clock, {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'The evaluation could not be completed.',
    });
  }
  switch (error.code) {
    case 'not_found':
      return createApiErrorResponse(context, clock, {
        status: 404,
        code: 'NOT_FOUND',
        message: error.message,
      });
    case 'invalid_state':
    case 'conflict':
      return createApiErrorResponse(context, clock, {
        status: 409,
        code: 'INTERVIEW_STATE_CONFLICT',
        message: error.message,
        retryable: error.retryable,
      });
    case 'unavailable':
      return createApiErrorResponse(context, clock, {
        status: 503,
        code: 'SERVICE_UNAVAILABLE',
        message: error.message,
        retryable: true,
      });
    case 'internal':
      return createApiErrorResponse(context, clock, {
        status: 500,
        code: 'INTERNAL_ERROR',
        message: 'The evaluation could not be completed.',
      });
  }
}
