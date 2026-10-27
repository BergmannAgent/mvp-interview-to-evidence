import { createHash } from 'node:crypto';

import {
  apiErrorEnvelopeSchema,
  evaluationProfileDocumentSchema,
  evaluationProfileListResponseSchema,
  evaluationProfileResponseSchema,
  type StructuredAgentOutput,
  guideImportResponseSchema,
  interviewCreateResponseSchema,
  interviewDetailResponseSchema,
  interviewSummaryPageSchema,
  type MvpRealtimeTurnIntentRequest,
  type MvpRealtimeTurnPlan,
} from '@orgscience/contracts';
import type {
  AiTranscriptTurn,
  FinalizedParticipantSegment,
  InterviewGuideSnapshot,
  ParticipantTranscriptTurn,
  PartialTranscriptSegment,
  TranscriptGuideReference,
  TranscriptTechnicalGap,
} from '@orgscience/domain';
import { validateFinalTranscript } from '@orgscience/domain';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  CreateInterviewService,
  EnsureDefaultEvaluationProfileService,
  EvaluationProfileService,
  GetGuideService,
  GetInterviewService,
  GetMonitoringEventHistoryService,
  GetMonitoringSnapshotService,
  ImportGuideService,
  ListInterviewsService,
  OpenMonitoringEventStreamService,
} from '../../application/index.js';
import { loadOrganizationalResilienceEvaluationAssets } from '../research/evaluation-assets.js';
import { DemoInterviewAgentExecutor } from '../../application/agents/demo-agent-executor.js';
import { CanonicalInterviewSessionService } from '../../application/interviews/canonical-interview-session-service.js';
import { ManageInterviewsService } from '../../application/interviews/manage-interviews.js';
import { DemoEvaluationCoder } from '../../application/evaluations/demo-evaluation-coder.js';
import { EvaluationService } from '../../application/evaluations/evaluation-service.js';
import { InMemoryRealtimeSignalHub } from '../realtime/index.js';
import { createPostgresOutboxNotificationListener } from '../realtime/postgres-outbox-listener.js';
import {
  failure,
  type AiDeliveryReservation,
  type EnqueueJobInput,
  type ImportedGuideRecord,
  type MonitoringEventDraft,
  type PersistedInterview,
  type RepositoryError,
  type StoredStepCheckpoint,
  type StoredWorkflowAttempt,
} from '../../application/persistence/index.js';
import { loadDatabaseConfig } from './config.js';
import {
  createPgMigrationPool,
  loadSqlMigrations,
  runSqlMigrations,
  type MigrationRunResult,
} from './migration-runner.js';
import { createDatabasePool } from './pool.js';
import { checkDatabaseReadiness } from './readiness.js';
import { PostgresPersistenceContextFactory } from './persistence-context.js';
import { PostgresGuideRepository } from './repositories/guide-repository.js';
import { PostgresInterviewRepository } from './repositories/interview-repository.js';
import { PostgreSqlJobRepository } from './repositories/job-repository.js';
import { PostgresOutboxRepository } from './repositories/outbox-repository.js';
import { PostgresRunRepository } from './repositories/run-repository.js';
import { createClientSqlExecutor, createPoolSqlExecutor } from './repositories/sql.js';
import { PostgresTranscriptRepository } from './repositories/transcript-repository.js';
import {
  createPgUnitOfWorkPool,
  PostgresUnitOfWork,
  type UnitOfWorkClient,
  type UnitOfWorkPool,
} from './unit-of-work.js';
import { createBackendHttpApp } from '../../transport/http/app.js';

const MINIMUM_POSTGRES_VERSION = 180_000;
const MIGRATION_DIRECTORY = new URL('../../../drizzle/', import.meta.url);
const INTEGRATION_LOCK_NAMESPACE = 1_651_473_985;
const INTEGRATION_LOCK_RESOURCE = 2;
const CREATED_AT = '2026-08-06T10:00:00.000Z';
const UPDATED_AT = '2026-08-06T10:01:00.000Z';
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL?.trim();

const databaseInfoSchema = z.strictObject({
  serverVersionNumber: z.number().int().positive(),
  databaseName: z.string().min(1),
});
const advisoryUnlockSchema = z.strictObject({ unlocked: z.literal(true) });
const allocatedSequenceSchema = z.strictObject({ allocatedSequence: z.number().int().positive() });
const counterSchema = z.strictObject({ nextTranscriptSequence: z.number().int().positive() });

interface IntegrationFixture {
  readonly pool: Pool;
  readonly serverVersionNumber: number;
  readonly migrationIds: readonly string[];
  readonly firstMigrationRun: MigrationRunResult;
  readonly secondMigrationRun: MigrationRunResult;
}

let managedPool: ReturnType<typeof createDatabasePool> | undefined;
let integrationLockClient: PoolClient | undefined;
let resetAuthorized = false;
let integrationFixture: IntegrationFixture | undefined;

const describePostgres =
  TEST_DATABASE_URL === undefined || TEST_DATABASE_URL.length === 0 ? describe.skip : describe;

