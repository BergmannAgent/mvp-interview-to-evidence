import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ORGANIZATIONAL_RESILIENCE_INTERMEDIATE_SCORES,
  ORGANIZATIONAL_RESILIENCE_ITEM_IDS,
  canonicalizeOrganizationalResilienceInterpolationCodebook,
  isOrganizationalResilienceCalibrationFixtureCompatible,
  organizationalResilienceCalibrationFixtureSchema,
  organizationalResilienceInterpolationCodebookSchema,
  parseOrganizationalResilienceInterpolationCodebookFingerprintSidecar,
  type OrganizationalResilienceInterpolationCodebook,
} from '../src/index.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const artifactDirectory = path.join(
  repositoryRoot,
  'research/instruments/organizational-resilience',
);
const fileName = 'kantur-iseri-say-interpolation-codebook-v1.json';
const artifactPath = path.join(artifactDirectory, fileName);
const fingerprintPath = path.join(
  artifactDirectory,
  'kantur-iseri-say-interpolation-codebook-v1.sha256',
);
const calibrationFixturePath = path.join(artifactDirectory, 'calibration-cases-v1.json');

function loadCodebook(): OrganizationalResilienceInterpolationCodebook {
  return organizationalResilienceInterpolationCodebookSchema.parse(
    JSON.parse(readFileSync(artifactPath, 'utf8')) as unknown,
  );
}

function fingerprint(codebook: OrganizationalResilienceInterpolationCodebook): string {
  return createHash('sha256')
    .update(canonicalizeOrganizationalResilienceInterpolationCodebook(codebook), 'utf8')
    .digest('hex');
}

