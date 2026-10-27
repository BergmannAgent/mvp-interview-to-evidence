import {
  DEFAULT_LOCALE,
  type ConductorOutput,
  type ConsistencyAnalysisOutput,
  type CoverageAnalysisOutput,
  type GuideQuestionReference,
  type InterviewDecisionOutput,
  type ModelMetadata,
  type SupportedLocale,
  type TranscriptFinalizationIssue,
  type TranscriptFinalizationReport,
} from '@orgscience/contracts';
import { buildGuideQuestionCatalog } from '@orgscience/domain';

import {
  validateConductorOutput,
  validateConsistencyAnalysisOutput,
  validateCoverageAnalysisOutput,
  validateInterviewDecisionOutput,
  validateTranscriptFinalizationOutput,
  type AgentGuardrailResult,
} from './guardrails.js';
import {
  consistencyAnalysisPromptInputSchema,
  coverageAnalysisPromptInputSchema,
  interviewConductorPromptInputSchema,
  interviewDecisionPromptInputSchema,
  transcriptFinalizationPromptInputSchema,
  type ConsistencyAnalysisPromptInput,
  type CoverageAnalysisPromptInput,
  type InterviewConductorPromptInput,
  type InterviewDecisionPromptInput,
  type TranscriptFinalizationPromptInput,
  type AgentPromptInput,
} from './input-schemas.js';
import {
  executionContextOwnsInput,
  isValidAgentExecutionContext,
  type AgentExecutionContext,
  type AgentExecutionResult,
  type InterviewAgentExecutor,
} from './ports.js';
import { createDeterministicConductorOutput } from './deterministic-conductor.js';

const DEMO_MODEL_METADATA = Object.freeze({
  mode: 'demo',
  provider: null,
  model: null,
} satisfies ModelMetadata);

const TERMINAL_COVERAGE_STATUSES = new Set(['answered', 'skipped_already_answered']);

interface DemoAgentText {
  readonly invalidContext: string;
  readonly invalidInput: string;
  readonly guardrailFailure: string;
  readonly invalidOutput: string;
  readonly aborted: string;
  readonly invalidCoverageCandidate: string;
  readonly answeredCoverage: string;
  readonly coverageSummary: string;
  readonly consistencySummary: string;
  readonly clarificationObjective: string;
  readonly clarificationDecision: string;
  readonly noOpenQuestion: string;
  readonly questionSelection: string;
  readonly technicalGap: string;
  readonly finalizationWithGaps: string;
  readonly finalizationValid: string;
  readonly finalizationInvalid: string;
}

const DEMO_AGENT_TEXT = {
  de: {
    invalidContext: 'Der Ausfuehrungskontext des Demo-Agenten ist ungueltig.',
    invalidInput: 'Die Eingabe des Demo-Agenten entspricht nicht dem Laufzeitschema.',
    guardrailFailure: 'Die deterministische Demo-Ausgabe hat die Guardrails nicht bestanden',
    invalidOutput: 'Der deterministische Demo-Agent konnte keine gueltige Ausgabe erzeugen.',
    aborted: 'Die Ausfuehrung des Demo-Agenten wurde abgebrochen.',
    invalidCoverageCandidate:
      'Die aktuelle Frage ist nicht als zulaessiger Analyse-Kandidat markiert.',
    answeredCoverage: 'Der aktuelle Demo-Turn beantwortet die aktive Leitfadenfrage.',
    coverageSummary:
      'Die deterministische Demo-Analyse verwendet nur den letzten finalen Nutzerturn.',
    consistencySummary: 'Der deterministische Demo-Modus meldet keine unbelegten Widersprueche.',
    clarificationObjective: 'Den dokumentierten moeglichen Widerspruch neutral klaeren.',
    clarificationDecision:
      'Ein validierter moeglicher Widerspruch wird vor dem Themenwechsel geklaert.',
    noOpenQuestion: 'Es ist keine offene zulaessige Leitfadenfrage mehr vorhanden.',
    questionSelection:
      'Die erste offene zulaessige Frage in kanonischer Leitfadenreihenfolge wird gewaehlt.',
    technicalGap: 'Technische Luecke im kanonischen Transkript.',
    finalizationWithGaps:
      'Alle kanonischen Eintraege sind geprueft; technische Luecken bleiben sichtbar.',
    finalizationValid: 'Alle kanonischen Eintraege sind vollstaendig und konsistent geprueft.',
    finalizationInvalid:
      'Die deterministische Vorpruefung hat mindestens einen Transkriptfehler festgestellt.',
  },
  en: {
    invalidContext: 'The demo agent execution context is invalid.',
    invalidInput: 'The demo agent input does not satisfy its runtime schema.',
    guardrailFailure: 'The deterministic demo output failed guardrail validation',
    invalidOutput: 'The deterministic demo agent could not construct a valid output.',
    aborted: 'The demo agent execution was aborted.',
    invalidCoverageCandidate:
      'The current question is not marked as an allowed analysis candidate.',
    answeredCoverage: 'The current demo turn answers the active guide question.',
    coverageSummary: 'The deterministic demo analysis uses only the latest final participant turn.',
    consistencySummary: 'The deterministic demo mode reports no unsupported contradictions.',
    clarificationObjective: 'Clarify the documented possible contradiction neutrally.',
    clarificationDecision:
      'A validated possible contradiction is clarified before changing topics.',
    noOpenQuestion: 'No unanswered allowed guide question remains.',
    questionSelection:
      'The first unanswered allowed question in canonical guide order is selected.',
    technicalGap: 'Technical gap in the canonical transcript.',
    finalizationWithGaps: 'All canonical entries were checked; technical gaps remain visible.',
    finalizationValid: 'All canonical entries were checked for completeness and consistency.',
    finalizationInvalid: 'The deterministic preflight detected at least one transcript error.',
  },
} as const satisfies Readonly<Record<SupportedLocale, DemoAgentText>>;

