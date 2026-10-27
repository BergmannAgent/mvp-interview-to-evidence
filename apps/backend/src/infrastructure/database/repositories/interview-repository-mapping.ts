import { interviewLifecycleStateSchema } from '@orgscience/contracts';
import type {
  GuideCoverageState,
  InterviewLifecycleState,
  QuestionCoverage,
} from '@orgscience/domain';

import {
  failure,
  success,
  type PersistedInterview,
  type RepositoryResult,
} from '../../../application/persistence/index.js';
import { corruptData } from './repository-errors.js';
import { formatZodIssues, type CoverageRow, type StateRow } from './interview-repository-rows.js';

export function reconstructInterview(
  interviewId: string,
  state: StateRow,
  coverageRows: readonly CoverageRow[],
): RepositoryResult<PersistedInterview> {
  if (
    state.interview_id !== interviewId ||
    state.interview_created_at !== state.state_created_at ||
    coverageRows.length === 0 ||
    coverageRows.some(
      (row) => row.interview_id !== interviewId || row.guide_id !== state.guide_id,
    ) ||
    new Set(state.section_memories.map((memory) => memory.sectionId)).size !==
      state.section_memories.length ||
    state.section_memories.some(
      (memory) => memory.interviewId !== interviewId || memory.guideId !== state.guide_id,
    )
  ) {
    return failure(
      corruptData('interview', interviewId, 'Interview state and coverage scopes are inconsistent'),
    );
  }

  const lifecycle = reconstructLifecycle(state);
  if (!lifecycle.ok) {
    return lifecycle;
  }
  const coverage = reconstructCoverage(
    interviewId,
    state.guide_id,
    state.coverage_version,
    coverageRows,
  );
  if (!coverage.ok) {
    return coverage;
  }

  const current = coverage.value.questions.filter((question) => question.status === 'current');
  const expectedCurrentMain = current[0]?.mainQuestionId ?? null;
  if (current.length > 1 || expectedCurrentMain !== state.current_main_question_id) {
    return failure(
      corruptData('interview', interviewId, 'Current main-question state does not match coverage'),
    );
  }

  return success({
    interviewId,
    guideId: state.guide_id,
    language: state.language,
    lifecycle: lifecycle.value,
    coverage: coverage.value,
    version: state.state_version,
    activeWorkflowRunId: state.active_workflow_run_id,
    ...(state.section_memories.length === 0 ? {} : { sectionMemories: state.section_memories }),
    createdAt: state.interview_created_at,
    updatedAt: state.updated_at,
  });
}

function reconstructLifecycle(state: StateRow): RepositoryResult<InterviewLifecycleState> {
  const snapshot = lifecycleSnapshotFromRow(state);
  const validated = interviewLifecycleStateSchema.safeParse(snapshot);
  if (!validated.success) {
    return failure(corruptData('interview', state.interview_id, formatZodIssues(validated.error)));
  }
  const base = {
    interviewId: state.interview_id,
    guideId: state.guide_id,
    createdAt: state.state_created_at,
    revision: state.state_version,
  };
  switch (validated.data.status) {
    case 'ready':
      return success({ ...base, status: 'ready' });
    case 'active':
      return success({ ...base, ...validated.data });
    case 'paused':
      return success({ ...base, ...validated.data });
    case 'ending':
      return success({ ...base, ...validated.data });
    case 'completed':
      return success({ ...base, ...validated.data });
    case 'failed':
      return success({ ...base, ...validated.data });
  }
}

function lifecycleSnapshotFromRow(state: StateRow): unknown {
  switch (state.status) {
    case 'ready':
      return { status: state.status };
    case 'active':
      return {
        status: state.status,
        startedAt: state.started_at,
        activeSince: state.active_since,
      };
    case 'paused':
      return { status: state.status, startedAt: state.started_at, pausedAt: state.paused_at };
    case 'ending':
      return {
        status: state.status,
        startedAt: state.started_at,
        endingAt: state.ending_at,
        endingFrom: state.ending_from,
      };
    case 'completed':
      return {
        status: state.status,
        startedAt: state.started_at,
        endingAt: state.ending_at,
        endedAt: state.ended_at,
      };
    case 'failed':
      return {
        status: state.status,
        startedAt: state.started_at,
        failedAt: state.failed_at,
        failedFrom: state.failed_from,
        failure:
          state.failure_code === null || state.failure_message === null
            ? null
            : { code: state.failure_code, message: state.failure_message },
      };
  }
}

function reconstructCoverage(
  interviewId: string,
  guideId: string,
  revision: number,
  rows: readonly CoverageRow[],
): RepositoryResult<GuideCoverageState> {
  const questions = new Map<string, MutableCoverage>();
  for (const row of rows) {
    if (row.coverage_status === null) {
      return failure(
        corruptData('interview', interviewId, `Question ${row.question_id} has no coverage row`),
      );
    }
    const kind = row.question_kind === 'main_question' ? 'main' : 'follow_up';
    const existing = questions.get(row.question_id);
    if (existing === undefined) {
      questions.set(row.question_id, {
        questionId: row.question_id,
        kind,
        mainQuestionId: row.main_question_id,
        status: row.coverage_status,
        referencedTurnIds: row.referenced_turn_id === null ? [] : [row.referenced_turn_id],
        updatedAt: row.coverage_updated_at,
      });
      continue;
    }
    if (
      existing.kind !== kind ||
      existing.mainQuestionId !== row.main_question_id ||
      existing.status !== row.coverage_status ||
      existing.updatedAt !== row.coverage_updated_at ||
      row.referenced_turn_id === null ||
      existing.referencedTurnIds.includes(row.referenced_turn_id)
    ) {
      return failure(
        corruptData('interview', interviewId, `Coverage ${row.question_id} is inconsistent`),
      );
    }
    existing.referencedTurnIds.push(row.referenced_turn_id);
  }

  const materialized: QuestionCoverage[] = [...questions.values()].map((question) => ({
    ...question,
    referencedTurnIds: question.referencedTurnIds,
  }));
  for (const question of materialized) {
    const requiresEvidence =
      question.status === 'partially_answered' ||
      question.status === 'answered' ||
      question.status === 'skipped_already_answered';
    if (
      (requiresEvidence && question.referencedTurnIds.length === 0) ||
      (question.status === 'not_addressed' && question.referencedTurnIds.length > 0)
    ) {
      return failure(
        corruptData(
          'interview',
          interviewId,
          `Coverage ${question.questionId} has invalid evidence`,
        ),
      );
    }
  }
  return success({ interviewId, guideId, revision, questions: materialized });
}

interface MutableCoverage extends Omit<QuestionCoverage, 'referencedTurnIds'> {
  readonly referencedTurnIds: string[];
}
