import {
  EVALUATION_PROFILE_LIMITS,
  evaluationProfileCreateRequestSchema,
  evaluationProfileDeleteQuerySchema,
  evaluationProfileDocumentSchema,
  evaluationProfileDuplicateRequestSchema,
  evaluationProfileImportRequestSchema,
  evaluationProfileImportPreviewResponseSchema,
  evaluationProfileListResponseSchema,
  evaluationProfileLockedGuardrailsResponseSchema,
  evaluationProfileResponseSchema,
  evaluationProfileUpdateRequestSchema,
  idSchema,
  type ApiErrorCode,
  type ApiFieldError,
} from '@orgscience/contracts';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { z } from 'zod';

import {
  EvaluationProfileServiceError,
  type EvaluationProfileJsonArtifact,
  type EvaluationProfileService,
} from '../../application/evaluation-profiles/index.js';
import {
  createApiErrorResponse,
  type ErrorResponseClock,
  type HttpEnvironment,
} from './error-response.js';
import { mediaTypeEssence } from './media-type.js';

export const MAXIMUM_EVALUATION_PROFILE_REQUEST_BYTES =
  EVALUATION_PROFILE_LIMITS.maximumSerializedBytes + 1024 * 1024;

export interface EvaluationProfileHttpRouteDependencies {
  readonly clock: ErrorResponseClock;
  readonly evaluationProfiles: Pick<
    EvaluationProfileService,
    | 'list'
    | 'get'
    | 'create'
    | 'update'
    | 'duplicate'
    | 'delete'
    | 'exportJson'
    | 'template'
    | 'previewImport'
    | 'importJson'
    | 'guardrails'
  >;
}

