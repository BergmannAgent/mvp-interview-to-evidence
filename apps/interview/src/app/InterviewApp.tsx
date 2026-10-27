import type {
  InterviewGuide,
  GuideSummary,
  MvpInterviewSession,
  MvpRealtimeAppendResponse,
  MvpRealtimeCommandResponse,
  MvpRealtimeTurnIntentRequest,
  MvpRealtimeTurnPlan,
  MvpRealtimeTurnRejection,
  MvpTranscriptGap,
  MvpTranscriptTurn,
  SupportedLocale,
} from '@orgscience/contracts';
import {
  LanguageSwitcher,
  useI18n,
  type MessageKey,
  type Translate,
} from '@orgscience/frontend-i18n';
import {
  Captions,
  Check,
  CircleStop,
  Download,
  FileJson,
  FileText,
  LoaderCircle,
  Mic,
  MicOff,
  MonitorUp,
  Pause,
  Play,
  RotateCcw,
  Send,
  Settings,
  Sparkles,
  Upload,
  Video,
  VideoOff,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';

import { InterviewApiError, interviewApi } from '../api/interview-api.js';
import { AiInterviewer } from '../components/AiInterviewer.js';
import { IconButton } from '../components/IconButton.js';
import { TranscriptPanel } from '../components/TranscriptPanel.js';
import { isAuthoritativeTranscriptFinalized } from '../completion-state.js';
import {
  downloadTranscript,
  orderedTranscriptEntries,
  type TranscriptExportFormat,
} from '../export-transcript.js';
import { ensureCurrentFrontendBuild } from '../frontend-build.js';
import { useMediaPreview, type MediaPreviewErrorCode } from '../hooks/use-media-preview.js';
import { useInterviewGuideSettings } from '../hooks/use-interview-guide-settings.js';
import {
  readVoiceRateLimitRetryDelay,
  useOpenAiVoice,
  type OpenAiVoiceState,
  type VoiceAiTranscriptDone,
  type VoiceAiTranscriptInterrupted,
} from '../hooks/use-openai-voice.js';
import type {
  DisplayTranscriptTurn,
  InterviewInputMode,
  InterviewPhase,
  PreparedInterview,
} from '../model.js';
import {
  clearInterviewSession,
  persistInterviewSession,
  restoreInterviewSession,
} from '../session-storage.js';
import { exactSpeechInstructions } from '../voice-instructions.js';
import { interviewProgress } from './interview-progress.js';
import { shouldApplyAuthoritativeSession } from './session-freshness.js';

type ConnectionState = 'connected' | 'degraded';
const UNCONFIRMED_AI_RETRY_DELAY_MS = 750;
const MAX_UNCONFIRMED_AI_FAILURES_BEFORE_STOP = 2;
const MAX_RATE_LIMIT_RETRIES_PER_DELIVERY = 3;

export function InterviewApp({
  onLanguageLock = () => undefined,
}: { readonly onLanguageLock?: (language: SupportedLocale | null) => void } = {}) {
  const { locale, t } = useI18n();
  const restored = useMemo(restoreInterviewSession, []);
  const media = useMediaPreview();
  const [prepared, setPrepared] = useState<PreparedInterview | null>(() =>
    restored === null
      ? null
      : {
          guide: restored.guide,
          interviewId: restored.interviewId,
        },
  );
  const [startedAt, setStartedAt] = useState<string | null>(restored?.startedAt ?? null);
  const [endedAt, setEndedAt] = useState<string | null>(restored?.endedAt ?? null);
  const [turns, setTurns] = useState<readonly DisplayTranscriptTurn[]>(restored?.turns ?? []);
  const [promptIndex, setPromptIndex] = useState(restored?.promptIndex ?? 0);
  const [phase, setPhase] = useState<InterviewPhase>(restored?.phase ?? 'ready');
  const [session, setSession] = useState<MvpInterviewSession | null>(null);
  const [connection, setConnection] = useState<ConnectionState>('connected');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const guideSettings = useInterviewGuideSettings(locale, prepared === null);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [captionsEnabled, setCaptionsEnabled] = useState(true);
  const [inputMode, setInputMode] = useState<InterviewInputMode>(restored?.inputMode ?? 'text');
  const [partialVoiceText, setPartialVoiceText] = useState<string | null>(null);
  const pendingCommandCountRef = useRef(0);
  const authoritativeSessionRef = useRef<MvpInterviewSession | null>(null);
  const activeInterviewIdRef = useRef(prepared?.interviewId ?? null);
  const voicePersistenceQueueRef = useRef<Promise<void>>(Promise.resolve());
  const activeDeliveryIdRef = useRef<string | null>(null);
  const settledDeliveryIdsRef = useRef(new Set<string>());
  const rateLimitRetryAttemptsRef = useRef(new Map<string, number>());
  const unconfirmedAiFailureCountRef = useRef(0);
  const endRequestedRef = useRef(false);
  const scheduledTurnTimeoutsRef = useRef(new Set<number>());
  const realtimeTurnGenerationRef = useRef(0);
  const desiredDeliveryIdRef = useRef<string | null>(null);
  const reconnectPromiseRef = useRef<Promise<void> | null>(null);
  const diagnosticWindowRef = useRef({ startedAt: 0, count: 0 });
  const voice = useOpenAiVoice({
    onDiagnostic: (diagnostic) => {
      if (prepared === null) return;
      const windowState = diagnosticWindowRef.current;
      if (Date.now() - windowState.startedAt > 60_000) {
        windowState.startedAt = Date.now();
        windowState.count = 0;
      }
      if (windowState.count >= 30) return;
      windowState.count += 1;
      void interviewApi.reportVoiceDiagnostic(prepared.interviewId, diagnostic).catch(() => {
        console.warn('Voice diagnostic could not be persisted.', diagnostic.diagnosticId);
      });
    },
    onFinalTurn: (turn) => enqueueVoicePersistence(() => submitVoiceAnswer(turn)),
    onTurnIntent: (intent) => reserveRealtimeTurnIntent(intent),
    onTurnPlanFallback: (clientEventId) => advanceAfterRejectedPlan(clientEventId),
    onPartialText: setPartialVoiceText,
    onAiTranscriptDone: (transcript) =>
      enqueueVoicePersistence(() => persistRealtimeAiTurn(transcript)),
    onAiTranscriptInterrupted: (transcript) =>
      enqueueVoicePersistence(() => persistInterruptedRealtimeAiTurn(transcript)),
    onReconnectRequired: (interviewId) => reconnectRealtimeVoice(interviewId),
    onError: (error) => {
      setConnection('degraded');
      setMessage(readErrorMessage(error, t));
    },
  });

  function applySession(sessionSnapshot: MvpInterviewSession): boolean {
    if (sessionSnapshot.interviewId !== activeInterviewIdRef.current) return false;
    if (!shouldApplyAuthoritativeSession(authoritativeSessionRef.current, sessionSnapshot)) {
      return false;
    }
    authoritativeSessionRef.current = sessionSnapshot;
    onLanguageLock(sessionSnapshot.status === 'completed' ? null : sessionSnapshot.language);
    applyAuthoritativeSession(sessionSnapshot, {
      setSession,
      setStartedAt,
      setEndedAt,
      setTurns,
      setPromptIndex,
      setPhase,
    });
    return true;
  }

  useEffect(() => {
    document.title = t('interview.meta.title');
    document
      .querySelector<HTMLMetaElement>('meta[name="description"]')
      ?.setAttribute('content', t('interview.meta.description'));
  }, [t]);

  useEffect(() => {
    if (inputMode !== 'voice' || session?.status !== 'active') return;
    switch (voice.state) {
      case 'connecting':
      case 'processing':
        setPhase('processing');
        return;
      case 'speaking':
        setPhase('speaking');
        return;
      case 'listening':
        setPhase('listening');
        return;
      case 'failed':
        setPhase('listening');
        return;
      case 'idle':
        return;
    }
  }, [inputMode, session?.status, voice.state]);

  useEffect(() => {
    if (prepared === null || startedAt === null) return;
    persistInterviewSession({
      guide: prepared.guide,
      interviewId: prepared.interviewId,
      phase,
      inputMode,
      promptIndex,
      turns,
      startedAt,
      endedAt,
    });
  }, [endedAt, inputMode, phase, prepared, promptIndex, startedAt, turns]);

  useEffect(() => {
    if (startedAt !== null) return undefined;
    const checkForUpdate = (): void => {
      if (document.visibilityState === 'visible') void ensureCurrentFrontendBuild();
    };
    window.addEventListener('focus', checkForUpdate);
    document.addEventListener('visibilitychange', checkForUpdate);
    return () => {
      window.removeEventListener('focus', checkForUpdate);
      document.removeEventListener('visibilitychange', checkForUpdate);
    };
  }, [startedAt]);

  useEffect(() => {
    if (prepared === null) return undefined;
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      if (pendingCommandCountRef.current > 0) return;
      try {
        const refreshed = await interviewApi.getSession(prepared.interviewId);
        if (cancelled) return;
        if (!applySession(refreshed)) return;
        if (inputMode === 'voice' && refreshed.status === 'active') {
          setPhase(voiceStateToPhase(voice.state));
        }
        setConnection('connected');
      } catch (error: unknown) {
        if (cancelled) return;
        if (error instanceof InterviewApiError && error.status === 404) {
          resetInterview();
          return;
        }
        setConnection('degraded');
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [inputMode, prepared, voice.state]);

  async function handleGuideFile(file: File): Promise<string | null> {
    setBusy(true);
    setMessage(null);
    if (!(await ensureCurrentFrontendBuild())) {
      setBusy(false);
      return null;
    }
    if (!file.name.toLowerCase().endsWith('.md')) {
      setMessage(t('interview.error.fileExtension'));
      setBusy(false);
      return null;
    }
    if (file.size > 1_000_000) {
      setMessage(t('interview.error.fileSize'));
      setBusy(false);
      return null;
    }

    try {
      const imported = await interviewApi.importGuide(file, locale);
      await guideSettings.reload();
      setConnection('connected');
      return imported.interviewGuide.id;
    } catch (error: unknown) {
      setMessage(readErrorMessage(error, t));
      setConnection('degraded');
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function saveGuideSetting(guideId: string): Promise<boolean> {
    setBusy(true);
    setMessage(null);
    try {
      await interviewApi.settings.updateSetting(locale, guideId);
      await guideSettings.reload();
      return true;
    } catch (error: unknown) {
      setMessage(readErrorMessage(error, t));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function startInterview(): Promise<void> {
    if (busy || (prepared === null && (guideSettings.guide === null || guideSettings.loading)))
      return;
    setBusy(true);
    setMessage(null);
    if (!(await ensureCurrentFrontendBuild())) {
      setBusy(false);
      return;
    }
    pendingCommandCountRef.current += 1;
    let starting = prepared;
    try {
      if (starting === null) {
        const guide = guideSettings.guide;
        if (guide === null) return;
        onLanguageLock(guideLanguage(guide));
        const interview = await interviewApi.createInterview(guide.id, guideLanguage(guide));
        starting = { guide, interviewId: interview.interviewState.interviewId };
        activeInterviewIdRef.current = starting.interviewId;
        authoritativeSessionRef.current = null;
        endRequestedRef.current = false;
        setPrepared(starting);
      }
      if (inputMode === 'voice') {
        const microphoneEnabled = media.microphoneEnabled;
        const response = await interviewApi.startRealtimeInterview(starting.interviewId);
        applySession(response.session);
        media.setMicrophoneEnabled(false);
        voice.setMicrophoneEnabled(microphoneEnabled);
        await voice.connect(starting.interviewId);
        scheduleRealtimeTurn(response.nextAiTurn);
      } else {
        const response = await interviewApi.performAction(starting.interviewId, 'start');
        applySession(response.session);
        if (response.newAiTurns.length > 0 && response.session.status === 'active') {
          setPhase('speaking');
          await wait(450);
          setPhase('listening');
        }
      }
      setConnection('connected');
    } catch (error: unknown) {
      if (starting === null) onLanguageLock(null);
      setConnection('degraded');
      setMessage(readErrorMessage(error, t));
    } finally {
      pendingCommandCountRef.current = Math.max(0, pendingCommandCountRef.current - 1);
      setBusy(false);
    }
  }

  async function submitVoiceAnswer(turn: {
    readonly clientEventId: string;
    readonly text: string;
    readonly occurredAt: string;
  }): Promise<void> {
    if (prepared === null) return;
    setMessage(null);
    setPhase('processing');
    pendingCommandCountRef.current += 1;
    try {
      const response = await interviewApi.appendRealtimeParticipantTurn(prepared.interviewId, turn);
      if (!applySession(response.session)) return;
      setConnection('connected');
      const nextAiTurn =
        response.nextAiTurn ??
        (response.session.status === 'active' && hasLatestParticipantTurn(response.session)
          ? await requestNextRealtimePlan()
          : null);
      scheduleRealtimeTurn(nextAiTurn);
      disconnectCompletedRealtimeSession(response);
    } catch (error: unknown) {
      const rateLimitDelayMs = readVoiceRateLimitRetryDelay(error);
      if (rateLimitDelayMs !== null) {
        await wait(rateLimitDelayMs);
        try {
          const nextAiTurn = await requestNextRealtimePlan();
          setConnection('connected');
          setMessage(null);
          scheduleRealtimeTurn(nextAiTurn);
          return;
        } catch (retryError: unknown) {
          setConnection('degraded');
          setMessage(readErrorMessage(retryError, t));
          throw retryError;
        }
      }
      try {
        const recovered = await interviewApi.recoverRealtimeParticipantTurn(prepared.interviewId);
        if (
          recovered.session.status !== 'completed' &&
          recovered.nextAiTurn === null &&
          !hasLatestParticipantTurn(recovered.session)
        ) {
          throw error;
        }
        if (!applySession(recovered.session)) return;
        setConnection('connected');
        setMessage(null);
        const nextAiTurn =
          recovered.nextAiTurn ??
          (recovered.session.status === 'active' && hasLatestParticipantTurn(recovered.session)
            ? await requestNextRealtimePlan()
            : null);
        scheduleRealtimeTurn(nextAiTurn);
        disconnectCompletedRealtimeSession(recovered);
      } catch {
        setConnection('degraded');
        setMessage(readErrorMessage(error, t));
        throw error;
      }
    } finally {
      pendingCommandCountRef.current = Math.max(0, pendingCommandCountRef.current - 1);
    }
  }

  async function reserveRealtimeTurnIntent(
    intent: MvpRealtimeTurnIntentRequest,
  ): Promise<MvpRealtimeTurnPlan | MvpRealtimeTurnRejection | null> {
    if (prepared === null || endRequestedRef.current) return null;
    const response = await interviewApi.reserveRealtimeTurnIntent(prepared.interviewId, intent);
    if (!applySession(response.session) || endRequestedRef.current) return null;
    if (response.contextUpdate != null) {
      voice.applyContextUpdate(response.contextUpdate);
    }
    setConnection('connected');
    return response.rejection ?? response.nextAiTurn;
  }

  async function advanceAfterRejectedPlan(
    clientEventId: string,
  ): Promise<MvpRealtimeTurnPlan | null> {
    const current = authoritativeSessionRef.current?.currentQuestion;
    if (current == null || endRequestedRef.current) return null;
    const result = await reserveRealtimeTurnIntent({
      clientEventId,
      action: 'ask_main_question',
      questionId: current.questionId,
      spokenText: 'Which guide question comes next?',
      answerDisposition: 'partial',
      missingAspect: null,
      requestedEvidenceType: null,
      repairAttempt: 1,
    });
    if (result !== null && 'reason' in result) throw new Error(result.reason);
    return result;
  }

  async function requestNextRealtimePlan(): Promise<MvpRealtimeTurnPlan | null> {
    if (endRequestedRef.current || authoritativeSessionRef.current?.status !== 'active')
      return null;
    return voice.requestTurnPlan();
  }

  async function persistRealtimeAiTurn(transcript: VoiceAiTranscriptDone): Promise<void> {
    if (prepared === null || transcript.text.trim().length === 0) return;
    if (transcript.deliveryId === null || transcript.turnType === null) {
      throw new Error('INVALID_AI_DELIVERY_PLAN');
    }
    const result = await interviewApi.appendRealtimeAiTurn(prepared.interviewId, {
      deliveryId: transcript.deliveryId,
      clientEventId: transcript.itemId,
      text: transcript.text,
      occurredAt: transcript.occurredAt,
      turnType: transcript.turnType,
      questionId: transcript.questionId,
    });
    settleDelivery(transcript.deliveryId);
    unconfirmedAiFailureCountRef.current = 0;
    applyRealtimeResponse(result);
    if (result.turn === null && result.nextAiTurn === null) {
      if (result.session.status === 'active') {
        const interviewId = prepared.interviewId;
        window.setTimeout(() => {
          void reconnectRealtimeVoice(interviewId).catch((error: unknown) => {
            setConnection('degraded');
            setMessage(readErrorMessage(error, t));
          });
        }, 0);
        return;
      }
      throw new Error('VOICE_DELIVERY_TEXT_MISMATCH');
    }
    setConnection('connected');
    setMessage(null);
  }

  async function persistInterruptedRealtimeAiTurn(
    transcript: VoiceAiTranscriptInterrupted,
  ): Promise<void> {
    if (prepared === null) return;
    if (transcript.deliveryId === null) {
      throw new Error('MISSING_INTERRUPTED_DELIVERY_ID');
    }
    const result = await interviewApi.interruptRealtimeAiTurn(prepared.interviewId, {
      deliveryId: transcript.deliveryId,
      clientEventId: transcript.itemId,
      generatedText: transcript.generatedText,
      confirmedSpokenText: transcript.confirmedSpokenText,
      occurredAt: transcript.occurredAt,
    });
    const wasUnconfirmed = result.turn === null;
    if (wasUnconfirmed) unconfirmedAiFailureCountRef.current += 1;
    else unconfirmedAiFailureCountRef.current = 0;
    settleDelivery(transcript.deliveryId);
    applyRealtimeResponse(
      result,
      wasUnconfirmed && result.nextAiTurn !== null ? UNCONFIRMED_AI_RETRY_DELAY_MS : 0,
    );
    if (
      wasUnconfirmed &&
      result.nextAiTurn === null &&
      result.session.status === 'active' &&
      hasLatestParticipantTurn(result.session) &&
      unconfirmedAiFailureCountRef.current <= MAX_UNCONFIRMED_AI_FAILURES_BEFORE_STOP
    ) {
      const interviewId = prepared.interviewId;
      window.setTimeout(() => {
        void reconnectRealtimeVoice(interviewId).catch((error: unknown) => {
          setConnection('degraded');
          setMessage(readErrorMessage(error, t));
        });
      }, UNCONFIRMED_AI_RETRY_DELAY_MS);
    }
    setConnection('connected');
  }

  function reconnectRealtimeVoice(interviewId: string): Promise<void> {
    if (reconnectPromiseRef.current !== null) return reconnectPromiseRef.current;
    const operation = performRealtimeReconnect(interviewId);
    reconnectPromiseRef.current = operation;
    const release = (): void => {
      if (reconnectPromiseRef.current === operation) reconnectPromiseRef.current = null;
    };
    void operation.then(release, release);
    return operation;
  }

  async function performRealtimeReconnect(interviewId: string): Promise<void> {
    if (interviewId !== activeInterviewIdRef.current) return;
    pendingCommandCountRef.current += 1;
    try {
      const response = await interviewApi.recoverRealtimeParticipantTurn(interviewId);
      if (!applySession(response.session)) return;
      if (response.session.status !== 'active') {
        voice.disconnect();
        return;
      }
      activeDeliveryIdRef.current = null;
      clearScheduledRealtimeTurns();
      await voice.connect(interviewId);
      if (interviewId !== activeInterviewIdRef.current) return;
      setConnection('connected');
      setMessage(null);
      const nextAiTurn =
        response.nextAiTurn ??
        (hasLatestParticipantTurn(response.session) ? await requestNextRealtimePlan() : null);
      scheduleRealtimeTurn(nextAiTurn);
    } catch (error: unknown) {
      setConnection('degraded');
      throw error;
    } finally {
      pendingCommandCountRef.current = Math.max(0, pendingCommandCountRef.current - 1);
    }
  }

  function applyRealtimeResponse(
    response: MvpRealtimeCommandResponse | MvpRealtimeAppendResponse,
    nextTurnDelayMs = 0,
  ): void {
    if (!applySession(response.session)) return;
    scheduleRealtimeTurn(response.nextAiTurn, nextTurnDelayMs);
    disconnectCompletedRealtimeSession(response);
  }

  function disconnectCompletedRealtimeSession(
    response: MvpRealtimeCommandResponse | MvpRealtimeAppendResponse,
  ): void {
    if (response.session.status === 'completed' && response.nextAiTurn === null) {
      clearScheduledRealtimeTurns();
      // This callback follows confirmed playback; keep no delayed disconnect from an old session.
      voice.disconnect();
    }
  }

  function scheduleRealtimeTurn(plan: MvpRealtimeTurnPlan | null, delayMs = 0): void {
    if (plan === null) return;
    if (endRequestedRef.current && plan.turnType !== 'closing') return;
    if (plan.turnType === 'closing' && !endRequestedRef.current) {
      endRequestedRef.current = true;
      clearScheduledRealtimeTurns();
      voice.stopPlayback();
    }
    if (desiredDeliveryIdRef.current !== plan.deliveryId) {
      clearScheduledRealtimeTurns();
      desiredDeliveryIdRef.current = plan.deliveryId;
    }
    const generation = realtimeTurnGenerationRef.current;
    const timeoutId = window.setTimeout(() => {
      scheduledTurnTimeoutsRef.current.delete(timeoutId);
      if (generation !== realtimeTurnGenerationRef.current) return;
      void speakRealtimeTurn(plan);
    }, delayMs);
    scheduledTurnTimeoutsRef.current.add(timeoutId);
  }

  function clearScheduledRealtimeTurns(): void {
    realtimeTurnGenerationRef.current += 1;
    for (const timeoutId of scheduledTurnTimeoutsRef.current) {
      window.clearTimeout(timeoutId);
    }
    scheduledTurnTimeoutsRef.current.clear();
    desiredDeliveryIdRef.current = null;
  }

  async function speakRealtimeTurn(plan: MvpRealtimeTurnPlan): Promise<void> {
    if (
      settledDeliveryIdsRef.current.has(plan.deliveryId) ||
      activeDeliveryIdRef.current === plan.deliveryId ||
      desiredDeliveryIdRef.current !== plan.deliveryId ||
      (endRequestedRef.current && plan.turnType !== 'closing')
    ) {
      return;
    }
    const currentSession = authoritativeSessionRef.current;
    if (
      (plan.turnType !== 'closing' && currentSession?.status !== 'active') ||
      (plan.turnType === 'closing' && currentSession?.status === 'completed')
    ) {
      return;
    }
    activeDeliveryIdRef.current = plan.deliveryId;
    const turnGeneration = realtimeTurnGenerationRef.current;
    try {
      const completed = await voice.requestResponse({
        instructions: exactSpeechInstructions(
          plan.text,
          currentSession?.language ?? prepared?.guide.sourceLanguage ?? 'de',
        ),
        deliveryId: plan.deliveryId,
        workflowRunId: plan.workflowRunId,
        questionId: plan.questionId,
        turnType: plan.turnType,
      });
      if (turnGeneration !== realtimeTurnGenerationRef.current) return;
      if (!completed && activeDeliveryIdRef.current === plan.deliveryId) {
        activeDeliveryIdRef.current = null;
      }
      if (!completed && plan.turnType === 'closing') {
        await resolveFailedRealtimeClosing(plan);
      }
    } catch (error: unknown) {
      if (turnGeneration !== realtimeTurnGenerationRef.current) return;
      if (activeDeliveryIdRef.current === plan.deliveryId) activeDeliveryIdRef.current = null;
      const rateLimitDelayMs = readVoiceRateLimitRetryDelay(error);
      if (rateLimitDelayMs !== null) {
        const attempts = (rateLimitRetryAttemptsRef.current.get(plan.deliveryId) ?? 0) + 1;
        if (attempts <= MAX_RATE_LIMIT_RETRIES_PER_DELIVERY) {
          rateLimitRetryAttemptsRef.current.set(plan.deliveryId, attempts);
          setConnection('connected');
          setMessage(null);
          if (desiredDeliveryIdRef.current === plan.deliveryId)
            scheduleRealtimeTurn(plan, rateLimitDelayMs);
          return;
        }
      }
      if (plan.turnType === 'closing') {
        try {
          await resolveFailedRealtimeClosing(plan);
          return;
        } catch {
          // Surface the original provider error when the terminal recovery also fails.
        }
      }
      setConnection('degraded');
      setMessage(readErrorMessage(error, t));
    }
  }

  async function resolveFailedRealtimeClosing(plan: MvpRealtimeTurnPlan): Promise<void> {
    if (prepared === null) return;
    const result = await enqueueVoicePersistence(() =>
      interviewApi.interruptRealtimeAiTurn(prepared.interviewId, {
        deliveryId: plan.deliveryId,
        clientEventId: crypto.randomUUID(),
        generatedText: '',
        confirmedSpokenText: '',
        occurredAt: new Date().toISOString(),
      }),
    );
    settleDelivery(plan.deliveryId);
    applyRealtimeResponse(result);
    setConnection('connected');
  }

  function settleDelivery(deliveryId: string): void {
    settledDeliveryIdsRef.current.add(deliveryId);
    rateLimitRetryAttemptsRef.current.delete(deliveryId);
    if (activeDeliveryIdRef.current === deliveryId) activeDeliveryIdRef.current = null;
  }

  function enqueueVoicePersistence<Result>(operation: () => Promise<Result>): Promise<Result> {
    const task = voicePersistenceQueueRef.current.then(operation);
    voicePersistenceQueueRef.current = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  async function sendAnswer(text: string): Promise<void> {
    if (prepared === null || session === null || phase !== 'listening') return;
    const answer = text.trim();
    if (answer.length === 0) return;
    setMessage(null);
    setPhase('processing');
    pendingCommandCountRef.current += 1;
    try {
      const response = await interviewApi.submitParticipantTextTurn(prepared.interviewId, {
        clientEventId: crypto.randomUUID(),
        text: answer,
        occurredAt: new Date().toISOString(),
      });
      applySession(response.session);
      setConnection('connected');
      if (response.session.status === 'active' && response.newAiTurns.length > 0) {
        setPhase('speaking');
        await wait(350);
        setPhase('listening');
      }
    } catch (error: unknown) {
      setConnection('degraded');
      setMessage(readErrorMessage(error, t));
      setPhase('listening');
    } finally {
      pendingCommandCountRef.current = Math.max(0, pendingCommandCountRef.current - 1);
    }
  }

  async function togglePause(): Promise<void> {
    if (prepared === null || (phase !== 'paused' && phase !== 'listening')) return;
    const action = phase === 'paused' ? 'resume' : 'pause';
    setMessage(null);
    pendingCommandCountRef.current += 1;
    try {
      const response = await interviewApi.performAction(prepared.interviewId, action);
      applySession(response.session);
      setConnection('connected');
      if (inputMode === 'voice') {
        if (action === 'pause') {
          voice.disconnect();
        } else {
          await reconnectRealtimeVoice(prepared.interviewId);
        }
      }
    } catch (error: unknown) {
      setConnection('degraded');
      setMessage(readErrorMessage(error, t));
    } finally {
      pendingCommandCountRef.current = Math.max(0, pendingCommandCountRef.current - 1);
    }
  }

  async function endInterview(): Promise<void> {
    if (prepared === null || endedAt !== null || endRequestedRef.current) return;
    endRequestedRef.current = true;
    setMessage(null);
    setPhase('processing');
    pendingCommandCountRef.current += 1;
    try {
      if (inputMode === 'voice') {
        clearScheduledRealtimeTurns();
        voice.stopPlayback();
        activeDeliveryIdRef.current = null;
        const response = await enqueueVoicePersistence(() =>
          interviewApi.completeRealtimeInterview(prepared.interviewId),
        );
        applyRealtimeResponse(response);
      } else {
        const response = await interviewApi.performAction(prepared.interviewId, 'end');
        applySession(response.session);
      }
      setConnection('connected');
    } catch (error: unknown) {
      endRequestedRef.current = false;
      setConnection('degraded');
      setMessage(readErrorMessage(error, t));
      setPhase(sessionStatusToPhase(session?.status ?? 'active'));
    } finally {
      pendingCommandCountRef.current = Math.max(0, pendingCommandCountRef.current - 1);
    }
  }

  function resetInterview(): void {
    onLanguageLock(null);
    clearScheduledRealtimeTurns();
    clearInterviewSession();
    setPrepared(null);
    setStartedAt(null);
    setEndedAt(null);
    setTurns([]);
    setPromptIndex(0);
    setPhase('ready');
    setConnection('connected');
    setSession(null);
    authoritativeSessionRef.current = null;
    activeInterviewIdRef.current = null;
    setMessage(null);
    setTranscriptOpen(false);
    setInputMode('text');
    setPartialVoiceText(null);
    voice.disconnect();
    pendingCommandCountRef.current = 0;
    voicePersistenceQueueRef.current = Promise.resolve();
    activeDeliveryIdRef.current = null;
    settledDeliveryIdsRef.current.clear();
    unconfirmedAiFailureCountRef.current = 0;
    endRequestedRef.current = false;
  }

  if (prepared !== null && endedAt !== null) {
    const sessionMatchesInterview = session?.interviewId === prepared.interviewId;
    return (
      <CompletionScreen
        guide={prepared.guide}
        interviewId={prepared.interviewId}
        startedAt={startedAt ?? endedAt}
        endedAt={endedAt}
        finalizedAt={sessionMatchesInterview ? session.finalizedAt : null}
        exportReady={isAuthoritativeTranscriptFinalized(session, prepared.interviewId)}
        interviewLanguage={
          sessionMatchesInterview ? session.language : guideLanguage(prepared.guide)
        }
        turns={turns}
        technicalGaps={sessionMatchesInterview ? session.technicalGaps : []}
        onRestart={resetInterview}
      />
    );
  }

  if (prepared !== null && startedAt !== null) {
    return (
      <MeetingScreen
        guide={prepared.guide}
        interviewId={prepared.interviewId}
        startedAt={startedAt}
        interviewLanguage={session?.language ?? guideLanguage(prepared.guide)}
        phase={phase}
        connection={connection}
        turns={turns}
        promptText={session?.currentQuestion?.text ?? null}
        progress={{
          current: Math.min(
            session === null ? promptIndex + 1 : interviewProgress(session),
            session?.totalQuestions ?? 1,
          ),
          total: session?.totalQuestions ?? countQuestions(prepared.guide),
        }}
        message={message}
        inputMode={inputMode}
        partialVoiceText={partialVoiceText}
        voiceState={voice.state}
        voiceConnected={isVoiceConnected(voice.state)}
        voiceMicrophoneEnabled={voice.microphoneEnabled}
        media={media}
        captionsEnabled={captionsEnabled}
        transcriptOpen={transcriptOpen}
        onCaptionsChange={setCaptionsEnabled}
        onTranscriptChange={setTranscriptOpen}
        onAnswer={sendAnswer}
        onVoiceControl={() => {
          if (voice.state === 'idle' || voice.state === 'failed') {
            setMessage(null);
            void reconnectRealtimeVoice(prepared.interviewId).catch((error: unknown) => {
              setMessage(readErrorMessage(error, t));
            });
          } else if (voice.state !== 'connecting') {
            voice.setMicrophoneEnabled(!voice.microphoneEnabled);
          }
        }}
        onPause={togglePause}
        onEnd={endInterview}
      />
    );
  }

  return (
    <PreparationScreen
      guide={prepared?.guide ?? guideSettings.guide}
      guides={guideSettings.guides}
      busy={busy || guideSettings.loading}
      message={
        message ?? (guideSettings.error === null ? null : readErrorMessage(guideSettings.error, t))
      }
      onSaveGuide={saveGuideSetting}
      languageLocked={prepared !== null}
      inputMode={inputMode}
      media={media}
      onInputModeChange={setInputMode}
      onFile={handleGuideFile}
      onStart={startInterview}
    />
  );
}

interface PreparationScreenProps {
  readonly guide: InterviewGuide | null;
  readonly guides: readonly GuideSummary[];
  readonly onSaveGuide: (guideId: string) => Promise<boolean>;
  readonly languageLocked: boolean;
  readonly busy: boolean;
  readonly message: string | null;
  readonly inputMode: InterviewInputMode;
  readonly media: ReturnType<typeof useMediaPreview>;
  readonly onInputModeChange: (mode: InterviewInputMode) => void;
  readonly onFile: (file: File) => Promise<string | null>;
  readonly onStart: () => Promise<void>;
}

function PreparationScreen(props: PreparationScreenProps) {
  const { formatNumber, t } = useI18n();
  const fileInput = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draftGuideId, setDraftGuideId] = useState(props.guide?.id ?? '');

  useEffect(() => {
    setDraftGuideId(props.guide?.id ?? '');
  }, [props.guide?.id]);
  useEffect(() => {
    if (settingsOpen) dialog.current?.showModal();
    else dialog.current?.close();
  }, [settingsOpen]);

  function handleInput(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    if (file !== undefined)
      void props.onFile(file).then((guideId) => {
        if (guideId !== null) setDraftGuideId(guideId);
      });
    event.target.value = '';
  }

  return (
    <main className="preparation-page">
      <header className="product-header">
        <div className="product-mark" aria-hidden="true">
          <Sparkles size={19} />
        </div>
        <div>
          <strong>Fieldwork</strong>
          <span>{t('interview.brand.subtitle')}</span>
        </div>
        <div className="header-actions">
          <LanguageSwitcher
            label={t('interview.language.interview')}
            disabled={props.busy || props.languageLocked}
          />
          <IconButton
            icon={Settings}
            label={t('interview.settings.title')}
            disabled={props.busy || props.languageLocked}
            onClick={() => setSettingsOpen(true)}
          />
          <div className="header-status">
            <span /> {t('interview.backend.ready')}
          </div>
        </div>
      </header>

      <dialog
        ref={dialog}
        className="interview-settings-dialog"
        aria-labelledby="interview-settings-title"
        onClose={() => setSettingsOpen(false)}
        onCancel={(event) => {
          if (props.busy) event.preventDefault();
        }}
      >
        <h2 id="interview-settings-title">{t('interview.settings.title')}</h2>
        <label className="settings-guide-select">
          {t('interview.settings.guide')}
          <select
            value={draftGuideId}
            disabled={props.busy}
            onChange={(event) => setDraftGuideId(event.target.value)}
          >
            <option value="" disabled>
              {t('interview.settings.guide')}
            </option>
            {props.guides.map((guide) => (
              <option value={guide.id} key={guide.id}>
                {guide.title} ({formatNumber(guide.mainQuestionCount)} +{' '}
                {formatNumber(guide.followUpQuestionCount)})
              </option>
            ))}
          </select>
        </label>
        <input
          ref={fileInput}
          hidden
          type="file"
          accept=".md,text/markdown,text/plain"
          onChange={handleInput}
        />
        <button
          className="text-button"
          type="button"
          disabled={props.busy}
          onClick={() => fileInput.current?.click()}
        >
          <Upload size={16} /> {t('interview.preparation.uploadTitle')}
        </button>
        {props.message !== null ? (
          <p className="inline-error" role="alert">
            {props.message}
          </p>
        ) : null}
        <div className="settings-actions">
          <button
            type="button"
            className="button"
            disabled={props.busy}
            onClick={() => setSettingsOpen(false)}
          >
            {t('interview.settings.close')}
          </button>
          <button
            type="button"
            className="button button--primary"
            disabled={props.busy || draftGuideId === ''}
            onClick={() =>
              void props.onSaveGuide(draftGuideId).then((saved) => {
                if (saved) setSettingsOpen(false);
              })
            }
          >
            {t('interview.settings.save')}
          </button>
        </div>
      </dialog>

      <section className="preparation-layout">
        <div className="preview-column">
          <div className="camera-preview">
            <video
              ref={props.media.videoRef}
              autoPlay
              muted
              playsInline
              className={props.media.cameraEnabled ? '' : 'camera-preview__video--hidden'}
            />
            {!props.media.cameraEnabled ? (
              <div className="camera-preview__empty">
                <span>{t('interview.participant.self')}</span>
              </div>
            ) : null}
            {props.media.pending ? <LoaderCircle className="spinner" size={24} /> : null}
            <div className="camera-preview__controls">
              <IconButton
                icon={props.media.microphoneEnabled ? Mic : MicOff}
                label={
                  props.media.microphoneEnabled
                    ? t('interview.device.microphone.off')
                    : t('interview.device.microphone.on')
                }
                active={props.media.microphoneEnabled}
                aria-pressed={props.media.microphoneEnabled}
                onClick={() => props.media.setMicrophoneEnabled(!props.media.microphoneEnabled)}
              />
              <IconButton
                icon={props.media.cameraEnabled ? Video : VideoOff}
                label={
                  props.media.cameraEnabled
                    ? t('interview.device.camera.off')
                    : t('interview.device.camera.on')
                }
                active={props.media.cameraEnabled}
                aria-pressed={props.media.cameraEnabled}
                onClick={() => props.media.setCameraEnabled(!props.media.cameraEnabled)}
              />
            </div>
          </div>
          {props.media.error !== null ? (
            <p className="inline-error" role="alert">
              {t(mediaErrorMessageKey(props.media.error))}
            </p>
          ) : null}
          <div className="device-row">
            <label>
              <Mic size={16} aria-hidden="true" />
              <select
                aria-label={t('interview.device.microphone.select')}
                value={props.media.microphoneDeviceId}
                onChange={(event) => props.media.setMicrophoneDeviceId(event.target.value)}
              >
                {props.media.microphones.length === 0 ? (
                  <option value="">{t('interview.device.microphone.default')}</option>
                ) : null}
                {props.media.microphones.map((device) => (
                  <option value={device.deviceId} key={device.deviceId}>
                    {device.label ??
                      t('interview.device.microphone.numbered', {
                        number: formatNumber(device.ordinal),
                      })}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <Video size={16} aria-hidden="true" />
              <select
                aria-label={t('interview.device.camera.select')}
                value={props.media.cameraDeviceId}
                onChange={(event) => props.media.setCameraDeviceId(event.target.value)}
              >
                {props.media.cameras.length === 0 ? (
                  <option value="">{t('interview.device.camera.default')}</option>
                ) : null}
                {props.media.cameras.map((device) => (
                  <option value={device.deviceId} key={device.deviceId}>
                    {device.label ??
                      t('interview.device.camera.numbered', {
                        number: formatNumber(device.ordinal),
                      })}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <div className="join-column">
          <p className="eyebrow">{t('interview.preparation.eyebrow')}</p>
          <h1>{t('interview.preparation.title')}</h1>
          <p className="intro-copy">{t('interview.preparation.intro')}</p>

          <p className="configured-guide" lang={props.guide?.sourceLanguage}>
            {props.guide === null
              ? t(props.busy ? 'interview.settings.loading' : 'interview.settings.unavailable')
              : props.guide.title}
          </p>

          <div className="mode-control" aria-label={t('interview.preparation.modeLabel')}>
            <button
              type="button"
              className={props.inputMode === 'text' ? 'is-selected' : ''}
              onClick={() => props.onInputModeChange('text')}
              aria-pressed={props.inputMode === 'text'}
            >
              <FileText size={17} /> {t('interview.preparation.modeText')}
            </button>
            <button
              type="button"
              className={props.inputMode === 'voice' ? 'is-selected' : ''}
              onClick={() => props.onInputModeChange('voice')}
              aria-pressed={props.inputMode === 'voice'}
            >
              <Mic size={17} /> {t('interview.preparation.modeVoice')}
            </button>
          </div>
          {props.inputMode === 'voice' ? (
            <div className="provider-notice" role="status">
              <Mic size={18} />
              <span>
                <strong>{t('interview.preparation.voiceProvider')}</strong>
                {t('interview.preparation.voiceNotice')}
              </span>
            </div>
          ) : null}
          {props.message !== null ? (
            <p className="status-message" role="status">
              {props.message}
            </p>
          ) : null}

          <button
            className="button button--primary button--join"
            type="button"
            disabled={props.guide === null || props.busy}
            onClick={() => void props.onStart()}
          >
            {props.busy ? <LoaderCircle className="spinner" size={20} /> : <MonitorUp size={20} />}
            {t('interview.preparation.start')}
          </button>
        </div>
      </section>
    </main>
  );
}

interface MeetingScreenProps {
  readonly guide: InterviewGuide;
  readonly interviewId: string;
  readonly startedAt: string;
  readonly interviewLanguage: SupportedLocale;
  readonly phase: InterviewPhase;
  readonly connection: ConnectionState;
  readonly turns: readonly DisplayTranscriptTurn[];
  readonly promptText: string | null;
  readonly progress: { readonly current: number; readonly total: number };
  readonly message: string | null;
  readonly inputMode: InterviewInputMode;
  readonly partialVoiceText: string | null;
  readonly voiceState: OpenAiVoiceState;
  readonly voiceConnected: boolean;
  readonly voiceMicrophoneEnabled: boolean;
  readonly media: ReturnType<typeof useMediaPreview>;
  readonly captionsEnabled: boolean;
  readonly transcriptOpen: boolean;
  readonly onCaptionsChange: (enabled: boolean) => void;
  readonly onTranscriptChange: (open: boolean) => void;
  readonly onAnswer: (text: string) => Promise<void>;
  readonly onVoiceControl: () => void;
  readonly onPause: () => Promise<void>;
  readonly onEnd: () => Promise<void>;
}

function MeetingScreen(props: MeetingScreenProps) {
  const { formatNumber, t } = useI18n();
  const [answer, setAnswer] = useState('');
  const elapsed = useElapsed(props.startedAt, props.phase === 'paused');
  const latestAiTurn = [...props.turns].reverse().find((turn) => turn.speaker === 'ai_interviewer');

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (answer.trim().length === 0 || props.phase !== 'listening') return;
    const submitted = answer;
    setAnswer('');
    void props.onAnswer(submitted);
  }

  return (
    <main className="meeting-page">
      <header className="meeting-header">
        <div className="meeting-title">
          <span className="record-dot" />{' '}
          <strong lang={props.interviewLanguage}>{props.guide.title}</strong>
          <span>{shortId(props.interviewId)}</span>
        </div>
        <div className="meeting-header__status">
          <span className="interview-language-badge">
            {t('interview.language.locked', {
              language: languageName(t, props.interviewLanguage),
            })}
          </span>
          <div className={`connection connection--${props.connection}`}>
            <span />
            {connectionLabel(props.connection, t)}
          </div>
        </div>
        <time>{elapsed}</time>
      </header>

      <div
        className={`meeting-workspace${props.transcriptOpen ? ' meeting-workspace--panel' : ''}`}
      >
        <div className="meeting-canvas">
          <AiInterviewer
            phase={props.phase}
            caption={latestAiTurn?.text ?? props.promptText}
            captionsEnabled={props.captionsEnabled}
            language={props.interviewLanguage}
          />
          <div className="meeting-state" aria-live="polite">
            <span className={`meeting-state__dot meeting-state__dot--${props.phase}`} />
            {meetingStateLabel(props.phase, props.inputMode, props.voiceState, t)}
            <small>
              {t('interview.meeting.progress', {
                current: formatNumber(props.progress.current),
                total: formatNumber(props.progress.total),
              })}
            </small>
          </div>
          {props.message !== null ? (
            <div className="meeting-error" role="alert">
              {props.message}
            </div>
          ) : null}
          <div className="self-view">
            <video
              ref={props.media.videoRef}
              autoPlay
              muted
              playsInline
              className={props.media.cameraEnabled ? '' : 'self-view__video--hidden'}
            />
            {!props.media.cameraEnabled ? (
              <div className="self-view__empty">{t('interview.participant.self')}</div>
            ) : null}
            <span className="self-view__label">{t('interview.participant.self')}</span>
          </div>
          {props.inputMode === 'text' ? (
            <form className="answer-composer" onSubmit={submit}>
              <textarea
                value={answer}
                onChange={(event) => setAnswer(event.target.value)}
                rows={2}
                maxLength={20_000}
                disabled={props.phase !== 'listening'}
                aria-label={t('interview.meeting.answer.label')}
                placeholder={
                  props.phase === 'paused'
                    ? t('interview.meeting.answer.paused')
                    : props.phase === 'processing'
                      ? t('interview.meeting.answer.processing')
                      : t('interview.meeting.answer.placeholder')
                }
              />
              <button
                type="submit"
                aria-label={t('interview.meeting.answer.send')}
                title={t('interview.meeting.answer.send')}
                disabled={answer.trim().length === 0 || props.phase !== 'listening'}
              >
                <Send size={20} />
              </button>
            </form>
          ) : (
            <div className="voice-transcript" aria-live="polite">
              <Mic size={18} aria-hidden="true" />
              <span lang={props.partialVoiceText === null ? undefined : props.interviewLanguage}>
                {props.partialVoiceText ??
                  (props.voiceConnected
                    ? props.voiceMicrophoneEnabled
                      ? props.phase === 'processing'
                        ? t('interview.meeting.voice.processing')
                        : t('interview.meeting.voice.listening')
                      : t('interview.meeting.voice.muted')
                    : t('interview.meeting.voice.disconnected'))}
              </span>
            </div>
          )}
        </div>
        {props.transcriptOpen ? (
          <TranscriptPanel
            language={props.interviewLanguage}
            turns={props.turns}
            onClose={() => props.onTranscriptChange(false)}
          />
        ) : null}
      </div>

      <footer className="meeting-controls">
        <div className="meeting-controls__left">
          <span>
            {props.inputMode === 'voice'
              ? t('interview.meeting.mode.voice')
              : t('interview.meeting.mode.text')}
          </span>
        </div>
        <div className="meeting-controls__center">
          {props.inputMode === 'voice' ? (
            <IconButton
              icon={
                props.voiceConnected &&
                props.voiceMicrophoneEnabled &&
                props.voiceState !== 'failed'
                  ? Mic
                  : MicOff
              }
              label={
                props.voiceState === 'idle' || props.voiceState === 'failed'
                  ? t('interview.meeting.voice.connect')
                  : props.voiceMicrophoneEnabled
                    ? t('interview.device.microphone.off')
                    : t('interview.device.microphone.on')
              }
              active={props.voiceConnected && props.voiceMicrophoneEnabled}
              aria-pressed={props.voiceConnected && props.voiceMicrophoneEnabled}
              disabled={props.voiceState === 'connecting'}
              onClick={props.onVoiceControl}
            />
          ) : (
            <IconButton
              icon={props.media.microphoneEnabled ? Mic : MicOff}
              label={
                props.media.microphoneEnabled
                  ? t('interview.device.microphone.off')
                  : t('interview.device.microphone.on')
              }
              active={props.media.microphoneEnabled}
              aria-pressed={props.media.microphoneEnabled}
              onClick={() => props.media.setMicrophoneEnabled(!props.media.microphoneEnabled)}
            />
          )}
          <IconButton
            icon={props.media.cameraEnabled ? Video : VideoOff}
            label={
              props.media.cameraEnabled
                ? t('interview.device.camera.off')
                : t('interview.device.camera.on')
            }
            active={props.media.cameraEnabled}
            aria-pressed={props.media.cameraEnabled}
            onClick={() => props.media.setCameraEnabled(!props.media.cameraEnabled)}
          />
          <IconButton
            icon={Captions}
            label={
              props.captionsEnabled
                ? t('interview.meeting.captions.off')
                : t('interview.meeting.captions.on')
            }
            active={props.captionsEnabled}
            aria-pressed={props.captionsEnabled}
            onClick={() => props.onCaptionsChange(!props.captionsEnabled)}
          />
          <IconButton
            icon={FileText}
            label={
              props.transcriptOpen
                ? t('interview.meeting.transcript.close')
                : t('interview.meeting.transcript.open')
            }
            active={props.transcriptOpen}
            aria-pressed={props.transcriptOpen}
            onClick={() => props.onTranscriptChange(!props.transcriptOpen)}
          />
          <IconButton
            icon={props.phase === 'paused' ? Play : Pause}
            label={
              props.phase === 'paused'
                ? t('interview.meeting.resume')
                : t('interview.meeting.pause')
            }
            active={props.phase === 'paused'}
            disabled={props.phase === 'processing'}
            onClick={() => void props.onPause()}
          />
          <IconButton
            icon={CircleStop}
            label={t('interview.meeting.end')}
            danger
            onClick={() => void props.onEnd()}
          />
        </div>
        <div className="meeting-controls__right">
          {countLabel(t, 'interview.meeting.turnCount', props.turns.length, formatNumber)}
        </div>
      </footer>
    </main>
  );
}

interface CompletionScreenProps {
  readonly guide: InterviewGuide;
  readonly interviewId: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly finalizedAt: string | null;
  readonly exportReady: boolean;
  readonly interviewLanguage: SupportedLocale;
  readonly turns: readonly DisplayTranscriptTurn[];
  readonly technicalGaps: readonly MvpTranscriptGap[];
  readonly onRestart: () => void;
}

function CompletionScreen(props: CompletionScreenProps) {
  const { formatDateTime, t } = useI18n();
  const duration = formatDuration(Date.parse(props.endedAt) - Date.parse(props.startedAt));
  const entries = orderedTranscriptEntries(props.turns, props.technicalGaps);
  function download(format: TranscriptExportFormat): void {
    if (!props.exportReady) return;
    downloadTranscript({
      format,
      guide: props.guide,
      interviewId: props.interviewId,
      language: props.interviewLanguage,
      startedAt: props.startedAt,
      endedAt: props.endedAt,
      turns: props.turns,
      technicalGaps: props.technicalGaps,
    });
  }
  return (
    <main className="completion-page">
      <header className="product-header product-header--completion">
        <div className="product-mark">
          <Sparkles size={19} />
        </div>
        <div>
          <strong>Fieldwork</strong>
          <span>{t('interview.brand.subtitle')}</span>
        </div>
        <div className="header-actions">
          <span className="interview-language-badge interview-language-badge--light">
            {t('interview.language.locked', {
              language: languageName(t, props.interviewLanguage),
            })}
          </span>
          <LanguageSwitcher label={t('interview.language.ui')} />
        </div>
      </header>
      <section className="completion-summary">
        <div className="completion-check">
          <Check size={32} />
        </div>
        <p className="eyebrow">{t('interview.completion.eyebrow')}</p>
        <h1 lang={props.interviewLanguage}>{props.guide.title}</h1>
        <p>{t('interview.completion.summary')}</p>
        <dl>
          <div>
            <dt>{t('interview.completion.interviewId')}</dt>
            <dd>{props.interviewId}</dd>
          </div>
          <div>
            <dt>{t('interview.completion.duration')}</dt>
            <dd>{duration}</dd>
          </div>
          <div>
            <dt>{t('interview.completion.turns')}</dt>
            <dd>{props.turns.length}</dd>
          </div>
        </dl>
        <div className="export-actions">
          <button
            type="button"
            className="button button--secondary"
            disabled={!props.exportReady}
            title={props.exportReady ? undefined : t('interview.completion.exportPendingTitle')}
            onClick={() => download('markdown')}
          >
            <Download size={18} /> Markdown
          </button>
          <button
            type="button"
            className="button button--secondary"
            disabled={!props.exportReady}
            title={props.exportReady ? undefined : t('interview.completion.exportPendingTitle')}
            onClick={() => download('json')}
          >
            <FileJson size={18} /> JSON
          </button>
          <button
            type="button"
            className="button button--secondary"
            disabled={!props.exportReady}
            title={props.exportReady ? undefined : t('interview.completion.exportPendingTitle')}
            onClick={() => download('text')}
          >
            <FileText size={18} /> Text
          </button>
          {props.finalizedAt === null ? (
            <span
              className="button button--primary button--disabled"
              aria-disabled="true"
              title={t('interview.completion.evaluationPendingTitle')}
            >
              <MonitorUp size={18} /> {t('interview.completion.evaluationPending')}
            </span>
          ) : (
            <a
              className="button button--primary"
              href={monitoringEvaluationUrl(props.interviewId)}
              rel="noreferrer"
              target="_blank"
            >
              <MonitorUp size={18} /> {t('interview.completion.openEvaluation')}
            </a>
          )}
        </div>
        <button type="button" className="text-button restart-button" onClick={props.onRestart}>
          <RotateCcw size={16} /> {t('interview.completion.restart')}
        </button>
      </section>
      <section className="final-transcript" aria-label={t('interview.completion.transcriptAria')}>
        <header>
          <div>
            <p className="eyebrow">{t('interview.completion.artifact')}</p>
            <h2>{t('interview.completion.transcriptTitle')}</h2>
          </div>
          <span>
            {props.finalizedAt === null ? (
              <>{t('interview.completion.finalizationPending')}</>
            ) : (
              <>
                <Check size={14} /> {t('interview.completion.finalized')}
              </>
            )}
          </span>
        </header>
        <div>
          {entries.map((entry) =>
            entry.kind === 'turn' ? (
              <article key={entry.value.id}>
                <div>
                  <strong>
                    {entry.value.speaker === 'ai_interviewer'
                      ? t('interview.completion.speaker.ai')
                      : t('interview.completion.speaker.participant')}
                  </strong>
                  <time dateTime={entry.value.occurredAt}>
                    {formatDateTime(entry.value.occurredAt)}
                  </time>
                </div>
                <p lang={props.interviewLanguage}>{entry.value.text}</p>
              </article>
            ) : (
              <article className="final-transcript__gap" key={entry.value.gapId}>
                <div>
                  <strong>{t('interview.completion.technicalGap')}</strong>
                  <time dateTime={entry.value.occurredAt}>
                    {formatDateTime(entry.value.occurredAt)}
                  </time>
                </div>
                <p lang={props.interviewLanguage}>{entry.value.description}</p>
              </article>
            ),
          )}
        </div>
      </section>
    </main>
  );
}

function monitoringEvaluationUrl(interviewId: string): string {
  const configuredOrigin = import.meta.env.VITE_MONITORING_ORIGIN?.trim();
  const url = monitoringOrigin(configuredOrigin);
  url.pathname = '/';
  url.search = '';
  url.searchParams.set('interview', interviewId);
  url.searchParams.set('view', 'report');
  url.hash = 'evaluation';
  return url.toString();
}

function monitoringOrigin(configuredOrigin: string | undefined): URL {
  if (configuredOrigin !== undefined && configuredOrigin.length > 0) {
    try {
      return new URL(configuredOrigin, window.location.href);
    } catch {
      // Fall through to the adjacent local frontend port.
    }
  }
  const url = new URL(window.location.href);
  const currentPort = Number(url.port);
  if (Number.isInteger(currentPort) && currentPort > 0 && currentPort < 65_535) {
    url.port = String(currentPort + 1);
  }
  return url;
}

function useElapsed(startedAt: string, paused: boolean): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (paused) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [paused]);
  return formatDuration(now - Date.parse(startedAt));
}

function countQuestions(guide: InterviewGuide | null): number {
  if (guide === null) return 0;
  return guide.sections.reduce(
    (total, section) =>
      total +
      section.mainQuestions.reduce(
        (sectionTotal, question) => sectionTotal + 1 + question.followUpQuestions.length,
        0,
      ),
    0,
  );
}

function guideLanguage(guide: InterviewGuide): SupportedLocale {
  return guide.sourceLanguage ?? 'de';
}

const countMessageKeys = {
  'interview.meeting.turnCount': {
    one: 'interview.meeting.turnCount.one',
    many: 'interview.meeting.turnCount.many',
  },
  'interview.preparation.questionCount': {
    one: 'interview.preparation.questionCount.one',
    many: 'interview.preparation.questionCount.many',
  },
  'interview.preparation.sectionCount': {
    one: 'interview.preparation.sectionCount.one',
    many: 'interview.preparation.sectionCount.many',
  },
} as const satisfies Readonly<
  Record<string, { readonly one: MessageKey; readonly many: MessageKey }>
>;

function countLabel(
  t: Translate,
  kind: keyof typeof countMessageKeys,
  count: number,
  numberFormatter: (value: number) => string,
): string {
  const keys = countMessageKeys[kind];
  return t(count === 1 ? keys.one : keys.many, { count: numberFormatter(count) });
}

function languageName(t: Translate, language: SupportedLocale): string {
  return t(language === 'de' ? 'common.localeName.de' : 'common.localeName.en');
}

function mediaErrorMessageKey(error: MediaPreviewErrorCode): MessageKey {
  const keys: Readonly<Record<MediaPreviewErrorCode, MessageKey>> = {
    enumeration_failed: 'interview.device.error.enumeration',
    permission_denied: 'interview.device.error.permission',
    unsupported: 'interview.device.error.unsupported',
  };
  return keys[error];
}

function phaseLabel(phase: InterviewPhase, t: Translate): string {
  switch (phase) {
    case 'ready':
      return t('interview.meeting.phase.ready');
    case 'listening':
      return t('interview.meeting.phase.listening');
    case 'processing':
      return t('interview.meeting.phase.processing');
    case 'speaking':
      return t('interview.meeting.phase.speaking');
    case 'paused':
      return t('interview.meeting.phase.paused');
    case 'completed':
      return t('interview.meeting.phase.completed');
  }
}

function meetingStateLabel(
  phase: InterviewPhase,
  inputMode: InterviewInputMode,
  voiceState: OpenAiVoiceState,
  t: Translate,
): string {
  if (inputMode === 'voice') {
    if (voiceState === 'failed') return t('interview.meeting.voice.failed');
    if (voiceState === 'idle') return t('interview.meeting.voice.idle');
    if (voiceState === 'connecting') return t('interview.meeting.voice.connecting');
  }
  return phaseLabel(phase, t);
}

function connectionLabel(state: ConnectionState, t: Translate): string {
  if (state === 'connected') return t('interview.meeting.connection.connected');
  return t('interview.meeting.connection.degraded');
}

export function readErrorMessage(error: unknown, t: Translate): string {
  if (!(error instanceof InterviewApiError)) {
    if (!(error instanceof Error)) return t('interview.error.generic');
    if (error.message === 'VOICE_RATE_LIMITED' || error.message.startsWith('VOICE_RATE_LIMITED:')) {
      return t('interview.error.voiceRateLimited');
    }
    return error.message.startsWith('VOICE_')
      ? t('interview.error.voice')
      : t('interview.error.generic');
  }
  const messageKeyByCode: Readonly<Record<string, MessageKey>> = {
    CLIENT_UPDATE_REQUIRED: 'interview.error.clientUpdate',
    GUIDE_INVALID: 'interview.error.guideInvalid',
    INTERVIEW_STATE_CONFLICT: 'interview.error.stateConflict',
    INVALID_RESPONSE: 'interview.error.invalidResponse',
    NETWORK_ERROR: 'interview.error.network',
    NOT_FOUND: 'interview.error.notFound',
    PROVIDER_ERROR: 'interview.error.voice',
    RATE_LIMITED: 'interview.error.voiceRateLimited',
    VOICE_CONFIGURATION_INVALID: 'interview.error.voiceConfigurationInvalid',
    VOICE_CONFIGURATION_MISSING: 'interview.error.voiceConfiguration',
  };
  return t(messageKeyByCode[error.code] ?? 'interview.error.generic');
}

function shortId(id: string): string {
  return id.length <= 12 ? id : `${id.slice(0, 8)}…`;
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':');
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

interface SessionSetters {
  readonly setSession: (session: MvpInterviewSession) => void;
  readonly setStartedAt: (timestamp: string | null) => void;
  readonly setEndedAt: (timestamp: string | null) => void;
  readonly setTurns: (turns: readonly DisplayTranscriptTurn[]) => void;
  readonly setPromptIndex: (index: number) => void;
  readonly setPhase: (phase: InterviewPhase) => void;
}

function applyAuthoritativeSession(session: MvpInterviewSession, setters: SessionSetters): void {
  setters.setSession(session);
  setters.setStartedAt(session.startedAt);
  setters.setEndedAt(session.endedAt);
  setters.setPromptIndex(session.currentQuestionIndex);
  setters.setTurns(session.transcript.map(toDisplayTurn));
  setters.setPhase(sessionStatusToPhase(session.status));
}

function toDisplayTurn(turn: MvpTranscriptTurn): DisplayTranscriptTurn {
  return {
    id: turn.turnId,
    sequenceNumber: turn.sequenceNumber,
    speaker: turn.speaker,
    turnType: turn.turnType,
    text: turn.text,
    occurredAt: turn.occurredAt,
    guideReference: turn.guideReference,
    interrupted: turn.interrupted,
  };
}

function sessionStatusToPhase(status: MvpInterviewSession['status']): InterviewPhase {
  switch (status) {
    case 'ready':
      return 'ready';
    case 'active':
      return 'listening';
    case 'paused':
      return 'paused';
    case 'completed':
      return 'completed';
  }
}

function voiceStateToPhase(state: ReturnType<typeof useOpenAiVoice>['state']): InterviewPhase {
  switch (state) {
    case 'connecting':
    case 'processing':
      return 'processing';
    case 'speaking':
      return 'speaking';
    case 'listening':
      return 'listening';
    case 'idle':
    case 'failed':
      return 'listening';
  }
}

function hasLatestParticipantTurn(session: MvpInterviewSession): boolean {
  return session.transcript.at(-1)?.speaker === 'participant';
}

function isVoiceConnected(state: OpenAiVoiceState): boolean {
  return state === 'listening' || state === 'processing' || state === 'speaking';
}
