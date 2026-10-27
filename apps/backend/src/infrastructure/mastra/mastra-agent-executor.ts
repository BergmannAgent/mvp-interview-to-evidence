import type { Agent } from '@mastra/core/agent';
import {
  consistencyAnalysisOutputSchema,
  coverageAnalysisOutputSchema,
  type AgentName,
  type ConductorOutput,
  type ConsistencyAnalysisOutput,
  type CoverageAnalysisOutput,
  type InterviewDecisionOutput,
  type ModelMetadata,
  type TranscriptFinalizationReport,
} from '@orgscience/contracts';
import type { z } from 'zod';

import {
  createDeterministicConductorOutput,
  createDeterministicInterviewDecision,
  createDeterministicTranscriptFinalization,
  consistencyAnalysisPromptInputSchema,
  coverageAnalysisPromptInputSchema,
  interviewConductorPromptInputSchema,
  interviewDecisionPromptInputSchema,
  transcriptFinalizationPromptInputSchema,
  validateConductorOutput,
  validateConsistencyAnalysisOutput,
  validateCoverageAnalysisOutput,
  validateInterviewDecisionOutput,
  validateTranscriptFinalizationOutput,
  type AgentExecutionContext,
  type AgentExecutionFailure,
  type AgentExecutionResult,
  type AgentGuardrailIssue,
  type AgentGuardrailResult,
  type AgentPromptInput,
  type ConsistencyAnalysisPromptInput,
  type CoverageAnalysisPromptInput,
  type InterviewAgentExecutor,
  type InterviewConductorPromptInput,
  type InterviewDecisionPromptInput,
  executionContextOwnsInput,
  isValidAgentExecutionContext,
  type TranscriptFinalizationPromptInput,
} from '../../application/agents/index.js';
import { createInterviewAgents, type InterviewAgents } from './agent-definitions.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAXIMUM_REPAIR_COUNT = 1;

type OutputSchema<Output> = z.ZodType<Output>;

export interface StructuredGenerationRequest<Output> {
  readonly agent: Agent;
  readonly prompt: string;
  readonly options: {
    readonly structuredOutput: {
      readonly schema: OutputSchema<Output>;
      readonly errorStrategy: 'strict';
    };
    readonly tracingOptions: {
      readonly hideInput: true;
      readonly hideOutput: true;
    };
    readonly abortSignal: AbortSignal;
    readonly maxSteps: 1;
    readonly maxProcessorRetries: 0;
    readonly runId: string;
  };
}

export interface StructuredGenerationResult {
  readonly object: unknown;
  readonly error?: unknown;
}

export interface StructuredGenerator {
  generate<Output>(
    request: StructuredGenerationRequest<Output>,
  ): Promise<StructuredGenerationResult>;
}

export class MastraStructuredGenerator implements StructuredGenerator {
  async generate<Output>(
    request: StructuredGenerationRequest<Output>,
  ): Promise<StructuredGenerationResult> {
    const result = await request.agent.generate(request.prompt, request.options);
    return result.error === undefined
      ? { object: result.object }
      : { object: result.object, error: result.error };
  }
}

export interface MastraAgentExecutorOptions {
  readonly model: string;
  readonly timeoutMs?: number;
  readonly generator?: StructuredGenerator;
}

export class MastraAgentExecutorConfigurationError extends Error {
  readonly code = 'INVALID_MASTRA_EXECUTOR_CONFIGURATION' as const;

  constructor(message: string) {
    super(message);
    this.name = 'MastraAgentExecutorConfigurationError';
  }
}

interface ExecutionSpec<Input extends AgentPromptInput, Generated, Output> {
  readonly agentName: AgentName;
  readonly inputSchema: z.ZodType<Input>;
  readonly outputSchema: OutputSchema<Generated>;
  readonly guardrail: (input: Input, candidate: unknown) => AgentGuardrailResult<Output>;
}

interface AttemptRejection {
  readonly code: 'invalid_output' | 'guardrail_rejected';
  readonly issues: readonly AgentGuardrailIssue[];
}

class ExecutionDeadlineError extends Error {
  constructor() {
    super('Agent execution deadline exceeded.');
    this.name = 'ExecutionDeadlineError';
  }
}

export class MastraInterviewAgentExecutor implements InterviewAgentExecutor {
  readonly mode = 'provider' as const;

  readonly #agents: InterviewAgents;
  readonly #generator: StructuredGenerator;
  readonly #metadata: ModelMetadata;
  readonly #timeoutMs: number;

