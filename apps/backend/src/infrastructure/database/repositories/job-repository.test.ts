import { describe, expect, it } from 'vitest';

import type {
  DurableJob,
  EnqueueJobInput,
  StoredFailure,
} from '../../../application/persistence/index.js';
import { PostgreSqlJobRepository } from './job-repository.js';
import { isStoredFailure } from './job-repository-validation.js';
import type { SqlExecutor, SqlQueryResult } from './sql.js';

const T0 = '2026-08-06T10:00:00.000Z';
const T1 = '2026-08-06T10:01:00.000Z';
const T2 = '2026-08-06T10:02:00.000Z';
const T3 = '2026-08-06T10:03:00.000Z';

interface ScriptStep {
  readonly result?: SqlQueryResult;
  readonly error?: unknown;
}

interface RecordedQuery {
  readonly statement: string;
  readonly parameters: readonly unknown[];
}

class ScriptedExecutor implements SqlExecutor {
  public readonly queries: RecordedQuery[] = [];
  readonly #steps: ScriptStep[];

  public constructor(steps: readonly ScriptStep[]) {
    this.#steps = [...steps];
  }

  public async query(
    statement: string,
    parameters: readonly unknown[] = [],
  ): Promise<SqlQueryResult> {
    this.queries.push({ statement, parameters });
    const step = this.#steps.shift();
    if (step === undefined) {
      throw new Error('Unexpected SQL query');
    }
    if (step.error !== undefined) {
      throw step.error;
    }
    if (step.result === undefined) {
      throw new Error('Script step has no result');
    }
    return step.result;
  }
}

