import { describe, expect, it } from 'vitest';

import type { VoiceProviderError } from '../../application/voice/index.js';
import { loadOpenAiVoiceConfig } from './config.js';

describe('OpenAI voice configuration', () => {
  it('uses the selected MVP model and voice defaults', () => {
    expect(loadOpenAiVoiceConfig({ OPENAI_API_KEY: 'test-key' })).toEqual({
      apiKey: 'test-key',
      baseUrl: 'https://api.openai.com/v1',
      realtimeModel: 'gpt-realtime-2.1',
      transcriptionModel: 'gpt-live-transcribe',
      realtimeVoice: 'marin',
      realtimeSecretTtlSeconds: 600,
    });
  });

  it('fails explicitly when the provider key is absent', () => {
    expect(() => loadOpenAiVoiceConfig({})).toThrow(
      expect.objectContaining<Partial<VoiceProviderError>>({
        code: 'missing_api_key',
        operation: 'configuration',
        retryable: false,
      }),
    );
  });

  it('uses the realtime model selected through the environment', () => {
    expect(
      loadOpenAiVoiceConfig({
        OPENAI_API_KEY: 'test-key',
        OPENAI_REALTIME_MODEL: 'gpt-realtime-current',
      }).realtimeModel,
    ).toBe('gpt-realtime-current');
  });

  it('rejects an empty realtime model instead of silently selecting another model', () => {
    expect(() =>
      loadOpenAiVoiceConfig({
        OPENAI_API_KEY: 'test-key',
        OPENAI_REALTIME_MODEL: '   ',
      }),
    ).toThrow(
      expect.objectContaining<Partial<VoiceProviderError>>({
        code: 'invalid_request',
        operation: 'configuration',
        retryable: false,
      }),
    );
  });
});
