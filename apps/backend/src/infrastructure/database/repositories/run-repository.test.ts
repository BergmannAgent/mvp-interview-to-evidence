import type { StructuredAgentOutput } from '@orgscience/contracts';
import { describe, expect, it } from 'vitest';

import type {
  StoredAgentRun,
  StoredStepCheckpoint,
  StoredWorkflowAttempt,
} from '../../../application/persistence/index.js';
import { PostgresRunRepository } from './run-repository.js';
import type { SqlExecutor, SqlQueryResult } from './sql.js';

const INTERVIEW_ID = 'interview-1';
const GUIDE_ID = 'guide-1';
const WORKFLOW_ID = 'workflow-1';
const ATTEMPT_ID = 'mastra-attempt-1';
const STARTED_AT = '2026-08-06T10:00:00.000Z';
const ENDED_AT = '2026-08-06T10:00:01.000Z';

interface SqlCall {
  readonly statement: string;
  readonly parameters: readonly unknown[];
}

class ScriptedExecutor implements SqlExecutor {
  public readonly calls: SqlCall[] = [];

  public constructor(private readonly results: SqlQueryResult[]) {}

  public async query(
    statement: string,
    parameters: readonly unknown[] = [],
  ): Promise<SqlQueryResult> {
    this.calls.push({ statement, parameters });
    const next = this.results.shift();
    if (next === undefined) throw new Error(`Unexpected SQL: ${statement}`);
    return next;
  }
}

const queryResult = (rows: readonly unknown[] = []): SqlQueryResult => ({
  rows,
  rowCount: rows.length,
});

const runningWorkflow: StoredWorkflowAttempt = {
  interviewId: INTERVIEW_ID,
  workflowRunId: WORKFLOW_ID,
  attemptId: ATTEMPT_ID,
  jobId: 'job-1',
  expectedInterviewVersion: 2,
  attemptNumber: 1,
  status: 'running',
  retryCount: 0,
  startedAt: STARTED_AT,
  endedAt: null,
  durationMs: null,
  failure: null,
  rejectionReason: null,
  appliedAt: null,
};

const succeededWorkflow: StoredWorkflowAttempt = {
  ...runningWorkflow,
  status: 'succeeded',
  endedAt: ENDED_AT,
  durationMs: 1000,
  appliedAt: ENDED_AT,
};

const coverageOutput: StructuredAgentOutput = {
  agentName: 'coverage_analysis',
  output: {
    findings: [],
    referencedTranscriptTurnIds: [],
    rationale: 'No participant evidence was available for this deterministic test.',
  },
};

const checkpoint: StoredStepCheckpoint = {
  interviewId: INTERVIEW_ID,
  workflowRunId: WORKFLOW_ID,
  attemptId: ATTEMPT_ID,
  stepRunId: 'step-1',
  agentRunId: 'agent-1',
  step: 'coverage_analysis',
  attemptNumber: 1,
  status: 'succeeded',
  retryCount: 0,
  referencedTranscriptTurnIds: ['turn-1'],
  referencedGuideQuestionIds: ['question-1'],
  structuredOutput: coverageOutput,
  startedAt: STARTED_AT,
  endedAt: ENDED_AT,
  durationMs: 1000,
  failure: null,
};

const runningCheckpoint: StoredStepCheckpoint = {
  ...checkpoint,
  agentRunId: null,
  status: 'running',
  structuredOutput: null,
  endedAt: null,
  durationMs: null,
};

const runningAgent: StoredAgentRun = {
  interviewId: INTERVIEW_ID,
  workflowRunId: WORKFLOW_ID,
  attemptId: ATTEMPT_ID,
  agentRunId: 'agent-1',
  agentName: 'coverage_analysis',
  invocationNumber: 1,
  status: 'running',
  model: { mode: 'demo', provider: null, model: null },
  validatedInput: {
    interviewStateVersion: 2,
    transcriptTurnIds: ['turn-1'],
    canonicalEntryIds: [],
    guideQuestionIds: ['question-1'],
  },
  validatedOutput: null,
  startedAt: STARTED_AT,
  endedAt: null,
  durationMs: null,
  retryCount: 0,
  failure: null,
};

const succeededAgent: StoredAgentRun = {
  ...runningAgent,
  status: 'succeeded',
  validatedOutput: coverageOutput,
  endedAt: ENDED_AT,
  durationMs: 1000,
};

function workflowRow(run: StoredWorkflowAttempt): Record<string, unknown> {
  return {
    id: run.workflowRunId,
    interview_id: run.interviewId,
    job_id: run.jobId,
    mastra_attempt_id: run.attemptId,
    attempt_number: run.attemptNumber,
    expected_state_version: run.expectedInterviewVersion,
    status: run.status,
    retry_count: run.retryCount,
    started_at: run.startedAt,
    ended_at: run.endedAt,
    duration_ms: run.durationMs,
    error_code: run.failure?.code ?? null,
    error_message: run.failure?.message ?? null,
    error_retryable: run.failure?.retryable ?? null,
    rejection_reason: run.rejectionReason,
    applied_at: run.appliedAt,
  };
}

