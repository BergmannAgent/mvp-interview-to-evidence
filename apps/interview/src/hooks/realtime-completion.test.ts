import { describe, expect, it, vi } from 'vitest';
import {
  createSpeechResponseConfig,
  handleRealtimeEvent,
  trackRealtimeConversationItem,
  type RealtimeEventContext,
} from './use-openai-voice.js';

function harness() {
  const context: RealtimeEventContext = {
    event: {},
    channel: { readyState: 'open', send: vi.fn() },
    participantPartials: new Map(),
    participantPartialRevisions: new Map(),
    completedParticipantItems: new Set(),
    aiPartials: new Map(),
    completedAiItems: new Set(),
    completedAiTranscripts: new Map(),
    aiResponseIds: new Map(),
    publishedAiItems: new Set(),
    responseStatuses: new Map(),
    drainedResponseIds: new Set(),
    interruptedResponseIds: new Set(),
    responsePlans: new Map(),
    responseTurnIds: new Map(),
    pendingResponse: {
      clientRequestId: 'request-closing',
      responseId: 'closing',
      turnId: null,
      timeoutId: 0,
      resolve: vi.fn(),
      reject: vi.fn(),
      callbackTasks: [],
      hasAudio: true,
      playbackStarted: true,
      plan: {
        deliveryId: 'delivery-closing',
        workflowRunId: 'workflow',
        questionId: null,
        turnType: 'closing',
      },
    },
    pendingTurnPlan: null,
    callbacks: { onFinalTurn: vi.fn(), onAiTranscriptDone: vi.fn() },
    updateState: vi.fn(),
    reportFailure: vi.fn(),
    settlePendingResponse: vi.fn(),
    settlePendingTurnPlan: vi.fn(),
    restartPendingTurnPlanTimeout: vi.fn(),
    confirmPersistedTimeoutInterruption: vi.fn(),
    playRemoteAudio: vi.fn(),
    setCaptureBlocked: vi.fn(),
    isTurnPlanRequestActive: () => true,
    enqueueParticipantPartial: vi.fn(),
    enqueueFinalParticipantTurn: vi.fn(),
  };
  const emit = (event: Record<string, unknown>) => handleRealtimeEvent({ ...context, event });
  return { context, emit };
}

describe('closing playback event ordering', () => {
  it.each([
    'output_audio_buffer.stopped',
    'output_audio_buffer.cleared',
    'output_audio_buffer.started',
    'response.output_audio_transcript.delta',
  ])('ignores %s from the previous question while closing is active', (type) => {
    const { context, emit } = harness();
    emit({ type, response_id: 'previous-question', item_id: 'old-item', delta: 'Bitte antworten' });
    expect(context.settlePendingResponse).not.toHaveBeenCalled();
    expect(context.setCaptureBlocked).not.toHaveBeenCalled();
    expect(context.updateState).not.toHaveBeenCalled();
    expect(context.playRemoteAudio).not.toHaveBeenCalled();
  });

  it('ignores a late response.done even if the previous audio buffer was drained', () => {
    const { context, emit } = harness();
    context.drainedResponseIds.add('previous-question');
    emit({
      type: 'response.done',
      response: { id: 'previous-question', status: 'completed', output: [] },
    });
    expect(context.settlePendingResponse).not.toHaveBeenCalled();
  });

  it.each(['transcript-first', 'buffer-first'])(
    'persists the closing once after playback and generation (%s)',
    async (order) => {
      const { context, emit } = harness();
      const transcript = {
        type: 'response.output_audio_transcript.done',
        response_id: 'closing',
        item_id: 'closing-item',
        transcript: 'Vielen Dank fuer Ihre Zeit.',
      };
      const done = {
        type: 'response.done',
        response: { id: 'closing', status: 'completed', output: [] },
      };
      const stopped = { type: 'output_audio_buffer.stopped', response_id: 'closing' };
      emit(transcript);
      if (order === 'transcript-first') {
        emit(done);
        emit(stopped);
      } else {
        emit(stopped);
        emit(done);
      }
      emit(done);
      await Promise.all(context.pendingResponse?.callbackTasks ?? []);
      expect(context.callbacks.onAiTranscriptDone).toHaveBeenCalledTimes(1);
      expect(context.callbacks.onAiTranscriptDone).toHaveBeenCalledWith(
        expect.objectContaining({
          deliveryId: 'delivery-closing',
          turnType: 'closing',
          text: 'Vielen Dank fuer Ihre Zeit.',
        }),
      );
    },
  );

  it('does not submit the same planning result twice or acknowledge it after cancellation', async () => {
    const { context } = harness();
    let active = true;
    let resolve: (value: null) => void = () => undefined;
    const callback = vi.fn(
      () =>
        new Promise<null>((done) => {
          resolve = done;
        }),
    );
    const pendingTurnPlan = {
      clientRequestId: 'planner',
      responseId: 'plan-response',
      timeoutId: 0,
      repairAttempts: 0,
      handlingResult: false,
      resolve: vi.fn(),
      reject: vi.fn(),
    };
    const planningContext = {
      ...context,
      pendingResponse: null,
      pendingTurnPlan,
      callbacks: { onFinalTurn: vi.fn(), onTurnIntent: callback },
      isTurnPlanRequestActive: () => active,
    };
    const event = {
      type: 'response.done',
      response: {
        id: 'plan-response',
        status: 'completed',
        output: [
          {
            type: 'function_call',
            name: 'plan_interview_turn',
            call_id: 'call',
            arguments: JSON.stringify({
              action: 'complete_interview',
              questionId: null,
              spokenText: 'Vielen Dank.',
              answerDisposition: 'answered',
              missingAspect: null,
              requestedEvidenceType: null,
            }),
          },
        ],
      },
    };
    handleRealtimeEvent({ ...planningContext, event });
    handleRealtimeEvent({ ...planningContext, event });
    await Promise.resolve();
    expect(callback).toHaveBeenCalledTimes(1);
    active = false;
    resolve(null);
    await new Promise<void>((done) => setImmediate(done));
    expect(context.channel.send).not.toHaveBeenCalled();
    expect(context.settlePendingTurnPlan).not.toHaveBeenCalled();
  });
});

