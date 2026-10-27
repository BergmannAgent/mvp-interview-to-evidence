import { isDeepStrictEqual } from 'node:util';

import {
  structuredAgentOutputSchema,
  timestampSchema as inputTimestampSchema,
} from '@orgscience/contracts';
import { z } from 'zod';

import {
  failure,
  success,
  type ConsistencyRepository,
  type IdempotentWrite,
  type RepositoryResult,
  type StoredContradiction,
} from '../../../application/persistence/index.js';
import { corruptData, mapDatabaseError } from './repository-errors.js';
import type { SqlExecutor } from './sql.js';

const databaseTimestampSchema = z.union([
  z.iso.datetime({ offset: true }),
  z.date().transform((value) => value.toISOString()),
]);

const contradictionRowSchema = z.strictObject({
  interviewId: z.string().min(1),
  contradictionId: z.string().min(1),
  workflowRunId: z.string().min(1),
  agentRunId: z.string().min(1),
  description: z.string().min(1),
  suggestedClarificationQuestion: z.string().min(1),
  shouldClarify: z.boolean(),
  rationale: z.string().min(1),
  status: z.enum(['detected', 'asked', 'dismissed', 'resolved']),
  askedTurnId: z.string().min(1).nullable(),
  createdAt: databaseTimestampSchema,
  updatedAt: databaseTimestampSchema,
  referencedTranscriptTurnIds: z.array(z.string().min(1)),
});

const provenanceRowSchema = z.strictObject({ output: structuredAgentOutputSchema });
const referenceCountSchema = z.strictObject({ count: z.number().int().nonnegative() });

const PROJECTION = `
  c.interview_id as "interviewId", c.id as "contradictionId",
  c.workflow_run_id as "workflowRunId", c.agent_run_id as "agentRunId",
  c.description, c.suggested_clarification_question as "suggestedClarificationQuestion",
  c.should_clarify as "shouldClarify", c.rationale, c.status,
  c.asked_turn_id as "askedTurnId", c.created_at as "createdAt",
  c.updated_at as "updatedAt",
  coalesce(array_agg(r.turn_id order by r.turn_id) filter (where r.turn_id is not null), '{}')
    as "referencedTranscriptTurnIds"`;

const FROM = `
  from app.contradictions c
  left join app.contradiction_turn_references r
    on r.interview_id = c.interview_id and r.contradiction_id = c.id`;

export class PostgresConsistencyRepository implements ConsistencyRepository {
  public constructor(private readonly executor: SqlExecutor) {}

  public async loadContradiction(
    interviewId: string,
    contradictionId: string,
  ): Promise<RepositoryResult<StoredContradiction>> {
    try {
      const result = await this.executor.query(
        `select ${PROJECTION} ${FROM}
          where c.interview_id = $1 and c.id = $2
          group by c.interview_id, c.id`,
        [interviewId, contradictionId],
      );
      if (result.rowCount === 0) {
        return failure({ code: 'not_found', resource: 'contradiction', id: contradictionId });
      }
      return parseContradiction(result.rows[0], interviewId, contradictionId);
    } catch (error: unknown) {
      return this.databaseFailure(error, contradictionId);
    }
  }

  public async listContradictions(
    interviewId: string,
  ): Promise<RepositoryResult<readonly StoredContradiction[]>> {
    try {
      const result = await this.executor.query(
        `select ${PROJECTION} ${FROM}
          where c.interview_id = $1
          group by c.interview_id, c.id
          order by c.created_at, c.id`,
        [interviewId],
      );
      const contradictions: StoredContradiction[] = [];
      for (const row of result.rows) {
        const parsed = parseContradiction(row, interviewId, interviewId);
        if (!parsed.ok) return parsed;
        contradictions.push(parsed.value);
      }
      return success(contradictions);
    } catch (error: unknown) {
      return this.databaseFailure(error, interviewId);
    }
  }