export function registerEvaluationProfileHttpRoutes(
  app: Hono<HttpEnvironment>,
  dependencies: EvaluationProfileHttpRouteDependencies,
): void {
  const jsonLimit = bodyLimit({ maxSize: MAXIMUM_EVALUATION_PROFILE_REQUEST_BYTES });

  app.get('/api/v1/evaluation-profiles', async (context) => {
    try {
      const profiles = await dependencies.evaluationProfiles.list();
      return context.json(evaluationProfileListResponseSchema.parse({ profiles }), 200);
    } catch (error: unknown) {
      return profileErrorResponse(context, dependencies.clock, error);
    }
  });

  app.get('/api/v1/evaluation-profiles/templates/json', (context) => {
    try {
      return artifactResponse(context, dependencies.evaluationProfiles.template(), 'attachment');
    } catch (error: unknown) {
      return profileErrorResponse(context, dependencies.clock, error);
    }
  });

  app.get('/api/v1/evaluation-profiles/meta/guardrails', (context) => {
    try {
      const guardrails = dependencies.evaluationProfiles.guardrails();
      return context.json(
        evaluationProfileLockedGuardrailsResponseSchema.parse({ guardrails }),
        200,
      );
    } catch (error: unknown) {
      return profileErrorResponse(context, dependencies.clock, error);
    }
  });

  app.post('/api/v1/evaluation-profiles/imports/json/preview', jsonLimit, async (context) => {
    const document = await validatedJson(
      context,
      dependencies.clock,
      evaluationProfileDocumentSchema,
      'EVALUATION_PROFILE_IMPORT_INVALID',
    );
    if (!document.ok) return document.response;
    try {
      const preview = dependencies.evaluationProfiles.previewImport(document.value);
      return context.json(evaluationProfileImportPreviewResponseSchema.parse(preview), 200);
    } catch (error: unknown) {
      return profileErrorResponse(context, dependencies.clock, error, true);
    }
  });

  app.post('/api/v1/evaluation-profiles/imports/json/confirm', jsonLimit, async (context) => {
    const request = await validatedJson(
      context,
      dependencies.clock,
      evaluationProfileImportRequestSchema,
      'EVALUATION_PROFILE_IMPORT_INVALID',
    );
    if (!request.ok) return request.response;
    try {
      const profile = await dependencies.evaluationProfiles.importJson(request.value);
      return context.json(
        evaluationProfileResponseSchema.parse({ profile }),
        request.value.mode === 'create' ? 201 : 200,
      );
    } catch (error: unknown) {
      return profileErrorResponse(context, dependencies.clock, error, true);
    }
  });

  app.post('/api/v1/evaluation-profiles', jsonLimit, async (context) => {
    const request = await validatedJson(
      context,
      dependencies.clock,
      evaluationProfileCreateRequestSchema,
      'EVALUATION_PROFILE_INVALID',
    );
    if (!request.ok) return request.response;
    try {
      const profile = await dependencies.evaluationProfiles.create(request.value.profile);
      return context.json(evaluationProfileResponseSchema.parse({ profile }), 201);
    } catch (error: unknown) {
      return profileErrorResponse(context, dependencies.clock, error);
    }
  });

  app.get('/api/v1/evaluation-profiles/:profileId/export', async (context) => {
    const profileId = validatedProfileId(context, dependencies.clock);
    if (!profileId.ok) return profileId.response;
    try {
      return artifactResponse(
        context,
        await dependencies.evaluationProfiles.exportJson(profileId.value),
        'attachment',
      );
    } catch (error: unknown) {
      return profileErrorResponse(context, dependencies.clock, error);
    }
  });

  app.post('/api/v1/evaluation-profiles/:profileId/duplicate', jsonLimit, async (context) => {
    const profileId = validatedProfileId(context, dependencies.clock);
    if (!profileId.ok) return profileId.response;
    const request = await validatedJson(
      context,
      dependencies.clock,
      evaluationProfileDuplicateRequestSchema,
      'EVALUATION_PROFILE_INVALID',
    );
    if (!request.ok) return request.response;
    try {
      const profile = await dependencies.evaluationProfiles.duplicate(
        profileId.value,
        request.value.name,
      );
      return context.json(evaluationProfileResponseSchema.parse({ profile }), 201);
    } catch (error: unknown) {
      return profileErrorResponse(context, dependencies.clock, error);
    }
  });

  app.get('/api/v1/evaluation-profiles/:profileId', async (context) => {
    const profileId = validatedProfileId(context, dependencies.clock);
    if (!profileId.ok) return profileId.response;
    try {
      const profile = await dependencies.evaluationProfiles.get(profileId.value);
      return context.json(evaluationProfileResponseSchema.parse({ profile }), 200);
    } catch (error: unknown) {
      return profileErrorResponse(context, dependencies.clock, error);
    }
  });

  app.put('/api/v1/evaluation-profiles/:profileId', jsonLimit, async (context) => {
    const profileId = validatedProfileId(context, dependencies.clock);
    if (!profileId.ok) return profileId.response;
    const request = await validatedJson(
      context,
      dependencies.clock,
      evaluationProfileUpdateRequestSchema,
      'EVALUATION_PROFILE_INVALID',
    );
    if (!request.ok) return request.response;
    try {
      const profile = await dependencies.evaluationProfiles.update(
        profileId.value,
        request.value.expectedUpdatedAt,
        request.value.profile,
      );
      return context.json(evaluationProfileResponseSchema.parse({ profile }), 200);
    } catch (error: unknown) {
      return profileErrorResponse(context, dependencies.clock, error);
    }
  });

  app.delete('/api/v1/evaluation-profiles/:profileId', async (context) => {
    const profileId = validatedProfileId(context, dependencies.clock);
    if (!profileId.ok) return profileId.response;
    const query = evaluationProfileDeleteQuerySchema.safeParse(context.req.query());
    if (!query.success) {
      return profileValidationErrorResponse(
        context,
        dependencies.clock,
        'EVALUATION_PROFILE_INVALID',
        query.error.issues,
      );
    }
    try {
      await dependencies.evaluationProfiles.delete(profileId.value, query.data.expectedUpdatedAt);
      return context.body(null, 204);
    } catch (error: unknown) {
      return profileErrorResponse(context, dependencies.clock, error);
    }
  });
}

async function validatedJson<Schema extends z.ZodType>(
  context: Context<HttpEnvironment>,
  clock: ErrorResponseClock,
  schema: Schema,
  code: Extract<ApiErrorCode, 'EVALUATION_PROFILE_INVALID' | 'EVALUATION_PROFILE_IMPORT_INVALID'>,
): Promise<
  | { readonly ok: true; readonly value: z.output<Schema> }
  | { readonly ok: false; readonly response: Response }
