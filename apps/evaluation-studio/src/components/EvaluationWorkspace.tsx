import type { EvaluableInterview } from '@orgscience/api-client';
import { useI18n } from '@orgscience/frontend-i18n';
import type {
  EvaluationProfileSummary,
  MvpTranscriptTurn,
  ProfileEvaluationExportFormat,
  ProfileEvaluationSnapshot,
  SupportedLocale,
} from '@orgscience/contracts';
import { AlertTriangle, Download, MessageSquareText } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';

import {
  downloadEvaluationArtifact,
  downloadInterviewTranscriptMarkdown,
  interviewDisplayName,
  type EvaluationStudioApi,
} from '../studio-api.js';
import { EvaluationReportView } from './EvaluationReportView.js';
import {
  EvaluationRunner,
  preferredEvaluableInterviewId,
  type EvaluationRunnerOperation,
} from './EvaluationRunner.js';
import { InterviewDirectory } from './InterviewDirectory.js';
import {
  DeleteInterviewDialog,
  RenameInterviewDialog,
  interviewManagementError,
} from './InterviewManagementDialogs.js';

const RUN_POLL_INTERVAL_MS = 1_250;
const SOURCE_READ_ATTEMPTS = 3;

const WORKSPACE_COPY = {
  de: {
    loadInterviewsFailed:
      'Die Interviews mit gespeicherten Antworten konnten nicht geladen werden.',
    loadResultFailed: 'Das persistierte Ergebnis konnte nicht geladen werden.',
    refreshStatusFailed: 'Der Auswertungsstatus konnte nicht aktualisiert werden.',
    refreshResultFailed: 'Das Ergebnis konnte nicht aktualisiert werden.',
    saveProfileFirst: 'Speichere oder verwirf die Profiländerungen vor dem Testlauf.',
    runFailed: 'Die Auswertung konnte nicht ausgeführt werden.',
    exportFailed: 'Der Export konnte nicht erstellt werden.',
    profileDirectoryFailed: 'Die Bewertungsprofile konnten nicht geladen werden.',
    evaluationFailed: 'Auswertung fehlgeschlagen',
    failureDescription: {
      aborted: 'Die Auswertung wurde abgebrochen.',
      timeout: 'Die Auswertung hat das Zeitlimit überschritten.',
      rate_limited: 'Der Modellanbieter hat die Anfrage vorübergehend begrenzt.',
      provider_error: 'Der Modellanbieter konnte die Auswertung nicht abschließen.',
      invalid_input: 'Die Auswertungsdaten sind ungültig.',
      invalid_output: 'Die Modellausgabe konnte nicht sicher validiert werden.',
      guardrail_rejected:
        'Die Auswertung wurde durch eine wissenschaftliche Schutzregel abgelehnt.',
      unknown: 'Die Auswertung konnte nicht abgeschlossen werden.',
    },
    errorCode: 'Fehlercode',
    retryAvailable: 'Erneuter Versuch möglich',
    canonicalSource: 'Kanonische Quelle',
    finalTranscript: 'Finales Transkript',
    savedTranscript: 'Bisheriges Transkript',
    turns: (count: number) => `${String(count)} Turns`,
    participant: 'Interviewpartner',
    interviewer: 'AI-Interviewer',
    turn: (sequence: number) => `Turn #${String(sequence)}`,
    exportTranscript: 'Transkript als Markdown herunterladen',
  },
  en: {
    loadInterviewsFailed: 'The interviews with saved answers could not be loaded.',
    loadResultFailed: 'The persisted result could not be loaded.',
    refreshStatusFailed: 'The evaluation status could not be refreshed.',
    refreshResultFailed: 'The result could not be refreshed.',
    saveProfileFirst: 'Save or discard the profile changes before the test run.',
    runFailed: 'The evaluation could not be run.',
    exportFailed: 'The export could not be created.',
    profileDirectoryFailed: 'The evaluation profiles could not be loaded.',
    evaluationFailed: 'Evaluation failed',
    failureDescription: {
      aborted: 'The evaluation was cancelled.',
      timeout: 'The evaluation exceeded its time limit.',
      rate_limited: 'The model provider temporarily rate-limited the request.',
      provider_error: 'The model provider could not complete the evaluation.',
      invalid_input: 'The evaluation input is invalid.',
      invalid_output: 'The model output could not be validated safely.',
      guardrail_rejected: 'A scientific guardrail rejected the evaluation.',
      unknown: 'The evaluation could not be completed.',
    },
    errorCode: 'Error code',
    retryAvailable: 'Retry available',
    canonicalSource: 'Canonical source',
    finalTranscript: 'Final transcript',
    savedTranscript: 'Transcript so far',
    turns: (count: number) => `${String(count)} turns`,
    participant: 'Participant',
    interviewer: 'AI interviewer',
    turn: (sequence: number) => `Turn #${String(sequence)}`,
    exportTranscript: 'Download transcript as Markdown',
  },
} as const;

