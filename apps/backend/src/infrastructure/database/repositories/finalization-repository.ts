import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  structuredAgentOutputSchema,
  timestampSchema,
  transcriptFinalizationReportSchema,
} from '@orgscience/contracts';
import {
  TRANSCRIPT_INVARIANT_ISSUE_CODES,
  validateFinalTranscript,
  type CanonicalTranscriptEntry,
} from '@orgscience/domain';
import { z } from 'zod';

import {
  failure,
  success,
  type FinalizationRepository as FinalizationRepositoryPort,
  type IdempotentWrite,
  type RepositoryResult,
  type StoredFinalization,
  type TranscriptReader,
  type TranscriptFinalizationCandidate,
} from '../../../application/persistence/index.js';
import { corruptData, mapDatabaseError } from './repository-errors.js';
import { storedAgentInputSchema } from './run-repository-schemas.js';
import type { SqlExecutor } from './sql.js';
import { PostgresTranscriptRepository } from './transcript-repository.js';

const databaseTimestampSchema = z
  .union([z.string(), z.date()])
  .transform((value) => (typeof value === 'string' ? value : value.toISOString()))
  .pipe(z.iso.datetime({ offset: true }));

const transcriptInvariantIssueCodeSchema = z.enum(TRANSCRIPT_INVARIANT_ISSUE_CODES);

const deterministicIssueSchema = z.strictObject({
  code: transcriptInvariantIssueCodeSchema,
  message: z.string().min(1),
  entryId: z.string().min(1).nullable(),
});

const finalizationRowSchema = z.strictObject({
  interview_id: z.string().min(1),
  finalization_id: z.string().min(1),
  state_version: z.number().int().nonnegative(),
  agent_run_id: z.string().min(1),
  validation_status: z.enum(['valid', 'valid_with_gaps']),
  entry_count: z.number().int().nonnegative(),
  technical_gap_count: z.number().int().nonnegative(),
  deterministic_issues: z.array(deterministicIssueSchema),
  agent_report: transcriptFinalizationReportSchema,
  canonical_digest: z.string().regex(/^[0-9a-f]{64}$/u),
  finalized_at: databaseTimestampSchema,
});

const identityRowSchema = z.strictObject({ finalization_id: z.string().min(1) });
const lockedFinalizationStateSchema = z.strictObject({
  stateVersion: z.number().int().nonnegative(),
  status: z.enum(['ready', 'active', 'paused', 'ending', 'completed', 'failed']),
  endedAt: databaseTimestampSchema.nullable(),
  pendingDeliveryCount: z.number().int().nonnegative(),
});
const finalizationAgentRowSchema = z.strictObject({
  status: z.literal('succeeded'),
  agentName: z.literal('transcript_finalization'),
  endedAt: databaseTimestampSchema,
  input: storedAgentInputSchema,
  output: structuredAgentOutputSchema,
});

const PROJECTION = `
  interview_id, finalization_id, state_version, agent_run_id,
  validation_status, entry_count, technical_gap_count,
  deterministic_issues, agent_report, canonical_digest, finalized_at
`;

export class PostgresFinalizationRepository implements FinalizationRepositoryPort {
  public constructor(
    private readonly executor: SqlExecutor,
    private readonly transcripts: TranscriptReader = new PostgresTranscriptRepository(executor),
  ) {}

  public async loadLatest(
    interviewId: string,
  ): Promise<RepositoryResult<StoredFinalization | null>> {
    try {
      const result = await this.executor.query(
        `select ${PROJECTION} from app.transcript_finalizations where interview_id = $1`,
        [interviewId],
      );
      if (result.rowCount === 0) return success(null);
      const parsed = parseFinalization(result.rows, interviewId);
      if (!parsed.ok) return parsed;
      const aggregate = await this.transcripts.loadAggregate(interviewId);
      if (!aggregate.ok) return aggregate;
      const expectedEntries = aggregate.value.entries.map((entry) => ({
        entryId: canonicalEntryId(entry),
        kind: entry.kind,
      }));
      const expectedGapCount = aggregate.value.entries.filter(
        (entry) => entry.kind === 'technical_gap',
      ).length;
      const expectedFingerprint = fingerprintTranscript(
        aggregate.value.interviewId,
        aggregate.value.guideId,
        aggregate.value.entries,
      );
      const latestEntry = aggregate.value.entries.at(-1);
      if (
        parsed.value.transcriptFingerprint !== expectedFingerprint ||
        parsed.value.entryCount !== aggregate.value.entries.length ||
        parsed.value.technicalGapCount !== expectedGapCount ||
        !isDeepStrictEqual(parsed.value.agentReport.checkedCanonicalEntries, expectedEntries) ||
        (latestEntry !== undefined &&
          Date.parse(parsed.value.finalizedAt) < Date.parse(latestEntry.occurredAt))
      ) {
        return failure(
          corruptData(
            'finalization',
            interviewId,
            'Finalization does not match the canonical transcript',
          ),
        );
      }
      return parsed;
    } catch (error: unknown) {
      return failure(mapDatabaseError(error, { resource: 'finalization', identity: interviewId }));
    }
  }

