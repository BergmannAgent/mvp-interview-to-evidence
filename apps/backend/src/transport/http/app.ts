import { randomUUID } from 'node:crypto';

import {
  guideImportResponseSchema,
  guideResponseSchema,
  idSchema,
  interviewCreateRequestSchema,
  interviewCreateResponseSchema,
  interviewDetailResponseSchema,
  interviewListQuerySchema,
  interviewSummaryPageSchema,
  livenessResponseSchema,
  MVP_REALTIME_CLIENT_PROTOCOL_HEADER,
  MVP_REALTIME_CLIENT_PROTOCOL_VERSION,
  readinessResponseSchema,
  mvpInterviewSessionSchema,
  mvpParticipantTurnRequestSchema,
  mvpPartialTranscriptRequestSchema,
  mvpRealtimeAiTurnRequestSchema,
  mvpRealtimeAppendResponseSchema,
  mvpRealtimeCompleteRequestSchema,
  mvpRealtimeCommandResponseSchema,
  mvpRealtimeGapRequestSchema,
  mvpRealtimeInterruptedAiTurnRequestSchema,
  mvpRealtimeTurnIntentRequestSchema,
  mvpSessionCommandResponseSchema,
  voiceSessionRequestSchema,
  voiceSessionResponseSchema,
  voiceDiagnosticSchema,
  type VoiceDiagnostic,
  timestampSchema,
  type InterviewState,
  type InterviewListQuery,
  type InterviewSummaryPage,
  type MvpPartialTranscriptRequest,
  type MvpRealtimeAiTurnRequest,
  type MvpRealtimeAppendResponse,
  type MvpRealtimeCommandResponse,
  type MvpRealtimeGapRequest,
  type MvpRealtimeInterruptedAiTurnRequest,
  type MvpRealtimeTurnIntentRequest,
  type SectionMemory,
} from '@orgscience/contracts';
import type { InterviewGuideSnapshot } from '@orgscience/domain';
import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { z } from 'zod';
import type {
  MvpInterviewSession,
  MvpParticipantTurnRequest,
  MvpSessionCommandResponse,
  MvpTranscriptTurn,
} from '@orgscience/contracts';

import type {
  ApplicationResult,
  CreateInterviewInput,
  CreateInterviewOutput,
  ImportGuideInput,
  ImportGuideOutput,
  ListInterviewsInput,
} from '../../application/index.js';
import {
  createApiErrorResponse,
  createApplicationErrorResponse,
  type ErrorResponseClock,
  type HttpEnvironment,
} from './error-response.js';
import {
  MAXIMUM_GUIDE_REQUEST_BYTES,
  readGuideUpload,
  type GuideUploadError,
} from './guide-upload.js';
import { mediaTypeEssence } from './media-type.js';
import {
  registerEvaluationHttpRoutes,
  type EvaluationHttpRouteDependencies,
} from './evaluation-routes.js';
import {
  registerEvaluationProfileHttpRoutes,
  type EvaluationProfileHttpRouteDependencies,
} from './evaluation-profile-routes.js';
import {
  registerEvaluationProfileXlsxHttpRoutes,
  type EvaluationProfileXlsxHttpRouteDependencies,
} from './evaluation-profile-xlsx-routes.js';
import {
  registerMonitoringHttpRoutes,
  type MonitoringHttpRouteDependencies,
} from './monitoring-routes.js';
import { validationHook } from './validation-hook.js';
import { registerInterviewSettingsRoutes } from './interview-settings-routes.js';
import { registerInterviewManagementRoutes } from './interview-management-routes.js';
import type { ManageInterviewsService } from '../../application/interviews/manage-interviews.js';
import type { InterviewSettingsService } from '../../application/guides/interview-settings.js';
import {
  buildRealtimeInterviewInstructions,
  MvpSessionError,
  resolveInterviewLocale,
  VoiceProviderError,
  type VoiceGateway,
} from '../../application/index.js';

export const MAXIMUM_JSON_REQUEST_BYTES = 16_384;

export {
  DEFAULT_MONITORING_HTTP_STREAM_OPTIONS,
  type MonitoringHttpStreamOptions,
} from './monitoring-routes.js';

interface Executor<TInput, TOutput> {
  execute(input: TInput): Promise<ApplicationResult<TOutput>>;
}

interface DatabaseReadinessProbe {
  check(): Promise<'ready' | 'not_ready'>;
}

