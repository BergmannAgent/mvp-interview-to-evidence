import { z } from 'zod';

import {
  VoiceProviderError,
  type RealtimeInterviewSecret,
  type RealtimeInterviewSecretRequest,
  type VoiceGateway,
} from '../../application/voice/index.js';
import type { OpenAiVoiceConfig } from './config.js';

const MAX_REALTIME_OUTPUT_TOKENS = 512;
const REALTIME_TRACE_WORKFLOW_NAME = 'orgscience_live_interview';
const REALTIME_INTERVIEW_TURN_TOOL = Object.freeze({
  type: 'function',
  name: 'plan_interview_turn',
  description:
    'Classify the latest answer and select exactly one guide-bounded interviewer question, one specific neutral clarification, or the interview closing. The client validates and persists the turn before it is spoken.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: {
        type: 'string',
        enum: [
          'ask_main_question',
          'ask_follow_up_question',
          'ask_clarification_question',
          'repeat_question',
          'complete_interview',
        ],
      },
      questionId: { type: ['string', 'null'], minLength: 1, maxLength: 128 },
      spokenText: { type: 'string', minLength: 1, maxLength: 600 },
      answerDisposition: {
        type: 'string',
        enum: [
          'answered',
          'partial',
          'off_topic',
          'question_misunderstood',
          'dont_know',
          'declined',
          'not_applicable',
          'already_answered',
        ],
      },
      missingAspect: { type: ['string', 'null'], minLength: 1, maxLength: 300 },
      requestedEvidenceType: {
        type: ['string', 'null'],
        enum: [
          'example',
          'responsibility',
          'actor',
          'action',
          'sequence',
          'outcome',
          'timeframe',
          'contradiction',
          null,
        ],
      },
    },
    required: [
      'action',
      'questionId',
      'spokenText',
      'answerDisposition',
      'missingAspect',
      'requestedEvidenceType',
    ],
  },
});

const realtimeSecretResponseSchema = z.object({
  value: z.string().min(1),
  expires_at: z.number().int().positive(),
  session: z.object({
    id: z.string().min(1),
    type: z.literal('realtime'),
    model: z.string().min(1),
  }),
});

export interface OpenAiVoiceGatewayOptions {
  readonly fetch?: typeof fetch;
}

export class OpenAiVoiceGateway implements VoiceGateway {
  readonly #config: OpenAiVoiceConfig;
  readonly #fetch: typeof fetch;

  public constructor(config: OpenAiVoiceConfig, options: OpenAiVoiceGatewayOptions = {}) {
    this.#config = config;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  public async createRealtimeInterviewSecret(
    request: RealtimeInterviewSecretRequest,
  ): Promise<RealtimeInterviewSecret> {
    validateRealtimeInterviewRequest(request);

    const transcription = {
      model: this.#config.transcriptionModel,
      ...(request.language === undefined ? {} : { language: request.language }),
    };
    const response = await this.#post(
      'realtime/client_secrets',
      {
        expires_after: {
          anchor: 'created_at',
          seconds: this.#config.realtimeSecretTtlSeconds,
        },
        session: {
          type: 'realtime',
          model: this.#config.realtimeModel,
          output_modalities: ['audio'],
          instructions: request.instructions,
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: 24_000 },
              transcription,
              noise_reduction: { type: 'near_field' },
              turn_detection: {
                type: 'semantic_vad',
                eagerness: 'low',
                create_response: false,
                interrupt_response: false,
              },
            },
            output: {
              format: { type: 'audio/pcm', rate: 24_000 },
              voice: this.#config.realtimeVoice,
            },
          },
          reasoning: { effort: 'low' },
          max_output_tokens: MAX_REALTIME_OUTPUT_TOKENS,
          tools: [REALTIME_INTERVIEW_TURN_TOOL],
          tool_choice: 'auto',
          tracing: {
            workflow_name: REALTIME_TRACE_WORKFLOW_NAME,
            group_id: request.interviewId,
            metadata: { interview_id: request.interviewId },
          },
        },
      },
      'realtime_interview_secret',
      request.signal,
    );

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw invalidResponse();
    }
    const parsed = realtimeSecretResponseSchema.safeParse(payload);
    if (!parsed.success) throw invalidResponse();

    return Object.freeze({
      value: parsed.data.value,
      expiresAt: parsed.data.expires_at,
      sessionId: parsed.data.session.id,
      model: parsed.data.session.model,
    });
  }

  async #post(
    path: string,
    body: unknown,
    operation: 'realtime_interview_secret',
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#config.baseUrl}/${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#config.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) {
        throw new VoiceProviderError(
          'aborted',
          operation,
          'OpenAI voice request was aborted.',
          false,
        );
      }
      throw new VoiceProviderError(
        'provider_error',
        operation,
        'OpenAI voice request failed.',
        true,
      );
    }

    if (!response.ok) {
      const rateLimited = response.status === 429;
      throw new VoiceProviderError(
        rateLimited ? 'rate_limited' : 'provider_error',
        operation,
        rateLimited ? 'OpenAI voice request was rate limited.' : 'OpenAI voice request failed.',
        response.status === 408 || response.status === 429 || response.status >= 500,
        response.status,
      );
    }
    return response;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function invalidResponse(): VoiceProviderError {
  return new VoiceProviderError(
    'invalid_response',
    'realtime_interview_secret',
    'OpenAI voice response was invalid.',
    false,
  );
}

function validateRealtimeInterviewRequest(request: RealtimeInterviewSecretRequest): void {
  if (request.instructions.trim().length === 0) {
    throw new VoiceProviderError(
      'invalid_request',
      'realtime_interview_secret',
      'Realtime interview instructions must not be empty.',
      false,
    );
  }
  if (request.interviewId.trim().length === 0) {
    throw new VoiceProviderError(
      'invalid_request',
      'realtime_interview_secret',
      'Realtime interview ID must not be empty.',
      false,
    );
  }
  if (request.language !== undefined && request.language.trim().length === 0) {
    throw new VoiceProviderError(
      'invalid_request',
      'realtime_interview_secret',
      'Realtime interview language must not be empty when provided.',
      false,
    );
  }
}
