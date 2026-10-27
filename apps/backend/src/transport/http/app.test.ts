import {
  API_ERROR_LIMITS,
  apiErrorEnvelopeSchema,
  guideImportResponseSchema,
  interviewCreateResponseSchema,
  interviewDetailResponseSchema,
  interviewStateSchema,
  interviewSummaryPageSchema,
  livenessResponseSchema,
  MVP_REALTIME_CLIENT_PROTOCOL_HEADER,
  MVP_REALTIME_CLIENT_PROTOCOL_VERSION,
  mvpInterviewSessionSchema,
  mvpRealtimeCommandResponseSchema,
  readinessResponseSchema,
  type InterviewState,
} from '@orgscience/contracts';
import {
  parseInterviewGuideMarkdown,
  toInterviewGuideSnapshot,
  type InterviewGuideSnapshot,
} from '@orgscience/domain';
import { describe, expect, it, vi } from 'vitest';

import {
  failure,
  success,
  VoiceProviderError,
  type CreateInterviewInput,
  type ImportGuideInput,
  type ListInterviewsInput,
} from '../../application/index.js';
import {
  createBackendHttpApp,
  MAXIMUM_JSON_REQUEST_BYTES,
  type BackendHttpDependencies,
} from './app.js';
import { MAXIMUM_GUIDE_REQUEST_BYTES } from './guide-upload.js';

const NOW = '2026-08-07T12:00:00.000Z';
const INTERVIEW_ID = 'interview-http-1';
const ALLOWED_ORIGIN = 'http://interview.example.test';
const REALTIME_BROWSER_HEADERS = {
  Origin: ALLOWED_ORIGIN,
  [MVP_REALTIME_CLIENT_PROTOCOL_HEADER]: MVP_REALTIME_CLIENT_PROTOCOL_VERSION,
} as const;
const GUIDE_MARKDOWN = `# Interviewleitfaden: Organizational Resilience

## Einfuehrung

### Hauptfrage
Welche Rolle haben Sie im Unternehmen?

#### Vertiefungsfragen

- Seit wann arbeiten Sie in dieser Position?
`;

describe('voice diagnostic ingestion', () => {
  const diagnostic = {
    diagnosticId: '469bcb17-c95c-4c44-bd28-1fb6c66fdf64',
    occurredAt: NOW,
    source: 'provider',
    eventType: 'error',
    code: 'rate_limit_exceeded',
    errorType: null,
    responseId: 'resp_test',
    providerEventId: 'event_test',
    message: 'Rate limited sk-secret123',
  };

  it('persists sanitized diagnostics and emits a structured Docker log', async () => {
    const recordVoiceDiagnostic = vi.fn(async () => undefined);
    const logger = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const app = createBackendHttpApp(
        createDependencies({ mvpSessions: createMvpSessions({ recordVoiceDiagnostic }) }),
      );
      const response = await app.request(
        `/api/v1/interviews/${INTERVIEW_ID}/realtime/diagnostics`,
        {
          method: 'POST',
          headers: { ...REALTIME_BROWSER_HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify(diagnostic),
        },
      );
      expect(response.status).toBe(204);
      expect(recordVoiceDiagnostic).toHaveBeenCalledWith(
        INTERVIEW_ID,
        expect.objectContaining({ message: 'Rate limited [secret]', responseId: 'resp_test' }),
      );
      expect(logger).toHaveBeenCalledWith(expect.stringContaining('voice.diagnostic'));
      expect(JSON.stringify(logger.mock.calls)).not.toContain('sk-secret123');
    } finally {
      logger.mockRestore();
    }
  });

  it('rejects arbitrary event payloads without persisting', async () => {
    const recordVoiceDiagnostic = vi.fn(async () => undefined);
    const app = createBackendHttpApp(
      createDependencies({ mvpSessions: createMvpSessions({ recordVoiceDiagnostic }) }),
    );
    const response = await app.request(`/api/v1/interviews/${INTERVIEW_ID}/realtime/diagnostics`, {
      method: 'POST',
      headers: { ...REALTIME_BROWSER_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...diagnostic, transcript: 'private' }),
    });
    expect(response.status).toBe(400);
    expect(recordVoiceDiagnostic).not.toHaveBeenCalled();
  });
});