describe('PostgreSqlJobRepository enqueue and loading', () => {
  it('inserts a valid initial job with parameterized SQL', async () => {
    const request = enqueueJobInput();
    const stored = queuedJob();
    const executor = new ScriptedExecutor([sourceTurnRows(), rows(queuedRow())]);
    const repository = new PostgreSqlJobRepository(executor);

    const result = await repository.enqueue(stored.interviewId, request);

    expect(result).toEqual({ ok: true, value: { outcome: 'inserted', value: stored } });
    expect(executor.queries[0]?.statement).toContain('FOR KEY SHARE OF turn');
    expect(executor.queries[0]?.parameters).toEqual([stored.interviewId, request.sourceTurnId]);
    expect(executor.queries[1]?.statement).toContain('ON CONFLICT (interview_id, idempotency_key)');
    expect(executor.queries[1]?.statement).toContain('clock_timestamp() AS enqueued_at');
    expect(executor.queries[1]?.statement).toContain(
      "timing.enqueued_at + ($8::bigint * interval '1 millisecond')",
    );
    expect(executor.queries[1]?.statement).not.toContain(request.idempotencyKey);
    expect(executor.queries[1]?.parameters).toEqual([
      request.jobId,
      stored.interviewId,
      request.kind,
      request.idempotencyKey,
      request.sourceTurnId,
      request.expectedInterviewVersion,
      request.maximumAttempts,
      request.initialDelayMs,
      request.resultDeliveryId,
    ]);
  });

  it('returns an exact idempotent enqueue and rejects a conflicting duplicate', async () => {
    const request = enqueueJobInput();
    const stored = queuedJob();
    const exactExecutor = new ScriptedExecutor([sourceTurnRows(), emptyRows(), rows(queuedRow())]);
    const exact = await new PostgreSqlJobRepository(exactExecutor).enqueue(
      stored.interviewId,
      request,
    );
    expect(exact).toEqual({ ok: true, value: { outcome: 'existing', value: stored } });

    const conflictExecutor = new ScriptedExecutor([
      sourceTurnRows(),
      emptyRows(),
      rows(queuedRow({ jobId: 'different-job' })),
    ]);
    const conflict = await new PostgreSqlJobRepository(conflictExecutor).enqueue(
      stored.interviewId,
      request,
    );
    expect(conflict).toMatchObject({
      ok: false,
      error: { code: 'duplicate_conflict', resource: 'job' },
    });
  });

  it('uses immutable initial delay metadata for retries after rescheduling', async () => {
    const rescheduled = requeuedRow(storedFailure(), 30_000);
    const exactExecutor = new ScriptedExecutor([sourceTurnRows(), emptyRows(), rows(rescheduled)]);
    const exact = await new PostgreSqlJobRepository(exactExecutor).enqueue(
      'interview-1',
      enqueueJobInput({ initialDelayMs: 0 }),
    );
    expect(exact).toMatchObject({
      ok: true,
      value: { outcome: 'existing', value: { status: 'queued', initialDelayMs: 0 } },
    });

    const conflictExecutor = new ScriptedExecutor([
      sourceTurnRows(),
      emptyRows(),
      rows(rescheduled),
    ]);
    await expect(
      new PostgreSqlJobRepository(conflictExecutor).enqueue(
        'interview-1',
        enqueueJobInput({ initialDelayMs: 1_000 }),
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: 'duplicate_conflict' } });
  });

  it('maps the partial active-job unique index and other database errors', async () => {
    const request = enqueueJobInput();
    const stored = queuedJob();
    const activeExecutor = new ScriptedExecutor([
      sourceTurnRows(),
      {
        error: {
          code: '23505',
          constraint: 'durable_jobs_one_active_per_interview',
        },
      },
    ]);
    const active = await new PostgreSqlJobRepository(activeExecutor).enqueue(
      stored.interviewId,
      request,
    );
    expect(active).toEqual({
      ok: false,
      error: {
        code: 'active_job_exists',
        interviewId: stored.interviewId,
        jobId: request.jobId,
      },
    });

    const unavailableExecutor = new ScriptedExecutor([{ error: { code: '08006' } }]);
    const unavailable = await new PostgreSqlJobRepository(unavailableExecutor).load(
      stored.interviewId,
      request.jobId,
    );
    expect(unavailable).toEqual({ ok: false, error: { code: 'unavailable', retryable: true } });
  });

  it('requires a scoped participant source turn before enqueueing work', async () => {
    const missingExecutor = new ScriptedExecutor([emptyRows()]);
    const missing = await new PostgreSqlJobRepository(missingExecutor).enqueue(
      'interview-1',
      enqueueJobInput({ sourceTurnId: 'missing-turn' }),
    );
    expect(missing).toEqual({
      ok: false,
      error: {
        code: 'constraint_violation',
        constraint: 'durable_jobs_participant_source_turn',
      },
    });

    const aiTurnExecutor = new ScriptedExecutor([emptyRows()]);
    const aiTurn = await new PostgreSqlJobRepository(aiTurnExecutor).enqueue(
      'interview-1',
      enqueueJobInput({ sourceTurnId: 'ai-turn' }),
    );
    expect(aiTurn).toEqual(missing);

    const crossInterviewExecutor = new ScriptedExecutor([emptyRows()]);
    const crossInterview = await new PostgreSqlJobRepository(crossInterviewExecutor).enqueue(
      'interview-1',
      enqueueJobInput({ sourceTurnId: 'participant-turn-from-interview-2' }),
    );
    expect(crossInterview).toEqual(missing);

    for (const executor of [missingExecutor, aiTurnExecutor, crossInterviewExecutor]) {
      expect(executor.queries).toHaveLength(1);
      expect(executor.queries[0]?.statement).toContain('turn.interview_id = $1');
      expect(executor.queries[0]?.statement).toContain("turn.speaker = 'participant'");
      expect(executor.queries[0]?.statement).toContain("turn.turn_type = 'participant_answer'");
      expect(executor.queries[0]?.statement).toContain(
        'JOIN app.transcript_final_segments AS final_segment',
      );
      expect(executor.queries[0]?.statement).toContain('FOR KEY SHARE OF turn, final_segment');
    }
  });

  it('rejects invalid job-kind and source-turn shapes before querying PostgreSQL', async () => {
    const cases: EnqueueJobInput[] = [
      enqueueJobInput({ sourceTurnId: null }),
      enqueueJobInput({ kind: 'start_interview', sourceTurnId: 'turn-1' }),
      enqueueJobInput({ kind: 'finish_interview', sourceTurnId: 'turn-1' }),
    ];

    for (const job of cases) {
      const executor = new ScriptedExecutor([]);
      await expect(
        new PostgreSqlJobRepository(executor).enqueue('interview-1', job),
      ).resolves.toEqual({
        ok: false,
        error: { code: 'constraint_violation', constraint: 'durable_jobs_enqueue_shape' },
      });
      expect(executor.queries).toHaveLength(0);
    }

    const delayed = enqueueJobInput({ initialDelayMs: 900_001 });
    const executor = new ScriptedExecutor([]);
    await expect(
      new PostgreSqlJobRepository(executor).enqueue('interview-1', delayed),
    ).resolves.toMatchObject({ ok: false, error: { code: 'constraint_violation' } });
    expect(executor.queries).toHaveLength(0);
  });

  it('rejects malformed internal enqueue identities before querying PostgreSQL', async () => {
    const cases: readonly {
      readonly interviewId: string;
      readonly job: EnqueueJobInput;
    }[] = [
      { interviewId: 'interview bad', job: enqueueJobInput() },
      { interviewId: 'interview-1', job: enqueueJobInput({ jobId: 'job bad' }) },
      { interviewId: 'interview-1', job: enqueueJobInput({ sourceTurnId: ' turn-1' }) },
      {
        interviewId: 'interview-1',
        job: enqueueJobInput({ resultDeliveryId: `d${'x'.repeat(128)}` }),
      },
    ];

    for (const input of cases) {
      const executor = new ScriptedExecutor([]);
      await expect(
        new PostgreSqlJobRepository(executor).enqueue(input.interviewId, input.job),
      ).resolves.toEqual({
        ok: false,
        error: { code: 'constraint_violation', constraint: 'durable_jobs_enqueue_shape' },
      });
      expect(executor.queries).toHaveLength(0);
    }
  });

  it('rejects malformed unknown rows as corrupt persisted data', async () => {
    const executor = new ScriptedExecutor([
      rows(queuedRow({ lastErrorCode: 'BROKEN', lastErrorMessage: null })),
    ]);
    const result = await new PostgreSqlJobRepository(executor).load('interview-1', 'job-1');

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'corrupt_data', resource: 'job', id: 'job-1' },
    });
  });

  it('rejects malformed stored job and source-turn identities as corrupt data', async () => {
    for (const row of [
      queuedRow({ interviewId: 'interview bad' }),
      queuedRow({ jobId: ' job-1' }),
      queuedRow({ sourceTurnId: `t${'x'.repeat(128)}` }),
      queuedRow({ resultDeliveryId: 'delivery bad' }),
    ]) {
      const executor = new ScriptedExecutor([rows(row)]);
      await expect(
        new PostgreSqlJobRepository(executor).load('interview-1', 'job-1'),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'corrupt_data', resource: 'job', id: 'job-1' },
      });
    }

    const sourceExecutor = new ScriptedExecutor([sourceTurnRows('turn bad')]);
    await expect(
      new PostgreSqlJobRepository(sourceExecutor).enqueue('interview-1', enqueueJobInput()),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'corrupt_data', resource: 'job', id: 'job-1' },
    });
    expect(sourceExecutor.queries).toHaveLength(1);
  });
});