  public async store(
    interviewId: string,
    finalization: TranscriptFinalizationCandidate,
  ): Promise<RepositoryResult<IdempotentWrite<StoredFinalization>>> {
    const issue = validateCandidate(interviewId, finalization);
    if (issue !== null) {
      return failure({ code: 'constraint_violation', constraint: issue });
    }

    try {
      const lockedState = await this.lockFinalizationState(interviewId);
      if (!lockedState.ok) return lockedState;
      if (
        lockedState.value.status !== 'completed' ||
        lockedState.value.endedAt === null ||
        lockedState.value.stateVersion !== finalization.stateVersion ||
        lockedState.value.pendingDeliveryCount !== 0 ||
        Date.parse(finalization.finalizedAt) < Date.parse(lockedState.value.endedAt)
      ) {
        return failure({
          code: 'constraint_violation',
          constraint: 'finalization_locked_state',
        });
      }

      const aggregate = await this.transcripts.loadAggregate(interviewId);
      if (!aggregate.ok) return aggregate;
      const deterministicValidation = validateFinalTranscript(aggregate.value);
      const checkedCanonicalEntries = aggregate.value.entries.map((entry) => ({
        entryId: canonicalEntryId(entry),
        kind: entry.kind,
      }));
      const canonicalTurnIds = aggregate.value.entries
        .filter((entry) => entry.kind === 'turn')
        .map((entry) => entry.turnId);
      const canonicalEntryIds = aggregate.value.entries.map(canonicalEntryId);
      const guideQuestionIds = aggregate.value.guideQuestionIndex.map((reference) =>
        reference.kind === 'main_question'
          ? reference.mainQuestionId
          : reference.followUpQuestionId,
      );
      const canonicalGapIds = aggregate.value.entries
        .filter((entry) => entry.kind === 'technical_gap')
        .map((entry) => entry.gapId);
      const reportedGapIds = finalization.agentReport.issues.flatMap((reportIssue) =>
        reportIssue.code === 'technical_gap' ? reportIssue.canonicalEntryIds : [],
      );
      const validationStatus = statusForGapCount(canonicalGapIds.length);
      const lastEntry = aggregate.value.entries.at(-1);
      if (
        !deterministicValidation.valid ||
        !isDeepStrictEqual(deterministicValidation, finalization.deterministicValidation) ||
        !isDeepStrictEqual(
          checkedCanonicalEntries,
          finalization.agentReport.checkedCanonicalEntries,
        ) ||
        finalization.agentReport.status !== validationStatus ||
        !sameUniqueIds(canonicalGapIds, reportedGapIds) ||
        (lastEntry !== undefined &&
          Date.parse(finalization.finalizedAt) < Date.parse(lastEntry.occurredAt))
      ) {
        return failure({
          code: 'constraint_violation',
          constraint: 'finalization_canonical_transcript',
        });
      }

      const agent = await this.loadFinalizationAgent(interviewId, finalization.agentRunId);
      if (!agent.ok) return agent;
      if (
        agent.value.output.agentName !== 'transcript_finalization' ||
        !isDeepStrictEqual(agent.value.output.output, finalization.agentReport) ||
        Date.parse(agent.value.endedAt) > Date.parse(finalization.finalizedAt) ||
        agent.value.input.interviewStateVersion !== finalization.stateVersion ||
        !isDeepStrictEqual(canonicalTurnIds, agent.value.input.transcriptTurnIds) ||
        !isDeepStrictEqual(canonicalEntryIds, agent.value.input.canonicalEntryIds) ||
        !isDeepStrictEqual(guideQuestionIds, agent.value.input.guideQuestionIds)
      ) {
        return failure({
          code: 'constraint_violation',
          constraint: 'finalization_agent_provenance',
        });
      }

      const stored: StoredFinalization = {
        ...finalization,
        transcriptFingerprint: fingerprintTranscript(
          aggregate.value.interviewId,
          aggregate.value.guideId,
          aggregate.value.entries,
        ),
        entryCount: aggregate.value.entries.length,
        technicalGapCount: aggregate.value.entries.filter((entry) => entry.kind === 'technical_gap')
          .length,
      };
      const result = await this.executor.query(
        `insert into app.transcript_finalizations (
           interview_id, finalization_id, state_version, agent_run_id,
           validation_status, entry_count, technical_gap_count,
           deterministic_issues, agent_report, canonical_digest, finalized_at
         ) values (
           $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11
         ) on conflict (interview_id) do nothing returning finalization_id`,
        [
          interviewId,
          stored.finalizationId,
          stored.stateVersion,
          stored.agentRunId,
          validationStatus,
          stored.entryCount,
          stored.technicalGapCount,
          JSON.stringify(stored.deterministicValidation.issues),
          JSON.stringify(stored.agentReport),
          stored.transcriptFingerprint,
          stored.finalizedAt,
        ],
      );
      const identity = z.array(identityRowSchema).safeParse(result.rows);
      if (!identity.success || identity.data.length !== result.rowCount) {
        return failure(corruptData('finalization', stored.finalizationId, 'Invalid insert result'));
      }
      if (result.rowCount === 1 && identity.data[0]?.finalization_id === stored.finalizationId) {
        return success({ outcome: 'inserted', value: stored });
      }
      if (result.rowCount !== 0) {
        return failure(
          corruptData('finalization', stored.finalizationId, 'Unexpected insert count'),
        );
      }
      const existing = await this.loadLatest(interviewId);
      if (!existing.ok) return existing;
      if (existing.value === null || !sameStoredFinalization(existing.value, stored)) {
        return failure({
          code: 'duplicate_conflict',
          resource: 'finalization',
          identity: interviewId,
        });
      }
      return success({ outcome: 'existing', value: existing.value });
    } catch (error: unknown) {
      return failure(
        mapDatabaseError(error, {
          resource: 'finalization',
          identity: finalization.finalizationId,
        }),
      );
    }
  }