export interface BackendHttpDependencies extends MonitoringHttpRouteDependencies {
  readonly manageInterviews?: Pick<ManageInterviewsService, 'rename' | 'delete'>;
  readonly interviewSettings?: InterviewSettingsService;
  readonly allowedOrigins: readonly string[];
  readonly readiness: DatabaseReadinessProbe;
  readonly importGuide: Executor<ImportGuideInput, ImportGuideOutput>;
  readonly getGuide: Executor<string, InterviewGuideSnapshot>;
  readonly createInterview: Executor<CreateInterviewInput, CreateInterviewOutput>;
  readonly getInterview: Executor<string, InterviewState>;
  readonly listInterviews: Executor<ListInterviewsInput, InterviewSummaryPage>;
  readonly evaluation?: EvaluationHttpRouteDependencies['evaluation'];
  readonly evaluationProfiles?: EvaluationProfileHttpRouteDependencies['evaluationProfiles'];
  readonly evaluationProfileWorkbooks?: EvaluationProfileXlsxHttpRouteDependencies['workbooks'];
  readonly mvpSessions?: {
    recordVoiceDiagnostic?(interviewId: string, diagnostic: VoiceDiagnostic): Promise<void>;
    get(interviewId: string): Promise<MvpInterviewSession>;
    start(interviewId: string): Promise<MvpSessionCommandResponse>;
    pause(interviewId: string): Promise<MvpSessionCommandResponse>;
    resume(interviewId: string): Promise<MvpSessionCommandResponse>;
    end(interviewId: string): Promise<MvpSessionCommandResponse>;
    submitParticipantTurn(
      interviewId: string,
      input: MvpParticipantTurnRequest,
    ): Promise<MvpSessionCommandResponse>;
    updatePartial(
      interviewId: string,
      input: MvpPartialTranscriptRequest,
    ): Promise<MvpInterviewSession>;
    getTurn(interviewId: string, turnId: string): Promise<MvpTranscriptTurn>;
    getRealtimeContext(interviewId: string): Promise<{
      readonly session: MvpInterviewSession;
      readonly guide: InterviewGuideSnapshot;
      readonly sectionMemories?: readonly SectionMemory[];
    }>;
    startRealtime(interviewId: string): Promise<MvpRealtimeCommandResponse>;
    appendRealtimeParticipantTurn(
      interviewId: string,
      input: MvpParticipantTurnRequest,
    ): Promise<MvpRealtimeAppendResponse>;
    recoverRealtimeParticipantTurn(interviewId: string): Promise<MvpRealtimeCommandResponse>;
    reserveRealtimeTurnIntent(
      interviewId: string,
      input: MvpRealtimeTurnIntentRequest,
    ): Promise<MvpRealtimeCommandResponse>;
    appendRealtimeAiTurn(
      interviewId: string,
      input: MvpRealtimeAiTurnRequest,
    ): Promise<MvpRealtimeAppendResponse>;
    interruptRealtimeAiTurn(
      interviewId: string,
      input: MvpRealtimeInterruptedAiTurnRequest,
    ): Promise<MvpRealtimeAppendResponse>;
    recordRealtimeGap(
      interviewId: string,
      input: MvpRealtimeGapRequest,
    ): Promise<MvpRealtimeCommandResponse>;
    getPendingRealtimePlan(interviewId: string): Promise<MvpRealtimeCommandResponse>;
    completeRealtimeInterview(
      interviewId: string,
      endedAt?: string,
    ): Promise<MvpRealtimeCommandResponse>;
  };
  readonly voiceGateway?: VoiceGateway | null;
  readonly voiceConfigurationError?: unknown;
  readonly onUnhandledError?: (input: {
    readonly requestId: string;
    readonly method: string;
    readonly path: string;
    readonly errorClass: 'error' | 'non_error';
  }) => void;
}

const guideParamsSchema = z.strictObject({ guideId: idSchema });
const interviewParamsSchema = z.strictObject({ interviewId: idSchema });

