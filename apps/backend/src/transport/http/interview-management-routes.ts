import {
  idSchema,
  interviewRenameRequestSchema,
  interviewResponseSchema,
} from '@orgscience/contracts';
import { zValidator } from '@hono/zod-validator';
import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';

import type { ManageInterviewsService } from '../../application/interviews/manage-interviews.js';
import {
  createApplicationErrorResponse,
  type ErrorResponseClock,
  type HttpEnvironment,
} from './error-response.js';
import { validationHook } from './validation-hook.js';

const paramsSchema = z.strictObject({ interviewId: idSchema });

export function registerInterviewManagementRoutes(
  app: Hono<HttpEnvironment>,
  service: Pick<ManageInterviewsService, 'rename' | 'delete'>,
  clock: ErrorResponseClock,
): void {
  app.patch(
    '/api/v1/interviews/:interviewId',
    bodyLimit({ maxSize: 16_384 }),
    zValidator<
      typeof paramsSchema,
      'param',
      HttpEnvironment,
      string,
      ReturnType<typeof validationHook>
    >('param', paramsSchema, validationHook(clock)),
    zValidator<
      typeof interviewRenameRequestSchema,
      'json',
      HttpEnvironment,
      string,
      ReturnType<typeof validationHook>
    >('json', interviewRenameRequestSchema, validationHook(clock)),
    async (context) => {
      const result = await service.rename(
        context.req.valid('param').interviewId,
        context.req.valid('json').displayName,
      );
      if (!result.ok) return createApplicationErrorResponse(context, clock, result.error);
      return context.json(interviewResponseSchema.parse({ interview: result.value }));
    },
  );
  app.delete(
    '/api/v1/interviews/:interviewId',
    zValidator<
      typeof paramsSchema,
      'param',
      HttpEnvironment,
      string,
      ReturnType<typeof validationHook>
    >('param', paramsSchema, validationHook(clock)),
    async (context) => {
      const result = await service.delete(context.req.valid('param').interviewId);
      if (!result.ok) return createApplicationErrorResponse(context, clock, result.error);
      return context.body(null, 204);
    },
  );
}
