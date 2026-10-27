import { isDeepStrictEqual } from 'node:util';

import {
  DEFAULT_LOCALE,
  evaluationFingerprintSchema,
  idSchema,
  modelMetadataSchema,
  profileEvaluationFailureSchema,
  profileEvaluationReportSchema,
  timestampSchema,
  supportedLocaleSchema,
  type ProfileEvaluationReport,
  type SupportedLocale,
} from '@orgscience/contracts';
import { z } from 'zod';

import {
  failure,
  success,
  type EvaluationRepository as EvaluationRepositoryPort,
  type EvaluationRunCompletion,
  type EvaluationRunFailure,
  type EvaluationRunRestart,
  type EvaluationRunStart,
  type IdempotentTransition,
  type IdempotentWrite,
  type RepositoryResult,
  type StoredCompletedEvaluationRun,
  type StoredEvaluationRun,
  type StoredFailedEvaluationRun,
  type StoredRunningEvaluationRun,
} from '../../../application/persistence/index.js';
import { corruptData, mapDatabaseError } from './repository-errors.js';
import { readPersistedProfileEvaluationReport } from './persisted-profile-evaluation-report.js';
import type { SqlExecutor } from './sql.js';

type StoredEvaluationRunBaseProjection = Omit<EvaluationRunStart, 'language'> & {
  readonly language: SupportedLocale;
};

const databaseTimestampSchema = z
  .union([z.string(), z.date()])
  .transform((value) => (typeof value === 'string' ? value : value.toISOString()))
  .pipe(timestampSchema);

const evaluationRunRowSchema = z.strictObject({
  evaluation_id: idSchema,
  interview_id: idSchema,
  profile_id: idSchema,
  profile_fingerprint: evaluationFingerprintSchema,
  transcript_fingerprint: evaluationFingerprintSchema,
  language: supportedLocaleSchema.default(DEFAULT_LOCALE),
  status: z.enum(['running', 'completed', 'failed']),
  prompt_version: idSchema,
  model: modelMetadataSchema,
  report: z.unknown().nullable(),
  failure: z.unknown().nullable(),
  started_at: databaseTimestampSchema,
  ended_at: databaseTimestampSchema.nullable(),
  duration_ms: z.number().int().nonnegative().nullable(),
});

const identityRowSchema = z.strictObject({ evaluation_id: idSchema });

const RUN_PROJECTION = `
  evaluation_id, interview_id, profile_id, profile_fingerprint,
  transcript_fingerprint, language, status, prompt_version, model, report, failure,
  started_at, ended_at, duration_ms
`;

const LOAD_RUN_SQL = `
  select ${RUN_PROJECTION}
    from app.evaluation_runs
   where interview_id = $1 and evaluation_id = $2
`;

const FIND_RUN_BY_PROFILE_SQL = `
  select ${RUN_PROJECTION}
    from app.evaluation_runs
   where interview_id = $1 and profile_id = $2
`;

export class PostgresEvaluationRepository implements EvaluationRepositoryPort {
  public constructor(private readonly executor: SqlExecutor) {}

  public async loadRun(
    interviewId: string,
    evaluationId: string,
  ): Promise<RepositoryResult<StoredEvaluationRun>> {
    const identityIssue = validateRunIdentity(interviewId, evaluationId);
    if (identityIssue !== null) return failure(identityIssue);

    try {
      const result = await this.executor.query(LOAD_RUN_SQL, [interviewId, evaluationId]);
      if (result.rowCount === 0) {
        return failure({ code: 'not_found', resource: 'evaluation_run', id: evaluationId });
      }
      return parseRunRows(result.rows, result.rowCount, interviewId, evaluationId);
    } catch (error: unknown) {
      return failure(
        mapDatabaseError(error, { resource: 'evaluation_run', identity: evaluationId }),
      );
    }
  }

  public async findRunByProfile(input: {
    readonly interviewId: string;
    readonly profileId: string;
  }): Promise<RepositoryResult<StoredEvaluationRun | null>> {
    if (
      !idSchema.safeParse(input.interviewId).success ||
      !idSchema.safeParse(input.profileId).success
    ) {
      return failure({ code: 'constraint_violation', constraint: 'evaluation_profile_identity' });
    }

    try {
      const result = await this.executor.query(FIND_RUN_BY_PROFILE_SQL, [
        input.interviewId,
        input.profileId,
      ]);
      if (result.rowCount === 0) return success(null);
      const parsed = parseRunRows(result.rows, result.rowCount, input.interviewId);
      if (!parsed.ok) return parsed;
      return parsed.value.profileId === input.profileId
        ? parsed
        : failure(
            corruptData(
              'evaluation_run',
              parsed.value.evaluationId,
              'Evaluation profile scope mismatch',
            ),
          );
    } catch (error: unknown) {
      return failure(
        mapDatabaseError(error, {
          resource: 'evaluation_run',
          identity: profileRunIdentity(input.interviewId, input.profileId),
        }),
      );
    }
  }

