import {
  idSchema,
  type AgentName,
  type GuideQuestionReference,
  type StructuredAgentOutput,
} from '@orgscience/contracts';
import { z } from 'zod';

import { failure, success, type RepositoryResult } from '../../../application/persistence/index.js';
import { corruptData, mapDatabaseError } from './repository-errors.js';
import type { SqlExecutor } from './sql.js';

const referenceRowSchema = z.strictObject({
  guideId: idSchema,
  transcriptTurnIds: z.array(idSchema),
  guideQuestionIds: z.array(idSchema),
  guideQuestions: z.array(
    z.strictObject({
      questionId: idSchema,
      kind: z.enum(['main_question', 'follow_up_question']),
      sectionId: idSchema,
      mainQuestionId: idSchema,
    }),
  ),
  canonicalEntryIds: z.array(idSchema),
  agentAttributionValid: z.boolean(),
});

const LOAD_REFERENCE_SCOPE_SQL = `select
    i.guide_id as "guideId",
    array(
      select t.turn_id from app.transcript_turns t
      where t.interview_id = i.id and t.turn_id = any($2::text[])
      order by t.turn_id
    ) as "transcriptTurnIds",
    array(
      select q.id from app.guide_questions q
      where q.guide_id = i.guide_id and q.id = any($3::text[])
      order by q.id
    ) as "guideQuestionIds",
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'questionId', q.id,
        'kind', q.kind,
        'sectionId', q.section_id,
        'mainQuestionId', q.main_question_id
      ) order by q.id)
      from app.guide_questions q
      where q.guide_id = i.guide_id and q.id = any($3::text[])
    ), '[]'::jsonb) as "guideQuestions",
    array(
      select e.entry_id from app.transcript_entries e
      where e.interview_id = i.id and e.entry_id = any($4::text[])
      order by e.entry_id
    ) as "canonicalEntryIds",
    case when $5::text is null then true else exists (
      select 1 from app.agent_runs a
      where a.interview_id = i.id
        and a.workflow_run_id = $6::text
        and a.id = $5::text
        and a.agent_name = $7::text
        and (
          $8::boolean = false
          or (a.status = 'succeeded' and a.output = $9::jsonb)
        )
    ) end as "agentAttributionValid"
  from app.interviews i
  where i.id = $1`;

interface RunReferences {
  readonly transcriptTurnIds: readonly string[];
  readonly guideQuestionIds: readonly string[];
  readonly canonicalEntryIds: readonly string[];
  readonly guideIds: readonly string[];
  readonly guideQuestions: readonly GuideQuestionReference[];
}

export interface RunAgentAttribution {
  readonly agentRunId: string;
  readonly workflowRunId: string;
  readonly agentName: AgentName;
  readonly requireSucceeded: boolean;
  readonly structuredOutput: StructuredAgentOutput | null;
}

export async function validateRunReferences(
  executor: SqlExecutor,
  interviewId: string,
  explicitTranscriptTurnIds: readonly string[],
  explicitGuideQuestionIds: readonly string[],
  explicitCanonicalEntryIds: readonly string[],
  structuredOutput: StructuredAgentOutput | null,
  agentAttribution: RunAgentAttribution | null = null,
): Promise<RepositoryResult<void>> {
  const outputReferences = collectReferences([], [], [], structuredOutput);
  if (!isSubset(outputReferences.transcriptTurnIds, explicitTranscriptTurnIds)) {
    return constraint('run_output_transcript_provenance');
  }
  if (!isSubset(outputReferences.guideQuestionIds, explicitGuideQuestionIds)) {
    return constraint('run_output_guide_provenance');
  }
  if (!isSubset(outputReferences.canonicalEntryIds, explicitCanonicalEntryIds)) {
    return constraint('run_output_canonical_provenance');
  }
  const references = collectReferences(
    explicitTranscriptTurnIds,
    explicitGuideQuestionIds,
    explicitCanonicalEntryIds,
    structuredOutput,
  );
  try {
    const result = await executor.query(LOAD_REFERENCE_SCOPE_SQL, [
      interviewId,
      references.transcriptTurnIds,
      references.guideQuestionIds,
      references.canonicalEntryIds,
      agentAttribution?.agentRunId ?? null,
      agentAttribution?.workflowRunId ?? null,
      agentAttribution?.agentName ?? null,
      agentAttribution?.requireSucceeded ?? false,
      agentAttribution?.structuredOutput === null || agentAttribution === null
        ? null
        : JSON.stringify(agentAttribution.structuredOutput),
    ]);
    if (result.rowCount === 0) {
      return failure({ code: 'not_found', resource: 'interview', id: interviewId });
    }
    const parsed = z.array(referenceRowSchema).safeParse(result.rows);
    if (!parsed.success || parsed.data.length !== 1 || result.rowCount !== 1) {
      return failure(corruptData('workflow_run', interviewId, 'Invalid run reference scope'));
    }
    const row = parsed.data[0]!;
    if (references.guideIds.some((guideId) => guideId !== row.guideId)) {
      return constraint('run_reference_guide_scope');
    }
    if (!sameIds(references.transcriptTurnIds, row.transcriptTurnIds)) {
      return constraint('run_reference_transcript_turns');
    }
    if (!sameIds(references.guideQuestionIds, row.guideQuestionIds)) {
      return constraint('run_reference_guide_questions');
    }
    if (!references.guideQuestions.every((reference) => matchesQuestion(reference, row))) {
      return constraint('run_reference_question_hierarchy');
    }
    if (!sameIds(references.canonicalEntryIds, row.canonicalEntryIds)) {
      return constraint('run_reference_canonical_entries');
    }
    if (!row.agentAttributionValid) {
      return constraint('workflow_step_agent_attribution');
    }
    return success(undefined);
  } catch (error: unknown) {
    return failure(mapDatabaseError(error, { resource: 'workflow_run', identity: interviewId }));
  }
}

