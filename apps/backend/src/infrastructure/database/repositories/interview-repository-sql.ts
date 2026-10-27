import { z } from 'zod';

import {
  failure,
  success,
  type PersistedInterview,
  type RepositoryResult,
} from '../../../application/persistence/index.js';
import {
  coverageIdentityRowSchema,
  coverageReferenceRowSchema,
  identityRowSchema,
} from './interview-repository-rows.js';
import { corruptData, mapDatabaseError } from './repository-errors.js';
import type { SqlExecutor } from './sql.js';

export const STATE_SELECT = `
  select
    i.id as interview_id,
    i.guide_id,
    i.language,
    i.created_at as interview_created_at,
    st.status,
    st.state_version,
    st.coverage_version,
    st.current_main_question_id,
    st.active_workflow_run_id,
    st.section_memories,
    st.created_at as state_created_at,
    st.updated_at,
    st.started_at,
    st.active_since,
    st.paused_at,
    st.ending_at,
    st.ending_from,
    st.ended_at,
    st.failed_at,
    st.failed_from,
    st.failure_code,
    st.failure_message
  from app.interviews i
  join app.interview_state st
    on st.interview_id = i.id
   and st.guide_id = i.guide_id
  where i.id = $1
`;

export const COVERAGE_SELECT = `
  select
    i.id as interview_id,
    i.guide_id,
    q.id as question_id,
    q.kind as question_kind,
    q.main_question_id,
    section.position as section_position,
    main_q.position as main_position,
    q.position as question_position,
    coverage.status as coverage_status,
    coverage.updated_at as coverage_updated_at,
    evidence.turn_id as referenced_turn_id
  from app.interviews i
  join app.guide_questions q
    on q.guide_id = i.guide_id
  join app.guide_sections section
    on section.guide_id = q.guide_id
   and section.id = q.section_id
  join app.guide_questions main_q
    on main_q.guide_id = q.guide_id
   and main_q.id = q.main_question_id
   and main_q.section_id = q.section_id
   and main_q.kind = 'main_question'
  left join app.question_coverage coverage
    on coverage.interview_id = i.id
   and coverage.guide_id = q.guide_id
   and coverage.question_id = q.id
  left join app.coverage_turn_references evidence
    on evidence.interview_id = i.id
   and evidence.question_id = q.id
  where i.id = $1
  order by
    section.position asc,
    main_q.position asc,
    case q.kind when 'main_question' then 0 else 1 end asc,
    q.position asc,
    evidence.turn_id asc
`;

export const GUIDE_QUESTION_SHAPE_SELECT = `
  select
    q.guide_id,
    q.id as question_id,
    q.kind as question_kind,
    q.main_question_id
  from app.guide_questions q
  join app.guide_sections section
    on section.guide_id = q.guide_id
   and section.id = q.section_id
  join app.guide_questions main_q
    on main_q.guide_id = q.guide_id
   and main_q.id = q.main_question_id
   and main_q.section_id = q.section_id
   and main_q.kind = 'main_question'
  where q.guide_id = $1
  order by
    section.position asc,
    main_q.position asc,
    case q.kind when 'main_question' then 0 else 1 end asc,
    q.position asc
`;

const UNRESOLVED_PARTIAL_PREDICATE = `
  p.disposition in ('accepted', 'updated')
  and not exists (
    select 1 from app.transcript_final_segments f
     where f.interview_id = p.interview_id
       and f.provider = p.provider
       and (f.segment_id = p.segment_id or f.utterance_id = p.utterance_id)
  )
  and not exists (
    select 1 from app.transcript_gaps g
     where g.interview_id = p.interview_id
       and g.source = 'speech_to_text'
       and g.provider = p.provider
       and (g.related_segment_id = p.segment_id
         or g.related_utterance_id = p.utterance_id)
  )
`;

export const TRANSITION_GUARD_SELECT = `
  select i.id as interview_id, i.guide_id, i.language,
         i.created_at as interview_created_at,
         st.status, st.state_version, st.coverage_version,
         st.current_main_question_id, st.active_workflow_run_id,
         st.section_memories,
         st.created_at as state_created_at, st.updated_at,
         st.started_at, st.active_since, st.paused_at,
         st.ending_at, st.ending_from, st.ended_at,
         st.failed_at, st.failed_from, st.failure_code, st.failure_message,
         pending.id as "pendingDeliveryId",
         pending.reserved_sequence_number as "pendingReservedSequenceNumber",
         unresolved.provider as "unresolvedPartialProvider",
         unresolved.segment_id as "unresolvedPartialSegmentId",
         unresolved.utterance_id as "unresolvedPartialUtteranceId"
    from app.interviews i
    join app.interview_state st
      on st.interview_id = i.id and st.guide_id = i.guide_id
    join app.interview_counters c on c.interview_id = st.interview_id
    left join lateral (
      select d.id, d.reserved_sequence_number
        from app.ai_turn_deliveries d
       where d.interview_id = st.interview_id and d.status = 'pending'
       limit 1
    ) pending on true
    left join lateral (
      select p.provider, p.segment_id, p.utterance_id
        from app.transcript_partial_events p
       where p.interview_id = st.interview_id
         and ${UNRESOLVED_PARTIAL_PREDICATE}
       order by p.observed_at, p.provider, p.segment_id, p.revision, p.provider_event_id
       limit 1
    ) unresolved on true
   where i.id = $1
   for update of st, c
`;

