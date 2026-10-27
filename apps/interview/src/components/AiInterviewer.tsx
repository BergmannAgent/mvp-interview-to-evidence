import type { SupportedLocale } from '@orgscience/contracts';
import { useI18n } from '@orgscience/frontend-i18n';
import { AudioLines, Sparkles } from 'lucide-react';

import type { InterviewPhase } from '../model.js';

interface AiInterviewerProps {
  readonly phase: InterviewPhase;
  readonly caption: string | null;
  readonly captionsEnabled: boolean;
  readonly language: SupportedLocale;
}

export function AiInterviewer({ phase, caption, captionsEnabled, language }: AiInterviewerProps) {
  const { t } = useI18n();
  const speaking = phase === 'speaking';
  return (
    <section className="ai-stage" aria-label={t('interview.ai.label')}>
      <div className={`ai-presence${speaking ? ' ai-presence--speaking' : ''}`}>
        <div className="ai-presence__rings" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div className="ai-presence__core">
          {speaking ? <AudioLines size={42} /> : <Sparkles size={38} />}
        </div>
      </div>
      <div className="ai-stage__identity">
        <h1>{t('interview.ai.name')}</h1>
        <span className="ai-badge">{t('interview.ai.label')}</span>
      </div>
      {captionsEnabled && caption !== null ? (
        <p className="live-caption" aria-live="polite">
          <span className="live-caption__speaker">{t('interview.ai.name')}</span>
          <span lang={language}>{caption}</span>
        </p>
      ) : null}
    </section>
  );
}
