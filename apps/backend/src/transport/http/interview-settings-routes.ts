import {
  guideListQuerySchema,
  guideListResponseSchema,
  interviewSettingsResponseSchema,
  supportedLocaleSchema,
  updateInterviewGuideSettingSchema,
} from '@orgscience/contracts';
import { zValidator } from '@hono/zod-validator';
import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';

import type { InterviewSettingsService } from '../../application/guides/interview-settings.js';
import {
  createApplicationErrorResponse,
  type ErrorResponseClock,
  type HttpEnvironment,
} from './error-response.js';
import { validationHook } from './validation-hook.js';

const languageParamsSchema = z.strictObject({ language: supportedLocaleSchema });

export function registerInterviewSettingsRoutes(
  app: Hono<HttpEnvironment>,
  service: InterviewSettingsService,
  clock: ErrorResponseClock,
): void {
  app.get(
    '/api/v1/guides',
    zValidator<
      typeof guideListQuerySchema,
      'query',
      HttpEnvironment,
      string,
      ReturnType<typeof validationHook>
    >('query', guideListQuerySchema, validationHook(clock)),
    async (context) => {
      const result = await service.listGuides(context.req.valid('query').sourceLanguage);
      if (!result.ok) return createApplicationErrorResponse(context, clock, result.error);
      return context.json(guideListResponseSchema.parse({ guides: result.value }));
    },
  );
  app.get('/api/v1/interview-settings', async (context) => {
    const result = await service.get();
    if (!result.ok) return createApplicationErrorResponse(context, clock, result.error);
    return context.json(interviewSettingsResponseSchema.parse({ settings: result.value }));
  });
  app.put(
    '/api/v1/interview-settings/:language',
    bodyLimit({ maxSize: 16_384 }),
    zValidator<
      typeof languageParamsSchema,
      'param',
      HttpEnvironment,
      string,
      ReturnType<typeof validationHook>
    >('param', languageParamsSchema, validationHook(clock)),
    zValidator<
      typeof updateInterviewGuideSettingSchema,
      'json',
      HttpEnvironment,
      string,
      ReturnType<typeof validationHook>
    >('json', updateInterviewGuideSettingSchema, validationHook(clock)),
    async (context) => {
      const result = await service.update(
        context.req.valid('param').language,
        context.req.valid('json').guideId,
      );
      if (!result.ok) return createApplicationErrorResponse(context, clock, result.error);
      return context.json(interviewSettingsResponseSchema.parse({ settings: [result.value] }));
    },
  );
}
