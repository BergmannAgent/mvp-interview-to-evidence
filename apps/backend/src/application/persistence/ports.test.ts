import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  failure,
  success,
  type OutboxBatchWrite,
  type RepositoryError,
  type RepositoryResult,
} from './model.js';
import type {
  AppUnitOfWork,
  EvaluationWriter,
  InterviewWriter,
  JobWriter,
  OutboxWriter,
  TranscriptWriter,
} from './ports.js';

describe('application persistence boundary', () => {
  it('uses an explicit result discriminant for commit and rollback outcomes', () => {
    const committed = success({ interviewId: 'interview-1' });
    const rolledBack = failure<RepositoryError>({
      code: 'stale_version',
      interviewId: 'interview-1',
      expected: 2,
      actual: 3,
    });

    expect(committed).toEqual({ ok: true, value: { interviewId: 'interview-1' } });
    expect(rolledBack).toEqual({
      ok: false,
      error: {
        code: 'stale_version',
        interviewId: 'interview-1',
        expected: 2,
        actual: 3,
      },
    });
  });

  it('keeps interview-owned write methods explicitly scoped', () => {
    expectTypeOf<Parameters<InterviewWriter['compareAndSwap']>[0]>().toEqualTypeOf<string>();
    expectTypeOf<
      Parameters<TranscriptWriter['appendParticipantFinal']>[0]
    >().toEqualTypeOf<string>();
    expectTypeOf<Parameters<OutboxWriter['append']>[0]>().toEqualTypeOf<string>();
    expectTypeOf<Parameters<JobWriter['renewLease']>[0]>().toEqualTypeOf<string>();
    expectTypeOf<Parameters<EvaluationWriter['startRun']>[0]>().toEqualTypeOf<string>();
    expectTypeOf<Parameters<EvaluationWriter['completeRun']>[0]>().toEqualTypeOf<string>();
    expectTypeOf<Awaited<ReturnType<OutboxWriter['appendMany']>>>().toEqualTypeOf<
      RepositoryResult<OutboxBatchWrite>
    >();
  });

  it('limits global queue access to claim and expired-lease recovery', () => {
    expectTypeOf<Parameters<JobWriter['claimNext']>>().toEqualTypeOf<
      [
        input: {
          readonly workerId: string;
          readonly leaseDurationMs: number;
        },
      ]
    >();
    expectTypeOf<Parameters<JobWriter['reclaimExpired']>>().toEqualTypeOf<[]>();
  });

  it('exposes a generic use-case result without exposing an implementation', () => {
    expectTypeOf<AppUnitOfWork['transaction']>().toBeFunction();
    expectTypeOf<AppUnitOfWork['read']>().toBeFunction();
  });
});