function stepRow(value: StoredStepCheckpoint): Record<string, unknown> {
  return {
    id: value.stepRunId,
    interview_id: value.interviewId,
    workflow_run_id: value.workflowRunId,
    mastra_attempt_id: value.attemptId,
    agent_run_id: value.agentRunId,
    step: value.step,
    attempt_number: value.attemptNumber,
    status: value.status,
    retry_count: value.retryCount,
    started_at: value.startedAt,
    ended_at: value.endedAt,
    duration_ms: value.durationMs,
    error_code: value.failure?.code ?? null,
    error_message: value.failure?.message ?? null,
    error_retryable: value.failure?.retryable ?? null,
    input: {
      referencedTranscriptTurnIds: value.referencedTranscriptTurnIds,
      referencedGuideQuestionIds: value.referencedGuideQuestionIds,
    },
    output: value.structuredOutput,
  };
}

function agentRow(run: StoredAgentRun): Record<string, unknown> {
  return {
    id: run.agentRunId,
    interview_id: run.interviewId,
    workflow_run_id: run.workflowRunId,
    mastra_attempt_id: run.attemptId,
    agent_name: run.agentName,
    invocation_number: run.invocationNumber,
    status: run.status,
    retry_count: run.retryCount,
    model_mode: run.model.mode,
    model_provider: run.model.provider,
    model_name: run.model.model,
    started_at: run.startedAt,
    ended_at: run.endedAt,
    duration_ms: run.durationMs,
    error_code: run.failure?.code ?? null,
    error_message: run.failure?.message ?? null,
    error_retryable: run.failure?.retryable ?? null,
    input: run.validatedInput,
    output: run.validatedOutput,
  };
}

function referenceScope(
  transcriptTurnIds: readonly string[] = ['turn-1'],
  guideQuestionIds: readonly string[] = ['question-1'],
  canonicalEntryIds: readonly string[] = [],
  guideId = GUIDE_ID,
  guideQuestions: readonly Record<string, unknown>[] = guideQuestionIds.map((questionId) => ({
    questionId,
    kind: 'main_question',
    sectionId: 'section-1',
    mainQuestionId: questionId,
  })),
  agentAttributionValid = true,
): SqlQueryResult {
  return queryResult([
    {
      guideId,
      transcriptTurnIds,
      guideQuestionIds,
      guideQuestions,
      canonicalEntryIds,
      agentAttributionValid,
    },
  ]);
}

