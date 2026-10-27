import {
  deriveOrganizationalResilienceEvidenceQuality,
  organizationalResilienceReportSchema,
  type ModelMetadata,
  type MvpInterviewSession,
  type OrganizationalResilienceCodingOutput,
  type OrganizationalResilienceReport,
  type OrganizationalResilienceRubric,
} from '@orgscience/contracts';

import { validateOrganizationalResilienceCodingOutput } from './evaluation-guardrails.js';

const REPORT_LIMITATIONS = Object.freeze([
  'Die Bewertung ist eine abgeleitete 1-bis-7-Evidenzcodierung und nicht die originale validierte 1-bis-5-Selbstauskunftsskala.',
  'Ein einzelnes Experteninterview belegt Aussagen der befragten Person, aber keine organisationsweite Wahrheit.',
  'Die Anker sind literaturbasierte Paraphrasen für einen Pilotprototyp und benötigen eine unabhängige methodische Validierung.',
  'Dimensions- und Gesamtwerte sind deskriptive Pilotmittelwerte und keine validierten Kantur-Skalenwerte.',
]);

export interface OrganizationalResilienceReportMetadata {
  readonly evaluationId: string;
  readonly interviewId: string;
  readonly guideId: string;
  readonly rubricFingerprint: string;
  readonly transcriptFingerprint: string;
  readonly promptVersion: string;
  readonly model: ModelMetadata;
  readonly evaluatedAt: string;
}

export class OrganizationalResilienceReportAuditError extends Error {
  readonly code = 'ORGANIZATIONAL_RESILIENCE_AUDIT_REJECTED' as const;

  constructor(readonly issueSummary: string) {
    super(`Organizational-resilience output failed deterministic audit: ${issueSummary}`);
    this.name = 'OrganizationalResilienceReportAuditError';
  }
}

export function buildOrganizationalResilienceReport(
  rubric: OrganizationalResilienceRubric,
  session: MvpInterviewSession,
  coding: OrganizationalResilienceCodingOutput,
  metadata: OrganizationalResilienceReportMetadata,
): OrganizationalResilienceReport {
  const audited = validateOrganizationalResilienceCodingOutput({ rubric, session }, coding);
  if (!audited.ok) {
    throw new OrganizationalResilienceReportAuditError(
      audited.issues
        .slice(0, 10)
        .map((issue) => `${issue.code}@${issue.path}`)
        .join(', '),
    );
  }

  const items = audited.value.items;
  const dimensions = rubric.dimensions.map((dimension) => {
    const dimensionItems = items.filter((item) => item.dimensionId === dimension.dimensionId);
    const scores = dimensionItems.flatMap((item) => (item.score === null ? [] : [item.score]));
    return {
      dimensionId: dimension.dimensionId,
      label: dimension.label,
      status:
        scores.length === dimensionItems.length
          ? ('complete' as const)
          : scores.length === 0
            ? ('not_scored' as const)
            : ('partial' as const),
      score: scores.length === 0 ? null : mean(scores),
      scoredItemCount: scores.length,
      totalItemCount: dimensionItems.length,
      itemIds: dimension.itemIds,
    };
  });
  const allScores = items.flatMap((item) => (item.score === null ? [] : [item.score]));
  const evidenceQuality = deriveOrganizationalResilienceEvidenceQuality(items);

  return organizationalResilienceReportSchema.parse({
    schemaVersion: 2,
    reportKind: 'organizational_resilience_evidence_report',
    evaluationId: metadata.evaluationId,
    interviewId: metadata.interviewId,
    guideId: metadata.guideId,
    rubricId: rubric.rubricId,
    rubricVersion: rubric.version,
    rubricFingerprint: metadata.rubricFingerprint,
    transcriptFingerprint: metadata.transcriptFingerprint,
    promptVersion: metadata.promptVersion,
    model: metadata.model,
    instrument: rubric.instrument,
    mapping: rubric.mapping,
    crisisContext: audited.value.crisisContext,
    processPhases: audited.value.processPhases,
    dimensions,
    itemCatalog: rubric.items.map((item) => ({
      itemId: item.itemId,
      dimensionId: item.dimensionId,
      itemLabel: item.label,
      originalStatementEn: item.originalStatementEn,
      referenceAnchors: item.anchors.map((anchor) => ({
        score: anchor.score,
        interpretation: anchor.interpretation,
      })),
    })),
    items,
    overallScore: allScores.length === items.length ? mean(allScores) : null,
    quality: {
      evidenceCoverage: {
        scoredItemCount: allScores.length,
        totalItemCount: 9,
        ratio: allScores.length / 9,
      },
      evidenceQuality: {
        ...evidenceQuality,
      },
      coderAgreement: {
        status: 'not_measured',
        explanation:
          'Es liegt noch keine unabhängige menschliche oder modellbasierte Doppelcodierung vor.',
      },
    },
    methodology: {
      classification: 'derived_evidence_rating',
      sourceScale: { kind: 'self_report_likert', minimum: 1, maximum: 5 },
      evidenceScale: {
        kind: 'interview_evidence_rating',
        minimum: 1,
        maximum: 7,
        referenceScores: [1, 4, 7],
        interpolationCodebook: rubric.scale.interpolationCodebook,
      },
      limitations: REPORT_LIMITATIONS,
    },
    rationale: audited.value.rationale,
    evaluatedAt: metadata.evaluatedAt,
  });
}

function mean(values: readonly number[]): number {
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100;
}