> {
  if (mediaTypeEssence(context.req.header('content-type') ?? null) !== 'application/json') {
    return {
      ok: false,
      response: createApiErrorResponse(context, clock, {
        status: 415,
        code,
        message: 'The request body must use application/json.',
        fieldErrors: [
          {
            path: ['body'],
            code: 'invalid_content_type',
            message: 'Content-Type must be application/json.',
          },
        ],
      }),
    };
  }

  let body: unknown;
  try {
    body = await context.req.json<unknown>();
  } catch {
    return {
      ok: false,
      response: createApiErrorResponse(context, clock, {
        status: 400,
        code,
        message: 'The JSON request body could not be read.',
        fieldErrors: [
          { path: ['body'], code: 'invalid_json', message: 'The request body is not valid JSON.' },
        ],
      }),
    };
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      response: profileValidationErrorResponse(context, clock, code, parsed.error.issues),
    };
  }
  return { ok: true, value: parsed.data };
}

function profileValidationErrorResponse(
  context: Context<HttpEnvironment>,
  clock: ErrorResponseClock,
  code: Extract<ApiErrorCode, 'EVALUATION_PROFILE_INVALID' | 'EVALUATION_PROFILE_IMPORT_INVALID'>,
  issues: readonly z.core.$ZodIssue[],
): Response {
  return createApiErrorResponse(context, clock, {
    status: 400,
    code,
    message: 'The evaluation profile does not satisfy the API contract.',
    fieldErrors: issues.map(zodIssueToFieldError),
  });
}

function validatedProfileId(
  context: Context<HttpEnvironment>,
  clock: ErrorResponseClock,
):
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly response: Response } {
  const parsed = idSchema.safeParse(context.req.param('profileId'));
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    response: createApiErrorResponse(context, clock, {
      status: 400,
      code: 'EVALUATION_PROFILE_INVALID',
      message: 'The evaluation profile ID is invalid.',
      fieldErrors: parsed.error.issues.map((issue) =>
        zodIssueToFieldError({ ...issue, path: ['profileId', ...issue.path] }),
      ),
    }),
  };
}

function zodIssueToFieldError(issue: z.core.$ZodIssue): ApiFieldError {
  return {
    path: issue.path.map((part) => (typeof part === 'symbol' ? String(part) : part)),
    code: issue.code,
    message: issue.message,
  };
}

function artifactResponse(
  context: Context<HttpEnvironment>,
  artifact: EvaluationProfileJsonArtifact,
  disposition: 'attachment' | 'inline',
): Response {
  context.header('Content-Type', artifact.contentType);
  context.header('Content-Disposition', `${disposition}; filename="${artifact.fileName}"`);
  context.header('Cache-Control', 'no-store');
  context.header('X-Content-Type-Options', 'nosniff');
  return context.body(artifact.body, 200);
}

function profileErrorResponse(
  context: Context<HttpEnvironment>,
  clock: ErrorResponseClock,
  error: unknown,
  importOperation = false,
): Response {
  if (!(error instanceof EvaluationProfileServiceError)) {
    return createApiErrorResponse(context, clock, {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'The evaluation profile operation could not be completed.',
    });
  }
  switch (error.code) {
    case 'not_found':
      return createApiErrorResponse(context, clock, {
        status: 404,
        code: 'NOT_FOUND',
        message: error.message,
      });
    case 'conflict':
      return createApiErrorResponse(context, clock, {
        status: 409,
        code: 'EVALUATION_PROFILE_CONFLICT',
        message: error.message,
      });
    case 'invalid_profile':
      return createApiErrorResponse(context, clock, {
        status: 400,
        code: importOperation ? 'EVALUATION_PROFILE_IMPORT_INVALID' : 'EVALUATION_PROFILE_INVALID',
        message: error.message,
      });
    case 'default_required':
      return createApiErrorResponse(context, clock, {
        status: 409,
        code: 'DEFAULT_PROFILE_REQUIRED',
        message: error.message,
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
        message: 'The evaluation profile operation could not be completed.',
      });
  }
}
