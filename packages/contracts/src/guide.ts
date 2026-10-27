import { z } from 'zod';

import { idSchema, nonBlankTextSchema, timestampSchema } from './primitives.js';
import { DEFAULT_LOCALE, supportedLocaleSchema } from './locale.js';

export const INTERVIEW_GUIDE_LIMITS = Object.freeze({
  maximumSections: 100,
  maximumMainQuestions: 500,
  maximumFollowUpQuestions: 1_500,
  maximumTotalQuestions: 1_750,
});

export const followUpQuestionSchema = z.strictObject({
  id: idSchema,
  position: z.number().int().nonnegative(),
  text: nonBlankTextSchema.max(2_000),
});

export const mainQuestionSchema = z.strictObject({
  id: idSchema,
  position: z.number().int().nonnegative(),
  text: nonBlankTextSchema.max(2_000),
  followUpQuestions: z
    .array(followUpQuestionSchema)
    .max(INTERVIEW_GUIDE_LIMITS.maximumFollowUpQuestions),
});

export const guideSectionSchema = z.strictObject({
  id: idSchema,
  position: z.number().int().nonnegative(),
  title: nonBlankTextSchema.max(300),
  mainQuestions: z.array(mainQuestionSchema).max(INTERVIEW_GUIDE_LIMITS.maximumMainQuestions),
});

const guideStructureShape = {
  id: idSchema,
  sourceLanguage: supportedLocaleSchema.default(DEFAULT_LOCALE),
  title: nonBlankTextSchema.max(300),
  sections: z.array(guideSectionSchema).min(1).max(INTERVIEW_GUIDE_LIMITS.maximumSections),
};

type GuideStructureInput = z.infer<z.ZodObject<typeof guideStructureShape>>;

const guideCardinalityPreflightSchema = z.unknown().superRefine(validateRawGuideCardinality);

function validateGuideStructure(guide: GuideStructureInput, context: z.RefinementCtx): void {
  const ids = new Set<string>([guide.id]);
  let mainQuestionCount = 0;

  for (const [sectionIndex, section] of guide.sections.entries()) {
    validatePosition(
      section.position,
      sectionIndex,
      ['sections', sectionIndex, 'position'],
      context,
    );
    addUniqueNodeId(section.id, ['sections', sectionIndex, 'id'], ids, context);

    for (const [questionIndex, question] of section.mainQuestions.entries()) {
      mainQuestionCount += 1;
      validatePosition(
        question.position,
        questionIndex,
        ['sections', sectionIndex, 'mainQuestions', questionIndex, 'position'],
        context,
      );
      addUniqueNodeId(
        question.id,
        ['sections', sectionIndex, 'mainQuestions', questionIndex, 'id'],
        ids,
        context,
      );

      for (const [followUpIndex, followUp] of question.followUpQuestions.entries()) {
        validatePosition(
          followUp.position,
          followUpIndex,
          [
            'sections',
            sectionIndex,
            'mainQuestions',
            questionIndex,
            'followUpQuestions',
            followUpIndex,
            'position',
          ],
          context,
        );
        addUniqueNodeId(
          followUp.id,
          [
            'sections',
            sectionIndex,
            'mainQuestions',
            questionIndex,
            'followUpQuestions',
            followUpIndex,
            'id',
          ],
          ids,
          context,
        );
      }
    }
  }

  if (mainQuestionCount === 0) {
    context.addIssue({
      code: 'custom',
      message: 'An interview guide must contain at least one main question',
      path: ['sections'],
    });
  }
  const followUpQuestionCount = guide.sections.reduce(
    (count, section) =>
      count +
      section.mainQuestions.reduce(
        (sectionCount, question) => sectionCount + question.followUpQuestions.length,
        0,
      ),
    0,
  );
  if (mainQuestionCount > INTERVIEW_GUIDE_LIMITS.maximumMainQuestions) {
    context.addIssue({
      code: 'too_big',
      origin: 'array',
      maximum: INTERVIEW_GUIDE_LIMITS.maximumMainQuestions,
      inclusive: true,
      path: ['sections'],
      message: 'An interview guide contains too many main questions',
    });
  }
  if (followUpQuestionCount > INTERVIEW_GUIDE_LIMITS.maximumFollowUpQuestions) {
    context.addIssue({
      code: 'too_big',
      origin: 'array',
      maximum: INTERVIEW_GUIDE_LIMITS.maximumFollowUpQuestions,
      inclusive: true,
      path: ['sections'],
      message: 'An interview guide contains too many follow-up questions',
    });
  }
  if (mainQuestionCount + followUpQuestionCount > INTERVIEW_GUIDE_LIMITS.maximumTotalQuestions) {
    context.addIssue({
      code: 'too_big',
      origin: 'array',
      maximum: INTERVIEW_GUIDE_LIMITS.maximumTotalQuestions,
      inclusive: true,
      path: ['sections'],
      message: 'An interview guide contains too many total questions',
    });
  }
}

function validatePosition(
  actual: number,
  expected: number,
  path: PropertyKey[],
  context: z.RefinementCtx,
): void {
  if (actual !== expected) {
    context.addIssue({
      code: 'custom',
      message: `Guide positions must be contiguous and zero based; expected ${expected}`,
      path,
    });
  }
}

function addUniqueNodeId(
  id: string,
  path: PropertyKey[],
  ids: Set<string>,
  context: z.RefinementCtx,
): void {
  if (ids.has(id)) {
    context.addIssue({
      code: 'custom',
      message: 'Guide node IDs must be unique',
      path,
    });
  }
  ids.add(id);
}

const detailedGuideStructureSchema = z
  .strictObject(guideStructureShape)
  .superRefine(validateGuideStructure);

