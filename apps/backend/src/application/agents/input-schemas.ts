import {
  AGENT_DATA_LIMITS,
  INTERVIEW_GUIDE_LIMITS,
  canonicalTranscriptSchema,
  consistencyAnalysisOutputSchema,
  coverageAnalysisOutputSchema,
  guideQuestionReferenceSchema,
  guideStructureSchema,
  idSchema,
  interviewDecisionOutputSchema,
  interviewStateSchema,
  nonBlankTextSchema,
  type CanonicalTranscript,
  type GuideQuestionReference,
  type GuideStructure,
  type InterviewState,
} from '@orgscience/contracts';
import { buildGuideQuestionCatalog } from '@orgscience/domain';
import { z } from 'zod';

const transcriptPromptPreflightSchema = z.unknown().superRefine((value, context) => {
  if (!isRecord(value) || !Array.isArray(value.entries)) return;
  if (value.entries.length > AGENT_DATA_LIMITS.maximumTranscriptEntries) {
    addIssue(
      context,
      ['entries'],
      `Agent prompt transcripts may contain at most ${AGENT_DATA_LIMITS.maximumTranscriptEntries} entries`,
    );
    return;
  }

  let codePoints = 0;
  for (const entry of value.entries) {
    if (!isRecord(entry)) continue;
    const content = typeof entry.text === 'string' ? entry.text : entry.description;
    if (typeof content !== 'string') continue;
    codePoints += countCodePointsThrough(
      content,
      AGENT_DATA_LIMITS.maximumTranscriptCodePoints + 1,
    );
    if (codePoints > AGENT_DATA_LIMITS.maximumTranscriptCodePoints) {
      addIssue(
        context,
        ['entries'],
        `Agent prompt transcript text may contain at most ${AGENT_DATA_LIMITS.maximumTranscriptCodePoints} code points`,
      );
      return;
    }
  }
});

const boundedTranscriptSchema = transcriptPromptPreflightSchema.pipe(canonicalTranscriptSchema);

const boundedQuestionIdsSchema = z
  .array(idSchema)
  .max(INTERVIEW_GUIDE_LIMITS.maximumTotalQuestions);

const uniqueQuestionIdsSchema = boundedQuestionIdsSchema.refine(
  (ids) => new Set(ids).size === ids.length,
  'Question IDs must be unique',
);

const nonEmptyUniqueQuestionIdsSchema = boundedQuestionIdsSchema
  .min(1)
  .refine((ids) => new Set(ids).size === ids.length, 'Question IDs must be unique');

const uniqueContradictionIdsSchema = z
  .array(idSchema)
  .max(AGENT_DATA_LIMITS.maximumContradictions)
  .refine((ids) => new Set(ids).size === ids.length, 'Contradiction IDs must be unique');

const commonAgentPromptInputShape = {
  interviewId: idSchema,
  interviewStateVersion: z.number().int().nonnegative(),
  guide: guideStructureSchema,
  interviewState: interviewStateSchema,
  transcript: boundedTranscriptSchema,
};

export const coverageAnalysisPromptInputSchema = z
  .strictObject({
    agentName: z.literal('coverage_analysis'),
    ...commonAgentPromptInputShape,
    latestParticipantTurnId: idSchema,
    currentQuestion: guideQuestionReferenceSchema,
    candidateQuestionIds: nonEmptyUniqueQuestionIdsSchema,
  })
  .superRefine((input, context) => {
    validateCommonScope(input, context, false);
    validateLatestParticipantTurn(
      input.transcript,
      input.latestParticipantTurnId,
      input.currentQuestion,
      context,
    );
    validateCurrentQuestion(input.guide, input.interviewState, input.currentQuestion, context);
    validateCandidateQuestionIds(input.guide, input.candidateQuestionIds, context);
    if (!input.candidateQuestionIds.includes(questionReferenceId(input.currentQuestion))) {
      addIssue(
        context,
        ['candidateQuestionIds'],
        'Coverage candidates must include the current question',
      );
    }
  });