describe('PostgresRunRepository', () => {
  it('loads and lists workflow attempts without losing failure retryability', async () => {
    const failed: StoredWorkflowAttempt = {
      ...runningWorkflow,
      status: 'failed',
      endedAt: ENDED_AT,
      durationMs: 1000,
      failure: {
        code: 'provider_timeout',
        message: 'Provider timed out',
        retryable: true,
        occurredAt: ENDED_AT,
      },
    };
    const executor = new ScriptedExecutor([
      queryResult([workflowRow(failed)]),
      queryResult([workflowRow(runningWorkflow), workflowRow(failed)]),
    ]);
    const repository = new PostgresRunRepository(executor);

    await expect(repository.loadWorkflow(INTERVIEW_ID, WORKFLOW_ID)).resolves.toEqual({
      ok: true,
      value: failed,
    });
    await expect(repository.listForInterview(INTERVIEW_ID)).resolves.toEqual({
      ok: true,
      value: [runningWorkflow, failed],
    });
    expect(executor.calls[1]?.statement).toContain('order by created_at asc, id asc');
  });

  it('loads and lists workflow-scoped step and agent runs in stable order', async () => {
    const executor = new ScriptedExecutor([
      queryResult([stepRow(checkpoint)]),
      queryResult([stepRow(checkpoint)]),
      queryResult([agentRow(succeededAgent)]),
      queryResult([agentRow(succeededAgent)]),
    ]);
    const repository = new PostgresRunRepository(executor);

    await expect(repository.loadStep(INTERVIEW_ID, checkpoint.stepRunId)).resolves.toEqual({
      ok: true,
      value: checkpoint,
    });
    await expect(repository.listStepsForWorkflow(INTERVIEW_ID, WORKFLOW_ID)).resolves.toEqual({
      ok: true,
      value: [checkpoint],
    });
    await expect(repository.loadAgent(INTERVIEW_ID, succeededAgent.agentRunId)).resolves.toEqual({
      ok: true,
      value: succeededAgent,
    });
    await expect(repository.listAgentsForWorkflow(INTERVIEW_ID, WORKFLOW_ID)).resolves.toEqual({
      ok: true,
      value: [succeededAgent],
    });
    expect(executor.calls[1]?.statement).toContain("when 'receive_user_turn' then 1");
    expect(executor.calls[3]?.statement).toContain('a.started_at asc nulls last');
  });

  it('lists all step and agent runs for one interview in stable workflow order', async () => {
    const executor = new ScriptedExecutor([
      queryResult([stepRow(checkpoint)]),
      queryResult([agentRow(succeededAgent)]),
    ]);
    const repository = new PostgresRunRepository(executor);

    await expect(repository.listStepsForInterview(INTERVIEW_ID)).resolves.toEqual({
      ok: true,
      value: [checkpoint],
    });
    await expect(repository.listAgentsForInterview(INTERVIEW_ID)).resolves.toEqual({
      ok: true,
      value: [succeededAgent],
    });
    expect(executor.calls[0]?.statement).toContain('where s.interview_id = $1');
    expect(executor.calls[0]?.statement).toContain('w.created_at asc, w.id asc');
    expect(executor.calls[1]?.statement).toContain('where a.interview_id = $1');
    expect(executor.calls[1]?.statement).toContain('w.created_at asc, w.id asc');
    expect(executor.calls.every((call) => !call.statement.includes('workflow_run_id = $2'))).toBe(
      true,
    );
  });

  it('rejects a cross-workflow row returned by a list query', async () => {
    const executor = new ScriptedExecutor([
      queryResult([stepRow({ ...checkpoint, workflowRunId: 'workflow-foreign' })]),
    ]);

    await expect(
      new PostgresRunRepository(executor).listStepsForWorkflow(INTERVIEW_ID, WORKFLOW_ID),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'corrupt_data',
        resource: 'workflow_run',
        id: checkpoint.stepRunId,
        reason: 'Step checkpoint scope mismatch',
      },
    });
  });

  it('rejects malformed workflow, attempt, step, agent, and reference IDs before SQL', async () => {
    for (const run of [
      { ...runningWorkflow, workflowRunId: 'workflow bad' },
      { ...runningWorkflow, jobId: ' job-1' },
      { ...runningWorkflow, attemptId: `a${'x'.repeat(128)}` },
    ]) {
      const executor = new ScriptedExecutor([]);
      await expect(
        new PostgresRunRepository(executor).startWorkflow(INTERVIEW_ID, run),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'constraint_violation', constraint: 'workflow_identity_or_counter' },
      });
      expect(executor.calls).toHaveLength(0);
    }

    const invalidStepCases = [
      {
        attemptId: 'attempt bad',
        value: { ...checkpoint, attemptId: 'attempt bad' },
        constraint: 'workflow_step_scope',
      },
      {
        attemptId: ATTEMPT_ID,
        value: { ...checkpoint, stepRunId: ' step-1' },
        constraint: 'workflow_step_identity_or_counter',
      },
      {
        attemptId: ATTEMPT_ID,
        value: { ...checkpoint, referencedTranscriptTurnIds: ['turn bad'] },
        constraint: 'workflow_step_duplicate_references',
      },
      {
        attemptId: ATTEMPT_ID,
        value: {
          ...checkpoint,
          structuredOutput: {
            agentName: 'consistency_analysis',
            output: {
              contradictions: [],
              referencedTranscriptTurnIds: [],
              rationale: 'No contradictions were detected.',
            },
          },
        },
        constraint: 'workflow_step_output_shape',
      },
      {
        attemptId: ATTEMPT_ID,
        value: {
          ...checkpoint,
          status: 'running',
          endedAt: null,
          durationMs: null,
        },
        constraint: 'workflow_step_output_shape',
      },
    ] satisfies readonly {
      attemptId: string;
      value: StoredStepCheckpoint;
      constraint: string;
    }[];
    for (const invalid of invalidStepCases) {
      const executor = new ScriptedExecutor([]);
      await expect(
        new PostgresRunRepository(executor).saveStepCheckpoint(
          INTERVIEW_ID,
          invalid.attemptId,
          invalid.value,
        ),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'constraint_violation', constraint: invalid.constraint },
      });
      expect(executor.calls).toHaveLength(0);
    }

    for (const run of [
      { ...runningAgent, agentRunId: 'agent bad' },
      {
        ...runningAgent,
        validatedInput: { ...runningAgent.validatedInput, canonicalEntryIds: [' entry-1'] },
      },
    ]) {
      const executor = new ScriptedExecutor([]);
      await expect(
        new PostgresRunRepository(executor).startAgent(INTERVIEW_ID, run),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'constraint_violation' },
      });
      expect(executor.calls).toHaveLength(0);
    }
  });

  it('rejects agent output outside a succeeded run before SQL', async () => {
    for (const run of [
      { ...runningAgent, validatedOutput: coverageOutput },
      { ...succeededAgent, validatedOutput: null },
    ]) {
      const executor = new ScriptedExecutor([]);
      await expect(
        new PostgresRunRepository(executor).startAgent(INTERVIEW_ID, run),
      ).resolves.toEqual({
        ok: false,
        error: { code: 'constraint_violation', constraint: 'agent_output_shape' },
      });
      expect(executor.calls).toHaveLength(0);
    }
  });

  it('rejects malformed runtime timestamps and non-integer run counters before SQL', async () => {
    for (const [run, constraint] of [
      [{ ...runningWorkflow, startedAt: 'not-a-timestamp' }, 'run_timestamp'],
      [
        { ...runningWorkflow, startedAt: new Date(STARTED_AT) as unknown as string },
        'run_timestamp',
      ],
      [{ ...runningWorkflow, startedAt: '2026-08-06T10:00:00.0006Z' }, 'run_timestamp'],
      [{ ...runningWorkflow, attemptNumber: 1.5 }, 'workflow_identity_or_counter'],
      [{ ...runningWorkflow, retryCount: 0.5 }, 'workflow_identity_or_counter'],
    ] as const) {
      const executor = new ScriptedExecutor([]);
      await expect(
        new PostgresRunRepository(executor).startWorkflow(INTERVIEW_ID, run),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'constraint_violation', constraint },
      });
      expect(executor.calls).toHaveLength(0);
    }

    for (const [value, constraint] of [
      [{ ...checkpoint, endedAt: new Date(ENDED_AT) as unknown as string }, 'run_timestamp'],
      [{ ...checkpoint, durationMs: 1.5 }, 'run_duration'],
      [{ ...checkpoint, attemptNumber: 1.5 }, 'workflow_step_identity_or_counter'],
    ] as const) {
      const executor = new ScriptedExecutor([]);
      await expect(
        new PostgresRunRepository(executor).saveStepCheckpoint(INTERVIEW_ID, ATTEMPT_ID, value),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'constraint_violation', constraint },
      });
      expect(executor.calls).toHaveLength(0);
    }

    for (const [run, constraint] of [
      [{ ...runningAgent, startedAt: 'not-a-timestamp' }, 'run_timestamp'],
      [{ ...runningAgent, invocationNumber: 1.5 }, 'agent_identity_or_counter'],
      [{ ...succeededAgent, durationMs: -1 }, 'run_duration'],
    ] as const) {
      const executor = new ScriptedExecutor([]);
      await expect(
        new PostgresRunRepository(executor).startAgent(INTERVIEW_ID, run),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'constraint_violation', constraint },
      });
      expect(executor.calls).toHaveLength(0);
    }
  });

  it('rejects malformed stored run and reference identities as corrupt data', async () => {
    const workflowExecutor = new ScriptedExecutor([
      queryResult([workflowRow({ ...runningWorkflow, workflowRunId: 'workflow bad' })]),
    ]);
    await expect(
      new PostgresRunRepository(workflowExecutor).loadWorkflow(INTERVIEW_ID, WORKFLOW_ID),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'corrupt_data', resource: 'workflow_run' },
    });

    const stepExecutor = new ScriptedExecutor([
      queryResult([
        stepRow({ ...checkpoint, referencedGuideQuestionIds: [`q${'x'.repeat(128)}`] }),
      ]),
    ]);
    await expect(
      new PostgresRunRepository(stepExecutor).loadStep(INTERVIEW_ID, checkpoint.stepRunId),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'corrupt_data', resource: 'workflow_run' },
    });

    const agentExecutor = new ScriptedExecutor([
      queryResult([agentRow({ ...runningAgent, attemptId: ' attempt-1' })]),
    ]);
    await expect(
      new PostgresRunRepository(agentExecutor).loadAgent(INTERVIEW_ID, runningAgent.agentRunId),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'corrupt_data', resource: 'agent_run' },
    });

    const referenceExecutor = new ScriptedExecutor([referenceScope(['turn bad'], ['question-1'])]);
    await expect(
      new PostgresRunRepository(referenceExecutor).saveStepCheckpoint(
        INTERVIEW_ID,
        ATTEMPT_ID,
        checkpoint,
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'corrupt_data', resource: 'workflow_run' },
    });
    expect(referenceExecutor.calls).toHaveLength(1);
  });

  it('treats an exact repeated workflow start as idempotent', async () => {
    const executor = new ScriptedExecutor([
      queryResult(),
      queryResult([workflowRow(runningWorkflow)]),
    ]);

    await expect(
      new PostgresRunRepository(executor).startWorkflow(INTERVIEW_ID, runningWorkflow),
    ).resolves.toEqual({
      ok: true,
      value: { outcome: 'existing', value: runningWorkflow },
    });
    expect(executor.calls[0]?.statement).toContain('on conflict (id) do nothing');
  });

  it('normalizes new runs and treats equivalent timestamp-offset retries as idempotent', async () => {
    const offsetStartedAt = '2026-08-06T12:00:00.000+02:00';
    const offsetEndedAt = '2026-08-06T12:00:01.000+02:00';
    const offsetRunningWorkflow = { ...runningWorkflow, startedAt: offsetStartedAt };
    const insertedWorkflowExecutor = new ScriptedExecutor([queryResult([{ id: WORKFLOW_ID }])]);
    await expect(
      new PostgresRunRepository(insertedWorkflowExecutor).startWorkflow(
        INTERVIEW_ID,
        offsetRunningWorkflow,
      ),
    ).resolves.toEqual({
      ok: true,
      value: { outcome: 'inserted', value: runningWorkflow },
    });

    const workflowStartExecutor = new ScriptedExecutor([
      queryResult(),
      queryResult([workflowRow(runningWorkflow)]),
    ]);
    await expect(
      new PostgresRunRepository(workflowStartExecutor).startWorkflow(
        INTERVIEW_ID,
        offsetRunningWorkflow,
      ),
    ).resolves.toEqual({
      ok: true,
      value: { outcome: 'existing', value: runningWorkflow },
    });

    const offsetSucceededWorkflow = {
      ...succeededWorkflow,
      startedAt: offsetStartedAt,
      endedAt: offsetEndedAt,
      appliedAt: offsetEndedAt,
    };
    const workflowFinishExecutor = new ScriptedExecutor([
      queryResult(),
      queryResult([workflowRow(succeededWorkflow)]),
    ]);
    await expect(
      new PostgresRunRepository(workflowFinishExecutor).finishWorkflow(
        INTERVIEW_ID,
        WORKFLOW_ID,
        'running',
        offsetSucceededWorkflow,
      ),
    ).resolves.toEqual({ ok: true, value: succeededWorkflow });

    const workflowFailure = {
      code: 'provider_timeout',
      message: 'Provider timed out',
      retryable: true,
      occurredAt: ENDED_AT,
    } as const;
    const failedWorkflow: StoredWorkflowAttempt = {
      ...runningWorkflow,
      status: 'failed',
      endedAt: ENDED_AT,
      durationMs: 1000,
      failure: workflowFailure,
    };
    const offsetFailedWorkflow: StoredWorkflowAttempt = {
      ...failedWorkflow,
      startedAt: offsetStartedAt,
      endedAt: offsetEndedAt,
      failure: { ...workflowFailure, occurredAt: offsetEndedAt },
    };
    const failureExecutor = new ScriptedExecutor([
      queryResult(),
      queryResult([workflowRow(failedWorkflow)]),
    ]);
    await expect(
      new PostgresRunRepository(failureExecutor).finishWorkflow(
        INTERVIEW_ID,
        WORKFLOW_ID,
        'running',
        offsetFailedWorkflow,
      ),
    ).resolves.toEqual({ ok: true, value: failedWorkflow });

    const offsetCheckpoint = {
      ...checkpoint,
      startedAt: offsetStartedAt,
      endedAt: offsetEndedAt,
    };
    const stepExecutor = new ScriptedExecutor([
      referenceScope(),
      queryResult(),
      queryResult([stepRow(checkpoint)]),
    ]);
    await expect(
      new PostgresRunRepository(stepExecutor).saveStepCheckpoint(
        INTERVIEW_ID,
        ATTEMPT_ID,
        offsetCheckpoint,
      ),
    ).resolves.toEqual({
      ok: true,
      value: { outcome: 'existing', value: checkpoint },
    });

    const offsetSucceededAgent = {
      ...succeededAgent,
      startedAt: offsetStartedAt,
      endedAt: offsetEndedAt,
    };
    const agentStartExecutor = new ScriptedExecutor([
      referenceScope(),
      queryResult(),
      queryResult([agentRow(succeededAgent)]),
    ]);
    await expect(
      new PostgresRunRepository(agentStartExecutor).startAgent(INTERVIEW_ID, offsetSucceededAgent),
    ).resolves.toEqual({
      ok: true,
      value: { outcome: 'existing', value: succeededAgent },
    });

    const agentFinishExecutor = new ScriptedExecutor([
      referenceScope(),
      queryResult(),
      queryResult([agentRow(succeededAgent)]),
    ]);
    await expect(
      new PostgresRunRepository(agentFinishExecutor).finishAgent(
        INTERVIEW_ID,
        succeededAgent.agentRunId,
        'running',
        offsetSucceededAgent,
      ),
    ).resolves.toEqual({ ok: true, value: succeededAgent });
  });

  it('finishes a workflow without updating immutable provenance', async () => {
    const executor = new ScriptedExecutor([queryResult([workflowRow(succeededWorkflow)])]);

    await expect(
      new PostgresRunRepository(executor).finishWorkflow(
        INTERVIEW_ID,
        WORKFLOW_ID,
        'running',
        succeededWorkflow,
      ),
    ).resolves.toEqual({ ok: true, value: succeededWorkflow });
    const statement = executor.calls[0]?.statement ?? '';
    const setClause = statement.slice(0, statement.indexOf('where'));
    expect(setClause).not.toContain('job_id =');
    expect(setClause).not.toContain('mastra_attempt_id =');
    expect(setClause).not.toContain('started_at =');
    expect(statement).toContain('and job_id = $13 and mastra_attempt_id = $14');
    expect(executor.calls[0]?.parameters[2]).toBe('running');
  });

  it('rejects a workflow finish that changes immutable provenance', async () => {
    const changed = { ...succeededWorkflow, jobId: 'job-foreign' };
    const executor = new ScriptedExecutor([
      queryResult(),
      queryResult([workflowRow(runningWorkflow)]),
    ]);

    await expect(
      new PostgresRunRepository(executor).finishWorkflow(
        INTERVIEW_ID,
        WORKFLOW_ID,
        'running',
        changed,
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: 'duplicate_conflict', resource: 'workflow_run', identity: WORKFLOW_ID },
    });
    expect(executor.calls[0]?.statement).toContain('job_id = $13');
    expect(executor.calls[1]?.statement).toContain('where interview_id = $1 and id = $2');
  });

  it('persists a step checkpoint only after its references are verified', async () => {
    const executor = new ScriptedExecutor([
      referenceScope(),
      queryResult([{ id: checkpoint.stepRunId }]),
    ]);

    await expect(
      new PostgresRunRepository(executor).saveStepCheckpoint(INTERVIEW_ID, ATTEMPT_ID, checkpoint),
    ).resolves.toEqual({
      ok: true,
      value: { outcome: 'inserted', value: checkpoint },
    });
    expect(executor.calls[0]?.statement).toContain('from app.interviews i');
    expect(executor.calls[0]?.parameters.slice(4)).toEqual([
      checkpoint.agentRunId,
      checkpoint.workflowRunId,
      'coverage_analysis',
      true,
      JSON.stringify(coverageOutput),
    ]);
    expect(executor.calls[1]?.statement).toContain('w.mastra_attempt_id = $17');
    expect(executor.calls[1]?.parameters[3]).toBe(checkpoint.agentRunId);
    expect(executor.calls[1]?.parameters[14]).toBe(
      JSON.stringify({
        referencedTranscriptTurnIds: ['turn-1'],
        referencedGuideQuestionIds: ['question-1'],
      }),
    );
  });

  it('rejects a step whose exact persisted agent attribution does not match', async () => {
    const executor = new ScriptedExecutor([
      referenceScope(['turn-1'], ['question-1'], [], GUIDE_ID, undefined, false),
    ]);

    await expect(
      new PostgresRunRepository(executor).saveStepCheckpoint(INTERVIEW_ID, ATTEMPT_ID, checkpoint),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'constraint_violation',
        constraint: 'workflow_step_agent_attribution',
      },
    });
    expect(executor.calls).toHaveLength(1);
  });

  it('finishes a running agent step with exact attribution and immutable provenance', async () => {
    const executor = new ScriptedExecutor([referenceScope(), queryResult([stepRow(checkpoint)])]);

    await expect(
      new PostgresRunRepository(executor).finishStep(
        INTERVIEW_ID,
        checkpoint.stepRunId,
        'running',
        checkpoint,
      ),
    ).resolves.toEqual({ ok: true, value: checkpoint });

    expect(executor.calls[0]?.parameters.slice(4)).toEqual([
      checkpoint.agentRunId,
      checkpoint.workflowRunId,
      'coverage_analysis',
      true,
      JSON.stringify(coverageOutput),
    ]);
    const statement = executor.calls[1]?.statement ?? '';
    const setClause = statement.slice(0, statement.indexOf('from app.workflow_runs'));
    expect(setClause).not.toContain('workflow_run_id =');
    expect(setClause).not.toContain('step =');
    expect(setClause).not.toContain('attempt_number =');
    expect(setClause).not.toContain('started_at =');
    expect(setClause).not.toContain('input =');
    expect(statement).toContain('s.workflow_run_id = $13 and s.step = $14');
    expect(statement).toContain('s.input = $17::jsonb');
    expect(statement).toContain('w.mastra_attempt_id = $18');
    expect(executor.calls[1]?.parameters[2]).toBe('running');
    expect(executor.calls[1]?.parameters[3]).toBe(checkpoint.agentRunId);
    expect(executor.calls[1]?.parameters[11]).toBe(JSON.stringify(coverageOutput));
  });

  it('treats a repeated identical step finish as idempotent', async () => {
    const executor = new ScriptedExecutor([
      referenceScope(),
      queryResult(),
      queryResult([stepRow(checkpoint)]),
    ]);

    await expect(
      new PostgresRunRepository(executor).finishStep(
        INTERVIEW_ID,
        checkpoint.stepRunId,
        'running',
        checkpoint,
      ),
    ).resolves.toEqual({ ok: true, value: checkpoint });
    expect(executor.calls[2]?.statement).toContain('where s.interview_id = $1 and s.id = $2');
  });

  it('rejects a step finish that changes immutable input provenance', async () => {
    const changed = { ...checkpoint, referencedGuideQuestionIds: ['question-2'] };
    const executor = new ScriptedExecutor([
      referenceScope(['turn-1'], ['question-2']),
      queryResult(),
      queryResult([stepRow(runningCheckpoint)]),
    ]);

    await expect(
      new PostgresRunRepository(executor).finishStep(
        INTERVIEW_ID,
        checkpoint.stepRunId,
        'running',
        changed,
      ),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'duplicate_conflict',
        resource: 'workflow_run',
        identity: checkpoint.stepRunId,
      },
    });
    expect(executor.calls[1]?.statement).toContain('s.input = $17::jsonb');
  });

  it('rejects an agent step finish before SQL when exact attribution is invalid', async () => {
    const executor = new ScriptedExecutor([
      referenceScope(['turn-1'], ['question-1'], [], GUIDE_ID, undefined, false),
    ]);

    await expect(
      new PostgresRunRepository(executor).finishStep(
        INTERVIEW_ID,
        checkpoint.stepRunId,
        'running',
        checkpoint,
      ),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'constraint_violation',
        constraint: 'workflow_step_agent_attribution',
      },
    });
    expect(executor.calls).toHaveLength(1);
  });

  it('finishes failed and deterministic steps without agent attribution or output', async () => {
    const failed: StoredStepCheckpoint = {
      ...runningCheckpoint,
      status: 'failed',
      endedAt: ENDED_AT,
      durationMs: 1000,
      failure: {
        code: 'provider_timeout',
        message: 'Provider timed out',
        retryable: true,
        occurredAt: ENDED_AT,
      },
    };
    const deterministic: StoredStepCheckpoint = {
      ...runningCheckpoint,
      stepRunId: 'step-validation-1',
      step: 'validation',
      status: 'succeeded',
      endedAt: ENDED_AT,
      durationMs: 1000,
    };

    for (const terminal of [failed, deterministic]) {
      const executor = new ScriptedExecutor([referenceScope(), queryResult([stepRow(terminal)])]);
      await expect(
        new PostgresRunRepository(executor).finishStep(
          INTERVIEW_ID,
          terminal.stepRunId,
          'running',
          terminal,
        ),
      ).resolves.toEqual({ ok: true, value: terminal });
      expect(executor.calls[1]?.parameters[3]).toBeNull();
      expect(executor.calls[1]?.parameters[11]).toBeNull();
    }
  });

  it('rejects nonterminal or mismatched step finishes before reading references', async () => {
    for (const [stepRunId, next] of [
      [runningCheckpoint.stepRunId, runningCheckpoint],
      ['step-other', checkpoint],
    ] as const) {
      const executor = new ScriptedExecutor([]);
      await expect(
        new PostgresRunRepository(executor).finishStep(INTERVIEW_ID, stepRunId, 'running', next),
      ).resolves.toEqual({
        ok: false,
        error: { code: 'constraint_violation', constraint: 'workflow_step_finish_shape' },
      });
      expect(executor.calls).toHaveLength(0);
    }
  });

  it.each([
    {
      label: 'cross-interview transcript turn',
      value: { ...checkpoint, referencedTranscriptTurnIds: ['turn-foreign'] },
      scope: referenceScope([], ['question-1']),
      constraint: 'run_reference_transcript_turns',
    },
    {
      label: 'unknown guide question',
      value: { ...checkpoint, referencedGuideQuestionIds: ['question-foreign'] },
      scope: referenceScope(['turn-1'], []),
      constraint: 'run_reference_guide_questions',
    },
  ])('rejects a $label before insert', async ({ value, scope, constraint }) => {
    const executor = new ScriptedExecutor([scope]);

    await expect(
      new PostgresRunRepository(executor).saveStepCheckpoint(INTERVIEW_ID, ATTEMPT_ID, value),
    ).resolves.toEqual({
      ok: false,
      error: { code: 'constraint_violation', constraint },
    });
    expect(executor.calls).toHaveLength(1);
  });

  it('stores validated agent input and matching structured output', async () => {
    const executor = new ScriptedExecutor([
      referenceScope(),
      queryResult([{ id: succeededAgent.agentRunId }]),
    ]);

    await expect(
      new PostgresRunRepository(executor).startAgent(INTERVIEW_ID, succeededAgent),
    ).resolves.toEqual({
      ok: true,
      value: { outcome: 'inserted', value: succeededAgent },
    });
    expect(executor.calls[1]?.statement).toContain('w.mastra_attempt_id = $19');
    expect(executor.calls[1]?.parameters[16]).toBe(JSON.stringify(succeededAgent.validatedInput));
    expect(executor.calls[1]?.parameters[17]).toBe(JSON.stringify(coverageOutput));
  });

  it('finishes an agent without updating immutable input, model, or attribution', async () => {
    const executor = new ScriptedExecutor([
      referenceScope(),
      queryResult([agentRow(succeededAgent)]),
    ]);

    await expect(
      new PostgresRunRepository(executor).finishAgent(
        INTERVIEW_ID,
        succeededAgent.agentRunId,
        'running',
        succeededAgent,
      ),
    ).resolves.toEqual({ ok: true, value: succeededAgent });
    const statement = executor.calls[1]?.statement ?? '';
    const setClause = statement.slice(0, statement.indexOf('from app.workflow_runs'));
    expect(setClause).not.toContain('workflow_run_id =');
    expect(setClause).not.toContain('agent_name =');
    expect(setClause).not.toContain('model_mode =');
    expect(setClause).not.toContain('input =');
    expect(statement).toContain('and a.workflow_run_id = $12 and a.agent_name = $13');
    expect(statement).toContain('and a.input = $19::jsonb');
  });

  it('rejects an agent finish that changes immutable input', async () => {
    const changed = {
      ...succeededAgent,
      validatedInput: { ...succeededAgent.validatedInput, interviewStateVersion: 3 },
    };
    const executor = new ScriptedExecutor([
      referenceScope(),
      queryResult(),
      queryResult([agentRow(runningAgent)]),
    ]);

    await expect(
      new PostgresRunRepository(executor).finishAgent(
        INTERVIEW_ID,
        succeededAgent.agentRunId,
        'running',
        changed,
      ),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'duplicate_conflict',
        resource: 'agent_run',
        identity: succeededAgent.agentRunId,
      },
    });
    expect(executor.calls[1]?.statement).toContain('a.input = $19::jsonb');
    expect(executor.calls[2]?.statement).toContain('where a.interview_id = $1 and a.id = $2');
  });

  it('rejects an unknown reference found only in structured agent output', async () => {
    const output: StructuredAgentOutput = {
      agentName: 'coverage_analysis',
      output: {
        findings: [],
        referencedTranscriptTurnIds: ['turn-foreign'],
        rationale: 'The output references a turn outside the current interview.',
      },
    };
    const run = { ...succeededAgent, validatedOutput: output };
    const executor = new ScriptedExecutor([referenceScope(['turn-1'], ['question-1'])]);

    await expect(
      new PostgresRunRepository(executor).startAgent(INTERVIEW_ID, run),
    ).resolves.toEqual({
      ok: false,
      error: { code: 'constraint_violation', constraint: 'run_output_transcript_provenance' },
    });
    expect(executor.calls).toHaveLength(0);
  });

  it('rejects an existing transcript turn that was not part of the validated agent input', async () => {
    const output: StructuredAgentOutput = {
      agentName: 'coverage_analysis',
      output: {
        findings: [],
        referencedTranscriptTurnIds: ['turn-2'],
        rationale: 'The output cites an existing turn that the agent did not receive.',
      },
    };
    const run = { ...succeededAgent, validatedOutput: output };
    const executor = new ScriptedExecutor([]);

    await expect(
      new PostgresRunRepository(executor).startAgent(INTERVIEW_ID, run),
    ).resolves.toEqual({
      ok: false,
      error: { code: 'constraint_violation', constraint: 'run_output_transcript_provenance' },
    });
    expect(executor.calls).toHaveLength(0);
  });

  it('rejects a guide question that was not part of the validated agent input', async () => {
    const output: StructuredAgentOutput = {
      agentName: 'coverage_analysis',
      output: {
        findings: [
          {
            question: {
              kind: 'main_question',
              guideId: GUIDE_ID,
              sectionId: 'section-1',
              mainQuestionId: 'question-2',
            },
            status: 'not_addressed',
            transcriptTurnIds: [],
            openAspects: ['The question has not been addressed.'],
            rationale: 'No evidence was available.',
          },
        ],
        referencedTranscriptTurnIds: [],
        rationale: 'The output considered another guide question.',
      },
    };
    const run = { ...succeededAgent, validatedOutput: output };
    const executor = new ScriptedExecutor([]);

    await expect(
      new PostgresRunRepository(executor).startAgent(INTERVIEW_ID, run),
    ).resolves.toEqual({
      ok: false,
      error: { code: 'constraint_violation', constraint: 'run_output_guide_provenance' },
    });
    expect(executor.calls).toHaveLength(0);
  });

  it('rejects a canonical entry that was not part of finalization agent input', async () => {
    const output: StructuredAgentOutput = {
      agentName: 'transcript_finalization',
      output: {
        status: 'valid',
        checkedCanonicalEntries: [{ entryId: 'entry-2', kind: 'turn' }],
        checks: {
          chronologyValid: true,
          sequenceValid: true,
          speakerAssignmentsValid: true,
          noDuplicateTurns: true,
        },
        issues: [],
        rationale: 'The transcript is structurally valid.',
      },
    };
    const run: StoredAgentRun = {
      ...succeededAgent,
      agentName: 'transcript_finalization',
      validatedInput: {
        ...succeededAgent.validatedInput,
        transcriptTurnIds: [],
        guideQuestionIds: [],
        canonicalEntryIds: ['entry-1'],
      },
      validatedOutput: output,
    };
    const executor = new ScriptedExecutor([]);

    await expect(
      new PostgresRunRepository(executor).startAgent(INTERVIEW_ID, run),
    ).resolves.toEqual({
      ok: false,
      error: { code: 'constraint_violation', constraint: 'run_output_canonical_provenance' },
    });
    expect(executor.calls).toHaveLength(0);
  });

  it('rejects a structured question whose section hierarchy differs from the guide', async () => {
    const output: StructuredAgentOutput = {
      agentName: 'coverage_analysis',
      output: {
        findings: [
          {
            question: {
              kind: 'main_question',
              guideId: GUIDE_ID,
              sectionId: 'section-invented',
              mainQuestionId: 'question-1',
            },
            status: 'not_addressed',
            transcriptTurnIds: [],
            openAspects: ['The main question has not been addressed.'],
            rationale: 'No matching participant evidence was found.',
          },
        ],
        referencedTranscriptTurnIds: [],
        rationale: 'The question remains open.',
      },
    };
    const run = {
      ...succeededAgent,
      validatedInput: {
        ...succeededAgent.validatedInput,
        transcriptTurnIds: [],
      },
      validatedOutput: output,
    };
    const executor = new ScriptedExecutor([
      referenceScope([], ['question-1'], [], GUIDE_ID, [
        {
          questionId: 'question-1',
          kind: 'main_question',
          sectionId: 'section-1',
          mainQuestionId: 'question-1',
        },
      ]),
    ]);

    await expect(
      new PostgresRunRepository(executor).startAgent(INTERVIEW_ID, run),
    ).resolves.toEqual({
      ok: false,
      error: { code: 'constraint_violation', constraint: 'run_reference_question_hierarchy' },
    });
    expect(executor.calls).toHaveLength(1);
  });

  it('rejects mismatched agent output before issuing SQL', async () => {
    const run: StoredAgentRun = {
      ...succeededAgent,
      agentName: 'interview_conductor',
    };
    const executor = new ScriptedExecutor([]);

    await expect(
      new PostgresRunRepository(executor).startAgent(INTERVIEW_ID, run),
    ).resolves.toEqual({
      ok: false,
      error: { code: 'constraint_violation', constraint: 'agent_output' },
    });
    expect(executor.calls).toEqual([]);
  });
});
