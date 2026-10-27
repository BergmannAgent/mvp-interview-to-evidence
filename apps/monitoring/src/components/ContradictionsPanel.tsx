import type { MonitoringContradiction, SupportedLocale } from '@orgscience/contracts';
import { useI18n, type Translate } from '@orgscience/frontend-i18n';
import { AlertCircle, GitCompareArrows } from 'lucide-react';
import type { ReactNode } from 'react';

import { formatClock } from '../view-model.js';

interface ContradictionsPanelProps {
  readonly contradictions: readonly MonitoringContradiction[];
  readonly language: SupportedLocale;
}

export function ContradictionsPanel({
  contradictions,
  language,
}: ContradictionsPanelProps): ReactNode {
  const { formatNumber, locale, t } = useI18n();
  return (
    <section className="panel contradictions-panel" aria-labelledby="contradictions-title">
      <div className="panel-header">
        <div>
          <span className="panel-kicker">{t('monitoring.contradiction.kicker')}</span>
          <h2 id="contradictions-title">{t('monitoring.contradiction.title')}</h2>
        </div>
        <span className={contradictions.length > 0 ? 'count-badge has-items' : 'count-badge'}>
          {formatNumber(contradictions.length)}
        </span>
      </div>

      {contradictions.length === 0 ? (
        <div className="empty-panel">
          <GitCompareArrows size={24} aria-hidden="true" />
          <p>{t('monitoring.contradiction.empty')}</p>
        </div>
      ) : (
        <div className="contradiction-list">
          {contradictions.map((item) => (
            <article className="contradiction-item" key={item.contradictionId}>
              <div className="contradiction-heading">
                <AlertCircle size={17} aria-hidden="true" />
                <strong lang={language}>{item.description}</strong>
                <span className={`contradiction-status contradiction-${item.status}`}>
                  {statusLabel(t, item.status)}
                </span>
              </div>
              <blockquote lang={language}>{item.suggestedClarificationQuestion}</blockquote>
              <p lang={language}>{item.rationale}</p>
              <div className="contradiction-footer">
                <span>{formatClock(locale, item.updatedAt)}</span>
                <span>
                  {item.shouldClarify
                    ? t('monitoring.contradiction.clarify')
                    : t('monitoring.contradiction.noClarification')}
                </span>
                <span>
                  {t('monitoring.contradiction.turns')}{' '}
                  {item.referencedTranscriptTurnIds.map((turnId) => (
                    <a href={`#turn-${turnId}`} key={turnId}>
                      #{turnId.slice(0, 5)}
                    </a>
                  ))}
                </span>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function statusLabel(t: Translate, status: MonitoringContradiction['status']): string {
  return t(`monitoring.contradiction.status.${status}`);
}