describe('backend HTTP health boundary', () => {
  it('serves liveness without consulting database readiness', async () => {
    const readiness = { check: vi.fn(async () => 'ready' as const) };
    const response = await createBackendHttpApp(createDependencies({ readiness })).request(
      '/health/live',
    );

    expect(response.status).toBe(200);
    expect(livenessResponseSchema.parse(await response.json())).toEqual({
      status: 'ok',
      checkedAt: NOW,
    });
    expect(readiness.check).not.toHaveBeenCalled();
  });

  it('reports ready and contained not-ready dependency states', async () => {
    const readyResponse = await createBackendHttpApp(createDependencies()).request('/health/ready');
    expect(readyResponse.status).toBe(200);
    expect(readinessResponseSchema.parse(await readyResponse.json()).status).toBe('ready');

    const secret = 'postgresql://user:secret@database/interview';
    const unavailableResponse = await createBackendHttpApp(
      createDependencies({
        readiness: {
          check: async () => {
            throw new Error(secret);
          },
        },
      }),
    ).request('/health/ready');
    const bodyText = await unavailableResponse.text();
    expect(unavailableResponse.status).toBe(503);
    expect(readinessResponseSchema.parse(JSON.parse(bodyText))).toMatchObject({
      status: 'not_ready',
      checks: { database: 'not_ready' },
    });
    expect(bodyText).not.toContain(secret);
  });

  it('applies the explicit CORS allowlist and stable request IDs', async () => {
    const app = createBackendHttpApp(createDependencies());
    const allowed = await app.request('/health/live', {
      headers: { Origin: ALLOWED_ORIGIN, 'X-Request-Id': 'request-accepted-1' },
    });
    expect(allowed.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    expect(allowed.headers.get('x-request-id')).toBe('request-accepted-1');

    const disallowed = await app.request('/health/live', {
      headers: { Origin: 'https://untrusted.example.test', 'X-Request-Id': 'invalid request id' },
    });
    expect(disallowed.headers.get('access-control-allow-origin')).toBeNull();
    expect(disallowed.headers.get('x-request-id')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });
});

describe('Realtime recovery HTTP boundary', () => {
  it('reads pending Realtime recovery state through an explicit endpoint', async () => {
    const session = activeMvpSession();
    const recoverRealtimeParticipantTurn = vi.fn(async () => ({
      session,
      newAiTurns: [],
      nextAiTurn: null,
    }));
    const app = createBackendHttpApp(
      createDependencies({
        mvpSessions: createMvpSessions({ recoverRealtimeParticipantTurn }),
      }),
    );

    const response = await app.request(
      `/api/v1/interviews/${INTERVIEW_ID}/realtime/recover-participant-turn`,
      { method: 'POST', headers: REALTIME_BROWSER_HEADERS },
    );

    expect(response.status).toBe(200);
    expect(mvpRealtimeCommandResponseSchema.parse(await response.json())).toEqual({
      session,
      newAiTurns: [],
      nextAiTurn: null,
    });
    expect(recoverRealtimeParticipantTurn).toHaveBeenCalledExactlyOnceWith(INTERVIEW_ID);
  });

  it('validates and reserves a Realtime interviewer turn intent', async () => {
    const session = activeMvpSession();
    const reserveRealtimeTurnIntent = vi.fn(async () => ({
      session,
      newAiTurns: [],
      nextAiTurn: null,
    }));
    const app = createBackendHttpApp(
      createDependencies({
        mvpSessions: createMvpSessions({ reserveRealtimeTurnIntent }),
      }),
    );
    const intent = {
      clientEventId: 'intent-http-1',
      action: 'ask_main_question',
      questionId: 'question-http-1',
      spokenText: 'Welche Rolle haben Sie im Unternehmen?',
      answerDisposition: 'answered',
      missingAspect: null,
      requestedEvidenceType: null,
    } as const;

    const response = await app.request(`/api/v1/interviews/${INTERVIEW_ID}/realtime/turn-intents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...REALTIME_BROWSER_HEADERS },
      body: JSON.stringify(intent),
    });

    expect(response.status).toBe(200);
    expect(mvpRealtimeCommandResponseSchema.parse(await response.json())).toEqual({
      session,
      newAiTurns: [],
      nextAiTurn: null,
    });
    expect(reserveRealtimeTurnIntent).toHaveBeenCalledExactlyOnceWith(INTERVIEW_ID, intent);
  });

  it('rejects a Realtime interviewer turn containing multiple questions', async () => {
    const reserveRealtimeTurnIntent = vi.fn();
    const app = createBackendHttpApp(
      createDependencies({
        mvpSessions: createMvpSessions({ reserveRealtimeTurnIntent }),
      }),
    );

    const response = await app.request(`/api/v1/interviews/${INTERVIEW_ID}/realtime/turn-intents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientEventId: 'intent-http-2',
        action: 'ask_main_question',
        questionId: 'question-http-1',
        spokenText: 'Was ist passiert? Und wer war beteiligt?',
        answerDisposition: 'answered',
        missingAspect: null,
        requestedEvidenceType: null,
      }),
    });

    expect(response.status).toBe(400);
    expect(reserveRealtimeTurnIntent).not.toHaveBeenCalled();
  });

  it('rejects an invalid interview ID before invoking recovery', async () => {
    const recoverRealtimeParticipantTurn = vi.fn();
    const app = createBackendHttpApp(
      createDependencies({
        mvpSessions: createMvpSessions({ recoverRealtimeParticipantTurn }),
      }),
    );

    const response = await app.request(
      '/api/v1/interviews/not%20valid/realtime/recover-participant-turn',
      {
        method: 'POST',
      },
    );

    expect(response.status).toBe(400);
    expect(recoverRealtimeParticipantTurn).not.toHaveBeenCalled();
  });

  it.each([null, '1'])('blocks a browser using stale Realtime protocol %s', async (version) => {
    const recoverRealtimeParticipantTurn = vi.fn();
    const app = createBackendHttpApp(
      createDependencies({
        mvpSessions: createMvpSessions({ recoverRealtimeParticipantTurn }),
      }),
    );
    const headers: Record<string, string> = { Origin: ALLOWED_ORIGIN };
    if (version !== null) headers[MVP_REALTIME_CLIENT_PROTOCOL_HEADER] = version;

    const response = await app.request(
      `/api/v1/interviews/${INTERVIEW_ID}/realtime/recover-participant-turn`,
      { method: 'POST', headers },
    );

    expect(response.status).toBe(409);
    expect(apiErrorEnvelopeSchema.parse(await response.json()).error).toMatchObject({
      code: 'CLIENT_UPDATE_REQUIRED',
      message: 'Diese Browser-Ansicht ist veraltet. Bitte laden Sie die Seite neu.',
    });
    expect(recoverRealtimeParticipantTurn).not.toHaveBeenCalled();
  });
});

