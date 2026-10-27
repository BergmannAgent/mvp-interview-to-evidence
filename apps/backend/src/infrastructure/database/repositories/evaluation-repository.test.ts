import { calculateProfileScores, profileEvaluationReportSchema } from '@orgscience/contracts';
import { describe, expect, it } from 'vitest';

import type {
  EvaluationRunStart,
  StoredCompletedEvaluationRun,
  StoredFailedEvaluationRun,
  StoredRunningEvaluationRun,
} from '../../../application/persistence/index.js';
import { PostgresPersistenceContextFactory } from '../persistence-context.js';
import { PostgresEvaluationRepository } from './evaluation-repository.js';
import type { SqlExecutor, SqlQueryResult } from './sql.js';

const STARTED_AT = '2026-08-14T08:00:00.000Z';
const ENDED_AT = '2026-08-14T08:00:01.000Z';
const STALE_BEFORE = '2026-08-14T08:05:00.000Z';
const RESTARTED_AT = '2026-08-14T08:10:00.000Z';
const PROFILE_FINGERPRINT = 'a'.repeat(64);
const TRANSCRIPT_FINGERPRINT = 'b'.repeat(64);
const NEXT_PROFILE_FINGERPRINT = 'c'.repeat(64);
const NEXT_TRANSCRIPT_FINGERPRINT = 'd'.repeat(64);
const MODEL = { mode: 'demo', provider: null, model: null } as const;
const NEXT_MODEL = {
  mode: 'provider',
  provider: 'openai',
  model: 'openai/gpt-5-mini',
} as const;

const RUN_START: EvaluationRunStart = {
  evaluationId: 'evaluation-profile-1',
  interviewId: 'interview-1',
  profileId: 'profile-1',
  profileFingerprint: PROFILE_FINGERPRINT,
  transcriptFingerprint: TRANSCRIPT_FINGERPRINT,
  language: 'de',
  promptVersion: 'profile-coding-v1',
  model: MODEL,
  startedAt: STARTED_AT,
};

const RUNNING: StoredRunningEvaluationRun = {
  ...RUN_START,
  status: 'running',
  endedAt: null,
  durationMs: null,
  report: null,
  failure: null,
};

const PROFILE = {
  profileId: RUN_START.profileId,
  name: 'Generic evidence profile',
  description: 'One arbitrary profile dimension.',
  coderPrompt: 'Code only directly observed evidence.',
  scale: { minimum: 1, maximum: 7 },
  dimensions: [{ dimensionId: 'dimension-1', name: 'Dimension 1', order: 0 }],
  items: [
    {
      itemId: 'item-1',
      dimensionId: 'dimension-1',
      name: 'Item 1',
      codingInstruction: 'Rate the observed behavior.',
      order: 0,
      anchors: ([1, 2, 3, 4, 5, 6, 7] as const).map((score) => ({
        score,
        criterion: `Criterion ${String(score)}`,
      })),
    },
  ],
};

const REPORT = profileEvaluationReportSchema.parse({
  schemaVersion: 5,
  calculation: calculateProfileScores(PROFILE, { 'item-1': 4 }).calculation,
  reportKind: 'evaluation_profile_report',
  evaluationId: RUN_START.evaluationId,
  interviewId: RUN_START.interviewId,
  profileId: RUN_START.profileId,
  profileName: PROFILE.name,
  profileUpdatedAt: STARTED_AT,
  profileFingerprint: PROFILE_FINGERPRINT,
  transcriptFingerprint: TRANSCRIPT_FINGERPRINT,
  promptVersion: RUN_START.promptVersion,
  model: MODEL,
  profile: PROFILE,
  dimensions: [
    {
      dimensionId: 'dimension-1',
      name: 'Dimension 1',
      order: 0,
      aggregate: {
        status: 'complete',
        score: 4,
        scoredItemCount: 1,
        unscoredItemCount: 0,
        totalItemCount: 1,
      },
      items: [
        {
          ...PROFILE.items[0],
          status: 'scored',
          score: 4,
          appliedAnchor: PROFILE.items[0]!.anchors[3],
          confidence: 0.9,
          supportingEvidence: [
            {
              turnId: 'turn-2',
              sequenceNumber: 2,
              verbatimExcerpt: 'We review every incident.',
            },
          ],
          counterEvidence: [],
          missingInformation: [],
          rationale: 'The participant describes a recurring review.',
        },
      ],
    },
  ],
  overallAggregate: {
    status: 'complete',
    score: 4,
    scoredItemCount: 1,
    unscoredItemCount: 0,
    totalItemCount: 1,
  },
  rationale: 'The numeric result is supported by a final participant turn.',
  evaluatedAt: ENDED_AT,
});

