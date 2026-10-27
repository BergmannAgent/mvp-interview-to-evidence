import { randomUUID } from 'node:crypto';

import {
  failure,
  success,
  type DurableJob,
  type EnqueueJobInput,
  type IdempotentWrite,
  type JobRepository,
  type RepositoryError,
  type RepositoryResult,
  type StoredFailure,
} from '../../../application/persistence/index.js';
import { corruptData, mapDatabaseError } from './repository-errors.js';
import { parseJob, sameEnqueueRequest, sameFailure } from './job-repository-row.js';
import { sourceTurnIdentityRowSchema } from './job-repository-row.js';
import {
  CANCEL_JOB_SQL,
  CLAIM_JOB_SQL,
  CLAIM_NEXT_JOB_SQL,
  COMPLETE_JOB_SQL,
  ENQUEUE_JOB_SQL,
  FAIL_JOB_SQL,
  LOAD_IDEMPOTENT_JOB_SQL,
  LOAD_JOB_SQL,
  LOCK_PARTICIPANT_SOURCE_TURN_SQL,
  RECLAIM_EXPIRED_SQL,
  RENEW_LEASE_SQL,
  REQUIRE_OWNED_LEASE_SQL,
  REQUEUE_JOB_SQL,
} from './job-repository-sql.js';
import {
  isNonBlank,
  isStoredFailure,
  JOB_TIMING_LIMITS_MS,
  readDatabaseProperty,
  validateEnqueueInput,
  validJobIdentity,
  validOwnedIdentity,
} from './job-repository-validation.js';
import type { SqlExecutor } from './sql.js';

export type LeaseTokenFactory = () => string;

export class PostgreSqlJobRepository implements JobRepository {
  readonly #executor: SqlExecutor;
  readonly #leaseTokenFactory: LeaseTokenFactory;

  public constructor(executor: SqlExecutor, leaseTokenFactory: LeaseTokenFactory = randomUUID) {
    this.#executor = executor;
    this.#leaseTokenFactory = leaseTokenFactory;
  }

  public async load(interviewId: string, jobId: string): Promise<RepositoryResult<DurableJob>> {
    if (!isNonBlank(interviewId) || !isNonBlank(jobId)) {
      return invalidInput('durable_jobs_identity_not_blank');
    }
    try {
      const result = await this.#executor.query(LOAD_JOB_SQL, [interviewId, jobId]);
      if (result.rows.length === 0) {
        return failure({ code: 'not_found', resource: 'job', id: jobId });
      }
      return parseJob(result.rows[0], jobId);
    } catch (error: unknown) {
      return databaseFailure(error, `${interviewId}:${jobId}`);
    }
  }

  public async enqueue(
    interviewId: string,
    job: EnqueueJobInput,
  ): Promise<RepositoryResult<IdempotentWrite<DurableJob>>> {
    const inputError = validateEnqueueInput(interviewId, job);
    if (inputError !== null) {
      return failure(inputError);
    }
    const sourceValidation = await this.#validateSourceTurn(interviewId, job);
    if (!sourceValidation.ok) {
      return sourceValidation;
    }

    try {
      const inserted = await this.#executor.query(ENQUEUE_JOB_SQL, [
        job.jobId,
        interviewId,
        job.kind,
        job.idempotencyKey,
        job.sourceTurnId,
        job.expectedInterviewVersion,
        job.maximumAttempts,
        job.initialDelayMs,
        job.resultDeliveryId,
      ]);
      if (inserted.rows.length > 0) {
        const parsed = parseJob(inserted.rows[0], job.jobId);
        return parsed.ok
          ? success({ outcome: 'inserted', value: parsed.value })
          : failure(parsed.error);
      }

