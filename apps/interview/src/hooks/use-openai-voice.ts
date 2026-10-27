import { useCallback, useEffect, useRef, useState } from 'react';

import {
  mvpRealtimeTurnIntentRequestSchema,
  type MvpRealtimeContextUpdate,
  type MvpRealtimeTurnIntentRequest,
  type MvpRealtimeTurnPlan,
  type MvpRealtimeTurnRejection,
  type VoiceDiagnostic,
} from '@orgscience/contracts';

import { interviewApi } from '../api/interview-api.js';
import { clientVoiceDiagnostic, providerVoiceDiagnostic } from '../voice-diagnostics.js';

const DATA_CHANNEL_OPEN_TIMEOUT_MS = 15_000;
const RESPONSE_TIMEOUT_MS = 60_000;
const RESPONSE_TIMEOUT_RECOVERY_GRACE_MS = 1_500;
const TURN_PLAN_TIMEOUT_MS = 15_000;
const CONTEXT_UPDATE_ACK_TIMEOUT_MS = 3_000;
const MAXIMUM_TURN_PLAN_REPAIRS = 1;
const AUDIO_RESPONSE_MAX_OUTPUT_TOKENS = 512;
const TURN_PLAN_MAX_OUTPUT_TOKENS = 512;
const DEFAULT_RATE_LIMIT_RETRY_DELAY_MS = 4_000;
const MAX_RATE_LIMIT_RETRY_DELAY_MS = 15_000;
const MEDIA_CAPTURE_TIMEOUT_MS = 15_000;
const PEER_DISCONNECTED_GRACE_MS = 2_000;
const RECONNECT_STABLE_RESET_MS = 30_000;
const RECONNECT_DELAYS_MS = [250, 1_000, 3_000] as const;

export type OpenAiVoiceState =
  'idle' | 'connecting' | 'listening' | 'processing' | 'speaking' | 'failed';

export interface VoiceFinalTurn {
  readonly clientEventId: string;
  readonly text: string;
  readonly occurredAt: string;
}

export interface VoiceAiTranscriptDelta {
  readonly responseId: string | null;
  readonly itemId: string;
  readonly turnId: string | null;
  readonly delta: string;
  readonly text: string;
}

export interface VoiceAiTranscriptDone {
  readonly responseId: string | null;
  readonly itemId: string;
  readonly turnId: string | null;
  readonly text: string;
  readonly occurredAt: string;
  readonly deliveryId: string | null;
  readonly workflowRunId: string | null;
  readonly questionId: string | null;
  readonly turnType: VoicePlannedTurnType | null;
}

export interface VoiceAiTranscriptInterrupted {
  readonly responseId: string | null;
  readonly itemId: string;
  readonly turnId: string | null;
  readonly generatedText: string;
  readonly confirmedSpokenText: string;
  readonly occurredAt: string;
  readonly deliveryId: string | null;
  readonly workflowRunId: string | null;
  readonly questionId: string | null;
  readonly turnType: VoicePlannedTurnType | null;
}

export type VoicePlannedTurnType =
  | 'greeting'
  | 'main_question'
  | 'follow_up_question'
  | 'clarification_question'
  | 'transition'
  | 'closing';

export interface VoiceResponsePlanMetadata {
  readonly deliveryId?: string | null;
  readonly workflowRunId?: string | null;
  readonly questionId?: string | null;
  readonly turnType?: VoicePlannedTurnType | null;
}

export interface VoiceResponseRequest extends VoiceResponsePlanMetadata {
  readonly instructions?: string;
}

export interface OpenAiVoiceOptions {
  readonly onDiagnostic?: (diagnostic: VoiceDiagnostic) => void;
  readonly onFinalTurn: (turn: VoiceFinalTurn) => void | Promise<void>;
  readonly onTurnIntent?: (
    intent: MvpRealtimeTurnIntentRequest,
  ) =>
    | MvpRealtimeTurnPlan
    | MvpRealtimeTurnRejection
    | null
    | Promise<MvpRealtimeTurnPlan | MvpRealtimeTurnRejection | null>;
  readonly onTurnPlanFallback?: (
    clientEventId: string,
  ) => MvpRealtimeTurnPlan | null | Promise<MvpRealtimeTurnPlan | null>;
  readonly onPartialText?: (text: string | null) => void;
  readonly onAiTranscriptDelta?: (transcript: VoiceAiTranscriptDelta) => void;
  readonly onAiTranscriptDone?: (transcript: VoiceAiTranscriptDone) => void | Promise<void>;
  readonly onAiTranscriptInterrupted?: (
    transcript: VoiceAiTranscriptInterrupted,
  ) => void | Promise<void>;
  readonly onReconnectRequired?: (interviewId: string) => void | Promise<void>;
  readonly onError?: (error: Error) => void;
}

interface ResolvedVoiceResponsePlan {
  readonly deliveryId: string | null;
  readonly workflowRunId: string | null;
  readonly questionId: string | null;
  readonly turnType: VoicePlannedTurnType | null;
}

interface PendingResponse {
  readonly clientRequestId: string;
  readonly turnId: string | null;
  readonly resolve: (completed: boolean) => void;
  readonly reject: (error: Error) => void;
  readonly callbackTasks: Promise<void>[];
  readonly timeoutId: number;
  readonly plan: ResolvedVoiceResponsePlan;
  responseId: string | null;
  hasAudio: boolean;
  playbackStarted: boolean;
}

interface PendingTurnPlan {
  readonly clientRequestId: string;
  readonly resolve: (plan: MvpRealtimeTurnPlan | null) => void;
  readonly reject: (error: Error) => void;
  timeoutId: number;
  repairAttempts: number;
  responseId: string | null;
  handlingResult: boolean;
}

interface ResponseRequest {
  readonly instructions: string | null;
  readonly connectionEpoch: number;
  readonly generation: number;
  readonly plan: ResolvedVoiceResponsePlan;
}

interface ResponseTimeoutRecovery {
  readonly responseId: string;
  readonly confirmPersistedInterruption: (responseId: string) => boolean;
  readonly cancel: () => void;
}

interface RealtimeEventChannel {
  readonly readyState: string;
  send(data: string): void;
}

interface PendingContextUpdate {
  readonly clientEventId: string;
  readonly update: MvpRealtimeContextUpdate;
  readonly timeoutId: number;
}

export interface RealtimeContextDeleteDispatch {
  readonly eventId: string;
  readonly itemId: string;
  readonly wasParticipant: boolean;
  readonly wasAi: boolean;
}

export function createResponseTimeoutRecovery(input: {
  readonly responseId: string;
  readonly schedule: (callback: () => void) => () => void;
  readonly onReconnectRequired: () => void;
}): ResponseTimeoutRecovery {
  let active = true;
  const cancelScheduled = input.schedule(() => {
    if (!active) return;
    active = false;
    input.onReconnectRequired();
  });
  return {
    responseId: input.responseId,
    confirmPersistedInterruption: (responseId) => {
      if (!active || responseId !== input.responseId) return false;
      active = false;
      cancelScheduled();
      return true;
    },
    cancel: () => {
      if (!active) return;
      active = false;
      cancelScheduled();
    },
  };
}

export function isRealtimeRequestCurrent(
  requestConnectionEpoch: number,
  currentConnectionEpoch: number,
  requestGeneration: number,
  currentGeneration: number,
): boolean {
  return (
    requestConnectionEpoch === currentConnectionEpoch && requestGeneration === currentGeneration
  );
}

