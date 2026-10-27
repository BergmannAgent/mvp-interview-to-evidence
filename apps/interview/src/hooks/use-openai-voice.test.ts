import { describe, expect, it, vi } from 'vitest';

import {
  confirmRealtimeContextItemDeletion,
  createTurnPlanResponseConfig,
  createResponseTimeoutRecovery,
  createVoiceRateLimitError,
  deleteCompactedRealtimeItems,
  isRealtimeRequestCurrent,
  isRealtimeContextUpdateAcknowledgement,
  parseTurnIntent,
  recoverRejectedRealtimeContextDelete,
  readRateLimitRetryDelayMs,
  readVoiceRateLimitRetryDelay,
  realtimeClientErrorEventId,
  sendRealtimeContextUpdateToChannel,
} from './use-openai-voice.js';

describe('Realtime section context updates', () => {
  it('updates instructions before deleting only conversation items known to this session', () => {
    const sent: Record<string, unknown>[] = [];
    const participantItems = new Set(['participant-old']);
    const aiItems = new Set(['ai-old']);
    const channel = {
      readyState: 'open',
      send: (data: string) => sent.push(JSON.parse(data) as Record<string, unknown>),
    };
    const update = {
      revision: 'section-memory:revision-1',
      instructions: 'Compacted instructions',
      removeConversationItemIds: ['participant-old', 'unknown-import', 'ai-old'],
    };

    expect(sendRealtimeContextUpdateToChannel(channel, update, 'context-update-1')).toBe(true);
    expect(sent).toEqual([
      expect.objectContaining({
        type: 'session.update',
        event_id: 'context-update-1',
        session: { type: 'realtime', instructions: 'Compacted instructions' },
      }),
    ]);

    const applied = deleteCompactedRealtimeItems(
      channel,
      update.removeConversationItemIds,
      participantItems,
      aiItems,
    );

    expect(applied).toBe(true);
    expect(sent.slice(1)).toEqual([
      expect.objectContaining({ type: 'conversation.item.delete', item_id: 'participant-old' }),
      expect.objectContaining({ type: 'conversation.item.delete', item_id: 'ai-old' }),
    ]);
    expect(participantItems.size).toBe(0);
    expect(aiItems.size).toBe(0);
  });

  it('fails open and retains item tracking when a provider delete cannot be sent', () => {
    const participantItems = new Set(['participant-old']);
    let calls = 0;
    const applied = deleteCompactedRealtimeItems(
      {
        readyState: 'open',
        send: () => {
          calls += 1;
          throw new Error('data channel write failed');
        },
      },
      ['participant-old'],
      participantItems,
      new Set(),
    );

    expect(applied).toBe(false);
    expect(calls).toBe(1);
    expect(participantItems).toEqual(new Set(['participant-old']));
  });

  it('restores item tracking and releases the revision after a correlated provider rejection', () => {
    const participantItems = new Set(['participant-old']);
    const aiItems = new Set(['ai-old']);
    const dispatches: Array<{
      eventId: string;
      itemId: string;
      wasParticipant: boolean;
      wasAi: boolean;
    }> = [];
    expect(
      deleteCompactedRealtimeItems(
        { readyState: 'open', send: () => undefined },
        ['participant-old', 'ai-old'],
        participantItems,
        aiItems,
        (dispatch) => dispatches.push(dispatch),
      ),
    ).toBe(true);
    const pendingDeletes = new Map(dispatches.map((dispatch) => [dispatch.eventId, dispatch]));

    const recovered = recoverRejectedRealtimeContextDelete({
      event: {
        type: 'error',
        error: { event_id: dispatches[0]?.eventId, message: 'Delete rejected' },
      },
      pendingDeletes,
      completedParticipantItems: participantItems,
      completedAiItems: aiItems,
      appliedRevision: 'revision-2',
    });

    expect(recovered).toEqual({ handled: true, appliedRevision: null });
    expect(participantItems).toEqual(new Set(['participant-old']));
    expect(aiItems.size).toBe(0);
    expect(pendingDeletes.size).toBe(1);
    expect(
      confirmRealtimeContextItemDeletion(
        { type: 'conversation.item.deleted', item_id: 'ai-old' },
        pendingDeletes,
      ),
    ).toBe(true);
    expect(pendingDeletes.size).toBe(0);
  });

  it('correlates the session acknowledgement and provider errors without exposing other errors', () => {
    expect(
      isRealtimeContextUpdateAcknowledgement(
        {
          type: 'session.updated',
          session: { instructions: 'Compacted instructions' },
        },
        'Compacted instructions',
      ),
    ).toBe(true);
    expect(
      isRealtimeContextUpdateAcknowledgement(
        {
          type: 'session.updated',
          session: { instructions: 'Different instructions' },
        },
        'Compacted instructions',
      ),
    ).toBe(false);
    expect(
      realtimeClientErrorEventId({
        type: 'error',
        error: { event_id: 'context-update-1', message: 'Rejected' },
      }),
    ).toBe('context-update-1');
    expect(realtimeClientErrorEventId({ type: 'error', error: { message: 'Other' } })).toBeNull();
  });

  it('does not retry deletion when the provider confirms the item is already absent', () => {
    const pendingDeletes = new Map([
      ['delete-1', { eventId: 'delete-1', itemId: 'old-item', wasParticipant: false, wasAi: true }],
    ]);
    const completedAiItems = new Set<string>();
    const input = {
      event: {
        type: 'error',
        error: { event_id: 'delete-1', code: 'item_delete_invalid_item_id' },
      },
      pendingDeletes,
      completedParticipantItems: new Set<string>(),
      completedAiItems,
      appliedRevision: 'revision-2',
    };

    expect(recoverRejectedRealtimeContextDelete(input)).toEqual({
      handled: true,
      appliedRevision: 'revision-2',
    });
    expect(pendingDeletes.size).toBe(0);
    expect(completedAiItems.size).toBe(0);
    expect(recoverRejectedRealtimeContextDelete(input).handled).toBe(false);
  });
});