describePostgres('PostgreSQL persistence integration', () => {
  beforeAll(async () => {
    if (TEST_DATABASE_URL === undefined || TEST_DATABASE_URL.length === 0) {
      throw new Error('TEST_DATABASE_URL is required for PostgreSQL integration tests');
    }

    const expectedDatabaseName = authorizeDestructiveReset(TEST_DATABASE_URL);
    const migrations = await loadSqlMigrations(MIGRATION_DIRECTORY);
    const config = loadDatabaseConfig({
      DATABASE_URL: TEST_DATABASE_URL,
      DATABASE_POOL_MAX: '4',
      DATABASE_IDLE_TIMEOUT_MS: '1000',
      DATABASE_CONNECTION_TIMEOUT_MS: '10000',
      DATABASE_APPLICATION_NAME: 'orgscience-postgres-integration-test',
    });
    managedPool = createDatabasePool(config);

    try {
      const databaseInfo = await readDatabaseInfo(managedPool.pool);
      if (
        databaseInfo.databaseName !== expectedDatabaseName ||
        !databaseInfo.databaseName.endsWith('_test')
      ) {
        throw new Error(
          'The connected PostgreSQL database does not match the authorized _test database',
        );
      }
      if (databaseInfo.serverVersionNumber < MINIMUM_POSTGRES_VERSION) {
        throw new Error(
          `PostgreSQL 18 or newer is required; server_version_num=${databaseInfo.serverVersionNumber}`,
        );
      }

      integrationLockClient = await managedPool.pool.connect();
      await integrationLockClient.query('SELECT pg_advisory_lock($1::integer, $2::integer)', [
        INTEGRATION_LOCK_NAMESPACE,
        INTEGRATION_LOCK_RESOURCE,
      ]);
      resetAuthorized = true;
      await managedPool.pool.query('DROP SCHEMA IF EXISTS app CASCADE');

      const migrationPool = createPgMigrationPool(managedPool.pool);
      const firstMigrationRun = await runSqlMigrations(migrationPool, MIGRATION_DIRECTORY);
      const secondMigrationRun = await runSqlMigrations(migrationPool, MIGRATION_DIRECTORY);
      integrationFixture = {
        pool: managedPool.pool,
        serverVersionNumber: databaseInfo.serverVersionNumber,
        migrationIds: migrations.map((migration) => migration.id),
        firstMigrationRun,
        secondMigrationRun,
      };
    } catch (error: unknown) {
      try {
        await cleanupDatabase();
      } catch (cleanupError: unknown) {
        throw new AggregateError(
          [error, cleanupError],
          'PostgreSQL integration setup and cleanup both failed',
          { cause: cleanupError },
        );
      }
      throw error;
    }
  }, 60_000);

  afterAll(async () => {
    await cleanupDatabase();
  }, 30_000);

  it('requires PostgreSQL 18 or newer before resetting the schema', () => {
    expect(fixture().serverVersionNumber).toBeGreaterThanOrEqual(MINIMUM_POSTGRES_VERSION);
  });

  it('contains and redacts errors from checked-out PostgreSQL clients', async () => {
    if (TEST_DATABASE_URL === undefined) throw new Error('PostgreSQL test URL is required');
    const secret = 'checked-out-client-secret';
    const clientError = vi.fn();
    const observedPool = createDatabasePool(
      loadDatabaseConfig({
        DATABASE_URL: TEST_DATABASE_URL,
        DATABASE_POOL_MAX: '1',
        DATABASE_IDLE_TIMEOUT_MS: '1000',
        DATABASE_CONNECTION_TIMEOUT_MS: '1000',
        DATABASE_APPLICATION_NAME: 'orgscience-client-error-test',
      }),
      { clientError },
    );

    try {
      const client = await observedPool.pool.connect();
      expect(client.listenerCount('error')).toBe(1);
      expect(() => client.emit('error', new Error(secret))).not.toThrow();
      expect(clientError).toHaveBeenCalledWith({
        database: expect.not.stringContaining(secret),
        errorClass: 'error',
      });
      expect(JSON.stringify(clientError.mock.calls)).not.toContain(secret);
      client.release();

      const reacquired = await observedPool.pool.connect();
      expect(reacquired).toBe(client);
      expect(reacquired.listenerCount('error')).toBe(1);
      reacquired.release();
    } finally {
      await observedPool.close();
    }
  });

  it('applies migrations once and treats a second run as idempotent', () => {
    const state = fixture();

    expect(state.firstMigrationRun).toEqual({
      appliedMigrationIds: state.migrationIds,
      previouslyAppliedMigrationIds: [],
    });
    expect(state.secondMigrationRun).toEqual({
      appliedMigrationIds: [],
      previouslyAppliedMigrationIds: state.migrationIds,
    });
  });

  it('persists explicit guide choices across reconstructed repositories and enforces language scope', async () => {
    const { pool } = fixture();
    const germanFirst = guideRecord('guide-settings-first');
    const germanChosen = guideRecord('guide-settings-chosen');
    const englishBase = guideRecord('guide-settings-english');
    const english: ImportedGuideRecord = {
      ...englishBase,
      guide: { ...englishBase.guide, sourceLanguage: 'en' },
    };
    const records = [germanFirst, germanChosen, english];
    const ids = records.map((record) => record.guideId);
    const unitOfWork = postgresUnitOfWork(pool);
    try {
      for (const record of records) {
        expect(
          await unitOfWork.transaction(({ guides }) => guides.import(record.guideId, record)),
        ).toMatchObject({ ok: true });
      }
      expect(
        await unitOfWork.transaction(({ interviewSettings }) =>
          interviewSettings.saveSetting(
            {
              language: 'de',
              guideId: germanFirst.guideId,
              updatedAt: CREATED_AT,
            },
            true,
          ),
        ),
      ).toMatchObject({ ok: true });
      const chosen = {
        language: 'de' as const,
        guideId: germanChosen.guideId,
        updatedAt: UPDATED_AT,
      };
      expect(
        await unitOfWork.transaction(({ interviewSettings }) =>
          interviewSettings.saveSetting(chosen),
        ),
      ).toEqual({ ok: true, value: chosen });
      expect(
        await postgresUnitOfWork(pool).transaction(({ interviewSettings }) =>
          interviewSettings.saveSetting(
            {
              language: 'de',
              guideId: germanFirst.guideId,
              updatedAt: CREATED_AT,
            },
            true,
          ),
        ),
      ).toEqual({ ok: true, value: chosen });
      expect(
        await unitOfWork.transaction(({ interviewSettings }) =>
          interviewSettings.saveSetting({
            language: 'en',
            guideId: english.guideId,
            updatedAt: CREATED_AT,
          }),
        ),
      ).toMatchObject({ ok: true });
      const listed = await postgresUnitOfWork(pool).read(({ interviewSettings }) =>
        interviewSettings.listGuides('de'),
      );
      expect(listed).toMatchObject({ ok: true });
      if (!listed.ok) throw new Error('Could not read German guide choices');
      expect(
        listed.value
          .filter((guide) => ids.includes(guide.id))
          .map((guide) => guide.id)
          .toSorted(),
      ).toEqual([germanFirst.guideId, germanChosen.guideId].toSorted());
      expect(
        await unitOfWork.transaction(({ interviewSettings }) =>
          interviewSettings.saveSetting({
            language: 'de',
            guideId: english.guideId,
            updatedAt: UPDATED_AT,
          }),
        ),
      ).toMatchObject({
        ok: false,
        error: { code: 'constraint_violation', constraint: 'interview_settings_guide_language_fk' },
      });
      expect(
        await postgresUnitOfWork(pool).read(({ interviewSettings }) =>
          interviewSettings.getSettings(),
        ),
      ).toEqual({
        ok: true,
        value: [chosen, { language: 'en', guideId: english.guideId, updatedAt: CREATED_AT }],
      });
    } finally {
      await pool.query('DELETE FROM app.interview_settings WHERE guide_id = ANY($1::text[])', [
        ids,
      ]);
      await pool.query('DELETE FROM app.guides WHERE id = ANY($1::text[])', [ids]);
    }
  });

  it('persists three clarification objectives across reconstructed services without advancing progress', async () => {
    const { pool } = fixture();
    const h = await startDynamicRealtimeInterview(pool, 'dynamic-probes');
    await h.answer('start', 'Wir haben schnell reagiert.');
    const invalid: MvpRealtimeTurnIntentRequest = {
      clientEventId: 'generic-probe',
      action: 'ask_clarification_question',
      questionId: h.questionId,
      spokenText: 'Koennen Sie mehr dazu sagen?',
      answerDisposition: 'partial',
      missingAspect: 'erste konkrete Massnahme',
      requestedEvidenceType: 'action',
    };
    const before = await h.service().get(h.interviewId);
    const rejected = await h.service().reserveRealtimeTurnIntent(h.interviewId, invalid);
    expect(rejected.rejection?.reason).toBeTruthy();
    expect(rejected.nextAiTurn).toBeNull();
    expect(rejected.session).toEqual(before);
    const objectives = [
      {
        text: 'Was war Ihre erste konkrete Massnahme?',
        aspect: 'erste konkrete Massnahme',
        type: 'action',
      },
      {
        text: 'Wer trug die Verantwortung fuer diese Massnahme?',
        aspect: 'Verantwortung fuer diese Massnahme',
        type: 'responsibility',
      },
      {
        text: 'Welches konkrete Ergebnis hatte diese Massnahme?',
        aspect: 'konkretes Ergebnis',
        type: 'outcome',
      },
    ] as const;
    for (const [index, objective] of objectives.entries()) {
      const intent: MvpRealtimeTurnIntentRequest = {
        ...invalid,
        clientEventId: `probe-${index}`,
        spokenText: objective.text,
        missingAspect: objective.aspect,
        requestedEvidenceType: objective.type,
      };
      const planned = await h.service().reserveRealtimeTurnIntent(h.interviewId, intent);
      expect(planned.nextAiTurn).toMatchObject({
        turnType: 'clarification_question',
        questionId: h.questionId,
        text: objective.text,
      });
      expect(planned.session.currentQuestionIndex).toBe(before.currentQuestionIndex);
      expect(planned.session.totalQuestions).toBe(2);
      const duplicate = await h.service().reserveRealtimeTurnIntent(h.interviewId, intent);
      expect(duplicate.nextAiTurn?.deliveryId).toBe(planned.nextAiTurn?.deliveryId);
      let playable = planned.nextAiTurn;
      if (index === 0 && playable !== null) {
        const repairedAudio = await h.service().appendRealtimeAiTurn(h.interviewId, {
          deliveryId: playable.deliveryId,
          clientEventId: 'mismatched-audio',
          text: 'Eine andere, nicht freigegebene Frage?',
          turnType: playable.turnType,
          questionId: playable.questionId,
        });
        expect(repairedAudio.turn).toBeNull();
        expect(repairedAudio.nextAiTurn?.text).toBe(playable.text);
        expect(repairedAudio.nextAiTurn?.deliveryId).not.toBe(playable.deliveryId);
        playable = repairedAudio.nextAiTurn;
      }
      await h.speak(playable);
      await h.answer(`answer-${index}`, 'Das war eine Massnahme unseres Teams.');
    }
    const advanced = await h
      .service()
      .reserveRealtimeTurnIntent(h.interviewId, { ...invalid, clientEventId: 'fourth-probe' });
    expect(advanced.rejection).toBeUndefined();
    expect(advanced.nextAiTurn).toMatchObject({
      turnType: 'main_question',
      questionId: h.nextQuestionId,
    });
    expect(advanced.session.currentQuestionIndex).toBe(before.currentQuestionIndex + 1);
    const receipts = await postgresUnitOfWork(pool).read(({ transcripts }) =>
      transcripts.listQuestionAiDeliveries(h.interviewId, h.questionId),
    );
    expect(receipts).toMatchObject({ ok: true });
    if (!receipts.ok) throw new Error('Could not load persisted question deliveries');
    expect(
      receipts.value.filter(
        (receipt) =>
          receipt.status === 'complete' && receipt.planningMetadata?.purpose === 'clarification',
      ),
    ).toHaveLength(3);
    expect(
      receipts.value
        .filter((receipt) => receipt.status === 'complete' && receipt.planningMetadata != null)
        .map((receipt) => receipt.planningMetadata?.missingAspect),
    ).toEqual(objectives.map((objective) => objective.aspect));
    const session = await h.service().get(h.interviewId);
    expect(
      session.transcript
        .filter((turn) => turn.turnType === 'clarification_question')
        .map((turn) => turn.text),
    ).toEqual(objectives.map((objective) => objective.text));
    expect(new Set(session.transcript.map((turn) => turn.turnId)).size).toBe(
      session.transcript.length,
    );
  });

  it('persists one repetition and prevents concurrent planning from reserving two turns', async () => {
    const { pool } = fixture();
    const h = await startDynamicRealtimeInterview(pool, 'dynamic-repeat');
    await h.answer('off-topic', 'Mein Auto ist rot.');
    const intent: MvpRealtimeTurnIntentRequest = {
      clientEventId: 'repeat-one',
      action: 'repeat_question',
      questionId: h.questionId,
      spokenText: 'Welche Farbe hat Ihr Auto?',
      answerDisposition: 'off_topic',
      missingAspect: null,
      requestedEvidenceType: null,
    };
    const results = await Promise.allSettled([
      h.service().reserveRealtimeTurnIntent(h.interviewId, intent),
      h.service().reserveRealtimeTurnIntent(h.interviewId, {
        ...intent,
        clientEventId: 'concurrent-repeat',
      }),
    ]);
    const accepted = results.find((result) => result.status === 'fulfilled');
    if (accepted?.status !== 'fulfilled') throw new Error('No concurrent repetition was accepted');
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(accepted.value.nextAiTurn?.text).toBe(
      `Ich stelle die Frage noch einmal: ${h.questionText}`,
    );
    await h.speak(accepted.value.nextAiTurn);
    await h.answer('still-off-topic', 'Ich spreche weiterhin nur ueber mein Auto.');
    const advanced = await h
      .service()
      .reserveRealtimeTurnIntent(h.interviewId, { ...intent, clientEventId: 'repeat-two' });
    expect(advanced.nextAiTurn?.questionId).toBe(h.nextQuestionId);
    const receipts = await postgresUnitOfWork(pool).read(({ transcripts }) =>
      transcripts.listQuestionAiDeliveries(h.interviewId, h.questionId),
    );
    expect(receipts).toMatchObject({ ok: true });
    if (!receipts.ok) throw new Error('Could not load repetition metadata');
    expect(
      receipts.value.filter((receipt) => receipt.planningMetadata?.purpose === 'repeat'),
    ).toHaveLength(1);
  });

  it('persists one mutable default profile across concurrent seed and reconstructed services', async () => {
    const { pool } = fixture();
    const assets = loadOrganizationalResilienceEvaluationAssets();
    const firstUnitOfWork = postgresUnitOfWork(pool);
    const secondUnitOfWork = postgresUnitOfWork(pool);
    const seededAt = '2026-08-21T10:00:00.000Z';
    const seeders = [firstUnitOfWork, secondUnitOfWork].map(
      (unitOfWork) =>
        new EnsureDefaultEvaluationProfileService(unitOfWork, { now: () => seededAt }, assets),
    );

    const seeded = await Promise.all(seeders.map((service) => service.execute()));
    expect(seeded[0]).toEqual(seeded[1]);
    expect(seeded[0]).toMatchObject({ name: 'default', isDefault: true });
    await expect(
      pool.query<{ count: string }>(
        'select count(*)::text as count from app.evaluation_profiles where is_default = true',
      ),
    ).resolves.toMatchObject({ rows: [{ count: '1' }] });

    const current = seeded[0]!;
    const changedAt = '2026-08-21T10:01:00.000Z';
    const changed = {
      ...current,
      name: 'Research default',
      description: 'Persisted user edit',
      updatedAt: changedAt,
    };
    await expect(
      firstUnitOfWork.transaction(({ evaluationProfiles }) =>
        evaluationProfiles.update(current.profileId, current.updatedAt, changed),
      ),
    ).resolves.toEqual({ ok: true, value: changed });

    const afterRestart = await new EnsureDefaultEvaluationProfileService(
      postgresUnitOfWork(pool),
      { now: () => '2026-08-21T10:02:00.000Z' },
      assets,
    ).execute();
    expect(afterRestart).toEqual(changed);

    const copy = {
      ...changed,
      profileId: 'profile-postgres-copy',
      name: 'Independent copy',
      isDefault: false,
      createdAt: '2026-08-21T10:03:00.000Z',
      updatedAt: '2026-08-21T10:03:00.000Z',
    };
    await expect(
      secondUnitOfWork.transaction(({ evaluationProfiles }) =>
        evaluationProfiles.duplicate(changed.profileId, copy),
      ),
    ).resolves.toEqual({ ok: true, value: copy });

    const created = {
      ...copy,
      profileId: 'profile-postgres-created',
      name: 'Created independently',
      createdAt: '2026-08-21T10:04:00.000Z',
      updatedAt: '2026-08-21T10:04:00.000Z',
    };
    await expect(
      postgresUnitOfWork(pool).transaction(({ evaluationProfiles }) =>
        evaluationProfiles.create(created),
      ),
    ).resolves.toEqual({ ok: true, value: created });
    await expect(
      postgresUnitOfWork(pool).read(({ evaluationProfiles }) =>
        evaluationProfiles.load(created.profileId),
      ),
    ).resolves.toEqual({ ok: true, value: created });

    const updatedCopy = {
      ...copy,
      description: 'First independent edit',
      updatedAt: '2026-08-21T10:05:00.000Z',
    };
    const staleCopy = {
      ...copy,
      description: 'Stale edit that must not win',
      updatedAt: '2026-08-21T10:06:00.000Z',
    };
    await expect(
      postgresUnitOfWork(pool).transaction(({ evaluationProfiles }) =>
        evaluationProfiles.update(copy.profileId, copy.updatedAt, updatedCopy),
      ),
    ).resolves.toEqual({ ok: true, value: updatedCopy });
    await expect(
      postgresUnitOfWork(pool).transaction(({ evaluationProfiles }) =>
        evaluationProfiles.update(copy.profileId, copy.updatedAt, staleCopy),
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: 'duplicate_conflict' } });

    const updatedCreated = {
      ...created,
      description: 'Second independent edit',
      updatedAt: '2026-08-21T10:05:30.000Z',
    };
    await expect(
      postgresUnitOfWork(pool).transaction(({ evaluationProfiles }) =>
        evaluationProfiles.update(created.profileId, created.updatedAt, updatedCreated),
      ),
    ).resolves.toEqual({ ok: true, value: updatedCreated });
    await expect(
      postgresUnitOfWork(pool).read(({ evaluationProfiles }) => evaluationProfiles.list()),
    ).resolves.toMatchObject({
      ok: true,
      value: [
        { profileId: changed.profileId, name: changed.name, isDefault: true },
        { profileId: updatedCreated.profileId, name: updatedCreated.name, isDefault: false },
        { profileId: updatedCopy.profileId, name: updatedCopy.name, isDefault: false },
      ],
    });

    await expect(
      postgresUnitOfWork(pool).transaction(({ evaluationProfiles }) =>
        evaluationProfiles.delete(updatedCopy.profileId, updatedCopy.updatedAt),
      ),
    ).resolves.toEqual({ ok: true, value: updatedCopy });
    await expect(
      postgresUnitOfWork(pool).transaction(({ evaluationProfiles }) =>
        evaluationProfiles.delete(updatedCreated.profileId, updatedCreated.updatedAt),
      ),
    ).resolves.toEqual({ ok: true, value: updatedCreated });
  });

  it('runs profile CRUD and lossless JSON reimport through HTTP and PostgreSQL', async () => {
    const { pool } = fixture();
    const unitOfWork = postgresUnitOfWork(pool);
    let now = '2026-08-21T11:00:00.000Z';
    const clock = { now: () => now };
    const hasher = {
      digestUtf8: (value: string) => createHash('sha256').update(value, 'utf8').digest('hex'),
    };
    const assets = loadOrganizationalResilienceEvaluationAssets();
    const seeder = new EnsureDefaultEvaluationProfileService(unitOfWork, clock, assets);
    let ready: Promise<void> | undefined;
    const ensureDefault = (): Promise<void> => {
      ready ??= seeder.execute().then(() => undefined);
      return ready;
    };
    await ensureDefault();
    const evaluationProfiles = new EvaluationProfileService(
      unitOfWork,
      clock,
      hasher,
      ensureDefault,
    );
    const realtimeSignals = new InMemoryRealtimeSignalHub();
    const app = createBackendHttpApp({
      allowedOrigins: ['http://localhost:5275'],
      clock,
      readiness: { check: () => checkDatabaseReadiness(pool) },
      importGuide: new ImportGuideService(unitOfWork, clock, hasher),
      getGuide: new GetGuideService(unitOfWork),
      createInterview: new CreateInterviewService(unitOfWork, clock, hasher),
      getInterview: new GetInterviewService(unitOfWork),
      listInterviews: new ListInterviewsService(unitOfWork),
      getMonitoringSnapshot: new GetMonitoringSnapshotService(unitOfWork, clock),
      getMonitoringEventHistory: new GetMonitoringEventHistoryService(unitOfWork),
      openMonitoringEventStream: new OpenMonitoringEventStreamService(unitOfWork, realtimeSignals),
      evaluationProfiles,
    });
    const content = {
      name: 'PostgreSQL HTTP profile',
      description: 'Created through the complete profile API path.',
      coderPrompt: 'Assess each item using only exact participant evidence.',
      scale: { minimum: 1, maximum: 7 },
      dimensions: [{ dimensionId: 'quality', name: 'Quality', order: 0 }],
      items: [
        {
          itemId: 'quality-01',
          dimensionId: 'quality',
          name: 'Reliable delivery',
          codingInstruction: 'Assess observable evidence of reliable delivery.',
          order: 0,
          anchors: [1, 2, 3, 4, 5, 6, 7].map((score) => ({
            score,
            criterion: `Observable delivery criterion ${String(score)}.`,
          })),
        },
      ],
    };

    now = '2026-08-21T11:01:00.000Z';
    const createResponse = await profileJsonRequest(app, '/api/v1/evaluation-profiles', 'POST', {
      profile: content,
    });
    expect(createResponse.status).toBe(201);
    const created = evaluationProfileResponseSchema.parse(await createResponse.json()).profile;

    const getResponse = await app.request(
      `/api/v1/evaluation-profiles/${encodeURIComponent(created.profileId)}`,
    );
    expect(evaluationProfileResponseSchema.parse(await getResponse.json()).profile).toEqual(
      created,
    );

    now = '2026-08-21T11:02:00.000Z';
    const updateResponse = await profileJsonRequest(
      app,
      `/api/v1/evaluation-profiles/${encodeURIComponent(created.profileId)}`,
      'PUT',
      {
        profile: { ...content, description: 'Updated through optimistic HTTP CRUD.' },
        expectedUpdatedAt: created.updatedAt,
      },
    );
    expect(updateResponse.status).toBe(200);
    const updated = evaluationProfileResponseSchema.parse(await updateResponse.json()).profile;

    const staleDelete = await app.request(profileDeleteUrl(created.profileId, created.updatedAt), {
      method: 'DELETE',
    });
    expect(staleDelete.status).toBe(409);
    expect(apiErrorEnvelopeSchema.parse(await staleDelete.json()).error.code).toBe(
      'EVALUATION_PROFILE_CONFLICT',
    );

    const exportResponse = await app.request(
      `/api/v1/evaluation-profiles/${encodeURIComponent(updated.profileId)}/export`,
    );
    expect(exportResponse.status).toBe(200);
    const exportedText = await exportResponse.text();
    const exported = evaluationProfileDocumentSchema.parse(JSON.parse(exportedText));

    const conflictingImport = await profileJsonRequest(
      app,
      '/api/v1/evaluation-profiles/imports/json/confirm',
      'POST',
      { mode: 'create', document: exported },
    );
    expect(conflictingImport.status).toBe(409);
    expect(apiErrorEnvelopeSchema.parse(await conflictingImport.json()).error.code).toBe(
      'EVALUATION_PROFILE_CONFLICT',
    );

    const deleteResponse = await app.request(
      profileDeleteUrl(updated.profileId, updated.updatedAt),
      { method: 'DELETE' },
    );
    expect(deleteResponse.status).toBe(204);

    now = '2026-08-21T11:03:00.000Z';
    const reimportResponse = await profileJsonRequest(
      app,
      '/api/v1/evaluation-profiles/imports/json/confirm',
      'POST',
      { mode: 'create', document: exported },
    );
    expect(reimportResponse.status).toBe(201);
    const reimported = evaluationProfileResponseSchema.parse(await reimportResponse.json()).profile;
    expect({
      profileId: reimported.profileId,
      name: reimported.name,
      description: reimported.description,
      coderPrompt: reimported.coderPrompt,
      scale: reimported.scale,
      dimensions: reimported.dimensions,
      items: reimported.items,
    }).toEqual(exported.profile);

    now = '2026-08-21T11:04:00.000Z';
    const duplicateResponse = await profileJsonRequest(
      app,
      `/api/v1/evaluation-profiles/${encodeURIComponent(reimported.profileId)}/duplicate`,
      'POST',
      { name: 'PostgreSQL HTTP profile copy' },
    );
    expect(duplicateResponse.status).toBe(201);
    const duplicate = evaluationProfileResponseSchema.parse(await duplicateResponse.json()).profile;

    const listResponse = await app.request('/api/v1/evaluation-profiles');
    const listed = evaluationProfileListResponseSchema.parse(await listResponse.json()).profiles;
    expect(listed.map(({ profileId }) => profileId)).toEqual(
      expect.arrayContaining([reimported.profileId, duplicate.profileId]),
    );

    const reconstructed = postgresUnitOfWork(pool);
    await expect(
      reconstructed.read(({ evaluationProfiles: profiles }) => profiles.load(reimported.profileId)),
    ).resolves.toEqual({ ok: true, value: reimported });

    const defaultProfile = listed.find(({ isDefault }) => isDefault);
    if (defaultProfile === undefined) throw new Error('Expected the seeded default profile');
    const protectedDelete = await app.request(
      profileDeleteUrl(defaultProfile.profileId, defaultProfile.updatedAt),
      { method: 'DELETE' },
    );
    expect(protectedDelete.status).toBe(409);
    expect(apiErrorEnvelopeSchema.parse(await protectedDelete.json()).error.code).toBe(
      'DEFAULT_PROFILE_REQUIRED',
    );

    for (const profile of [duplicate, reimported]) {
      const response = await app.request(profileDeleteUrl(profile.profileId, profile.updatedAt), {
        method: 'DELETE',
      });
      expect(response.status).toBe(204);
    }
  });

  it('runs guide import and idempotent interview creation through HTTP and PostgreSQL', async () => {
    const { pool } = fixture();
    const unitOfWork = new PostgresUnitOfWork(
      createPgUnitOfWorkPool(pool),
      new PostgresPersistenceContextFactory(),
    );
    let now = '2026-08-07T08:00:00.000Z';
    const clock = { now: () => now };
    const hasher = {
      digestUtf8: (value: string) => createHash('sha256').update(value, 'utf8').digest('hex'),
    };
    const realtimeSignals = new InMemoryRealtimeSignalHub();
    const app = createBackendHttpApp({
      allowedOrigins: ['http://localhost:5173'],
      clock,
      readiness: { check: () => checkDatabaseReadiness(pool) },
      importGuide: new ImportGuideService(unitOfWork, clock, hasher),
      getGuide: new GetGuideService(unitOfWork),
      createInterview: new CreateInterviewService(unitOfWork, clock, hasher),
      getInterview: new GetInterviewService(unitOfWork),
      listInterviews: new ListInterviewsService(unitOfWork),
      getMonitoringSnapshot: new GetMonitoringSnapshotService(unitOfWork, clock),
      getMonitoringEventHistory: new GetMonitoringEventHistoryService(unitOfWork),
      openMonitoringEventStream: new OpenMonitoringEventStreamService(unitOfWork, realtimeSignals),
    });
    const markdown = `# Interviewleitfaden: PostgreSQL HTTP

## Einstieg

### Hauptfrage
Welche Rolle haben Sie?

#### Vertiefungsfragen

- Seit wann arbeiten Sie in dieser Rolle?
`;
    const upload = new FormData();
    upload.append('file', new File([markdown], 'postgres-guide.md', { type: 'text/markdown' }));

    const importedResponse = await app.request('/api/v1/guides', {
      method: 'POST',
      body: upload,
    });
    expect(importedResponse.status).toBe(201);
    const imported = guideImportResponseSchema.parse(await importedResponse.json());
    const interviewId = 'interview-postgres-http-1';

    const createResponse = await app.request('/api/v1/interviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interviewId, guideId: imported.interviewGuide.id }),
    });
    expect(createResponse.status).toBe(201);
    const created = interviewCreateResponseSchema.parse(await createResponse.json());
    expect(created).toMatchObject({
      outcome: 'inserted',
      interviewState: { interviewId, lifecycle: { status: 'ready' } },
    });

    now = '2026-08-07T08:05:00.000Z';
    const retryResponse = await app.request('/api/v1/interviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interviewId, guideId: imported.interviewGuide.id }),
    });
    expect(retryResponse.status).toBe(200);
    const retried = interviewCreateResponseSchema.parse(await retryResponse.json());
    expect(retried).toEqual({ outcome: 'existing', interviewState: created.interviewState });

    const detailResponse = await app.request(`/api/v1/interviews/${interviewId}`);
    expect(detailResponse.status).toBe(200);
    expect(interviewDetailResponseSchema.parse(await detailResponse.json())).toEqual({
      interviewState: created.interviewState,
    });

    const listResponse = await app.request('/api/v1/interviews?limit=100');
    expect(listResponse.status).toBe(200);
    const page = interviewSummaryPageSchema.parse(await listResponse.json());
    expect(page.interviews.some((interview) => interview.interviewId === interviewId)).toBe(true);

    const invalidCursorResponse = await app.request('/api/v1/interviews?after=abc');
    expect(invalidCursorResponse.status).toBe(400);

    const highWater = await unitOfWork.read(({ outbox }) => outbox.highWater(interviewId));
    expect(highWater).toEqual({ ok: true, value: 1 });
    const replay = await unitOfWork.read(({ outbox }) =>
      outbox.replay(interviewId, { afterSequence: 0, throughSequence: 1, limit: 10 }),
    );
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.value.events).toHaveLength(1);
      expect(replay.value.events[0]).toMatchObject({
        interviewId,
        sequenceNumber: 1,
        type: 'interview.status_changed',
        payload: { previousStatus: null, nextStatus: 'ready' },
      });
    }
  });

  it('resolves concurrent idempotent interview creation after a real serialization race', async () => {
    const { pool } = fixture();
    const guide = guideRecord('concurrent-create-same-guide');
    await expect(
      postgresUnitOfWork(pool).transaction(({ guides }) => guides.import(guide.guideId, guide)),
    ).resolves.toMatchObject({ ok: true });
    const interviewId = 'interview-concurrent-create-same-guide';
    const unitOfWork = new PostgresUnitOfWork(
      synchronizeMissingInterviewLoads(pool, interviewId),
      persistenceContexts,
    );
    const clock = { now: () => '2026-08-07T09:00:00.000Z' };
    const hasher = {
      digestUtf8: (value: string) => createHash('sha256').update(value, 'utf8').digest('hex'),
    };
    const services = [
      new CreateInterviewService(unitOfWork, clock, hasher),
      new CreateInterviewService(unitOfWork, clock, hasher),
    ] as const;

    const results = await Promise.all(
      services.map((service) => service.execute({ interviewId, guideId: guide.guideId })),
    );

    expect(
      results.map((result) => (result.ok ? result.value.outcome : result.error.code)).sort(),
    ).toEqual(['existing', 'inserted']);
    await expectInitialInterviewRowCounts(pool, interviewId);
  });

  it('resolves a concurrent same-ID race across different guides as one conflict', async () => {
    const { pool } = fixture();
    const guides = [
      guideRecord('concurrent-create-guide-a'),
      guideRecord('concurrent-create-guide-b'),
    ] as const;
    for (const guide of guides) {
      await expect(
        postgresUnitOfWork(pool).transaction((transaction) =>
          transaction.guides.import(guide.guideId, guide),
        ),
      ).resolves.toMatchObject({ ok: true });
    }
    const interviewId = 'interview-concurrent-create-different-guides';
    const unitOfWork = new PostgresUnitOfWork(
      synchronizeMissingInterviewLoads(pool, interviewId),
      persistenceContexts,
    );
    const clock = { now: () => '2026-08-07T09:05:00.000Z' };
    const hasher = {
      digestUtf8: (value: string) => createHash('sha256').update(value, 'utf8').digest('hex'),
    };

    const results = await Promise.all(
      guides.map((guide) =>
        new CreateInterviewService(unitOfWork, clock, hasher).execute({
          interviewId,
          guideId: guide.guideId,
        }),
      ),
    );

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      {
        ok: false,
        error: { code: 'duplicate_conflict', resource: 'interview', identity: interviewId },
      },
    ]);
    await expectInitialInterviewRowCounts(pool, interviewId);
  });

  it('keeps keyset pagination stable when an unseen interview is updated between pages', async () => {
    const { pool } = fixture();
    const guide = guideRecord('stable-summary-pagination');
    const unitOfWork = postgresUnitOfWork(pool);
    await expect(
      unitOfWork.transaction(({ guides }) => guides.import(guide.guideId, guide)),
    ).resolves.toMatchObject({ ok: true });
    let now = '2099-01-01T10:00:00.000Z';
    const clock = { now: () => now };
    const hasher = {
      digestUtf8: (value: string) => createHash('sha256').update(value, 'utf8').digest('hex'),
    };
    const service = new CreateInterviewService(unitOfWork, clock, hasher);
    for (const [interviewId, createdAt] of [
      ['interview-pagination-1', '2099-01-01T10:00:00.000Z'],
      ['interview-pagination-2', '2099-01-01T10:01:00.000Z'],
      ['interview-pagination-3', '2099-01-01T10:02:00.000Z'],
    ] as const) {
      now = createdAt;
      await expect(service.execute({ interviewId, guideId: guide.guideId })).resolves.toMatchObject(
        {
          ok: true,
          value: { outcome: 'inserted' },
        },
      );
    }

    const firstPage = await new ListInterviewsService(unitOfWork).execute({
      after: null,
      limit: 2,
    });
    expect(firstPage.ok).toBe(true);
    if (!firstPage.ok || firstPage.value.nextCursor === null) return;
    expect(firstPage.value.interviews.map((item) => item.interviewId)).toEqual([
      'interview-pagination-3',
      'interview-pagination-2',
    ]);

    await pool.query(
      `UPDATE app.interview_state
          SET updated_at = '2099-01-01T11:00:00.000Z'
        WHERE interview_id = 'interview-pagination-1'`,
    );
    const secondPage = await new ListInterviewsService(unitOfWork).execute({
      after: firstPage.value.nextCursor,
      limit: 100,
    });
    expect(secondPage.ok).toBe(true);
    if (!secondPage.ok) return;
    const collectedIds = [...firstPage.value.interviews, ...secondPage.value.interviews].map(
      (item) => item.interviewId,
    );
    expect(collectedIds.filter((id) => id.startsWith('interview-pagination-'))).toEqual([
      'interview-pagination-3',
      'interview-pagination-2',
      'interview-pagination-1',
    ]);
  });

  it('treats workflow timestamp offsets as idempotent through real PostgreSQL retries', async () => {
    const { pool } = fixture();

    await withRollback(pool, async (client) => {
      await insertRawGuide(client, 'guide:v1:run-offset', 'Run offset');
      await insertRawInterview(client, 'interview-run-offset', 'guide:v1:run-offset');
      await insertRawJob(client, 'interview-run-offset', 'job-run-offset', 'succeeded');
      const repository = new PostgresRunRepository(createClientSqlExecutor(client));
      const running: StoredWorkflowAttempt = {
        interviewId: 'interview-run-offset',
        workflowRunId: 'workflow-run-offset',
        attemptId: 'attempt-run-offset',
        jobId: 'job-run-offset',
        expectedInterviewVersion: 0,
        attemptNumber: 1,
        status: 'running',
        retryCount: 0,
        startedAt: '2026-08-06T12:00:00.000+02:00',
        endedAt: null,
        durationMs: null,
        failure: null,
        rejectionReason: null,
        appliedAt: null,
      };

      await expect(
        repository.startWorkflow('interview-run-offset', running),
      ).resolves.toMatchObject({
        ok: true,
        value: { outcome: 'inserted', value: { startedAt: CREATED_AT } },
      });
      await expect(
        repository.startWorkflow('interview-run-offset', running),
      ).resolves.toMatchObject({
        ok: true,
        value: { outcome: 'existing', value: { startedAt: CREATED_AT } },
      });

      const succeeded: StoredWorkflowAttempt = {
        ...running,
        status: 'succeeded',
        endedAt: '2026-08-06T12:01:00.000+02:00',
        durationMs: 60_000,
        appliedAt: '2026-08-06T12:01:00.000+02:00',
      };
      await expect(
        repository.finishWorkflow(
          'interview-run-offset',
          'workflow-run-offset',
          'running',
          succeeded,
        ),
      ).resolves.toMatchObject({
        ok: true,
        value: { startedAt: CREATED_AT, endedAt: UPDATED_AT, appliedAt: UPDATED_AT },
      });
      await expect(
        repository.finishWorkflow(
          'interview-run-offset',
          'workflow-run-offset',
          'running',
          succeeded,
        ),
      ).resolves.toMatchObject({
        ok: true,
        value: { startedAt: CREATED_AT, endedAt: UPDATED_AT, appliedAt: UPDATED_AT },
      });
    });
  });

  it('enforces exact workflow-step agent binding and permits workflow cascade deletion', async () => {
    const { pool } = fixture();

    await withRollback(pool, async (client) => {
      const interviewId = 'interview-step-agent-binding';
      const workflowRunId = 'workflow-step-agent-binding';
      const agentRunId = 'agent-step-agent-binding';
      await insertRawGuide(client, 'guide:v1:step-agent-binding', 'Step agent binding');
      await insertRawInterview(client, interviewId, 'guide:v1:step-agent-binding');
      await insertRawJob(client, interviewId, 'job-step-agent-binding', 'succeeded');
      await insertRawWorkflow(client, interviewId, 'job-step-agent-binding', workflowRunId);
      const structuredOutput: StructuredAgentOutput = {
        agentName: 'coverage_analysis',
        output: {
          findings: [],
          referencedTranscriptTurnIds: [],
          rationale: 'No evidence was available.',
        },
      };
      const output = JSON.stringify(structuredOutput);
      await client.query(
        `INSERT INTO app.agent_runs (
           id, interview_id, workflow_run_id, agent_name, invocation_number,
           status, retry_count, model_mode, started_at, ended_at, duration_ms,
           input, output
         ) VALUES ($1, $2, $3, 'coverage_analysis', 1, 'succeeded', 0, 'demo',
                   $4, $4, 0, '{}'::jsonb, $5::jsonb)`,
        [agentRunId, interviewId, workflowRunId, CREATED_AT, output],
      );
      await client.query(
        `INSERT INTO app.workflow_step_runs (
           id, interview_id, workflow_run_id, agent_run_id, step, attempt_number,
           status, retry_count, started_at, ended_at, duration_ms, input, output
         ) VALUES ('step-agent-binding', $1, $2, $3, 'coverage_analysis', 1,
                   'succeeded', 0, $4, $4, 0, '{}'::jsonb, $5::jsonb)`,
        [interviewId, workflowRunId, agentRunId, CREATED_AT, output],
      );

      const runningStep: StoredStepCheckpoint = {
        interviewId,
        workflowRunId,
        attemptId: `${workflowRunId}-attempt`,
        stepRunId: 'step-agent-lifecycle',
        agentRunId: null,
        step: 'coverage_analysis',
        attemptNumber: 4,
        status: 'running',
        retryCount: 0,
        referencedTranscriptTurnIds: [],
        referencedGuideQuestionIds: [],
        structuredOutput: null,
        startedAt: CREATED_AT,
        endedAt: null,
        durationMs: null,
        failure: null,
      };
      await client.query(
        `INSERT INTO app.workflow_step_runs (
           id, interview_id, workflow_run_id, step, attempt_number,
           status, retry_count, started_at, input
         ) VALUES ($1, $2, $3, $4, $5, 'running', 0, $6, $7::jsonb)`,
        [
          runningStep.stepRunId,
          interviewId,
          workflowRunId,
          runningStep.step,
          runningStep.attemptNumber,
          CREATED_AT,
          JSON.stringify({
            referencedTranscriptTurnIds: [],
            referencedGuideQuestionIds: [],
          }),
        ],
      );
      const succeededStep: StoredStepCheckpoint = {
        ...runningStep,
        agentRunId,
        status: 'succeeded',
        structuredOutput,
        endedAt: UPDATED_AT,
        durationMs: 60_000,
      };
      const repository = new PostgresRunRepository(createClientSqlExecutor(client));
      await expect(
        repository.finishStep(interviewId, runningStep.stepRunId, 'running', succeededStep),
      ).resolves.toEqual({ ok: true, value: succeededStep });
      await expect(
        repository.finishStep(interviewId, runningStep.stepRunId, 'running', succeededStep),
      ).resolves.toEqual({ ok: true, value: succeededStep });

      await client.query('SAVEPOINT invalid_agent_reference');
      await expect(
        client.query(
          `INSERT INTO app.workflow_step_runs (
             id, interview_id, workflow_run_id, agent_run_id, step, attempt_number,
             status, retry_count, started_at, ended_at, duration_ms, input, output
           ) VALUES ('step-agent-missing', $1, $2, 'agent-unknown', 'coverage_analysis', 2,
                     'succeeded', 0, $3, $3, 0, '{}'::jsonb, $4::jsonb)`,
          [interviewId, workflowRunId, CREATED_AT, output],
        ),
      ).rejects.toMatchObject({ code: '23503', constraint: 'workflow_step_runs_agent_fk' });
      await client.query('ROLLBACK TO SAVEPOINT invalid_agent_reference');
      await client.query('RELEASE SAVEPOINT invalid_agent_reference');
      await client.query('SAVEPOINT missing_agent_attribution');
      await expect(
        client.query(
          `INSERT INTO app.workflow_step_runs (
             id, interview_id, workflow_run_id, step, attempt_number,
             status, retry_count, started_at, ended_at, duration_ms, input, output
           ) VALUES ('step-agent-unattributed', $1, $2, 'coverage_analysis', 3,
                     'succeeded', 0, $3, $3, 0, '{}'::jsonb, $4::jsonb)`,
          [interviewId, workflowRunId, CREATED_AT, output],
        ),
      ).rejects.toMatchObject({ code: '23514', constraint: 'workflow_step_runs_agent_shape' });
      await client.query('ROLLBACK TO SAVEPOINT missing_agent_attribution');
      await client.query('RELEASE SAVEPOINT missing_agent_attribution');

      await client.query('DELETE FROM app.workflow_runs WHERE interview_id = $1 AND id = $2', [
        interviewId,
        workflowRunId,
      ]);
      const remaining = await client.query<{ agent_count: number; step_count: number }>(
        `SELECT
           (SELECT count(*)::integer FROM app.agent_runs WHERE workflow_run_id = $1) AS agent_count,
           (SELECT count(*)::integer FROM app.workflow_step_runs WHERE workflow_run_id = $1) AS step_count`,
        [workflowRunId],
      );
      expect(remaining.rows).toEqual([{ agent_count: 0, step_count: 0 }]);
    });
  });

  it('rolls back repository writes when a unit-of-work callback returns a failure', async () => {
    const state = fixture();
    const unitOfWork = new PostgresUnitOfWork(
      createPgUnitOfWorkPool(state.pool),
      persistenceContexts,
    );
    const guide = guideRecord('rollback');
    const rollbackError: RepositoryError = {
      code: 'constraint_violation',
      constraint: 'integration_forced_rollback',
    };

    const result = await unitOfWork.transaction<never>(async (transaction) => {
      const imported = await transaction.guides.import(guide.guideId, guide);
      return imported.ok ? failure(rollbackError) : imported;
    });

    expect(result).toEqual(failure(rollbackError));
    await expect(
      new PostgresGuideRepository(createPoolSqlExecutor(state.pool)).getById(guide.guideId),
    ).resolves.toEqual({
      ok: false,
      error: { code: 'not_found', resource: 'guide', id: guide.guideId },
    });
  });

  it('enforces foreign-key, unique, and check constraints in PostgreSQL', async () => {
    const { pool } = fixture();

    await withRollback(pool, async (client) => {
      await expect(
        client.query('INSERT INTO app.interviews (id, guide_id, created_at) VALUES ($1, $2, $3)', [
          'orphan-interview',
          'missing-guide',
          CREATED_AT,
        ]),
      ).rejects.toMatchObject({ code: '23503', constraint: 'interviews_guide_fk' });
    });

    await withRollback(pool, async (client) => {
      await insertRawGuide(client, 'guide:v1:unique', 'Unique guide');
      await client.query(
        'INSERT INTO app.guide_sections (guide_id, id, position, title) VALUES ($1, $2, $3, $4)',
        ['guide:v1:unique', 'section-1', 0, 'First section'],
      );
      await expect(
        client.query(
          'INSERT INTO app.guide_sections (guide_id, id, position, title) VALUES ($1, $2, $3, $4)',
          ['guide:v1:unique', 'section-2', 0, 'Second section'],
        ),
      ).rejects.toMatchObject({
        code: '23505',
        constraint: 'guide_sections_position_unique',
      });
    });

    await withRollback(pool, async (client) => {
      await expect(insertRawGuide(client, 'guide:v1:blank-title', '   ')).rejects.toMatchObject({
        code: '23514',
        constraint: 'guides_title_not_blank',
      });
    });
  });

  it('uses real compare-and-swap state updates and monotone counter allocation', async () => {
    const { pool } = fixture();

    await withRollback(pool, async (client) => {
      const executor = createClientSqlExecutor(client);
      const guide = guideRecord('cas');
      const interview = readyInterview(guide.guide);
      const next = activeInterview(interview);
      const guides = new PostgresGuideRepository(executor);
      const interviews = new PostgresInterviewRepository(executor);

      await expect(guides.import(guide.guideId, guide)).resolves.toMatchObject({
        ok: true,
        value: { outcome: 'inserted' },
      });
      await expect(interviews.create(interview.interviewId, interview)).resolves.toMatchObject({
        ok: true,
        value: { outcome: 'inserted' },
      });
      await expect(interviews.compareAndSwap(interview.interviewId, 0, next)).resolves.toEqual({
        ok: true,
        value: next,
      });
      await expect(interviews.compareAndSwap(interview.interviewId, 0, next)).resolves.toEqual({
        ok: false,
        error: {
          code: 'stale_version',
          interviewId: interview.interviewId,
          expected: 0,
          actual: 1,
        },
      });

      const first = await allocateTranscriptSequence(client, interview.interviewId, 1);
      const second = await allocateTranscriptSequence(client, interview.interviewId, 2);
      const stale = await allocateTranscriptSequence(client, interview.interviewId, 1);
      expect([first, second, stale]).toEqual([1, 2, null]);

      const counterResult = await client.query<Record<string, unknown>>(
        `SELECT next_transcript_sequence AS "nextTranscriptSequence"
           FROM app.interview_counters
          WHERE interview_id = $1`,
        [interview.interviewId],
      );
      expect(
        parseSingleRow(counterResult.rows, counterSchema, 'counter').nextTranscriptSequence,
      ).toBe(3);
    });
  });

  it('preserves outbox batch outcomes and deduplicates equivalent timestamp offsets', async () => {
    const { pool } = fixture();

    await withRollback(pool, async (client) => {
      const interviewId = 'interview-outbox-batch';
      await insertRawGuide(client, 'guide:v1:outbox-batch', 'Outbox batch');
      await insertRawInterview(client, interviewId, 'guide:v1:outbox-batch');
      const outbox = new PostgresOutboxRepository(createClientSqlExecutor(client));
      const firstEvent = {
        eventId: 'event-outbox-existing',
        interviewId,
        runId: 'run-outbox-batch',
        occurredAt: CREATED_AT,
        category: 'interview',
        type: 'interview.status_changed',
        payload: {
          previousStatus: 'ready',
          nextStatus: 'active',
          changedAt: CREATED_AT,
        },
      } satisfies MonitoringEventDraft;
      const secondEvent = {
        ...firstEvent,
        eventId: 'event-outbox-new',
        occurredAt: UPDATED_AT,
      } satisfies MonitoringEventDraft;

      await expect(outbox.append(interviewId, firstEvent)).resolves.toMatchObject({
        ok: true,
        value: { outcome: 'inserted', value: { sequenceNumber: 1 } },
      });
      await expect(
        outbox.appendMany(interviewId, [
          secondEvent,
          { ...firstEvent, occurredAt: '2026-08-06T12:00:00.000+02:00' },
        ]),
      ).resolves.toEqual({
        ok: true,
        value: [
          {
            outcome: 'inserted',
            value: { ...secondEvent, language: 'de', sequenceNumber: 2 },
          },
          {
            outcome: 'existing',
            value: { ...firstEvent, language: 'de', sequenceNumber: 1 },
          },
        ],
      });

      const stored = await client.query<{ event_id: string; sequence_number: number }>(
        `SELECT event_id, sequence_number
           FROM app.event_outbox
          WHERE interview_id = $1
          ORDER BY sequence_number`,
        [interviewId],
      );
      expect(stored.rows).toEqual([
        { event_id: firstEvent.eventId, sequence_number: 1 },
        { event_id: secondEvent.eventId, sequence_number: 2 },
      ]);
    });
  });

  it('persists only one concurrent voice transition from the same locked state', async () => {
    const { pool } = fixture();
    const guideId = 'guide:v1:outbox-voice-race';
    const interviewId = 'interview-outbox-voice-race';

    await withCommittedClient(pool, async (client) => {
      await insertRawGuide(client, guideId, 'Outbox voice race');
      await insertRawInterview(client, interviewId, guideId);
    });

    const event = (
      eventId: string,
      nextState: 'listening' | 'processing',
    ): MonitoringEventDraft => ({
      eventId,
      interviewId,
      runId: 'run-outbox-voice-race',
      occurredAt: CREATED_AT,
      category: 'voice',
      type: 'voice.state_changed',
      payload: {
        previousState: 'idle',
        nextState,
        utteranceId: null,
        turnId: null,
        provider: 'demo',
      },
    });

    try {
      const unitOfWork = postgresUnitOfWork(pool);
      const outcomes = await Promise.all([
        unitOfWork.transaction(({ outbox }) =>
          outbox.append(interviewId, event('event-voice-race-listening', 'listening')),
        ),
        unitOfWork.transaction(({ outbox }) =>
          outbox.append(interviewId, event('event-voice-race-processing', 'processing')),
        ),
      ]);

      expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
      expect(outcomes.filter((outcome) => !outcome.ok)).toHaveLength(1);

      const stored = await pool.query<{ sequence_number: number }>(
        `SELECT sequence_number
           FROM app.event_outbox
          WHERE interview_id = $1
          ORDER BY sequence_number`,
        [interviewId],
      );
      expect(stored.rows).toEqual([{ sequence_number: 1 }]);
      await expect(
        new PostgresOutboxRepository(createPoolSqlExecutor(pool)).loadLiveState(interviewId, 1),
      ).resolves.toMatchObject({
        ok: true,
        value: { activeAiTextStream: null },
      });
    } finally {
      await withCommittedClient(pool, async (client) => {
        await client.query('DELETE FROM app.interviews WHERE id = $1', [interviewId]);
        await client.query('DELETE FROM app.guides WHERE id = $1', [guideId]);
      });
    }
  });

  it('publishes outbox wake-ups after commit and suppresses rolled-back inserts', async () => {
    if (TEST_DATABASE_URL === undefined) throw new Error('PostgreSQL test URL is required');
    const { pool } = fixture();
    const guideId = 'guide:v1:outbox-notification';
    const rolledBackInterviewId = 'interview-outbox-notification-rollback';
    const committedInterviewId = 'interview-outbox-notification-commit';
    const listenerConfig = loadDatabaseConfig({
      DATABASE_URL: TEST_DATABASE_URL,
      DATABASE_CONNECTION_TIMEOUT_MS: '5000',
      DATABASE_APPLICATION_NAME: 'orgscience-notification-integration-test',
    });
    const observedPayloads: string[] = [];
    let resolveCommitted: (() => void) | undefined;
    const committedNotification = new Promise<void>((resolvePromise) => {
      resolveCommitted = resolvePromise;
    });
    const listener = createPostgresOutboxNotificationListener(listenerConfig, {
      signal: (interviewId) => {
        observedPayloads.push(interviewId);
        if (interviewId === committedInterviewId) resolveCommitted?.();
      },
    });

    try {
      await withCommittedClient(pool, async (client) => {
        await insertRawGuide(client, guideId, 'Outbox notification');
        await insertRawInterview(client, rolledBackInterviewId, guideId);
        await insertRawInterview(client, committedInterviewId, guideId);
      });
      await listener.start();

      await withRollback(pool, async (client) => {
        const outbox = new PostgresOutboxRepository(createClientSqlExecutor(client));
        await expect(
          outbox.append(rolledBackInterviewId, notificationEvent(rolledBackInterviewId)),
        ).resolves.toMatchObject({ ok: true, value: { outcome: 'inserted' } });
      });
      await withCommittedClient(pool, async (client) => {
        const outbox = new PostgresOutboxRepository(createClientSqlExecutor(client));
        await expect(
          outbox.append(committedInterviewId, notificationEvent(committedInterviewId)),
        ).resolves.toMatchObject({ ok: true, value: { outcome: 'inserted' } });
      });

      await withTestDeadline(committedNotification, 2_000);
      expect(observedPayloads).toEqual([committedInterviewId]);
      await listener.close();

      await withCommittedClient(pool, async (client) => {
        const outbox = new PostgresOutboxRepository(createClientSqlExecutor(client));
        await expect(
          outbox.append(rolledBackInterviewId, notificationEvent(rolledBackInterviewId)),
        ).resolves.toMatchObject({ ok: true, value: { outcome: 'inserted' } });
      });
      expect(observedPayloads).toEqual([committedInterviewId]);
    } finally {
      await listener.close().catch(() => undefined);
      await withCommittedClient(pool, async (client) => {
        await client.query('DELETE FROM app.interviews WHERE id = ANY($1::text[])', [
          [rolledBackInterviewId, committedInterviewId],
        ]);
        await client.query('DELETE FROM app.guides WHERE id = $1', [guideId]);
      });
    }
  });

  it('enforces interview scope for active workflows, AI deliveries, and participant jobs', async () => {
    const { pool } = fixture();

    await withRollback(pool, async (client) => {
      await insertRawGuide(client, 'guide:v1:workflow-scope', 'Workflow scope');
      await insertRawInterview(client, 'interview-scope-a', 'guide:v1:workflow-scope');
      await insertRawInterview(client, 'interview-scope-b', 'guide:v1:workflow-scope');
      await insertRawJob(client, 'interview-scope-b', 'job-scope-b', 'succeeded');
      await insertRawWorkflow(client, 'interview-scope-b', 'job-scope-b', 'workflow-scope-b');

      await expect(
        client.query(
          'UPDATE app.interview_state SET active_workflow_run_id = $2 WHERE interview_id = $1',
          ['interview-scope-a', 'workflow-scope-b'],
        ),
      ).rejects.toMatchObject({
        code: '23503',
        constraint: 'interview_state_active_workflow_fk',
      });
    });

    await withRollback(pool, async (client) => {
      await insertRawGuide(client, 'guide:v1:delivery-scope', 'Delivery scope');
      await insertRawInterview(client, 'interview-delivery', 'guide:v1:delivery-scope');
      await insertRawJob(client, 'interview-delivery', 'job-workflow', 'succeeded');
      await insertRawJob(client, 'interview-delivery', 'job-delivery', 'succeeded');
      await insertRawWorkflow(client, 'interview-delivery', 'job-workflow', 'workflow-delivery');

      await expect(
        client.query(
          `INSERT INTO app.ai_turn_deliveries (
             id, interview_id, job_id, workflow_run_id, turn_id, utterance_id,
             reserved_sequence_number, turn_type, proposed_text, status, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, 1, 'greeting', $7, 'pending', $8)`,
          [
            'delivery-scope',
            'interview-delivery',
            'job-delivery',
            'workflow-delivery',
            'turn-delivery',
            'utterance-delivery',
            'Welcome.',
            CREATED_AT,
          ],
        ),
      ).rejects.toMatchObject({
        code: '23503',
        constraint: 'ai_turn_deliveries_workflow_job_fk',
      });
    });

    await withRollback(pool, async (client) => {
      await insertRawGuide(client, 'guide:v1:source-scope', 'Source scope');
      await insertRawInterview(client, 'interview-source-a', 'guide:v1:source-scope');
      await insertRawInterview(client, 'interview-source-b', 'guide:v1:source-scope');
      await insertRawParticipantTurn(client, 'interview-source-b', 'source-turn', 1, 'utterance-b');

      await expect(
        client.query(
          `INSERT INTO app.durable_jobs (
             id, interview_id, type, idempotency_key, source_turn_id,
             expected_state_version, status, attempt_count, maximum_attempts,
             available_at, created_at, updated_at
           ) VALUES ($1, $2, 'participant_turn', $3, $4, 0, 'queued', 0, 3, $5, $5, $5)`,
          ['job-source-a', 'interview-source-a', 'source-key-a', 'source-turn', CREATED_AT],
        ),
      ).rejects.toMatchObject({
        code: '23503',
        constraint: 'durable_jobs_source_final_segment_fk',
      });
    });

    await withRollback(pool, async (client) => {
      await insertRawGuide(client, 'guide:v1:source-final', 'Final source');
      await insertRawInterview(client, 'interview-source-final', 'guide:v1:source-final');
      await insertRawParticipantTurn(
        client,
        'interview-source-final',
        'unfinalized-turn',
        1,
        'unfinalized-utterance',
        false,
      );
      const unfinalized = await client.query<{ turn_count: number; final_count: number }>(
        `SELECT
           (SELECT count(*)::integer FROM app.transcript_turns
             WHERE interview_id = $1 AND turn_id = $2) AS turn_count,
           (SELECT count(*)::integer FROM app.transcript_final_segments
             WHERE interview_id = $1 AND turn_id = $2) AS final_count`,
        ['interview-source-final', 'unfinalized-turn'],
      );
      expect(unfinalized.rows).toEqual([{ turn_count: 1, final_count: 0 }]);

      await expect(
        client.query(
          `INSERT INTO app.durable_jobs (
             id, interview_id, type, idempotency_key, source_turn_id,
             expected_state_version, status, attempt_count, maximum_attempts,
             available_at, created_at, updated_at
           ) VALUES ($1, $2, 'participant_turn', $3, $4, 0, 'queued', 0, 3, $5, $5, $5)`,
          [
            'job-source-final',
            'interview-source-final',
            'source-final-key',
            'unfinalized-turn',
            CREATED_AT,
          ],
        ),
      ).rejects.toMatchObject({
        code: '23503',
        constraint: 'durable_jobs_source_final_segment_fk',
      });
    });
  });

  it('deduplicates final STT utterances independently of provider event ids', async () => {
    const { pool } = fixture();

    await withRollback(pool, async (client) => {
      await insertRawGuide(client, 'guide:v1:utterance-dedupe', 'Utterance dedupe');
      await insertRawInterview(client, 'interview-utterance', 'guide:v1:utterance-dedupe');
      await insertRawParticipantTurn(
        client,
        'interview-utterance',
        'participant-turn-1',
        1,
        'utterance-shared',
      );

      await client.query(
        `INSERT INTO app.transcript_entries
           (interview_id, sequence_number, entry_id, kind, occurred_at)
         VALUES ($1, 2, $2, 'turn', $3)`,
        ['interview-utterance', 'participant-turn-2', UPDATED_AT],
      );
      await client.query(
        `INSERT INTO app.transcript_turns (
           interview_id, turn_id, entry_kind, speaker, turn_type, text,
           source_provider, provider_event_id, source_segment_id
         ) VALUES ($1, $2, 'turn', 'participant', 'participant_answer', $3,
                   'demo-stt', $4, $5)`,
        [
          'interview-utterance',
          'participant-turn-2',
          'Second answer',
          'provider-event-2',
          'segment-2',
        ],
      );

      await expect(
        client.query(
          `INSERT INTO app.transcript_final_segments (
             interview_id, provider, provider_event_id, segment_id, utterance_id,
             turn_id, text, observed_at, finalized_at
           ) VALUES ($1, 'demo-stt', $2, $3, $4, $5, $6, $7, $7)`,
          [
            'interview-utterance',
            'provider-event-2',
            'segment-2',
            'utterance-shared',
            'participant-turn-2',
            'Second answer',
            UPDATED_AT,
          ],
        ),
      ).rejects.toMatchObject({
        code: '23505',
        constraint: 'transcript_final_segments_utterance_unique',
      });
    });
  });

  it('scopes participant and STT-gap source identities by provider', async () => {
    const { pool } = fixture();

    await withRollback(pool, async (client) => {
      await insertRawGuide(client, 'guide:v1:provider-scope', 'Provider scope');
      await insertRawInterview(client, 'interview-provider-scope', 'guide:v1:provider-scope');
      for (const [index, provider] of ['stt-a', 'stt-b'].entries()) {
        const sequenceNumber = index + 1;
        const turnId = `provider-turn-${sequenceNumber}`;
        await client.query(
          `INSERT INTO app.transcript_entries
             (interview_id, sequence_number, entry_id, kind, occurred_at)
           VALUES ('interview-provider-scope', $1, $2, 'turn', $3)`,
          [sequenceNumber, turnId, index === 0 ? CREATED_AT : UPDATED_AT],
        );
        await client.query(
          `INSERT INTO app.transcript_turns (
             interview_id, turn_id, entry_kind, speaker, turn_type, text,
             source_provider, provider_event_id, source_segment_id
           ) VALUES ('interview-provider-scope', $1, 'turn', 'participant',
                     'participant_answer', $2, $3, 'shared-event', 'shared-segment')`,
          [turnId, `Answer ${sequenceNumber}`, provider],
        );
        await client.query(
          `INSERT INTO app.transcript_final_segments (
             interview_id, provider, provider_event_id, segment_id, utterance_id,
             turn_id, text, observed_at, finalized_at
           ) VALUES ('interview-provider-scope', $1, 'shared-event', 'shared-segment',
                     'shared-utterance', $2, $3, $4, $4)`,
          [provider, turnId, `Answer ${sequenceNumber}`, index === 0 ? CREATED_AT : UPDATED_AT],
        );
      }

      const stored = await client.query<{ count: number }>(
        `SELECT count(*)::integer AS count FROM app.transcript_final_segments
          WHERE interview_id = 'interview-provider-scope'`,
      );
      expect(stored.rows).toEqual([{ count: 2 }]);
    });

    await withRollback(pool, async (client) => {
      await insertRawGuide(client, 'guide:v1:provider-fk', 'Provider foreign key');
      await insertRawInterview(client, 'interview-provider-fk', 'guide:v1:provider-fk');
      await client.query(
        `INSERT INTO app.transcript_entries
           (interview_id, sequence_number, entry_id, kind, occurred_at)
         VALUES ('interview-provider-fk', 1, 'provider-fk-turn', 'turn', $1)`,
        [CREATED_AT],
      );
      await client.query(
        `INSERT INTO app.transcript_turns (
           interview_id, turn_id, entry_kind, speaker, turn_type, text,
           source_provider, provider_event_id, source_segment_id
         ) VALUES ('interview-provider-fk', 'provider-fk-turn', 'turn', 'participant',
                   'participant_answer', 'Answer', 'stt-a', 'event-a', 'segment-a')`,
      );
      await expect(
        client.query(
          `INSERT INTO app.transcript_final_segments (
             interview_id, provider, provider_event_id, segment_id, utterance_id,
             turn_id, text, observed_at, finalized_at
           ) VALUES ('interview-provider-fk', 'stt-b', 'event-a', 'segment-a',
                     'utterance-a', 'provider-fk-turn', 'Answer', $1, $1)`,
          [CREATED_AT],
        ),
      ).rejects.toMatchObject({
        code: '23503',
        constraint: 'transcript_final_segments_turn_fk',
      });
    });

    await withRollback(pool, async (client) => {
      await insertRawGuide(client, 'guide:v1:gap-provider', 'Gap provider scope');
      await insertRawInterview(client, 'interview-gap-provider', 'guide:v1:gap-provider');
      for (const [index, provider] of ['stt-a', 'stt-b'].entries()) {
        const sequenceNumber = index + 1;
        const gapId = `provider-gap-${sequenceNumber}`;
        await client.query(
          `INSERT INTO app.transcript_entries
             (interview_id, sequence_number, entry_id, kind, occurred_at)
           VALUES ('interview-gap-provider', $1, $2, 'technical_gap', $3)`,
          [sequenceNumber, gapId, index === 0 ? CREATED_AT : UPDATED_AT],
        );
        await client.query(
          `INSERT INTO app.transcript_gaps (
             interview_id, gap_id, entry_kind, source, provider, description,
             related_segment_id, related_utterance_id, source_event_id
           ) VALUES ('interview-gap-provider', $1, 'technical_gap', 'speech_to_text',
                     $2, 'Missing final segment', 'shared-segment',
                     'shared-gap-utterance', 'shared-gap-event')`,
          [gapId, provider],
        );
      }
      const stored = await client.query<{ count: number }>(
        `SELECT count(*)::integer AS count FROM app.transcript_gaps
          WHERE interview_id = 'interview-gap-provider'`,
      );
      expect(stored.rows).toEqual([{ count: 2 }]);
    });
  });

  it('round-trips provider-scoped identities through the canonical aggregate', async () => {
    const { pool } = fixture();
    const guide = guideRecord('provider-roundtrip');
    const interview = readyInterview(guide.guide);
    const jobId = `job-${interview.interviewId}`;
    const workflowRunId = `workflow-${interview.interviewId}`;
    const unitOfWork = postgresUnitOfWork(pool);
    const section = guide.guide.sections[0]!;
    const main = section.mainQuestions[0]!;
    const followUp = main.followUpQuestions[0]!;
    const mainReference: TranscriptGuideReference = {
      kind: 'main_question',
      guideId: guide.guideId,
      sectionId: section.id,
      mainQuestionId: main.id,
    };
    const followUpReference: TranscriptGuideReference = {
      kind: 'follow_up_question',
      guideId: guide.guideId,
      sectionId: section.id,
      mainQuestionId: main.id,
      followUpQuestionId: followUp.id,
    };
    try {
      await expect(
        unitOfWork.transaction(async (transaction) => {
          const imported = await transaction.guides.import(guide.guideId, guide);
          if (!imported.ok) return imported;
          return transaction.interviews.create(interview.interviewId, interview);
        }),
      ).resolves.toMatchObject({ ok: true });
      await withCommittedClient(pool, async (client) => {
        await insertRawJob(client, interview.interviewId, jobId, 'succeeded');
        await insertRawWorkflow(client, interview.interviewId, jobId, workflowRunId);
      });

      await persistAiTurn(pool, jobId, workflowRunId, {
        kind: 'turn',
        interviewId: interview.interviewId,
        sequenceNumber: 1,
        turnId: 'provider-roundtrip-greeting',
        deliveryEventId: 'provider-roundtrip-delivery-1',
        speaker: 'ai_interviewer',
        turnType: 'greeting',
        text: 'Welcome to the interview.',
        occurredAt: CREATED_AT,
        guideReference: null,
        delivery: { status: 'complete' },
      });
      await persistAiTurn(pool, jobId, workflowRunId, {
        kind: 'turn',
        interviewId: interview.interviewId,
        sequenceNumber: 2,
        turnId: 'provider-roundtrip-main',
        deliveryEventId: 'provider-roundtrip-delivery-2',
        speaker: 'ai_interviewer',
        turnType: 'main_question',
        text: main.text,
        occurredAt: CREATED_AT,
        guideReference: mainReference,
        delivery: { status: 'complete' },
      });
      const rejectedSource = { provider: 'stt-a', utteranceId: 'shared-utterance' };
      const rejectedFinal: FinalizedParticipantSegment = {
        interviewId: interview.interviewId,
        sourceProvider: rejectedSource.provider,
        utteranceId: rejectedSource.utteranceId,
        providerEventId: 'shared-event',
        segmentId: 'shared-segment',
        turnId: 'provider-roundtrip-answer-stt-a',
        text: 'First provider answer.',
        occurredAt: CREATED_AT,
        observedAt: CREATED_AT,
        finalizedAt: CREATED_AT,
        guideReference: followUpReference,
      };
      const rejectedTurn: ParticipantTranscriptTurn = {
        kind: 'turn',
        interviewId: interview.interviewId,
        sequenceNumber: 3,
        turnId: rejectedFinal.turnId,
        sourceProvider: rejectedSource.provider,
        providerEventId: rejectedFinal.providerEventId,
        speaker: 'participant',
        turnType: 'participant_answer',
        text: rejectedFinal.text,
        occurredAt: CREATED_AT,
        guideReference: followUpReference,
        sourceSegmentId: rejectedFinal.segmentId,
      };
      await expect(
        unitOfWork.transaction((transaction) =>
          transaction.transcripts.appendParticipantFinal(
            interview.interviewId,
            3,
            rejectedSource,
            rejectedFinal,
            rejectedTurn,
          ),
        ),
      ).resolves.toEqual({
        ok: false,
        error: {
          code: 'constraint_violation',
          constraint: 'transcript_participant_question_reference_mismatch',
        },
      });
      await persistParticipantTurn(pool, 3, 'stt-a', 'First provider answer.', mainReference);
      const lateGap: TranscriptTechnicalGap = {
        kind: 'technical_gap',
        interviewId: interview.interviewId,
        sequenceNumber: 4,
        gapId: 'provider-roundtrip-late-gap',
        sourceEventId: 'provider-roundtrip-late-gap-event',
        source: 'speech_to_text',
        sourceProvider: 'stt-a',
        relatedUtteranceId: 'late-gap-utterance',
        description: 'A late provider error for an already finalized utterance.',
        occurredAt: CREATED_AT,
        relatedSegmentId: 'shared-segment',
      };
      await expect(
        unitOfWork.transaction((transaction) =>
          transaction.transcripts.appendTechnicalGap(interview.interviewId, 4, lateGap),
        ),
      ).resolves.toEqual({
        ok: false,
        error: {
          code: 'duplicate_conflict',
          resource: 'transcript',
          identity: 'stt-a:late-gap-utterance',
        },
      });
      await expect(
        pool.query<{ next_sequence: number }>(
          `SELECT next_transcript_sequence AS next_sequence
             FROM app.interview_counters
            WHERE interview_id = $1`,
          [interview.interviewId],
        ),
      ).resolves.toMatchObject({ rows: [{ next_sequence: 4 }] });
      await persistAiTurn(pool, jobId, workflowRunId, {
        kind: 'turn',
        interviewId: interview.interviewId,
        sequenceNumber: 4,
        turnId: 'provider-roundtrip-follow-up',
        deliveryEventId: 'provider-roundtrip-delivery-4',
        speaker: 'ai_interviewer',
        turnType: 'follow_up_question',
        text: followUp.text,
        occurredAt: CREATED_AT,
        guideReference: followUpReference,
        delivery: { status: 'complete' },
      });
      await persistParticipantTurn(pool, 5, 'stt-b', 'Second provider answer.', followUpReference);
      for (const [sequenceNumber, provider] of [
        [6, 'stt-a'],
        [7, 'stt-b'],
      ] as const) {
        const gap: TranscriptTechnicalGap = {
          kind: 'technical_gap',
          interviewId: interview.interviewId,
          sequenceNumber,
          gapId: `provider-roundtrip-gap-${provider}`,
          sourceEventId: 'shared-gap-event',
          source: 'speech_to_text',
          sourceProvider: provider,
          relatedUtteranceId: 'shared-gap-utterance',
          description: `A separate ${provider} interval could not be finalized.`,
          occurredAt: CREATED_AT,
          relatedSegmentId: null,
        };
        await expect(
          unitOfWork.transaction((transaction) =>
            transaction.transcripts.appendTechnicalGap(interview.interviewId, sequenceNumber, gap),
          ),
        ).resolves.toMatchObject({ ok: true, value: { outcome: 'inserted' } });
      }
      await persistAiTurn(pool, jobId, workflowRunId, {
        kind: 'turn',
        interviewId: interview.interviewId,
        sequenceNumber: 8,
        turnId: 'provider-roundtrip-closing',
        deliveryEventId: 'provider-roundtrip-delivery-8',
        speaker: 'ai_interviewer',
        turnType: 'closing',
        text: 'Thank you for participating.',
        occurredAt: UPDATED_AT,
        guideReference: null,
        delivery: { status: 'complete' },
      });

      const loaded = await unitOfWork.transaction((transaction) =>
        transaction.transcripts.loadAggregate(interview.interviewId),
      );
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      expect(loaded.value.finals.map((final) => final.sourceProvider)).toEqual(['stt-a', 'stt-b']);
      expect(loaded.value.finals.map((final) => final.utteranceId)).toEqual([
        'shared-utterance',
        'shared-utterance',
      ]);
      expect(
        loaded.value.entries
          .filter((entry) => entry.kind === 'technical_gap')
          .map((gap) => gap.sourceProvider),
      ).toEqual(['stt-a', 'stt-b']);
      expect(validateFinalTranscript(loaded.value)).toEqual({ valid: true, issues: [] });
    } finally {
      await removeInterviewAndGuide(pool, interview.interviewId, guide.guideId);
    }

    async function persistParticipantTurn(
      databasePool: Pool,
      sequenceNumber: number,
      provider: string,
      text: string,
      guideReference: TranscriptGuideReference,
    ): Promise<void> {
      const source = { provider, utteranceId: 'shared-utterance' };
      const turnId = `provider-roundtrip-answer-${provider}`;
      const final: FinalizedParticipantSegment = {
        interviewId: interview.interviewId,
        sourceProvider: provider,
        utteranceId: source.utteranceId,
        providerEventId: 'shared-event',
        segmentId: 'shared-segment',
        turnId,
        text,
        occurredAt: CREATED_AT,
        observedAt: CREATED_AT,
        finalizedAt: CREATED_AT,
        guideReference,
      };
      const turn: ParticipantTranscriptTurn = {
        kind: 'turn',
        interviewId: interview.interviewId,
        sequenceNumber,
        turnId,
        sourceProvider: provider,
        providerEventId: final.providerEventId,
        speaker: 'participant',
        turnType: 'participant_answer',
        text,
        occurredAt: CREATED_AT,
        guideReference,
        sourceSegmentId: final.segmentId,
      };
      await expect(
        postgresUnitOfWork(databasePool).transaction((transaction) =>
          transaction.transcripts.appendParticipantFinal(
            interview.interviewId,
            sequenceNumber,
            source,
            final,
            turn,
          ),
        ),
      ).resolves.toMatchObject({ ok: true, value: { outcome: 'inserted' } });
    }
  });

  it('rejects lifecycle timestamp regressions and failed-from shape mismatches', async () => {
    const { pool } = fixture();

    await withRollback(pool, async (client) => {
      await insertRawGuide(client, 'guide:v1:lifecycle-active-time', 'Lifecycle active time');
      await insertRawInterview(
        client,
        'interview-lifecycle-active-time',
        'guide:v1:lifecycle-active-time',
      );
      await expect(
        client.query(
          `UPDATE app.interview_state
              SET status = 'active', started_at = $2, active_since = $3, updated_at = $2
            WHERE interview_id = $1`,
          ['interview-lifecycle-active-time', UPDATED_AT, '2026-08-06T09:59:00.000Z'],
        ),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'interview_state_lifecycle_time_order',
      });
    });

    await withRollback(pool, async (client) => {
      await insertRawGuide(client, 'guide:v1:lifecycle-failed-from', 'Lifecycle failed from');
      await insertRawInterview(
        client,
        'interview-lifecycle-failed-from',
        'guide:v1:lifecycle-failed-from',
      );
      await expect(
        client.query(
          `UPDATE app.interview_state
              SET status = 'failed', started_at = $2, failed_at = $3,
                  failed_from = 'ready', failure_code = 'provider_error',
                  failure_message = 'Provider failed', updated_at = $3
            WHERE interview_id = $1`,
          ['interview-lifecycle-failed-from', CREATED_AT, UPDATED_AT],
        ),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'interview_state_lifecycle_time_order',
      });
    });

    await withRollback(pool, async (client) => {
      await insertRawGuide(client, 'guide:v1:lifecycle-complete-time', 'Lifecycle complete time');
      await insertRawInterview(
        client,
        'interview-lifecycle-complete-time',
        'guide:v1:lifecycle-complete-time',
      );
      await expect(
        client.query(
          `UPDATE app.interview_state
              SET status = 'completed', started_at = $2, ending_at = $3,
                  ended_at = $2, updated_at = $3
            WHERE interview_id = $1`,
          ['interview-lifecycle-complete-time', CREATED_AT, UPDATED_AT],
        ),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'interview_state_lifecycle_time_order',
      });
    });
  });

  it('serializes concurrent AI sequence reservations across real connections', async () => {
    const { pool } = fixture();
    const committed = await createCommittedInterviewFixture(pool, 'concurrent-reservation');
    try {
      const unitOfWork = postgresUnitOfWork(pool);
      const left = aiReservation(committed, 'left');
      const right = aiReservation(committed, 'right');
      const results = await Promise.all([
        unitOfWork.transaction((transaction) =>
          transaction.transcripts.reserveAiDelivery(committed.interviewId, 1, left),
        ),
        unitOfWork.transaction((transaction) =>
          transaction.transcripts.reserveAiDelivery(committed.interviewId, 1, right),
        ),
      ]);

      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(
        results.some(
          (result) =>
            !result.ok &&
            (('retryable' in result.error && result.error.retryable === true) ||
              result.error.code === 'pending_ai_delivery'),
        ),
      ).toBe(true);
      const winner = results[0]?.ok === true ? left : right;
      const loser = winner.deliveryId === left.deliveryId ? right : left;
      await expect(
        unitOfWork.transaction((transaction) =>
          transaction.transcripts.reserveAiDelivery(committed.interviewId, 1, loser),
        ),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'pending_ai_delivery', deliveryId: winner.deliveryId },
      });

      const state = await pool.query<{ pending_count: number; next_sequence: number }>(
        `SELECT
           (SELECT count(*)::integer FROM app.ai_turn_deliveries
             WHERE interview_id = $1 AND status = 'pending') AS pending_count,
           (SELECT next_transcript_sequence FROM app.interview_counters
             WHERE interview_id = $1) AS next_sequence`,
        [committed.interviewId],
      );
      expect(state.rows).toEqual([{ pending_count: 1, next_sequence: 2 }]);
    } finally {
      await removeCommittedInterviewFixture(pool, committed);
    }
  });

  it('holds an owned job lease through side effects and commit before cancellation', async () => {
    const { pool } = fixture();
    const guideId = 'guide:v1:owned-lease-fencing';
    const interviewId = 'interview-owned-lease-fencing';
    const jobId = 'job-owned-lease-fencing';
    const leaseToken = 'lease-owned-lease-fencing';
    const leaseExpiresAt = '2099-01-01T00:00:00.000Z';
    const sideEffectStaged = createSignal();
    const allowOwnerCommit = createSignal();
    const cancellationClient = await pool.connect();
    let cancellationTransactionOpen = false;
    let ownerPromise: ReturnType<PostgresUnitOfWork['transaction']> | undefined;
    let cancellationPromise: ReturnType<PostgreSqlJobRepository['cancel']> | undefined;
    try {
      await withCommittedClient(pool, async (client) => {
        await insertRawGuide(client, guideId, 'Owned lease fencing');
        await insertRawInterview(client, interviewId, guideId);
        await insertRawRunningJob(client, interviewId, jobId, leaseToken, leaseExpiresAt);
      });

      ownerPromise = postgresUnitOfWork(pool).transaction(async (transaction) => {
        const owned = await transaction.jobs.requireOwnedLease(interviewId, jobId, leaseToken);
        if (!owned.ok) return owned;
        const sideEffect = await transaction.outbox.append(interviewId, {
          eventId: 'event-owned-lease-fencing',
          interviewId,
          runId: 'run-owned-lease-fencing',
          occurredAt: CREATED_AT,
          category: 'interview',
          type: 'interview.status_changed',
          payload: {
            previousStatus: 'ready',
            nextStatus: 'active',
            changedAt: CREATED_AT,
          },
        });
        if (!sideEffect.ok) return sideEffect;
        sideEffectStaged.resolve();
        await allowOwnerCommit.promise;
        return sideEffect;
      });
      const ownerPhase = await Promise.race([
        sideEffectStaged.promise.then(() => 'staged' as const),
        ownerPromise.then(() => 'finished' as const),
      ]);
      expect(ownerPhase).toBe('staged');

      const backendPid = await readBackendPid(cancellationClient);
      await cancellationClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      cancellationTransactionOpen = true;
      let cancellationSettled = false;
      cancellationPromise = new PostgreSqlJobRepository(createClientSqlExecutor(cancellationClient))
        .cancel(interviewId, jobId, 'operator_cancelled')
        .finally(() => {
          cancellationSettled = true;
        });

      await waitUntilBlocked(pool, backendPid);
      expect(cancellationSettled).toBe(false);
      await expect(
        pool.query<{ count: number }>(
          `SELECT count(*)::integer AS count
             FROM app.event_outbox
            WHERE interview_id = $1 AND event_id = 'event-owned-lease-fencing'`,
          [interviewId],
        ),
      ).resolves.toMatchObject({ rows: [{ count: 0 }] });

      allowOwnerCommit.resolve();
      await expect(ownerPromise).resolves.toMatchObject({
        ok: true,
        value: { outcome: 'inserted', value: { eventId: 'event-owned-lease-fencing' } },
      });
      await expect(cancellationPromise).resolves.toMatchObject({
        ok: true,
        value: { outcome: 'inserted', value: { status: 'cancelled' } },
      });
      await cancellationClient.query('COMMIT');
      cancellationTransactionOpen = false;

      await expect(
        pool.query<{ count: number }>(
          `SELECT count(*)::integer AS count
             FROM app.event_outbox
            WHERE interview_id = $1 AND event_id = 'event-owned-lease-fencing'`,
          [interviewId],
        ),
      ).resolves.toMatchObject({ rows: [{ count: 1 }] });
    } finally {
      allowOwnerCommit.resolve();
      if (ownerPromise !== undefined) await ownerPromise.catch(() => undefined);
      if (cancellationPromise !== undefined) await cancellationPromise.catch(() => undefined);
      if (cancellationTransactionOpen) await cancellationClient.query('ROLLBACK');
      cancellationClient.release();
      await removeInterviewAndGuide(pool, interviewId, guideId);
    }
  });

  it('rejects an owned lease expired according to PostgreSQL server time', async () => {
    const { pool } = fixture();
    const guideId = 'guide:v1:server-expired-lease';
    const interviewId = 'interview-server-expired-lease';
    const jobId = 'job-server-expired-lease';
    const leaseToken = 'lease-server-expired';
    try {
      await withCommittedClient(pool, async (client) => {
        await insertRawGuide(client, guideId, 'Server-expired lease');
        await insertRawInterview(client, interviewId, guideId);
        await insertRawRunningJob(
          client,
          interviewId,
          jobId,
          leaseToken,
          '2000-01-02T00:00:00.000Z',
        );
      });

      await expect(
        postgresUnitOfWork(pool).transaction((transaction) =>
          transaction.jobs.requireOwnedLease(interviewId, jobId, leaseToken),
        ),
      ).resolves.toEqual({
        ok: false,
        error: { code: 'lease_lost', interviewId, jobId, leaseToken },
      });
    } finally {
      await removeInterviewAndGuide(pool, interviewId, guideId);
    }
  });

  it('does not renew a lease that expires while waiting for its job row lock', async () => {
    const { pool } = fixture();
    const guideId = 'guide:v1:renew-after-lock-expiry';
    const interviewId = 'interview-renew-after-lock-expiry';
    const jobId = 'job-renew-after-lock-expiry';
    const leaseToken = 'lease-renew-after-lock-expiry';
    const blocker = await pool.connect();
    const renewal = await pool.connect();
    let blockerOpen = false;
    let renewalOpen = false;
    let renewalPromise: ReturnType<PostgreSqlJobRepository['renewLease']> | undefined;
    try {
      await withCommittedClient(pool, async (client) => {
        await insertRawGuide(client, guideId, 'Renew after lock expiry');
        await insertRawInterview(client, interviewId, guideId);
        await insertRawRunningJob(client, interviewId, jobId, leaseToken, '2099-01-01T00:00:00Z');
        await client.query(
          `UPDATE app.durable_jobs
              SET lease_expires_at = clock_timestamp() + interval '1 second'
            WHERE interview_id = $1 AND id = $2`,
          [interviewId, jobId],
        );
      });

      await blocker.query('BEGIN');
      blockerOpen = true;
      await blocker.query(
        `SELECT id FROM app.durable_jobs
          WHERE interview_id = $1 AND id = $2
          FOR UPDATE`,
        [interviewId, jobId],
      );
      await renewal.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      renewalOpen = true;
      const renewalPid = await readBackendPid(renewal);
      renewalPromise = new PostgreSqlJobRepository(createClientSqlExecutor(renewal)).renewLease(
        interviewId,
        jobId,
        leaseToken,
        60_000,
      );
      await waitUntilBlocked(pool, renewalPid);
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      await blocker.query('COMMIT');
      blockerOpen = false;

      await expect(renewalPromise).resolves.toEqual({
        ok: false,
        error: { code: 'lease_lost', interviewId, jobId, leaseToken },
      });
      await renewal.query('COMMIT');
      renewalOpen = false;
    } finally {
      if (blockerOpen) await blocker.query('ROLLBACK');
      if (renewalPromise !== undefined) await renewalPromise.catch(() => undefined);
      if (renewalOpen) await renewal.query('ROLLBACK');
      blocker.release();
      renewal.release();
      await removeInterviewAndGuide(pool, interviewId, guideId);
    }
  });

  it('derives initial job availability and creation timestamps from PostgreSQL', async () => {
    const { pool } = fixture();
    const guideId = 'guide:v1:enqueue-server-clock';
    const interviewId = 'interview-enqueue-server-clock';
    const job: EnqueueJobInput = {
      jobId: 'job-enqueue-server-clock',
      kind: 'start_interview',
      idempotencyKey: 'start:interview-enqueue-server-clock',
      sourceTurnId: null,
      expectedInterviewVersion: 0,
      maximumAttempts: 3,
      initialDelayMs: 0,
      resultDeliveryId: null,
    };
    try {
      await withCommittedClient(pool, async (client) => {
        await insertRawGuide(client, guideId, 'Enqueue server clock');
        await insertRawInterview(client, interviewId, guideId);
      });

      await expect(
        postgresUnitOfWork(pool).transaction((transaction) =>
          transaction.jobs.enqueue(interviewId, job),
        ),
      ).resolves.toMatchObject({
        ok: true,
        value: {
          outcome: 'inserted',
          value: {
            interviewId,
            jobId: job.jobId,
            status: 'queued',
            availableAt: expect.any(String),
            createdAt: expect.any(String),
            updatedAt: expect.any(String),
          },
        },
      });
      await expect(
        pool.query<{ timestamps_match: boolean }>(
          `SELECT available_at = created_at AND updated_at = created_at AS timestamps_match
             FROM app.durable_jobs
            WHERE interview_id = $1 AND id = $2`,
          [interviewId, job.jobId],
        ),
      ).resolves.toMatchObject({ rows: [{ timestamps_match: true }] });
      await expect(
        postgresUnitOfWork(pool).transaction((transaction) =>
          transaction.jobs.claimNext({
            workerId: 'worker-enqueue-server-clock',
            leaseDurationMs: 60_000,
          }),
        ),
      ).resolves.toMatchObject({
        ok: true,
        value: { interviewId, jobId: job.jobId, status: 'running' },
      });
    } finally {
      await removeInterviewAndGuide(pool, interviewId, guideId);
    }
  });

  it('does not claim a job scheduled after PostgreSQL server time', async () => {
    const { pool } = fixture();
    const guideId = 'guide:v1:claim-server-clock';
    const interviewId = 'interview-claim-server-clock';
    const jobId = 'job-claim-server-clock';
    try {
      await withCommittedClient(pool, async (client) => {
        await insertRawGuide(client, guideId, 'Claim server clock');
        await insertRawInterview(client, interviewId, guideId);
        await insertRawJob(client, interviewId, jobId, 'queued');
        await client.query(
          `UPDATE app.durable_jobs
              SET available_at = '2099-01-01T00:00:00.000Z'
            WHERE interview_id = $1 AND id = $2`,
          [interviewId, jobId],
        );
      });

      await expect(
        postgresUnitOfWork(pool).transaction((transaction) =>
          transaction.jobs.claimNext({
            workerId: 'worker-future-clock',
            leaseDurationMs: 60_000,
          }),
        ),
      ).resolves.toEqual({ ok: true, value: null });
      await expect(
        pool.query<{ status: string; attempt_count: number }>(
          `SELECT status, attempt_count
             FROM app.durable_jobs
            WHERE interview_id = $1 AND id = $2`,
          [interviewId, jobId],
        ),
      ).resolves.toMatchObject({ rows: [{ status: 'queued', attempt_count: 0 }] });
    } finally {
      await removeInterviewAndGuide(pool, interviewId, guideId);
    }
  });

  it('claims a due job and derives its bounded lease from PostgreSQL server time', async () => {
    const { pool } = fixture();
    const guideId = 'guide:v1:claim-server-duration';
    const interviewId = 'interview-claim-server-duration';
    const jobId = 'job-claim-server-duration';
    try {
      await withCommittedClient(pool, async (client) => {
        await insertRawGuide(client, guideId, 'Claim server duration');
        await insertRawInterview(client, interviewId, guideId);
        await insertRawJob(client, interviewId, jobId, 'queued');
        await client.query(
          `UPDATE app.durable_jobs
              SET available_at = clock_timestamp() - interval '1 minute'
            WHERE interview_id = $1 AND id = $2`,
          [interviewId, jobId],
        );
      });

      await expect(
        postgresUnitOfWork(pool).transaction((transaction) =>
          transaction.jobs.claimNext({
            workerId: 'worker-server-duration',
            leaseDurationMs: 60_000,
          }),
        ),
      ).resolves.toMatchObject({
        ok: true,
        value: { interviewId, jobId, status: 'running', leaseOwner: 'worker-server-duration' },
      });
      await expect(
        pool.query<{ bounded: boolean }>(
          `SELECT lease_expires_at > clock_timestamp() + interval '50 seconds'
                    AND lease_expires_at <= clock_timestamp() + interval '70 seconds' AS bounded
             FROM app.durable_jobs
            WHERE interview_id = $1 AND id = $2`,
          [interviewId, jobId],
        ),
      ).resolves.toMatchObject({ rows: [{ bounded: true }] });
    } finally {
      await removeInterviewAndGuide(pool, interviewId, guideId);
    }
  });

  it('does not reclaim a lease still valid according to PostgreSQL server time', async () => {
    const { pool } = fixture();
    const guideId = 'guide:v1:reclaim-server-clock';
    const interviewId = 'interview-reclaim-server-clock';
    const jobId = 'job-reclaim-server-clock';
    const leaseToken = 'lease-reclaim-server-clock';
    try {
      await withCommittedClient(pool, async (client) => {
        await insertRawGuide(client, guideId, 'Reclaim server clock');
        await insertRawInterview(client, interviewId, guideId);
        await insertRawRunningJob(
          client,
          interviewId,
          jobId,
          leaseToken,
          '2099-01-01T00:00:00.000Z',
        );
      });

      await expect(
        postgresUnitOfWork(pool).transaction((transaction) => transaction.jobs.reclaimExpired()),
      ).resolves.toEqual({ ok: true, value: 0 });
      await expect(
        pool.query<{ status: string; lease_token: string }>(
          `SELECT status, lease_token
             FROM app.durable_jobs
            WHERE interview_id = $1 AND id = $2`,
          [interviewId, jobId],
        ),
      ).resolves.toMatchObject({
        rows: [{ status: 'running', lease_token: leaseToken }],
      });
    } finally {
      await removeInterviewAndGuide(pool, interviewId, guideId);
    }
  });

  it('reclaims a lease expired according to PostgreSQL server time', async () => {
    const { pool } = fixture();
    const guideId = 'guide:v1:reclaim-server-expired';
    const interviewId = 'interview-reclaim-server-expired';
    const jobId = 'job-reclaim-server-expired';
    const leaseToken = 'lease-reclaim-server-expired';
    try {
      await withCommittedClient(pool, async (client) => {
        await insertRawGuide(client, guideId, 'Reclaim server expired');
        await insertRawInterview(client, interviewId, guideId);
        await insertRawRunningJob(
          client,
          interviewId,
          jobId,
          leaseToken,
          '2000-01-01T00:00:00.000Z',
        );
      });

      await expect(
        postgresUnitOfWork(pool).transaction((transaction) => transaction.jobs.reclaimExpired()),
      ).resolves.toEqual({ ok: true, value: 1 });
      await expect(
        pool.query<{ status: string; lease_expires_at: string | null }>(
          `SELECT status, lease_expires_at
             FROM app.durable_jobs
            WHERE interview_id = $1 AND id = $2`,
          [interviewId, jobId],
        ),
      ).resolves.toMatchObject({ rows: [{ status: 'queued', lease_expires_at: null }] });
    } finally {
      await removeInterviewAndGuide(pool, interviewId, guideId);
    }
  });

  it('prevents completion until a pending AI delivery is resolved exactly', async () => {
    const { pool } = fixture();
    const guide = guideRecord('completion-pending');
    const interview = readyInterview(guide.guide);
    const { active, ending, completed: next, failed } = completionProgression(interview);
    const unitOfWork = postgresUnitOfWork(pool);
    try {
      await expect(
        unitOfWork.transaction(async (transaction) => {
          const imported = await transaction.guides.import(guide.guideId, guide);
          if (!imported.ok) return imported;
          return transaction.interviews.create(interview.interviewId, interview);
        }),
      ).resolves.toMatchObject({ ok: true });
      await expect(
        unitOfWork.transaction((transaction) =>
          transaction.interviews.compareAndSwap(interview.interviewId, 0, active),
        ),
      ).resolves.toEqual({ ok: true, value: active });
      await expect(
        unitOfWork.transaction((transaction) =>
          transaction.interviews.compareAndSwap(interview.interviewId, 1, ending),
        ),
      ).resolves.toEqual({ ok: true, value: ending });
      await withCommittedClient(pool, async (client) => {
        await insertRawJob(
          client,
          interview.interviewId,
          `job-${interview.interviewId}`,
          'succeeded',
        );
        await insertRawWorkflow(
          client,
          interview.interviewId,
          `job-${interview.interviewId}`,
          `workflow-${interview.interviewId}`,
        );
      });
      const reservation: AiDeliveryReservation = {
        deliveryId: `delivery-${interview.interviewId}`,
        jobId: `job-${interview.interviewId}`,
        workflowRunId: `workflow-${interview.interviewId}`,
        turnId: `turn-${interview.interviewId}`,
        utteranceId: `utterance-${interview.interviewId}`,
        turnType: 'greeting',
        guideReference: null,
        proposedText: 'Welcome to the interview.',
        createdAt: CREATED_AT,
      };
      await expect(
        unitOfWork.transaction((transaction) =>
          transaction.transcripts.reserveAiDelivery(interview.interviewId, 1, reservation),
        ),
      ).resolves.toMatchObject({ ok: true, value: { outcome: 'inserted' } });

      await expect(
        unitOfWork.transaction((transaction) =>
          transaction.interviews.compareAndSwap(interview.interviewId, 2, next),
        ),
      ).resolves.toEqual({
        ok: false,
        error: {
          code: 'pending_ai_delivery',
          interviewId: interview.interviewId,
          deliveryId: reservation.deliveryId,
          reservedSequenceNumber: 1,
        },
      });
      await expect(
        unitOfWork.transaction((transaction) =>
          transaction.interviews.compareAndSwap(interview.interviewId, 2, failed),
        ),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'pending_ai_delivery', deliveryId: reservation.deliveryId },
      });

      const gap = technicalTransportGap(interview.interviewId, 1, 'completion', UPDATED_AT);
      await expect(
        unitOfWork.transaction((transaction) =>
          transaction.transcripts.gapAiDelivery(interview.interviewId, {
            deliveryId: reservation.deliveryId,
            status: 'gapped',
            resolvedAt: UPDATED_AT,
            gap,
          }),
        ),
      ).resolves.toMatchObject({ ok: true, value: { outcome: 'inserted' } });
      await expect(
        unitOfWork.transaction((transaction) =>
          transaction.interviews.compareAndSwap(interview.interviewId, 2, next),
        ),
      ).resolves.toEqual({ ok: true, value: next });
    } finally {
      await removeInterviewAndGuide(pool, interview.interviewId, guide.guideId);
    }
  });

  it('prevents completion until an unresolved STT partial is explicitly closed', async () => {
    const { pool } = fixture();
    const guide = guideRecord('completion-unresolved-partial');
    const interview = readyInterview(guide.guide);
    const { active, ending, completed, failed } = completionProgression(interview);
    const source = {
      provider: 'demo-stt',
      utteranceId: `utterance-${interview.interviewId}`,
    } as const;
    const partial: PartialTranscriptSegment = {
      interviewId: interview.interviewId,
      sourceProvider: source.provider,
      utteranceId: source.utteranceId,
      providerEventId: `partial-event-${interview.interviewId}`,
      segmentId: `segment-${interview.interviewId}`,
      text: 'A participant answer that has not been finalized yet.',
      revision: 0,
      observedAt: UPDATED_AT,
    };
    const unitOfWork = postgresUnitOfWork(pool);
    try {
      await expect(
        unitOfWork.transaction(async (transaction) => {
          const imported = await transaction.guides.import(guide.guideId, guide);
          if (!imported.ok) return imported;
          const created = await transaction.interviews.create(interview.interviewId, interview);
          if (!created.ok) return created;
          const started = await transaction.interviews.compareAndSwap(
            interview.interviewId,
            0,
            active,
          );
          if (!started.ok) return started;
          return transaction.interviews.compareAndSwap(interview.interviewId, 1, ending);
        }),
      ).resolves.toEqual({ ok: true, value: ending });
      await expect(
        unitOfWork.transaction((transaction) =>
          transaction.transcripts.upsertPartial(interview.interviewId, source, partial),
        ),
      ).resolves.toMatchObject({ ok: true, value: { outcome: 'inserted' } });

      await expect(
        unitOfWork.transaction((transaction) =>
          transaction.interviews.compareAndSwap(interview.interviewId, 2, completed),
        ),
      ).resolves.toEqual({
        ok: false,
        error: {
          code: 'unresolved_transcript_partial',
          interviewId: interview.interviewId,
          provider: source.provider,
          segmentId: partial.segmentId,
          utteranceId: source.utteranceId,
        },
      });
      await expect(
        unitOfWork.transaction((transaction) =>
          transaction.interviews.compareAndSwap(interview.interviewId, 2, failed),
        ),
      ).resolves.toMatchObject({
        ok: false,
        error: {
          code: 'unresolved_transcript_partial',
          provider: source.provider,
          segmentId: partial.segmentId,
          utteranceId: source.utteranceId,
        },
      });

      const gap: TranscriptTechnicalGap = {
        kind: 'technical_gap',
        interviewId: interview.interviewId,
        sequenceNumber: 1,
        gapId: `gap-${interview.interviewId}`,
        source: 'speech_to_text',
        sourceProvider: source.provider,
        description: 'The provider did not deliver a final STT segment.',
        relatedSegmentId: partial.segmentId,
        relatedUtteranceId: source.utteranceId,
        sourceEventId: `gap-event-${interview.interviewId}`,
        occurredAt: UPDATED_AT,
      };
      await expect(
        unitOfWork.transaction((transaction) =>
          transaction.transcripts.appendTechnicalGap(interview.interviewId, 1, gap),
        ),
      ).resolves.toMatchObject({ ok: true, value: { outcome: 'inserted' } });
      await expect(
        unitOfWork.transaction((transaction) =>
          transaction.interviews.compareAndSwap(interview.interviewId, 2, completed),
        ),
      ).resolves.toEqual({ ok: true, value: completed });
    } finally {
      await removeInterviewAndGuide(pool, interview.interviewId, guide.guideId);
    }
  });

  it('fences a partial committed while a terminal transition waits on its transcript lock', async () => {
    const { pool } = fixture();
    const guide = guideRecord('partial-completion-fence-race');
    const interview = readyInterview(guide.guide);
    const { active, ending, completed } = completionProgression(interview);
    const setup = postgresUnitOfWork(pool);
    const partialClient = await pool.connect();
    let partialTransactionOpen = false;
    const source = {
      provider: 'demo-stt',
      utteranceId: `utterance-${interview.interviewId}`,
    } as const;
    const partial: PartialTranscriptSegment = {
      interviewId: interview.interviewId,
      sourceProvider: source.provider,
      utteranceId: source.utteranceId,
      providerEventId: `partial-event-${interview.interviewId}`,
      segmentId: `segment-${interview.interviewId}`,
      text: 'A partial committed while completion waits.',
      revision: 0,
      observedAt: UPDATED_AT,
    };
    try {
      await expect(
        setup.transaction(async (transaction) => {
          const imported = await transaction.guides.import(guide.guideId, guide);
          if (!imported.ok) return imported;
          const created = await transaction.interviews.create(interview.interviewId, interview);
          if (!created.ok) return created;
          const started = await transaction.interviews.compareAndSwap(
            interview.interviewId,
            0,
            active,
          );
          if (!started.ok) return started;
          return transaction.interviews.compareAndSwap(interview.interviewId, 1, ending);
        }),
      ).resolves.toEqual({ ok: true, value: ending });

      await partialClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      partialTransactionOpen = true;
      await expect(
        new PostgresTranscriptRepository(createClientSqlExecutor(partialClient)).upsertPartial(
          interview.interviewId,
          source,
          partial,
        ),
      ).resolves.toMatchObject({ ok: true, value: { outcome: 'inserted' } });

      const lockAttempt = createSignal();
      const racingUnitOfWork = new PostgresUnitOfWork(
        createSignalingUnitOfWorkPool(pool, lockAttempt.resolve),
        persistenceContexts,
      );
      const completionPromise = racingUnitOfWork.transaction((transaction) =>
        transaction.interviews.compareAndSwap(interview.interviewId, 2, completed),
      );
      await lockAttempt.promise;
      await partialClient.query('COMMIT');
      partialTransactionOpen = false;

      const raced = await completionPromise;
      if (raced.ok) {
        throw new Error('Completion must not commit after the racing partial was accepted');
      }
      expect(
        raced.error.code === 'unresolved_transcript_partial' ||
          ('retryable' in raced.error && raced.error.retryable),
      ).toBe(true);
      await expect(
        setup.transaction((transaction) =>
          transaction.interviews.compareAndSwap(interview.interviewId, 2, completed),
        ),
      ).resolves.toMatchObject({
        ok: false,
        error: {
          code: 'unresolved_transcript_partial',
          provider: source.provider,
          segmentId: partial.segmentId,
          utteranceId: source.utteranceId,
        },
      });
    } finally {
      if (partialTransactionOpen) await partialClient.query('ROLLBACK');
      partialClient.release();
      await removeInterviewAndGuide(pool, interview.interviewId, guide.guideId);
    }
  });

  it('serializes an AI reservation racing with interview completion', async () => {
    const { pool } = fixture();
    const guide = guideRecord('reservation-completion-race');
    const interview = readyInterview(guide.guide);
    const { active, ending, completed: next } = completionProgression(interview);
    const setup = postgresUnitOfWork(pool);
    const reservationClient = await pool.connect();
    let reservationOpen = false;
    try {
      await setup.transaction(async (transaction) => {
        const imported = await transaction.guides.import(guide.guideId, guide);
        if (!imported.ok) return imported;
        return transaction.interviews.create(interview.interviewId, interview);
      });
      await expect(
        setup.transaction((transaction) =>
          transaction.interviews.compareAndSwap(interview.interviewId, 0, active),
        ),
      ).resolves.toEqual({ ok: true, value: active });
      await expect(
        setup.transaction((transaction) =>
          transaction.interviews.compareAndSwap(interview.interviewId, 1, ending),
        ),
      ).resolves.toEqual({ ok: true, value: ending });
      await withCommittedClient(pool, async (client) => {
        await insertRawJob(
          client,
          interview.interviewId,
          `job-${interview.interviewId}`,
          'succeeded',
        );
        await insertRawWorkflow(
          client,
          interview.interviewId,
          `job-${interview.interviewId}`,
          `workflow-${interview.interviewId}`,
        );
      });
      const reservation: AiDeliveryReservation = {
        deliveryId: `delivery-${interview.interviewId}`,
        jobId: `job-${interview.interviewId}`,
        workflowRunId: `workflow-${interview.interviewId}`,
        turnId: `turn-${interview.interviewId}`,
        utteranceId: `utterance-${interview.interviewId}`,
        turnType: 'greeting',
        guideReference: null,
        proposedText: 'Welcome to the interview.',
        createdAt: CREATED_AT,
      };
      await reservationClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      reservationOpen = true;
      await expect(
        new PostgresTranscriptRepository(
          createClientSqlExecutor(reservationClient),
        ).reserveAiDelivery(interview.interviewId, 1, reservation),
      ).resolves.toMatchObject({ ok: true, value: { outcome: 'inserted' } });

      const lockAttempt = createSignal();
      const racingUnitOfWork = new PostgresUnitOfWork(
        createSignalingUnitOfWorkPool(pool, lockAttempt.resolve),
        persistenceContexts,
      );
      const completionPromise = racingUnitOfWork.transaction((transaction) =>
        transaction.interviews.compareAndSwap(interview.interviewId, 2, next),
      );
      await lockAttempt.promise;
      await reservationClient.query('COMMIT');
      reservationOpen = false;

      const raced = await completionPromise;
      if (raced.ok) {
        throw new Error('Completion must not win after the pending reservation committed');
      }
      expect(
        raced.error.code === 'pending_ai_delivery' ||
          ('retryable' in raced.error && raced.error.retryable),
      ).toBe(true);
      await expect(
        setup.transaction((transaction) =>
          transaction.interviews.compareAndSwap(interview.interviewId, 2, next),
        ),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'pending_ai_delivery', deliveryId: reservation.deliveryId },
      });
    } finally {
      if (reservationOpen) await reservationClient.query('ROLLBACK');
      reservationClient.release();
      await removeInterviewAndGuide(pool, interview.interviewId, guide.guideId);
    }
  });

  it('rolls back a reservation and later resolves the exact reserved slot', async () => {
    const { pool } = fixture();
    const committed = await createCommittedInterviewFixture(pool, 'reservation-rollback');
    try {
      const unitOfWork = postgresUnitOfWork(pool);
      const reservation = aiReservation(committed, 'rollback');
      const forcedError: RepositoryError = {
        code: 'constraint_violation',
        constraint: 'forced_reservation_rollback',
      };
      await expect(
        unitOfWork.transaction(async (transaction) => {
          const reserved = await transaction.transcripts.reserveAiDelivery(
            committed.interviewId,
            1,
            reservation,
          );
          return reserved.ok ? failure(forcedError) : reserved;
        }),
      ).resolves.toEqual(failure(forcedError));
      await expect(readTranscriptStorageState(pool, committed.interviewId)).resolves.toEqual({
        deliveryCount: 0,
        entryCount: 0,
        nextSequence: 1,
      });

      await expect(
        unitOfWork.transaction((transaction) =>
          transaction.transcripts.reserveAiDelivery(committed.interviewId, 1, reservation),
        ),
      ).resolves.toMatchObject({ ok: true, value: { outcome: 'inserted' } });
      const gap: TranscriptTechnicalGap = {
        kind: 'technical_gap',
        interviewId: committed.interviewId,
        sequenceNumber: 1,
        gapId: 'reservation-rollback-gap',
        sourceEventId: 'reservation-rollback-gap-event',
        source: 'audio_output',
        sourceProvider: null,
        relatedUtteranceId: null,
        description: 'Audio delivery confirmation was unavailable.',
        occurredAt: UPDATED_AT,
        relatedSegmentId: null,
      };
      await expect(
        unitOfWork.transaction((transaction) =>
          transaction.transcripts.gapAiDelivery(committed.interviewId, {
            deliveryId: reservation.deliveryId,
            resolvedAt: UPDATED_AT,
            status: 'gapped',
            gap,
          }),
        ),
      ).resolves.toEqual({ ok: true, value: { outcome: 'inserted', value: gap } });
      await expect(readTranscriptStorageState(pool, committed.interviewId)).resolves.toEqual({
        deliveryCount: 1,
        entryCount: 1,
        nextSequence: 2,
      });
    } finally {
      await removeCommittedInterviewFixture(pool, committed);
    }
  });

  it('deduplicates concurrent identical partial retries after a retryable race', async () => {
    const { pool } = fixture();
    const committed = await createCommittedInterviewFixture(pool, 'concurrent-partial');
    try {
      const unitOfWork = postgresUnitOfWork(pool);
      const source = { provider: 'demo-stt', utteranceId: 'concurrent-partial-utterance' };
      const partial: PartialTranscriptSegment = {
        interviewId: committed.interviewId,
        sourceProvider: source.provider,
        utteranceId: source.utteranceId,
        providerEventId: 'concurrent-partial-event',
        segmentId: 'concurrent-partial-segment',
        text: 'Exact concurrent partial',
        revision: 0,
        observedAt: UPDATED_AT,
      };
      const results = await Promise.all([
        unitOfWork.transaction((transaction) =>
          transaction.transcripts.upsertPartial(committed.interviewId, source, partial),
        ),
        unitOfWork.transaction((transaction) =>
          transaction.transcripts.upsertPartial(committed.interviewId, source, partial),
        ),
      ]);

      expect(
        results.filter((result) => result.ok && result.value.outcome === 'inserted'),
      ).toHaveLength(1);
      expect(
        results.every(
          (result) => result.ok || ('retryable' in result.error && result.error.retryable === true),
        ),
      ).toBe(true);
      await expect(
        unitOfWork.transaction((transaction) =>
          transaction.transcripts.upsertPartial(committed.interviewId, source, partial),
        ),
      ).resolves.toEqual({ ok: true, value: { outcome: 'existing', value: partial } });
      const stored = await pool.query<{ count: number }>(
        `SELECT count(*)::integer AS count FROM app.transcript_partial_events
          WHERE interview_id = $1 AND provider = $2 AND provider_event_id = $3`,
        [committed.interviewId, source.provider, partial.providerEventId],
      );
      expect(stored.rows).toEqual([{ count: 1 }]);
    } finally {
      await removeCommittedInterviewFixture(pool, committed);
    }
  });

  it('recovers a late partial racing with interview completion without duplication', async () => {
    const { pool } = fixture();
    const committed = await createCommittedInterviewFixture(pool, 'completion-partial-race');
    const completionClient = await pool.connect();
    let completionTransactionOpen = false;
    try {
      await pool.query(
        `UPDATE app.interview_state
            SET status = 'active', state_version = 1, started_at = $2,
                active_since = $2, updated_at = $2
          WHERE interview_id = $1`,
        [committed.interviewId, CREATED_AT],
      );
      await completionClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      completionTransactionOpen = true;
      await completionClient.query(
        `UPDATE app.interview_state
            SET status = 'completed', state_version = 2, active_since = NULL,
                ending_at = $2, ended_at = $2, updated_at = $2
          WHERE interview_id = $1`,
        [committed.interviewId, UPDATED_AT],
      );

      const lockAttempt = createSignal();
      const racingUnitOfWork = new PostgresUnitOfWork(
        createSignalingUnitOfWorkPool(pool, lockAttempt.resolve),
        persistenceContexts,
      );
      const source = { provider: 'demo-stt', utteranceId: 'late-race-utterance' };
      const partial: PartialTranscriptSegment = {
        interviewId: committed.interviewId,
        sourceProvider: source.provider,
        utteranceId: source.utteranceId,
        providerEventId: 'late-race-event',
        segmentId: 'late-race-segment',
        text: 'Late racing partial',
        revision: 0,
        observedAt: UPDATED_AT,
      };
      const racedPromise = racingUnitOfWork.transaction((transaction) =>
        transaction.transcripts.upsertPartial(committed.interviewId, source, partial),
      );
      await lockAttempt.promise;
      await completionClient.query('COMMIT');
      completionTransactionOpen = false;

      const raced = await racedPromise;
      if (raced.ok) {
        expect(raced.value.outcome).toBe('ignored_finalized');
      } else {
        expect('retryable' in raced.error && raced.error.retryable).toBe(true);
      }
      await expect(
        postgresUnitOfWork(pool).transaction((transaction) =>
          transaction.transcripts.upsertPartial(committed.interviewId, source, partial),
        ),
      ).resolves.toEqual({
        ok: true,
        value: { outcome: 'ignored_finalized', value: partial },
      });
      const stored = await pool.query<{ count: number; disposition: string }>(
        `SELECT count(*)::integer AS count, min(disposition) AS disposition
           FROM app.transcript_partial_events
          WHERE interview_id = $1 AND provider = $2 AND provider_event_id = $3`,
        [committed.interviewId, source.provider, partial.providerEventId],
      );
      expect(stored.rows).toEqual([{ count: 1, disposition: 'ignored_finalized' }]);
    } finally {
      if (completionTransactionOpen) await completionClient.query('ROLLBACK');
      completionClient.release();
      await removeCommittedInterviewFixture(pool, committed);
    }
  });

  it('rejects a canonical timestamp regression without consuming its sequence', async () => {
    const { pool } = fixture();
    const committed = await createCommittedInterviewFixture(pool, 'timestamp-regression');
    try {
      const unitOfWork = postgresUnitOfWork(pool);
      const firstGap = technicalTransportGap(committed.interviewId, 1, 'first', UPDATED_AT);
      await expect(
        unitOfWork.transaction((transaction) =>
          transaction.transcripts.appendTechnicalGap(committed.interviewId, 1, firstGap),
        ),
      ).resolves.toMatchObject({ ok: true, value: { outcome: 'inserted' } });
      const regressedGap = technicalTransportGap(committed.interviewId, 2, 'regressed', CREATED_AT);
      await expect(
        unitOfWork.transaction((transaction) =>
          transaction.transcripts.appendTechnicalGap(committed.interviewId, 2, regressedGap),
        ),
      ).resolves.toEqual({
        ok: false,
        error: { code: 'constraint_violation', constraint: 'transcript_timestamp_regression' },
      });
      await expect(readTranscriptStorageState(pool, committed.interviewId)).resolves.toEqual({
        deliveryCount: 0,
        entryCount: 1,
        nextSequence: 2,
      });
    } finally {
      await removeCommittedInterviewFixture(pool, committed);
    }
  });

  it('allows only one pending AI delivery per interview', async () => {
    const { pool } = fixture();

    await withRollback(pool, async (client) => {
      await insertRawGuide(client, 'guide:v1:pending-delivery', 'Pending delivery');
      await insertRawInterview(client, 'interview-pending', 'guide:v1:pending-delivery');
      await insertRawJob(client, 'interview-pending', 'job-pending', 'succeeded');
      await insertRawWorkflow(client, 'interview-pending', 'job-pending', 'workflow-pending');
      await insertRawAiDelivery(
        client,
        'interview-pending',
        'job-pending',
        'workflow-pending',
        'delivery-pending-1',
        'turn-pending-1',
        1,
        'pending',
      );

      await expect(
        insertRawAiDelivery(
          client,
          'interview-pending',
          'job-pending',
          'workflow-pending',
          'delivery-pending-2',
          'turn-pending-2',
          2,
          'pending',
        ),
      ).rejects.toMatchObject({
        code: '23505',
        constraint: 'ai_turn_deliveries_one_pending_per_interview',
      });
    });
  });

  it('enforces internal and provider AI-delivery identifiers in PostgreSQL', async () => {
    const { pool } = fixture();

    await withRollback(pool, async (client) => {
      await insertRawGuide(client, 'guide:v1:delivery-ids', 'Delivery identifiers');
      await insertRawInterview(client, 'interview-delivery-ids', 'guide:v1:delivery-ids');
      await insertRawJob(client, 'interview-delivery-ids', 'job-delivery-ids', 'succeeded');
      await insertRawWorkflow(
        client,
        'interview-delivery-ids',
        'job-delivery-ids',
        'workflow-delivery-ids',
      );

      await expect(
        insertRawAiDelivery(
          client,
          'interview-delivery-ids',
          'job-delivery-ids',
          'workflow-delivery-ids',
          ' delivery-invalid',
          'turn-delivery-invalid',
          1,
          'pending',
        ),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'ai_turn_deliveries_internal_ids_valid',
      });
    });

    for (const [provider, providerDeliveryEventId] of [
      [' demo-tts', 'provider-event-1'],
      ['\tdemo-tts', 'provider-event-1'],
      ['\u00a0demo-tts', 'provider-event-1'],
      ['x'.repeat(101), 'provider-event-1'],
      ['😀'.repeat(101), 'provider-event-1'],
      ['demo-tts', ' provider-event-1'],
      ['demo-tts', 'provider-event-1\n'],
      ['demo-tts', `provider-event-1\u3000`],
      ['demo-tts', 'x'.repeat(301)],
      ['demo-tts', '😀'.repeat(301)],
    ] as const) {
      await withRollback(pool, async (client) => {
        await insertRawGuide(client, 'guide:v1:provider-ids', 'Provider identifiers');
        await insertRawInterview(client, 'interview-provider-ids', 'guide:v1:provider-ids');
        await insertRawJob(client, 'interview-provider-ids', 'job-provider-ids', 'succeeded');
        await insertRawWorkflow(
          client,
          'interview-provider-ids',
          'job-provider-ids',
          'workflow-provider-ids',
        );
        await insertRawAiDelivery(
          client,
          'interview-provider-ids',
          'job-provider-ids',
          'workflow-provider-ids',
          'delivery-provider-ids',
          'turn-provider-ids',
          1,
          'pending',
        );

        await expect(
          client.query(
            `UPDATE app.ai_turn_deliveries
                SET status = 'complete', provider = $2, provider_delivery_event_id = $3,
                    confirmed_spoken_text = proposed_text, resolved_at = $4
              WHERE interview_id = $1 AND id = 'delivery-provider-ids'`,
            ['interview-provider-ids', provider, providerDeliveryEventId, UPDATED_AT],
          ),
        ).rejects.toMatchObject({
          code: '23514',
          constraint: 'ai_turn_deliveries_provider_identifiers_valid',
        });
      });
    }

    for (const whitespaceOnlyText of ['\t', '\n', '\u00a0', '\u3000', '\ufeff']) {
      await withRollback(pool, async (client) => {
        await insertRawGuide(client, 'guide:v1:blank-text', 'Blank text');
        await insertRawInterview(client, 'interview-blank-text', 'guide:v1:blank-text');
        await insertRawJob(client, 'interview-blank-text', 'job-blank-text', 'succeeded');
        await insertRawWorkflow(
          client,
          'interview-blank-text',
          'job-blank-text',
          'workflow-blank-text',
        );
        await insertRawAiDelivery(
          client,
          'interview-blank-text',
          'job-blank-text',
          'workflow-blank-text',
          'delivery-blank-text',
          'turn-blank-text',
          1,
          'pending',
        );

        await expect(
          client.query(
            `UPDATE app.ai_turn_deliveries SET proposed_text = $2
              WHERE interview_id = $1 AND id = 'delivery-blank-text'`,
            ['interview-blank-text', whitespaceOnlyText],
          ),
        ).rejects.toMatchObject({
          code: '23514',
          constraint: 'ai_turn_deliveries_text_valid',
        });
      });
    }

    await withRollback(pool, async (client) => {
      await insertRawGuide(client, 'guide:v1:unicode-length', 'Unicode length');
      await insertRawInterview(client, 'interview-unicode-length', 'guide:v1:unicode-length');
      await insertRawJob(client, 'interview-unicode-length', 'job-unicode-length', 'succeeded');
      await insertRawWorkflow(
        client,
        'interview-unicode-length',
        'job-unicode-length',
        'workflow-unicode-length',
      );
      await insertRawAiDelivery(
        client,
        'interview-unicode-length',
        'job-unicode-length',
        'workflow-unicode-length',
        'delivery-unicode-length',
        'turn-unicode-length',
        1,
        'pending',
      );

      await expect(
        client.query(
          `UPDATE app.ai_turn_deliveries
              SET status = 'complete', provider = $2, provider_delivery_event_id = $3,
                  confirmed_spoken_text = proposed_text, resolved_at = $4
            WHERE interview_id = $1 AND id = 'delivery-unicode-length'`,
          ['interview-unicode-length', '😀'.repeat(100), '😀'.repeat(300), UPDATED_AT],
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
    });

    await withRollback(pool, async (client) => {
      await insertRawGuide(client, 'guide:v1:unicode-text', 'Unicode text');
      await insertRawInterview(client, 'interview-unicode-text', 'guide:v1:unicode-text');
      await insertRawJob(client, 'interview-unicode-text', 'job-unicode-text', 'succeeded');
      await insertRawWorkflow(
        client,
        'interview-unicode-text',
        'job-unicode-text',
        'workflow-unicode-text',
      );
      await insertRawAiDelivery(
        client,
        'interview-unicode-text',
        'job-unicode-text',
        'workflow-unicode-text',
        'delivery-unicode-text',
        'turn-unicode-text',
        1,
        'pending',
      );

      await expect(
        client.query(
          `UPDATE app.ai_turn_deliveries SET proposed_text = $2
            WHERE interview_id = $1 AND id = 'delivery-unicode-text'`,
          ['interview-unicode-text', '😀'.repeat(20_000)],
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
      await expect(
        client.query(
          `UPDATE app.ai_turn_deliveries SET proposed_text = $2
            WHERE interview_id = $1 AND id = 'delivery-unicode-text'`,
          ['interview-unicode-text', '😀'.repeat(20_001)],
        ),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'ai_turn_deliveries_text_valid',
      });
    });

    await withRollback(pool, async (client) => {
      await insertRawGuide(client, 'guide:v1:confirmed-text', 'Confirmed text');
      await insertRawInterview(client, 'interview-confirmed-text', 'guide:v1:confirmed-text');
      await insertRawJob(client, 'interview-confirmed-text', 'job-confirmed-text', 'succeeded');
      await insertRawWorkflow(
        client,
        'interview-confirmed-text',
        'job-confirmed-text',
        'workflow-confirmed-text',
      );
      await insertRawAiDelivery(
        client,
        'interview-confirmed-text',
        'job-confirmed-text',
        'workflow-confirmed-text',
        'delivery-confirmed-text',
        'turn-confirmed-text',
        1,
        'pending',
      );

      await expect(
        client.query(
          `UPDATE app.ai_turn_deliveries
              SET status = 'interrupted', proposed_text = E'\\tWelcome.', provider = 'demo-tts',
                  provider_delivery_event_id = 'provider-event-confirmed-text',
                  confirmed_spoken_text = E'\\t', resolved_at = $2, interrupted_at = $2
            WHERE interview_id = $1 AND id = 'delivery-confirmed-text'`,
          ['interview-confirmed-text', UPDATED_AT],
        ),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'ai_turn_deliveries_confirmed_text_valid',
      });
    });
  });

  it('enforces partial transcript identifiers and code-point text limits in PostgreSQL', async () => {
    const { pool } = fixture();

    await withRollback(pool, async (client) => {
      const interviewId = await insertRawTranscriptContractInterview(client, 'partial-valid');
      for (const [revision, providerEventId, text] of [
        [0, 'partial-empty', ''],
        [1, 'partial-whitespace', '\t\u00a0\u3000\ufeff'],
        [2, 'partial-unicode-limit', '😀'.repeat(20_000)],
      ] as const) {
        await expect(
          client.query(
            `INSERT INTO app.transcript_partial_events (
               interview_id, provider, provider_event_id, segment_id, utterance_id,
               revision, text, disposition, observed_at
             ) VALUES ($1, 'demo-stt', $2, 'segment-partial-valid',
                       'utterance-partial-valid', $3, $4, 'accepted', $5)`,
            [interviewId, providerEventId, revision, text, CREATED_AT],
          ),
        ).resolves.toMatchObject({ rowCount: 1 });
      }
    });

    for (const [provider, providerEventId] of [
      ['\tdemo-stt', 'partial-provider-event'],
      ['demo-stt', 'partial-provider-event\n'],
    ] as const) {
      await withRollback(pool, async (client) => {
        const interviewId = await insertRawTranscriptContractInterview(
          client,
          'partial-provider-identifiers',
        );
        await expect(
          client.query(
            `INSERT INTO app.transcript_partial_events (
               interview_id, provider, provider_event_id, segment_id, utterance_id,
               revision, text, disposition, observed_at
             ) VALUES ($1, $2, $3, 'segment-partial-identifiers',
                       'utterance-partial-identifiers', 0, '', 'accepted', $4)`,
            [interviewId, provider, providerEventId, CREATED_AT],
          ),
        ).rejects.toMatchObject({
          code: '23514',
          constraint: 'transcript_partial_provider_identifiers_valid',
        });
      });
    }

    await withRollback(pool, async (client) => {
      const interviewId = await insertRawTranscriptContractInterview(client, 'partial-text-limit');
      await expect(
        client.query(
          `INSERT INTO app.transcript_partial_events (
             interview_id, provider, provider_event_id, segment_id, utterance_id,
             revision, text, disposition, observed_at
           ) VALUES ($1, 'demo-stt', 'partial-over-limit', 'segment-partial-over-limit',
                     'utterance-partial-over-limit', 0, $2, 'accepted', $3)`,
          [interviewId, '😀'.repeat(20_001), CREATED_AT],
        ),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'transcript_partial_text_valid',
      });
    });

    await withRollback(pool, async (client) => {
      const interviewId = await insertRawTranscriptContractInterview(client, 'partial-internal-id');
      await expect(
        client.query(
          `INSERT INTO app.transcript_partial_events (
             interview_id, provider, provider_event_id, segment_id, utterance_id,
             revision, text, disposition, observed_at
           ) VALUES ($1, 'demo-stt', 'partial-invalid-id', ' invalid-segment',
                     'utterance-partial-invalid-id', 0, '', 'accepted', $2)`,
          [interviewId, CREATED_AT],
        ),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'transcript_partial_internal_ids_valid',
      });
    });
  });

  it('enforces canonical turn Unicode text contracts in PostgreSQL', async () => {
    const { pool } = fixture();

    for (const [suffix, whitespaceOnlyText] of [
      ['tab', '\t'],
      ['newline', '\n'],
      ['nbsp', '\u00a0'],
      ['ideographic-space', '\u3000'],
      ['byte-order-mark', '\ufeff'],
    ] as const) {
      await withRollback(pool, async (client) => {
        const interviewId = await insertRawTranscriptContractInterview(client, `turn-${suffix}`);
        const turnId = `turn-${suffix}`;
        await insertRawParticipantTurn(
          client,
          interviewId,
          turnId,
          1,
          `utterance-${suffix}`,
          false,
        );
        await expect(
          client.query(
            'UPDATE app.transcript_turns SET text = $3 WHERE interview_id = $1 AND turn_id = $2',
            [interviewId, turnId, whitespaceOnlyText],
          ),
        ).rejects.toMatchObject({
          code: '23514',
          constraint: 'transcript_turns_text_valid',
        });
      });
    }

    await withRollback(pool, async (client) => {
      const interviewId = await insertRawTranscriptContractInterview(client, 'turn-text-limit');
      const turnId = 'turn-text-limit';
      await insertRawParticipantTurn(client, interviewId, turnId, 1, 'utterance-turn-limit', false);
      await expect(
        client.query(
          'UPDATE app.transcript_turns SET text = $3 WHERE interview_id = $1 AND turn_id = $2',
          [interviewId, turnId, '😀'.repeat(20_000)],
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
      await expect(
        client.query(
          'UPDATE app.transcript_turns SET text = $3 WHERE interview_id = $1 AND turn_id = $2',
          [interviewId, turnId, '😀'.repeat(20_001)],
        ),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'transcript_turns_text_valid',
      });
    });

    await withRollback(pool, async (client) => {
      const interviewId = await insertRawTranscriptContractInterview(client, 'turn-provider-id');
      const turnId = 'turn-provider-id';
      await insertRawParticipantTurn(
        client,
        interviewId,
        turnId,
        1,
        'utterance-turn-provider',
        false,
      );
      await expect(
        client.query(
          `UPDATE app.transcript_turns
              SET source_provider = $3
            WHERE interview_id = $1 AND turn_id = $2`,
          [interviewId, turnId, '\tdemo-stt'],
        ),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'transcript_turns_provider_identifiers_valid',
      });
    });
  });

  it('enforces final segment Unicode text contracts in PostgreSQL', async () => {
    const { pool } = fixture();

    for (const [suffix, whitespaceOnlyText] of [
      ['tab', '\t'],
      ['newline', '\n'],
      ['nbsp', '\u00a0'],
      ['ideographic-space', '\u3000'],
      ['byte-order-mark', '\ufeff'],
    ] as const) {
      await withRollback(pool, async (client) => {
        const interviewId = await insertRawTranscriptContractInterview(client, `final-${suffix}`);
        const turnId = `turn-final-${suffix}`;
        await insertRawParticipantTurn(client, interviewId, turnId, 1, `utterance-final-${suffix}`);
        await expect(
          client.query(
            `UPDATE app.transcript_final_segments
                SET text = $3
              WHERE interview_id = $1 AND turn_id = $2`,
            [interviewId, turnId, whitespaceOnlyText],
          ),
        ).rejects.toMatchObject({
          code: '23514',
          constraint: 'transcript_final_segments_text_valid',
        });
      });
    }

    await withRollback(pool, async (client) => {
      const interviewId = await insertRawTranscriptContractInterview(client, 'final-text-limit');
      const turnId = 'turn-final-text-limit';
      await insertRawParticipantTurn(client, interviewId, turnId, 1, 'utterance-final-text-limit');
      await expect(
        client.query(
          `UPDATE app.transcript_final_segments
              SET text = $3
            WHERE interview_id = $1 AND turn_id = $2`,
          [interviewId, turnId, '😀'.repeat(20_000)],
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
      await expect(
        client.query(
          `UPDATE app.transcript_final_segments
              SET text = $3
            WHERE interview_id = $1 AND turn_id = $2`,
          [interviewId, turnId, '😀'.repeat(20_001)],
        ),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'transcript_final_segments_text_valid',
      });
    });

    await withRollback(pool, async (client) => {
      const interviewId = await insertRawTranscriptContractInterview(client, 'final-provider-id');
      const turnId = 'turn-final-provider-id';
      await insertRawParticipantTurn(client, interviewId, turnId, 1, 'utterance-final-provider-id');
      await expect(
        client.query(
          `UPDATE app.transcript_final_segments
              SET provider_event_id = $3
            WHERE interview_id = $1 AND turn_id = $2`,
          [interviewId, turnId, 'provider-event\n'],
        ),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'transcript_final_segments_provider_identifiers_valid',
      });
    });
  });

  it('enforces technical gap description and event identifier contracts in PostgreSQL', async () => {
    const { pool } = fixture();

    for (const [suffix, description] of [
      ['tab', '\t'],
      ['newline', '\n'],
      ['nbsp', '\u00a0'],
      ['ideographic-space', '\u3000'],
      ['byte-order-mark', '\ufeff'],
      ['over-limit', '😀'.repeat(1_001)],
    ] as const) {
      await expect(
        withRollback(pool, async (client) => {
          const interviewId = await insertRawTranscriptContractInterview(client, `gap-${suffix}`);
          await insertRawTranscriptGap(client, interviewId, `gap-${suffix}`, description);
        }),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'transcript_gaps_description_valid',
      });
    }

    await withRollback(pool, async (client) => {
      const interviewId = await insertRawTranscriptContractInterview(client, 'gap-valid-limit');
      await expect(
        insertRawTranscriptGap(client, interviewId, 'gap-valid-limit', '😀'.repeat(1_000)),
      ).resolves.toBeUndefined();
    });

    await withRollback(pool, async (client) => {
      const interviewId = await insertRawTranscriptContractInterview(client, 'gap-provider-id');
      await client.query(
        `INSERT INTO app.transcript_entries
           (interview_id, sequence_number, entry_id, kind, occurred_at)
         VALUES ($1, 1, 'gap-provider-id', 'technical_gap', $2)`,
        [interviewId, CREATED_AT],
      );
      await expect(
        client.query(
          `INSERT INTO app.transcript_gaps (
             interview_id, gap_id, entry_kind, source, provider, description,
             related_segment_id, related_utterance_id, source_event_id
           ) VALUES ($1, 'gap-provider-id', 'technical_gap', 'speech_to_text', $2,
                     'Speech recognition gap', 'segment-gap-provider',
                     'utterance-gap-provider', 'event-gap-provider')`,
          [interviewId, '\u00a0demo-stt'],
        ),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'transcript_gaps_provider_identifiers_valid',
      });
    });

    await withRollback(pool, async (client) => {
      const interviewId = await insertRawTranscriptContractInterview(client, 'gap-event-id');
      await expect(
        insertRawTranscriptGap(client, interviewId, 'gap-event-id', 'Transport gap', 'gap-event\n'),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'transcript_gaps_internal_ids_valid',
      });
    });
  });

  it('rejects NULL-shaped terminal lifecycle, run, delivery, and AI-turn rows', async () => {
    const { pool } = fixture();

    await withRollback(pool, async (client) => {
      await insertRawGuide(client, 'guide:v1:null-lifecycle', 'Null lifecycle');
      await insertRawInterview(client, 'interview-null-lifecycle', 'guide:v1:null-lifecycle');
      await expect(
        client.query(
          `UPDATE app.interview_state
              SET status = 'ending', started_at = $2, ending_at = $3,
                  ending_from = NULL, updated_at = $3
            WHERE interview_id = $1`,
          ['interview-null-lifecycle', CREATED_AT, UPDATED_AT],
        ),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'interview_state_lifecycle_shape',
      });
    });

    await withRollback(pool, async (client) => {
      await insertRawGuide(client, 'guide:v1:null-run', 'Null run');
      await insertRawInterview(client, 'interview-null-run', 'guide:v1:null-run');
      await insertRawJob(client, 'interview-null-run', 'job-null-run', 'succeeded');
      await expect(
        client.query(
          `INSERT INTO app.workflow_runs (
             id, interview_id, job_id, mastra_attempt_id, attempt_number,
             expected_state_version, status, retry_count, started_at, ended_at, created_at
           ) VALUES ($1, $2, $3, $4, 1, 0, 'succeeded', 0, $5, $6, $5)`,
          [
            'workflow-null-duration',
            'interview-null-run',
            'job-null-run',
            'attempt-null-duration',
            CREATED_AT,
            UPDATED_AT,
          ],
        ),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'workflow_runs_timing_valid',
      });
    });

    await withRollback(pool, async (client) => {
      await insertRawGuide(client, 'guide:v1:null-delivery', 'Null delivery');
      await insertRawInterview(client, 'interview-null-delivery', 'guide:v1:null-delivery');
      await insertRawJob(client, 'interview-null-delivery', 'job-null-delivery', 'succeeded');
      await insertRawWorkflow(
        client,
        'interview-null-delivery',
        'job-null-delivery',
        'workflow-null-delivery',
      );
      await expect(
        client.query(
          `INSERT INTO app.ai_turn_deliveries (
             id, interview_id, job_id, workflow_run_id, turn_id, utterance_id,
             reserved_sequence_number, turn_type, proposed_text, status,
             provider, provider_delivery_event_id, confirmed_spoken_text,
             created_at, resolved_at
           ) VALUES ($1, $2, $3, $4, $5, $6, 1, 'greeting', 'Welcome.', 'complete',
                     'demo-tts', 'provider-delivery-null', NULL, $7, $8)`,
          [
            'delivery-null-text',
            'interview-null-delivery',
            'job-null-delivery',
            'workflow-null-delivery',
            'turn-null-text',
            'utterance-null-text',
            CREATED_AT,
            UPDATED_AT,
          ],
        ),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'ai_turn_deliveries_resolution_shape',
      });
    });

    await withRollback(pool, async (client) => {
      await insertRawGuide(client, 'guide:v1:null-ai-turn', 'Null AI turn');
      await insertRawInterview(client, 'interview-null-ai-turn', 'guide:v1:null-ai-turn');
      await insertRawJob(client, 'interview-null-ai-turn', 'job-null-ai-turn', 'succeeded');
      await insertRawWorkflow(
        client,
        'interview-null-ai-turn',
        'job-null-ai-turn',
        'workflow-null-ai-turn',
      );
      await insertRawAiDelivery(
        client,
        'interview-null-ai-turn',
        'job-null-ai-turn',
        'workflow-null-ai-turn',
        'delivery-null-ai-turn',
        'turn-null-ai-turn',
        1,
        'complete',
      );
      await client.query(
        `INSERT INTO app.transcript_entries
           (interview_id, sequence_number, entry_id, kind, occurred_at)
         VALUES ($1, 1, $2, 'turn', $3)`,
        ['interview-null-ai-turn', 'turn-null-ai-turn', CREATED_AT],
      );
      await expect(
        client.query(
          `INSERT INTO app.transcript_turns (
             interview_id, turn_id, entry_kind, speaker, turn_type, text,
             delivery_id, delivery_event_id, delivery_status
           ) VALUES ($1, $2, 'turn', 'ai_interviewer', 'greeting', 'Welcome.',
                     $3, $4, NULL)`,
          [
            'interview-null-ai-turn',
            'turn-null-ai-turn',
            'delivery-null-ai-turn',
            'delivery-null-ai-turn-provider-event',
          ],
        ),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'transcript_turns_speaker_shape',
      });
    });
  });

  it('accepts an interview CAS after PostgreSQL normalizes an equivalent ISO offset', async () => {
    const { pool } = fixture();
    const guide = guideRecord('interview-offset-cas');
    const base = readyInterview(guide.guide);
    const offsetCreatedAt = '2026-08-06T12:00:00.000+02:00';
    const interview: PersistedInterview = {
      ...base,
      lifecycle: { ...base.lifecycle, createdAt: offsetCreatedAt },
      coverage: {
        ...base.coverage,
        questions: base.coverage.questions.map((question) => ({ ...question })),
      },
      createdAt: offsetCreatedAt,
      updatedAt: offsetCreatedAt,
    };
    const active = activeInterview(interview);
    const unitOfWork = postgresUnitOfWork(pool);
    try {
      await expect(
        unitOfWork.transaction(async (transaction) => {
          const imported = await transaction.guides.import(guide.guideId, guide);
          if (!imported.ok) return imported;
          return transaction.interviews.create(interview.interviewId, interview);
        }),
      ).resolves.toMatchObject({ ok: true });
      await expect(
        unitOfWork.transaction((transaction) =>
          transaction.interviews.compareAndSwap(interview.interviewId, 0, active),
        ),
      ).resolves.toEqual({ ok: true, value: active });
      await expect(
        unitOfWork.read((context) => context.interviews.load(interview.interviewId)),
      ).resolves.toMatchObject({
        ok: true,
        value: {
          lifecycle: { status: 'active', createdAt: CREATED_AT },
          createdAt: CREATED_AT,
        },
      });
    } finally {
      await removeInterviewAndGuide(pool, interview.interviewId, guide.guideId);
    }
  });

  it('audits late partial STT as ignored after interview completion', async () => {
    const { pool } = fixture();

    await withRollback(pool, async (client) => {
      const interviewId = 'interview-late-partial';
      await insertRawGuide(client, 'guide:v1:late-partial', 'Late partial');
      await insertRawInterview(client, interviewId, 'guide:v1:late-partial');
      await client.query(
        `UPDATE app.interview_state
            SET status = 'completed', state_version = 1, started_at = $2,
                ending_at = $3, ended_at = $3, updated_at = $3
          WHERE interview_id = $1`,
        [interviewId, CREATED_AT, UPDATED_AT],
      );

      const repository = new PostgresTranscriptRepository(createClientSqlExecutor(client));
      const partial = {
        interviewId,
        sourceProvider: 'demo-stt',
        utteranceId: 'late-partial-utterance',
        providerEventId: 'late-partial-event',
        segmentId: 'late-partial-segment',
        text: 'Late partial text',
        revision: 0,
        observedAt: UPDATED_AT,
      } as const;
      await expect(
        repository.upsertPartial(
          interviewId,
          { provider: 'demo-stt', utteranceId: 'late-partial-utterance' },
          partial,
        ),
      ).resolves.toEqual({
        ok: true,
        value: { outcome: 'ignored_finalized', value: partial },
      });

      const disposition = await client.query<{ disposition: string }>(
        `SELECT disposition FROM app.transcript_partial_events
          WHERE interview_id = $1 AND provider_event_id = $2`,
        [interviewId, partial.providerEventId],
      );
      expect(disposition.rows).toEqual([{ disposition: 'ignored_finalized' }]);
    });
  });

  it('treats a failed interview as terminal for every new transcript write', async () => {
    const { pool } = fixture();

    await withRollback(pool, async (client) => {
      const interviewId = 'interview-failed-transcript';
      await insertRawGuide(client, 'guide:v1:failed-transcript', 'Failed transcript');
      await insertRawInterview(client, interviewId, 'guide:v1:failed-transcript');
      await client.query(
        `UPDATE app.interview_state
            SET status = 'failed', state_version = 1, failed_at = $2,
                failed_from = 'ready', failure_code = 'provider_error',
                failure_message = 'The provider failed.', updated_at = $2
          WHERE interview_id = $1`,
        [interviewId, UPDATED_AT],
      );

      const repository = new PostgresTranscriptRepository(createClientSqlExecutor(client));
      const source = { provider: 'demo-stt', utteranceId: 'failed-utterance' };
      const partial = {
        interviewId,
        sourceProvider: source.provider,
        utteranceId: source.utteranceId,
        providerEventId: 'failed-partial-event',
        segmentId: 'failed-partial-segment',
        text: 'Late text after failure.',
        revision: 0,
        observedAt: UPDATED_AT,
      } as const;
      await expect(repository.upsertPartial(interviewId, source, partial)).resolves.toEqual({
        ok: true,
        value: { outcome: 'ignored_finalized', value: partial },
      });
      const gap: TranscriptTechnicalGap = {
        kind: 'technical_gap',
        interviewId,
        sequenceNumber: 1,
        gapId: 'failed-late-gap',
        source: 'speech_to_text',
        sourceProvider: source.provider,
        description: 'A late gap after terminal failure.',
        relatedSegmentId: partial.segmentId,
        relatedUtteranceId: source.utteranceId,
        sourceEventId: 'failed-late-gap-event',
        occurredAt: UPDATED_AT,
      };
      await expect(repository.appendTechnicalGap(interviewId, 1, gap)).resolves.toEqual({
        ok: false,
        error: { code: 'transcript_finalized', interviewId },
      });
      await expect(
        client.query<{ count: number; next_sequence: number }>(
          `SELECT
             (SELECT count(*)::integer FROM app.transcript_entries WHERE interview_id = $1) AS count,
             (SELECT next_transcript_sequence FROM app.interview_counters WHERE interview_id = $1)
               AS next_sequence`,
          [interviewId],
        ),
      ).resolves.toMatchObject({ rows: [{ count: 0, next_sequence: 1 }] });
    });
  });

  it('persists and resets an interview display name without mutating its guide, state or transcript', async () => {
    const { pool } = fixture();
    const h = await startDynamicRealtimeInterview(pool, 'management-rename');
    await h.answer('management-rename', 'Wir passen bei Engpaessen unseren Schichtplan an.');
    await h.service().pause(h.interviewId);
    const before = await h.service().get(h.interviewId);
    const service = new ManageInterviewsService(postgresUnitOfWork(pool));
    const renamed = await service.rename(h.interviewId, '  Standortinterview Nord  ');
    expect(renamed).toMatchObject({
      ok: true,
      value: {
        interviewId: h.interviewId,
        displayName: 'Standortinterview Nord',
        guideTitle: before.guideTitle,
        status: 'paused',
        updatedAt: before.updatedAt,
      },
    });
    const reconstructed = new ManageInterviewsService(postgresUnitOfWork(pool));
    const listed = await postgresUnitOfWork(pool).read(({ interviews }) =>
      interviews.listSummaries({ after: null, limit: 100 }),
    );
    expect(listed).toMatchObject({ ok: true });
    if (!listed.ok) throw new Error('Cannot read renamed interview');
    expect(
      listed.value.interviews.find((interview) => interview.interviewId === h.interviewId)
        ?.displayName,
    ).toBe('Standortinterview Nord');
    expect(await h.service().get(h.interviewId)).toEqual(before);
    await expect(reconstructed.rename(h.interviewId, null)).resolves.toMatchObject({
      ok: true,
      value: { displayName: null },
    });
    expect(await h.service().get(h.interviewId)).toEqual(before);
    await expect(service.rename('interview-management-missing', 'Name')).resolves.toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    await expect(service.delete('interview-management-missing')).resolves.toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    await expect(service.delete(h.interviewId)).resolves.toEqual({ ok: true, value: undefined });
    await expect(
      pool.query('select id from app.guides where id = $1', [before.guideId]),
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  it('atomically deletes only one completed interview with mixed transcript, delivery, workflow, event and evaluation children', async () => {
    const { pool } = fixture();
    const h = await startDynamicRealtimeInterview(pool, 'management-delete');
    const other = await startDynamicRealtimeInterview(pool, 'management-preserve');
    await h.answer(
      'management-delete',
      'Wir verteilen Aufgaben bei Lieferengpaessen neu und besprechen die Rueckmeldungen.',
    );
    const nextQuestion = await h.service().reserveRealtimeTurnIntent(h.interviewId, {
      clientEventId: 'management-delete-second-question',
      action: 'ask_main_question',
      questionId: h.nextQuestionId,
      spokenText: 'Wie bereiten Sie sich vor?',
      answerDisposition: 'answered',
      missingAspect: null,
      requestedEvidenceType: null,
    });
    await h.speak(nextQuestion.nextAiTurn);
    await h.answer(
      'management-delete-second-answer',
      'Wir planen Ersatzlieferanten und besprechen die Notfallablaeufe regelmaessig.',
    );
    await h.service().end(h.interviewId);
    await h.service().end(h.interviewId);
    const before = await h.service().get(h.interviewId);
    const untouched = await other.service().get(other.interviewId);
    expect(before.status).toBe('completed');
    expect(before.transcript.some((turn) => turn.speaker === 'participant')).toBe(true);
    expect(before.transcript.some((turn) => turn.speaker === 'ai_interviewer')).toBe(true);
    const canonical = await postgresUnitOfWork(pool).read(({ transcripts }) =>
      transcripts.loadAggregate(h.interviewId),
    );
    if (!canonical.ok) throw new Error('Could not load deletion fixture transcript');
    expect(validateFinalTranscript(canonical.value).issues).toEqual([]);
    const profile = await ensureManagementEvaluationProfile(pool);
    const evaluation = new EvaluationService(
      postgresUnitOfWork(pool),
      managementEvaluationClock,
      managementHasher,
      new DemoEvaluationCoder(),
    );
    const report = await evaluation.run(h.interviewId, profile.profileId);
    expect(report.status).toBe('completed');
    const beforeRows = await managementChildCounts(pool, h.interviewId);
    expect(beforeRows.transcript_entries).toBeGreaterThan(0);
    expect(beforeRows.transcript_final_segments).toBeGreaterThan(0);
    expect(beforeRows.ai_turn_deliveries).toBeGreaterThan(0);
    expect(beforeRows.workflow_runs).toBeGreaterThan(0);
    expect(beforeRows.event_outbox).toBeGreaterThan(0);
    expect(beforeRows.transcript_finalizations).toBe(1);
    expect(beforeRows.evaluation_runs).toBe(1);
    await expect(
      new ManageInterviewsService(postgresUnitOfWork(pool)).delete(h.interviewId),
    ).resolves.toEqual({ ok: true, value: undefined });
    expect(
      Object.values(await managementChildCounts(pool, h.interviewId)).every((count) => count === 0),
    ).toBe(true);
    await expect(
      pool.query('select id from app.interviews where id = $1', [h.interviewId]),
    ).resolves.toMatchObject({ rowCount: 0 });
    await expect(
      pool.query('select id from app.guides where id = $1', [before.guideId]),
    ).resolves.toMatchObject({ rowCount: 1 });
    await expect(
      pool.query('select profile_id from app.evaluation_profiles where profile_id = $1', [
        profile.profileId,
      ]),
    ).resolves.toMatchObject({ rowCount: 1 });
    expect(await other.service().get(other.interviewId)).toEqual(untouched);
  });

  it('rejects deletion of active interviews and interviews with queued workflow jobs', async () => {
    const { pool } = fixture();
    const h = await startDynamicRealtimeInterview(pool, 'management-busy');
    const service = new ManageInterviewsService(postgresUnitOfWork(pool));
    await expect(service.delete(h.interviewId)).resolves.toEqual({
      ok: false,
      error: { code: 'interview_busy', interviewId: h.interviewId, reason: 'active_interview' },
    });
    await h.service().pause(h.interviewId);
    await withCommittedClient(pool, (client) =>
      insertRawJob(client, h.interviewId, 'management-queued-job', 'queued'),
    );
    await expect(service.delete(h.interviewId)).resolves.toEqual({
      ok: false,
      error: { code: 'interview_busy', interviewId: h.interviewId, reason: 'active_job' },
    });
    await expect(
      pool.query('select id from app.interviews where id = $1', [h.interviewId]),
    ).resolves.toMatchObject({ rowCount: 1 });
    await pool.query('delete from app.durable_jobs where id = $1', ['management-queued-job']);
    await expect(service.delete(h.interviewId)).resolves.toEqual({ ok: true, value: undefined });
  });

  it('keeps an interview and its run intact while the scoring provider call is in flight', async () => {
    const { pool } = fixture();
    const h = await startDynamicRealtimeInterview(pool, 'management-evaluation-inflight');
    await h.answer(
      'management-evaluation-inflight',
      'Das Team passt die Planung an, die Verantwortung ist aber teilweise unklar.',
    );
    await h.service().pause(h.interviewId);
    const before = await h.service().get(h.interviewId);
    const profile = await ensureManagementEvaluationProfile(pool);
    const delegate = new DemoEvaluationCoder();
    let enter: (() => void) | undefined;
    let release: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = new EvaluationService(
      postgresUnitOfWork(pool),
      managementEvaluationClock,
      managementHasher,
      {
        model: delegate.model,
        code: async (input, context) => {
          enter?.();
          await released;
          return delegate.code(input, context);
        },
      },
    );
    const running = service.run(h.interviewId, profile.profileId);
    try {
      await entered;
      await expect(
        new ManageInterviewsService(postgresUnitOfWork(pool)).delete(h.interviewId),
      ).resolves.toEqual({
        ok: false,
        error: { code: 'interview_busy', interviewId: h.interviewId, reason: 'active_evaluation' },
      });
      expect(await h.service().get(h.interviewId)).toEqual(before);
      await expect(
        pool.query('select status from app.evaluation_runs where interview_id = $1', [
          h.interviewId,
        ]),
      ).resolves.toMatchObject({ rows: [{ status: 'running' }] });
    } finally {
      release?.();
    }
    expect((await running).status).toBe('completed');
    await expect(
      new ManageInterviewsService(postgresUnitOfWork(pool)).delete(h.interviewId),
    ).resolves.toEqual({ ok: true, value: undefined });
  });

  it('does not delete a newly committed evaluation after waiting on its repeatable-read interview lock', async () => {
    const { pool } = fixture();
    const h = await startDynamicRealtimeInterview(pool, 'management-evaluation-lock-race');
    await h.answer(
      'management-evaluation-lock-race',
      'Wir aendern die Schichtplanung nach Rueckmeldungen.',
    );
    await h.service().pause(h.interviewId);
    const before = await h.service().get(h.interviewId);
    const profile = await ensureManagementEvaluationProfile(pool);
    const starter = await pool.connect();
    const remover = await pool.connect();
    let deletion: Promise<unknown> | null = null;
    try {
      const removerInfo = await remover.query<{ pid: number }>('select pg_backend_pid() as pid');
      const pid = removerInfo.rows[0]?.pid;
      if (pid === undefined) throw new Error('Missing deletion backend ID');
      await starter.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const transaction = persistenceContexts.createTransaction(createClientSqlExecutor(starter));
      expect((await transaction.interviews.lock(h.interviewId)).ok).toBe(true);
      expect(
        (
          await transaction.evaluations.startRun(h.interviewId, {
            evaluationId: 'evaluation-management-lock-race',
            interviewId: h.interviewId,
            profileId: profile.profileId,
            profileFingerprint: 'a'.repeat(64),
            transcriptFingerprint: 'b'.repeat(64),
            language: 'de',
            promptVersion: 'management-test',
            model: new DemoEvaluationCoder().model,
            startedAt: managementEvaluationClock.now(),
          })
        ).ok,
      ).toBe(true);
      await remover.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const pending = new PostgresInterviewRepository(createClientSqlExecutor(remover)).delete(
        h.interviewId,
      );
      deletion = pending;
      await waitForManagementRowLock(pool, pid);
      await starter.query('COMMIT');
      const result = await pending;
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('An active evaluation must not be deleted');
      expect(['serialization_failure', 'interview_busy']).toContain(result.error.code);
      await remover.query('ROLLBACK');
      expect(await h.service().get(h.interviewId)).toEqual(before);
      await expect(
        pool.query('select status from app.evaluation_runs where interview_id = $1', [
          h.interviewId,
        ]),
      ).resolves.toMatchObject({ rows: [{ status: 'running' }] });
    } finally {
      await starter.query('ROLLBACK');
      await remover.query('ROLLBACK');
      if (deletion !== null) await deletion;
      starter.release();
      remover.release();
    }
    await pool.query('delete from app.evaluation_runs where interview_id = $1', [h.interviewId]);
    await expect(
      new ManageInterviewsService(postgresUnitOfWork(pool)).delete(h.interviewId),
    ).resolves.toEqual({ ok: true, value: undefined });
  });
});

const managementEvaluationClock = { now: () => '2026-10-01T12:00:00.000Z' };
const managementHasher = {
  digestUtf8: (value: string) => createHash('sha256').update(value).digest('hex'),
};

function ensureManagementEvaluationProfile(pool: Pool) {
  return new EnsureDefaultEvaluationProfileService(
    postgresUnitOfWork(pool),
    managementEvaluationClock,
    loadOrganizationalResilienceEvaluationAssets(),
  ).execute();
}

async function managementChildCounts(
  pool: Pool,
  interviewId: string,
): Promise<Readonly<Record<string, number>>> {
  const tables = [
    'interview_state',
    'interview_counters',
    'command_receipts',
    'durable_jobs',
    'workflow_runs',
    'agent_runs',
    'workflow_step_runs',
    'ai_turn_deliveries',
    'transcript_entries',
    'transcript_turns',
    'transcript_partial_events',
    'transcript_final_segments',
    'transcript_gaps',
    'question_coverage',
    'coverage_turn_references',
    'contradictions',
    'contradiction_turn_references',
    'transcript_finalizations',
    'evaluation_runs',
    'event_outbox',
  ];
  const result: Record<string, number> = {};
  for (const table of tables) {
    const count = await pool.query<{ count: number }>(
      `select count(*)::integer as count from app.${table} where interview_id = $1`,
      [interviewId],
    );
    result[table] = count.rows[0]?.count ?? -1;
  }
  return result;
}

async function waitForManagementRowLock(pool: Pool, pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  do {
    const result = await pool.query<{ waiting: boolean }>(
      "select wait_event_type = 'Lock' as waiting from pg_stat_activity where pid = $1",
      [pid],
    );
    if (result.rows[0]?.waiting === true) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  throw new Error('Deletion did not reach the expected row lock');
}

const persistenceContexts = new PostgresPersistenceContextFactory();

async function startDynamicRealtimeInterview(pool: Pool, suffix: string) {
  const interviewId = `interview-${suffix}`;
  const clock = { now: () => '2026-09-30T12:00:00.000Z' };
  const hasher = {
    digestUtf8: (value: string) => createHash('sha256').update(value).digest('hex'),
  };
  const unitOfWork = postgresUnitOfWork(pool);
  const imported = await new ImportGuideService(unitOfWork, clock, hasher).execute({
    markdown: `# Interviewleitfaden: ${suffix}\n\n## Vorgehen\n\n### Hauptfrage\nWie handelt Ihre Organisation unter schwierigen Bedingungen?\n\n### Hauptfrage\nWie bereiten Sie sich vor?`,
  });
  if (!imported.ok) throw new Error(`Could not import dynamic guide: ${imported.error.code}`);
  const questions = imported.value.guide.sections[0]?.mainQuestions;
  const first = questions?.[0];
  const next = questions?.[1];
  if (first === undefined || next === undefined)
    throw new Error('Dynamic guide requires two questions');
  const created = await new CreateInterviewService(unitOfWork, clock, hasher).execute({
    interviewId,
    guideId: imported.value.guide.id,
  });
  if (!created.ok) throw new Error(`Could not create dynamic interview: ${created.error.code}`);
  const service = () =>
    new CanonicalInterviewSessionService(
      postgresUnitOfWork(pool),
      clock,
      new DemoInterviewAgentExecutor(),
      { model: { mode: 'demo', provider: null, model: null } },
    );
  const speak = async (plan: MvpRealtimeTurnPlan | null) => {
    if (plan === null) throw new Error('Expected a pending spoken turn');
    return service().appendRealtimeAiTurn(interviewId, {
      deliveryId: plan.deliveryId,
      clientEventId: `spoken-${plan.deliveryId}`,
      text: plan.text,
      turnType: plan.turnType,
      questionId: plan.questionId,
    });
  };
  const greeting = await service().startRealtime(interviewId);
  const firstQuestion = await speak(greeting.nextAiTurn);
  await speak(firstQuestion.nextAiTurn);
  return {
    interviewId,
    questionId: first.id,
    nextQuestionId: next.id,
    questionText: first.text,
    service,
    speak,
    answer: (id: string, text: string) =>
      service().appendRealtimeParticipantTurn(interviewId, {
        clientEventId: `participant-${id}`,
        sourceProvider: 'openai_realtime',
        text,
      }),
  };
}

interface CommittedInterviewFixture {
  readonly guideId: string;
  readonly interviewId: string;
  readonly jobId: string;
  readonly workflowRunId: string;
}

function postgresUnitOfWork(pool: Pool): PostgresUnitOfWork {
  return new PostgresUnitOfWork(createPgUnitOfWorkPool(pool), persistenceContexts);
}

function synchronizeMissingInterviewLoads(pool: Pool, interviewId: string): UnitOfWorkPool {
  const underlying = createPgUnitOfWorkPool(pool);
  let arrivalCount = 0;
  let releaseGate: (() => void) | undefined;
  const gate = new Promise<void>((resolvePromise) => {
    releaseGate = resolvePromise;
  });

  return {
    async connect(): Promise<UnitOfWorkClient> {
      const client = await underlying.connect();
      return {
        async query(statement, parameters = []) {
          const result = await client.query(statement, parameters);
          if (
            result.rowCount === 0 &&
            parameters[0] === interviewId &&
            /from app\.interview_state st/u.test(statement)
          ) {
            arrivalCount += 1;
            if (arrivalCount === 2) releaseGate?.();
            await gate;
          }
          return result;
        },
        release: (destroy = false) => {
          client.release(destroy);
        },
      };
    },
  };
}

async function expectInitialInterviewRowCounts(pool: Pool, interviewId: string): Promise<void> {
  const result = await pool.query<{
    readonly interviewCount: string;
    readonly counterCount: string;
    readonly eventCount: string;
  }>(
    `SELECT
       (SELECT count(*) FROM app.interviews WHERE id = $1)::text AS "interviewCount",
       (SELECT count(*) FROM app.interview_counters WHERE interview_id = $1)::text AS "counterCount",
       (SELECT count(*) FROM app.event_outbox WHERE interview_id = $1)::text AS "eventCount"`,
    [interviewId],
  );
  expect(result.rows).toEqual([{ interviewCount: '1', counterCount: '1', eventCount: '1' }]);
}

function createSignal(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolver: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolver = resolve;
  });
  return {
    promise,
    resolve(): void {
      resolver?.();
    },
  };
}

