import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
  canonicalizeDefaultOrProfileEnglishOverlay,
  defaultOrProfileEnglishOverlaySchema,
} from '@orgscience/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import {
  EvaluationAssetError,
  loadOrganizationalResilienceEvaluationAssets,
} from './evaluation-assets.js';

const ASSET_DIRECTORY = 'research/instruments/organizational-resilience';
const OVERLAY_FILE = 'default-or-evaluation-profile-en-v1.json';
const OVERLAY_SIDECAR = 'default-or-evaluation-profile-en-v1.sha256';
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('organizational-resilience evaluation assets', () => {
  it('loads the published English overlay with matching fingerprints and calibration identity', () => {
    const assets = loadOrganizationalResilienceEvaluationAssets();

    expect(assets.englishDefaultProfileOverlay.appliesTo).toMatchObject({
      instrumentId: assets.instrument.instrumentId,
      instrumentVersion: assets.instrument.instrumentVersion,
      instrumentFingerprintSha256: assets.instrumentFingerprint,
      interpolationCodebookId: assets.interpolationCodebook.codebookId,
      interpolationCodebookVersion: assets.interpolationCodebook.codebookVersion,
      interpolationCodebookFingerprintSha256: assets.interpolationCodebookFingerprint,
    });
    expect(assets.englishDefaultProfileOverlay.profile.items.map(({ itemId }) => itemId)).toEqual(
      assets.instrument.dimensions.flatMap((dimension) =>
        dimension.items.map(({ itemId }) => itemId),
      ),
    );
    expect(
      assets.englishDefaultProfileOverlay.profile.items.every(
        (item) => item.anchors.map(({ score }) => score).join(',') === '1,2,3,4,5,6,7',
      ),
    ).toBe(true);
    expect(assets.englishDefaultProfileOverlay.rubric.examples).toHaveLength(54);
    expect(assets.englishDefaultProfileOverlay.translationMethod).toMatchObject({
      method: 'controlled_semantic_translation_with_source_identity_preservation',
      curator: { kind: 'ai_assisted' },
      reviewer: { kind: 'automated_validation' },
      humanReviewStatus: 'pending',
    });
    expect(assets.englishDefaultProfileOverlayFingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('rejects an English overlay whose bytes no longer match its sidecar', () => {
    const root = copiedAssetWorkspace();
    const overlayPath = resolve(root, ASSET_DIRECTORY, OVERLAY_FILE);
    writeFileSync(
      overlayPath,
      readFileSync(overlayPath, 'utf8').replace('Editable 1-to-7', 'Modified 1-to-7'),
      'utf8',
    );

    expect(() => loadOrganizationalResilienceEvaluationAssets(root)).toThrowError(
      new EvaluationAssetError('Published English default-profile overlay fingerprint mismatch.'),
    );
  });

  it('rejects a correctly fingerprinted overlay that targets other source assets', () => {
    const root = copiedAssetWorkspace();
    const overlayPath = resolve(root, ASSET_DIRECTORY, OVERLAY_FILE);
    const sidecarPath = resolve(root, ASSET_DIRECTORY, OVERLAY_SIDECAR);
    const source = JSON.parse(readFileSync(overlayPath, 'utf8')) as Record<string, unknown>;
    const appliesTo = source['appliesTo'] as Record<string, unknown>;
    appliesTo['instrumentFingerprintSha256'] = 'f'.repeat(64);
    const overlay = defaultOrProfileEnglishOverlaySchema.parse(source);
    const fingerprint = createHash('sha256')
      .update(canonicalizeDefaultOrProfileEnglishOverlay(overlay))
      .digest('hex');
    writeFileSync(overlayPath, `${JSON.stringify(overlay, null, 2)}\n`, 'utf8');
    writeFileSync(sidecarPath, `${fingerprint}  ${OVERLAY_FILE}\n`, 'utf8');

    expect(() => loadOrganizationalResilienceEvaluationAssets(root)).toThrowError(
      new EvaluationAssetError(
        'English default-profile overlay does not match the published evaluation assets.',
      ),
    );
  });

  it('rejects a correctly fingerprinted overlay with changed example provenance', () => {
    const root = copiedAssetWorkspace();
    const overlayPath = resolve(root, ASSET_DIRECTORY, OVERLAY_FILE);
    const sidecarPath = resolve(root, ASSET_DIRECTORY, OVERLAY_SIDECAR);
    const source = JSON.parse(readFileSync(overlayPath, 'utf8')) as Record<string, unknown>;
    const rubric = source['rubric'] as { examples: { sourceReference: { sourceId: string } }[] };
    rubric.examples[0]!.sourceReference.sourceId = 'changed-source';
    const overlay = defaultOrProfileEnglishOverlaySchema.parse(source);
    const fingerprint = createHash('sha256')
      .update(canonicalizeDefaultOrProfileEnglishOverlay(overlay))
      .digest('hex');
    writeFileSync(overlayPath, `${JSON.stringify(overlay, null, 2)}\n`, 'utf8');
    writeFileSync(sidecarPath, `${fingerprint}  ${OVERLAY_FILE}\n`, 'utf8');

    expect(() => loadOrganizationalResilienceEvaluationAssets(root)).toThrowError(
      /does not preserve source identity/u,
    );
  });
});

function copiedAssetWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'orgscience-evaluation-assets-'));
  temporaryRoots.push(root);
  const target = resolve(root, ASSET_DIRECTORY);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(resolve(process.cwd(), ASSET_DIRECTORY), target, { recursive: true });
  return root;
}
