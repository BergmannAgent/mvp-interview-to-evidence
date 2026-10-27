import { z } from 'zod';

import { idSchema, nonBlankTextSchema, timestampSchema } from './primitives.js';

export const API_ERROR_LIMITS = Object.freeze({
  maximumFieldErrors: 100,
  maximumPathSegments: 32,
  maximumPathSegmentCharacters: 200,
  maximumCodeCharacters: 100,
  maximumFieldMessageCharacters: 500,
  maximumMessageCharacters: 1_000,
});

export const MVP_REALTIME_CLIENT_PROTOCOL_HEADER = 'X-Orgscience-Realtime-Protocol';
export const MVP_REALTIME_CLIENT_PROTOCOL_VERSION = '2';

export const apiErrorCodeSchema = z.enum([
  'INVALID_REQUEST',
  'VALIDATION_ERROR',
  'GUIDE_INVALID',
  'FORBIDDEN',
  'CLIENT_UPDATE_REQUIRED',
  'NOT_FOUND',
  'CONFLICT',
  'INTERVIEW_STATE_CONFLICT',
  'SNAPSHOT_RESET_REQUIRED',
  'DUPLICATE_EVENT',
  'VOICE_CONFIGURATION_MISSING',
  'VOICE_CONFIGURATION_INVALID',
  'PROVIDER_ERROR',
  'TIMEOUT',
  'RATE_LIMITED',
  'EVALUATION_PROFILE_INVALID',
  'EVALUATION_PROFILE_IMPORT_INVALID',
  'EVALUATION_PROFILE_CONFLICT',
  'DEFAULT_PROFILE_REQUIRED',
  'SERVICE_UNAVAILABLE',
  'INTERNAL_ERROR',
]);

export const apiFieldErrorSchema = z.strictObject({
  path: z
    .array(
      z.union([
        z.string().max(API_ERROR_LIMITS.maximumPathSegmentCharacters),
        z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      ]),
    )
    .max(API_ERROR_LIMITS.maximumPathSegments),
  code: nonBlankTextSchema.max(API_ERROR_LIMITS.maximumCodeCharacters),
  message: nonBlankTextSchema.max(API_ERROR_LIMITS.maximumFieldMessageCharacters),
});

export const apiErrorEnvelopeSchema = z.strictObject({
  error: z.strictObject({
    code: apiErrorCodeSchema,
    message: nonBlankTextSchema.max(API_ERROR_LIMITS.maximumMessageCharacters),
    requestId: idSchema,
    occurredAt: timestampSchema,
    retryable: z.boolean(),
    fieldErrors: z.array(apiFieldErrorSchema).max(API_ERROR_LIMITS.maximumFieldErrors),
  }),
});

export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;
export type ApiFieldError = z.infer<typeof apiFieldErrorSchema>;
export type ApiErrorEnvelope = z.infer<typeof apiErrorEnvelopeSchema>;
