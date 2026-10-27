import {
  calculateProfileScores,
  mvpInterviewSessionSchema,
  profileEvaluationReportSchema,
  profileEvaluationSnapshotResponseSchema,
  type InterviewSummary,
  type MvpInterviewSession,
} from '@orgscience/contracts';
import { describe, expect, it, vi } from 'vitest';

import { ApiError, EvaluationStudioApiClient, type EvaluationProfilesFetch } from '../src/index.js';

const PROFILE_FINGERPRINT = 'a'.repeat(64);
const T0 = '2026-08-21T10:00:00.000Z';
const T1 = '2026-08-21T10:01:00.000Z';
const T2 = '2026-08-21T10:02:00.000Z';
const T3 = '2026-08-21T10:03:00.000Z';

describe('EvaluationStudioApiClient evaluation runner', () => {
  it('renames an interview through a validated PATCH without changing its guide title', async () => {
    const original = summary('interview-1', 'completed');
    const renamed = { ...original, displayName: 'Interview Anna' };
    const fetch = queuedFetch([jsonResponse({ interview: renamed })]);
    const client = new EvaluationStudioApiClient({ fetch });
    expect(
      await client.renameInterview('interview-1', { displayName: '  Interview Anna  ' }),
    ).toEqual(renamed);
    expect(fetch.mock.calls[0]).toEqual([
      '/api/v1/interviews/interview-1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ displayName: 'Interview Anna' }),
      }),
    ]);
    expect(renamed.guideTitle).toBe(original.guideTitle);
  });

  it('resets a custom interview name to null and rejects a foreign rename response', async () => {
    const fetch = queuedFetch([
      jsonResponse({ interview: { ...summary('interview-1', 'completed'), displayName: null } }),
      jsonResponse({
        interview: { ...summary('other-interview', 'completed'), displayName: 'New name' },
      }),
    ]);
    const client = new EvaluationStudioApiClient({ fetch });
    await expect(
      client.renameInterview('interview-1', { displayName: null }),
    ).resolves.toMatchObject({ displayName: null });
    await expect(
      client.renameInterview('interview-1', { displayName: 'New name' }),
    ).rejects.toMatchObject({ kind: 'contract', code: 'INVALID_RESPONSE' });
  });

  it('validates rename input before a request and enforces DELETE 204 while preserving busy errors', async () => {
    const fetch = queuedFetch([
      new Response(null, { status: 204 }),
      jsonResponse(
        {
          error: {
            code: 'CONFLICT',
            message: 'Interview is active.',
            requestId: 'request-delete',
            occurredAt: T1,
            retryable: false,
            fieldErrors: [],
          },
        },
        { status: 409 },
      ),
      jsonResponse({}, { status: 200 }),
    ]);
    const client = new EvaluationStudioApiClient({ fetch });
    await expect(client.renameInterview('interview-1', { displayName: ' ' })).rejects.toMatchObject(
      { code: 'INVALID_REQUEST' },
    );
    await expect(
      client.renameInterview('interview-1', { displayName: 'x'.repeat(201) }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(client.deleteInterview('not valid')).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    expect(fetch).not.toHaveBeenCalled();
    await expect(client.deleteInterview('interview-1')).resolves.toBeUndefined();
    await expect(client.deleteInterview('interview-2')).rejects.toMatchObject({
      kind: 'http',
      status: 409,
    });
    await expect(client.deleteInterview('interview-3')).rejects.toMatchObject({
      kind: 'contract',
      code: 'INVALID_RESPONSE',
    });
    expect(fetch.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ['/api/v1/interviews/interview-1', 'DELETE'],
      ['/api/v1/interviews/interview-2', 'DELETE'],
      ['/api/v1/interviews/interview-3', 'DELETE'],
    ]);
  });

  it('paginates canonical interviews and returns only completed, finalized sessions', async () => {
    const fetch = queuedFetch([
      jsonResponse({
        interviews: [
          summary('interview-active', 'active'),
          summary('interview-final', 'completed'),
        ],
        nextCursor: 'cursor-1',
      }),
      jsonResponse({
        interviews: [summary('interview-not-finalized', 'completed')],
        nextCursor: null,
      }),
      jsonResponse(session('interview-final', true)),
      jsonResponse(session('interview-not-finalized', false)),
    ]);
    const client = new EvaluationStudioApiClient({ baseUrl: 'https://studio.test/', fetch });

    const interviews = await client.listFinalizedInterviews();

    expect(interviews).toHaveLength(1);
    expect(interviews[0]).toMatchObject({
      summary: { interviewId: 'interview-final', guideTitle: 'Guide interview-final' },
      session: {
        interviewId: 'interview-final',
        status: 'completed',
        endedAt: T2,
        finalizedAt: T3,
      },
    });
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      'https://studio.test/api/v1/interviews?limit=100',
      'https://studio.test/api/v1/interviews?limit=100&after=cursor-1',
      'https://studio.test/api/v1/interviews/interview-final/session',
      'https://studio.test/api/v1/interviews/interview-not-finalized/session',
    ]);
  });

  it('loads persisted evaluation state and starts and retries only through explicit POSTs', async () => {
    const fetch = queuedFetch([
      jsonResponse(
        profileEvaluationSnapshotResponseSchema.parse({
          evaluation: {
            status: 'not_started',
            interviewId: 'interview-1',
            profileId: 'profile-2',
            profileFingerprint: PROFILE_FINGERPRINT,
            report: null,
            failure: null,
          },
        }),
      ),
      jsonResponse(
        profileEvaluationSnapshotResponseSchema.parse({
          evaluation: {
            status: 'running',
            evaluationId: 'evaluation-1',
            interviewId: 'interview-1',
            profileId: 'profile-2',
            profileFingerprint: PROFILE_FINGERPRINT,
            startedAt: T1,
            report: null,
            failure: null,
          },
        }),
      ),
      jsonResponse(
        profileEvaluationSnapshotResponseSchema.parse({
          evaluation: {
            status: 'failed',
            evaluationId: 'evaluation-1',
            interviewId: 'interview-1',
            profileId: 'profile-2',
            profileFingerprint: PROFILE_FINGERPRINT,
            startedAt: T1,
            failedAt: T2,
            report: null,
            failure: { code: 'provider_error', message: 'Provider failed.', retryable: true },
          },
        }),
      ),
    ]);
    const client = new EvaluationStudioApiClient({ fetch });

    await expect(client.getEvaluation('interview-1', 'profile-2')).resolves.toMatchObject({
      status: 'not_started',
    });
    await expect(
      client.startEvaluation('interview-1', { profileId: 'profile-2' }),
    ).resolves.toMatchObject({ status: 'running' });
    await expect(
      client.retryEvaluation('interview-1', { profileId: 'profile-2' }),
    ).resolves.toMatchObject({ status: 'failed', failure: { retryable: true } });

    expect(fetch.mock.calls.map(([url, init]) => [String(url), init?.method ?? 'GET'])).toEqual([
      ['/api/v1/interviews/interview-1/evaluation?profileId=profile-2', 'GET'],
      ['/api/v1/interviews/interview-1/evaluation', 'POST'],
      ['/api/v1/interviews/interview-1/evaluation/retry', 'POST'],
    ]);
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ profileId: 'profile-2' }));
    expect(fetch.mock.calls[2]?.[1]?.body).toBe(JSON.stringify({ profileId: 'profile-2' }));
  });

  it('includes answered active, paused, completed, failed and ending interviews without inventing finalization', async () => {
    const active = answeredSession('active', 'active');
    const paused = answeredSession('paused', 'paused');
    const incomplete = answeredSession('incomplete', 'completed');
    const finalized = answeredSession('finalized', 'completed', true);
    const failed = answeredSession('failed', 'completed');
    const ending = answeredSession('ending', 'completed');
    const noAnswer = {
      ...answeredSession('no-answer', 'active'),
      transcript: active.transcript
        .filter((turn) => turn.speaker === 'ai_interviewer')
        .map((turn) => ({ ...turn, interviewId: 'no-answer' })),
      partialTranscript: 'Only a partial answer.',
    };
    const fetch = queuedFetch([
      jsonResponse({
        interviews: [
          summary('ready', 'ready'),
          summary('active', 'active'),
          summary('paused', 'paused'),
          summary('incomplete', 'completed'),
          summary('finalized', 'completed'),
          summary('failed', 'failed'),
          summary('ending', 'ending'),
          summary('no-answer', 'active'),
        ],
        nextCursor: null,
      }),
      ...[active, paused, incomplete, finalized, failed, ending, noAnswer].map((candidate) =>
        jsonResponse(candidate),
      ),
    ]);
    const interviews = await new EvaluationStudioApiClient({ fetch }).listEvaluableInterviews();
    expect(interviews.map((interview) => interview.summary.interviewId)).toEqual([
      'active',
      'paused',
      'incomplete',
      'finalized',
      'failed',
      'ending',
    ]);
    expect(interviews[0]?.session).toMatchObject({
      status: 'active',
      endedAt: null,
      finalizedAt: null,
    });
    expect(interviews[1]?.session).toMatchObject({
      status: 'paused',
      endedAt: null,
      finalizedAt: null,
    });
    expect(interviews[2]?.session.finalizedAt).toBeNull();
    expect(interviews[4]?.summary.status).toBe('failed');
    expect(interviews[5]?.summary.status).toBe('ending');
    expect(
      fetch.mock.calls.every(([, init]) => init?.method === undefined || init.method === 'GET'),
    ).toBe(true);
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/ready/session'))).toBe(false);
  });

  it('skips disappeared evaluable sources and propagates contract failures', async () => {
    const listed = jsonResponse({ interviews: [summary('gone', 'paused')], nextCursor: null });
    await expect(
      new EvaluationStudioApiClient({
        fetch: queuedFetch([listed, new Response(null, { status: 404 })]),
      }).listEvaluableInterviews(),
    ).resolves.toEqual([]);
    await expect(
      new EvaluationStudioApiClient({
        fetch: queuedFetch([
          jsonResponse({ interviews: [summary('bad', 'active')], nextCursor: null }),
          jsonResponse({ invalid: true }),
        ]),
      }).listEvaluableInterviews(),
    ).rejects.toMatchObject({ kind: 'contract' });
  });

  it.each([
    ['json', 'application/json', '.json'],
    ['csv', 'text/csv', '.csv'],
    ['markdown', 'text/markdown', '.md'],
    ['html', 'text/html', '.html'],
  ] as const)(
    'loads the %s export with validated media type and file name',
    async (format, mediaType, extension) => {
      const body =
        format === 'json'
          ? JSON.stringify(evaluationReport('interview-1', 'profile-2'))
          : `canonical-${format}-report`;
      const fetch = queuedFetch([
        new Response(body, {
          status: 200,
          headers: {
            'Content-Type': `${mediaType}; charset=utf-8`,
            'Content-Disposition': `attachment; filename="evaluation-result${extension}"`,
          },
        }),
      ]);
      const client = new EvaluationStudioApiClient({ fetch });

      await expect(client.getEvaluationExport('interview-1', format, 'profile-2')).resolves.toEqual(
        {
          format,
          fileName: `evaluation-result${extension}`,
          mediaType,
          text: body,
        },
      );
      expect(fetch.mock.calls[0]?.[0]).toBe(
        `/api/v1/interviews/interview-1/evaluation/export?format=${format}&profileId=profile-2`,
      );
      expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('Accept')).toBe(mediaType);
    },
  );

  it('rejects malformed and out-of-scope JSON evaluation exports', async () => {
    const malformedClient = new EvaluationStudioApiClient({
      fetch: queuedFetch([
        new Response('{not-json', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ]),
    });
    await expect(
      malformedClient.getEvaluationExport('interview-1', 'json', 'profile-2'),
    ).rejects.toMatchObject({ kind: 'contract', code: 'INVALID_RESPONSE' });

    for (const report of [
      evaluationReport('interview-other', 'profile-2'),
      evaluationReport('interview-1', 'profile-other'),
    ]) {
      const foreignScopeClient = new EvaluationStudioApiClient({
        fetch: queuedFetch([
          new Response(JSON.stringify(report), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ]),
      });
      await expect(
        foreignScopeClient.getEvaluationExport('interview-1', 'json', 'profile-2'),
      ).rejects.toMatchObject({ kind: 'contract', code: 'INVALID_RESPONSE' });
    }
  });

  it('bounds finalized-session requests and skips only missing or stale candidates', async () => {
    const interviewIds = Array.from({ length: 7 }, (_, index) => `interview-${String(index + 1)}`);
    let activeSessionRequests = 0;
    let maximumActiveSessionRequests = 0;
    const fetch = vi.fn<EvaluationProfilesFetch>(async (input) => {
      const url = String(input);
      if (url === '/api/v1/interviews?limit=100') {
        return jsonResponse({
          interviews: interviewIds.map((interviewId) => summary(interviewId, 'completed')),
          nextCursor: null,
        });
      }

      activeSessionRequests += 1;
      maximumActiveSessionRequests = Math.max(maximumActiveSessionRequests, activeSessionRequests);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeSessionRequests -= 1;
      if (url.endsWith('/interview-2/session')) return new Response(null, { status: 404 });
      const interviewId = interviewIdFromUrl(url);
      return jsonResponse(session(interviewId, interviewId !== 'interview-3'));
    });
    const client = new EvaluationStudioApiClient({ fetch });

    const interviews = await client.listFinalizedInterviews();

    expect(maximumActiveSessionRequests).toBe(4);
    expect(interviews.map(({ summary: interview }) => interview.interviewId)).toEqual([
      'interview-1',
      'interview-4',
      'interview-5',
      'interview-6',
      'interview-7',
    ]);
  });

  it.each([
    ['network', (): TypeError => new TypeError('offline')],
    ['contract', (): null => null],
  ] as const)('propagates %s failures while enriching finalized interviews', async (_, failure) => {
    const fetch = vi.fn<EvaluationProfilesFetch>(async (input) => {
      if (String(input) === '/api/v1/interviews?limit=100') {
        return jsonResponse({
          interviews: [summary('interview-1', 'completed')],
          nextCursor: null,
        });
      }
      const error = failure();
      if (error !== null) throw error;
      return jsonResponse({ invalid: 'session' });
    });
    const client = new EvaluationStudioApiClient({ fetch });

    await expect(client.listFinalizedInterviews()).rejects.toMatchObject(
      _ === 'network'
        ? { kind: 'network', code: 'NETWORK_ERROR' }
        : { kind: 'contract', code: 'INVALID_RESPONSE' },
    );
  });

  it('preserves abort errors while enriching finalized interviews', async () => {
    const controller = new AbortController();
    const abortError = new DOMException('Cancelled', 'AbortError');
    const fetch = vi.fn<EvaluationProfilesFetch>(async (input) => {
      if (String(input) === '/api/v1/interviews?limit=100') {
        return jsonResponse({
          interviews: [summary('interview-1', 'completed')],
          nextCursor: null,
        });
      }
      controller.abort(abortError);
      throw abortError;
    });
    const client = new EvaluationStudioApiClient({ fetch });

    await expect(client.listFinalizedInterviews(controller.signal)).rejects.toBe(abortError);
  });

  it('preserves the shared structured API error for evaluation failures', async () => {
    const fetch = queuedFetch([
      jsonResponse(
        {
          error: {
            code: 'RATE_LIMITED',
            message: 'Try again later.',
            requestId: 'request-1',
            occurredAt: T1,
            retryable: true,
            fieldErrors: [],
          },
        },
        { status: 429 },
      ),
    ]);
    const client = new EvaluationStudioApiClient({ fetch });

    const result = client.startEvaluation('interview-1', { profileId: 'profile-2' });

    await expect(result).rejects.toBeInstanceOf(ApiError);
    await expect(result).rejects.toMatchObject({
      kind: 'http',
      status: 429,
      code: 'RATE_LIMITED',
      requestId: 'request-1',
      retryable: true,
    });
  });

  it('rejects a valid evaluation payload from another interview scope', async () => {
    const fetch = queuedFetch([
      jsonResponse({
        evaluation: {
          status: 'not_started',
          interviewId: 'interview-other',
          profileId: 'profile-2',
          profileFingerprint: PROFILE_FINGERPRINT,
          report: null,
          failure: null,
        },
      }),
    ]);
    const client = new EvaluationStudioApiClient({ fetch });

    await expect(client.getEvaluation('interview-1', 'profile-2')).rejects.toMatchObject({
      kind: 'contract',
      code: 'INVALID_RESPONSE',
    });
  });

  it('rejects invalid interview IDs before issuing a request', async () => {
    const fetch = vi.fn<EvaluationProfilesFetch>();
    const client = new EvaluationStudioApiClient({ fetch });

    await expect(client.getInterviewSession('not valid')).rejects.toMatchObject({
      kind: 'contract',
      code: 'INVALID_REQUEST',
      fieldErrors: [expect.objectContaining({ path: ['interviewId'] })],
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

function summary(interviewId: string, status: InterviewSummary['status']): InterviewSummary {
  return {
    interviewId,
    guideId: `guide-${interviewId}`,
    language: 'de',
    guideTitle: `Guide ${interviewId}`,
    status,
    currentMainQuestionId: null,
    activeWorkflowRunId: null,
    createdAt: T0,
    updatedAt: T2,
    startedAt: status === 'ready' ? null : T1,
  };
}

function session(interviewId: string, finalized: boolean): MvpInterviewSession {
  return mvpInterviewSessionSchema.parse({
    interviewId,
    guideId: `guide-${interviewId}`,
    language: 'de',
    guideTitle: `Guide ${interviewId}`,
    status: 'completed',
    currentQuestionIndex: 1,
    totalQuestions: 1,
    currentQuestion: null,
    startedAt: T1,
    endedAt: T2,
    updatedAt: finalized ? T3 : T2,
    partialTranscript: null,
    transcript: [],
    technicalGaps: [],
    finalizedAt: finalized ? T3 : null,
  });
}

function answeredSession(
  interviewId: string,
  status: MvpInterviewSession['status'],
  finalized = false,
): MvpInterviewSession {
  return {
    ...session(interviewId, finalized),
    status,
    endedAt: status === 'completed' ? T2 : null,
    finalizedAt: finalized ? T3 : null,
    transcript: [
      {
        turnId: `${interviewId}-question`,
        interviewId,
        sequenceNumber: 1,
        speaker: 'ai_interviewer',
        turnType: 'main_question',
        text: 'What happened?',
        occurredAt: T1,
        guideReference: null,
        interrupted: false,
      },
      {
        turnId: `${interviewId}-answer`,
        interviewId,
        sequenceNumber: 2,
        speaker: 'participant',
        turnType: 'participant_answer',
        text: 'We changed the production schedule.',
        occurredAt: T2,
        guideReference: null,
        interrupted: false,
      },
    ],
  };
}

function evaluationReport(interviewId: string, profileId: string) {
  const anchors = ([1, 2, 3, 4, 5, 6, 7] as const).map((score) => ({
    score,
    criterion: `Criterion ${String(score)}`,
  }));
  const profileItem = {
    itemId: 'item-1',
    dimensionId: 'dimension-1',
    name: 'Evidence quality',
    codingInstruction: 'Evaluate only observed participant evidence.',
    order: 0,
    anchors,
  };
  const profile = {
    profileId,
    name: 'Evaluation profile',
    description: '',
    coderPrompt: 'Code every item without inventing evidence.',
    scale: { minimum: 1, maximum: 7 },
    dimensions: [{ dimensionId: 'dimension-1', name: 'Evidence', order: 0 }],
    items: [profileItem],
  };
  const aggregate = {
    status: 'not_scored',
    score: null,
    scoredItemCount: 0,
    unscoredItemCount: 1,
    totalItemCount: 1,
  };
  return profileEvaluationReportSchema.parse({
    schemaVersion: 5,
    calculation: calculateProfileScores(profile, { 'item-1': null }).calculation,
    reportKind: 'evaluation_profile_report',
    evaluationId: 'evaluation-1',
    interviewId,
    profileId,
    profileName: profile.name,
    profileUpdatedAt: T0,
    profileFingerprint: PROFILE_FINGERPRINT,
    transcriptFingerprint: 'b'.repeat(64),
    promptVersion: 'profile-evidence-coding-v1',
    model: { mode: 'demo', provider: null, model: null },
    profile,
    dimensions: [
      {
        dimensionId: 'dimension-1',
        name: 'Evidence',
        order: 0,
        aggregate,
        items: [
          {
            ...profileItem,
            status: 'insufficient_evidence',
            score: null,
            appliedAnchor: null,
            confidence: 0.2,
            supportingEvidence: [],
            counterEvidence: [],
            missingInformation: ['No participant evidence was available.'],
            rationale: 'No score is assigned without evidence.',
          },
        ],
      },
    ],
    overallAggregate: aggregate,
    rationale: 'The report contains no invented evidence.',
    evaluatedAt: T3,
  });
}

function interviewIdFromUrl(url: string): string {
  const encoded = /\/interviews\/([^/]+)\/session$/u.exec(url)?.[1];
  if (encoded === undefined) throw new Error(`Unexpected session URL: ${url}`);
  return decodeURIComponent(encoded);
}

function queuedFetch(responses: readonly Response[]) {
  const queue = [...responses];
  return vi.fn<EvaluationProfilesFetch>(async () => {
    const response = queue.shift();
    if (response === undefined) throw new Error('Unexpected fetch call');
    return response;
  });
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(body), { ...init, headers });
}
