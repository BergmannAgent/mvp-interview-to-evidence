import {
  type ProfileEvaluationExportFormat,
  type ProfileEvaluationSnapshot,
} from '@orgscience/contracts';
import { useI18n } from '@orgscience/frontend-i18n';
import {
  AlertTriangle,
  BarChart3,
  Download,
  FileJson,
  FileText,
  LoaderCircle,
  Printer,
  RefreshCw,
  Table2,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { evaluationExportUrl, getEvaluationExport } from '../api.js';
import { formatDateTime, truncateIdentifier } from '../view-model.js';
import { ProfileEvaluationReport } from './ProfileEvaluationReport.js';

type DownloadFormat = Exclude<ProfileEvaluationExportFormat, 'html'>;

interface EvaluationPanelProps {
  readonly interviewId: string;
  readonly evaluation: ProfileEvaluationSnapshot | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onReload: () => void;
}

export function EvaluationPanel({
  interviewId,
  evaluation,
  loading,
  error,
  onReload,
}: EvaluationPanelProps): ReactNode {
  const { t } = useI18n();
  const [activeDownload, setActiveDownload] = useState<DownloadFormat | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const completedEvaluation = evaluation?.status === 'completed' ? evaluation : null;

  const download = async (format: DownloadFormat): Promise<void> => {
    if (completedEvaluation === null) return;
    setActiveDownload(format);
    setDownloadError(null);
    try {
      const file = await getEvaluationExport(interviewId, format, completedEvaluation.profileId);
      triggerDownload(file.blob, file.fileName);
    } catch {
      setDownloadError(t('monitoring.error.export'));
    } finally {
      setActiveDownload(null);
    }
  };

  return (
    <section className="panel evaluation-panel" id="evaluation" aria-labelledby="evaluation-title">
      <div className="panel-header evaluation-header">
        <div>
          <span className="panel-kicker">{t('monitoring.evaluation.kicker')}</span>
          <h2 id="evaluation-title">{t('monitoring.evaluation.title')}</h2>
        </div>
        <div className="evaluation-actions">
          {completedEvaluation === null ? null : (
            <>
              <ExportButton format="json" activeDownload={activeDownload} onDownload={download} />
              <ExportButton format="csv" activeDownload={activeDownload} onDownload={download} />
              <ExportButton
                format="markdown"
                activeDownload={activeDownload}
                onDownload={download}
              />
              <a
                className="compact-control"
                href={evaluationExportUrl(interviewId, 'html', completedEvaluation.profileId)}
                target="_blank"
                rel="noreferrer"
                title={t('monitoring.evaluation.printTitle')}
              >
                <Printer size={14} aria-hidden="true" />
                <span>{t('monitoring.evaluation.print')}</span>
              </a>
            </>
          )}
          <button
            className="icon-button evaluation-refresh"
            type="button"
            title={t('monitoring.evaluation.reload')}
            aria-label={t('monitoring.evaluation.reload')}
            disabled={loading}
            onClick={onReload}
          >
            <RefreshCw className={loading ? 'is-spinning' : ''} size={16} aria-hidden="true" />
          </button>
        </div>
      </div>

      {error === null ? null : (
        <EvaluationNotice tone="error" icon={<AlertTriangle size={17} />}>
          {error}
        </EvaluationNotice>
      )}
      {downloadError === null ? null : (
        <EvaluationNotice tone="error" icon={<AlertTriangle size={17} />}>
          {downloadError}
        </EvaluationNotice>
      )}

      {evaluation === null ? (
        <EvaluationNotice
          icon={
            loading ? <LoaderCircle className="is-spinning" size={18} /> : <BarChart3 size={18} />
          }
        >
          {loading ? t('monitoring.evaluation.loading') : t('monitoring.evaluation.unavailable')}
        </EvaluationNotice>
      ) : (
        <EvaluationContent evaluation={evaluation} />
      )}
    </section>
  );
}

function EvaluationContent({
  evaluation,
}: {
  readonly evaluation: ProfileEvaluationSnapshot;
}): ReactNode {
  const { locale, t } = useI18n();
  switch (evaluation.status) {
    case 'not_started':
      return (
        <EvaluationNotice icon={<BarChart3 size={18} />}>
          {t('monitoring.evaluation.notStarted', {
            profile: truncateIdentifier(evaluation.profileId, 20),
          })}
        </EvaluationNotice>
      );
    case 'running':
      return (
        <EvaluationNotice icon={<LoaderCircle className="is-spinning" size={18} />}>
          {t('monitoring.evaluation.running', {
            started: formatDateTime(locale, evaluation.startedAt),
            run: truncateIdentifier(evaluation.evaluationId),
          })}
        </EvaluationNotice>
      );
    case 'failed':
      return (
        <EvaluationNotice tone="error" icon={<AlertTriangle size={18} />}>
          <strong>{t('monitoring.evaluation.failed')}</strong>
          <small>
            {evaluation.failure.code} · {t('monitoring.evaluation.profile')}{' '}
            {truncateIdentifier(evaluation.profileId, 20)}
          </small>
        </EvaluationNotice>
      );
    case 'completed':
      return <ProfileEvaluationReport report={evaluation.report} />;
  }
}

function EvaluationNotice({
  icon,
  tone = 'neutral',
  children,
}: {
  readonly icon: ReactNode;
  readonly tone?: 'neutral' | 'error';
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div className={`evaluation-notice is-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <span aria-hidden="true">{icon}</span>
      <div>{children}</div>
    </div>
  );
}

function ExportButton({
  format,
  activeDownload,
  onDownload,
}: {
  readonly format: DownloadFormat;
  readonly activeDownload: DownloadFormat | null;
  readonly onDownload: (format: DownloadFormat) => Promise<void>;
}): ReactNode {
  const { t } = useI18n();
  const active = activeDownload === format;
  const Icon = format === 'json' ? FileJson : format === 'csv' ? Table2 : FileText;
  const label = format === 'markdown' ? 'Markdown' : format.toUpperCase();

  return (
    <button
      className="compact-control"
      type="button"
      disabled={activeDownload !== null}
      aria-label={t('monitoring.evaluation.exportAria', { format: label })}
      onClick={() => void onDownload(format)}
    >
      {active ? (
        <LoaderCircle className="is-spinning" size={14} aria-hidden="true" />
      ) : (
        <Icon size={14} aria-hidden="true" />
      )}
      <span>{label}</span>
      <Download size={12} aria-hidden="true" />
    </button>
  );
}

function triggerDownload(blob: Blob, fileName: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}