  public async createContradiction(
    interviewId: string,
    contradiction: StoredContradiction,
  ): Promise<RepositoryResult<IdempotentWrite<StoredContradiction>>> {
    const issue = validateContradiction(interviewId, contradiction);
    if (issue !== null || contradiction.status !== 'detected') {
      return constraint(issue ?? 'contradiction_initial_status');
    }
    try {
      const provenance = await this.validateProvenance(contradiction);
      if (!provenance.ok) return provenance;
      const references = await this.validateTurnReferences(
        interviewId,
        contradiction.referencedTranscriptTurnIds,
      );
      if (!references.ok) return references;

      const inserted = await this.executor.query(
        `insert into app.contradictions (
           interview_id, id, workflow_run_id, agent_run_id, description,
           suggested_clarification_question, should_clarify, rationale,
           status, asked_turn_id, created_at, updated_at
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, null, $10, $11)
         on conflict (interview_id, id) do nothing
         returning id`,
        [
          interviewId,
          contradiction.contradictionId,
          contradiction.workflowRunId,
          contradiction.agentRunId,
          contradiction.description,
          contradiction.suggestedClarificationQuestion,
          contradiction.shouldClarify,
          contradiction.rationale,
          contradiction.status,
          contradiction.createdAt,
          contradiction.updatedAt,
        ],
      );
      if (inserted.rowCount === 1) {
        await this.insertTurnReferences(contradiction);
        return success({ outcome: 'inserted', value: contradiction });
      }
      if (inserted.rowCount !== 0) {
        return failure(corruptData('contradiction', contradiction.contradictionId, 'insert count'));
      }
      const existing = await this.loadContradiction(interviewId, contradiction.contradictionId);
      return existing.ok && sameContradiction(existing.value, contradiction)
        ? success({ outcome: 'existing', value: existing.value })
        : existing.ok
          ? duplicate(contradiction.contradictionId)
          : existing;
    } catch (error: unknown) {
      return this.databaseFailure(error, contradiction.contradictionId);
    }
  }

  public async transitionContradiction(
    interviewId: string,
    contradictionId: string,
    expectedStatus: StoredContradiction['status'],
    next: StoredContradiction,
  ): Promise<RepositoryResult<StoredContradiction>> {
    const issue = validateContradiction(interviewId, next);
    if (
      issue !== null ||
      next.contradictionId !== contradictionId ||
      !allowedTransition(expectedStatus, next.status)
    ) {
      return constraint(issue ?? 'contradiction_transition');
    }
    try {
      const existing = await this.loadContradiction(interviewId, contradictionId);
      if (!existing.ok) return existing;
      if (!sameImmutableContradiction(existing.value, next)) return duplicate(contradictionId);
      if (Date.parse(next.updatedAt) < Date.parse(existing.value.updatedAt)) {
        return constraint('contradiction_timestamp_regression');
      }
      if (
        (expectedStatus === 'asked' && next.askedTurnId !== existing.value.askedTurnId) ||
        (expectedStatus === 'detected' && next.status === 'dismissed' && next.askedTurnId !== null)
      ) {
        return constraint('contradiction_asked_turn_immutable');
      }
      if (next.status === 'asked') {
        const askedTurn = await this.validateClarificationTurn(interviewId, next.askedTurnId);
        if (!askedTurn.ok) return askedTurn;
      }
      const result = await this.executor.query(
        `update app.contradictions
            set status = $4, asked_turn_id = $5, updated_at = $6
          where interview_id = $1 and id = $2 and status = $3 and updated_at <= $6
          returning id`,
        [
          interviewId,
          contradictionId,
          expectedStatus,
          next.status,
          next.askedTurnId,
          next.updatedAt,
        ],
      );
      if (result.rowCount === 1) return success(next);
      if (result.rowCount !== 0) {
        return failure(corruptData('contradiction', contradictionId, 'update count'));
      }
      const retried = await this.loadContradiction(interviewId, contradictionId);
      return retried.ok && sameContradiction(retried.value, next)
        ? retried
        : retried.ok
          ? duplicate(contradictionId)
          : retried;
    } catch (error: unknown) {
      return this.databaseFailure(error, contradictionId);
    }
  }

  private async validateProvenance(
    contradiction: StoredContradiction,
  ): Promise<RepositoryResult<true>> {
    const result = await this.executor.query(
      `select a.output
         from app.agent_runs a
        where a.interview_id = $1 and a.id = $2 and a.workflow_run_id = $3
          and a.agent_name = 'consistency_analysis' and a.status = 'succeeded'`,
      [contradiction.interviewId, contradiction.agentRunId, contradiction.workflowRunId],
    );
    const parsed = provenanceRowSchema.safeParse(result.rows[0]);
    if (!parsed.success || parsed.data.output.agentName !== 'consistency_analysis') {
      return constraint('contradiction_agent_provenance');
    }
    const candidate = parsed.data.output.output.contradictions.find(
      (item) => item.id === contradiction.contradictionId,
    );
    if (
      candidate === undefined ||
      candidate.description !== contradiction.description ||
      candidate.suggestedClarificationQuestion !== contradiction.suggestedClarificationQuestion ||
      candidate.shouldClarify !== contradiction.shouldClarify ||
      candidate.rationale !== contradiction.rationale ||
      !sameIds(candidate.transcriptTurnIds, contradiction.referencedTranscriptTurnIds)
    ) {
      return constraint('contradiction_agent_output_mismatch');
    }
    return success(true);
  }

  private async validateTurnReferences(
    interviewId: string,
    turnIds: readonly string[],
  ): Promise<RepositoryResult<true>> {
    const result = await this.executor.query(
      `select count(*)::integer as count
         from app.transcript_turns
        where interview_id = $1 and turn_id = any($2::text[])`,
      [interviewId, turnIds],
    );
    const parsed = referenceCountSchema.safeParse(result.rows[0]);
    return parsed.success && parsed.data.count === turnIds.length
      ? success(true)
      : constraint('contradiction_turn_references');
  }

