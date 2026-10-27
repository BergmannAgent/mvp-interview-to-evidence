import type {
  ProfileEvaluationAggregate,
  ProfileEvaluationEvidenceReference,
  ProfileEvaluationExportFormat,
  ProfileEvaluationReportItem,
  ProfileEvaluationReport,
  ProfileEvaluationSnapshot,
  SupportedLocale,
} from '@orgscience/contracts';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Code2,
  Download,
  FileJson2,
  FileText,
  LoaderCircle,
  MinusCircle,
  Quote,
  Scale,
  Table2,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { profileUiError } from './profile-ui-errors.js';
import './EvaluationReportView.css';

export type CompletedProfileEvaluation = Extract<
  ProfileEvaluationSnapshot,
  { readonly status: 'completed' }
>;

export interface EvaluationReportViewProps {
  readonly evaluation: CompletedProfileEvaluation;
  readonly interviewTitle?: string;
  readonly interfaceLanguage?: SupportedLocale;
  readonly activeExport?: ProfileEvaluationExportFormat | null;
  readonly exportError?: string | null;
  readonly onExport: (format: ProfileEvaluationExportFormat) => void | Promise<void>;
}

const REPORT_COPY = {
  de: {
    transcriptSnapshot: 'Transkriptstand',
    partialInterview: 'Vorläufige Auswertung des bisherigen Transkripts',
    partialInterviewDetail:
      'Das Interview ist noch nicht vollständig abgeschlossen oder finalisiert. Fehlende Antworten sind keine negative Evidenz.',
    ignoredPartial: 'Unbestätigte partielle Transkriptionen wurden nicht ausgewertet.',
    completedEvaluation: 'Abgeschlossene Auswertung',
    participantDetails: 'Interviewperson',
    participantAge: 'Alter',
    participantPosition: 'Position laut Transkript',
    participantNotStated: 'Nicht angegeben oder nicht eindeutig',
    participantNotExtracted: 'Nicht erfasst',
    participantSource: 'Transkriptbeleg',
    resultsOverview: 'Ergebnisübersicht',
    overallScore: 'Gesamtwert',
    scoredItems: 'Bewertete Items',
    withoutScore: (count: number) => `${String(count)} ohne Score`,
    model: 'Modell',
    runtime: 'Laufzeit',
    overallRationale: 'Gesamtbegründung',
    profileCoding: 'Profilbasierte Codierung',
    dimensionsAndItems: 'Dimensionen und Items',
    dimensionsItems: (dimensions: number, items: number) =>
      `${String(dimensions)} Dimensionen · ${String(items)} Items`,
    exportEvaluation: 'Auswertung exportieren',
    exportAs: (format: string) => `Auswertung als ${format} exportieren`,
    exportPreparing: (format: string) => `${format} wird vorbereitet.`,
    noScore: 'Kein Score',
    scoredCount: (scored: number, total: number) =>
      `${String(scored)} von ${String(total)} Items bewertet`,
    codingInstruction: 'Codieranweisung',
    auditableRationale: 'Auditierbare Begründung',
    supportingEvidence: 'Fördernde Evidenz',
    noSupportingEvidence: 'Keine fördernde Evidenz dokumentiert.',
    counterEvidence: 'Hemmende Evidenz',
    noCounterEvidence: 'Keine hemmende Evidenz dokumentiert.',
    evidenceLabel: 'Evidenz',
    evidenceInference: 'Ableitung',
    missingInformation: 'Fehlende Evidenz oder Informationen',
    noMissingInformation: 'Keine zusätzlichen Informationslücken dokumentiert.',
    confidence: 'Konfidenz',
    coderConfidence: 'KI-Selbsteinschätzung, keine statistisch validierte Sicherheit.',
    confidenceNoticeTitle: 'Hinweis zur KI-generierten Konfidenz',
    confidenceNotice:
      'Die vom KI-Scoring-Agent ausgegebenen Konfidenzwerte sind modellgenerierte Selbsteinschätzungen. Sie sind keine statistisch kalibrierten Wahrscheinlichkeiten oder Konfidenzintervalle und garantieren nicht die Richtigkeit der Bewertung. Scores und Evidenz sollten fachlich geprüft werden.',
    anchorDecision: 'Ankerentscheidung',
    noNumericAnchor: 'Kein numerischer Anker angewendet',
    appliedAnchorAria: 'Angewendeter Bewertungsanker',
    appliedAnchor: (score: number) => `Angewendeter Anker ${String(score)} von 7`,
    fullAnchorScale: 'Vollständige Ankerskala',
    turn: (sequence: number) => `Turn #${String(sequence)}`,
    provenance: 'Provenienz',
    runMetadata: 'Run- und Modellmetadaten',
    evaluationRunId: 'Evaluation-Run-ID',
    interviewId: 'Interview-ID',
    profileId: 'Profil-ID',
    profileName: 'Bewertungsprofil',
    profileVersion: 'Profilstand',
    promptVersion: 'Prompt-Version',
    mode: 'Modus',
    provider: 'Provider',
    started: 'Gestartet',
    completed: 'Abgeschlossen',
    profileFingerprint: 'Profil-Fingerprint',
    transcriptFingerprint: 'Transkript-Fingerprint',
    reportLanguage: 'Reportsprache',
    translationStatus: 'Übersetzungsstatus',
    controlledTranslation: 'Kontrollierte Übersetzung des abgeleiteten Pilotinstruments',
    originalLanguage: 'Deutsche Originalfassung des abgeleiteten Pilotinstruments',
    notUsed: 'Nicht verwendet',
    deterministicDemoCoder: 'Deterministischer Demo-Coder',
    demoCoder: 'Demo-Coder',
    deterministicDemoMode: 'Deterministischer Demo-Modus',
    providerMode: 'Provider-Modus',
    scoreTitle: (score: string) => `${score} von 7`,
    aggregateStatus: {
      complete: 'Vollständig bewertet',
      partial: 'Teilweise bewertet',
      not_scored: 'Nicht bewertet',
    },
    itemStatus: {
      scored: {
        label: 'Bewertet',
        detail: 'Numerischer Score mit beobachteter Evidenz',
        icon: CheckCircle2,
      },
      insufficient_evidence: {
        label: 'Unzureichende Evidenz',
        detail: 'Für einen belastbaren Score fehlen Informationen',
        icon: MinusCircle,
      },
      not_applicable: {
        label: 'Nicht anwendbar',
        detail: 'Das Item ist für dieses Interview nicht anwendbar',
        icon: MinusCircle,
      },
      conflicting: {
        label: 'Widersprüchliche Evidenz',
        detail: 'Fördernde und hemmende Evidenz verhindern einen eindeutigen Score',
        icon: AlertTriangle,
      },
    },
  },
  en: {
    transcriptSnapshot: 'Transcript snapshot',
    partialInterview: 'Provisional evaluation of the transcript so far',
    partialInterviewDetail:
      'The interview has not been fully completed or finalized. Missing answers are not negative evidence.',
    ignoredPartial: 'Unconfirmed partial transcriptions were excluded from evaluation.',
    completedEvaluation: 'Completed evaluation',
    participantDetails: 'Interview participant',
    participantAge: 'Age',
    participantPosition: 'Position stated in transcript',
    participantNotStated: 'Not stated or unclear',
    participantNotExtracted: 'Not recorded',
    participantSource: 'Transcript source',
    resultsOverview: 'Results overview',
    overallScore: 'Overall score',
    scoredItems: 'Scored items',
    withoutScore: (count: number) => `${String(count)} without a score`,
    model: 'Model',
    runtime: 'Runtime',
    overallRationale: 'Overall rationale',
    profileCoding: 'Profile-based coding',
    dimensionsAndItems: 'Dimensions and items',
    dimensionsItems: (dimensions: number, items: number) =>
      `${String(dimensions)} dimensions · ${String(items)} items`,
    exportEvaluation: 'Export evaluation',
    exportAs: (format: string) => `Export evaluation as ${format}`,
    exportPreparing: (format: string) => `Preparing ${format}.`,
    noScore: 'No score',
    scoredCount: (scored: number, total: number) =>
      `${String(scored)} of ${String(total)} items scored`,
    codingInstruction: 'Coding instruction',
    auditableRationale: 'Auditable rationale',
    supportingEvidence: 'Supporting evidence',
    noSupportingEvidence: 'No supporting evidence documented.',
    counterEvidence: 'Counter-evidence',
    noCounterEvidence: 'No counter-evidence documented.',
    evidenceLabel: 'Evidence',
    evidenceInference: 'Inference',
    missingInformation: 'Missing evidence or information',
    noMissingInformation: 'No additional information gaps documented.',
    confidence: 'Confidence',
    coderConfidence: 'AI self-assessment, not statistically validated certainty.',
    confidenceNoticeTitle: 'AI-generated confidence disclaimer',
    confidenceNotice:
      'Confidence values returned by the AI scoring agent are model-generated self-assessments. They are not statistically calibrated probabilities or confidence intervals and do not guarantee that the evaluation is correct. Scores and evidence should be reviewed by a qualified person.',
    anchorDecision: 'Anchor decision',
    noNumericAnchor: 'No numeric anchor applied',
    appliedAnchorAria: 'Applied scoring anchor',
    appliedAnchor: (score: number) => `Applied anchor ${String(score)} of 7`,
    fullAnchorScale: 'Full anchor scale',
    turn: (sequence: number) => `Turn #${String(sequence)}`,
    provenance: 'Provenance',
    runMetadata: 'Run and model metadata',
    evaluationRunId: 'Evaluation run ID',
    interviewId: 'Interview ID',
    profileId: 'Profile ID',
    profileName: 'Evaluation profile',
    profileVersion: 'Profile version',
    promptVersion: 'Prompt version',
    mode: 'Mode',
    provider: 'Provider',
    started: 'Started',
    completed: 'Completed',
    profileFingerprint: 'Profile fingerprint',
    transcriptFingerprint: 'Transcript fingerprint',
    reportLanguage: 'Report language',
    translationStatus: 'Translation status',
    controlledTranslation: 'Controlled translation of the derived pilot instrument',
    originalLanguage: 'German source version of the derived pilot instrument',
    notUsed: 'Not used',
    deterministicDemoCoder: 'Deterministic demo coder',
    demoCoder: 'Demo coder',
    deterministicDemoMode: 'Deterministic demo mode',
    providerMode: 'Provider mode',
    scoreTitle: (score: string) => `${score} of 7`,
    aggregateStatus: {
      complete: 'Fully scored',
      partial: 'Partially scored',
      not_scored: 'Not scored',
    },
    itemStatus: {
      scored: {
        label: 'Scored',
        detail: 'Numeric score supported by observed evidence',
        icon: CheckCircle2,
      },
      insufficient_evidence: {
        label: 'Insufficient evidence',
        detail: 'Information required for a defensible score is missing',
        icon: MinusCircle,
      },
      not_applicable: {
        label: 'Not applicable',
        detail: 'The item is not applicable to this interview',
        icon: MinusCircle,
      },
      conflicting: {
        label: 'Conflicting evidence',
        detail: 'Supporting and counter-evidence prevent a score',
        icon: AlertTriangle,
      },
    },
  },
} as const;

