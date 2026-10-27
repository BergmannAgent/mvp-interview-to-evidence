import { coverageAnalysisOutputSchema, type CoverageAnalysisOutput } from '@orgscience/contracts';
import { describe, expect, it } from 'vitest';

import {
  interviewConductorPromptInputSchema,
  interviewDecisionPromptInputSchema,
  transcriptFinalizationPromptInputSchema,
  type CoverageAnalysisPromptInput,
  type InterviewConductorPromptInput,
  type InterviewDecisionPromptInput,
  type TranscriptFinalizationPromptInput,
} from '../../application/agents/index.js';
import {
  MastraAgentExecutorConfigurationError,
  MastraInterviewAgentExecutor,
  type StructuredGenerationRequest,
  type StructuredGenerationResult,
  type StructuredGenerator,
} from './mastra-agent-executor.js';

const NOW = '2026-08-12T10:00:00.000Z';
const LATER = '2026-08-12T10:01:00.000Z';
const GUIDE_ID = 'guide-mastra-executor-1';
const INTERVIEW_ID = 'interview-mastra-executor-1';
const RUN_ID = 'agent-run-mastra-executor-1';

const mainQuestionReference = {
  kind: 'main_question' as const,
  guideId: GUIDE_ID,
  sectionId: 'section-1',
  mainQuestionId: 'main-1',
};

const followUpQuestionReference = {
  kind: 'follow_up_question' as const,
  guideId: GUIDE_ID,
  sectionId: 'section-1',
  mainQuestionId: 'main-1',
  followUpQuestionId: 'follow-up-1',
};

function createCoverageInput(): CoverageAnalysisPromptInput {
  return {
    agentName: 'coverage_analysis',
    interviewId: INTERVIEW_ID,
    interviewStateVersion: 4,
    guide: {
      id: GUIDE_ID,
      sourceLanguage: 'de',
      title: 'Interviewleitfaden',
      sections: [
        {
          id: 'section-1',
          position: 0,
          title: 'Einfuehrung',
          mainQuestions: [
            {
              id: 'main-1',
              position: 0,
              text: 'Welche Rolle haben Sie?',
              followUpQuestions: [
                {
                  id: 'follow-up-1',
                  position: 0,
                  text: 'Seit wann arbeiten Sie in dieser Position?',
                },
              ],
            },
          ],
        },
      ],
    },
    interviewState: {
      interviewId: INTERVIEW_ID,
      guideId: GUIDE_ID,
      language: 'de',
      lifecycle: { status: 'active', startedAt: NOW, activeSince: NOW },
      currentMainQuestion: mainQuestionReference,
      coverage: [
        {
          question: mainQuestionReference,
          status: 'current',
          transcriptTurnIds: [],
        },
        {
          question: followUpQuestionReference,
          status: 'not_addressed',
          transcriptTurnIds: [],
        },
      ],
      activeWorkflowRunId: 'workflow-1',
      version: 4,
      createdAt: NOW,
      updatedAt: LATER,
    },
    transcript: {
      interviewId: INTERVIEW_ID,
      guideId: GUIDE_ID,
      entries: [
        {
          kind: 'turn',
          turnId: 'ai-turn-1',
          interviewId: INTERVIEW_ID,
          sequenceNumber: 1,
          speaker: 'ai_interviewer',
          text: 'Welche Rolle haben Sie?',
          occurredAt: NOW,
          turnType: 'main_question',
          guideReference: mainQuestionReference,
          deliveryEventId: 'delivery-1',
          delivery: { status: 'complete' },
        },
        {
          kind: 'turn',
          turnId: 'participant-turn-1',
          interviewId: INTERVIEW_ID,
          sequenceNumber: 2,
          speaker: 'participant',
          text: 'Ich leite den Bereich Forschung.',
          occurredAt: LATER,
          turnType: 'participant_answer',
          guideReference: mainQuestionReference,
          sourceProvider: 'demo',
          providerEventId: 'provider-event-1',
          sourceSegmentId: 'segment-1',
        },
      ],
      finalizedAt: null,
    },
    latestParticipantTurnId: 'participant-turn-1',
    currentQuestion: mainQuestionReference,
    candidateQuestionIds: ['main-1', 'follow-up-1'],
  };
}