describe('Realtime voice session boundary', () => {
  it('returns a stable configuration code for a missing Voice key', async () => {
    const app = createBackendHttpApp(
      createDependencies({
        mvpSessions: createMvpSessions({
          getRealtimeContext: async () => ({
            session: activeMvpSession('en'),
            guide: guideSnapshot(),
          }),
        }),
        voiceConfigurationError: new VoiceProviderError(
          'missing_api_key',
          'configuration',
          'OPENAI_API_KEY is required for voice mode.',
          false,
        ),
      }),
    );

    const response = await app.request(`/api/v1/interviews/${INTERVIEW_ID}/voice/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(503);
    expect(apiErrorEnvelopeSchema.parse(await response.json()).error).toMatchObject({
      code: 'VOICE_CONFIGURATION_MISSING',
      message: 'OpenAI Voice is not configured.',
      retryable: false,
    });
  });

  it('returns a distinct public code without exposing malformed Voice configuration details', async () => {
    const internalDetail = 'Invalid OpenAI voice configuration containing private server detail';
    const app = createBackendHttpApp(
      createDependencies({
        mvpSessions: createMvpSessions({
          getRealtimeContext: async () => ({
            session: activeMvpSession('de'),
            guide: guideSnapshot(),
          }),
        }),
        voiceConfigurationError: new VoiceProviderError(
          'invalid_request',
          'configuration',
          internalDetail,
          false,
        ),
      }),
    );

    const response = await app.request(`/api/v1/interviews/${INTERVIEW_ID}/voice/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const responseBody = await response.json();

    expect(response.status).toBe(503);
    expect(apiErrorEnvelopeSchema.parse(responseBody).error).toEqual(
      expect.objectContaining({
        code: 'VOICE_CONFIGURATION_INVALID',
        message: 'OpenAI Voice configuration is invalid.',
        retryable: false,
      }),
    );
    expect(JSON.stringify(responseBody)).not.toContain(internalDetail);
  });

  it('blocks a stale browser before creating a provider secret', async () => {
    const getRealtimeContext = vi.fn();
    const createRealtimeInterviewSecret = vi.fn();
    const app = createBackendHttpApp(
      createDependencies({
        mvpSessions: createMvpSessions({ getRealtimeContext }),
        voiceGateway: { createRealtimeInterviewSecret },
      }),
    );

    const response = await app.request(`/api/v1/interviews/${INTERVIEW_ID}/voice/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ALLOWED_ORIGIN },
      body: JSON.stringify({ language: 'de' }),
    });

    expect(response.status).toBe(409);
    expect(apiErrorEnvelopeSchema.parse(await response.json()).error.code).toBe(
      'CLIENT_UPDATE_REQUIRED',
    );
    expect(getRealtimeContext).not.toHaveBeenCalled();
    expect(createRealtimeInterviewSecret).not.toHaveBeenCalled();
  });

  it('supplies the Realtime interviewer with stable guide IDs and transcript context', async () => {
    const guide = guideSnapshot();
    const session = activeMvpSession();
    const createRealtimeInterviewSecret = vi.fn(
      async (input: {
        readonly instructions: string;
        readonly interviewId: string;
        readonly language?: string;
        readonly signal?: AbortSignal;
      }) => {
        expect(input.language).toBe('de');
        expect(input.instructions).toContain('plan_interview_turn');
        expect(input.instructions).toContain('wissenschaftliches Experteninterview auf Deutsch');
        expect(input.instructions).toContain(guide.sections[0]?.mainQuestions[0]?.id);
        expect(input.instructions).toContain('GUIDE_DATA');
        expect(input.instructions).toContain('TRANSCRIPT_DATA');
        expect(input.instructions).toContain('answerDisposition');
        expect(input.instructions).toContain('Seit drei Jahren');
        expect(input.instructions).toContain('Allgemeine Saetze');
        expect(input.instructions).toContain('hoechstens drei unterschiedliche Klaerungsfragen');
        expect(input.instructions).toContain('repeat_question');
        return {
          value: 'ephemeral-secret',
          expiresAt: 1_800_000_000,
          sessionId: 'realtime-session-http',
          model: 'gpt-realtime-2.1',
        };
      },
    );
    const app = createBackendHttpApp(
      createDependencies({
        mvpSessions: createMvpSessions({
          getRealtimeContext: async () => ({ session, guide }),
        }),
        voiceGateway: { createRealtimeInterviewSecret },
      }),
    );

    const response = await app.request(`/api/v1/interviews/${INTERVIEW_ID}/voice/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language: 'de' }),
    });

    expect(response.status).toBe(200);
    expect(createRealtimeInterviewSecret).toHaveBeenCalledOnce();
  });

  it('derives English voice configuration and instructions from the persisted interview', async () => {
    const guide = guideSnapshot();
    const session = activeMvpSession('en');
    const createRealtimeInterviewSecret = vi.fn(
      async (input: {
        readonly instructions: string;
        readonly interviewId: string;
        readonly language?: string;
      }) => {
        expect(input.language).toBe('en');
        expect(input.instructions).toContain('natural, scientific expert interview in English');
        expect(input.instructions).toContain('Could you elaborate?');
        expect(input.instructions).toContain('already-answered feedback');
        expect(input.instructions).toContain('"language":"en"');
        expect(input.instructions).not.toContain(
          'wissenschaftliches Experteninterview auf Deutsch',
        );
        return {
          value: 'ephemeral-secret',
          expiresAt: 1_800_000_000,
          sessionId: 'realtime-session-http-en',
          model: 'gpt-realtime-2.1',
        };
      },
    );
    const app = createBackendHttpApp(
      createDependencies({
        mvpSessions: createMvpSessions({
          getRealtimeContext: async () => ({ session, guide }),
        }),
        voiceGateway: { createRealtimeInterviewSecret },
      }),
    );

    const response = await app.request(`/api/v1/interviews/${INTERVIEW_ID}/voice/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(200);
    expect(createRealtimeInterviewSecret).toHaveBeenCalledOnce();
  });

  it('rejects a client voice language that differs from the persisted interview', async () => {
    const createRealtimeInterviewSecret = vi.fn();
    const app = createBackendHttpApp(
      createDependencies({
        mvpSessions: createMvpSessions({
          getRealtimeContext: async () => ({
            session: activeMvpSession('en'),
            guide: guideSnapshot(),
          }),
        }),
        voiceGateway: { createRealtimeInterviewSecret },
      }),
    );

    const response = await app.request(`/api/v1/interviews/${INTERVIEW_ID}/voice/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language: 'de' }),
    });

    expect(response.status).toBe(409);
    expect(apiErrorEnvelopeSchema.parse(await response.json()).error).toMatchObject({
      code: 'INTERVIEW_STATE_CONFLICT',
    });
    expect(createRealtimeInterviewSecret).not.toHaveBeenCalled();
  });
});