  public async startRun(
    interviewId: string,
    run: EvaluationRunStart,
  ): Promise<RepositoryResult<IdempotentWrite<StoredEvaluationRun>>> {
    const validated = validateRunStart(interviewId, run);
    if (!validated.ok) return validated;
    const stored: StoredRunningEvaluationRun = {
      ...validated.value,
      status: 'running',
      endedAt: null,
      durationMs: null,
      report: null,
      failure: null,
    };

    try {
      const result = await this.executor.query(
        `insert into app.evaluation_runs (
           evaluation_id, interview_id, profile_id, profile_fingerprint,
           transcript_fingerprint, language, status, prompt_version, model, report, failure,
           started_at, ended_at, duration_ms
         ) values ($1, $2, $3, $4, $5, $6, 'running', $7, $8::jsonb, null, null, $9, null, null)
         on conflict (interview_id, profile_id) do nothing
         returning evaluation_id`,
        [
          stored.evaluationId,
          stored.interviewId,
          stored.profileId,
          stored.profileFingerprint,
          stored.transcriptFingerprint,
          stored.language,
          stored.promptVersion,
          JSON.stringify(stored.model),
          stored.startedAt,
        ],
      );
      const identity = parseIdentityRows(
        result.rows,
        result.rowCount,
        stored.evaluationId,
        'insert',
      );
      if (!identity.ok) return identity;
      if (result.rowCount === 1) {
        return success({ outcome: 'inserted', value: stored });
      }

      const existing = await this.findRunByProfile(stored);
      if (!existing.ok) return existing;
      if (existing.value === null || !sameRunStart(existing.value, stored)) {
        return failure({
          code: 'duplicate_conflict',
          resource: 'evaluation_run',
          identity: profileRunIdentity(stored.interviewId, stored.profileId),
        });
      }
      return success({ outcome: 'existing', value: existing.value });
    } catch (error: unknown) {
      return failure(
        mapDatabaseError(error, { resource: 'evaluation_run', identity: run.evaluationId }),
      );
    }
  }

  public async completeRun(
    interviewId: string,
    evaluationId: string,
    completion: EvaluationRunCompletion,
  ): Promise<RepositoryResult<IdempotentTransition<StoredCompletedEvaluationRun>>> {
    const identityIssue = validateRunIdentity(interviewId, evaluationId);
    if (identityIssue !== null) return failure(identityIssue);
    const validated = validateCompletion(interviewId, evaluationId, completion);
    if (!validated.ok) return validated;
    return this.transitionRun(interviewId, evaluationId, 'completed', validated.value);
  }

  public async failRun(
    interviewId: string,
    evaluationId: string,
    failed: EvaluationRunFailure,
  ): Promise<RepositoryResult<IdempotentTransition<StoredFailedEvaluationRun>>> {
    const identityIssue = validateRunIdentity(interviewId, evaluationId);
    if (identityIssue !== null) return failure(identityIssue);
    const validated = validateFailure(failed);
    if (!validated.ok) return validated;
    return this.transitionRun(interviewId, evaluationId, 'failed', validated.value);
  }

