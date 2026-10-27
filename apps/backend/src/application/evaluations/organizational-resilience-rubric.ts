import {
  canonicalizeGuideStructureForMapping,
  checkGuideEvaluationMappingCompatibility,
  guideStructureSchema,
  ORGANIZATIONAL_RESILIENCE_ADAPTIVE_MAPPING_ID,
  ORGANIZATIONAL_RESILIENCE_RUBRIC_VERSION,
  organizationalResilienceRubricSchema,
  type GuideEvaluationMapping,
  type DefaultOrProfileEnglishOverlay,
  type LiteratureInstrument,
  type OrganizationalResilienceInterpolationCodebook,
  type OrganizationalResilienceRubric,
  type SupportedLocale,
} from '@orgscience/contracts';
import { buildGuideQuestionCatalog, type InterviewGuideSnapshot } from '@orgscience/domain';

import { deterministicId, sha256, type Sha256 } from '../runtime.js';
import { validateEvaluationRubricAgainstGuide } from './evaluation-guardrails.js';

const ADAPTIVE_MAPPING_VERSION = '1.0.0';
const MAXIMUM_RUBRIC_QUESTION_HINTS = 100;

export class UnsupportedEvaluationGuideError extends Error {
  readonly code = 'UNSUPPORTED_EVALUATION_GUIDE' as const;

  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedEvaluationGuideError';
  }
}

export interface OrganizationalResilienceEvaluationAssets {
  readonly instrument: LiteratureInstrument;
  readonly instrumentFingerprint: string;
  readonly interpolationCodebook: OrganizationalResilienceInterpolationCodebook;
  readonly interpolationCodebookFingerprint: string;
  readonly englishDefaultProfileOverlay: DefaultOrProfileEnglishOverlay;
  readonly englishDefaultProfileOverlayFingerprint: string;
  readonly mapping: GuideEvaluationMapping;
  readonly mappingFingerprint: string;
}