export interface EvaluationWorkspaceProps {
  readonly api: EvaluationStudioApi;
  readonly profiles: readonly EvaluationProfileSummary[];
  readonly profilesLoading: boolean;
  readonly profileDirectoryError: string | null;
  readonly dirtyProfile: boolean;
  readonly selectedProfileId: string | null;
}

export function EvaluationWorkspace({
  api,
  profiles,
  profilesLoading,
  profileDirectoryError,
  dirtyProfile,
  selectedProfileId,
}: EvaluationWorkspaceProps): ReactNode {
  const { locale } = useI18n();
  const initialSelection = useMemo(readRunnerSelection, []);
  const [interviews, setInterviews] = useState<readonly EvaluableInterview[]>([]);
  const [loadingInterviews, setLoadingInterviews] = useState(true);
  const [selectedInterviewId, setSelectedInterviewId] = useState<string | null>(
    initialSelection.interviewId,
  );
  const [evaluation, setEvaluation] = useState<ProfileEvaluationSnapshot | null>(null);
  const [evaluationScopeKey, setEvaluationScopeKey] = useState<string | null>(null);
  const [operation, setOperation] = useState<EvaluationRunnerOperation>('load_interviews');
  const [error, setError] = useState<string | null>(null);
  const [activeExport, setActiveExport] = useState<ProfileEvaluationExportFormat | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [managementDialog, setManagementDialog] = useState<{
    readonly kind: 'rename' | 'delete';
    readonly interview: EvaluableInterview;
  } | null>(null);
  const [managementError, setManagementError] = useState<string | null>(null);
  const interviewRequest = useRef(0);
  const evaluationRequest = useRef(0);
  const copy = WORKSPACE_COPY[locale];
  const errorCopy = useRef(copy);
  useEffect(() => {
    errorCopy.current = copy;
  }, [copy]);

  const loadInterviews = useCallback(async (): Promise<void> => {
    const request = ++interviewRequest.current;
    setLoadingInterviews(true);
    setOperation((current) => current ?? 'load_interviews');
    setError(null);
    try {
      const loaded = await api.listEvaluableInterviews();
      if (request !== interviewRequest.current) return;
      setInterviews(loaded);
      setSelectedInterviewId((current) =>
        current !== null && hasInterview(loaded, current)
          ? current
          : preferredEvaluableInterviewId(loaded),
      );
    } catch (reason: unknown) {
      if (request !== interviewRequest.current) return;
      setInterviews([]);
      setSelectedInterviewId(null);
      setError(safeErrorMessage(reason, errorCopy.current.loadInterviewsFailed));
    } finally {
      if (request === interviewRequest.current) {
        setLoadingInterviews(false);
        setOperation((current) => (current === 'load_interviews' ? null : current));
      }
    }
  }, [api]);

  useEffect(() => {
    void loadInterviews();
    return () => {
      interviewRequest.current += 1;
      evaluationRequest.current += 1;
    };
  }, [loadInterviews]);

  const selectedProfileUpdatedAt =
    profiles.find((candidate) => candidate.profileId === selectedProfileId)?.updatedAt ?? null;
  const selectedInterview =
    interviews.find(({ summary }) => summary.interviewId === selectedInterviewId) ?? null;
  const selectionReady =
    !profilesLoading &&
    selectedInterview !== null &&
    selectedProfileId !== null &&
    selectedProfileUpdatedAt !== null;
  const selectionKey =
    selectionReady && selectedInterview !== null && selectedProfileId !== null
      ? evaluationSourceKey(selectedInterview, selectedProfileId, selectedProfileUpdatedAt)
      : null;
  const scopedEvaluation = evaluationForSelection({
    evaluation,
    evaluationScopeKey,
    selectionKey,
    interviewId: selectedInterviewId,
    profileId: selectedProfileId,
  });

  useEffect(() => {
    writeRunnerSelection(selectedInterviewId, selectedProfileId);
  }, [selectedInterviewId, selectedProfileId]);

  useEffect(() => {
    if (!selectionReady || selectedInterviewId === null || selectedProfileId === null) {
      evaluationRequest.current += 1;
      setEvaluation(null);
      setEvaluationScopeKey(null);
      setOperation((current) => (current === 'load_evaluation' ? null : current));
      return;
    }

    const request = ++evaluationRequest.current;
    const controller = new AbortController();
    setEvaluation(null);
    setEvaluationScopeKey(null);
    setError(null);
    setExportError(null);
    setOperation('load_evaluation');
    void loadCurrentEvaluationSource(api, selectedInterviewId, selectedProfileId, controller.signal)
      .then((current) => {
        if (request === evaluationRequest.current && selectionKey !== null) {
          setInterviews(current.interviews);
          setEvaluation(current.evaluation);
          setEvaluationScopeKey(
            evaluationSourceKey(current.interview, selectedProfileId, selectedProfileUpdatedAt),
          );
        }
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted || request !== evaluationRequest.current) return;
        setError(safeErrorMessage(reason, errorCopy.current.loadResultFailed));
      })
      .finally(() => {
        if (request === evaluationRequest.current) {
          setOperation((current) => (current === 'load_evaluation' ? null : current));
        }
      });

    return () => {
      controller.abort();
      if (request === evaluationRequest.current) evaluationRequest.current += 1;
    };
  }, [
    api,
    selectedInterviewId,
    selectedProfileId,
    selectedProfileUpdatedAt,
    selectionKey,
    selectionReady,
  ]);

  useEffect(() => {
    if (
      scopedEvaluation?.status !== 'running' ||
      operation !== null ||
      selectedInterviewId === null ||
      selectedProfileId === null
    ) {
      return;
    }
    const scope = evaluationRequest.current;
    const controller = new AbortController();
    void pollUntilTerminal({
      signal: controller.signal,
      wait: () => abortableDelay(RUN_POLL_INTERVAL_MS, controller.signal),
      load: async () => {
        const snapshot = await api.getEvaluation(
          selectedInterviewId,
          selectedProfileId,
          controller.signal,
        );
        if (snapshot.status === 'running') return { status: 'running', current: null };
        const current = await loadCurrentEvaluationSource(
          api,
          selectedInterviewId,
          selectedProfileId,
          controller.signal,
        );
        return { status: current.evaluation.status, current };
      },
      onError: (reason) => {
        if (scope === evaluationRequest.current) {
          setError(safeErrorMessage(reason, errorCopy.current.refreshStatusFailed));
        }
      },
      onRecovered: () => {
        if (scope === evaluationRequest.current) setError(null);
      },
    }).then((snapshot) => {
      if (
        snapshot?.current !== null &&
        snapshot?.current !== undefined &&
        scope === evaluationRequest.current &&
        selectionKey !== null
      ) {
        setInterviews(snapshot.current.interviews);
        setEvaluation(snapshot.current.evaluation);
        setEvaluationScopeKey(
          evaluationSourceKey(
            snapshot.current.interview,
            selectedProfileId,
            selectedProfileUpdatedAt,
          ),
        );
      }
    });
    return () => {
      controller.abort();
    };
  }, [
    api,
    operation,
    scopedEvaluation,
    selectedInterviewId,
    selectedProfileId,
    selectedProfileUpdatedAt,
    selectionKey,
  ]);

  const refreshEvaluation = async (): Promise<void> => {
    if (!selectionReady || selectedInterviewId === null || selectedProfileId === null) return;
    const request = ++evaluationRequest.current;
    setOperation('refresh');
    setError(null);
    setEvaluation(null);
    setEvaluationScopeKey(null);
    try {
      const current = await loadCurrentEvaluationSource(
        api,
        selectedInterviewId,
        selectedProfileId,
      );
      if (request === evaluationRequest.current) {
        setInterviews(current.interviews);
        setEvaluation(current.evaluation);
        setEvaluationScopeKey(
          evaluationSourceKey(current.interview, selectedProfileId, selectedProfileUpdatedAt),
        );
      }
    } catch (reason: unknown) {
      if (request === evaluationRequest.current) {
        setError(safeErrorMessage(reason, errorCopy.current.refreshResultFailed));
      }
    } finally {
      if (request === evaluationRequest.current) setOperation(null);
    }
  };

  const runEvaluation = async (kind: 'start' | 'retry'): Promise<void> => {
    if (
      dirtyProfile ||
      operation !== null ||
      !selectionReady ||
      selectedInterviewId === null ||
      selectedProfileId === null
    ) {
      if (dirtyProfile) {
        setError(copy.saveProfileFirst);
      }
      return;
    }
    if (
      !evaluationCommandAllowed({
        kind,
        evaluation: scopedEvaluation,
        dirtyProfile,
        operation,
        selectionReady,
      })
    ) {
      return;
    }

    const request = ++evaluationRequest.current;
    setOperation(kind);
    setEvaluation(null);
    setEvaluationScopeKey(null);
    setError(null);
    setExportError(null);
    try {
      const current = await loadCurrentEvaluationSource(
        api,
        selectedInterviewId,
        selectedProfileId,
      );
      if (request !== evaluationRequest.current) return;
      const submitted = await submitCurrentEvaluationSource(api, current, kind);
      if (request === evaluationRequest.current) {
        setInterviews(submitted.interviews);
        setEvaluation(submitted.evaluation);
        setEvaluationScopeKey(
          evaluationSourceKey(submitted.interview, selectedProfileId, selectedProfileUpdatedAt),
        );
      }
    } catch (reason: unknown) {
      if (request !== evaluationRequest.current) return;
      setError(safeErrorMessage(reason, errorCopy.current.runFailed));
      try {
        const reconciled = await loadCurrentEvaluationSource(
          api,
          selectedInterviewId,
          selectedProfileId,
        );
        if (request === evaluationRequest.current) {
          setInterviews(reconciled.interviews);
          setEvaluation(reconciled.evaluation);
          setEvaluationScopeKey(
            evaluationSourceKey(reconciled.interview, selectedProfileId, selectedProfileUpdatedAt),
          );
        }
      } catch {
        // Keep the original sanitized operation error when reconciliation is unavailable.
      }
    } finally {
      if (request === evaluationRequest.current) setOperation(null);
    }
  };

  const exportEvaluation = async (format: ProfileEvaluationExportFormat): Promise<void> => {
    if (
      activeExport !== null ||
      scopedEvaluation?.status !== 'completed' ||
      selectedInterviewId === null ||
      selectedProfileId === null
    ) {
      return;
    }
    setActiveExport(format);
    setExportError(null);
    try {
      downloadEvaluationArtifact(
        await api.getEvaluationExport(selectedInterviewId, format, selectedProfileId),
      );
    } catch (reason: unknown) {
      setExportError(safeErrorMessage(reason, errorCopy.current.exportFailed));
    } finally {
      setActiveExport(null);
    }
  };

  const manageInterview = async (displayName?: string | null): Promise<void> => {
    if (managementDialog === null || operation !== null || activeExport !== null) return;
    const { kind, interview } = managementDialog;
    const interviewId = interview.summary.interviewId;
    const request = ++evaluationRequest.current;
    interviewRequest.current += 1;
    setOperation(kind);
    setManagementError(null);
    try {
      if (kind === 'rename') {
        const summary = await api.renameInterview(interviewId, {
          displayName: displayName ?? null,
        });
        if (request !== evaluationRequest.current) return;
        setInterviews((current) =>
          current.map((candidate) =>
            candidate.summary.interviewId === interviewId ? { ...candidate, summary } : candidate,
          ),
        );
      } else {
        await api.deleteInterview(interviewId);
        if (request !== evaluationRequest.current) return;
        const remaining = interviews.filter(
          (candidate) => candidate.summary.interviewId !== interviewId,
        );
        setInterviews(remaining);
        if (selectedInterviewId === interviewId) {
          setEvaluation(null);
          setEvaluationScopeKey(null);
          setSelectedInterviewId(preferredEvaluableInterviewId(remaining));
        }
      }
      setManagementDialog(null);
    } catch (reason: unknown) {
      if (request === evaluationRequest.current)
        setManagementError(interviewManagementError(reason, kind, locale));
    } finally {
      if (request === evaluationRequest.current)
        setOperation((current) => (current === kind ? null : current));
    }
  };

  const openManagement = (kind: 'rename' | 'delete', interview: EvaluableInterview): void => {
    if (operation !== null || activeExport !== null) return;
    setManagementError(null);
    setManagementDialog({ kind, interview });
  };

  const handleReportNavigation = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const link = (event.target as Element).closest<HTMLAnchorElement>(
      'a[href^="#transcript-turn-"]',
    );
    if (link === null) return;
    const targetId = decodeURIComponent(link.hash.slice(1));
    const target = document.getElementById(targetId);
    if (target === null) return;
    event.preventDefault();
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    target.focus({ preventScroll: true });
    window.history.replaceState(window.history.state, '', link.hash);
  };

  const visibleError =
    error ?? (profileDirectoryError === null ? null : copy.profileDirectoryFailed);

  return (
    <div className="evaluation-workspace">
      <InterviewDirectory
        interfaceLanguage={locale}
        interviews={interviews}
        selectedInterviewId={selectedInterviewId}
        loading={loadingInterviews}
        managementDisabled={operation !== null}
        disabled={
          (operation !== null && operation !== 'load_evaluation') ||
          managementDialog !== null ||
          activeExport !== null
        }
        error={error !== null && interviews.length === 0 ? error : null}
        onSelect={(interviewId) => {
          if (
            (operation !== null && operation !== 'load_evaluation') ||
            !hasInterview(interviews, interviewId)
          )
            return;
          setSelectedInterviewId(interviewId);
        }}
        onReload={() => void loadInterviews()}
        onRename={(interview) => openManagement('rename', interview)}
        onDelete={(interview) => openManagement('delete', interview)}
        runningEvaluationInterviewId={
          scopedEvaluation?.status === 'running' ? selectedInterviewId : null
        }
      />
      <div className="evaluation-main-content">
        <EvaluationRunner
          interfaceLanguage={locale}
          interviews={interviews}
          profiles={profiles}
          selectedInterviewId={selectedInterviewId}
          selectedProfileId={selectedProfileId}
          evaluation={scopedEvaluation}
          loadingInterviews={loadingInterviews}
          operation={operation}
          dirtyProfile={dirtyProfile}
          error={visibleError}
          onReloadInterviews={() => void loadInterviews()}
          onRefresh={() => void refreshEvaluation()}
          onStart={() => void runEvaluation('start')}
          onRetry={() => void runEvaluation('retry')}
        />

        {scopedEvaluation?.status === 'failed' ? (
          <EvaluationFailure evaluation={scopedEvaluation} language={locale} />
        ) : null}

        {scopedEvaluation?.status === 'completed' && selectedInterview !== null ? (
          <div className="evaluation-review-layout" onClick={handleReportNavigation}>
            <EvaluationReportView
              evaluation={scopedEvaluation}
              interfaceLanguage={locale}
              interviewTitle={interviewDisplayName(selectedInterview)}
              activeExport={activeExport}
              exportError={exportError}
              onExport={exportEvaluation}
            />
            <CanonicalTranscript
              turns={selectedInterview.session.transcript}
              language={locale}
              finalized={selectedInterview.session.finalizedAt !== null}
              onExport={() => downloadInterviewTranscriptMarkdown(selectedInterview)}
            />
          </div>
        ) : null}
      </div>
      {managementDialog?.kind === 'rename' ? (
        <RenameInterviewDialog
          interview={managementDialog.interview}
          busy={operation === 'rename'}
          error={managementError}
          onConfirm={(name) => void manageInterview(name)}
          onClose={() => setManagementDialog(null)}
        />
      ) : managementDialog?.kind === 'delete' ? (
        <DeleteInterviewDialog
          interview={managementDialog.interview}
          busy={operation === 'delete'}
          error={managementError}
          onConfirm={() => void manageInterview()}
          onClose={() => setManagementDialog(null)}
        />
      ) : null}
    </div>
  );
}

