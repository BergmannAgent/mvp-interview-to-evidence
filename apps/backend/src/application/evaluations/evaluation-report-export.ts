import type {
  EvaluationExportFormat,
  EvaluationReport,
  ProfileEvaluationAggregate,
  ProfileEvaluationEvidenceReference,
  ProfileEvaluationItemStatus,
  ProfileEvaluationReportItem,
  SupportedLocale,
} from '@orgscience/contracts';

export interface EvaluationReportExportArtifact {
  readonly contentType:
    | 'application/json; charset=utf-8'
    | 'text/csv; charset=utf-8'
    | 'text/markdown; charset=utf-8'
    | 'text/html; charset=utf-8';
  readonly fileName: string;
  readonly body: string;
}

interface ReportCopy {
  readonly transcriptSnapshot: string;
  readonly partialInterviewNotice: string;
  readonly ignoredPartialNotice: string;
  readonly participantDetails: string;
  readonly participantAge: string;
  readonly participantPosition: string;
  readonly participantNotStated: string;
  readonly participantNotExtracted: string;
  readonly reportTitle: string;
  readonly interviewId: string;
  readonly evaluationId: string;
  readonly profileId: string;
  readonly evaluatedAt: string;
  readonly overallStatus: string;
  readonly overallScore: string;
  readonly scoredItems: string;
  readonly status: string;
  readonly dimensionScore: string;
  readonly score: string;
  readonly confidence: string;
  readonly confidenceNoticeTitle: string;
  readonly confidenceNotice: string;
  readonly rationale: string;
  readonly supportingEvidence: string;
  readonly counterEvidence: string;
  readonly evidence: string;
  readonly inference: string;
  readonly additionalSource: string;
  readonly missingInformation: string;
  readonly allProfileAnchors: string;
  readonly provenance: string;
  readonly profileVersion: string;
  readonly profileFingerprint: string;
  readonly transcriptFingerprint: string;
  readonly promptVersion: string;
  readonly model: string;
  readonly demoMode: string;
  readonly language: string;
  readonly profileTranslation: string;
  readonly methodology: string;
  readonly methodologySummary: string;
  readonly limitations: string;
  readonly limitationItems: readonly string[];
  readonly translatedProfileLimitation: string;
  readonly notCalculated: string;
  readonly noScore: string;
  readonly noValue: string;
  readonly noOverallValue: string;
  readonly itemStatus: Readonly<Record<ProfileEvaluationItemStatus, string>>;
  readonly aggregateStatus: Readonly<Record<ProfileEvaluationAggregate['status'], string>>;
  scoredCount(scored: number, total: number): string;
  appliedAnchor(score: number): string;
  dimensionSummary(
    scored: number,
    total: number,
    status: ProfileEvaluationAggregate['status'],
  ): string;
}