describe('guide HTTP boundary', () => {
  it('imports one UTF-8 Markdown file and preserves idempotent status', async () => {
    const guide = guideSnapshot();
    const execute = vi.fn(async (input: ImportGuideInput) => {
      expect(input).toEqual({ markdown: GUIDE_MARKDOWN, sourceLanguage: 'de' });
      return success({ outcome: 'inserted' as const, guide });
    });
    const formData = new FormData();
    formData.append('file', new File([GUIDE_MARKDOWN], 'guide.md', { type: 'text/markdown' }));

    const response = await createBackendHttpApp(
      createDependencies({ importGuide: { execute } }),
    ).request('/api/v1/guides', { method: 'POST', body: formData });

    expect(response.status).toBe(201);
    expect(guideImportResponseSchema.parse(await response.json())).toEqual({
      outcome: 'inserted',
      interviewGuide: guide,
    });
    expect(execute).toHaveBeenCalledOnce();

    const existingForm = new FormData();
    existingForm.append('file', new File([GUIDE_MARKDOWN], 'guide.md', { type: 'text/plain' }));
    const existing = await createBackendHttpApp(
      createDependencies({
        importGuide: {
          execute: async () => success({ outcome: 'existing', guide }),
        },
      }),
    ).request('/api/v1/guides', { method: 'POST', body: existingForm });
    expect(existing.status).toBe(200);
    expect(guideImportResponseSchema.parse(await existing.json()).outcome).toBe('existing');
  });

  it('accepts browser Markdown files without MIME metadata and generic binary MIME metadata', async () => {
    const execute = vi.fn(async () =>
      success({ outcome: 'inserted' as const, guide: guideSnapshot() }),
    );
    const app = createBackendHttpApp(createDependencies({ importGuide: { execute } }));

    for (const type of ['', 'application/octet-stream']) {
      const body = new FormData();
      body.append('file', new File([GUIDE_MARKDOWN], 'guide.md', { type }));
      const response = await app.request('/api/v1/guides', { method: 'POST', body });
      expect(response.status).toBe(201);
    }

    const maximumBody = new FormData();
    maximumBody.append(
      'file',
      new File(['x'.repeat(1_000_000)], 'guide.md', { type: 'text/markdown' }),
    );
    const maximumResponse = await app.request('/api/v1/guides', {
      method: 'POST',
      body: maximumBody,
    });
    expect(maximumResponse.status).toBe(201);

    expect(execute).toHaveBeenCalledTimes(3);
  });

  it.each([
    { label: 'declared content length', includeLength: true },
    { label: 'streamed request body', includeLength: false },
  ])(
    'rejects an oversized $label before parsing or application execution',
    async ({ includeLength }) => {
      const execute = vi.fn(async () =>
        success({ outcome: 'inserted' as const, guide: guideSnapshot() }),
      );
      const headers: Record<string, string> = {
        'Content-Type': 'multipart/form-data; boundary=oversized',
      };
      if (includeLength) headers['Content-Length'] = String(MAXIMUM_GUIDE_REQUEST_BYTES + 1);

      const response = await createBackendHttpApp(
        createDependencies({ importGuide: { execute } }),
      ).request('/api/v1/guides', {
        method: 'POST',
        headers,
        body: includeLength ? 'x' : 'x'.repeat(MAXIMUM_GUIDE_REQUEST_BYTES + 1),
      });

      expect(response.status).toBe(413);
      expect(apiErrorEnvelopeSchema.parse(await response.json()).error).toMatchObject({
        code: 'INVALID_REQUEST',
        fieldErrors: [{ path: ['body'], code: 'body_too_large' }],
      });
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('rejects disallowed browser origins before reading a mutating request', async () => {
    const execute = vi.fn(async () =>
      success({ outcome: 'inserted' as const, guide: guideSnapshot() }),
    );
    const app = createBackendHttpApp(createDependencies({ importGuide: { execute } }));

    for (const origin of ['https://untrusted.example.test', 'null']) {
      const body = new FormData();
      body.append('file', new File([GUIDE_MARKDOWN], 'guide.md'));
      const response = await app.request('/api/v1/guides', {
        method: 'POST',
        headers: { Origin: origin },
        body,
      });
      expect(response.status).toBe(403);
      expect(apiErrorEnvelopeSchema.parse(await response.json()).error.code).toBe('FORBIDDEN');
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    }

    expect(execute).not.toHaveBeenCalled();

    const allowedBody = new FormData();
    allowedBody.append('file', new File([GUIDE_MARKDOWN], 'guide.md'));
    const allowed = await app.request('/api/v1/guides', {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN },
      body: allowedBody,
    });
    expect(allowed.status).toBe(201);
    expect(allowed.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    expect(execute).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: 'missing multipart body',
      request: () => ({ method: 'POST', body: 'not multipart' }),
      expectedStatus: 415,
    },
    {
      label: 'missing file field',
      request: () => {
        const body = new FormData();
        body.append('other', 'value');
        return { method: 'POST', body };
      },
      expectedStatus: 400,
    },
    {
      label: 'invalid extension',
      request: () => {
        const body = new FormData();
        body.append('file', new File([GUIDE_MARKDOWN], 'guide.txt', { type: 'text/plain' }));
        return { method: 'POST', body };
      },
      expectedStatus: 400,
    },
    {
      label: 'invalid file media type',
      request: () => {
        const body = new FormData();
        body.append('file', new File([GUIDE_MARKDOWN], 'guide.md', { type: 'application/json' }));
        return { method: 'POST', body };
      },
      expectedStatus: 415,
    },
    {
      label: 'invalid UTF-8',
      request: () => {
        const body = new FormData();
        body.append('file', new File([new Uint8Array([0xff])], 'guide.md', { type: 'text/plain' }));
        return { method: 'POST', body };
      },
      expectedStatus: 400,
    },
    {
      label: 'oversized file',
      request: () => {
        const body = new FormData();
        body.append(
          'file',
          new File(['x'.repeat(1_000_001)], 'guide.md', { type: 'text/markdown' }),
        );
        return { method: 'POST', body };
      },
      expectedStatus: 413,
    },
  ])(
    'rejects $label before calling the application service',
    async ({ request, expectedStatus }) => {
      const execute = vi.fn(async () =>
        success({ outcome: 'inserted' as const, guide: guideSnapshot() }),
      );
      const response = await createBackendHttpApp(
        createDependencies({ importGuide: { execute } }),
      ).request('/api/v1/guides', request());

      expect(response.status).toBe(expectedStatus);
      expect(apiErrorEnvelopeSchema.safeParse(await response.json()).success).toBe(true);
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('rejects multiple files and returns parser issues as line-addressed fields', async () => {
    const multiple = new FormData();
    multiple.append('file', new File([GUIDE_MARKDOWN], 'one.md', { type: 'text/plain' }));
    multiple.append('file', new File([GUIDE_MARKDOWN], 'two.md', { type: 'text/plain' }));
    const multipleResponse = await createBackendHttpApp(createDependencies()).request(
      '/api/v1/guides',
      { method: 'POST', body: multiple },
    );
    expect(multipleResponse.status).toBe(400);

    const unexpectedFile = new FormData();
    unexpectedFile.append('file', new File([GUIDE_MARKDOWN], 'guide.md'));
    unexpectedFile.append('attachment', new File(['unrelated'], 'notes.txt'));
    const unexpectedFileResponse = await createBackendHttpApp(createDependencies()).request(
      '/api/v1/guides',
      { method: 'POST', body: unexpectedFile },
    );
    expect(unexpectedFileResponse.status).toBe(400);

    const invalid = new FormData();
    invalid.append('file', new File(['# Incomplete'], 'guide.md', { type: 'text/markdown' }));
    const parserResponse = await createBackendHttpApp(
      createDependencies({
        importGuide: {
          execute: async () =>
            failure({
              code: 'guide_invalid',
              issues: [
                {
                  line: 1,
                  code: 'NO_MAIN_QUESTION',
                  message: 'Der Leitfaden muss mindestens eine Hauptfrage enthalten.',
                },
              ],
            }),
        },
      }),
    ).request('/api/v1/guides', { method: 'POST', body: invalid });
    const error = apiErrorEnvelopeSchema.parse(await parserResponse.json());
    expect(parserResponse.status).toBe(422);
    expect(error.error).toMatchObject({
      code: 'GUIDE_INVALID',
      fieldErrors: [{ path: ['file', 'line', 1], code: 'NO_MAIN_QUESTION' }],
    });
  });

  it('keeps parser error responses bounded for adversarial valid-size uploads', async () => {
    const execute = async (input: ImportGuideInput) => {
      const parsed = parseInterviewGuideMarkdown(input.markdown);
      if (parsed.success) throw new Error('Expected the adversarial guide to be invalid');
      return failure({ code: 'guide_invalid' as const, issues: parsed.issues });
    };
    const app = createBackendHttpApp(createDependencies({ importGuide: { execute } }));

    const malformed = new FormData();
    malformed.append(
      'file',
      new File(
        [
          ['# Leitfaden', '## Abschnitt', ...Array.from({ length: 250 }, () => 'ungueltig')].join(
            '\n',
          ),
        ],
        'guide.md',
        { type: 'text/markdown' },
      ),
    );
    const malformedResponse = await app.request('/api/v1/guides', {
      method: 'POST',
      body: malformed,
    });
    const malformedError = apiErrorEnvelopeSchema.parse(await malformedResponse.json());
    expect(malformedResponse.status).toBe(422);
    expect(malformedError.error.fieldErrors).toHaveLength(100);
    expect(malformedError.error.fieldErrors.at(-1)?.code).toBe('TOO_MANY_ISSUES');

    const excessiveLines = new FormData();
    excessiveLines.append(
      'file',
      new File([`${'x'.repeat(47)}\n`.repeat(20_000)], 'guide.md', {
        type: 'text/markdown',
      }),
    );
    const lineResponse = await app.request('/api/v1/guides', {
      method: 'POST',
      body: excessiveLines,
    });
    const lineError = apiErrorEnvelopeSchema.parse(await lineResponse.json());
    expect(lineResponse.status).toBe(422);
    expect(lineError.error.fieldErrors).toEqual([
      expect.objectContaining({ code: 'TOO_MANY_LINES', path: ['file', 'line', 20_001] }),
    ]);
  });

  it('accepts exactly the field-error limit and truncates excess producer errors', async () => {
    for (const issueCount of [
      API_ERROR_LIMITS.maximumFieldErrors,
      API_ERROR_LIMITS.maximumFieldErrors + 1,
    ]) {
      const body = new FormData();
      body.append('file', new File(['# Invalid'], 'guide.md', { type: 'text/markdown' }));
      const response = await createBackendHttpApp(
        createDependencies({
          importGuide: {
            execute: async () =>
              failure({
                code: 'guide_invalid',
                issues: Array.from({ length: issueCount }, (_, index) => ({
                  line: index + 1,
                  code: 'UNEXPECTED_CONTENT' as const,
                  message: 'Diese Zeile ist nicht erlaubt.',
                })),
              }),
          },
        }),
      ).request('/api/v1/guides', { method: 'POST', body });
      const error = apiErrorEnvelopeSchema.parse(await response.json());

      expect(response.status).toBe(422);
      expect(error.error.fieldErrors).toHaveLength(API_ERROR_LIMITS.maximumFieldErrors);
    }
  });

  it('does not inspect guide parser errors beyond the central response limit', async () => {
    const issues = Array.from({ length: API_ERROR_LIMITS.maximumFieldErrors }, (_, index) => ({
      line: index + 1,
      code: 'UNEXPECTED_CONTENT' as const,
      message: 'Diese Zeile ist nicht erlaubt.',
    }));
    Object.defineProperty(issues, API_ERROR_LIMITS.maximumFieldErrors, {
      get: () => {
        throw new Error('The bounded response must not inspect this issue');
      },
    });
    issues.length = API_ERROR_LIMITS.maximumFieldErrors + 1;
    const body = new FormData();
    body.append('file', new File(['# Invalid'], 'guide.md', { type: 'text/markdown' }));

    const response = await createBackendHttpApp(
      createDependencies({
        importGuide: { execute: async () => failure({ code: 'guide_invalid', issues }) },
      }),
    ).request('/api/v1/guides', { method: 'POST', body });
    const error = apiErrorEnvelopeSchema.parse(await response.json());

    expect(response.status).toBe(422);
    expect(error.error.fieldErrors).toHaveLength(API_ERROR_LIMITS.maximumFieldErrors);
  });

  it('gets a guide and validates the path before application execution', async () => {
    const guide = guideSnapshot();
    const found = await createBackendHttpApp(createDependencies()).request(
      `/api/v1/guides/${guide.id}`,
    );
    expect(found.status).toBe(200);
    expect((await found.json()) as unknown).toEqual({ interviewGuide: guide });

    const invalid = await createBackendHttpApp(createDependencies()).request(
      '/api/v1/guides/not%20valid',
    );
    expect(invalid.status).toBe(400);
    expect(apiErrorEnvelopeSchema.parse(await invalid.json()).error.code).toBe('VALIDATION_ERROR');

    const missing = await createBackendHttpApp(
      createDependencies({
        getGuide: {
          execute: async (guideId) =>
            failure({ code: 'not_found', resource: 'guide', id: guideId }),
        },
      }),
    ).request('/api/v1/guides/missing-guide');
    expect(missing.status).toBe(404);
    expect(apiErrorEnvelopeSchema.parse(await missing.json()).error.code).toBe('NOT_FOUND');
  });
});

describe('interview HTTP boundary', () => {
  it('creates interviews with inserted and existing idempotency outcomes', async () => {
    const guide = guideSnapshot();
    const state = readyInterviewState(guide);
    const execute = vi.fn(async (input: CreateInterviewInput) => {
      expect(input).toEqual({ interviewId: INTERVIEW_ID, guideId: guide.id, language: 'de' });
      return success({ outcome: 'inserted' as const, interviewState: state });
    });
    const response = await createBackendHttpApp(
      createDependencies({ createInterview: { execute } }),
    ).request('/api/v1/interviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interviewId: INTERVIEW_ID, guideId: guide.id }),
    });
    expect(response.status).toBe(201);
    expect(interviewCreateResponseSchema.parse(await response.json())).toEqual({
      outcome: 'inserted',
      interviewState: state,
    });

    const existing = await createBackendHttpApp(
      createDependencies({
        createInterview: {
          execute: async () => success({ outcome: 'existing', interviewState: state }),
        },
      }),
    ).request('/api/v1/interviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interviewId: INTERVIEW_ID, guideId: guide.id }),
    });
    expect(existing.status).toBe(200);
    expect(interviewCreateResponseSchema.parse(await existing.json()).outcome).toBe('existing');
  });

  it('accepts only the exact JSON media type and enforces the JSON body limit', async () => {
    const guide = guideSnapshot();
    const execute = vi.fn(async () =>
      success({ outcome: 'inserted' as const, interviewState: readyInterviewState(guide) }),
    );
    const app = createBackendHttpApp(createDependencies({ createInterview: { execute } }));
    const body = JSON.stringify({ interviewId: INTERVIEW_ID, guideId: guide.id });

    const accepted = await app.request('/api/v1/interviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body,
    });
    expect(accepted.status).toBe(201);

    for (const contentType of ['application/jsonp', 'application/json-patch+json']) {
      const rejected = await app.request('/api/v1/interviews', {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body,
      });
      expect(rejected.status).toBe(415);
    }

    const oversized = await app.request('/api/v1/interviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: ' '.repeat(MAXIMUM_JSON_REQUEST_BYTES + 1),
    });
    expect(oversized.status).toBe(413);
    expect(apiErrorEnvelopeSchema.parse(await oversized.json()).error.code).toBe('INVALID_REQUEST');
    expect(execute).toHaveBeenCalledOnce();
  });

  it('rejects malformed and unknown JSON fields without invoking the application', async () => {
    const execute = vi.fn(async () =>
      success({
        outcome: 'inserted' as const,
        interviewState: readyInterviewState(guideSnapshot()),
      }),
    );
    const app = createBackendHttpApp(createDependencies({ createInterview: { execute } }));

    for (const body of [
      '{',
      JSON.stringify({ interviewId: INTERVIEW_ID }),
      JSON.stringify({ interviewId: INTERVIEW_ID, guideId: 'guide-1', unexpected: true }),
    ]) {
      const response = await app.request('/api/v1/interviews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      expect(response.status).toBe(400);
      expect(apiErrorEnvelopeSchema.safeParse(await response.json()).success).toBe(true);
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('normalizes oversized Zod diagnostics into the stable validation envelope', async () => {
    const execute = vi.fn(async () =>
      success({
        outcome: 'inserted' as const,
        interviewState: readyInterviewState(guideSnapshot()),
      }),
    );
    const unknownFields = Object.fromEntries(
      Array.from({ length: 120 }, (_, index) => [
        `unexpected_field_with_long_name_${String(index).padStart(3, '0')}`,
        true,
      ]),
    );

    const response = await createBackendHttpApp(
      createDependencies({ createInterview: { execute } }),
    ).request('/api/v1/interviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        interviewId: INTERVIEW_ID,
        guideId: guideSnapshot().id,
        ...unknownFields,
      }),
    });
    const error = apiErrorEnvelopeSchema.parse(await response.json());

    expect(response.status).toBe(400);
    expect(error.error.code).toBe('VALIDATION_ERROR');
    expect(error.error.fieldErrors).toHaveLength(1);
    expect(error.error.fieldErrors[0]?.message.length).toBe(
      API_ERROR_LIMITS.maximumFieldMessageCharacters,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('trims producer messages before applying the error-envelope length limit', async () => {
    const response = await createBackendHttpApp(
      createDependencies({
        createInterview: {
          execute: async () =>
            failure({
              code: 'application_validation',
              field: 'guideId',
              message: `${' '.repeat(API_ERROR_LIMITS.maximumFieldMessageCharacters)}x`,
            }),
        },
      }),
    ).request('/api/v1/interviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interviewId: INTERVIEW_ID, guideId: guideSnapshot().id }),
    });
    const error = apiErrorEnvelopeSchema.parse(await response.json());

    expect(response.status).toBe(400);
    expect(error.error.fieldErrors[0]?.message).toBe('x');
  });

  it('counts unrelated multipart file parts toward the transport body limit', async () => {
    const execute = vi.fn(async () =>
      success({ outcome: 'inserted' as const, guide: guideSnapshot() }),
    );
    const body = new FormData();
    body.append('file', new File([GUIDE_MARKDOWN], 'guide.md'));
    body.append('attachment', new File(['x'.repeat(MAXIMUM_GUIDE_REQUEST_BYTES)], 'unrelated.bin'));

    const response = await createBackendHttpApp(
      createDependencies({ importGuide: { execute } }),
    ).request('/api/v1/guides', { method: 'POST', body });

    expect(response.status).toBe(413);
    expect(apiErrorEnvelopeSchema.parse(await response.json()).error.code).toBe('INVALID_REQUEST');
    expect(execute).not.toHaveBeenCalled();
  });

  it('lists with normalized defaults and rejects invalid or unknown query values', async () => {
    const guide = guideSnapshot();
    const page = interviewPage(guide);
    const execute = vi.fn(async (input: ListInterviewsInput) => {
      expect(input).toEqual({ after: null, limit: 20 });
      return success(page);
    });
    const app = createBackendHttpApp(createDependencies({ listInterviews: { execute } }));
    const response = await app.request('/api/v1/interviews');
    expect(response.status).toBe(200);
    expect(interviewSummaryPageSchema.parse(await response.json())).toEqual(page);

    for (const query of ['?limit=0', '?limit=101', '?limit=1.5', '?unknown=value', '?after=']) {
      const invalid = await app.request(`/api/v1/interviews${query}`);
      expect(invalid.status).toBe(400);
    }
    expect(execute).toHaveBeenCalledOnce();
  });

  it('gets one guide-backed interview state and contains service failures', async () => {
    const state = readyInterviewState(guideSnapshot());
    const found = await createBackendHttpApp(createDependencies()).request(
      `/api/v1/interviews/${INTERVIEW_ID}`,
    );
    expect(found.status).toBe(200);
    expect(interviewDetailResponseSchema.parse(await found.json())).toEqual({
      interviewState: state,
    });

    const unavailable = await createBackendHttpApp(
      createDependencies({
        getInterview: {
          execute: async () => failure({ code: 'unavailable', retryable: true }),
        },
      }),
    ).request(`/api/v1/interviews/${INTERVIEW_ID}`);
    expect(unavailable.status).toBe(503);
    expect(apiErrorEnvelopeSchema.parse(await unavailable.json()).error).toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      retryable: true,
    });
  });
});

