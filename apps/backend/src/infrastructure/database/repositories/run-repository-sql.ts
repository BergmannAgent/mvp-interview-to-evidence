export const WORKFLOW_PROJECTION = `
  id, interview_id, job_id, mastra_attempt_id, attempt_number,
  expected_state_version, status, retry_count, started_at, ended_at,
  duration_ms, error_code, error_message, error_retryable,
  rejection_reason, applied_at
`;

export const STEP_PROJECTION = `
  s.id, s.interview_id, s.workflow_run_id, s.agent_run_id,
  w.mastra_attempt_id, s.step, s.attempt_number, s.status,
  s.retry_count, s.started_at, s.ended_at, s.duration_ms,
  s.error_code, s.error_message, s.error_retryable,
  s.input, s.output
`;

export const AGENT_PROJECTION = `
  a.id, a.interview_id, a.workflow_run_id,
  w.mastra_attempt_id, a.agent_name, a.invocation_number, a.status,
  a.retry_count, a.model_mode, a.model_provider, a.model_name,
  a.started_at, a.ended_at, a.duration_ms,
  a.error_code, a.error_message, a.error_retryable,
  a.input, a.output
`;

export const LOAD_WORKFLOW_SQL = `select ${WORKFLOW_PROJECTION}
  from app.workflow_runs
  where interview_id = $1 and id = $2`;

export const LIST_WORKFLOWS_SQL = `select ${WORKFLOW_PROJECTION}
  from app.workflow_runs
  where interview_id = $1
  order by created_at asc, id asc`;

export const INSERT_WORKFLOW_SQL = `insert into app.workflow_runs (
    id, interview_id, job_id, mastra_attempt_id, attempt_number,
    expected_state_version, status, retry_count, started_at, ended_at,
    duration_ms, error_code, error_message, error_retryable,
    rejection_reason, applied_at, created_at
  ) values (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
    $11, $12, $13, $14, $15, $16, coalesce($9::timestamptz, current_timestamp)
  ) on conflict (id) do nothing returning id`;

export const FINISH_WORKFLOW_SQL = `update app.workflow_runs set
    status = $4, retry_count = $5, ended_at = $6, duration_ms = $7,
    error_code = $8, error_message = $9, error_retryable = $10,
    rejection_reason = $11, applied_at = $12
  where interview_id = $2 and id = $1 and status = $3
    and job_id = $13 and mastra_attempt_id = $14 and attempt_number = $15
    and expected_state_version = $16
    and started_at is not distinct from $17::timestamptz
  returning ${WORKFLOW_PROJECTION}`;

export const LOAD_STEP_SQL = `select ${STEP_PROJECTION}
  from app.workflow_step_runs s
  join app.workflow_runs w
    on w.interview_id = s.interview_id and w.id = s.workflow_run_id
  where s.interview_id = $1 and s.id = $2`;

export const LIST_STEPS_SQL = `select ${STEP_PROJECTION}
  from app.workflow_step_runs s
  join app.workflow_runs w
    on w.interview_id = s.interview_id and w.id = s.workflow_run_id
  where s.interview_id = $1 and s.workflow_run_id = $2
  order by case s.step
    when 'receive_user_turn' then 1
    when 'finalize_user_turn' then 2
    when 'load_interview_state' then 3
    when 'coverage_analysis' then 4
    when 'consistency_analysis' then 5
    when 'interview_decision' then 6
    when 'conductor_question_generation' then 7
    when 'validation' then 8
    when 'persistence' then 9
    when 'text_streaming' then 10
    when 'audio_streaming' then 11
    when 'state_update' then 12
    else 13
  end asc, s.attempt_number asc, s.id asc`;

export const LIST_INTERVIEW_STEPS_SQL = `select ${STEP_PROJECTION}
  from app.workflow_step_runs s
  join app.workflow_runs w
    on w.interview_id = s.interview_id and w.id = s.workflow_run_id
  where s.interview_id = $1
  order by w.created_at asc, w.id asc, case s.step
    when 'receive_user_turn' then 1
    when 'finalize_user_turn' then 2
    when 'load_interview_state' then 3
    when 'coverage_analysis' then 4
    when 'consistency_analysis' then 5
    when 'interview_decision' then 6
    when 'conductor_question_generation' then 7
    when 'validation' then 8
    when 'persistence' then 9
    when 'text_streaming' then 10
    when 'audio_streaming' then 11
    when 'state_update' then 12
    else 13
  end asc, s.attempt_number asc, s.id asc`;