  public async restartRun(
    interviewId: string,
    evaluationId: string,
    restart: EvaluationRunRestart,
  ): Promise<RepositoryResult<IdempotentTransition<StoredEvaluationRun>>> {
    const identityIssue = validateRunIdentity(interviewId, evaluationId);
    if (identityIssue !== null) return failure(identityIssue);
    const validated = validateRestart(restart);
    if (!validated.ok) return validated;

    try {
      const result = await this.executor.query(
        `update app.evaluation_runs
            set status = 'running', profile_fingerprint = $6,
                transcript_fingerprint = $7, started_at = $4,
                language = $8, prompt_version = $9, model = $10::jsonb,
                ended_at = null, duration_ms = null, report = null, failure = null
          where interview_id = $1 and evaluation_id = $2 and started_at = $3
            and (status in ('completed', 'failed') or (status = 'running' and started_at <= $5))
          returning evaluation_id`,
        [
          interviewId,
          evaluationId,
          restart.expectedStartedAt,
          restart.startedAt,
          restart.staleBefore,
          restart.profileFingerprint,
          restart.transcriptFingerprint,
          restart.language ?? DEFAULT_LOCALE,
          restart.promptVersion,
          JSON.stringify(restart.model),
        ],
      );
      const identity = parseIdentityRows(result.rows, result.rowCount, evaluationId, 'restart');
      if (!identity.ok) return identity;

      const loaded = await this.loadRun(interviewId, evaluationId);
      if (!loaded.ok) return loaded;
      if (result.rowCount === 1) {
        return sameRestartTarget(loaded.value, restart)
          ? success({ outcome: 'updated', value: loaded.value })
          : failure(corruptData('evaluation_run', evaluationId, 'Restart state mismatch'));
      }
      if (sameRestartTarget(loaded.value, restart)) {
        return success({ outcome: 'existing', value: loaded.value });
      }
      return failure({
        code: 'duplicate_conflict',
        resource: 'evaluation_run',
        identity: evaluationId,
      });
    } catch (error: unknown) {
      return failure(
        mapDatabaseError(error, { resource: 'evaluation_run', identity: evaluationId }),
      );
    }
  }

  private async transitionRun<T extends StoredCompletedEvaluationRun | StoredFailedEvaluationRun>(
    interviewId: string,
    evaluationId: string,
    status: T['status'],
    terminal: EvaluationRunCompletion | EvaluationRunFailure,
  ): Promise<RepositoryResult<IdempotentTransition<T>>> {
    const endedAt = 'completedAt' in terminal ? terminal.completedAt : terminal.failedAt;
    const report = 'report' in terminal ? terminal.report : null;
    const failureValue = 'failure' in terminal ? terminal.failure : null;

    try {
      const result = await this.executor.query(
        `update app.evaluation_runs
            set status = $3, ended_at = $4, duration_ms = $5,
                report = $6::jsonb, failure = $7::jsonb
          where interview_id = $1 and evaluation_id = $2 and status = 'running'
            and started_at = $8
          returning evaluation_id`,
        [
          interviewId,
          evaluationId,
          status,
          endedAt,
          terminal.durationMs,
          report === null ? null : JSON.stringify(report),
          failureValue === null ? null : JSON.stringify(failureValue),
          terminal.attemptStartedAt,
        ],
      );
      const identity = parseIdentityRows(result.rows, result.rowCount, evaluationId, 'transition');
      if (!identity.ok) return identity;

      const loaded = await this.loadRun(interviewId, evaluationId);
      if (!loaded.ok) return loaded;
      if (result.rowCount === 1) {
        return loaded.value.status === status &&
          loaded.value.startedAt === terminal.attemptStartedAt
          ? success({ outcome: 'updated', value: loaded.value as T })
          : failure(corruptData('evaluation_run', evaluationId, 'Transition state mismatch'));
      }
      if (sameTerminal(loaded.value, status, terminal)) {
        return success({ outcome: 'existing', value: loaded.value as T });
      }
      return failure({
        code: 'duplicate_conflict',
        resource: 'evaluation_run',
        identity: evaluationId,
      });
    } catch (error: unknown) {
      return failure(
        mapDatabaseError(error, { resource: 'evaluation_run', identity: evaluationId }),
      );
    }
  }
}

function parseIdentityRows(
  rows: readonly unknown[],
  rowCount: number,
  evaluationId: string,
  operation: string,
): RepositoryResult<true> {
  const parsed = z.array(identityRowSchema).safeParse(rows);
  if (!parsed.success || parsed.data.length !== rowCount || rowCount > 1) {
    return failure(corruptData('evaluation_run', evaluationId, `Invalid ${operation} result`));
  }
  if (rowCount === 1 && parsed.data[0]?.evaluation_id !== evaluationId) {
    return failure(corruptData('evaluation_run', evaluationId, `${operation} identity mismatch`));
  }
  return success(true);
}

