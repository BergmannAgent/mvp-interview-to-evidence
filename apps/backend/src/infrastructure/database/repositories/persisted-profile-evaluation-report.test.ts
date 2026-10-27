import {
  PROFILE_EVALUATION_LIMITS,
  calculateProfileScores,
  profileEvaluationReportSchema,
  type ProfileEvaluationEvidenceReference,
  type SupportedLocale,
} from '@orgscience/contracts';
import { describe, expect, it } from 'vitest';

import { readPersistedProfileEvaluationReport } from './persisted-profile-evaluation-report.js';

const SOURCE = {
  turnId: 'turn-2',
  sequenceNumber: 2,
  verbatimExcerpt: 'We review every incident.',
};
const ARCHIVED_SOURCE: ProfileEvaluationEvidenceReference = {
  turnId: 'turn-4',
  sequenceNumber: 4,
  verbatimExcerpt: 'The response varies between teams.',
  evidenceType: 'indirect',
  inference: 'The observation does not establish a uniform practice.',
  additionalSources: [
    { turnId: 'turn-6', sequenceNumber: 6, verbatimExcerpt: 'I only know our own process.' },
  ],
};

function currentReport(language: SupportedLocale = 'de') {
  const anchors = ([1, 2, 3, 4, 5, 6, 7] as const).map((score) => ({
    score,
    criterion: `Criterion ${String(score)}`,
  }));
  const item = {
    itemId: 'item-1',
    dimensionId: 'dimension-1',
    name: 'Item 1',
    codingInstruction: 'Rate the observed behavior.',
    order: 0,
    anchors,
  };
  const dimension = { dimensionId: 'dimension-1', name: 'Dimension 1', order: 0 };
  const aggregate = {
    status: 'complete',
    score: 4,
    scoredItemCount: 1,
    unscoredItemCount: 0,
    totalItemCount: 1,
  };
  return profileEvaluationReportSchema.parse({
    schemaVersion: 5,
    reportKind: 'evaluation_profile_report',
    evaluationId: 'evaluation-1',
    interviewId: 'interview-1',
    profileId: 'profile-1',
    profileName: 'Evidence profile',
    profileUpdatedAt: '2026-08-14T08:00:00.000Z',
    profileFingerprint: 'a'.repeat(64),
    transcriptFingerprint: 'b'.repeat(64),
    language,
    profileTranslation:
      language === 'en'
        ? {
            overlayId: 'overlay-1',
            overlayVersion: 'translation-v1',
            overlayFingerprintSha256: 'c'.repeat(64),
          }
        : null,
    promptVersion: 'historical-prompt-v1',
    model: { mode: 'provider', provider: 'openai', model: 'openai/gpt-5-mini' },
    profile: {
      profileId: 'profile-1',
      name: 'Evidence profile',
      description: 'One arbitrary profile dimension.',
      coderPrompt: 'Code observed evidence.',
      scale: { minimum: 1, maximum: 7 },
      dimensions: [dimension],
      items: [item],
    },
    calculation: calculateProfileScores({ dimensions: [dimension], items: [item] }, { 'item-1': 4 })
      .calculation,
    dimensions: [
      {
        ...dimension,
        aggregate,
        items: [
          {
            ...item,
            status: 'scored',
            score: 4,
            appliedAnchor: anchors[3],
            confidence: 0.9,
            supportingEvidence: [
              {
                ...SOURCE,
                evidenceType: 'indirect',
                inference: 'A recurring review indicates an established practice.',
                additionalSources: [
                  {
                    turnId: 'turn-2',
                    sequenceNumber: 2,
                    verbatimExcerpt: 'The team decides what to change.',
                  },
                ],
              },
            ],
            counterEvidence: [
              { turnId: 'turn-8', sequenceNumber: 8, verbatimExcerpt: 'Some reviews are late.' },
            ],
            missingInformation: ['Review frequency is not specified.'],
            rationale: 'The participant describes a recurring review.',
          },
        ],
      },
    ],
    overallAggregate: aggregate,
    rationale: 'The historical result is supported by the interview.',
    evaluatedAt: '2026-08-14T08:00:01.000Z',
  });
}

