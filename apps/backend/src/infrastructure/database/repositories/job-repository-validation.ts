import { idSchema, timestampSchema } from '@orgscience/contracts';

import {
  type EnqueueJobInput,
  type RepositoryError,
  type StoredFailure,
} from '../../../application/persistence/index.js';

export const JOB_TIMING_LIMITS_MS = Object.freeze({
  minimumLease: 1_000,
  maximumLease: 15 * 60_000,
  maximumDelay: 15 * 60_000,
});

export function validateEnqueueInput(
  interviewId: string,
  job: EnqueueJobInput,
): RepositoryError | null {
  if (
    !isInternalId(interviewId) ||
    !isInternalId(job.jobId) ||
    !isNonBlank(job.idempotencyKey) ||
    (job.sourceTurnId !== null && !isInternalId(job.sourceTurnId)) ||
    (job.kind === 'participant_turn') !== (job.sourceTurnId !== null) ||
    !Number.isInteger(job.maximumAttempts) ||
    job.maximumAttempts <= 0 ||
    !Number.isInteger(job.expectedInterviewVersion) ||
    job.expectedInterviewVersion < 0 ||
    !Number.isSafeInteger(job.initialDelayMs) ||
    job.initialDelayMs < 0 ||
    job.initialDelayMs > JOB_TIMING_LIMITS_MS.maximumDelay ||
    (job.resultDeliveryId !== null && !isInternalId(job.resultDeliveryId))
  ) {
    return { code: 'constraint_violation', constraint: 'durable_jobs_enqueue_shape' };
  }
  return null;
}

export function isStoredFailure(value: unknown): value is StoredFailure {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    isNonBlank(candidate.code) &&
    isNonBlank(candidate.message) &&
    typeof candidate.retryable === 'boolean' &&
    isTimestamp(candidate.occurredAt)
  );
}

export function validOwnedIdentity(
  interviewId: string,
  jobId: string,
  leaseToken: string,
): boolean {
  return validJobIdentity(interviewId, jobId) && isNonBlank(leaseToken);
}

export function validJobIdentity(interviewId: string, jobId: string): boolean {
  return isInternalId(interviewId) && isInternalId(jobId);
}

function isInternalId(value: string): boolean {
  return idSchema.safeParse(value).success;
}

export function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isTimestamp(value: unknown): value is string {
  return timestampSchema.safeParse(value).success;
}

export function readDatabaseProperty(value: unknown, property: string): string | undefined {
  if (typeof value !== 'object' || value === null || !(property in value)) {
    return undefined;
  }
  const candidate = (value as Record<string, unknown>)[property];
  return typeof candidate === 'string' ? candidate : undefined;
}