export function createBackendHttpApp(dependencies: BackendHttpDependencies): Hono<HttpEnvironment> {
  const app = new Hono<HttpEnvironment>();

  app.use('*', async (context, next) => {
    const supplied = idSchema.safeParse(context.req.header('x-request-id'));
    const requestId = supplied.success ? supplied.data : randomUUID();
    context.set('requestId', requestId);
    context.header('X-Request-Id', requestId);
    await next();
  });
  app.use('/api/v1/*', async (context, next) => {
    if (isSafeHttpMethod(context.req.method)) {
      await next();
      return;
    }

    const origin = context.req.header('origin');
    // Origin-less requests are reserved for non-browser service and CLI clients.
    if (origin === undefined || dependencies.allowedOrigins.includes(origin)) {
      await next();
      return;
    }

    return createApiErrorResponse(context, dependencies.clock, {
      status: 403,
      code: 'FORBIDDEN',
      message: 'The request origin is not allowed.',
    });
  });
  app.use(
    '*',
    cors({
      origin: [...dependencies.allowedOrigins],
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: [
        'Content-Type',
        'Last-Event-ID',
        'X-Request-Id',
        MVP_REALTIME_CLIENT_PROTOCOL_HEADER,
      ],
      exposeHeaders: ['Content-Disposition', 'X-Request-Id'],
      maxAge: 600,
    }),
  );
  app.use('/api/v1/interviews/*', async (context, next) => {
    if (
      !requiresRealtimeClientProtocol(context.req.method, context.req.path) ||
      context.req.header('origin') === undefined
    ) {
      await next();
      return;
    }
    if (
      context.req.header(MVP_REALTIME_CLIENT_PROTOCOL_HEADER) ===
      MVP_REALTIME_CLIENT_PROTOCOL_VERSION
    ) {
      await next();
      return;
    }
    return createApiErrorResponse(context, dependencies.clock, {
      status: 409,
      code: 'CLIENT_UPDATE_REQUIRED',
      message: 'Diese Browser-Ansicht ist veraltet. Bitte laden Sie die Seite neu.',
    });
  });

  app.get('/health/live', (context) => {
    const response = livenessResponseSchema.parse({
      status: 'ok',
      checkedAt: safeClockNow(dependencies.clock),
    });
    return context.json(response, 200);
  });

  app.get('/health/ready', async (context) => {
    const database = await checkReadiness(dependencies.readiness);
    const response = readinessResponseSchema.parse({
      status: database === 'ready' ? 'ready' : 'not_ready',
      checkedAt: safeClockNow(dependencies.clock),
      checks: { database },
    });
    return database === 'ready' ? context.json(response, 200) : context.json(response, 503);
  });

  if (dependencies.interviewSettings !== undefined) {
    registerInterviewSettingsRoutes(app, dependencies.interviewSettings, dependencies.clock);
  }
  if (dependencies.manageInterviews !== undefined) {
    registerInterviewManagementRoutes(app, dependencies.manageInterviews, dependencies.clock);
  }

  app.post(
    '/api/v1/guides',
    bodyLimit({ maxSize: MAXIMUM_GUIDE_REQUEST_BYTES }),
    async (context) => {
      const upload = await readGuideUpload(context.req.raw);
      if (!upload.ok) {
        return guideUploadErrorResponse(context, dependencies.clock, upload.error);
      }

      const imported = await dependencies.importGuide.execute({
        markdown: upload.markdown,
        sourceLanguage: upload.sourceLanguage,
      });
      if (!imported.ok) {
        return createApplicationErrorResponse(context, dependencies.clock, imported.error);
      }
      const response = guideImportResponseSchema.parse({
        outcome: imported.value.outcome,
        interviewGuide: imported.value.guide,
      });
      return imported.value.outcome === 'inserted'
        ? context.json(response, 201)
        : context.json(response, 200);
    },
  );

  app.get(
    '/api/v1/guides/:guideId',
    zValidator<
      typeof guideParamsSchema,
      'param',
      HttpEnvironment,
      string,
      ReturnType<typeof validationHook>
    >('param', guideParamsSchema, validationHook(dependencies.clock)),
    async (context) => {
      const { guideId } = context.req.valid('param');
      const guide = await dependencies.getGuide.execute(guideId);
      if (!guide.ok) {
        return createApplicationErrorResponse(context, dependencies.clock, guide.error);
      }
      return context.json(guideResponseSchema.parse({ interviewGuide: guide.value }), 200);
    },
  );

  app.post(
    '/api/v1/interviews',
    bodyLimit({ maxSize: MAXIMUM_JSON_REQUEST_BYTES }),
    async (context, next) => {
      const contentType = mediaTypeEssence(context.req.header('content-type') ?? null);
      if (contentType !== 'application/json') {
        return createApiErrorResponse(context, dependencies.clock, {
          status: 415,
          code: 'INVALID_REQUEST',
          message: 'The request body must use application/json.',
          fieldErrors: [
            {
              path: ['body'],
              code: 'invalid_content_type',
              message: 'Content-Type must be application/json.',
            },
          ],
        });
      }
      try {
        await context.req.raw.clone().json();
      } catch {
        return createApiErrorResponse(context, dependencies.clock, {
          status: 400,
          code: 'INVALID_REQUEST',
          message: 'The JSON request body could not be read.',
          fieldErrors: [
            {
              path: ['body'],
              code: 'invalid_json',
              message: 'The request body is not valid JSON.',
            },
          ],
        });
      }
      return next();
    },
    zValidator<
      typeof interviewCreateRequestSchema,
      'json',
      HttpEnvironment,
      string,
      ReturnType<typeof validationHook>
    >('json', interviewCreateRequestSchema, validationHook(dependencies.clock)),
    async (context) => {
      const input = context.req.valid('json');
      const interview = await dependencies.createInterview.execute(input);
      if (!interview.ok) {
        return createApplicationErrorResponse(context, dependencies.clock, interview.error);
      }
      const response = interviewCreateResponseSchema.parse({
        outcome: interview.value.outcome,
        interviewState: interview.value.interviewState,
      });
      return interview.value.outcome === 'inserted'
        ? context.json(response, 201)
        : context.json(response, 200);
    },
  );

  app.get(
    '/api/v1/interviews',
    zValidator<
      typeof interviewListQuerySchema,
      'query',
      HttpEnvironment,
      string,
      ReturnType<typeof validationHook>
    >('query', interviewListQuerySchema, validationHook(dependencies.clock)),
    async (context) => {
      const query: InterviewListQuery = context.req.valid('query');
      const interviews = await dependencies.listInterviews.execute(query);
      if (!interviews.ok) {
        return createApplicationErrorResponse(context, dependencies.clock, interviews.error);
      }
      return context.json(interviewSummaryPageSchema.parse(interviews.value), 200);
    },
  );

  registerMonitoringHttpRoutes(app, dependencies);
  if (dependencies.evaluationProfiles !== undefined) {
    registerEvaluationProfileHttpRoutes(app, {
      clock: dependencies.clock,
      evaluationProfiles: dependencies.evaluationProfiles,
    });
  }
  if (dependencies.evaluationProfileWorkbooks !== undefined) {
    registerEvaluationProfileXlsxHttpRoutes(app, {
      clock: dependencies.clock,
      workbooks: dependencies.evaluationProfileWorkbooks,
    });
  }
  if (dependencies.evaluation !== undefined) {
    registerEvaluationHttpRoutes(app, {
      clock: dependencies.clock,
      evaluation: dependencies.evaluation,
    });
  }

  app.get('/api/v1/interviews/:interviewId/session', async (context) => {
    const interviewId = context.req.param('interviewId');
    if (!idSchema.safeParse(interviewId).success) {
      return createApiErrorResponse(context, dependencies.clock, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'The interview ID is invalid.',
      });
    }
    try {
      const session = await requireMvpSessions(dependencies).get(interviewId);
      return context.json(mvpInterviewSessionSchema.parse(session), 200);
    } catch (error: unknown) {
      return mvpErrorResponse(context, dependencies.clock, error);
    }
  });

  for (const action of ['start', 'pause', 'resume', 'end'] as const) {
    app.post(`/api/v1/interviews/:interviewId/${action}`, async (context) => {
      const interviewId = context.req.param('interviewId');
      if (!idSchema.safeParse(interviewId).success) {
        return createApiErrorResponse(context, dependencies.clock, {
          status: 400,
          code: 'VALIDATION_ERROR',
          message: 'The interview ID is invalid.',
        });
      }
      try {
        const response = await requireMvpSessions(dependencies)[action](interviewId);
        return context.json(mvpSessionCommandResponseSchema.parse(response), 200);
      } catch (error: unknown) {
        return mvpErrorResponse(context, dependencies.clock, error);
      }
    });
  }

  app.post('/api/v1/interviews/:interviewId/turns', async (context) => {
    const interviewId = context.req.param('interviewId');
    const parsedId = idSchema.safeParse(interviewId);
    const body = await readJsonBody(context.req.raw);
    const parsedBody = mvpParticipantTurnRequestSchema.safeParse(body);
    if (!parsedId.success || !parsedBody.success) {
      return createApiErrorResponse(context, dependencies.clock, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'The participant turn is invalid.',
      });
    }
    try {
      const response = await requireMvpSessions(dependencies).submitParticipantTurn(
        parsedId.data,
        parsedBody.data,
      );
      return context.json(mvpSessionCommandResponseSchema.parse(response), 200);
    } catch (error: unknown) {
      return mvpErrorResponse(context, dependencies.clock, error);
    }
  });

  app.post('/api/v1/interviews/:interviewId/partial-transcript', async (context) => {
    const interviewId = context.req.param('interviewId');
    const body = await readJsonBody(context.req.raw);
    const parsedBody = mvpPartialTranscriptRequestSchema.safeParse(body);
    if (!idSchema.safeParse(interviewId).success || !parsedBody.success) {
      return createApiErrorResponse(context, dependencies.clock, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'The partial transcript is invalid.',
      });
    }
    try {
      const session = await requireMvpSessions(dependencies).updatePartial(
        interviewId,
        parsedBody.data,
      );
      return context.json(mvpInterviewSessionSchema.parse(session), 200);
    } catch (error: unknown) {
      return mvpErrorResponse(context, dependencies.clock, error);
    }
  });

  app.post('/api/v1/interviews/:interviewId/realtime/diagnostics', async (context) => {
    const interviewId = context.req.param('interviewId');
    const parsed = voiceDiagnosticSchema.safeParse(await readJsonBody(context.req.raw));
    if (!idSchema.safeParse(interviewId).success || !parsed.success) {
      return createApiErrorResponse(context, dependencies.clock, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Invalid voice diagnostic.',
      });
    }
    try {
      const sessions = requireMvpSessions(dependencies);
      if (sessions.recordVoiceDiagnostic === undefined) {
        return context.body(null, 503);
      }
      await sessions.recordVoiceDiagnostic(interviewId, parsed.data);
      console.error(JSON.stringify({ event: 'voice.diagnostic', interviewId, ...parsed.data }));
      return context.body(null, 204);
    } catch (error: unknown) {
      return mvpErrorResponse(context, dependencies.clock, error);
    }
  });

  app.post('/api/v1/interviews/:interviewId/voice/session', async (context) => {
    const interviewId = context.req.param('interviewId');
    const body = await readJsonBody(context.req.raw);
    const parsed = voiceSessionRequestSchema.safeParse(body ?? {});
    if (!idSchema.safeParse(interviewId).success || !parsed.success) {
      return createApiErrorResponse(context, dependencies.clock, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'The voice session request is invalid.',
      });
    }
    try {
      const realtimeContext =
        await requireMvpSessions(dependencies).getRealtimeContext(interviewId);
      const interviewLanguage = resolveInterviewLocale(realtimeContext.session.language);
      if (parsed.data.language !== undefined && parsed.data.language !== interviewLanguage) {
        return createApiErrorResponse(context, dependencies.clock, {
          status: 409,
          code: 'INTERVIEW_STATE_CONFLICT',
          message: 'The requested voice language does not match the interview language.',
        });
      }
      const gateway = requireVoiceGateway(dependencies);
      const secret = await gateway.createRealtimeInterviewSecret({
        language: interviewLanguage,
        interviewId,
        instructions: buildRealtimeInterviewInstructions(realtimeContext),
      });
      return context.json(
        voiceSessionResponseSchema.parse({
          clientSecret: secret.value,
          expiresAt: secret.expiresAt,
          sessionId: secret.sessionId,
          model: secret.model,
        }),
        200,
      );
    } catch (error: unknown) {
      return voiceErrorResponse(context, dependencies.clock, error);
    }
  });

  app.post('/api/v1/interviews/:interviewId/realtime/start', async (context) => {
    const interviewId = context.req.param('interviewId');
    if (!idSchema.safeParse(interviewId).success) {
      return createApiErrorResponse(context, dependencies.clock, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'The interview ID is invalid.',
      });
    }
    try {
      const response = await requireMvpSessions(dependencies).startRealtime(interviewId);
      return context.json(mvpRealtimeCommandResponseSchema.parse(response), 200);
    } catch (error: unknown) {
      return mvpErrorResponse(context, dependencies.clock, error);
    }
  });

  app.post('/api/v1/interviews/:interviewId/realtime/participant-turns', async (context) => {
    const interviewId = context.req.param('interviewId');
    const parsed = mvpParticipantTurnRequestSchema.safeParse(await readJsonBody(context.req.raw));
    if (
      !idSchema.safeParse(interviewId).success ||
      !parsed.success ||
      parsed.data.sourceProvider !== 'openai_realtime'
    ) {
      return createApiErrorResponse(context, dependencies.clock, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'The Realtime participant turn is invalid.',
      });
    }
    try {
      const result = await requireMvpSessions(dependencies).appendRealtimeParticipantTurn(
        interviewId,
        parsed.data,
      );
      return context.json(mvpRealtimeAppendResponseSchema.parse(result), 200);
    } catch (error: unknown) {
      return mvpErrorResponse(context, dependencies.clock, error);
    }
  });

  app.post('/api/v1/interviews/:interviewId/realtime/turn-intents', async (context) => {
    const interviewId = context.req.param('interviewId');
    const parsed = mvpRealtimeTurnIntentRequestSchema.safeParse(
      await readJsonBody(context.req.raw),
    );
    if (!idSchema.safeParse(interviewId).success || !parsed.success) {
      return createApiErrorResponse(context, dependencies.clock, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'The Realtime interviewer turn intent is invalid.',
      });
    }
    try {
      const result = await requireMvpSessions(dependencies).reserveRealtimeTurnIntent(
        interviewId,
        parsed.data,
      );
      return context.json(mvpRealtimeCommandResponseSchema.parse(result), 200);
    } catch (error: unknown) {
      return mvpErrorResponse(context, dependencies.clock, error);
    }
  });

  app.post('/api/v1/interviews/:interviewId/realtime/recover-participant-turn', async (context) => {
    const interviewId = context.req.param('interviewId');
    if (!idSchema.safeParse(interviewId).success) {
      return createApiErrorResponse(context, dependencies.clock, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'The interview ID is invalid.',
      });
    }
    try {
      const result =
        await requireMvpSessions(dependencies).recoverRealtimeParticipantTurn(interviewId);
      return context.json(mvpRealtimeCommandResponseSchema.parse(result), 200);
    } catch (error: unknown) {
      return mvpErrorResponse(context, dependencies.clock, error);
    }
  });

  app.post('/api/v1/interviews/:interviewId/realtime/ai-turns', async (context) => {
    const interviewId = context.req.param('interviewId');
    const parsed = mvpRealtimeAiTurnRequestSchema.safeParse(await readJsonBody(context.req.raw));
    if (!idSchema.safeParse(interviewId).success || !parsed.success) {
      return createApiErrorResponse(context, dependencies.clock, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'The Realtime AI turn is invalid.',
      });
    }
    try {
      const result = await requireMvpSessions(dependencies).appendRealtimeAiTurn(
        interviewId,
        parsed.data,
      );
      return context.json(mvpRealtimeAppendResponseSchema.parse(result), 200);
    } catch (error: unknown) {
      return mvpErrorResponse(context, dependencies.clock, error);
    }
  });

  app.post('/api/v1/interviews/:interviewId/realtime/ai-turns/interrupted', async (context) => {
    const interviewId = context.req.param('interviewId');
    const parsed = mvpRealtimeInterruptedAiTurnRequestSchema.safeParse(
      await readJsonBody(context.req.raw),
    );
    if (!idSchema.safeParse(interviewId).success || !parsed.success) {
      return createApiErrorResponse(context, dependencies.clock, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'The interrupted Realtime AI turn is invalid.',
      });
    }
    try {
      const result = await requireMvpSessions(dependencies).interruptRealtimeAiTurn(
        interviewId,
        parsed.data,
      );
      return context.json(mvpRealtimeAppendResponseSchema.parse(result), 200);
    } catch (error: unknown) {
      return mvpErrorResponse(context, dependencies.clock, error);
    }
  });

  app.post('/api/v1/interviews/:interviewId/realtime/gaps', async (context) => {
    const interviewId = context.req.param('interviewId');
    const parsed = mvpRealtimeGapRequestSchema.safeParse(await readJsonBody(context.req.raw));
    if (!idSchema.safeParse(interviewId).success || !parsed.success) {
      return createApiErrorResponse(context, dependencies.clock, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'The Realtime transcript gap is invalid.',
      });
    }
    try {
      const result = await requireMvpSessions(dependencies).recordRealtimeGap(
        interviewId,
        parsed.data,
      );
      return context.json(mvpRealtimeCommandResponseSchema.parse(result), 200);
    } catch (error: unknown) {
      return mvpErrorResponse(context, dependencies.clock, error);
    }
  });

  app.get('/api/v1/interviews/:interviewId/realtime/pending-plan', async (context) => {
    const interviewId = context.req.param('interviewId');
    if (!idSchema.safeParse(interviewId).success) {
      return createApiErrorResponse(context, dependencies.clock, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'The interview ID is invalid.',
      });
    }
    try {
      const result = await requireMvpSessions(dependencies).getPendingRealtimePlan(interviewId);
      return context.json(mvpRealtimeCommandResponseSchema.parse(result), 200);
    } catch (error: unknown) {
      return mvpErrorResponse(context, dependencies.clock, error);
    }
  });

  app.post('/api/v1/interviews/:interviewId/realtime/complete', async (context) => {
    const interviewId = context.req.param('interviewId');
    const parsed = mvpRealtimeCompleteRequestSchema.safeParse(await readJsonBody(context.req.raw));
    if (!idSchema.safeParse(interviewId).success || !parsed.success) {
      return createApiErrorResponse(context, dependencies.clock, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'The Realtime completion is invalid.',
      });
    }
    try {
      const result = await requireMvpSessions(dependencies).completeRealtimeInterview(
        interviewId,
        parsed.data.occurredAt,
      );
      return context.json(mvpRealtimeCommandResponseSchema.parse(result), 200);
    } catch (error: unknown) {
      return mvpErrorResponse(context, dependencies.clock, error);
    }
  });

  app.get(
    '/api/v1/interviews/:interviewId',
    zValidator<
      typeof interviewParamsSchema,
      'param',
      HttpEnvironment,
      string,
      ReturnType<typeof validationHook>
    >('param', interviewParamsSchema, validationHook(dependencies.clock)),
    async (context) => {
      const { interviewId } = context.req.valid('param');
      const interview = await dependencies.getInterview.execute(interviewId);
      if (!interview.ok) {
        return createApplicationErrorResponse(context, dependencies.clock, interview.error);
      }
      return context.json(
        interviewDetailResponseSchema.parse({ interviewState: interview.value }),
        200,
      );
    },
  );

  app.notFound((context) =>
    createApiErrorResponse(context, dependencies.clock, {
      status: 404,
      code: 'NOT_FOUND',
      message: 'The requested route was not found.',
    }),
  );
  app.onError((error, context) => {
    if (error instanceof HTTPException && error.status === 413) {
      return createApiErrorResponse(context, dependencies.clock, {
        status: 413,
        code: 'INVALID_REQUEST',
        message: 'The request body exceeds the maximum allowed size.',
        fieldErrors: [
          {
            path: ['body'],
            code: 'body_too_large',
            message: 'The request body is too large.',
          },
        ],
      });
    }
    try {
      dependencies.onUnhandledError?.({
        requestId: context.get('requestId'),
        method: context.req.method,
        path: context.req.path,
        errorClass: error instanceof Error ? 'error' : 'non_error',
      });
    } catch {
      // Diagnostics must never replace the stable API error response.
    }
    return createApiErrorResponse(context, dependencies.clock, {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'The request could not be completed.',
    });
  });

  return app;
}

function isSafeHttpMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
}

function guideUploadErrorResponse(
  context: Parameters<typeof createApiErrorResponse>[0],
  clock: ErrorResponseClock,
  error: GuideUploadError,
): Response {
  switch (error.code) {
    case 'invalid_content_type':
    case 'invalid_file_type':
      return createApiErrorResponse(context, clock, {
        status: 415,
        code: 'INVALID_REQUEST',
        message: 'Upload one Markdown file using multipart field "file".',
        fieldErrors: [{ path: ['file'], code: error.code, message: 'Unsupported media type.' }],
      });
    case 'file_too_large':
      return createApiErrorResponse(context, clock, {
        status: 413,
        code: 'INVALID_REQUEST',
        message: 'The interview guide exceeds the maximum upload size.',
        fieldErrors: [
          {
            path: ['file'],
            code: error.code,
            message: 'The file must not exceed 1,000,000 bytes.',
          },
        ],
      });
    case 'invalid_multipart_body':
    case 'missing_file':
    case 'multiple_files':
    case 'invalid_file_name':
    case 'invalid_source_language':
    case 'invalid_text_encoding':
      return createApiErrorResponse(context, clock, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'The Markdown upload is invalid.',
        fieldErrors: [
          { path: ['file'], code: error.code, message: uploadErrorMessage(error.code) },
        ],
      });
  }
}

