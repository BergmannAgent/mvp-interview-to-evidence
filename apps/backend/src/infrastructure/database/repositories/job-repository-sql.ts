export const JOB_COLUMNS = `
  job.interview_id AS "interviewId",
  job.id AS "jobId",
  job.type AS "kind",
  job.idempotency_key AS "idempotencyKey",
  job.source_turn_id AS "sourceTurnId",
  job.expected_state_version AS "expectedInterviewVersion",
  job.status,
  job.attempt_count AS "attemptCount",
  job.maximum_attempts AS "maximumAttempts",
  job.initial_delay_ms AS "initialDelayMs",
  job.available_at AS "availableAt",
  job.lease_owner AS "leaseOwner",
  job.lease_token AS "leaseToken",
  job.lease_expires_at AS "leaseExpiresAt",
  job.applied_state_version AS "appliedStateVersion",
  job.cancellation_reason AS "cancellationReason",
  job.result_delivery_id AS "resultDeliveryId",
  job.last_error_code AS "lastErrorCode",
  job.last_error_message AS "lastErrorMessage",
  job.last_error_retryable AS "lastErrorRetryable",
  job.last_error_occurred_at AS "lastErrorOccurredAt",
  job.created_at AS "createdAt",
  job.updated_at AS "updatedAt",
  job.completed_at AS "completedAt"`;

export const LOAD_JOB_SQL = `
SELECT ${JOB_COLUMNS}
FROM app.durable_jobs AS job
WHERE job.interview_id = $1 AND job.id = $2
LIMIT 1`;

export const LOAD_IDEMPOTENT_JOB_SQL = `
SELECT ${JOB_COLUMNS}
FROM app.durable_jobs AS job
WHERE job.interview_id = $1 AND job.idempotency_key = $2
LIMIT 1`;

export const LOCK_PARTICIPANT_SOURCE_TURN_SQL = `
SELECT turn.turn_id AS "turnId"
FROM app.transcript_turns AS turn
JOIN app.transcript_final_segments AS final_segment
  ON final_segment.interview_id = turn.interview_id
 AND final_segment.turn_id = turn.turn_id
WHERE turn.interview_id = $1
  AND turn.turn_id = $2
  AND turn.speaker = 'participant'
  AND turn.turn_type = 'participant_answer'
FOR KEY SHARE OF turn, final_segment`;

export const ENQUEUE_JOB_SQL = `
WITH timing AS (
  SELECT clock_timestamp() AS enqueued_at
)
INSERT INTO app.durable_jobs AS job (
  id,
  interview_id,
  type,
  idempotency_key,
  source_turn_id,
  expected_state_version,
  status,
  attempt_count,
  maximum_attempts,
  initial_delay_ms,
  available_at,
  result_delivery_id,
  created_at,
  updated_at
)
SELECT $1, $2, $3, $4, $5, $6, 'queued', 0, $7, $8::integer,
       timing.enqueued_at + ($8::bigint * interval '1 millisecond'),
       $9, timing.enqueued_at, timing.enqueued_at
FROM timing
ON CONFLICT (interview_id, idempotency_key) DO NOTHING
RETURNING ${JOB_COLUMNS}`;

export const CLAIM_NEXT_JOB_SQL = `
WITH timing AS (
  SELECT clock_timestamp() AS claimed_at
), candidate AS (
  SELECT queued.interview_id, queued.id
  FROM app.durable_jobs AS queued
  CROSS JOIN timing
  WHERE queued.status = 'queued'
    AND queued.available_at <= timing.claimed_at
    AND queued.attempt_count < queued.maximum_attempts
  ORDER BY queued.available_at, queued.created_at, queued.interview_id, queued.id
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
UPDATE app.durable_jobs AS job
SET status = 'running',
    attempt_count = job.attempt_count + 1,
    lease_owner = $1,
    lease_token = $3,
    lease_expires_at = timing.claimed_at + ($2::bigint * interval '1 millisecond'),
    updated_at = timing.claimed_at
FROM candidate, timing
WHERE job.interview_id = candidate.interview_id AND job.id = candidate.id
RETURNING ${JOB_COLUMNS}`;