describe('Realtime voice turn-intent parsing', () => {
  it('preserves a structured specific clarification without rewriting its text', () => {
    const spokenText = 'Welche konkreten Aufgaben uebernehmen Sie im digitalen Vertrieb selbst?';

    expect(
      parseTurnIntent(
        'call-specific-clarification',
        JSON.stringify({
          action: 'ask_clarification_question',
          questionId: 'question-role',
          spokenText,
          answerDisposition: 'partial',
          missingAspect: 'Aufgaben im digitalen Vertrieb',
          requestedEvidenceType: 'responsibility',
        }),
      ),
    ).toEqual({
      clientEventId: 'call-specific-clarification',
      action: 'ask_clarification_question',
      questionId: 'question-role',
      spokenText,
      answerDisposition: 'partial',
      missingAspect: 'Aufgaben im digitalen Vertrieb',
      requestedEvidenceType: 'responsibility',
    });
  });

  it('forwards generic metadata for server normalization but rejects malformed output', () => {
    const base = {
      action: 'ask_clarification_question',
      questionId: 'question-role',
      answerDisposition: 'partial',
      missingAspect: 'Aufgaben im digitalen Vertrieb',
      requestedEvidenceType: 'responsibility',
    } as const;

    const generic = parseTurnIntent(
      'call-generic-clarification',
      JSON.stringify({
        ...base,
        spokenText: 'Koennen Sie Ihre letzte Antwort bitte noch etwas genauer erlaeutern?',
      }),
    );
    expect(generic).toMatchObject({ action: 'ask_clarification_question' });
    expect(
      parseTurnIntent(
        'call-missing-metadata',
        JSON.stringify({
          action: 'ask_main_question',
          questionId: 'question-next',
          spokenText: 'Welche Rolle haben Sie?',
        }),
      ),
    ).toBeNull();
    expect(
      parseTurnIntent(
        'call-missing-question-id',
        JSON.stringify({
          action: 'ask_clarification_question',
          spokenText: 'Welche Aufgaben uebernehmen Sie selbst?',
          answerDisposition: 'partial',
          missingAspect: 'selbst uebernommene Aufgaben',
          requestedEvidenceType: 'responsibility',
        }),
      ),
    ).toBeNull();
    expect(
      parseTurnIntent(
        'call-two-questions',
        JSON.stringify({
          ...base,
          spokenText: 'Welche Aufgaben uebernehmen Sie? Und wer entscheidet?',
        }),
      ),
    ).toBeNull();
  });
});