describe('PostgreSqlJobRepository claiming and leases', () => {
  it('claims one exact interview job without searching for another candidate', async () => {
    const executor = new ScriptedExecutor([
      rows(runningRow({ leaseOwner: 'worker-exact', leaseToken: 'lease-exact' })),
    ]);
    const repository = new PostgreSqlJobRepository(executor, () => 'lease-exact');

    const result = await repository.claim('interview-1', 'job-1', {
      workerId: 'worker-exact',
      leaseDurationMs: 120_000,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        interviewId: 'interview-1',
        jobId: 'job-1',
        leaseOwner: 'worker-exact',
        leaseToken: 'lease-exact',
      },
    });
    expect(executor.queries).toHaveLength(1);
    expect(executor.queries[0]?.statement).toContain('queued.interview_id = $1');
    expect(executor.queries[0]?.statement).toContain('queued.id = $2');
    expect(executor.queries[0]?.statement).toContain('FOR UPDATE SKIP LOCKED');
    expect(executor.queries[0]?.statement).not.toContain('ORDER BY');
    expect(executor.queries[0]?.statement).toContain(
      "timing.claimed_at + ($4::bigint * interval '1 millisecond')",
    );
    expect(executor.queries[0]?.parameters).toEqual([
      'interview-1',
      'job-1',
      'worker-exact',
      120_000,
      'lease-exact',
    ]);
  });

  it('returns null instead of claiming another job when the exact job is unavailable', async () => {
    const executor = new ScriptedExecutor([emptyRows()]);
    const repository = new PostgreSqlJobRepository(executor, () => 'lease-exact');

    await expect(
      repository.claim('interview-1', 'job-1', {
        workerId: 'worker-exact',
        leaseDurationMs: 120_000,
      }),
    ).resolves.toEqual({ ok: true, value: null });
    expect(executor.queries).toHaveLength(1);
  });

  it('rejects invalid exact job identities before querying PostgreSQL', async () => {
    const executor = new ScriptedExecutor([]);
    const repository = new PostgreSqlJobRepository(executor);

    await expect(
      repository.claim('invalid interview', 'job-1', {
        workerId: 'worker-a',
        leaseDurationMs: 120_000,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'constraint_violation' } });
    await expect(
      repository.claim('interview-1', 'invalid job', {
        workerId: 'worker-a',
        leaseDurationMs: 120_000,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'constraint_violation' } });
    expect(executor.queries).toHaveLength(0);
  });

  it('claims two jobs atomically with distinct injected fencing tokens', async () => {
    const executor = new ScriptedExecutor([
      rows(runningRow({ leaseToken: 'lease-1' })),
      rows(
        runningRow({
          interviewId: 'interview-2',
          jobId: 'job-2',
          idempotencyKey: 'participant:interview-2:turn-1',
          leaseToken: 'lease-2',
        }),
      ),
    ]);
    const tokens = ['lease-1', 'lease-2'];
    const repository = new PostgreSqlJobRepository(executor, () => tokens.shift() ?? 'unexpected');

    const first = await repository.claimNext({
      workerId: 'worker-a',
      leaseDurationMs: 120_000,
    });
    const second = await repository.claimNext({
      workerId: 'worker-b',
      leaseDurationMs: 120_000,
    });

    expect(first).toMatchObject({ ok: true, value: { jobId: 'job-1', leaseToken: 'lease-1' } });
    expect(second).toMatchObject({ ok: true, value: { jobId: 'job-2', leaseToken: 'lease-2' } });
    for (const query of executor.queries) {
      expect(query.statement).toContain('FOR UPDATE SKIP LOCKED');
      expect(query.statement).toContain('UPDATE app.durable_jobs AS job');
      expect(query.statement).toContain('queued.available_at <= timing.claimed_at');
      expect(query.statement).toContain(
        "timing.claimed_at + ($2::bigint * interval '1 millisecond')",
      );
    }
    expect(executor.queries.map((query) => query.parameters)).toEqual([
      ['worker-a', 120_000, 'lease-1'],
      ['worker-b', 120_000, 'lease-2'],
    ]);
  });

  it('renews only a live scoped lease and reports a lost token', async () => {
    const renewedExecutor = new ScriptedExecutor([
      rows(runningRow({ leaseExpiresAt: '2026-08-06T10:05:00.000Z', updatedAt: T2 })),
    ]);
    const renewed = await new PostgreSqlJobRepository(renewedExecutor).renewLease(
      'interview-1',
      'job-1',
      'lease-1',
      180_000,
    );
    expect(renewed).toMatchObject({
      ok: true,
      value: { interviewId: 'interview-1', jobId: 'job-1', leaseToken: 'lease-1' },
    });
    expect(renewedExecutor.queries[0]?.statement).toContain(
      'job.lease_expires_at > timing.renewed_at',
    );
    expect(renewedExecutor.queries[0]?.parameters.slice(0, 3)).toEqual([
      'interview-1',
      'job-1',
      'lease-1',
    ]);

    const lostExecutor = new ScriptedExecutor([
      emptyRows(),
      rows(runningRow({ leaseToken: 'other-lease' })),
    ]);
    const lost = await new PostgreSqlJobRepository(lostExecutor).renewLease(
      'interview-1',
      'job-1',
      'lease-1',
      180_000,
    );
    expect(lost).toEqual({
      ok: false,
      error: {
        code: 'lease_lost',
        interviewId: 'interview-1',
        jobId: 'job-1',
        leaseToken: 'lease-1',
      },
    });
  });

  it('keeps lease expiry monotone when a shorter renewal arrives late', async () => {
    const laterExpiry = '2026-08-06T10:06:00.000Z';
    const renewedRow = runningRow({ leaseExpiresAt: laterExpiry, updatedAt: T2 });
    const executor = new ScriptedExecutor([rows(renewedRow), rows(renewedRow)]);
    const repository = new PostgreSqlJobRepository(executor);

    const extended = await repository.renewLease('interview-1', 'job-1', 'lease-1', 300_000);
    const lateRetry = await repository.renewLease('interview-1', 'job-1', 'lease-1', 60_000);

    expect(extended).toMatchObject({ ok: true, value: { leaseExpiresAt: laterExpiry } });
    expect(lateRetry).toEqual(extended);
    for (const query of executor.queries) {
      expect(query.statement).toContain('GREATEST(');
      expect(query.statement).toContain(
        "timing.renewed_at + ($4::bigint * interval '1 millisecond')",
      );
      expect(query.statement.match(/clock_timestamp\(\)/gu)).toHaveLength(1);
      expect(query.statement).toContain('job.lease_expires_at > timing.renewed_at');
    }
    expect(executor.queries.map((query) => query.parameters[3])).toEqual([300_000, 60_000]);
  });

  it('locks an unexpired owned lease for the surrounding transaction', async () => {
    const executor = new ScriptedExecutor([emptyRows(), rows(runningRow())]);
    const result = await new PostgreSqlJobRepository(executor).requireOwnedLease(
      'interview-1',
      'job-1',
      'lease-1',
    );

    expect(result).toMatchObject({ ok: false, error: { code: 'lease_lost' } });
    expect(executor.queries[0]?.statement).toContain('job.lease_expires_at > timing.checked_at');
    expect(executor.queries[0]?.statement).toContain('FOR UPDATE OF owned');
    expect(executor.queries[0]?.statement.match(/clock_timestamp\(\)/gu)).toHaveLength(1);
    expect(executor.queries[0]?.parameters).toEqual(['interview-1', 'job-1', 'lease-1']);
  });

  it('requeues expired work but makes an exhausted lease terminal', async () => {
    const executor = new ScriptedExecutor([{ result: { rows: [], rowCount: 2 } }]);
    const result = await new PostgreSqlJobRepository(executor).reclaimExpired();

    expect(result).toEqual({ ok: true, value: 2 });
    expect(executor.queries[0]?.statement).toContain("WHERE job.status = 'running'");
    expect(executor.queries[0]?.statement).toContain('clock_timestamp() AS effective_now');
    expect(executor.queries[0]?.statement).toContain(
      'job.lease_expires_at <= timing.effective_now',
    );
    expect(executor.queries[0]?.statement).toContain("THEN 'failed'");
    expect(executor.queries[0]?.statement).toContain("ELSE 'queued'");
    expect(executor.queries[0]?.statement).toContain('completed_at = CASE');
    expect(executor.queries[0]?.statement).toContain('last_error_retryable');
    expect(executor.queries[0]?.statement).not.toContain('lease_token = NULL');
    expect(executor.queries[0]?.statement).not.toContain("status = 'cancelled'");
    expect(executor.queries[0]?.parameters).toEqual([]);
  });

  it('rejects unbounded lease and retry durations before querying PostgreSQL', async () => {
    const executor = new ScriptedExecutor([]);
    const repository = new PostgreSqlJobRepository(executor);

    await expect(
      repository.claimNext({ workerId: 'worker-a', leaseDurationMs: 999 }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'constraint_violation' } });
    await expect(
      repository.claimNext({ workerId: 'worker-a', leaseDurationMs: 900_001 }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'constraint_violation' } });
    await expect(
      repository.claim('interview-1', 'job-1', {
        workerId: 'worker-a',
        leaseDurationMs: 999,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'constraint_violation' } });
    await expect(
      repository.claim('interview-1', 'job-1', {
        workerId: 'worker-a',
        leaseDurationMs: 900_001,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'constraint_violation' } });
    await expect(
      repository.renewLease('interview-1', 'job-1', 'lease-1', 900_001),
    ).resolves.toMatchObject({ ok: false, error: { code: 'constraint_violation' } });
    await expect(
      repository.requeue('interview-1', 'job-1', 'lease-1', storedFailure(), -1),
    ).resolves.toMatchObject({ ok: false, error: { code: 'constraint_violation' } });
    await expect(
      repository.requeue('interview-1', 'job-1', 'lease-1', storedFailure(), 900_001),
    ).resolves.toMatchObject({ ok: false, error: { code: 'constraint_violation' } });
    expect(executor.queries).toHaveLength(0);
  });
});