export function deriveOrganizationalResilienceRubric(
  guide: InterviewGuideSnapshot,
  assets: OrganizationalResilienceEvaluationAssets,
  hasher: Sha256,
): OrganizationalResilienceRubric {
  const language = guide.sourceLanguage ?? 'de';
  const guideStructure = guideStructureSchema.parse({
    id: guide.id,
    title: guide.title,
    sections: guide.sections,
  });
  const compatibility = checkGuideEvaluationMappingCompatibility(
    guideStructure,
    assets.mapping,
    assets.mappingFingerprint,
  );
  const itemRoutes = new Map(assets.mapping.itemRoutes.map((route) => [route.itemId, route]));
  const instrumentItems = assets.instrument.dimensions.flatMap((dimension) => dimension.items);
  const interpolationItems = new Map(
    assets.interpolationCodebook.items.map((item) => [item.itemId, item]),
  );
  const englishItems = new Map(
    assets.englishDefaultProfileOverlay.profile.items.map((item) => [item.itemId, item]),
  );
  const englishExamples = new Map(
    assets.englishDefaultProfileOverlay.rubric.examples.map((example) => [
      example.exampleId,
      example,
    ]),
  );
  const guideCatalog = buildGuideQuestionCatalog(guide);
  const adaptiveRoutes = new Map(
    instrumentItems.map((item) => [
      item.itemId,
      adaptiveGuideQuestionIds(
        guideCatalog,
        localizedElicitationQuestion(item, language, englishItems),
        language,
      ),
    ]),
  );
  const mapping = compatibility.compatible
    ? {
        mappingId: compatibility.mappingId,
        mappingVersion: compatibility.mappingVersion,
        mappingFingerprint: compatibility.mappingFingerprintSha256,
      }
    : adaptiveMapping(
        guideStructure,
        assets.instrumentFingerprint,
        [...adaptiveRoutes.entries()],
        hasher,
      );
  const identity = deterministicId(
    'or-evaluation-rubric',
    `${guide.id}:${assets.instrumentFingerprint}:${assets.interpolationCodebookFingerprint}:${mapping.mappingFingerprint}:${language === 'en' ? assets.englishDefaultProfileOverlayFingerprint : 'de'}`,
    hasher,
  );
  if (!identity.ok) throw new UnsupportedEvaluationGuideError('Evaluation rubric ID is invalid.');

  const rubric = organizationalResilienceRubricSchema.parse({
    schemaVersion: 1,
    kind: 'organizational_resilience_evidence_1_7',
    rubricId: identity.value,
    guideId: guide.id,
    version: ORGANIZATIONAL_RESILIENCE_RUBRIC_VERSION,
    title:
      language === 'en'
        ? assets.englishDefaultProfileOverlay.rubric.title
        : 'Organizational-Resilience-Evidenzrating',
    description:
      language === 'en'
        ? assets.englishDefaultProfileOverlay.rubric.description
        : 'Literaturbasierter Pilot zur abgeleiteten 1-bis-7-Evidenzcodierung der neun Kantur/Iseri-Say-Items.',
    instrument: {
      instrumentId: assets.instrument.instrumentId,
      instrumentVersion: assets.instrument.instrumentVersion,
      instrumentFingerprint: assets.instrumentFingerprint,
      classification: assets.instrument.classification,
    },
    mapping,
    scale: {
      kind: 'ordinal_1_7',
      minimum: 1,
      maximum: 7,
      referenceScores: [1, 4, 7],
      interpolationCodebook: {
        codebookId: assets.interpolationCodebook.codebookId,
        codebookVersion: assets.interpolationCodebook.codebookVersion,
        fingerprintSha256: assets.interpolationCodebookFingerprint,
        classification: assets.interpolationCodebook.classification,
        approvalStatus: assets.interpolationCodebook.approvalStatus,
      },
    },
    dimensions: assets.instrument.dimensions.map((dimension) => ({
      dimensionId: dimension.dimensionId,
      label: dimension.label,
      itemIds: dimension.items.map((item) => item.itemId),
    })),
    items: instrumentItems.map((item) => {
      const interpolationItem = interpolationItems.get(item.itemId);
      if (interpolationItem === undefined) {
        throw new UnsupportedEvaluationGuideError(
          `Missing interpolation rules for ${item.itemId}.`,
        );
      }
      const route = compatibility.compatible ? itemRoutes.get(item.itemId) : undefined;
      if (compatibility.compatible && route === undefined) {
        throw new UnsupportedEvaluationGuideError(`Missing guide route for ${item.itemId}.`);
      }
      const phases =
        route === undefined
          ? ['pre_adversity', 'during_adversity', 'post_adversity']
          : unique(
              route.scenarioRoutes.flatMap((scenario) =>
                scenario.preferredPhaseContexts.filter(isAdversityPhase),
              ),
            );
      const translatedItem =
        language === 'en'
          ? requiredEnglishValue(englishItems.get(item.itemId), `item ${item.itemId}`)
          : null;
      return {
        itemId: item.itemId,
        dimensionId: item.dimensionId,
        position: item.position,
        label: translatedItem?.name ?? item.elicitationQuestionDe,
        originalStatementEn: item.originalStatementEn,
        elicitationQuestion: translatedItem?.name ?? item.elicitationQuestionDe,
        codingInstruction: translatedItem?.codingInstruction ?? item.codingInstructionDe,
        guideQuestionIds:
          route === undefined
            ? (adaptiveRoutes.get(item.itemId) ?? [])
            : unique([
                ...route.primaryQuestionIds,
                ...route.supportingQuestionIds,
                ...route.counterEvidenceQuestionIds,
              ]),
        phases:
          phases.length === 0 ? ['pre_adversity', 'during_adversity', 'post_adversity'] : phases,
        anchors: item.anchors.map((anchor) => {
          const translatedAnchor = translatedItem?.anchors.find(
            (candidate) => candidate.score === anchor.score,
          );
          return {
            score: anchor.score,
            interpretation: translatedAnchor?.criterion ?? anchor.interpretationDe,
            approvedExamples: anchor.approvedExamples.map((example) => {
              const translatedExample =
                language === 'en'
                  ? requiredEnglishValue(
                      englishExamples.get(example.exampleId),
                      `example ${example.exampleId}`,
                    )
                  : null;
              return {
                exampleId: example.exampleId,
                behavioralAnchor: translatedExample?.behavioralAnchor ?? example.behavioralAnchorDe,
                typicalEvidence: translatedExample?.typicalEvidence ?? example.typicalEvidenceDe,
                empiricalEvidence:
                  translatedExample?.empiricalEvidence ?? example.empiricalEvidenceDe,
                sourceId: example.sourceReference.sourceId,
                sourceLocator: example.sourceReference.locator,
              };
            }),
          };
        }),
        interpolationRules: interpolationItem.rules.map((rule) => {
          const translatedRule =
            translatedItem === null
              ? null
              : translatedInterpolationRule(translatedItem, rule.score, rule.ruleId);
          return {
            ruleId: rule.ruleId,
            score: rule.score,
            adjacentReferenceScores: rule.adjacentReferenceScores,
            proximity: rule.proximity,
            decisionCriterion: translatedRule?.decisionCriterion ?? rule.decisionCriterionDe,
            exclusionCriterion: translatedRule?.exclusionCriterion ?? rule.exclusionCriterionDe,
          };
        }),
      };
    }),
  });
  const validated = validateEvaluationRubricAgainstGuide(rubric, guideStructure);
  if (!validated.ok) {
    throw new UnsupportedEvaluationGuideError(
      'The mapped organizational-resilience rubric does not match the supplied guide.',
    );
  }
  return rubric;
}

