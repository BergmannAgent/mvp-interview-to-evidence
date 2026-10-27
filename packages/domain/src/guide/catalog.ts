import type { ParsedInterviewGuide } from './types.js';

export interface MainGuideQuestionReference {
  readonly kind: 'main_question';
  readonly guideId: string;
  readonly sectionId: string;
  readonly mainQuestionId: string;
}

export interface FollowUpGuideQuestionReference {
  readonly kind: 'follow_up_question';
  readonly guideId: string;
  readonly sectionId: string;
  readonly mainQuestionId: string;
  readonly followUpQuestionId: string;
}

export type GuideCatalogReference = MainGuideQuestionReference | FollowUpGuideQuestionReference;

interface GuideQuestionCatalogEntryBase {
  readonly questionId: string;
  readonly sectionId: string;
  readonly sectionTitle: string;
  readonly sectionPosition: number;
  readonly mainQuestionId: string;
  readonly mainQuestionText: string;
  readonly mainQuestionPosition: number;
  readonly text: string;
}

export interface MainGuideQuestionCatalogEntry extends GuideQuestionCatalogEntryBase {
  readonly kind: 'main';
  readonly followUpPosition: null;
  readonly reference: MainGuideQuestionReference;
}

export interface FollowUpGuideQuestionCatalogEntry extends GuideQuestionCatalogEntryBase {
  readonly kind: 'follow_up';
  readonly followUpPosition: number;
  readonly reference: FollowUpGuideQuestionReference;
}

export type GuideQuestionCatalogEntry =
  MainGuideQuestionCatalogEntry | FollowUpGuideQuestionCatalogEntry;

export class GuideCatalogError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'GuideCatalogError';
  }
}

export function buildGuideQuestionCatalog(
  guide: ParsedInterviewGuide,
): readonly GuideQuestionCatalogEntry[] {
  validateGuideHeader(guide);

  const sectionIds = new Set<string>();
  const questionIds = new Set<string>();
  const catalog: GuideQuestionCatalogEntry[] = [];

  for (const [sectionPosition, section] of guide.sections.entries()) {
    if (
      !isNonBlank(section.id) ||
      !isNonBlank(section.title) ||
      section.position !== sectionPosition ||
      sectionIds.has(section.id)
    ) {
      throw new GuideCatalogError(
        `Guide ${guide.id} contains an invalid, out-of-order, or duplicate section`,
      );
    }
    sectionIds.add(section.id);

    for (const [mainQuestionPosition, mainQuestion] of section.mainQuestions.entries()) {
      if (mainQuestion.position !== mainQuestionPosition) {
        throw new GuideCatalogError(`Guide ${guide.id} contains an out-of-order main question`);
      }
      addQuestionId(questionIds, mainQuestion.id, mainQuestion.text);

      const mainReference = Object.freeze({
        kind: 'main_question',
        guideId: guide.id,
        sectionId: section.id,
        mainQuestionId: mainQuestion.id,
      } satisfies MainGuideQuestionReference);
      catalog.push(
        Object.freeze({
          kind: 'main',
          questionId: mainQuestion.id,
          sectionId: section.id,
          sectionTitle: section.title,
          sectionPosition,
          mainQuestionId: mainQuestion.id,
          mainQuestionText: mainQuestion.text,
          mainQuestionPosition,
          followUpPosition: null,
          text: mainQuestion.text,
          reference: mainReference,
        }),
      );

      for (const [followUpPosition, followUp] of mainQuestion.followUpQuestions.entries()) {
        if (followUp.position !== followUpPosition) {
          throw new GuideCatalogError(
            `Guide ${guide.id} contains an out-of-order follow-up question`,
          );
        }
        addQuestionId(questionIds, followUp.id, followUp.text);
        catalog.push(
          Object.freeze({
            kind: 'follow_up',
            questionId: followUp.id,
            sectionId: section.id,
            sectionTitle: section.title,
            sectionPosition,
            mainQuestionId: mainQuestion.id,
            mainQuestionText: mainQuestion.text,
            mainQuestionPosition,
            followUpPosition,
            text: followUp.text,
            reference: Object.freeze({
              kind: 'follow_up_question',
              guideId: guide.id,
              sectionId: section.id,
              mainQuestionId: mainQuestion.id,
              followUpQuestionId: followUp.id,
            } satisfies FollowUpGuideQuestionReference),
          }),
        );
      }
    }
  }

  if (!catalog.some((question) => question.kind === 'main')) {
    throw new GuideCatalogError('A guide requires at least one main question');
  }
  return Object.freeze(catalog);
}

function validateGuideHeader(guide: ParsedInterviewGuide): void {
  if (!isNonBlank(guide.id) || !isNonBlank(guide.title) || guide.sections.length === 0) {
    throw new GuideCatalogError('A guide requires an ID, title, and at least one section');
  }
}

function addQuestionId(questionIds: Set<string>, questionId: string, text: string): void {
  if (!isNonBlank(questionId) || !isNonBlank(text) || questionIds.has(questionId)) {
    throw new GuideCatalogError(`Guide contains invalid or duplicate question ID ${questionId}`);
  }
  questionIds.add(questionId);
}

function isNonBlank(value: string): boolean {
  return value.trim().length > 0;
}
