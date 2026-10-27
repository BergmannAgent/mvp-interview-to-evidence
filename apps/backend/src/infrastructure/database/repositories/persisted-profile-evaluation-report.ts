import {
  PROFILE_EVALUATION_LIMITS,
  PROFILE_EVALUATION_REPORT_SCHEMA_VERSION,
  profileEvaluationEvidenceReferenceSchema,
  profileEvaluationReportDimensionSchema,
  profileEvaluationReportItemSchema,
  profileEvaluationReportSchema,
  evaluationProfilePortableV1Schema,
  evaluationProfileScoreSchema,
  calculateProfileScores,
  idSchema,
  type SupportedLocale,
} from '@orgscience/contracts';
import { z } from 'zod';

const archivedEvidenceReferencesSchema = z
  .array(profileEvaluationEvidenceReferenceSchema)
  .max(PROFILE_EVALUATION_LIMITS.maximumEvidenceReferencesPerBucket)
  .refine(
    (references) =>
      new Set(
        references.map((reference) => `${reference.turnId}\u0000${reference.verbatimExcerpt}`),
      ).size === references.length,
    'An evidence bucket may not repeat the same verbatim excerpt',
  );

const legacyReportItemSchema = profileEvaluationReportItemSchema.safeExtend({
  ambiguousEvidence: archivedEvidenceReferencesSchema,
  weight: z.never().optional(),
});

const legacyReportDimensionSchema = profileEvaluationReportDimensionSchema.safeExtend({
  items: z.array(legacyReportItemSchema).min(1),
  weight: z.never().optional(),
});

const legacyReportSchema = profileEvaluationReportSchema.safeExtend({
  dimensions: z.array(legacyReportDimensionSchema).min(1),
  legacyEvidenceNotice: z.never().optional(),
});

const legacyVersionSchema = z
  .object({
    schemaVersion: z.union([z.literal(3), z.literal(4)]),
    profile: evaluationProfilePortableV1Schema,
    calculation: z.never().optional(),
    dimensions: z.array(
      z
        .object({
          dimensionId: idSchema,
          weight: z.never().optional(),
          items: z.array(
            z
              .object({
                itemId: idSchema,
                score: evaluationProfileScoreSchema.nullable(),
                weight: z.never().optional(),
              })
              .passthrough(),
          ),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export function readPersistedProfileEvaluationReport(
  candidate: unknown,
): ReturnType<typeof profileEvaluationReportSchema.safeParse> {
  const current = profileEvaluationReportSchema.safeParse(candidate);
  if (current.success) return current;

  const legacyVersion = legacyVersionSchema.safeParse(candidate);
  if (!legacyVersion.success) return current;

  // Reconstruct calculation metadata only; strict validation still checks the stored scores.
  const calculation = calculateProfileScores(
    legacyVersion.data.profile,
    new Map(
      legacyVersion.data.dimensions.flatMap((dimension) =>
        dimension.items.map((item) => [item.itemId, item.score] as const),
      ),
    ),
  ).calculation;
  const candidateWithCalculation = {
    ...legacyVersion.data,
    schemaVersion: PROFILE_EVALUATION_REPORT_SCHEMA_VERSION,
    calculation,
  };
  if (legacyVersion.data.schemaVersion === 4) {
    const legacy = profileEvaluationReportSchema.safeParse(candidateWithCalculation);
    if (!legacy.success) return current;
    return profileEvaluationReportSchema.safeParse({
      ...legacy.data,
      legacyEvidenceNotice:
        legacy.data.legacyEvidenceNotice ?? historicalReportNotice(legacy.data.language, false, 4),
    });
  }
  const legacy = legacyReportSchema.safeParse(candidateWithCalculation);
  if (!legacy.success) return current;

  let hasArchivedEvidence = false;
  const dimensions = legacy.data.dimensions.map((dimension) => ({
    ...dimension,
    items: dimension.items.map(({ ambiguousEvidence, ...item }) => {
      hasArchivedEvidence ||= ambiguousEvidence.length > 0;
      return item;
    }),
  }));

  return profileEvaluationReportSchema.safeParse({
    ...legacy.data,
    dimensions,
    legacyEvidenceNotice: historicalReportNotice(legacy.data.language, hasArchivedEvidence, 3),
  });
}

function historicalReportNotice(
  language: SupportedLocale,
  hasArchivedEvidence: boolean,
  sourceVersion: 3 | 4,
): string {
  if (language === 'en') {
    return [
      `Historical evaluation (schema ${String(sourceVersion)}) projected into the current schema 5 view.`,
      'Scores, rationale, and retained sources are unchanged; no rescoring occurred.',
      ...(hasArchivedEvidence
        ? [
            'Previously unassigned sources remain in the archived original and were not reclassified as supporting or counter evidence.',
          ]
        : []),
      'Run the evaluation again manually to use the current approach.',
    ].join(' ');
  }
  return [
    `Historische Auswertung (Schema ${String(sourceVersion)}), fuer die aktuelle Ansicht in Schema 5 uebertragen.`,
    'Werte, Begruendungen und uebernommene Quellen sind unveraendert; es erfolgte keine neue Bewertung.',
    ...(hasArchivedEvidence
      ? [
          'Frueher nicht eindeutig zugeordnete Quellen bleiben im archivierten Original erhalten und wurden nicht als unterstuetzende Belege oder Gegenbelege umklassifiziert.',
        ]
      : []),
    'Fuer eine Auswertung nach dem aktuellen Verfahren bitte manuell neu auswerten.',
  ].join(' ');
}