function uploadErrorMessage(code: GuideUploadError['code']): string {
  switch (code) {
    case 'invalid_multipart_body':
      return 'The multipart request body could not be read.';
    case 'missing_file':
      return 'Multipart field "file" must contain one Markdown file.';
    case 'multiple_files':
      return 'Multipart field "file" must contain exactly one file.';
    case 'invalid_file_name':
      return 'The uploaded filename must end in .md.';
    case 'invalid_source_language':
      return 'The guide source language must be de or en.';
    case 'invalid_text_encoding':
      return 'The uploaded Markdown must use valid UTF-8 encoding.';
    case 'invalid_content_type':
    case 'invalid_file_type':
      return 'The upload must use an allowed Markdown media type.';
    case 'file_too_large':
      return 'The uploaded Markdown is too large.';
  }
}

function requiresRealtimeClientProtocol(method: string, path: string): boolean {
  if (method === 'OPTIONS') return false;
  return path.endsWith('/voice/session') || path.includes('/realtime/');
}

function safeClockNow(clock: ErrorResponseClock): string {
  try {
    const now = timestampSchema.safeParse(clock.now());
    if (now.success) {
      return now.data;
    }
  } catch {
    // Health endpoints remain serializable even if a custom clock fails.
  }
  return new Date().toISOString();
}