function parseRunRows(
  rows: readonly unknown[],
  rowCount: number,
  interviewId: string,
  evaluationId?: string,
): RepositoryResult<StoredEvaluationRun> {
  const parsed = z.array(evaluationRunRowSchema).safeParse(rows);
  if (!parsed.success || rowCount !== 1 || parsed.data.length !== rowCount) {
    return failure(
      corruptData('evaluation_run', evaluationId ?? interviewId, 'Invalid evaluation run row'),
    );
  }
  const row = parsed.data[0]!;
  if (
    row.interview_id !== interviewId ||
    (evaluationId !== undefined && row.evaluation_id !== evaluationId)
  ) {
    return failure(
      corruptData('evaluation_run', evaluationId ?? interviewId, 'Evaluation run scope mismatch'),
    );
  }

  const base: StoredEvaluationRunBaseProjection = {
    evaluationId: row.evaluation_id,
    interviewId: row.interview_id,
    profileId: row.profile_id,
    profileFingerprint: row.profile_fingerprint,
    transcriptFingerprint: row.transcript_fingerprint,
    language: row.language,
    promptVersion: row.prompt_version,
    model: row.model,
    startedAt: row.started_at,
  };

  if (
    row.status === 'running' &&
    row.ended_at === null &&
    row.duration_ms === null &&
    row.report === null &&
    row.failure === null
  ) {
    return success({
      ...base,
      status: 'running',
      endedAt: null,
      durationMs: null,
      report: null,
      failure: null,
    });
  }
  if (
    row.status === 'completed' &&
    row.ended_at !== null &&
    row.duration_ms !== null &&
    row.failure === null &&
    validTerminalTiming(row.started_at, row.ended_at, row.duration_ms)
  ) {
    const report = readPersistedProfileEvaluationReport(row.report);
    if (report.success && validCompletedReportScope(base, row.ended_at, report.data)) {
      return success({
        ...base,
        status: 'completed',
        endedAt: row.ended_at,
        durationMs: row.duration_ms,
        report: report.data,
        failure: null,
      });
    }
  }
  if (
    row.status === 'failed' &&
    row.ended_at !== null &&
    row.duration_ms !== null &&
    row.report === null &&
    validTerminalTiming(row.started_at, row.ended_at, row.duration_ms)
  ) {
    const parsedFailure = profileEvaluationFailureSchema.safeParse(row.failure);
    if (parsedFailure.success) {
      return success({
        ...base,
        status: 'failed',
        endedAt: row.ended_at,
        durationMs: row.duration_ms,
        report: null,
        failure: parsedFailure.data,
      });
    }
  }
  return failure(
    corruptData('evaluation_run', row.evaluation_id, 'Evaluation terminal state is inconsistent'),
  );
}

function validateRunStart(
  interviewId: string,
  run: EvaluationRunStart,
): RepositoryResult<StoredEvaluationRunBaseProjection> {
  if (
    run.interviewId !== interviewId ||
    !idSchema.safeParse(run.evaluationId).success ||
    !idSchema.safeParse(run.interviewId).success ||
    !idSchema.safeParse(run.profileId).success ||
    !evaluationFingerprintSchema.safeParse(run.profileFingerprint).success ||
    !evaluationFingerprintSchema.safeParse(run.transcriptFingerprint).success ||
    !supportedLocaleSchema.safeParse(run.language).success ||
    !idSchema.safeParse(run.promptVersion).success ||
    !modelMetadataSchema.safeParse(run.model).success ||
    !timestampSchema.safeParse(run.startedAt).success
  ) {
    return failure({ code: 'constraint_violation', constraint: 'evaluation_run_start_input' });
  }
  return success(run);
}

function validateCompletion(
  interviewId: string,
  evaluationId: string,
  completion: EvaluationRunCompletion,
): RepositoryResult<EvaluationRunCompletion> {
  const report = profileEvaluationReportSchema.safeParse(completion.report);
  if (
    !timestampSchema.safeParse(completion.attemptStartedAt).success ||
    !timestampSchema.safeParse(completion.completedAt).success ||
    !Number.isInteger(completion.durationMs) ||
    completion.durationMs < 0 ||
    !validTerminalTiming(
      completion.attemptStartedAt,
      completion.completedAt,
      completion.durationMs,
    ) ||
    !report.success ||
    report.data.evaluationId !== evaluationId ||
    report.data.interviewId !== interviewId ||
    report.data.evaluatedAt !== completion.completedAt
  ) {
    return failure({ code: 'constraint_violation', constraint: 'evaluation_completion_input' });
  }
  return success({ ...completion, report: report.data });
}

function validateFailure(failed: EvaluationRunFailure): RepositoryResult<EvaluationRunFailure> {
  const failureValue = profileEvaluationFailureSchema.safeParse(failed.failure);
  if (
    !timestampSchema.safeParse(failed.attemptStartedAt).success ||
    !timestampSchema.safeParse(failed.failedAt).success ||
    !Number.isInteger(failed.durationMs) ||
    failed.durationMs < 0 ||
    !validTerminalTiming(failed.attemptStartedAt, failed.failedAt, failed.durationMs) ||
    !failureValue.success
  ) {
    return failure({ code: 'constraint_violation', constraint: 'evaluation_failure_input' });
  }
  return success({ ...failed, failure: failureValue.data });
}