function withLanguage(
  input: CoverageAnalysisPromptInput,
  language: 'de' | 'en',
): CoverageAnalysisPromptInput {
  return {
    ...input,
    guide: { ...input.guide, sourceLanguage: language },
    interviewState: { ...input.interviewState, language },
  };
}

function createDecisionInput(
  consistencyAnalysis: InterviewDecisionPromptInput['consistencyAnalysis'] = {
    contradictions: [],
    referencedTranscriptTurnIds: [],
    rationale: 'Es gibt keinen belegten Widerspruch.',
  },
): InterviewDecisionPromptInput {
  const coverageInput = createCoverageInput();
  return interviewDecisionPromptInputSchema.parse({
    agentName: 'interview_decision',
    interviewId: coverageInput.interviewId,
    interviewStateVersion: coverageInput.interviewStateVersion,
    guide: coverageInput.guide,
    interviewState: coverageInput.interviewState,
    transcript: coverageInput.transcript,
    coverageAnalysis: validCoverageOutput,
    consistencyAnalysis,
    currentQuestion: coverageInput.currentQuestion,
    candidateQuestionIds: coverageInput.candidateQuestionIds,
  });
}

function createConductorInput(
  selectedAction: InterviewConductorPromptInput['decision']['selectedAction'] = {
    action: 'ask_follow_up_question',
    target: followUpQuestionReference,
  },
): InterviewConductorPromptInput {
  const coverageInput = createCoverageInput();
  const isClarification = selectedAction.action === 'ask_clarification_question';
  const isCompletion = selectedAction.action === 'complete_interview';
  return interviewConductorPromptInputSchema.parse({
    agentName: 'interview_conductor',
    interviewId: coverageInput.interviewId,
    interviewStateVersion: coverageInput.interviewStateVersion,
    guide: coverageInput.guide,
    interviewState: coverageInput.interviewState,
    transcript: coverageInput.transcript,
    decision: {
      selectedAction,
      referencedTranscriptTurnIds: ['participant-turn-1'],
      consideredQuestions: isCompletion
        ? []
        : [
            selectedAction.action === 'ask_main_question'
              ? mainQuestionReference
              : selectedAction.target,
          ],
      rationale: 'Die naechste Aktion wurde aus dem validierten Leitfaden ausgewaehlt.',
    },
    selectedQuestionText:
      isCompletion || isClarification ? null : 'Seit wann arbeiten Sie in dieser Position?',
    requiredClarificationQuestion: isClarification ? selectedAction.basis.sourceQuestion : null,
    allowGreeting: false,
    allowTransition: !isCompletion && !isClarification,
  });
}

function createFinalizationInput(): TranscriptFinalizationPromptInput {
  const coverageInput = createCoverageInput();
  return transcriptFinalizationPromptInputSchema.parse({
    agentName: 'transcript_finalization',
    interviewId: INTERVIEW_ID,
    interviewStateVersion: 5,
    guide: coverageInput.guide,
    interviewState: {
      ...coverageInput.interviewState,
      lifecycle: {
        status: 'completed',
        startedAt: NOW,
        endingAt: LATER,
        endedAt: LATER,
      },
      currentMainQuestion: null,
      coverage: [
        {
          question: mainQuestionReference,
          status: 'answered',
          transcriptTurnIds: ['participant-turn-1'],
        },
        {
          question: followUpQuestionReference,
          status: 'not_addressed',
          transcriptTurnIds: [],
        },
      ],
      activeWorkflowRunId: null,
      version: 5,
    },
    transcript: {
      interviewId: INTERVIEW_ID,
      guideId: GUIDE_ID,
      finalizedAt: LATER,
      entries: [
        {
          kind: 'turn',
          turnId: 'greeting-turn-1',
          interviewId: INTERVIEW_ID,
          sequenceNumber: 1,
          speaker: 'ai_interviewer',
          text: 'Guten Tag.',
          occurredAt: NOW,
          turnType: 'greeting',
          guideReference: null,
          deliveryEventId: 'delivery-greeting-1',
          delivery: { status: 'complete' },
        },
        ...coverageInput.transcript.entries.map((entry, index) => ({
          ...entry,
          sequenceNumber: index + 2,
        })),
        {
          kind: 'turn',
          turnId: 'closing-turn-1',
          interviewId: INTERVIEW_ID,
          sequenceNumber: 4,
          speaker: 'ai_interviewer',
          text: 'Vielen Dank.',
          occurredAt: LATER,
          turnType: 'closing',
          guideReference: null,
          deliveryEventId: 'delivery-closing-1',
          delivery: { status: 'complete' },
        },
      ],
    },
    deterministicValidation: { valid: true, issues: [] },
  });
}

