import { describe, expect, it } from 'vitest';
import { voiceDiagnosticSchema } from '@orgscience/contracts';
import { clientVoiceDiagnostic, providerVoiceDiagnostic } from './voice-diagnostics.js';

describe('voice diagnostics', () => {
  it('preserves provider error codes and response IDs without forwarding the conversation', () => {
    const diagnostic = providerVoiceDiagnostic({
      type: 'response.done',
      event_id: 'event_123',
      response: {
        id: 'resp_123',
        status: 'failed',
        output: [{ text: 'private answer' }],
        status_details: {
          error: {
            code: 'rate_limit_exceeded',
            type: 'tokens',
            message: 'Rate limit reached. Retry in 2 seconds.',
          },
        },
      },
    });
    expect(diagnostic).toMatchObject({
      code: 'rate_limit_exceeded',
      responseId: 'resp_123',
      providerEventId: 'event_123',
      message: 'Rate limit reached. Retry in 2 seconds.',
    });
    expect(JSON.stringify(diagnostic)).not.toContain('private answer');
  });

  it('captures protocol, transcription and incomplete response errors', () => {
    for (const type of ['error', 'conversation.item.input_audio_transcription.failed']) {
      expect(
        providerVoiceDiagnostic({ type, error: { code: 'server_error', message: 'Try again.' } })
          ?.code,
      ).toBe('server_error');
    }
    expect(
      providerVoiceDiagnostic({
        type: 'response.done',
        response: { status: 'incomplete', status_details: { reason: 'max_output_tokens' } },
      })?.code,
    ).toBe('max_output_tokens');
  });

  it('ignores normal transcript and completed response events', () => {
    expect(
      providerVoiceDiagnostic({ type: 'response.done', response: { status: 'completed' } }),
    ).toBeNull();
    expect(
      providerVoiceDiagnostic({
        type: 'response.output_audio_transcript.delta',
        delta: 'private answer',
      }),
    ).toBeNull();
  });

  it('sanitizes secrets, URLs and quoted provider echoes on both boundaries', () => {
    const diagnostic = clientVoiceDiagnostic(
      new Error(
        'Invalid sk-secret123 Bearer abc123 "private answer" https://example.com?token=secret',
      ),
    );
    expect(diagnostic.message).not.toMatch(/secret123|abc123|private answer|example.com/);
    expect(
      voiceDiagnosticSchema.parse({ ...diagnostic, message: 'Invalid ek_secret123' }).message,
    ).toBe('Invalid [secret]');
  });

  it('bounds messages and rejects extra raw data', () => {
    const diagnostic = clientVoiceDiagnostic(new Error('x'.repeat(8000)));
    expect(diagnostic.message).toHaveLength(1000);
    expect(voiceDiagnosticSchema.safeParse({ ...diagnostic, audio: 'raw' }).success).toBe(false);
  });
});