async function readBackendPid(client: PoolClient): Promise<number> {
  const result = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  const pid = result.rows[0]?.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid)) {
    throw new Error('PostgreSQL did not return a backend PID');
  }
  return pid;
}

async function waitUntilBlocked(pool: Pool, backendPid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await pool.query<{ blocked: boolean }>(
      'SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked',
      [backendPid],
    );
    if (result.rows[0]?.blocked === true) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`PostgreSQL backend ${backendPid} did not wait for the owned lease lock`);
}

function createSignalingUnitOfWorkPool(pool: Pool, onWriteLock: () => void): UnitOfWorkPool {
  const base = createPgUnitOfWorkPool(pool);
  return {
    async connect() {
      const client = await base.connect();
      return {
        async query(statement, parameters = []) {
          if (statement.toUpperCase().includes('FOR UPDATE OF ST, C')) onWriteLock();
          return client.query(statement, parameters);
        },
        release(destroy = false): void {
          client.release(destroy);
        },
      };
    },
  };
}

async function createCommittedInterviewFixture(
  pool: Pool,
  suffix: string,
): Promise<CommittedInterviewFixture> {
  const committed = {
    guideId: `guide:v1:${suffix}`,
    interviewId: `interview-${suffix}`,
    jobId: `job-${suffix}`,
    workflowRunId: `workflow-${suffix}`,
  } as const;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await insertRawGuide(client, committed.guideId, `Guide ${suffix}`);
    await insertRawInterview(client, committed.interviewId, committed.guideId);
    await insertRawJob(client, committed.interviewId, committed.jobId, 'succeeded');
    await insertRawWorkflow(
      client,
      committed.interviewId,
      committed.jobId,
      committed.workflowRunId,
    );
    await client.query('COMMIT');
    return committed;
  } catch (error: unknown) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function removeCommittedInterviewFixture(
  pool: Pool,
  committed: CommittedInterviewFixture,
): Promise<void> {
  await pool.query('DELETE FROM app.interviews WHERE id = $1', [committed.interviewId]);
  await pool.query('DELETE FROM app.guides WHERE id = $1', [committed.guideId]);
}

