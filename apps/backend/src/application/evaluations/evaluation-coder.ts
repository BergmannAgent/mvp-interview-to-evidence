import type {
  EvaluationProfileDocument,
  ModelMetadata,
  MvpInterviewSession,
  ProfileEvaluationCodingOutput,
} from '@orgscience/contracts';

export const PROFILE_EVALUATION_CODING_PROMPT_VERSION = 'profile-evidence-coding-v7' as const;

export interface EvaluationCodingInput {
  readonly profile: EvaluationProfileDocument;
  readonly session: MvpInterviewSession;
}

export interface EvaluationCodingContext {
  readonly runId: string;
  readonly signal: AbortSignal;
}

export interface EvaluationCodingFailure {
  readonly code:
    | 'aborted'
    | 'timeout'
    | 'rate_limited'
    | 'provider_error'
    | 'invalid_input'
    | 'invalid_output'
    | 'guardrail_rejected';
  readonly message: string;
  readonly retryable: boolean;
}

export type EvaluationCodingResult =
  | {
      readonly ok: true;
      readonly output: ProfileEvaluationCodingOutput;
    }
  | {
      readonly ok: false;
      readonly error: EvaluationCodingFailure;
    };

export interface EvaluationCoder {
  readonly model: ModelMetadata;

  code(
    input: EvaluationCodingInput,
    context: EvaluationCodingContext,
  ): Promise<EvaluationCodingResult>;
}
