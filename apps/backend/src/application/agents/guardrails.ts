import {
  conductorOutputSchema,
  consistencyAnalysisOutputSchema,
  coverageAnalysisOutputSchema,
  interviewDecisionOutputSchema,
  transcriptFinalizationReportSchema,
  type CanonicalTranscriptEntry,
  type ConductorOutput,
  type ConsistencyAnalysisOutput,
  type CoverageAnalysisOutput,
  type GuideQuestionReference,
  type InterviewDecisionOutput,
  type QuestionCoverageStatus,
  type TranscriptFinalizationReport,
} from '@orgscience/contracts';
import { buildGuideQuestionCatalog } from '@orgscience/domain';

import type {
  ConsistencyAnalysisPromptInput,
  CoverageAnalysisPromptInput,
  InterviewConductorPromptInput,
  InterviewDecisionPromptInput,
  TranscriptFinalizationPromptInput,
} from './input-schemas.js';

export interface AgentGuardrailIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export type AgentGuardrailResult<Output> =
  | { readonly ok: true; readonly output: Output }
  | { readonly ok: false; readonly issues: readonly AgentGuardrailIssue[] };

const TERMINAL_COVERAGE_STATUSES = new Set<QuestionCoverageStatus>([
  'answered',
  'skipped_already_answered',
]);

const ALLOWED_COVERAGE_TRANSITIONS: Readonly<
  Record<QuestionCoverageStatus, ReadonlySet<QuestionCoverageStatus>>
> = {
  not_addressed: new Set([
    'not_addressed',
    'current',
    'partially_answered',
    'answered',
    'skipped_already_answered',
  ]),
  current: new Set(['current', 'partially_answered', 'answered', 'skipped_already_answered']),
  partially_answered: new Set([
    'current',
    'partially_answered',
    'answered',
    'skipped_already_answered',
  ]),
  answered: new Set(['answered']),
  skipped_already_answered: new Set(['skipped_already_answered']),
};

export function validateCoverageAnalysisOutput(
  input: CoverageAnalysisPromptInput,
  candidate: unknown,
): AgentGuardrailResult<CoverageAnalysisOutput> {
  const parsed = coverageAnalysisOutputSchema.safeParse(candidate);
  if (!parsed.success) return schemaFailure(parsed.error.issues);

  const issues: AgentGuardrailIssue[] = [];
  const catalog = buildGuideQuestionCatalog(input.guide);
  const catalogById = new Map(catalog.map((question) => [question.questionId, question]));
  const allowedCandidateIds = new Set(input.candidateQuestionIds);
  const allowedTurnIds = participantTurnIds(input.transcript.entries);
  const persistedCoverageById = new Map(
    input.interviewState.coverage.map((coverage) => [
      questionIdFromReference(coverage.question),
      coverage.status,
    ]),
  );
  const findingsTurnIds = new Set<string>();

  for (const [index, finding] of parsed.data.findings.entries()) {
    const questionId = questionIdFromReference(finding.question);
    const catalogQuestion = catalogById.get(questionId);
    if (
      catalogQuestion === undefined ||
      !sameQuestionReference(catalogQuestion.reference, finding.question)
    ) {
      addIssue(
        issues,
        'unknown_question',
        `findings.${index}.question`,
        'Question is not in guide',
      );
    }
    if (!allowedCandidateIds.has(questionId)) {
      addIssue(
        issues,
        'question_not_allowed',
        `findings.${index}.question`,
        'Question was not an allowed coverage candidate',
      );
    }
    const persistedStatus = persistedCoverageById.get(questionId);
    if (
      persistedStatus === undefined ||
      !ALLOWED_COVERAGE_TRANSITIONS[persistedStatus].has(finding.status)
    ) {
      addIssue(
        issues,
        'invalid_coverage_transition',
        `findings.${index}.status`,
        'Coverage analysis cannot regress or mutate terminal persisted coverage',
      );
    }
    for (const [turnIndex, turnId] of finding.transcriptTurnIds.entries()) {
      findingsTurnIds.add(turnId);
      if (!allowedTurnIds.has(turnId)) {
        addIssue(
          issues,
          'invalid_evidence',
          `findings.${index}.transcriptTurnIds.${turnIndex}`,
          'Coverage evidence must be a supplied participant turn',
        );
      }
    }
  }
  const expectedAnalysisTurnIds = new Set(findingsTurnIds);
  expectedAnalysisTurnIds.add(input.latestParticipantTurnId);
  requireExactIds(
    issues,
    parsed.data.referencedTranscriptTurnIds,
    expectedAnalysisTurnIds,
    'referencedTranscriptTurnIds',
    'Coverage references must exactly equal finding evidence',
  );

  if (
    !parsed.data.findings.some((finding) =>
      sameQuestionReference(finding.question, input.currentQuestion),
    )
  ) {
    addIssue(
      issues,
      'current_question_missing',
      'findings',
      'Coverage analysis must report the current guide question',
    );
  }
  if (!parsed.data.referencedTranscriptTurnIds.includes(input.latestParticipantTurnId)) {
    addIssue(
      issues,
      'latest_turn_missing',
      'referencedTranscriptTurnIds',
      'Coverage analysis findings must use the latest participant turn',
    );
  }
  return finish(parsed.data, issues);
}