const REPORT_COPY = {
  de: {
    transcriptSnapshot: 'Transkriptstand',
    partialInterviewNotice:
      'Vorläufige Auswertung des bisherigen Transkripts. Das Interview wurde noch nicht vollständig abgeschlossen oder finalisiert. Fehlende Antworten sind keine negative Evidenz.',
    ignoredPartialNotice: 'Unbestätigte partielle Transkriptionen wurden nicht ausgewertet.',
    participantDetails: 'Interviewperson',
    participantAge: 'Alter',
    participantPosition: 'Position laut Transkript',
    participantNotStated: 'Nicht angegeben oder nicht eindeutig',
    participantNotExtracted: 'Nicht erfasst',
    reportTitle: 'Auswertungsreport',
    interviewId: 'Interview-ID',
    evaluationId: 'Evaluation-ID',
    profileId: 'Profil-ID',
    evaluatedAt: 'Ausgewertet am',
    overallStatus: 'Gesamtstatus',
    overallScore: 'Gesamtwert',
    scoredItems: 'Bewertete Items',
    status: 'Status',
    dimensionScore: 'Dimensionswert',
    score: 'Wert',
    confidence: 'Konfidenz',
    confidenceNoticeTitle: 'Hinweis zur KI-generierten Konfidenz',
    confidenceNotice:
      'Die vom KI-Scoring-Agent ausgegebenen Konfidenzwerte sind modellgenerierte Selbsteinschätzungen. Sie sind keine statistisch kalibrierten Wahrscheinlichkeiten oder Konfidenzintervalle und garantieren nicht die Richtigkeit der Bewertung. Scores und Evidenz sollten fachlich geprüft werden.',
    rationale: 'Begruendung',
    supportingEvidence: 'Fördernde Evidenz',
    counterEvidence: 'Hemmende Evidenz',
    evidence: 'Evidenz',
    inference: 'Ableitung',
    additionalSource: 'Weitere Quelle',
    missingInformation: 'Fehlende Informationen',
    allProfileAnchors: 'Alle Profilanker',
    provenance: 'Provenienz',
    profileVersion: 'Profilstand',
    profileFingerprint: 'Profil-Fingerprint',
    transcriptFingerprint: 'Transkript-Fingerprint',
    promptVersion: 'Prompt-Version',
    model: 'Modell',
    demoMode: 'Demo-Modus',
    language: 'Sprache',
    profileTranslation: 'Profiluebersetzung',
    methodology: 'Methodik',
    methodologySummary:
      'Die Auswertung codiert ausschliesslich Evidenz aus finalen Teilnehmenden-Turns gegen die sieben Profilanker.',
    limitations: 'Limitationen',
    limitationItems: [
      'Ein einzelnes Interview belegt Aussagen der befragten Person, aber keine organisationsweite Wahrheit.',
      'Fehlende Information ist keine beobachtete negative Evidenz und darf nicht als niedriger Score behandelt werden.',
      'Profilanker und Coder-Ausgabe sind keine eigenstaendig psychometrisch validierte Skala und benoetigen eine unabhaengige Pruefung im Anwendungskontext.',
      'Teilaggregate sind nur zusammen mit der Anzahl bewerteter und nicht bewerteter Items zu interpretieren.',
    ],
    translatedProfileLimitation:
      'Die englische Fassung des Standardprofils ist eine kontrollierte Uebersetzung des abgeleiteten Pilotinstruments und keine eigenstaendig psychometrisch validierte Skala.',
    notCalculated: 'Nicht berechnet',
    noScore: 'Kein Score',
    noValue: 'Kein Wert',
    noOverallValue: 'Kein Gesamtwert',
    itemStatus: {
      scored: 'Bewertet',
      insufficient_evidence: 'Unzureichende Evidenz',
      not_applicable: 'Nicht anwendbar',
      conflicting: 'Widerspruechliche Evidenz',
    },
    aggregateStatus: {
      complete: 'Vollstaendig',
      partial: 'Teilweise',
      not_scored: 'Nicht bewertet',
    },
    scoredCount: (scored, total) => `${String(scored)} von ${String(total)}`,
    appliedAnchor: (score) => `Verwendeter Anker ${String(score)}`,
    dimensionSummary: (scored, total, status) =>
      `${String(scored)} von ${String(total)} Items bewertet (${germanAggregateStatus(status)}).`,
  },
  en: {
    transcriptSnapshot: 'Transcript snapshot',
    partialInterviewNotice:
      'Provisional evaluation of the transcript so far. The interview has not been fully completed or finalized. Missing answers are not negative evidence.',
    ignoredPartialNotice: 'Unconfirmed partial transcriptions were excluded from evaluation.',
    participantDetails: 'Interview participant',
    participantAge: 'Age',
    participantPosition: 'Position stated in transcript',
    participantNotStated: 'Not stated or unclear',
    participantNotExtracted: 'Not recorded',
    reportTitle: 'Evaluation report',
    interviewId: 'Interview ID',
    evaluationId: 'Evaluation ID',
    profileId: 'Profile ID',
    evaluatedAt: 'Evaluated at',
    overallStatus: 'Overall status',
    overallScore: 'Overall score',
    scoredItems: 'Scored items',
    status: 'Status',
    dimensionScore: 'Dimension score',
    score: 'Score',
    confidence: 'Confidence',
    confidenceNoticeTitle: 'AI-generated confidence disclaimer',
    confidenceNotice:
      'Confidence values returned by the AI scoring agent are model-generated self-assessments. They are not statistically calibrated probabilities or confidence intervals and do not guarantee that the evaluation is correct. Scores and evidence should be reviewed by a qualified person.',
    rationale: 'Rationale',
    supportingEvidence: 'Supporting evidence',
    counterEvidence: 'Counter evidence',
    evidence: 'Evidence',
    inference: 'Inference',
    additionalSource: 'Additional source',
    missingInformation: 'Missing information',
    allProfileAnchors: 'All profile anchors',
    provenance: 'Provenance',
    profileVersion: 'Profile version',
    profileFingerprint: 'Profile fingerprint',
    transcriptFingerprint: 'Transcript fingerprint',
    promptVersion: 'Prompt version',
    model: 'Model',
    demoMode: 'Demo mode',
    language: 'Language',
    profileTranslation: 'Profile translation',
    methodology: 'Methodology',
    methodologySummary:
      'The evaluation codes only evidence from final participant turns against the seven profile anchors.',
    limitations: 'Limitations',
    limitationItems: [
      'A single interview supports claims made by the participant, not organization-wide truth.',
      'Missing information is not observed negative evidence and must not be treated as a low score.',
      'Profile anchors and coder output are not an independently psychometrically validated scale and require independent review in context.',
      'Partial aggregates must be interpreted together with the counts of scored and unscored items.',
    ],
    translatedProfileLimitation:
      'The English default-profile text is a controlled translation of the derived pilot instrument, not an independently psychometrically validated scale.',
    notCalculated: 'Not calculated',
    noScore: 'No score',
    noValue: 'No value',
    noOverallValue: 'No overall score',
    itemStatus: {
      scored: 'Scored',
      insufficient_evidence: 'Insufficient evidence',
      not_applicable: 'Not applicable',
      conflicting: 'Conflicting evidence',
    },
    aggregateStatus: {
      complete: 'Complete',
      partial: 'Partial',
      not_scored: 'Not scored',
    },
    scoredCount: (scored, total) => `${String(scored)} of ${String(total)}`,
    appliedAnchor: (score) => `Applied anchor ${String(score)}`,
    dimensionSummary: (scored, total, status) =>
      `${String(scored)} of ${String(total)} items scored (${englishAggregateStatus(status)}).`,
  },
} as const satisfies Readonly<Record<SupportedLocale, ReportCopy>>;

function germanAggregateStatus(status: ProfileEvaluationAggregate['status']): string {
  if (status === 'complete') return 'Vollstaendig';
  if (status === 'partial') return 'Teilweise';
  return 'Nicht bewertet';
}

function englishAggregateStatus(status: ProfileEvaluationAggregate['status']): string {
  if (status === 'complete') return 'Complete';
  if (status === 'partial') return 'Partial';
  return 'Not scored';
}