describe('PostgreSqlJobRepository fenced state changes', () => {
  it('rejects non-millisecond failure timestamps without querying or throwing', async () => {
    const executor = new ScriptedExecutor([]);
    const repository = new PostgreSqlJobRepository(executor);
    const invalidTimestamps: readonly unknown[] = [
      new Date(T2),
      '2026-08-06',
      '2026-08-06T10:02:00Z',
      '2026-08-06T10:02:00.00Z',
      '2026-08-06T10:02:00.0006Z',
    ];

    expect(isStoredFailure(storedFailure({ occurredAt: '2026-08-06T12:02:00.000+02:00' }))).toBe(
      true,
    );
    for (const occurredAt of invalidTimestamps) {
      const jobFailure = storedFailure({ occurredAt: occurredAt as string });
      expect(isStoredFailure(jobFailure)).toBe(false);
      await expect(repository.fail('interview-1', 'job-1', 'lease-1', jobFailure)).resolves.toEqual(
        {
          ok: false,
          error: {
            code: 'constraint_violation',
            constraint: 'durable_jobs_fail_input_valid',
          },
        },
      );
    }
    expect(executor.queries).toHaveLength(0);
  });

  it('requeues with exact failure data and accepts an exact retained-token retry', async () => {
    const jobFailure = storedFailure();
    const row = requeuedRow(jobFailure, 30_000);
    const executor = new ScriptedExecutor([
      rows(row),
      emptyRows(),
      rows(row),
      emptyRows(),
      rows(row),
    ]);
    const repository = new PostgreSqlJobRepository(executor);

    const applied = await repository.requeue('interview-1', 'job-1', 'lease-1', jobFailure, 30_000);
    const retry = await repository.requeue('interview-1', 'job-1', 'lease-1', jobFailure, 30_000);
    const conflictingDelay = await repository.requeue(
      'interview-1',
      'job-1',
      'lease-1',
      jobFailure,
      40_000,
    );

    expect(applied).toMatchObject({
      ok: true,
      value: { status: 'queued', leaseToken: 'lease-1', leaseOwner: null, lastError: jobFailure },
    });
    expect(retry).toEqual(applied);
    expect(conflictingDelay).toMatchObject({
      ok: false,
      error: { code: 'duplicate_conflict' },
    });
    expect(executor.queries[0]?.statement).not.toContain('lease_token = NULL');
    expect(executor.queries[0]?.parameters.slice(0, 3)).toEqual([
      'interview-1',
      'job-1',
      'lease-1',
    ]);
    expect(executor.queries[0]?.parameters[7]).toBe(30_000);
    expect(executor.queries[0]?.statement).toContain(
      "timing.requeued_at + ($8::bigint * interval '1 millisecond')",
    );
  });

  it('completes once, recognizes an exact terminal retry, and fences another token', async () => {
    const succeeded = succeededRow();
    const executor = new ScriptedExecutor([
      rows(succeeded),
      emptyRows(),
      rows(succeeded),
      emptyRows(),
      rows(succeeded),
    ]);
    const repository = new PostgreSqlJobRepository(executor);

    const applied = await repository.complete('interview-1', 'job-1', 'lease-1', 2);
    const retry = await repository.complete('interview-1', 'job-1', 'lease-1', 2);
    const fenced = await repository.complete('interview-1', 'job-1', 'lease-other', 2);

    expect(applied).toMatchObject({ ok: true, value: { outcome: 'inserted' } });
    expect(retry).toMatchObject({ ok: true, value: { outcome: 'existing' } });
    expect(fenced).toMatchObject({ ok: false, error: { code: 'lease_lost' } });
    expect(executor.queries[0]?.statement).toContain("SET status = 'succeeded'");
    expect(executor.queries[0]?.statement).not.toContain('lease_token = NULL');
  });

  it('fails once and recognizes only an exact failure retry', async () => {
    const jobFailure = storedFailure({ retryable: false });
    const failed = failedRow(jobFailure);
    const exactExecutor = new ScriptedExecutor([rows(failed), emptyRows(), rows(failed)]);
    const repository = new PostgreSqlJobRepository(exactExecutor);

    const applied = await repository.fail('interview-1', 'job-1', 'lease-1', jobFailure);
    const retry = await repository.fail('interview-1', 'job-1', 'lease-1', jobFailure);
    expect(retry).toEqual(applied);

    const conflictExecutor = new ScriptedExecutor([emptyRows(), rows(failed)]);
    const conflict = await new PostgreSqlJobRepository(conflictExecutor).fail(
      'interview-1',
      'job-1',
      'lease-1',
      { ...jobFailure, message: 'different' },
    );
    expect(conflict).toMatchObject({ ok: false, error: { code: 'duplicate_conflict' } });
  });

  it('makes cancellation terminal and idempotent only for the same reason', async () => {
    const cancelled = cancelledRow('Interview ended');
    const executor = new ScriptedExecutor([
      rows(cancelled),
      emptyRows(),
      rows(cancelled),
      emptyRows(),
      rows(cancelled),
    ]);
    const repository = new PostgreSqlJobRepository(executor);

    const applied = await repository.cancel('interview-1', 'job-1', 'Interview ended');
    const retry = await repository.cancel('interview-1', 'job-1', 'Interview ended');
    const conflict = await repository.cancel('interview-1', 'job-1', 'Different reason');

    expect(applied).toMatchObject({ ok: true, value: { outcome: 'inserted' } });
    expect(retry).toMatchObject({ ok: true, value: { outcome: 'existing' } });
    expect(conflict).toMatchObject({ ok: false, error: { code: 'duplicate_conflict' } });
    expect(executor.queries[0]?.statement).toContain("job.status IN ('queued', 'running')");
  });
});