function EvaluationFailure({
  evaluation,
  language,
}: {
  readonly evaluation: Extract<ProfileEvaluationSnapshot, { readonly status: 'failed' }>;
  readonly language: SupportedLocale;
}): ReactNode {
  const copy = WORKSPACE_COPY[language];
  return (
    <section className="evaluation-failure" role="alert">
      <AlertTriangle aria-hidden="true" size={19} />
      <div>
        <strong>{copy.evaluationFailed}</strong>
        <p>{failureDescription(copy, evaluation.failure.code)}</p>
        <span>
          {copy.errorCode} <code>{evaluation.failure.code}</code>
          {evaluation.failure.retryable ? ` · ${copy.retryAvailable}` : ''}
        </span>
      </div>
    </section>
  );
}

function CanonicalTranscript({
  turns,
  language,
  onExport,
  finalized,
}: {
  readonly turns: readonly MvpTranscriptTurn[];
  readonly language: SupportedLocale;
  readonly onExport: () => void;
  readonly finalized: boolean;
}): ReactNode {
  const copy = WORKSPACE_COPY[language];
  return (
    <aside className="evaluation-transcript" aria-labelledby="evaluation-transcript-title">
      <header>
        <MessageSquareText aria-hidden="true" size={17} />
        <div>
          <span className="eyebrow">{copy.canonicalSource}</span>
          <h2 id="evaluation-transcript-title">
            {finalized ? copy.finalTranscript : copy.savedTranscript}
          </h2>
        </div>
        <div className="evaluation-transcript-actions">
          <span>{copy.turns(turns.length)}</span>
          <button
            className="icon-button evaluation-transcript-export"
            type="button"
            title={copy.exportTranscript}
            aria-label={copy.exportTranscript}
            onClick={onExport}
          >
            <Download aria-hidden="true" size={16} />
          </button>
        </div>
      </header>
      <ol>
        {turns.map((turn) => (
          <li
            className={turn.speaker === 'participant' ? 'is-participant' : 'is-interviewer'}
            id={`transcript-turn-${turn.turnId}`}
            tabIndex={-1}
            key={turn.turnId}
          >
            <div>
              <strong>
                {turn.speaker === 'participant' ? copy.participant : copy.interviewer}
              </strong>
              <span>{copy.turn(turn.sequenceNumber)}</span>
            </div>
            <p>{turn.text}</p>
            <code>{turn.turnId}</code>
          </li>
        ))}
      </ol>
    </aside>
  );
}

