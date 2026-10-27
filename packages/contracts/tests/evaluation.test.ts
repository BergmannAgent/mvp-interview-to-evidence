import { describe, expect, it } from 'vitest';

import {
  evaluationCodingOutputSchema,
  evaluationExportQuerySchema,
  evaluationReportSchema,
  evaluationRubricSchema,
  evaluationSnapshotSchema,
  evaluationStartRequestSchema,
  profileEvaluationReportSchema,
  profileEvaluationSnapshotSchema,
} from '../src/index.js';

function anchors() {
  return [1, 2, 3, 4, 5].map((score) => ({
    score,
    label: `Stufe ${String(score)}`,
    description: `Expliziter Bewertungsanker fuer Stufe ${String(score)}.`,
  }));
}

function rubric() {
  return {
    schemaVersion: 1,
    rubricId: 'rubric-1',
    guideId: 'guide-1',
    version: 1,
    title: 'Resiliente Entscheidungen',
    description: 'Versionierte ordinale Kodierungsrubrik.',
    scale: { kind: 'ordinal_1_5', minimum: 1, maximum: 5 },
    items: [
      {
        itemId: 'pre-adversity',
        label: 'Antizipative Entscheidungsfaehigkeit',
        construct: 'Entscheidungsfaehigkeit vor einer Krise',
        codingInstruction: 'Kodiere nur explizite Evidenz aus finalen Teilnehmerturns.',
        guideQuestionIds: ['main-1'],
        anchors: anchors(),
      },
    ],
  };
}

function codingOutput() {
  return {
    items: [
      {
        itemId: 'pre-adversity',
        status: 'scored',
        score: 4,
        confidence: 0.82,
        evidence: [
          {
            turnId: 'turn-participant-1',
            sequenceNumber: 2,
            verbatimExcerpt: 'Wir testen unsere Notfallplaene jedes Quartal.',
          },
        ],
        missingInformation: [],
        rationale: 'Die Antwort beschreibt einen formalen und wiederholten Prozess.',
      },
    ],
    rationale: 'Alle Rubrikitems wurden anhand finaler Teilnehmeraussagen kodiert.',
  };
}

describe('evaluation contracts', () => {
  it('accepts a versioned rubric with exactly ordered 1-5 anchors', () => {
    expect(
      evaluationRubricSchema.parse(rubric()).items[0]?.anchors.map((item) => item.score),
    ).toEqual([1, 2, 3, 4, 5]);

    const reversed = rubric();
    reversed.items[0]!.anchors.reverse();
    expect(evaluationRubricSchema.safeParse(reversed).success).toBe(false);
  });

  it('rejects duplicate rubric items and duplicate guide-question references', () => {
    const duplicateItems = rubric();
    duplicateItems.items.push({ ...duplicateItems.items[0]! });
    expect(evaluationRubricSchema.safeParse(duplicateItems).success).toBe(false);

    const duplicateQuestions = rubric();
    duplicateQuestions.items[0]!.guideQuestionIds.push('main-1');
    expect(evaluationRubricSchema.safeParse(duplicateQuestions).success).toBe(false);
  });

  it('requires evidence for a score and missing information when evidence is insufficient', () => {
    const scoredWithoutEvidence = codingOutput();
    scoredWithoutEvidence.items[0]!.evidence = [];
    expect(evaluationCodingOutputSchema.safeParse(scoredWithoutEvidence).success).toBe(false);

    const insufficient = {
      ...codingOutput(),
      items: [
        {
          ...codingOutput().items[0]!,
          status: 'insufficient_evidence',
          score: null,
          evidence: [],
          missingInformation: ['Es fehlen Angaben zur regelmaessigen Erprobung.'],
        },
      ],
    };
    expect(evaluationCodingOutputSchema.safeParse(insufficient).success).toBe(true);

    expect(
      evaluationCodingOutputSchema.safeParse({
        ...insufficient,
        items: [{ ...insufficient.items[0]!, missingInformation: [] }],
      }).success,
    ).toBe(false);
  });

  it('uses the profile-driven report and snapshot as the only runtime contracts', () => {
    expect(evaluationReportSchema).toBe(profileEvaluationReportSchema);
    expect(evaluationSnapshotSchema).toBe(profileEvaluationSnapshotSchema);
  });

  it('validates profile selection in start and export requests', () => {
    expect(evaluationStartRequestSchema.parse({ profileId: 'profile-1' })).toEqual({
      profileId: 'profile-1',
    });
    expect(evaluationStartRequestSchema.parse({})).toEqual({});
    expect(evaluationExportQuerySchema.parse({ format: 'csv', profileId: 'profile-1' })).toEqual({
      format: 'csv',
      profileId: 'profile-1',
    });
    expect(evaluationExportQuerySchema.parse({ format: 'markdown' })).toEqual({
      format: 'markdown',
    });
    expect(evaluationExportQuerySchema.parse({ format: 'html' })).toEqual({ format: 'html' });
  });
});