describe('bounded Realtime planning repair', () => {
  function planningHarness() {
    const { context } = harness();
    const pendingTurnPlan: NonNullable<RealtimeEventContext['pendingTurnPlan']> = {
      clientRequestId: 'planner',
      responseId: 'original',
      repairAttempts: 0,
      handlingResult: false,
      timeoutId: 0,
      resolve: vi.fn(),
      reject: vi.fn(),
    };
    const onTurnIntent = vi
      .fn()
      .mockResolvedValue({ reason: 'Name the missing responsibility explicitly.' });
    const onTurnPlanFallback = vi.fn().mockResolvedValue(null);
    const active = { value: true };
    const planningContext: RealtimeEventContext = {
      ...context,
      pendingResponse: null,
      pendingTurnPlan,
      callbacks: { onFinalTurn: vi.fn(), onTurnIntent, onTurnPlanFallback },
      isTurnPlanRequestActive: () => active.value,
    };
    const emit = (
      id: string,
      repairAttempt = 0,
      args = JSON.stringify({
        action: 'ask_clarification_question',
        questionId: 'main',
        spokenText: 'Wer ist fuer diese Massnahme verantwortlich?',
        answerDisposition: 'partial',
        missingAspect: 'Verantwortung fuer diese Massnahme',
        requestedEvidenceType: 'responsibility',
      }),
    ) =>
      handleRealtimeEvent({
        ...planningContext,
        event: {
          type: 'response.done',
          response: {
            id,
            status: 'completed',
            metadata: { client_request_id: 'planner', repair_attempt: String(repairAttempt) },
            output: [
              {
                type: 'function_call',
                name: 'plan_interview_turn',
                call_id: `call-${id}`,
                arguments: args,
              },
            ],
          },
        },
      });
    return {
      context: planningContext,
      emit,
      onTurnIntent,
      onTurnPlanFallback,
      pendingTurnPlan,
      active,
    };
  }

  const flush = () => new Promise<void>((done) => setImmediate(done));

  it('feeds the approved canonical question and wording back into the live conversation', async () => {
    const h = planningHarness();
    const plan = {
      deliveryId: 'approved-delivery',
      workflowRunId: 'run',
      text: 'Was war Ihre erste konkrete Massnahme?',
      turnType: 'clarification_question',
      questionId: 'main',
      guideReference: {
        kind: 'main_question',
        guideId: 'guide',
        sectionId: 'section',
        mainQuestionId: 'main',
      },
    };
    h.onTurnIntent.mockResolvedValueOnce(plan);
    h.emit('original');
    await flush();
    expect(h.context.settlePendingTurnPlan).toHaveBeenCalledWith(plan);
    const event: unknown = JSON.parse(
      vi.mocked(h.context.channel.send).mock.calls[0]?.[0] ?? 'null',
    );
    expect(event).toMatchObject({
      item: {
        type: 'function_call_output',
        output: JSON.stringify({
          accepted: true,
          deliveryId: plan.deliveryId,
          questionId: plan.questionId,
          turnType: plan.turnType,
          text: plan.text,
        }),
      },
    });
  });

  it('repairs a semantic rejection once and ignores late original responses', async () => {
    const h = planningHarness();
    h.emit('original');
    await flush();
    expect(h.pendingTurnPlan.repairAttempts).toBe(1);
    expect(h.onTurnIntent).toHaveBeenCalledWith(expect.objectContaining({ repairAttempt: 0 }));
    expect(h.context.restartPendingTurnPlanTimeout).toHaveBeenCalledTimes(1);
    handleRealtimeEvent({
      ...h.context,
      event: {
        type: 'response.created',
        response: {
          id: 'original',
          metadata: { client_request_id: 'planner' },
        },
      },
    });
    h.emit('original');
    await flush();
    expect(h.pendingTurnPlan.responseId).toBeNull();
    expect(h.onTurnIntent).toHaveBeenCalledTimes(1);
    h.onTurnIntent.mockResolvedValueOnce(null);
    h.emit('repair', 1);
    await flush();
    expect(h.onTurnIntent).toHaveBeenLastCalledWith(expect.objectContaining({ repairAttempt: 1 }));
    expect(h.context.settlePendingTurnPlan).toHaveBeenCalledWith(null);
    expect(h.onTurnPlanFallback).not.toHaveBeenCalled();
    expect(h.context.reportFailure).not.toHaveBeenCalled();
  });

  it('advances once after two malformed plans, including duplicate completion events', async () => {
    const h = planningHarness();
    h.emit('original', 0, '{');
    h.emit('repair', 1, '{');
    h.emit('repair', 1, '{');
    await flush();
    expect(h.onTurnIntent).not.toHaveBeenCalled();
    expect(h.onTurnPlanFallback).toHaveBeenCalledTimes(1);
    expect(h.onTurnPlanFallback).toHaveBeenCalledWith('planner');
    expect(h.context.restartPendingTurnPlanTimeout).toHaveBeenCalledTimes(1);
    expect(h.context.settlePendingTurnPlan).toHaveBeenCalledTimes(1);
    expect(h.context.reportFailure).not.toHaveBeenCalled();
  });

  it('does not invoke deterministic advancement after a cancelled planning request', async () => {
    const h = planningHarness();
    h.emit('original', 0, '{');
    h.emit('repair', 1, '{');
    h.active.value = false;
    await flush();
    expect(h.onTurnPlanFallback).not.toHaveBeenCalled();
    expect(h.context.settlePendingTurnPlan).not.toHaveBeenCalled();
  });
});

describe('isolated speech output', () => {
  it('uses no conversation history or tools for the exact closing utterance', () => {
    const response = createSpeechResponseConfig('closing', 'Speak only: Vielen Dank.', {
      deliveryId: 'delivery',
      workflowRunId: 'run',
      questionId: null,
      turnType: 'closing',
    });
    expect(response).toMatchObject({
      conversation: 'none',
      input: [],
      tools: [],
      tool_choice: 'none',
      instructions: 'Speak only: Vielen Dank.',
      output_modalities: ['audio'],
    });
  });

  it('does not treat an out-of-band audio item as a deletable conversation item', () => {
    const items = new Set<string>();
    trackRealtimeConversationItem(
      { type: 'response.output_audio_transcript.done', item_id: 'out-of-band' },
      items,
    );
    trackRealtimeConversationItem(
      { type: 'conversation.item.added', item: { id: 'participant' } },
      items,
    );
    expect([...items]).toEqual(['participant']);
    trackRealtimeConversationItem(
      { type: 'conversation.item.deleted', item_id: 'participant' },
      items,
    );
    expect(items.size).toBe(0);
  });
});
