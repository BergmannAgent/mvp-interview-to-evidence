import {
  evaluationProfileDocumentSchema,
  guideStructureSchema,
  mvpInterviewSessionSchema,
  organizationalResilienceCodingOutputSchema,
  organizationalResilienceRubricSchema,
  persistedEvaluationRubricSchema,
  profileEvaluationProviderCodingOutputSchema,
  profileEvaluationCodingOutputSchema,
  type EvaluationProfileDocument,
  type GuideStructure,
  type MvpInterviewSession,
  type OrganizationalResilienceCodingOutput,
  type OrganizationalResilienceEvidenceReference,
  type OrganizationalResilienceRubric,
  type PersistedEvaluationRubric,
  type ProfileEvaluationCodingOutput,
  type ProfileEvaluationEvidenceReference,
} from '@orgscience/contracts';
import type { z } from 'zod';

export interface EvaluationGuardrailIssue {
  readonly code:
    | 'schema_invalid'
    | 'interview_not_completed'
    | 'transcript_not_finalized'
    | 'interview_time_invalid'
    | 'partial_transcript_unresolved'
    | 'transcript_empty'
    | 'missing_ai_turn'
    | 'missing_participant_turn'
    | 'sequence_error'
    | 'duplicate_turn'
    | 'scope_mismatch'
    | 'chronology_error'
    | 'speaker_mismatch'
    | 'guide_scope_mismatch'
    | 'unknown_guide_question'
    | 'item_set_mismatch'
    | 'invalid_evidence_turn'
    | 'evidence_sequence_mismatch'
    | 'non_verbatim_evidence'
    | 'item_dimension_mismatch'
    | 'invalid_anchor_reference'
    | 'score_without_evidence'
    | 'invalid_interpolation_rule'
    | 'duplicate_evidence_direction'
    | 'absence_as_low_score'
    | 'hypothetical_as_observed_score'
    | 'evidence_phase_mismatch'
    | 'unsupported_process_phase'
    | 'invalid_crisis_context';
  readonly path: string;
  readonly message: string;
}

export type EvaluationGuardrailResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly issues: readonly EvaluationGuardrailIssue[] };

export interface OrganizationalResilienceCodingGuardrailInput {
  readonly rubric: OrganizationalResilienceRubric;
  readonly session: MvpInterviewSession;
}

export interface EvaluationCodingGuardrailInput {
  readonly profile: EvaluationProfileDocument;
  readonly session: MvpInterviewSession;
}

