import {
  PROFILE_EVALUATION_REPORT_SCHEMA_VERSION,
  profileEvaluationReportSchema,
  calculateProfileScores,
  EVALUATION_PROFILE_DOCUMENT_SCHEMA_VERSION,
  evaluationProfilePortableOf,
  type EvaluationProfile,
  type ModelMetadata,
  type MvpInterviewSession,
  type ProfileEvaluationAggregate,
  type ProfileEvaluationCodingOutput,
  type ProfileEvaluationReport,
  type ProfileEvaluationTranslationMetadata,
  type SupportedLocale,
} from '@orgscience/contracts';

import { validateEvaluationCodingOutput } from './evaluation-guardrails.js';

export interface ProfileEvaluationReportMetadata {
  readonly evaluationId: string;
  readonly interviewId: string;
  readonly profileFingerprint: string;
  readonly transcriptFingerprint: string;
  readonly language: SupportedLocale;
  readonly profileTranslation: ProfileEvaluationTranslationMetadata | null;
  readonly promptVersion: string;
  readonly model: ModelMetadata;
  readonly evaluatedAt: string;
  readonly ignoredPartialTranscript?: boolean;
}

export class ProfileEvaluationReportAuditError extends Error {
  readonly code = 'PROFILE_EVALUATION_AUDIT_REJECTED' as const;

  constructor(readonly issueSummary: string) {
    super(`Profile evaluation output failed deterministic audit: ${issueSummary}`);
    this.name = 'ProfileEvaluationReportAuditError';
  }
}

export function buildProfileEvaluationReport(
  profile: EvaluationProfile,
  session: MvpInterviewSession,
  coding: ProfileEvaluationCodingOutput,
  metadata: ProfileEvaluationReportMetadata,
): ProfileEvaluationReport {
  if (metadata.interviewId !== session.interviewId) {
    throw new ProfileEvaluationReportAuditError('interview_scope_mismatch@interviewId');
  }
  const profileDocument = {
    schemaVersion: EVALUATION_PROFILE_DOCUMENT_SCHEMA_VERSION,
    profile: evaluationProfilePortableOf(profile),
  };
  const audited = validateEvaluationCodingOutput({ profile: profileDocument, session }, coding);
  if (!audited.ok) {
    throw new ProfileEvaluationReportAuditError(
      audited.issues
        .slice(0, 10)
        .map((issue) => `${issue.code}@${issue.path}`)
        .join(', '),
    );
  }

  const codingByItem = new Map(audited.value.items.map((item) => [item.itemId, item]));
  const calculated = calculateProfileScores(
    profile,
    new Map(audited.value.items.map((item) => [item.itemId, item.score])),
  );
  const dimensions = profile.dimensions.map((dimension, dimensionIndex) => {
    const dimensionResult = calculated.dimensions[dimensionIndex];
    if (dimensionResult?.dimensionId !== dimension.dimensionId) {
      throw new ProfileEvaluationReportAuditError(`missing_dimension@${dimension.dimensionId}`);
    }
    const sourceItems = profile.items.filter((item) => item.dimensionId === dimension.dimensionId);
    const items = sourceItems.map((sourceItem) => {
      const result = codingByItem.get(sourceItem.itemId);
      if (result === undefined) {
        throw new ProfileEvaluationReportAuditError(`missing_item@${sourceItem.itemId}`);
      }
      return {
        ...sourceItem,
        ...result,
        appliedAnchor: result.score === null ? null : sourceItem.anchors[result.score - 1],
      };
    });
    return {
      ...dimension,
      aggregate: dimensionResult.aggregate,
      items,
    };
  });

  return profileEvaluationReportSchema.parse({
    schemaVersion: PROFILE_EVALUATION_REPORT_SCHEMA_VERSION,
    reportKind: 'evaluation_profile_report',
    evaluationId: metadata.evaluationId,
    interviewId: metadata.interviewId,
    profileId: profile.profileId,
    profileName: profile.name,
    profileUpdatedAt: profile.updatedAt,
    profileFingerprint: metadata.profileFingerprint,
    transcriptFingerprint: metadata.transcriptFingerprint,
    language: metadata.language,
    profileTranslation: metadata.profileTranslation,
    promptVersion: metadata.promptVersion,
    model: metadata.model,
    profile: profileDocument.profile,
    dimensions,
    overallAggregate: calculated.overallAggregate,
    calculation: calculated.calculation,
    rationale: audited.value.rationale,
    ...(audited.value.participantDetails === undefined
      ? {}
      : { participantDetails: audited.value.participantDetails }),
    evaluatedAt: metadata.evaluatedAt,
    sourceTranscript: {
      interviewStatus: session.status,
      finalized: session.finalizedAt !== null,
      snapshotAt: session.updatedAt,
      turnCount: session.transcript.length,
      ignoredPartial: metadata.ignoredPartialTranscript ?? session.partialTranscript !== null,
    },
  });
}

export function aggregate(scores: readonly (number | null)[]): ProfileEvaluationAggregate {
  const numeric = scores.filter((score): score is number => score !== null);
  return {
    status:
      numeric.length === 0
        ? 'not_scored'
        : numeric.length === scores.length
          ? 'complete'
          : 'partial',
    score: numeric.length === 0 ? null : mean(numeric),
    scoredItemCount: numeric.length,
    unscoredItemCount: scores.length - numeric.length,
    totalItemCount: scores.length,
  };
}

function mean(values: readonly number[]): number {
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100;
}