type ReportCopy = (typeof REPORT_COPY)[SupportedLocale];

const CALCULATION_COPY = {
  de: {
    audit: 'Berechnungsnachweis',
    weighted: 'Gewichtetes Mittel',
    formula: 'Formel',
    expression: 'Formelausdruck',
    trace: 'Berechnungstrace',
    result: 'Ergebnis',
    unrounded: 'Vor Rundung',
    error: 'Berechnung nicht möglich',
    unavailable: 'Nicht verfügbar',
    item: 'Item',
    dimension: 'Dimension',
    score: 'Itemwert',
    itemWeight: 'Itemgewicht',
    dimensionWeight: 'Dimensionsgewicht',
    effectiveWeight: 'Effektives Gewicht',
    effectiveMeanWeight: 'Effektives Mittelwertgewicht',
    contribution: 'Gewichteter Beitrag',
    participation: 'Mittelwertbeitrag',
    included: 'Einbezogen',
    missing: 'Fehlender Wert',
    zeroWeight: 'Gewicht 0',
    dimensions: 'Dimensionsberechnung',
    weightedSum: 'Gewichtete Summe',
    weightSum: 'Gewichtssumme',
    references: 'Ausgewertete Formelreferenzen',
    reference: 'Referenz',
    value: 'Wert',
    missingSubstitution: 'Fehlender Wert als 0 eingesetzt',
    originalValue: 'Originalwert',
    noReferences: 'Keine Referenzen ausgewertet',
    calculated: 'Berechnet',
    notCalculated: 'Nicht berechnet',
  },
  en: {
    audit: 'Calculation audit',
    weighted: 'Weighted mean',
    formula: 'Formula',
    expression: 'Formula expression',
    trace: 'Calculation trace',
    result: 'Result',
    unrounded: 'Before rounding',
    error: 'Calculation unavailable',
    unavailable: 'Unavailable',
    item: 'Item',
    dimension: 'Dimension',
    score: 'Item score',
    itemWeight: 'Item weight',
    dimensionWeight: 'Dimension weight',
    effectiveWeight: 'Effective weight',
    effectiveMeanWeight: 'Effective mean weight',
    contribution: 'Weighted contribution',
    participation: 'Mean contribution',
    included: 'Included',
    missing: 'Missing score',
    zeroWeight: 'Weight 0',
    dimensions: 'Dimension calculation',
    weightedSum: 'Weighted sum',
    weightSum: 'Weight sum',
    references: 'Evaluated formula references',
    reference: 'Reference',
    value: 'Value',
    missingSubstitution: 'Missing score substituted with 0',
    originalValue: 'Original value',
    noReferences: 'No references evaluated',
    calculated: 'Calculated',
    notCalculated: 'Not calculated',
  },
} as const;