export function validateConsistencyAnalysisOutput(
  input: ConsistencyAnalysisPromptInput,
  candidate: unknown,
): AgentGuardrailResult<ConsistencyAnalysisOutput> {
  const parsed = consistencyAnalysisOutputSchema.safeParse(candidate);
  if (!parsed.success) return schemaFailure(parsed.error.issues);

  const issues: AgentGuardrailIssue[] = [];
  const allowedTurnIds = participantTurnIds(input.transcript.entries);
  const allowedContradictionIds = new Set(input.allowedContradictionIds);
  const existingContradictionIds = new Set(input.existingContradictionIds);
  const contradictionTurnIds = new Set<string>();
  for (const [index, contradiction] of parsed.data.contradictions.entries()) {
    if (
      !allowedContradictionIds.has(contradiction.id) ||
      existingContradictionIds.has(contradiction.id)
    ) {
      addIssue(
        issues,
        'invalid_contradiction_id',
        `contradictions.${index}.id`,
        'Contradiction ID is not a new server-allowed identity',
      );
    }
    for (const [turnIndex, turnId] of contradiction.transcriptTurnIds.entries()) {
      contradictionTurnIds.add(turnId);
      if (!allowedTurnIds.has(turnId)) {
        addIssue(
          issues,
          'invalid_evidence',
          `contradictions.${index}.transcriptTurnIds.${turnIndex}`,
          'Contradiction evidence must be a supplied participant turn',
        );
      }
    }
    if (!contradiction.transcriptTurnIds.includes(input.latestParticipantTurnId)) {
      addIssue(
        issues,
        'latest_turn_missing',
        `contradictions.${index}.transcriptTurnIds`,
        'A new contradiction must involve the latest participant turn',
      );
    }
    if (isSuggestiveQuestion(contradiction.suggestedClarificationQuestion)) {
      addIssue(
        issues,
        'suggestive_question',
        `contradictions.${index}.suggestedClarificationQuestion`,
        'Clarification questions must remain neutral and non-leading',
      );
    }
  }
  requireExactIds(
    issues,
    parsed.data.referencedTranscriptTurnIds,
    contradictionTurnIds,
    'referencedTranscriptTurnIds',
    'Consistency references must exactly equal contradiction evidence',
  );
  return finish(parsed.data, issues);
}