/** Serializes exactly one persisted canonical report without deriving scores or evidence. */
export function exportEvaluationReport(
  sourceReport: EvaluationReport,
  format: EvaluationExportFormat,
): EvaluationReportExportArtifact {
  const report = {
    ...sourceReport,
    dimensions: sourceReport.dimensions.map((dimension) => ({
      ...dimension,
      items: dimension.items.map((item) => ({
        ...item,
        supportingEvidence: item.supportingEvidence.map(withoutEvidenceType),
        counterEvidence: item.counterEvidence.map(withoutEvidenceType),
      })),
    })),
  };
  const baseName = `interview-${safeFileSegment(report.interviewId)}-profile-${safeFileSegment(report.profileId)}-evaluation`;
  const copy = REPORT_COPY[report.language];
  switch (format) {
    case 'json':
      // The canonical report already persists its language and localized coder/profile text.
      return {
        contentType: 'application/json; charset=utf-8',
        fileName: `${baseName}.json`,
        body: `${JSON.stringify(report, null, 2)}\n`,
      };
    case 'csv':
      return {
        contentType: 'text/csv; charset=utf-8',
        fileName: `${baseName}.csv`,
        body: exportCsv(report, copy),
      };
    case 'markdown':
      return {
        contentType: 'text/markdown; charset=utf-8',
        fileName: `${baseName}.md`,
        body: exportMarkdown(report, copy),
      };
    case 'html':
      return {
        contentType: 'text/html; charset=utf-8',
        fileName: `${baseName}.html`,
        body: exportHtml(report, copy),
      };
  }
}

