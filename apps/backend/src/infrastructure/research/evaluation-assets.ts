import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  canonicalizeDefaultOrProfileEnglishOverlay,
  canonicalizeGuideEvaluationMapping,
  canonicalizeLiteratureInstrument,
  canonicalizeOrganizationalResilienceInterpolationCodebook,
  checkDefaultOrProfileEnglishOverlayParity,
  defaultOrProfileEnglishOverlaySchema,
  guideEvaluationMappingSchema,
  literatureInstrumentSchema,
  organizationalResilienceInterpolationCodebookSchema,
  parseGuideEvaluationMappingFingerprintSidecar,
  parseLiteratureInstrumentFingerprintSidecar,
  parseOrganizationalResilienceInterpolationCodebookFingerprintSidecar,
} from '@orgscience/contracts';

import type { OrganizationalResilienceEvaluationAssets } from '../../application/evaluations/organizational-resilience-rubric.js';

const ASSET_DIRECTORY = 'research/instruments/organizational-resilience';
const INSTRUMENT_FILE = 'kantur-iseri-say-evidence-v1.json';
const INSTRUMENT_SIDECAR = 'kantur-iseri-say-evidence-v1.sha256';
const INTERPOLATION_CODEBOOK_FILE = 'kantur-iseri-say-interpolation-codebook-v1.json';
const INTERPOLATION_CODEBOOK_SIDECAR = 'kantur-iseri-say-interpolation-codebook-v1.sha256';
const ENGLISH_DEFAULT_PROFILE_OVERLAY_FILE = 'default-or-evaluation-profile-en-v1.json';
const ENGLISH_DEFAULT_PROFILE_OVERLAY_SIDECAR = 'default-or-evaluation-profile-en-v1.sha256';
const MAPPING_FILE = 'resilient-decision-processes-guide-mapping-v1.json';
const MAPPING_SIDECAR = 'resilient-decision-processes-guide-mapping-v1.sha256';

export class EvaluationAssetError extends Error {
  readonly code = 'EVALUATION_ASSET_INVALID' as const;

  constructor(message: string) {
    super(message);
    this.name = 'EvaluationAssetError';
  }
}

export function loadOrganizationalResilienceEvaluationAssets(
  workspaceRoot = process.cwd(),
): OrganizationalResilienceEvaluationAssets {
  try {
    const assetDirectory = resolve(workspaceRoot, ASSET_DIRECTORY);
    const instrument = literatureInstrumentSchema.parse(
      parseJson(readFileSync(resolve(assetDirectory, INSTRUMENT_FILE), 'utf8')),
    );
    const instrumentFingerprint = digest(canonicalizeLiteratureInstrument(instrument));
    const expectedInstrumentFingerprint = parseLiteratureInstrumentFingerprintSidecar(
      readFileSync(resolve(assetDirectory, INSTRUMENT_SIDECAR), 'utf8'),
      INSTRUMENT_FILE,
    );
    if (instrumentFingerprint !== expectedInstrumentFingerprint) {
      throw new EvaluationAssetError('Published evaluation instrument fingerprint mismatch.');
    }

    const interpolationCodebook = organizationalResilienceInterpolationCodebookSchema.parse(
      parseJson(readFileSync(resolve(assetDirectory, INTERPOLATION_CODEBOOK_FILE), 'utf8')),
    );
    const interpolationCodebookFingerprint = digest(
      canonicalizeOrganizationalResilienceInterpolationCodebook(interpolationCodebook),
    );
    const expectedInterpolationCodebookFingerprint =
      parseOrganizationalResilienceInterpolationCodebookFingerprintSidecar(
        readFileSync(resolve(assetDirectory, INTERPOLATION_CODEBOOK_SIDECAR), 'utf8'),
        INTERPOLATION_CODEBOOK_FILE,
      );
    if (interpolationCodebookFingerprint !== expectedInterpolationCodebookFingerprint) {
      throw new EvaluationAssetError('Published interpolation codebook fingerprint mismatch.');
    }
    if (interpolationCodebook.appliesTo.instrumentFingerprintSha256 !== instrumentFingerprint) {
      throw new EvaluationAssetError(
        'Interpolation codebook does not match the published evaluation instrument.',
      );
    }

    const englishDefaultProfileOverlay = defaultOrProfileEnglishOverlaySchema.parse(
      parseJson(
        readFileSync(resolve(assetDirectory, ENGLISH_DEFAULT_PROFILE_OVERLAY_FILE), 'utf8'),
      ),
    );
    const englishDefaultProfileOverlayFingerprint = digest(
      canonicalizeDefaultOrProfileEnglishOverlay(englishDefaultProfileOverlay),
    );
    const expectedEnglishDefaultProfileOverlayFingerprint =
      parseLiteratureInstrumentFingerprintSidecar(
        readFileSync(resolve(assetDirectory, ENGLISH_DEFAULT_PROFILE_OVERLAY_SIDECAR), 'utf8'),
        ENGLISH_DEFAULT_PROFILE_OVERLAY_FILE,
      );
    if (
      englishDefaultProfileOverlayFingerprint !== expectedEnglishDefaultProfileOverlayFingerprint
    ) {
      throw new EvaluationAssetError(
        'Published English default-profile overlay fingerprint mismatch.',
      );
    }
    if (
      englishDefaultProfileOverlay.appliesTo.instrumentFingerprintSha256 !==
        instrumentFingerprint ||
      englishDefaultProfileOverlay.appliesTo.interpolationCodebookFingerprintSha256 !==
        interpolationCodebookFingerprint
    ) {
      throw new EvaluationAssetError(
        'English default-profile overlay does not match the published evaluation assets.',
      );
    }
    const overlayParity = checkDefaultOrProfileEnglishOverlayParity(
      englishDefaultProfileOverlay,
      instrument,
    );
    if (!overlayParity.compatible) {
      throw new EvaluationAssetError(
        `English default-profile overlay does not preserve source identity (${overlayParity.issues[0] ?? 'unknown mismatch'}).`,
      );
    }

    const mapping = guideEvaluationMappingSchema.parse(
      parseJson(readFileSync(resolve(assetDirectory, MAPPING_FILE), 'utf8')),
    );
    const mappingFingerprint = digest(canonicalizeGuideEvaluationMapping(mapping));
    const expectedMappingFingerprint = parseGuideEvaluationMappingFingerprintSidecar(
      readFileSync(resolve(assetDirectory, MAPPING_SIDECAR), 'utf8'),
      MAPPING_FILE,
    );
    if (mappingFingerprint !== expectedMappingFingerprint) {
      throw new EvaluationAssetError('Published guide mapping fingerprint mismatch.');
    }

    return {
      instrument,
      instrumentFingerprint,
      interpolationCodebook,
      interpolationCodebookFingerprint,
      englishDefaultProfileOverlay,
      englishDefaultProfileOverlayFingerprint,
      mapping,
      mappingFingerprint,
    };
  } catch (error: unknown) {
    if (error instanceof EvaluationAssetError) throw error;
    throw new EvaluationAssetError('Organizational-resilience evaluation assets are unavailable.');
  }
}

function parseJson(serialized: string): unknown {
  try {
    return JSON.parse(serialized) as unknown;
  } catch {
    throw new EvaluationAssetError('Published evaluation asset contains invalid JSON.');
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