describe('Realtime rate-limit recovery', () => {
  it('extracts the provider retry delay and preserves it for the app retry', () => {
    const delay = readRateLimitRetryDelayMs(
      'Rate limit reached for gpt-realtime-2.1. Please try again in 3.325s.',
    );

    expect(delay).toBe(3_325);
    expect(readVoiceRateLimitRetryDelay(createVoiceRateLimitError(delay ?? 0))).toBe(3_325);
  });

  it('uses a bounded default for rate-limit messages without a retry hint', () => {
    expect(readRateLimitRetryDelayMs('rate_limit_exceeded')).toBe(4_000);
    expect(readRateLimitRetryDelayMs('provider unavailable')).toBeNull();
    expect(readVoiceRateLimitRetryDelay(new Error('VOICE_RATE_LIMITED'))).toBe(4_000);
  });
});

describe('Realtime response budgets', () => {
  it('keeps the turn planner response bounded', () => {
    expect(createTurnPlanResponseConfig('request-1')).toMatchObject({
      output_modalities: ['text'],
      max_output_tokens: 512,
      tool_choice: 'required',
    });
  });
});

describe('Realtime voice timeout recovery', () => {
  it('reconnects even when a provider error has already settled the pending response', () => {
    const reconnect = vi.fn();
    let fallback: (() => void) | null = null;
    const recovery = createResponseTimeoutRecovery({
      responseId: 'timeout-response:request-1',
      schedule: (callback) => {
        fallback = callback;
        return vi.fn();
      },
      onReconnectRequired: reconnect,
    });

    expect(recovery.confirmPersistedInterruption('unrelated-response')).toBe(false);
    expect(fallback).not.toBeNull();
    (fallback as unknown as () => void)();
    expect(reconnect).toHaveBeenCalledOnce();
  });

  it('suppresses the reconnect only after the correlated interruption was persisted', () => {
    const reconnect = vi.fn();
    const cancelScheduled = vi.fn();
    let fallback: (() => void) | null = null;
    const recovery = createResponseTimeoutRecovery({
      responseId: 'timeout-response:request-2',
      schedule: (callback) => {
        fallback = callback;
        return cancelScheduled;
      },
      onReconnectRequired: reconnect,
    });

    expect(recovery.confirmPersistedInterruption('timeout-response:request-2')).toBe(true);
    expect(cancelScheduled).toHaveBeenCalledOnce();
    (fallback as unknown as () => void)();
    expect(reconnect).not.toHaveBeenCalled();
  });
});

describe('Realtime request fencing', () => {
  it('rejects requests from a previous connection or response generation', () => {
    expect(isRealtimeRequestCurrent(2, 2, 4, 4)).toBe(true);
    expect(isRealtimeRequestCurrent(1, 2, 4, 4)).toBe(false);
    expect(isRealtimeRequestCurrent(2, 2, 3, 4)).toBe(false);
  });
});

describe('Realtime voice provider metadata', () => {
  it('preserves session instructions and serializes repair metadata for turn planning', () => {
    expect(createTurnPlanResponseConfig('request-initial')).toEqual({
      output_modalities: ['text'],
      max_output_tokens: 512,
      tool_choice: 'required',
      metadata: {
        client_request_id: 'request-initial',
        request_kind: 'turn_plan',
      },
    });
    expect(createTurnPlanResponseConfig('request-repair', 1)).toEqual({
      output_modalities: ['text'],
      max_output_tokens: 512,
      tool_choice: 'required',
      metadata: {
        client_request_id: 'request-repair',
        request_kind: 'turn_plan',
        repair_attempt: '1',
      },
    });
  });
});
