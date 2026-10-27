import type {
  EvaluationProfileContent,
  EvaluationProfileDocument,
  EvaluationProfilePortable,
} from './evaluation-profile.js';

/** Preserve calculation configuration at every editable-profile boundary. */
export function evaluationProfileContentOf(
  profile: EvaluationProfileContent,
): EvaluationProfileContent {
  return {
    name: profile.name,
    description: profile.description,
    coderPrompt: profile.coderPrompt,
    scale: profile.scale,
    dimensions: profile.dimensions,
    items: profile.items,
    ...(profile.calculation === undefined ? {} : { calculation: profile.calculation }),
  };
}

export function evaluationProfilePortableOf(
  profile: EvaluationProfileContent & { readonly profileId: string },
): EvaluationProfilePortable {
  return { profileId: profile.profileId, ...evaluationProfileContentOf(profile) };
}

/** Subject-matter coding must not be influenced by downstream calculation settings. */
export function evaluationProfileCodingDocumentOf(
  profile: EvaluationProfileContent & { readonly profileId: string },
): EvaluationProfileDocument {
  return {
    schemaVersion: 1,
    profile: {
      profileId: profile.profileId,
      name: profile.name,
      description: profile.description,
      coderPrompt: profile.coderPrompt,
      scale: profile.scale,
      dimensions: profile.dimensions.map(({ dimensionId, name, order }) => ({
        dimensionId,
        name,
        order,
      })),
      items: profile.items.map(
        ({ itemId, dimensionId, name, codingInstruction, order, anchors }) => ({
          itemId,
          dimensionId,
          name,
          codingInstruction,
          order,
          anchors,
        }),
      ),
    },
  };
}

/** Default settings deliberately retain the exact pre-v2 fingerprint document. */
export function evaluationProfileFingerprintDocumentOf(
  profile: EvaluationProfileContent & { readonly profileId: string },
): EvaluationProfileDocument {
  const legacy = evaluationProfileCodingDocumentOf(profile);
  if (
    profile.calculation?.mode !== 'formula' &&
    profile.dimensions.every((dimension) => (dimension.weight ?? 1) === 1) &&
    profile.items.every((item) => (item.weight ?? 1) === 1)
  ) {
    return legacy;
  }
  return {
    schemaVersion: 2,
    profile: {
      ...evaluationProfilePortableOf(profile),
      calculation: profile.calculation ?? { mode: 'weighted_mean' },
      dimensions: profile.dimensions.map((dimension) => ({
        ...dimension,
        weight: dimension.weight ?? 1,
      })),
      items: profile.items.map((item) => ({ ...item, weight: item.weight ?? 1 })),
    },
  };
}