async function removeInterviewAndGuide(
  pool: Pool,
  interviewId: string,
  guideId: string,
): Promise<void> {
  await withCommittedClient(pool, async (client) => {
    await client.query('DELETE FROM app.transcript_entries WHERE interview_id = $1', [interviewId]);
    await client.query('DELETE FROM app.ai_turn_deliveries WHERE interview_id = $1', [interviewId]);
    await client.query('DELETE FROM app.interviews WHERE id = $1', [interviewId]);
    await client.query('DELETE FROM app.guides WHERE id = $1', [guideId]);
  });
}

function aiReservation(
  committed: CommittedInterviewFixture,
  suffix: string,
): AiDeliveryReservation {
  return {
    deliveryId: `delivery-${suffix}-${committed.interviewId}`,
    jobId: committed.jobId,
    workflowRunId: committed.workflowRunId,
    turnId: `turn-${suffix}-${committed.interviewId}`,
    utteranceId: `utterance-${suffix}-${committed.interviewId}`,
    turnType: 'greeting',
    guideReference: null,
    proposedText: 'Welcome to the interview.',
    createdAt: CREATED_AT,
  };
}

async function persistAiTurn(
  pool: Pool,
  jobId: string,
  workflowRunId: string,
  turn: AiTranscriptTurn,
): Promise<void> {
  const reservation: AiDeliveryReservation = {
    deliveryId: `reservation-${turn.turnId}`,
    jobId,
    workflowRunId,
    turnId: turn.turnId,
    utteranceId: `utterance-${turn.turnId}`,
    turnType: turn.turnType,
    guideReference: turn.guideReference,
    proposedText: turn.text,
    createdAt: turn.occurredAt,
  };
  const unitOfWork = postgresUnitOfWork(pool);
  const reserved = await unitOfWork.transaction((transaction) =>
    transaction.transcripts.reserveAiDelivery(turn.interviewId, turn.sequenceNumber, reservation),
  );
  if (!reserved.ok) {
    throw new Error(`Could not reserve AI turn ${turn.turnId}: ${reserved.error.code}`);
  }
  const resolved = await unitOfWork.transaction((transaction) =>
    transaction.transcripts.resolveAiDelivery(turn.interviewId, {
      deliveryId: reservation.deliveryId,
      provider: 'demo-voice',
      providerDeliveryEventId: turn.deliveryEventId,
      resolvedAt:
        turn.delivery.status === 'interrupted' ? turn.delivery.interruptedAt : turn.occurredAt,
      turn,
    }),
  );
  if (!resolved.ok) {
    throw new Error(`Could not resolve AI turn ${turn.turnId}: ${resolved.error.code}`);
  }
}