export function validateInterviewDecisionOutput(
  input: InterviewDecisionPromptInput,
  candidate: unknown,
): AgentGuardrailResult<InterviewDecisionOutput> {
  const parsed = interviewDecisionOutputSchema.safeParse(candidate);
  if (!parsed.success) return schemaFailure(parsed.error.issues);

  const issues: AgentGuardrailIssue[] = [];
  const catalog = buildGuideQuestionCatalog(input.guide);
  const catalogById = new Map(catalog.map((question) => [question.questionId, question]));
  const allowedCandidates = new Set(input.candidateQuestionIds);
  const effectiveCoverage = effectiveCoverageById(input);
  const analysisTurnIds = new Set([
    ...input.coverageAnalysis.referencedTranscriptTurnIds,
    ...input.consistencyAnalysis.referencedTranscriptTurnIds,
  ]);

  for (const [index, question] of parsed.data.consideredQuestions.entries()) {
    const questionId = questionIdFromReference(question);
    const catalogQuestion = catalogById.get(questionId);
    if (
      !allowedCandidates.has(questionId) ||
      catalogQuestion === undefined ||
      !sameQuestionReference(catalogQuestion.reference, question)
    ) {
      addIssue(
        issues,
        'question_not_allowed',
        `consideredQuestions.${index}`,
        'Considered question is not an allowed guide candidate',
      );
    }
  }
  for (const [index, turnId] of parsed.data.referencedTranscriptTurnIds.entries()) {
    if (!analysisTurnIds.has(turnId)) {
      addIssue(
        issues,
        'unsupported_reference',
        `referencedTranscriptTurnIds.${index}`,
        'Decision may reference only validated analysis evidence',
      );
    }
  }
  requireExactIds(
    issues,
    parsed.data.referencedTranscriptTurnIds,
    analysisTurnIds,
    'referencedTranscriptTurnIds',
    'Decision references must exactly equal the validated analysis evidence',
  );

  const action = parsed.data.selectedAction;
  if (action.action === 'complete_interview') {
    const openMainQuestions = catalog.filter(
      (question) =>
        question.kind === 'main' &&
        !TERMINAL_COVERAGE_STATUSES.has(
          effectiveCoverage.get(question.questionId) ?? 'not_addressed',
        ),
    );
    if (openMainQuestions.length > 0) {
      addIssue(
        issues,
        'completion_not_allowed',
        'selectedAction',
        'Every main question must be terminal before completion',
      );
    }
    if (input.consistencyAnalysis.contradictions.some((item) => item.shouldClarify)) {
      addIssue(
        issues,
        'clarification_pending',
        'selectedAction',
        'A selected contradiction must be resolved before completion',
      );
    }
  } else {
    const targetId = questionIdFromReference(action.target);
    if (!allowedCandidates.has(targetId)) {
      addIssue(
        issues,
        'target_not_allowed',
        'selectedAction.target',
        'Selected target is not an allowed candidate',
      );
    }
    const coverageStatus = effectiveCoverage.get(targetId);
    if (
      action.action !== 'ask_clarification_question' &&
      (coverageStatus === undefined || TERMINAL_COVERAGE_STATUSES.has(coverageStatus))
    ) {
      addIssue(
        issues,
        'target_terminal',
        'selectedAction.target',
        'A normal question action cannot select terminal coverage',
      );
    }
    if (
      action.action !== 'ask_clarification_question' &&
      coverageStatus === 'partially_answered' &&
      wasQuestionAlreadyAsked(input, action.target) &&
      hasUnaskedAlternative(input, targetId, effectiveCoverage)
    ) {
      addIssue(
        issues,
        'repeated_partial_question',
        'selectedAction.target',
        'A partially answered question must not be repeated while an eligible unasked question remains',
      );
    }
    if (
      action.action === 'ask_main_question' &&
      (action.target.kind !== 'main_question' || targetId !== firstOpenMainQuestionId(input))
    ) {
      addIssue(
        issues,
        'main_question_order',
        'selectedAction.target',
        'Main-question selection must use the first open main question',
      );
    }
    if (action.action === 'ask_follow_up_question') {
      if (
        input.interviewState.currentMainQuestion === null ||
        action.target.mainQuestionId !== input.interviewState.currentMainQuestion.mainQuestionId
      ) {
        addIssue(
          issues,
          'follow_up_parent',
          'selectedAction.target',
          'Follow-up selection must remain under the current main question',
        );
      }
    }
    if (action.action === 'ask_clarification_question') {
      const contradiction = input.consistencyAnalysis.contradictions.find(
        (item) => item.id === action.basis.contradictionId,
      );
      if (contradiction === undefined || !contradiction.shouldClarify) {
        addIssue(
          issues,
          'clarification_unbound',
          'selectedAction.basis.contradictionId',
          'Clarification must bind to a selected validated contradiction',
        );
      } else if (contradiction.suggestedClarificationQuestion !== action.basis.sourceQuestion) {
        addIssue(
          issues,
          'clarification_source_mismatch',
          'selectedAction.basis.sourceQuestion',
          'Clarification source must exactly match the validated contradiction proposal',
        );
      } else if (
        contradiction.transcriptTurnIds.some(
          (turnId) => !parsed.data.referencedTranscriptTurnIds.includes(turnId),
        )
      ) {
        addIssue(
          issues,
          'clarification_evidence_missing',
          'referencedTranscriptTurnIds',
          'Clarification decisions must cite every turn supporting the selected contradiction',
        );
      }
    }
  }
  return finish(parsed.data, issues);
}

