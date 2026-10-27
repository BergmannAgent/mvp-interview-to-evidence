import type { EvaluableInterview } from '@orgscience/api-client';
import type {
  EvaluationProfileSummary,
  ProfileEvaluationSnapshot,
  SupportedLocale,
} from '@orgscience/contracts';
import {
  CheckCircle2,
  CirclePlay,
  Clock3,
  FileText,
  LoaderCircle,
  RefreshCw,
  RotateCw,
  TriangleAlert,
} from 'lucide-react';
import type { ReactNode } from 'react';

import './EvaluationRunner.css';

export type EvaluationRunnerOperation =
  | 'load_interviews'
  | 'load_evaluation'
  | 'start'
  | 'retry'
  | 'refresh'
  | 'rename'
  | 'delete'
  | null;

const RUNNER_COPY = {
  de: {
    persistedInterviews: 'Interviews mit Antworten',
    title: 'Auswertung',
    reload: 'Interviews mit Antworten neu laden',
    completedInterview: 'Abgeschlossenes Interview',
    selectInterview: 'Interview auswählen',
    profile: 'Bewertungsprofil',
    selectProfile: 'Profil auswählen',
    loading: 'Interviews mit gespeicherten Antworten werden geladen.',
    empty: 'Es ist noch kein Interview mit gespeicherten Fragen und Antworten verfügbar.',
    guide: 'Leitfaden',
    interviewId: 'Interview-ID',
    language: 'Interviewsprache',
    completed: 'Abgeschlossen',
    activity: 'Letzte Aktivität',
    interviewStatus: 'Interviewstatus',
    interviewStatuses: {
      ready: 'Noch nicht gestartet',
      active: 'Laufend',
      paused: 'Pausiert',
      ending: 'Wird beendet',
      completed: 'Beendet',
      failed: 'Mit Fehler abgebrochen',
    },
    snapshotTitle: 'Auswertung des bisherigen Transkripts',
    snapshotDetail:
      'Das Interview ist nicht vollständig finalisiert. Nicht alle Leitfadenfragen müssen behandelt sein. Nur gespeicherte finale Äußerungen werden ausgewertet; fehlende Antworten werden nicht erfunden.',
    transcript: 'Transkript',
    turn: ['Turn', 'Turns'] as const,
    answer: ['Antwort', 'Antworten'] as const,
    character: ['Zeichen', 'Zeichen'] as const,
    runBlocked: 'Testlauf gesperrt',
    runBlockedDetail:
      'Speichere oder verwirf die Profiländerungen. Auswertungen verwenden ausschließlich die persistierte Profilversion.',
    profileContext: 'Profil',
    refreshResult: 'Ergebnis aktualisieren',
    saveBeforeRun: 'Profiländerungen vor dem Testlauf speichern oder verwerfen',
    start: 'Auswertung starten',
    saveBeforeRetry: 'Profiländerungen vor dem erneuten Lauf speichern oder verwerfen',
    retryUnavailable: 'Dieser Fehler ist nicht automatisch erneut ausführbar',
    rerun: 'Erneut ausführen',
    retry: 'Erneut versuchen',
    evaluationId: 'Evaluation-ID',
    status: {
      unknown: 'Status nicht verfügbar',
      ready: 'Bereit',
      loading: 'Ergebnis wird geladen',
      running: 'Auswertung läuft',
      completed: 'Erfolgreich',
      failed: 'Fehlgeschlagen',
      retryable: 'Fehlgeschlagen · erneut ausführbar',
    },
  },
  en: {
    persistedInterviews: 'Interviews with answers',
    title: 'Evaluation',
    reload: 'Reload interviews with answers',
    completedInterview: 'Completed interview',
    selectInterview: 'Select interview',
    profile: 'Evaluation profile',
    selectProfile: 'Select profile',
    loading: 'Loading interviews with saved answers.',
    empty: 'No interview with saved questions and answers is available yet.',
    guide: 'Interview guide',
    interviewId: 'Interview ID',
    language: 'Interview language',
    completed: 'Completed',
    activity: 'Last activity',
    interviewStatus: 'Interview status',
    interviewStatuses: {
      ready: 'Not started',
      active: 'In progress',
      paused: 'Paused',
      ending: 'Ending',
      completed: 'Ended',
      failed: 'Stopped with an error',
    },
    snapshotTitle: 'Evaluation of the transcript so far',
    snapshotDetail:
      'The interview has not been fully finalised. Not all guide questions may have been covered. Only saved final utterances are evaluated; missing answers are not invented.',
    transcript: 'Transcript',
    turn: ['turn', 'turns'] as const,
    answer: ['answer', 'answers'] as const,
    character: ['character', 'characters'] as const,
    runBlocked: 'Test run blocked',
    runBlockedDetail:
      'Save or discard the profile changes. Evaluations only use the persisted profile version.',
    profileContext: 'Profile',
    refreshResult: 'Refresh result',
    saveBeforeRun: 'Save or discard profile changes before the test run',
    start: 'Start evaluation',
    saveBeforeRetry: 'Save or discard profile changes before running again',
    retryUnavailable: 'This failure cannot be retried automatically',
    rerun: 'Run again',
    retry: 'Retry',
    evaluationId: 'Evaluation ID',
    status: {
      unknown: 'Status unavailable',
      ready: 'Ready',
      loading: 'Loading result',
      running: 'Evaluation running',
      completed: 'Successful',
      failed: 'Failed',
      retryable: 'Failed · retry available',
    },
  },
} as const;

