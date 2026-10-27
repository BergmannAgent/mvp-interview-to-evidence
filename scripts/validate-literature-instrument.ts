import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  canonicalizeGuideEvaluationMapping,
  canonicalizeGuideStructureForMapping,
  checkGuideEvaluationMappingCompatibility,
  guideEvaluationMappingSchema,
  parseGuideEvaluationMappingFingerprintSidecar,
} from '../packages/contracts/src/guide-evaluation-mapping.js';
import {
  canonicalizeOrganizationalResilienceInterpolationCodebook,
  isOrganizationalResilienceCalibrationFixtureCompatible,
  organizationalResilienceCalibrationFixtureSchema,
  organizationalResilienceInterpolationCodebookSchema,
  parseOrganizationalResilienceInterpolationCodebookFingerprintSidecar,
} from '../packages/contracts/src/organizational-resilience-evaluation.js';
import {
  canonicalizeDefaultOrProfileEnglishOverlay,
  canonicalizeLiteratureInstrument,
  defaultOrProfileEnglishOverlaySchema,
  literatureInstrumentSchema,
  parseLiteratureInstrumentFingerprintSidecar,
} from '../packages/contracts/src/literature-instrument.js';
import { parseInterviewGuideMarkdown } from '../packages/domain/src/guide/parser.js';

const instrumentDirectory = path.resolve(
  process.cwd(),
  'research/instruments/organizational-resilience',
);
const fileName = 'kantur-iseri-say-evidence-v1.json';
const instrumentPath = path.join(instrumentDirectory, fileName);
const fingerprintPath = path.join(instrumentDirectory, 'kantur-iseri-say-evidence-v1.sha256');
const interpolationCodebookFileName = 'kantur-iseri-say-interpolation-codebook-v1.json';
const interpolationCodebookPath = path.join(instrumentDirectory, interpolationCodebookFileName);
const interpolationCodebookFingerprintPath = path.join(
  instrumentDirectory,
  'kantur-iseri-say-interpolation-codebook-v1.sha256',
);
const calibrationFixturePath = path.join(instrumentDirectory, 'calibration-cases-v1.json');
const englishDefaultProfileOverlayFileName = 'default-or-evaluation-profile-en-v1.json';
const englishDefaultProfileOverlayPath = path.join(
  instrumentDirectory,
  englishDefaultProfileOverlayFileName,
);
const englishDefaultProfileOverlayFingerprintPath = path.join(
  instrumentDirectory,
  'default-or-evaluation-profile-en-v1.sha256',
);
const mappingFileName = 'resilient-decision-processes-guide-mapping-v1.json';
const mappingPath = path.join(instrumentDirectory, mappingFileName);
const mappingFingerprintPath = path.join(
  instrumentDirectory,
  'resilient-decision-processes-guide-mapping-v1.sha256',
);
const guidePath = path.resolve(
  process.cwd(),
  'guides/fixtures/Interview Leitfaden_Test Voice Agent.docx.md',
);