export const consistencyAnalysisPromptInputSchema = z
  .strictObject({
    agentName: z.literal('consistency_analysis'),
    ...commonAgentPromptInputShape,
    latestParticipantTurnId: idSchema,
    currentQuestion: guideQuestionReferenceSchema,
    allowedContradictionIds: uniqueContradictionIdsSchema,
    existingContradictionIds: uniqueContradictionIdsSchema,
  })
  .superRefine((input, context) => {
    validateCommonScope(input, context, false);
    validateLatestParticipantTurn(
      input.transcript,
      input.latestParticipantTurnId,
      input.currentQuestion,
      context,
    );
    validateCurrentQuestion(input.guide, input.interviewState, input.currentQuestion, context);

    const existingIds = new Set(input.existingContradictionIds);
    for (const [index, contradictionId] of input.allowedContradictionIds.entries()) {
      if (existingIds.has(contradictionId)) {
        addIssue(
          context,
          ['allowedContradictionIds', index],
          'Server-reserved contradiction IDs must not collide with existing contradiction IDs',
        );
      }
    }
  });

export const interviewDecisionPromptInputSchema = z
  .strictObject({
    agentName: z.literal('interview_decision'),
    ...commonAgentPromptInputShape,
    coverageAnalysis: coverageAnalysisOutputSchema,
    consistencyAnalysis: consistencyAnalysisOutputSchema,
    currentQuestion: guideQuestionReferenceSchema.nullable(),
    candidateQuestionIds: uniqueQuestionIdsSchema,
  })
  .superRefine((input, context) => {
    validateCommonScope(input, context, false);
    if (input.currentQuestion !== null) {
      validateCurrentQuestion(input.guide, input.interviewState, input.currentQuestion, context);
    } else if (input.interviewState.currentMainQuestion !== null) {
      addIssue(
        context,
        ['currentQuestion'],
        'A decision input must include the current guide question while a main question is active',
      );
    }
    validateCandidateQuestionIds(input.guide, input.candidateQuestionIds, context);
    validateCoverageAnalysis(input.guide, input.transcript, input.coverageAnalysis, context);
    validateConsistencyAnalysis(input.transcript, input.consistencyAnalysis, context);
  });

const clarificationQuestionSchema = nonBlankTextSchema
  .max(600)
  .refine(
    (text) => text.endsWith('?') && (text.match(/\?/gu) ?? []).length === 1,
    'A required clarification must contain exactly one question mark and end with it',
  );

export const interviewConductorPromptInputSchema = z
  .strictObject({
    agentName: z.literal('interview_conductor'),
    ...commonAgentPromptInputShape,
    decision: interviewDecisionOutputSchema,
    selectedQuestionText: nonBlankTextSchema.max(2_000).nullable(),
    requiredClarificationQuestion: clarificationQuestionSchema.nullable(),
    allowGreeting: z.boolean(),
    allowTransition: z.boolean(),
  })
  .superRefine((input, context) => {
    validateCommonScope(input, context, false);
    validateDecision(input.guide, input.transcript, input.decision, context);
    validateConductorShape(input, context);
  });

const deterministicValidationIssueSchema = z.strictObject({
  code: nonBlankTextSchema.max(100),
  message: nonBlankTextSchema.max(1_000),
  entryId: idSchema.nullable(),
});

const deterministicValidationSchema = z
  .strictObject({
    valid: z.boolean(),
    issues: z
      .array(deterministicValidationIssueSchema)
      .max(AGENT_DATA_LIMITS.maximumFinalizationIssues),
  })
  .superRefine((validation, context) => {
    if (validation.valid !== (validation.issues.length === 0)) {
      addIssue(
        context,
        ['valid'],
        'Deterministic validation is valid exactly when it contains no issues',
      );
    }
    if (!validation.valid) {
      addIssue(
        context,
        ['valid'],
        'Transcript finalization agents require a successful deterministic validation',
      );
    }
  });

export const transcriptFinalizationPromptInputSchema = z
  .strictObject({
    agentName: z.literal('transcript_finalization'),
    ...commonAgentPromptInputShape,
    deterministicValidation: deterministicValidationSchema,
  })
  .superRefine((input, context) => {
    validateCommonScope(input, context, true);

    const entryIds = new Set(input.transcript.entries.map(canonicalEntryId));
    for (const [index, issue] of input.deterministicValidation.issues.entries()) {
      if (issue.entryId !== null && !entryIds.has(issue.entryId)) {
        addIssue(
          context,
          ['deterministicValidation', 'issues', index, 'entryId'],
          'A deterministic validation issue must reference a canonical transcript entry',
        );
      }
    }
  });