function hasInterview(interviews: readonly EvaluableInterview[], interviewId: string): boolean {
  return interviews.some(({ summary }) => summary.interviewId === interviewId);
}

function readRunnerSelection(): {
  readonly interviewId: string | null;
  readonly profileId: string | null;
} {
  if (typeof window === 'undefined') return { interviewId: null, profileId: null };
  const parameters = new URL(window.location.href).searchParams;
  return {
    interviewId: parameters.get('interviewId'),
    profileId: parameters.get('profileId'),
  };
}

function writeRunnerSelection(interviewId: string | null, profileId: string | null): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  setParameter(url, 'interviewId', interviewId);
  setParameter(url, 'profileId', profileId);
  window.history.replaceState(window.history.state, '', url);
}

function setParameter(url: URL, key: string, value: string | null): void {
  if (value === null) url.searchParams.delete(key);
  else url.searchParams.set(key, value);
}

function safeErrorMessage(_reason: unknown, fallback: string): string {
  return fallback;
}

function failureDescription(copy: (typeof WORKSPACE_COPY)[SupportedLocale], code: string): string {
  return (
    copy.failureDescription[code as keyof typeof copy.failureDescription] ??
    copy.failureDescription.unknown
  );
}

export function evaluationSourceKey(
  interview: EvaluableInterview,
  profileId: string,
  profileUpdatedAt: string | null,
): string {
  const { session } = interview;
  return JSON.stringify([
    session.interviewId,
    profileId,
    profileUpdatedAt,
    session.status,
    session.startedAt,
    session.endedAt,
    session.finalizedAt,
    session.transcript,
    session.technicalGaps,
  ]);
}

