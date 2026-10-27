import { z } from 'zod';

import { VoiceProviderError } from '../../application/voice/index.js';

const voiceEnvironmentSchema = z.strictObject({
  OPENAI_API_KEY: z.string().trim().min(1).optional(),
  OPENAI_API_BASE_URL: z.url().default('https://api.openai.com/v1'),
  OPENAI_REALTIME_MODEL: z.string().trim().min(1).default('gpt-realtime-2.1'),
  OPENAI_TRANSCRIPTION_MODEL: z.enum(['gpt-live-transcribe']).default('gpt-live-transcribe'),
  OPENAI_REALTIME_VOICE: z
    .enum(['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'])
    .default('marin'),
  OPENAI_REALTIME_SECRET_TTL_SECONDS: z.coerce.number().int().min(10).max(7_200).default(600),
});

export interface OpenAiVoiceConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly realtimeModel: string;
  readonly transcriptionModel: string;
  readonly realtimeVoice: string;
  readonly realtimeSecretTtlSeconds: number;
}

export function loadOpenAiVoiceConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): OpenAiVoiceConfig {
  const result = voiceEnvironmentSchema.safeParse({
    OPENAI_API_KEY: environment.OPENAI_API_KEY,
    OPENAI_API_BASE_URL: environment.OPENAI_API_BASE_URL,
    OPENAI_REALTIME_MODEL: environment.OPENAI_REALTIME_MODEL,
    OPENAI_TRANSCRIPTION_MODEL: environment.OPENAI_TRANSCRIPTION_MODEL,
    OPENAI_REALTIME_VOICE: environment.OPENAI_REALTIME_VOICE,
    OPENAI_REALTIME_SECRET_TTL_SECONDS: environment.OPENAI_REALTIME_SECRET_TTL_SECONDS,
  });

  if (!result.success) {
    const missingApiKey = result.error.issues.some((issue) => issue.path[0] === 'OPENAI_API_KEY');
    throw new VoiceProviderError(
      missingApiKey ? 'missing_api_key' : 'invalid_request',
      'configuration',
      missingApiKey
        ? 'OPENAI_API_KEY is required for OpenAI voice operations.'
        : `Invalid OpenAI voice configuration: ${result.error.issues
            .map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`)
            .join('; ')}`,
      false,
    );
  }

  if (result.data.OPENAI_API_KEY === undefined) {
    throw new VoiceProviderError(
      'missing_api_key',
      'configuration',
      'OPENAI_API_KEY is required for OpenAI voice operations.',
      false,
    );
  }

  return Object.freeze({
    apiKey: result.data.OPENAI_API_KEY,
    baseUrl: result.data.OPENAI_API_BASE_URL.replace(/\/$/, ''),
    realtimeModel: result.data.OPENAI_REALTIME_MODEL,
    transcriptionModel: result.data.OPENAI_TRANSCRIPTION_MODEL,
    realtimeVoice: result.data.OPENAI_REALTIME_VOICE,
    realtimeSecretTtlSeconds: result.data.OPENAI_REALTIME_SECRET_TTL_SECONDS,
  });
}
