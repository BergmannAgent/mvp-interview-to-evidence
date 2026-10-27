import type { Hono } from 'hono';

import {
  CanonicalInterviewSessionService,
  CreateInterviewService,
  createDemoEvaluationCoder,
  createDemoInterviewAgentExecutor,
  EnsureDefaultEvaluationProfileService,
  EvaluationProfileService,
  EvaluationService,
  GetMonitoringEventHistoryService,
  GetGuideService,
  GetInterviewService,
  GetMonitoringSnapshotService,
  ImportGuideService,
  ListInterviewsService,
  localizeEvaluationProfile,
  OpenMonitoringEventStreamService,
} from '../application/index.js';
import { loadDatabaseConfig } from '../infrastructure/database/config.js';
import { PostgresPersistenceContextFactory } from '../infrastructure/database/persistence-context.js';
import { createDatabasePool } from '../infrastructure/database/pool.js';
import { checkDatabaseReadiness } from '../infrastructure/database/readiness.js';
import {
  createPgUnitOfWorkPool,
  PostgresUnitOfWork,
} from '../infrastructure/database/unit-of-work.js';
import {
  createPostgresOutboxNotificationListener,
  InMemoryRealtimeSignalHub,
} from '../infrastructure/realtime/index.js';
import { createBackendHttpApp, type BackendHttpDependencies } from '../transport/http/app.js';
import type { HttpEnvironment } from '../transport/http/error-response.js';
import { loadHttpRuntimeConfig, type HttpRuntimeConfig } from './http-config.js';
import { loadModelRuntimeConfig } from './model-config.js';
import { loadRealtimeRuntimeConfig } from './realtime-config.js';
import { NodeSha256, SystemClock } from './system-adapters.js';
import { loadOpenAiVoiceConfig, OpenAiVoiceGateway } from '../infrastructure/voice/index.js';
import {
  MastraEvaluationCoder,
  MastraInterviewAgentExecutor,
} from '../infrastructure/mastra/index.js';
import { loadOrganizationalResilienceEvaluationAssets } from '../infrastructure/research/index.js';
import { ExcelJsEvaluationProfileXlsxWorkbook } from '../infrastructure/evaluation-profiles/index.js';
import { InterviewSettingsService } from '../application/guides/interview-settings.js';
import { createInterviewDefaultsInitializer } from './interview-defaults.js';
import { ManageInterviewsService } from '../application/interviews/manage-interviews.js';

export interface RuntimeDiagnostics {
  databasePoolError(input: {
    readonly database: string;
    readonly errorClass: 'error' | 'non_error';
  }): void;
  unhandledHttpError(input: {
    readonly requestId: string;
    readonly method: string;
    readonly path: string;
    readonly errorClass: 'error' | 'non_error';
  }): void;
  realtimeListenerError(input: {
    readonly phase: 'connect' | 'listen' | 'runtime' | 'publisher' | 'close';
    readonly errorClass: 'error' | 'non_error';
  }): void;
}

export interface BackendComposition {
  readonly app: Hono<HttpEnvironment>;
  readonly http: HttpRuntimeConfig;
  beginShutdown(): void;
  close(): Promise<void>;
  forceClose(): void;
}

