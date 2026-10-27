import {
  PROFILE_EVALUATION_LIMITS,
  calculateProfileScores,
  profileEvaluationProviderCodingOutputSchema,
  profileEvaluationCodingOutputSchema,
  profileEvaluationEvidenceReferenceSchema,
  profileEvaluationReportSchema,
  profileEvaluationSnapshotSchema,
  participantDetailsSchema,
  type EvaluationProfilePortable,
  type ProfileEvaluationReport,
} from '../src/index.js';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const NOW = '2026-08-21T12:00:00.000Z';
const profile: EvaluationProfilePortable = {
  profileId: 'profile-generic-test',
  name: 'Generic evidence profile',
  description: 'No guide-specific assumptions.',
  coderPrompt: 'Code every item from observed participant evidence.',
  scale: { minimum: 1, maximum: 7 },
  dimensions: [{ dimensionId: 'dimension-a', name: 'Dimension A', order: 0 }],
  items: ([1, 2, 3, 4, 5, 6, 7] as const).map((score, order) => ({
    itemId: `item-${String(score)}`,
    dimensionId: 'dimension-a',
    name: `Item ${String(score)}`,
    codingInstruction: `Assess criterion ${String(score)}.`,
    order,
    anchors: ([1, 2, 3, 4, 5, 6, 7] as const).map((anchorScore) => ({
      score: anchorScore,
      criterion: `Item ${String(score)} anchor ${String(anchorScore)}`,
    })) as EvaluationProfilePortable['items'][number]['anchors'],
  })),
};