export const agentPromptInputSchema = z.discriminatedUnion('agentName', [
  coverageAnalysisPromptInputSchema,
  consistencyAnalysisPromptInputSchema,
  interviewDecisionPromptInputSchema,
  interviewConductorPromptInputSchema,
  transcriptFinalizationPromptInputSchema,
]);

interface CommonAgentPromptInput {
  readonly interviewId: string;
  readonly interviewStateVersion: number;
  readonly guide: GuideStructure;
  readonly interviewState: InterviewState;
  readonly transcript: CanonicalTranscript;
}

interface ConductorShapeInput extends CommonAgentPromptInput {
  readonly decision: z.infer<typeof interviewDecisionOutputSchema>;
  readonly selectedQuestionText: string | null;
  readonly requiredClarificationQuestion: string | null;
  readonly allowGreeting: boolean;
  readonly allowTransition: boolean;
}

function validateCommonScope(
  input: CommonAgentPromptInput,
  context: z.RefinementCtx,
  isFinalization: boolean,
): void {
  if (input.interviewState.interviewId !== input.interviewId) {
    addIssue(
      context,
      ['interviewState', 'interviewId'],
      'Interview state belongs to another interview',
    );
  }
  if (input.transcript.interviewId !== input.interviewId) {
    addIssue(context, ['transcript', 'interviewId'], 'Transcript belongs to another interview');
  }
  if (input.interviewStateVersion !== input.interviewState.version) {
    addIssue(
      context,
      ['interviewStateVersion'],
      'Prompt state version must match the loaded interview state',
    );
  }
  if (input.interviewState.guideId !== input.guide.id) {
    addIssue(context, ['interviewState', 'guideId'], 'Interview state belongs to another guide');
  }
  if (input.transcript.guideId !== input.guide.id) {
    addIssue(context, ['transcript', 'guideId'], 'Transcript belongs to another guide');
  }
  if (input.interviewState.language !== input.guide.sourceLanguage) {
    addIssue(
      context,
      ['interviewState', 'language'],
      'Interview state language must match the guide source language',
    );
  }

  if (input.interviewState.currentMainQuestion !== null) {
    validateGuideReference(
      input.guide,
      input.interviewState.currentMainQuestion,
      ['interviewState', 'currentMainQuestion'],
      context,
    );
  }

  const transcriptTurnIds = new Set<string>();
  for (const [index, entry] of input.transcript.entries.entries()) {
    if (entry.kind !== 'turn') continue;
    transcriptTurnIds.add(entry.turnId);
    if (entry.guideReference !== null) {
      validateGuideReference(
        input.guide,
        entry.guideReference,
        ['transcript', 'entries', index, 'guideReference'],
        context,
      );
    }
  }

  const coverageQuestionIds = new Set<string>();
  for (const [index, coverage] of input.interviewState.coverage.entries()) {
    validateGuideReference(
      input.guide,
      coverage.question,
      ['interviewState', 'coverage', index, 'question'],
      context,
    );
    coverageQuestionIds.add(questionReferenceId(coverage.question));
    for (const [turnIndex, turnId] of coverage.transcriptTurnIds.entries()) {
      if (!transcriptTurnIds.has(turnId)) {
        addIssue(
          context,
          ['interviewState', 'coverage', index, 'transcriptTurnIds', turnIndex],
          'Coverage evidence must reference a canonical transcript turn',
        );
      }
    }
  }
  for (const question of buildGuideQuestionCatalog(input.guide)) {
    if (!coverageQuestionIds.has(question.questionId)) {
      addIssue(
        context,
        ['interviewState', 'coverage'],
        `Interview coverage is missing guide question ${question.questionId}`,
      );
    }
  }

  if (isFinalization) {
    if (input.interviewState.lifecycle.status !== 'completed') {
      addIssue(
        context,
        ['interviewState', 'lifecycle', 'status'],
        'Transcript finalization requires a completed interview',
      );
    }
    if (input.interviewState.activeWorkflowRunId !== null) {
      addIssue(
        context,
        ['interviewState', 'activeWorkflowRunId'],
        'Transcript finalization requires no active workflow run',
      );
    }
    if (input.transcript.finalizedAt === null) {
      addIssue(
        context,
        ['transcript', 'finalizedAt'],
        'Transcript finalization requires a finalized canonical transcript',
      );
    }
  } else {
    if (input.interviewState.lifecycle.status !== 'active') {
      addIssue(
        context,
        ['interviewState', 'lifecycle', 'status'],
        'Interview agents require an active interview',
      );
    }
    if (input.interviewState.activeWorkflowRunId === null) {
      addIssue(
        context,
        ['interviewState', 'activeWorkflowRunId'],
        'Interview agents require an active workflow run',
      );
    }
    if (input.transcript.finalizedAt !== null) {
      addIssue(
        context,
        ['transcript', 'finalizedAt'],
        'Non-finalization agents require a non-finalized canonical transcript',
      );
    }
  }
}

