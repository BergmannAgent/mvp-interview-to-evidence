import type { PersistedInterview } from '../../../application/persistence/index.js';
import { describe, expect, it } from 'vitest';

import { PostgresInterviewRepository } from './interview-repository.js';
import { COMPARE_AND_SWAP_STATE_SQL, TRANSITION_GUARD_SELECT } from './interview-repository-sql.js';
import type { SqlExecutor, SqlQueryResult } from './sql.js';

const INTERVIEW_ID = 'interview-completion-guard';
const GUIDE_ID = 'guide:v1:completion-guard';
const CREATED_AT = '2026-08-06T10:00:00.000Z';
const ENDING_AT = '2026-08-06T10:10:00.000Z';
const ENDED_AT = '2026-08-06T10:11:00.000Z';

describe('interview terminal-transition transcript guards', () => {
  it.each([
    ['completed', completedInterview],
    ['failed', failedInterview],
  ] as const)(
    'returns the unresolved STT identity before transitioning to %s',
    async (_status, nextInterview) => {
      const executor = new SingleResultExecutor({
        rows: [
          endingGuardRow({
            unresolvedPartialProvider: 'demo-stt',
            unresolvedPartialSegmentId: 'segment-pending',
            unresolvedPartialUtteranceId: 'utterance-pending',
          }),
        ],
        rowCount: 1,
      });

      const result = await new PostgresInterviewRepository(executor).compareAndSwap(
        INTERVIEW_ID,
        2,
        nextInterview(),
      );

      expect(result).toEqual({
        ok: false,
        error: {
          code: 'unresolved_transcript_partial',
          interviewId: INTERVIEW_ID,
          provider: 'demo-stt',
          segmentId: 'segment-pending',
          utteranceId: 'utterance-pending',
        },
      });
      expect(executor.statements).toHaveLength(1);
      expect(normalizeSql(executor.statements[0]!)).toContain('for update of st, c');
    },
  );

  it('returns the pending AI delivery before a legal failure transition', async () => {
    const executor = new SingleResultExecutor({
      rows: [
        endingGuardRow({
          pendingDeliveryId: 'delivery-pending',
          pendingReservedSequenceNumber: 7,
        }),
      ],
      rowCount: 1,
    });

    const result = await new PostgresInterviewRepository(executor).compareAndSwap(
      INTERVIEW_ID,
      2,
      failedInterview(),
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'pending_ai_delivery',
        interviewId: INTERVIEW_ID,
        deliveryId: 'delivery-pending',
        reservedSequenceNumber: 7,
      },
    });
    expect(executor.statements).toHaveLength(1);
    expect(normalizeSql(executor.statements[0]!)).toContain('for update of st, c');
  });

  it('uses the same provider-scoped resolution guard for completed and failed states', () => {
    for (const statement of [TRANSITION_GUARD_SELECT, COMPARE_AND_SWAP_STATE_SQL]) {
      const sql = normalizeSql(statement);
      expect(sql).toContain("p.disposition in ('accepted', 'updated')");
      expect(sql).toContain('f.provider = p.provider');
      expect(sql).toContain('(f.segment_id = p.segment_id or f.utterance_id = p.utterance_id)');
      expect(sql).toContain("g.source = 'speech_to_text'");
      expect(sql).toContain('g.provider = p.provider');
      expect(sql).toContain(
        '(g.related_segment_id = p.segment_id or g.related_utterance_id = p.utterance_id)',
      );
    }
    expect(normalizeSql(COMPARE_AND_SWAP_STATE_SQL)).toContain(
      "and ($3 not in ('completed', 'failed') or ( not exists",
    );
  });
});

class SingleResultExecutor implements SqlExecutor {
  public readonly statements: string[] = [];

  public constructor(private readonly result: SqlQueryResult) {}

  public async query(statement: string): Promise<SqlQueryResult> {
    this.statements.push(statement);
    if (this.statements.length > 1) {
      throw new Error('Terminal-transition guard rejection must not issue another query');
    }
    return this.result;
  }
}

function completedInterview(): PersistedInterview {
  return {
    interviewId: INTERVIEW_ID,
    guideId: GUIDE_ID,
    lifecycle: {
      status: 'completed',
      interviewId: INTERVIEW_ID,
      guideId: GUIDE_ID,
      createdAt: CREATED_AT,
      revision: 3,
      startedAt: CREATED_AT,
      endingAt: ENDING_AT,
      endedAt: ENDED_AT,
    },
    coverage: {
      interviewId: INTERVIEW_ID,
      guideId: GUIDE_ID,
      revision: 0,
      questions: [
        {
          questionId: 'main-question-1',
          kind: 'main',
          mainQuestionId: 'main-question-1',
          status: 'not_addressed',
          referencedTurnIds: [],
          updatedAt: null,
        },
      ],
    },
    version: 3,
    activeWorkflowRunId: null,
    createdAt: CREATED_AT,
    updatedAt: ENDED_AT,
  };
}

function failedInterview(): PersistedInterview {
  const completed = completedInterview();
  return {
    ...completed,
    lifecycle: {
      status: 'failed',
      interviewId: INTERVIEW_ID,
      guideId: GUIDE_ID,
      createdAt: CREATED_AT,
      revision: 3,
      startedAt: CREATED_AT,
      failedAt: ENDED_AT,
      failedFrom: 'ending',
      failure: {
        code: 'provider_failure',
        message: 'The provider failed while the interview was ending.',
      },
    },
  };
}

function endingGuardRow(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    interview_id: INTERVIEW_ID,
    guide_id: GUIDE_ID,
    interview_created_at: CREATED_AT,
    status: 'ending',
    state_version: 2,
    coverage_version: 0,
    current_main_question_id: null,
    active_workflow_run_id: null,
    state_created_at: CREATED_AT,
    updated_at: ENDING_AT,
    started_at: CREATED_AT,
    active_since: null,
    paused_at: null,
    ending_at: ENDING_AT,
    ending_from: 'active',
    ended_at: null,
    failed_at: null,
    failed_from: null,
    failure_code: null,
    failure_message: null,
    pendingDeliveryId: null,
    pendingReservedSequenceNumber: null,
    unresolvedPartialProvider: null,
    unresolvedPartialSegmentId: null,
    unresolvedPartialUtteranceId: null,
    ...overrides,
  };
}

function normalizeSql(statement: string): string {
  return statement.replace(/\s+/gu, ' ').trim().toLowerCase();
}