export function validateConductorOutput(
  input: InterviewConductorPromptInput,
  candidate: unknown,
): AgentGuardrailResult<ConductorOutput> {
  const parsed = conductorOutputSchema.safeParse(candidate);
  if (!parsed.success) return schemaFailure(parsed.error.issues);

  const issues: AgentGuardrailIssue[] = [];
  const decisionAction = input.decision.selectedAction;
  if (decisionAction.action === 'complete_interview') {
    if (parsed.data.action !== 'close') {
      addIssue(issues, 'decision_mismatch', 'action', 'Completion requires a closing output');
    }
  } else if (parsed.data.action !== 'ask') {
    addIssue(issues, 'decision_mismatch', 'action', 'A question decision requires an ask output');
  } else {
    const expectedTurnType =
      decisionAction.action === 'ask_main_question'
        ? 'main_question'
        : decisionAction.action === 'ask_follow_up_question'
          ? 'follow_up_question'
          : 'clarification_question';
    if (
      parsed.data.question.turnType !== expectedTurnType ||
      !sameQuestionReference(parsed.data.question.guideReference, decisionAction.target)
    ) {
      addIssue(
        issues,
        'decision_mismatch',
        'question',
        'Conductor turn type and reference must exactly match the decision',
      );
    }
    if (parsed.data.question.text.includes('\n')) {
      addIssue(issues, 'multiple_lines', 'question.text', 'Question must be a single line');
    }
    if (isSuggestiveQuestion(parsed.data.question.text)) {
      addIssue(
        issues,
        'suggestive_question',
        'question.text',
        'Participant-facing questions must remain neutral and non-leading',
      );
    }
    if (parsed.data.preface?.turnType === 'greeting' && !input.allowGreeting) {
      addIssue(issues, 'greeting_not_allowed', 'preface', 'Greeting is not allowed in this turn');
    }
    if (parsed.data.preface?.turnType === 'transition' && !input.allowTransition) {
      addIssue(
        issues,
        'transition_not_allowed',
        'preface',
        'Transition is not allowed in this turn',
      );
    }
    if (
      decisionAction.action === 'ask_clarification_question' &&
      (input.requiredClarificationQuestion !== parsed.data.question.text ||
        decisionAction.basis.sourceQuestion !== input.requiredClarificationQuestion)
    ) {
      addIssue(
        issues,
        'clarification_text_mismatch',
        'question.text',
        'Clarification text must exactly match the validated proposed question',
      );
    } else if (
      decisionAction.action !== 'ask_clarification_question' &&
      input.selectedQuestionText !== parsed.data.question.text
    ) {
      addIssue(
        issues,
        'question_text_mismatch',
        'question.text',
        'Guide question text must exactly match the validated source text',
      );
    }
  }
  requireExactIds(
    issues,
    parsed.data.referencedTranscriptTurnIds,
    new Set(input.decision.referencedTranscriptTurnIds),
    'referencedTranscriptTurnIds',
    'Conductor references must exactly equal the validated decision evidence',
  );
  return finish(parsed.data, issues);
}

