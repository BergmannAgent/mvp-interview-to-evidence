import type { SectionMemory } from '@orgscience/contracts';
import type { GuideCoverageState, InterviewLifecycleState } from '@orgscience/domain';
import { describe, expect, it } from 'vitest';

import type { PersistedInterview } from '../../../application/persistence/index.js';
import { PostgresInterviewRepository } from './interview-repository.js';
import {
  validateInterviewInput,
  validateInterviewTransition,
} from './interview-repository-values.js';
import type { SqlExecutor, SqlQueryResult } from './sql.js';

const INTERVIEW_ID = 'interview-1';
const GUIDE_ID = 'guide:v1:test';
const CREATED_AT = '2026-08-06T10:00:00.000Z';
const UPDATED_AT = '2026-08-06T10:01:00.000Z';
const OFFSET_CREATED_AT = '2026-08-06T12:00:00.000+02:00';
const OFFSET_UPDATED_AT = '2026-08-06T12:01:00.000+02:00';

describe('PostgresInterviewRepository', () => {
  it('round-trips active lifecycle state, ordered coverage, and evidence', async () => {
    const expected = activeInterview();
    const executor = new ScriptedSqlExecutor([
      query(/from app\.interviews i/u, { rows: [activeStateRow()], rowCount: 1 }),
      query(/from app\.interviews i/u, { rows: activeCoverageRows(), rowCount: 3 }),
    ]);

    const result = await new PostgresInterviewRepository(executor).load(INTERVIEW_ID);

    expect(result).toEqual({ ok: true, value: expected });
    expect(executor.calls.every((call) => call.parameters[0] === INTERVIEW_ID)).toBe(true);
    expect(executor.calls.every((call) => call.statement.includes('where i.id = $1'))).toBe(true);
    executor.assertComplete();
  });

  it('restores section memories with their interview and guide scope', async () => {
    const memory = sectionMemory();
    const executor = new ScriptedSqlExecutor([
      query(/from app\.interviews i/u, {
        rows: [{ ...activeStateRow(), section_memories: [memory] }],
        rowCount: 1,
      }),
      query(/from app\.interviews i/u, { rows: activeCoverageRows(), rowCount: 3 }),
    ]);

    await expect(new PostgresInterviewRepository(executor).load(INTERVIEW_ID)).resolves.toEqual({
      ok: true,
      value: { ...activeInterview(), sectionMemories: [memory] },
    });
    executor.assertComplete();
  });

  it('loads a reactivated current question with its prior evidence', async () => {
    const active = activeInterview();
    const expected: PersistedInterview = {
      ...active,
      coverage: {
        ...active.coverage,
        questions: active.coverage.questions.map((question) =>
          question.questionId === 'follow-1'
            ? { ...question, referencedTurnIds: ['turn-3'] }
            : question,
        ),
      },
    };
    const rows = activeCoverageRows().map((row) =>
      row.question_id === 'follow-1' ? { ...row, referenced_turn_id: 'turn-3' } : row,
    );
    const executor = new ScriptedSqlExecutor([
      query(/from app\.interviews i/u, { rows: [activeStateRow()], rowCount: 1 }),
      query(/from app\.interviews i/u, { rows, rowCount: rows.length }),
    ]);

    const result = await new PostgresInterviewRepository(executor).load(INTERVIEW_ID);

    expect(result).toEqual({ ok: true, value: expected });
    executor.assertComplete();
  });

  it('maps all terminal and transitional lifecycle variants', async () => {
    const cases: readonly {
      readonly row: StateDatabaseRow;
      readonly expected: InterviewLifecycleState;
    }[] = [
      {
        row: readyStateRow(),
        expected: readyInterview().lifecycle,
      },
      {
        row: lifecycleOnlyRow({
          ...activeStateRow(),
          status: 'paused',
          active_since: null,
          paused_at: UPDATED_AT,
        }),
        expected: {
          status: 'paused',
          interviewId: INTERVIEW_ID,
          guideId: GUIDE_ID,
          createdAt: CREATED_AT,
          revision: 1,
          startedAt: CREATED_AT,
          pausedAt: UPDATED_AT,
        },
      },
      {
        row: lifecycleOnlyRow({
          ...activeStateRow(),
          status: 'ending',
          active_since: null,
          ending_at: UPDATED_AT,
          ending_from: 'active',
        }),
        expected: {
          status: 'ending',
          interviewId: INTERVIEW_ID,
          guideId: GUIDE_ID,
          createdAt: CREATED_AT,
          revision: 1,
          startedAt: CREATED_AT,
          endingAt: UPDATED_AT,
          endingFrom: 'active',
        },
      },
      {
        row: lifecycleOnlyRow({
          ...activeStateRow(),
          status: 'completed',
          active_since: null,
          ending_at: UPDATED_AT,
          ended_at: '2026-08-06T10:02:00.000Z',
          updated_at: '2026-08-06T10:02:00.000Z',
        }),
        expected: {
          status: 'completed',
          interviewId: INTERVIEW_ID,
          guideId: GUIDE_ID,
          createdAt: CREATED_AT,
          revision: 1,
          startedAt: CREATED_AT,
          endingAt: UPDATED_AT,
          endedAt: '2026-08-06T10:02:00.000Z',
        },
      },
      {
        row: lifecycleOnlyRow({
          ...activeStateRow(),
          status: 'failed',
          active_since: null,
          failed_at: UPDATED_AT,
          failed_from: 'active',
          failure_code: 'PROVIDER_ERROR',
          failure_message: 'Provider failed',
        }),
        expected: {
          status: 'failed',
          interviewId: INTERVIEW_ID,
          guideId: GUIDE_ID,
          createdAt: CREATED_AT,
          revision: 1,
          startedAt: CREATED_AT,
          failedAt: UPDATED_AT,
          failedFrom: 'active',
          failure: { code: 'PROVIDER_ERROR', message: 'Provider failed' },
        },
      },
    ];

    for (const lifecycleCase of cases) {
      const executor = new ScriptedSqlExecutor([
        query(/from app\.interviews i/u, { rows: [lifecycleCase.row], rowCount: 1 }),
        query(/from app\.interviews i/u, { rows: readyCoverageRows(), rowCount: 2 }),
      ]);
      const result = await new PostgresInterviewRepository(executor).load(INTERVIEW_ID);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.lifecycle).toEqual(lifecycleCase.expected);
      }
    }
  });

  it('locks only the requested interview state before loading its coverage', async () => {
    const executor = new ScriptedSqlExecutor([
      query(/for update of i, st/u, { rows: [readyStateRow()], rowCount: 1 }),
      query(/from app\.interviews i/u, { rows: readyCoverageRows(), rowCount: 2 }),
    ]);

    const result = await new PostgresInterviewRepository(executor).lock(INTERVIEW_ID);

    expect(result.ok).toBe(true);
    expect(executor.calls[0]?.statement).toContain('where i.id = $1');
    expect(executor.calls[0]?.statement).toContain('for update of i, st');
    expect(executor.calls.map((call) => call.parameters)).toEqual([[INTERVIEW_ID], [INTERVIEW_ID]]);
  });

  it('creates state, counters, and coverage without opening its own transaction', async () => {
    const interview = readyInterview();
    const executor = new ScriptedSqlExecutor([
      query(/from app\.guide_questions q/u, { rows: guideQuestionShapeRows(), rowCount: 2 }),
      query(/insert into app\.interviews/u, {
        rows: [{ interview_id: INTERVIEW_ID }],
        rowCount: 1,
      }),
      query(/insert into app\.interview_state/u, {
        rows: [{ interview_id: INTERVIEW_ID }],
        rowCount: 1,
      }),
      query(/insert into app\.interview_counters/u, {
        rows: [{ interview_id: INTERVIEW_ID }],
        rowCount: 1,
      }),
      query(/delete from app\.coverage_turn_references/u, { rows: [], rowCount: 0 }),
      query(/delete from app\.question_coverage/u, { rows: [], rowCount: 0 }),
      query(/insert into app\.question_coverage/u, {
        rows: [{ question_id: 'main-1' }, { question_id: 'follow-1' }],
        rowCount: 2,
      }),
    ]);

    const result = await new PostgresInterviewRepository(executor).create(INTERVIEW_ID, interview);

    expect(result).toEqual({ ok: true, value: { outcome: 'inserted', value: interview } });
    expect(
      executor.calls.some((call) => /\b(begin|commit|rollback)\b/iu.test(call.statement)),
    ).toBe(false);
    expect(executor.calls[0]?.parameters).toEqual([GUIDE_ID]);
    expect(executor.calls.slice(1).every((call) => call.parameters[0] === INTERVIEW_ID)).toBe(true);
    executor.assertComplete();
  });

  it('rejects create coverage that is not the exact persisted guide question shape', async () => {
    const missingQuestion = readyInterview();
    const extraQuestion = readyInterview();
    const wrongKind = readyInterview();
    const cases: readonly PersistedInterview[] = [
      {
        ...missingQuestion,
        coverage: {
          ...missingQuestion.coverage,
          questions: missingQuestion.coverage.questions.slice(0, 1),
        },
      },
      {
        ...extraQuestion,
        coverage: {
          ...extraQuestion.coverage,
          questions: [
            ...extraQuestion.coverage.questions,
            {
              questionId: 'main-extra',
              kind: 'main',
              mainQuestionId: 'main-extra',
              status: 'not_addressed',
              referencedTurnIds: [],
              updatedAt: null,
            },
          ],
        },
      },
      {
        ...wrongKind,
        coverage: {
          ...wrongKind.coverage,
          questions: wrongKind.coverage.questions.map((question) =>
            question.questionId === 'follow-1'
              ? { ...question, kind: 'main' as const, mainQuestionId: 'follow-1' }
              : question,
          ),
        },
      },
    ];

    for (const interview of cases) {
      const executor = new ScriptedSqlExecutor([
        query(/from app\.guide_questions q/u, { rows: guideQuestionShapeRows(), rowCount: 2 }),
      ]);
      await expect(
        new PostgresInterviewRepository(executor).create(INTERVIEW_ID, interview),
      ).resolves.toEqual({
        ok: false,
        error: {
          code: 'constraint_violation',
          constraint: 'interview_repository_guide_coverage',
        },
      });
      executor.assertComplete();
    }
  });

  it('returns an identical existing interview but rejects a conflicting duplicate', async () => {
    const existingExecutor = new ScriptedSqlExecutor([
      query(/from app\.guide_questions q/u, { rows: guideQuestionShapeRows(), rowCount: 2 }),
      query(/insert into app\.interviews/u, { rows: [], rowCount: 0 }),
      query(/from app\.interviews i/u, { rows: [readyStateRow()], rowCount: 1 }),
      query(/from app\.interviews i/u, { rows: readyCoverageRows(), rowCount: 2 }),
    ]);
    const existing = await new PostgresInterviewRepository(existingExecutor).create(
      INTERVIEW_ID,
      readyInterview(),
    );
    expect(existing).toEqual({
      ok: true,
      value: { outcome: 'existing', value: readyInterview() },
    });

    const conflictExecutor = new ScriptedSqlExecutor([
      query(/from app\.guide_questions q/u, { rows: guideQuestionShapeRows(), rowCount: 2 }),
      query(/insert into app\.interviews/u, { rows: [], rowCount: 0 }),
      query(/from app\.interviews i/u, { rows: [readyStateRow()], rowCount: 1 }),
      query(/from app\.interviews i/u, { rows: readyCoverageRows(), rowCount: 2 }),
    ]);
    const conflict = await new PostgresInterviewRepository(conflictExecutor).create(INTERVIEW_ID, {
      ...readyInterview(),
      activeWorkflowRunId: 'workflow-elsewhere',
    });
    expect(conflict).toEqual({
      ok: false,
      error: { code: 'duplicate_conflict', resource: 'interview', identity: INTERVIEW_ID },
    });
  });

  it('uses state-version CAS and replaces only the target interview coverage', async () => {
    const next = activeInterview();
    const executor = new ScriptedSqlExecutor([
      query(/for update of st, c/u, {
        rows: [transitionGuardRow()],
        rowCount: 1,
      }),
      query(/from app\.interviews i/u, { rows: readyCoverageRows(), rowCount: 2 }),
      query(/update app\.interview_state/u, {
        rows: [{ interview_id: INTERVIEW_ID }],
        rowCount: 1,
      }),
      query(/delete from app\.coverage_turn_references/u, { rows: [], rowCount: 0 }),
      query(/delete from app\.question_coverage/u, { rows: [], rowCount: 2 }),
      query(/insert into app\.question_coverage/u, {
        rows: [{ question_id: 'main-1' }, { question_id: 'follow-1' }],
        rowCount: 2,
      }),
      query(/insert into app\.coverage_turn_references/u, {
        rows: [
          { question_id: 'main-1', turn_id: 'turn-1' },
          { question_id: 'main-1', turn_id: 'turn-2' },
        ],
        rowCount: 2,
      }),
    ]);

    const result = await new PostgresInterviewRepository(executor).compareAndSwap(
      INTERVIEW_ID,
      0,
      next,
    );

    expect(result).toEqual({ ok: true, value: next });
    expect(executor.calls[0]?.statement).toContain('for update of st, c');
    expect(executor.calls[1]?.statement).toContain('where i.id = $1');
    expect(executor.calls[2]?.statement).toContain('where interview_id = $1');
    expect(executor.calls[2]?.statement).toContain('and state_version = $2');
    expect(executor.calls[2]?.parameters.slice(0, 2)).toEqual([INTERVIEW_ID, 0]);
    expect(executor.calls[2]?.parameters[7]).toBe('[]');
    expect(executor.calls.every((call) => call.parameters[0] === INTERVIEW_ID)).toBe(true);
    executor.assertComplete();
  });

  it('allows immutable memory append but rejects removal or replacement', () => {
    const current = activeInterview();
    const withMemory = advanceActiveState(current, [sectionMemory()]);
    expect(validateInterviewTransition(current, withMemory)).toBeNull();
    expect(
      validateInterviewTransition(
        withMemory,
        advanceActiveState(withMemory, [{ ...sectionMemory(), sectionTitle: 'Manipuliert' }]),
      ),
    ).toBe('interview_repository_section_memories_immutable');
    expect(validateInterviewTransition(withMemory, advanceActiveState(withMemory, []))).toBe(
      'interview_repository_section_memories_immutable',
    );
  });

  it('rejects section memories on initial ready state instead of silently dropping them', async () => {
    const executor = new ScriptedSqlExecutor([]);
    const ready = { ...readyInterview(), sectionMemories: [sectionMemory()] };

    await expect(
      new PostgresInterviewRepository(executor).create(INTERVIEW_ID, ready),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'constraint_violation',
        constraint: 'interview_repository_initial_section_memories',
      },
    });
    executor.assertComplete();
  });

  it('accepts equivalent ISO offsets across ready-to-active CAS validation', () => {
    const base = activeInterview();
    if (base.lifecycle.status !== 'active') throw new Error('Expected active fixture');
    const next: PersistedInterview = {
      ...base,
      lifecycle: {
        ...base.lifecycle,
        createdAt: OFFSET_CREATED_AT,
        startedAt: OFFSET_CREATED_AT,
        activeSince: OFFSET_CREATED_AT,
      },
      coverage: {
        ...base.coverage,
        questions: base.coverage.questions.map((question) => ({
          ...question,
          updatedAt: question.updatedAt === null ? null : OFFSET_UPDATED_AT,
        })),
      },
      createdAt: CREATED_AT,
      updatedAt: OFFSET_UPDATED_AT,
    };

    expect(validateInterviewInput(INTERVIEW_ID, next)).toBeNull();
    expect(validateInterviewTransition(readyInterview(), next)).toBeNull();
  });

  it('treats equivalent coverage and lifecycle timestamps as equal after normalization', () => {
    const current = activeInterview();
    if (current.lifecycle.status !== 'active') throw new Error('Expected active fixture');
    const next: PersistedInterview = {
      ...current,
      lifecycle: {
        ...current.lifecycle,
        createdAt: OFFSET_CREATED_AT,
        revision: current.lifecycle.revision + 1,
        startedAt: OFFSET_CREATED_AT,
        activeSince: OFFSET_CREATED_AT,
      },
      coverage: {
        ...current.coverage,
        questions: current.coverage.questions.map((question) => ({
          ...question,
          updatedAt: question.updatedAt === null ? null : OFFSET_UPDATED_AT,
        })),
      },
      version: current.version + 1,
      createdAt: OFFSET_CREATED_AT,
      updatedAt: OFFSET_UPDATED_AT,
    };

    expect(validateInterviewInput(INTERVIEW_ID, next)).toBeNull();
    expect(validateInterviewTransition(current, next)).toBeNull();
  });

  it('allows a same-lifecycle CAS with a valid forward coverage transition', async () => {
    const current = activeInterview();
    const next: PersistedInterview = {
      ...current,
      lifecycle: { ...current.lifecycle, revision: 2 },
      coverage: {
        ...current.coverage,
        revision: 2,
        questions: current.coverage.questions.map((question) =>
          question.questionId === 'follow-1'
            ? {
                ...question,
                status: 'answered' as const,
                referencedTurnIds: ['turn-3'],
              }
            : question,
        ),
      },
      version: 2,
    };
    const executor = new ScriptedSqlExecutor([
      query(/for update of st, c/u, {
        rows: [transitionGuardRow({ state: activeStateRow() })],
        rowCount: 1,
      }),
      query(/from app\.interviews i/u, { rows: activeCoverageRows(), rowCount: 3 }),
      query(/update app\.interview_state/u, {
        rows: [{ interview_id: INTERVIEW_ID }],
        rowCount: 1,
      }),
      query(/delete from app\.coverage_turn_references/u, { rows: [], rowCount: 2 }),
      query(/delete from app\.question_coverage/u, { rows: [], rowCount: 2 }),
      query(/insert into app\.question_coverage/u, {
        rows: [{ question_id: 'main-1' }, { question_id: 'follow-1' }],
        rowCount: 2,
      }),
      query(/insert into app\.coverage_turn_references/u, {
        rows: [
          { question_id: 'main-1', turn_id: 'turn-1' },
          { question_id: 'main-1', turn_id: 'turn-2' },
          { question_id: 'follow-1', turn_id: 'turn-3' },
        ],
        rowCount: 3,
      }),
    ]);

    await expect(
      new PostgresInterviewRepository(executor).compareAndSwap(INTERVIEW_ID, 1, next),
    ).resolves.toEqual({ ok: true, value: next });
    executor.assertComplete();
  });

  it('allows partially answered coverage to become current while retaining evidence', () => {
    const active = activeInterview();
    const current: PersistedInterview = {
      ...active,
      coverage: {
        ...active.coverage,
        questions: active.coverage.questions.map((question) =>
          question.questionId === 'follow-1'
            ? {
                ...question,
                status: 'partially_answered' as const,
                referencedTurnIds: ['turn-partial'],
              }
            : question,
        ),
      },
    };
    const next: PersistedInterview = {
      ...current,
      lifecycle: { ...current.lifecycle, revision: 2 },
      coverage: {
        ...current.coverage,
        revision: 2,
        questions: current.coverage.questions.map((question) =>
          question.questionId === 'follow-1'
            ? { ...question, status: 'current' as const }
            : question,
        ),
      },
      version: 2,
    };

    expect(validateInterviewInput(INTERVIEW_ID, next)).toBeNull();
    expect(validateInterviewTransition(current, next)).toBeNull();
  });

  it('rejects lifecycle transitions that skip states or mutate a terminal interview', async () => {
    const skippedExecutor = new ScriptedSqlExecutor([
      query(/for update of st, c/u, { rows: [transitionGuardRow()], rowCount: 1 }),
      query(/from app\.interviews i/u, { rows: readyCoverageRows(), rowCount: 2 }),
    ]);
    await expect(
      new PostgresInterviewRepository(skippedExecutor).compareAndSwap(
        INTERVIEW_ID,
        0,
        completedInterview(),
      ),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'constraint_violation',
        constraint: 'interview_repository_lifecycle_transition',
      },
    });
    skippedExecutor.assertComplete();

    const current = completedInterview();
    const terminalMutation: PersistedInterview = {
      ...current,
      lifecycle: { ...current.lifecycle, revision: 2 },
      version: 2,
      updatedAt: '2026-08-06T10:02:00.000Z',
    };
    const terminalExecutor = new ScriptedSqlExecutor([
      query(/for update of st, c/u, {
        rows: [transitionGuardRow({ state: completedStateRow() })],
        rowCount: 1,
      }),
      query(/from app\.interviews i/u, { rows: activeCoverageRows(), rowCount: 3 }),
    ]);
    await expect(
      new PostgresInterviewRepository(terminalExecutor).compareAndSwap(
        INTERVIEW_ID,
        1,
        terminalMutation,
      ),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'constraint_violation',
        constraint: 'interview_repository_terminal_state',
      },
    });
    terminalExecutor.assertComplete();
  });

  it('rejects regressive coverage and CAS coverage that differs from the persisted guide', async () => {
    const current = activeInterview();
    const regressive: PersistedInterview = {
      ...current,
      lifecycle: { ...current.lifecycle, revision: 2 },
      coverage: {
        ...current.coverage,
        revision: 2,
        questions: [
          {
            ...current.coverage.questions[0]!,
            status: 'current',
            referencedTurnIds: [],
            updatedAt: '2026-08-06T10:02:00.000Z',
          },
          {
            ...current.coverage.questions[1]!,
            status: 'answered',
            referencedTurnIds: ['turn-3'],
            updatedAt: '2026-08-06T10:02:00.000Z',
          },
        ],
      },
      version: 2,
      updatedAt: '2026-08-06T10:02:00.000Z',
    };
    const regressiveExecutor = new ScriptedSqlExecutor([
      query(/for update of st, c/u, {
        rows: [transitionGuardRow({ state: activeStateRow() })],
        rowCount: 1,
      }),
      query(/from app\.interviews i/u, { rows: activeCoverageRows(), rowCount: 3 }),
    ]);
    await expect(
      new PostgresInterviewRepository(regressiveExecutor).compareAndSwap(
        INTERVIEW_ID,
        1,
        regressive,
      ),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'constraint_violation',
        constraint: 'interview_repository_coverage_transition',
      },
    });
    regressiveExecutor.assertComplete();

    const incomplete = readyInterview();
    const incompleteNext: PersistedInterview = {
      ...activeInterview(),
      coverage: {
        ...activeInterview().coverage,
        questions: incomplete.coverage.questions.slice(0, 1),
      },
    };
    const guideMismatchExecutor = new ScriptedSqlExecutor([
      query(/for update of st, c/u, { rows: [transitionGuardRow()], rowCount: 1 }),
      query(/from app\.interviews i/u, { rows: readyCoverageRows(), rowCount: 2 }),
    ]);
    await expect(
      new PostgresInterviewRepository(guideMismatchExecutor).compareAndSwap(
        INTERVIEW_ID,
        0,
        incompleteNext,
      ),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'constraint_violation',
        constraint: 'interview_repository_guide_coverage',
      },
    });
    guideMismatchExecutor.assertComplete();
  });

  it('allows an atomic coverage rollback after an unspoken AI delivery fails', () => {
    const current = activeInterview();
    const recovered: PersistedInterview = {
      ...current,
      lifecycle: { ...current.lifecycle, revision: 2 },
      coverage: {
        ...current.coverage,
        revision: 2,
        questions: current.coverage.questions.map((question) =>
          question.questionId === 'main-1'
            ? { ...question, status: 'current' as const, updatedAt: '2026-08-06T10:02:00.000Z' }
            : {
                ...question,
                status: 'not_addressed' as const,
                updatedAt: '2026-08-06T10:02:00.000Z',
              },
        ),
      },
      version: 2,
      updatedAt: '2026-08-06T10:02:00.000Z',
    };

    expect(validateInterviewTransition(current, recovered)).toBeNull();
  });

  it('reports the actual version after a stale CAS and not-found after deletion', async () => {
    const staleExecutor = new ScriptedSqlExecutor([
      query(/for update of st, c/u, {
        rows: [transitionGuardRow({ stateVersion: 4, updatedAt: UPDATED_AT })],
        rowCount: 1,
      }),
    ]);
    await expect(
      new PostgresInterviewRepository(staleExecutor).compareAndSwap(
        INTERVIEW_ID,
        0,
        activeInterview(),
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: 'stale_version', interviewId: INTERVIEW_ID, expected: 0, actual: 4 },
    });

    const deletedExecutor = new ScriptedSqlExecutor([
      query(/for update of st, c/u, { rows: [], rowCount: 0 }),
    ]);
    const deleted = await new PostgresInterviewRepository(deletedExecutor).compareAndSwap(
      INTERVIEW_ID,
      0,
      activeInterview(),
    );
    expect(deleted).toEqual({
      ok: false,
      error: { code: 'not_found', resource: 'interview', id: INTERVIEW_ID },
    });
  });

  it('reports a retryable race when the CAS belt rejects an unchanged version', async () => {
    const executor = new ScriptedSqlExecutor([
      query(/for update of st, c/u, { rows: [transitionGuardRow()], rowCount: 1 }),
      query(/from app\.interviews i/u, { rows: readyCoverageRows(), rowCount: 2 }),
      query(/update app\.interview_state/u, { rows: [], rowCount: 0 }),
      query(/select state_version, updated_at/u, {
        rows: [{ state_version: 0, updated_at: CREATED_AT }],
        rowCount: 1,
      }),
    ]);

    await expect(
      new PostgresInterviewRepository(executor).compareAndSwap(INTERVIEW_ID, 0, activeInterview()),
    ).resolves.toEqual({
      ok: false,
      error: { code: 'serialization_failure', retryable: true },
    });
    executor.assertComplete();
  });

  it('rejects a CAS that would move the interview update timestamp backwards', async () => {
    const regressed = {
      ...activeInterview(),
      updatedAt: UPDATED_AT,
    };
    const executor = new ScriptedSqlExecutor([
      query(/for update of st, c/u, {
        rows: [transitionGuardRow({ updatedAt: '2026-08-06T10:02:00.000Z' })],
        rowCount: 1,
      }),
    ]);

    await expect(
      new PostgresInterviewRepository(executor).compareAndSwap(INTERVIEW_ID, 0, regressed),
    ).resolves.toEqual({
      ok: false,
      error: { code: 'constraint_violation', constraint: 'interview_updated_at_monotonic' },
    });
  });

  it('blocks completion while an AI delivery owns the next transcript sequence', async () => {
    const next = completedInterview();
    const executor = new ScriptedSqlExecutor([
      query(/for update of st, c/u, {
        rows: [
          transitionGuardRow({
            pendingDeliveryId: 'delivery-1',
            pendingReservedSequenceNumber: 1,
          }),
        ],
        rowCount: 1,
      }),
    ]);

    await expect(
      new PostgresInterviewRepository(executor).compareAndSwap(INTERVIEW_ID, 0, next),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'pending_ai_delivery',
        interviewId: INTERVIEW_ID,
        deliveryId: 'delivery-1',
        reservedSequenceNumber: 1,
      },
    });
    executor.assertComplete();
  });

  it('rejects updatedAt before the current lifecycle event without querying', async () => {
    const next = activeInterview();
    const invalid = {
      ...next,
      lifecycle: {
        ...next.lifecycle,
        activeSince: '2026-08-06T10:02:00.000Z',
      },
    };
    const executor = new ScriptedSqlExecutor([]);

    await expect(
      new PostgresInterviewRepository(executor).compareAndSwap(INTERVIEW_ID, 0, invalid),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'constraint_violation',
        constraint: 'interview_repository_input_timestamp',
      },
    });
    executor.assertComplete();
  });

  it('rejects non-millisecond interview write timestamps before querying PostgreSQL', async () => {
    const invalidTimestamps: readonly unknown[] = [
      new Date(CREATED_AT),
      '2026-08-06',
      '2026-08-06T10:00:00Z',
      '2026-08-06T10:00:00.00Z',
      '2026-08-06T10:00:00.0006Z',
    ];

    for (const timestamp of invalidTimestamps) {
      const ready = readyInterview();
      const invalidInterviews = [
        {
          ...ready,
          lifecycle: { ...ready.lifecycle, createdAt: timestamp as string },
          createdAt: timestamp as string,
        },
        { ...ready, updatedAt: timestamp as string },
      ] as const;

      for (const invalid of invalidInterviews) {
        const executor = new ScriptedSqlExecutor([]);
        await expect(
          new PostgresInterviewRepository(executor).create(INTERVIEW_ID, invalid),
        ).resolves.toEqual({
          ok: false,
          error: {
            code: 'constraint_violation',
            constraint: 'interview_repository_input_timestamp',
          },
        });
        executor.assertComplete();
      }
    }

    for (const timestamp of [new Date(UPDATED_AT), '2026-08-06T10:01:00.0006Z']) {
      const invalidCoverage = activeInterview();
      const firstQuestion = invalidCoverage.coverage.questions[0]!;
      const invalid = {
        ...invalidCoverage,
        coverage: {
          ...invalidCoverage.coverage,
          questions: [
            { ...firstQuestion, updatedAt: timestamp as string },
            ...invalidCoverage.coverage.questions.slice(1),
          ],
        },
      };
      const executor = new ScriptedSqlExecutor([]);

      await expect(
        new PostgresInterviewRepository(executor).compareAndSwap(
          INTERVIEW_ID,
          invalidCoverage.version,
          invalid,
        ),
      ).resolves.toEqual({
        ok: false,
        error: {
          code: 'constraint_violation',
          constraint: 'interview_repository_input_coverage',
        },
      });
      executor.assertComplete();
    }
  });

  it('rejects malformed internal interview identities before querying', async () => {
    const ready = readyInterview();
    const invalidInterviewId = 'interview bad';
    const invalidInterview: PersistedInterview = {
      ...ready,
      interviewId: invalidInterviewId,
      lifecycle: { ...ready.lifecycle, interviewId: invalidInterviewId },
      coverage: { ...ready.coverage, interviewId: invalidInterviewId },
    };
    const invalidGuideId = ' guide:v1:test';
    const invalidGuide: PersistedInterview = {
      ...ready,
      guideId: invalidGuideId,
      lifecycle: { ...ready.lifecycle, guideId: invalidGuideId },
      coverage: { ...ready.coverage, guideId: invalidGuideId },
    };
    const invalidQuestion: PersistedInterview = {
      ...ready,
      coverage: {
        ...ready.coverage,
        questions: ready.coverage.questions.map((question) =>
          question.kind === 'main'
            ? { ...question, questionId: 'main bad', mainQuestionId: 'main bad' }
            : { ...question, mainQuestionId: 'main bad' },
        ),
      },
    };
    const active = activeInterview();
    const invalidWorkflow: PersistedInterview = {
      ...active,
      activeWorkflowRunId: `w${'x'.repeat(128)}`,
    };
    const invalidReference: PersistedInterview = {
      ...active,
      coverage: {
        ...active.coverage,
        questions: active.coverage.questions.map((question) =>
          question.kind === 'main' ? { ...question, referencedTurnIds: [' turn-1'] } : question,
        ),
      },
    };
    const executor = new ScriptedSqlExecutor([]);
    const repository = new PostgresInterviewRepository(executor);

    await expect(repository.create(invalidInterviewId, invalidInterview)).resolves.toMatchObject({
      ok: false,
      error: { code: 'constraint_violation', constraint: 'interview_repository_input_identity' },
    });
    await expect(repository.create(INTERVIEW_ID, invalidGuide)).resolves.toMatchObject({
      ok: false,
      error: { code: 'constraint_violation', constraint: 'interview_repository_input_guide' },
    });
    await expect(repository.create(INTERVIEW_ID, invalidQuestion)).resolves.toMatchObject({
      ok: false,
      error: { code: 'constraint_violation', constraint: 'interview_repository_input_coverage' },
    });
    await expect(
      repository.compareAndSwap(INTERVIEW_ID, 0, invalidWorkflow),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'constraint_violation', constraint: 'interview_repository_input_identity' },
    });
    await expect(
      repository.compareAndSwap(INTERVIEW_ID, 0, invalidReference),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'constraint_violation', constraint: 'interview_repository_input_coverage' },
    });
    executor.assertComplete();
  });

  it('lists interview summaries with a stable opaque cursor', async () => {
    const firstPageExecutor = new ScriptedSqlExecutor([
      query(
        /select st\.interview_id as "interviewId"[\s\S]*\(st\.created_at, st\.interview_id\) < \(\$1::timestamptz, \$2\)[\s\S]*order by st\.created_at desc, st\.interview_id desc/u,
        {
          rows: [
            summaryRow('interview-3', '2026-08-06T10:03:00.000Z'),
            summaryRow('interview-2', '2026-08-06T10:02:00.000Z'),
            summaryRow('interview-1', '2026-08-06T10:01:00.000Z'),
          ],
          rowCount: 3,
        },
      ),
    ]);

    const firstPage = await new PostgresInterviewRepository(firstPageExecutor).listSummaries({
      after: null,
      limit: 2,
    });

    expect(firstPage.ok).toBe(true);
    if (!firstPage.ok) return;
    expect(firstPage.value.interviews.map((interview) => interview.interviewId)).toEqual([
      'interview-3',
      'interview-2',
    ]);
    expect(firstPage.value.nextCursor).not.toBeNull();
    expect(firstPageExecutor.calls[0]?.parameters).toEqual([null, null, 3]);

    const secondPageExecutor = new ScriptedSqlExecutor([
      query(/where \(\$1::timestamptz is null/u, {
        rows: [summaryRow('interview-1', '2026-08-06T10:01:00.000Z')],
        rowCount: 1,
      }),
    ]);
    const secondPage = await new PostgresInterviewRepository(secondPageExecutor).listSummaries({
      after: firstPage.value.nextCursor,
      limit: 2,
    });

    expect(secondPage).toEqual({
      ok: true,
      value: {
        interviews: [summaryRow('interview-1', '2026-08-06T10:01:00.000Z')],
        nextCursor: null,
      },
    });
    expect(secondPageExecutor.calls[0]?.parameters).toEqual([
      '2026-08-06T10:02:00.000Z',
      'interview-2',
      3,
    ]);
  });

  it('rejects invalid summary pagination before querying the database', async () => {
    const executor = new ScriptedSqlExecutor([]);
    const repository = new PostgresInterviewRepository(executor);

    await expect(repository.listSummaries({ after: null, limit: 0 })).resolves.toEqual({
      ok: false,
      error: { code: 'constraint_violation', constraint: 'interview_summary_limit' },
    });
    await expect(
      repository.listSummaries({ after: 'not-base64-json', limit: 20 }),
    ).resolves.toEqual({
      ok: false,
      error: { code: 'constraint_violation', constraint: 'interview_summary_cursor' },
    });
    executor.assertComplete();
  });

  it('rejects malformed summary rows without returning a partial page', async () => {
    const executor = new ScriptedSqlExecutor([
      query(/from app\.interview_state st/u, {
        rows: [{ ...summaryRow(INTERVIEW_ID, UPDATED_AT), status: 'unknown' }],
        rowCount: 1,
      }),
    ]);

    const result = await new PostgresInterviewRepository(executor).listSummaries({
      after: null,
      limit: 20,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('corrupt_data');
  });

  it('rejects cross-interview and corrupt lifecycle/coverage rows without throwing', async () => {
    const crossScoped = new ScriptedSqlExecutor([
      query(/from app\.interviews i/u, {
        rows: [{ ...readyStateRow(), interview_id: 'interview-2' }],
        rowCount: 1,
      }),
    ]);
    const crossResult = await new PostgresInterviewRepository(crossScoped).load(INTERVIEW_ID);
    expect(crossResult.ok).toBe(false);
    if (!crossResult.ok) {
      expect(crossResult.error.code).toBe('corrupt_data');
    }

    const corrupt = new ScriptedSqlExecutor([
      query(/from app\.interviews i/u, {
        rows: [{ ...activeStateRow(), active_since: null }],
        rowCount: 1,
      }),
      query(/from app\.interviews i/u, { rows: readyCoverageRows(), rowCount: 2 }),
    ]);
    const corruptResult = await new PostgresInterviewRepository(corrupt).load(INTERVIEW_ID);
    expect(corruptResult.ok).toBe(false);
    if (!corruptResult.ok) {
      expect(corruptResult.error.code).toBe('corrupt_data');
    }
  });

  it('rejects malformed stored interview and coverage IDs as corrupt data', async () => {
    const invalidState = new ScriptedSqlExecutor([
      query(/from app\.interviews i/u, {
        rows: [{ ...activeStateRow(), active_workflow_run_id: 'workflow bad' }],
        rowCount: 1,
      }),
    ]);
    await expect(
      new PostgresInterviewRepository(invalidState).load(INTERVIEW_ID),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'corrupt_data', resource: 'interview' },
    });
    invalidState.assertComplete();

    const invalidCoverage = new ScriptedSqlExecutor([
      query(/from app\.interviews i/u, { rows: [readyStateRow()], rowCount: 1 }),
      query(/from app\.interviews i/u, {
        rows: [
          { ...readyCoverageRows()[0], referenced_turn_id: `t${'x'.repeat(128)}` },
          readyCoverageRows()[1],
        ],
        rowCount: 2,
      }),
    ]);
    await expect(
      new PostgresInterviewRepository(invalidCoverage).load(INTERVIEW_ID),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'corrupt_data', resource: 'interview' },
    });
    invalidCoverage.assertComplete();
  });
});

