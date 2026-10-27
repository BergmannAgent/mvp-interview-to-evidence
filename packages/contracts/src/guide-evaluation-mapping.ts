import { z } from 'zod';

import {
  LITERATURE_INSTRUMENT_ITEM_IDS,
  LITERATURE_INSTRUMENT_VERSION,
} from './literature-instrument.js';
import { idSchema, nonBlankTextSchema } from './primitives.js';

export const GUIDE_EVALUATION_MAPPING_SCHEMA_VERSION = 1 as const;
export const GUIDE_EVALUATION_MAPPING_VERSION = '1.0.0' as const;
export const GUIDE_EVALUATION_MAPPING_ID =
  'resilient-decision-processes-kantur-evidence-v1' as const;

export const GUIDE_PHASE_CONTEXT_IDS = [
  'respondent_context',
  'pre_adversity',
  'during_adversity',
  'post_adversity',
  'cross_phase',
] as const;

export const GUIDE_EVENT_ROUTE_IDS = [
  'actual_event',
  'hypothetical_event',
  'no_crisis_experienced',
] as const;

const normalizedTextSchema = nonBlankTextSchema
  .max(2_000)
  .refine((value) => value === value.trim(), 'Text must not contain boundary whitespace')
  .refine((value) => value.normalize('NFC') === value, 'Text must be NFC-normalized');
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const itemIdSchema = z.enum(LITERATURE_INSTRUMENT_ITEM_IDS);
const phaseContextSchema = z.enum(GUIDE_PHASE_CONTEXT_IDS);
const eventRouteIdSchema = z.enum(GUIDE_EVENT_ROUTE_IDS);

const mappedMainQuestionSchema = z.strictObject({
  mainQuestionId: idSchema,
  followUpQuestionIds: z.array(idSchema),
});

const mappedGuideSectionSchema = z.strictObject({
  sectionId: idSchema,
  phaseContext: phaseContextSchema,
  mainQuestions: z.array(mappedMainQuestionSchema).min(1),
});

const scenarioRouteDefinitionSchema = z.strictObject({
  routeId: eventRouteIdSchema,
  evidenceClassification: z.enum([
    'observed_event',
    'hypothetical_response',
    'preparation_or_minor_disruption',
  ]),
  activationConditionDe: normalizedTextSchema,
  interviewerInstructionDe: normalizedTextSchema,
  scoringConstraintDe: normalizedTextSchema,
});

const itemScenarioRouteSchema = z.strictObject({
  routeId: eventRouteIdSchema,
  neutralPromptDe: normalizedTextSchema.max(600),
  preferredPhaseContexts: z.array(phaseContextSchema).min(1),
});

const itemEvidenceRouteSchema = z.strictObject({
  itemId: itemIdSchema,
  primaryQuestionIds: z.array(idSchema).min(1),
  supportingQuestionIds: z.array(idSchema),
  counterEvidenceQuestionIds: z.array(idSchema),
  scenarioRoutes: z.array(itemScenarioRouteSchema),
});

export const guideEvaluationMappingSchema = z
  .strictObject({
    schemaVersion: z.literal(GUIDE_EVALUATION_MAPPING_SCHEMA_VERSION),
    mappingId: z.literal(GUIDE_EVALUATION_MAPPING_ID),
    mappingVersion: z.literal(GUIDE_EVALUATION_MAPPING_VERSION),
    status: z.literal('pilot_only'),
    language: z.literal('de'),
    instrument: z.strictObject({
      instrumentId: z.literal('kantur-iseri-say-evidence-rating'),
      instrumentVersion: z.literal(LITERATURE_INSTRUMENT_VERSION),
    }),
    sourceGuide: z.strictObject({
      guideId: idSchema,
      title: normalizedTextSchema.max(300),
      stableIdVersion: z.literal('v1'),
      sourceFile: z.literal('Interview Leitfaden_Test Voice Agent.docx.md'),
      structureFingerprintSha256: sha256Schema,
      sections: z.array(mappedGuideSectionSchema).min(1),
      contextOnlyQuestionIds: z.array(idSchema),
    }),
    methodologicalSafeguards: z.strictObject({
      phaseTreatment: z.literal('context_only_not_additional_rating_items'),
      guideQuestionTreatment: z.literal('evidence_prompts_not_rating_items'),
      noCrisisRule: z.literal('never_infer_low_score_from_absence_of_crisis'),
      hypotheticalEvidenceRule: z.literal(
        'label_hypothetical_and_do_not_treat_as_observed_behavior',
      ),
      partialCoverageRule: z.literal('use_insufficient_evidence_instead_of_forced_score'),
      multipleEvidenceRule: z.literal('retain_supporting_counter_and_ambiguous_evidence'),
    }),
    scenarioRoutes: z.array(scenarioRouteDefinitionSchema),
    itemRoutes: z.array(itemEvidenceRouteSchema),
  })
  .superRefine(validateMappingInvariants);