export function validateTranscriptFinalizationOutput(
  input: TranscriptFinalizationPromptInput,
  candidate: unknown,
): AgentGuardrailResult<TranscriptFinalizationReport> {
  const parsed = transcriptFinalizationReportSchema.safeParse(candidate);
  if (!parsed.success) return schemaFailure(parsed.error.issues);

  const issues: AgentGuardrailIssue[] = [];
  const expectedEntries = input.transcript.entries.map((entry) => ({
    entryId: entry.kind === 'turn' ? entry.turnId : entry.gapId,
    kind: entry.kind,
  }));
  if (JSON.stringify(parsed.data.checkedCanonicalEntries) !== JSON.stringify(expectedEntries)) {
    addIssue(
      issues,
      'incomplete_entry_check',
      'checkedCanonicalEntries',
      'Finalization must check every canonical entry exactly once in sequence order',
    );
  }
  const deterministicValid = input.deterministicValidation.valid;
  if (!deterministicValid) {
    addIssue(
      issues,
      'deterministic_input_invalid',
      'deterministicValidation',
      'Transcript finalization must not run after deterministic validation has failed',
    );
  }
  if (!Object.values(parsed.data.checks).every(Boolean)) {
    addIssue(
      issues,
      'deterministic_mismatch',
      'checks',
      'Agent checks cannot override a successful deterministic canonical validation',
    );
  }
  const gapIds = input.transcript.entries
    .filter((entry) => entry.kind === 'technical_gap')
    .map((entry) => entry.gapId);
  const expectedStatus = gapIds.length === 0 ? 'valid' : 'valid_with_gaps';
  if (parsed.data.status !== expectedStatus) {
    addIssue(
      issues,
      'deterministic_mismatch',
      'status',
      `Canonical transcript requires finalization status ${expectedStatus}`,
    );
  }
  if (parsed.data.issues.length !== gapIds.length) {
    addIssue(
      issues,
      'gap_accounting',
      'issues',
      'Finalization issues must contain exactly one warning for every canonical technical gap',
    );
  }
  const reportedGapIds = new Set<string>();
  for (const [index, issue] of parsed.data.issues.entries()) {
    const gapId = issue.canonicalEntryIds[0];
    if (
      issue.code !== 'technical_gap' ||
      issue.severity !== 'warning' ||
      issue.canonicalEntryIds.length !== 1 ||
      gapId === undefined ||
      !gapIds.includes(gapId) ||
      reportedGapIds.has(gapId)
    ) {
      addIssue(
        issues,
        'gap_accounting',
        `issues.${index}`,
        'Each finalization issue must identify one distinct canonical technical gap',
      );
      continue;
    }
    reportedGapIds.add(gapId);
  }
  return finish(parsed.data, issues);
}

function firstOpenMainQuestionId(input: InterviewDecisionPromptInput): string | null {
  const coverageById = effectiveCoverageById(input);
  const question = buildGuideQuestionCatalog(input.guide).find(
    (candidate) =>
      candidate.kind === 'main' &&
      ['current', 'partially_answered', 'not_addressed'].includes(
        coverageById.get(candidate.questionId) ?? '',
      ),
  );
  return question?.questionId ?? null;
}

function wasQuestionAlreadyAsked(
  input: InterviewDecisionPromptInput,
  target: GuideQuestionReference,
): boolean {
  return input.transcript.entries.some(
    (entry) =>
      entry.kind === 'turn' &&
      entry.speaker === 'ai_interviewer' &&
      entry.guideReference !== null &&
      sameQuestionReference(entry.guideReference, target),
  );
}