const COMPLETED: StoredCompletedEvaluationRun = {
  ...RUN_START,
  status: 'completed',
  endedAt: ENDED_AT,
  durationMs: 1_000,
  report: REPORT,
  failure: null,
};

const FAILED: StoredFailedEvaluationRun = {
  ...RUN_START,
  status: 'failed',
  endedAt: ENDED_AT,
  durationMs: 1_000,
  report: null,
  failure: { code: 'provider_timeout', message: 'Provider timed out.', retryable: true },
};

const RESTART = {
  expectedStartedAt: STARTED_AT,
  startedAt: RESTARTED_AT,
  staleBefore: STALE_BEFORE,
  profileFingerprint: NEXT_PROFILE_FINGERPRINT,
  transcriptFingerprint: NEXT_TRANSCRIPT_FINGERPRINT,
  language: 'de',
  promptVersion: 'profile-coding-v2',
  model: NEXT_MODEL,
} as const;

const RESTARTED: StoredRunningEvaluationRun = {
  ...RUN_START,
  profileFingerprint: NEXT_PROFILE_FINGERPRINT,
  transcriptFingerprint: NEXT_TRANSCRIPT_FINGERPRINT,
  promptVersion: RESTART.promptVersion,
  model: NEXT_MODEL,
  startedAt: RESTARTED_AT,
  status: 'running',
  endedAt: null,
  durationMs: null,
  report: null,
  failure: null,
};

class ScriptedExecutor implements SqlExecutor {
  public readonly calls: Array<{
    readonly statement: string;
    readonly parameters: readonly unknown[];
  }> = [];

  public constructor(private readonly results: SqlQueryResult[]) {}

  public async query(
    statement: string,
    parameters: readonly unknown[] = [],
  ): Promise<SqlQueryResult> {
    this.calls.push({ statement, parameters });
    const result = this.results.shift();
    if (result === undefined) throw new Error('Unexpected SQL query');
    return result;
  }
}

