import { describe, expect, it, vi } from 'vitest';

import { OpenAiVoiceGateway } from './openai-voice-gateway.js';

const config = {
  apiKey: 'test-secret',
  baseUrl: 'https://api.openai.test/v1',
  realtimeModel: 'gpt-realtime-2.1',
  transcriptionModel: 'gpt-live-transcribe',
  realtimeVoice: 'marin',
  realtimeSecretTtlSeconds: 600,
} as const;

describe('OpenAI voice gateway', () => {
  it('creates a native Realtime interview secret with the controlled session configuration', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        value: 'ek_test',
        expires_at: 1_800_000_000,
        session: { id: 'sess_test', type: 'realtime', model: 'gpt-realtime-2.1' },
      }),
    );
    const gateway = new OpenAiVoiceGateway(config, { fetch: fetchMock });
    const instructions = 'Conduct the supplied interview and ask exactly one question at a time.';

    await expect(
      gateway.createRealtimeInterviewSecret({
        language: 'de',
        instructions,
        interviewId: 'interview-123',
      }),
    ).resolves.toEqual({
      value: 'ek_test',
      expiresAt: 1_800_000_000,
      sessionId: 'sess_test',
      model: 'gpt-realtime-2.1',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.test/v1/realtime/client_secrets',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          expires_after: { anchor: 'created_at', seconds: 600 },
          session: {
            type: 'realtime',
            model: 'gpt-realtime-2.1',
            output_modalities: ['audio'],
            instructions,
            audio: {
              input: {
                format: { type: 'audio/pcm', rate: 24_000 },
                transcription: { model: 'gpt-live-transcribe', language: 'de' },
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
                voice: 'marin',
              },
            },
            reasoning: { effort: 'low' },
            max_output_tokens: 512,
            tools: [
              {
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
                    questionId: {
                      type: ['string', 'null'],
                      minLength: 1,
                      maxLength: 128,
                    },
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
                    missingAspect: {
                      type: ['string', 'null'],
                      minLength: 1,
                      maxLength: 300,
                    },
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
              },
            ],
            tool_choice: 'auto',
            tracing: {
              workflow_name: 'orgscience_live_interview',
              group_id: 'interview-123',
              metadata: { interview_id: 'interview-123' },
            },
          },
        }),
      }),
    );
  });

  it('passes server-controlled session instructions through without adding interview behavior', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        value: 'ek_test',
        expires_at: 1_800_000_000,
        session: { id: 'sess_test', type: 'realtime', model: 'gpt-realtime-2.1' },
      }),
    );
    const gateway = new OpenAiVoiceGateway(config, { fetch: fetchMock });
    const instructions =
      'Only render the exact utterance supplied in an explicit response.create instruction.';

    await gateway.createRealtimeInterviewSecret({ instructions, interviewId: 'interview-123' });

    const request = fetchMock.mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body)) as {
      session: { instructions: string; tools: unknown[]; tool_choice: string };
    };
    expect(body.session).toMatchObject({ instructions, tool_choice: 'auto' });
    expect(body.session.tools).toEqual([
      expect.objectContaining({ type: 'function', name: 'plan_interview_turn' }),
    ]);
  });

  it('rejects an empty interview ID before contacting OpenAI', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const gateway = new OpenAiVoiceGateway(config, { fetch: fetchMock });

    await expect(
      gateway.createRealtimeInterviewSecret({
        instructions: 'Conduct the interview.',
        interviewId: '   ',
      }),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      operation: 'realtime_interview_secret',
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