function validateLatestParticipantTurn(
  transcript: CanonicalTranscript,
  latestParticipantTurnId: string,
  currentQuestion: GuideQuestionReference,
  context: z.RefinementCtx,
): void {
  const matchingTurn = transcript.entries.find(
    (entry) => entry.kind === 'turn' && entry.turnId === latestParticipantTurnId,
  );
  if (matchingTurn === undefined || matchingTurn.kind !== 'turn') {
    addIssue(
      context,
      ['latestParticipantTurnId'],
      'Latest participant turn must exist in the canonical transcript',
    );
    return;
  }
  if (matchingTurn.speaker !== 'participant') {
    addIssue(
      context,
      ['latestParticipantTurnId'],
      'Latest participant turn must identify a participant turn',
    );
    return;
  }
  if (
    matchingTurn.guideReference === null ||
    !sameQuestionReference(matchingTurn.guideReference, currentQuestion)
  ) {
    addIssue(
      context,
      ['latestParticipantTurnId'],
      'Latest participant turn must answer the supplied current guide question',
    );
  }

  const latestParticipantTurn = transcript.entries.findLast(
    (entry) => entry.kind === 'turn' && entry.speaker === 'participant',
  );
  if (
    latestParticipantTurn === undefined ||
    latestParticipantTurn.kind !== 'turn' ||
    latestParticipantTurn.turnId !== latestParticipantTurnId
  ) {
    addIssue(
      context,
      ['latestParticipantTurnId'],
      'Latest participant turn must identify the most recent participant turn',
    );
  }
}

function validateCurrentQuestion(
  guide: GuideStructure,
  interviewState: InterviewState,
  currentQuestion: GuideQuestionReference,
  context: z.RefinementCtx,
): void {
  validateGuideReference(guide, currentQuestion, ['currentQuestion'], context);
  const currentMainQuestion = interviewState.currentMainQuestion;
  if (
    currentMainQuestion === null ||
    !belongsToMainQuestion(currentQuestion, currentMainQuestion)
  ) {
    addIssue(
      context,
      ['currentQuestion'],
      'Current question must belong to the interview state current main question',
    );
  }
  const currentCoverage = interviewState.coverage.find((coverage) => coverage.status === 'current');
  if (
    currentCoverage === undefined ||
    !sameQuestionReference(currentCoverage.question, currentQuestion)
  ) {
    addIssue(
      context,
      ['currentQuestion'],
      'Current question must exactly match the current coverage record',
    );
  }
}

function validateCandidateQuestionIds(
  guide: GuideStructure,
  candidateQuestionIds: readonly string[],
  context: z.RefinementCtx,
): void {
  const questionIds = new Set(questionCatalog(guide).keys());
  for (const [index, questionId] of candidateQuestionIds.entries()) {
    if (!questionIds.has(questionId)) {
      addIssue(
        context,
        ['candidateQuestionIds', index],
        'Candidate question ID must exist in the supplied guide',
      );
    }
  }
}