const EXPORT_FORMATS: readonly ProfileEvaluationExportFormat[] = [
  'json',
  'csv',
  'markdown',
  'html',
];

export function EvaluationReportView({
  evaluation,
  interviewTitle,
  interfaceLanguage,
  activeExport = null,
  exportError = null,
  onExport,
}: EvaluationReportViewProps): ReactNode {
  const { report } = evaluation;
  const language = interfaceLanguage ?? report.language;
  const copy = REPORT_COPY[language];

  return (
    <article className="evaluation-report-view" aria-labelledby="evaluation-report-title">
      <header className="evaluation-report-header">
        <div>
          <span className="evaluation-report-eyebrow">{copy.completedEvaluation}</span>
          <h2 id="evaluation-report-title">{interviewTitle ?? copy.resultsOverview}</h2>
        </div>
        <ExportActions
          activeExport={activeExport}
          exportError={exportError}
          language={language}
          onExport={onExport}
        />
      </header>

      {report.sourceTranscript === undefined ? null : (
        <aside className="evaluation-confidence-notice" role="note">
          <strong>{copy.transcriptSnapshot}</strong>
          <p>
            {formatDateTime(report.sourceTranscript.snapshotAt, language)} ·{' '}
            {report.sourceTranscript.turnCount} Turns
          </p>
          {report.sourceTranscript.interviewStatus === 'completed' &&
          report.sourceTranscript.finalized ? null : (
            <>
              <strong>{copy.partialInterview}</strong>
              <p>{copy.partialInterviewDetail}</p>
            </>
          )}
          {report.sourceTranscript.ignoredPartial ? <p>{copy.ignoredPartial}</p> : null}
        </aside>
      )}

      <section className="evaluation-participant-details" aria-label={copy.participantDetails}>
        <h3>{copy.participantDetails}</h3>
        <dl>
          {(['age', 'position'] as const).map((field) => {
            const detail = report.participantDetails?.[field];
            return (
              <div key={field}>
                <dt>{field === 'age' ? copy.participantAge : copy.participantPosition}</dt>
                <dd>
                  {detail?.value ??
                    (report.participantDetails === undefined
                      ? copy.participantNotExtracted
                      : copy.participantNotStated)}
                  {detail == null ? null : (
                    <details>
                      <summary>{copy.participantSource}</summary>
                      <blockquote>{detail.source.verbatimExcerpt}</blockquote>
                      <a href={`#transcript-turn-${detail.source.turnId}`}>
                        {copy.turn(detail.source.sequenceNumber)}
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
        <p className="evaluation-legacy-evidence-notice" role="note">
          {report.legacyEvidenceNotice}
        </p>
      )}

      <aside className="evaluation-confidence-notice" role="note">
        <strong>{copy.confidenceNoticeTitle}</strong>
        <p>{copy.confidenceNotice}</p>
      </aside>

      <div className="evaluation-report-metrics" aria-label={copy.resultsOverview}>
        <Metric
          icon={<Scale aria-hidden="true" size={17} />}
          label={copy.overallScore}
          value={formatAggregateScore(
            report.overallAggregate,
            language,
            report.calculation?.mode === 'formula' ||
              report.profile.calculation?.mode === 'formula',
          )}
          detail={copy.aggregateStatus[report.overallAggregate.status]}
        />
        <Metric
          icon={<CheckCircle2 aria-hidden="true" size={17} />}
          label={copy.scoredItems}
          value={`${String(report.overallAggregate.scoredItemCount)} / ${String(
            report.overallAggregate.totalItemCount,
          )}`}
          detail={copy.withoutScore(report.overallAggregate.unscoredItemCount)}
        />
        <Metric
          icon={<Bot aria-hidden="true" size={17} />}
          label={copy.model}
          value={modelName(evaluation, copy)}
          detail={modelDetail(evaluation, copy)}
        />
        <Metric
          icon={<Clock3 aria-hidden="true" size={17} />}
          label={copy.runtime}
          value={formatDuration(evaluation.startedAt, evaluation.completedAt, language)}
          detail={formatDateTime(evaluation.completedAt, language)}
        />
      </div>

      <CalculationAudit report={report} language={language} />

      <section className="evaluation-report-rationale" aria-labelledby="report-rationale-title">
        <span className="evaluation-report-section-label" id="report-rationale-title">
          {copy.overallRationale}
        </span>
        <p>{report.rationale}</p>
      </section>

      <section className="evaluation-report-results" aria-labelledby="report-results-title">
        <div className="evaluation-report-section-heading">
          <div>
            <span className="evaluation-report-section-label">{copy.profileCoding}</span>
            <h3 id="report-results-title">{copy.dimensionsAndItems}</h3>
          </div>
          <span className="evaluation-report-count">
            {copy.dimensionsItems(report.dimensions.length, report.overallAggregate.totalItemCount)}
          </span>
        </div>

        <div className="evaluation-report-dimensions">
          {report.dimensions.map((dimension) => (
            <section
              className="evaluation-report-dimension"
              key={dimension.dimensionId}
              aria-labelledby={`evaluation-dimension-${dimension.dimensionId}`}
            >
              <header>
                <div>
                  <span className={`evaluation-aggregate-state is-${dimension.aggregate.status}`}>
                    {copy.aggregateStatus[dimension.aggregate.status]}
                  </span>
                  <h4 id={`evaluation-dimension-${dimension.dimensionId}`}>{dimension.name}</h4>
                  <code>{dimension.dimensionId}</code>
                </div>
                <AggregateResult aggregate={dimension.aggregate} language={language} />
              </header>

              <div className="evaluation-report-items">
                {dimension.items.map((item, index) => (
                  <EvaluationItem
                    item={item}
                    initiallyOpen={index === 0}
                    key={item.itemId}
                    language={language}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      </section>

      <RunMetadata evaluation={evaluation} language={language} />
    </article>
  );
}

function CalculationAudit({
  report,
  language,
}: {
  readonly report: ProfileEvaluationReport;
  readonly language: SupportedLocale;
}): ReactNode {
  const trace = report.calculation;
  if (trace === undefined) return null;
  const copy = CALCULATION_COPY[language];
  const weighted = trace.mode === 'weighted_mean';
  const number = (value: number | null): string =>
    value === null || !Number.isFinite(value)
      ? copy.unavailable
      : formatCalculationNumber(value, language);
  const itemNames = new Map(report.profile.items.map((item) => [item.itemId, item.name]));
  const dimensionNames = new Map(
    report.profile.dimensions.map((dimension) => [dimension.dimensionId, dimension.name]),
  );
  return (
    <section
      className="evaluation-calculation-audit"
      aria-labelledby="evaluation-calculation-title"
    >
      <header>
        <h3 id="evaluation-calculation-title">{copy.audit}</h3>
        <span>{weighted ? copy.weighted : copy.formula}</span>
        <span>
          {trace.status === 'calculated'
            ? copy.calculated
            : trace.status === 'error'
              ? copy.error
              : copy.notCalculated}
        </span>
      </header>
      {trace.error === null ? null : (
        <p className="evaluation-calculation-error" role="alert">
          <strong>{copy.error}: </strong>
          {profileUiError(trace.error.message, language)}
        </p>
      )}
      {trace.expression === null ? null : (
        <pre aria-label={copy.expression}>{trace.expression}</pre>
      )}
      <details className="evaluation-calculation-trace">
        <summary>{copy.trace}</summary>
        <dl>
          <div>
            <dt>{copy.result}</dt>
            <dd>{number(trace.result)}</dd>
          </div>
          <div>
            <dt>{copy.unrounded}</dt>
            <dd>{number(trace.unroundedResult)}</dd>
          </div>
          {weighted ? (
            <>
              <div>
                <dt>{copy.weightedSum}</dt>
                <dd>{number(trace.weightedSum)}</dd>
              </div>
              <div>
                <dt>{copy.weightSum}</dt>
                <dd>{number(trace.weightSum)}</dd>
              </div>
            </>
          ) : null}
        </dl>
        <div className="evaluation-calculation-table-wrap" tabIndex={0}>
          <table aria-label={weighted ? copy.participation : copy.itemWeight}>
            <thead>
              <tr>
                <th scope="col">{copy.item}</th>
                <th scope="col">{copy.score}</th>
                <th scope="col">{copy.itemWeight}</th>
                <th scope="col">{copy.dimensionWeight}</th>
                <th scope="col">{weighted ? copy.effectiveWeight : copy.effectiveMeanWeight}</th>
                {weighted ? (
                  <>
                    <th scope="col">{copy.contribution}</th>
                    <th scope="col">{copy.participation}</th>
                  </>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {trace.items.map((item) => (
                <tr key={item.itemId}>
                  <th scope="row">
                    <span>{itemNames.get(item.itemId) ?? item.itemId}</span>
                    <code>{item.itemId}</code>
                    <code>{item.dimensionId}</code>
                  </th>
                  <td>{item.score === null ? copy.missing : number(item.score)}</td>
                  <td>{number(item.itemWeight)}</td>
                  <td>{number(item.dimensionWeight)}</td>
                  <td>{number(item.effectiveWeight)}</td>
                  {weighted ? (
                    <>
                      <td>
                        {item.score !== null && item.effectiveWeight !== null
                          ? number(item.score * item.effectiveWeight)
                          : copy.unavailable}
                      </td>
                      <td>
                        {item.included
                          ? copy.included
                          : item.exclusion === 'missing_score'
                            ? copy.missing
                            : item.exclusion === 'zero_weight'
                              ? copy.zeroWeight
                              : copy.unavailable}
                      </td>
                    </>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="evaluation-calculation-table-wrap" tabIndex={0}>
          <table aria-label={copy.dimensions}>
            <thead>
              <tr>
                <th scope="col">{copy.dimension}</th>
                <th scope="col">{copy.dimensionWeight}</th>
                <th scope="col">{copy.unrounded}</th>
                <th scope="col">{copy.weightedSum}</th>
                <th scope="col">{copy.weightSum}</th>
              </tr>
            </thead>
            <tbody>
              {trace.dimensions.map((dimension) => (
                <tr key={dimension.dimensionId}>
                  <th scope="row">
                    <span>
                      {dimensionNames.get(dimension.dimensionId) ?? dimension.dimensionId}
                    </span>
                    <code>{dimension.dimensionId}</code>
                  </th>
                  <td>{number(dimension.weight)}</td>
                  <td>{number(dimension.unroundedResult)}</td>
                  <td>{number(dimension.weightedSum)}</td>
                  <td>{number(dimension.weightSum)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {weighted ? null : (
          <div className="evaluation-calculation-table-wrap" tabIndex={0}>
            <table aria-label={copy.references}>
              <thead>
                <tr>
                  <th scope="col">{copy.reference}</th>
                  <th scope="col">{copy.value}</th>
                  <th scope="col">{copy.missing}</th>
                </tr>
              </thead>
              <tbody>
                {trace.references.length === 0 ? (
                  <tr>
                    <td colSpan={3}>{copy.noReferences}</td>
                  </tr>
                ) : null}
                {trace.references.map((reference, index) => (
                  <tr key={index}>
                    <th scope="row">
                      <code>
                        {reference.function}({JSON.stringify(reference.id)})
                      </code>
                    </th>
                    <td>{number(reference.value)}</td>
                    <td>
                      {reference.zeroSubstituted ? copy.missingSubstitution : copy.originalValue}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </details>
    </section>
  );
}

function ExportActions({
  activeExport,
  exportError,
  language,
  onExport,
}: {
  readonly activeExport: ProfileEvaluationExportFormat | null;
  readonly exportError: string | null;
  readonly language: SupportedLocale;
  readonly onExport: (format: ProfileEvaluationExportFormat) => void | Promise<void>;
}): ReactNode {
  const copy = REPORT_COPY[language];
  return (
    <div className="evaluation-export-area">
      <div className="evaluation-export-actions" role="group" aria-label={copy.exportEvaluation}>
        {EXPORT_FORMATS.map((format) => {
          const Icon = exportIcon(format);
          const active = activeExport === format;
          return (
            <button
              type="button"
              key={format}
              disabled={activeExport !== null}
              aria-label={copy.exportAs(exportLabel(format))}
              onClick={() => void onExport(format)}
            >
              {active ? (
                <LoaderCircle className="evaluation-export-spinner" aria-hidden="true" size={15} />
              ) : (
                <Icon aria-hidden="true" size={15} />
              )}
              <span>{exportLabel(format)}</span>
              <Download aria-hidden="true" size={13} />
            </button>
          );
        })}
      </div>
      {activeExport === null ? null : (
        <span className="evaluation-export-status" role="status">
          {copy.exportPreparing(exportLabel(activeExport))}
        </span>
      )}
      {exportError === null ? null : (
        <span className="evaluation-export-error" role="alert">
          {exportError}
        </span>
      )}
    </div>
  );
}

function Metric({
  icon,
  label,
  value,
  detail,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly value: string;
  readonly detail: string;
}): ReactNode {
  return (
    <div className="evaluation-report-metric">
      <span className="evaluation-report-metric-icon">{icon}</span>
      <span>
        <small>{label}</small>
        <strong title={value}>{value}</strong>
        <span>{detail}</span>
      </span>
    </div>
  );
}

function AggregateResult({
  aggregate,
  language,
}: {
  readonly aggregate: ProfileEvaluationAggregate;
  readonly language: SupportedLocale;
}): ReactNode {
  const copy = REPORT_COPY[language];
  return (
    <div className="evaluation-dimension-aggregate">
      {aggregate.score === null ? (
        <strong>{copy.noScore}</strong>
      ) : (
        <Score value={aggregate.score} language={language} />
      )}
      <small>{copy.scoredCount(aggregate.scoredItemCount, aggregate.totalItemCount)}</small>
    </div>
  );
}

function EvaluationItem({
  item,
  initiallyOpen,
  language,
}: {
  readonly item: ProfileEvaluationReportItem;
  readonly initiallyOpen: boolean;
  readonly language: SupportedLocale;
}): ReactNode {
  const copy = REPORT_COPY[language];
  const status = copy.itemStatus[item.status];
  const StatusIcon = status.icon;
  return (
    <details
      className={`evaluation-result-item is-${item.status}`}
      open={initiallyOpen}
      data-item-id={item.itemId}
    >
      <summary>
        <span className="evaluation-result-identity">
          <code>{item.itemId}</code>
          <strong>{item.name}</strong>
        </span>
        <span className={`evaluation-item-status is-${item.status}`} title={status.detail}>
          <StatusIcon aria-hidden="true" size={14} />
          {status.label}
        </span>
        {item.score === null ? (
          <span className="evaluation-no-score">{copy.noScore}</span>
        ) : (
          <Score value={item.score} language={language} />
        )}
        <ChevronDown className="evaluation-result-chevron" aria-hidden="true" size={17} />
      </summary>

      <div className="evaluation-result-body">
        <div className="evaluation-result-context">
          <LabeledText label={copy.codingInstruction} value={item.codingInstruction} />
          <LabeledText label={copy.auditableRationale} value={item.rationale} />
          <Confidence value={item.confidence} language={language} />
        </div>

        <AppliedAnchor item={item} language={language} />

        <div className="evaluation-evidence-grid">
          <EvidenceList
            title={copy.supportingEvidence}
            evidence={item.supportingEvidence}
            emptyLabel={copy.noSupportingEvidence}
            language={language}
            tone="supporting"
          />
          <EvidenceList
            title={copy.counterEvidence}
            evidence={item.counterEvidence}
            emptyLabel={copy.noCounterEvidence}
            language={language}
            tone="counter"
          />
        </div>

        <section className="evaluation-missing-information">
          <h6>{copy.missingInformation}</h6>
          {item.missingInformation.length === 0 ? (
            <p>{copy.noMissingInformation}</p>
          ) : (
            <ul>
              {item.missingInformation.map((entry, index) => (
                <li key={`${item.itemId}:missing:${String(index)}`}>{entry}</li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </details>
  );
}

function LabeledText({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): ReactNode {
  return (
    <div>
      <span className="evaluation-report-section-label">{label}</span>
      <p>{value}</p>
    </div>
  );
}

function Confidence({
  value,
  language,
}: {
  readonly value: number;
  readonly language: SupportedLocale;
}): ReactNode {
  const copy = REPORT_COPY[language];
  const formatted = formatPercent(value, language);
  return (
    <div className="evaluation-confidence">
      <span>
        <small>{copy.confidence}</small>
        <strong>{formatted}</strong>
      </span>
      <meter min={0} max={1} value={value} aria-label={`${copy.confidence} ${formatted}`} />
      <small>{copy.coderConfidence}</small>
    </div>
  );
}

function AppliedAnchor({
  item,
  language,
}: {
  readonly item: ProfileEvaluationReportItem;
  readonly language: SupportedLocale;
}): ReactNode {
  const copy = REPORT_COPY[language];
  if (item.appliedAnchor === null) {
    return (
      <section className="evaluation-applied-anchor is-empty" aria-label={copy.anchorDecision}>
        <Scale aria-hidden="true" size={17} />
        <div>
          <strong>{copy.noNumericAnchor}</strong>
          <p>{copy.itemStatus[item.status].detail}.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="evaluation-applied-anchor" aria-label={copy.appliedAnchorAria}>
      <span className="evaluation-anchor-score">{String(item.appliedAnchor.score)}</span>
      <div>
        <strong>{copy.appliedAnchor(item.appliedAnchor.score)}</strong>
        <p>{item.appliedAnchor.criterion}</p>
      </div>
      <details className="evaluation-anchor-scale">
        <summary>{copy.fullAnchorScale}</summary>
        <ol>
          {item.anchors.map((anchor) => (
            <li
              className={anchor.score === item.appliedAnchor?.score ? 'is-applied' : ''}
              value={anchor.score}
              key={anchor.score}
            >
              <strong>{String(anchor.score)}</strong>
              <span>{anchor.criterion}</span>
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
}

function EvidenceList({
  title,
  evidence,
  emptyLabel,
  language,
  tone,
}: {
  readonly title: string;
  readonly evidence: readonly ProfileEvaluationEvidenceReference[];
  readonly emptyLabel: string;
  readonly language: SupportedLocale;
  readonly tone: 'supporting' | 'counter';
}): ReactNode {
  const copy = REPORT_COPY[language];
  return (
    <section className={`evaluation-evidence-list is-${tone}`}>
      <h6>
        <Quote aria-hidden="true" size={14} />
        {title}
        <span>{String(evidence.length)}</span>
      </h6>
      {evidence.length === 0 ? (
        <p className="evaluation-evidence-empty">{emptyLabel}</p>
      ) : (
        <ul>
          {evidence.map((reference, index) => (
            <li key={`${reference.turnId}:${String(reference.sequenceNumber)}:${String(index)}`}>
              <span className="evaluation-evidence-type">{copy.evidenceLabel}</span>
              {[reference, ...(reference.additionalSources ?? [])].map((source, sourceIndex) => (
                <div
                  className="evaluation-evidence-source"
                  key={`${source.turnId}:${String(sourceIndex)}`}
                >
                  <a href={`#transcript-turn-${source.turnId}`}>
                    {copy.turn(source.sequenceNumber)}
                    <code>{source.turnId}</code>
                  </a>
                  <blockquote>{source.verbatimExcerpt}</blockquote>
                </div>
              ))}
              {reference.inference ? (
                <p className="evaluation-evidence-inference">
                  <strong>{copy.evidenceInference}: </strong>
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

function RunMetadata({
  evaluation,
  language,
}: {
  readonly evaluation: CompletedProfileEvaluation;
  readonly language: SupportedLocale;
}): ReactNode {
  const { report } = evaluation;
  const copy = REPORT_COPY[language];
  return (
    <section className="evaluation-run-metadata" aria-labelledby="evaluation-run-metadata-title">
      <div className="evaluation-report-section-heading">
        <div>
          <span className="evaluation-report-section-label">{copy.provenance}</span>
          <h3 id="evaluation-run-metadata-title">{copy.runMetadata}</h3>
        </div>
      </div>
      <dl>
        <Metadata label={copy.evaluationRunId} value={evaluation.evaluationId} mono />
        <Metadata label={copy.interviewId} value={evaluation.interviewId} mono />
        <Metadata label={copy.profileId} value={evaluation.profileId} mono />
        <Metadata label={copy.profileName} value={report.profileName} />
        <Metadata
          label={copy.profileVersion}
          value={formatDateTime(report.profileUpdatedAt, language)}
        />
        <Metadata label={copy.promptVersion} value={report.promptVersion} mono />
        <Metadata label={copy.mode} value={report.model.mode === 'demo' ? 'Demo' : 'Provider'} />
        <Metadata label={copy.provider} value={report.model.provider ?? copy.notUsed} />
        <Metadata label={copy.model} value={report.model.model ?? copy.deterministicDemoCoder} />
        <Metadata label={copy.started} value={formatDateTime(evaluation.startedAt, language)} />
        <Metadata label={copy.completed} value={formatDateTime(evaluation.completedAt, language)} />
        <Metadata
          label={copy.reportLanguage}
          value={report.language === 'en' ? 'English' : 'Deutsch'}
        />
        <Metadata
          label={copy.translationStatus}
          value={
            report.profileTranslation === null ? copy.originalLanguage : copy.controlledTranslation
          }
        />
        <Metadata label={copy.profileFingerprint} value={report.profileFingerprint} mono />
        <Metadata label={copy.transcriptFingerprint} value={report.transcriptFingerprint} mono />
      </dl>
    </section>
  );
}

function Metadata({
  label,
  value,
  mono = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
}): ReactNode {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={mono ? 'is-mono' : undefined}>{value}</dd>
    </div>
  );
}

function Score({
  value,
  language,
}: {
  readonly value: number;
  readonly language: SupportedLocale;
}): ReactNode {
  const formatted = formatScore(value, language);
  return (
    <span className="evaluation-score" title={REPORT_COPY[language].scoreTitle(formatted)}>
      <strong>{formatted}</strong>
      <small>/7</small>
    </span>
  );
}

function modelName(evaluation: CompletedProfileEvaluation, copy: ReportCopy): string {
  return evaluation.report.model.model ?? copy.demoCoder;
}

function modelDetail(evaluation: CompletedProfileEvaluation, copy: ReportCopy): string {
  return (
    evaluation.report.model.provider ??
    (evaluation.report.model.mode === 'demo' ? copy.deterministicDemoMode : copy.providerMode)
  );
}

function exportIcon(format: ProfileEvaluationExportFormat): typeof FileJson2 {
  switch (format) {
    case 'json':
      return FileJson2;
    case 'csv':
      return Table2;
    case 'markdown':
      return FileText;
    case 'html':
      return Code2;
  }
}

function exportLabel(format: ProfileEvaluationExportFormat): string {
  return format === 'markdown' ? 'Markdown' : format.toUpperCase();
}

function formatAggregateScore(
  aggregate: ProfileEvaluationAggregate,
  language: SupportedLocale,
  unbounded = false,
): string {
  return aggregate.score === null
    ? REPORT_COPY[language].noScore
    : `${formatScore(aggregate.score, language, unbounded)}${unbounded ? '' : ' / 7'}`;
}

function formatCalculationNumber(value: number, language: SupportedLocale): string {
  return new Intl.NumberFormat(localeTag(language), {
    maximumSignificantDigits: 17,
    notation:
      value !== 0 && (Math.abs(value) < 0.000001 || Math.abs(value) >= 1e9)
        ? 'scientific'
        : 'standard',
  }).format(value);
}

function formatScore(value: number, language: SupportedLocale, unbounded = false): string {
  return new Intl.NumberFormat(localeTag(language), {
    maximumFractionDigits: 2,
    notation: unbounded && Math.abs(value) >= 1e9 ? 'scientific' : 'standard',
  }).format(value);
}

function formatPercent(value: number, language: SupportedLocale): string {
  return new Intl.NumberFormat(localeTag(language), {
    style: 'percent',
    maximumFractionDigits: 0,
  }).format(value);
}

function formatDateTime(value: string, language: SupportedLocale): string {
  return new Intl.DateTimeFormat(localeTag(language), {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function formatDuration(startedAt: string, completedAt: string, language: SupportedLocale): string {
  const durationMs = Math.max(0, Date.parse(completedAt) - Date.parse(startedAt));
  const totalSeconds = Math.round(durationMs / 1_000);
  if (totalSeconds < 60) {
    return language === 'en' ? `${String(totalSeconds)} sec` : `${String(totalSeconds)} s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (seconds === 0) return `${String(minutes)} min`;
  return language === 'en'
    ? `${String(minutes)} min ${String(seconds)} sec`
    : `${String(minutes)} min ${String(seconds)} s`;
}

function localeTag(language: SupportedLocale): 'de-DE' | 'en-GB' {
  return language === 'en' ? 'en-GB' : 'de-DE';
}
