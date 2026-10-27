import { describe, expect, it, vi } from 'vitest';
import { mvpInterviewSessionSchema, type ProfileEvaluationSnapshot } from '@orgscience/contracts';
import type { EvaluableInterview } from '@orgscience/api-client';

import {
  evaluationCommandAllowed,
  evaluationForSelection,
  evaluationSourceKey,
  loadCurrentEvaluationSource,
  pollUntilTerminal,
  submitCurrentEvaluationSource,
} from './EvaluationWorkspace.js';

describe('EvaluationWorkspace command boundary', () => {
  it('starts only a ready persisted profile and blocks every dirty or busy command', () => {
    const ready = {
      kind: 'start' as const,
      evaluation: { status: 'not_started' as const },
      dirtyProfile: false,
      operation: null,
      selectionReady: true,
    };

    expect(evaluationCommandAllowed(ready)).toBe(true);
    expect(evaluationCommandAllowed({ ...ready, evaluation: null })).toBe(false);
    expect(evaluationCommandAllowed({ ...ready, dirtyProfile: true })).toBe(false);
    expect(evaluationCommandAllowed({ ...ready, operation: 'refresh' })).toBe(false);
    expect(evaluationCommandAllowed({ ...ready, selectionReady: false })).toBe(false);
    expect(evaluationCommandAllowed({ ...ready, evaluation: { status: 'completed' } })).toBe(false);
  });

  it('retries completed or retryable failed runs but not non-retryable failures', () => {
    const retry = {
      kind: 'retry' as const,
      dirtyProfile: false,
      operation: null,
      selectionReady: true,
    };

    expect(evaluationCommandAllowed({ ...retry, evaluation: { status: 'completed' } })).toBe(true);
    expect(
      evaluationCommandAllowed({
        ...retry,
        evaluation: { status: 'failed', failure: { retryable: true } },
      }),
    ).toBe(true);
    expect(
      evaluationCommandAllowed({
        ...retry,
        evaluation: { status: 'failed', failure: { retryable: false } },
      }),
    ).toBe(false);
    expect(evaluationCommandAllowed({ ...retry, evaluation: { status: 'running' } })).toBe(false);
  });

  it('keeps polling after a transient error and returns the later terminal result', async () => {
    const controller = new AbortController();
    const errors: unknown[] = [];
    let recovered = 0;
    let calls = 0;

    const result = await pollUntilTerminal({
      signal: controller.signal,
      wait: async () => undefined,
      load: async () => {
        calls += 1;
        if (calls === 1) throw new Error('temporary network failure');
        return { status: calls === 2 ? 'running' : 'completed', reportId: 'report-1' };
      },
      onError: (reason) => errors.push(reason),
      onRecovered: () => {
        recovered += 1;
      },
    });

    expect(result).toEqual({ status: 'completed', reportId: 'report-1' });
    expect(calls).toBe(3);
    expect(errors).toHaveLength(1);
    expect(recovered).toBe(2);
  });

  it('never exposes a result from an outdated interview or profile revision', () => {
    const evaluation = {
      status: 'completed',
      interviewId: 'interview-a',
      profileId: 'profile-a',
    } as const;

    expect(
      evaluationForSelection({
        evaluation,
        evaluationScopeKey: '["interview-a","profile-a","revision-1"]',
        selectionKey: '["interview-a","profile-a","revision-1"]',
        interviewId: 'interview-a',
        profileId: 'profile-a',
      }),
    ).toBe(evaluation);
    expect(
      evaluationForSelection({
        evaluation,
        evaluationScopeKey: '["interview-a","profile-a","revision-1"]',
        selectionKey: '["interview-b","profile-a","revision-1"]',
        interviewId: 'interview-b',
        profileId: 'profile-a',
      }),
    ).toBeNull();
    expect(
      evaluationForSelection({
        evaluation,
        evaluationScopeKey: '["interview-a","profile-a","revision-1"]',
        selectionKey: '["interview-a","profile-a","revision-2"]',
        interviewId: 'interview-a',
        profileId: 'profile-a',
      }),
    ).toBeNull();
  });

  it('loads a fresh saved transcript before fetching its current evaluation', async () => {
    const interview = source();
    const order: string[] = [];
    const evaluation = {
      status: 'not_started' as const,
      interviewId: interview.session.interviewId,
      profileId: 'profile',
      profileFingerprint: 'a'.repeat(64),
      language: 'de' as const,
      report: null,
      failure: null,
    };
    const listEvaluableInterviews = vi.fn(async () => {
      order.push('source');
      return [interview];
    });
    const getEvaluation = vi.fn(async () => {
      order.push('evaluation');
      return evaluation;
    });
    const signal = new AbortController().signal;
    expect(
      await loadCurrentEvaluationSource(
        { listEvaluableInterviews, getEvaluation },
        interview.session.interviewId,
        'profile',
        signal,
      ),
    ).toEqual({ interview, interviews: [interview], evaluation });
    expect(order).toEqual(['source', 'evaluation', 'source']);
    expect(listEvaluableInterviews).toHaveBeenCalledTimes(2);
    expect(listEvaluableInterviews).toHaveBeenCalledWith(signal);
    expect(getEvaluation).toHaveBeenCalledWith(interview.session.interviewId, 'profile', signal);
  });

  it('invalidates a report after new final turns, while partial-only changes do not invalidate it', () => {
    const before = source();
    const key = evaluationSourceKey(before, 'profile', 'revision');
    const partial = {
      ...before,
      session: {
        ...before.session,
        partialTranscript: 'Still speaking',
        updatedAt: '2026-10-01T10:05:00.000Z',
        stateVersion: 4,
      },
    };
    expect(evaluationSourceKey(partial, 'profile', 'revision')).toBe(key);
    const next = {
      ...before,
      session: {
        ...before.session,
        transcript: [
          ...before.session.transcript,
          {
            turnId: 'new-answer',
            interviewId: before.session.interviewId,
            sequenceNumber: 3,
            speaker: 'participant' as const,
            turnType: 'participant_answer' as const,
            text: 'Additional final evidence.',
            occurredAt: '2026-10-01T10:04:00.000Z',
            guideReference: null,
            interrupted: false,
          },
        ],
      },
    };
    const newKey = evaluationSourceKey(next, 'profile', 'revision');
    expect(newKey).not.toBe(key);
    expect(
      evaluationForSelection({
        evaluation: { interviewId: before.session.interviewId, profileId: 'profile' },
        evaluationScopeKey: key,
        selectionKey: newKey,
        interviewId: before.session.interviewId,
        profileId: 'profile',
      }),
    ).toBeNull();
  });

  it('keeps an existing evaluation source valid after renaming without changing transcript or guide', () => {
    const original = source();
    const renamed = {
      ...original,
      summary: { ...original.summary, displayName: 'Interview Anna' },
    };
    expect(evaluationSourceKey(renamed, 'profile', 'revision')).toBe(
      evaluationSourceKey(original, 'profile', 'revision'),
    );
    expect(renamed.session.transcript).toBe(original.session.transcript);
    expect(renamed.session.guideTitle).toBe(original.session.guideTitle);
  });

  it('does not fetch an evaluation for a disappeared or no-longer-answered source', async () => {
    const getEvaluation = vi.fn();
    await expect(
      loadCurrentEvaluationSource(
        { listEvaluableInterviews: async () => [], getEvaluation },
        'missing',
        'profile',
      ),
    ).rejects.toThrow('no longer');
    expect(getEvaluation).not.toHaveBeenCalled();
  });

  it('retries a source read when a final turn arrives between the source and evaluation reads', async () => {
    const original = source();
    const extended = appendFinal(original, 'new-evidence');
    let latest = original;
    const getEvaluation = vi
      .fn()
      .mockImplementationOnce(async () => {
        latest = extended;
        return runningSnapshot('outdated-run');
      })
      .mockResolvedValue(runningSnapshot('current-run'));
    const current = await loadCurrentEvaluationSource(
      { listEvaluableInterviews: async () => [latest], getEvaluation },
      original.session.interviewId,
      'profile',
    );

    expect(current.interview).toBe(extended);
    expect(current.interview.session.transcript.at(-1)?.turnId).toBe('new-evidence');
    expect(current.evaluation).toEqual(runningSnapshot('current-run'));
    expect(getEvaluation).toHaveBeenCalledTimes(2);
  });

  it('accepts partial-only updates without retrying and preserves the latest actual summary status', async () => {
    const original = source();
    const partial = {
      ...original,
      summary: { ...original.summary, updatedAt: '2026-10-01T10:06:00.000Z' },
      session: {
        ...original.session,
        partialTranscript: 'Still speaking',
        updatedAt: '2026-10-01T10:06:00.000Z',
      },
    };
    const listEvaluableInterviews = vi
      .fn()
      .mockResolvedValueOnce([original])
      .mockResolvedValueOnce([partial]);
    const getEvaluation = vi.fn(async () => runningSnapshot('current-run'));

    const current = await loadCurrentEvaluationSource(
      { listEvaluableInterviews, getEvaluation },
      original.session.interviewId,
      'profile',
    );
    expect(current.interview).toBe(partial);
    expect(current.interview.summary.status).toBe('paused');
    expect(getEvaluation).toHaveBeenCalledTimes(1);
    expect(listEvaluableInterviews).toHaveBeenCalledTimes(2);
  });

  it('stops after three unstable reads instead of pairing an old evaluation with a new transcript', async () => {
    let current = source();
    let turn = 0;
    const listEvaluableInterviews = vi.fn(async () => {
      current = appendFinal(current, `new-evidence-${String(++turn)}`);
      return [current];
    });
    const getEvaluation = vi.fn(async () => runningSnapshot('changing-run'));

    await expect(
      loadCurrentEvaluationSource(
        { listEvaluableInterviews, getEvaluation },
        current.session.interviewId,
        'profile',
      ),
    ).rejects.toThrow('changed while loading');
    expect(getEvaluation).toHaveBeenCalledTimes(3);
    expect(listEvaluableInterviews).toHaveBeenCalledTimes(6);
  });

  it('reloads the fenced source after a successful POST instead of showing its pre-call transcript', async () => {
    const original = source();
    const extended = appendFinal(original, 'answer-during-post');
    let latest = original;
    const startEvaluation = vi.fn(async () => {
      latest = extended;
      return runningSnapshot('post-response');
    });
    const retryEvaluation = vi.fn();
    const getEvaluation = vi.fn(async () => runningSnapshot('current-source-run'));
    const current = await submitCurrentEvaluationSource(
      {
        listEvaluableInterviews: async () => [latest],
        getEvaluation,
        startEvaluation,
        retryEvaluation,
      },
      {
        interviews: [original],
        interview: original,
        evaluation: notStartedSnapshot(),
      },
      'start',
    );

    expect(startEvaluation).toHaveBeenCalledTimes(1);
    expect(retryEvaluation).not.toHaveBeenCalled();
    expect(current.interview).toBe(extended);
    expect(current.evaluation).toEqual(runningSnapshot('current-source-run'));
    expect(current.evaluation).not.toEqual(runningSnapshot('post-response'));
  });

  it('reloads after a retry but does not submit duplicate commands for an already-running run', async () => {
    const interview = source();
    const running = runningSnapshot('existing-run');
    const startEvaluation = vi.fn();
    const retryEvaluation = vi.fn(async () => runningSnapshot('post-retry-run'));
    const listEvaluableInterviews = vi.fn(async () => [interview]);
    const getEvaluation = vi.fn(async () => runningSnapshot('current-retry-run'));
    const api = { listEvaluableInterviews, getEvaluation, startEvaluation, retryEvaluation };
    const before = { interviews: [interview], interview, evaluation: running };
    expect(await submitCurrentEvaluationSource(api, before, 'retry')).toBe(before);
    expect(listEvaluableInterviews).not.toHaveBeenCalled();
    expect(retryEvaluation).not.toHaveBeenCalled();

    const failure: ProfileEvaluationSnapshot = {
      ...running,
      status: 'failed',
      failedAt: '2026-10-01T10:05:00.000Z',
      failure: { code: 'provider_error', message: 'Provider failed', retryable: true },
    };
    const retried = await submitCurrentEvaluationSource(
      api,
      { ...before, evaluation: failure },
      'retry',
    );
    expect(startEvaluation).not.toHaveBeenCalled();
    expect(retryEvaluation).toHaveBeenCalledTimes(1);
    expect(listEvaluableInterviews).toHaveBeenCalledTimes(2);
    expect(retried.evaluation).toEqual(runningSnapshot('current-retry-run'));
  });
});