function validateCoverageAnalysis(
  guide: GuideStructure,
  transcript: CanonicalTranscript,
  analysis: z.infer<typeof coverageAnalysisOutputSchema>,
  context: z.RefinementCtx,
): void {
  const turnIds = canonicalTurnIds(transcript);
  for (const [index, finding] of analysis.findings.entries()) {
    validateGuideReference(
      guide,
      finding.question,
      ['coverageAnalysis', 'findings', index, 'question'],
      context,
    );
  }
  validateTranscriptTurnReferences(
    analysis.referencedTranscriptTurnIds,
    turnIds,
    ['coverageAnalysis', 'referencedTranscriptTurnIds'],
    context,
  );
}

function validateConsistencyAnalysis(
  transcript: CanonicalTranscript,
  analysis: z.infer<typeof consistencyAnalysisOutputSchema>,
  context: z.RefinementCtx,
): void {
  validateTranscriptTurnReferences(
    analysis.referencedTranscriptTurnIds,
    canonicalTurnIds(transcript),
    ['consistencyAnalysis', 'referencedTranscriptTurnIds'],
    context,
  );
}

function validateDecision(
  guide: GuideStructure,
  transcript: CanonicalTranscript,
  decision: z.infer<typeof interviewDecisionOutputSchema>,
  context: z.RefinementCtx,
): void {
  for (const [index, question] of decision.consideredQuestions.entries()) {
    validateGuideReference(guide, question, ['decision', 'consideredQuestions', index], context);
  }
  if (decision.selectedAction.action !== 'complete_interview') {
    validateGuideReference(
      guide,
      decision.selectedAction.target,
      ['decision', 'selectedAction', 'target'],
      context,
    );
  }
  validateTranscriptTurnReferences(
    decision.referencedTranscriptTurnIds,
    canonicalTurnIds(transcript),
    ['decision', 'referencedTranscriptTurnIds'],
    context,
  );
}

function validateConductorShape(input: ConductorShapeInput, context: z.RefinementCtx): void {
  const action = input.decision.selectedAction;
  if (action.action === 'complete_interview') {
    if (input.selectedQuestionText !== null) {
      addIssue(context, ['selectedQuestionText'], 'A completion decision has no selected question');
    }
    if (input.requiredClarificationQuestion !== null) {
      addIssue(
        context,
        ['requiredClarificationQuestion'],
        'A completion decision has no required clarification question',
      );
    }
    if (input.allowGreeting || input.allowTransition) {
      addIssue(context, ['allowGreeting'], 'A completion decision cannot add a preface');
    }
    return;
  }

  if (action.action === 'ask_clarification_question') {
    if (input.selectedQuestionText !== null) {
      addIssue(
        context,
        ['selectedQuestionText'],
        'A clarification decision uses requiredClarificationQuestion instead of selectedQuestionText',
      );
    }
    if (input.requiredClarificationQuestion === null) {
      addIssue(
        context,
        ['requiredClarificationQuestion'],
        'A clarification decision requires its exact clarification question',
      );
    }
    if (input.allowGreeting || input.allowTransition) {
      addIssue(context, ['allowGreeting'], 'A clarification question cannot add a preface');
    }
    return;
  }

  if (input.requiredClarificationQuestion !== null) {
    addIssue(
      context,
      ['requiredClarificationQuestion'],
      'A guide question decision must not supply a clarification question',
    );
  }

  const selectedQuestion = questionCatalog(input.guide).get(questionReferenceId(action.target));
  if (input.selectedQuestionText === null) {
    addIssue(
      context,
      ['selectedQuestionText'],
      'A guide question decision requires its source text',
    );
  } else if (selectedQuestion?.text !== input.selectedQuestionText) {
    addIssue(
      context,
      ['selectedQuestionText'],
      'Selected question text must exactly match the selected guide question',
    );
  }

  if (input.allowGreeting && input.allowTransition) {
    addIssue(context, ['allowTransition'], 'Greeting and transition cannot both be enabled');
  }
  if (input.allowGreeting && input.transcript.entries.length > 0) {
    addIssue(
      context,
      ['allowGreeting'],
      'Greeting is allowed only before the first transcript entry',
    );
  }
  if (input.allowGreeting && action.action !== 'ask_main_question') {
    addIssue(context, ['allowGreeting'], 'A greeting may introduce only a main question');
  }
  if (input.allowTransition && input.transcript.entries.length === 0) {
    addIssue(context, ['allowTransition'], 'A transition requires preceding transcript context');
  }
}

