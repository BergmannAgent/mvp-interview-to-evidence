import {
  apiErrorEnvelopeSchema,
  interviewStateSchema,
  monitoringEventHistoryPageSchema,
  monitoringSnapshotResponseSchema,
  monitoringSnapshotSchema,
  type MonitoringEvent,
  type MonitoringSnapshot,
} from '@orgscience/contracts';
import type { InterviewGuideSnapshot } from '@orgscience/domain';
import { describe, expect, it, vi } from 'vitest';

import {
  failure,
  success,
  type ApplicationResult,
  type MonitoringEventStream,
  type MonitoringEventStreamRead,
} from '../../application/index.js';
import { createBackendHttpApp, type BackendHttpDependencies } from './app.js';

const NOW = '2026-08-12T10:30:00.000Z';
const INTERVIEW_ID = 'interview-monitoring-http-1';
const GUIDE_ID = 'guide-monitoring-http-1';

const guide: InterviewGuideSnapshot = {
  id: GUIDE_ID,
  sourceLanguage: 'de',
  title: 'Interviewleitfaden',
  sections: [
    {
      id: 'section-1',
      position: 0,
      title: 'Einfuehrung',
      mainQuestions: [
        {
          id: 'main-1',
          position: 0,
          text: 'Welche Rolle haben Sie?',
          followUpQuestions: [],
        },
      ],
    },
  ],
  sourceMarkdown: '# Interviewleitfaden',
  createdAt: NOW,
};

const interviewState = interviewStateSchema.parse({
  interviewId: INTERVIEW_ID,
  guideId: GUIDE_ID,
  lifecycle: { status: 'ready' },
  currentMainQuestion: null,
  coverage: [
    {
      question: {
        kind: 'main_question',
        guideId: GUIDE_ID,
        sectionId: 'section-1',
        mainQuestionId: 'main-1',
      },
      status: 'not_addressed',
      transcriptTurnIds: [],
    },
  ],
  activeWorkflowRunId: null,
  version: 0,
  createdAt: NOW,
  updatedAt: NOW,
});

const snapshot: MonitoringSnapshot = monitoringSnapshotSchema.parse({
  interviewGuide: { id: guide.id, title: guide.title, sections: guide.sections },
  interviewState,
  transcript: { interviewId: INTERVIEW_ID, guideId: GUIDE_ID, entries: [], finalizedAt: null },
  partialTranscriptions: [],
  finalTranscriptions: [],
  workflowRuns: [],
  workflowSteps: [],
  agentRuns: [],
  contradictions: [],
  finalization: null,
  liveState: { voiceState: 'idle', activeAiTextStream: null },
  eventSequence: 0,
  capturedAt: NOW,
});

class FiniteMonitoringStream implements MonitoringEventStream {
  public closeCalls = 0;

  public constructor(
    public readonly interviewId: string,
    public readonly initialAfterSequence: number,
    public readonly initialHighWaterSequence: number,
    private readonly reads: ApplicationResult<MonitoringEventStreamRead>[],
  ) {}

  public async read(): Promise<ApplicationResult<MonitoringEventStreamRead>> {
    return (
      this.reads.shift() ??
      success({
        status: 'closed',
        highWaterSequence: this.initialHighWaterSequence,
        reason: 'client_closed',
      })
    );
  }

  public close(): void {
    this.closeCalls += 1;
  }
}