describe('profile evaluation contracts', () => {
  it.each([801, PROFILE_EVALUATION_LIMITS.maximumItemRationaleLength])(
    'preserves a %i-character item rationale in provider output and persisted reports',
    (length) => {
      const prefix = 'Evidence supports the supplied anchor.\n\n';
      const rationale = prefix + 'x'.repeat(length - prefix.length);
      const output = classifiedOutput([{ ...evidence(1), inference: null, additionalSources: [] }]);
      output.items = output.items.map((item) => ({ ...item, rationale }));
      const report = canonicalReport();
      report.dimensions = report.dimensions.map((dimension) => ({
        ...dimension,
        items: dimension.items.map((item) => ({ ...item, rationale })),
      }));

      expect(profileEvaluationProviderCodingOutputSchema.parse(output)).toEqual(output);
      expect(profileEvaluationCodingOutputSchema.parse(output)).toEqual(output);
      expect(profileEvaluationReportSchema.parse(report)).toEqual(report);
    },
  );

  it.each([801, PROFILE_EVALUATION_LIMITS.maximumReportRationaleLength])(
    'preserves a %i-character overall rationale in provider output and persisted reports',
    (length) => {
      const rationale = 'x'.repeat(length);
      const output = {
        ...classifiedOutput([{ ...evidence(1), inference: null, additionalSources: [] }]),
        rationale,
      };
      const report = { ...canonicalReport(), rationale };

      expect(profileEvaluationProviderCodingOutputSchema.parse(output)).toEqual(output);
      expect(profileEvaluationCodingOutputSchema.parse(output)).toEqual(output);
      expect(profileEvaluationReportSchema.parse(report)).toEqual(report);
    },
  );

  it.each([
    '',
    '   ',
    '\n\t',
    'x'.repeat(PROFILE_EVALUATION_LIMITS.maximumItemRationaleLength + 1),
  ])('rejects blank or oversized item rationales (case %#)', (rationale) => {
    const output = classifiedOutput([{ ...evidence(1), inference: null, additionalSources: [] }]);
    output.items = output.items.map((item) => ({ ...item, rationale }));
    const report = canonicalReport();
    report.dimensions = report.dimensions.map((dimension) => ({
      ...dimension,
      items: dimension.items.map((item) => ({ ...item, rationale })),
    }));

    expect(profileEvaluationProviderCodingOutputSchema.safeParse(output).success).toBe(false);
    expect(profileEvaluationCodingOutputSchema.safeParse(output).success).toBe(false);
    expect(profileEvaluationReportSchema.safeParse(report).success).toBe(false);
  });

  it.each([
    '',
    '   ',
    '\n\t',
    'x'.repeat(PROFILE_EVALUATION_LIMITS.maximumReportRationaleLength + 1),
  ])('rejects blank or oversized overall rationales (case %#)', (rationale) => {
    const output = {
      ...classifiedOutput([{ ...evidence(1), inference: null, additionalSources: [] }]),
      rationale,
    };
    const report = { ...canonicalReport(), rationale };

    expect(profileEvaluationProviderCodingOutputSchema.safeParse(output).success).toBe(false);
    expect(profileEvaluationCodingOutputSchema.safeParse(output).success).toBe(false);
    expect(profileEvaluationReportSchema.safeParse(report).success).toBe(false);
  });

  it('retains historical short rationales without padding or changing the report', () => {
    const report = canonicalReport();
    const output = classifiedOutput([{ ...evidence(1), inference: null, additionalSources: [] }]);

    expect(report.promptVersion).toBe('profile-evidence-coding-v1');
    expect(report.rationale.length).toBeLessThan(800);
    expect(
      report.dimensions.every((dimension) =>
        dimension.items.every((item) => item.rationale.length < 800),
      ),
    ).toBe(true);
    expect(profileEvaluationReportSchema.parse(report)).toEqual(report);
    expect(profileEvaluationProviderCodingOutputSchema.parse(output)).toEqual(output);
  });

  it('accepts missing participant details without inventing age or position', () => {
    expect(participantDetailsSchema.parse({ age: null, position: null })).toEqual({
      age: null,
      position: null,
    });
    expect(profileEvaluationReportSchema.parse(canonicalReport())).not.toHaveProperty(
      'participantDetails',
    );
  });

  it('requires a verbatim source for each participant detail', () => {
    const source = {
      turnId: 'participant',
      sequenceNumber: 2,
      verbatimExcerpt: 'Ich bin 48 Jahre alt und war Bereichsleiterin.',
    };
    const details = {
      age: { value: '48 Jahre', source },
      position: { value: 'war Bereichsleiterin', source },
    };
    expect(participantDetailsSchema.parse(details)).toEqual(details);
    expect(
      participantDetailsSchema.safeParse({ ...details, age: { value: '58 Jahre', source } })
        .success,
    ).toBe(false);
    expect(
      participantDetailsSchema.safeParse({ age: { value: '48 Jahre' }, position: null }).success,
    ).toBe(false);
    expect(participantDetailsSchema.safeParse({ age: null }).success).toBe(false);
  });

  it('requires the participant details object in new model output', () => {
    const { participantDetails: omitted, ...output } = classifiedOutput([]);
    expect(omitted).toEqual({ age: null, position: null });
    expect(profileEvaluationProviderCodingOutputSchema.safeParse(output).success).toBe(false);
  });
  it('keeps legacy reports unchanged without inventing an evidence classification', () => {
    const report = canonicalReport();
    const parsed = profileEvaluationReportSchema.parse(report);

    expect(parsed).toEqual(report);
    expect(parsed.dimensions[0]?.items[0]?.supportingEvidence[0]).toEqual(evidence(1));
    expect(parsed.dimensions[0]?.items[0]?.supportingEvidence[0]).not.toHaveProperty(
      'evidenceType',
    );
  });

  it('accepts a score with one source with or without an explanation', () => {
    for (const inference of [null, 'The described decision supports responsibility.']) {
      const reference = {
        ...evidence(1),
        inference,
        additionalSources: [],
      };
      const output = classifiedOutput([reference]);

      expect(profileEvaluationProviderCodingOutputSchema.parse(output)).toEqual(output);
      expect(profileEvaluationCodingOutputSchema.parse(output)).toEqual(output);
    }
  });

  it.each([undefined, null, '', '   '])(
    'rejects indirect evidence without a nonblank inference (%s)',
    (inference) => {
      const reference = {
        ...evidence(1),
        evidenceType: 'indirect',
        inference,
        additionalSources: [],
      };
      expect(profileEvaluationEvidenceReferenceSchema.safeParse(reference).success).toBe(false);
      expect(
        profileEvaluationProviderCodingOutputSchema.safeParse(classifiedOutput([reference]))
          .success,
      ).toBe(false);
    },
  );

  it('retains historical validation for evidence labeled direct', () => {
    for (const evidenceType of ['direct']) {
      expect(
        profileEvaluationEvidenceReferenceSchema.safeParse({
          ...evidence(1),
          evidenceType,
          inference: 'This interpretation is not a verbatim observation.',
        }).success,
      ).toBe(false);
    }
  });

  it('requires source context fields but rejects evidence classification in provider outputs', () => {
    const reference = {
      ...evidence(1),
      inference: null,
      additionalSources: [],
    };
    expect(
      profileEvaluationProviderCodingOutputSchema.safeParse(classifiedOutput([reference])).success,
    ).toBe(true);
    expect(
      profileEvaluationProviderCodingOutputSchema.safeParse(
        classifiedOutput([{ ...reference, evidenceType: 'direct' }]),
      ).success,
    ).toBe(false);
    for (const key of ['inference', 'additionalSources'] as const) {
      const { [key]: omitted, ...incomplete } = reference;
      expect(omitted).toBeDefined();
      expect(
        profileEvaluationProviderCodingOutputSchema.safeParse(classifiedOutput([incomplete]))
          .success,
      ).toBe(false);
    }
    expect(
      profileEvaluationProviderCodingOutputSchema.safeParse(classifiedOutput([evidence(1)]))
        .success,
    ).toBe(false);
  });

  it('accepts explanations and multiple sources for evidence and counter-evidence without types', () => {
    const output = classifiedOutput([
      {
        ...evidence(1),
        inference: 'These statements support the item.',
        additionalSources: [evidence(2)],
      },
    ]);
    const withCounterEvidence = {
      ...output,
      items: output.items.map((item) => ({
        ...item,
        counterEvidence: [
          { ...evidence(3), inference: 'This statement limits the claim.', additionalSources: [] },
        ],
      })),
    };
    const parsed = profileEvaluationProviderCodingOutputSchema.parse(withCounterEvidence);
    expect(parsed).toEqual(withCounterEvidence);
    expect(JSON.stringify(parsed)).not.toContain('evidenceType');
  });

  it('exposes generic evidence fields without classifications in the provider JSON schema', () => {
    const jsonSchema = JSON.stringify(z.toJSONSchema(profileEvaluationProviderCodingOutputSchema));
    expect(jsonSchema).toContain('supportingEvidence');
    expect(jsonSchema).toContain('counterEvidence');
    expect(jsonSchema).not.toContain('ambiguousEvidence');
    expect(jsonSchema).not.toContain('evidenceType');
    expect(z.toJSONSchema(profileEvaluationProviderCodingOutputSchema)).toMatchObject({
      properties: {
        items: {
          items: {
            anyOf: expect.arrayContaining([
              expect.objectContaining({
                properties: expect.objectContaining({
                  supportingEvidence: expect.objectContaining({
                    items: expect.objectContaining({
                      required: expect.arrayContaining(['inference', 'additionalSources']),
                    }),
                  }),
                }),
              }),
            ]),
          },
        },
      },
    });
  });

  it('rejects the removed evidence direction in new coding outputs and reports', () => {
    const output = classifiedOutput([
      { ...evidence(1), evidenceType: 'direct', inference: null, additionalSources: [] },
    ]);
    const invalidOutput = {
      ...output,
      items: output.items.map((item) => ({ ...item, ambiguousEvidence: [] })),
    };
    expect(profileEvaluationProviderCodingOutputSchema.safeParse(invalidOutput).success).toBe(
      false,
    );
    expect(profileEvaluationCodingOutputSchema.safeParse(invalidOutput).success).toBe(false);
    const report = canonicalReport();
    const invalidReport = {
      ...report,
      dimensions: report.dimensions.map((dimension) => ({
        ...dimension,
        items: dimension.items.map((item) => ({ ...item, ambiguousEvidence: [] })),
      })),
    };
    expect(profileEvaluationReportSchema.safeParse(invalidReport).success).toBe(false);
  });

  it('rejects duplicate evidence even when the classification differs', () => {
    const output = classifiedOutput([
      { ...evidence(1), evidenceType: 'direct', inference: null, additionalSources: [] },
      {
        ...evidence(1),
        evidenceType: 'indirect',
        inference: 'An interpretation of the same quote must not count it twice.',
        additionalSources: [],
      },
    ]);
    expect(profileEvaluationProviderCodingOutputSchema.safeParse(output).success).toBe(false);
    expect(profileEvaluationCodingOutputSchema.safeParse(output).success).toBe(false);
  });

  it('accepts distinct evidence and rejects duplicate primary or additional sources', () => {
    const reference = {
      ...evidence(1),
      inference: 'The quoted statements jointly support the interpretation.',
      additionalSources: [evidence(2), evidence(3)],
    };
    expect(profileEvaluationEvidenceReferenceSchema.safeParse(reference).success).toBe(true);
    for (const additionalSources of [[evidence(1)], [evidence(2), evidence(2)]]) {
      expect(
        profileEvaluationEvidenceReferenceSchema.safeParse({ ...reference, additionalSources })
          .success,
      ).toBe(false);
    }
    const output = classifiedOutput([reference, { ...reference, ...evidence(4) }]);
    expect(profileEvaluationProviderCodingOutputSchema.safeParse(output).success).toBe(true);
  });

  it('bounds inference length and additional sources', () => {
    const reference = {
      ...evidence(1),
      evidenceType: 'indirect',
      inference: 'A grounded interpretation.',
      additionalSources: [],
    };
    expect(
      profileEvaluationEvidenceReferenceSchema.safeParse({
        ...reference,
        inference: 'x'.repeat(PROFILE_EVALUATION_LIMITS.maximumEvidenceInferenceLength + 1),
      }).success,
    ).toBe(false);
    expect(
      profileEvaluationEvidenceReferenceSchema.safeParse({
        ...reference,
        additionalSources: Array.from(
          { length: PROFILE_EVALUATION_LIMITS.maximumAdditionalEvidenceSources + 1 },
          (_, index) => evidence(index + 2),
        ),
      }).success,
    ).toBe(false);
  });

  it('accepts every integer score from 1 through 7 without privileging reference values', () => {
    const output = profileEvaluationCodingOutputSchema.parse({
      items: profile.items.map((item, index) => ({
        itemId: item.itemId,
        dimensionId: item.dimensionId,
        status: 'scored',
        score: index + 1,
        confidence: 0.8,
        supportingEvidence: [evidence(index + 1)],
        counterEvidence: [],
        missingInformation: [],
        rationale: `The exact evidence supports score ${String(index + 1)}.`,
      })),
      rationale: 'All seven scale values are represented.',
    });

    expect(output.items.map((item) => item.score)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(
      profileEvaluationCodingOutputSchema.safeParse({
        ...output,
        items: [{ ...output.items[0], score: 8 }],
      }).success,
    ).toBe(false);
  });

  it('supports explicit non-score states and rejects scores without observed evidence', () => {
    const base = {
      itemId: 'item-1',
      dimensionId: 'dimension-a',
      confidence: 0.2,
      rationale: 'The available evidence does not support a numeric score.',
    };
    const output = {
      items: [
        {
          ...base,
          status: 'insufficient_evidence',
          score: null,
          supportingEvidence: [],
          counterEvidence: [],
          missingInformation: ['A concrete example is missing.'],
        },
        {
          ...base,
          itemId: 'item-2',
          status: 'not_applicable',
          score: null,
          supportingEvidence: [],
          counterEvidence: [],
          missingInformation: [],
        },
        {
          ...base,
          itemId: 'item-3',
          status: 'conflicting',
          score: null,
          supportingEvidence: [evidence(1)],
          counterEvidence: [evidence(2)],
          missingInformation: [],
        },
      ],
      rationale: 'Non-score states remain distinct.',
    };

    expect(profileEvaluationCodingOutputSchema.safeParse(output).success).toBe(true);
    expect(
      profileEvaluationCodingOutputSchema.safeParse({
        items: [
          {
            ...base,
            status: 'scored',
            score: 4,
            supportingEvidence: [],
            counterEvidence: [],
            missingInformation: [],
          },
        ],
        rationale: 'No observed evidence exists.',
      }).success,
    ).toBe(false);
  });

  it('validates the canonical profile snapshot, exact anchors, and deterministic aggregates', () => {
    const report = canonicalReport();
    expect(profileEvaluationReportSchema.safeParse(report).success).toBe(true);

    const wrongAnchor = structuredClone(report);
    wrongAnchor.dimensions[0]!.items[0]!.appliedAnchor!.criterion = 'Invented anchor';
    expect(profileEvaluationReportSchema.safeParse(wrongAnchor).success).toBe(false);

    const manipulatedAggregate = structuredClone(report);
    manipulatedAggregate.overallAggregate.score = 7;
    expect(profileEvaluationReportSchema.safeParse(manipulatedAggregate).success).toBe(false);
  });

  it('validates weighted scores and rejects changes to snapshot weights or calculation traces', () => {
    const report = canonicalReport();
    report.profile.dimensions[0]!.weight = 2;
    report.profile.items[0]!.weight = 0;
    report.dimensions[0]!.weight = 2;
    report.dimensions[0]!.items[0]!.weight = 0;
    updateCalculation(report);
    expect(report.overallAggregate.score).toBe(4.5);
    expect(profileEvaluationReportSchema.parse(report)).toEqual(report);

    const incorrectWeight = structuredClone(report);
    incorrectWeight.dimensions[0]!.items[0]!.weight = 1;
    expect(profileEvaluationReportSchema.safeParse(incorrectWeight).success).toBe(false);
    const incorrectDimensionWeight = structuredClone(report);
    incorrectDimensionWeight.dimensions[0]!.weight = 3;
    expect(profileEvaluationReportSchema.safeParse(incorrectDimensionWeight).success).toBe(false);
    const incorrectTrace = structuredClone(report);
    incorrectTrace.calculation.items[0]!.effectiveWeight = 2;
    expect(profileEvaluationReportSchema.safeParse(incorrectTrace).success).toBe(false);
    const incorrectSum = structuredClone(report);
    incorrectSum.calculation.weightedSum = 0;
    expect(profileEvaluationReportSchema.safeParse(incorrectSum).success).toBe(false);
  });

  it('accepts unrestricted formula scores while rejecting a tampered formula reference trace', () => {
    const report = canonicalReport();
    report.profile.calculation = { mode: 'formula', expression: 'item("item-7") * 3' };
    updateCalculation(report);
    expect(report.overallAggregate.score).toBe(21);
    expect(profileEvaluationReportSchema.parse(report)).toEqual(report);

    const tampered = structuredClone(report);
    tampered.calculation.references[0]!.value = 1;
    expect(profileEvaluationReportSchema.safeParse(tampered).success).toBe(false);
    const incorrectFormula = structuredClone(report);
    incorrectFormula.calculation.expression = 'item("item-7")';
    expect(profileEvaluationReportSchema.safeParse(incorrectFormula).success).toBe(false);
  });

  it('preserves successful source coding when the calculation fails or all weights are zero', () => {
    const report = canonicalReport();
    report.profile.calculation = { mode: 'formula', expression: 'item("item-1") / 0' };
    updateCalculation(report);
    expect(report.overallAggregate.status).toBe('complete');
    expect(report.overallAggregate.score).toBeNull();
    expect(report.calculation.status).toBe('error');
    expect(profileEvaluationReportSchema.parse(report)).toEqual(report);

    const zero = canonicalReport();
    zero.profile.items.forEach((item) => {
      item.weight = 0;
    });
    zero.dimensions
      .flatMap((dimension) => dimension.items)
      .forEach((item) => {
        item.weight = 0;
      });
    updateCalculation(zero);
    expect(zero.overallAggregate.status).toBe('complete');
    expect(zero.overallAggregate.score).toBeNull();
    expect(zero.calculation.status).toBe('not_calculated');
    expect(profileEvaluationReportSchema.parse(zero)).toEqual(zero);
  });

  it('allows an explicit formula zero with no scored source items and requires the v5 trace', () => {
    const report = canonicalReport();
    report.profile.calculation = { mode: 'formula', expression: 'item("item-1")' };
    for (const item of report.dimensions.flatMap((dimension) => dimension.items)) {
      item.status = 'not_applicable';
      item.score = null;
      item.appliedAnchor = null;
    }
    updateCalculation(report);
    expect(report.overallAggregate.status).toBe('not_scored');
    expect(report.overallAggregate.score).toBe(0);
    expect(report.calculation.references[0]?.zeroSubstituted).toBe(true);
    expect(profileEvaluationReportSchema.parse(report)).toEqual(report);

    const { calculation: omitted, ...withoutTrace } = report;
    expect(omitted.status).toBe('calculated');
    expect(profileEvaluationReportSchema.safeParse(withoutTrace).success).toBe(false);
  });

  it('binds completed snapshots to the selected profile report', () => {
    const report = canonicalReport();
    const snapshot = profileEvaluationSnapshotSchema.parse({
      status: 'completed',
      evaluationId: report.evaluationId,
      interviewId: report.interviewId,
      profileId: report.profileId,
      profileFingerprint: report.profileFingerprint,
      startedAt: '2026-08-21T11:59:00.000Z',
      completedAt: report.evaluatedAt,
      report,
      failure: null,
    });
    expect(snapshot.status).toBe('completed');
    expect(
      profileEvaluationSnapshotSchema.safeParse({ ...snapshot, profileId: 'another-profile' })
        .success,
    ).toBe(false);
  });
});

function classifiedOutput(supportingEvidence: unknown[]) {
  return {
    participantDetails: { age: null, position: null },
    items: [
      {
        itemId: 'item-1',
        dimensionId: 'dimension-a',
        status: 'scored',
        score: 5,
        confidence: 0.8,
        supportingEvidence,
        counterEvidence: [],
        missingInformation: [],
        rationale: 'One grounded evidence entry supports the applied score.',
      },
    ],
    rationale: 'Evidence strength, rather than count, determines the assessment.',
  };
}

function canonicalReport(): ProfileEvaluationReport {
  const items = profile.items.map((item, index) => ({
    ...item,
    status: 'scored' as const,
    score: (index + 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7,
    appliedAnchor: item.anchors[index]!,
    confidence: 0.8,
    supportingEvidence: [evidence(index + 1)],
    counterEvidence: [],
    missingInformation: [],
    rationale: `Evidence matches score ${String(index + 1)}.`,
  }));
  return profileEvaluationReportSchema.parse({
    schemaVersion: 5,
    reportKind: 'evaluation_profile_report',
    evaluationId: 'evaluation-profile-test',
    interviewId: 'interview-profile-test',
    profileId: profile.profileId,
    profileName: profile.name,
    profileUpdatedAt: NOW,
    profileFingerprint: 'a'.repeat(64),
    transcriptFingerprint: 'b'.repeat(64),
    promptVersion: 'profile-evidence-coding-v1',
    model: { mode: 'demo', provider: null, model: null },
    profile,
    dimensions: [
      {
        dimensionId: 'dimension-a',
        name: 'Dimension A',
        order: 0,
        aggregate: {
          status: 'complete',
          score: 4,
          scoredItemCount: 7,
          unscoredItemCount: 0,
          totalItemCount: 7,
        },
        items,
      },
    ],
    overallAggregate: {
      status: 'complete',
      score: 4,
      scoredItemCount: 7,
      unscoredItemCount: 0,
      totalItemCount: 7,
    },
    calculation: calculateProfileScores(
      profile,
      new Map(items.map((item) => [item.itemId, item.score])),
    ).calculation,
    rationale: 'The report preserves the selected profile and observed evidence.',
    evaluatedAt: NOW,
  });
}

function evidence(sequenceNumber: number) {
  return {
    turnId: `turn-participant-${String(sequenceNumber)}`,
    sequenceNumber,
    verbatimExcerpt: `Observed participant evidence ${String(sequenceNumber)}.`,
  };
}

function updateCalculation(report: ProfileEvaluationReport): void {
  const calculated = calculateProfileScores(
    report.profile,
    new Map(
      report.dimensions.flatMap((dimension) =>
        dimension.items.map((item) => [item.itemId, item.score] as const),
      ),
    ),
  );
  report.dimensions.forEach((dimension, index) => {
    dimension.aggregate = calculated.dimensions[index]!.aggregate;
  });
  report.overallAggregate = calculated.overallAggregate;
  report.calculation = calculated.calculation;
}
