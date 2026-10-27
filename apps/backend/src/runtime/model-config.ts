import { EVALUATION_RUN_STALE_AFTER_MS } from '@orgscience/contracts';
import { z } from 'zod';

const DEFAULT_INTERVIEW_AGENT_MODEL = 'openai/gpt-5.4-nano';
const DEFAULT_EVALUATION_MODEL = 'openai/gpt-5.6-terra';
const DEFAULT_EVALUATION_TIMEOUT_MS = 120_000;
const EVALUATION_RECOVERY_GRACE_MS = 60_000;
const MAXIMUM_EVALUATION_TIMEOUT_MS = EVALUATION_RUN_STALE_AFTER_MS - EVALUATION_RECOVERY_GRACE_MS;

const evaluationTimeoutSchema = z.coerce
  .number()
  .int('EVALUATION_TIMEOUT_MS must be an integer')
  .min(1_000, 'EVALUATION_TIMEOUT_MS must be at least 1000')
  .max(
    MAXIMUM_EVALUATION_TIMEOUT_MS,
    `EVALUATION_TIMEOUT_MS must be at most ${String(MAXIMUM_EVALUATION_TIMEOUT_MS)}`,
  )
  .default(DEFAULT_EVALUATION_TIMEOUT_MS);

export interface ModelRuntimeConfig {
  readonly interviewAgentModel: string;
  readonly evaluationModel: string;
  readonly evaluationTimeoutMs: number;
}

export class ModelRuntimeConfigurationError extends Error {
  public readonly issues: readonly string[];

  public constructor(issues: readonly string[]) {
    super(`Invalid model runtime configuration: ${issues.join('; ')}`);
    this.name = 'ModelRuntimeConfigurationError';
    this.issues = issues;
  }
}

export function loadModelRuntimeConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ModelRuntimeConfig {
  const legacyModel = configuredModel(environment.AI_MODEL);
  const evaluationTimeout = evaluationTimeoutSchema.safeParse(environment.EVALUATION_TIMEOUT_MS);
  if (!evaluationTimeout.success) {
    throw new ModelRuntimeConfigurationError(
      evaluationTimeout.error.issues.map((issue) => issue.message),
    );
  }

  return Object.freeze({
    interviewAgentModel:
      configuredModel(environment.INTERVIEW_AGENT_MODEL) ??
      legacyModel ??
      DEFAULT_INTERVIEW_AGENT_MODEL,
    evaluationModel:
      configuredModel(environment.EVALUATION_MODEL) ?? legacyModel ?? DEFAULT_EVALUATION_MODEL,
    evaluationTimeoutMs: evaluationTimeout.data,
  });
}

function configuredModel(value: string | undefined): string | undefined {
  const model = value?.trim();
  return model === undefined || model.length === 0 ? undefined : model;
}
