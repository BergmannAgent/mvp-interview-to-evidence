import type { SupportedLocale } from '@orgscience/contracts';
import { useI18n } from '@orgscience/frontend-i18n';
import { Check, X } from 'lucide-react';
import { useEffect, useRef } from 'react';

import type { DisplayTranscriptTurn } from '../model.js';

interface TranscriptPanelProps {
  readonly language: SupportedLocale;
  readonly turns: readonly DisplayTranscriptTurn[];
  readonly onClose: () => void;
}

export function TranscriptPanel({ language, turns, onClose }: TranscriptPanelProps) {
  const { formatDateTime, t } = useI18n();
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [turns]);

  return (
    <aside className="transcript-panel" aria-label={t('interview.transcript.aria')}>
      <header className="transcript-panel__header">
        <div>
          <p className="eyebrow">{t('interview.transcript.eyebrow')}</p>
          <h2>{t('interview.transcript.title')}</h2>
        </div>
        <button
          className="plain-icon-button"
          type="button"
          onClick={onClose}
          aria-label={t('interview.transcript.close')}
        >
          <X size={20} aria-hidden="true" />
        </button>
      </header>
      <div className="transcript-panel__body" aria-live="polite">
        {turns.length === 0 ? (
          <p className="empty-copy">{t('interview.transcript.empty')}</p>
        ) : (
          turns.map((turn) => (
            <article className={`transcript-turn transcript-turn--${turn.speaker}`} key={turn.id}>
              <div className="transcript-turn__meta">
                <strong>
                  {turn.speaker === 'ai_interviewer'
                    ? t('interview.transcript.speaker.ai')
                    : t('interview.transcript.speaker.participant')}
                </strong>
                <time dateTime={turn.occurredAt}>
                  {formatDateTime(turn.occurredAt, { hour: '2-digit', minute: '2-digit' })}
                </time>
              </div>
              <p lang={language}>{turn.text}</p>
              <span className="transcript-turn__final">
                <Check size={12} aria-hidden="true" /> {t('interview.transcript.final')}
              </span>
            </article>
          ))
        )}
        <div ref={endRef} />
      </div>
    </aside>
  );
}