describe('monitoring HTTP snapshot and SSE boundary', () => {
  it('returns the validated atomic monitoring snapshot', async () => {
    const execute = vi.fn(async () => success(snapshot));
    const response = await createBackendHttpApp(
      dependencies({ getMonitoringSnapshot: { execute } }),
    ).request(`/api/v1/interviews/${INTERVIEW_ID}/monitoring`);

    expect(response.status).toBe(200);
    expect(monitoringSnapshotResponseSchema.parse(await response.json())).toEqual({ snapshot });
    expect(execute).toHaveBeenCalledWith(INTERVIEW_ID);
  });

  it('returns a validated paginated event history for refresh recovery', async () => {
    const events = [event(2), event(3)];
    const execute = vi.fn(async () =>
      success({
        interviewId: INTERVIEW_ID,
        afterSequence: 1,
        highWaterSequence: 4,
        events,
        hasMore: true,
        nextAfterSequence: 3,
      }),
    );
    const response = await createBackendHttpApp(
      dependencies({ getMonitoringEventHistory: { execute } }),
    ).request(
      `/api/v1/interviews/${INTERVIEW_ID}/event-history?afterSequence=1&throughSequence=4&limit=2`,
    );

    expect(response.status).toBe(200);
    expect(monitoringEventHistoryPageSchema.parse(await response.json())).toEqual({
      interviewId: INTERVIEW_ID,
      afterSequence: 1,
      highWaterSequence: 4,
      events,
      hasMore: true,
      nextAfterSequence: 3,
    });
    expect(execute).toHaveBeenCalledWith({
      interviewId: INTERVIEW_ID,
      afterSequence: 1,
      throughSequence: 4,
      limit: 2,
    });
  });

  it('rejects duplicate event history cursors instead of accepting the first value', async () => {
    const execute = vi.fn();
    const response = await createBackendHttpApp(
      dependencies({ getMonitoringEventHistory: { execute } }),
    ).request(`/api/v1/interviews/${INTERVIEW_ID}/event-history?afterSequence=0&afterSequence=1`);

    expect(response.status).toBe(400);
    expect(apiErrorEnvelopeSchema.parse(await response.json()).error.code).toBe('VALIDATION_ERROR');
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects unknown event history query parameters at the HTTP boundary', async () => {
    const execute = vi.fn();
    const response = await createBackendHttpApp(
      dependencies({ getMonitoringEventHistory: { execute } }),
    ).request(`/api/v1/interviews/${INTERVIEW_ID}/event-history?unexpected=true`);

    expect(response.status).toBe(400);
    expect(apiErrorEnvelopeSchema.parse(await response.json()).error.code).toBe('VALIDATION_ERROR');
    expect(execute).not.toHaveBeenCalled();
  });

  it('uses Last-Event-ID ahead of the static query cursor and defaults to zero', async () => {
    const seen: number[] = [];
    const execute = vi.fn(async (input: { interviewId: string; afterSequence: number }) => {
      seen.push(input.afterSequence);
      return success(
        new FiniteMonitoringStream(input.interviewId, input.afterSequence, input.afterSequence, []),
      );
    });
    const app = createBackendHttpApp(dependencies({ openMonitoringEventStream: { execute } }));

    const initial = await app.request(`/api/v1/interviews/${INTERVIEW_ID}/events`);
    expect(initial.status).toBe(200);
    await initial.text();
    const query = await app.request(`/api/v1/interviews/${INTERVIEW_ID}/events?afterSequence=3`);
    await query.text();
    const reconnect = await app.request(
      `/api/v1/interviews/${INTERVIEW_ID}/events?afterSequence=01`,
      { headers: { 'Last-Event-ID': '5' } },
    );
    const reconnectText = await reconnect.text();

    expect(seen).toEqual([0, 3, 5]);
    expect(reconnectText).toContain('"afterSequence":5');
    expect(reconnectText).not.toMatch(/^id:/mu);
  });

  it('rejects malformed, duplicate, and unknown cursors before opening a stream', async () => {
    const execute = vi.fn(async () => {
      throw new Error('Unexpected stream open');
    });
    const app = createBackendHttpApp(dependencies({ openMonitoringEventStream: { execute } }));
    const requests = [
      app.request(`/api/v1/interviews/${INTERVIEW_ID}/events?afterSequence=01`),
      app.request(`/api/v1/interviews/${INTERVIEW_ID}/events?afterSequence=1&afterSequence=2`),
      app.request(`/api/v1/interviews/${INTERVIEW_ID}/events?unknown=1`),
      app.request(`/api/v1/interviews/${INTERVIEW_ID}/events`, {
        headers: { 'Last-Event-ID': 'event-id' },
      }),
    ];

    for (const response of await Promise.all(requests)) {
      expect(response.status).toBe(400);
      expect(apiErrorEnvelopeSchema.parse(await response.json()).error.code).toBe(
        'VALIDATION_ERROR',
      );
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('maps stale and ahead cursors to an explicit snapshot reset before SSE starts', async () => {
    for (const code of ['monitoring_cursor_ahead', 'monitoring_cursor_stale'] as const) {
      const error =
        code === 'monitoring_cursor_ahead'
          ? {
              code,
              interviewId: INTERVIEW_ID,
              cursor: 5,
              highWaterSequence: 3,
            }
          : {
              code,
              interviewId: INTERVIEW_ID,
              cursor: 0,
              highWaterSequence: 100,
              maximumReplayEvents: 10,
            };
      const response = await createBackendHttpApp(
        dependencies({
          openMonitoringEventStream: { execute: async () => failure(error) },
        }),
      ).request(`/api/v1/interviews/${INTERVIEW_ID}/events`);

      expect(response.status).toBe(409);
      expect(apiErrorEnvelopeSchema.parse(await response.json()).error.code).toBe(
        'SNAPSHOT_RESET_REQUIRED',
      );
    }
  });

  it('preflights replay and emits contiguous events with sequence-based SSE IDs', async () => {
    const stream = new FiniteMonitoringStream(INTERVIEW_ID, 1, 3, [
      success({ status: 'events', events: [event(2), event(3)], highWaterSequence: 3 }),
    ]);
    const response = await createBackendHttpApp(
      dependencies({
        openMonitoringEventStream: { execute: async () => success(stream) },
      }),
    ).request(`/api/v1/interviews/${INTERVIEW_ID}/events?afterSequence=1`);
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(text).toMatch(/^event: ready$/mu);
    expect(text).toMatch(/^event: monitoring$/gmu);
    expect(text).toMatch(/^id: 2$/mu);
    expect(text).toMatch(/^id: 3$/mu);
    expect(text).not.toContain('id: event-');
    expect(stream.closeCalls).toBe(1);
  });

  it('returns reset before 200 when replay preflight detects persisted corruption', async () => {
    const stream = new FiniteMonitoringStream(INTERVIEW_ID, 0, 1, [
      failure({
        code: 'corrupt_data',
        resource: 'outbox_event',
        id: INTERVIEW_ID,
        reason: 'missing sequence',
      }),
    ]);
    const response = await createBackendHttpApp(
      dependencies({
        openMonitoringEventStream: { execute: async () => success(stream) },
      }),
    ).request(`/api/v1/interviews/${INTERVIEW_ID}/events`);

    expect(response.status).toBe(409);
    expect(apiErrorEnvelopeSchema.parse(await response.json()).error.code).toBe(
      'SNAPSHOT_RESET_REQUIRED',
    );
    expect(stream.closeCalls).toBe(1);
  });

  it('returns a retryable 503 when shutdown closes the replay preflight', async () => {
    const stream = new FiniteMonitoringStream(INTERVIEW_ID, 0, 1, [
      success({ status: 'closed', highWaterSequence: 1, reason: 'server_shutdown' }),
    ]);
    const response = await createBackendHttpApp(
      dependencies({
        openMonitoringEventStream: { execute: async () => success(stream) },
      }),
    ).request(`/api/v1/interviews/${INTERVIEW_ID}/events`);
    const error = apiErrorEnvelopeSchema.parse(await response.json()).error;

    expect(response.status).toBe(503);
    expect(error).toMatchObject({ code: 'SERVICE_UNAVAILABLE', retryable: true });
    expect(stream.closeCalls).toBe(1);
  });

  it('rejects a noncontiguous preflight page even when a custom stream adapter reports success', async () => {
    const stream = new FiniteMonitoringStream(INTERVIEW_ID, 0, 2, [
      success({ status: 'events', events: [event(2)], highWaterSequence: 2 }),
    ]);
    const response = await createBackendHttpApp(
      dependencies({
        openMonitoringEventStream: { execute: async () => success(stream) },
      }),
    ).request(`/api/v1/interviews/${INTERVIEW_ID}/events`);

    expect(response.status).toBe(409);
    expect(apiErrorEnvelopeSchema.parse(await response.json()).error.code).toBe(
      'SNAPSHOT_RESET_REQUIRED',
    );
    expect(stream.closeCalls).toBe(1);
  });

  it('contains post-start failures in an id-less fault frame without diagnostic leakage', async () => {
    const secret = 'postgresql://private:secret@database/interview';
    const stream: MonitoringEventStream = {
      interviewId: INTERVIEW_ID,
      initialAfterSequence: 4,
      initialHighWaterSequence: 4,
      read: async () => {
        throw new Error(secret);
      },
      close: vi.fn(),
    };
    const response = await createBackendHttpApp(
      dependencies({
        openMonitoringEventStream: { execute: async () => success(stream) },
      }),
    ).request(`/api/v1/interviews/${INTERVIEW_ID}/events?afterSequence=4`);
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).toContain('"reason":"storage_unavailable"');
    expect(text).not.toContain(secret);
    expect(text.match(/^id:/gmu)).toBeNull();
    expect(stream.close).toHaveBeenCalledOnce();
  });

  it('announces server shutdown with an id-less retryable fault before closing', async () => {
    const stream = new FiniteMonitoringStream(INTERVIEW_ID, 0, 0, [
      success({ status: 'closed', highWaterSequence: 0, reason: 'server_shutdown' }),
    ]);
    const response = await createBackendHttpApp(
      dependencies({
        openMonitoringEventStream: { execute: async () => success(stream) },
      }),
    ).request(`/api/v1/interviews/${INTERVIEW_ID}/events`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('event: fault');
    expect(body).toContain('"reason":"server_shutdown"');
    expect(body).toContain('"retryable":true');
    expect(body.match(/^id:/gmu)).toBeNull();
    expect(stream.closeCalls).toBe(1);
  });

  it('closes application subscriptions when the browser cancels the response body', async () => {
    let completeRead: ((result: ApplicationResult<MonitoringEventStreamRead>) => void) | undefined;
    const close = vi.fn(() => {
      completeRead?.(success({ status: 'closed', highWaterSequence: 0, reason: 'client_closed' }));
    });
    const stream: MonitoringEventStream = {
      interviewId: INTERVIEW_ID,
      initialAfterSequence: 0,
      initialHighWaterSequence: 0,
      read: () =>
        new Promise((resolvePromise) => {
          completeRead = resolvePromise;
        }),
      close,
    };
    const response = await createBackendHttpApp(
      dependencies({
        openMonitoringEventStream: { execute: async () => success(stream) },
      }),
    ).request(`/api/v1/interviews/${INTERVIEW_ID}/events`);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    if (reader === undefined) return;

    await reader.read();
    await reader.cancel();

    await vi.waitFor(() => {
      expect(close).toHaveBeenCalled();
    });
  });

  it('terminates an unconsumed SSE response after the configured write deadline', async () => {
    const close = vi.fn();
    const stream: MonitoringEventStream = {
      interviewId: INTERVIEW_ID,
      initialAfterSequence: 0,
      initialHighWaterSequence: 0,
      read: async () =>
        success({ status: 'closed', highWaterSequence: 0, reason: 'client_closed' }),
      close,
    };
    const response = await createBackendHttpApp(
      dependencies({
        openMonitoringEventStream: { execute: async () => success(stream) },
        monitoringStreamOptions: { writeTimeoutMs: 10 },
      }),
    ).request(`/api/v1/interviews/${INTERVIEW_ID}/events`);

    await vi.waitFor(
      () => {
        expect(close).toHaveBeenCalled();
      },
      { timeout: 250 },
    );
    await response.body?.cancel();
  });
});

function dependencies(overrides: Partial<BackendHttpDependencies> = {}): BackendHttpDependencies {
  return {
    allowedOrigins: ['http://localhost:5173'],
    clock: { now: () => NOW },
    readiness: { check: async () => 'ready' },
    importGuide: { execute: async () => success({ outcome: 'inserted', guide }) },
    getGuide: { execute: async () => success(guide) },
    createInterview: {
      execute: async () => success({ outcome: 'inserted', interviewState }),
    },
    getInterview: { execute: async () => success(interviewState) },
    listInterviews: { execute: async () => success({ interviews: [], nextCursor: null }) },
    getMonitoringSnapshot: { execute: async () => success(snapshot) },
    getMonitoringEventHistory: {
      execute: async ({ interviewId, afterSequence }) =>
        success({
          interviewId,
          afterSequence,
          highWaterSequence: afterSequence,
          events: [],
          hasMore: false,
          nextAfterSequence: null,
        }),
    },
    openMonitoringEventStream: {
      execute: async ({ interviewId, afterSequence }) =>
        success(new FiniteMonitoringStream(interviewId, afterSequence, afterSequence, [])),
    },
    ...overrides,
  };
}

function event(sequenceNumber: number): MonitoringEvent {
  return {
    eventId: `event-${String(sequenceNumber)}`,
    interviewId: INTERVIEW_ID,
    language: 'de',
    runId: `run-${String(sequenceNumber)}`,
    sequenceNumber,
    occurredAt: NOW,
    category: 'interview',
    type: 'interview.status_changed',
    payload: {
      previousStatus: sequenceNumber === 1 ? null : 'ready',
      nextStatus: 'ready',
      changedAt: NOW,
    },
  };
}
