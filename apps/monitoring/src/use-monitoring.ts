import type {
  InterviewSummary,
  MonitoringEvent,
  MonitoringSnapshot,
  MvpInterviewSession,
  ProfileEvaluationSnapshot,
} from '@orgscience/contracts';
import type { MessageKey, Translate } from '@orgscience/frontend-i18n';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  getEvaluation,
  getInterviewSession,
  getMonitoringHistory,
  getMonitoringSnapshot,
  listAllInterviews,
  MonitoringApiError,
  openMonitoringStream,
} from './api.js';

export type ConnectionState = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'offline';
export type MonitoringErrorKind =
  | 'backend_unavailable'
  | 'event_history_gap'
  | 'generic'
  | 'invalid_json'
  | 'invalid_response'
  | 'live_event_gap'
  | 'request_failed'
  | 'stream_reset';

interface InterviewDirectoryState {
  readonly interviews: readonly InterviewSummary[];
  readonly loading: boolean;
  readonly error: MonitoringErrorKind | null;
  readonly reload: () => void;
}

export interface MonitoringSessionState {
  readonly liveSession: MvpInterviewSession | null;
  readonly snapshot: MonitoringSnapshot | null;
  readonly events: readonly MonitoringEvent[];
  readonly connection: ConnectionState;
  readonly loading: boolean;
  readonly error: MonitoringErrorKind | null;
  readonly lastEventAt: string | null;
  readonly evaluation: ProfileEvaluationSnapshot | null;
  readonly evaluationLoading: boolean;
  readonly evaluationError: MonitoringErrorKind | null;
  readonly reloadEvaluation: () => void;
  readonly reconnect: () => void;
}

export function useInterviewDirectory(): InterviewDirectoryState {
  const [interviews, setInterviews] = useState<InterviewSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<MonitoringErrorKind | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    void listAllInterviews(controller.signal)
      .then((items) => {
        setInterviews(items);
        setLoading(false);
      })
      .catch((reason: unknown) => {
        if (isAbort(reason)) return;
        setError(errorKind(reason));
        setLoading(false);
      });

    return () => {
      controller.abort();
    };
  }, [reloadToken]);

  const reload = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  return { interviews, loading, error, reload };
}

export function useMonitoringSession(
  interviewId: string | null,
  evaluationProfileId?: string,
): MonitoringSessionState {
  const [liveSession, setLiveSession] = useState<MvpInterviewSession | null>(null);
  const [snapshot, setSnapshot] = useState<MonitoringSnapshot | null>(null);
  const [events, setEvents] = useState<MonitoringEvent[]>([]);
  const [connection, setConnection] = useState<ConnectionState>('idle');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<MonitoringErrorKind | null>(null);
  const [lastEventAt, setLastEventAt] = useState<string | null>(null);
  const [reconnectToken, setReconnectToken] = useState(0);
  const selectedInterviewRef = useRef<string | null>(null);
  useEffect(() => {
    if (interviewId === null) {
      selectedInterviewRef.current = null;
      setLiveSession(null);
      setSnapshot(null);
      setEvents([]);
      setConnection('idle');
      setLoading(false);
      setError(null);
      setLastEventAt(null);
      return;
    }

    const controller = new AbortController();
    let stream: EventSource | null = null;
    let closed = false;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let resetTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let cursor = 0;

    if (selectedInterviewRef.current !== interviewId) {
      selectedInterviewRef.current = interviewId;
      setLiveSession(null);
      setSnapshot(null);
      setEvents([]);
      setLastEventAt(null);
    }
    setLoading(true);
    setError(null);
    setConnection('connecting');

    const pollSession = async (): Promise<void> => {
      try {
        const nextSession = await getInterviewSession(interviewId, controller.signal);
        if (!closed && nextSession.interviewId === interviewId) {
          setLiveSession(nextSession);
          setConnection('live');
          setLoading(false);
        }
      } catch (reason) {
        if (!isAbort(reason) && !closed) setError(errorKind(reason));
      }
    };

    const loadSnapshot = async (): Promise<void> => {
      const nextSnapshot = await getMonitoringSnapshot(interviewId, controller.signal);
      const history = await getMonitoringHistory(
        interviewId,
        nextSnapshot.eventSequence,
        controller.signal,
      );
      if (closed || nextSnapshot.interviewState.interviewId !== interviewId) return;

      cursor = nextSnapshot.eventSequence;
      setSnapshot(nextSnapshot);
      setEvents(history);
      setLastEventAt(history.at(-1)?.occurredAt ?? null);
      setLoading(false);
      connect();
    };

    const refreshSnapshot = (): void => {
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        void getMonitoringSnapshot(interviewId, controller.signal)
          .then((nextSnapshot) => {
            if (
              !closed &&
              nextSnapshot.interviewState.interviewId === interviewId &&
              nextSnapshot.eventSequence >= cursor
            ) {
              setSnapshot(nextSnapshot);
            }
          })
          .catch((reason: unknown) => {
            if (!isAbort(reason) && !closed) setError(errorKind(reason));
          });
      }, 180);
    };

    const resetFromSnapshot = (): void => {
      stream?.close();
      stream = null;
      setConnection('reconnecting');
      if (resetTimer !== null) clearTimeout(resetTimer);
      resetTimer = setTimeout(() => {
        if (!closed) {
          setReconnectToken((token) => token + 1);
        }
      }, 650);
    };

    const connect = (): void => {
      if (closed) return;
      stream = openMonitoringStream(interviewId, cursor, {
        onReady: (ready) => {
          if (closed || ready.interviewId !== interviewId) return;
          setConnection('live');
          setError(null);
        },
        onEvent: (event) => {
          if (closed || event.interviewId !== interviewId) return;
          if (event.sequenceNumber <= cursor) return;
          if (event.sequenceNumber !== cursor + 1) {
            setError('live_event_gap');
            resetFromSnapshot();
            return;
          }

          cursor = event.sequenceNumber;
          setEvents((current) => [...current, event]);
          setLastEventAt(event.occurredAt);
          setConnection('live');
          refreshSnapshot();
        },
        onFault: (fault) => {
          if (closed || fault.interviewId !== interviewId) return;
          setError('stream_reset');
          resetFromSnapshot();
        },
        onConnectionError: () => {
          if (!closed) setConnection('reconnecting');
        },
      });
    };

    void pollSession();
    pollTimer = setInterval(() => void pollSession(), 1_000);
    void loadSnapshot().catch((reason: unknown) => {
      if (isAbort(reason) || closed) return;
      setError(errorKind(reason));
      setLoading(false);
    });

    return () => {
      closed = true;
      controller.abort();
      stream?.close();
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      if (resetTimer !== null) clearTimeout(resetTimer);
      if (pollTimer !== null) clearInterval(pollTimer);
    };
  }, [interviewId, reconnectToken]);

  const reconnect = useCallback(() => {
    setReconnectToken((token) => token + 1);
  }, []);

  const selectionPending = selectedInterviewRef.current !== interviewId;
  const scopedLiveSession =
    !selectionPending && liveSession?.interviewId === interviewId ? liveSession : null;
  const scopedSnapshot = snapshot?.interviewState.interviewId === interviewId ? snapshot : null;
  const scopedEvents =
    interviewId === null || selectionPending
      ? []
      : events.filter((event) => event.interviewId === interviewId);
  const interviewCompleted =
    scopedLiveSession?.status === 'completed' ||
    scopedSnapshot?.interviewState.lifecycle.status === 'completed';
  const evaluation = useEvaluationSnapshot(
    interviewId,
    evaluationProfileId,
    interviewCompleted,
    reconnectToken,
  );

  return {
    liveSession: scopedLiveSession,
    snapshot: selectionPending ? null : scopedSnapshot,
    events: scopedEvents,
    connection: selectionPending ? (interviewId === null ? 'idle' : 'connecting') : connection,
    loading: selectionPending ? interviewId !== null : loading,
    error: selectionPending ? null : error,
    lastEventAt: scopedEvents.length === 0 ? null : lastEventAt,
    evaluation: evaluation.snapshot,
    evaluationLoading: evaluation.loading,
    evaluationError: evaluation.error,
    reloadEvaluation: evaluation.reload,
    reconnect,
  };
}

