import type {
  GuideQuestionReference,
  MonitoringSnapshot,
  QuestionCoverage,
} from '@orgscience/contracts';
import { useI18n } from '@orgscience/frontend-i18n';
import { Check, Circle, CircleDot, ListTree, Minus } from 'lucide-react';
import type { ReactNode } from 'react';

import { coverageStatusLabel } from '../view-model.js';

interface CoveragePanelProps {
  readonly snapshot: MonitoringSnapshot;
}

export function CoveragePanel({ snapshot }: CoveragePanelProps): ReactNode {
  const { formatPercent, t } = useI18n();
  const coverage = new Map(
    snapshot.interviewState.coverage.map((record) => [referenceKey(record.question), record]),
  );
  const answered = snapshot.interviewState.coverage.filter(
    (item) => item.status === 'answered' || item.status === 'skipped_already_answered',
  ).length;
  const total = snapshot.interviewState.coverage.length;
  const progress = total === 0 ? 0 : Math.round((answered / total) * 100);

  return (
    <section className="panel coverage-panel" aria-labelledby="coverage-title">
      <div className="panel-header">
        <div>
          <span className="panel-kicker">{t('monitoring.coverage.kicker')}</span>
          <h2 id="coverage-title">{t('monitoring.coverage.title')}</h2>
        </div>
        <strong className="coverage-percent">{formatPercent(progress / 100)}</strong>
      </div>
      <div
        className="progress-track"
        aria-label={t('monitoring.coverage.progressAria', {
          progress: formatPercent(progress / 100),
        })}
      >
        <span style={{ width: `${progress}%` }} />
      </div>

      <div className="coverage-tree">
        {snapshot.interviewGuide.sections.map((section) => (
          <section className="coverage-section" key={section.id}>
            <h3 lang={snapshot.interviewState.language}>
              <ListTree size={15} aria-hidden="true" />
              {section.title}
            </h3>
            {section.mainQuestions.map((mainQuestion) => {
              const mainReference: GuideQuestionReference = {
                kind: 'main_question',
                guideId: snapshot.interviewGuide.id,
                sectionId: section.id,
                mainQuestionId: mainQuestion.id,
              };
              const mainCoverage = coverage.get(referenceKey(mainReference));
              return (
                <div className="coverage-branch" key={mainQuestion.id}>
                  <CoverageRow
                    text={mainQuestion.text}
                    coverage={mainCoverage}
                    language={snapshot.interviewState.language}
                    main
                  />
                  {mainQuestion.followUpQuestions.map((followUp) => {
                    const reference: GuideQuestionReference = {
                      kind: 'follow_up_question',
                      guideId: snapshot.interviewGuide.id,
                      sectionId: section.id,
                      mainQuestionId: mainQuestion.id,
                      followUpQuestionId: followUp.id,
                    };
                    return (
                      <CoverageRow
                        key={followUp.id}
                        text={followUp.text}
                        coverage={coverage.get(referenceKey(reference))}
                        language={snapshot.interviewState.language}
                      />
                    );
                  })}
                </div>
              );
            })}
          </section>
        ))}
      </div>
    </section>
  );
}

interface CoverageRowProps {
  readonly text: string;
  readonly coverage: QuestionCoverage | undefined;
  readonly language: MonitoringSnapshot['interviewState']['language'];
  readonly main?: boolean;
}

function CoverageRow({ text, coverage, language, main = false }: CoverageRowProps): ReactNode {
  const { t } = useI18n();
  const status = coverage?.status ?? 'not_addressed';
  const Icon = statusIcon(status);
  return (
    <div className={`coverage-row coverage-${status} ${main ? 'is-main' : ''}`}>
      <Icon size={15} aria-hidden="true" />
      <span className="coverage-copy">
        <strong lang={language}>{text}</strong>
        <small>{coverageStatusLabel(t, status)}</small>
      </span>
      {coverage === undefined || coverage.transcriptTurnIds.length === 0 ? null : (
        <span className="evidence-links">
          {coverage.transcriptTurnIds.map((turnId) => (
            <a href={`#turn-${turnId}`} key={turnId} title={turnId}>
              #{turnId.slice(0, 5)}
            </a>
          ))}
        </span>
      )}
    </div>
  );
}

function statusIcon(status: QuestionCoverage['status']): typeof Circle {
  if (status === 'answered') return Check;
  if (status === 'current') return CircleDot;
  if (status === 'partially_answered') return Minus;
  if (status === 'skipped_already_answered') return Check;
  return Circle;
}

function referenceKey(reference: GuideQuestionReference): string {
  return reference.kind === 'main_question'
    ? `${reference.guideId}:${reference.sectionId}:${reference.mainQuestionId}`
    : `${reference.guideId}:${reference.sectionId}:${reference.mainQuestionId}:${reference.followUpQuestionId}`;
}