function technicalTransportGap(
  interviewId: string,
  sequenceNumber: number,
  suffix: string,
  occurredAt: string,
): TranscriptTechnicalGap {
  return {
    kind: 'technical_gap',
    interviewId,
    sequenceNumber,
    gapId: `gap-${suffix}-${interviewId}`,
    sourceEventId: `gap-event-${suffix}-${interviewId}`,
    source: 'transport',
    sourceProvider: null,
    relatedUtteranceId: null,
    description: 'A transport interval could not be reconstructed.',
    occurredAt,
    relatedSegmentId: null,
  };
}

async function readTranscriptStorageState(
  pool: Pool,
  interviewId: string,
): Promise<{
  readonly deliveryCount: number;
  readonly entryCount: number;
  readonly nextSequence: number;
}> {
  const result = await pool.query<{
    delivery_count: number;
    entry_count: number;
    next_sequence: number;
  }>(
    `SELECT
       (SELECT count(*)::integer FROM app.ai_turn_deliveries
         WHERE interview_id = $1) AS delivery_count,
       (SELECT count(*)::integer FROM app.transcript_entries
         WHERE interview_id = $1) AS entry_count,
       (SELECT next_transcript_sequence FROM app.interview_counters
         WHERE interview_id = $1) AS next_sequence`,
    [interviewId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('Transcript storage state query returned no row');
  return {
    deliveryCount: row.delivery_count,
    entryCount: row.entry_count,
    nextSequence: row.next_sequence,
  };
}

async function profileJsonRequest(
  app: ReturnType<typeof createBackendHttpApp>,
  path: string,
  method: 'POST' | 'PUT',
  body: unknown,
): Promise<Response> {
  return await app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function profileDeleteUrl(profileId: string, expectedUpdatedAt: string): string {
  return `/api/v1/evaluation-profiles/${encodeURIComponent(profileId)}?${new URLSearchParams({
    expectedUpdatedAt,
  }).toString()}`;
}

function fixture(): IntegrationFixture {
  if (integrationFixture === undefined) {
    throw new Error('PostgreSQL integration fixture is not initialized');
  }
  return integrationFixture;
}

function authorizeDestructiveReset(connectionString: string): string {
  if (process.env.ALLOW_TEST_DATABASE_RESET !== 'true') {
    throw new Error('ALLOW_TEST_DATABASE_RESET=true is required before resetting a test database');
  }

  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('TEST_DATABASE_URL must be a valid PostgreSQL URL');
  }
  let databaseName: string;
  try {
    databaseName = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new Error('TEST_DATABASE_URL contains an invalid encoded database name');
  }
  if (databaseName.length === 0 || databaseName.includes('/') || !databaseName.endsWith('_test')) {
    throw new Error('TEST_DATABASE_URL must name a database ending in _test');
  }
  return databaseName;
}

async function readDatabaseInfo(pool: Pool): Promise<z.infer<typeof databaseInfoSchema>> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT current_setting('server_version_num')::integer AS "serverVersionNumber",
            current_database() AS "databaseName"`,
  );
  return parseSingleRow(result.rows, databaseInfoSchema, 'database metadata');
}

async function cleanupDatabase(): Promise<void> {
  const errors: unknown[] = [];
  const pool = managedPool;
  const lockClient = integrationLockClient;

  if (pool !== undefined && resetAuthorized) {
    try {
      await pool.pool.query('DROP SCHEMA IF EXISTS app CASCADE');
    } catch (error: unknown) {
      errors.push(error);
    }
  }

  if (lockClient !== undefined) {
    let destroyClient = false;
    try {
      const result = await lockClient.query<Record<string, unknown>>(
        'SELECT pg_advisory_unlock($1::integer, $2::integer) AS unlocked',
        [INTEGRATION_LOCK_NAMESPACE, INTEGRATION_LOCK_RESOURCE],
      );
      parseSingleRow(result.rows, advisoryUnlockSchema, 'advisory unlock');
    } catch (error: unknown) {
      destroyClient = true;
      errors.push(error);
    } finally {
      lockClient.release(destroyClient);
    }
  }

  if (pool !== undefined) {
    try {
      await pool.close();
    } catch (error: unknown) {
      errors.push(error);
    }
  }

  integrationFixture = undefined;
  integrationLockClient = undefined;
  managedPool = undefined;
  resetAuthorized = false;
  if (errors.length > 0) {
    throw new AggregateError(errors, 'PostgreSQL integration cleanup failed');
  }
}

async function withRollback(
  pool: Pool,
  operation: (client: PoolClient) => Promise<void>,
): Promise<void> {
  const client = await pool.connect();
  let operationFailed = false;
  let operationError: unknown;
  try {
    await client.query('BEGIN');
    await operation(client);
  } catch (error: unknown) {
    operationFailed = true;
    operationError = error;
  }

  try {
    await client.query('ROLLBACK');
  } catch (rollbackError: unknown) {
    client.release(true);
    if (operationFailed) {
      throw new AggregateError(
        [operationError, rollbackError],
        'PostgreSQL test operation and rollback both failed',
        { cause: rollbackError },
      );
    }
    throw rollbackError;
  }
  client.release();
  if (operationFailed) {
    throw operationError;
  }
}

async function withCommittedClient(
  pool: Pool,
  operation: (client: PoolClient) => Promise<void>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await operation(client);
    await client.query('COMMIT');
  } catch (error: unknown) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function insertRawTranscriptContractInterview(
  client: PoolClient,
  suffix: string,
): Promise<string> {
  const guideId = `guide:v1:transcript-contract-${suffix}`;
  const interviewId = `interview-transcript-contract-${suffix}`;
  await insertRawGuide(client, guideId, `Transcript contract ${suffix}`);
  await insertRawInterview(client, interviewId, guideId);
  return interviewId;
}

async function insertRawTranscriptGap(
  client: PoolClient,
  interviewId: string,
  gapId: string,
  description: string,
  sourceEventId = `event-${gapId}`,
): Promise<void> {
  await client.query(
    `INSERT INTO app.transcript_entries
       (interview_id, sequence_number, entry_id, kind, occurred_at)
     VALUES ($1, 1, $2, 'technical_gap', $3)`,
    [interviewId, gapId, CREATED_AT],
  );
  await client.query(
    `INSERT INTO app.transcript_gaps (
       interview_id, gap_id, entry_kind, source, provider, description,
       related_segment_id, related_utterance_id, source_event_id
     ) VALUES ($1, $2, 'technical_gap', 'transport', NULL, $3, NULL, NULL, $4)`,
    [interviewId, gapId, description, sourceEventId],
  );
}

async function insertRawGuide(client: PoolClient, guideId: string, title: string): Promise<void> {
  await client.query(
    `INSERT INTO app.guides (id, title, source_markdown, stable_id_version, created_at)
     VALUES ($1, $2, $3, 'v1', $4)`,
    [guideId, title, '# Test guide', CREATED_AT],
  );
}

async function insertRawInterview(
  client: PoolClient,
  interviewId: string,
  guideId: string,
): Promise<void> {
  await client.query('INSERT INTO app.interviews (id, guide_id, created_at) VALUES ($1, $2, $3)', [
    interviewId,
    guideId,
    CREATED_AT,
  ]);
  await client.query(
    `INSERT INTO app.interview_state (
       interview_id, guide_id, status, state_version, coverage_version, created_at, updated_at
     ) VALUES ($1, $2, 'ready', 0, 0, $3, $3)`,
    [interviewId, guideId, CREATED_AT],
  );
  await client.query(
    `INSERT INTO app.interview_counters
       (interview_id, next_transcript_sequence, next_event_sequence)
     VALUES ($1, 1, 1)`,
    [interviewId],
  );
}

async function insertRawJob(
  client: PoolClient,
  interviewId: string,
  jobId: string,
  status: 'queued' | 'succeeded',
): Promise<void> {
  const succeeded = status === 'succeeded';
  await client.query(
    `INSERT INTO app.durable_jobs (
       id, interview_id, type, idempotency_key, expected_state_version,
       status, attempt_count, maximum_attempts, available_at,
       applied_state_version, created_at, updated_at, completed_at
     ) VALUES ($1, $2, 'start_interview', $3, 0, $4, 0, 3, $5, $6, $5, $5, $7)`,
    [
      jobId,
      interviewId,
      `${jobId}-key`,
      status,
      CREATED_AT,
      succeeded ? 0 : null,
      succeeded ? CREATED_AT : null,
    ],
  );
}

async function insertRawRunningJob(
  client: PoolClient,
  interviewId: string,
  jobId: string,
  leaseToken: string,
  leaseExpiresAt: string,
): Promise<void> {
  await client.query(
    `INSERT INTO app.durable_jobs (
       id, interview_id, type, idempotency_key, expected_state_version,
       status, attempt_count, maximum_attempts, available_at,
       lease_owner, lease_token, lease_expires_at, created_at, updated_at
     ) VALUES ($1, $2, 'start_interview', $3, 0, 'running', 1, 3, $4,
               'worker-owned-lease-fencing', $5, $6, $4, $4)`,
    [jobId, interviewId, `${jobId}-key`, CREATED_AT, leaseToken, leaseExpiresAt],
  );
}

async function insertRawWorkflow(
  client: PoolClient,
  interviewId: string,
  jobId: string,
  workflowRunId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO app.workflow_runs (
       id, interview_id, job_id, mastra_attempt_id, attempt_number,
       expected_state_version, status, retry_count, created_at
     ) VALUES ($1, $2, $3, $4, 1, 0, 'waiting', 0, $5)`,
    [workflowRunId, interviewId, jobId, `${workflowRunId}-attempt`, CREATED_AT],
  );
}