export async function loadCurrentEvaluationSource(
  api: Pick<EvaluationStudioApi, 'listEvaluableInterviews' | 'getEvaluation'>,
  interviewId: string,
  profileId: string,
  signal?: AbortSignal,
): Promise<CurrentEvaluationSource> {
  for (let attempt = 0; attempt < SOURCE_READ_ATTEMPTS; attempt += 1) {
    const before = await api.listEvaluableInterviews(signal);
    const original = selectedSource(before, interviewId);
    const evaluation = await api.getEvaluation(interviewId, profileId, signal);
    const interviews = await api.listEvaluableInterviews(signal);
    const interview = selectedSource(interviews, interviewId);
    if (
      evaluationSourceKey(original, profileId, null) ===
      evaluationSourceKey(interview, profileId, null)
    ) {
      return { interviews, interview, evaluation };
    }
  }
  throw new Error('The saved transcript changed while loading its evaluation. Please refresh.');
}

export interface CurrentEvaluationSource {
  readonly interviews: readonly EvaluableInterview[];
  readonly interview: EvaluableInterview;
  readonly evaluation: ProfileEvaluationSnapshot;
}

function selectedSource(
  interviews: readonly EvaluableInterview[],
  interviewId: string,
): EvaluableInterview {
  const interview = interviews.find((candidate) => candidate.summary.interviewId === interviewId);
  if (interview === undefined)
    throw new Error('The selected interview no longer has a saved evaluable transcript.');
  return interview;
}