function fingerprint(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function validate(): Promise<void> {
  const [
    serializedInstrument,
    serializedFingerprint,
    serializedMapping,
    serializedMappingFingerprint,
    serializedInterpolationCodebook,
    serializedInterpolationCodebookFingerprint,
    serializedCalibrationFixture,
    serializedEnglishDefaultProfileOverlay,
    serializedEnglishDefaultProfileOverlayFingerprint,
    serializedGuide,
  ] = await Promise.all([
    readFile(instrumentPath, 'utf8'),
    readFile(fingerprintPath, 'utf8'),
    readFile(mappingPath, 'utf8'),
    readFile(mappingFingerprintPath, 'utf8'),
    readFile(interpolationCodebookPath, 'utf8'),
    readFile(interpolationCodebookFingerprintPath, 'utf8'),
    readFile(calibrationFixturePath, 'utf8'),
    readFile(englishDefaultProfileOverlayPath, 'utf8'),
    readFile(englishDefaultProfileOverlayFingerprintPath, 'utf8'),
    readFile(guidePath, 'utf8'),
  ]);
  const instrument = literatureInstrumentSchema.parse(JSON.parse(serializedInstrument) as unknown);
  const actualFingerprint = fingerprint(canonicalizeLiteratureInstrument(instrument));
  const expectedFingerprint = parseLiteratureInstrumentFingerprintSidecar(
    serializedFingerprint,
    fileName,
  );

  if (expectedFingerprint !== actualFingerprint) {
    throw new Error(
      `Literature instrument fingerprint mismatch: expected ${expectedFingerprint}, found ${actualFingerprint}`,
    );
  }

  const interpolationCodebook = organizationalResilienceInterpolationCodebookSchema.parse(
    JSON.parse(serializedInterpolationCodebook) as unknown,
  );
  const actualInterpolationCodebookFingerprint = fingerprint(
    canonicalizeOrganizationalResilienceInterpolationCodebook(interpolationCodebook),
  );
  const expectedInterpolationCodebookFingerprint =
    parseOrganizationalResilienceInterpolationCodebookFingerprintSidecar(
      serializedInterpolationCodebookFingerprint,
      interpolationCodebookFileName,
    );
  if (expectedInterpolationCodebookFingerprint !== actualInterpolationCodebookFingerprint) {
    throw new Error(
      `Interpolation codebook fingerprint mismatch: expected ${expectedInterpolationCodebookFingerprint}, found ${actualInterpolationCodebookFingerprint}`,
    );
  }
  if (interpolationCodebook.appliesTo.instrumentFingerprintSha256 !== actualFingerprint) {
    throw new Error('Interpolation codebook targets a different literature instrument fingerprint');
  }
  const calibrationFixture = organizationalResilienceCalibrationFixtureSchema.parse(
    JSON.parse(serializedCalibrationFixture) as unknown,
  );
  if (
    !isOrganizationalResilienceCalibrationFixtureCompatible(
      calibrationFixture,
      interpolationCodebook,
      actualInterpolationCodebookFingerprint,
    )
  ) {
    throw new Error('Calibration fixture targets different instrument or codebook assets');
  }

  const englishDefaultProfileOverlay = defaultOrProfileEnglishOverlaySchema.parse(
    JSON.parse(serializedEnglishDefaultProfileOverlay) as unknown,
  );
  const actualEnglishDefaultProfileOverlayFingerprint = fingerprint(
    canonicalizeDefaultOrProfileEnglishOverlay(englishDefaultProfileOverlay),
  );
  const expectedEnglishDefaultProfileOverlayFingerprint =
    parseLiteratureInstrumentFingerprintSidecar(
      serializedEnglishDefaultProfileOverlayFingerprint,
      englishDefaultProfileOverlayFileName,
    );
  if (
    actualEnglishDefaultProfileOverlayFingerprint !==
    expectedEnglishDefaultProfileOverlayFingerprint
  ) {
    throw new Error(
      `English default-profile overlay fingerprint mismatch: expected ${expectedEnglishDefaultProfileOverlayFingerprint}, found ${actualEnglishDefaultProfileOverlayFingerprint}`,
    );
  }
  if (
    englishDefaultProfileOverlay.appliesTo.instrumentFingerprintSha256 !== actualFingerprint ||
    englishDefaultProfileOverlay.appliesTo.interpolationCodebookFingerprintSha256 !==
      actualInterpolationCodebookFingerprint
  ) {
    throw new Error('English default-profile overlay targets different evaluation assets');
  }

  const mapping = guideEvaluationMappingSchema.parse(JSON.parse(serializedMapping) as unknown);
  const actualMappingFingerprint = fingerprint(canonicalizeGuideEvaluationMapping(mapping));
  const expectedMappingFingerprint = parseGuideEvaluationMappingFingerprintSidecar(
    serializedMappingFingerprint,
    mappingFileName,
  );
  if (expectedMappingFingerprint !== actualMappingFingerprint) {
    throw new Error(
      `Guide evaluation mapping fingerprint mismatch: expected ${expectedMappingFingerprint}, found ${actualMappingFingerprint}`,
    );
  }

  const parsedGuide = parseInterviewGuideMarkdown(serializedGuide);
  if (!parsedGuide.success) {
    throw new Error('Mapped interview guide cannot be parsed');
  }
  const actualGuideFingerprint = fingerprint(
    canonicalizeGuideStructureForMapping(parsedGuide.guide),
  );
  if (mapping.sourceGuide.structureFingerprintSha256 !== actualGuideFingerprint) {
    throw new Error(
      `Mapped interview guide fingerprint mismatch: expected ${mapping.sourceGuide.structureFingerprintSha256}, found ${actualGuideFingerprint}`,
    );
  }
  const compatibility = checkGuideEvaluationMappingCompatibility(
    parsedGuide.guide,
    mapping,
    actualMappingFingerprint,
  );
  if (!compatibility.compatible) {
    throw new Error(`Guide evaluation mapping is incompatible: ${compatibility.message}`);
  }

  const items = instrument.dimensions.flatMap((dimension) => dimension.items);
  const examples = items.flatMap((item) =>
    item.anchors.flatMap((anchor) => anchor.approvedExamples),
  );
  process.stdout.write(
    `Validated ${instrument.instrumentId}@${instrument.instrumentVersion}: ${String(items.length)} items, ${String(examples.length)} examples, sha256 ${actualFingerprint}\n`,
  );
  process.stdout.write(
    `Validated ${mapping.mappingId}@${mapping.mappingVersion}: ${String(mapping.itemRoutes.length)} item routes, guide sha256 ${actualGuideFingerprint}, mapping sha256 ${actualMappingFingerprint}\n`,
  );
  process.stdout.write(
    `Validated ${interpolationCodebook.codebookId}@${interpolationCodebook.codebookVersion}: ${String(interpolationCodebook.items.length)} items, ${String(interpolationCodebook.items.flatMap((item) => item.rules).length)} intermediate rules, sha256 ${actualInterpolationCodebookFingerprint}\n`,
  );
  process.stdout.write(
    `Validated ${calibrationFixture.fixtureId}@${calibrationFixture.fixtureVersion}: ${String(calibrationFixture.cases.length)} synthetic calibration cases\n`,
  );
  process.stdout.write(
    `Validated ${englishDefaultProfileOverlay.overlayId}@${englishDefaultProfileOverlay.overlayVersion}: ${String(englishDefaultProfileOverlay.profile.items.length)} localized runtime items, sha256 ${actualEnglishDefaultProfileOverlayFingerprint}\n`,
  );
}

await validate();