  constructor(options: MastraAgentExecutorOptions) {
    this.#agents = createInterviewAgents(options.model);
    this.#generator = options.generator ?? new MastraStructuredGenerator();
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs <= 0) {
      throw new MastraAgentExecutorConfigurationError(
        'Agent execution timeout must be a positive safe integer.',
      );
    }
    this.#metadata = modelMetadata(options.model);
  }

  executeCoverageAnalysis(
    input: CoverageAnalysisPromptInput,
    context: AgentExecutionContext,
  ): Promise<AgentExecutionResult<CoverageAnalysisOutput>> {
    return this.#execute(input, context, {
      agentName: 'coverage_analysis',
      inputSchema: coverageAnalysisPromptInputSchema,
      outputSchema: coverageAnalysisOutputSchema,
      guardrail: validateCoverageAnalysisOutput,
    });
  }

  executeConsistencyAnalysis(
    input: ConsistencyAnalysisPromptInput,
    context: AgentExecutionContext,
  ): Promise<AgentExecutionResult<ConsistencyAnalysisOutput>> {
    return this.#execute(input, context, {
      agentName: 'consistency_analysis',
      inputSchema: consistencyAnalysisPromptInputSchema,
      outputSchema: consistencyAnalysisOutputSchema,
      guardrail: validateConsistencyAnalysisOutput,
    });
  }

  executeInterviewDecision(
    input: InterviewDecisionPromptInput,
    context: AgentExecutionContext,
  ): Promise<AgentExecutionResult<InterviewDecisionOutput>> {
    if (!isValidAgentExecutionContext(context)) {
      return Promise.resolve(this.#failure('invalid_input', 0));
    }
    if (context.signal.aborted) return Promise.resolve(this.#failure('aborted', 0));

    const parsedInput = interviewDecisionPromptInputSchema.safeParse(input);
    if (!parsedInput.success || !executionContextOwnsInput(parsedInput.data, context)) {
      return Promise.resolve(this.#failure('invalid_input', 0));
    }

    try {
      const guarded = validateInterviewDecisionOutput(
        parsedInput.data,
        createDeterministicInterviewDecision(parsedInput.data),
      );
      if (!guarded.ok) return Promise.resolve(this.#failure('guardrail_rejected', 0));
      return Promise.resolve({
        ok: true,
        output: guarded.output,
        model: this.#metadata,
        repairCount: 0,
      });
    } catch {
      return Promise.resolve(this.#failure('invalid_output', 0));
    }
  }

  executeInterviewConductor(
    input: InterviewConductorPromptInput,
    context: AgentExecutionContext,
  ): Promise<AgentExecutionResult<ConductorOutput>> {
    if (!isValidAgentExecutionContext(context)) {
      return Promise.resolve(this.#failure('invalid_input', 0));
    }
    if (context.signal.aborted) return Promise.resolve(this.#failure('aborted', 0));

    const parsedInput = interviewConductorPromptInputSchema.safeParse(input);
    if (!parsedInput.success || !executionContextOwnsInput(parsedInput.data, context)) {
      return Promise.resolve(this.#failure('invalid_input', 0));
    }

    try {
      const guarded = validateConductorOutput(
        parsedInput.data,
        createDeterministicConductorOutput(parsedInput.data),
      );
      if (!guarded.ok) return Promise.resolve(this.#failure('guardrail_rejected', 0));
      return Promise.resolve({
        ok: true,
        output: guarded.output,
        model: this.#metadata,
        repairCount: 0,
      });
    } catch {
      return Promise.resolve(this.#failure('invalid_output', 0));
    }
  }

  executeTranscriptFinalization(
    input: TranscriptFinalizationPromptInput,
    context: AgentExecutionContext,
  ): Promise<AgentExecutionResult<TranscriptFinalizationReport>> {
    if (!isValidAgentExecutionContext(context)) {
      return Promise.resolve(this.#failure('invalid_input', 0));
    }
    if (context.signal.aborted) return Promise.resolve(this.#failure('aborted', 0));

    const parsedInput = transcriptFinalizationPromptInputSchema.safeParse(input);
    if (!parsedInput.success || !executionContextOwnsInput(parsedInput.data, context)) {
      return Promise.resolve(this.#failure('invalid_input', 0));
    }

    try {
      const guarded = validateTranscriptFinalizationOutput(
        parsedInput.data,
        createDeterministicTranscriptFinalization(parsedInput.data),
      );
      if (!guarded.ok) return Promise.resolve(this.#failure('guardrail_rejected', 0));
      return Promise.resolve({
        ok: true,
        output: guarded.output,
        model: this.#metadata,
        repairCount: 0,
      });
    } catch {
      return Promise.resolve(this.#failure('invalid_output', 0));
    }
  }

  async #execute<Input extends AgentPromptInput, Generated, Output>(
    untrustedInput: Input,
    context: AgentExecutionContext,
    spec: ExecutionSpec<Input, Generated, Output>,
  ): Promise<AgentExecutionResult<Output>> {
    const parsedInput = spec.inputSchema.safeParse(untrustedInput);
    if (
      !parsedInput.success ||
      !isValidAgentExecutionContext(context) ||
      !executionContextOwnsInput(parsedInput.data, context)
    ) {
      return this.#failure('invalid_input', 0);
    }
    if (context.signal.aborted) return this.#failure('aborted', 0);

    const deadline = Date.now() + this.#timeoutMs;
    let repairIssues: readonly AgentGuardrailIssue[] = [];

    for (let repairCount = 0; repairCount <= MAXIMUM_REPAIR_COUNT; repairCount += 1) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return this.#failure('timeout', repairCount);

      try {
        const generation = await generateBeforeDeadline(
          this.#generator,
          {
            agent: this.#agents[spec.agentName],
            prompt: buildPrompt(spec.agentName, parsedInput.data, repairIssues),
            options: {
              structuredOutput: { schema: spec.outputSchema, errorStrategy: 'strict' },
              tracingOptions: { hideInput: true, hideOutput: true },
              abortSignal: context.signal,
              maxSteps: 1,
              maxProcessorRetries: 0,
              runId: context.runId,
            },
          },
          context.signal,
          remainingMs,
        );
        if (generation.error !== undefined) throw generation.error;

        const validation = spec.guardrail(parsedInput.data, generation.object);
        if (validation.ok) {
          return {
            ok: true,
            output: validation.output,
            model: this.#metadata,
            repairCount,
          };
        }

        const rejection = classifyValidationRejection(validation.issues);
        if (repairCount === MAXIMUM_REPAIR_COUNT) {
          return this.#failure(rejection.code, repairCount);
        }
        repairIssues = rejection.issues;
      } catch (error: unknown) {
        const failure = classifyGenerationError(error, context.signal);
        if (failure.code !== 'invalid_output' || repairCount === MAXIMUM_REPAIR_COUNT) {
          return this.#failure(failure.code, repairCount);
        }
        repairIssues = [
          {
            code: 'schema_invalid',
            path: '',
            message: 'The prior response did not satisfy the required output schema.',
          },
        ];
      }
    }

    return this.#failure('invalid_output', MAXIMUM_REPAIR_COUNT);
  }

  #failure(code: AgentExecutionFailure['code'], repairCount: number): AgentExecutionResult<never> {
    return {
      ok: false,
      error: failureFor(code),
      model: this.#metadata,
      repairCount,
    };
  }
}

async function generateBeforeDeadline<Output>(
  generator: StructuredGenerator,
  request: StructuredGenerationRequest<Output>,
  externalSignal: AbortSignal,
  timeoutMs: number,
): Promise<StructuredGenerationResult> {
  const operationController = new AbortController();
  let deadlineReached = false;

  const relayAbort = (): void => {
    operationController.abort(externalSignal.reason);
  };
  externalSignal.addEventListener('abort', relayAbort, { once: true });
  if (externalSignal.aborted) relayAbort();

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      deadlineReached = true;
      const error = new ExecutionDeadlineError();
      operationController.abort(error);
      reject(error);
    }, timeoutMs);
  });
  const aborted = new Promise<never>((_resolve, reject) => {
    if (operationController.signal.aborted) {
      reject(operationController.signal.reason);
      return;
    }
    operationController.signal.addEventListener(
      'abort',
      () => reject(operationController.signal.reason),
      { once: true },
    );
  });

  try {
    return await Promise.race([
      generator.generate({
        ...request,
        options: { ...request.options, abortSignal: operationController.signal },
      }),
      deadline,
      aborted,
    ]);
  } catch (error: unknown) {
    if (deadlineReached) throw new ExecutionDeadlineError();
    throw error;
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    externalSignal.removeEventListener('abort', relayAbort);
  }
}

function buildPrompt(
  agentName: AgentName,
  validatedInput: AgentPromptInput,
  repairIssues: readonly AgentGuardrailIssue[],
): string {
  const repairInstruction =
    repairIssues.length === 0
      ? ''
      : [
          'A prior response was rejected. Produce one corrected response without discussing the rejection.',
          `Validation issues: ${JSON.stringify(repairIssues)}`,
        ].join('\n');

  return [
    `Execute the ${agentName} task using only the validated JSON input below.`,
    'Return only the requested structured output. Keep rationale fields short and explicit; never return private chain of thought.',
    outputLanguageInstruction(validatedInput),
    agentPromptConstraint(agentName),
    repairInstruction,
    `Validated input: ${JSON.stringify(validatedInput)}`,
  ]
    .filter((part) => part.length > 0)
    .join('\n');
}

function outputLanguageInstruction(validatedInput: AgentPromptInput): string {
  const language = validatedInput.interviewState.language;
  const outputLanguage = language === 'en' ? 'English (en)' : 'German (de)';
  return [
    `OUTPUT_LANGUAGE_CODE: ${language}.`,
    `Write every newly generated natural-language output field in ${outputLanguage}.`,
    'Preserve verbatim guide text, transcript excerpts, identifiers, schema property names, enum values, and fields that the input requires you to copy exactly; never translate or paraphrase those values.',
  ].join(' ');
}

function agentPromptConstraint(agentName: AgentName): string {
  if (agentName === 'coverage_analysis') {
    return [
      'The current status is an input-only control state and must never appear in a finding.',
      'Use partially_answered only with one or more exact participant transcriptTurnIds and at least one concrete openAspects entry.',
      'Use answered only with one or more exact participant transcriptTurnIds and an empty openAspects array.',
      'Do not repeat unchanged coverage records that the latest participant answer does not affect.',
    ].join(' ');
  }
  if (agentName !== 'interview_decision') return '';
  return [
    'Use ask_clarification_question only for an entry in consistencyAnalysis.contradictions with shouldClarify=true.',
    'For that action, copy the entry id verbatim to basis.contradictionId and suggestedClarificationQuestion verbatim to basis.sourceQuestion.',
    'Never turn coverageAnalysis openAspects into contradictions; address open aspects only by choosing an allowed ask_main_question or ask_follow_up_question target from the guide.',
    'Do not repeat a partially answered guide question while an eligible not-addressed guide question remains.',
  ].join(' ');
}

function classifyValidationRejection(issues: readonly AgentGuardrailIssue[]): AttemptRejection {
  return {
    code: issues.every((issue) => issue.code === 'schema_invalid')
      ? 'invalid_output'
      : 'guardrail_rejected',
    issues: issues.map((issue) => ({
      code: issue.code,
      path: issue.path,
      message: issue.message,
    })),
  };
}

function classifyGenerationError(
  error: unknown,
  externalSignal: AbortSignal,
): AgentExecutionFailure {
  if (error instanceof ExecutionDeadlineError) return failureFor('timeout');
  if (externalSignal.aborted || errorIdentity(error).has('aborterror')) {
    return failureFor('aborted');
  }

  const identity = errorIdentity(error);
  const status = errorStatus(error);
  if (
    status === 429 ||
    [...identity].some((value) => value.includes('rate_limit') || value.includes('ratelimit'))
  ) {
    return failureFor('rate_limited');
  }
  if (
    [...identity].some(
      (value) =>
        value.includes('noobjectgenerated') ||
        value.includes('jsonparse') ||
        value.includes('typevalidation') ||
        value.includes('structured_output'),
    )
  ) {
    return failureFor('invalid_output');
  }
  return failureFor('provider_error');
}

function failureFor(code: AgentExecutionFailure['code']): AgentExecutionFailure {
  const definitions: Record<
    AgentExecutionFailure['code'],
    { readonly message: string; readonly retryable: boolean }
  > = {
    aborted: { message: 'Agent execution was aborted.', retryable: false },
    timeout: { message: 'Agent execution timed out.', retryable: true },
    rate_limited: { message: 'Agent provider rate limit exceeded.', retryable: true },
    provider_error: { message: 'Agent provider request failed.', retryable: true },
    invalid_input: { message: 'Agent input validation failed.', retryable: false },
    invalid_output: { message: 'Agent returned invalid structured output.', retryable: true },
    guardrail_rejected: { message: 'Agent output failed semantic guardrails.', retryable: true },
  };
  return { code, ...definitions[code] };
}

function modelMetadata(model: string): ModelMetadata {
  const separator = model.indexOf('/');
  return {
    mode: 'provider',
    provider: separator > 0 ? model.slice(0, separator) : null,
    model,
  };
}

function errorIdentity(error: unknown): ReadonlySet<string> {
  const identities = new Set<string>();
  let current: unknown = error;
  for (let depth = 0; depth < 3 && isRecord(current); depth += 1) {
    for (const key of ['name', 'code', 'id', 'type'] as const) {
      const value = current[key];
      if (typeof value === 'string') identities.add(value.toLowerCase());
    }
    current = current.cause;
  }
  return identities;
}

function errorStatus(error: unknown): number | null {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && isRecord(current); depth += 1) {
    for (const key of ['status', 'statusCode'] as const) {
      const value = current[key];
      if (typeof value === 'number') return value;
    }
    current = current.cause;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