interface RuntimeSchema<Input extends AgentPromptInput> {
  safeParse(
    value: unknown,
  ): { readonly success: true; readonly data: Input } | { readonly success: false };
}

export class DemoInterviewAgentExecutor implements InterviewAgentExecutor {
  readonly mode = 'demo' as const;

  executeCoverageAnalysis(
    input: CoverageAnalysisPromptInput,
    context: AgentExecutionContext,
  ): Promise<AgentExecutionResult<CoverageAnalysisOutput>> {
    return executeDeterministically(
      input,
      context,
      coverageAnalysisPromptInputSchema,
      createCoverageAnalysis,
      validateCoverageAnalysisOutput,
    );
  }

  executeConsistencyAnalysis(
    input: ConsistencyAnalysisPromptInput,
    context: AgentExecutionContext,
  ): Promise<AgentExecutionResult<ConsistencyAnalysisOutput>> {
    return executeDeterministically(
      input,
      context,
      consistencyAnalysisPromptInputSchema,
      createConsistencyAnalysis,
      validateConsistencyAnalysisOutput,
    );
  }

  executeInterviewDecision(
    input: InterviewDecisionPromptInput,
    context: AgentExecutionContext,
  ): Promise<AgentExecutionResult<InterviewDecisionOutput>> {
    return executeDeterministically(
      input,
      context,
      interviewDecisionPromptInputSchema,
      createDeterministicInterviewDecision,
      validateInterviewDecisionOutput,
    );
  }

  executeInterviewConductor(
    input: InterviewConductorPromptInput,
    context: AgentExecutionContext,
  ): Promise<AgentExecutionResult<ConductorOutput>> {
    return executeDeterministically(
      input,
      context,
      interviewConductorPromptInputSchema,
      createDeterministicConductorOutput,
      validateConductorOutput,
    );
  }

  executeTranscriptFinalization(
    input: TranscriptFinalizationPromptInput,
    context: AgentExecutionContext,
  ): Promise<AgentExecutionResult<TranscriptFinalizationReport>> {
    return executeDeterministically(
      input,
      context,
      transcriptFinalizationPromptInputSchema,
      createDeterministicTranscriptFinalization,
      validateTranscriptFinalizationOutput,
    );
  }
}

export function createDemoInterviewAgentExecutor(): InterviewAgentExecutor {
  return new DemoInterviewAgentExecutor();
}

async function executeDeterministically<Input extends AgentPromptInput, Output>(
  rawInput: Input,
  context: AgentExecutionContext,
  schema: RuntimeSchema<Input>,
  createOutput: (input: Input) => Output,
  validateOutput: (input: Input, candidate: unknown) => AgentGuardrailResult<Output>,
): Promise<AgentExecutionResult<Output>> {
  const messages = demoAgentText(rawInput);
  if (!isValidAgentExecutionContext(context)) {
    return failureResult('invalid_input', messages.invalidContext);
  }
  if (context.signal.aborted) return abortedResult(messages);

  const parsed = schema.safeParse(rawInput);
  if (!parsed.success || !executionContextOwnsInput(parsed.data, context)) {
    return failureResult('invalid_input', messages.invalidInput);
  }
  if (context.signal.aborted) return abortedResult(messages);

  try {
    const guarded = validateOutput(parsed.data, createOutput(parsed.data));
    if (!guarded.ok) {
      const issueSummary = guarded.issues
        .map((issue) => `${issue.code}@${issue.path || '<root>'}`)
        .join(', ');
      return failureResult('guardrail_rejected', `${messages.guardrailFailure}: ${issueSummary}`);
    }
    if (context.signal.aborted) return abortedResult(messages);
    return {
      ok: true,
      output: guarded.output,
      model: DEMO_MODEL_METADATA,
      repairCount: 0,
    };
  } catch {
    return failureResult('invalid_output', messages.invalidOutput);
  }
}