describe('HTTP failure containment', () => {
  it('returns the canonical envelope for unknown routes and unhandled errors', async () => {
    const missing = await createBackendHttpApp(createDependencies()).request('/unknown');
    expect(missing.status).toBe(404);
    expect(apiErrorEnvelopeSchema.parse(await missing.json()).error.code).toBe('NOT_FOUND');

    const secret = 'private-database-message';
    const onUnhandledError = vi.fn();
    const failed = await createBackendHttpApp(
      createDependencies({
        getInterview: {
          execute: async () => {
            throw new Error(secret);
          },
        },
        onUnhandledError,
      }),
    ).request(`/api/v1/interviews/${INTERVIEW_ID}`);
    const text = await failed.text();
    expect(failed.status).toBe(500);
    expect(apiErrorEnvelopeSchema.parse(JSON.parse(text)).error.code).toBe('INTERNAL_ERROR');
    expect(text).not.toContain(secret);
    expect(onUnhandledError).toHaveBeenCalledWith({
      requestId: expect.any(String),
      method: 'GET',
      path: `/api/v1/interviews/${INTERVIEW_ID}`,
      errorClass: 'error',
    });
  });

  it('maps internal repository constraint violations to a contained server error', async () => {
    const response = await createBackendHttpApp(
      createDependencies({
        listInterviews: {
          execute: async () =>
            failure({ code: 'constraint_violation', constraint: 'interview_summary_limit' }),
        },
      }),
    ).request('/api/v1/interviews');

    expect(response.status).toBe(500);
    expect(apiErrorEnvelopeSchema.parse(await response.json()).error.code).toBe('INTERNAL_ERROR');
  });
});