async function insertRawParticipantTurn(
  client: PoolClient,
  interviewId: string,
  turnId: string,
  sequenceNumber: number,
  utteranceId: string,
  includeFinalSegment = true,
): Promise<void> {
  const providerEventId = `${turnId}-provider-event`;
  const segmentId = `${turnId}-segment`;
  await client.query(
    `INSERT INTO app.transcript_entries
       (interview_id, sequence_number, entry_id, kind, occurred_at)
     VALUES ($1, $2, $3, 'turn', $4)`,
    [interviewId, sequenceNumber, turnId, CREATED_AT],
  );
  await client.query(
    `INSERT INTO app.transcript_turns (
       interview_id, turn_id, entry_kind, speaker, turn_type, text,
       source_provider, provider_event_id, source_segment_id
     ) VALUES ($1, $2, 'turn', 'participant', 'participant_answer', $3, 'demo-stt', $4, $5)`,
    [interviewId, turnId, 'Participant answer', providerEventId, segmentId],
  );
  if (!includeFinalSegment) return;
  await client.query(
    `INSERT INTO app.transcript_final_segments (
       interview_id, provider, provider_event_id, segment_id, utterance_id,
       turn_id, text, observed_at, finalized_at
     ) VALUES ($1, 'demo-stt', $2, $3, $4, $5, $6, $7, $7)`,
    [
      interviewId,
      providerEventId,
      segmentId,
      utteranceId,
      turnId,
      'Participant answer',
      CREATED_AT,
    ],
  );
}