export function validateEvaluationTranscript(
  candidate: unknown,
): EvaluationGuardrailResult<MvpInterviewSession> {
  const parsed = mvpInterviewSessionSchema.safeParse(candidate);
  if (!parsed.success) return failure(schemaIssues(parsed.error.issues));

  const session = parsed.data;
  const issues: EvaluationGuardrailIssue[] = [];
  if (session.status === 'ready') {
    addIssue(
      issues,
      'interview_not_completed',
      'status',
      'An interview must have started before its confirmed transcript can be evaluated',
    );
  }
  if (session.status === 'completed' && session.currentQuestion !== null) {
    addIssue(
      issues,
      'interview_not_completed',
      'currentQuestion',
      'A completed evaluation source cannot retain a current question',
    );
  }
  if (session.partialTranscript !== null) {
    addIssue(
      issues,
      'partial_transcript_unresolved',
      'partialTranscript',
      'An unresolved partial transcription cannot be used as evaluation evidence',
    );
  }
  if (session.startedAt === null) {
    addIssue(
      issues,
      'interview_time_invalid',
      'startedAt',
      'An evaluation snapshot requires the actual interview start timestamp',
    );
  } else if (
    Date.parse(session.updatedAt) < Date.parse(session.startedAt) ||
    (session.endedAt !== null &&
      (Date.parse(session.endedAt) < Date.parse(session.startedAt) ||
        Date.parse(session.updatedAt) < Date.parse(session.endedAt)))
  ) {
    addIssue(
      issues,
      'interview_time_invalid',
      'endedAt',
      'Interview timestamps must be chronological',
    );
  }
  if (
    session.finalizedAt !== null &&
    ((session.endedAt !== null && Date.parse(session.finalizedAt) < Date.parse(session.endedAt)) ||
      (session.startedAt !== null &&
        Date.parse(session.finalizedAt) < Date.parse(session.startedAt)) ||
      Date.parse(session.updatedAt) < Date.parse(session.finalizedAt))
  ) {
    addIssue(
      issues,
      'interview_time_invalid',
      'finalizedAt',
      'Transcript finalization must occur within the actual interview timestamps',
    );
  }

  if (session.transcript.length === 0) {
    addIssue(
      issues,
      'transcript_empty',
      'transcript',
      'An evaluation requires final transcript turns',
    );
  }

  const orderedEntries = [
    ...session.transcript.map((turn, index) => ({
      entryId: turn.turnId,
      interviewId: turn.interviewId,
      sequenceNumber: turn.sequenceNumber,
      occurredAt: turn.occurredAt,
      path: `transcript.${String(index)}`,
    })),
    ...session.technicalGaps.map((gap, index) => ({
      entryId: gap.gapId,
      interviewId: gap.interviewId,
      sequenceNumber: gap.sequenceNumber,
      occurredAt: gap.occurredAt,
      path: `technicalGaps.${String(index)}`,
    })),
  ].sort((left, right) => left.sequenceNumber - right.sequenceNumber);
  const entryIds = new Set<string>();
  let previousOccurredAt: number | null = null;
  for (const [index, entry] of orderedEntries.entries()) {
    if (entry.sequenceNumber !== index + 1) {
      addIssue(
        issues,
        'sequence_error',
        `${entry.path}.sequenceNumber`,
        'Evaluation transcript entries must be contiguous and start at one',
      );
    }
    if (entryIds.has(entry.entryId)) {
      addIssue(
        issues,
        'duplicate_turn',
        `${entry.path}.${entry.path.startsWith('technicalGaps') ? 'gapId' : 'turnId'}`,
        'Transcript entry IDs must be unique',
      );
    }
    entryIds.add(entry.entryId);
    if (entry.interviewId !== session.interviewId) {
      addIssue(
        issues,
        'scope_mismatch',
        `${entry.path}.interviewId`,
        'Every transcript entry must belong to the evaluated interview',
      );
    }
    const occurredAt = Date.parse(entry.occurredAt);
    if (previousOccurredAt !== null && occurredAt < previousOccurredAt) {
      addIssue(
        issues,
        'chronology_error',
        `${entry.path}.occurredAt`,
        'Transcript entry times must not regress',
      );
    }
    previousOccurredAt = occurredAt;
    if (
      session.startedAt !== null &&
      (occurredAt < Date.parse(session.startedAt) ||
        occurredAt > Date.parse(session.endedAt ?? session.updatedAt))
    ) {
      addIssue(
        issues,
        'chronology_error',
        `${entry.path}.occurredAt`,
        'Transcript entries must fall within the actual interview snapshot interval',
      );
    }
  }

  let hasAiTurn = false;
  let hasParticipantTurn = false;
  for (const [index, turn] of session.transcript.entries()) {
    const path = `transcript.${String(index)}`;
    if (turn.speaker === 'participant') {
      hasParticipantTurn = true;
      if (turn.turnType !== 'participant_answer') {
        addIssue(
          issues,
          'speaker_mismatch',
          `${path}.turnType`,
          'Participant evaluation evidence must be a participant answer',
        );
      }
    } else {
      hasAiTurn = true;
      if (turn.turnType === 'participant_answer') {
        addIssue(
          issues,
          'speaker_mismatch',
          `${path}.turnType`,
          'An AI interviewer turn cannot be a participant answer',
        );
      }
    }
    if (turn.guideReference !== null && turn.guideReference.guideId !== session.guideId) {
      addIssue(
        issues,
        'guide_scope_mismatch',
        `${path}.guideReference.guideId`,
        'Transcript guide references must belong to the evaluated guide',
      );
    }
  }

  if (!hasAiTurn) {
    addIssue(
      issues,
      'missing_ai_turn',
      'transcript',
      'Evaluation requires the interviewer context from at least one final AI turn',
    );
  }
  if (!hasParticipantTurn) {
    addIssue(
      issues,
      'missing_participant_turn',
      'transcript',
      'Evaluation requires at least one final participant answer',
    );
  }

  return issues.length === 0 ? success(session) : failure(issues);
}

