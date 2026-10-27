import { z } from 'zod';
import { idSchema, interviewDisplayNameSchema } from '@orgscience/contracts';

import {
  failure,
  success,
  type IdempotentWrite,
  type InterviewSummaryPage,
  type InterviewRepository as InterviewRepositoryPort,
  type PersistedInterviewSummary,
  type PersistedInterview,
  type RepositoryResult,
} from '../../../application/persistence/index.js';
import { reconstructInterview } from './interview-repository-mapping.js';
import {
  counterRowSchema,
  coverageRowSchema,
  formatZodIssues,
  guideQuestionShapeRowSchema,
  identityRowSchema,
  interviewSummaryCursorSchema,
  interviewSummaryRowSchema,
  noRowsSchema,
  stateRowSchema,
  transitionGuardRowSchema,
  versionRowSchema,
} from './interview-repository-rows.js';
import {
  COMPARE_AND_SWAP_STATE_SQL,
  COVERAGE_SELECT,
  GUIDE_QUESTION_SHAPE_SELECT,
  insertCoverageReferences,
  insertCoverageRows,
  STATE_SELECT,
  TRANSITION_GUARD_SELECT,
  validateSingleIdentityResult,
} from './interview-repository-sql.js';
import {
  currentMainQuestionId,
  lifecycleColumns,
  serializeInterview,
  validateCoverageAgainstPersistedGuide,
  validateInterviewInput,
  validateInterviewTransition,
} from './interview-repository-values.js';
import { corruptData, mapDatabaseError } from './repository-errors.js';
import type { SqlExecutor } from './sql.js';

const SUMMARY_SELECT = `select st.interview_id as "interviewId", i.guide_id as "guideId",
                i.language, g.title as "guideTitle", i.display_name as "displayName",
                st.status, st.current_main_question_id as "currentMainQuestionId",
                st.active_workflow_run_id as "activeWorkflowRunId",
                st.created_at as "createdAt", st.updated_at as "updatedAt",
                st.started_at as "startedAt"
           from app.interview_state st
           join app.interviews i on i.id = st.interview_id and i.guide_id = st.guide_id
           join app.guides g on g.id = i.guide_id`;

export class PostgresInterviewRepository implements InterviewRepositoryPort {
  readonly #executor: SqlExecutor;

  public constructor(executor: SqlExecutor) {
    this.#executor = executor;
  }

  public load(interviewId: string): Promise<RepositoryResult<PersistedInterview>> {
    return this.#read(interviewId, false);
  }

