import { describe, expect, it } from 'vitest';

import { loadOrganizationalResilienceEvaluationAssets } from '../../infrastructure/research/evaluation-assets.js';
import {
  buildDefaultEvaluationProfile,
  DEFAULT_EVALUATION_PROFILE_ID,
  localizeEvaluationProfile,
} from './default-evaluation-profile.js';

const NOW = '2026-08-21T10:00:00.000Z';

describe('default evaluation profile', () => {
  it.each(['weighted_mean', 'formula'] as const)(
    'keeps the English overlay available for calculation-only %s edits',
    (mode) => {
      const assets = loadOrganizationalResilienceEvaluationAssets();
      const profile = buildDefaultEvaluationProfile(assets, NOW);
      profile.dimensions[0]!.weight = 0;
      profile.dimensions[1]!.weight = 2.5;
      profile.items[0]!.weight = 3;
      profile.items[1]!.weight = 0;
      profile.calculation =
        mode === 'formula'
          ? { mode, expression: `item("${profile.items[0]!.itemId}") * 2` }
          : { mode };
      const original = structuredClone(profile);
      const localized = localizeEvaluationProfile(profile, assets, 'en');
      expect(localized.translation).not.toBeNull();
      expect(localized.profile.items[0]!.name).toContain('What does your organization');
      expect(localized.profile.calculation).toEqual(profile.calculation);
      expect(localized.profile.dimensions.map(({ weight }) => weight)).toEqual(
        profile.dimensions.map(({ weight }) => weight),
      );
      expect(localized.profile.items.map(({ weight }) => weight)).toEqual(
        profile.items.map(({ weight }) => weight),
      );
      expect(profile).toEqual(original);
    },
  );

  it('converts the current research assets into one generic complete profile', () => {
    const profile = buildDefaultEvaluationProfile(
      loadOrganizationalResilienceEvaluationAssets(),
      NOW,
    );

    expect(profile).toMatchObject({
      profileId: DEFAULT_EVALUATION_PROFILE_ID,
      name: 'default',
      isDefault: true,
      scale: { minimum: 1, maximum: 7 },
    });
    expect(profile.dimensions.map(({ dimensionId }) => dimensionId)).toEqual([
      'robustness',
      'agility',
      'integrity',
    ]);
    expect(profile.items).toHaveLength(9);
    expect(profile.items.every((item) => item.anchors.length === 7)).toBe(true);
    expect(profile.items[0]?.anchors.map(({ score }) => score)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(profile.items[0]?.anchors[1]?.criterion).toContain('Abgrenzung:');
    expect(profile).not.toHaveProperty('guideId');
    expect(profile).not.toHaveProperty('locale');
  });

  it('projects the pristine default profile into the versioned English overlay', () => {
    const assets = loadOrganizationalResilienceEvaluationAssets();
    const german = buildDefaultEvaluationProfile(assets, NOW);

    const localized = localizeEvaluationProfile(german, assets, 'en');

    expect(localized.profile).not.toBe(german);
    expect(german.items[0]?.name).toContain('Was macht Ihre Organisation');
    expect(localized.profile).toMatchObject({
      profileId: DEFAULT_EVALUATION_PROFILE_ID,
      description: assets.englishDefaultProfileOverlay.profile.description,
      coderPrompt: assets.englishDefaultProfileOverlay.profile.coderPrompt,
    });
    expect(localized.translation).toEqual({
      overlayId: assets.englishDefaultProfileOverlay.overlayId,
      overlayVersion: assets.englishDefaultProfileOverlay.overlayVersion,
      overlayFingerprintSha256: assets.englishDefaultProfileOverlayFingerprint,
    });
    expect(localized.profile.dimensions.map(({ dimensionId }) => dimensionId)).toEqual(
      german.dimensions.map(({ dimensionId }) => dimensionId),
    );
    expect(
      localized.profile.items.map(({ itemId, dimensionId, anchors }) => ({
        itemId,
        dimensionId,
        scores: anchors.map(({ score }) => score),
      })),
    ).toEqual(
      german.items.map(({ itemId, dimensionId, anchors }) => ({
        itemId,
        dimensionId,
        scores: anchors.map(({ score }) => score),
      })),
    );
    expect(localized.profile.items[0]?.name).toContain('What does your organization');
    expect(localized.profile.items[0]?.anchors[1]?.criterion).toContain('Boundary:');
  });

  it('does not implicitly translate German output or an edited default profile', () => {
    const assets = loadOrganizationalResilienceEvaluationAssets();
    const profile = buildDefaultEvaluationProfile(assets, NOW);
    const edited = { ...profile, coderPrompt: 'Custom instructions remain author-owned.' };

    expect(localizeEvaluationProfile(profile, assets, 'de')).toEqual({
      profile,
      translation: null,
    });
    expect(localizeEvaluationProfile(edited, assets, 'en')).toEqual({
      profile: edited,
      translation: null,
    });
  });
});
