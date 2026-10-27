import {
  ORGANIZATIONAL_RESILIENCE_ITEM_IDS,
  deriveOrganizationalResilienceEvidenceQuality,
  deriveOrganizationalResilienceScoreDistribution,
  evaluationReportSchema,
  organizationalResilienceCodingOutputSchema,
  type OrganizationalResilienceCodingOutput,
} from '../src/index.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const DIMENSIONS = [
  'robustness',
  'robustness',
  'robustness',
  'robustness',
  'agility',
  'agility',
  'agility',
  'integrity',
  'integrity',
] as const;

describe('organizational-resilience evaluation contracts', () => {
  it('accepts exactly nine ordered items and all four non-overlapping statuses', () => {
    const candidate = mutableOutput();
    candidate.items[0] = scoredItem(0, 4);
    candidate.items[1] = {
      ...emptyItem(1),
      status: 'not_applicable',
      missingInformation: ['Keine erlebte Krise.'],
    };
    candidate.items[2] = {
      ...emptyItem(2),
      status: 'conflicting',
      supportingEvidence: [evidence('supporting', 'turn-2')],
      counterEvidence: [evidence('counter', 'turn-4')],
      missingInformation: ['Die widersprüchlichen Aussagen müssen geklärt werden.'],
    };

    const parsed = organizationalResilienceCodingOutputSchema.parse(candidate);

    expect(parsed.items).toHaveLength(9);
    expect(parsed.items.map((item) => item.itemId)).toEqual(ORGANIZATIONAL_RESILIENCE_ITEM_IDS);
    expect(parsed.items.map((item) => item.status)).toEqual([
      'scored',
      'not_applicable',
      'conflicting',
      'insufficient_evidence',
      'insufficient_evidence',
      'insufficient_evidence',
      'insufficient_evidence',
      'insufficient_evidence',
      'insufficient_evidence',
    ]);
  });

  it('rejects numeric scores without directional evidence', () => {
    const candidate = mutableOutput();
    candidate.items[0] = {
      ...scoredItem(0, 4),
      supportingEvidence: [],
      ambiguousEvidence: [evidence('ambiguous', 'turn-2')],
    };

    expect(organizationalResilienceCodingOutputSchema.safeParse(candidate).success).toBe(false);
  });

  it('uses provider-compatible fixed arrays while enforcing canonical phase and item order', () => {
    const wrongPhaseOrder = structuredClone(output());
    wrongPhaseOrder.processPhases.reverse();
    const missingItem = structuredClone(output());
    missingItem.items.pop();

    expect(organizationalResilienceCodingOutputSchema.safeParse(wrongPhaseOrder).success).toBe(
      false,
    );
    expect(organizationalResilienceCodingOutputSchema.safeParse(missingItem).success).toBe(false);
  });

  it('emits provider-compatible JSON Schema without tuple keywords', () => {
    const transportSchema = z
      .object({
        properties: z.object({
          processPhases: z.object({ items: z.unknown() }),
          items: z.object({ items: z.unknown() }),
        }),
      })
      .parse(z.toJSONSchema(organizationalResilienceCodingOutputSchema));

    expect(Array.isArray(transportSchema.properties.processPhases.items)).toBe(false);
    expect(Array.isArray(transportSchema.properties.items.items)).toBe(false);
    expect(JSON.stringify(transportSchema)).not.toContain('prefixItems');
  });

  it('classifies a reused excerpt as concrete only when every use is concrete', () => {
    const concrete = evidence('supporting', 'turn-shared');
    const general = { ...concrete, specificity: 'general_statement' as const };

    expect(
      deriveOrganizationalResilienceEvidenceQuality([
        { supportingEvidence: [concrete], counterEvidence: [], ambiguousEvidence: [] },
        { supportingEvidence: [general], counterEvidence: [], ambiguousEvidence: [] },
      ]),
    ).toEqual({ level: 'low', concreteEvidenceCount: 0, totalEvidenceCount: 1 });
  });

  it.each([
    { score: 2, valid: [1, 4], invalid: [1] },
    { score: 3, valid: [1, 4], invalid: [4, 7] },
    { score: 5, valid: [4, 7], invalid: [1, 4] },
    { score: 6, valid: [4, 7], invalid: [7] },
  ] as const)(
    'requires adjacent reference anchors for score $score',
    ({ score, valid, invalid }) => {
      const validCandidate = mutableOutput();
      validCandidate.items[0] = scoredItem(0, score, valid);
      expect(organizationalResilienceCodingOutputSchema.safeParse(validCandidate).success).toBe(
        true,
      );

      const invalidCandidate = mutableOutput();
      invalidCandidate.items[0] = scoredItem(0, score, invalid);
      expect(organizationalResilienceCodingOutputSchema.safeParse(invalidCandidate).success).toBe(
        false,
      );
    },
  );

  it('derives a non-mutating 1-7 distribution and keeps non-score outcomes separate', () => {
    const distribution = deriveOrganizationalResilienceScoreDistribution([
      { score: 1 },
      { score: 2 },
      { score: 3 },
      { score: 4 },
      { score: 5 },
      { score: 6 },
      { score: 7 },
      { score: null },
      { score: null },
      { score: null },
    ]);

    expect(distribution).toEqual({
      byScore: { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1 },
      scoredItemCount: 7,
      unscoredItemCount: 3,
      referenceAnchorCount: 3,
      intermediateScoreCount: 4,
      referenceAnchorRatio: 3 / 7,
    });
  });

  it('does not accept obsolete reports through the profile-driven runtime contract', () => {
    expect(
      evaluationReportSchema.safeParse({
        schemaVersion: 1,
        evaluationId: 'evaluation-legacy',
        interviewId: 'interview-legacy',
        guideId: 'guide-legacy',
        rubricId: 'rubric-legacy',
        rubricVersion: 1,
        rubricFingerprint: 'a'.repeat(64),
        transcriptFingerprint: 'b'.repeat(64),
        promptVersion: 'legacy-prompt-v1',
        model: { mode: 'demo', provider: null, model: null },
        items: [
          {
            itemId: 'legacy-item',
            status: 'insufficient_evidence',
            score: null,
            confidence: 0,
            evidence: [],
            missingInformation: ['Keine Evidenz.'],
            rationale: 'Alter technischer Bericht.',
          },
        ],
        rationale: 'Legacy 1-bis-5-Auswertung.',
        evaluatedAt: '2026-08-19T10:00:00.000Z',
      }).success,
    ).toBe(false);
  });
});