      const existingResult = await this.#executor.query(LOAD_IDEMPOTENT_JOB_SQL, [
        interviewId,
        job.idempotencyKey,
      ]);
      if (existingResult.rows.length === 0) {
        return duplicateConflict(`${interviewId}:${job.idempotencyKey}`);
      }
      const parsed = parseJob(existingResult.rows[0], job.jobId);
      if (!parsed.ok) {
        return failure(parsed.error);
      }
      return sameEnqueueRequest(parsed.value, interviewId, job)
        ? success({ outcome: 'existing', value: parsed.value })
        : duplicateConflict(`${interviewId}:${job.idempotencyKey}`);
    } catch (error: unknown) {
      if (readDatabaseProperty(error, 'constraint') === 'durable_jobs_one_active_per_interview') {
        return failure({ code: 'active_job_exists', interviewId, jobId: job.jobId });
      }
      return databaseFailure(error, `${interviewId}:${job.jobId}`);
    }
  }

  public async claimNext(input: {
    readonly workerId: string;
    readonly leaseDurationMs: number;
  }): Promise<RepositoryResult<DurableJob | null>> {
    if (
      !isNonBlank(input.workerId) ||
      !isBoundedDuration(
        input.leaseDurationMs,
        JOB_TIMING_LIMITS_MS.minimumLease,
        JOB_TIMING_LIMITS_MS.maximumLease,
      )
    ) {
      return invalidInput('durable_jobs_claim_input_valid');
    }
    const leaseToken = this.#leaseTokenFactory();
    if (!isNonBlank(leaseToken)) {
      return invalidInput('durable_jobs_lease_token_not_blank');
    }

    try {
      const result = await this.#executor.query(CLAIM_NEXT_JOB_SQL, [
        input.workerId,
        input.leaseDurationMs,
        leaseToken,
      ]);
      return result.rows.length === 0 ? success(null) : parseJob(result.rows[0], 'claimed-job');
    } catch (error: unknown) {
      return databaseFailure(error, 'claim-next');
    }
  }

  public async claim(
    interviewId: string,
    jobId: string,
    input: {
      readonly workerId: string;
      readonly leaseDurationMs: number;
    },
  ): Promise<RepositoryResult<DurableJob | null>> {
    if (
      !validJobIdentity(interviewId, jobId) ||
      !isNonBlank(input.workerId) ||
      !isBoundedDuration(
        input.leaseDurationMs,
        JOB_TIMING_LIMITS_MS.minimumLease,
        JOB_TIMING_LIMITS_MS.maximumLease,
      )
    ) {
      return invalidInput('durable_jobs_claim_input_valid');
    }
    const leaseToken = this.#leaseTokenFactory();
    if (!isNonBlank(leaseToken)) {
      return invalidInput('durable_jobs_lease_token_not_blank');
    }

    try {
      const result = await this.#executor.query(CLAIM_JOB_SQL, [
        interviewId,
        jobId,
        input.workerId,
        input.leaseDurationMs,
        leaseToken,
      ]);
      return result.rows.length === 0 ? success(null) : parseJob(result.rows[0], jobId);
    } catch (error: unknown) {
      return databaseFailure(error, `${interviewId}:${jobId}`);
    }
  }

  public async renewLease(
    interviewId: string,
    jobId: string,
    leaseToken: string,
    leaseDurationMs: number,
  ): Promise<RepositoryResult<DurableJob>> {
    if (
      !validOwnedIdentity(interviewId, jobId, leaseToken) ||
      !isBoundedDuration(
        leaseDurationMs,
        JOB_TIMING_LIMITS_MS.minimumLease,
        JOB_TIMING_LIMITS_MS.maximumLease,
      )
    ) {
      return invalidInput('durable_jobs_renew_input_valid');
    }
    try {
      const result = await this.#executor.query(RENEW_LEASE_SQL, [
        interviewId,
        jobId,
        leaseToken,
        leaseDurationMs,
      ]);
      return result.rows.length > 0
        ? parseJob(result.rows[0], jobId)
        : await this.#leaseFailure(interviewId, jobId, leaseToken);
    } catch (error: unknown) {
      return databaseFailure(error, `${interviewId}:${jobId}`);
    }
  }

  public async requireOwnedLease(
    interviewId: string,
    jobId: string,
    leaseToken: string,
  ): Promise<RepositoryResult<DurableJob>> {
    if (!validOwnedIdentity(interviewId, jobId, leaseToken)) {
      return invalidInput('durable_jobs_owned_lease_input_valid');
    }
    try {
      const result = await this.#executor.query(REQUIRE_OWNED_LEASE_SQL, [
        interviewId,
        jobId,
        leaseToken,
      ]);
      return result.rows.length > 0
        ? parseJob(result.rows[0], jobId)
        : await this.#leaseFailure(interviewId, jobId, leaseToken);
    } catch (error: unknown) {
      return databaseFailure(error, `${interviewId}:${jobId}`);
    }
  }

  public async requeue(
    interviewId: string,
    jobId: string,
    leaseToken: string,
    jobFailure: StoredFailure,
    retryDelayMs: number,
  ): Promise<RepositoryResult<DurableJob>> {
    if (
      !validOwnedIdentity(interviewId, jobId, leaseToken) ||
      !isStoredFailure(jobFailure) ||
      !isBoundedDuration(retryDelayMs, 0, JOB_TIMING_LIMITS_MS.maximumDelay)
    ) {
      return invalidInput('durable_jobs_requeue_input_valid');
    }
    try {
      const result = await this.#executor.query(REQUEUE_JOB_SQL, [
        interviewId,
        jobId,
        leaseToken,
        jobFailure.code,
        jobFailure.message,
        jobFailure.retryable,
        jobFailure.occurredAt,
        retryDelayMs,
      ]);
      if (result.rows.length > 0) {
        return parseJob(result.rows[0], jobId);
      }
      const existing = await this.load(interviewId, jobId);
      if (!existing.ok) {
        return existing;
      }
      if (
        existing.value.status === 'queued' &&
        existing.value.leaseToken === leaseToken &&
        sameFailure(existing.value.lastError, jobFailure) &&
        Date.parse(existing.value.availableAt) - Date.parse(existing.value.updatedAt) ===
          retryDelayMs
      ) {
        return existing;
      }
      if (
        existing.value.status === 'running' &&
        existing.value.leaseToken === leaseToken &&
        existing.value.attemptCount >= existing.value.maximumAttempts
      ) {
        return invalidInput('durable_jobs_attempts_exhausted');
      }
      return ownedConflict(existing.value, interviewId, jobId, leaseToken, 'requeue');
    } catch (error: unknown) {
      return databaseFailure(error, `${interviewId}:${jobId}`);
    }
  }

  public async complete(
    interviewId: string,
    jobId: string,
    leaseToken: string,
    appliedStateVersion: number,
  ): Promise<RepositoryResult<IdempotentWrite<DurableJob>>> {
    if (
      !validOwnedIdentity(interviewId, jobId, leaseToken) ||
      !Number.isInteger(appliedStateVersion) ||
      appliedStateVersion < 0
    ) {
      return invalidInput('durable_jobs_complete_input_valid');
    }
    try {
      const result = await this.#executor.query(COMPLETE_JOB_SQL, [
        interviewId,
        jobId,
        leaseToken,
        appliedStateVersion,
      ]);
      if (result.rows.length > 0) {
        const parsed = parseJob(result.rows[0], jobId);
        return parsed.ok
          ? success({ outcome: 'inserted', value: parsed.value })
          : failure(parsed.error);
      }
      const existing = await this.load(interviewId, jobId);
      if (!existing.ok) {
        return existing;
      }
      if (
        existing.value.status === 'succeeded' &&
        existing.value.leaseToken === leaseToken &&
        existing.value.appliedStateVersion === appliedStateVersion
      ) {
        return success({ outcome: 'existing', value: existing.value });
      }
      return ownedConflict(existing.value, interviewId, jobId, leaseToken, 'complete');
    } catch (error: unknown) {
      return databaseFailure(error, `${interviewId}:${jobId}`);
    }
  }

  public async fail(
    interviewId: string,
    jobId: string,
    leaseToken: string,
    jobFailure: StoredFailure,
  ): Promise<RepositoryResult<DurableJob>> {
    if (!validOwnedIdentity(interviewId, jobId, leaseToken) || !isStoredFailure(jobFailure)) {
      return invalidInput('durable_jobs_fail_input_valid');
    }
    try {
      const result = await this.#executor.query(FAIL_JOB_SQL, [
        interviewId,
        jobId,
        leaseToken,
        jobFailure.code,
        jobFailure.message,
        jobFailure.retryable,
        jobFailure.occurredAt,
      ]);
      if (result.rows.length > 0) {
        return parseJob(result.rows[0], jobId);
      }
      const existing = await this.load(interviewId, jobId);
      if (!existing.ok) {
        return existing;
      }
      if (
        existing.value.status === 'failed' &&
        existing.value.leaseToken === leaseToken &&
        sameFailure(existing.value.lastError, jobFailure)
      ) {
        return existing;
      }
      return ownedConflict(existing.value, interviewId, jobId, leaseToken, 'fail');
    } catch (error: unknown) {
      return databaseFailure(error, `${interviewId}:${jobId}`);
    }
  }

  public async cancel(
    interviewId: string,
    jobId: string,
    reason: string,
  ): Promise<RepositoryResult<IdempotentWrite<DurableJob>>> {
    if (!isNonBlank(interviewId) || !isNonBlank(jobId) || !isNonBlank(reason)) {
      return invalidInput('durable_jobs_cancel_input_valid');
    }
    try {
      const result = await this.#executor.query(CANCEL_JOB_SQL, [interviewId, jobId, reason]);
      if (result.rows.length > 0) {
        const parsed = parseJob(result.rows[0], jobId);
        return parsed.ok
          ? success({ outcome: 'inserted', value: parsed.value })
          : failure(parsed.error);
      }
      const existing = await this.load(interviewId, jobId);
      if (!existing.ok) {
        return existing;
      }
      return existing.value.status === 'cancelled' && existing.value.cancellationReason === reason
        ? success({ outcome: 'existing', value: existing.value })
        : duplicateConflict(`${interviewId}:${jobId}:cancel`);
    } catch (error: unknown) {
      return databaseFailure(error, `${interviewId}:${jobId}`);
    }
  }

  public async reclaimExpired(): Promise<RepositoryResult<number>> {
    try {
      const result = await this.#executor.query(RECLAIM_EXPIRED_SQL);
      return success(result.rowCount);
    } catch (error: unknown) {
      return databaseFailure(error, 'reclaim-expired');
    }
  }

  async #validateSourceTurn(
    interviewId: string,
    job: EnqueueJobInput,
  ): Promise<RepositoryResult<void>> {
    if (job.kind !== 'participant_turn') {
      return success(undefined);
    }
    if (job.sourceTurnId === null) {
      return invalidInput('durable_jobs_enqueue_shape');
    }
    try {
      const result = await this.#executor.query(LOCK_PARTICIPANT_SOURCE_TURN_SQL, [
        interviewId,
        job.sourceTurnId,
      ]);
      if (result.rowCount === 0) {
        return invalidInput('durable_jobs_participant_source_turn');
      }
      const parsed = sourceTurnIdentityRowSchema.array().safeParse(result.rows);
      if (
        !parsed.success ||
        parsed.data.length !== 1 ||
        result.rowCount !== 1 ||
        parsed.data[0]?.turnId !== job.sourceTurnId
      ) {
        return failure(corruptData('job', job.jobId, 'Participant source-turn lookup is invalid'));
      }
      return success(undefined);
    } catch (error: unknown) {
      return databaseFailure(error, `${interviewId}:${job.jobId}:source-turn`);
    }
  }

  async #leaseFailure(
    interviewId: string,
    jobId: string,
    leaseToken: string,
  ): Promise<RepositoryResult<DurableJob>> {
    const existing = await this.load(interviewId, jobId);
    return existing.ok ? failure({ code: 'lease_lost', interviewId, jobId, leaseToken }) : existing;
  }
}

function ownedConflict(
  job: DurableJob,
  interviewId: string,
  jobId: string,
  leaseToken: string,
  operation: string,
): { readonly ok: false; readonly error: RepositoryError } {
  return job.leaseToken !== leaseToken || job.status === 'running'
    ? { ok: false, error: { code: 'lease_lost', interviewId, jobId, leaseToken } }
    : {
        ok: false,
        error: {
          code: 'duplicate_conflict',
          resource: 'job',
          identity: `${interviewId}:${jobId}:${operation}`,
        },
      };
}

function invalidInput<T>(constraint: string): RepositoryResult<T> {
  return failure({ code: 'constraint_violation', constraint });
}

function duplicateConflict<T>(identity: string): RepositoryResult<T> {
  return failure({ code: 'duplicate_conflict', resource: 'job', identity });
}

function databaseFailure<T>(error: unknown, identity: string): RepositoryResult<T> {
  return failure(mapDatabaseError(error, { resource: 'job', identity }));
}

function isBoundedDuration(value: number, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