export const CLAIM_JOB_SQL = `
WITH timing AS (
  SELECT clock_timestamp() AS claimed_at
), candidate AS (
  SELECT queued.interview_id, queued.id
  FROM app.durable_jobs AS queued
  CROSS JOIN timing
  WHERE queued.interview_id = $1
    AND queued.id = $2
    AND queued.status = 'queued'
    AND queued.available_at <= timing.claimed_at
    AND queued.attempt_count < queued.maximum_attempts
  FOR UPDATE SKIP LOCKED
)
UPDATE app.durable_jobs AS job
SET status = 'running',
    attempt_count = job.attempt_count + 1,
    lease_owner = $3,
    lease_token = $5,
    lease_expires_at = timing.claimed_at + ($4::bigint * interval '1 millisecond'),
    updated_at = timing.claimed_at
FROM candidate, timing
WHERE job.interview_id = candidate.interview_id AND job.id = candidate.id
RETURNING ${JOB_COLUMNS}`;

export const RENEW_LEASE_SQL = `
WITH candidate AS MATERIALIZED (
  SELECT owned.interview_id, owned.id
  FROM app.durable_jobs AS owned
  WHERE owned.interview_id = $1
    AND owned.id = $2
    AND owned.status = 'running'
    AND owned.lease_token = $3
  FOR UPDATE OF owned
), timing AS MATERIALIZED (
  SELECT clock_timestamp() AS renewed_at FROM candidate
)
UPDATE app.durable_jobs AS job
SET lease_expires_at = GREATEST(
      job.lease_expires_at,
      timing.renewed_at + ($4::bigint * interval '1 millisecond')
    ),
    updated_at = CASE
      WHEN timing.renewed_at + ($4::bigint * interval '1 millisecond') > job.lease_expires_at
        THEN timing.renewed_at
      ELSE job.updated_at
    END
FROM candidate, timing
WHERE job.interview_id = candidate.interview_id
  AND job.id = candidate.id
  AND job.lease_expires_at > timing.renewed_at
RETURNING ${JOB_COLUMNS}`;

export const REQUIRE_OWNED_LEASE_SQL = `
WITH candidate AS MATERIALIZED (
  SELECT owned.interview_id, owned.id
  FROM app.durable_jobs AS owned
  WHERE owned.interview_id = $1
    AND owned.id = $2
    AND owned.status = 'running'
    AND owned.lease_token = $3
  FOR UPDATE OF owned
), timing AS MATERIALIZED (
  SELECT clock_timestamp() AS checked_at FROM candidate
)
SELECT ${JOB_COLUMNS}
FROM app.durable_jobs AS job
JOIN candidate
  ON candidate.interview_id = job.interview_id AND candidate.id = job.id
CROSS JOIN timing
WHERE job.lease_expires_at > timing.checked_at
LIMIT 1`;

export const REQUEUE_JOB_SQL = `
WITH candidate AS MATERIALIZED (
  SELECT owned.interview_id, owned.id
  FROM app.durable_jobs AS owned
  WHERE owned.interview_id = $1
    AND owned.id = $2
    AND owned.status = 'running'
    AND owned.lease_token = $3
  FOR UPDATE OF owned
), timing AS MATERIALIZED (
  SELECT clock_timestamp() AS requeued_at FROM candidate
)
UPDATE app.durable_jobs AS job
SET status = 'queued',
    available_at = timing.requeued_at + ($8::bigint * interval '1 millisecond'),
    lease_owner = NULL,
    lease_expires_at = NULL,
    last_error_code = $4,
    last_error_message = $5,
    last_error_retryable = $6,
    last_error_occurred_at = $7::timestamptz,
    updated_at = timing.requeued_at
FROM candidate, timing
WHERE job.interview_id = candidate.interview_id
  AND job.id = candidate.id
  AND job.lease_expires_at > timing.requeued_at
  AND job.attempt_count < job.maximum_attempts
RETURNING ${JOB_COLUMNS}`;