function createCoverageAnalysis(input: CoverageAnalysisPromptInput): CoverageAnalysisOutput {
  const messages = demoAgentText(input);
  const currentQuestionId = questionId(input.currentQuestion);
  if (!input.candidateQuestionIds.includes(currentQuestionId)) {
    return {
      findings: [],
      referencedTranscriptTurnIds: [input.latestParticipantTurnId],
      rationale: messages.invalidCoverageCandidate,
    };
  }

  return {
    findings: [
      {
        question: input.currentQuestion,
        status: 'answered',
        transcriptTurnIds: [input.latestParticipantTurnId],
        openAspects: [],
        rationale: messages.answeredCoverage,
      },
    ],
    referencedTranscriptTurnIds: [input.latestParticipantTurnId],
    rationale: messages.coverageSummary,
  };
}

function createConsistencyAnalysis(
  input: ConsistencyAnalysisPromptInput,
): ConsistencyAnalysisOutput {
  return {
    contradictions: [],
    referencedTranscriptTurnIds: [],
    rationale: demoAgentText(input).consistencySummary,
  };
}

export function createDeterministicInterviewDecision(
  input: InterviewDecisionPromptInput,
): InterviewDecisionOutput {
  const messages = demoAgentText(input);
  const allowedCandidateIds = new Set(input.candidateQuestionIds);
  const coverageByQuestionId = new Map(
    input.interviewState.coverage.map((coverage) => [
      questionId(coverage.question),
      coverage.status,
    ]),
  );
  for (const finding of input.coverageAnalysis.findings) {
    coverageByQuestionId.set(questionId(finding.question), finding.status);
  }
  const allowedCandidates = buildGuideQuestionCatalog(input.guide).filter((question) =>
    allowedCandidateIds.has(question.questionId),
  );
  const candidates = allowedCandidates.filter(
    (question) =>
      !TERMINAL_COVERAGE_STATUSES.has(coverageByQuestionId.get(question.questionId) ?? ''),
  );
  const firstOpenMainQuestion = candidates.find((question) => question.kind === 'main');
  const selectableCandidates = candidates.filter(
    (question) =>
      (question.kind === 'main' && question.questionId === firstOpenMainQuestion?.questionId) ||
      (question.kind === 'follow_up' &&
        question.mainQuestionId === input.interviewState.currentMainQuestion?.mainQuestionId),
  );
  const consideredQuestions = candidates.map((question) => question.reference);
  const referencedTranscriptTurnIds = orderedTranscriptTurnIds(input, [
    ...input.coverageAnalysis.referencedTranscriptTurnIds,
    ...input.consistencyAnalysis.referencedTranscriptTurnIds,
  ]);
  const clarification = input.consistencyAnalysis.contradictions.find(
    (contradiction) => contradiction.shouldClarify,
  );

  if (clarification !== undefined && allowedCandidates.length > 0) {
    const currentQuestionId =
      input.currentQuestion === null ? null : questionId(input.currentQuestion);
    const target =
      allowedCandidates.find((candidate) => candidate.questionId === currentQuestionId)
        ?.reference ??
      candidates[0]?.reference ??
      allowedCandidates[0]?.reference;
    if (target !== undefined) {
      return {
        selectedAction: {
          action: 'ask_clarification_question',
          target,
          basis: {
            kind: 'contradiction',
            contradictionId: clarification.id,
            sourceQuestion: clarification.suggestedClarificationQuestion,
          },
          clarificationObjective: messages.clarificationObjective,
        },
        referencedTranscriptTurnIds,
        consideredQuestions: allowedCandidates.map((candidate) => candidate.reference),
        rationale: messages.clarificationDecision,
      };
    }
  }

  const currentQuestionId =
    input.currentQuestion === null ? null : questionId(input.currentQuestion);
  const currentFinding = input.coverageAnalysis.findings.find(
    (finding) => questionId(finding.question) === currentQuestionId,
  );
  const selectedForOpenAspect =
    currentQuestionId !== null &&
    currentFinding?.status === 'partially_answered' &&
    currentFinding.openAspects.length > 0
      ? selectableCandidates.find(
          (candidate) =>
            candidate.kind === 'follow_up' &&
            candidate.questionId !== currentQuestionId &&
            candidate.reference.mainQuestionId === input.currentQuestion?.mainQuestionId &&
            coverageByQuestionId.get(candidate.questionId) === 'not_addressed',
        )
      : undefined;
  const selected =
    selectedForOpenAspect ??
    selectableCandidates.find(
      (candidate) => coverageByQuestionId.get(candidate.questionId) === 'not_addressed',
    ) ??
    selectableCandidates[0];
  if (selected === undefined) {
    return {
      selectedAction: { action: 'complete_interview' },
      referencedTranscriptTurnIds,
      consideredQuestions: [],
      rationale: messages.noOpenQuestion,
    };
  }

  return {
    selectedAction:
      selected.kind === 'main'
        ? { action: 'ask_main_question', target: selected.reference }
        : { action: 'ask_follow_up_question', target: selected.reference },
    referencedTranscriptTurnIds,
    consideredQuestions,
    rationale: messages.questionSelection,
  };
}