export function validateEvaluationRubricAgainstGuide(
  rubricCandidate: unknown,
  guideCandidate: unknown,
): EvaluationGuardrailResult<PersistedEvaluationRubric> {
  const rubric = persistedEvaluationRubricSchema.safeParse(rubricCandidate);
  const guide = guideStructureSchema.safeParse(guideCandidate);
  const issues: EvaluationGuardrailIssue[] = [];
  if (!rubric.success) issues.push(...schemaIssues(rubric.error.issues, 'rubric'));
  if (!guide.success) issues.push(...schemaIssues(guide.error.issues, 'guide'));
  if (!rubric.success || !guide.success) return failure(issues);

  if (rubric.data.guideId !== guide.data.id) {
    addIssue(
      issues,
      'guide_scope_mismatch',
      'rubric.guideId',
      'The evaluation rubric belongs to another interview guide',
    );
  }
  const questionIds = guideQuestionIds(guide.data);
  for (const [itemIndex, item] of rubric.data.items.entries()) {
    for (const [questionIndex, questionId] of item.guideQuestionIds.entries()) {
      if (!questionIds.has(questionId)) {
        addIssue(
          issues,
          'unknown_guide_question',
          `rubric.items.${String(itemIndex)}.guideQuestionIds.${String(questionIndex)}`,
          'A rubric item references a question outside the supplied guide',
        );
      }
    }
  }
  return issues.length === 0 ? success(rubric.data) : failure(issues);
}

export function validateEvaluationCodingOutput(
  input: EvaluationCodingGuardrailInput,
  candidate: unknown,
  options: { readonly requireProviderEvidence?: boolean } = {},
): EvaluationGuardrailResult<ProfileEvaluationCodingOutput> {
  const profile = evaluationProfileDocumentSchema.safeParse(input.profile);
  const transcript = validateEvaluationTranscript(input.session);
  const output = (
    options.requireProviderEvidence === true
      ? profileEvaluationProviderCodingOutputSchema
      : profileEvaluationCodingOutputSchema
  ).safeParse(candidate);
  const issues: EvaluationGuardrailIssue[] = [];
  if (!profile.success) issues.push(...schemaIssues(profile.error.issues, 'profile'));
  if (!transcript.ok) issues.push(...transcript.issues);
  if (!output.success) issues.push(...schemaIssues(output.error.issues, 'output'));
  if (!profile.success || !transcript.ok || !output.success) return failure(issues);

  const expectedItems = profile.data.profile.items;
  if (output.data.items.length !== expectedItems.length) {
    addIssue(
      issues,
      'item_set_mismatch',
      'output.items',
      'Evaluation output must contain every profile item exactly once and in profile order',
    );
  }

  const participantTurnsById = new Map(
    transcript.value.transcript
      .filter((turn) => turn.speaker === 'participant')
      .map((turn) => [turn.turnId, turn]),
  );
  for (const field of ['age', 'position'] as const) {
    const detail = output.data.participantDetails?.[field];
    if (detail != null) {
      validateEvidenceList(
        [detail.source],
        `output.participantDetails.${field}.source`,
        participantTurnsById,
        issues,
      );
    }
  }
  for (const [itemIndex, result] of output.data.items.entries()) {
    const expected = expectedItems[itemIndex];
    const resultPath = `output.items.${String(itemIndex)}`;
    if (expected === undefined || result.itemId !== expected.itemId) {
      addIssue(
        issues,
        'item_set_mismatch',
        `${resultPath}.itemId`,
        'Evaluation result items must exactly follow the profile item order',
      );
    }
    if (expected !== undefined && result.dimensionId !== expected.dimensionId) {
      addIssue(
        issues,
        'item_dimension_mismatch',
        `${resultPath}.dimensionId`,
        'Evaluation result dimension must match its profile item',
      );
    }

    validateProfileEvidenceList(
      result.supportingEvidence,
      `${resultPath}.supportingEvidence`,
      participantTurnsById,
      issues,
    );
    validateProfileEvidenceList(
      result.counterEvidence,
      `${resultPath}.counterEvidence`,
      participantTurnsById,
      issues,
    );
    validateEvidenceDirections(result, resultPath, issues);

    if (
      result.status === 'scored' &&
      result.supportingEvidence.length + result.counterEvidence.length === 0
    ) {
      addIssue(
        issues,
        'score_without_evidence',
        `${resultPath}.supportingEvidence`,
        'A numeric score requires at least one final participant excerpt supporting or countering that score',
      );
    }
  }

  return issues.length === 0 ? success(output.data) : failure(issues);
}

