import { voiceDiagnosticSchema, type VoiceDiagnostic } from '@orgscience/contracts';

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

function token(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : null;
}

/** Select diagnostic fields only: never forward audio, conversation items or full events. */
export function providerVoiceDiagnostic(event: Record<string, unknown>): VoiceDiagnostic | null {
  const response = record(event.response);
  const details = record(response.status_details);
  const isResponseFailure =
    event.type === 'response.done' &&
    (response.status === 'failed' || response.status === 'incomplete');
  if (
    event.type !== 'error' &&
    event.type !== 'conversation.item.input_audio_transcription.failed' &&
    !isResponseFailure
  )
    return null;
  const error = record(isResponseFailure ? details.error : event.error);
  return voiceDiagnosticSchema.parse({
    diagnosticId: crypto.randomUUID(),
    occurredAt: new Date().toISOString(),
    source: 'provider',
    eventType: token(event.type),
    code: token(error.code) ?? token(details.reason),
    errorType: token(error.type) ?? token(response.status),
    responseId: token(response.id) ?? token(event.response_id),
    providerEventId: token(event.event_id),
    message:
      typeof error.message === 'string' && error.message.length > 0
        ? error.message.slice(0, 4000)
        : `Realtime failure: ${token(details.reason) ?? token(response.status) ?? 'unknown'}`,
  });
}

export function clientVoiceDiagnostic(error: unknown): VoiceDiagnostic {
  return voiceDiagnosticSchema.parse({
    diagnosticId: crypto.randomUUID(),
    occurredAt: new Date().toISOString(),
    source: 'client',
    eventType: 'client.failure',
    code: 'VOICE_CLIENT_ERROR',
    errorType: error instanceof Error ? token(error.name) : null,
    responseId: null,
    providerEventId: null,
    message:
      error instanceof Error && error.message.length > 0
        ? error.message.slice(0, 4000)
        : 'Unknown voice client failure',
  });
}