export interface EvaluationRunnerProps {
  readonly interviews: readonly EvaluableInterview[];
  readonly interfaceLanguage?: SupportedLocale;
  readonly profiles: readonly EvaluationProfileSummary[];
  readonly selectedInterviewId: string | null;
  readonly selectedProfileId: string | null;
  readonly evaluation: ProfileEvaluationSnapshot | null;
  readonly loadingInterviews: boolean;
  readonly operation: EvaluationRunnerOperation;
  readonly dirtyProfile: boolean;
  readonly error: string | null;
  readonly onReloadInterviews: () => void;
  readonly onRefresh: () => void;
  readonly onStart: () => void;
  readonly onRetry: () => void;
}

export interface TranscriptExtent {
  readonly totalTurns: number;
  readonly participantTurns: number;
  readonly characterCount: number;
}

export interface EvaluationRunnerAvailability {
  readonly canRefresh: boolean;
  readonly canStart: boolean;
  readonly canRetry: boolean;
  readonly runBlockedByDirtyProfile: boolean;
}

export function EvaluationRunner({
  interviews,
  profiles,
  selectedInterviewId,
  selectedProfileId,
  evaluation,
  loadingInterviews,
  operation,
  dirtyProfile,
  error,
  onReloadInterviews,
  onRefresh,
  onStart,
  onRetry,
  interfaceLanguage,
}: EvaluationRunnerProps): ReactNode {
  const selectedInterview =
    interviews.find(({ summary }) => summary.interviewId === selectedInterviewId) ?? null;
  const selectedProfile =
    profiles.find((profile) => profile.profileId === selectedProfileId) ?? null;
  const language =
    interfaceLanguage ?? selectedInterview?.summary.language ?? evaluation?.language ?? 'de';
  const copy = RUNNER_COPY[language];
  const availability = evaluationRunnerAvailability({
    selectedInterviewId,
    selectedProfileId,
    evaluation,
    operation,
    dirtyProfile,
  });
  const extent = selectedInterview === null ? null : transcriptExtent(selectedInterview);
  const status = runnerStatus(evaluation, operation);
  const controlsDisabled = operation !== null;

  return (
    <section
      className="evaluation-runner"
      aria-labelledby="evaluation-runner-title"
      aria-busy={operation !== null || loadingInterviews}
    >
      <header className="evaluation-runner-header">
        <div>
          <span className="eyebrow">{copy.persistedInterviews}</span>
          <h2 id="evaluation-runner-title">{copy.title}</h2>
        </div>
        <button
          className="icon-button"
          type="button"
          title={copy.reload}
          aria-label={copy.reload}
          disabled={controlsDisabled || loadingInterviews}
          onClick={onReloadInterviews}
        >
          <RefreshCw aria-hidden="true" size={17} />
        </button>
      </header>

      {loadingInterviews && interviews.length === 0 ? (
        <RunnerNotice icon={<LoaderCircle className="runner-spinner" size={17} />}>
          {copy.loading}
        </RunnerNotice>
      ) : null}

      {!loadingInterviews && interviews.length === 0 ? (
        <RunnerNotice icon={<FileText size={17} />}>{copy.empty}</RunnerNotice>
      ) : null}

      {selectedInterview !== null && extent !== null ? (
        <dl className="runner-selection-summary">
          <div>
            <dt>{copy.guide}</dt>
            <dd>{selectedInterview.session.guideTitle}</dd>
          </div>
          <div>
            <dt>{copy.interviewId}</dt>
            <dd>
              <code>{selectedInterview.summary.interviewId}</code>
            </dd>
          </div>
          <div>
            <dt>{copy.language}</dt>
            <dd>{selectedInterview.session.language === 'en' ? 'English' : 'Deutsch'}</dd>
          </div>
          <div>
            <dt>{copy.interviewStatus}</dt>
            <dd>{copy.interviewStatuses[selectedInterview.summary.status]}</dd>
          </div>
          <div>
            <dt>{selectedInterview.session.endedAt === null ? copy.activity : copy.completed}</dt>
            <dd>
              <time dateTime={interviewActivityAt(selectedInterview)}>
                {formatDateTime(interviewActivityAt(selectedInterview), language)}
              </time>
            </dd>
          </div>
          <div>
            <dt>{copy.transcript}</dt>
            <dd>
              {formatCount(extent.totalTurns, copy.turn, language)} ·{' '}
              {formatCount(extent.participantTurns, copy.answer, language)} ·{' '}
              {formatCount(extent.characterCount, copy.character, language)}
            </dd>
          </div>
        </dl>
      ) : null}

      {selectedInterview !== null && selectedInterview.session.finalizedAt === null ? (
        <div className="runner-warning" role="note">
          <TriangleAlert size={18} aria-hidden="true" />
          <div>
            <strong>{copy.snapshotTitle}</strong>
            <p>{copy.snapshotDetail}</p>
          </div>
        </div>
      ) : null}

      {dirtyProfile ? (
        <div className="runner-warning" role="status">
          <TriangleAlert aria-hidden="true" size={18} />
          <div>
            <strong>{copy.runBlocked}</strong>
            <p>{copy.runBlockedDetail}</p>
          </div>
        </div>
      ) : null}

      {error !== null ? (
        <div className="runner-error" role="alert">
          <TriangleAlert aria-hidden="true" size={18} />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="runner-status-row" aria-live="polite">
        <RunnerStatus status={status} evaluation={evaluation} language={language} />
        {selectedProfile !== null ? (
          <span className="runner-profile-context">
            {copy.profileContext}: <strong>{selectedProfile.name}</strong>
          </span>
        ) : null}
      </div>

      <div className="runner-actions">
        <button
          className="secondary-button"
          type="button"
          disabled={!availability.canRefresh}
          onClick={onRefresh}
        >
          {operation === 'refresh' || operation === 'load_evaluation' ? (
            <LoaderCircle className="runner-spinner" aria-hidden="true" size={16} />
          ) : (
            <RefreshCw aria-hidden="true" size={16} />
          )}
          {copy.refreshResult}
        </button>

        {evaluation === null || evaluation.status === 'not_started' ? (
          <button
            className="primary-button"
            type="button"
            disabled={!availability.canStart}
            title={availability.runBlockedByDirtyProfile ? copy.saveBeforeRun : undefined}
            onClick={onStart}
          >
            {operation === 'start' ? (
              <LoaderCircle className="runner-spinner" aria-hidden="true" size={16} />
            ) : (
              <CirclePlay aria-hidden="true" size={16} />
            )}
            {copy.start}
          </button>
        ) : null}

        {evaluation?.status === 'failed' || evaluation?.status === 'completed' ? (
          <button
            className="primary-button"
            type="button"
            disabled={!availability.canRetry}
            title={
              availability.runBlockedByDirtyProfile
                ? copy.saveBeforeRetry
                : evaluation.status === 'failed' && !evaluation.failure.retryable
                  ? copy.retryUnavailable
                  : undefined
            }
            onClick={onRetry}
          >
            {operation === 'retry' ? (
              <LoaderCircle className="runner-spinner" aria-hidden="true" size={16} />
            ) : (
              <RotateCw aria-hidden="true" size={16} />
            )}
            {evaluation.status === 'completed' ? copy.rerun : copy.retry}
          </button>
        ) : null}
      </div>
    </section>
  );
}

export function preferredEvaluationProfileId(
  profiles: readonly EvaluationProfileSummary[],
): string | null {
  return profiles.find((profile) => profile.isDefault)?.profileId ?? profiles[0]?.profileId ?? null;
}

export function preferredEvaluableInterviewId(
  interviews: readonly EvaluableInterview[],
): string | null {
  let preferred: EvaluableInterview | null = null;
  for (const interview of interviews) {
    if (
      preferred === null ||
      Date.parse(interviewActivityAt(interview)) > Date.parse(interviewActivityAt(preferred))
    ) {
      preferred = interview;
    }
  }
  return preferred?.summary.interviewId ?? null;
}

export function interviewActivityAt(interview: EvaluableInterview): string {
  return interview.session.endedAt ?? interview.session.updatedAt;
}

export function transcriptExtent(interview: EvaluableInterview): TranscriptExtent {
  return interview.session.transcript.reduce<TranscriptExtent>(
    (extent, turn) => ({
      totalTurns: extent.totalTurns + 1,
      participantTurns: extent.participantTurns + (turn.speaker === 'participant' ? 1 : 0),
      characterCount: extent.characterCount + turn.text.length,
    }),
    { totalTurns: 0, participantTurns: 0, characterCount: 0 },
  );
}

export function evaluationRunnerAvailability(input: {
  readonly selectedInterviewId: string | null;
  readonly selectedProfileId: string | null;
  readonly evaluation: ProfileEvaluationSnapshot | null;
  readonly operation: EvaluationRunnerOperation;
  readonly dirtyProfile: boolean;
}): EvaluationRunnerAvailability {
  const hasSelection = input.selectedInterviewId !== null && input.selectedProfileId !== null;
  const idle = input.operation === null;
  const canRun = hasSelection && idle && !input.dirtyProfile;
  return {
    canRefresh: hasSelection && idle,
    canStart: canRun && input.evaluation?.status === 'not_started',
    canRetry:
      canRun &&
      (input.evaluation?.status === 'completed' ||
        (input.evaluation?.status === 'failed' && input.evaluation.failure.retryable)),
    runBlockedByDirtyProfile: hasSelection && idle && input.dirtyProfile,
  };
}

type RunnerDisplayStatus =
  'unknown' | 'ready' | 'loading' | 'running' | 'completed' | 'failed' | 'retryable';

function runnerStatus(
  evaluation: ProfileEvaluationSnapshot | null,
  operation: EvaluationRunnerOperation,
): RunnerDisplayStatus {
  if (operation === 'load_evaluation' || operation === 'refresh') return 'loading';
  if (operation === 'start' || operation === 'retry') return 'running';
  if (evaluation === null) return 'unknown';
  if (evaluation.status === 'not_started') return 'ready';
  if (evaluation.status === 'running') return 'running';
  if (evaluation.status === 'completed') return 'completed';
  return evaluation.failure.retryable ? 'retryable' : 'failed';
}

function RunnerStatus({
  status,
  evaluation,
  language,
}: {
  readonly status: RunnerDisplayStatus;
  readonly evaluation: ProfileEvaluationSnapshot | null;
  readonly language: SupportedLocale;
}): ReactNode {
  const copy = RUNNER_COPY[language];
  const presentation: Readonly<
    Record<RunnerDisplayStatus, { readonly label: string; readonly icon: ReactNode }>
  > = {
    unknown: {
      label: copy.status.unknown,
      icon: <TriangleAlert aria-hidden="true" size={15} />,
    },
    ready: { label: copy.status.ready, icon: <Clock3 aria-hidden="true" size={15} /> },
    loading: {
      label: copy.status.loading,
      icon: <LoaderCircle className="runner-spinner" aria-hidden="true" size={15} />,
    },
    running: {
      label: copy.status.running,
      icon: <LoaderCircle className="runner-spinner" aria-hidden="true" size={15} />,
    },
    completed: {
      label: copy.status.completed,
      icon: <CheckCircle2 aria-hidden="true" size={15} />,
    },
    failed: { label: copy.status.failed, icon: <TriangleAlert aria-hidden="true" size={15} /> },
    retryable: {
      label: copy.status.retryable,
      icon: <RotateCw aria-hidden="true" size={15} />,
    },
  };
  const current = presentation[status];

  return (
    <div className={`runner-status runner-status-${status}`}>
      {current.icon}
      <span>{current.label}</span>
      {evaluation !== null && 'evaluationId' in evaluation ? (
        <code title={copy.evaluationId}>{evaluation.evaluationId}</code>
      ) : null}
    </div>
  );
}

function RunnerNotice({
  icon,
  children,
}: {
  readonly icon: ReactNode;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div className="runner-notice">
      {icon}
      <span>{children}</span>
    </div>
  );
}

function formatDateTime(value: string, language: SupportedLocale): string {
  return new Intl.DateTimeFormat(language === 'en' ? 'en-GB' : 'de-DE', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function formatCount(
  value: number,
  labels: readonly [string, string],
  language: SupportedLocale,
): string {
  return `${new Intl.NumberFormat(language === 'en' ? 'en-GB' : 'de-DE').format(value)} ${
    value === 1 ? labels[0] : labels[1]
  }`;
}