describe('PostgresEvaluationRepository profile-scoped runs', () => {
  it('starts exactly one running row per interview/profile pair', async () => {
    const executor = new ScriptedExecutor([
      { rows: [{ evaluation_id: RUN_START.evaluationId }], rowCount: 1 },
    ]);

    await expect(
      new PostgresEvaluationRepository(executor).startRun(RUN_START.interviewId, RUN_START),
    ).resolves.toEqual({ ok: true, value: { outcome: 'inserted', value: RUNNING } });

    expect(executor.calls[0]?.statement).toContain(
      'on conflict (interview_id, profile_id) do nothing',
    );
    expect(executor.calls[0]?.statement).not.toContain('guide_id');
    expect(executor.calls[0]?.statement).not.toContain('rubric_id');
    expect(executor.calls[0]?.parameters).toEqual([
      RUN_START.evaluationId,
      RUN_START.interviewId,
      RUN_START.profileId,
      PROFILE_FINGERPRINT,
      TRANSCRIPT_FINGERPRINT,
      'de',
      RUN_START.promptVersion,
      JSON.stringify(MODEL),
      STARTED_AT,
    ]);
  });

  it('returns the existing row for an exact idempotent start retry', async () => {
    const executor = new ScriptedExecutor([
      { rows: [], rowCount: 0 },
      { rows: [runRow(RUNNING)], rowCount: 1 },
    ]);

    await expect(
      new PostgresEvaluationRepository(executor).startRun(RUN_START.interviewId, RUN_START),
    ).resolves.toEqual({ ok: true, value: { outcome: 'existing', value: RUNNING } });
  });

  it('converges concurrent starts even when process clocks differ', async () => {
    const executor = new ScriptedExecutor([
      { rows: [], rowCount: 0 },
      { rows: [runRow(RUNNING)], rowCount: 1 },
    ]);

    await expect(
      new PostgresEvaluationRepository(executor).startRun(RUN_START.interviewId, {
        ...RUN_START,
        startedAt: '2026-08-14T08:00:00.250Z',
      }),
    ).resolves.toEqual({ ok: true, value: { outcome: 'existing', value: RUNNING } });
  });

  it('rejects an implicit overwrite when a profile-scoped row already exists', async () => {
    const executor = new ScriptedExecutor([
      { rows: [], rowCount: 0 },
      { rows: [runRow(RUNNING)], rowCount: 1 },
    ]);
    const changed = {
      ...RUN_START,
      evaluationId: 'different-evaluation-id',
      profileFingerprint: NEXT_PROFILE_FINGERPRINT,
    };

    await expect(
      new PostgresEvaluationRepository(executor).startRun(RUN_START.interviewId, changed),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'duplicate_conflict',
        resource: 'evaluation_run',
        identity: `${RUN_START.interviewId}:${RUN_START.profileId}`,
      },
    });
  });

  it('finds a run by interview and profile without transcript or guide coupling', async () => {
    const executor = new ScriptedExecutor([{ rows: [runRow(RUNNING)], rowCount: 1 }]);

    await expect(
      new PostgresEvaluationRepository(executor).findRunByProfile({
        interviewId: RUN_START.interviewId,
        profileId: RUN_START.profileId,
      }),
    ).resolves.toEqual({ ok: true, value: RUNNING });
    expect(executor.calls[0]?.parameters).toEqual([RUN_START.interviewId, RUN_START.profileId]);
    expect(executor.calls[0]?.statement).not.toContain('guide_id');
  });

  it('returns null when the interview/profile pair has no result', async () => {
    const executor = new ScriptedExecutor([{ rows: [], rowCount: 0 }]);

    await expect(
      new PostgresEvaluationRepository(executor).findRunByProfile({
        interviewId: RUN_START.interviewId,
        profileId: RUN_START.profileId,
      }),
    ).resolves.toEqual({ ok: true, value: null });
  });

  it('persists and idempotently reloads a structured failure for one attempt', async () => {
    const failure = {
      attemptStartedAt: STARTED_AT,
      failedAt: ENDED_AT,
      durationMs: 1_000,
      failure: FAILED.failure,
    };
    const updated = new ScriptedExecutor([
      { rows: [{ evaluation_id: RUN_START.evaluationId }], rowCount: 1 },
      { rows: [runRow(FAILED)], rowCount: 1 },
    ]);
    await expect(
      new PostgresEvaluationRepository(updated).failRun(
        RUN_START.interviewId,
        RUN_START.evaluationId,
        failure,
      ),
    ).resolves.toEqual({ ok: true, value: { outcome: 'updated', value: FAILED } });

    const repeated = new ScriptedExecutor([
      { rows: [], rowCount: 0 },
      { rows: [runRow(FAILED)], rowCount: 1 },
    ]);
    await expect(
      new PostgresEvaluationRepository(repeated).failRun(
        RUN_START.interviewId,
        RUN_START.evaluationId,
        failure,
      ),
    ).resolves.toEqual({ ok: true, value: { outcome: 'existing', value: FAILED } });
  });

  it('persists and idempotently reloads one generic profile report', async () => {
    const completion = {
      attemptStartedAt: STARTED_AT,
      completedAt: ENDED_AT,
      durationMs: 1_000,
      report: REPORT,
    };
    const updated = new ScriptedExecutor([
      { rows: [{ evaluation_id: RUN_START.evaluationId }], rowCount: 1 },
      { rows: [runRow(COMPLETED)], rowCount: 1 },
    ]);
    await expect(
      new PostgresEvaluationRepository(updated).completeRun(
        RUN_START.interviewId,
        RUN_START.evaluationId,
        completion,
      ),
    ).resolves.toEqual({ ok: true, value: { outcome: 'updated', value: COMPLETED } });
    expect(JSON.parse(updated.calls[0]?.parameters[5] as string)).toEqual(REPORT);

    const repeated = new ScriptedExecutor([
      { rows: [], rowCount: 0 },
      { rows: [runRow(COMPLETED)], rowCount: 1 },
    ]);
    await expect(
      new PostgresEvaluationRepository(repeated).completeRun(
        RUN_START.interviewId,
        RUN_START.evaluationId,
        completion,
      ),
    ).resolves.toEqual({ ok: true, value: { outcome: 'existing', value: COMPLETED } });
  });

  it('rejects a completed report with a mismatched interview scope before SQL', async () => {
    const executor = new ScriptedExecutor([]);

    await expect(
      new PostgresEvaluationRepository(executor).completeRun(
        RUN_START.interviewId,
        RUN_START.evaluationId,
        {
          attemptStartedAt: STARTED_AT,
          completedAt: ENDED_AT,
          durationMs: 1_000,
          report: { ...REPORT, interviewId: 'another-interview' },
        },
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: 'constraint_violation', constraint: 'evaluation_completion_input' },
    });
    expect(executor.calls).toHaveLength(0);
  });

  it('roundtrips a score seven with one indirect evidence entry and its additional quotation', async () => {
    const report = structuredClone(REPORT);
    report.participantDetails = {
      age: null,
      position: {
        value: 'shift lead',
        source: {
          turnId: 'turn-2',
          sequenceNumber: 2,
          verbatimExcerpt: 'The shift lead changed the schedule.',
        },
      },
    };
    const item = report.dimensions[0]!.items[0]!;
    item.score = 7;
    item.appliedAnchor = item.anchors[6];
    item.supportingEvidence = [
      {
        turnId: 'turn-2',
        sequenceNumber: 2,
        verbatimExcerpt: 'The shift lead changed the schedule.',
        evidenceType: 'indirect',
        inference: 'The local decision without management approval indicates delegated authority.',
        additionalSources: [
          {
            turnId: 'turn-2',
            sequenceNumber: 2,
            verbatimExcerpt: 'No management approval was required.',
          },
        ],
      },
    ];
    report.dimensions[0]!.aggregate.score = 7;
    report.overallAggregate.score = 7;
    report.calculation = calculateProfileScores(report.profile, { 'item-1': 7 }).calculation;
    const completed: StoredCompletedEvaluationRun = { ...COMPLETED, report };
    const executor = new ScriptedExecutor([
      { rows: [{ evaluation_id: RUN_START.evaluationId }], rowCount: 1 },
      { rows: [runRow(completed)], rowCount: 1 },
      { rows: [runRow(completed)], rowCount: 1 },
    ]);
    const repository = new PostgresEvaluationRepository(executor);

    await expect(
      repository.completeRun(RUN_START.interviewId, RUN_START.evaluationId, {
        attemptStartedAt: STARTED_AT,
        completedAt: ENDED_AT,
        durationMs: 1_000,
        report,
      }),
    ).resolves.toEqual({ ok: true, value: { outcome: 'updated', value: completed } });
    expect(JSON.parse(executor.calls[0]?.parameters[5] as string)).toEqual(report);
    await expect(
      repository.loadRun(RUN_START.interviewId, RUN_START.evaluationId),
    ).resolves.toEqual({ ok: true, value: completed });
  });

  it('reports a persisted report/profile mismatch as corrupt data', async () => {
    const executor = new ScriptedExecutor([
      {
        rows: [
          {
            ...runRow(COMPLETED),
            profile_fingerprint: NEXT_PROFILE_FINGERPRINT,
          },
        ],
        rowCount: 1,
      },
    ]);

    await expect(
      new PostgresEvaluationRepository(executor).loadRun(
        RUN_START.interviewId,
        RUN_START.evaluationId,
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'corrupt_data', resource: 'evaluation_run' },
    });
  });

  it.each([false, true])(
    'reads historical reports through both lookup paths without writes (archived sources: %s)',
    async (hasArchivedEvidence) => {
      const archivedEvidence = hasArchivedEvidence
        ? [{ turnId: 'turn-4', sequenceNumber: 4, verbatimExcerpt: 'It depends on the team.' }]
        : [];
      const historicalReport = {
        ...REPORT,
        schemaVersion: 3,
        calculation: undefined,
        dimensions: REPORT.dimensions.map((dimension) => ({
          ...dimension,
          items: dimension.items.map((item) => ({ ...item, ambiguousEvidence: archivedEvidence })),
        })),
      };
      const row = { ...runRow(COMPLETED), report: historicalReport };
      const original = structuredClone(row);
      const executor = new ScriptedExecutor([
        { rows: [row], rowCount: 1 },
        { rows: [row], rowCount: 1 },
      ]);
      const repository = new PostgresEvaluationRepository(executor);

      const loaded = await repository.loadRun(RUN_START.interviewId, RUN_START.evaluationId);
      expect(loaded).toMatchObject({
        ok: true,
        value: {
          ...COMPLETED,
          report: { ...REPORT, legacyEvidenceNotice: expect.stringContaining('Historische') },
        },
      });
      if (!loaded.ok || loaded.value.status !== 'completed') return;
      expect(loaded.value.report.dimensions).toEqual(REPORT.dimensions);
      expect(JSON.stringify(loaded.value.report)).not.toContain('ambiguousEvidence');
      if (hasArchivedEvidence) {
        expect(loaded.value.report.legacyEvidenceNotice).toContain('archivierten Original');
        expect(loaded.value.report.legacyEvidenceNotice).toContain('umklassifiziert');
      }
      await expect(
        repository.findRunByProfile({
          interviewId: RUN_START.interviewId,
          profileId: RUN_START.profileId,
        }),
      ).resolves.toEqual(loaded);
      expect(row).toEqual(original);
      expect(executor.calls).toHaveLength(2);
      expect(
        executor.calls.every(({ statement }) => statement.trimStart().startsWith('select')),
      ).toBe(true);
    },
  );

  it.each(['unknown field', 'invalid archived source'] as const)(
    'rejects a corrupt historical report with %s instead of discarding it',
    async (corruption) => {
      const report = {
        ...REPORT,
        schemaVersion: 3,
        calculation: undefined,
        ...(corruption === 'unknown field' ? { unexpected: true } : {}),
        dimensions: REPORT.dimensions.map((dimension) => ({
          ...dimension,
          items: dimension.items.map((item) => ({
            ...item,
            ambiguousEvidence:
              corruption === 'invalid archived source'
                ? [{ turnId: 'turn-4', sequenceNumber: 0, verbatimExcerpt: 'Invalid source.' }]
                : [],
          })),
        })),
      };
      const executor = new ScriptedExecutor([
        { rows: [{ ...runRow(COMPLETED), report }], rowCount: 1 },
      ]);

      await expect(
        new PostgresEvaluationRepository(executor).loadRun(
          RUN_START.interviewId,
          RUN_START.evaluationId,
        ),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'corrupt_data', resource: 'evaluation_run' },
      });
      expect(executor.calls).toHaveLength(1);
      expect(executor.calls[0]!.statement.trimStart()).toMatch(/^select/u);
    },
  );

  it('never accepts a historical schema version in a completion write', async () => {
    const executor = new ScriptedExecutor([]);
    const report = structuredClone(REPORT);
    Object.assign(report, { schemaVersion: 3 });

    await expect(
      new PostgresEvaluationRepository(executor).completeRun(
        RUN_START.interviewId,
        RUN_START.evaluationId,
        {
          attemptStartedAt: STARTED_AT,
          completedAt: ENDED_AT,
          durationMs: 1_000,
          report,
        },
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: 'constraint_violation', constraint: 'evaluation_completion_input' },
    });
    expect(executor.calls).toHaveLength(0);
  });

  it('restarts a terminal row with a true started-at CAS and new source configuration', async () => {
    const executor = new ScriptedExecutor([
      { rows: [{ evaluation_id: RUN_START.evaluationId }], rowCount: 1 },
      { rows: [runRow(RESTARTED)], rowCount: 1 },
    ]);

    await expect(
      new PostgresEvaluationRepository(executor).restartRun(
        RUN_START.interviewId,
        RUN_START.evaluationId,
        RESTART,
      ),
    ).resolves.toEqual({ ok: true, value: { outcome: 'updated', value: RESTARTED } });

    expect(executor.calls[0]?.statement).toContain('started_at = $3');
    expect(executor.calls[0]?.statement).toContain("status in ('completed', 'failed')");
    expect(executor.calls[0]?.statement).toContain("status = 'running' and started_at <= $5");
    expect(executor.calls[0]?.statement).toContain('profile_fingerprint = $6');
    expect(executor.calls[0]?.statement).toContain('transcript_fingerprint = $7');
    expect(executor.calls[0]?.parameters).toEqual([
      RUN_START.interviewId,
      RUN_START.evaluationId,
      STARTED_AT,
      RESTARTED_AT,
      STALE_BEFORE,
      NEXT_PROFILE_FINGERPRINT,
      NEXT_TRANSCRIPT_FINGERPRINT,
      'de',
      RESTART.promptVersion,
      JSON.stringify(NEXT_MODEL),
    ]);
  });

  it('treats the winning value as idempotent for two identical restart attempts', async () => {
    const executor = new ScriptedExecutor([
      { rows: [], rowCount: 0 },
      { rows: [runRow(RESTARTED)], rowCount: 1 },
    ]);

    await expect(
      new PostgresEvaluationRepository(executor).restartRun(
        RUN_START.interviewId,
        RUN_START.evaluationId,
        RESTART,
      ),
    ).resolves.toEqual({ ok: true, value: { outcome: 'existing', value: RESTARTED } });
  });

  it('does not reclaim a fresh running attempt', async () => {
    const executor = new ScriptedExecutor([
      { rows: [], rowCount: 0 },
      { rows: [runRow(RUNNING)], rowCount: 1 },
    ]);

    await expect(
      new PostgresEvaluationRepository(executor).restartRun(
        RUN_START.interviewId,
        RUN_START.evaluationId,
        RESTART,
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'duplicate_conflict', resource: 'evaluation_run' },
    });
  });

  it('fences a delayed failure from the previous attempt', async () => {
    const executor = new ScriptedExecutor([
      { rows: [], rowCount: 0 },
      { rows: [runRow(RESTARTED)], rowCount: 1 },
    ]);

    await expect(
      new PostgresEvaluationRepository(executor).failRun(
        RUN_START.interviewId,
        RUN_START.evaluationId,
        {
          attemptStartedAt: STARTED_AT,
          failedAt: ENDED_AT,
          durationMs: 1_000,
          failure: FAILED.failure,
        },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'duplicate_conflict', resource: 'evaluation_run' },
    });
    expect(executor.calls[0]?.statement).toContain('started_at = $8');
    expect(executor.calls[0]?.parameters[7]).toBe(STARTED_AT);
  });

  it('requires a newer attempt timestamp and valid fingerprints before restart SQL', async () => {
    const executor = new ScriptedExecutor([]);

    await expect(
      new PostgresEvaluationRepository(executor).restartRun(
        RUN_START.interviewId,
        RUN_START.evaluationId,
        {
          ...RESTART,
          startedAt: STARTED_AT,
          profileFingerprint: 'invalid',
        },
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: 'constraint_violation', constraint: 'evaluation_restart_input' },
    });
    expect(executor.calls).toHaveLength(0);
  });

  it('rejects malformed run input before issuing SQL', async () => {
    const executor = new ScriptedExecutor([]);

    await expect(
      new PostgresEvaluationRepository(executor).startRun(RUN_START.interviewId, {
        ...RUN_START,
        transcriptFingerprint: 'invalid',
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: 'constraint_violation', constraint: 'evaluation_run_start_input' },
    });
    expect(executor.calls).toHaveLength(0);
  });

  it('reports corrupt rows instead of widening malformed terminal state', async () => {
    const executor = new ScriptedExecutor([
      { rows: [{ ...runRow(FAILED), duration_ms: 999 }], rowCount: 1 },
    ]);

    await expect(
      new PostgresEvaluationRepository(executor).loadRun(
        RUN_START.interviewId,
        RUN_START.evaluationId,
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'corrupt_data', resource: 'evaluation_run' },
    });
  });
});

describe('evaluation persistence context wiring', () => {
  it('exposes the evaluation repository in read and transaction contexts', () => {
    const executor = new ScriptedExecutor([]);
    const contexts = new PostgresPersistenceContextFactory();

    expect(contexts.createReadContext(executor).evaluations).toBeInstanceOf(
      PostgresEvaluationRepository,
    );
    expect(contexts.createTransaction(executor).evaluations).toBeInstanceOf(
      PostgresEvaluationRepository,
    );
  });
});

function runRow(
  run: StoredRunningEvaluationRun | StoredCompletedEvaluationRun | StoredFailedEvaluationRun,
): Record<string, unknown> {
  return {
    evaluation_id: run.evaluationId,
    interview_id: run.interviewId,
    profile_id: run.profileId,
    profile_fingerprint: run.profileFingerprint,
    transcript_fingerprint: run.transcriptFingerprint,
    language: run.language,
    status: run.status,
    prompt_version: run.promptVersion,
    model: run.model,
    report: run.report,
    failure: run.failure,
    started_at: run.startedAt,
    ended_at: run.endedAt,
    duration_ms: run.durationMs,
  };
}
