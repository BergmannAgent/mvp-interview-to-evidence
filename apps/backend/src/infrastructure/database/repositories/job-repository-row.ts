import { idSchema } from '@orgscience/contracts';
import { z } from 'zod';

import {
  failure,
  success,
  type DurableJob,
  type EnqueueJobInput,
  type RepositoryResult,
  type StoredFailure,
} from '../../../application/persistence/index.js';
import { corruptData } from './repository-errors.js';

const databaseTimestampSchema = z
  .union([z.string(), z.date()])
  .transform((value, context): string => {
    const timestamp = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(timestamp.getTime())) {
      context.addIssue({ code: 'custom', message: 'Invalid database timestamp' });
      return z.NEVER;
    }
    return timestamp.toISOString();
  });

const nullableDatabaseTimestampSchema = databaseTimestampSchema.nullable();

const jobRowSchema = z
  .strictObject({
    interviewId: idSchema,
    jobId: idSchema,
    kind: z.enum(['start_interview', 'participant_turn', 'finish_interview']),
    idempotencyKey: z.string().min(1),
    sourceTurnId: idSchema.nullable(),
    expectedInterviewVersion: z.number().int().nonnegative(),
    status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
    attemptCount: z.number().int().nonnegative(),
    maximumAttempts: z.number().int().positive(),
    initialDelayMs: z.number().int().min(0).max(900_000),
    availableAt: databaseTimestampSchema,
    leaseOwner: z.string().min(1).nullable(),
    leaseToken: z.string().min(1).nullable(),
    leaseExpiresAt: nullableDatabaseTimestampSchema,
    appliedStateVersion: z.number().int().nonnegative().nullable(),
    cancellationReason: z.string().min(1).nullable(),
    resultDeliveryId: idSchema.nullable(),
    lastErrorCode: z.string().min(1).nullable(),
    lastErrorMessage: z.string().min(1).nullable(),
    lastErrorRetryable: z.boolean().nullable(),
    lastErrorOccurredAt: nullableDatabaseTimestampSchema,
    createdAt: databaseTimestampSchema,
    updatedAt: databaseTimestampSchema,
    completedAt: nullableDatabaseTimestampSchema,
  })
  .superRefine((row, context) => {
    const errorValues = [
      row.lastErrorCode,
      row.lastErrorMessage,
      row.lastErrorRetryable,
      row.lastErrorOccurredAt,
    ];
    const errorValueCount = errorValues.filter((value) => value !== null).length;
    if (errorValueCount !== 0 && errorValueCount !== errorValues.length) {
      context.addIssue({
        code: 'custom',
        message: 'Job failure columns must be all null or all set',
      });
    }
    if (row.attemptCount > row.maximumAttempts) {
      context.addIssue({ code: 'custom', message: 'Job attempts exceed the configured maximum' });
    }
    if (row.status === 'running') {
      if (row.leaseOwner === null || row.leaseToken === null || row.leaseExpiresAt === null) {
        context.addIssue({ code: 'custom', message: 'A running job requires a complete lease' });
      }
    } else if (row.leaseOwner !== null || row.leaseExpiresAt !== null) {
      context.addIssue({
        code: 'custom',
        message: 'A non-running job cannot have an active lease',
      });
    }
    const terminal =
      row.status === 'succeeded' || row.status === 'failed' || row.status === 'cancelled';
    if ((terminal && row.completedAt === null) || (!terminal && row.completedAt !== null)) {
      context.addIssue({
        code: 'custom',
        message: 'Job completion timestamp conflicts with status',
      });
    }
    if ((row.status === 'cancelled') !== (row.cancellationReason !== null)) {
      context.addIssue({
        code: 'custom',
        message: 'Job cancellation reason conflicts with status',
      });
    }
    if ((row.status === 'succeeded') !== (row.appliedStateVersion !== null)) {
      context.addIssue({ code: 'custom', message: 'Applied state version conflicts with status' });
    }
    if (Date.parse(row.updatedAt) < Date.parse(row.createdAt)) {
      context.addIssue({ code: 'custom', message: 'Job timestamps move backwards' });
    }
  });

type JobRow = z.infer<typeof jobRowSchema>;

export const sourceTurnIdentityRowSchema = z.strictObject({ turnId: idSchema });

export function parseJob(value: unknown, jobId: string): RepositoryResult<DurableJob> {
  const result = jobRowSchema.safeParse(value);
  if (!result.success) {
    return failure(
      corruptData('job', jobId, result.error.issues.map((issue) => issue.message).join('; ')),
    );
  }
  return success(rowToJob(result.data));
}

function rowToJob(row: JobRow): DurableJob {
  const lastError =
    row.lastErrorCode === null ||
    row.lastErrorMessage === null ||
    row.lastErrorRetryable === null ||
    row.lastErrorOccurredAt === null
      ? null
      : {
          code: row.lastErrorCode,
          message: row.lastErrorMessage,
          retryable: row.lastErrorRetryable,
          occurredAt: row.lastErrorOccurredAt,
        };
  return {
    interviewId: row.interviewId,
    jobId: row.jobId,
    kind: row.kind,
    idempotencyKey: row.idempotencyKey,
    sourceTurnId: row.sourceTurnId,
    expectedInterviewVersion: row.expectedInterviewVersion,
    status: row.status,
    attemptCount: row.attemptCount,
    maximumAttempts: row.maximumAttempts,
    initialDelayMs: row.initialDelayMs,
    availableAt: row.availableAt,
    leaseOwner: row.leaseOwner,
    leaseToken: row.leaseToken,
    leaseExpiresAt: row.leaseExpiresAt,
    appliedStateVersion: row.appliedStateVersion,
    cancellationReason: row.cancellationReason,
    resultDeliveryId: row.resultDeliveryId,
    lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
  };
}

export function sameEnqueueRequest(
  stored: DurableJob,
  interviewId: string,
  request: EnqueueJobInput,
): boolean {
  return (
    stored.interviewId === interviewId &&
    stored.jobId === request.jobId &&
    stored.kind === request.kind &&
    stored.idempotencyKey === request.idempotencyKey &&
    stored.sourceTurnId === request.sourceTurnId &&
    stored.expectedInterviewVersion === request.expectedInterviewVersion &&
    stored.maximumAttempts === request.maximumAttempts &&
    stored.initialDelayMs === request.initialDelayMs &&
    stored.resultDeliveryId === request.resultDeliveryId
  );
}

export function sameFailure(left: StoredFailure | null, right: StoredFailure | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return (
    left.code === right.code &&
    left.message === right.message &&
    left.retryable === right.retryable &&
    sameTimestamp(left.occurredAt, right.occurredAt)
  );
}

export function sameTimestamp(left: string, right: string): boolean {
  return Date.parse(left) === Date.parse(right);
}