  public async listSummaries(query: {
    readonly after: string | null;
    readonly limit: number;
  }): Promise<RepositoryResult<InterviewSummaryPage>> {
    if (!Number.isInteger(query.limit) || query.limit <= 0 || query.limit > 100) {
      return failure({ code: 'constraint_violation', constraint: 'interview_summary_limit' });
    }
    const cursor = decodeSummaryCursor(query.after);
    if (!cursor.ok) return cursor;
    try {
      const result = await this.#executor.query(
        `${SUMMARY_SELECT}
          where ($1::timestamptz is null or (st.created_at, st.interview_id) < ($1::timestamptz, $2))
          order by st.created_at desc, st.interview_id desc
          limit $3`,
        [cursor.value?.createdAt ?? null, cursor.value?.interviewId ?? null, query.limit + 1],
      );
      const parsed = z.array(interviewSummaryRowSchema).safeParse(result.rows);
      if (!parsed.success) {
        return failure(corruptData('interview', 'summary-page', formatZodIssues(parsed.error)));
      }
      const page = parsed.data.slice(0, query.limit) as readonly PersistedInterviewSummary[];
      const finalItem = page.at(-1);
      return success({
        interviews: page,
        nextCursor:
          parsed.data.length > query.limit && finalItem !== undefined
            ? encodeSummaryCursor(finalItem.createdAt, finalItem.interviewId)
            : null,
      });
    } catch (error: unknown) {
      return failure(mapDatabaseError(error, { resource: 'interview', identity: 'summary-page' }));
    }
  }

  public lock(interviewId: string): Promise<RepositoryResult<PersistedInterview>> {
    return this.#read(interviewId, true);
  }

  public async rename(
    interviewId: string,
    displayName: string | null,
  ): Promise<RepositoryResult<PersistedInterviewSummary>> {
    if (
      !idSchema.safeParse(interviewId).success ||
      !interviewDisplayNameSchema.nullable().safeParse(displayName).success
    ) {
      return failure({ code: 'constraint_violation', constraint: 'interview_display_name' });
    }
    try {
      const updated = await this.#executor.query(
        'update app.interviews set display_name = $2 where id = $1 returning id as interview_id',
        [interviewId, displayName === null ? null : displayName.trim()],
      );
      if (updated.rowCount === 0)
        return failure({ code: 'not_found', resource: 'interview', id: interviewId });
      const rows = await this.#executor.query(`${SUMMARY_SELECT} where st.interview_id = $1`, [
        interviewId,
      ]);
      const parsed = z.array(interviewSummaryRowSchema).safeParse(rows.rows);
      if (
        !parsed.success ||
        parsed.data.length !== 1 ||
        rows.rowCount !== 1 ||
        parsed.data[0]?.interviewId !== interviewId
      ) {
        return failure(corruptData('interview', interviewId, 'Renamed summary is invalid'));
      }
      return success({ ...parsed.data[0], displayName: parsed.data[0].displayName ?? null });
    } catch (error: unknown) {
      return failure(mapDatabaseError(error, { resource: 'interview', identity: interviewId }));
    }
  }

  public async delete(interviewId: string): Promise<RepositoryResult<void>> {
    const locked = await this.lock(interviewId);
    if (!locked.ok) return locked;
    if (locked.value.lifecycle.status === 'active' || locked.value.lifecycle.status === 'ending') {
      return failure({ code: 'interview_busy', interviewId, reason: 'active_interview' });
    }
    try {
      // The parent lock also blocks new child FK inserts while the cleanup is in progress.
      await this.#executor.query('select id from app.interviews where id = $1 for update', [
        interviewId,
      ]);
      const busyResult = await this.#executor.query(
        `select exists(select 1 from app.durable_jobs where interview_id = $1 and status in ('queued', 'running')) as jobs,
                exists(select 1 from app.evaluation_runs where interview_id = $1 and status = 'running') as evaluations`,
        [interviewId],
      );
      const busy = z
        .strictObject({ jobs: z.boolean(), evaluations: z.boolean() })
        .safeParse(busyResult.rows[0]);
      if (!busy.success || busyResult.rowCount !== 1)
        return failure(corruptData('interview', interviewId, 'Deletion guard is invalid'));
      if (busy.data.jobs || busy.data.evaluations)
        return failure({
          code: 'interview_busy',
          interviewId,
          reason: busy.data.jobs ? 'active_job' : 'active_evaluation',
        });

      // Clear interview-local RESTRICT links before the existing cascades remove their parents.
      const cleanup = [
        'delete from app.coverage_turn_references where interview_id = $1',
        'delete from app.contradiction_turn_references where interview_id = $1',
        'delete from app.contradictions where interview_id = $1',
        'delete from app.transcript_finalizations where interview_id = $1',
        'delete from app.workflow_step_runs where interview_id = $1',
        'delete from app.interview_state where interview_id = $1',
        `delete from app.transcript_entries e using app.transcript_turns t
          where e.interview_id = $1 and t.interview_id = e.interview_id
            and t.turn_id = e.entry_id and t.delivery_id is not null`,
        'delete from app.durable_jobs where interview_id = $1',
        'delete from app.transcript_entries where interview_id = $1',
      ];
      for (const statement of cleanup) await this.#executor.query(statement, [interviewId]);
      const deleted = await this.#executor.query(
        'delete from app.interviews where id = $1 returning id as interview_id',
        [interviewId],
      );
      const deletedIdentity = z.array(identityRowSchema).safeParse(deleted.rows);
      if (
        deleted.rowCount !== 1 ||
        !deletedIdentity.success ||
        deletedIdentity.data.length !== 1 ||
        deletedIdentity.data[0]?.interview_id !== interviewId
      )
        return failure(corruptData('interview', interviewId, 'Delete returned the wrong identity'));
      return success(undefined);
    } catch (error: unknown) {
      return failure(mapDatabaseError(error, { resource: 'interview', identity: interviewId }));
    }
  }

  public async create(
    interviewId: string,
    interview: PersistedInterview,
  ): Promise<RepositoryResult<IdempotentWrite<PersistedInterview>>> {
    const inputError = validateInterviewInput(interviewId, interview);
    const hasInitialSectionMemories = (interview.sectionMemories?.length ?? 0) > 0;
    if (
      inputError !== null ||
      interview.version !== 0 ||
      interview.lifecycle.status !== 'ready' ||
      hasInitialSectionMemories
    ) {
      return failure({
        code: 'constraint_violation',
        constraint:
          inputError ??
          (hasInitialSectionMemories
            ? 'interview_repository_initial_section_memories'
            : 'interview_repository_initial_state'),
      });
    }

    try {
      const guideShapeResult = await this.#executor.query(GUIDE_QUESTION_SHAPE_SELECT, [
        interview.guideId,
      ]);
      const parsedGuideShape = z
        .array(guideQuestionShapeRowSchema)
        .safeParse(guideShapeResult.rows);
      if (!parsedGuideShape.success || parsedGuideShape.data.length !== guideShapeResult.rowCount) {
        return failure(
          corruptData(
            'interview',
            interviewId,
            parsedGuideShape.success
              ? 'Guide question row count is invalid'
              : formatZodIssues(parsedGuideShape.error),
          ),
        );
      }
      const guideCoverageError = validateCoverageAgainstPersistedGuide(
        interview.coverage,
        interview.guideId,
        parsedGuideShape.data,
      );
      if (guideCoverageError !== null) {
        return failure({ code: 'constraint_violation', constraint: guideCoverageError });
      }

      const inserted = await this.#executor.query(
        `
          insert into app.interviews (id, guide_id, language, created_at)
          values ($1, $2, $3, $4)
          on conflict (id) do nothing
          returning id as interview_id
        `,
        [interviewId, interview.guideId, interview.language ?? 'de', interview.createdAt],
      );
      const parsedInsert = z.array(identityRowSchema).safeParse(inserted.rows);
      if (!parsedInsert.success || parsedInsert.data.length !== inserted.rowCount) {
        return failure(corruptData('interview', interviewId, 'Interview insert row is invalid'));
      }
      if (inserted.rowCount === 0) {
        return this.#resolveExistingCreate(interviewId, interview);
      }
      if (inserted.rowCount !== 1 || parsedInsert.data[0]?.interview_id !== interviewId) {
        return failure(
          corruptData('interview', interviewId, 'Interview insert returned the wrong identity'),
        );
      }

      const stateWrite = await this.#insertState(interview);
      if (!stateWrite.ok) {
        return stateWrite;
      }
      const counterWrite = await this.#insertCounters(interviewId);
      if (!counterWrite.ok) {
        return counterWrite;
      }
      const coverageWrite = await this.#replaceCoverage(interview);
      if (!coverageWrite.ok) {
        return coverageWrite;
      }

      return success({ outcome: 'inserted', value: interview });
    } catch (error: unknown) {
      return failure(mapDatabaseError(error, { resource: 'interview', identity: interviewId }));
    }
  }

  public async compareAndSwap(
    interviewId: string,
    expectedVersion: number,
    next: PersistedInterview,
  ): Promise<RepositoryResult<PersistedInterview>> {
    const inputError = validateInterviewInput(interviewId, next);
    if (inputError !== null || next.version !== expectedVersion + 1) {
      return failure({
        code: 'constraint_violation',
        constraint: inputError ?? 'interview_repository_next_version',
      });
    }

    const lifecycle = lifecycleColumns(next.lifecycle);
    try {
      const guardResult = await this.#executor.query(TRANSITION_GUARD_SELECT, [interviewId]);
      if (guardResult.rowCount === 0) {
        return failure({ code: 'not_found', resource: 'interview', id: interviewId });
      }
      const parsedGuard = z.array(transitionGuardRowSchema).safeParse(guardResult.rows);
      if (!parsedGuard.success || parsedGuard.data.length !== 1 || guardResult.rowCount !== 1) {
        return failure(corruptData('interview', interviewId, 'Transition guard row is invalid'));
      }
      const guard = parsedGuard.data[0]!;
      if ((guard.pendingDeliveryId === null) !== (guard.pendingReservedSequenceNumber === null)) {
        return failure(corruptData('interview', interviewId, 'Pending delivery guard is invalid'));
      }
      const unresolvedPartialIdentity = [
        guard.unresolvedPartialProvider,
        guard.unresolvedPartialSegmentId,
        guard.unresolvedPartialUtteranceId,
      ];
      if (!(
        unresolvedPartialIdentity.every((value) => value === null) ||
        unresolvedPartialIdentity.every((value) => value !== null)
      )) {
        return failure(
          corruptData('interview', interviewId, 'Unresolved partial guard is invalid'),
        );
      }
      if (guard.state_version !== expectedVersion) {
        return failure({
          code: 'stale_version',
          interviewId,
          expected: expectedVersion,
          actual: guard.state_version,
        });
      }
      if (Date.parse(next.updatedAt) < Date.parse(guard.updated_at)) {
        return failure({
          code: 'constraint_violation',
          constraint: 'interview_updated_at_monotonic',
        });
      }
      const closesTranscript =
        next.lifecycle.status === 'completed' || next.lifecycle.status === 'failed';
      if (
        closesTranscript &&
        guard.pendingDeliveryId !== null &&
        guard.pendingReservedSequenceNumber !== null
      ) {
        return failure({
          code: 'pending_ai_delivery',
          interviewId,
          deliveryId: guard.pendingDeliveryId,
          reservedSequenceNumber: guard.pendingReservedSequenceNumber,
        });
      }
      if (
        closesTranscript &&
        guard.unresolvedPartialProvider !== null &&
        guard.unresolvedPartialSegmentId !== null &&
        guard.unresolvedPartialUtteranceId !== null
      ) {
        return failure({
          code: 'unresolved_transcript_partial',
          interviewId,
          provider: guard.unresolvedPartialProvider,
          segmentId: guard.unresolvedPartialSegmentId,
          utteranceId: guard.unresolvedPartialUtteranceId,
        });
      }

      const coverageResult = await this.#executor.query(COVERAGE_SELECT, [interviewId]);
      const parsedCoverage = z.array(coverageRowSchema).safeParse(coverageResult.rows);
      if (!parsedCoverage.success || parsedCoverage.data.length !== coverageResult.rowCount) {
        return failure(
          corruptData(
            'interview',
            interviewId,
            parsedCoverage.success
              ? 'Coverage row count is invalid'
              : formatZodIssues(parsedCoverage.error),
          ),
        );
      }
      const current = reconstructInterview(interviewId, guard, parsedCoverage.data);
      if (!current.ok) {
        return current;
      }
      const guideCoverageError = validateCoverageAgainstPersistedGuide(
        next.coverage,
        current.value.guideId,
        parsedCoverage.data,
      );
      if (guideCoverageError !== null) {
        return failure({ code: 'constraint_violation', constraint: guideCoverageError });
      }
      const transitionError = validateInterviewTransition(current.value, next);
      if (transitionError !== null) {
        return failure({ code: 'constraint_violation', constraint: transitionError });
      }

      const updated = await this.#executor.query(COMPARE_AND_SWAP_STATE_SQL, [
        interviewId,
        expectedVersion,
        next.lifecycle.status,
        next.version,
        next.coverage.revision,
        currentMainQuestionId(next.coverage),
        next.activeWorkflowRunId,
        JSON.stringify(next.sectionMemories ?? []),
        next.updatedAt,
        ...lifecycle,
      ]);
      const parsedUpdate = z.array(identityRowSchema).safeParse(updated.rows);
      if (!parsedUpdate.success || parsedUpdate.data.length !== updated.rowCount) {
        return failure(corruptData('interview', interviewId, 'CAS returned an invalid row'));
      }
      if (updated.rowCount === 0) {
        return this.#staleOrMissing(interviewId, expectedVersion, next.updatedAt);
      }
      if (updated.rowCount !== 1 || parsedUpdate.data[0]?.interview_id !== interviewId) {
        return failure(corruptData('interview', interviewId, 'CAS updated an invalid identity'));
      }

      const coverageWrite = await this.#replaceCoverage(next);
      return coverageWrite.ok ? success(next) : coverageWrite;
    } catch (error: unknown) {
      return failure(mapDatabaseError(error, { resource: 'interview', identity: interviewId }));
    }
  }

  async #read(
    interviewId: string,
    forUpdate: boolean,
  ): Promise<RepositoryResult<PersistedInterview>> {
    try {
      const stateResult = await this.#executor.query(
        `${STATE_SELECT}${forUpdate ? ' for update of i, st' : ''}`,
        [interviewId],
      );
      if (stateResult.rowCount === 0) {
        return failure({ code: 'not_found', resource: 'interview', id: interviewId });
      }
      const parsedState = z.array(stateRowSchema).safeParse(stateResult.rows);
      if (!parsedState.success || parsedState.data.length !== 1 || stateResult.rowCount !== 1) {
        return failure(
          corruptData(
            'interview',
            interviewId,
            parsedState.success ? 'Duplicate state rows' : formatZodIssues(parsedState.error),
          ),
        );
      }
      const state = parsedState.data[0];
      if (state === undefined || state.interview_id !== interviewId) {
        return failure(
          corruptData('interview', interviewId, 'State query returned another interview'),
        );
      }

      const coverageResult = await this.#executor.query(COVERAGE_SELECT, [interviewId]);
      const parsedCoverage = z.array(coverageRowSchema).safeParse(coverageResult.rows);
      if (!parsedCoverage.success || parsedCoverage.data.length !== coverageResult.rowCount) {
        return failure(
          corruptData(
            'interview',
            interviewId,
            parsedCoverage.success
              ? 'Coverage row count is invalid'
              : formatZodIssues(parsedCoverage.error),
          ),
        );
      }
      return reconstructInterview(interviewId, state, parsedCoverage.data);
    } catch (error: unknown) {
      return failure(mapDatabaseError(error, { resource: 'interview', identity: interviewId }));
    }
  }

  async #resolveExistingCreate(
    interviewId: string,
    requested: PersistedInterview,
  ): Promise<RepositoryResult<IdempotentWrite<PersistedInterview>>> {
    const loaded = await this.load(interviewId);
    if (!loaded.ok) {
      return loaded;
    }
    if (serializeInterview(loaded.value) !== serializeInterview(requested)) {
      return failure({ code: 'duplicate_conflict', resource: 'interview', identity: interviewId });
    }
    return success({ outcome: 'existing', value: loaded.value });
  }

  async #insertState(interview: PersistedInterview): Promise<RepositoryResult<void>> {
    const lifecycle = lifecycleColumns(interview.lifecycle);
    try {
      const result = await this.#executor.query(
        `
          insert into app.interview_state (
            interview_id, guide_id, status, state_version, coverage_version,
            current_main_question_id, active_workflow_run_id, created_at, updated_at,
            started_at, active_since, paused_at, ending_at, ending_from, ended_at,
            failed_at, failed_from, failure_code, failure_message
          ) values (
            $1, $2, $3, $4, $5, $6, $7, $8, $9,
            $10, $11, $12, $13, $14, $15, $16, $17, $18, $19
          )
          returning interview_id
        `,
        [
          interview.interviewId,
          interview.guideId,
          interview.lifecycle.status,
          interview.version,
          interview.coverage.revision,
          currentMainQuestionId(interview.coverage),
          interview.activeWorkflowRunId,
          interview.createdAt,
          interview.updatedAt,
          ...lifecycle,
        ],
      );
      return validateSingleIdentityResult(result.rows, result.rowCount, interview.interviewId);
    } catch (error: unknown) {
      return failure(
        mapDatabaseError(error, { resource: 'interview', identity: interview.interviewId }),
      );
    }
  }

  async #insertCounters(interviewId: string): Promise<RepositoryResult<void>> {
    try {
      const result = await this.#executor.query(
        `
          insert into app.interview_counters (
            interview_id, next_transcript_sequence, next_event_sequence
          ) values ($1, 1, 1)
          returning interview_id
        `,
        [interviewId],
      );
      const parsed = z.array(counterRowSchema).safeParse(result.rows);
      if (
        !parsed.success ||
        result.rowCount !== 1 ||
        parsed.data.length !== 1 ||
        parsed.data[0]?.interview_id !== interviewId
      ) {
        return failure(corruptData('interview', interviewId, 'Counter insert is invalid'));
      }
      return success(undefined);
    } catch (error: unknown) {
      return failure(mapDatabaseError(error, { resource: 'interview', identity: interviewId }));
    }
  }

  async #replaceCoverage(interview: PersistedInterview): Promise<RepositoryResult<void>> {
    try {
      const referenceDelete = await this.#executor.query(
        'delete from app.coverage_turn_references where interview_id = $1',
        [interview.interviewId],
      );
      if (!noRowsSchema.safeParse(referenceDelete.rows).success) {
        return failure(
          corruptData('interview', interview.interviewId, 'Evidence delete returned rows'),
        );
      }
      const coverageDelete = await this.#executor.query(
        'delete from app.question_coverage where interview_id = $1',
        [interview.interviewId],
      );
      if (!noRowsSchema.safeParse(coverageDelete.rows).success) {
        return failure(
          corruptData('interview', interview.interviewId, 'Coverage delete returned rows'),
        );
      }

      const coverageWrite = await insertCoverageRows(this.#executor, interview);
      return coverageWrite.ok ? insertCoverageReferences(this.#executor, interview) : coverageWrite;
    } catch (error: unknown) {
      return failure(
        mapDatabaseError(error, { resource: 'interview', identity: interview.interviewId }),
      );
    }
  }

  async #staleOrMissing(
    interviewId: string,
    expectedVersion: number,
    nextUpdatedAt: string,
  ): Promise<RepositoryResult<PersistedInterview>> {
    try {
      const result = await this.#executor.query(
        'select state_version, updated_at from app.interview_state where interview_id = $1',
        [interviewId],
      );
      if (result.rowCount === 0) {
        return failure({ code: 'not_found', resource: 'interview', id: interviewId });
      }
      const parsed = z.array(versionRowSchema).safeParse(result.rows);
      if (!parsed.success || parsed.data.length !== 1 || result.rowCount !== 1) {
        return failure(corruptData('interview', interviewId, 'State version row is invalid'));
      }
      const actual = parsed.data[0]?.state_version;
      const currentUpdatedAt = parsed.data[0]?.updated_at;
      if (
        actual === expectedVersion &&
        currentUpdatedAt !== undefined &&
        Date.parse(nextUpdatedAt) < Date.parse(currentUpdatedAt)
      ) {
        return failure({
          code: 'constraint_violation',
          constraint: 'interview_updated_at_monotonic',
        });
      }
      if (actual === expectedVersion) {
        return failure({ code: 'serialization_failure', retryable: true });
      }
      return actual === undefined
        ? failure(corruptData('interview', interviewId, 'State version is missing'))
        : failure({ code: 'stale_version', interviewId, expected: expectedVersion, actual });
    } catch (error: unknown) {
      return failure(mapDatabaseError(error, { resource: 'interview', identity: interviewId }));
    }
  }
}

function decodeSummaryCursor(
  cursor: string | null,
): RepositoryResult<z.infer<typeof interviewSummaryCursorSchema> | null> {
  if (cursor === null) return success(null);
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const parsed = interviewSummaryCursorSchema.safeParse(decoded);
    return parsed.success
      ? success(parsed.data)
      : failure({ code: 'constraint_violation', constraint: 'interview_summary_cursor' });
  } catch {
    return failure({ code: 'constraint_violation', constraint: 'interview_summary_cursor' });
  }
}

function encodeSummaryCursor(createdAt: string, interviewId: string): string {
  return Buffer.from(JSON.stringify({ createdAt, interviewId }), 'utf8').toString('base64url');
}