function createDependencies(
  overrides: Partial<BackendHttpDependencies> = {},
): BackendHttpDependencies {
  const guide = guideSnapshot();
  const interviewState = readyInterviewState(guide);
  return {
    allowedOrigins: [ALLOWED_ORIGIN],
    clock: { now: () => NOW },
    readiness: { check: async () => 'ready' },
    importGuide: {
      execute: async () => success({ outcome: 'inserted', guide }),
    },
    getGuide: { execute: async () => success(guide) },
    createInterview: {
      execute: async () => success({ outcome: 'inserted', interviewState }),
    },
    getInterview: { execute: async () => success(interviewState) },
    listInterviews: { execute: async () => success(interviewPage(guide)) },
    getMonitoringSnapshot: {
      execute: async () => {
        throw new Error('Unexpected monitoring snapshot request');
      },
    },
    getMonitoringEventHistory: {
      execute: async () => {
        throw new Error('Unexpected monitoring event history request');
      },
    },
    openMonitoringEventStream: {
      execute: async () => {
        throw new Error('Unexpected monitoring event stream request');
      },
    },
    ...overrides,
  };
}

type MvpSessions = NonNullable<BackendHttpDependencies['mvpSessions']>;

function createMvpSessions(overrides: Partial<MvpSessions> = {}): MvpSessions {
  const unexpected = async (): Promise<never> => {
    throw new Error('Unexpected MVP session request');
  };
  return {
    get: unexpected,
    start: unexpected,
    pause: unexpected,
    resume: unexpected,
    end: unexpected,
    submitParticipantTurn: unexpected,
    updatePartial: unexpected,
    getTurn: unexpected,
    getRealtimeContext: unexpected,
    startRealtime: unexpected,
    appendRealtimeParticipantTurn: unexpected,
    recoverRealtimeParticipantTurn: unexpected,
    reserveRealtimeTurnIntent: unexpected,
    appendRealtimeAiTurn: unexpected,
    interruptRealtimeAiTurn: unexpected,
    recordRealtimeGap: unexpected,
    getPendingRealtimePlan: unexpected,
    completeRealtimeInterview: unexpected,
    ...overrides,
  };
}