interface EvaluationState {
  readonly snapshot: ProfileEvaluationSnapshot | null;
  readonly loading: boolean;
  readonly error: MonitoringErrorKind | null;
  readonly reload: () => void;
}

function useEvaluationSnapshot(
  interviewId: string | null,
  profileId: string | undefined,
  pollUntilTerminal: boolean,
  reconnectToken: number,
): EvaluationState {
  const [snapshot, setSnapshot] = useState<ProfileEvaluationSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<MonitoringErrorKind | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (interviewId === null) {
      setSnapshot(null);
      setLoading(false);
      setError(null);
      return;
    }

    const controller = new AbortController();
    let closed = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    setSnapshot(null);
    setLoading(true);
    setError(null);

    const load = async (): Promise<void> => {
      try {
        const nextSnapshot = await getEvaluation(interviewId, profileId, controller.signal);
        if (closed) return;

        setSnapshot(nextSnapshot);
        setLoading(false);
        setError(null);

        if (
          pollUntilTerminal &&
          nextSnapshot.status !== 'completed' &&
          nextSnapshot.status !== 'failed'
        ) {
          pollTimer = setTimeout(() => void load(), 2_500);
        }
      } catch (reason) {
        if (isAbort(reason) || closed) return;
        setLoading(false);
        setError(errorKind(reason));
        if (pollUntilTerminal) pollTimer = setTimeout(() => void load(), 4_000);
      }
    };

    void load();

    return () => {
      closed = true;
      controller.abort();
      if (pollTimer !== null) clearTimeout(pollTimer);
    };
  }, [interviewId, pollUntilTerminal, profileId, reconnectToken, reloadToken]);

  const reload = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  return {
    snapshot: snapshot?.interviewId === interviewId ? snapshot : null,
    loading,
    error,
    reload,
  };
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function errorKind(error: unknown): MonitoringErrorKind {
  if (!(error instanceof MonitoringApiError)) return 'generic';
  switch (error.code) {
    case 'NETWORK_ERROR':
      return 'backend_unavailable';
    case 'EVENT_HISTORY_GAP':
      return 'event_history_gap';
    case 'INVALID_JSON':
      return 'invalid_json';
    case 'INVALID_RESPONSE':
      return 'invalid_response';
    case 'HTTP_ERROR':
      return 'request_failed';
    default:
      return 'generic';
  }
}

export function monitoringErrorMessage(t: Translate, error: MonitoringErrorKind): string {
  const keys = {
    backend_unavailable: 'monitoring.error.backendUnavailable',
    event_history_gap: 'monitoring.error.eventHistoryGap',
    generic: 'monitoring.error.generic',
    invalid_json: 'monitoring.error.invalidJson',
    invalid_response: 'monitoring.error.invalidResponse',
    live_event_gap: 'monitoring.error.liveEventGap',
    request_failed: 'monitoring.error.requestFailed',
    stream_reset: 'monitoring.error.streamReset',
  } as const satisfies Record<MonitoringErrorKind, MessageKey>;
  return t(keys[error]);
}