export function validateOrganizationalResilienceCodingOutput(
  input: OrganizationalResilienceCodingGuardrailInput,
  candidate: unknown,
): EvaluationGuardrailResult<OrganizationalResilienceCodingOutput> {
  const rubric = organizationalResilienceRubricSchema.safeParse(input.rubric);
  const transcript = validateEvaluationTranscript(input.session);
  const output = organizationalResilienceCodingOutputSchema.safeParse(candidate);
  const issues: EvaluationGuardrailIssue[] = [];
  if (!rubric.success) issues.push(...schemaIssues(rubric.error.issues, 'rubric'));
  if (!transcript.ok) issues.push(...transcript.issues);
  if (!output.success) issues.push(...schemaIssues(output.error.issues, 'output'));
  if (!rubric.success || !transcript.ok || !output.success) return failure(issues);

  if (rubric.data.guideId !== transcript.value.guideId) {
    addIssue(
      issues,
      'guide_scope_mismatch',
      'rubric.guideId',
      'The evaluation rubric and transcript must belong to the same guide',
    );
  }
  if (output.data.items.length !== rubric.data.items.length) {
    addIssue(
      issues,
      'item_set_mismatch',
      'output.items',
      'Evaluation output must contain every rubric item exactly once and in rubric order',
    );
  }

  const turnsById = new Map(transcript.value.transcript.map((turn) => [turn.turnId, turn]));
  const crisisAbsenceEvidence =
    output.data.crisisContext.mode === 'no_crisis_experience'
      ? output.data.crisisContext.evidence.filter(
          (reference) => reference.specificity === 'absence_of_crisis_experience',
        )
      : [];
  for (const [itemIndex, result] of output.data.items.entries()) {
    const expected = rubric.data.items[itemIndex];
    const resultPath = `output.items.${String(itemIndex)}`;
    if (expected === undefined || result.itemId !== expected.itemId) {
      addIssue(
        issues,
        'item_set_mismatch',
        `${resultPath}.itemId`,
        'Evaluation result items must exactly follow the rubric item order',
      );
    }
    if (expected !== undefined && result.dimensionId !== expected.dimensionId) {
      addIssue(
        issues,
        'item_dimension_mismatch',
        `${resultPath}.dimensionId`,
        'Evaluation result dimension must match its rubric item',
      );
    }
    validateEvidenceList(
      result.supportingEvidence,
      `${resultPath}.supportingEvidence`,
      turnsById,
      issues,
    );
    validateEvidenceList(
      result.counterEvidence,
      `${resultPath}.counterEvidence`,
      turnsById,
      issues,
    );
    validateEvidenceList(
      result.ambiguousEvidence,
      `${resultPath}.ambiguousEvidence`,
      turnsById,
      issues,
    );
    validateEvidenceDirections(result, resultPath, issues);
    if (expected !== undefined) {
      validateInterpolationRule(rubric.data.version, expected, result, resultPath, issues);
    }
    if (result.status === 'scored' && expected !== undefined) {
      const scoreEvidence = [...result.supportingEvidence, ...result.counterEvidence];
      if (
        scoreEvidence.some(
          (reference) =>
            reference.specificity === 'absence_of_crisis_experience' ||
            crisisAbsenceEvidence.some((absence) => evidenceClaimsOverlap(reference, absence)),
        )
      ) {
        addIssue(
          issues,
          'absence_as_low_score',
          `${resultPath}.score`,
          'Absence of crisis experience cannot justify a numeric resilience score',
        );
      }
      if (
        scoreEvidence.length > 0 &&
        scoreEvidence.every((reference) => reference.specificity === 'hypothetical_statement')
      ) {
        addIssue(
          issues,
          'hypothetical_as_observed_score',
          `${resultPath}.score`,
          'Exclusively hypothetical statements cannot justify an observed resilience score',
        );
      }
      for (const [anchorIndex, anchor] of result.matchedAnchors.entries()) {
        const expectedAnchor = expected.anchors.find(
          (candidate) => candidate.score === anchor.score,
        );
        if (
          expectedAnchor === undefined ||
          expectedAnchor.interpretation !== anchor.interpretation
        ) {
          addIssue(
            issues,
            'invalid_anchor_reference',
            `${resultPath}.matchedAnchors.${String(anchorIndex)}`,
            'Matched anchors must reference the exact approved rubric anchor',
          );
        }
      }
      validateAnchorRelationships(result, resultPath, issues);
    }
  }

  validateEvidenceList(
    output.data.crisisContext.evidence,
    'output.crisisContext.evidence',
    turnsById,
    issues,
  );
  if (
    output.data.crisisContext.mode === 'no_crisis_experience' &&
    !output.data.crisisContext.evidence.some(
      (reference) => reference.specificity === 'absence_of_crisis_experience',
    )
  ) {
    addIssue(
      issues,
      'invalid_crisis_context',
      'output.crisisContext.evidence',
      'No-crisis context requires a verbatim absence-of-crisis participant reference',
    );
  }
  if (
    output.data.crisisContext.mode === 'actual_event' &&
    (output.data.crisisContext.eventLabel === null ||
      !output.data.crisisContext.evidence.some(
        (reference) => reference.specificity === 'concrete_event',
      ))
  ) {
    addIssue(
      issues,
      'invalid_crisis_context',
      'output.crisisContext',
      'Actual-event context requires an event label and concrete-event participant evidence',
    );
  }
  if (
    output.data.crisisContext.mode === 'hypothetical' &&
    !output.data.crisisContext.evidence.some(
      (reference) => reference.specificity === 'hypothetical_statement',
    )
  ) {
    addIssue(
      issues,
      'invalid_crisis_context',
      'output.crisisContext.evidence',
      'Hypothetical context requires a hypothetical participant reference',
    );
  }
  for (const [phaseIndex, phase] of output.data.processPhases.entries()) {
    validateEvidenceList(
      phase.evidence,
      `output.processPhases.${String(phaseIndex)}.evidence`,
      turnsById,
      issues,
    );
    if (phase.status !== 'not_covered' && phase.evidence.length === 0) {
      addIssue(
        issues,
        'unsupported_process_phase',
        `output.processPhases.${String(phaseIndex)}.evidence`,
        'A covered or partially covered process phase requires participant evidence',
      );
    }
    for (const [evidenceIndex, reference] of phase.evidence.entries()) {
      if (reference.phase !== phase.phase) {
        addIssue(
          issues,
          'evidence_phase_mismatch',
          `output.processPhases.${String(phaseIndex)}.evidence.${String(evidenceIndex)}.phase`,
          'Process-phase evidence must identify its containing phase',
        );
      }
    }
  }

  return issues.length === 0 ? success(output.data) : failure(issues);
}