export const COMPLETE_JOB_SQL = `
WITH candidate AS MATERIALIZED (
  SELECT owned.interview_id, owned.id
  FROM app.durable_jobs AS owned
  WHERE owned.interview_id = $1
    AND owned.id = $2
    AND owned.status = 'running'
    AND owned.lease_token = $3
  FOR UPDATE OF owned
), timing AS MATERIALIZED (
  SELECT clock_timestamp() AS completed_at FROM candidate
)
UPDATE app.durable_jobs AS job
SET status = 'succeeded',
    lease_owner = NULL,
    lease_expires_at = NULL,
    applied_state_version = $4,
    updated_at = timing.completed_at,
    completed_at = timing.completed_at
FROM candidate, timing
WHERE job.interview_id = candidate.interview_id
  AND job.id = candidate.id
  AND job.lease_expires_at > timing.completed_at
RETURNING ${JOB_COLUMNS}`;

export const FAIL_JOB_SQL = `
WITH candidate AS MATERIALIZED (
  SELECT owned.interview_id, owned.id
  FROM app.durable_jobs AS owned
  WHERE owned.interview_id = $1
    AND owned.id = $2
    AND owned.status = 'running'
    AND owned.lease_token = $3
  FOR UPDATE OF owned
), timing AS MATERIALIZED (
  SELECT clock_timestamp() AS failed_at FROM candidate
)
UPDATE app.durable_jobs AS job
SET status = 'failed',
    lease_owner = NULL,
    lease_expires_at = NULL,
    last_error_code = $4,
    last_error_message = $5,
    last_error_retryable = $6,
    last_error_occurred_at = $7::timestamptz,
    updated_at = timing.failed_at,
    completed_at = timing.failed_at
FROM candidate, timing
WHERE job.interview_id = candidate.interview_id
  AND job.id = candidate.id
  AND job.lease_expires_at > timing.failed_at
RETURNING ${JOB_COLUMNS}`;

export const CANCEL_JOB_SQL = `
UPDATE app.durable_jobs AS job
SET status = 'cancelled',
    lease_owner = NULL,
    lease_expires_at = NULL,
    cancellation_reason = $3,
    updated_at = clock_timestamp(),
    completed_at = clock_timestamp()
WHERE job.interview_id = $1
  AND job.id = $2
  AND job.status IN ('queued', 'running')
RETURNING ${JOB_COLUMNS}`;

export const RECLAIM_EXPIRED_SQL = `
WITH timing AS (
  SELECT clock_timestamp() AS effective_now
)
UPDATE app.durable_jobs AS job
SET status = CASE
      WHEN job.attempt_count >= job.maximum_attempts THEN 'failed'
      ELSE 'queued'
    END,
    available_at = timing.effective_now,
    lease_owner = NULL,
    lease_expires_at = NULL,
    last_error_code = CASE
      WHEN job.attempt_count >= job.maximum_attempts
        THEN 'lease_expired_attempts_exhausted'
      ELSE 'lease_expired'
    END,
    last_error_message = CASE
      WHEN job.attempt_count >= job.maximum_attempts
        THEN 'The worker lease expired after the final permitted attempt.'
      ELSE 'The worker lease expired before the job completed.'
    END,
    last_error_retryable = job.attempt_count < job.maximum_attempts,
    last_error_occurred_at = timing.effective_now,
    updated_at = timing.effective_now,
    completed_at = CASE
      WHEN job.attempt_count >= job.maximum_attempts THEN timing.effective_now
      ELSE NULL
    END
FROM timing
WHERE job.status = 'running'
  AND job.lease_expires_at <= timing.effective_now`;