function validateRestart(restart: EvaluationRunRestart): RepositoryResult<EvaluationRunRestart> {
  if (
    !timestampSchema.safeParse(restart.expectedStartedAt).success ||
    !timestampSchema.safeParse(restart.startedAt).success ||
    !timestampSchema.safeParse(restart.staleBefore).success ||
    Date.parse(restart.startedAt) <= Date.parse(restart.expectedStartedAt) ||
    Date.parse(restart.staleBefore) > Date.parse(restart.startedAt) ||
    !evaluationFingerprintSchema.safeParse(restart.profileFingerprint).success ||
    !evaluationFingerprintSchema.safeParse(restart.transcriptFingerprint).success ||
    !supportedLocaleSchema.safeParse(restart.language).success ||
    !idSchema.safeParse(restart.promptVersion).success ||
    !modelMetadataSchema.safeParse(restart.model).success
  ) {
    return failure({ code: 'constraint_violation', constraint: 'evaluation_restart_input' });
  }
  return success(restart);
}

function validCompletedReportScope(
  run: StoredEvaluationRunBaseProjection,
  completedAt: string,
  report: ProfileEvaluationReport,
): boolean {
  return (
    report.evaluationId === run.evaluationId &&
    report.interviewId === run.interviewId &&
    report.profileId === run.profileId &&
    report.profileFingerprint === run.profileFingerprint &&
    report.transcriptFingerprint === run.transcriptFingerprint &&
    report.language === run.language &&
    report.promptVersion === run.promptVersion &&
    isDeepStrictEqual(report.model, run.model) &&
    Date.parse(report.evaluatedAt) === Date.parse(completedAt)
  );
}

function validTerminalTiming(startedAt: string, endedAt: string, durationMs: number): boolean {
  return Date.parse(endedAt) - Date.parse(startedAt) === durationMs;
}

function validateRunIdentity(
  interviewId: string,
  evaluationId: string,
): { readonly code: 'constraint_violation'; readonly constraint: string } | null {
  return idSchema.safeParse(interviewId).success && idSchema.safeParse(evaluationId).success
    ? null
    : { code: 'constraint_violation', constraint: 'evaluation_run_identity' };
}

function sameRunStart(left: StoredEvaluationRun, right: StoredRunningEvaluationRun): boolean {
  return (
    left.evaluationId === right.evaluationId &&
    left.interviewId === right.interviewId &&
    left.profileId === right.profileId &&
    left.profileFingerprint === right.profileFingerprint &&
    left.transcriptFingerprint === right.transcriptFingerprint &&
    left.language === right.language &&
    left.promptVersion === right.promptVersion &&
    isDeepStrictEqual(left.model, right.model)
  );
}

function sameRestartTarget(run: StoredEvaluationRun, restart: EvaluationRunRestart): boolean {
  return (
    run.status === 'running' &&
    run.startedAt === restart.startedAt &&
    run.profileFingerprint === restart.profileFingerprint &&
    run.transcriptFingerprint === restart.transcriptFingerprint &&
    run.language === restart.language &&
    run.promptVersion === restart.promptVersion &&
    isDeepStrictEqual(run.model, restart.model)
  );
}

function sameTerminal(
  run: StoredEvaluationRun,
  status: 'completed' | 'failed',
  terminal: EvaluationRunCompletion | EvaluationRunFailure,
): boolean {
  if (status === 'completed' && run.status === 'completed' && 'report' in terminal) {
    return (
      run.startedAt === terminal.attemptStartedAt &&
      Date.parse(run.endedAt) === Date.parse(terminal.completedAt) &&
      run.durationMs === terminal.durationMs &&
      isDeepStrictEqual(run.report, terminal.report)
    );
  }
  if (status === 'failed' && run.status === 'failed' && 'failure' in terminal) {
    return (
      run.startedAt === terminal.attemptStartedAt &&
      Date.parse(run.endedAt) === Date.parse(terminal.failedAt) &&
      run.durationMs === terminal.durationMs &&
      isDeepStrictEqual(run.failure, terminal.failure)
    );
  }
  return false;
}

function profileRunIdentity(interviewId: string, profileId: string): string {
  return `${interviewId}:${profileId}`;
}
