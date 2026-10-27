import type { AgentName, MonitoringAgentRun, MonitoringSnapshot } from '@orgscience/contracts';
import { useI18n } from '@orgscience/frontend-i18n';
import { Bot, ChevronDown } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import {
  agentLabel,
  agentNames,
  agentTask,
  formatClock,
  formatDuration,
  structuredRationale,
  truncateIdentifier,
} from '../view-model.js';
import { JsonDetails } from './JsonDetails.js';
import { StatusBadge } from './StatusBadge.js';

interface AgentPanelProps {
  readonly snapshot: MonitoringSnapshot;
}

export function AgentPanel({ snapshot }: AgentPanelProps): ReactNode {
  const { formatNumber, locale, t } = useI18n();
  const latestRuns = useMemo(() => latestAgentRuns(snapshot.agentRuns), [snapshot.agentRuns]);
  const defaultAgent = activeOrRecentAgent(latestRuns);
  const [selectedAgent, setSelectedAgent] = useState<AgentName>(defaultAgent);

  useEffect(() => {
    const active = activeOrRecentAgent(latestRuns);
    if (latestRuns.get(active)?.run.status === 'running') setSelectedAgent(active);
  }, [latestRuns]);

  return (
    <section className="agents-section" aria-labelledby="agents-title">
      <div className="section-heading">
        <div>
          <span className="panel-kicker">{t('monitoring.agent.kicker')}</span>
          <h2 id="agents-title">{t('monitoring.agent.title')}</h2>
        </div>
        <span>
          {t('monitoring.agent.callCount', {
            count: formatNumber(snapshot.agentRuns.length),
          })}
        </span>
      </div>

      <div className="agent-grid">
        {agentNames.map((name) => {
          const run = latestRuns.get(name) ?? null;
          return (
            <button
              type="button"
              className={selectedAgent === name ? 'agent-card is-selected' : 'agent-card'}
              key={name}
              onClick={() => {
                setSelectedAgent(name);
              }}
            >
              <span className="agent-icon" aria-hidden="true">
                <Bot size={17} />
              </span>
              <span className="agent-card-copy">
                <strong>{agentLabel(t, name)}</strong>
                <small>
                  {run === null
                    ? t('monitoring.agent.noRun')
                    : `${formatDuration(locale, t, run.run.durationMs)} · ${run.run.model.mode}`}
                </small>
              </span>
              <StatusBadge status={run?.run.status ?? 'waiting'} />
              <ChevronDown size={16} aria-hidden="true" />
            </button>
          );
        })}
      </div>

      <AgentDetails name={selectedAgent} run={latestRuns.get(selectedAgent) ?? null} />
    </section>
  );
}

interface AgentDetailsProps {
  readonly name: AgentName;
  readonly run: MonitoringAgentRun | null;
}

function AgentDetails({ name, run }: AgentDetailsProps): ReactNode {
  const { formatNumber, locale, t } = useI18n();
  if (run === null) {
    return (
      <div className="agent-details empty-agent-details">
        <strong>{agentLabel(t, name)}</strong>
        <p>{agentTask(t, name)}</p>
        <span>{t('monitoring.agent.neverRun')}</span>
      </div>
    );
  }

  const rationale = structuredRationale(run.structuredOutput);
  return (
    <div className="agent-details">
      <div className="agent-details-heading">
        <div>
          <h3>{agentLabel(t, name)}</h3>
          <p>{agentTask(t, name)}</p>
        </div>
        <StatusBadge status={run.run.status} />
      </div>

      <dl className="metadata-grid">
        <Metadata
          label={t('monitoring.agent.metadata.runId')}
          value={truncateIdentifier(run.run.agentRunId, 18)}
          title={run.run.agentRunId}
        />
        <Metadata
          label={t('monitoring.agent.metadata.workflow')}
          value={truncateIdentifier(run.run.workflowRunId, 18)}
          title={run.run.workflowRunId}
        />
        <Metadata
          label={t('monitoring.agent.metadata.started')}
          value={formatClock(locale, run.run.startedAt)}
        />
        <Metadata
          label={t('monitoring.agent.metadata.ended')}
          value={formatClock(locale, run.run.endedAt)}
        />
        <Metadata
          label={t('monitoring.agent.metadata.duration')}
          value={formatDuration(locale, t, run.run.durationMs)}
        />
        <Metadata
          label={t('monitoring.agent.metadata.retries')}
          value={formatNumber(run.run.retryCount)}
        />
        <Metadata
          label={t('monitoring.agent.metadata.model')}
          value={run.run.model.model ?? run.run.model.mode}
        />
        <Metadata
          label={t('monitoring.agent.metadata.provider')}
          value={run.run.model.provider ?? t('monitoring.agent.deterministic')}
        />
      </dl>

      {rationale === null ? null : (
        <div className="rationale-box">
          <span>{t('monitoring.agent.rationale')}</span>
          <p>{rationale}</p>
        </div>
      )}

      <div className="reference-row">
        <span>
          {t('monitoring.agent.transcriptTurns')}{' '}
          <strong>{formatNumber(run.input.transcriptTurnIds.length)}</strong>
        </span>
        <span>
          {t('monitoring.agent.canonicalEntries')}{' '}
          <strong>{formatNumber(run.input.canonicalEntryIds.length)}</strong>
        </span>
        <span>
          {t('monitoring.agent.guideQuestions')}{' '}
          <strong>{formatNumber(run.input.guideQuestionIds.length)}</strong>
        </span>
      </div>

      {run.failure === null ? null : (
        <div className="failure-box">
          <strong>{run.failure.code}</strong>
        </div>
      )}

      <div className="json-grid">
        <JsonDetails label={t('monitoring.agent.structuredInput')} value={run.input} />
        <JsonDetails label={t('monitoring.agent.structuredOutput')} value={run.structuredOutput} />
      </div>
    </div>
  );
}

interface MetadataProps {
  readonly label: string;
  readonly value: string;
  readonly title?: string;
}

function Metadata({ label, value, title }: MetadataProps): ReactNode {
  return (
    <div title={title}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function latestAgentRuns(
  runs: readonly MonitoringAgentRun[],
): ReadonlyMap<AgentName, MonitoringAgentRun> {
  const result = new Map<AgentName, MonitoringAgentRun>();
  for (const run of runs) {
    const current = result.get(run.run.agentName);
    if (current === undefined || compareRuns(run, current) > 0) result.set(run.run.agentName, run);
  }
  return result;
}

function compareRuns(left: MonitoringAgentRun, right: MonitoringAgentRun): number {
  return (
    left.invocationNumber - right.invocationNumber ||
    timestamp(left.run.startedAt) - timestamp(right.run.startedAt)
  );
}

function activeOrRecentAgent(runs: ReadonlyMap<AgentName, MonitoringAgentRun>): AgentName {
  const active = agentNames.find((name) => runs.get(name)?.run.status === 'running');
  if (active !== undefined) return active;
  return (
    [...runs.values()].sort(
      (left, right) => timestamp(right.run.startedAt) - timestamp(left.run.startedAt),
    )[0]?.run.agentName ?? 'coverage_analysis'
  );
}

function timestamp(value: string | null): number {
  return value === null ? 0 : Date.parse(value);
}