function exportCsv(report: EvaluationReport, copy: ReportCopy): string {
  const header = [
    'schema_version',
    'report_kind',
    'evaluation_id',
    'interview_id',
    'profile_id',
    'profile_name',
    'profile_updated_at',
    'profile_fingerprint',
    'transcript_fingerprint',
    'language',
    'profile_translation_overlay_id',
    'profile_translation_overlay_version',
    'profile_translation_overlay_fingerprint',
    'prompt_version',
    'model_mode',
    'model_provider',
    'model_name',
    'evaluated_at',
    'overall_status',
    'overall_status_label',
    'overall_score',
    'overall_scored_item_count',
    'overall_unscored_item_count',
    'overall_total_item_count',
    'report_rationale',
    'participant_details_json',
    'dimension_id',
    'dimension_name',
    'dimension_order',
    'dimension_status',
    'dimension_status_label',
    'dimension_score',
    'dimension_scored_item_count',
    'dimension_unscored_item_count',
    'dimension_total_item_count',
    'item_id',
    'item_name',
    'item_order',
    'status',
    'status_label',
    'score',
    'anchors_json',
    'applied_anchor_score',
    'applied_anchor_criterion',
    'confidence',
    'confidence_notice',
    'supporting_evidence_json',
    'counter_evidence_json',
    'missing_information_json',
    'rationale',
    'methodology',
    'limitations_json',
    'legacy_evidence_notice',
    'source_transcript_json',
    'aggregation_mode',
    'custom_formula',
    'calculation_status',
    'calculation_result',
    'calculation_unrounded_result',
    'calculation_error_json',
    'calculation_weighted_sum',
    'calculation_weight_sum',
    'dimension_weight',
    'item_weight',
    'effective_weight',
    'effective_contribution',
    'calculation_included',
    'calculation_exclusion',
    'excluded_item_ids_json',
    'zero_substituted_ids_json',
    'calculation_trace_json',
  ];
  const limitations = JSON.stringify(reportLimitations(report, copy));
  const rows = report.dimensions.flatMap((dimension) =>
    dimension.items.map((item) => [
      String(report.schemaVersion),
      report.reportKind,
      report.evaluationId,
      report.interviewId,
      report.profileId,
      report.profileName,
      report.profileUpdatedAt,
      report.profileFingerprint,
      report.transcriptFingerprint,
      report.language,
      report.profileTranslation?.overlayId ?? '',
      report.profileTranslation?.overlayVersion ?? '',
      report.profileTranslation?.overlayFingerprintSha256 ?? '',
      report.promptVersion,
      report.model.mode,
      report.model.provider ?? '',
      report.model.model ?? '',
      report.evaluatedAt,
      report.overallAggregate.status,
      copy.aggregateStatus[report.overallAggregate.status],
      report.overallAggregate.score === null ? '' : String(report.overallAggregate.score),
      String(report.overallAggregate.scoredItemCount),
      String(report.overallAggregate.unscoredItemCount),
      String(report.overallAggregate.totalItemCount),
      report.rationale,
      report.participantDetails === undefined ? '' : JSON.stringify(report.participantDetails),
      dimension.dimensionId,
      dimension.name,
      String(dimension.order),
      dimension.aggregate.status,
      copy.aggregateStatus[dimension.aggregate.status],
      dimension.aggregate.score === null ? '' : String(dimension.aggregate.score),
      String(dimension.aggregate.scoredItemCount),
      String(dimension.aggregate.unscoredItemCount),
      String(dimension.aggregate.totalItemCount),
      item.itemId,
      item.name,
      String(item.order),
      item.status,
      copy.itemStatus[item.status],
      item.score === null ? '' : String(item.score),
      JSON.stringify(item.anchors),
      item.appliedAnchor === null ? '' : String(item.appliedAnchor.score),
      item.appliedAnchor?.criterion ?? '',
      String(item.confidence),
      copy.confidenceNotice,
      JSON.stringify(item.supportingEvidence),
      JSON.stringify(item.counterEvidence),
      JSON.stringify(item.missingInformation),
      item.rationale,
      methodologySummary(report, copy),
      limitations,
    ]),
  );
  const traceItems = report.calculation.items;
  const csvItems = report.dimensions.flatMap((dimension) => dimension.items);
  const rowsWithNotice = rows.map((row, index) => {
    const item = traceItems.find((candidate) => candidate.itemId === csvItems[index]?.itemId);
    return [
      ...row,
      index === 0 ? (report.legacyEvidenceNotice ?? '') : '',
      report.sourceTranscript === undefined ? '' : JSON.stringify(report.sourceTranscript),
      report.calculation.mode,
      report.calculation.expression ?? '',
      report.calculation.status,
      numericCell(report.calculation.result),
      numericCell(report.calculation.unroundedResult),
      report.calculation.error === null ? '' : JSON.stringify(report.calculation.error),
      numericCell(report.calculation.weightedSum),
      numericCell(report.calculation.weightSum),
      numericCell(item?.dimensionWeight),
      numericCell(item?.itemWeight),
      numericCell(item?.effectiveWeight),
      numericCell(item === undefined ? null : effectiveContribution(item)),
      item === undefined ? '' : String(item.included),
      item?.exclusion ?? '',
      JSON.stringify(
        traceItems.filter((candidate) => !candidate.included).map(({ itemId }) => itemId),
      ),
      JSON.stringify(
        report.calculation.references
          .filter(({ zeroSubstituted }) => zeroSubstituted)
          .map(({ function: referenceFunction, id }) => ({ function: referenceFunction, id })),
      ),
      JSON.stringify(report.calculation),
    ];
  });
  return `${[header, ...rowsWithNotice].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

function exportMarkdown(report: EvaluationReport, copy: ReportCopy): string {
  const lines = [
    `# ${copy.reportTitle}: ${md(report.profileName)}`,
    '',
    `- **${copy.interviewId}:** ${md(report.interviewId)}`,
    `- **${copy.evaluationId}:** ${md(report.evaluationId)}`,
    `- **${copy.profileId}:** ${md(report.profileId)}`,
    `- **${copy.language}:** ${report.language}`,
    `- **${copy.evaluatedAt}:** ${md(report.evaluatedAt)}`,
    `- **${copy.overallStatus}:** ${copy.aggregateStatus[report.overallAggregate.status]}`,
    `- **${copy.overallScore}:** ${md(overallScoreText(report, copy.notCalculated))}`,
    `- **${copy.scoredItems}:** ${copy.scoredCount(report.overallAggregate.scoredItemCount, report.overallAggregate.totalItemCount)}`,
    '',
    md(report.rationale),
    '',
    `## ${copy.confidenceNoticeTitle}`,
    '',
    md(copy.confidenceNotice),
  ];
  if (report.sourceTranscript !== undefined) {
    lines.push('', `- **${copy.transcriptSnapshot}:** ${md(transcriptSnapshotText(report))}`);
    if (isPartialReport(report)) lines.push('', `> ${md(copy.partialInterviewNotice)}`);
    if (report.sourceTranscript.ignoredPartial)
      lines.push('', `> ${md(copy.ignoredPartialNotice)}`);
  }
  if (report.legacyEvidenceNotice) lines.push('', md(report.legacyEvidenceNotice));

  lines.push('', `## ${copy.participantDetails}`, '');
  for (const field of ['age', 'position'] as const) {
    const detail = report.participantDetails?.[field];
    lines.push(
      `- **${field === 'age' ? copy.participantAge : copy.participantPosition}:** ${md(participantDetailValue(report, field, copy))}`,
    );
    if (detail != null) {
      lines.push(
        `  - Turn ${String(detail.source.sequenceNumber)} (${md(detail.source.turnId)}): "${md(detail.source.verbatimExcerpt)}"`,
      );
    }
  }

  for (const dimension of report.dimensions) {
    lines.push(
      '',
      `## ${md(dimension.name)}`,
      '',
      `- **${copy.status}:** ${copy.aggregateStatus[dimension.aggregate.status]}`,
      `- **${copy.dimensionScore}:** ${dimension.aggregate.score === null ? copy.notCalculated : md(`${String(dimension.aggregate.score)} / 7`)}`,
      `- **${copy.scoredItems}:** ${copy.scoredCount(dimension.aggregate.scoredItemCount, dimension.aggregate.totalItemCount)}`,
    );
    for (const item of dimension.items) appendMarkdownItem(lines, item, copy);
  }

  appendMarkdownCalculation(lines, report);
  lines.push('', `## ${copy.methodology}`, '', md(methodologySummary(report, copy)));
  lines.push('', `### ${copy.limitations}`, '');
  for (const limitation of reportLimitations(report, copy)) lines.push(`- ${md(limitation)}`);

  lines.push(
    '',
    `## ${copy.provenance}`,
    '',
    `- **${copy.profileVersion}:** ${md(report.profileUpdatedAt)}`,
    `- **${copy.profileFingerprint}:** ${md(report.profileFingerprint)}`,
    `- **${copy.transcriptFingerprint}:** ${md(report.transcriptFingerprint)}`,
    `- **${copy.promptVersion}:** ${md(report.promptVersion)}`,
    `- **${copy.model}:** ${md(report.model.model ?? copy.demoMode)}`,
  );
  if (report.profileTranslation !== null) {
    lines.push(
      `- **${copy.profileTranslation}:** ${md(`${report.profileTranslation.overlayId}@${report.profileTranslation.overlayVersion} (${report.profileTranslation.overlayFingerprintSha256})`)}`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

function appendMarkdownItem(
  lines: string[],
  item: ProfileEvaluationReportItem,
  copy: ReportCopy,
): void {
  lines.push(
    '',
    `### ${md(item.name)} (${md(item.itemId)})`,
    '',
    `- **${copy.status}:** ${copy.itemStatus[item.status]}`,
    `- **${copy.score}:** ${item.score === null ? copy.noScore : md(`${String(item.score)} / 7`)}`,
    `- **${copy.confidence}:** ${md(String(item.confidence))}`,
    `- **${copy.rationale}:** ${md(item.rationale)}`,
  );
  if (item.appliedAnchor !== null) {
    lines.push(
      `- **${copy.appliedAnchor(item.appliedAnchor.score)}:** ${md(item.appliedAnchor.criterion)}`,
    );
  }
  appendMarkdownEvidence(lines, copy.supportingEvidence, item.supportingEvidence, copy);
  appendMarkdownEvidence(lines, copy.counterEvidence, item.counterEvidence, copy);
  if (item.missingInformation.length > 0) {
    lines.push('', `**${copy.missingInformation}:**`);
    for (const information of item.missingInformation) lines.push(`- ${md(information)}`);
  }
  lines.push('', '<details>', `<summary>${copy.allProfileAnchors}</summary>`, '');
  for (const anchor of item.anchors) {
    lines.push(`- **${String(anchor.score)}:** ${md(anchor.criterion)}`);
  }
  lines.push('', '</details>');
}

function appendMarkdownEvidence(
  lines: string[],
  heading: string,
  evidence: readonly ProfileEvaluationEvidenceReference[],
  copy: ReportCopy,
): void {
  if (evidence.length === 0) return;
  lines.push('', `**${heading}:**`);
  for (const reference of evidence) {
    lines.push(
      `- **${copy.evidence}** | Turn ${String(reference.sequenceNumber)} (${md(reference.turnId)}): "${md(reference.verbatimExcerpt)}"`,
    );
    for (const source of reference.additionalSources ?? []) {
      lines.push(
        `  - **${copy.additionalSource}:** Turn ${String(source.sequenceNumber)} (${md(source.turnId)}): "${md(source.verbatimExcerpt)}"`,
      );
    }
    if (reference.inference) {
      lines.push(`  - **${copy.inference}:** ${md(reference.inference)}`);
    }
  }
}

function exportHtml(report: EvaluationReport, copy: ReportCopy): string {
  const dimensions = report.dimensions
    .map(
      (dimension) => `<section class="dimension">
  <header><div><h2>${html(dimension.name)}</h2><code>${html(dimension.dimensionId)}</code></div><strong>${dimension.aggregate.score === null ? copy.noValue : `${String(dimension.aggregate.score)} / 7`}</strong></header>
  <p>${html(copy.dimensionSummary(dimension.aggregate.scoredItemCount, dimension.aggregate.totalItemCount, dimension.aggregate.status))}</p>
  ${dimension.items.map((item) => itemHtml(item, copy)).join('\n')}
</section>`,
    )
    .join('\n');
  const translation =
    report.profileTranslation === null
      ? ''
      : `<dt>${copy.profileTranslation}</dt><dd>${html(`${report.profileTranslation.overlayId}@${report.profileTranslation.overlayVersion}`)}<br><code>${html(report.profileTranslation.overlayFingerprintSha256)}</code></dd>`;
  const limitations = reportLimitations(report, copy)
    .map((limitation) => `<li>${html(limitation)}</li>`)
    .join('');
  return `<!doctype html>
<html lang="${report.language}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
  <title>${html(report.profileName)} - ${copy.reportTitle}</title>
  <style>
    :root { color-scheme: light; font-family: Arial, sans-serif; line-height: 1.45; color: #17202a; }
    body { max-width: 1050px; margin: 0 auto; padding: 32px; }
    h1, h2, h3 { break-after: avoid; }
    h1 { border-bottom: 2px solid #176b5b; padding-bottom: 10px; }
    header { display: flex; align-items: start; justify-content: space-between; gap: 24px; }
    dl { display: grid; grid-template-columns: minmax(150px, 230px) 1fr; gap: 6px 18px; }
    dt { font-weight: 700; } dd { margin: 0; overflow-wrap: anywhere; }
    .calculation-table { overflow-x: auto; margin: 16px 0; }
    table { border-collapse: collapse; width: 100%; font-size: 0.85rem; }
    th, td { border: 1px solid #c9d0cd; padding: 6px; text-align: left; overflow-wrap: anywhere; }
    .dimension { border-top: 3px solid #176b5b; margin-top: 28px; padding-top: 10px; }
    .item { border: 1px solid #c9d0cd; border-radius: 4px; margin: 14px 0; padding: 14px; break-inside: avoid; }
    .applied { border-left: 3px solid #176b5b; padding-left: 8px; }
    .applied small { color: #176b5b; display: block; font-weight: 700; }
    .evidence { border-left: 3px solid #73827d; margin: 8px 0; padding-left: 12px; overflow-wrap: anywhere; }
    .muted { color: #56615e; }
    .confidence-notice { border-left: 3px solid #176b5b; background: #f1f6f4; margin: 20px 0; padding: 12px 16px; break-inside: avoid; }
    .confidence-notice h2 { margin: 0 0 8px; font-size: 1.1rem; }
    .confidence-notice p { margin: 0; }
    @page { size: A4; margin: 16mm; }
    @media print { body { max-width: none; margin: 0; padding: 0; font-size: 10pt; } }
  </style>
</head>
<body>
<header><div><p>${copy.reportTitle}</p><h1>${html(report.profileName)}</h1><p>${html(report.rationale)}</p></div><strong>${html(overallScoreText(report, copy.noOverallValue))}</strong></header>
${report.sourceTranscript === undefined ? '' : `<aside class="confidence-notice" role="note"><h2>${copy.transcriptSnapshot}</h2><p>${html(transcriptSnapshotText(report))}</p>${isPartialReport(report) ? `<p>${html(copy.partialInterviewNotice)}</p>` : ''}${report.sourceTranscript.ignoredPartial ? `<p>${html(copy.ignoredPartialNotice)}</p>` : ''}</aside>`}
<aside class="confidence-notice" role="note"><h2>${copy.confidenceNoticeTitle}</h2><p>${html(copy.confidenceNotice)}</p></aside>
<dl>
  <dt>${copy.interviewId}</dt><dd>${html(report.interviewId)}</dd>
  <dt>${copy.evaluationId}</dt><dd>${html(report.evaluationId)}</dd>
  <dt>${copy.profileId}</dt><dd>${html(report.profileId)}</dd>
  <dt>${copy.language}</dt><dd>${report.language}</dd>
  <dt>${copy.overallStatus}</dt><dd>${copy.aggregateStatus[report.overallAggregate.status]}</dd>
  <dt>${copy.scoredItems}</dt><dd>${html(copy.scoredCount(report.overallAggregate.scoredItemCount, report.overallAggregate.totalItemCount))}</dd>
  <dt>${copy.evaluatedAt}</dt><dd>${html(report.evaluatedAt)}</dd>
</dl>
${report.legacyEvidenceNotice ? `<p class="legacy-evidence-notice">${html(report.legacyEvidenceNotice)}</p>` : ''}
<section><h2>${copy.participantDetails}</h2><dl>${(['age', 'position'] as const)
    .map((field) => {
      const detail = report.participantDetails?.[field];
      const source =
        detail == null
          ? ''
          : `<blockquote>${html(detail.source.verbatimExcerpt)}<footer>Turn ${String(detail.source.sequenceNumber)} | ${html(detail.source.turnId)}</footer></blockquote>`;
      return `<dt>${field === 'age' ? copy.participantAge : copy.participantPosition}</dt><dd>${html(participantDetailValue(report, field, copy))}${source}</dd>`;
    })
    .join('')}</dl></section>
<main>${dimensions}</main>
${calculationHtml(report)}
<section class="methodology"><h2>${copy.methodology}</h2><p>${html(methodologySummary(report, copy))}</p><h3>${copy.limitations}</h3><ul>${limitations}</ul></section>
<section><h2>${copy.provenance}</h2><dl>
  <dt>${copy.profileVersion}</dt><dd>${html(report.profileUpdatedAt)}</dd>
  <dt>${copy.profileFingerprint}</dt><dd><code>${html(report.profileFingerprint)}</code></dd>
  <dt>${copy.transcriptFingerprint}</dt><dd><code>${html(report.transcriptFingerprint)}</code></dd>
  <dt>${copy.promptVersion}</dt><dd>${html(report.promptVersion)}</dd>
  <dt>${copy.model}</dt><dd>${html(report.model.model ?? copy.demoMode)}</dd>
  ${translation}
</dl></section>
</body>
</html>
`;
}

function participantDetailValue(
  report: EvaluationReport,
  field: 'age' | 'position',
  copy: ReportCopy,
): string {
  return (
    report.participantDetails?.[field]?.value ??
    (report.participantDetails === undefined
      ? copy.participantNotExtracted
      : copy.participantNotStated)
  );
}

function itemHtml(item: ProfileEvaluationReportItem, copy: ReportCopy): string {
  const anchors = item.anchors
    .map((anchor) => {
      const applied = item.appliedAnchor?.score === anchor.score;
      return `<li${applied ? ' class="applied"' : ''}><strong>${String(anchor.score)}</strong> ${html(anchor.criterion)}${applied ? ` <small>${html(copy.appliedAnchor(anchor.score))}</small>` : ''}</li>`;
    })
    .join('');
  const missing = item.missingInformation
    .map((information) => `<li>${html(information)}</li>`)
    .join('');
  return `<article class="item" id="item-${html(item.itemId)}">
  <header><div><h3>${html(item.name)}</h3><code>${html(item.itemId)}</code></div><strong>${item.score === null ? copy.noScore : `${String(item.score)} / 7`}</strong></header>
  <dl><dt>${copy.status}</dt><dd>${copy.itemStatus[item.status]}</dd><dt>${copy.confidence}</dt><dd>${html(String(item.confidence))}</dd><dt>${copy.rationale}</dt><dd>${html(item.rationale)}</dd></dl>
  ${evidenceSectionHtml(copy.supportingEvidence, item.supportingEvidence, copy)}
  ${evidenceSectionHtml(copy.counterEvidence, item.counterEvidence, copy)}
  ${missing.length === 0 ? '' : `<h4>${copy.missingInformation}</h4><ul>${missing}</ul>`}
  <details><summary>${copy.allProfileAnchors}</summary><ol>${anchors}</ol></details>
</article>`;
}

function evidenceSectionHtml(
  heading: string,
  evidence: readonly ProfileEvaluationEvidenceReference[],
  copy: ReportCopy,
): string {
  if (evidence.length === 0) return '';
  return `<section><h4>${html(heading)}</h4>${evidence
    .map((reference) => {
      const additionalSources = (reference.additionalSources ?? [])
        .map(
          (source) =>
            `<p>${copy.additionalSource}</p><blockquote><p>${html(source.verbatimExcerpt)}</p><footer>Turn ${String(source.sequenceNumber)} | ${html(source.turnId)}</footer></blockquote>`,
        )
        .join('');
      const inference = reference.inference
        ? `<p><strong>${copy.inference}:</strong> ${html(reference.inference)}</p>`
        : '';
      return `<div class="evidence"><strong>${copy.evidence}</strong><blockquote><p>${html(reference.verbatimExcerpt)}</p><footer>Turn ${String(reference.sequenceNumber)} | ${html(reference.turnId)}</footer></blockquote>${additionalSources}${inference}</div>`;
    })
    .join('')}</section>`;
}

function withoutEvidenceType(
  reference: ProfileEvaluationEvidenceReference,
): ProfileEvaluationEvidenceReference {
  const { evidenceType, ...evidence } = reference;
  void evidenceType;
  return evidence;
}

function reportLimitations(report: EvaluationReport, copy: ReportCopy): readonly string[] {
  return [
    ...copy.limitationItems,
    ...(report.profileTranslation === null ? [] : [copy.translatedProfileLimitation]),
    ...(isPartialReport(report) ? [copy.partialInterviewNotice] : []),
    ...(report.sourceTranscript?.ignoredPartial ? [copy.ignoredPartialNotice] : []),
  ];
}

function isPartialReport(report: EvaluationReport): boolean {
  return (
    report.sourceTranscript !== undefined &&
    (report.sourceTranscript.interviewStatus !== 'completed' || !report.sourceTranscript.finalized)
  );
}

function transcriptSnapshotText(report: EvaluationReport): string {
  const source = report.sourceTranscript;
  return source === undefined
    ? ''
    : `${source.snapshotAt} | ${String(source.turnCount)} Turns | ${source.interviewStatus} | finalized=${String(source.finalized)}`;
}

const CALCULATION_COPY = {
  de: {
    title: 'Berechnung',
    mode: 'Aggregationsmodus',
    expression: 'Formelausdruck',
    status: 'Berechnungsstatus',
    result: 'Ergebnis',
    unrounded: 'Ungerundetes Ergebnis',
    error: 'Rechenfehler',
    weightedSum: 'Gewichtete Summe',
    weightSum: 'Gewichtssumme',
    item: 'Item-ID',
    dimension: 'Dimensions-ID',
    score: 'Score',
    itemWeight: 'Itemgewicht',
    dimensionWeight: 'Dimensionsgewicht',
    effectiveWeight: 'Effektives Gewicht',
    contribution: 'Gewichteter Beitrag',
    included: 'Einbezogen',
    exclusion: 'Ausschlussgrund',
    excluded: 'Aus gewichteten Mitteln ausgeschlossene Item-IDs',
    references: 'Formelreferenzen',
    zeroSubstituted: 'Nullwert als 0 eingesetzt',
    yes: 'Ja',
    no: 'Nein',
    calculationStatus: {
      calculated: 'Berechnet',
      not_calculated: 'Nicht berechnet',
      error: 'Rechenfehler',
    },
    weightedMethod:
      'Dimensionswerte sind serverseitige gewichtete Mittel bewerteter Items. Der Gesamtwert ist das gewichtete Mittel mit Itemgewicht mal Dimensionsgewicht. Fehlende Scores und effektive Nullgewichte sind ausgeschlossen; ausgelassene Gewichte gelten als 1.',
    formulaMethod:
      'Dimensionswerte sind serverseitige gewichtete Mittel bewerteter Items. Der Gesamtwert folgt dem gespeicherten Formelausdruck und ist nicht auf die Skala 1 bis 7 beschraenkt. Nullwerte in item- und dimension-Referenzen werden als 0 eingesetzt und protokolliert; Gewichte sind ueber itemWeight und dimensionWeight referenzierbar.',
  },
  en: {
    title: 'Calculation',
    mode: 'Aggregation mode',
    expression: 'Formula expression',
    status: 'Calculation status',
    result: 'Result',
    unrounded: 'Unrounded result',
    error: 'Calculation error',
    weightedSum: 'Weighted sum',
    weightSum: 'Weight sum',
    item: 'Item ID',
    dimension: 'Dimension ID',
    score: 'Score',
    itemWeight: 'Item weight',
    dimensionWeight: 'Dimension weight',
    effectiveWeight: 'Effective weight',
    contribution: 'Weighted contribution',
    included: 'Included',
    exclusion: 'Exclusion reason',
    excluded: 'Item IDs excluded from weighted means',
    references: 'Formula references',
    zeroSubstituted: 'Null value substituted with 0',
    yes: 'Yes',
    no: 'No',
    calculationStatus: {
      calculated: 'Calculated',
      not_calculated: 'Not calculated',
      error: 'Calculation error',
    },
    weightedMethod:
      'Dimension scores are server-side weighted means of scored items. The overall score uses item weight multiplied by dimension weight. Missing scores and effective zero weights are excluded; omitted weights default to 1.',
    formulaMethod:
      'Dimension scores are server-side weighted means of scored items. The overall score follows the persisted formula expression and is not bounded to the 1 to 7 scale. Null values in item and dimension references are substituted with 0 and recorded; weights are available through itemWeight and dimensionWeight.',
  },
} as const;

function methodologySummary(report: EvaluationReport, copy: ReportCopy): string {
  const calculationCopy = CALCULATION_COPY[report.language];
  return `${copy.methodologySummary} ${report.calculation.mode === 'formula' ? calculationCopy.formulaMethod : calculationCopy.weightedMethod}`;
}

function overallScoreText(report: EvaluationReport, empty: string): string {
  const value = report.overallAggregate.score;
  return value === null
    ? empty
    : `${String(value)}${report.calculation.mode === 'formula' ? '' : ' / 7'}`;
}

type CalculationItem = EvaluationReport['calculation']['items'][number];

function effectiveContribution(item: CalculationItem): number | null {
  if (!item.included || item.score === null || item.effectiveWeight === null) return null;
  const contribution = item.score * item.effectiveWeight;
  return Number.isFinite(contribution) ? contribution : null;
}

function numericCell(value: number | null | undefined): string {
  return value == null ? '' : String(value);
}

function calculationRows(report: EvaluationReport): readonly (readonly string[])[] {
  const trace = report.calculation;
  const copy = CALCULATION_COPY[report.language];
  return [
    [copy.mode, trace.mode],
    [copy.expression, trace.expression ?? '-'],
    [copy.status, copy.calculationStatus[trace.status]],
    [copy.result, trace.result === null ? '-' : String(trace.result)],
    [copy.unrounded, trace.unroundedResult === null ? '-' : String(trace.unroundedResult)],
    [copy.weightedSum, trace.weightedSum === null ? '-' : String(trace.weightedSum)],
    [copy.weightSum, trace.weightSum === null ? '-' : String(trace.weightSum)],
    [copy.error, trace.error === null ? '-' : `${trace.error.code}: ${trace.error.message}`],
    [
      copy.excluded,
      trace.items
        .filter(({ included }) => !included)
        .map(({ itemId }) => itemId)
        .join(', ') || '-',
    ],
  ];
}

function calculationTables(report: EvaluationReport): readonly (readonly (readonly string[])[])[] {
  const trace = report.calculation;
  const copy = CALCULATION_COPY[report.language];
  return [
    [
      [
        copy.item,
        copy.dimension,
        copy.score,
        copy.itemWeight,
        copy.dimensionWeight,
        copy.effectiveWeight,
        copy.contribution,
        copy.included,
        copy.exclusion,
      ],
      ...trace.items.map((item) => [
        item.itemId,
        item.dimensionId,
        numericCell(item.score) || '-',
        String(item.itemWeight),
        String(item.dimensionWeight),
        numericCell(item.effectiveWeight) || '-',
        numericCell(effectiveContribution(item)) || '-',
        item.included ? copy.yes : copy.no,
        item.exclusion ?? '-',
      ]),
    ],
    [
      [
        copy.dimension,
        copy.dimensionWeight,
        copy.result,
        copy.unrounded,
        copy.weightedSum,
        copy.weightSum,
      ],
      ...trace.dimensions.map((dimension) => [
        dimension.dimensionId,
        String(dimension.weight),
        numericCell(dimension.result) || '-',
        numericCell(dimension.unroundedResult) || '-',
        numericCell(dimension.weightedSum) || '-',
        numericCell(dimension.weightSum) || '-',
      ]),
    ],
    [
      [copy.references, 'ID', copy.result, copy.zeroSubstituted],
      ...trace.references.map((reference) => [
        reference.function,
        reference.id,
        String(reference.value),
        reference.zeroSubstituted ? copy.yes : copy.no,
      ]),
    ],
  ];
}

function appendMarkdownCalculation(lines: string[], report: EvaluationReport): void {
  lines.push('', `## ${CALCULATION_COPY[report.language].title}`, '');
  for (const [label, value] of calculationRows(report)) {
    lines.push(`- **${label}:** ${md(value ?? '')}`);
  }
  for (const [header, ...rows] of calculationTables(report)) {
    if (header === undefined || rows.length === 0) continue;
    lines.push(
      '',
      `| ${header.map(md).join(' | ')} |`,
      `| ${header.map(() => '---').join(' | ')} |`,
    );
    for (const row of rows) lines.push(`| ${row.map(md).join(' | ')} |`);
  }
}

function calculationHtml(report: EvaluationReport): string {
  const details = calculationRows(report)
    .map(([label, value]) => `<dt>${html(label ?? '')}</dt><dd>${html(value ?? '')}</dd>`)
    .join('');
  const tables = calculationTables(report)
    .map(([header, ...rows]) => {
      if (header === undefined || rows.length === 0) return '';
      return `<div class="calculation-table"><table><thead><tr>${header.map((value) => `<th>${html(value)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((value) => `<td>${html(value)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    })
    .join('');
  return `<section><h2>${CALCULATION_COPY[report.language].title}</h2><dl>${details}</dl>${tables}</section>`;
}

function csvCell(value: string): string {
  const neutralized = /^[\t\r\n]|^\s*[=+@-]/u.test(value) ? `'${value}` : value;
  return `"${neutralized.replaceAll('"', '""')}"`;
}

function md(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/([`*_{}[\]()#+|])/gu, '\\$1')
    .replace(/\r?\n/gu, '<br>');
}

function html(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replace(/\r?\n/gu, '<br>');
}

function safeFileSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, '_');
}
