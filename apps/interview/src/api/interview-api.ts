import {
  apiErrorEnvelopeSchema,
  guideImportResponseSchema,
  interviewCreateResponseSchema,
  interviewDetailResponseSchema,
  MVP_REALTIME_CLIENT_PROTOCOL_HEADER,
  MVP_REALTIME_CLIENT_PROTOCOL_VERSION,
  mvpInterviewSessionSchema,
  mvpRealtimeAppendResponseSchema,
  mvpRealtimeCommandResponseSchema,
  mvpSessionCommandResponseSchema,
  voiceSessionResponseSchema,
  type ApiFieldError,
  type GuideImportResponse,
  type InterviewCreateResponse,
  type InterviewDetailResponse,
  type MvpInterviewSession,
  type MvpRealtimeAiTurnRequest,
  type MvpRealtimeAppendResponse,
  type MvpRealtimeCommandResponse,
  type MvpRealtimeGapRequest,
  type MvpRealtimeInterruptedAiTurnRequest,
  type MvpRealtimeTurnIntentRequest,
  type MvpPartialTranscriptRequest,
  type MvpSessionCommandResponse,
  type SupportedLocale,
  voiceDiagnosticSchema,
  type VoiceDiagnostic,
} from '@orgscience/contracts';
import { InterviewSettingsApiClient } from '@orgscience/api-client';

type VoiceSessionResponse = ReturnType<typeof voiceSessionResponseSchema.parse>;

const API_PATHS = Object.freeze({
  guides: '/api/v1/guides',
  interviews: '/api/v1/interviews',
  interview: (interviewId: string) => `/api/v1/interviews/${encodeURIComponent(interviewId)}`,
  session: (interviewId: string) => `/api/v1/interviews/${encodeURIComponent(interviewId)}/session`,
  start: (interviewId: string) => `/api/v1/interviews/${encodeURIComponent(interviewId)}/start`,
  pause: (interviewId: string) => `/api/v1/interviews/${encodeURIComponent(interviewId)}/pause`,
  resume: (interviewId: string) => `/api/v1/interviews/${encodeURIComponent(interviewId)}/resume`,
  end: (interviewId: string) => `/api/v1/interviews/${encodeURIComponent(interviewId)}/end`,
  turns: (interviewId: string) => `/api/v1/interviews/${encodeURIComponent(interviewId)}/turns`,
  partial: (interviewId: string) =>
    `/api/v1/interviews/${encodeURIComponent(interviewId)}/partial-transcript`,
  voiceSession: (interviewId: string) =>
    `/api/v1/interviews/${encodeURIComponent(interviewId)}/voice/session`,
  realtimeStart: (interviewId: string) =>
    `/api/v1/interviews/${encodeURIComponent(interviewId)}/realtime/start`,
  realtimeParticipantTurn: (interviewId: string) =>
    `/api/v1/interviews/${encodeURIComponent(interviewId)}/realtime/participant-turns`,
  realtimeRecoverParticipantTurn: (interviewId: string) =>
    `/api/v1/interviews/${encodeURIComponent(interviewId)}/realtime/recover-participant-turn`,
  realtimeTurnIntent: (interviewId: string) =>
    `/api/v1/interviews/${encodeURIComponent(interviewId)}/realtime/turn-intents`,
  realtimeAiTurn: (interviewId: string) =>
    `/api/v1/interviews/${encodeURIComponent(interviewId)}/realtime/ai-turns`,
  realtimeInterruptedAiTurn: (interviewId: string) =>
    `/api/v1/interviews/${encodeURIComponent(interviewId)}/realtime/ai-turns/interrupted`,
  realtimeGap: (interviewId: string) =>
    `/api/v1/interviews/${encodeURIComponent(interviewId)}/realtime/gaps`,
  realtimePendingPlan: (interviewId: string) =>
    `/api/v1/interviews/${encodeURIComponent(interviewId)}/realtime/pending-plan`,
  realtimeComplete: (interviewId: string) =>
    `/api/v1/interviews/${encodeURIComponent(interviewId)}/realtime/complete`,
});

export type InterviewAction = 'start' | 'pause' | 'resume' | 'end';

export interface ParticipantTextTurnRequest {
  readonly clientEventId: string;
  readonly text: string;
  readonly occurredAt: string;
}

