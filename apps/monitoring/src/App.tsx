import type {
  InterviewSummary,
  MonitoringSnapshot,
  MvpInterviewSession,
  SupportedLocale,
} from '@orgscience/contracts';
import { LanguageSwitcher, LocaleProvider, useI18n } from '@orgscience/frontend-i18n';
import { Activity, AlertTriangle, Database, RefreshCw, SearchX, Waves } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { AgentPanel } from './components/AgentPanel.js';
import { ConnectionBadge } from './components/StatusBadge.js';
import { ContradictionsPanel } from './components/ContradictionsPanel.js';
import { CoveragePanel } from './components/CoveragePanel.js';
import { EventLog } from './components/EventLog.js';
import { EvaluationPanel } from './components/EvaluationPanel.js';
import { InterviewOverview } from './components/InterviewOverview.js';
import { SessionSummary, SessionTranscriptPanel } from './components/SessionLivePanel.js';
import { TranscriptPanel } from './components/TranscriptPanel.js';
import { WorkflowPanel } from './components/WorkflowPanel.js';
import {
  useInterviewDirectory,
  useMonitoringSession,
  monitoringErrorMessage,
  type ConnectionState,
  type MonitoringErrorKind,
} from './use-monitoring.js';

const selectionStorageKey = 'orgscience.monitoring.interview';
export const MONITORING_UI_LOCALE_STORAGE_KEY = 'orgscience.monitoring.ui.locale.v1';

