import type { ErrorResponseClock } from './error-response.js';
import { createApiErrorResponse } from './error-response.js';

interface ValidationIssueLike {
  readonly code: string;
  readonly message: string;
  readonly path: readonly PropertyKey[];
}

interface ValidationResultLike {
  readonly success: boolean;
  readonly error?: {
    readonly issues: readonly ValidationIssueLike[];
  };
}

export function validationHook(clock: ErrorResponseClock) {
  return (
    result: ValidationResultLike,
    context: Parameters<typeof createApiErrorResponse>[0],
  ): Response | undefined => {
    if (result.success || result.error === undefined) {
      return undefined;
    }
    return createApiErrorResponse(context, clock, {
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'The request does not satisfy the HTTP contract.',
      fieldErrors: result.error.issues.map((issue) => ({
        path: issue.path.map((part) => (typeof part === 'symbol' ? String(part) : part)),
        code: issue.code,
        message: issue.message,
      })),
    });
  };
}