describe('organizational-resilience interpolation codebook', () => {
  it('contains four ordered pilot rules for every stable item without redefining anchors', () => {
    const codebook = loadCodebook();

    expect(codebook.classification).toBe('derived_interpolation_guidance');
    expect(codebook.approvalStatus).toBe('pilot_only');
    expect(codebook.appliesTo.referenceScores).toEqual([1, 4, 7]);
    expect(codebook.items.map((item) => item.itemId)).toEqual(ORGANIZATIONAL_RESILIENCE_ITEM_IDS);
    expect(codebook.items.flatMap((item) => item.rules)).toHaveLength(36);
    for (const item of codebook.items) {
      expect(item.rules.map((rule) => rule.score)).toEqual(
        ORGANIZATIONAL_RESILIENCE_INTERMEDIATE_SCORES,
      );
      expect(item.rules.map((rule) => rule.adjacentReferenceScores)).toEqual([
        [1, 4],
        [1, 4],
        [4, 7],
        [4, 7],
      ]);
      expect(item.rules.map((rule) => rule.proximity)).toEqual([
        'lower',
        'upper',
        'lower',
        'upper',
      ]);
      expect(item.rules.map((rule) => rule.ruleId)).toEqual(
        ORGANIZATIONAL_RESILIENCE_INTERMEDIATE_SCORES.map(
          (score) => `${item.itemId}-score-${String(score)}`,
        ),
      );
    }
  });

  it('matches the checked-in canonical fingerprint and its exact instrument version', () => {
    const codebook = loadCodebook();
    const digest = fingerprint(codebook);

    expect(codebook.appliesTo).toMatchObject({
      instrumentId: 'kantur-iseri-say-evidence-rating',
      instrumentVersion: '1.0.0',
      instrumentFingerprintSha256:
        '5664be7211e3818f62b7a6d73e0e333e1176172b2633355593f08a4129d9dc61',
    });
    expect(readFileSync(fingerprintPath, 'utf8')).toBe(`${digest}  ${fileName}\n`);
    expect(
      parseOrganizationalResilienceInterpolationCodebookFingerprintSidecar(
        `${digest}  ${fileName}\r\n`,
        fileName,
      ),
    ).toBe(digest);
  });

  it('rejects reordered items, swapped rules, incorrect adjacency, and unknown fields', () => {
    const reorderedItems = structuredClone(loadCodebook());
    [reorderedItems.items[0], reorderedItems.items[1]] = [
      reorderedItems.items[1]!,
      reorderedItems.items[0]!,
    ];
    expect(
      organizationalResilienceInterpolationCodebookSchema.safeParse(reorderedItems).success,
    ).toBe(false);

    const swappedRules = structuredClone(loadCodebook()) as unknown as {
      items: { rules: { ruleId: string }[] }[];
    };
    const firstRuleId = swappedRules.items[0]!.rules[0]!.ruleId;
    swappedRules.items[0]!.rules[0]!.ruleId = swappedRules.items[0]!.rules[1]!.ruleId;
    swappedRules.items[0]!.rules[1]!.ruleId = firstRuleId;
    expect(
      organizationalResilienceInterpolationCodebookSchema.safeParse(swappedRules).success,
    ).toBe(false);

    const incorrectAdjacency = structuredClone(loadCodebook()) as unknown as {
      items: { rules: { adjacentReferenceScores: number[] }[] }[];
    };
    incorrectAdjacency.items[0]!.rules[0]!.adjacentReferenceScores = [4, 7];
    expect(
      organizationalResilienceInterpolationCodebookSchema.safeParse(incorrectAdjacency).success,
    ).toBe(false);

    const unknownField = structuredClone(loadCodebook()) as unknown as Record<string, unknown>;
    unknownField['literatureValidatedIntermediateAnchors'] = true;
    expect(
      organizationalResilienceInterpolationCodebookSchema.safeParse(unknownField).success,
    ).toBe(false);
  });

  it('validates distinct calibration vignettes for 1-7 and both non-score outcomes', () => {
    const fixture = organizationalResilienceCalibrationFixtureSchema.parse(
      JSON.parse(readFileSync(calibrationFixturePath, 'utf8')) as unknown,
    );

    expect(fixture.cases.map((calibrationCase) => calibrationCase.expectedScore)).toEqual([
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      null,
      null,
    ]);
    expect(
      new Set(fixture.cases.flatMap((calibrationCase) => calibrationCase.participantTurns)).size,
    ).toBe(10);
    expect(
      fixture.cases.slice(1, 3).map((calibrationCase) => calibrationCase.expectedRuleId),
    ).toEqual(['rob-01-score-2', 'rob-01-score-3']);
    expect(
      fixture.cases.slice(4, 6).map((calibrationCase) => calibrationCase.expectedRuleId),
    ).toEqual(['rob-01-score-5', 'rob-01-score-6']);
    expect(fixture.appliesTo).toMatchObject({
      instrumentFingerprintSha256: loadCodebook().appliesTo.instrumentFingerprintSha256,
      interpolationCodebookId: loadCodebook().codebookId,
      interpolationCodebookVersion: loadCodebook().codebookVersion,
      interpolationCodebookFingerprintSha256: fingerprint(loadCodebook()),
    });

    const mismatched = structuredClone(fixture);
    mismatched.appliesTo.interpolationCodebookFingerprintSha256 = 'f'.repeat(64);
    expect(
      isOrganizationalResilienceCalibrationFixtureCompatible(
        mismatched,
        loadCodebook(),
        fingerprint(loadCodebook()),
      ),
    ).toBe(false);
  });

  it('defines observed intermediate deficits without narrowing the published low anchor', () => {
    const codebook = loadCodebook();
    const rule = (itemId: (typeof ORGANIZATIONAL_RESILIENCE_ITEM_IDS)[number], score: number) =>
      codebook.items
        .find((item) => item.itemId === itemId)
        ?.rules.find((candidate) => candidate.score === score);

    expect(rule('rob-03', 5)?.decisionCriterionDe).toContain('beobachtbar ungesichert');
    expect(rule('rob-03', 6)?.decisionCriterionDe).toContain('beobachtbar ungesichert');
    expect(rule('agi-02', 5)?.decisionCriterionDe).toContain('beobachtete');
    expect(rule('agi-02', 6)?.decisionCriterionDe).toContain('beobachtete');
    expect(rule('agi-01', 2)?.decisionCriterionDe).toContain(
      'Gesamtreaktion bleibt deutlich verzögert oder nachweislich zu langsam',
    );
    expect(rule('agi-01', 2)?.exclusionCriterionDe).not.toContain('vollständige Untätigkeit');
  });
});
