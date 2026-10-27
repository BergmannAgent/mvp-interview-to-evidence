import type {
  CanonicalTranscriptTurn,
  GuideQuestionReference,
  MonitoringSnapshot,
  TranscriptTurnType,
} from '@orgscience/contracts';
import { useI18n, type Translate } from '@orgscience/frontend-i18n';
import { Captions, Pause, Play } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { formatClock } from '../view-model.js';

interface TranscriptPanelProps {
  readonly snapshot: MonitoringSnapshot;
}

export function TranscriptPanel({ snapshot }: TranscriptPanelProps): ReactNode {
  const { formatNumber, locale, t } = useI18n();
  const [autoScroll, setAutoScroll] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);
  const entryCount = snapshot.transcript.entries.length + snapshot.partialTranscriptions.length;

  useEffect(() => {
    if (autoScroll)
      listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [autoScroll, entryCount, snapshot.liveState.activeAiTextStream?.generatedText]);

  return (
    <section className="panel transcript-panel" aria-labelledby="transcript-title">
      <div className="panel-header">
        <div>
          <span className="panel-kicker">{t('monitoring.transcript.canonicalSource')}</span>
          <h2 id="transcript-title">{t('monitoring.transcript.title')}</h2>
        </div>
        <button
          type="button"
          className={autoScroll ? 'compact-control is-active' : 'compact-control'}
          aria-pressed={autoScroll}
          onClick={() => {
            setAutoScroll((enabled) => !enabled);
          }}
        >
          {autoScroll ? (
            <Pause size={14} aria-hidden="true" />
          ) : (
            <Play size={14} aria-hidden="true" />
          )}
          {t('monitoring.transcript.autoScroll')}
        </button>
      </div>

      <div className="transcript-list" ref={listRef} aria-live="polite">
        {snapshot.transcript.entries.length === 0 && snapshot.partialTranscriptions.length === 0 ? (
          <div className="empty-panel">
            <Captions size={24} aria-hidden="true" />
            <p>{t('monitoring.transcript.empty')}</p>
          </div>
        ) : null}

        {snapshot.transcript.entries.map((entry) =>
          entry.kind === 'turn' ? (
            <article
              className={`transcript-turn speaker-${entry.speaker} ${isInterruptedAiTurn(entry) ? 'is-interrupted' : ''}`}
              key={entry.turnId}
              id={`turn-${entry.turnId}`}
            >
              <div className="turn-meta">
                <strong>
                  {entry.speaker === 'ai_interviewer'
                    ? t('monitoring.transcript.speaker.ai')
                    : t('monitoring.transcript.speaker.participant')}
                </strong>
                <span>{formatClock(locale, entry.occurredAt)}</span>
                <span>#{formatNumber(entry.sequenceNumber)}</span>
                <span className="turn-state">{t('monitoring.transcript.state.final')}</span>
              </div>
              <p lang={snapshot.interviewState.language}>{entry.text}</p>
              <div className="turn-footer">
                <span>{turnTypeLabel(t, entry.turnType)}</span>
                {entry.guideReference === null ? null : (
                  <span>{questionReferenceLabel(t, entry.guideReference)}</span>
                )}
                {isInterruptedAiTurn(entry) ? (
                  <span className="danger-label">{t('monitoring.transcript.interrupted')}</span>
                ) : null}
              </div>
            </article>
          ) : (
            <article className="technical-gap" key={entry.gapId} id={`gap-${entry.gapId}`}>
              <strong>{t('monitoring.transcript.technicalGap')}</strong>
              <span>{formatClock(locale, entry.occurredAt)}</span>
              <p lang={snapshot.interviewState.language}>{entry.description}</p>
            </article>
          ),
        )}

        {snapshot.partialTranscriptions.map((segment) => (
          <article
            className="transcript-turn speaker-participant is-partial"
            key={`${segment.provider}:${segment.segmentId}`}
          >
            <div className="turn-meta">
              <strong>{t('monitoring.transcript.speaker.participant')}</strong>
              <span>{formatClock(locale, segment.observedAt)}</span>
              <span className="turn-state">{t('monitoring.transcript.state.partial')}</span>
            </div>
            <p lang={snapshot.interviewState.language}>{segment.text || '…'}</p>
          </article>
        ))}

        {snapshot.liveState.activeAiTextStream === null ? null : (
          <article className="transcript-turn speaker-ai_interviewer is-streaming">
            <div className="turn-meta">
              <strong>{t('monitoring.transcript.speaker.ai')}</strong>
              <span>{formatClock(locale, snapshot.liveState.activeAiTextStream.startedAt)}</span>
              <span className="turn-state">{t('monitoring.transcript.state.stream')}</span>
            </div>
            <p lang={snapshot.interviewState.language}>
              {snapshot.liveState.activeAiTextStream.generatedText || '…'}
            </p>
          </article>
        )}
      </div>
    </section>
  );
}

function turnTypeLabel(t: Translate, type: TranscriptTurnType): string {
  return t(`monitoring.transcript.turnType.${type}`);
}

function questionReferenceLabel(t: Translate, reference: GuideQuestionReference): string {
  const id =
    reference.kind === 'main_question' ? reference.mainQuestionId : reference.followUpQuestionId;
  return t('monitoring.transcript.questionReference', {
    id: `${id.slice(0, 10)}${id.length > 10 ? '…' : ''}`,
  });
}

function isInterruptedAiTurn(turn: CanonicalTranscriptTurn): boolean {
  return turn.speaker === 'ai_interviewer' && turn.delivery.status === 'interrupted';
}