export function createDeterministicTranscriptFinalization(
  input: TranscriptFinalizationPromptInput,
): TranscriptFinalizationReport {
  const messages = demoAgentText(input);
  const checkedCanonicalEntries = input.transcript.entries.map((entry) => ({
    entryId: entry.kind === 'turn' ? entry.turnId : entry.gapId,
    kind: entry.kind,
  }));
  const gapIds = new Set(
    input.transcript.entries.flatMap((entry) =>
      entry.kind === 'technical_gap' ? [entry.gapId] : [],
    ),
  );
  const deterministicIssues: TranscriptFinalizationIssue[] =
    input.deterministicValidation.issues.flatMap((issue) => {
      if (issue.code === 'technical_gap' && issue.entryId !== null && gapIds.has(issue.entryId)) {
        return [];
      }
      return [
        {
          code: issue.code === 'technical_gap' ? 'missing_turn' : finalizationIssueCode(issue.code),
          severity: 'error',
          canonicalEntryIds: issue.entryId === null ? [] : [issue.entryId],
          description: truncateCodePoints(issue.message, 800),
        },
      ];
    });
  const gapIssues: TranscriptFinalizationIssue[] = [...gapIds].map((gapId) => ({
    code: 'technical_gap',
    severity: 'warning',
    canonicalEntryIds: [gapId],
    description: messages.technicalGap,
  }));
  const deterministicallyValid = input.deterministicValidation.valid;

  return {
    status: !deterministicallyValid
      ? 'invalid'
      : gapIssues.length > 0
        ? 'valid_with_gaps'
        : 'valid',
    checkedCanonicalEntries,
    checks: {
      chronologyValid:
        deterministicallyValid ||
        !input.deterministicValidation.issues.some((issue) => issue.code === 'timestamp_error'),
      sequenceValid: deterministicallyValid,
      speakerAssignmentsValid:
        deterministicallyValid ||
        !input.deterministicValidation.issues.some((issue) => issue.code === 'speaker_mismatch'),
      noDuplicateTurns:
        deterministicallyValid ||
        !input.deterministicValidation.issues.some((issue) => issue.code === 'duplicate_turn'),
    },
    issues: [...deterministicIssues, ...gapIssues],
    rationale: deterministicallyValid
      ? gapIssues.length > 0
        ? messages.finalizationWithGaps
        : messages.finalizationValid
      : messages.finalizationInvalid,
  };
}

function finalizationIssueCode(code: string): TranscriptFinalizationIssue['code'] {
  switch (code) {
    case 'missing_turn':
    case 'duplicate_turn':
    case 'speaker_mismatch':
    case 'sequence_error':
    case 'timestamp_error':
      return code;
    default:
      return 'missing_turn';
  }
}

function questionId(reference: GuideQuestionReference): string {
  return reference.kind === 'main_question'
    ? reference.mainQuestionId
    : reference.followUpQuestionId;
}

function orderedTranscriptTurnIds(
  input: InterviewDecisionPromptInput,
  ids: readonly string[],
): string[] {
  const selectedIds = new Set(ids);
  return input.transcript.entries.flatMap((entry) =>
    entry.kind === 'turn' && selectedIds.has(entry.turnId) ? [entry.turnId] : [],
  );
}

function truncateCodePoints(value: string, maximum: number): string {
  return [...value].slice(0, maximum).join('');
}

function abortedResult<Output>(messages: DemoAgentText): AgentExecutionResult<Output> {
  return failureResult('aborted', messages.aborted);
}

function failureResult<Output>(
  code: 'aborted' | 'invalid_input' | 'invalid_output' | 'guardrail_rejected',
  message: string,
): AgentExecutionResult<Output> {
  return {
    ok: false,
    error: { code, message, retryable: false },
    model: DEMO_MODEL_METADATA,
    repairCount: 0,
  };
}

function demoAgentText(input: AgentPromptInput): DemoAgentText {
  const language = input.interviewState.language ?? input.guide.sourceLanguage ?? DEFAULT_LOCALE;
  return DEMO_AGENT_TEXT[language];
}