async function checkReadiness(readiness: DatabaseReadinessProbe): Promise<'ready' | 'not_ready'> {
  try {
    return await readiness.check();
  } catch {
    return 'not_ready';
  }
}

function requireMvpSessions(dependencies: BackendHttpDependencies) {
  if (dependencies.mvpSessions === undefined) {
    throw new MvpSessionError('invalid_state', 'Interview sessions are not configured.');
  }
  return dependencies.mvpSessions;
}

function requireVoiceGateway(dependencies: BackendHttpDependencies): VoiceGateway {
  if (dependencies.voiceGateway !== null && dependencies.voiceGateway !== undefined) {
    return dependencies.voiceGateway;
  }
  if (dependencies.voiceConfigurationError instanceof VoiceProviderError) {
    throw dependencies.voiceConfigurationError;
  }
  throw new VoiceProviderError(
    'missing_api_key',
    'configuration',
    'OPENAI_API_KEY is required for voice mode.',
    false,
  );
}

function mvpErrorResponse(
  context: Parameters<typeof createApiErrorResponse>[0],
  clock: ErrorResponseClock,
  error: unknown,
): Response {
  if (error instanceof MvpSessionError) {
    const status = error.code === 'not_found' ? 404 : error.code === 'invalid_request' ? 400 : 409;
    return createApiErrorResponse(context, clock, {
      status,
      code:
        error.code === 'not_found'
          ? 'NOT_FOUND'
          : error.code === 'invalid_request'
            ? 'VALIDATION_ERROR'
            : 'INTERVIEW_STATE_CONFLICT',
      message: error.message,
    });
  }
  console.error(
    JSON.stringify({
      event: 'interview_session.unexpected_error',
      errorName: error instanceof Error ? error.name : 'UnknownError',
      errorMessage: error instanceof Error ? error.message : 'Unknown interview session error',
    }),
  );
  return createApiErrorResponse(context, clock, {
    status: 503,
    code: 'SERVICE_UNAVAILABLE',
    message: 'The interview session could not be persisted.',
    retryable: true,
  });
}