export function App(): ReactNode {
  const directory = useInterviewDirectory();
  const sortedInterviews = useMemo(
    () => sortInterviews(directory.interviews),
    [directory.interviews],
  );
  const [selectedInterviewId, setSelectedInterviewId] = useState<string | null>(initialSelection);
  const selectedEvaluationProfileId =
    new URL(window.location.href).searchParams.get('profileId') ?? undefined;

  useEffect(() => {
    if (directory.loading || sortedInterviews.length === 0) return;
    const selectionExists = sortedInterviews.some(
      (interview) => interview.interviewId === selectedInterviewId,
    );
    if (!selectionExists) setSelectedInterviewId(preferredInterview(sortedInterviews).interviewId);
  }, [directory.loading, selectedInterviewId, sortedInterviews]);

  useEffect(() => {
    if (selectedInterviewId === null) return;
    window.localStorage.setItem(selectionStorageKey, selectedInterviewId);
    const url = new URL(window.location.href);
    url.searchParams.set('interview', selectedInterviewId);
    window.history.replaceState(null, '', url);
  }, [selectedInterviewId]);

  const session = useMonitoringSession(selectedInterviewId, selectedEvaluationProfileId);
  const selectedSummary =
    sortedInterviews.find((interview) => interview.interviewId === selectedInterviewId) ?? null;
  const interviewLanguage =
    selectedSummary?.language ??
    session.liveSession?.language ??
    session.snapshot?.interviewState.language ??
    null;

  useEffect(() => {
    if (
      selectedInterviewId === null ||
      session.loading ||
      new URL(window.location.href).searchParams.get('view') !== 'report'
    ) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      document.getElementById('evaluation')?.scrollIntoView({ block: 'start' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [selectedInterviewId, session.loading]);

  return (
    <LocaleProvider storageKey={MONITORING_UI_LOCALE_STORAGE_KEY}>
      <MonitoringShell
        directory={directory}
        sortedInterviews={sortedInterviews}
        selectedInterviewId={selectedInterviewId}
        setSelectedInterviewId={setSelectedInterviewId}
        selectedSummary={selectedSummary}
        interviewLanguage={interviewLanguage}
        session={session}
      />
    </LocaleProvider>
  );
}

interface MonitoringShellProps {
  readonly directory: ReturnType<typeof useInterviewDirectory>;
  readonly sortedInterviews: readonly InterviewSummary[];
  readonly selectedInterviewId: string | null;
  readonly setSelectedInterviewId: (interviewId: string | null) => void;
  readonly selectedSummary: InterviewSummary | null;
  readonly interviewLanguage: SupportedLocale | null;
  readonly session: ReturnType<typeof useMonitoringSession>;
}

function MonitoringShell({
  directory,
  sortedInterviews,
  selectedInterviewId,
  setSelectedInterviewId,
  selectedSummary,
  interviewLanguage,
  session,
}: MonitoringShellProps): ReactNode {
  const { t } = useI18n();

  useEffect(() => {
    document.title = t('monitoring.meta.title');
    document
      .querySelector<HTMLMetaElement>('meta[name="description"]')
      ?.setAttribute('content', t('monitoring.meta.description'));
  }, [t]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label={t('monitoring.brand.homeAria')}>
          <span className="brand-mark" aria-hidden="true">
            <Waves size={20} strokeWidth={2.4} />
          </span>
          <span>
            <strong>{t('monitoring.brand.title')}</strong>
            <small>{t('monitoring.brand.subtitle')}</small>
          </span>
        </a>

        <div className="interview-picker">
          <label htmlFor="interview-select">{t('monitoring.picker.label')}</label>
          <select
            id="interview-select"
            value={selectedInterviewId ?? ''}
            disabled={directory.loading || sortedInterviews.length === 0}
            onChange={(event) => {
              setSelectedInterviewId(event.target.value || null);
            }}
          >
            {sortedInterviews.length === 0 ? (
              <option value="">{t('monitoring.picker.empty')}</option>
            ) : null}
            {sortedInterviews.map((interview) => (
              <option
                key={interview.interviewId}
                value={interview.interviewId}
                lang={interview.language}
              >
                {interview.guideTitle} · {shortId(interview.interviewId)}
              </option>
            ))}
          </select>
        </div>

        <div className="topbar-actions">
          {interviewLanguage === null ? null : (
            <span className="interview-language" title={t('monitoring.language.interview')}>
              {t('monitoring.language.interviewValue', {
                language: t(
                  interviewLanguage === 'de' ? 'common.localeName.de' : 'common.localeName.en',
                ),
              })}
            </span>
          )}
          <LanguageSwitcher
            className="monitoring-language-switcher"
            label={t('monitoring.language.ui')}
          />
          <ConnectionBadge state={session.connection} />
          <button
            className="icon-button"
            type="button"
            title={t('monitoring.action.reloadData')}
            aria-label={t('monitoring.action.reloadData')}
            onClick={() => {
              directory.reload();
              session.reconnect();
            }}
          >
            <RefreshCw size={18} aria-hidden="true" />
          </button>
        </div>
      </header>

      <main className="main-content">
        <DashboardState
          directoryLoading={directory.loading}
          directoryError={directory.error}
          interviewCount={sortedInterviews.length}
          selectedSummary={selectedSummary}
          snapshot={session.snapshot}
          liveSession={session.liveSession}
          events={session.events}
          connection={session.connection}
          sessionLoading={session.loading}
          sessionError={session.error}
          lastEventAt={session.lastEventAt}
          evaluation={session.evaluation}
          evaluationLoading={session.evaluationLoading}
          evaluationError={session.evaluationError}
          reloadEvaluation={session.reloadEvaluation}
          reloadDirectory={directory.reload}
          reconnect={session.reconnect}
        />
      </main>
    </div>
  );
}

interface DashboardStateProps {
  readonly directoryLoading: boolean;
  readonly directoryError: MonitoringErrorKind | null;
  readonly interviewCount: number;
  readonly selectedSummary: InterviewSummary | null;
  readonly snapshot: MonitoringSnapshot | null;
  readonly liveSession: MvpInterviewSession | null;
  readonly events: ReturnType<typeof useMonitoringSession>['events'];
  readonly connection: ConnectionState;
  readonly sessionLoading: boolean;
  readonly sessionError: MonitoringErrorKind | null;
  readonly lastEventAt: string | null;
  readonly evaluation: ReturnType<typeof useMonitoringSession>['evaluation'];
  readonly evaluationLoading: boolean;
  readonly evaluationError: MonitoringErrorKind | null;
  readonly reloadEvaluation: () => void;
  readonly reloadDirectory: () => void;
  readonly reconnect: () => void;
}

function DashboardState({
  directoryLoading,
  directoryError,
  interviewCount,
  selectedSummary,
  snapshot,
  liveSession,
  events,
  connection,
  sessionLoading,
  sessionError,
  lastEventAt,
  evaluation,
  evaluationLoading,
  evaluationError,
  reloadEvaluation,
  reloadDirectory,
  reconnect,
}: DashboardStateProps): ReactNode {
  const { t } = useI18n();
  if (directoryLoading) {
    return <CenteredState icon={<Activity />} title={t('monitoring.directory.loading')} busy />;
  }
  if (directoryError !== null) {
    return (
      <CenteredState
        icon={<AlertTriangle />}
        title={t('monitoring.directory.errorTitle')}
        detail={monitoringErrorMessage(t, directoryError)}
        actionLabel={t('monitoring.action.reload')}
        onAction={reloadDirectory}
      />
    );
  }
  if (interviewCount === 0) {
    return (
      <CenteredState
        icon={<SearchX />}
        title={t('monitoring.directory.emptyTitle')}
        detail={t('monitoring.directory.emptyDetail')}
        actionLabel={t('monitoring.action.refreshList')}
        onAction={reloadDirectory}
      />
    );
  }
  if (sessionLoading && snapshot === null && liveSession === null) {
    return <CenteredState icon={<Database />} title={t('monitoring.snapshot.loading')} busy />;
  }
  if (snapshot === null && liveSession !== null) {
    return (
      <div className="dashboard">
        <SessionSummary session={liveSession} />
        <SessionTranscriptPanel session={liveSession} />
        <EvaluationPanel
          interviewId={liveSession.interviewId}
          evaluation={evaluation}
          loading={evaluationLoading}
          error={evaluationError === null ? null : monitoringErrorMessage(t, evaluationError)}
          onReload={reloadEvaluation}
        />
      </div>
    );
  }
  if (snapshot === null) {
    return (
      <CenteredState
        icon={<AlertTriangle />}
        title={t('monitoring.unavailable.title')}
        detail={
          sessionError === null
            ? t('monitoring.unavailable.detail')
            : monitoringErrorMessage(t, sessionError)
        }
        actionLabel={t('monitoring.action.reconnect')}
        onAction={reconnect}
      />
    );
  }

  return (
    <div className="dashboard">
      {sessionError !== null ? (
        <div className="inline-alert" role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>{monitoringErrorMessage(t, sessionError)}</span>
          <button type="button" onClick={reconnect}>
            {t('monitoring.action.reconnect')}
          </button>
        </div>
      ) : null}

      {liveSession === null ? (
        <InterviewOverview
          snapshot={snapshot}
          summary={selectedSummary}
          connection={connection}
          lastEventAt={lastEventAt}
        />
      ) : (
        <SessionSummary session={liveSession} />
      )}

      <div className="primary-grid">
        {liveSession === null ? (
          <TranscriptPanel snapshot={snapshot} />
        ) : (
          <SessionTranscriptPanel session={liveSession} />
        )}
        <WorkflowPanel snapshot={snapshot} />
      </div>

      <AgentPanel snapshot={snapshot} />

      <div className="analysis-grid">
        <CoveragePanel snapshot={snapshot} />
        <ContradictionsPanel
          contradictions={snapshot.contradictions}
          language={snapshot.interviewState.language}
        />
      </div>

      <EvaluationPanel
        interviewId={snapshot.interviewState.interviewId}
        evaluation={evaluation}
        loading={evaluationLoading}
        error={evaluationError === null ? null : monitoringErrorMessage(t, evaluationError)}
        onReload={reloadEvaluation}
      />

      <EventLog events={events} />
    </div>
  );
}

interface CenteredStateProps {
  readonly icon: ReactNode;
  readonly title: string;
  readonly detail?: string;
  readonly busy?: boolean;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
}

function CenteredState({
  icon,
  title,
  detail,
  busy = false,
  actionLabel,
  onAction,
}: CenteredStateProps): ReactNode {
  return (
    <section className="centered-state" aria-live="polite">
      <span className={busy ? 'state-icon is-busy' : 'state-icon'} aria-hidden="true">
        {icon}
      </span>
      <h1>{title}</h1>
      {detail === undefined ? null : <p>{detail}</p>}
      {actionLabel === undefined || onAction === undefined ? null : (
        <button className="secondary-button" type="button" onClick={onAction}>
          <RefreshCw size={16} aria-hidden="true" />
          {actionLabel}
        </button>
      )}
    </section>
  );
}

function initialSelection(): string | null {
  const querySelection = new URL(window.location.href).searchParams.get('interview');
  return querySelection ?? window.localStorage.getItem(selectionStorageKey);
}

function sortInterviews(interviews: readonly InterviewSummary[]): InterviewSummary[] {
  return [...interviews].sort((left, right) => {
    const statusPriority = (status: InterviewSummary['status']): number => {
      if (status === 'active') return 0;
      if (status === 'paused' || status === 'ending') return 1;
      return 2;
    };
    return (
      statusPriority(left.status) - statusPriority(right.status) ||
      Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
    );
  });
}

function preferredInterview(interviews: readonly InterviewSummary[]): InterviewSummary {
  const first = interviews[0];
  if (first === undefined) throw new Error('An interview selection requires a non-empty directory');
  return first;
}

function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 10)}…` : id;
}