  private async lockFinalizationState(
    interviewId: string,
  ): Promise<RepositoryResult<z.infer<typeof lockedFinalizationStateSchema>>> {
    const result = await this.executor.query(
      `select st.state_version as "stateVersion", st.status, st.ended_at as "endedAt",
              (select count(*)::integer from app.ai_turn_deliveries d
                where d.interview_id = st.interview_id and d.status = 'pending')
                as "pendingDeliveryCount"
         from app.interview_state st
         join app.interview_counters c on c.interview_id = st.interview_id
        where st.interview_id = $1
        for update of st, c`,
      [interviewId],
    );
    if (result.rowCount === 0) {
      return failure({ code: 'not_found', resource: 'finalization', id: interviewId });
    }
    const parsed = lockedFinalizationStateSchema.safeParse(result.rows[0]);
    return parsed.success
      ? success(parsed.data)
      : failure(corruptData('finalization', interviewId, parsed.error.message));
  }

  private async loadFinalizationAgent(
    interviewId: string,
    agentRunId: string,
  ): Promise<RepositoryResult<z.infer<typeof finalizationAgentRowSchema>>> {
    const result = await this.executor.query(
      `select status, agent_name as "agentName", ended_at as "endedAt", input, output
         from app.agent_runs
        where interview_id = $1 and id = $2
        for share`,
      [interviewId, agentRunId],
    );
    if (result.rowCount === 0) {
      return failure({ code: 'not_found', resource: 'agent_run', id: agentRunId });
    }
    const parsed = finalizationAgentRowSchema.safeParse(result.rows[0]);
    return parsed.success
      ? success(parsed.data)
      : failure(corruptData('agent_run', agentRunId, parsed.error.message));
  }
}

function parseFinalization(
  rows: readonly unknown[],
  interviewId: string,
): RepositoryResult<StoredFinalization> {
  const parsed = z.array(finalizationRowSchema).safeParse(rows);
  if (!parsed.success || parsed.data.length !== 1) {
    return failure(corruptData('finalization', interviewId, 'Invalid finalization row'));
  }
  const row = parsed.data[0]!;
  if (row.interview_id !== interviewId) {
    return failure(corruptData('finalization', interviewId, 'Finalization identity mismatch'));
  }
  const finalization: StoredFinalization = {
    interviewId: row.interview_id,
    finalizationId: row.finalization_id,
    stateVersion: row.state_version,
    agentRunId: row.agent_run_id,
    transcriptFingerprint: row.canonical_digest,
    entryCount: row.entry_count,
    technicalGapCount: row.technical_gap_count,
    finalizedAt: row.finalized_at,
    deterministicValidation: {
      valid: row.deterministic_issues.length === 0,
      issues: row.deterministic_issues,
    },
    agentReport: row.agent_report,
  };
  const issue = validateStoredFinalization(interviewId, finalization);
  if (issue !== null || row.validation_status !== statusFor(finalization)) {
    return failure(corruptData('finalization', interviewId, issue ?? 'Validation status mismatch'));
  }
  return success(finalization);
}

