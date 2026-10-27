import { describe, expect, it } from 'vitest';

import { buildGuideQuestionCatalog, GuideCatalogError } from './catalog.js';
import type { ParsedInterviewGuide } from './types.js';

function guide(): ParsedInterviewGuide {
  return {
    id: 'guide-1',
    sourceLanguage: 'en',
    title: 'Interview guide',
    sections: [
      {
        id: 'section-1',
        position: 0,
        title: 'Introduction',
        mainQuestions: [
          {
            id: 'main-1',
            position: 0,
            text: 'What is your role?',
            followUpQuestions: [
              { id: 'follow-1', position: 0, text: 'Since when?' },
              { id: 'follow-2', position: 1, text: 'Which responsibilities?' },
            ],
          },
          {
            id: 'main-2',
            position: 1,
            text: 'What else matters?',
            followUpQuestions: [],
          },
        ],
      },
      {
        id: 'section-2',
        position: 1,
        title: 'Events',
        mainQuestions: [
          {
            id: 'main-3',
            position: 0,
            text: 'Describe an unexpected event.',
            followUpQuestions: [{ id: 'follow-3', position: 0, text: 'Who was involved?' }],
          },
        ],
      },
    ],
  };
}

describe('guide question catalog', () => {
  it('preserves guide order, hierarchy, text, and complete references', () => {
    const catalog = buildGuideQuestionCatalog(guide());

    expect(catalog.map((question) => question.questionId)).toEqual([
      'main-1',
      'follow-1',
      'follow-2',
      'main-2',
      'main-3',
      'follow-3',
    ]);
    expect(
      catalog.map((question) => [
        question.questionId,
        question.sectionPosition,
        question.mainQuestionPosition,
        question.followUpPosition,
        question.mainQuestionId,
      ]),
    ).toEqual([
      ['main-1', 0, 0, null, 'main-1'],
      ['follow-1', 0, 0, 0, 'main-1'],
      ['follow-2', 0, 0, 1, 'main-1'],
      ['main-2', 0, 1, null, 'main-2'],
      ['main-3', 1, 0, null, 'main-3'],
      ['follow-3', 1, 0, 0, 'main-3'],
    ]);
    expect(catalog[0]).toMatchObject({
      kind: 'main',
      sectionTitle: 'Introduction',
      mainQuestionText: 'What is your role?',
      followUpPosition: null,
      reference: {
        kind: 'main_question',
        guideId: 'guide-1',
        sectionId: 'section-1',
        mainQuestionId: 'main-1',
      },
    });
    expect(catalog[1]).toMatchObject({
      kind: 'follow_up',
      text: 'Since when?',
      mainQuestionText: 'What is your role?',
      followUpPosition: 0,
      reference: {
        kind: 'follow_up_question',
        guideId: 'guide-1',
        sectionId: 'section-1',
        mainQuestionId: 'main-1',
        followUpQuestionId: 'follow-1',
      },
    });
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog[0])).toBe(true);
    expect(Object.isFrozen(catalog[0]?.reference)).toBe(true);
  });

  it('rejects duplicate question IDs and non-contiguous positions', () => {
    const duplicate = guide();
    const firstMain = duplicate.sections[0]?.mainQuestions[0];
    if (firstMain === undefined) throw new Error('Invalid fixture');
    const invalidDuplicate: ParsedInterviewGuide = {
      ...duplicate,
      sections: [
        {
          ...duplicate.sections[0]!,
          mainQuestions: [
            firstMain,
            { ...duplicate.sections[0]!.mainQuestions[1]!, id: 'follow-1' },
          ],
        },
      ],
    };
    expect(() => buildGuideQuestionCatalog(invalidDuplicate)).toThrow(GuideCatalogError);

    const outOfOrder: ParsedInterviewGuide = {
      ...guide(),
      sections: [{ ...guide().sections[0]!, position: 1 }, guide().sections[1]!],
    };
    expect(() => buildGuideQuestionCatalog(outOfOrder)).toThrow(GuideCatalogError);
  });

  it('rejects guides without a main question', () => {
    const invalid: ParsedInterviewGuide = {
      ...guide(),
      sections: [{ ...guide().sections[0]!, mainQuestions: [] }],
    };

    expect(() => buildGuideQuestionCatalog(invalid)).toThrow(
      'A guide requires at least one main question',
    );
  });
});
