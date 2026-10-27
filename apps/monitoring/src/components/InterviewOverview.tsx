import type { InterviewSummary, MonitoringSnapshot } from '@orgscience/contracts';
import { useI18n } from '@orgscience/frontend-i18n';
import { Clock3, FileText, Radio, Route, Timer } from 'lucide-react';
import type { ReactNode } from 'react';

import type { ConnectionState } from '../use-monitoring.js';
import {
  buildQuestionIndex,
  formatClock,
  formatDateTime,
  formatDuration,
  interviewStatusLabel,
  referenceQuestionId,
  truncateIdentifier,
} from '../view-model.js';
import { ConnectionBadge } from './StatusBadge.js';

interface InterviewOverviewProps {
  readonly snapshot: MonitoringSnapshot;
  readonly summary: InterviewSummary | null;
  readonly connection: ConnectionState;
  readonly lastEventAt: string | null;
}

export function InterviewOverview({
  snapshot,
  summary,
  connection,
  lastEventAt,
}: InterviewOverviewProps): ReactNode {
  const { formatNumber, locale, t } = useI18n();
  const questionIndex = buildQuestionIndex(snapshot.interviewGuide);
  const currentReference = snapshot.interviewState.currentMainQuestion;
  const currentQuestion =
    currentReference === null
      ? null
      : (questionIndex.get(referenceQuestionId(currentReference)) ?? null);
  const startedAt = lifecycleStartedAt(snapshot.interviewState.lifecycle);
  const endedAt = lifecycleEndedAt(snapshot.interviewState.lifecycle);
  const duration =
    startedAt === null ? null : Date.parse(endedAt ?? snapshot.capturedAt) - Date.parse(startedAt);

  return (
    <section className="overview-band" aria-labelledby="overview-title">
      <div className="overview-heading">
        <div>
          <span className="eyebrow" id="overview-title">
            {t('monitoring.overview.eyebrow')}
          </span>
          <h1 lang={snapshot.interviewState.language}>{snapshot.interviewGuide.title}</h1>
          <div className="id-line" title={snapshot.interviewState.interviewId}>
            {snapshot.interviewState.interviewId}
          </div>
        </div>
        <div className="overview-statuses">
          <span
            className={`interview-status interview-${snapshot.interviewState.lifecycle.status}`}
          >
            {interviewStatusLabel(t, snapshot.interviewState.lifecycle.status)}
          </span>
          <ConnectionBadge state={connection} />
        </div>
      </div>

      <div className="metric-strip">
        <Metric
          icon={<Route />}
          label={t('monitoring.overview.currentSection')}
          value={currentQuestion?.sectionTitle ?? t('common.value.notAvailable')}
          {...(currentQuestion === null ? {} : { valueLanguage: snapshot.interviewState.language })}
        />
        <Metric
          icon={<FileText />}
          label={t('monitoring.overview.currentQuestion')}
          value={currentQuestion?.mainQuestionText ?? t('monitoring.overview.noActiveQuestion')}
          {...(currentQuestion === null ? {} : { valueLanguage: snapshot.interviewState.language })}
        />
        <Metric
          icon={<Clock3 />}
          label={t('monitoring.overview.started')}
          value={formatDateTime(locale, startedAt)}
        />
        <Metric
          icon={<Timer />}
          label={t('monitoring.overview.duration')}
          value={formatDuration(locale, t, duration)}
        />
        <Metric
          icon={<Radio />}
          label={t('monitoring.overview.workflowEvent')}
          value={`${truncateIdentifier(snapshot.interviewState.activeWorkflowRunId)} · ${formatClock(locale, lastEventAt)}`}
          title={`${snapshot.interviewState.activeWorkflowRunId ?? t('monitoring.overview.noActiveWorkflow')} · ${lastEventAt ?? t('monitoring.overview.noEvent')}`}
        />
      </div>

      {summary?.status !== snapshot.interviewState.lifecycle.status ? (
        <span className="sync-note">
          {t('monitoring.overview.syncing', {
            version: formatNumber(snapshot.interviewState.version),
          })}
        </span>
      ) : null}
    </section>
  );
}

interface MetricProps {
  readonly icon: ReactNode;
  readonly label: string;
  readonly value: string;
  readonly valueLanguage?: MonitoringSnapshot['interviewState']['language'];
  readonly title?: string;
}

function Metric({ icon, label, value, valueLanguage, title }: MetricProps): ReactNode {
  return (
    <div className="metric" title={title ?? value}>
      <span className="metric-icon" aria-hidden="true">
        {icon}
      </span>
      <span>
        <small>{label}</small>
        <strong lang={valueLanguage}>{value}</strong>
      </span>
    </div>
  );
}

function lifecycleStartedAt(
  lifecycle: MonitoringSnapshot['interviewState']['lifecycle'],
): string | null {
  return lifecycle.status === 'ready' ? null : lifecycle.startedAt;
}

function lifecycleEndedAt(
  lifecycle: MonitoringSnapshot['interviewState']['lifecycle'],
): string | null {
  if (lifecycle.status === 'completed') return lifecycle.endedAt;
  if (lifecycle.status === 'failed') return lifecycle.failedAt;
  return null;
}