function sameStoredFinalization(left: StoredFinalization, right: StoredFinalization): boolean {
  const { finalizedAt: leftFinalizedAt, ...leftExact } = left;
  const { finalizedAt: rightFinalizedAt, ...rightExact } = right;
  return (
    Date.parse(leftFinalizedAt) === Date.parse(rightFinalizedAt) &&
    isDeepStrictEqual(leftExact, rightExact)
  );
}

function validateStoredFinalization(
  interviewId: string,
  finalization: StoredFinalization,
): string | null {
  const candidateIssue = validateCandidate(interviewId, finalization);
  if (candidateIssue !== null) return candidateIssue;
  if (
    finalization.entryCount < 0 ||
    finalization.technicalGapCount < 0 ||
    finalization.technicalGapCount > finalization.entryCount
  ) {
    return 'finalization_identity_or_counts';
  }
  if (!/^[0-9a-f]{64}$/u.test(finalization.transcriptFingerprint)) {
    return 'finalization_digest';
  }
  if (finalization.agentReport.checkedCanonicalEntries.length !== finalization.entryCount) {
    return 'finalization_entry_count';
  }
  const checkedGapCount = finalization.agentReport.checkedCanonicalEntries.filter(
    (entry) => entry.kind === 'technical_gap',
  ).length;
  if (checkedGapCount !== finalization.technicalGapCount) return 'finalization_gap_count';
  const checkedGapIds = finalization.agentReport.checkedCanonicalEntries
    .filter((entry) => entry.kind === 'technical_gap')
    .map((entry) => entry.entryId);
  const reportedGapIds = finalization.agentReport.issues.flatMap((issue) =>
    issue.code === 'technical_gap' ? issue.canonicalEntryIds : [],
  );
  if (!sameUniqueIds(checkedGapIds, reportedGapIds)) return 'finalization_gap_references';
  if (finalization.agentReport.status !== statusFor(finalization)) return 'finalization_status';
  return null;
}

function validateCandidate(
  interviewId: string,
  finalization: TranscriptFinalizationCandidate,
): string | null {
  if (finalization.interviewId !== interviewId) return 'finalization_interview_scope';
  if (
    finalization.finalizationId.trim().length === 0 ||
    finalization.agentRunId.trim().length === 0 ||
    !Number.isInteger(finalization.stateVersion) ||
    finalization.stateVersion < 0
  ) {
    return 'finalization_identity_or_state';
  }
  if (!timestampSchema.safeParse(finalization.finalizedAt).success) return 'finalization_timestamp';
  const deterministic = z
    .array(deterministicIssueSchema)
    .safeParse(finalization.deterministicValidation.issues);
  if (
    !deterministic.success ||
    !finalization.deterministicValidation.valid ||
    deterministic.data.length !== 0
  ) {
    return 'finalization_deterministic_validation';
  }
  const report = transcriptFinalizationReportSchema.safeParse(finalization.agentReport);
  if (!report.success || report.data.status === 'invalid') return 'finalization_agent_report';
  return null;
}

function statusFor(finalization: StoredFinalization): 'valid' | 'valid_with_gaps' {
  return statusForGapCount(finalization.technicalGapCount);
}

function statusForGapCount(technicalGapCount: number): 'valid' | 'valid_with_gaps' {
  return technicalGapCount === 0 ? 'valid' : 'valid_with_gaps';
}

function sameUniqueIds(expected: readonly string[], actual: readonly string[]): boolean {
  const expectedIds = new Set(expected);
  const actualIds = new Set(actual);
  return (
    expected.length === expectedIds.size &&
    actual.length === actualIds.size &&
    expectedIds.size === actualIds.size &&
    [...expectedIds].every((id) => actualIds.has(id))
  );
}

function canonicalEntryId(entry: CanonicalTranscriptEntry): string {
  return entry.kind === 'turn' ? entry.turnId : entry.gapId;
}

export function fingerprintTranscript(
  interviewId: string,
  guideId: string,
  entries: readonly CanonicalTranscriptEntry[],
): string {
  return createHash('sha256').update(stableJson({ interviewId, guideId, entries })).digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON numbers must be finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  throw new TypeError('Canonical JSON does not support this value');
}