function notStartedSnapshot(): Extract<
  ProfileEvaluationSnapshot,
  { readonly status: 'not_started' }
> {
  return {
    status: 'not_started',
    interviewId: 'partial-interview',
    profileId: 'profile',
    profileFingerprint: 'a'.repeat(64),
    language: 'de',
    report: null,
    failure: null,
  };
}

function runningSnapshot(
  evaluationId: string,
): Extract<ProfileEvaluationSnapshot, { readonly status: 'running' }> {
  return {
    ...notStartedSnapshot(),
    status: 'running',
    evaluationId,
    startedAt: '2026-10-01T10:03:00.000Z',
  };
}

function appendFinal(interview: EvaluableInterview, turnId: string): EvaluableInterview {
  return {
    ...interview,
    session: {
      ...interview.session,
      transcript: [
        ...interview.session.transcript,
        {
          turnId,
          interviewId: interview.session.interviewId,
          sequenceNumber: interview.session.transcript.length + 1,
          speaker: 'participant',
          turnType: 'participant_answer',
          text: 'Additional final evidence.',
          occurredAt: '2026-10-01T10:04:00.000Z',
          guideReference: null,
          interrupted: false,
        },
      ],
    },
  };
}

function source(): EvaluableInterview {
  const updatedAt = '2026-10-01T10:03:00.000Z';
  const session = mvpInterviewSessionSchema.parse({
    interviewId: 'partial-interview',
    guideId: 'guide',
    guideTitle: 'Original guide',
    language: 'de',
    status: 'paused',
    startedAt: '2026-10-01T10:00:00.000Z',
    endedAt: null,
    finalizedAt: null,
    updatedAt,
    currentQuestionIndex: 0,
    totalQuestions: 2,
    currentQuestion: null,
    partialTranscript: null,
    transcript: [
      {
        turnId: 'question',
        interviewId: 'partial-interview',
        sequenceNumber: 1,
        speaker: 'ai_interviewer',
        turnType: 'main_question',
        text: 'What happened?',
        occurredAt: '2026-10-01T10:01:00.000Z',
        guideReference: null,
        interrupted: false,
      },
      {
        turnId: 'answer',
        interviewId: 'partial-interview',
        sequenceNumber: 2,
        speaker: 'participant',
        turnType: 'participant_answer',
        text: 'We adjusted the schedule.',
        occurredAt: '2026-10-01T10:02:00.000Z',
        guideReference: null,
        interrupted: false,
      },
    ],
  });
  return {
    session,
    summary: {
      interviewId: session.interviewId,
      guideId: session.guideId,
      guideTitle: session.guideTitle,
      language: 'de',
      status: 'paused',
      currentMainQuestionId: null,
      activeWorkflowRunId: null,
      createdAt: session.startedAt ?? updatedAt,
      updatedAt,
      startedAt: session.startedAt,
    },
  };
}