export type GuidePhaseContextId = (typeof GUIDE_PHASE_CONTEXT_IDS)[number];
export type GuideEventRouteId = (typeof GUIDE_EVENT_ROUTE_IDS)[number];
export type GuideEvaluationMapping = z.infer<typeof guideEvaluationMappingSchema>;

export interface EvaluationMappingGuideStructure {
  readonly id: string;
  readonly title: string;
  readonly sections: readonly {
    readonly id: string;
    readonly position: number;
    readonly title: string;
    readonly mainQuestions: readonly {
      readonly id: string;
      readonly position: number;
      readonly text: string;
      readonly followUpQuestions: readonly {
        readonly id: string;
        readonly position: number;
        readonly text: string;
      }[];
    }[];
  }[];
}

export type GuideEvaluationMappingCompatibility =
  | {
      readonly compatible: true;
      readonly mappingId: typeof GUIDE_EVALUATION_MAPPING_ID;
      readonly mappingVersion: typeof GUIDE_EVALUATION_MAPPING_VERSION;
      readonly mappingFingerprintSha256: string;
    }
  | {
      readonly compatible: false;
      readonly code: 'guide_id_mismatch' | 'guide_structure_mismatch';
      readonly message: string;
    };

export function checkGuideEvaluationMappingCompatibility(
  guide: EvaluationMappingGuideStructure,
  mapping: GuideEvaluationMapping,
  mappingFingerprintSha256: string,
): GuideEvaluationMappingCompatibility {
  if (guide.id !== mapping.sourceGuide.guideId || guide.title !== mapping.sourceGuide.title) {
    return {
      compatible: false,
      code: 'guide_id_mismatch',
      message: `Guide ${guide.id} is not supported by mapping ${mapping.mappingId}@${mapping.mappingVersion}`,
    };
  }

  if (!hasMappedStructure(guide, mapping.sourceGuide.sections)) {
    return {
      compatible: false,
      code: 'guide_structure_mismatch',
      message: `Guide ${guide.id} differs from the versioned structure required by mapping ${mapping.mappingId}@${mapping.mappingVersion}`,
    };
  }

  if (!sha256Schema.safeParse(mappingFingerprintSha256).success) {
    throw new TypeError('mappingFingerprintSha256 must be a lowercase SHA-256 digest');
  }

  return {
    compatible: true,
    mappingId: mapping.mappingId,
    mappingVersion: mapping.mappingVersion,
    mappingFingerprintSha256,
  };
}

export function canonicalizeGuideStructureForMapping(
  guide: EvaluationMappingGuideStructure,
): string {
  return JSON.stringify({
    id: guide.id,
    title: guide.title,
    sections: guide.sections.map((section) => ({
      id: section.id,
      position: section.position,
      title: section.title,
      mainQuestions: section.mainQuestions.map((question) => ({
        id: question.id,
        position: question.position,
        text: question.text,
        followUpQuestions: question.followUpQuestions.map((followUp) => ({
          id: followUp.id,
          position: followUp.position,
          text: followUp.text,
        })),
      })),
    })),
  });
}

export function canonicalizeGuideEvaluationMapping(mapping: GuideEvaluationMapping): string {
  return JSON.stringify(canonicalizeValue(mapping));
}

export function parseGuideEvaluationMappingFingerprintSidecar(
  serializedSidecar: string,
  expectedFileName: string,
): string {
  const normalized = serializedSidecar.replace(/\r\n/gu, '\n');
  const match = /^([a-f0-9]{64}) {2}([^\n]+)\n$/u.exec(normalized);
  if (match === null || match[2] !== expectedFileName || match[1] === undefined) {
    throw new TypeError('Invalid guide evaluation mapping fingerprint sidecar');
  }
  return match[1];
}