export const INSERT_STEP_SQL = `insert into app.workflow_step_runs (
    id, interview_id, workflow_run_id, agent_run_id, step, attempt_number, status,
    retry_count, started_at, ended_at, duration_ms,
    error_code, error_message, error_retryable, input, output
  ) select
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
    $12, $13, $14, $15::jsonb, $16::jsonb
  from app.workflow_runs w
  where w.interview_id = $2 and w.id = $3 and w.mastra_attempt_id = $17
  on conflict (id) do nothing returning id`;

export const FINISH_STEP_SQL = `update app.workflow_step_runs s set
    agent_run_id = $4, status = $5, retry_count = $6,
    ended_at = $7, duration_ms = $8,
    error_code = $9, error_message = $10, error_retryable = $11,
    output = $12::jsonb
  from app.workflow_runs w
  where s.interview_id = $2 and s.id = $1 and s.status = $3
    and s.agent_run_id is null and s.output is null
    and s.workflow_run_id = $13 and s.step = $14 and s.attempt_number = $15
    and s.started_at is not distinct from $16::timestamptz
    and s.input = $17::jsonb
    and w.interview_id = s.interview_id and w.id = s.workflow_run_id
    and w.mastra_attempt_id = $18
  returning ${STEP_PROJECTION}`;

export const LOAD_AGENT_SQL = `select ${AGENT_PROJECTION}
  from app.agent_runs a
  join app.workflow_runs w
    on w.interview_id = a.interview_id and w.id = a.workflow_run_id
  where a.interview_id = $1 and a.id = $2`;

export const LIST_AGENTS_SQL = `select ${AGENT_PROJECTION}
  from app.agent_runs a
  join app.workflow_runs w
    on w.interview_id = a.interview_id and w.id = a.workflow_run_id
  where a.interview_id = $1 and a.workflow_run_id = $2
  order by a.started_at asc nulls last, a.agent_name asc,
    a.invocation_number asc, a.id asc`;

export const LIST_INTERVIEW_AGENTS_SQL = `select ${AGENT_PROJECTION}
  from app.agent_runs a
  join app.workflow_runs w
    on w.interview_id = a.interview_id and w.id = a.workflow_run_id
  where a.interview_id = $1
  order by w.created_at asc, w.id asc, a.started_at asc nulls last,
    a.agent_name asc, a.invocation_number asc, a.id asc`;

export const INSERT_AGENT_SQL = `insert into app.agent_runs (
    id, interview_id, workflow_run_id, agent_name, invocation_number,
    status, retry_count, model_mode, model_provider, model_name,
    started_at, ended_at, duration_ms, error_code, error_message,
    error_retryable, input, output
  ) select
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
    $11, $12, $13, $14, $15, $16, $17::jsonb, $18::jsonb
  from app.workflow_runs w
  where w.interview_id = $2 and w.id = $3 and w.mastra_attempt_id = $19
  on conflict (id) do nothing returning id`;

export const FINISH_AGENT_SQL = `update app.agent_runs a set
    status = $4, retry_count = $5, ended_at = $6, duration_ms = $7,
    error_code = $8, error_message = $9, error_retryable = $10,
    output = $11::jsonb
  from app.workflow_runs w
  where a.interview_id = $2 and a.id = $1 and a.status = $3
    and a.workflow_run_id = $12 and a.agent_name = $13
    and a.invocation_number = $14 and a.model_mode = $15
    and a.model_provider is not distinct from $16
    and a.model_name is not distinct from $17
    and a.started_at is not distinct from $18::timestamptz
    and a.input = $19::jsonb
    and w.interview_id = a.interview_id and w.id = a.workflow_run_id
    and w.mastra_attempt_id = $20
  returning ${AGENT_PROJECTION}`;
