import type { MonitoringEvent } from './monitoring.js';

type AiTextStreamEventType =
  | 'transcript.ai_text_stream_started'
  | 'transcript.ai_text_delta'
  | 'transcript.ai_text_stream_completed'
  | 'transcript.ai_text_stream_interrupted';

export type AiTextStreamEvent = Extract<MonitoringEvent, { readonly type: AiTextStreamEventType }>;

interface AiTextStreamStateBase {
  readonly interviewId: string;
  readonly runId: string;
  readonly utteranceId: string;
  readonly turnId: string;
  readonly lastDeltaSequenceNumber: number;
  readonly generatedText: string;
}

export type AiTextStreamState =
  | (AiTextStreamStateBase & { readonly status: 'streaming' })
  | (AiTextStreamStateBase & {
      readonly status: 'completed';
      readonly confirmedSpokenText: string;
      readonly completedAt: string;
    })
  | (AiTextStreamStateBase & {
      readonly status: 'interrupted';
      readonly confirmedSpokenText: string;
      readonly interruptedAt: string;
    });

export class AiTextStreamSequenceError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'AiTextStreamSequenceError';
  }
}

export function reduceAiTextStreamEvent(
  state: AiTextStreamState | null,
  event: AiTextStreamEvent,
): AiTextStreamState {
  if (event.type === 'transcript.ai_text_stream_started') {
    if (state !== null) {
      throw new AiTextStreamSequenceError('An AI text stream may start only once');
    }
    return {
      status: 'streaming',
      interviewId: event.interviewId,
      runId: event.runId,
      utteranceId: event.payload.utteranceId,
      turnId: event.payload.turnId,
      lastDeltaSequenceNumber: 0,
      generatedText: '',
    };
  }

  if (state === null) {
    throw new AiTextStreamSequenceError('An AI text stream event arrived before its start');
  }
  assertStreamIdentity(state, event);
  if (state.status !== 'streaming') {
    throw new AiTextStreamSequenceError('An AI text stream cannot change after a terminal event');
  }

  if (event.type === 'transcript.ai_text_delta') {
    const expectedSequence = state.lastDeltaSequenceNumber + 1;
    if (event.payload.deltaSequenceNumber !== expectedSequence) {
      throw new AiTextStreamSequenceError(
        `Expected AI text delta ${String(expectedSequence)}, received ${String(event.payload.deltaSequenceNumber)}`,
      );
    }
    return {
      ...state,
      lastDeltaSequenceNumber: event.payload.deltaSequenceNumber,
      generatedText: state.generatedText + event.payload.textDelta,
    };
  }

  if (event.payload.lastDeltaSequenceNumber !== state.lastDeltaSequenceNumber) {
    throw new AiTextStreamSequenceError('AI text terminal event references the wrong final delta');
  }
  if (event.payload.generatedText !== state.generatedText) {
    throw new AiTextStreamSequenceError('AI text terminal event does not match accumulated deltas');
  }

  return event.type === 'transcript.ai_text_stream_completed'
    ? {
        ...state,
        status: 'completed',
        confirmedSpokenText: event.payload.confirmedSpokenText,
        completedAt: event.payload.completedAt,
      }
    : {
        ...state,
        status: 'interrupted',
        confirmedSpokenText: event.payload.confirmedSpokenText,
        interruptedAt: event.payload.interruptedAt,
      };
}

function assertStreamIdentity(state: AiTextStreamState, event: AiTextStreamEvent): void {
  if (
    event.interviewId !== state.interviewId ||
    event.runId !== state.runId ||
    event.payload.utteranceId !== state.utteranceId ||
    event.payload.turnId !== state.turnId
  ) {
    throw new AiTextStreamSequenceError('AI text stream identity changed between events');
  }
}
