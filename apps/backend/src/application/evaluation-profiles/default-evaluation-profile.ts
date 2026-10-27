import {
  evaluationProfileSchema,
  evaluationProfileCodingDocumentOf,
  type DefaultOrProfileEnglishOverlay,
  type EvaluationProfile,
  type EvaluationProfileAnchor,
  type ProfileEvaluationTranslationMetadata,
  type SupportedLocale,
} from '@orgscience/contracts';

import type { OrganizationalResilienceEvaluationAssets } from '../evaluations/organizational-resilience-rubric.js';

export const DEFAULT_EVALUATION_PROFILE_ID = 'profile-default' as const;

export interface LocalizedEvaluationProfile {
  readonly profile: EvaluationProfile;
  readonly translation: ProfileEvaluationTranslationMetadata | null;
}

const DEFAULT_CODER_PROMPT = `Bewerte die im Interview beobachtbare organisationale Resilienz fuer jedes Profilitem.
Beruecksichtige sowohl unterstuetzende als auch entgegenstehende Evidenz und ordne die Aussagen dem am besten passenden Kriterium der Skala von 1 bis 7 zu.
Eine hohe Bewertung setzt konkrete, belastbare Praxisbelege voraus. Allgemeine Absichtserklaerungen oder rein hypothetische Aussagen sind schwaechere Evidenz.
Wenn die Aussagen keine tragfaehige Bewertung erlauben, verwende einen passenden Non-Score-Status und benenne die fehlende oder widerspruechliche Evidenz.`;

export function buildDefaultEvaluationProfile(
  assets: OrganizationalResilienceEvaluationAssets,
  timestamp: string,
): EvaluationProfile {
  const interpolationByItem = new Map(
    assets.interpolationCodebook.items.map((item) => [item.itemId, item.rules]),
  );

  return evaluationProfileSchema.parse({
    profileId: DEFAULT_EVALUATION_PROFILE_ID,
    name: 'default',
    description:
      'Editierbares 1-bis-7-Evidenzprofil mit den neun derzeit verwendeten Organizational-Resilience-Items.',
    coderPrompt: DEFAULT_CODER_PROMPT,
    scale: { minimum: 1, maximum: 7 },
    dimensions: assets.instrument.dimensions.map((dimension, order) => ({
      dimensionId: dimension.dimensionId,
      name: dimension.label,
      order,
    })),
    items: assets.instrument.dimensions.flatMap((dimension) =>
      dimension.items.map((item, order) => ({
        itemId: item.itemId,
        dimensionId: dimension.dimensionId,
        name: item.elicitationQuestionDe,
        codingInstruction: item.codingInstructionDe,
        order,
        anchors: buildSevenAnchors(item.anchors, interpolationByItem.get(item.itemId) ?? []),
      })),
    ),
    isDefault: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

/**
 * Projects the pristine built-in profile into English without changing the persisted profile.
 * User-authored and edited profile content is deliberately never translated implicitly.
 */
export function localizeEvaluationProfile(
  profile: EvaluationProfile,
  assets: OrganizationalResilienceEvaluationAssets,
  language: SupportedLocale,
): LocalizedEvaluationProfile {
  if (language !== 'en' || !isPristineDefaultProfile(profile, assets)) {
    return { profile, translation: null };
  }

  const overlay = assets.englishDefaultProfileOverlay;
  const dimensionsById = new Map<
    string,
    DefaultOrProfileEnglishOverlay['profile']['dimensions'][number]
  >(overlay.profile.dimensions.map((dimension) => [dimension.dimensionId, dimension]));
  const itemsById = new Map<string, DefaultOrProfileEnglishOverlay['profile']['items'][number]>(
    overlay.profile.items.map((item) => [item.itemId, item]),
  );
  const localized = evaluationProfileSchema.parse({
    ...profile,
    description: overlay.profile.description,
    coderPrompt: overlay.profile.coderPrompt,
    dimensions: profile.dimensions.map((dimension) => ({
      ...dimension,
      name: requiredTranslation(
        dimensionsById.get(dimension.dimensionId),
        `dimension ${dimension.dimensionId}`,
      ).name,
    })),
    items: profile.items.map((item) => {
      const translated = requiredTranslation(itemsById.get(item.itemId), `item ${item.itemId}`);
      return {
        ...item,
        name: translated.name,
        codingInstruction: translated.codingInstruction,
        anchors: translated.anchors,
      };
    }),
  });

  return {
    profile: localized,
    translation: {
      overlayId: overlay.overlayId,
      overlayVersion: overlay.overlayVersion,
      overlayFingerprintSha256: assets.englishDefaultProfileOverlayFingerprint,
    },
  };
}

function isPristineDefaultProfile(
  profile: EvaluationProfile,
  assets: OrganizationalResilienceEvaluationAssets,
): boolean {
  if (profile.profileId !== DEFAULT_EVALUATION_PROFILE_ID || !profile.isDefault) return false;
  const expected = buildDefaultEvaluationProfile(assets, profile.createdAt);
  return JSON.stringify(profileContent(profile)) === JSON.stringify(profileContent(expected));
}

function profileContent(profile: EvaluationProfile): unknown {
  return evaluationProfileCodingDocumentOf(profile).profile;
}

function requiredTranslation<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new TypeError(`English default-profile overlay is missing ${label}.`);
  }
  return value;
}

function buildSevenAnchors(
  referenceAnchors: readonly { readonly score: number; readonly interpretationDe: string }[],
  interpolationRules: readonly {
    readonly score: number;
    readonly decisionCriterionDe: string;
    readonly exclusionCriterionDe: string;
  }[],
): readonly EvaluationProfileAnchor[] {
  const references = new Map(referenceAnchors.map((anchor) => [anchor.score, anchor]));
  const interpolations = new Map(interpolationRules.map((rule) => [rule.score, rule]));
  return ([1, 2, 3, 4, 5, 6, 7] as const).map((score) => {
    const reference = references.get(score);
    if (reference !== undefined) {
      return { score, criterion: reference.interpretationDe };
    }
    const interpolation = interpolations.get(score);
    if (interpolation === undefined) {
      throw new TypeError(
        `Default evaluation profile is missing the criterion for score ${score}.`,
      );
    }
    return {
      score,
      criterion: `${interpolation.decisionCriterionDe}\nAbgrenzung: ${interpolation.exclusionCriterionDe}`,
    };
  });
}