function voiceErrorResponse(
  context: Parameters<typeof createApiErrorResponse>[0],
  clock: ErrorResponseClock,
  error: unknown,
): Response {
  if (error instanceof VoiceProviderError) {
    if (error.operation === 'configuration') {
      const missingApiKey = error.code === 'missing_api_key';
      return createApiErrorResponse(context, clock, {
        status: 503,
        code: missingApiKey ? 'VOICE_CONFIGURATION_MISSING' : 'VOICE_CONFIGURATION_INVALID',
        message: missingApiKey
          ? 'OpenAI Voice is not configured.'
          : 'OpenAI Voice configuration is invalid.',
        retryable: false,
      });
    }
    return createApiErrorResponse(context, clock, {
      status: error.code === 'rate_limited' ? 503 : error.code === 'invalid_request' ? 400 : 503,
      code:
        error.code === 'missing_api_key'
          ? 'VOICE_CONFIGURATION_MISSING'
          : error.code === 'rate_limited'
            ? 'RATE_LIMITED'
            : 'PROVIDER_ERROR',
      message: error.message,
      retryable: error.retryable,
    });
  }
  return mvpErrorResponse(context, clock, error);
}

async function readJsonBody(request: Request): Promise<unknown> {
  try {
    const text = await request.text();
    return text.length === 0 ? {} : (JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}