function hasUnaskedAlternative(
  input: InterviewDecisionPromptInput,
  targetId: string,
  effectiveCoverage: ReadonlyMap<string, QuestionCoverageStatus>,
): boolean {
  const allowedCandidates = new Set(input.candidateQuestionIds);
  const firstOpenMainId = firstOpenMainQuestionId(input);
  const currentMainQuestionId = input.interviewState.currentMainQuestion?.mainQuestionId ?? null;

  return buildGuideQuestionCatalog(input.guide).some((question) => {
    if (
      question.questionId === targetId ||
      !allowedCandidates.has(question.questionId) ||
      effectiveCoverage.get(question.questionId) !== 'not_addressed'
    ) {
      return false;
    }
    return question.kind === 'main'
      ? question.questionId === firstOpenMainId
      : question.mainQuestionId === currentMainQuestionId;
  });
}

function effectiveCoverageById(
  input: InterviewDecisionPromptInput,
): ReadonlyMap<string, QuestionCoverageStatus> {
  const coverageById = new Map(
    input.interviewState.coverage.map((coverage) => [
      questionIdFromReference(coverage.question),
      coverage.status,
    ]),
  );
  for (const finding of input.coverageAnalysis.findings) {
    coverageById.set(questionIdFromReference(finding.question), finding.status);
  }
  return coverageById;
}

function participantTurnIds(entries: readonly CanonicalTranscriptEntry[]): ReadonlySet<string> {
  return new Set(
    entries.flatMap((entry) =>
      entry.kind === 'turn' && entry.speaker === 'participant' ? [entry.turnId] : [],
    ),
  );
}

function questionIdFromReference(reference: GuideQuestionReference): string {
  return reference.kind === 'main_question'
    ? reference.mainQuestionId
    : reference.followUpQuestionId;
}

function sameQuestionReference(
  left: GuideQuestionReference,
  right: GuideQuestionReference,
): boolean {
  return (
    left.kind === right.kind &&
    left.guideId === right.guideId &&
    left.sectionId === right.sectionId &&
    left.mainQuestionId === right.mainQuestionId &&
    (left.kind === 'main_question' ||
      (right.kind === 'follow_up_question' && left.followUpQuestionId === right.followUpQuestionId))
  );
}

function isSuggestiveQuestion(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .replace(/\u00e4/gu, 'ae')
    .replace(/\u00f6/gu, 'oe')
    .replace(/\u00fc/gu, 'ue')
    .replace(/\u00df/gu, 'ss');
  return [
    /\bwuerden sie nicht (?:zustimmen|sagen)\b/u,
    /\bfinden sie nicht auch\b/u,
    /\bist es nicht (?:so|wahr|offensichtlich)\b/u,
    /\b(?:sicherlich|offensichtlich|zweifellos)\b/u,
    /\b(?:don't|do you not) agree\b/u,
    /\bis(?:n't| it not) (?:true|obvious)\b/u,
    /\b(?:surely|obviously|clearly)\b/u,
  ].some((pattern) => pattern.test(normalized));
}

function requireExactIds(
  issues: AgentGuardrailIssue[],
  actual: readonly string[],
  expected: ReadonlySet<string>,
  path: string,
  message: string,
): void {
  if (actual.length !== expected.size || actual.some((id) => !expected.has(id))) {
    addIssue(issues, 'reference_mismatch', path, message);
  }
}

function schemaFailure(
  zodIssues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
): AgentGuardrailResult<never> {
  return {
    ok: false,
    issues: zodIssues.map((issue) => ({
      code: 'schema_invalid',
      path: issue.path.map(String).join('.'),
      message: issue.message,
    })),
  };
}

function addIssue(
  issues: AgentGuardrailIssue[],
  code: string,
  path: string,
  message: string,
): void {
  issues.push({ code, path, message });
}

function finish<Output>(
  output: Output,
  issues: readonly AgentGuardrailIssue[],
): AgentGuardrailResult<Output> {
  return issues.length === 0 ? { ok: true, output } : { ok: false, issues };
}