const validCoverageOutput: CoverageAnalysisOutput = {
  findings: [
    {
      question: mainQuestionReference,
      status: 'partially_answered',
      transcriptTurnIds: ['participant-turn-1'],
      openAspects: ['Dauer in der Position'],
      rationale: 'Die Rolle ist genannt, die Dauer aber noch offen.',
    },
  ],
  referencedTranscriptTurnIds: ['participant-turn-1'],
  rationale: 'Die letzte Antwort deckt einen Teil der Hauptfrage ab.',
};

interface CapturedRequest {
  readonly agentId: string;
  readonly prompt: string;
  readonly schema: unknown;
  readonly errorStrategy: string;
  readonly hideInput: boolean;
  readonly hideOutput: boolean;
  readonly abortSignal: AbortSignal;
  readonly maxSteps: number;
  readonly maxProcessorRetries: number;
  readonly runId: string;
}

type QueuedGeneration =
  | StructuredGenerationResult
  | Error
  | ((signal: AbortSignal) => Promise<StructuredGenerationResult>);

class QueueStructuredGenerator implements StructuredGenerator {
  readonly requests: CapturedRequest[] = [];
  readonly #queue: QueuedGeneration[];

  constructor(...queue: QueuedGeneration[]) {
    this.#queue = queue;
  }

  async generate<Output>(
    request: StructuredGenerationRequest<Output>,
  ): Promise<StructuredGenerationResult> {
    this.requests.push({
      agentId: request.agent.id,
      prompt: request.prompt,
      schema: request.options.structuredOutput.schema,
      errorStrategy: request.options.structuredOutput.errorStrategy,
      hideInput: request.options.tracingOptions.hideInput,
      hideOutput: request.options.tracingOptions.hideOutput,
      abortSignal: request.options.abortSignal,
      maxSteps: request.options.maxSteps,
      maxProcessorRetries: request.options.maxProcessorRetries,
      runId: request.options.runId,
    });

    const queued = this.#queue.shift();
    if (queued === undefined) throw new Error('No queued structured generation result.');
    if (queued instanceof Error) throw queued;
    return typeof queued === 'function' ? queued(request.options.abortSignal) : queued;
  }
}

function executionContext(controller = new AbortController()) {
  return { runId: RUN_ID, workflowRunId: 'workflow-1', signal: controller.signal };
}