function enqueueJobInput(overrides: Partial<EnqueueJobInput> = {}): EnqueueJobInput {
  return {
    jobId: 'job-1',
    kind: 'participant_turn',
    idempotencyKey: 'participant:interview-1:turn-1',
    sourceTurnId: 'turn-1',
    expectedInterviewVersion: 1,
    maximumAttempts: 3,
    initialDelayMs: 0,
    resultDeliveryId: 'delivery-1',
    ...overrides,
  };
}

function queuedJob(overrides: Partial<DurableJob> = {}): DurableJob {
  return {
    interviewId: 'interview-1',
    jobId: 'job-1',
    kind: 'participant_turn',
    idempotencyKey: 'participant:interview-1:turn-1',
    sourceTurnId: 'turn-1',
    expectedInterviewVersion: 1,
    status: 'queued',
    attemptCount: 0,
    maximumAttempts: 3,
    initialDelayMs: 0,
    availableAt: T0,
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    appliedStateVersion: null,
    cancellationReason: null,
    resultDeliveryId: 'delivery-1',
    lastError: null,
    createdAt: T0,
    updatedAt: T0,
    completedAt: null,
    ...overrides,
  };
}

function queuedRow(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    interviewId: 'interview-1',
    jobId: 'job-1',
    kind: 'participant_turn',
    idempotencyKey: 'participant:interview-1:turn-1',
    sourceTurnId: 'turn-1',
    expectedInterviewVersion: 1,
    status: 'queued',
    attemptCount: 0,
    maximumAttempts: 3,
    initialDelayMs: 0,
    availableAt: T0,
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    appliedStateVersion: null,
    cancellationReason: null,
    resultDeliveryId: 'delivery-1',
    lastErrorCode: null,
    lastErrorMessage: null,
    lastErrorRetryable: null,
    lastErrorOccurredAt: null,
    createdAt: T0,
    updatedAt: T0,
    completedAt: null,
    ...overrides,
  };
}

