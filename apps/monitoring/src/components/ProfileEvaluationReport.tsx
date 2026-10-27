import {
  type ProfileCalculationResult,
  type ProfileEvaluationEvidenceReference,
  type ProfileEvaluationReport as ProfileEvaluationReportData,
  type ProfileEvaluationReportItem,
} from '@orgscience/contracts';
import { useI18n, type Translate } from '@orgscience/frontend-i18n';
import { ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';

import { formatDateTime, truncateIdentifier } from '../view-model.js';

import './ProfileEvaluationReport.css';

interface ProfileEvaluationReportProps {
  readonly report: ProfileEvaluationReportData;
}

export function ProfileEvaluationReport({ report }: ProfileEvaluationReportProps): ReactNode {
  const { formatNumber, locale, t } = useI18n();
  const totalDimensions = report.dimensions.length;
  const aggregate = report.overallAggregate;
  const customOverall =
    report.calculation?.mode === 'formula' || report.profile.calculation?.mode === 'formula';
  const calculationCopy = CALCULATION_COPY[locale];

  return (
    <div className="profile-report">
      <section
        className="profile-participant-details"
        aria-label={t('monitoring.report.participantDetails')}
      >
        <h3>{t('monitoring.report.participantDetails')}</h3>
        <dl>
          {(['age', 'position'] as const).map((field) => {
            const detail = report.participantDetails?.[field];
            return (
              <div key={field}>
                <dt>
                  {t(
                    field === 'age'
                      ? 'monitoring.report.participantAge'
                      : 'monitoring.report.participantPosition',
                  )}
                </dt>
                <dd>
                  {detail?.value ??
                    t(
                      report.participantDetails === undefined
                        ? 'monitoring.report.participantNotExtracted'
                        : 'monitoring.report.participantNotStated',
                    )}
                  {detail == null ? null : (
                    <details>
                      <summary>{t('monitoring.report.participantSource')}</summary>
                      <blockquote>{detail.source.verbatimExcerpt}</blockquote>
                      <a href={`#turn-${detail.source.turnId}`}>
                        {t('monitoring.report.turn', {
                          number: formatNumber(detail.source.sequenceNumber),
                        })}
                      </a>
                    </details>
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      </section>
      {report.legacyEvidenceNotice === undefined ? null : (
        <p className="profile-legacy-evidence-notice" role="note">
          {report.legacyEvidenceNotice}
        </p>
      )}

      <aside className="profile-confidence-notice" role="note">
        <strong>{t('monitoring.report.confidenceNoticeTitle')}</strong>
        <p>{t('monitoring.report.confidenceNotice')}</p>
      </aside>

      <div className="profile-report-summary" aria-label={t('monitoring.report.summaryAria')}>
        <ReportMetric
          label={t('monitoring.report.overallScore')}
          value={
            aggregate.score === null
              ? t('monitoring.report.notScored')
              : formatNumber(aggregate.score, scoreNumberOptions(aggregate.score, customOverall))
          }
          detail={
            aggregate.score === null
              ? t('monitoring.report.noNumericScore')
              : customOverall
                ? calculationCopy.formulaResult
                : t('monitoring.report.ofSeven')
          }
        />
        <ReportMetric
          label={t('monitoring.report.scoredItems')}
          value={`${formatNumber(aggregate.scoredItemCount)} / ${formatNumber(aggregate.totalItemCount)}`}
          detail={t('monitoring.report.unscoredItems', {
            count: formatNumber(aggregate.unscoredItemCount),
          })}
        />
        <ReportMetric
          label={t('monitoring.report.dimensions')}
          value={formatNumber(totalDimensions)}
          detail={aggregateStatusLabel(t, aggregate.status)}
        />
        <ReportMetric
          label={t('monitoring.report.model')}
          value={report.model.model ?? t('monitoring.report.demoMode')}
          detail={report.model.provider ?? report.model.mode}
        />
      </div>

      {report.calculation === undefined ? null : (
        <CalculationAudit calculation={report.calculation} />
      )}

      <p className="profile-report-rationale">{report.rationale}</p>

      <section className="profile-report-section" aria-labelledby="profile-dimensions-title">
        <div className="profile-section-heading">
          <div>
            <span className="panel-kicker">{t('monitoring.report.codingKicker')}</span>
            <h3 id="profile-dimensions-title">{report.profileName}</h3>
          </div>
          <span className="profile-overall-score">
            <small>{t('monitoring.report.overallScore')}</small>
            {aggregate.score === null ? (
              <strong>{t('monitoring.report.notScored')}</strong>
            ) : (
              <Score value={aggregate.score} customOverall={customOverall} />
            )}
          </span>
        </div>
        {report.profile.description.length === 0 ? null : (
          <p className="profile-context-summary">{report.profile.description}</p>
        )}

        <div className="profile-dimensions">
          {report.dimensions.map((dimension) => (
            <section
              className="profile-dimension"
              id={`dimension-${dimension.dimensionId}`}
              key={dimension.dimensionId}
              aria-labelledby={`dimension-${dimension.dimensionId}-title`}
            >
              <header className="profile-dimension-header">
                <div>
                  <span className={`profile-dimension-status status-${dimension.aggregate.status}`}>
                    {aggregateStatusLabel(t, dimension.aggregate.status)}
                  </span>
                  <h4 id={`dimension-${dimension.dimensionId}-title`}>{dimension.name}</h4>
                </div>
                <div className="profile-dimension-result">
                  {dimension.aggregate.score === null ? (
                    <strong>{t('monitoring.report.notScored')}</strong>
                  ) : (
                    <Score value={dimension.aggregate.score} />
                  )}
                  <small>
                    {t('monitoring.report.itemsScored', {
                      scored: formatNumber(dimension.aggregate.scoredItemCount),
                      total: formatNumber(dimension.aggregate.totalItemCount),
                    })}
                  </small>
                </div>
              </header>
              <div className="profile-item-list">
                {dimension.items.map((item, index) => (
                  <ItemResult item={item} initiallyOpen={index === 0} key={item.itemId} />
                ))}
              </div>
            </section>
          ))}
        </div>
      </section>

      <footer className="profile-report-provenance">
        <span title={report.evaluationId}>
          {t('monitoring.report.evaluation', {
            id: truncateIdentifier(report.evaluationId, 18),
          })}
        </span>
        <span title={report.profileId}>
          {t('monitoring.report.profile', { id: truncateIdentifier(report.profileId, 18) })}
        </span>
        <span>
          {t('monitoring.report.profileVersion', {
            date: formatDateTime(locale, report.profileUpdatedAt),
          })}
        </span>
        <span>{t('monitoring.report.prompt', { version: report.promptVersion })}</span>
        <span title={report.profileFingerprint}>
          {t('monitoring.report.profileFingerprint', {
            id: truncateIdentifier(report.profileFingerprint, 14),
          })}
        </span>
        <span title={report.transcriptFingerprint}>
          {t('monitoring.report.transcriptFingerprint', {
            id: truncateIdentifier(report.transcriptFingerprint, 14),
          })}
        </span>
        <span>
          {t('monitoring.report.evaluatedAt', {
            date: formatDateTime(locale, report.evaluatedAt),
          })}
        </span>
      </footer>
    </div>
  );
}

function ReportMetric({
  label,
  value,
  detail,
}: {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
}): ReactNode {
  return (
    <span>
      <small>{label}</small>
      <strong>{value}</strong>
      <span title={detail}>{detail}</span>
    </span>
  );
}

function Score({
  value,
  customOverall = false,
}: {
  readonly value: number;
  readonly customOverall?: boolean;
}): ReactNode {
  const { formatNumber, locale, t } = useI18n();
  const score = formatNumber(value, scoreNumberOptions(value, customOverall));
  return (
    <span
      className="profile-score"
      title={
        customOverall
          ? `${score} (${CALCULATION_COPY[locale].formulaResult})`
          : t('monitoring.report.scoreTitle', { score })
      }
    >
      {score}
      {customOverall ? null : <small className="profile-score-scale">/7</small>}
    </span>
  );
}

function scoreNumberOptions(value: number, customOverall: boolean): Intl.NumberFormatOptions {
  return {
    maximumFractionDigits: 2,
    notation: customOverall && Math.abs(value) >= 1e9 ? 'scientific' : 'standard',
  };
}

function CalculationAudit({
  calculation,
}: {
  readonly calculation: ProfileCalculationResult;
}): ReactNode {
  const { formatNumber, locale } = useI18n();
  const copy = CALCULATION_COPY[locale];
  const weighted = calculation.mode === 'weighted_mean';
  const mode = weighted ? copy.weightedMean : copy.formula;
  const number = (value: number | null): string =>
    value === null || !Number.isFinite(value)
      ? copy.unavailable
      : formatNumber(value, {
          maximumSignificantDigits: 17,
          notation:
            value !== 0 && (Math.abs(value) < 0.000001 || Math.abs(value) >= 1e9)
              ? 'scientific'
              : 'standard',
        });

  return (
    <section className="profile-calculation" aria-label={copy.audit}>
      {calculation.error === null ? null : (
        <p className="profile-calculation-error" role="alert">
          <strong>{copy.failed}</strong> {copy.errors[calculation.error.code]}{' '}
          <code>{calculation.error.code}</code>
        </p>
      )}
      <details className="profile-calculation-details">
        <summary>
          <strong>{copy.audit}</strong>
          <span>{mode}</span>
          <ChevronDown size={16} aria-hidden="true" />
        </summary>
        <div className="profile-calculation-body">
          <dl className="profile-calculation-facts">
            <div>
              <dt>{copy.mode}</dt>
              <dd>{mode}</dd>
            </div>
            <div>
              <dt>{copy.status}</dt>
              <dd>{copy.statuses[calculation.status]}</dd>
            </div>
            <div>
              <dt>{copy.result}</dt>
              <dd>{number(calculation.result)}</dd>
            </div>
            <div>
              <dt>{copy.unroundedResult}</dt>
              <dd>{number(calculation.unroundedResult)}</dd>
            </div>
            {weighted ? (
              <>
                <div>
                  <dt>{copy.weightedSum}</dt>
                  <dd>{number(calculation.weightedSum)}</dd>
                </div>
                <div>
                  <dt>{copy.weightSum}</dt>
                  <dd>{number(calculation.weightSum)}</dd>
                </div>
              </>
            ) : (
              <div className="profile-calculation-expression">
                <dt>{copy.expression}</dt>
                <dd>
                  <code>{calculation.expression}</code>
                </dd>
              </div>
            )}
          </dl>

          <div className="profile-calculation-table-scroll" tabIndex={0}>
            <table>
              <caption>{copy.dimensionWeights}</caption>
              <thead>
                <tr>
                  <th scope="col">{copy.dimension}</th>
                  <th scope="col">{copy.dimensionWeight}</th>
                  <th scope="col">{copy.dimensionResult}</th>
                  <th scope="col">{copy.unroundedResult}</th>
                  <th scope="col">{copy.weightedSum}</th>
                  <th scope="col">{copy.weightSum}</th>
                </tr>
              </thead>
              <tbody>
                {calculation.dimensions.map((dimension) => (
                  <tr key={dimension.dimensionId}>
                    <th scope="row">
                      <code>{dimension.dimensionId}</code>
                    </th>
                    <td>{number(dimension.weight)}</td>
                    <td>{number(dimension.result)}</td>
                    <td>{number(dimension.unroundedResult)}</td>
                    <td>{number(dimension.weightedSum)}</td>
                    <td>{number(dimension.weightSum)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="profile-calculation-table-scroll" tabIndex={0}>
            <table>
              <caption>{copy.itemWeights}</caption>
              <thead>
                <tr>
                  <th scope="col">{copy.item}</th>
                  <th scope="col">{copy.dimension}</th>
                  <th scope="col">{copy.score}</th>
                  <th scope="col">{copy.itemWeight}</th>
                  <th scope="col">{copy.dimensionWeight}</th>
                  <th scope="col">{weighted ? copy.effectiveWeight : copy.effectiveMeanWeight}</th>
                  {weighted ? <th scope="col">{copy.contribution}</th> : null}
                  {weighted ? <th scope="col">{copy.participation}</th> : null}
                </tr>
              </thead>
              <tbody>
                {calculation.items.map((item) => (
                  <tr key={item.itemId}>
                    <th scope="row">
                      <code>{item.itemId}</code>
                    </th>
                    <td>
                      <code>{item.dimensionId}</code>
                    </td>
                    <td>{number(item.score)}</td>
                    <td>{number(item.itemWeight)}</td>
                    <td>{number(item.dimensionWeight)}</td>
                    <td>{number(item.effectiveWeight)}</td>
                    {weighted ? (
                      <td>
                        {item.score !== null && item.effectiveWeight !== null
                          ? number(item.score * item.effectiveWeight)
                          : copy.unavailable}
                      </td>
                    ) : null}
                    {weighted ? (
                      <td>
                        {item.included
                          ? copy.included
                          : item.exclusion === 'missing_score'
                            ? copy.missingScore
                            : copy.zeroWeight}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {weighted ? null : (
            <div className="profile-calculation-table-scroll" tabIndex={0}>
              <table>
                <caption>{copy.references}</caption>
                <thead>
                  <tr>
                    <th scope="col">{copy.reference}</th>
                    <th scope="col">{copy.value}</th>
                    <th scope="col">{copy.source}</th>
                  </tr>
                </thead>
                <tbody>
                  {calculation.references.map((reference, index) => (
                    <tr key={`${reference.function}-${reference.id}-${String(index)}`}>
                      <th scope="row">
                        <code>{`${reference.function}(${JSON.stringify(reference.id)})`}</code>
                      </th>
                      <td>{number(reference.value)}</td>
                      <td>
                        {reference.zeroSubstituted ? copy.zeroSubstituted : copy.originalValue}
                      </td>
                    </tr>
                  ))}
                  {calculation.references.length === 0 ? (
                    <tr>
                      <td colSpan={3}>{copy.noReferences}</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </details>
    </section>
  );
}

const CALCULATION_COPY = {
  de: {
    audit: 'Berechnungsnachweis',
    mode: 'Modus',
    weightedMean: 'Gewichtetes Mittel',
    formula: 'Formel',
    formulaResult: 'Formelergebnis',
    status: 'Status',
    statuses: { calculated: 'Berechnet', not_calculated: 'Nicht berechnet', error: 'Fehler' },
    result: 'Ergebnis',
    unroundedResult: 'Ungerundetes Ergebnis',
    expression: 'Ausdruck',
    weightedSum: 'Gewichtete Summe',
    weightSum: 'Gewichtssumme',
    dimensionWeights: 'Dimensionsgewichte',
    itemWeights: 'Itemgewichte',
    dimension: 'Dimension-ID',
    item: 'Item-ID',
    score: 'Score',
    dimensionResult: 'Dimensionswert',
    dimensionWeight: 'Dimensionsgewicht',
    itemWeight: 'Itemgewicht',
    effectiveWeight: 'Effektives Gewicht',
    effectiveMeanWeight: 'Effektives Mittelwertgewicht',
    participation: 'Beitrag zum Mittelwert',
    contribution: 'Gewichteter Beitrag',
    included: 'Einbezogen',
    missingScore: 'Fehlender Score; ausgeschlossen',
    zeroWeight: 'Nullgewicht; kein Beitrag',
    references: 'Ausgewertete Referenzen',
    reference: 'Referenz',
    value: 'Wert',
    source: 'Wertquelle',
    zeroSubstituted: 'Fehlender Wert durch 0 ersetzt',
    originalValue: 'Originalwert',
    noReferences: 'Keine Referenzen ausgewertet',
    unavailable: 'Nicht verfügbar',
    failed: 'Berechnung fehlgeschlagen.',
    errors: {
      invalid_formula: 'Die Formel ist ungültig.',
      unknown_reference: 'Die Formel enthält eine unbekannte Referenz.',
      formula_too_long: 'Die Formel überschreitet die maximale Länge.',
      formula_too_complex: 'Die Formel überschreitet die maximale Komplexität.',
      formula_too_deep: 'Die Formel ist zu tief verschachtelt.',
      division_by_zero: 'Division oder Restwertbildung durch null ist nicht definiert.',
      non_finite_result: 'Die Berechnung erzeugt keinen endlichen Wert.',
      invalid_score: 'Item-Scores müssen ganze Zahlen von 1 bis 7 oder fehlend sein.',
    },
  },
  en: {
    audit: 'Calculation audit',
    mode: 'Mode',
    weightedMean: 'Weighted mean',
    formula: 'Formula',
    formulaResult: 'Formula result',
    status: 'Status',
    statuses: { calculated: 'Calculated', not_calculated: 'Not calculated', error: 'Error' },
    result: 'Result',
    unroundedResult: 'Unrounded result',
    expression: 'Expression',
    weightedSum: 'Weighted sum',
    weightSum: 'Weight sum',
    dimensionWeights: 'Dimension weights',
    itemWeights: 'Item weights',
    dimension: 'Dimension ID',
    item: 'Item ID',
    score: 'Score',
    dimensionResult: 'Dimension score',
    dimensionWeight: 'Dimension weight',
    itemWeight: 'Item weight',
    effectiveWeight: 'Effective weight',
    effectiveMeanWeight: 'Effective mean weight',
    participation: 'Mean contribution',
    contribution: 'Weighted contribution',
    included: 'Included',
    missingScore: 'Missing score; excluded',
    zeroWeight: 'Zero weight; no contribution',
    references: 'Evaluated references',
    reference: 'Reference',
    value: 'Value',
    source: 'Value source',
    zeroSubstituted: 'Missing value replaced by 0',
    originalValue: 'Original value',
    noReferences: 'No references evaluated',
    unavailable: 'Unavailable',
    failed: 'Calculation failed.',
    errors: {
      invalid_formula: 'The formula is invalid.',
      unknown_reference: 'The formula contains an unknown reference.',
      formula_too_long: 'The formula exceeds the maximum length.',
      formula_too_complex: 'The formula exceeds the maximum complexity.',
      formula_too_deep: 'The formula is nested too deeply.',
      division_by_zero: 'Division or remainder by zero is undefined.',
      non_finite_result: 'The calculation produced a non-finite value.',
      invalid_score: 'Item scores must be integers from 1 through 7 or missing.',
    },
  },
} as const;

function ItemResult({
  item,
  initiallyOpen,
}: {
  readonly item: ProfileEvaluationReportItem;
  readonly initiallyOpen: boolean;
}): ReactNode {
  const { formatPercent, t } = useI18n();
  return (
    <details className={`profile-item status-${item.status}`} open={initiallyOpen}>
      <summary>
        <span className="profile-item-identity">
          <code>{item.itemId}</code>
          <strong>{item.name}</strong>
        </span>
        <span className={`profile-item-status status-${item.status}`}>
          {itemStatusLabel(t, item.status)}
        </span>
        {item.score === null ? (
          <span className="profile-no-score">{t('monitoring.report.noScore')}</span>
        ) : (
          <Score value={item.score} />
        )}
        <ChevronDown className="profile-item-chevron" size={17} aria-hidden="true" />
      </summary>

      <div className="profile-item-body">
        <div className="profile-item-context">
          <div>
            <small>{t('monitoring.report.codingInstruction')}</small>
            <p>{item.codingInstruction}</p>
          </div>
          <div>
            <small>{t('monitoring.report.auditableRationale')}</small>
            <p>{item.rationale}</p>
          </div>
          <span className="profile-confidence">
            <span>
              {t('monitoring.report.confidence')} <strong>{formatPercent(item.confidence)}</strong>
            </span>
            <small>{t('monitoring.report.coderConfidence')}</small>
          </span>
        </div>

        <div
          className="profile-anchor-list"
          aria-label={t('monitoring.report.anchorAria', { item: item.itemId })}
        >
          {item.anchors.map((anchor) => {
            const isApplied = item.appliedAnchor?.score === anchor.score;
            return (
              <div className={isApplied ? 'is-matched' : ''} key={anchor.score}>
                <strong>{anchor.score}</strong>
                <span>{anchor.criterion}</span>
                {isApplied ? <small>{t('monitoring.report.appliedAnchor')}</small> : null}
              </div>
            );
          })}
        </div>

        <div className="profile-evidence-groups">
          <EvidenceList
            title={t('monitoring.report.supportingEvidence')}
            evidence={item.supportingEvidence}
            emptyLabel={t('monitoring.report.noSupportingEvidence')}
            tone="supporting"
          />
          <EvidenceList
            title={t('monitoring.report.counterEvidence')}
            evidence={item.counterEvidence}
            emptyLabel={t('monitoring.report.noCounterEvidence')}
            tone="counter"
          />
        </div>

        <div className="profile-missing-information">
          <h5>{t('monitoring.report.missingInformation')}</h5>
          {item.missingInformation.length === 0 ? (
            <p>{t('monitoring.report.noMissingInformation')}</p>
          ) : (
            <ul>
              {item.missingInformation.map((information, index) => (
                <li key={`${item.itemId}:${String(index)}`}>{information}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </details>
  );
}

function EvidenceList({
  title,
  evidence,
  emptyLabel,
  tone,
}: {
  readonly title: string;
  readonly evidence: readonly ProfileEvaluationEvidenceReference[];
  readonly emptyLabel: string;
  readonly tone: 'supporting' | 'counter';
}): ReactNode {
  const { formatNumber, t } = useI18n();
  return (
    <section className={`profile-evidence-list tone-${tone}`}>
      <h5>{title}</h5>
      {evidence.length === 0 ? (
        <p className="profile-evidence-empty">{emptyLabel}</p>
      ) : (
        <ul>
          {evidence.map((reference, index) => (
            <li key={`${reference.turnId}:${String(reference.sequenceNumber)}:${String(index)}`}>
              <span className="profile-evidence-type">{t('monitoring.report.evidenceLabel')}</span>
              {[reference, ...(reference.additionalSources ?? [])].map((source, sourceIndex) => (
                <div
                  className="profile-evidence-source"
                  key={`${source.turnId}:${String(sourceIndex)}`}
                >
                  <a href={`#turn-${source.turnId}`}>
                    {t('monitoring.report.turn', {
                      number: formatNumber(source.sequenceNumber),
                    })}
                    <code title={source.turnId}>{truncateIdentifier(source.turnId, 24)}</code>
                  </a>
                  <blockquote>{source.verbatimExcerpt}</blockquote>
                </div>
              ))}
              {reference.inference ? (
                <p className="profile-evidence-inference">
                  <strong>{t('monitoring.report.evidenceInference')}: </strong>
                  {reference.inference}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function itemStatusLabel(t: Translate, status: ProfileEvaluationReportItem['status']): string {
  return t(`monitoring.report.itemStatus.${status}`);
}

function aggregateStatusLabel(
  t: Translate,
  status: ProfileEvaluationReportData['overallAggregate']['status'],
): string {
  return t(`monitoring.report.aggregateStatus.${status}`);
}