function validateInterpolationRule(
  rubricVersion: number,
  rubricItem: OrganizationalResilienceRubric['items'][number],
  result: OrganizationalResilienceCodingOutput['items'][number],
  path: string,
  issues: EvaluationGuardrailIssue[],
): void {
  if (rubricVersion < 2) {
    return;
  }
  if (
    result.status !== 'scored' ||
    result.score === 1 ||
    result.score === 4 ||
    result.score === 7
  ) {
    if (
      result.appliedInterpolationRuleId !== undefined &&
      result.appliedInterpolationRuleId !== null
    ) {
      addIssue(
        issues,
        'invalid_interpolation_rule',
        `${path}.appliedInterpolationRuleId`,
        'Only an intermediate numeric score may reference an interpolation rule',
      );
    }
    return;
  }
  const rule = rubricItem.interpolationRules?.find((candidate) => candidate.score === result.score);
  if (rule === undefined || result.appliedInterpolationRuleId !== rule.ruleId) {
    addIssue(
      issues,
      'invalid_interpolation_rule',
      `${path}.appliedInterpolationRuleId`,
      'An intermediate score must reference its exact item-specific interpolation rule',
    );
  }
}

function evidenceClaimsOverlap(
  left: OrganizationalResilienceEvidenceReference,
  right: OrganizationalResilienceEvidenceReference,
): boolean {
  return (
    left.turnId === right.turnId &&
    (left.verbatimExcerpt.includes(right.verbatimExcerpt) ||
      right.verbatimExcerpt.includes(left.verbatimExcerpt))
  );
}

function validateEvidenceDirections(
  result: {
    readonly supportingEvidence: readonly TranscriptEvidenceReference[];
    readonly counterEvidence: readonly TranscriptEvidenceReference[];
    readonly ambiguousEvidence?: readonly TranscriptEvidenceReference[];
  },
  path: string,
  issues: EvaluationGuardrailIssue[],
): void {
  const directions = [
    ['supportingEvidence', result.supportingEvidence],
    ['counterEvidence', result.counterEvidence],
    ['ambiguousEvidence', result.ambiguousEvidence ?? []],
  ] as const;
  const observed = new Map<string, string>();
  for (const [field, references] of directions) {
    for (const [index, reference] of references.entries()) {
      const key = `${reference.turnId}\u0000${reference.verbatimExcerpt}`;
      const prior = observed.get(key);
      if (prior !== undefined && prior !== field) {
        addIssue(
          issues,
          'duplicate_evidence_direction',
          `${path}.${field}.${String(index)}`,
          'The same excerpt cannot have multiple evidence directions for one item',
        );
      }
      observed.set(key, field);
    }
  }
}