async function insertRawAiDelivery(
  client: PoolClient,
  interviewId: string,
  jobId: string,
  workflowRunId: string,
  deliveryId: string,
  turnId: string,
  sequenceNumber: number,
  status: 'pending' | 'complete',
): Promise<void> {
  const complete = status === 'complete';
  await client.query(
    `INSERT INTO app.ai_turn_deliveries (
       id, interview_id, job_id, workflow_run_id, turn_id, utterance_id,
       reserved_sequence_number, turn_type, proposed_text, status,
       provider, provider_delivery_event_id, confirmed_spoken_text,
       created_at, resolved_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'greeting', 'Welcome.', $8,
               $9, $10, $11, $12, $13)`,
    [
      deliveryId,
      interviewId,
      jobId,
      workflowRunId,
      turnId,
      `${deliveryId}-utterance`,
      sequenceNumber,
      status,
      complete ? 'demo-tts' : null,
      complete ? `${deliveryId}-provider-event` : null,
      complete ? 'Welcome.' : null,
      CREATED_AT,
      complete ? UPDATED_AT : null,
    ],
  );
}

async function allocateTranscriptSequence(
  client: PoolClient,
  interviewId: string,
  expectedSequence: number,
): Promise<number | null> {
  const result = await client.query<Record<string, unknown>>(
    `UPDATE app.interview_counters
        SET next_transcript_sequence = next_transcript_sequence + 1
      WHERE interview_id = $1 AND next_transcript_sequence = $2
      RETURNING next_transcript_sequence - 1 AS "allocatedSequence"`,
    [interviewId, expectedSequence],
  );
  if (result.rowCount === 0) {
    return null;
  }
  return parseSingleRow(result.rows, allocatedSequenceSchema, 'sequence allocation')
    .allocatedSequence;
}