export async function submitCurrentEvaluationSource(
  api: Pick<
    EvaluationStudioApi,
    'listEvaluableInterviews' | 'getEvaluation' | 'startEvaluation' | 'retryEvaluation'
  >,
  current: CurrentEvaluationSource,
  kind: 'start' | 'retry',
): Promise<CurrentEvaluationSource> {
  const { interviewId, profileId } = current.evaluation;
  if (current.evaluation.status === 'not_started') {
    await api.startEvaluation(interviewId, { profileId });
  } else if (
    kind === 'retry' &&
    (current.evaluation.status === 'completed' ||
      (current.evaluation.status === 'failed' && current.evaluation.failure.retryable))
  ) {
    await api.retryEvaluation(interviewId, { profileId });
  } else {
    return current;
  }
  // A completed POST can describe a newer snapshot than the transcript read before it.
  return loadCurrentEvaluationSource(api, interviewId, profileId);
}

export function evaluationForSelection<
  T extends { readonly interviewId: string; readonly profileId: string },
>(input: {
  readonly evaluation: T | null;
  readonly evaluationScopeKey: string | null;
  readonly selectionKey: string | null;
  readonly interviewId: string | null;
  readonly profileId: string | null;
}): T | null {
  return input.selectionKey !== null &&
    input.evaluationScopeKey === input.selectionKey &&
    input.evaluation !== null &&
    input.evaluation.interviewId === input.interviewId &&
    input.evaluation.profileId === input.profileId
    ? input.evaluation
    : null;
}

