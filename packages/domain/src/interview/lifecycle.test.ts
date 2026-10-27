import { describe, expect, it } from 'vitest';

import {
  createReadyInterview,
  getAllowedLifecycleActions,
  transitionInterview,
  type InterviewLifecycleAction,
  type InterviewLifecycleState,
} from './lifecycle.js';

const CREATED_AT = '2026-08-06T10:00:00.000Z';

function ready(): InterviewLifecycleState {
  return createReadyInterview({
    interviewId: 'interview-1',
    guideId: 'guide-1',
    createdAt: CREATED_AT,
  });
}

function apply(
  state: InterviewLifecycleState,
  action: InterviewLifecycleAction,
): InterviewLifecycleState {
  const result = transitionInterview(state, action);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.state;
}

describe('interview lifecycle', () => {
  it('runs the complete start, pause, resume, ending, and completion lifecycle', () => {
    const active = apply(ready(), { type: 'start', at: '2026-08-06T10:01:00.000Z' });
    expect(active).toMatchObject({ status: 'active', revision: 1 });

    const paused = apply(active, { type: 'pause', at: '2026-08-06T10:02:00.000Z' });
    expect(paused).toMatchObject({ status: 'paused', revision: 2 });

    const resumed = apply(paused, { type: 'resume', at: '2026-08-06T10:03:00.000Z' });
    expect(resumed).toMatchObject({ status: 'active', revision: 3 });

    const ending = apply(resumed, {
      type: 'begin_ending',
      at: '2026-08-06T10:04:00.000Z',
    });
    expect(ending).toMatchObject({ status: 'ending', endingFrom: 'active', revision: 4 });

    const completed = apply(ending, {
      type: 'complete',
      at: '2026-08-06T10:05:00.000Z',
    });
    expect(completed).toMatchObject({
      status: 'completed',
      startedAt: '2026-08-06T10:01:00.000Z',
      endingAt: '2026-08-06T10:04:00.000Z',
      endedAt: '2026-08-06T10:05:00.000Z',
      revision: 5,
    });
    expect(getAllowedLifecycleActions(completed)).toEqual([]);
  });

  it.each([
    { action: { type: 'pause', at: CREATED_AT } as const, status: 'ready' },
    { action: { type: 'resume', at: CREATED_AT } as const, status: 'ready' },
    { action: { type: 'begin_ending', at: CREATED_AT } as const, status: 'ready' },
    { action: { type: 'complete', at: CREATED_AT } as const, status: 'ready' },
  ])('rejects $action.type while $status', ({ action }) => {
    const state = ready();
    const result = transitionInterview(state, action);
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: 'invalid_transition',
        currentStatus: 'ready',
        attemptedAction: action.type,
      }),
    });
    expect(state).toEqual(ready());
  });

  it('allows a controlled failure from non-terminal states and rejects terminal transitions', () => {
    const active = apply(ready(), { type: 'start', at: '2026-08-06T10:01:00.000Z' });
    const failed = apply(active, {
      type: 'fail',
      at: '2026-08-06T10:02:00.000Z',
      failure: { code: 'provider_unavailable', message: 'Provider unavailable' },
    });
    expect(failed).toMatchObject({
      status: 'failed',
      failedFrom: 'active',
      startedAt: '2026-08-06T10:01:00.000Z',
    });

    expect(
      transitionInterview(failed, {
        type: 'fail',
        at: '2026-08-06T10:03:00.000Z',
        failure: { code: 'again', message: 'Again' },
      }),
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'invalid_transition', allowedActions: [] }),
    });
  });

  it('rejects invalid and regressing transition timestamps', () => {
    const active = apply(ready(), { type: 'start', at: '2026-08-06T10:02:00.000Z' });
    expect(transitionInterview(active, { type: 'pause', at: 'not-a-date' })).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'invalid_timestamp' }),
    });
    expect(transitionInterview(active, { type: 'pause', at: '2026-08-06T10:01:00.000Z' })).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'timestamp_regression' }),
    });
  });

  it('rejects failures without an auditable code and message', () => {
    expect(
      transitionInterview(ready(), {
        type: 'fail',
        at: '2026-08-06T10:01:00.000Z',
        failure: { code: '', message: '' },
      }),
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'invalid_failure' }),
    });
  });
});