describe('MastraInterviewAgentExecutor', () => {
  it('finalizes a validated canonical transcript without a provider request', async () => {
    const generator = new QueueStructuredGenerator();
    const executor = new MastraInterviewAgentExecutor({
      model: 'openai/gpt-5.4-mini',
      generator,
    });

    const result = await executor.executeTranscriptFinalization(
      createFinalizationInput(),
      executionContext(),
    );

    expect(result).toMatchObject({
      ok: true,
      output: {
        status: 'valid',
        checkedCanonicalEntries: [
          { entryId: 'greeting-turn-1', kind: 'turn' },
          { entryId: 'ai-turn-1', kind: 'turn' },
          { entryId: 'participant-turn-1', kind: 'turn' },
          { entryId: 'closing-turn-1', kind: 'turn' },
        ],
        issues: [],
      },
      repairCount: 0,
    });
    expect(generator.requests).toHaveLength(0);
  });

  it('creates exact conductor questions and closing text without a provider request', async () => {
    const generator = new QueueStructuredGenerator();
    const executor = new MastraInterviewAgentExecutor({
      model: 'openai/gpt-5.4-mini',
      generator,
    });
    const clarificationQuestion = 'Welche Rollenbeschreibung gilt aktuell?';

    const [guideQuestion, clarification, closing] = await Promise.all([
      executor.executeInterviewConductor(createConductorInput(), executionContext()),
      executor.executeInterviewConductor(
        createConductorInput({
          action: 'ask_clarification_question',
          target: mainQuestionReference,
          basis: {
            kind: 'contradiction',
            contradictionId: 'contradiction-1',
            sourceQuestion: clarificationQuestion,
          },
          clarificationObjective: 'Die aktuell gueltige Rollenbeschreibung klaeren.',
        }),
        executionContext(),
      ),
      executor.executeInterviewConductor(
        createConductorInput({ action: 'complete_interview' }),
        executionContext(),
      ),
    ]);

    expect(guideQuestion).toMatchObject({
      ok: true,
      output: {
        action: 'ask',
        question: {
          turnType: 'follow_up_question',
          text: 'Seit wann arbeiten Sie in dieser Position?',
        },
      },
    });
    expect(clarification).toMatchObject({
      ok: true,
      output: {
        action: 'ask',
        preface: null,
        question: { turnType: 'clarification_question', text: clarificationQuestion },
      },
    });
    expect(closing).toMatchObject({
      ok: true,
      output: {
        action: 'close',
        closingText: 'Vielen Dank fuer das Gespraech und Ihre Zeit.',
      },
    });
    expect(generator.requests).toHaveLength(0);
  });

  it('uses strict one-step generation with private trace payloads', async () => {
    const generator = new QueueStructuredGenerator({ object: validCoverageOutput });
    const executor = new MastraInterviewAgentExecutor({
      model: 'openai/gpt-5.4-mini',
      generator,
    });

    const result = await executor.executeCoverageAnalysis(
      createCoverageInput(),
      executionContext(),
    );

    expect(result).toEqual({
      ok: true,
      output: validCoverageOutput,
      model: {
        mode: 'provider',
        provider: 'openai',
        model: 'openai/gpt-5.4-mini',
      },
      repairCount: 0,
    });
    expect(generator.requests).toHaveLength(1);
    expect(generator.requests[0]).toMatchObject({
      agentId: 'coverage_analysis',
      schema: coverageAnalysisOutputSchema,
      errorStrategy: 'strict',
      hideInput: true,
      hideOutput: true,
      maxSteps: 1,
      maxProcessorRetries: 0,
      runId: RUN_ID,
    });
    expect(generator.requests[0]?.prompt).toContain('"agentName":"coverage_analysis"');
    expect(generator.requests[0]?.prompt).toContain('never return private chain of thought');
    expect(generator.requests[0]?.prompt).toContain('input-only control state');
  });

  it.each([
    ['de', 'German (de)'],
    ['en', 'English (en)'],
  ] as const)('binds provider output to the persisted %s locale', async (language, label) => {
    const generator = new QueueStructuredGenerator({ object: validCoverageOutput });
    const executor = new MastraInterviewAgentExecutor({
      model: 'openai/gpt-5.4-mini',
      generator,
    });

    const result = await executor.executeCoverageAnalysis(
      withLanguage(createCoverageInput(), language),
      executionContext(),
    );

    expect(result.ok).toBe(true);
    expect(generator.requests).toHaveLength(1);
    expect(generator.requests[0]?.prompt).toContain(`OUTPUT_LANGUAGE_CODE: ${language}.`);
    expect(generator.requests[0]?.prompt).toContain(
      `Write every newly generated natural-language output field in ${label}.`,
    );
  });

  it('rejects invalid input before invoking the provider', async () => {
    const generator = new QueueStructuredGenerator({ object: validCoverageOutput });
    const executor = new MastraInterviewAgentExecutor({
      model: 'openai/gpt-5.4-mini',
      generator,
    });
    const invalidInput = { ...createCoverageInput(), interviewId: 'another-interview' };

    const result = await executor.executeCoverageAnalysis(invalidInput, executionContext());

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invalid_input', retryable: false },
      repairCount: 0,
    });
    expect(generator.requests).toHaveLength(0);
  });

  it('rejects an invalid execution run identity before invoking the provider', async () => {
    const generator = new QueueStructuredGenerator({ object: validCoverageOutput });
    const executor = new MastraInterviewAgentExecutor({
      model: 'openai/gpt-5.4-mini',
      generator,
    });

    const result = await executor.executeCoverageAnalysis(createCoverageInput(), {
      runId: 'invalid run id',
      workflowRunId: 'workflow-1',
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invalid_input', retryable: false },
      repairCount: 0,
    });
    expect(generator.requests).toHaveLength(0);
  });

  it('rejects a workflow that does not own the active interview before provider execution', async () => {
    const generator = new QueueStructuredGenerator({ object: validCoverageOutput });
    const executor = new MastraInterviewAgentExecutor({
      model: 'openai/gpt-5.4-mini',
      generator,
    });

    const result = await executor.executeCoverageAnalysis(createCoverageInput(), {
      runId: RUN_ID,
      workflowRunId: 'workflow-other',
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invalid_input', retryable: false },
      repairCount: 0,
    });
    expect(generator.requests).toHaveLength(0);
  });

  it('repairs one semantic guardrail rejection without echoing raw output', async () => {
    const rawRejectedValue = 'raw-rejected-turn-id';
    const rejectedOutput = {
      ...validCoverageOutput,
      findings: [
        {
          ...validCoverageOutput.findings[0],
          transcriptTurnIds: [rawRejectedValue],
        },
      ],
      referencedTranscriptTurnIds: [rawRejectedValue],
    };
    const generator = new QueueStructuredGenerator(
      { object: rejectedOutput },
      { object: validCoverageOutput },
    );
    const executor = new MastraInterviewAgentExecutor({
      model: 'openai/gpt-5.4-mini',
      generator,
    });

    const result = await executor.executeCoverageAnalysis(
      createCoverageInput(),
      executionContext(),
    );

    expect(result).toMatchObject({ ok: true, repairCount: 1, output: validCoverageOutput });
    expect(generator.requests).toHaveLength(2);
    expect(generator.requests[1]?.prompt).toContain('A prior response was rejected');
    expect(generator.requests[1]?.prompt).toContain('invalid_evidence');
    expect(generator.requests[1]?.prompt).not.toContain(rawRejectedValue);
  });

  it('repairs one strict structured-output failure without exposing its error', async () => {
    const providerDetail = 'raw-provider-output-must-not-leak';
    const invalidOutputError = Object.assign(new Error(providerDetail), {
      id: 'STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED',
    });
    const generator = new QueueStructuredGenerator(invalidOutputError, {
      object: validCoverageOutput,
    });
    const executor = new MastraInterviewAgentExecutor({
      model: 'openai/gpt-5.4-mini',
      generator,
    });

    const result = await executor.executeCoverageAnalysis(
      createCoverageInput(),
      executionContext(),
    );

    expect(result).toMatchObject({ ok: true, repairCount: 1 });
    expect(generator.requests[1]?.prompt).toContain('schema_invalid');
    expect(generator.requests[1]?.prompt).not.toContain(providerDetail);
  });

  it('selects an allowed guide follow-up deterministically without a provider call', async () => {
    const generator = new QueueStructuredGenerator(new Error('must not be called'));
    const executor = new MastraInterviewAgentExecutor({
      model: 'openai/gpt-5.4-mini',
      generator,
    });

    const result = await executor.executeInterviewDecision(
      createDecisionInput(),
      executionContext(),
    );

    expect(result).toMatchObject({
      ok: true,
      repairCount: 0,
      model: { mode: 'provider', model: 'openai/gpt-5.4-mini' },
      output: {
        selectedAction: {
          action: 'ask_follow_up_question',
          target: followUpQuestionReference,
        },
      },
    });
    expect(generator.requests).toHaveLength(0);
  });

  it('selects a real contradiction with its exact validated clarification', async () => {
    const clarificationQuestion = 'Welche der beiden Rollenbeschreibungen ist aktuell?';
    const earlierParticipantTurnId = 'participant-turn-earlier';
    const consistencyAnalysis = {
      contradictions: [
        {
          id: 'contradiction-1',
          transcriptTurnIds: [earlierParticipantTurnId, 'participant-turn-1'],
          description: 'Die Rollenbeschreibungen unterscheiden sich.',
          suggestedClarificationQuestion: clarificationQuestion,
          shouldClarify: true,
          rationale: 'Der finale Nutzerturn enthaelt zwei unterschiedliche Rollenbeschreibungen.',
        },
      ],
      referencedTranscriptTurnIds: [earlierParticipantTurnId, 'participant-turn-1'],
      rationale: 'Ein moeglicher Widerspruch soll neutral geklaert werden.',
    } as const;
    const generator = new QueueStructuredGenerator(new Error('must not be called'));
    const executor = new MastraInterviewAgentExecutor({
      model: 'openai/gpt-5.4-mini',
      generator,
    });

    const baseInput = createDecisionInput();
    const latestParticipantTurn = baseInput.transcript.entries[1];
    if (latestParticipantTurn?.kind !== 'turn' || latestParticipantTurn.speaker !== 'participant') {
      throw new Error('Expected the participant test fixture turn.');
    }
    const result = await executor.executeInterviewDecision(
      interviewDecisionPromptInputSchema.parse({
        ...baseInput,
        transcript: {
          ...baseInput.transcript,
          entries: [
            baseInput.transcript.entries[0],
            {
              ...latestParticipantTurn,
              turnId: earlierParticipantTurnId,
              sequenceNumber: 2,
              text: 'Ich leite die Forschung nur kommissarisch.',
              providerEventId: 'provider-event-earlier',
              sourceSegmentId: 'segment-earlier',
            },
            { ...latestParticipantTurn, sequenceNumber: 3 },
          ],
        },
        consistencyAnalysis,
      }),
      executionContext(),
    );

    expect(result).toMatchObject({
      ok: true,
      repairCount: 0,
      output: {
        selectedAction: {
          action: 'ask_clarification_question',
          basis: {
            contradictionId: 'contradiction-1',
            sourceQuestion: clarificationQuestion,
          },
        },
      },
    });
    expect(generator.requests).toHaveLength(0);
  });

  it('returns a generic guardrail failure after the single repair attempt', async () => {
    const rejectedOutput = {
      ...validCoverageOutput,
      referencedTranscriptTurnIds: ['missing-turn'],
      findings: [
        {
          ...validCoverageOutput.findings[0],
          transcriptTurnIds: ['missing-turn'],
        },
      ],
    };
    const generator = new QueueStructuredGenerator(
      { object: rejectedOutput },
      { object: rejectedOutput },
    );
    const executor = new MastraInterviewAgentExecutor({
      model: 'openai/gpt-5.4-mini',
      generator,
    });

    const result = await executor.executeCoverageAnalysis(
      createCoverageInput(),
      executionContext(),
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'guardrail_rejected',
        message: 'Agent output failed semantic guardrails.',
        retryable: true,
      },
      model: {
        mode: 'provider',
        provider: 'openai',
        model: 'openai/gpt-5.4-mini',
      },
      repairCount: 1,
    });
    expect(JSON.stringify(result)).not.toContain('missing-turn');
  });

  it('returns invalid_output after two schema-invalid responses', async () => {
    const rawRejectedValue = 'raw-schema-invalid-output';
    const generator = new QueueStructuredGenerator(
      { object: { unexpected: rawRejectedValue } },
      { object: { unexpected: rawRejectedValue } },
    );
    const executor = new MastraInterviewAgentExecutor({
      model: 'openai/gpt-5.4-mini',
      generator,
    });

    const result = await executor.executeCoverageAnalysis(
      createCoverageInput(),
      executionContext(),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invalid_output', retryable: true },
      repairCount: 1,
    });
    expect(JSON.stringify(result)).not.toContain(rawRejectedValue);
    expect(generator.requests[1]?.prompt).not.toContain(rawRejectedValue);
  });

  it('short-circuits a pre-aborted execution', async () => {
    const controller = new AbortController();
    controller.abort();
    const generator = new QueueStructuredGenerator({ object: validCoverageOutput });
    const executor = new MastraInterviewAgentExecutor({
      model: 'openai/gpt-5.4-mini',
      generator,
    });

    const result = await executor.executeCoverageAnalysis(
      createCoverageInput(),
      executionContext(controller),
    );

    expect(result).toMatchObject({ ok: false, error: { code: 'aborted' } });
    expect(generator.requests).toHaveLength(0);
  });

  it('aborts an in-flight provider operation even when the generator does not settle', async () => {
    const controller = new AbortController();
    const generator = new QueueStructuredGenerator(
      () => new Promise<StructuredGenerationResult>(() => undefined),
    );
    const executor = new MastraInterviewAgentExecutor({
      model: 'openai/gpt-5.4-mini',
      timeoutMs: 5_000,
      generator,
    });

    const execution = executor.executeCoverageAnalysis(
      createCoverageInput(),
      executionContext(controller),
    );
    controller.abort(new DOMException('cancelled', 'AbortError'));

    await expect(execution).resolves.toMatchObject({
      ok: false,
      error: { code: 'aborted', retryable: false },
    });
  });

  it('enforces the configured execution timeout', async () => {
    const generator = new QueueStructuredGenerator(
      () => new Promise<StructuredGenerationResult>(() => undefined),
    );
    const executor = new MastraInterviewAgentExecutor({
      model: 'openai/gpt-5.4-mini',
      timeoutMs: 5,
      generator,
    });

    const result = await executor.executeCoverageAnalysis(
      createCoverageInput(),
      executionContext(),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'timeout', retryable: true },
      repairCount: 0,
    });
    expect(generator.requests[0]?.abortSignal.aborted).toBe(true);
  });

  it('maps rate limits and other provider errors without returning provider details', async () => {
    const rateLimitGenerator = new QueueStructuredGenerator(
      Object.assign(new Error('provider account detail'), { status: 429 }),
    );
    const providerGenerator = new QueueStructuredGenerator(new Error('secret provider response'));
    const rateLimitExecutor = new MastraInterviewAgentExecutor({
      model: 'openai/gpt-5.4-mini',
      generator: rateLimitGenerator,
    });
    const providerExecutor = new MastraInterviewAgentExecutor({
      model: 'openai/gpt-5.4-mini',
      generator: providerGenerator,
    });

    const [rateLimited, providerFailed] = await Promise.all([
      rateLimitExecutor.executeCoverageAnalysis(createCoverageInput(), executionContext()),
      providerExecutor.executeCoverageAnalysis(createCoverageInput(), executionContext()),
    ]);

    expect(rateLimited).toMatchObject({
      ok: false,
      error: { code: 'rate_limited', retryable: true },
    });
    expect(providerFailed).toMatchObject({
      ok: false,
      error: { code: 'provider_error', retryable: true },
    });
    expect(JSON.stringify([rateLimited, providerFailed])).not.toContain('secret provider response');
    expect(JSON.stringify([rateLimited, providerFailed])).not.toContain('provider account detail');
  });

  it('rejects invalid timeout configuration', () => {
    expect(
      () =>
        new MastraInterviewAgentExecutor({
          model: 'openai/gpt-5.4-mini',
          timeoutMs: 0,
        }),
    ).toThrowError(MastraAgentExecutorConfigurationError);
  });
});