function readyInterview(): PersistedInterview {
  return {
    interviewId: INTERVIEW_ID,
    guideId: GUIDE_ID,
    language: 'de',
    lifecycle: {
      status: 'ready',
      interviewId: INTERVIEW_ID,
      guideId: GUIDE_ID,
      createdAt: CREATED_AT,
      revision: 0,
    },
    coverage: readyCoverage(),
    version: 0,
    activeWorkflowRunId: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

function activeInterview(): PersistedInterview {
  return {
    interviewId: INTERVIEW_ID,
    guideId: GUIDE_ID,
    language: 'de',
    lifecycle: {
      status: 'active',
      interviewId: INTERVIEW_ID,
      guideId: GUIDE_ID,
      createdAt: CREATED_AT,
      revision: 1,
      startedAt: CREATED_AT,
      activeSince: CREATED_AT,
    },
    coverage: {
      interviewId: INTERVIEW_ID,
      guideId: GUIDE_ID,
      revision: 1,
      questions: [
        {
          questionId: 'main-1',
          kind: 'main',
          mainQuestionId: 'main-1',
          status: 'answered',
          referencedTurnIds: ['turn-1', 'turn-2'],
          updatedAt: UPDATED_AT,
        },
        {
          questionId: 'follow-1',
          kind: 'follow_up',
          mainQuestionId: 'main-1',
          status: 'current',
          referencedTurnIds: [],
          updatedAt: UPDATED_AT,
        },
      ],
    },
    version: 1,
    activeWorkflowRunId: 'workflow-1',
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
  };
}

function completedInterview(): PersistedInterview {
  const active = activeInterview();
  return {
    ...active,
    lifecycle: {
      status: 'completed',
      interviewId: INTERVIEW_ID,
      guideId: GUIDE_ID,
      createdAt: CREATED_AT,
      revision: 1,
      startedAt: CREATED_AT,
      endingAt: UPDATED_AT,
      endedAt: UPDATED_AT,
    },
    activeWorkflowRunId: null,
  };
}

function sectionMemory(): SectionMemory {
  return {
    interviewId: INTERVIEW_ID,
    guideId: GUIDE_ID,
    sectionId: 'section-1',
    sectionTitle: 'Abschnitt 1',
    coveredQuestionIds: ['main-1'],
    partiallyCoveredQuestionIds: [],
    facts: [{ statement: 'Wortgetreue Aussage.', transcriptTurnIds: ['turn-1'] }],
    examples: [],
    limitations: [],
    openAspects: [{ questionId: 'follow-1', description: 'Offener Aspekt' }],
    possibleContradictions: [],
    sourceThroughSequenceNumber: 2,
    compactedAt: UPDATED_AT,
  };
}

function advanceActiveState(
  current: PersistedInterview,
  sectionMemories: readonly SectionMemory[],
): PersistedInterview {
  if (current.lifecycle.status !== 'active') throw new Error('Expected active fixture');
  const version = current.version + 1;
  return {
    ...current,
    lifecycle: { ...current.lifecycle, revision: version },
    coverage: { ...current.coverage, revision: current.coverage.revision + 1 },
    sectionMemories,
    version,
  };
}

function transitionGuardRow(
  overrides: Partial<{
    readonly state: StateDatabaseRow;
    readonly stateVersion: number;
    readonly updatedAt: string;
    readonly pendingDeliveryId: string | null;
    readonly pendingReservedSequenceNumber: number | null;
  }> = {},
) {
  const state = overrides.state ?? readyStateRow();
  return {
    ...state,
    state_version: overrides.stateVersion ?? state.state_version,
    updated_at: overrides.updatedAt ?? state.updated_at,
    pendingDeliveryId: null,
    pendingReservedSequenceNumber: null,
    unresolvedPartialProvider: null,
    unresolvedPartialSegmentId: null,
    unresolvedPartialUtteranceId: null,
    ...(overrides.pendingDeliveryId === undefined
      ? {}
      : { pendingDeliveryId: overrides.pendingDeliveryId }),
    ...(overrides.pendingReservedSequenceNumber === undefined
      ? {}
      : { pendingReservedSequenceNumber: overrides.pendingReservedSequenceNumber }),
  };
}

function readyCoverage(): GuideCoverageState {
  return {
    interviewId: INTERVIEW_ID,
    guideId: GUIDE_ID,
    revision: 0,
    questions: [
      {
        questionId: 'main-1',
        kind: 'main',
        mainQuestionId: 'main-1',
        status: 'not_addressed',
        referencedTurnIds: [],
        updatedAt: null,
      },
      {
        questionId: 'follow-1',
        kind: 'follow_up',
        mainQuestionId: 'main-1',
        status: 'not_addressed',
        referencedTurnIds: [],
        updatedAt: null,
      },
    ],
  };
}

interface StateDatabaseRow {
  interview_id: string;
  guide_id: string;
  language: 'de' | 'en';
  interview_created_at: string;
  status: 'ready' | 'active' | 'paused' | 'ending' | 'completed' | 'failed';
  state_version: number;
  coverage_version: number;
  current_main_question_id: string | null;
  active_workflow_run_id: string | null;
  state_created_at: string;
  updated_at: string;
  started_at: string | null;
  active_since: string | null;
  paused_at: string | null;
  ending_at: string | null;
  ending_from: 'active' | 'paused' | null;
  ended_at: string | null;
  failed_at: string | null;
  failed_from: 'ready' | 'active' | 'paused' | 'ending' | null;
  failure_code: string | null;
  failure_message: string | null;
}

function readyStateRow(): StateDatabaseRow {
  return {
    interview_id: INTERVIEW_ID,
    guide_id: GUIDE_ID,
    language: 'de',
    interview_created_at: CREATED_AT,
    status: 'ready',
    state_version: 0,
    coverage_version: 0,
    current_main_question_id: null,
    active_workflow_run_id: null,
    state_created_at: CREATED_AT,
    updated_at: CREATED_AT,
    started_at: null,
    active_since: null,
    paused_at: null,
    ending_at: null,
    ending_from: null,
    ended_at: null,
    failed_at: null,
    failed_from: null,
    failure_code: null,
    failure_message: null,
  };
}

function activeStateRow(): StateDatabaseRow {
  return {
    ...readyStateRow(),
    status: 'active',
    state_version: 1,
    coverage_version: 1,
    current_main_question_id: 'main-1',
    active_workflow_run_id: 'workflow-1',
    updated_at: UPDATED_AT,
    started_at: CREATED_AT,
    active_since: CREATED_AT,
  };
}

function completedStateRow(): StateDatabaseRow {
  return {
    ...activeStateRow(),
    status: 'completed',
    active_since: null,
    ending_at: UPDATED_AT,
    ended_at: UPDATED_AT,
  };
}

function summaryRow(interviewId: string, createdAt: string, updatedAt = createdAt) {
  return {
    interviewId,
    guideId: GUIDE_ID,
    language: 'de' as const,
    guideTitle: 'Organizational Resilience',
    status: 'active' as const,
    currentMainQuestionId: 'main-1',
    activeWorkflowRunId: 'workflow-1',
    createdAt,
    updatedAt,
    startedAt: createdAt,
  };
}

function lifecycleOnlyRow(row: StateDatabaseRow): StateDatabaseRow {
  return {
    ...row,
    coverage_version: 0,
    current_main_question_id: null,
    active_workflow_run_id: null,
  };
}

interface CoverageDatabaseRow {
  interview_id: string;
  guide_id: string;
  question_id: string;
  question_kind: 'main_question' | 'follow_up_question';
  main_question_id: string;
  section_position: number;
  main_position: number;
  question_position: number;
  coverage_status:
    'not_addressed' | 'current' | 'partially_answered' | 'answered' | 'skipped_already_answered';
  coverage_updated_at: string | null;
  referenced_turn_id: string | null;
}

function readyCoverageRows(): CoverageDatabaseRow[] {
  return [
    coverageRow('main-1', 'main_question', 'main-1', 0, 'not_addressed', null, null),
    coverageRow('follow-1', 'follow_up_question', 'main-1', 0, 'not_addressed', null, null),
  ];
}

function guideQuestionShapeRows() {
  return [
    {
      guide_id: GUIDE_ID,
      question_id: 'main-1',
      question_kind: 'main_question' as const,
      main_question_id: 'main-1',
    },
    {
      guide_id: GUIDE_ID,
      question_id: 'follow-1',
      question_kind: 'follow_up_question' as const,
      main_question_id: 'main-1',
    },
  ];
}

function activeCoverageRows(): CoverageDatabaseRow[] {
  return [
    coverageRow('main-1', 'main_question', 'main-1', 0, 'answered', UPDATED_AT, 'turn-1'),
    coverageRow('main-1', 'main_question', 'main-1', 0, 'answered', UPDATED_AT, 'turn-2'),
    coverageRow('follow-1', 'follow_up_question', 'main-1', 0, 'current', UPDATED_AT, null),
  ];
}

function coverageRow(
  questionId: string,
  kind: CoverageDatabaseRow['question_kind'],
  mainQuestionId: string,
  questionPosition: number,
  status: CoverageDatabaseRow['coverage_status'],
  updatedAt: string | null,
  turnId: string | null,
): CoverageDatabaseRow {
  return {
    interview_id: INTERVIEW_ID,
    guide_id: GUIDE_ID,
    question_id: questionId,
    question_kind: kind,
    main_question_id: mainQuestionId,
    section_position: 0,
    main_position: 0,
    question_position: questionPosition,
    coverage_status: status,
    coverage_updated_at: updatedAt,
    referenced_turn_id: turnId,
  };
}

interface ScriptedQuery {
  readonly pattern: RegExp;
  readonly result: SqlQueryResult;
}

class ScriptedSqlExecutor implements SqlExecutor {
  public readonly calls: { readonly statement: string; readonly parameters: readonly unknown[] }[] =
    [];

  readonly #scripts: ScriptedQuery[];

  public constructor(scripts: readonly ScriptedQuery[]) {
    this.#scripts = [...scripts];
  }

  public async query(
    statement: string,
    parameters: readonly unknown[] = [],
  ): Promise<SqlQueryResult> {
    const script = this.#scripts.shift();
    if (script === undefined || !script.pattern.test(statement)) {
      throw new Error(`Unexpected SQL: ${statement}`);
    }
    this.calls.push({ statement, parameters });
    return script.result;
  }

  public assertComplete(): void {
    expect(this.#scripts).toHaveLength(0);
  }
}

function query(pattern: RegExp, result: SqlQueryResult): ScriptedQuery {
  return { pattern, result };
}