function activeMvpSession(language: 'de' | 'en' = 'de') {
  const guide = guideSnapshot();
  return mvpInterviewSessionSchema.parse({
    interviewId: INTERVIEW_ID,
    guideId: guide.id,
    language,
    guideTitle: guide.title,
    status: 'active',
    currentQuestionIndex: 0,
    totalQuestions: 2,
    currentQuestion: null,
    startedAt: NOW,
    endedAt: null,
    updatedAt: NOW,
    partialTranscript: null,
    transcript: [],
    technicalGaps: [],
    finalizedAt: null,
  });
}

function guideSnapshot(): InterviewGuideSnapshot {
  const parsed = parseInterviewGuideMarkdown(GUIDE_MARKDOWN);
  if (!parsed.success) {
    throw new Error('HTTP test guide must parse');
  }
  return toInterviewGuideSnapshot(parsed.guide, GUIDE_MARKDOWN, NOW);
}

function readyInterviewState(guide: InterviewGuideSnapshot): InterviewState {
  return interviewStateSchema.parse({
    interviewId: INTERVIEW_ID,
    guideId: guide.id,
    lifecycle: { status: 'ready' },
    currentMainQuestion: null,
    coverage: guide.sections.flatMap((section) =>
      section.mainQuestions.flatMap((mainQuestion) => [
        {
          question: {
            kind: 'main_question',
            guideId: guide.id,
            sectionId: section.id,
            mainQuestionId: mainQuestion.id,
          },
          status: 'not_addressed',
          transcriptTurnIds: [],
        },
        ...mainQuestion.followUpQuestions.map((followUp) => ({
          question: {
            kind: 'follow_up_question' as const,
            guideId: guide.id,
            sectionId: section.id,
            mainQuestionId: mainQuestion.id,
            followUpQuestionId: followUp.id,
          },
          status: 'not_addressed' as const,
          transcriptTurnIds: [],
        })),
      ]),
    ),
    activeWorkflowRunId: null,
    version: 0,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function interviewPage(guide: InterviewGuideSnapshot) {
  return interviewSummaryPageSchema.parse({
    interviews: [
      {
        interviewId: INTERVIEW_ID,
        guideId: guide.id,
        guideTitle: guide.title,
        status: 'ready',
        currentMainQuestionId: null,
        activeWorkflowRunId: null,
        createdAt: NOW,
        updatedAt: NOW,
        startedAt: null,
      },
    ],
    nextCursor: null,
  });
}
