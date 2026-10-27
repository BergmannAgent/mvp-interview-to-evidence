import type { ApiErrorCode, ApiFieldError } from '@orgscience/contracts';
import { API_ERROR_LIMITS, apiErrorEnvelopeSchema, timestampSchema } from '@orgscience/contracts';
import type { Context } from 'hono';

import type { ApplicationError } from '../../application/index.js';

export interface HttpEnvironment {
  readonly Variables: {
    readonly requestId: string;
  };
}

export interface ErrorResponseClock {
  now(): string;
}

export type ApiErrorStatus = 400 | 403 | 404 | 409 | 413 | 415 | 422 | 500 | 503;

interface ApiErrorInput {
  readonly status: ApiErrorStatus;
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly retryable?: boolean;
  readonly fieldErrors?: readonly ApiFieldError[];
}

export function createApiErrorResponse(
  context: Context<HttpEnvironment>,
  clock: ErrorResponseClock,
  input: ApiErrorInput,
): Response {
  const envelope = apiErrorEnvelopeSchema.parse({
    error: {
      code: input.code,
      message: boundedNonBlankText(
        input.message,
        API_ERROR_LIMITS.maximumMessageCharacters,
        'The request could not be completed.',
      ),
      requestId: context.get('requestId'),
      occurredAt: safeTimestamp(clock),
      retryable: input.retryable ?? false,
      fieldErrors: normalizeFieldErrors(input.fieldErrors ?? []),
    },
  });
  return context.json(envelope, input.status);
}

export function createApplicationErrorResponse(
  context: Context<HttpEnvironment>,
  clock: ErrorResponseClock,
  error: ApplicationError,
): Response {
  switch (error.code) {
    case 'guide_invalid':
      return createApiErrorResponse(context, clock, {
        status: 422,
        code: 'GUIDE_INVALID',
        message: 'The interview guide has an invalid Markdown structure.',
        fieldErrors: error.issues.slice(0, API_ERROR_LIMITS.maximumFieldErrors).map((issue) => ({
          path: ['file', 'line', issue.line],
          code: issue.code,
          message: issue.message,
        })),
      });
    case 'application_validation':
      return createApiErrorResponse(context, clock, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'The request does not satisfy the application contract.',
        fieldErrors: [{ path: [error.field], code: error.code, message: error.message }],
      });
    case 'not_found':
      return createApiErrorResponse(context, clock, {
        status: 404,
        code: 'NOT_FOUND',
        message: 'The requested resource was not found.',
      });
    case 'interview_busy':
      return createApiErrorResponse(context, clock, {
        status: 409,
        code: 'INTERVIEW_STATE_CONFLICT',
        message:
          'Pause or end the interview and wait for any running evaluation before deleting it.',
        fieldErrors: [
          {
            path: ['interviewId'],
            code: error.reason,
            message: 'The interview still has active processing and cannot be deleted safely.',
          },
        ],
      });
    case 'duplicate_conflict':
    case 'lease_lost':
      return createApiErrorResponse(context, clock, {
        status: 409,
        code: 'CONFLICT',
        message: 'The request conflicts with persisted application state.',
      });
    case 'stale_version':
    case 'sequence_conflict':
    case 'active_job_exists':
    case 'transcript_finalized':
    case 'pending_ai_delivery':
    case 'unresolved_transcript_partial':
      return createApiErrorResponse(context, clock, {
        status: 409,
        code: 'INTERVIEW_STATE_CONFLICT',
        message: 'The request conflicts with the current interview state.',
      });
    case 'monitoring_cursor_ahead':
      return createApiErrorResponse(context, clock, {
        status: 409,
        code: 'SNAPSHOT_RESET_REQUIRED',
        message: 'The monitoring cursor is ahead of persisted history. Refresh the snapshot.',
        fieldErrors: [
          {
            path: ['afterSequence'],
            code: 'cursor_ahead',
            message: `The latest persisted event sequence is ${String(error.highWaterSequence)}.`,
          },
        ],
      });
    case 'monitoring_cursor_stale':
      return createApiErrorResponse(context, clock, {
        status: 409,
        code: 'SNAPSHOT_RESET_REQUIRED',
        message: 'The monitoring cursor is too far behind persisted history. Refresh the snapshot.',
        fieldErrors: [
          {
            path: ['afterSequence'],
            code: 'cursor_stale',
            message: `The latest persisted event sequence is ${String(error.highWaterSequence)}.`,
          },
        ],
      });
    case 'serialization_failure':
    case 'unavailable':
      return createApiErrorResponse(context, clock, {
        status: 503,
        code: 'SERVICE_UNAVAILABLE',
        message: 'A required service is temporarily unavailable.',
        retryable: true,
      });
    case 'application_invariant':
    case 'runtime_dependency_invalid':
    case 'constraint_violation':
    case 'corrupt_data':
    case 'internal':
      return createApiErrorResponse(context, clock, {
        status: 500,
        code: 'INTERNAL_ERROR',
        message: 'The request could not be completed.',
      });
  }
}

function normalizeFieldErrors(fieldErrors: readonly ApiFieldError[]): ApiFieldError[] {
  return fieldErrors.slice(0, API_ERROR_LIMITS.maximumFieldErrors).map((fieldError) => ({
    path: fieldError.path.slice(0, API_ERROR_LIMITS.maximumPathSegments).map(normalizePathSegment),
    code: boundedNonBlankText(fieldError.code, API_ERROR_LIMITS.maximumCodeCharacters, 'invalid'),
    message: boundedNonBlankText(
      fieldError.message,
      API_ERROR_LIMITS.maximumFieldMessageCharacters,
      'The field is invalid.',
    ),
  }));
}

function normalizePathSegment(segment: string | number): string | number {
  if (typeof segment === 'number') {
    return Number.isSafeInteger(segment) && segment >= 0 ? segment : 0;
  }
  return segment.slice(0, API_ERROR_LIMITS.maximumPathSegmentCharacters);
}

function boundedNonBlankText(value: string, maximum: number, fallback: string): string {
  const trimmed = value.trim();
  const candidate = trimmed.length > 0 ? trimmed : fallback.trim();
  return candidate.slice(0, maximum);
}

function safeTimestamp(clock: ErrorResponseClock): string {
  try {
    const candidate = timestampSchema.safeParse(clock.now());
    if (candidate.success) {
      return candidate.data;
    }
  } catch {
    // Error responses must remain available even when an injected clock fails.
  }
  return new Date().toISOString();
}