function validateAnchorRelationships(
  result: Extract<
    OrganizationalResilienceCodingOutput['items'][number],
    { readonly status: 'scored' }
  >,
  path: string,
  issues: EvaluationGuardrailIssue[],
): void {
  const expected =
    result.score === 1 || result.score === 4 || result.score === 7
      ? [{ score: result.score, relationship: 'exact' }]
      : result.score < 4
        ? [
            { score: 1, relationship: 'lower_bound' },
            { score: 4, relationship: 'upper_bound' },
          ]
        : [
            { score: 4, relationship: 'lower_bound' },
            { score: 7, relationship: 'upper_bound' },
          ];
  for (const reference of expected) {
    if (
      !result.matchedAnchors.some(
        (anchor) =>
          anchor.score === reference.score && anchor.relationship === reference.relationship,
      )
    ) {
      addIssue(
        issues,
        'invalid_anchor_reference',
        `${path}.matchedAnchors`,
        'Matched anchor relationships do not correspond to the assigned score',
      );
    }
  }
}

function validateProfileEvidenceList(
  evidence: readonly ProfileEvaluationEvidenceReference[],
  path: string,
  turnsById: ReadonlyMap<string, MvpInterviewSession['transcript'][number]>,
  issues: EvaluationGuardrailIssue[],
): void {
  validateEvidenceList(evidence, path, turnsById, issues);
  for (const [index, reference] of evidence.entries()) {
    validateEvidenceList(
      reference.additionalSources ?? [],
      `${path}.${String(index)}.additionalSources`,
      turnsById,
      issues,
    );
  }
}

function validateEvidenceList(
  evidence: readonly TranscriptEvidenceReference[],
  path: string,
  turnsById: ReadonlyMap<string, MvpInterviewSession['transcript'][number]>,
  issues: EvaluationGuardrailIssue[],
): void {
  for (const [evidenceIndex, reference] of evidence.entries()) {
    const evidencePath = `${path}.${String(evidenceIndex)}`;
    const turn = turnsById.get(reference.turnId);
    if (turn === undefined || turn.speaker !== 'participant') {
      addIssue(
        issues,
        'invalid_evidence_turn',
        `${evidencePath}.turnId`,
        'Evaluation evidence must reference a final participant turn in this transcript',
      );
      continue;
    }
    if (turn.sequenceNumber !== reference.sequenceNumber) {
      addIssue(
        issues,
        'evidence_sequence_mismatch',
        `${evidencePath}.sequenceNumber`,
        'Evidence sequence number does not match the referenced transcript turn',
      );
    }
    if (!turn.text.includes(reference.verbatimExcerpt)) {
      addIssue(
        issues,
        'non_verbatim_evidence',
        `${evidencePath}.verbatimExcerpt`,
        'Evidence excerpts must occur verbatim in the referenced participant turn',
      );
    }
  }
}

interface TranscriptEvidenceReference {
  readonly turnId: string;
  readonly sequenceNumber: number;
  readonly verbatimExcerpt: string;
}

function guideQuestionIds(guide: GuideStructure): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const section of guide.sections) {
    for (const mainQuestion of section.mainQuestions) {
      ids.add(mainQuestion.id);
      for (const followUp of mainQuestion.followUpQuestions) ids.add(followUp.id);
    }
  }
  return ids;
}

function schemaIssues(
  issues: readonly z.core.$ZodIssue[],
  prefix = '',
): EvaluationGuardrailIssue[] {
  return issues.map((issue) => ({
    code: 'schema_invalid',
    path: [prefix, ...issue.path.map(String)].filter((segment) => segment.length > 0).join('.'),
    message: issue.message,
  }));
}

function addIssue(
  issues: EvaluationGuardrailIssue[],
  code: EvaluationGuardrailIssue['code'],
  path: string,
  message: string,
): void {
  issues.push({ code, path, message });
}

function success<Value>(value: Value): EvaluationGuardrailResult<Value> {
  return { ok: true, value };
}

function failure<Value = never>(
  issues: readonly EvaluationGuardrailIssue[],
): EvaluationGuardrailResult<Value> {
  return { ok: false, issues };
}