function parseSingleRow<T>(rows: readonly unknown[], schema: z.ZodType<T>, label: string): T {
  const result = z.array(schema).safeParse(rows);
  if (!result.success || result.data.length !== 1) {
    throw new Error(`PostgreSQL returned invalid ${label}`);
  }
  const row = result.data[0];
  if (row === undefined) {
    throw new Error(`PostgreSQL returned no ${label}`);
  }
  return row;
}

function notificationEvent(interviewId: string): MonitoringEventDraft {
  return {
    eventId: `event-${interviewId}`,
    interviewId,
    runId: `run-${interviewId}`,
    occurredAt: CREATED_AT,
    category: 'interview',
    type: 'interview.status_changed',
    payload: {
      previousStatus: 'ready',
      nextStatus: 'active',
      changedAt: CREATED_AT,
    },
  };
}

async function withTestDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolvePromise, rejectPromise) => {
        timeout = setTimeout(() => {
          rejectPromise(new Error('PostgreSQL notification test deadline exceeded'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function guideRecord(suffix: string): ImportedGuideRecord {
  const guide = guideSnapshot(suffix);
  return {
    guideId: guide.id,
    guide,
    sourceHash: createHash('sha256').update(guide.sourceMarkdown).digest('hex'),
    importedAt: CREATED_AT,
  };
}

function guideSnapshot(suffix: string): InterviewGuideSnapshot {
  const guideId = `guide:v1:integration-${suffix}`;
  return {
    id: guideId,
    sourceLanguage: 'de',
    title: `Integration guide ${suffix}`,
    sourceMarkdown: `# Integration guide ${suffix}\n\n## Section\n\n### Hauptfrage\nQuestion?\n\n#### Vertiefungsfragen\n\n- Follow-up?`,
    createdAt: CREATED_AT,
    sections: [
      {
        id: `${guideId}:section`,
        position: 0,
        title: 'Section',
        mainQuestions: [
          {
            id: `${guideId}:main`,
            position: 0,
            text: 'Question?',
            followUpQuestions: [{ id: `${guideId}:follow-up`, position: 0, text: 'Follow-up?' }],
          },
        ],
      },
    ],
  };
}

function readyInterview(guide: InterviewGuideSnapshot): PersistedInterview {
  const interviewId = 'interview-integration-cas';
  const mainQuestion = guide.sections[0]?.mainQuestions[0];
  const followUp = mainQuestion?.followUpQuestions[0];
  if (mainQuestion === undefined || followUp === undefined) {
    throw new Error('Integration guide has no questions');
  }
  return {
    interviewId,
    guideId: guide.id,
    lifecycle: {
      status: 'ready',
      interviewId,
      guideId: guide.id,
      createdAt: CREATED_AT,
      revision: 0,
    },
    coverage: {
      interviewId,
      guideId: guide.id,
      revision: 0,
      questions: [
        {
          questionId: mainQuestion.id,
          kind: 'main',
          mainQuestionId: mainQuestion.id,
          status: 'not_addressed',
          referencedTurnIds: [],
          updatedAt: null,
        },
        {
          questionId: followUp.id,
          kind: 'follow_up',
          mainQuestionId: mainQuestion.id,
          status: 'not_addressed',
          referencedTurnIds: [],
          updatedAt: null,
        },
      ],
    },
    version: 0,
    activeWorkflowRunId: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

function activeInterview(interview: PersistedInterview): PersistedInterview {
  const [mainQuestion, followUp] = interview.coverage.questions;
  if (mainQuestion === undefined || followUp === undefined) {
    throw new Error('Integration interview has no coverage questions');
  }
  return {
    ...interview,
    lifecycle: {
      status: 'active',
      interviewId: interview.interviewId,
      guideId: interview.guideId,
      createdAt: interview.createdAt,
      revision: 1,
      startedAt: UPDATED_AT,
      activeSince: UPDATED_AT,
    },
    coverage: {
      ...interview.coverage,
      revision: 1,
      questions: [{ ...mainQuestion, status: 'current', updatedAt: UPDATED_AT }, followUp],
    },
    version: 1,
    updatedAt: UPDATED_AT,
  };
}

function completionProgression(interview: PersistedInterview): {
  readonly active: PersistedInterview;
  readonly ending: PersistedInterview;
  readonly completed: PersistedInterview;
  readonly failed: PersistedInterview;
} {
  const active = activeInterview(interview);
  const ending: PersistedInterview = {
    ...active,
    lifecycle: {
      status: 'ending',
      interviewId: interview.interviewId,
      guideId: interview.guideId,
      createdAt: interview.createdAt,
      revision: 2,
      startedAt: UPDATED_AT,
      endingAt: UPDATED_AT,
      endingFrom: 'active',
    },
    version: 2,
    updatedAt: UPDATED_AT,
  };
  const completed: PersistedInterview = {
    ...ending,
    lifecycle: {
      status: 'completed',
      interviewId: interview.interviewId,
      guideId: interview.guideId,
      createdAt: interview.createdAt,
      revision: 3,
      startedAt: UPDATED_AT,
      endingAt: UPDATED_AT,
      endedAt: UPDATED_AT,
    },
    version: 3,
    activeWorkflowRunId: null,
    updatedAt: UPDATED_AT,
  };
  const failed: PersistedInterview = {
    ...ending,
    lifecycle: {
      status: 'failed',
      interviewId: interview.interviewId,
      guideId: interview.guideId,
      createdAt: interview.createdAt,
      revision: 3,
      startedAt: UPDATED_AT,
      failedAt: UPDATED_AT,
      failedFrom: 'ending',
      failure: {
        code: 'provider_failure',
        message: 'The provider failed while the interview was ending.',
      },
    },
    version: 3,
    activeWorkflowRunId: null,
    updatedAt: UPDATED_AT,
  };
  return { active, ending, completed, failed };
}