export function useOpenAiVoice(options: OpenAiVoiceOptions) {
  const [state, setState] = useState<OpenAiVoiceState>('idle');
  const [microphoneEnabled, setMicrophoneEnabledState] = useState(true);
  const stateRef = useRef<OpenAiVoiceState>('idle');
  const microphoneEnabledRef = useRef(true);
  const captureBlockedRef = useRef(true);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const interviewIdRef = useRef<string | null>(null);
  const connectionEpochRef = useRef(0);
  const appliedContextRevisionRef = useRef<string | null>(null);
  const pendingContextUpdateRef = useRef<PendingContextUpdate | null>(null);
  const pendingContextDeletesRef = useRef(new Map<string, RealtimeContextDeleteDispatch>());
  const contextMaintenanceEventIdsRef = useRef(new Set<string>());
  const participantPartialsRef = useRef(new Map<string, string>());
  const participantPartialRevisionsRef = useRef(new Map<string, number>());
  const completedParticipantItemsRef = useRef(new Set<string>());
  const aiPartialsRef = useRef(new Map<string, string>());
  const completedAiItemsRef = useRef(new Set<string>());
  const completedAiTranscriptsRef = useRef(new Map<string, VoiceAiTranscriptDone>());
  const aiResponseIdsRef = useRef(new Map<string, string | null>());
  const publishedAiItemsRef = useRef(new Set<string>());
  const responseStatusesRef = useRef(new Map<string, string>());
  const drainedResponseIdsRef = useRef(new Set<string>());
  const interruptedResponseIdsRef = useRef(new Set<string>());
  const responsePlansRef = useRef(new Map<string, ResolvedVoiceResponsePlan>());
  const responseTurnIdsRef = useRef(new Map<string, string | null>());
  const participantPersistenceQueueRef = useRef<Promise<void>>(Promise.resolve());
  const responseQueueRef = useRef<Promise<void>>(Promise.resolve());
  const responseGenerationRef = useRef(0);
  const turnPlanPromiseRef = useRef<Promise<MvpRealtimeTurnPlan | null> | null>(null);
  const conversationItemIdsRef = useRef(new Set<string>());
  const pendingResponseRef = useRef<PendingResponse | null>(null);
  const pendingTurnPlanRef = useRef<PendingTurnPlan | null>(null);
  const responseTimeoutRecoveryRef = useRef<ResponseTimeoutRecovery | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectStableTimerRef = useRef<number | null>(null);
  const peerDisconnectedTimerRef = useRef<number | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const updateState = useCallback((nextState: OpenAiVoiceState): void => {
    stateRef.current = nextState;
    setState(nextState);
  }, []);

  const syncMicrophoneTrack = useCallback((): void => {
    setAudioTracksEnabled(
      streamRef.current,
      microphoneEnabledRef.current && !captureBlockedRef.current,
    );
  }, []);

  const setCaptureBlocked = useCallback(
    (blocked: boolean): void => {
      captureBlockedRef.current = blocked;
      syncMicrophoneTrack();
    },
    [syncMicrophoneTrack],
  );

  const setMicrophoneEnabled = useCallback(
    (enabled: boolean): void => {
      microphoneEnabledRef.current = enabled;
      setMicrophoneEnabledState(enabled);
      syncMicrophoneTrack();
    },
    [syncMicrophoneTrack],
  );

  const reportFailure = useCallback(
    (error: unknown): void => {
      optionsRef.current.onDiagnostic?.(clientVoiceDiagnostic(error));
      captureBlockedRef.current = true;
      setAudioTracksEnabled(streamRef.current, false);
      fail(error, optionsRef.current.onError, updateState);
    },
    [updateState],
  );

  const settlePendingResponse = useCallback(
    (completed: boolean, error?: Error): void => {
      const pending = pendingResponseRef.current;
      if (pending === null) return;
      pendingResponseRef.current = null;
      window.clearTimeout(pending.timeoutId);
      const connectionEpoch = connectionEpochRef.current;
      const generation = responseGenerationRef.current;

      void Promise.all(pending.callbackTasks).then(
        () => {
          if (error === undefined) {
            pending.resolve(completed);
            if (
              completed &&
              peerRef.current !== null &&
              pending.plan.turnType !== 'closing' &&
              isRealtimeRequestCurrent(
                connectionEpoch,
                connectionEpochRef.current,
                generation,
                responseGenerationRef.current,
              )
            ) {
              setCaptureBlocked(false);
              updateState('listening');
            }
          } else {
            pending.reject(error);
          }
        },
        (callbackError: unknown) => {
          pending.reject(asError(callbackError));
        },
      );
    },
    [setCaptureBlocked, updateState],
  );

  const settlePendingTurnPlan = useCallback(
    (plan: MvpRealtimeTurnPlan | null, error?: Error): void => {
      const pending = pendingTurnPlanRef.current;
      if (pending === null) return;
      pendingTurnPlanRef.current = null;
      window.clearTimeout(pending.timeoutId);
      if (error === undefined) pending.resolve(plan);
      else pending.reject(error);
    },
    [],
  );

  const clearResponseTimeoutRecovery = useCallback((): void => {
    responseTimeoutRecoveryRef.current?.cancel();
    responseTimeoutRecoveryRef.current = null;
  }, []);

  const confirmPersistedTimeoutInterruption = useCallback((responseId: string): void => {
    const recovery = responseTimeoutRecoveryRef.current;
    if (recovery?.confirmPersistedInterruption(responseId) === true) {
      responseTimeoutRecoveryRef.current = null;
    }
  }, []);

  const restartPendingTurnPlanTimeout = useCallback((): void => {
    const pending = pendingTurnPlanRef.current;
    if (pending === null) return;
    window.clearTimeout(pending.timeoutId);
    pending.timeoutId = window.setTimeout(() => {
      if (pendingTurnPlanRef.current !== pending) return;
      const timeoutError = new Error(
        'Die nächste Interviewfrage konnte nicht rechtzeitig geplant werden.',
      );
      settlePendingTurnPlan(null, timeoutError);
      reportFailure(timeoutError);
    }, TURN_PLAN_TIMEOUT_MS);
  }, [reportFailure, settlePendingTurnPlan]);

  const releaseConnectionResources = useCallback((): void => {
    captureBlockedRef.current = true;
    const channel = dataChannelRef.current;
    const peer = peerRef.current;
    dataChannelRef.current = null;
    peerRef.current = null;
    channel?.close();
    if (peer !== null) {
      peer.ontrack = null;
      peer.close();
    }
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;

    const remoteAudio = remoteAudioRef.current;
    if (remoteAudio !== null) {
      remoteAudio.pause();
      remoteAudio.srcObject = null;
      remoteAudio.remove();
    }
    remoteAudioRef.current = null;
  }, []);

  const clearProviderEventState = useCallback((): void => {
    responseGenerationRef.current += 1;
    turnPlanPromiseRef.current = null;
    conversationItemIdsRef.current.clear();
    const pendingContextUpdate = pendingContextUpdateRef.current;
    if (pendingContextUpdate !== null) window.clearTimeout(pendingContextUpdate.timeoutId);
    pendingContextUpdateRef.current = null;
    appliedContextRevisionRef.current = null;
    pendingContextDeletesRef.current.clear();
    contextMaintenanceEventIdsRef.current.clear();
    participantPartialsRef.current.clear();
    participantPartialRevisionsRef.current.clear();
    completedParticipantItemsRef.current.clear();
    aiPartialsRef.current.clear();
    completedAiItemsRef.current.clear();
    completedAiTranscriptsRef.current.clear();
    aiResponseIdsRef.current.clear();
    publishedAiItemsRef.current.clear();
    responseStatusesRef.current.clear();
    drainedResponseIdsRef.current.clear();
    interruptedResponseIdsRef.current.clear();
    responsePlansRef.current.clear();
    responseTurnIdsRef.current.clear();
    responseQueueRef.current = Promise.resolve();
    optionsRef.current.onPartialText?.(null);
  }, []);

  const handleContextProtocolEvent = useCallback(
    (event: Record<string, unknown>, channel: RealtimeEventChannel): boolean => {
      const type = readString(event, 'type');
      if (type === 'error') {
        const clientEventId = realtimeClientErrorEventId(event);
        const pending = pendingContextUpdateRef.current;
        if (pending !== null && clientEventId === pending.clientEventId) {
          window.clearTimeout(pending.timeoutId);
          pendingContextUpdateRef.current = null;
          contextMaintenanceEventIdsRef.current.delete(clientEventId);
          return true;
        }
        const recovered = recoverRejectedRealtimeContextDelete({
          event,
          pendingDeletes: pendingContextDeletesRef.current,
          completedParticipantItems: completedParticipantItemsRef.current,
          completedAiItems: completedAiItemsRef.current,
          appliedRevision: appliedContextRevisionRef.current,
        });
        if (recovered.handled) {
          appliedContextRevisionRef.current = recovered.appliedRevision;
          return true;
        }
        return (
          clientEventId !== null && contextMaintenanceEventIdsRef.current.delete(clientEventId)
        );
      }

      if (confirmRealtimeContextItemDeletion(event, pendingContextDeletesRef.current)) {
        return true;
      }

      const pending = pendingContextUpdateRef.current;
      if (
        pending === null ||
        !isRealtimeContextUpdateAcknowledgement(event, pending.update.instructions)
      ) {
        return false;
      }
      window.clearTimeout(pending.timeoutId);
      pendingContextUpdateRef.current = null;
      contextMaintenanceEventIdsRef.current.delete(pending.clientEventId);
      const complete = deleteCompactedRealtimeItems(
        channel,
        pending.update.removeConversationItemIds.filter((id) =>
          conversationItemIdsRef.current.has(id),
        ),
        completedParticipantItemsRef.current,
        completedAiItemsRef.current,
        (dispatch) => pendingContextDeletesRef.current.set(dispatch.eventId, dispatch),
      );
      if (complete) appliedContextRevisionRef.current = pending.update.revision;
      return true;
    },
    [],
  );

  const haltAfterParticipantFailure = useCallback(
    (error: unknown): void => {
      connectionEpochRef.current += 1;
      clearResponseTimeoutRecovery();
      settlePendingResponse(false);
      settlePendingTurnPlan(null);
      releaseConnectionResources();
      clearProviderEventState();
      if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current);
      if (reconnectStableTimerRef.current !== null) {
        window.clearTimeout(reconnectStableTimerRef.current);
      }
      if (peerDisconnectedTimerRef.current !== null) {
        window.clearTimeout(peerDisconnectedTimerRef.current);
      }
      reconnectTimerRef.current = null;
      reconnectStableTimerRef.current = null;
      peerDisconnectedTimerRef.current = null;
      reconnectAttemptsRef.current = 0;
      interviewIdRef.current = null;
      reportFailure(error);
    },
    [
      clearProviderEventState,
      clearResponseTimeoutRecovery,
      releaseConnectionResources,
      reportFailure,
      settlePendingResponse,
      settlePendingTurnPlan,
    ],
  );

  const playRemoteAudio = useCallback((): void => {
    const audio = remoteAudioRef.current;
    if (audio === null) return;
    void audio.play().catch((error: unknown) => {
      reportFailure(
        new Error(
          `Die automatische OpenAI-Audiowiedergabe wurde blockiert: ${asError(error).message}`,
        ),
      );
    });
  }, [reportFailure]);

  const stopPlayback = useCallback((): void => {
    responseGenerationRef.current += 1;
    turnPlanPromiseRef.current = null;
    const channel = dataChannelRef.current;
    if (
      channel !== null &&
      (pendingResponseRef.current !== null ||
        pendingTurnPlanRef.current !== null ||
        stateRef.current === 'speaking')
    ) {
      sendRealtimeEvent(channel, { type: 'response.cancel' });
      sendRealtimeEvent(channel, { type: 'output_audio_buffer.clear' });
    }
    remoteAudioRef.current?.pause();
    settlePendingResponse(false);
    settlePendingTurnPlan(null);
    if (peerRef.current !== null) updateState('listening');
  }, [settlePendingResponse, settlePendingTurnPlan, updateState]);

  const disconnect = useCallback((): void => {
    connectionEpochRef.current += 1;
    clearResponseTimeoutRecovery();
    settlePendingResponse(false);
    settlePendingTurnPlan(null);
    releaseConnectionResources();
    if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current);
    if (reconnectStableTimerRef.current !== null) {
      window.clearTimeout(reconnectStableTimerRef.current);
    }
    if (peerDisconnectedTimerRef.current !== null) {
      window.clearTimeout(peerDisconnectedTimerRef.current);
    }
    reconnectTimerRef.current = null;
    reconnectStableTimerRef.current = null;
    peerDisconnectedTimerRef.current = null;
    reconnectAttemptsRef.current = 0;
    interviewIdRef.current = null;
    clearProviderEventState();
    updateState('idle');
  }, [
    clearProviderEventState,
    clearResponseTimeoutRecovery,
    releaseConnectionResources,
    settlePendingResponse,
    settlePendingTurnPlan,
    updateState,
  ]);

  const requestAuthoritativeReconnect = useCallback(
    (interviewId: string, error: Error): void => {
      if (interviewIdRef.current !== interviewId) return;

      connectionEpochRef.current += 1;
      clearResponseTimeoutRecovery();
      settlePendingResponse(false);
      settlePendingTurnPlan(null);
      releaseConnectionResources();
      clearProviderEventState();
      if (peerDisconnectedTimerRef.current !== null) {
        window.clearTimeout(peerDisconnectedTimerRef.current);
        peerDisconnectedTimerRef.current = null;
      }
      if (reconnectStableTimerRef.current !== null) {
        window.clearTimeout(reconnectStableTimerRef.current);
        reconnectStableTimerRef.current = null;
      }
      if (reconnectTimerRef.current !== null) return;

      const callback = optionsRef.current.onReconnectRequired;
      const attempt = reconnectAttemptsRef.current + 1;
      if (callback === undefined || attempt > RECONNECT_DELAYS_MS.length) {
        reportFailure(error);
        return;
      }

      reconnectAttemptsRef.current = attempt;
      updateState('connecting');
      reconnectTimerRef.current = window.setTimeout(
        () => {
          reconnectTimerRef.current = null;
          if (
            interviewIdRef.current !== interviewId ||
            peerRef.current !== null ||
            stateRef.current !== 'connecting'
          ) {
            return;
          }
          const reconnect = optionsRef.current.onReconnectRequired;
          if (reconnect === undefined) {
            reportFailure(error);
            return;
          }
          void Promise.resolve()
            .then(() => reconnect(interviewId))
            .catch((reconnectError: unknown) => reportFailure(reconnectError));
        },
        RECONNECT_DELAYS_MS[attempt - 1],
      );
    },
    [
      clearProviderEventState,
      clearResponseTimeoutRecovery,
      releaseConnectionResources,
      reportFailure,
      settlePendingResponse,
      settlePendingTurnPlan,
      updateState,
    ],
  );

  useEffect(() => disconnect, [disconnect]);

  const connect = useCallback(
    async (interviewId: string): Promise<void> => {
      const isReconnect =
        interviewIdRef.current === interviewId && reconnectAttemptsRef.current > 0;
      const reconnectAttempts = reconnectAttemptsRef.current;
      disconnect();
      if (isReconnect) reconnectAttemptsRef.current = reconnectAttempts;
      updateState('connecting');
      interviewIdRef.current = interviewId;
      const connectionEpoch = connectionEpochRef.current;

      try {
        const secret = await interviewApi.createVoiceSession(interviewId);
        if (connectionEpoch !== connectionEpochRef.current) return;

        const stream = await withTimeout(
          navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            video: false,
          }),
          MEDIA_CAPTURE_TIMEOUT_MS,
          'Das Mikrofon konnte nicht rechtzeitig geoeffnet werden. Bitte pruefen Sie die Browser-Berechtigung und versuchen Sie es erneut.',
        );
        if (connectionEpoch !== connectionEpochRef.current) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        streamRef.current = stream;
        setCaptureBlocked(true);

        const peer = new RTCPeerConnection();
        peerRef.current = peer;
        const remoteAudio = new Audio();
        remoteAudio.autoplay = true;
        remoteAudio.setAttribute('playsinline', '');
        remoteAudio.setAttribute('aria-hidden', 'true');
        remoteAudio.style.display = 'none';
        document.body.append(remoteAudio);
        remoteAudioRef.current = remoteAudio;

        peer.ontrack = (event): void => {
          if (peerRef.current !== peer) return;
          remoteAudio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
          playRemoteAudio();
        };
        peer.addEventListener('connectionstatechange', () => {
          if (peerRef.current !== peer) return;
          if (peer.connectionState === 'connected') {
            if (peerDisconnectedTimerRef.current !== null) {
              window.clearTimeout(peerDisconnectedTimerRef.current);
              peerDisconnectedTimerRef.current = null;
            }
            return;
          }
          if (peer.connectionState === 'disconnected') {
            if (peerDisconnectedTimerRef.current !== null) return;
            peerDisconnectedTimerRef.current = window.setTimeout(() => {
              peerDisconnectedTimerRef.current = null;
              if (
                peerRef.current === peer &&
                interviewIdRef.current === interviewId &&
                peer.connectionState === 'disconnected'
              ) {
                requestAuthoritativeReconnect(
                  interviewId,
                  new Error('Die OpenAI-WebRTC-Verbindung wurde unterbrochen.'),
                );
              }
            }, PEER_DISCONNECTED_GRACE_MS);
            return;
          }
          if (peer.connectionState === 'failed' || peer.connectionState === 'closed') {
            requestAuthoritativeReconnect(
              interviewId,
              new Error('Die OpenAI-WebRTC-Verbindung ist fehlgeschlagen.'),
            );
          }
        });

        const channel = peer.createDataChannel('oai-events');
        dataChannelRef.current = channel;
        channel.addEventListener('message', (messageEvent) => {
          if (dataChannelRef.current !== channel) return;
          const event = parseRealtimeEvent(messageEvent.data);
          if (event === null) return;
          trackRealtimeConversationItem(event, conversationItemIdsRef.current);
          const diagnostic = providerVoiceDiagnostic(event);
          if (diagnostic !== null) optionsRef.current.onDiagnostic?.(diagnostic);
          if (handleContextProtocolEvent(event, channel)) return;

          handleRealtimeEvent({
            event,
            channel,
            participantPartials: participantPartialsRef.current,
            participantPartialRevisions: participantPartialRevisionsRef.current,
            completedParticipantItems: completedParticipantItemsRef.current,
            aiPartials: aiPartialsRef.current,
            completedAiItems: completedAiItemsRef.current,
            completedAiTranscripts: completedAiTranscriptsRef.current,
            aiResponseIds: aiResponseIdsRef.current,
            publishedAiItems: publishedAiItemsRef.current,
            responseStatuses: responseStatusesRef.current,
            drainedResponseIds: drainedResponseIdsRef.current,
            interruptedResponseIds: interruptedResponseIdsRef.current,
            responsePlans: responsePlansRef.current,
            responseTurnIds: responseTurnIdsRef.current,
            pendingResponse: pendingResponseRef.current,
            pendingTurnPlan: pendingTurnPlanRef.current,
            callbacks: optionsRef.current,
            updateState,
            reportFailure,
            settlePendingResponse,
            settlePendingTurnPlan,
            restartPendingTurnPlanTimeout,
            confirmPersistedTimeoutInterruption,
            playRemoteAudio,
            setCaptureBlocked,
            isTurnPlanRequestActive: (clientRequestId) =>
              dataChannelRef.current === channel &&
              pendingTurnPlanRef.current?.clientRequestId === clientRequestId,
            enqueueParticipantPartial: (partial) => {
              const activeInterviewId = interviewIdRef.current;
              if (activeInterviewId === null) return;
              participantPersistenceQueueRef.current = participantPersistenceQueueRef.current
                .then(() => interviewApi.updatePartialTranscript(activeInterviewId, partial))
                .then(
                  () => undefined,
                  () => undefined,
                );
            },
            enqueueFinalParticipantTurn: (turn) => {
              const participantEpoch = connectionEpochRef.current;
              participantPersistenceQueueRef.current = participantPersistenceQueueRef.current
                .then(() => optionsRef.current.onFinalTurn(turn))
                .catch((error: unknown) => {
                  if (participantEpoch === connectionEpochRef.current) {
                    haltAfterParticipantFailure(error);
                  }
                });
            },
          });
        });
        channel.addEventListener('open', () => {
          if (dataChannelRef.current !== channel) return;
          setCaptureBlocked(false);
          updateState('listening');
          if (reconnectStableTimerRef.current !== null) {
            window.clearTimeout(reconnectStableTimerRef.current);
          }
          reconnectStableTimerRef.current = window.setTimeout(() => {
            reconnectStableTimerRef.current = null;
            if (
              dataChannelRef.current === channel &&
              interviewIdRef.current === interviewId &&
              channel.readyState === 'open'
            ) {
              reconnectAttemptsRef.current = 0;
            }
          }, RECONNECT_STABLE_RESET_MS);
        });
        channel.addEventListener('error', () => {
          if (dataChannelRef.current === channel) {
            requestAuthoritativeReconnect(
              interviewId,
              new Error('Die OpenAI-Realtime-Datenverbindung ist fehlgeschlagen.'),
            );
          }
        });
        channel.addEventListener('close', () => {
          if (dataChannelRef.current === channel) {
            requestAuthoritativeReconnect(
              interviewId,
              new Error('Die OpenAI-Realtime-Datenverbindung wurde geschlossen.'),
            );
          }
        });

        const audioTrack = stream.getAudioTracks()[0];
        if (audioTrack === undefined) throw new Error('Kein Mikrofon-Audiotrack verfügbar.');
        peer.addTrack(audioTrack, stream);

        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        if (offer.sdp === undefined) {
          throw new Error('OpenAI Realtime konnte kein WebRTC-Angebot erzeugen.');
        }
        const sdpResponse = await fetch('https://api.openai.com/v1/realtime/calls', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${secret.clientSecret}`,
            'Content-Type': 'application/sdp',
          },
          body: offer.sdp,
        });
        if (!sdpResponse.ok) {
          throw new Error(
            sdpResponse.status === 429 ? 'VOICE_RATE_LIMITED' : 'VOICE_CONNECT_FAILED',
          );
        }
        await peer.setRemoteDescription({ type: 'answer', sdp: await sdpResponse.text() });
        await waitForDataChannelOpen(channel);
      } catch (error: unknown) {
        if (connectionEpoch !== connectionEpochRef.current) return;
        if (isReconnect && interviewIdRef.current === interviewId) {
          requestAuthoritativeReconnect(interviewId, asError(error));
          return;
        }
        disconnect();
        reportFailure(error);
        throw error;
      }
    },
    [
      disconnect,
      confirmPersistedTimeoutInterruption,
      handleContextProtocolEvent,
      playRemoteAudio,
      reportFailure,
      requestAuthoritativeReconnect,
      restartPendingTurnPlanTimeout,
      setCaptureBlocked,
      haltAfterParticipantFailure,
      settlePendingResponse,
      settlePendingTurnPlan,
      updateState,
    ],
  );

  const enqueueResponse = useCallback(
    (request: ResponseRequest): Promise<boolean> => {
      const operation = responseQueueRef.current.then(
        () =>
          new Promise<boolean>((resolve, reject) => {
            if (
              !isRealtimeRequestCurrent(
                request.connectionEpoch,
                connectionEpochRef.current,
                request.generation,
                responseGenerationRef.current,
              )
            ) {
              resolve(false);
              return;
            }
            const channel = dataChannelRef.current;
            if (channel === null || channel.readyState !== 'open') {
              reject(new Error('OpenAI Voice ist nicht verbunden.'));
              return;
            }

            const clientRequestId = crypto.randomUUID();
            const timeoutId = window.setTimeout(() => {
              const pending = pendingResponseRef.current;
              if (pending?.clientRequestId !== clientRequestId) return;
              const timeoutError = new Error(
                'Die OpenAI-Sprachantwort hat das Zeitlimit überschritten.',
              );
              const activeInterviewId = interviewIdRef.current;
              if (activeInterviewId === null) {
                settlePendingResponse(false, timeoutError);
                reportFailure(timeoutError);
                return;
              }
              const providerResponseId = pending.responseId;
              const recoveryResponseId =
                providerResponseId ?? `timeout-response:${clientRequestId}`;
              if (providerResponseId === null) {
                pending.responseId = recoveryResponseId;
                responsePlansRef.current.set(recoveryResponseId, pending.plan);
                responseTurnIdsRef.current.set(recoveryResponseId, pending.turnId);
              }
              const responseCancelled = sendRealtimeEvent(channel, {
                type: 'response.cancel',
                event_id: realtimeEventId(),
                ...(providerResponseId === null ? {} : { response_id: providerResponseId }),
              });
              const audioCleared = sendRealtimeEvent(channel, {
                type: 'output_audio_buffer.clear',
                event_id: realtimeEventId(),
              });
              if (!responseCancelled || !audioCleared) {
                requestAuthoritativeReconnect(activeInterviewId, timeoutError);
                return;
              }
              clearResponseTimeoutRecovery();
              responseTimeoutRecoveryRef.current = createResponseTimeoutRecovery({
                responseId: recoveryResponseId,
                schedule: (callback) => {
                  const recoveryTimerId = window.setTimeout(
                    callback,
                    RESPONSE_TIMEOUT_RECOVERY_GRACE_MS,
                  );
                  return () => window.clearTimeout(recoveryTimerId);
                },
                onReconnectRequired: () => {
                  if (responseTimeoutRecoveryRef.current?.responseId !== recoveryResponseId) return;
                  responseTimeoutRecoveryRef.current = null;
                  requestAuthoritativeReconnect(activeInterviewId, timeoutError);
                },
              });
            }, RESPONSE_TIMEOUT_MS);
            pendingResponseRef.current = {
              clientRequestId,
              turnId: null,
              resolve,
              reject,
              callbackTasks: [],
              timeoutId,
              plan: request.plan,
              responseId: null,
              hasAudio: false,
              playbackStarted: false,
            };
            setCaptureBlocked(true);

            const responseCreated = sendRealtimeEvent(channel, {
              type: 'response.create',
              event_id: realtimeEventId(),
              response: createSpeechResponseConfig(
                clientRequestId,
                request.instructions,
                request.plan,
              ),
            });
            if (!responseCreated) {
              settlePendingResponse(
                false,
                new Error('Die AI-Sprachantwort konnte nicht gestartet werden.'),
              );
              return;
            }
            updateState('processing');
          }),
      );
      responseQueueRef.current = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    },
    [
      clearResponseTimeoutRecovery,
      reportFailure,
      requestAuthoritativeReconnect,
      setCaptureBlocked,
      settlePendingResponse,
      updateState,
    ],
  );

  const requestResponse = useCallback(
    (
      request?: string | VoiceResponseRequest,
      planMetadata?: VoiceResponsePlanMetadata,
    ): Promise<boolean> => {
      const normalized = normalizeResponseRequest(request, planMetadata);
      return enqueueResponse({
        ...normalized,
        connectionEpoch: connectionEpochRef.current,
        generation: responseGenerationRef.current,
      });
    },
    [enqueueResponse],
  );

  const requestTurnPlan = useCallback((): Promise<MvpRealtimeTurnPlan | null> => {
    if (turnPlanPromiseRef.current !== null) return turnPlanPromiseRef.current;
    const connectionEpoch = connectionEpochRef.current;
    const generation = responseGenerationRef.current;
    const operation = responseQueueRef.current.then(
      () =>
        new Promise<MvpRealtimeTurnPlan | null>((resolve, reject) => {
          if (
            !isRealtimeRequestCurrent(
              connectionEpoch,
              connectionEpochRef.current,
              generation,
              responseGenerationRef.current,
            )
          ) {
            resolve(null);
            return;
          }
          const channel = dataChannelRef.current;
          if (channel === null || channel.readyState !== 'open') {
            reject(new Error('OpenAI Voice ist nicht verbunden.'));
            return;
          }
          if (optionsRef.current.onTurnIntent === undefined) {
            reject(new Error('Die Realtime-Turnplanung ist nicht konfiguriert.'));
            return;
          }

          const clientRequestId = crypto.randomUUID();
          pendingTurnPlanRef.current = {
            clientRequestId,
            resolve,
            reject,
            timeoutId: 0,
            repairAttempts: 0,
            responseId: null,
            handlingResult: false,
          };
          restartPendingTurnPlanTimeout();
          setCaptureBlocked(true);

          const responseCreated = sendRealtimeEvent(channel, {
            type: 'response.create',
            event_id: realtimeEventId(),
            response: createTurnPlanResponseConfig(clientRequestId),
          });
          if (!responseCreated) {
            settlePendingTurnPlan(
              null,
              new Error('Die nächste Interviewfrage konnte nicht angefordert werden.'),
            );
            return;
          }
          updateState('processing');
        }),
    );
    responseQueueRef.current = operation.then(
      () => undefined,
      () => undefined,
    );
    turnPlanPromiseRef.current = operation;
    const release = (): void => {
      if (turnPlanPromiseRef.current === operation) turnPlanPromiseRef.current = null;
    };
    void operation.then(release, release);
    return operation;
  }, [restartPendingTurnPlanTimeout, setCaptureBlocked, settlePendingTurnPlan, updateState]);

  const applyContextUpdate = useCallback((update: MvpRealtimeContextUpdate): boolean => {
    if (appliedContextRevisionRef.current === update.revision) return true;
    const pending = pendingContextUpdateRef.current;
    if (pending?.update.revision === update.revision) return true;
    if (pending !== null) return false;
    const channel = dataChannelRef.current;
    if (channel === null || channel.readyState !== 'open') return false;
    const clientEventId = realtimeEventId();
    if (!sendRealtimeContextUpdateToChannel(channel, update, clientEventId)) return false;
    contextMaintenanceEventIdsRef.current.add(clientEventId);
    const timeoutId = window.setTimeout(() => {
      if (pendingContextUpdateRef.current?.clientEventId === clientEventId) {
        pendingContextUpdateRef.current = null;
      }
    }, CONTEXT_UPDATE_ACK_TIMEOUT_MS);
    pendingContextUpdateRef.current = { clientEventId, update, timeoutId };
    return true;
  }, []);

  return {
    state,
    microphoneEnabled,
    connect,
    disconnect,
    requestResponse,
    requestTurnPlan,
    applyContextUpdate,
    setMicrophoneEnabled,
    stopPlayback,
  } as const;
}

export interface RealtimeEventContext {
  readonly event: Record<string, unknown>;
  readonly channel: RealtimeEventChannel;
  readonly participantPartials: Map<string, string>;
  readonly participantPartialRevisions: Map<string, number>;
  readonly completedParticipantItems: Set<string>;
  readonly aiPartials: Map<string, string>;
  readonly completedAiItems: Set<string>;
  readonly completedAiTranscripts: Map<string, VoiceAiTranscriptDone>;
  readonly aiResponseIds: Map<string, string | null>;
  readonly publishedAiItems: Set<string>;
  readonly responseStatuses: Map<string, string>;
  readonly drainedResponseIds: Set<string>;
  readonly interruptedResponseIds: Set<string>;
  readonly responsePlans: Map<string, ResolvedVoiceResponsePlan>;
  readonly responseTurnIds: Map<string, string | null>;
  readonly pendingResponse: PendingResponse | null;
  readonly pendingTurnPlan: PendingTurnPlan | null;
  readonly callbacks: OpenAiVoiceOptions;
  readonly updateState: (state: OpenAiVoiceState) => void;
  readonly reportFailure: (error: unknown) => void;
  readonly settlePendingResponse: (completed: boolean, error?: Error) => void;
  readonly settlePendingTurnPlan: (plan: MvpRealtimeTurnPlan | null, error?: Error) => void;
  readonly restartPendingTurnPlanTimeout: () => void;
  readonly confirmPersistedTimeoutInterruption: (responseId: string) => void;
  readonly playRemoteAudio: () => void;
  readonly setCaptureBlocked: (blocked: boolean) => void;
  readonly isTurnPlanRequestActive: (clientRequestId: string) => boolean;
  readonly enqueueParticipantPartial: (partial: {
    readonly text: string | null;
    readonly itemId: string;
    readonly providerEventId: string;
    readonly revision: number;
  }) => void;
  readonly enqueueFinalParticipantTurn: (turn: VoiceFinalTurn) => void;
}

export function handleRealtimeEvent(context: RealtimeEventContext): void {
  const { event } = context;
  const type = readString(event, 'type');
  if (type === null) return;

  if (type === 'conversation.item.input_audio_transcription.failed') {
    handleParticipantTranscriptFailure(context);
    return;
  }

  if (type === 'error') {
    const message = readProviderError(event);
    const retryDelayMs = readRateLimitRetryDelayMs(message);
    const error =
      retryDelayMs === null ? new Error(message) : createVoiceRateLimitError(retryDelayMs);
    context.settlePendingResponse(false, error);
    context.settlePendingTurnPlan(null, error);
    if (retryDelayMs === null) context.reportFailure(error);
    return;
  }

  if (
    (type.startsWith('response.') || type.startsWith('output_audio_buffer.')) &&
    !ownsResponseEvent(context)
  )
    return;

  switch (type) {
    case 'input_audio_buffer.speech_started':
      context.updateState('listening');
      return;
    case 'input_audio_buffer.speech_stopped':
      context.setCaptureBlocked(true);
      context.updateState('processing');
      return;
    case 'conversation.item.input_audio_transcription.delta':
      handleParticipantTranscriptDelta(context);
      return;
    case 'conversation.item.input_audio_transcription.completed':
      handleParticipantTranscriptDone(context);
      return;
    case 'response.created':
      handleResponseCreated(context);
      return;
    case 'response.output_audio_transcript.delta':
    case 'response.audio_transcript.delta':
      handleAiTranscriptDelta(context);
      return;
    case 'response.output_audio_transcript.done':
    case 'response.audio_transcript.done':
      handleAiTranscriptDone(context);
      return;
    case 'response.output_audio.delta':
    case 'response.output_audio.done': {
      const pending = pendingResponseFor(context, readString(event, 'response_id'));
      if (pending !== null) {
        pending.hasAudio = true;
      }
      context.updateState('speaking');
      return;
    }
    case 'output_audio_buffer.started':
      {
        const pending = pendingResponseFor(context, readString(event, 'response_id'));
        if (pending !== null) {
          pending.hasAudio = true;
          pending.playbackStarted = true;
        }
      }
      context.playRemoteAudio();
      context.updateState('speaking');
      return;
    case 'output_audio_buffer.stopped':
      handleOutputAudioStopped(context);
      return;
    case 'output_audio_buffer.cleared':
      handleOutputAudioCleared(context);
      return;
    case 'response.done':
      handleResponseDone(context);
      return;
    default:
      return;
  }
}

function handleParticipantTranscriptDelta(context: RealtimeEventContext): void {
  const itemId = readString(context.event, 'item_id');
  if (itemId === null || context.completedParticipantItems.has(itemId)) return;
  const delta = readString(context.event, 'delta') ?? '';
  const text = `${context.participantPartials.get(itemId) ?? ''}${delta}`;
  context.participantPartials.set(itemId, text);
  if (text.trim().length > 0) publishParticipantPartial(context, itemId, text);
}

function handleParticipantTranscriptDone(context: RealtimeEventContext): void {
  const itemId = readString(context.event, 'item_id');
  if (itemId === null || context.completedParticipantItems.has(itemId)) return;
  const transcript =
    readString(context.event, 'transcript') ?? context.participantPartials.get(itemId) ?? '';
  context.completedParticipantItems.add(itemId);
  context.participantPartials.delete(itemId);
  context.participantPartialRevisions.delete(itemId);
  context.callbacks.onPartialText?.(null);
  if (transcript.trim().length === 0) {
    context.setCaptureBlocked(false);
    context.updateState('listening');
    return;
  }
  context.setCaptureBlocked(true);
  context.updateState('processing');
  context.enqueueFinalParticipantTurn({
    clientEventId: itemId,
    text: transcript,
    occurredAt: new Date().toISOString(),
  });
}

function handleParticipantTranscriptFailure(context: RealtimeEventContext): void {
  const itemId = readString(context.event, 'item_id');
  if (itemId === null) context.participantPartials.clear();
  else {
    context.participantPartials.delete(itemId);
    context.completedParticipantItems.add(itemId);
  }
  context.callbacks.onPartialText?.(null);
  context.setCaptureBlocked(false);
  context.updateState('listening');
  context.callbacks.onError?.(new Error(readProviderError(context.event)));
}

function publishParticipantPartial(
  context: RealtimeEventContext,
  itemId: string,
  text: string,
): void {
  const revision = (context.participantPartialRevisions.get(itemId) ?? 0) + 1;
  context.participantPartialRevisions.set(itemId, revision);
  context.callbacks.onPartialText?.(text);
  context.enqueueParticipantPartial({
    text,
    itemId,
    providerEventId: `${itemId}:partial:${revision}`,
    revision,
  });
}

function handleResponseCreated(context: RealtimeEventContext): void {
  const response = readRecord(context.event, 'response');
  if (response === null) return;
  const responseId = readString(response, 'id');
  if (responseId === null) return;
  const metadata = readRecord(response, 'metadata');
  const turnPlan = context.pendingTurnPlan;
  if (turnPlan !== null) {
    const requestId = metadata === null ? null : readString(metadata, 'client_request_id');
    if (requestId === turnPlan.clientRequestId) {
      turnPlan.responseId = responseId;
      context.updateState('processing');
      return;
    }
  }
  const metadataTurnId = metadata === null ? null : readString(metadata, 'turn_id');
  context.responseTurnIds.set(responseId, metadataTurnId);
  context.responsePlans.set(responseId, readVoiceResponsePlan(metadata));

  const pending = context.pendingResponse;
  if (pending !== null) {
    const requestId = metadata === null ? null : readString(metadata, 'client_request_id');
    if (requestId === pending.clientRequestId) {
      pending.responseId = responseId;
      context.responseTurnIds.set(responseId, pending.turnId);
      context.responsePlans.set(responseId, pending.plan);
    }
  }
  context.updateState('processing');
}

function handleAiTranscriptDelta(context: RealtimeEventContext): void {
  const itemId = readString(context.event, 'item_id');
  if (itemId === null || context.completedAiItems.has(itemId)) return;
  const responseId = readString(context.event, 'response_id');
  context.aiResponseIds.set(itemId, responseId);
  const delta = readString(context.event, 'delta') ?? '';
  const text = `${context.aiPartials.get(itemId) ?? ''}${delta}`;
  context.aiPartials.set(itemId, text);
  const pending = pendingResponseFor(context, responseId);
  if (pending !== null) pending.hasAudio = true;
  if (responseId === null || !context.drainedResponseIds.has(responseId)) {
    context.updateState('speaking');
  }
  context.callbacks.onAiTranscriptDelta?.({
    responseId,
    itemId,
    turnId: resolveTurnId(context, responseId),
    delta,
    text,
  });
}

function handleAiTranscriptDone(context: RealtimeEventContext): void {
  const itemId = readString(context.event, 'item_id');
  if (itemId === null || context.completedAiItems.has(itemId)) return;
  const responseId = readString(context.event, 'response_id');
  context.aiResponseIds.set(itemId, responseId);
  const transcript =
    readString(context.event, 'transcript') ?? context.aiPartials.get(itemId) ?? '';
  context.completedAiItems.add(itemId);
  context.aiPartials.delete(itemId);
  const pending = pendingResponseFor(context, responseId);
  if (pending !== null) pending.hasAudio = true;
  if (responseId === null || !context.drainedResponseIds.has(responseId)) {
    context.updateState('speaking');
  }

  context.completedAiTranscripts.set(itemId, {
    responseId,
    itemId,
    turnId: resolveTurnId(context, responseId),
    text: transcript,
    occurredAt: new Date().toISOString(),
    ...resolveVoiceResponsePlan(context, responseId),
  });
}

function handleOutputAudioStopped(context: RealtimeEventContext): void {
  context.setCaptureBlocked(true);
  context.updateState('processing');
  const responseId =
    readString(context.event, 'response_id') ?? context.pendingResponse?.responseId ?? null;
  if (responseId !== null) {
    context.drainedResponseIds.add(responseId);
    if (
      context.responseStatuses.get(responseId) === 'completed' &&
      !context.interruptedResponseIds.has(responseId)
    ) {
      publishCompletedAiTranscripts(context, responseId);
      context.settlePendingResponse(true);
    }
  }
}

function handleOutputAudioCleared(context: RealtimeEventContext): void {
  const responseId =
    readString(context.event, 'response_id') ?? context.pendingResponse?.responseId ?? null;
  if (responseId !== null) {
    context.interruptedResponseIds.add(responseId);
    publishInterruptedAiTranscripts(context, responseId);
  }
  context.settlePendingResponse(false);
  context.setCaptureBlocked(false);
  context.updateState('listening');
}

function handleResponseDone(context: RealtimeEventContext): void {
  const response = readRecord(context.event, 'response');
  if (response === null) return;

  const responseId = readString(response, 'id');
  const status = readString(response, 'status');
  const metadata = readRecord(response, 'metadata');
  const clientRequestId = metadata === null ? null : readString(metadata, 'client_request_id');
  if (isPendingTurnPlanResponse(context, response, responseId)) {
    handleTurnPlanResponse(context, response, status);
    return;
  }
  const pendingForResponse = context.pendingResponse;
  const pendingMatchesResponse =
    pendingForResponse !== null &&
    (pendingForResponse.responseId === null
      ? clientRequestId === pendingForResponse.clientRequestId
      : pendingForResponse.responseId === responseId);
  if (pendingMatchesResponse && (status === 'failed' || status === 'incomplete')) {
    const retryDelayMs = readRateLimitRetryDelayMs(readResponseFailure(response));
    if (retryDelayMs !== null) {
      context.settlePendingResponse(false, createVoiceRateLimitError(retryDelayMs));
      return;
    }
  }
  if (responseId !== null && status !== null) {
    if (
      pendingForResponse !== null &&
      pendingForResponse.responseId === null &&
      clientRequestId === pendingForResponse.clientRequestId
    ) {
      pendingForResponse.responseId = responseId;
      context.responsePlans.set(responseId, pendingForResponse.plan);
    }
    if (!context.responsePlans.has(responseId)) {
      const pending = context.pendingResponse;
      const plan =
        pending !== null &&
        (pending.responseId === responseId || clientRequestId === pending.clientRequestId)
          ? pending.plan
          : readVoiceResponsePlan(metadata);
      context.responsePlans.set(responseId, plan);
    }
    context.responseStatuses.set(responseId, status);
    captureResponseOutputTranscripts(context, response, responseId);
    if (status === 'completed') {
      if (context.interruptedResponseIds.has(responseId)) {
        publishInterruptedAiTranscripts(context, responseId);
      } else if (context.drainedResponseIds.has(responseId)) {
        publishCompletedAiTranscripts(context, responseId);
        context.settlePendingResponse(true);
      }
    } else if (status === 'cancelled' || status === 'failed' || status === 'incomplete') {
      context.interruptedResponseIds.add(responseId);
      publishInterruptedAiTranscripts(context, responseId);
    }
  }
  const pending = context.pendingResponse;
  if (
    pending === null ||
    (pending.responseId === null
      ? clientRequestId !== pending.clientRequestId
      : pending.responseId !== responseId)
  )
    return;

  if (status === 'failed' || status === 'incomplete') {
    const error = new Error(readResponseFailure(response));
    context.settlePendingResponse(false, error);
    context.reportFailure(error);
    return;
  }
  if (status === 'cancelled') {
    context.settlePendingResponse(false);
    context.setCaptureBlocked(false);
    context.updateState('listening');
    return;
  }
  if (
    status === 'completed' &&
    (responseId === null ||
      context.drainedResponseIds.has(responseId) ||
      (!pending.hasAudio && !pending.playbackStarted))
  ) {
    context.settlePendingResponse(true);
  }
}

function isPendingTurnPlanResponse(
  context: RealtimeEventContext,
  response: Record<string, unknown>,
  responseId: string | null,
): boolean {
  const pending = context.pendingTurnPlan;
  if (pending === null) return false;
  if (pending.responseId !== null) return pending.responseId === responseId;
  const metadata = readRecord(response, 'metadata');
  const requestId = metadata === null ? null : readString(metadata, 'client_request_id');
  const repairAttempt = metadata === null ? null : readString(metadata, 'repair_attempt');
  return (
    requestId === pending.clientRequestId &&
    (repairAttempt ?? '0') === String(pending.repairAttempts)
  );
}

function handleTurnPlanResponse(
  context: RealtimeEventContext,
  response: Record<string, unknown>,
  status: string | null,
): void {
  if (status === 'failed' || status === 'incomplete') {
    const failure = readResponseFailure(response);
    const retryDelayMs = readRateLimitRetryDelayMs(failure);
    const error =
      retryDelayMs === null ? new Error(failure) : createVoiceRateLimitError(retryDelayMs);
    context.settlePendingTurnPlan(null, error);
    if (retryDelayMs === null) context.reportFailure(error);
    return;
  }
  if (status === 'cancelled') {
    context.settlePendingTurnPlan(null);
    context.setCaptureBlocked(false);
    context.updateState('listening');
    return;
  }
  if (status !== 'completed') return;
  const clientRequestId = context.pendingTurnPlan?.clientRequestId;
  if (clientRequestId === undefined) return;
  if (context.pendingTurnPlan?.handlingResult === true) return;

  const functionCall = readRecordArray(response, 'output').find(
    (output) =>
      readString(output, 'type') === 'function_call' &&
      readString(output, 'name') === 'plan_interview_turn',
  );
  if (functionCall === undefined) {
    if (requestTurnPlanRepair(context, null, 'The response did not call plan_interview_turn.')) {
      return;
    }
    if (requestTurnPlanFallback(context, clientRequestId, null)) return;
    const error = new Error('OpenAI hat keinen gültigen nächsten Interviewturn geplant.');
    context.settlePendingTurnPlan(null, error);
    context.reportFailure(error);
    return;
  }

  const callId = readString(functionCall, 'call_id');
  const serializedArguments = readString(functionCall, 'arguments');
  const intent = parseTurnIntent(callId, serializedArguments);
  const callback = context.callbacks.onTurnIntent;
  if (callback === undefined) {
    const error = new Error('Die Realtime-Turnplanung ist nicht konfiguriert.');
    context.settlePendingTurnPlan(null, error);
    context.reportFailure(error);
    return;
  }
  if (callId === null || intent === null) {
    if (
      requestTurnPlanRepair(
        context,
        callId,
        'The tool arguments did not satisfy the required interview-turn schema.',
      )
    ) {
      return;
    }
    if (requestTurnPlanFallback(context, clientRequestId, callId)) return;
    const error = new Error('Der geplante Interviewturn besitzt ungültige Funktionsdaten.');
    context.settlePendingTurnPlan(null, error);
    context.reportFailure(error);
    return;
  }

  if (context.pendingTurnPlan !== null) context.pendingTurnPlan.handlingResult = true;
  void Promise.resolve()
    .then(() => {
      if (!context.isTurnPlanRequestActive(clientRequestId)) return undefined;
      return callback({ ...intent, repairAttempt: context.pendingTurnPlan?.repairAttempts ?? 0 });
    })
    .then((plan) => {
      if (plan === undefined || !context.isTurnPlanRequestActive(clientRequestId)) return;
      if (plan !== null && 'reason' in plan) {
        if (requestTurnPlanRepair(context, callId, plan.reason)) return;
        if (requestTurnPlanFallback(context, clientRequestId, callId)) return;
        throw new Error(plan.reason);
      }
      const accepted = sendRealtimeEvent(context.channel, {
        type: 'conversation.item.create',
        event_id: realtimeEventId(),
        item: {
          type: 'function_call_output',
          call_id: callId,
          output: JSON.stringify({
            accepted: true,
            deliveryId: plan?.deliveryId ?? null,
            questionId: plan?.questionId ?? null,
            turnType: plan?.turnType ?? null,
            text: plan?.text ?? null,
          }),
        },
      });
      if (!accepted) {
        throw new Error('Der bestätigte Interviewturn konnte nicht an OpenAI übermittelt werden.');
      }
      context.settlePendingTurnPlan(plan);
      if (plan === null) {
        context.setCaptureBlocked(false);
        context.updateState('listening');
      } else {
        context.updateState('processing');
      }
    })
    .catch((error: unknown) => {
      if (!context.isTurnPlanRequestActive(clientRequestId)) return;
      const resolvedError = asError(error);
      context.settlePendingTurnPlan(null, resolvedError);
      context.reportFailure(resolvedError);
    });
}

function ownsResponseEvent(context: RealtimeEventContext): boolean {
  const response = readRecord(context.event, 'response');
  const responseId =
    response === null ? readString(context.event, 'response_id') : readString(response, 'id');
  const metadata = response === null ? null : readRecord(response, 'metadata');
  const requestId = metadata === null ? null : readString(metadata, 'client_request_id');
  const pending = context.pendingResponse;
  return (
    (pending !== null &&
      (pending.responseId === null
        ? requestId === pending.clientRequestId
        : responseId === pending.responseId)) ||
    (response !== null
      ? isPendingTurnPlanResponse(context, response, responseId)
      : context.pendingTurnPlan?.responseId === responseId && responseId !== null)
  );
}

function requestTurnPlanRepair(
  context: RealtimeEventContext,
  callId: string | null,
  reason: string,
): boolean {
  const pending = context.pendingTurnPlan;
  if (pending === null || pending.repairAttempts >= MAXIMUM_TURN_PLAN_REPAIRS) return false;
  if (
    callId !== null &&
    !sendRealtimeEvent(context.channel, {
      type: 'conversation.item.create',
      event_id: realtimeEventId(),
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: JSON.stringify({ accepted: false, reason }),
      },
    })
  ) {
    return false;
  }

  pending.repairAttempts += 1;
  pending.responseId = null;
  pending.handlingResult = false;
  const responseCreated = sendRealtimeEvent(context.channel, {
    type: 'response.create',
    event_id: realtimeEventId(),
    response: createTurnPlanResponseConfig(pending.clientRequestId, pending.repairAttempts),
  });
  if (responseCreated) {
    context.restartPendingTurnPlanTimeout();
    context.updateState('processing');
  }
  return responseCreated;
}

function requestTurnPlanFallback(
  context: RealtimeEventContext,
  clientRequestId: string,
  callId: string | null,
): boolean {
  const callback = context.callbacks.onTurnPlanFallback;
  if (callback === undefined || !context.isTurnPlanRequestActive(clientRequestId)) return false;
  if (context.pendingTurnPlan !== null) context.pendingTurnPlan.handlingResult = true;
  void Promise.resolve()
    .then(() => {
      if (!context.isTurnPlanRequestActive(clientRequestId)) return undefined;
      return callback(clientRequestId);
    })
    .then((plan) => {
      if (plan === undefined || !context.isTurnPlanRequestActive(clientRequestId)) return;
      if (
        callId !== null &&
        !sendRealtimeEvent(context.channel, {
          type: 'conversation.item.create',
          event_id: realtimeEventId(),
          item: {
            type: 'function_call_output',
            call_id: callId,
            output: JSON.stringify({
              accepted: true,
              fallback: true,
              questionId: plan?.questionId ?? null,
              text: plan?.text ?? null,
            }),
          },
        })
      )
        throw new Error('The approved fallback could not be acknowledged.');
      context.settlePendingTurnPlan(plan);
      if (plan === null) {
        context.setCaptureBlocked(false);
        context.updateState('listening');
      } else context.updateState('processing');
    })
    .catch((error: unknown) => {
      if (!context.isTurnPlanRequestActive(clientRequestId)) return;
      const resolvedError = asError(error);
      context.settlePendingTurnPlan(null, resolvedError);
      context.reportFailure(resolvedError);
    });
  return true;
}

export function parseTurnIntent(
  callId: string | null,
  serializedArguments: string | null,
): MvpRealtimeTurnIntentRequest | null {
  if (callId === null || serializedArguments === null) return null;
  try {
    const parsed = JSON.parse(serializedArguments) as unknown;
    if (!isRecord(parsed)) return null;
    const action = readString(parsed, 'action');
    const spokenText = readString(parsed, 'spokenText') ?? readString(parsed, 'spoken_text');
    const questionId = readString(parsed, 'questionId') ?? readString(parsed, 'question_id');
    const answerDisposition =
      readString(parsed, 'answerDisposition') ?? readString(parsed, 'answer_disposition');
    const missingAspect =
      readString(parsed, 'missingAspect') ?? readString(parsed, 'missing_aspect');
    const requestedEvidenceType =
      readString(parsed, 'requestedEvidenceType') ?? readString(parsed, 'requested_evidence_type');
    if (!isRealtimeTurnAction(action) || spokenText === null || spokenText.trim().length === 0) {
      return null;
    }
    const candidate = {
      clientEventId: callId,
      action,
      questionId: action === 'complete_interview' ? null : questionId,
      spokenText: spokenText.trim(),
      answerDisposition,
      missingAspect,
      requestedEvidenceType,
    };
    const validated = mvpRealtimeTurnIntentRequestSchema.safeParse(candidate);
    return validated.success ? validated.data : null;
  } catch {
    return null;
  }
}

function isRealtimeTurnAction(
  value: string | null,
): value is MvpRealtimeTurnIntentRequest['action'] {
  return (
    value === 'ask_main_question' ||
    value === 'ask_follow_up_question' ||
    value === 'ask_clarification_question' ||
    value === 'repeat_question' ||
    value === 'complete_interview'
  );
}

function publishCompletedAiTranscripts(context: RealtimeEventContext, responseId: string): void {
  const callback = context.callbacks.onAiTranscriptDone;
  const itemIds = responseItemIds(context, responseId);
  const plan = resolveVoiceResponsePlan(context, responseId);
  for (const itemId of itemIds) {
    if (context.publishedAiItems.has(itemId)) continue;
    const transcript = context.completedAiTranscripts.get(itemId);
    if (transcript === undefined || transcript.text.trim().length === 0) continue;
    context.publishedAiItems.add(itemId);
    if (callback !== undefined) {
      const publishedTranscript: VoiceAiTranscriptDone = {
        ...transcript,
        responseId,
        turnId: transcript.turnId ?? resolveTurnId(context, responseId),
        occurredAt: new Date().toISOString(),
        ...plan,
      };
      registerCallbackTask(
        context,
        responseId,
        Promise.resolve().then(() => callback(publishedTranscript)),
      );
    }
  }
  clearPublishedResponse(context, responseId, itemIds);
}

function publishInterruptedAiTranscripts(context: RealtimeEventContext, responseId: string): void {
  const callback = context.callbacks.onAiTranscriptInterrupted;
  const responseItems = responseItemIds(context, responseId);
  const itemIds =
    responseItems.length > 0
      ? responseItems
      : context.pendingResponse?.responseId === responseId
        ? [`timeout:${responseId}`]
        : [];
  const plan = resolveVoiceResponsePlan(context, responseId);
  for (const itemId of itemIds) {
    if (context.publishedAiItems.has(itemId)) continue;
    const completed = context.completedAiTranscripts.get(itemId);
    const generatedText = completed?.text ?? context.aiPartials.get(itemId) ?? '';
    context.completedAiItems.add(itemId);
    context.publishedAiItems.add(itemId);
    context.aiPartials.delete(itemId);
    if (callback !== undefined) {
      const interruptedTranscript: VoiceAiTranscriptInterrupted = {
        responseId,
        itemId,
        turnId: completed?.turnId ?? resolveTurnId(context, responseId),
        generatedText,
        confirmedSpokenText: '',
        occurredAt: new Date().toISOString(),
        ...plan,
      };
      registerCallbackTask(
        context,
        responseId,
        Promise.resolve()
          .then(() => callback(interruptedTranscript))
          .then(() => context.confirmPersistedTimeoutInterruption(responseId)),
      );
    }
  }
  clearPublishedResponse(context, responseId, itemIds);
}

function clearPublishedResponse(
  context: RealtimeEventContext,
  responseId: string,
  itemIds: readonly string[],
): void {
  for (const itemId of itemIds) {
    context.aiPartials.delete(itemId);
    context.completedAiTranscripts.delete(itemId);
    context.aiResponseIds.delete(itemId);
  }
  context.responseStatuses.delete(responseId);
  context.drainedResponseIds.delete(responseId);
  context.interruptedResponseIds.delete(responseId);
  context.responseTurnIds.delete(responseId);
  context.responsePlans.delete(responseId);
}

function captureResponseOutputTranscripts(
  context: RealtimeEventContext,
  response: Record<string, unknown>,
  responseId: string,
): void {
  for (const output of readRecordArray(response, 'output')) {
    if (readString(output, 'type') !== 'message') continue;
    const itemId = readString(output, 'id');
    if (itemId === null) continue;
    context.aiResponseIds.set(itemId, responseId);
    if (context.completedAiTranscripts.has(itemId)) continue;
    const transcript = readRecordArray(output, 'content')
      .map((content) => readString(content, 'transcript'))
      .find((value): value is string => value !== null);
    if (transcript === undefined) continue;
    const pending = context.pendingResponse;
    if (pending?.responseId === responseId) {
      pending.hasAudio = true;
    }
    context.completedAiItems.add(itemId);
    context.aiPartials.delete(itemId);
    context.completedAiTranscripts.set(itemId, {
      responseId,
      itemId,
      turnId: resolveTurnId(context, responseId),
      text: transcript,
      occurredAt: new Date().toISOString(),
      ...resolveVoiceResponsePlan(context, responseId),
    });
  }
}

function responseItemIds(context: RealtimeEventContext, responseId: string): string[] {
  return [...context.aiResponseIds.entries()]
    .filter((entry): entry is [string, string] => entry[1] === responseId)
    .map(([itemId]) => itemId);
}

function registerCallbackTask(
  context: RealtimeEventContext,
  responseId: string,
  callback: Promise<void | undefined>,
): void {
  const task = callback.catch((error: unknown) => {
    context.reportFailure(error);
    throw error;
  });
  const pending = context.pendingResponse;
  if (pending?.responseId === responseId) {
    pending.callbackTasks.push(task);
  } else {
    void task.catch(() => undefined);
  }
}

function resolveTurnId(context: RealtimeEventContext, responseId: string | null): string | null {
  if (responseId !== null) {
    const mapped = context.responseTurnIds.get(responseId);
    if (mapped !== undefined) return mapped;
  }
  return responseId === null ? (context.pendingResponse?.turnId ?? null) : null;
}

function resolveVoiceResponsePlan(
  context: RealtimeEventContext,
  responseId: string | null,
): ResolvedVoiceResponsePlan {
  if (responseId !== null) {
    const mapped = context.responsePlans.get(responseId);
    if (mapped !== undefined) return mapped;
  }
  const pending = context.pendingResponse;
  if (pending !== null && responseId !== null && pending.responseId === responseId) {
    return pending.plan;
  }
  return normalizeVoiceResponsePlan();
}

function pendingResponseFor(
  context: RealtimeEventContext,
  responseId: string | null,
): PendingResponse | null {
  const pending = context.pendingResponse;
  return pending !== null && responseId !== null && pending.responseId === responseId
    ? pending
    : null;
}

function parseRealtimeEvent(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readProviderError(event: Record<string, unknown>): string {
  const error = readRecord(event, 'error');
  if (error === null) return 'OpenAI konnte das Audioereignis nicht verarbeiten.';
  return (
    [readString(error, 'code'), readString(error, 'message')].filter(Boolean).join(': ') ||
    'OpenAI konnte das Audioereignis nicht verarbeiten.'
  );
}

export function readRateLimitRetryDelayMs(value: string): number | null {
  if (!/(rate[ _-]?limit|tokens per min|\bTPM\b)/i.test(value)) return null;
  const seconds = /try again in\s+([0-9]+(?:\.[0-9]+)?)s/i.exec(value)?.[1];
  if (seconds === undefined) return DEFAULT_RATE_LIMIT_RETRY_DELAY_MS;
  const parsed = Number(seconds);
  if (!Number.isFinite(parsed)) return DEFAULT_RATE_LIMIT_RETRY_DELAY_MS;
  return Math.min(MAX_RATE_LIMIT_RETRY_DELAY_MS, Math.max(1_000, Math.ceil(parsed * 1_000)));
}

export function createVoiceRateLimitError(delayMs: number): Error {
  const boundedDelay = Math.min(MAX_RATE_LIMIT_RETRY_DELAY_MS, Math.max(1_000, Math.ceil(delayMs)));
  return new Error(`VOICE_RATE_LIMITED:${boundedDelay}`);
}

export function readVoiceRateLimitRetryDelay(error: unknown): number | null {
  if (!(error instanceof Error)) return null;
  const encodedDelay = /^VOICE_RATE_LIMITED(?::([0-9]+))?$/.exec(error.message)?.[1];
  if (encodedDelay !== undefined) return Math.max(1_000, Number(encodedDelay));
  if (error.message === 'VOICE_RATE_LIMITED') return DEFAULT_RATE_LIMIT_RETRY_DELAY_MS;
  return null;
}

function readResponseFailure(response: Record<string, unknown>): string {
  const statusDetails = readRecord(response, 'status_details');
  const error = statusDetails === null ? null : readRecord(statusDetails, 'error');
  if (error === null) {
    return (
      readString(statusDetails ?? {}, 'reason') ??
      'OpenAI konnte keine vollständige Sprachantwort erzeugen.'
    );
  }
  return (
    [readString(error, 'code'), readString(error, 'message')].filter(Boolean).join(': ') ||
    'OpenAI konnte keine vollständige Sprachantwort erzeugen.'
  );
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function readRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = record[key];
  return isRecord(value) ? value : null;
}

function readRecordArray(record: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = record[key];
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function normalizeResponseRequest(
  request: string | VoiceResponseRequest | undefined,
  planMetadata: VoiceResponsePlanMetadata | undefined,
): Pick<ResponseRequest, 'instructions' | 'plan'> {
  if (typeof request === 'string') {
    return {
      instructions: normalizeOptionalText(request),
      plan: normalizeVoiceResponsePlan(planMetadata),
    };
  }
  return {
    instructions: normalizeOptionalText(request?.instructions),
    plan: normalizeVoiceResponsePlan({ ...request, ...planMetadata }),
  };
}

function normalizeVoiceResponsePlan(
  metadata?: VoiceResponsePlanMetadata,
): ResolvedVoiceResponsePlan {
  return {
    deliveryId: normalizeOptionalText(metadata?.deliveryId),
    workflowRunId: normalizeOptionalText(metadata?.workflowRunId),
    questionId: normalizeOptionalText(metadata?.questionId),
    turnType: metadata?.turnType ?? null,
  };
}

function serializeVoiceResponsePlan(
  plan: ResolvedVoiceResponsePlan,
): Readonly<Record<string, string>> {
  return {
    ...(plan.deliveryId === null ? {} : { delivery_id: plan.deliveryId }),
    ...(plan.workflowRunId === null ? {} : { workflow_run_id: plan.workflowRunId }),
    ...(plan.questionId === null ? {} : { question_id: plan.questionId }),
    ...(plan.turnType === null ? {} : { turn_type: plan.turnType }),
  };
}

export function createTurnPlanResponseConfig(
  clientRequestId: string,
  repairAttempt?: number,
): Readonly<Record<string, unknown>> {
  return {
    output_modalities: ['text'],
    max_output_tokens: TURN_PLAN_MAX_OUTPUT_TOKENS,
    tool_choice: 'required',
    metadata: {
      client_request_id: clientRequestId,
      request_kind: 'turn_plan',
      ...(repairAttempt === undefined ? {} : { repair_attempt: String(repairAttempt) }),
    },
  };
}

export function createSpeechResponseConfig(
  clientRequestId: string,
  instructions: string | null,
  plan: ResolvedVoiceResponsePlan,
): Readonly<Record<string, unknown>> {
  return {
    conversation: 'none',
    // Out-of-band alone still reads the conversation; an empty input isolates speech from planning.
    input: [],
    output_modalities: ['audio'],
    max_output_tokens: AUDIO_RESPONSE_MAX_OUTPUT_TOKENS,
    tools: [],
    tool_choice: 'none',
    metadata: { client_request_id: clientRequestId, ...serializeVoiceResponsePlan(plan) },
    ...(instructions === null ? {} : { instructions }),
  };
}

export function trackRealtimeConversationItem(
  event: Record<string, unknown>,
  items: Set<string>,
): void {
  const type = readString(event, 'type');
  if (type === 'conversation.item.created' || type === 'conversation.item.added') {
    const item = readRecord(event, 'item');
    const id = item === null ? null : readString(item, 'id');
    if (id !== null) items.add(id);
  } else if (type === 'conversation.item.deleted') {
    const id = readString(event, 'item_id');
    if (id !== null) items.delete(id);
  }
}

function readVoiceResponsePlan(
  metadata: Record<string, unknown> | null,
): ResolvedVoiceResponsePlan {
  if (metadata === null) return normalizeVoiceResponsePlan();
  const rawTurnType = readString(metadata, 'turn_type');
  return normalizeVoiceResponsePlan({
    deliveryId: readString(metadata, 'delivery_id'),
    workflowRunId: readString(metadata, 'workflow_run_id'),
    questionId: readString(metadata, 'question_id'),
    turnType: isVoicePlannedTurnType(rawTurnType) ? rawTurnType : null,
  });
}

function isVoicePlannedTurnType(value: string | null): value is VoicePlannedTurnType {
  return (
    value === 'greeting' ||
    value === 'main_question' ||
    value === 'follow_up_question' ||
    value === 'clarification_question' ||
    value === 'transition' ||
    value === 'closing'
  );
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? null : normalized;
}

function realtimeEventId(): string {
  return `evt_${crypto.randomUUID()}`;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('OpenAI Voice ist fehlgeschlagen.');
}

function fail(
  error: unknown,
  onError: ((error: Error) => void) | undefined,
  setState: (state: OpenAiVoiceState) => void,
): void {
  setState('failed');
  onError?.(asError(error));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function waitForDataChannelOpen(channel: RTCDataChannel): Promise<void> {
  if (channel.readyState === 'open') return;
  await new Promise<void>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error('Die OpenAI-Realtime-Datenverbindung wurde nicht rechtzeitig geöffnet.'));
    }, DATA_CHANNEL_OPEN_TIMEOUT_MS);
    const onOpen = (): void => {
      cleanup();
      resolve();
    };
    const onFailure = (): void => {
      cleanup();
      reject(new Error('Die OpenAI-Realtime-Datenverbindung konnte nicht geöffnet werden.'));
    };
    const cleanup = (): void => {
      window.clearTimeout(timeoutId);
      channel.removeEventListener('open', onOpen);
      channel.removeEventListener('error', onFailure);
      channel.removeEventListener('close', onFailure);
    };
    channel.addEventListener('open', onOpen);
    channel.addEventListener('error', onFailure);
    channel.addEventListener('close', onFailure);
  });
}

async function withTimeout<Result>(
  operation: Promise<Result>,
  timeoutMs: number,
  message: string,
): Promise<Result> {
  let timeoutId: number | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeoutId = window.setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  }
}

export function sendRealtimeContextUpdateToChannel(
  channel: RealtimeEventChannel,
  update: MvpRealtimeContextUpdate,
  clientEventId: string,
): boolean {
  return sendRealtimeEvent(channel, {
    type: 'session.update',
    event_id: clientEventId,
    session: { type: 'realtime', instructions: update.instructions },
  });
}

export function deleteCompactedRealtimeItems(
  channel: RealtimeEventChannel,
  itemIds: readonly string[],
  completedParticipantItems: Set<string>,
  completedAiItems: Set<string>,
  onEventSent: (dispatch: RealtimeContextDeleteDispatch) => void = () => undefined,
): boolean {
  let complete = true;
  for (const itemId of itemIds) {
    const wasParticipant = completedParticipantItems.has(itemId);
    const wasAi = completedAiItems.has(itemId);
    if (!wasParticipant && !wasAi) continue;
    const eventId = realtimeEventId();
    const removed = sendRealtimeEvent(channel, {
      type: 'conversation.item.delete',
      event_id: eventId,
      item_id: itemId,
    });
    if (removed) {
      onEventSent({ eventId, itemId, wasParticipant, wasAi });
      completedParticipantItems.delete(itemId);
      completedAiItems.delete(itemId);
    } else {
      complete = false;
    }
  }
  return complete;
}

export function recoverRejectedRealtimeContextDelete(input: {
  readonly event: Readonly<Record<string, unknown>>;
  readonly pendingDeletes: Map<string, RealtimeContextDeleteDispatch>;
  readonly completedParticipantItems: Set<string>;
  readonly completedAiItems: Set<string>;
  readonly appliedRevision: string | null;
}): { readonly handled: boolean; readonly appliedRevision: string | null } {
  const clientEventId = realtimeClientErrorEventId(input.event);
  const dispatch = clientEventId === null ? undefined : input.pendingDeletes.get(clientEventId);
  if (clientEventId === null || dispatch === undefined) {
    return { handled: false, appliedRevision: input.appliedRevision };
  }
  input.pendingDeletes.delete(clientEventId);
  const error = readRecord(input.event, 'error');
  if (error !== null && readString(error, 'code') === 'item_delete_invalid_item_id') {
    return { handled: true, appliedRevision: input.appliedRevision };
  }
  if (dispatch.wasParticipant) input.completedParticipantItems.add(dispatch.itemId);
  if (dispatch.wasAi) input.completedAiItems.add(dispatch.itemId);
  return {
    handled: true,
    appliedRevision: null,
  };
}

export function confirmRealtimeContextItemDeletion(
  event: Readonly<Record<string, unknown>>,
  pendingDeletes: Map<string, RealtimeContextDeleteDispatch>,
): boolean {
  if (readString(event, 'type') !== 'conversation.item.deleted') return false;
  const itemId = readString(event, 'item_id');
  if (itemId === null) return false;
  for (const [eventId, dispatch] of pendingDeletes) {
    if (dispatch.itemId !== itemId) continue;
    pendingDeletes.delete(eventId);
    return true;
  }
  return false;
}

export function isRealtimeContextUpdateAcknowledgement(
  event: Readonly<Record<string, unknown>>,
  expectedInstructions: string,
): boolean {
  const session = readRecord(event, 'session');
  return (
    readString(event, 'type') === 'session.updated' &&
    session !== null &&
    readString(session, 'instructions') === expectedInstructions
  );
}

export function realtimeClientErrorEventId(
  event: Readonly<Record<string, unknown>>,
): string | null {
  const error = readRecord(event, 'error');
  return error === null ? null : readString(error, 'event_id');
}

function sendRealtimeEvent(
  channel: RealtimeEventChannel,
  event: Readonly<Record<string, unknown>>,
): boolean {
  if (channel.readyState !== 'open') return false;
  try {
    channel.send(JSON.stringify(event));
    return true;
  } catch {
    return false;
  }
}

function setAudioTracksEnabled(stream: MediaStream | null, enabled: boolean): void {
  for (const track of stream?.getAudioTracks() ?? []) track.enabled = enabled;
}