interface QuestionCatalogEntry {
  readonly reference: GuideQuestionReference;
  readonly text: string;
}

function questionCatalog(guide: GuideStructure): ReadonlyMap<string, QuestionCatalogEntry> {
  return new Map(
    buildGuideQuestionCatalog(guide).map((question) => [
      question.questionId,
      { reference: question.reference, text: question.text },
    ]),
  );
}

function validateGuideReference(
  guide: GuideStructure,
  reference: GuideQuestionReference,
  path: PropertyKey[],
  context: z.RefinementCtx,
): void {
  const entry = questionCatalog(guide).get(questionReferenceId(reference));
  if (entry === undefined || !sameQuestionReference(entry.reference, reference)) {
    addIssue(context, path, 'Question reference must identify a question in the supplied guide');
  }
}

function validateTranscriptTurnReferences(
  referencedTurnIds: readonly string[],
  validTurnIds: ReadonlySet<string>,
  path: PropertyKey[],
  context: z.RefinementCtx,
): void {
  for (const [index, turnId] of referencedTurnIds.entries()) {
    if (!validTurnIds.has(turnId)) {
      addIssue(
        context,
        [...path, index],
        'Referenced transcript turn must exist in the canonical transcript',
      );
    }
  }
}

function canonicalTurnIds(transcript: CanonicalTranscript): ReadonlySet<string> {
  return new Set(
    transcript.entries
      .filter((entry) => entry.kind === 'turn')
      .map((entry) => (entry.kind === 'turn' ? entry.turnId : '')),
  );
}

function canonicalEntryId(entry: CanonicalTranscript['entries'][number]): string {
  return entry.kind === 'turn' ? entry.turnId : entry.gapId;
}

function questionReferenceId(reference: GuideQuestionReference): string {
  return reference.kind === 'main_question'
    ? reference.mainQuestionId
    : reference.followUpQuestionId;
}

function sameQuestionReference(
  first: GuideQuestionReference,
  second: GuideQuestionReference,
): boolean {
  if (
    first.kind !== second.kind ||
    first.guideId !== second.guideId ||
    first.sectionId !== second.sectionId ||
    first.mainQuestionId !== second.mainQuestionId
  ) {
    return false;
  }
  return (
    first.kind === 'main_question' ||
    (second.kind === 'follow_up_question' && first.followUpQuestionId === second.followUpQuestionId)
  );
}

function belongsToMainQuestion(
  question: GuideQuestionReference,
  mainQuestion: Extract<GuideQuestionReference, { readonly kind: 'main_question' }>,
): boolean {
  return (
    question.guideId === mainQuestion.guideId &&
    question.sectionId === mainQuestion.sectionId &&
    question.mainQuestionId === mainQuestion.mainQuestionId
  );
}

function addIssue(context: z.RefinementCtx, path: PropertyKey[], message: string): void {
  context.addIssue({ code: 'custom', path, message });
}

function isRecord(value: unknown): value is Readonly<Record<PropertyKey, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function countCodePointsThrough(value: string, maximum: number): number {
  let count = 0;
  let offset = 0;
  while (offset < value.length) {
    const codePoint = value.codePointAt(offset);
    offset += codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
    count += 1;
    if (count >= maximum) return count;
  }
  return count;
}

export type CoverageAnalysisPromptInput = z.infer<typeof coverageAnalysisPromptInputSchema>;
export type ConsistencyAnalysisPromptInput = z.infer<typeof consistencyAnalysisPromptInputSchema>;
export type InterviewDecisionPromptInput = z.infer<typeof interviewDecisionPromptInputSchema>;
export type InterviewConductorPromptInput = z.infer<typeof interviewConductorPromptInputSchema>;
export type TranscriptFinalizationPromptInput = z.infer<
  typeof transcriptFinalizationPromptInputSchema
>;
export type AgentPromptInput = z.infer<typeof agentPromptInputSchema>;