export const guideStructureSchema = guideCardinalityPreflightSchema.pipe(
  detailedGuideStructureSchema,
);

const detailedInterviewGuideSchema = z
  .strictObject({
    ...guideStructureShape,
    sourceMarkdown: nonBlankTextSchema.max(1_000_000),
    createdAt: timestampSchema,
  })
  .superRefine(validateGuideStructure);

export const interviewGuideSchema = guideCardinalityPreflightSchema.pipe(
  detailedInterviewGuideSchema,
);

function validateRawGuideCardinality(value: unknown, context: z.RefinementCtx): void {
  if (!isRecord(value) || !Array.isArray(value.sections)) return;
  if (value.sections.length > INTERVIEW_GUIDE_LIMITS.maximumSections) {
    addRawCardinalityIssue(
      context,
      INTERVIEW_GUIDE_LIMITS.maximumSections,
      ['sections'],
      'An interview guide contains too many sections',
    );
    return;
  }

  let mainQuestionCount = 0;
  let followUpQuestionCount = 0;
  for (const [sectionIndex, section] of value.sections.entries()) {
    if (!isRecord(section) || !Array.isArray(section.mainQuestions)) continue;
    mainQuestionCount += section.mainQuestions.length;
    if (mainQuestionCount > INTERVIEW_GUIDE_LIMITS.maximumMainQuestions) {
      addRawCardinalityIssue(
        context,
        INTERVIEW_GUIDE_LIMITS.maximumMainQuestions,
        ['sections', sectionIndex, 'mainQuestions'],
        'An interview guide contains too many main questions',
      );
      return;
    }
    if (mainQuestionCount + followUpQuestionCount > INTERVIEW_GUIDE_LIMITS.maximumTotalQuestions) {
      addRawCardinalityIssue(
        context,
        INTERVIEW_GUIDE_LIMITS.maximumTotalQuestions,
        ['sections'],
        'An interview guide contains too many total questions',
      );
      return;
    }

    for (const [questionIndex, question] of section.mainQuestions.entries()) {
      if (!isRecord(question) || !Array.isArray(question.followUpQuestions)) continue;
      followUpQuestionCount += question.followUpQuestions.length;
      if (followUpQuestionCount > INTERVIEW_GUIDE_LIMITS.maximumFollowUpQuestions) {
        addRawCardinalityIssue(
          context,
          INTERVIEW_GUIDE_LIMITS.maximumFollowUpQuestions,
          ['sections', sectionIndex, 'mainQuestions', questionIndex, 'followUpQuestions'],
          'An interview guide contains too many follow-up questions',
        );
        return;
      }
      if (
        mainQuestionCount + followUpQuestionCount >
        INTERVIEW_GUIDE_LIMITS.maximumTotalQuestions
      ) {
        addRawCardinalityIssue(
          context,
          INTERVIEW_GUIDE_LIMITS.maximumTotalQuestions,
          ['sections'],
          'An interview guide contains too many total questions',
        );
        return;
      }
    }
  }
}

function addRawCardinalityIssue(
  context: z.RefinementCtx,
  maximum: number,
  path: PropertyKey[],
  message: string,
): void {
  context.addIssue({
    code: 'too_big',
    origin: 'array',
    maximum,
    inclusive: true,
    path,
    message,
  });
}

function isRecord(value: unknown): value is Readonly<Record<PropertyKey, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const mainQuestionReferenceSchema = z.strictObject({
  kind: z.literal('main_question'),
  guideId: idSchema,
  sectionId: idSchema,
  mainQuestionId: idSchema,
});

export const followUpQuestionReferenceSchema = z.strictObject({
  kind: z.literal('follow_up_question'),
  guideId: idSchema,
  sectionId: idSchema,
  mainQuestionId: idSchema,
  followUpQuestionId: idSchema,
});

export const guideQuestionReferenceSchema = z.union([
  mainQuestionReferenceSchema,
  followUpQuestionReferenceSchema,
]);

export const questionCoverageStatusSchema = z.enum([
  'not_addressed',
  'current',
  'partially_answered',
  'answered',
  'skipped_already_answered',
]);

const notAddressedCoverageSchema = z.strictObject({
  question: guideQuestionReferenceSchema,
  status: z.literal('not_addressed'),
  transcriptTurnIds: z.array(idSchema).max(0),
});

const currentCoverageSchema = z.strictObject({
  question: guideQuestionReferenceSchema,
  status: z.literal('current'),
  // A partially answered question may become active again without losing its prior evidence.
  transcriptTurnIds: z.array(idSchema),
});

const evidencedCoverageSchema = z.strictObject({
  question: guideQuestionReferenceSchema,
  status: z.enum(['partially_answered', 'answered', 'skipped_already_answered']),
  transcriptTurnIds: z.array(idSchema).min(1),
});

export const questionCoverageSchema = z.union([
  notAddressedCoverageSchema,
  currentCoverageSchema,
  evidencedCoverageSchema,
]);

export type FollowUpQuestion = z.infer<typeof followUpQuestionSchema>;
export type MainQuestion = z.infer<typeof mainQuestionSchema>;
export type GuideSection = z.infer<typeof guideSectionSchema>;
export type GuideStructure = z.infer<typeof guideStructureSchema>;
export type InterviewGuide = z.infer<typeof interviewGuideSchema>;
export type MainQuestionReference = z.infer<typeof mainQuestionReferenceSchema>;
export type FollowUpQuestionReference = z.infer<typeof followUpQuestionReferenceSchema>;
export type GuideQuestionReference = z.infer<typeof guideQuestionReferenceSchema>;
export type QuestionCoverageStatus = z.infer<typeof questionCoverageStatusSchema>;
export type QuestionCoverage = z.infer<typeof questionCoverageSchema>;
