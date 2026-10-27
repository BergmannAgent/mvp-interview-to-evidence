import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseInterviewGuideMarkdown } from '../../domain/src/guide/parser.js';
import {
  canonicalizeGuideEvaluationMapping,
  canonicalizeGuideStructureForMapping,
  checkGuideEvaluationMappingCompatibility,
  GUIDE_EVENT_ROUTE_IDS,
  GUIDE_PHASE_CONTEXT_IDS,
  guideEvaluationMappingSchema,
  parseGuideEvaluationMappingFingerprintSidecar,
  type GuideEvaluationMapping,
} from '../src/guide-evaluation-mapping.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const mappingFileName = 'resilient-decision-processes-guide-mapping-v1.json';
const mappingDirectory = path.join(
  repositoryRoot,
  'research/instruments/organizational-resilience',
);
const mappingPath = path.join(mappingDirectory, mappingFileName);
const mappingFingerprintPath = path.join(
  mappingDirectory,
  'resilient-decision-processes-guide-mapping-v1.sha256',
);
const guidePath = path.join(
  repositoryRoot,
  'guides/fixtures/Interview Leitfaden_Test Voice Agent.docx.md',
);

function loadMapping(): GuideEvaluationMapping {
  return guideEvaluationMappingSchema.parse(
    JSON.parse(readFileSync(mappingPath, 'utf8')) as unknown,
  );
}