function validateMappingInvariants(
  mapping: z.infer<typeof guideEvaluationMappingSchema>,
  context: z.RefinementCtx,
): void {
  const questionIds = new Set<string>();
  const questionPhaseContexts = new Map<string, GuidePhaseContextId>();
  const sectionIds = new Set<string>();

  validateOrderedIds(
    mapping.sourceGuide.sections.map((section) => section.phaseContext),
    GUIDE_PHASE_CONTEXT_IDS,
    ['sourceGuide', 'sections'],
    'Guide phase contexts',
    context,
  );

  for (const [sectionIndex, section] of mapping.sourceGuide.sections.entries()) {
    if (sectionIds.has(section.sectionId)) {
      addIssue(
        context,
        ['sourceGuide', 'sections', sectionIndex, 'sectionId'],
        'Section IDs must be unique',
      );
    }
    sectionIds.add(section.sectionId);
    for (const [mainIndex, mainQuestion] of section.mainQuestions.entries()) {
      addQuestion(
        mainQuestion.mainQuestionId,
        section.phaseContext,
        ['sourceGuide', 'sections', sectionIndex, 'mainQuestions', mainIndex, 'mainQuestionId'],
        questionIds,
        questionPhaseContexts,
        context,
      );
      for (const [followUpIndex, followUpId] of mainQuestion.followUpQuestionIds.entries()) {
        addQuestion(
          followUpId,
          section.phaseContext,
          [
            'sourceGuide',
            'sections',
            sectionIndex,
            'mainQuestions',
            mainIndex,
            'followUpQuestionIds',
            followUpIndex,
          ],
          questionIds,
          questionPhaseContexts,
          context,
        );
      }
    }
  }

  const contextOnlyIds = new Set(mapping.sourceGuide.contextOnlyQuestionIds);
  if (contextOnlyIds.size !== mapping.sourceGuide.contextOnlyQuestionIds.length) {
    addIssue(
      context,
      ['sourceGuide', 'contextOnlyQuestionIds'],
      'Context-only question IDs must be unique',
    );
  }
  for (const questionId of contextOnlyIds) {
    if (!questionIds.has(questionId)) {
      addIssue(
        context,
        ['sourceGuide', 'contextOnlyQuestionIds'],
        `Unknown context-only question ${questionId}`,
      );
    }
    if (questionPhaseContexts.get(questionId) !== 'respondent_context') {
      addIssue(
        context,
        ['sourceGuide', 'contextOnlyQuestionIds'],
        `Context-only question ${questionId} must belong to respondent context`,
      );
    }
  }

  validateOrderedIds(
    mapping.scenarioRoutes.map((route) => route.routeId),
    GUIDE_EVENT_ROUTE_IDS,
    ['scenarioRoutes'],
    'Scenario routes',
    context,
  );
  const expectedClassifications = [
    'observed_event',
    'hypothetical_response',
    'preparation_or_minor_disruption',
  ];
  if (
    mapping.scenarioRoutes.some(
      (route, index) => route.evidenceClassification !== expectedClassifications[index],
    )
  ) {
    addIssue(
      context,
      ['scenarioRoutes'],
      'Scenario route classifications must distinguish actual, hypothetical, and no-crisis evidence',
    );
  }

  validateOrderedIds(
    mapping.itemRoutes.map((route) => route.itemId),
    LITERATURE_INSTRUMENT_ITEM_IDS,
    ['itemRoutes'],
    'Instrument item routes',
    context,
  );

  const assignedQuestionIds = new Set<string>();
  for (const [itemIndex, itemRoute] of mapping.itemRoutes.entries()) {
    const lists = [
      ['primaryQuestionIds', itemRoute.primaryQuestionIds],
      ['supportingQuestionIds', itemRoute.supportingQuestionIds],
      ['counterEvidenceQuestionIds', itemRoute.counterEvidenceQuestionIds],
    ] as const;
    const itemQuestionIds = new Set<string>();
    for (const [field, ids] of lists) {
      for (const [questionIndex, questionId] of ids.entries()) {
        const path = ['itemRoutes', itemIndex, field, questionIndex];
        if (!questionIds.has(questionId)) {
          addIssue(context, path, `Unknown mapped question ${questionId}`);
        }
        if (contextOnlyIds.has(questionId)) {
          addIssue(
            context,
            path,
            `Context-only question ${questionId} cannot provide item evidence`,
          );
        }
        if (itemQuestionIds.has(questionId)) {
          addIssue(
            context,
            path,
            `Question ${questionId} has multiple evidence roles for ${itemRoute.itemId}`,
          );
        }
        itemQuestionIds.add(questionId);
        assignedQuestionIds.add(questionId);
      }
    }

    validateOrderedIds(
      itemRoute.scenarioRoutes.map((route) => route.routeId),
      GUIDE_EVENT_ROUTE_IDS,
      ['itemRoutes', itemIndex, 'scenarioRoutes'],
      `Scenario routes for ${itemRoute.itemId}`,
      context,
    );
    for (const [scenarioIndex, route] of itemRoute.scenarioRoutes.entries()) {
      const phases = new Set(route.preferredPhaseContexts);
      if (phases.size !== route.preferredPhaseContexts.length) {
        addIssue(
          context,
          ['itemRoutes', itemIndex, 'scenarioRoutes', scenarioIndex, 'preferredPhaseContexts'],
          'Preferred phase contexts must be unique',
        );
      }
      if (
        !itemQuestionIds.size ||
        ![...itemQuestionIds].some((questionId) =>
          phases.has(questionPhaseContexts.get(questionId)!),
        )
      ) {
        addIssue(
          context,
          ['itemRoutes', itemIndex, 'scenarioRoutes', scenarioIndex, 'preferredPhaseContexts'],
          'Each scenario route must point to a phase represented by an item question',
        );
      }
    }
  }

  for (const questionId of questionIds) {
    if (!contextOnlyIds.has(questionId) && !assignedQuestionIds.has(questionId)) {
      addIssue(
        context,
        ['itemRoutes'],
        `Guide question ${questionId} is neither context-only nor mapped to an instrument item`,
      );
    }
  }
}