function translatedInterpolationRule(
  item: DefaultOrProfileEnglishOverlay['profile']['items'][number],
  score: 2 | 3 | 5 | 6,
  ruleId: string,
): { readonly decisionCriterion: string; readonly exclusionCriterion: string } {
  const criterion = requiredEnglishValue(
    item.anchors.find((anchor) => anchor.score === score),
    `interpolation rule ${ruleId}`,
  ).criterion;
  const separator = '\nBoundary: ';
  const separatorIndex = criterion.indexOf(separator);
  if (separatorIndex <= 0 || separatorIndex + separator.length >= criterion.length) {
    throw new UnsupportedEvaluationGuideError(
      `English translation for interpolation rule ${ruleId} has no explicit boundary.`,
    );
  }
  return {
    decisionCriterion: criterion.slice(0, separatorIndex),
    exclusionCriterion: criterion.slice(separatorIndex + separator.length),
  };
}

function adaptiveGuideQuestionIds(
  catalog: ReturnType<typeof buildGuideQuestionCatalog>,
  elicitationQuestion: string,
  language: SupportedLocale,
): string[] {
  return unique(
    catalog
      .filter(
        (question) =>
          normalizedGuideText(question.text, language) ===
          normalizedGuideText(elicitationQuestion, language),
      )
      .map((question) => question.questionId),
  ).slice(0, MAXIMUM_RUBRIC_QUESTION_HINTS);
}

function normalizedGuideText(value: string, language: SupportedLocale): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLocaleLowerCase(language === 'en' ? 'en-US' : 'de-DE')
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim();
}

function localizedElicitationQuestion(
  item: OrganizationalResilienceEvaluationAssets['instrument']['dimensions'][number]['items'][number],
  language: SupportedLocale,
  englishItems: ReadonlyMap<string, DefaultOrProfileEnglishOverlay['profile']['items'][number]>,
): string {
  return language === 'en'
    ? requiredEnglishValue(englishItems.get(item.itemId), `item ${item.itemId}`).name
    : item.elicitationQuestionDe;
}

function requiredEnglishValue<Value>(value: Value | undefined, label: string): Value {
  if (value === undefined) {
    throw new UnsupportedEvaluationGuideError(`Missing English translation for ${label}.`);
  }
  return value;
}

function adaptiveMapping(
  guide: Parameters<typeof canonicalizeGuideStructureForMapping>[0],
  instrumentFingerprint: string,
  itemRoutes: readonly (readonly [string, readonly string[]])[],
  hasher: Sha256,
): OrganizationalResilienceRubric['mapping'] {
  const fingerprint = sha256(
    hasher,
    JSON.stringify({
      mappingId: ORGANIZATIONAL_RESILIENCE_ADAPTIVE_MAPPING_ID,
      mappingVersion: ADAPTIVE_MAPPING_VERSION,
      instrumentFingerprint,
      guideStructure: canonicalizeGuideStructureForMapping(guide),
      itemRoutes,
    }),
  );
  if (!fingerprint.ok) {
    throw new UnsupportedEvaluationGuideError('Adaptive evaluation mapping is invalid.');
  }
  return {
    mappingId: ORGANIZATIONAL_RESILIENCE_ADAPTIVE_MAPPING_ID,
    mappingVersion: ADAPTIVE_MAPPING_VERSION,
    mappingFingerprint: fingerprint.value,
  };
}

function isAdversityPhase(
  phase: string,
): phase is 'pre_adversity' | 'during_adversity' | 'post_adversity' {
  return phase === 'pre_adversity' || phase === 'during_adversity' || phase === 'post_adversity';
}

function unique<Value>(values: readonly Value[]): Value[] {
  return [...new Set(values)];
}