export function evaluationCommandAllowed(input: {
  readonly kind: 'start' | 'retry';
  readonly evaluation:
    | null
    | { readonly status: 'not_started' | 'running' | 'completed' }
    | { readonly status: 'failed'; readonly failure: { readonly retryable: boolean } };
  readonly dirtyProfile: boolean;
  readonly operation: EvaluationRunnerOperation;
  readonly selectionReady: boolean;
}): boolean {
  if (input.dirtyProfile || input.operation !== null || !input.selectionReady) return false;
  if (input.kind === 'start') {
    return input.evaluation?.status === 'not_started';
  }
  return (
    input.evaluation?.status === 'completed' ||
    (input.evaluation?.status === 'failed' && input.evaluation.failure.retryable)
  );
}

export async function pollUntilTerminal<T extends { readonly status: string }>(options: {
  readonly signal: AbortSignal;
  readonly wait: () => Promise<void>;
  readonly load: () => Promise<T>;
  readonly onError: (reason: unknown) => void;
  readonly onRecovered: () => void;
}): Promise<T | null> {
  while (!options.signal.aborted) {
    await options.wait();
    if (options.signal.aborted) return null;
    try {
      const snapshot = await options.load();
      if (options.signal.aborted) return null;
      options.onRecovered();
      if (snapshot.status !== 'running') return snapshot;
    } catch (reason: unknown) {
      if (options.signal.aborted) return null;
      options.onError(reason);
    }
  }
  return null;
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      window.clearTimeout(timeout);
      resolve();
    };
    const timeout = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