function hasMappedStructure(
  guide: EvaluationMappingGuideStructure,
  mappedSections: GuideEvaluationMapping['sourceGuide']['sections'],
): boolean {
  if (guide.sections.length !== mappedSections.length) return false;
  return guide.sections.every((section, sectionIndex) => {
    const mappedSection = mappedSections[sectionIndex];
    if (
      mappedSection === undefined ||
      section.id !== mappedSection.sectionId ||
      section.mainQuestions.length !== mappedSection.mainQuestions.length
    ) {
      return false;
    }
    return section.mainQuestions.every((question, questionIndex) => {
      const mappedQuestion = mappedSection.mainQuestions[questionIndex];
      return (
        mappedQuestion !== undefined &&
        question.id === mappedQuestion.mainQuestionId &&
        question.followUpQuestions.length === mappedQuestion.followUpQuestionIds.length &&
        question.followUpQuestions.every(
          (followUp, followUpIndex) =>
            followUp.id === mappedQuestion.followUpQuestionIds[followUpIndex],
        )
      );
    });
  });
}

function addQuestion(
  questionId: string,
  phaseContext: GuidePhaseContextId,
  path: PropertyKey[],
  questionIds: Set<string>,
  questionPhaseContexts: Map<string, GuidePhaseContextId>,
  context: z.RefinementCtx,
): void {
  if (questionIds.has(questionId)) {
    addIssue(context, path, 'Guide question IDs must be unique');
  }
  questionIds.add(questionId);
  questionPhaseContexts.set(questionId, phaseContext);
}

function validateOrderedIds(
  actual: readonly string[],
  expected: readonly string[],
  path: PropertyKey[],
  label: string,
  context: z.RefinementCtx,
): void {
  if (
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    addIssue(context, path, `${label} must be complete, unique, and in canonical order`);
  }
}

function addIssue(context: z.RefinementCtx, path: PropertyKey[], message: string): void {
  context.addIssue({ code: 'custom', path, message });
}

type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

function canonicalizeValue(value: unknown): CanonicalJsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new TypeError('Canonical JSON cannot contain non-finite numbers');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalizeValue);
  if (typeof value === 'object') {
    const result: Record<string, CanonicalJsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined)
        throw new TypeError('Canonical JSON cannot contain undefined values');
      result[key] = canonicalizeValue(child);
    }
    return result;
  }
  throw new TypeError(`Unsupported canonical JSON value: ${typeof value}`);
}
