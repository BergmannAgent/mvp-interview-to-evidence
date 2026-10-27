import type { MonitoringSnapshot, MonitoringWorkflowStep } from '@orgscience/contracts';
import { useI18n, type Translate } from '@orgscience/frontend-i18n';
import { GitBranch, RotateCcw } from 'lucide-react';
import type { ReactNode } from 'react';

import {
  formatClock,
  formatDuration,
  truncateIdentifier,
  workflowStepLabel,
  workflowSteps,
} from '../view-model.js';
import { StatusBadge } from './StatusBadge.js';

interface WorkflowPanelProps {
  readonly snapshot: MonitoringSnapshot;
}

export function WorkflowPanel({ snapshot }: WorkflowPanelProps): ReactNode {
  const { formatNumber, locale, t } = useI18n();
  const activeId = snapshot.interviewState.activeWorkflowRunId;
  const attemptsWithSteps = new Set(snapshot.workflowSteps.map((step) => step.attemptId));
  const newestRuns = [...snapshot.workflowRuns].sort(
    (left, right) => timestamp(right.startedAt) - timestamp(left.startedAt),
  );
  const latestRun =
    snapshot.workflowRuns.find((run) => run.workflowRunId === activeId) ??
    newestRuns.find((run) => attemptsWithSteps.has(run.attemptId)) ??
    newestRuns[0] ??
    null;
  const attemptSteps =
    latestRun === null
      ? []
      : snapshot.workflowSteps.filter((step) => step.attemptId === latestRun.attemptId);
  const stepsByName = new Map(attemptSteps.map((step) => [step.run.step, step]));

  return (
    <section className="panel workflow-panel" aria-labelledby="workflow-title">
      <div className="panel-header">
        <div>
          <span className="panel-kicker">{t('monitoring.workflow.kicker')}</span>
          <h2 id="workflow-title">{t('monitoring.workflow.title')}</h2>
        </div>
        {latestRun === null ? null : <StatusBadge status={latestRun.status} />}
      </div>

      {latestRun === null ? (
        <div className="empty-panel">
          <GitBranch size={24} aria-hidden="true" />
          <p>{t('monitoring.workflow.empty')}</p>
        </div>
      ) : (
        <>
          <div className="run-summary">
            <span title={latestRun.workflowRunId}>
              {t('monitoring.workflow.run')}{' '}
              <strong>{truncateIdentifier(latestRun.workflowRunId)}</strong>
            </span>
            <span>
              {t('monitoring.workflow.attempt', {
                number: formatNumber(latestRun.attemptNumber),
              })}
            </span>
            <span>{formatDuration(locale, t, latestRun.durationMs)}</span>
            {latestRun.retryCount > 0 ? (
              <span className="retry-count">
                <RotateCcw size={13} aria-hidden="true" /> {formatNumber(latestRun.retryCount)}
              </span>
            ) : null}
          </div>

          <ol className="workflow-list">
            {workflowSteps.map((stepName, index) => {
              const step = stepsByName.get(stepName);
              return (
                <WorkflowStepRow
                  key={stepName}
                  index={index + 1}
                  name={stepName}
                  step={step}
                  workflowStatus={latestRun.status}
                  locale={locale}
                  t={t}
                />
              );
            })}
          </ol>

          {latestRun.failure === null ? null : (
            <div className="failure-box">
              <strong>{latestRun.failure.code}</strong>
            </div>
          )}
        </>
      )}
    </section>
  );
}

interface WorkflowStepRowProps {
  readonly index: number;
  readonly name: MonitoringWorkflowStep['run']['step'];
  readonly step: MonitoringWorkflowStep | undefined;
  readonly workflowStatus: MonitoringSnapshot['workflowRuns'][number]['status'];
  readonly locale: MonitoringSnapshot['interviewState']['language'];
  readonly t: Translate;
}

function WorkflowStepRow({
  index,
  name,
  step,
  workflowStatus,
  locale,
  t,
}: WorkflowStepRowProps): ReactNode {
  const inferredCompleted = step === undefined && workflowStatus === 'succeeded';
  const status = step?.run.status ?? (inferredCompleted ? 'succeeded' : 'waiting');
  return (
    <li className={`workflow-row workflow-${status}`}>
      <span className="step-number">{index}</span>
      <span className="step-copy">
        <strong>{workflowStepLabel(t, name)}</strong>
        <small>
          {step === undefined
            ? inferredCompleted
              ? t('monitoring.workflow.inferredCompleted')
              : t('monitoring.workflow.notStarted')
            : `${formatClock(locale, step.run.startedAt)} · ${formatDuration(locale, t, step.run.durationMs)}`}
        </small>
      </span>
      <span className="step-signals" aria-label={t('monitoring.workflow.dataAvailability')}>
        <i
          className={step?.run.inputAvailable === true ? 'available' : ''}
          title={
            step?.run.inputAvailable === true
              ? t('monitoring.workflow.inputAvailable')
              : t('monitoring.workflow.inputUnavailable')
          }
        >
          I
        </i>
        <i
          className={step?.run.outputAvailable === true ? 'available' : ''}
          title={
            step?.run.outputAvailable === true
              ? t('monitoring.workflow.outputAvailable')
              : t('monitoring.workflow.outputUnavailable')
          }
        >
          O
        </i>
      </span>
      <StatusBadge status={status} />
    </li>
  );
}

function timestamp(value: string | null): number {
  return value === null ? 0 : Date.parse(value);
}