function output(): OrganizationalResilienceCodingOutput {
  return organizationalResilienceCodingOutputSchema.parse({
    crisisContext: {
      mode: 'actual_event',
      summary: 'Ein Ereignis wurde beschrieben.',
      eventLabel: 'Lieferausfall',
      evidence: [],
    },
    processPhases: [phase('pre_adversity'), phase('during_adversity'), phase('post_adversity')],
    items: ORGANIZATIONAL_RESILIENCE_ITEM_IDS.map((_itemId, index) => emptyItem(index)),
    rationale: 'Alle Items wurden getrennt gegen die Referenzanker geprüft.',
  });
}

function mutableOutput(): { items: unknown[] } & Record<string, unknown> {
  return structuredClone(output()) as { items: unknown[] } & Record<string, unknown>;
}

function phase(phaseId: 'pre_adversity' | 'during_adversity' | 'post_adversity') {
  return {
    phase: phaseId,
    status: 'not_covered',
    summary: 'Keine phasenspezifische Evidenz.',
    evidence: [],
  } as const;
}

function emptyItem(index: number) {
  return {
    itemId: ORGANIZATIONAL_RESILIENCE_ITEM_IDS[index]!,
    dimensionId: DIMENSIONS[index]!,
    status: 'insufficient_evidence' as const,
    score: null,
    confidence: 0,
    supportingEvidence: [],
    counterEvidence: [],
    ambiguousEvidence: [],
    matchedAnchors: [] as const,
    missingInformation: ['Es fehlt konkrete Evidenz.'],
    rationale: 'Ohne Evidenz wird kein Wert vergeben.',
  };
}

function scoredItem(
  index: number,
  score: 1 | 2 | 3 | 4 | 5 | 6 | 7,
  anchorScores: readonly (1 | 4 | 7)[] = [score as 1 | 4 | 7],
) {
  return {
    ...emptyItem(index),
    status: 'scored' as const,
    score,
    confidence: 0.8,
    supportingEvidence: [evidence('supporting', 'turn-2')],
    matchedAnchors: anchorScores.map((anchorScore) => ({
      score: anchorScore,
      relationship:
        score === anchorScore
          ? ('exact' as const)
          : anchorScore < score
            ? ('lower_bound' as const)
            : ('upper_bound' as const),
      interpretation: `Referenzanker ${String(anchorScore)}`,
    })),
    missingInformation: [],
  };
}

function evidence<Direction extends 'supporting' | 'counter' | 'ambiguous'>(
  direction: Direction,
  turnId: string,
) {
  return {
    turnId,
    sequenceNumber: 2,
    verbatimExcerpt: 'Wortgetreue Aussage.',
    phase: 'during_adversity' as const,
    direction,
    specificity: 'concrete_event' as const,
  };
}
