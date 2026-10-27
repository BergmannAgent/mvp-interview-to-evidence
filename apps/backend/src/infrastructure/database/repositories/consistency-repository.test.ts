import { describe, expect, it } from 'vitest';

import { PostgresConsistencyRepository } from './consistency-repository.js';
import type { SqlExecutor, SqlQueryResult } from './sql.js';
import type { StoredContradiction } from '../../../application/persistence/index.js';

const detected: StoredContradiction = {
  interviewId: 'interview-1',
  contradictionId: 'contradiction-1',
  workflowRunId: 'workflow-1',
  agentRunId: 'agent-consistency-1',
  description: 'The reported timing differs between two answers.',
  suggestedClarificationQuestion: 'Können Sie den zeitlichen Ablauf bitte präzisieren?',
  shouldClarify: true,
  rationale: 'Two final participant turns contain different dates.',
  referencedTranscriptTurnIds: ['turn-2', 'turn-4'],
  status: 'detected',
  askedTurnId: null,
  createdAt: '2026-08-06T10:00:00.000Z',
  updatedAt: '2026-08-06T10:00:00.000Z',
};

const consistencyOutput = {
  agentName: 'consistency_analysis' as const,
  output: {
    contradictions: [
      {
        id: detected.contradictionId,
        transcriptTurnIds: detected.referencedTranscriptTurnIds,
        description: detected.description,
        suggestedClarificationQuestion: detected.suggestedClarificationQuestion,
        shouldClarify: detected.shouldClarify,
        rationale: detected.rationale,
      },
    ],
    referencedTranscriptTurnIds: detected.referencedTranscriptTurnIds,
    rationale: 'A possible timeline conflict requires neutral clarification.',
  },
};

class ScriptedExecutor implements SqlExecutor {
  readonly calls: Array<{ readonly sql: string; readonly parameters: readonly unknown[] }> = [];

  public constructor(private readonly results: SqlQueryResult[]) {}

  public async query(sql: string, parameters: readonly unknown[] = []): Promise<SqlQueryResult> {
    this.calls.push({ sql, parameters });
    const result = this.results.shift();
    if (result === undefined) throw new Error('Unexpected SQL query');
    return result;
  }
}

function row(value: StoredContradiction): Record<string, unknown> {
  return {
    interviewId: value.interviewId,
    contradictionId: value.contradictionId,
    workflowRunId: value.workflowRunId,
    agentRunId: value.agentRunId,
    description: value.description,
    suggestedClarificationQuestion: value.suggestedClarificationQuestion,
    shouldClarify: value.shouldClarify,
    rationale: value.rationale,
    status: value.status,
    askedTurnId: value.askedTurnId,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    referencedTranscriptTurnIds: [...value.referencedTranscriptTurnIds].sort(),
  };
}

describe('PostgresConsistencyRepository', () => {
  it.each([
    ['runtime Date', { createdAt: new Date(detected.createdAt) as unknown as string }],
    ['invalid timestamp', { updatedAt: 'not-a-timestamp' }],
  ])('rejects a %s at the contradiction write boundary before SQL', async (_label, override) => {
    const executor = new ScriptedExecutor([]);

    await expect(
      new PostgresConsistencyRepository(executor).createContradiction('interview-1', {
        ...detected,
        ...override,
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: 'constraint_violation', constraint: 'contradiction_shape' },
    });
    expect(executor.calls).toHaveLength(0);
  });

  it('persists a contradiction only from the matching validated consistency output', async () => {
    const executor = new ScriptedExecutor([
      { rows: [{ output: consistencyOutput }], rowCount: 1 },
      { rows: [{ count: 2 }], rowCount: 1 },
      { rows: [{ id: detected.contradictionId }], rowCount: 1 },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
    ]);

    await expect(
      new PostgresConsistencyRepository(executor).createContradiction('interview-1', detected),
    ).resolves.toEqual({ ok: true, value: { outcome: 'inserted', value: detected } });
    expect(
      executor.calls.filter((call) => call.sql.includes('contradiction_turn_references')),
    ).toHaveLength(2);
  });

  it('rejects a contradiction absent from the agent output', async () => {
    const executor = new ScriptedExecutor([
      {
        rows: [
          {
            output: {
              ...consistencyOutput,
              output: { ...consistencyOutput.output, contradictions: [] },
            },
          },
        ],
        rowCount: 1,
      },
    ]);
    await expect(
      new PostgresConsistencyRepository(executor).createContradiction('interview-1', detected),
    ).resolves.toEqual({
      ok: false,
      error: { code: 'constraint_violation', constraint: 'contradiction_agent_output_mismatch' },
    });
  });

  it('loads persisted evidence in stable order', async () => {
    const executor = new ScriptedExecutor([{ rows: [row(detected)], rowCount: 1 }]);
    await expect(
      new PostgresConsistencyRepository(executor).loadContradiction(
        detected.interviewId,
        detected.contradictionId,
      ),
    ).resolves.toEqual({
      ok: true,
      value: { ...detected, referencedTranscriptTurnIds: ['turn-2', 'turn-4'] },
    });
  });

  it('marks a contradiction asked only with an AI clarification turn', async () => {
    const asked: StoredContradiction = {
      ...detected,
      status: 'asked',
      askedTurnId: 'turn-clarification',
      updatedAt: '2026-08-06T10:01:00.000Z',
    };
    const executor = new ScriptedExecutor([
      { rows: [row(detected)], rowCount: 1 },
      { rows: [{ count: 1 }], rowCount: 1 },
      { rows: [{ id: detected.contradictionId }], rowCount: 1 },
    ]);
    await expect(
      new PostgresConsistencyRepository(executor).transitionContradiction(
        detected.interviewId,
        detected.contradictionId,
        'detected',
        asked,
      ),
    ).resolves.toEqual({ ok: true, value: asked });
    expect(executor.calls[1]?.sql).toContain("turn_type = 'clarification_question'");
  });

  it('does not allow immutable provenance to change during a transition', async () => {
    const changed: StoredContradiction = {
      ...detected,
      workflowRunId: 'workflow-other',
      status: 'dismissed',
      updatedAt: '2026-08-06T10:01:00.000Z',
    };
    const executor = new ScriptedExecutor([{ rows: [row(detected)], rowCount: 1 }]);
    await expect(
      new PostgresConsistencyRepository(executor).transitionContradiction(
        detected.interviewId,
        detected.contradictionId,
        'detected',
        changed,
      ),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'duplicate_conflict',
        resource: 'contradiction',
        identity: detected.contradictionId,
      },
    });
  });

  it('does not move the contradiction update timestamp backwards', async () => {
    const current: StoredContradiction = {
      ...detected,
      updatedAt: '2026-08-06T10:02:00.000Z',
    };
    const regressed: StoredContradiction = {
      ...current,
      status: 'dismissed',
      updatedAt: '2026-08-06T10:01:00.000Z',
    };
    const executor = new ScriptedExecutor([{ rows: [row(current)], rowCount: 1 }]);

    await expect(
      new PostgresConsistencyRepository(executor).transitionContradiction(
        detected.interviewId,
        detected.contradictionId,
        'detected',
        regressed,
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: 'constraint_violation', constraint: 'contradiction_timestamp_regression' },
    });
    expect(executor.calls).toHaveLength(1);
  });
});