export class InterviewApiError extends Error {
  public readonly kind: 'network' | 'http' | 'contract';
  public readonly status: number | null;
  public readonly code: string;
  public readonly retryable: boolean;
  public readonly fieldErrors: readonly ApiFieldError[];

  public constructor(input: {
    readonly kind: 'network' | 'http' | 'contract';
    readonly message: string;
    readonly status?: number;
    readonly code?: string;
    readonly retryable?: boolean;
    readonly fieldErrors?: readonly ApiFieldError[];
  }) {
    super(input.message);
    this.name = 'InterviewApiError';
    this.kind = input.kind;
    this.status = input.status ?? null;
    this.code = input.code ?? 'CLIENT_ERROR';
    this.retryable = input.retryable ?? false;
    this.fieldErrors = input.fieldErrors ?? [];
  }
}

export class InterviewApi {
  public readonly settings = new InterviewSettingsApiClient((path, schema, init) =>
    this.request(path, schema, init),
  );
  public constructor(private readonly baseUrl = defaultApiBaseUrl()) {}

  public async reportVoiceDiagnostic(
    interviewId: string,
    diagnostic: VoiceDiagnostic,
  ): Promise<void> {
    const response = await this.fetch(
      `/api/v1/interviews/${encodeURIComponent(interviewId)}/realtime/diagnostics`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(voiceDiagnosticSchema.parse(diagnostic)),
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!response.ok) throw new Error('Voice diagnostic could not be stored.');
  }

  public async importGuide(
    file: File,
    sourceLanguage: SupportedLocale,
  ): Promise<GuideImportResponse> {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('sourceLanguage', sourceLanguage);
    return this.request(API_PATHS.guides, guideImportResponseSchema, {
      method: 'POST',
      body: formData,
    });
  }