function collectReferences(
  explicitTranscriptTurnIds: readonly string[],
  explicitGuideQuestionIds: readonly string[],
  explicitCanonicalEntryIds: readonly string[],
  structuredOutput: StructuredAgentOutput | null,
): RunReferences {
  const transcriptTurnIds = new Set(explicitTranscriptTurnIds);
  const guideQuestionIds = new Set(explicitGuideQuestionIds);
  const canonicalEntryIds = new Set(explicitCanonicalEntryIds);
  const guideIds = new Set<string>();
  const guideQuestions = new Map<string, GuideQuestionReference>();

  if (structuredOutput !== null) {
    switch (structuredOutput.agentName) {
      case 'coverage_analysis':
        addAll(transcriptTurnIds, structuredOutput.output.referencedTranscriptTurnIds);
        for (const finding of structuredOutput.output.findings) {
          addQuestion(guideQuestionIds, guideIds, guideQuestions, finding.question);
        }
        break;
      case 'consistency_analysis':
        addAll(transcriptTurnIds, structuredOutput.output.referencedTranscriptTurnIds);
        break;
      case 'interview_decision':
        addAll(transcriptTurnIds, structuredOutput.output.referencedTranscriptTurnIds);
        for (const question of structuredOutput.output.consideredQuestions) {
          addQuestion(guideQuestionIds, guideIds, guideQuestions, question);
        }
        break;
      case 'interview_conductor':
        addAll(transcriptTurnIds, structuredOutput.output.referencedTranscriptTurnIds);
        if (structuredOutput.output.action === 'ask') {
          addQuestion(
            guideQuestionIds,
            guideIds,
            guideQuestions,
            structuredOutput.output.question.guideReference,
          );
        }
        break;
      case 'transcript_finalization':
        addAll(
          canonicalEntryIds,
          structuredOutput.output.checkedCanonicalEntries.map((entry) => entry.entryId),
        );
        break;
    }
  }

  return {
    transcriptTurnIds: sorted(transcriptTurnIds),
    guideQuestionIds: sorted(guideQuestionIds),
    canonicalEntryIds: sorted(canonicalEntryIds),
    guideIds: sorted(guideIds),
    guideQuestions: [...guideQuestions.values()],
  };
}

function addQuestion(
  questionIds: Set<string>,
  guideIds: Set<string>,
  questions: Map<string, GuideQuestionReference>,
  reference: GuideQuestionReference,
): void {
  guideIds.add(reference.guideId);
  const questionId =
    reference.kind === 'main_question' ? reference.mainQuestionId : reference.followUpQuestionId;
  questionIds.add(questionId);
  questions.set(questionKey(reference), reference);
}

function matchesQuestion(
  reference: GuideQuestionReference,
  row: z.infer<typeof referenceRowSchema>,
): boolean {
  const questionId =
    reference.kind === 'main_question' ? reference.mainQuestionId : reference.followUpQuestionId;
  const persisted = row.guideQuestions.find((question) => question.questionId === questionId);
  return (
    persisted !== undefined &&
    persisted.kind === reference.kind &&
    persisted.sectionId === reference.sectionId &&
    persisted.mainQuestionId === reference.mainQuestionId
  );
}

function questionKey(reference: GuideQuestionReference): string {
  return reference.kind === 'main_question'
    ? `${reference.guideId}:${reference.sectionId}:${reference.mainQuestionId}`
    : `${reference.guideId}:${reference.sectionId}:${reference.mainQuestionId}:${reference.followUpQuestionId}`;
}

function addAll(target: Set<string>, values: readonly string[]): void {
  for (const value of values) target.add(value);
}

function sorted(values: ReadonlySet<string>): readonly string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function sameIds(expected: readonly string[], actual: readonly string[]): boolean {
  const actualIds = new Set(actual);
  return expected.length === actualIds.size && expected.every((id) => actualIds.has(id));
}

function isSubset(values: readonly string[], allowed: readonly string[]): boolean {
  const allowedValues = new Set(allowed);
  return values.every((value) => allowedValues.has(value));
}

function constraint(name: string): RepositoryResult<void> {
  return failure({ code: 'constraint_violation', constraint: name });
}