function loadGuide() {
  const result = parseInterviewGuideMarkdown(readFileSync(guidePath, 'utf8'));
  if (!result.success) throw new Error('The mapped guide fixture must parse');
  return result.guide;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function mappedQuestionIds(mapping: GuideEvaluationMapping): Set<string> {
  return new Set(
    mapping.itemRoutes.flatMap((route) => [
      ...route.primaryQuestionIds,
      ...route.supportingQuestionIds,
      ...route.counterEvidenceQuestionIds,
    ]),
  );
}

describe('resilient decision processes guide mapping', () => {
  it('maps the complete current guide to exactly nine literature items and contextual phases', () => {
    const mapping = loadMapping();
    const sourceQuestionIds = mapping.sourceGuide.sections.flatMap((section) =>
      section.mainQuestions.flatMap((question) => [
        question.mainQuestionId,
        ...question.followUpQuestionIds,
      ]),
    );
    const contextOnlyIds = new Set(mapping.sourceGuide.contextOnlyQuestionIds);
    const scoredPromptIds = mappedQuestionIds(mapping);

    expect(mapping.itemRoutes.map((route) => route.itemId)).toEqual([
      'rob-01',
      'rob-02',
      'rob-03',
      'rob-04',
      'agi-01',
      'agi-02',
      'agi-03',
      'int-01',
      'int-02',
    ]);
    expect(mapping.sourceGuide.sections.map((section) => section.phaseContext)).toEqual(
      GUIDE_PHASE_CONTEXT_IDS,
    );
    expect(sourceQuestionIds).toHaveLength(58);
    expect(contextOnlyIds.size).toBe(3);
    expect(scoredPromptIds.size).toBe(55);
    expect(
      sourceQuestionIds.every(
        (questionId) => contextOnlyIds.has(questionId) || scoredPromptIds.has(questionId),
      ),
    ).toBe(true);
    expect(
      mapping.itemRoutes.every(
        (route) =>
          route.primaryQuestionIds.length > 0 &&
          route.scenarioRoutes.map((scenario) => scenario.routeId).join('|') ===
            GUIDE_EVENT_ROUTE_IDS.join('|'),
      ),
    ).toBe(true);
  });

  it('binds the artifact and its source fingerprint to the checked-in Markdown guide', () => {
    const mapping = loadMapping();
    const guide = loadGuide();
    const guideFingerprint = sha256(canonicalizeGuideStructureForMapping(guide));
    const sidecarFingerprint = parseGuideEvaluationMappingFingerprintSidecar(
      readFileSync(mappingFingerprintPath, 'utf8'),
      mappingFileName,
    );
    const mappingFingerprint = sha256(canonicalizeGuideEvaluationMapping(mapping));

    expect(guideFingerprint).toBe(mapping.sourceGuide.structureFingerprintSha256);
    expect(mappingFingerprint).toBe(sidecarFingerprint);
    expect(checkGuideEvaluationMappingCompatibility(guide, mapping, mappingFingerprint)).toEqual({
      compatible: true,
      mappingId: 'resilient-decision-processes-kantur-evidence-v1',
      mappingVersion: '1.0.0',
      mappingFingerprintSha256: mappingFingerprint,
    });
  });

  it('rejects an unknown guide and a changed structure with an explicit incompatibility reason', () => {
    const mapping = loadMapping();
    const guide = loadGuide();
    const digest = sha256(canonicalizeGuideEvaluationMapping(mapping));
    const unknownGuide = {
      ...guide,
      id: 'guide:v1:unknown',
      title: 'Anderer Leitfaden',
    };
    expect(checkGuideEvaluationMappingCompatibility(unknownGuide, mapping, digest)).toMatchObject({
      compatible: false,
      code: 'guide_id_mismatch',
    });

    const changedGuide = {
      ...guide,
      sections: guide.sections.map((section, sectionIndex) => ({
        ...section,
        mainQuestions: section.mainQuestions.map((question, questionIndex) => ({
          ...question,
          followUpQuestions:
            sectionIndex === 1 && questionIndex === 0
              ? question.followUpQuestions.slice(0, -1)
              : [...question.followUpQuestions],
        })),
      })),
    };
    expect(checkGuideEvaluationMappingCompatibility(changedGuide, mapping, digest)).toMatchObject({
      compatible: false,
      code: 'guide_structure_mismatch',
    });
  });

  it('rejects unknown references, duplicate evidence roles, and unmapped guide questions', () => {
    const unknownReference = structuredClone(loadMapping());
    unknownReference.itemRoutes[0]!.primaryQuestionIds[0] = 'main-question:v1:unknown';
    expect(guideEvaluationMappingSchema.safeParse(unknownReference).success).toBe(false);

    const duplicateRole = structuredClone(loadMapping());
    duplicateRole.itemRoutes[0]!.supportingQuestionIds.push(
      duplicateRole.itemRoutes[0]!.primaryQuestionIds[0]!,
    );
    expect(guideEvaluationMappingSchema.safeParse(duplicateRole).success).toBe(false);

    const unmapped = structuredClone(loadMapping());
    const onlyIntegrityRoute = unmapped.itemRoutes.find((route) => route.itemId === 'int-02');
    if (onlyIntegrityRoute === undefined) throw new Error('Invalid mapping fixture');
    onlyIntegrityRoute.supportingQuestionIds = onlyIntegrityRoute.supportingQuestionIds.filter(
      (questionId) => questionId !== 'follow-up:v1:0a7g9y20q0u9pa',
    );
    expect(guideEvaluationMappingSchema.safeParse(unmapped).success).toBe(false);
  });

  it('keeps actual, hypothetical, and no-crisis routes methodologically distinct', () => {
    const mapping = loadMapping();

    expect(mapping.scenarioRoutes.map((route) => route.evidenceClassification)).toEqual([
      'observed_event',
      'hypothetical_response',
      'preparation_or_minor_disruption',
    ]);
    expect(mapping.methodologicalSafeguards).toMatchObject({
      phaseTreatment: 'context_only_not_additional_rating_items',
      guideQuestionTreatment: 'evidence_prompts_not_rating_items',
      noCrisisRule: 'never_infer_low_score_from_absence_of_crisis',
      hypotheticalEvidenceRule: 'label_hypothetical_and_do_not_treat_as_observed_behavior',
      partialCoverageRule: 'use_insufficient_evidence_instead_of_forced_score',
      multipleEvidenceRule: 'retain_supporting_counter_and_ambiguous_evidence',
    });
    expect(
      mapping.itemRoutes
        .flatMap((route) => route.scenarioRoutes)
        .every((route) => (route.neutralPromptDe.match(/\?/gu) ?? []).length === 1),
    ).toBe(true);

    const reorderedRoutes = {
      ...mapping,
      scenarioRoutes: mapping.scenarioRoutes.toReversed(),
    };
    expect(guideEvaluationMappingSchema.safeParse(reorderedRoutes).success).toBe(false);

    const weakenedNoCrisisGuardrail = {
      ...mapping,
      methodologicalSafeguards: {
        ...mapping.methodologicalSafeguards,
        noCrisisRule: 'infer_low_score_when_no_crisis_was_observed',
      },
    };
    expect(guideEvaluationMappingSchema.safeParse(weakenedNoCrisisGuardrail).success).toBe(false);
  });

  it('canonicalizes object keys and validates the strict digest sidecar format', () => {
    const mapping = loadMapping();
    const digest = sha256(canonicalizeGuideEvaluationMapping(mapping));
    const reordered = guideEvaluationMappingSchema.parse(
      Object.fromEntries(Object.entries(mapping).reverse()),
    );
    expect(sha256(canonicalizeGuideEvaluationMapping(reordered))).toBe(digest);

    const changed = structuredClone(mapping);
    changed.itemRoutes[0]!.scenarioRoutes[0]!.neutralPromptDe +=
      ' Bitte nennen Sie dafür ein Beispiel.';
    expect(sha256(canonicalizeGuideEvaluationMapping(changed))).not.toBe(digest);

    expect(
      parseGuideEvaluationMappingFingerprintSidecar(
        `${digest}  ${mappingFileName}\r\n`,
        mappingFileName,
      ),
    ).toBe(digest);
    expect(() =>
      parseGuideEvaluationMappingFingerprintSidecar(
        `${digest}  anderes-mapping.json\n`,
        mappingFileName,
      ),
    ).toThrow('Invalid guide evaluation mapping fingerprint sidecar');
  });
});