  private async validateClarificationTurn(
    interviewId: string,
    turnId: string | null,
  ): Promise<RepositoryResult<true>> {
    if (turnId === null) return constraint('contradiction_asked_turn');
    const result = await this.executor.query(
      `select count(*)::integer as count from app.transcript_turns
        where interview_id = $1 and turn_id = $2
          and speaker = 'ai_interviewer' and turn_type = 'clarification_question'`,
      [interviewId, turnId],
    );
    const parsed = referenceCountSchema.safeParse(result.rows[0]);
    return parsed.success && parsed.data.count === 1
      ? success(true)
      : constraint('contradiction_asked_turn');
  }

  private async insertTurnReferences(contradiction: StoredContradiction): Promise<void> {
    for (const turnId of contradiction.referencedTranscriptTurnIds) {
      await this.executor.query(
        `insert into app.contradiction_turn_references
           (interview_id, contradiction_id, turn_id) values ($1, $2, $3)`,
        [contradiction.interviewId, contradiction.contradictionId, turnId],
      );
    }
  }

  private databaseFailure(error: unknown, identity: string): RepositoryResult<never> {
    return failure(mapDatabaseError(error, { resource: 'contradiction', identity }));
  }
}

function parseContradiction(
  row: unknown,
  interviewId: string,
  identity: string,
): RepositoryResult<StoredContradiction> {
  const parsed = contradictionRowSchema.safeParse(row);
  if (!parsed.success || parsed.data.interviewId !== interviewId) {
    return failure(corruptData('contradiction', identity, 'invalid contradiction row'));
  }
  const issue = validateContradiction(interviewId, parsed.data);
  return issue === null
    ? success(parsed.data)
    : failure(corruptData('contradiction', identity, issue));
}

function validateContradiction(interviewId: string, value: StoredContradiction): string | null {
  if (
    value.interviewId !== interviewId ||
    [
      value.contradictionId,
      value.workflowRunId,
      value.agentRunId,
      value.description,
      value.suggestedClarificationQuestion,
      value.rationale,
    ].some((part) => part.trim().length === 0) ||
    value.referencedTranscriptTurnIds.length < 2 ||
    new Set(value.referencedTranscriptTurnIds).size !== value.referencedTranscriptTurnIds.length ||
    !inputTimestampSchema.safeParse(value.createdAt).success ||
    !inputTimestampSchema.safeParse(value.updatedAt).success ||
    Date.parse(value.updatedAt) < Date.parse(value.createdAt)
  ) {
    return 'contradiction_shape';
  }
  const question = value.suggestedClarificationQuestion.trim();
  if (!question.endsWith('?') || (question.match(/\?/gu) ?? []).length !== 1) {
    return 'contradiction_clarification_question';
  }
  if ((value.status === 'asked') !== (value.askedTurnId !== null)) {
    if (value.status === 'detected' || value.askedTurnId === null)
      return 'contradiction_asked_shape';
  }
  return null;
}

function allowedTransition(
  current: StoredContradiction['status'],
  next: StoredContradiction['status'],
): boolean {
  return (
    (current === 'detected' && (next === 'asked' || next === 'dismissed')) ||
    (current === 'asked' && (next === 'resolved' || next === 'dismissed'))
  );
}

function sameImmutableContradiction(
  left: StoredContradiction,
  right: StoredContradiction,
): boolean {
  return (
    left.interviewId === right.interviewId &&
    left.contradictionId === right.contradictionId &&
    left.workflowRunId === right.workflowRunId &&
    left.agentRunId === right.agentRunId &&
    left.description === right.description &&
    left.suggestedClarificationQuestion === right.suggestedClarificationQuestion &&
    left.shouldClarify === right.shouldClarify &&
    left.rationale === right.rationale &&
    sameIds(left.referencedTranscriptTurnIds, right.referencedTranscriptTurnIds) &&
    Date.parse(left.createdAt) === Date.parse(right.createdAt)
  );
}

function sameContradiction(left: StoredContradiction, right: StoredContradiction): boolean {
  return (
    sameImmutableContradiction(left, right) &&
    left.status === right.status &&
    left.askedTurnId === right.askedTurnId &&
    Date.parse(left.updatedAt) === Date.parse(right.updatedAt)
  );
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return isDeepStrictEqual([...left].sort(), [...right].sort());
}

function constraint<T>(name: string): RepositoryResult<T> {
  return failure({ code: 'constraint_violation', constraint: name });
}

function duplicate<T>(identity: string): RepositoryResult<T> {
  return failure({ code: 'duplicate_conflict', resource: 'contradiction', identity });
}