  public async createInterview(
    guideId: string,
    language: SupportedLocale,
  ): Promise<InterviewCreateResponse> {
    return this.request(API_PATHS.interviews, interviewCreateResponseSchema, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interviewId: crypto.randomUUID(), guideId, language }),
    });
  }

  public async getInterview(interviewId: string): Promise<InterviewDetailResponse> {
    return this.request(API_PATHS.interview(interviewId), interviewDetailResponseSchema);
  }

  public async getSession(interviewId: string): Promise<MvpInterviewSession> {
    return this.request(API_PATHS.session(interviewId), mvpInterviewSessionSchema);
  }

  public async performAction(
    interviewId: string,
    action: InterviewAction,
  ): Promise<MvpSessionCommandResponse> {
    const path = API_PATHS[action](interviewId);
    return this.request(path, mvpSessionCommandResponseSchema, { method: 'POST' });
  }

  public async submitParticipantTextTurn(
    interviewId: string,
    turn: ParticipantTextTurnRequest,
  ): Promise<MvpSessionCommandResponse> {
    return this.request(API_PATHS.turns(interviewId), mvpSessionCommandResponseSchema, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...turn, sourceProvider: 'text_input' }),
    });
  }

  public async startRealtimeInterview(interviewId: string): Promise<MvpRealtimeCommandResponse> {
    return this.request(API_PATHS.realtimeStart(interviewId), mvpRealtimeCommandResponseSchema, {
      method: 'POST',
    });
  }

  public async appendRealtimeParticipantTurn(
    interviewId: string,
    turn: ParticipantTextTurnRequest,
  ): Promise<MvpRealtimeAppendResponse> {
    return this.request(
      API_PATHS.realtimeParticipantTurn(interviewId),
      mvpRealtimeAppendResponseSchema,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...turn, sourceProvider: 'openai_realtime' }),
      },
    );
  }

  public async recoverRealtimeParticipantTurn(
    interviewId: string,
  ): Promise<MvpRealtimeCommandResponse> {
    return this.request(
      API_PATHS.realtimeRecoverParticipantTurn(interviewId),
      mvpRealtimeCommandResponseSchema,
      { method: 'POST' },
    );
  }

  public async reserveRealtimeTurnIntent(
    interviewId: string,
    intent: MvpRealtimeTurnIntentRequest,
  ): Promise<MvpRealtimeCommandResponse> {
    return this.request(
      API_PATHS.realtimeTurnIntent(interviewId),
      mvpRealtimeCommandResponseSchema,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(intent),
      },
    );
  }

  public async appendRealtimeAiTurn(
    interviewId: string,
    turn: MvpRealtimeAiTurnRequest,
  ): Promise<MvpRealtimeAppendResponse> {
    return this.request(API_PATHS.realtimeAiTurn(interviewId), mvpRealtimeAppendResponseSchema, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(turn),
    });
  }

  public async interruptRealtimeAiTurn(
    interviewId: string,
    turn: MvpRealtimeInterruptedAiTurnRequest,
  ): Promise<MvpRealtimeAppendResponse> {
    return this.request(
      API_PATHS.realtimeInterruptedAiTurn(interviewId),
      mvpRealtimeAppendResponseSchema,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(turn),
      },
    );
  }

  public async recordRealtimeGap(
    interviewId: string,
    gap: MvpRealtimeGapRequest,
  ): Promise<MvpRealtimeCommandResponse> {
    return this.request(API_PATHS.realtimeGap(interviewId), mvpRealtimeCommandResponseSchema, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(gap),
    });
  }

  public async getPendingRealtimePlan(interviewId: string): Promise<MvpRealtimeCommandResponse> {
    return this.request(
      API_PATHS.realtimePendingPlan(interviewId),
      mvpRealtimeCommandResponseSchema,
    );
  }

  public async completeRealtimeInterview(interviewId: string): Promise<MvpRealtimeCommandResponse> {
    return this.request(API_PATHS.realtimeComplete(interviewId), mvpRealtimeCommandResponseSchema, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ occurredAt: new Date().toISOString() }),
    });
  }

  public async updatePartialTranscript(
    interviewId: string,
    partial: MvpPartialTranscriptRequest,
  ): Promise<MvpInterviewSession> {
    return this.request(API_PATHS.partial(interviewId), mvpInterviewSessionSchema, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(partial),
    });
  }

  public async createVoiceSession(interviewId: string): Promise<VoiceSessionResponse> {
    return this.request(API_PATHS.voiceSession(interviewId), voiceSessionResponseSchema, {
      method: 'POST',
    });
  }

  private async request<T>(
    path: string,
    schema: {
      readonly safeParse: (value: unknown) => { success: true; data: T } | { success: false };
    },
    init?: RequestInit,
  ): Promise<T> {
    const response = await this.fetch(path, init);
    const payload = await readJson(response);
    if (!response.ok) throw apiErrorFromResponse(response, payload);
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new InterviewApiError({
        kind: 'contract',
        status: response.status,
        code: 'INVALID_RESPONSE',
        message: 'Die Serverantwort entspricht nicht dem erwarteten Datenvertrag.',
      });
    }
    return parsed.data;
  }

  private async fetch(path: string, init?: RequestInit): Promise<Response> {
    try {
      return await globalThis.fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Accept: 'application/json',
          ...init?.headers,
          [MVP_REALTIME_CLIENT_PROTOCOL_HEADER]: MVP_REALTIME_CLIENT_PROTOCOL_VERSION,
        },
      });
    } catch {
      throw new InterviewApiError({
        kind: 'network',
        code: 'NETWORK_ERROR',
        message: 'Das Backend ist derzeit nicht erreichbar.',
        retryable: true,
      });
    }
  }
}

function defaultApiBaseUrl(): string {
  const configured = import.meta.env.VITE_API_BASE_URL?.trim();
  if (configured === undefined || configured.length === 0) return '';
  return configured.endsWith('/') ? configured.slice(0, -1) : configured;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function apiErrorFromResponse(response: Response, payload: unknown): InterviewApiError {
  const parsed = apiErrorEnvelopeSchema.safeParse(payload);
  if (!parsed.success) {
    return new InterviewApiError({
      kind: 'http',
      status: response.status,
      code: 'HTTP_ERROR',
      message: `Die Anfrage ist fehlgeschlagen (HTTP ${String(response.status)}).`,
      retryable: response.status >= 500,
    });
  }
  return new InterviewApiError({
    kind: 'http',
    status: response.status,
    code: parsed.data.error.code,
    message: parsed.data.error.message,
    retryable: parsed.data.error.retryable,
    fieldErrors: parsed.data.error.fieldErrors,
  });
}

export const interviewApi = new InterviewApi();