function legacyReport(
  language: SupportedLocale = 'de',
  archived: ProfileEvaluationEvidenceReference[] = [ARCHIVED_SOURCE],
) {
  const report = historicalV4Report(language);
  return {
    ...report,
    schemaVersion: 3,
    dimensions: report.dimensions.map((dimension) => ({
      ...dimension,
      items: dimension.items.map((item) => ({
        ...item,
        ambiguousEvidence: structuredClone(archived),
      })),
    })),
  };
}

function historicalV4Report(language: SupportedLocale = 'de') {
  const { calculation, ...report } = currentReport(language);
  void calculation;
  return { ...report, schemaVersion: 4 };
}

describe('readPersistedProfileEvaluationReport', () => {
  it.each(['de', 'en'] as const)(
    'projects historical v4 %s reports with default traces and unchanged aggregates and metadata',
    (language) => {
      const candidate = historicalV4Report(language);
      candidate.sourceTranscript = {
        interviewStatus: 'paused',
        finalized: false,
        snapshotAt: candidate.evaluatedAt,
        turnCount: 8,
        ignoredPartial: true,
      };
      candidate.participantDetails = {
        age: null,
        position: { value: 'Team lead', source: { ...SOURCE, verbatimExcerpt: 'I am Team lead.' } },
      };
      const original = structuredClone(candidate);
      const projected = readPersistedProfileEvaluationReport(candidate);
      expect(projected.success).toBe(true);
      if (!projected.success) return;
      const { calculation, legacyEvidenceNotice, schemaVersion, ...retained } = projected.data;
      const { schemaVersion: historicalVersion, ...historical } = candidate;
      void historicalVersion;
      expect(schemaVersion).toBe(5);
      expect(retained).toEqual(historical);
      expect(calculation).toEqual(currentReport(language).calculation);
      expect(calculation.mode).toBe('weighted_mean');
      expect(legacyEvidenceNotice).toContain(language === 'en' ? 'schema 4' : 'Schema 4');
      expect(candidate).toEqual(original);
    },
  );

  it('preserves a v4 historical notice that is already present', () => {
    const candidate = {
      ...historicalV4Report(),
      legacyEvidenceNotice: 'Previously migrated original evidence.',
    };
    const projected = readPersistedProfileEvaluationReport(candidate);
    expect(projected.success).toBe(true);
    if (projected.success)
      expect(projected.data.legacyEvidenceNotice).toBe(candidate.legacyEvidenceNotice);
  });

  it.each([3, 4] as const)(
    'rejects calculation and weight fields in an alleged historical v%s report',
    (schemaVersion) => {
      const candidate = schemaVersion === 3 ? legacyReport() : historicalV4Report();
      const changes = [
        (report: typeof candidate) =>
          Object.assign(report, { calculation: currentReport().calculation }),
        (report: typeof candidate) =>
          Object.assign(report.profile, { calculation: { mode: 'weighted_mean' } }),
        (report: typeof candidate) => Object.assign(report.profile.dimensions[0]!, { weight: 1 }),
        (report: typeof candidate) => Object.assign(report.profile.items[0]!, { weight: 1 }),
        (report: typeof candidate) => Object.assign(report.dimensions[0]!, { weight: 1 }),
        (report: typeof candidate) => Object.assign(report.dimensions[0]!.items[0]!, { weight: 1 }),
      ];
      for (const change of changes) {
        const modified = structuredClone(candidate);
        change(modified);
        expect(readPersistedProfileEvaluationReport(modified).success).toBe(false);
      }
    },
  );

  it.each([3, 4] as const)(
    'does not repair altered historical v%s aggregates during projection',
    (schemaVersion) => {
      const candidate = schemaVersion === 3 ? legacyReport() : historicalV4Report();
      candidate.overallAggregate.score = 6;
      expect(readPersistedProfileEvaluationReport(candidate).success).toBe(false);
    },
  );

  it('reads current reports without adding a historical notice or changing the input', () => {
    const candidate = currentReport();
    const original = structuredClone(candidate);

    expect(readPersistedProfileEvaluationReport(candidate)).toEqual({
      success: true,
      data: candidate,
    });
    expect(candidate).toEqual(original);
    expect(candidate).not.toHaveProperty('legacyEvidenceNotice');
  });

  it.each(['de', 'en'] as const)(
    'projects a historical %s report without changing scores, retained evidence, or provenance',
    (language) => {
      const candidate = legacyReport(language);
      const original = structuredClone(candidate);
      const result = readPersistedProfileEvaluationReport(candidate);

      expect(result.success).toBe(true);
      if (!result.success) return;
      const { legacyEvidenceNotice, ...projected } = result.data;
      expect(projected).toEqual(currentReport(language));
      expect(JSON.stringify(projected)).not.toContain('ambiguousEvidence');
      expect(JSON.stringify(projected)).not.toContain(ARCHIVED_SOURCE.verbatimExcerpt);
      expect(legacyEvidenceNotice).toContain(language === 'en' ? 'Historical' : 'Historische');
      expect(legacyEvidenceNotice).toContain(
        language === 'en' ? 'archived original' : 'archivierten Original',
      );
      expect(legacyEvidenceNotice).toContain(language === 'en' ? 'not reclassified' : 'nicht als');
      expect(legacyEvidenceNotice).toContain(language === 'en' ? 'manually' : 'manuell');
      expect(legacyEvidenceNotice!.length).toBeLessThanOrEqual(1_000);
      expect(candidate).toEqual(original);
    },
  );

  it.each(['de', 'en'] as const)(
    'also marks historical %s reports with empty archived buckets',
    (language) => {
      const candidate = legacyReport(language, []);
      const result = readPersistedProfileEvaluationReport(candidate);

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.legacyEvidenceNotice).toContain(
        language === 'en' ? 'Historical' : 'Historische',
      );
      expect(result.data.legacyEvidenceNotice).toContain(
        language === 'en' ? 'manually' : 'manuell',
      );
      expect(result.data.legacyEvidenceNotice).not.toContain(
        language === 'en' ? 'unassigned' : 'zugeordnete',
      );
      expect(result.data.dimensions[0]!.items[0]).not.toHaveProperty('ambiguousEvidence');
      expect(candidate.dimensions[0]!.items[0]!.ambiguousEvidence).toEqual([]);
    },
  );

  it('retains the historical defaults for absent locale and translation metadata', () => {
    const candidate = legacyReport();
    Reflect.deleteProperty(candidate, 'language');
    Reflect.deleteProperty(candidate, 'profileTranslation');
    const result = readPersistedProfileEvaluationReport(candidate);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.language).toBe('de');
    expect(result.data.profileTranslation).toBeNull();
    expect(result.data.legacyEvidenceNotice).toContain('Historische');
  });

  it.each([1, 2, 6, '3', null])(
    'does not expand compatibility to schema version %s',
    (schemaVersion) => {
      expect(
        readPersistedProfileEvaluationReport({ ...legacyReport(), schemaVersion }).success,
      ).toBe(false);
    },
  );

  it('does not tolerate archived fields in current reports', () => {
    expect(
      readPersistedProfileEvaluationReport({ ...legacyReport(), schemaVersion: 5 }).success,
    ).toBe(false);
  });

  it.each([
    ['report', (report: ReturnType<typeof legacyReport>) => report],
    ['dimension', (report: ReturnType<typeof legacyReport>) => report.dimensions[0]!],
    ['item', (report: ReturnType<typeof legacyReport>) => report.dimensions[0]!.items[0]!],
    ['source metadata', (report: ReturnType<typeof legacyReport>) => report.model],
    [
      'archived evidence',
      (report: ReturnType<typeof legacyReport>) =>
        report.dimensions[0]!.items[0]!.ambiguousEvidence[0]!,
    ],
    [
      'archived additional source',
      (report: ReturnType<typeof legacyReport>) =>
        report.dimensions[0]!.items[0]!.ambiguousEvidence[0]!.additionalSources![0]!,
    ],
  ] as const)('rejects unknown properties on a historical %s', (_label, target) => {
    const candidate = legacyReport();
    Object.assign(target(candidate), { unexpected: 'not silently discarded' });
    expect(readPersistedProfileEvaluationReport(candidate).success).toBe(false);
  });

  it('rejects a new-only historical-notice property on an alleged historical report', () => {
    const candidate = { ...legacyReport(), legacyEvidenceNotice: 'Untrusted preexisting notice' };
    expect(readPersistedProfileEvaluationReport(candidate).success).toBe(false);
  });

  it.each([
    ['invalid sequence number', { sequenceNumber: 0 }],
    ['invalid turn identifier', { turnId: '' }],
    ['blank quotation', { verbatimExcerpt: '' }],
    ['padded quotation', { verbatimExcerpt: ' Padded quotation ' }],
    ['unknown classification', { evidenceType: 'unclear' }],
    ['missing indirect inference', { inference: null }],
    ['direct inference', { evidenceType: 'direct' }],
    [
      'invalid additional-source metadata',
      { additionalSources: [{ ...SOURCE, sequenceNumber: -1 }] },
    ],
    [
      'repeated additional quotation',
      {
        additionalSources: [
          {
            turnId: ARCHIVED_SOURCE.turnId,
            sequenceNumber: 4,
            verbatimExcerpt: ARCHIVED_SOURCE.verbatimExcerpt,
          },
        ],
      },
    ],
  ] as const)('rejects archived evidence with %s before projecting it away', (_label, fields) => {
    const candidate = legacyReport();
    Object.assign(candidate.dimensions[0]!.items[0]!.ambiguousEvidence[0]!, fields);
    expect(readPersistedProfileEvaluationReport(candidate).success).toBe(false);
  });

  it('rejects missing historical buckets, duplicate quotations, and oversized buckets', () => {
    const missing = legacyReport();
    Reflect.deleteProperty(missing.dimensions[0]!.items[0]!, 'ambiguousEvidence');
    expect(readPersistedProfileEvaluationReport(missing).success).toBe(false);
    expect(
      readPersistedProfileEvaluationReport(legacyReport('de', [ARCHIVED_SOURCE, ARCHIVED_SOURCE]))
        .success,
    ).toBe(false);
    const oversized = Array.from(
      { length: PROFILE_EVALUATION_LIMITS.maximumEvidenceReferencesPerBucket + 1 },
      (_, index) => ({ ...ARCHIVED_SOURCE, turnId: `archived-turn-${String(index)}` }),
    );
    expect(readPersistedProfileEvaluationReport(legacyReport('de', oversized)).success).toBe(false);
  });

  it.each([
    [
      'applied anchor',
      (report: ReturnType<typeof legacyReport>) => {
        report.dimensions[0]!.items[0]!.appliedAnchor!.criterion = 'Wrong anchor';
      },
    ],
    [
      'aggregate',
      (report: ReturnType<typeof legacyReport>) => {
        report.overallAggregate.score = 7;
      },
    ],
    [
      'profile snapshot',
      (report: ReturnType<typeof legacyReport>) => {
        report.dimensions[0]!.name = 'Wrong dimension';
      },
    ],
    [
      'translation provenance',
      (report: ReturnType<typeof legacyReport>) => {
        report.profileTranslation = currentReport('en').profileTranslation;
      },
    ],
  ] as const)('retains the current %s refinement for historical reports', (_label, invalidate) => {
    const candidate = legacyReport();
    invalidate(candidate);
    expect(readPersistedProfileEvaluationReport(candidate).success).toBe(false);
  });
});