export function createBackendComposition(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  diagnostics: RuntimeDiagnostics = silentDiagnostics,
): BackendComposition {
  const http = loadHttpRuntimeConfig(environment);
  const databaseConfig = loadDatabaseConfig(environment);
  const realtimeConfig = loadRealtimeRuntimeConfig(environment);
  const modelConfig = loadModelRuntimeConfig(environment);
  const database = createDatabasePool(databaseConfig, {
    clientError: (input) => {
      diagnostics.databasePoolError(input);
    },
  });
  const unitOfWork = new PostgresUnitOfWork(
    createPgUnitOfWorkPool(database.pool),
    new PostgresPersistenceContextFactory(),
  );
  const clock = new SystemClock();
  const hasher = new NodeSha256();
  const importGuide = new ImportGuideService(unitOfWork, clock, hasher);
  const ensureInterviewDefaults = createInterviewDefaultsInitializer(unitOfWork, importGuide);
  const demoMode = environment.DEMO_MODE === 'true';
  const agentExecutor = demoMode
    ? createDemoInterviewAgentExecutor()
    : new MastraInterviewAgentExecutor({ model: modelConfig.interviewAgentModel });
  const modelMetadata = demoMode
    ? ({ mode: 'demo', provider: null, model: null } as const)
    : ({
        mode: 'provider',
        provider: modelConfig.interviewAgentModel.includes('/')
          ? modelConfig.interviewAgentModel.slice(0, modelConfig.interviewAgentModel.indexOf('/'))
          : null,
        model: modelConfig.interviewAgentModel,
      } as const);
  const mvpSessions = new CanonicalInterviewSessionService(unitOfWork, clock, agentExecutor, {
    model: modelMetadata,
  });
  const evaluationCoder = demoMode
    ? createDemoEvaluationCoder()
    : new MastraEvaluationCoder({
        model: modelConfig.evaluationModel,
        timeoutMs: modelConfig.evaluationTimeoutMs,
      });
  const evaluationAssets = loadOrganizationalResilienceEvaluationAssets();
  const evaluationProfileSeed = new EnsureDefaultEvaluationProfileService(
    unitOfWork,
    clock,
    evaluationAssets,
  );
  let defaultProfileReady = false;
  let activeProfileSeed: Promise<void> | undefined;
  const ensureDefaultProfile = (): Promise<void> => {
    if (defaultProfileReady) return Promise.resolve();
    activeProfileSeed ??= evaluationProfileSeed
      .execute()
      .then(() => {
        defaultProfileReady = true;
      })
      .finally(() => {
        activeProfileSeed = undefined;
      });
    return activeProfileSeed;
  };
  void ensureDefaultProfile().catch(() => undefined);
  const evaluationProfiles = new EvaluationProfileService(
    unitOfWork,
    clock,
    hasher,
    ensureDefaultProfile,
  );
  const evaluationProfileWorkbooks = new ExcelJsEvaluationProfileXlsxWorkbook();
  const evaluation = new EvaluationService(
    unitOfWork,
    clock,
    hasher,
    evaluationCoder,
    (profile, language) => localizeEvaluationProfile(profile, evaluationAssets, language),
  );
  let voiceGateway: OpenAiVoiceGateway | null = null;
  let voiceConfigurationError: unknown = null;
  try {
    voiceGateway = new OpenAiVoiceGateway(loadOpenAiVoiceConfig(environment));
  } catch (error: unknown) {
    voiceConfigurationError = error;
  }
  const realtimeSignals = new InMemoryRealtimeSignalHub({
    maximumSubscribers: realtimeConfig.maximumSubscribers,
    maximumSubscribersPerInterview: realtimeConfig.maximumSubscribersPerInterview,
  });
  const realtimeListener = createPostgresOutboxNotificationListener(
    databaseConfig,
    realtimeSignals,
    {
      error: (input) => diagnostics.realtimeListenerError(input),
    },
  );
  void realtimeListener.start().catch(() => undefined);

  const dependencies: BackendHttpDependencies = {
    allowedOrigins: http.allowedOrigins,
    clock,
    readiness: {
      check: async () => {
        const databaseReady = await checkDatabaseReadiness(
          database.pool,
          databaseConfig.readinessTimeoutMs,
        );
        if (databaseReady !== 'ready') return databaseReady;
        try {
          await ensureDefaultProfile();
          await ensureInterviewDefaults();
          return 'ready';
        } catch {
          return 'not_ready';
        }
      },
    },
    importGuide,
    interviewSettings: new InterviewSettingsService(unitOfWork, clock, ensureInterviewDefaults),
    getGuide: new GetGuideService(unitOfWork),
    createInterview: new CreateInterviewService(unitOfWork, clock, hasher),
    getInterview: new GetInterviewService(unitOfWork),
    listInterviews: new ListInterviewsService(unitOfWork),
    manageInterviews: new ManageInterviewsService(unitOfWork),
    getMonitoringSnapshot: new GetMonitoringSnapshotService(unitOfWork, clock),
    getMonitoringEventHistory: new GetMonitoringEventHistoryService(unitOfWork),
    openMonitoringEventStream: new OpenMonitoringEventStreamService(unitOfWork, realtimeSignals, {
      pollIntervalMs: realtimeConfig.pollIntervalMs,
      replayPageSize: realtimeConfig.replayPageSize,
      maximumReplayEvents: realtimeConfig.maximumReplayEvents,
    }),
    monitoringStreamOptions: {
      heartbeatIntervalMs: realtimeConfig.heartbeatIntervalMs,
      retryMs: realtimeConfig.retryMs,
      writeTimeoutMs: realtimeConfig.writeTimeoutMs,
      maximumFrameBytes: realtimeConfig.maximumFrameBytes,
    },
    mvpSessions,
    evaluation,
    evaluationProfiles,
    evaluationProfileWorkbooks,
    voiceGateway,
    voiceConfigurationError,
    onUnhandledError: (input) => {
      diagnostics.unhandledHttpError(input);
    },
  };

  return {
    app: createBackendHttpApp(dependencies),
    http,
    beginShutdown: () => realtimeSignals.close(),
    close: async () => {
      realtimeSignals.close();
      await Promise.all([realtimeListener.close(), database.close()]);
    },
    forceClose: () => {
      realtimeSignals.close();
      realtimeListener.forceClose();
      database.forceClose();
    },
  };
}

const silentDiagnostics: RuntimeDiagnostics = {
  databasePoolError: () => undefined,
  unhandledHttpError: () => undefined,
  realtimeListenerError: () => undefined,
};