export const COMPARE_AND_SWAP_STATE_SQL = `
  update app.interview_state
  set
    status = $3,
    state_version = $4,
    coverage_version = $5,
    current_main_question_id = $6,
    active_workflow_run_id = $7,
    section_memories = $8,
    updated_at = $9,
    started_at = $10,
    active_since = $11,
    paused_at = $12,
    ending_at = $13,
    ending_from = $14,
    ended_at = $15,
    failed_at = $16,
    failed_from = $17,
    failure_code = $18,
    failure_message = $19
  where interview_id = $1
    and state_version = $2
    and updated_at <= $9
    and ($3 not in ('completed', 'failed') or (
      not exists (
        select 1 from app.ai_turn_deliveries d
         where d.interview_id = interview_state.interview_id and d.status = 'pending'
      )
      and not exists (
        select 1 from app.transcript_partial_events p
         where p.interview_id = interview_state.interview_id
           and ${UNRESOLVED_PARTIAL_PREDICATE}
      )
    ))
  returning interview_id
`;

export async function insertCoverageRows(
  executor: SqlExecutor,
  interview: PersistedInterview,
): Promise<RepositoryResult<void>> {
  const rows = interview.coverage.questions.map((question) => [
    interview.interviewId,
    interview.guideId,
    question.questionId,
    question.status,
    question.updatedAt,
  ]);
  if (rows.length === 0) {
    return failure({ code: 'constraint_violation', constraint: 'interview_coverage_empty' });
  }
  const parameters = rows.flat();
  const values = placeholders(rows.length, 5);
  try {
    const result = await executor.query(
      `
        insert into app.question_coverage (
          interview_id, guide_id, question_id, status, updated_at
        ) values ${values}
        returning question_id
      `,
      parameters,
    );
    const parsed = z.array(coverageIdentityRowSchema).safeParse(result.rows);
    if (!parsed.success || parsed.data.length !== rows.length || result.rowCount !== rows.length) {
      return failure(
        corruptData('interview', interview.interviewId, 'Coverage insert count is invalid'),
      );
    }
    return success(undefined);
  } catch (error: unknown) {
    return failure(
      mapDatabaseError(error, { resource: 'interview', identity: interview.interviewId }),
    );
  }
}

export async function insertCoverageReferences(
  executor: SqlExecutor,
  interview: PersistedInterview,
): Promise<RepositoryResult<void>> {
  const rows = interview.coverage.questions.flatMap((question) =>
    question.referencedTurnIds.map((turnId) => [
      interview.interviewId,
      question.questionId,
      turnId,
    ]),
  );
  if (rows.length === 0) {
    return success(undefined);
  }
  try {
    const result = await executor.query(
      `
        insert into app.coverage_turn_references (interview_id, question_id, turn_id)
        values ${placeholders(rows.length, 3)}
        returning question_id, turn_id
      `,
      rows.flat(),
    );
    const parsed = z.array(coverageReferenceRowSchema).safeParse(result.rows);
    if (!parsed.success || parsed.data.length !== rows.length || result.rowCount !== rows.length) {
      return failure(
        corruptData('interview', interview.interviewId, 'Coverage evidence insert is invalid'),
      );
    }
    return success(undefined);
  } catch (error: unknown) {
    return failure(
      mapDatabaseError(error, { resource: 'interview', identity: interview.interviewId }),
    );
  }
}

export function validateSingleIdentityResult(
  rows: readonly unknown[],
  rowCount: number,
  interviewId: string,
): RepositoryResult<void> {
  const parsed = z.array(identityRowSchema).safeParse(rows);
  return parsed.success &&
    parsed.data.length === 1 &&
    rowCount === 1 &&
    parsed.data[0]?.interview_id === interviewId
    ? success(undefined)
    : failure(corruptData('interview', interviewId, 'State insert identity is invalid'));
}

function placeholders(rowCount: number, columnCount: number): string {
  return Array.from({ length: rowCount }, (_, rowIndex) => {
    const row = Array.from(
      { length: columnCount },
      (_, columnIndex) => `$${String(rowIndex * columnCount + columnIndex + 1)}`,
    );
    return `(${row.join(', ')})`;
  }).join(', ');
}