function runningRow(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return queuedRow({
    status: 'running',
    attemptCount: 1,
    leaseOwner: 'worker-a',
    leaseToken: 'lease-1',
    leaseExpiresAt: T3,
    updatedAt: T1,
    ...overrides,
  });
}

function requeuedRow(jobFailure: StoredFailure, retryDelayMs: number): Record<string, unknown> {
  const updatedAt = T2;
  return queuedRow({
    attemptCount: 1,
    availableAt: new Date(Date.parse(updatedAt) + retryDelayMs).toISOString(),
    leaseToken: 'lease-1',
    lastErrorCode: jobFailure.code,
    lastErrorMessage: jobFailure.message,
    lastErrorRetryable: jobFailure.retryable,
    lastErrorOccurredAt: jobFailure.occurredAt,
    updatedAt,
  });
}

function succeededRow(): Record<string, unknown> {
  return queuedRow({
    status: 'succeeded',
    attemptCount: 1,
    leaseToken: 'lease-1',
    appliedStateVersion: 2,
    updatedAt: T2,
    completedAt: T2,
  });
}

function failedRow(jobFailure: StoredFailure): Record<string, unknown> {
  return queuedRow({
    status: 'failed',
    attemptCount: 1,
    leaseToken: 'lease-1',
    lastErrorCode: jobFailure.code,
    lastErrorMessage: jobFailure.message,
    lastErrorRetryable: jobFailure.retryable,
    lastErrorOccurredAt: jobFailure.occurredAt,
    updatedAt: jobFailure.occurredAt,
    completedAt: jobFailure.occurredAt,
  });
}

function cancelledRow(reason: string): Record<string, unknown> {
  return queuedRow({
    status: 'cancelled',
    attemptCount: 1,
    leaseToken: 'lease-1',
    cancellationReason: reason,
    updatedAt: T2,
    completedAt: T2,
  });
}

function storedFailure(overrides: Partial<StoredFailure> = {}): StoredFailure {
  return {
    code: 'PROVIDER_UNAVAILABLE',
    message: 'Provider unavailable',
    retryable: true,
    occurredAt: T2,
    ...overrides,
  };
}

function rows(...values: readonly unknown[]): ScriptStep {
  return { result: { rows: values, rowCount: values.length } };
}

function sourceTurnRows(turnId = 'turn-1'): ScriptStep {
  return rows({ turnId });
}

function emptyRows(): ScriptStep {
  return rows();
}
