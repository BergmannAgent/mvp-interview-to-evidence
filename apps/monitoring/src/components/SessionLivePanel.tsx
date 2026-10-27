import type {
  MvpInterviewSession,
  MvpTranscriptGap,
  MvpTranscriptTurn,
} from '@orgscience/contracts';
import { useI18n, type Translate } from '@orgscience/frontend-i18n';
import { Captions } from 'lucide-react';
import type { ReactNode } from 'react';

import { formatClock, formatDateTime, interviewStatusLabel } from '../view-model.js';

export function SessionSummary({ session }: { readonly session: MvpInterviewSession }): ReactNode {
  const { formatNumber, locale, t } = useI18n();
  return (
    <section className="session-summary">
      <div>
        <span className="eyebrow">{t('monitoring.session.eyebrow')}</span>
        <h1 lang={session.language}>{session.guideTitle}</h1>
        <small>{session.interviewId}</small>
      </div>
      <div className="session-facts">
        <span>
          <small>{t('monitoring.session.status')}</small>
          <strong>{interviewStatusLabel(t, session.status)}</strong>
        </span>
        <span>
          <small>{t('monitoring.session.currentQuestion')}</small>
          <strong lang={session.currentQuestion === null ? undefined : session.language}>
            {session.currentQuestion?.text ?? t('common.value.notAvailable')}
          </strong>
        </span>
        <span>
          <small>{t('monitoring.session.progress')}</small>
          <strong>
            {t('monitoring.session.progressValue', {
              current: formatNumber(
                Math.min(session.currentQuestionIndex + 1, session.totalQuestions),
              ),
              total: formatNumber(session.totalQuestions),
            })}
          </strong>
        </span>
        <span>
          <small>{t('monitoring.session.started')}</small>
          <strong>{formatDateTime(locale, session.startedAt)}</strong>
        </span>
      </div>
    </section>
  );
}

export function SessionTranscriptPanel({
  session,
}: {
  readonly session: MvpInterviewSession;
}): ReactNode {
  const { formatNumber, locale, t } = useI18n();
  const entries = sessionEntries(session);

  return (
    <section className="panel transcript-panel">
      <div className="panel-header">
        <div>
          <span className="panel-kicker">{t('monitoring.transcript.sessionSource')}</span>
          <h2>{t('monitoring.transcript.title')}</h2>
        </div>
        <span className="count-badge">{formatNumber(entries.length)}</span>
      </div>
      <div className="transcript-list" aria-live="polite">
        {entries.length === 0 && session.partialTranscript === null ? (
          <div className="empty-panel">
            <Captions size={24} />
            <p>{t('monitoring.transcript.empty')}</p>
          </div>
        ) : null}
        {entries.map((entry) =>
          entry.kind === 'turn' ? (
            <article
              className={`transcript-turn speaker-${entry.value.speaker} ${entry.value.interrupted ? 'is-interrupted' : ''}`}
              key={entry.value.turnId}
              id={`turn-${entry.value.turnId}`}
            >
              <div className="turn-meta">
                <strong>
                  {entry.value.speaker === 'ai_interviewer'
                    ? t('monitoring.transcript.speaker.ai')
                    : t('monitoring.transcript.speaker.participant')}
                </strong>
                <span>{formatClock(locale, entry.value.occurredAt)}</span>
                <span>#{formatNumber(entry.value.sequenceNumber)}</span>
                <span className="turn-state">{t('monitoring.transcript.state.final')}</span>
              </div>
              <p lang={session.language}>{entry.value.text}</p>
              <div className="turn-footer">
                <span>{turnTypeLabel(t, entry.value.turnType)}</span>
                {entry.value.interrupted ? (
                  <span className="danger-label">{t('monitoring.transcript.interrupted')}</span>
                ) : null}
              </div>
            </article>
          ) : (
            <article
              className="technical-gap"
              key={entry.value.gapId}
              id={`gap-${entry.value.gapId}`}
            >
              <strong>{t('monitoring.transcript.technicalGap')}</strong>
              <span>{formatClock(locale, entry.value.occurredAt)}</span>
              <span>#{formatNumber(entry.value.sequenceNumber)}</span>
              <p lang={session.language}>{entry.value.description}</p>
              <small>{gapSourceLabel(t, entry.value.source)}</small>
            </article>
          ),
        )}
        {session.partialTranscript === null ? null : (
          <article className="transcript-turn speaker-participant is-partial">
            <div className="turn-meta">
              <strong>{t('monitoring.transcript.speaker.participant')}</strong>
              <span className="turn-state">{t('monitoring.transcript.state.partial')}</span>
            </div>
            <p lang={session.language}>{session.partialTranscript}</p>
          </article>
        )}
      </div>
    </section>
  );
}

type SessionEntry =
  | { readonly kind: 'turn'; readonly value: MvpTranscriptTurn }
  | { readonly kind: 'gap'; readonly value: MvpTranscriptGap };

function sessionEntries(session: MvpInterviewSession): SessionEntry[] {
  return [
    ...session.transcript.map((turn): SessionEntry => ({ kind: 'turn', value: turn })),
    ...session.technicalGaps.map((gap): SessionEntry => ({ kind: 'gap', value: gap })),
  ].sort((left, right) => left.value.sequenceNumber - right.value.sequenceNumber);
}

function gapSourceLabel(t: Translate, source: MvpTranscriptGap['source']): string {
  return t(`monitoring.gapSource.${source}`);
}

function turnTypeLabel(t: Translate, type: MvpTranscriptTurn['turnType']): string {
  return t(`monitoring.transcript.turnType.${type}`);
}
