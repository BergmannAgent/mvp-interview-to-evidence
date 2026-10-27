import { describe, expect, it } from 'vitest';

import { loadModelRuntimeConfig, ModelRuntimeConfigurationError } from './model-config.js';

describe('model runtime configuration', () => {
  it('uses a low-latency interview model and a stronger end-of-interview evaluation model', () => {
    const config = loadModelRuntimeConfig({});

    expect(config).toEqual({
      interviewAgentModel: 'openai/gpt-5.4-nano',
      evaluationModel: 'openai/gpt-5.6-terra',
      evaluationTimeoutMs: 120_000,
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('loads the two model roles independently', () => {
    expect(
      loadModelRuntimeConfig({
        INTERVIEW_AGENT_MODEL: 'openai/fast-interview-model',
        EVALUATION_MODEL: 'openai/strong-evaluation-model',
      }),
    ).toEqual({
      interviewAgentModel: 'openai/fast-interview-model',
      evaluationModel: 'openai/strong-evaluation-model',
      evaluationTimeoutMs: 120_000,
    });
  });

  it('keeps AI_MODEL as a backward-compatible fallback', () => {
    expect(loadModelRuntimeConfig({ AI_MODEL: 'openai/legacy-model' })).toEqual({
      interviewAgentModel: 'openai/legacy-model',
      evaluationModel: 'openai/legacy-model',
      evaluationTimeoutMs: 120_000,
    });
  });

  it('lets each explicit role override the legacy fallback', () => {
    expect(
      loadModelRuntimeConfig({
        AI_MODEL: 'openai/legacy-model',
        INTERVIEW_AGENT_MODEL: ' openai/fast-model ',
      }),
    ).toEqual({
      interviewAgentModel: 'openai/fast-model',
      evaluationModel: 'openai/legacy-model',
      evaluationTimeoutMs: 120_000,
    });

    expect(
      loadModelRuntimeConfig({
        AI_MODEL: 'openai/legacy-model',
        EVALUATION_MODEL: ' openai/evaluation-model ',
      }),
    ).toEqual({
      interviewAgentModel: 'openai/legacy-model',
      evaluationModel: 'openai/evaluation-model',
      evaluationTimeoutMs: 120_000,
    });
  });

  it('ignores blank role and legacy settings', () => {
    expect(
      loadModelRuntimeConfig({
        AI_MODEL: '  ',
        INTERVIEW_AGENT_MODEL: '',
        EVALUATION_MODEL: '\t',
      }),
    ).toEqual({
      interviewAgentModel: 'openai/gpt-5.4-nano',
      evaluationModel: 'openai/gpt-5.6-terra',
      evaluationTimeoutMs: 120_000,
    });
  });

  it('loads a configured evaluation deadline', () => {
    expect(loadModelRuntimeConfig({ EVALUATION_TIMEOUT_MS: ' 90000 ' })).toMatchObject({
      evaluationTimeoutMs: 90_000,
    });
    expect(loadModelRuntimeConfig({ EVALUATION_TIMEOUT_MS: '240000' })).toMatchObject({
      evaluationTimeoutMs: 240_000,
    });
  });

  it.each(['999', '240001', '600000', '1.5', 'invalid', ''])(
    'rejects invalid evaluation timeout %j',
    (value) => {
      expect(() => loadModelRuntimeConfig({ EVALUATION_TIMEOUT_MS: value })).toThrow(
        ModelRuntimeConfigurationError,
      );
    },
  );
});
