import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  canonicalizeLiteratureInstrument,
  literatureInstrumentSchema,
  parseLiteratureInstrumentFingerprintSidecar,
  type LiteratureInstrument,
} from '../src/index.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const artifactDirectory = path.join(
  repositoryRoot,
  'research/instruments/organizational-resilience',
);
const artifactPath = path.join(artifactDirectory, 'kantur-iseri-say-evidence-v1.json');
const fingerprintPath = path.join(artifactDirectory, 'kantur-iseri-say-evidence-v1.sha256');

function loadRawArtifact(): unknown {
  return JSON.parse(readFileSync(artifactPath, 'utf8')) as unknown;
}

function loadArtifact(): LiteratureInstrument {
  return literatureInstrumentSchema.parse(loadRawArtifact());
}

function fingerprint(instrument: LiteratureInstrument): string {
  return createHash('sha256')
    .update(canonicalizeLiteratureInstrument(instrument), 'utf8')
    .digest('hex');
}

function approvedExamples(instrument: LiteratureInstrument) {
  return instrument.dimensions.flatMap((dimension) =>
    dimension.items.flatMap((item) => item.anchors.flatMap((anchor) => anchor.approvedExamples)),
  );
}

describe('Kantur and Iseri-Say literature instrument', () => {
  it('loads the golden artifact with 4/3/2 items and exactly 54 approved examples', () => {
    const instrument = loadArtifact();
    expectTypeOf<LiteratureInstrument['instrumentVersion']>().toEqualTypeOf<'1.0.0'>();
    expect(instrument.dimensions.map((dimension) => dimension.items.length)).toEqual([4, 3, 2]);

    const items = instrument.dimensions.flatMap((dimension) => dimension.items);
    expect(items).toHaveLength(9);
    for (const item of items) {
      expect(item.anchors.map((anchor) => anchor.score)).toEqual([1, 4, 7]);
      expect(item.anchors.map((anchor) => anchor.approvedExamples.length)).toEqual([2, 2, 2]);
    }
    expect(approvedExamples(instrument)).toHaveLength(54);
    expect(
      approvedExamples(instrument).every(
        (example) =>
          example.evidenceKind === 'observed_empirical_evidence' &&
          example.evidenceVerificationStatus === 'source_content_checked' &&
          !/workbook|Full_Data|Only_Anchor_V/iu.test(example.sourceReference.locator),
      ),
    ).toBe(true);
  });

  it('ties every item to its exact row in the published Kantur scale', () => {
    const items = loadArtifact().dimensions.flatMap((dimension) => dimension.items);
    expect(items.map((item) => [item.itemId, item.sourceReference])).toEqual([
      [
        'rob-01',
        {
          sourceId: 'kantur-iseri-say-2015',
          locator: 'Table 4, journal page 465, Robustness item 1',
        },
      ],
      [
        'rob-02',
        {
          sourceId: 'kantur-iseri-say-2015',
          locator: 'Table 4, journal page 465, Robustness item 2',
        },
      ],
      [
        'rob-03',
        {
          sourceId: 'kantur-iseri-say-2015',
          locator: 'Table 4, journal page 465, Robustness item 3',
        },
      ],
      [
        'rob-04',
        {
          sourceId: 'kantur-iseri-say-2015',
          locator: 'Table 4, journal page 465, Robustness item 4',
        },
      ],
      [
        'agi-01',
        {
          sourceId: 'kantur-iseri-say-2015',
          locator: 'Table 4, journal page 465, Agility item 1',
        },
      ],
      [
        'agi-02',
        {
          sourceId: 'kantur-iseri-say-2015',
          locator: 'Table 4, journal page 465, Agility item 2',
        },
      ],
      [
        'agi-03',
        {
          sourceId: 'kantur-iseri-say-2015',
          locator: 'Table 4, journal page 465, Agility item 3',
        },
      ],
      [
        'int-01',
        {
          sourceId: 'kantur-iseri-say-2015',
          locator: 'Table 4, journal page 465, Integrity item 1',
        },
      ],
      [
        'int-02',
        {
          sourceId: 'kantur-iseri-say-2015',
          locator: 'Table 4, journal page 465, Integrity item 2',
        },
      ],
    ]);
  });

  it('matches the checked-in canonical fingerprint', () => {
    const expected = `${fingerprint(loadArtifact())}  kantur-iseri-say-evidence-v1.json\n`;
    expect(readFileSync(fingerprintPath, 'utf8')).toBe(expected);
  });

  it('accepts a CRLF fingerprint sidecar but rejects extra content', () => {
    const digest = fingerprint(loadArtifact());
    const fileName = 'kantur-iseri-say-evidence-v1.json';
    expect(
      parseLiteratureInstrumentFingerprintSidecar(`${digest}  ${fileName}\r\n`, fileName),
    ).toBe(digest);
    expect(() =>
      parseLiteratureInstrumentFingerprintSidecar(`${digest}  ${fileName}\nextra\n`, fileName),
    ).toThrow('Invalid literature instrument fingerprint sidecar');
  });

  it('makes object key order irrelevant but preserves meaningful array and value changes', () => {
    const artifact = loadArtifact();
    const reordered = Object.fromEntries(
      Object.entries(artifact).reverse(),
    ) as LiteratureInstrument;
    expect(fingerprint(reordered)).toBe(fingerprint(artifact));

    const nestedReordered = structuredClone(artifact);
    nestedReordered.sourceCatalog[0] = Object.fromEntries(
      Object.entries(nestedReordered.sourceCatalog[0]!).reverse(),
    ) as (typeof nestedReordered.sourceCatalog)[number];
    expect(fingerprint(nestedReordered)).toBe(fingerprint(artifact));

    const reorderedSources = structuredClone(artifact);
    reorderedSources.sourceCatalog.reverse();
    expect(fingerprint(reorderedSources)).not.toBe(fingerprint(artifact));

    const changed = structuredClone(artifact);
    changed.dimensions[0]!.items[0]!.codingInstructionDe += ' Zusätzliche Pilotregel.';
    expect(fingerprint(changed)).not.toBe(fingerprint(artifact));
  });

  it('repairs all six empty workbook slots and excludes the contradictory row 11 candidate', () => {
    const examples = approvedExamples(loadArtifact());
    const repairedRows = examples
      .filter((example) => example.workbookProvenance.status === 'repaired_empty_slot')
      .map((example) => example.workbookProvenance.fullData.row)
      .sort((left, right) => left - right);
    expect(repairedRows).toEqual([7, 8, 19, 21, 28, 29]);
    expect(examples.map((example) => example.workbookProvenance.fullData.row)).not.toContain(11);
    expect(JSON.stringify(examples)).not.toContain('"0"');
  });

  it('rejects row 11, provenance swaps, incorrect status labels, and invalid row mappings', () => {
    const excludedRow = structuredClone(loadArtifact());
    const excludedExample = excludedRow.dimensions[0]!.items[0]!.anchors[1].approvedExamples[0];
    excludedExample.workbookProvenance.fullData.row = 11;
    excludedExample.workbookProvenance.fullData.cells = {
      score: 'D11',
      anchor: 'E11',
      typicalEvidence: 'F11',
      empiricalExample: 'G11',
      source: 'H11',
      rationale: 'I11',
    };
    excludedExample.workbookProvenance.onlyAnchor.row = 11;
    excludedExample.workbookProvenance.onlyAnchor.cells = { score: 'D11', anchor: 'E11' };
    expect(literatureInstrumentSchema.safeParse(excludedRow).success).toBe(false);

    const swappedProvenance = structuredClone(loadArtifact());
    const scoreFourExample =
      swappedProvenance.dimensions[0]!.items[0]!.anchors[1].approvedExamples[0];
    const scoreSevenExample =
      swappedProvenance.dimensions[0]!.items[0]!.anchors[2].approvedExamples[0];
    const scoreFourProvenance = structuredClone(scoreFourExample.workbookProvenance);
    scoreFourExample.workbookProvenance = structuredClone(scoreSevenExample.workbookProvenance);
    scoreSevenExample.workbookProvenance = scoreFourProvenance;
    expect(literatureInstrumentSchema.safeParse(swappedProvenance).success).toBe(false);

    const mislabeledRepair = structuredClone(loadArtifact());
    mislabeledRepair.dimensions[0]!.items[0]!.anchors[0].approvedExamples[0].workbookProvenance.status =
      'selected';
    expect(literatureInstrumentSchema.safeParse(mislabeledRepair).success).toBe(false);

    const mislabeledReplacement = structuredClone(loadArtifact());
    mislabeledReplacement.dimensions[0]!.items[0]!.anchors[2].approvedExamples[1].workbookProvenance.status =
      'selected';
    expect(literatureInstrumentSchema.safeParse(mislabeledReplacement).success).toBe(false);

    const wrongMapping = structuredClone(loadArtifact());
    const mappedExample = wrongMapping.dimensions[1]!.items[1]!.anchors[1].approvedExamples[0];
    mappedExample.workbookProvenance.onlyAnchor.row = 44;
    mappedExample.workbookProvenance.onlyAnchor.cells = { score: 'D44', anchor: 'E44' };
    expect(literatureInstrumentSchema.safeParse(wrongMapping).success).toBe(false);
  });

  it('rejects imprecise publication locators and incomplete source provenance', () => {
    const workbookLocator = structuredClone(loadArtifact());
    workbookLocator.dimensions[0]!.items[0]!.anchors[0].approvedExamples[0].sourceReference.locator =
      'Workbook Full_Data row 7';
    expect(literatureInstrumentSchema.safeParse(workbookLocator).success).toBe(false);

    const genericLocator = structuredClone(loadArtifact());
    genericLocator.dimensions[0]!.items[0]!.anchors[1].approvedExamples[0].sourceReference.locator =
      'Results';
    expect(literatureInstrumentSchema.safeParse(genericLocator).success).toBe(false);

    const wrongApprovedSource = structuredClone(loadArtifact());
    const sourceMutation =
      wrongApprovedSource.dimensions[0]!.items[0]!.anchors[1].approvedExamples[0];
    sourceMutation.sourceReference = {
      sourceId: 'chen-et-al-2021',
      locator: 'Table 4, article page 9',
    };
    expect(literatureInstrumentSchema.safeParse(wrongApprovedSource).success).toBe(false);

    const wrongItemLocator = structuredClone(loadArtifact());
    wrongItemLocator.dimensions[0]!.items[0]!.sourceReference.locator =
      'Table 4, journal page 465, Robustness item 2';
    expect(literatureInstrumentSchema.safeParse(wrongItemLocator).success).toBe(false);

    const missingLocalArtifact = structuredClone(loadArtifact());
    delete missingLocalArtifact.sourceCatalog[0]!.localArtifact;
    expect(literatureInstrumentSchema.safeParse(missingLocalArtifact).success).toBe(false);

    const missingScaleSource = structuredClone(loadArtifact());
    missingScaleSource.sourceCatalog = missingScaleSource.sourceCatalog.filter(
      (source) => source.sourceId !== missingScaleSource.sourceScale.sourceId,
    );
    expect(literatureInstrumentSchema.safeParse(missingScaleSource).success).toBe(false);

    const unusedCatalogSource = structuredClone(loadArtifact());
    const unusedSource = structuredClone(unusedCatalogSource.sourceCatalog[1]!);
    unusedSource.sourceId = 'unused-source';
    unusedCatalogSource.sourceCatalog.push(unusedSource);
    expect(literatureInstrumentSchema.safeParse(unusedCatalogSource).success).toBe(false);
  });

  it('rejects unresolved sources, duplicate workbook rows, invalid scales, and unknown keys', () => {
    const unresolvedSource = structuredClone(loadArtifact());
    unresolvedSource.dimensions[0]!.items[0]!.anchors[0].approvedExamples[0].sourceReference.sourceId =
      'missing-source';
    expect(literatureInstrumentSchema.safeParse(unresolvedSource).success).toBe(false);

    const duplicateRow = structuredClone(loadArtifact());
    const first = duplicateRow.dimensions[0]!.items[0]!.anchors[0].approvedExamples[0];
    const second = duplicateRow.dimensions[0]!.items[0]!.anchors[0].approvedExamples[1];
    second.workbookProvenance = structuredClone(first.workbookProvenance);
    expect(literatureInstrumentSchema.safeParse(duplicateRow).success).toBe(false);

    const duplicateEvidence = structuredClone(loadArtifact());
    const firstEvidence = duplicateEvidence.dimensions[0]!.items[0]!.anchors[0].approvedExamples[0];
    const secondEvidence =
      duplicateEvidence.dimensions[0]!.items[0]!.anchors[0].approvedExamples[1];
    secondEvidence.sourceReference = structuredClone(firstEvidence.sourceReference);
    secondEvidence.empiricalEvidenceDe = firstEvidence.empiricalEvidenceDe;
    expect(literatureInstrumentSchema.safeParse(duplicateEvidence).success).toBe(false);

    const invalidScale = structuredClone(loadRawArtifact()) as Record<string, unknown>;
    invalidScale.sourceScale = {
      kind: 'self_report_likert',
      minimum: 1,
      maximum: 7,
      responseLabels: ['strongly_disagree', 'disagree', 'neutral', 'agree', 'strongly_agree'],
      sourceId: 'kantur-iseri-say-2015',
      locator: 'invalid scale mutation',
    };
    expect(literatureInstrumentSchema.safeParse(invalidScale).success).toBe(false);

    const unknownKey = structuredClone(loadRawArtifact()) as Record<string, unknown>;
    unknownKey.unexpected = true;
    expect(literatureInstrumentSchema.safeParse(unknownKey).success).toBe(false);
  });
});
