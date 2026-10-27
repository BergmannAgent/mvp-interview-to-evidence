import { describe, expect, it } from 'vitest';

import { parseInterviewGuideMarkdown } from '../guide/parser.js';
import type { ParsedInterviewGuide } from '../guide/types.js';
import {
  CoverageDomainError,
  applyCoverageUpdates,
  initializeGuideCoverage,
  selectNextOpenFollowUpQuestion,
  selectNextOpenMainQuestion,
  selectNextOpenQuestion,
} from './coverage.js';

const AT = '2026-08-06T10:00:00.000Z';
const INTERVIEW_ID = 'interview-1';

function guide(id = 'guide-1'): ParsedInterviewGuide {
  return {
    id,
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
    ],
  };
}

function expectCoverageError(callback: () => unknown, code: CoverageDomainError['code']): void {
  try {
    callback();
    throw new Error('Expected CoverageDomainError');
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(CoverageDomainError);
    expect((error as CoverageDomainError).code).toBe(code);
  }
}

describe('guide coverage', () => {
  it('initializes the parser output directly in deterministic guide order', () => {
    const parsed = parseInterviewGuideMarkdown(`# Leitfaden
## Einführung
### Hauptfrage
Welche Rolle haben Sie?
#### Vertiefungsfragen
- Seit wann?
- Welche Verantwortung?`);
    if (!parsed.success) {
      throw new Error('Expected fixture to parse');
    }

    const state = initializeGuideCoverage(parsed.guide, INTERVIEW_ID);

    expect(state.interviewId).toBe(INTERVIEW_ID);
    expect(state.guideId).toBe(parsed.guide.id);
    expect(state.questions.map((question) => question.questionId)).toEqual([
      parsed.guide.sections[0]?.mainQuestions[0]?.id,
      parsed.guide.sections[0]?.mainQuestions[0]?.followUpQuestions[0]?.id,
      parsed.guide.sections[0]?.mainQuestions[0]?.followUpQuestions[1]?.id,
    ]);
    expect(state.questions.every((question) => question.status === 'not_addressed')).toBe(true);
  });

  it('applies evidence-backed updates immutably and selects the next open question', () => {
    const original = initializeGuideCoverage(guide(), INTERVIEW_ID);
    const current = applyCoverageUpdates(guide(), original, {
      interviewId: INTERVIEW_ID,
      guideId: 'guide-1',
      expectedRevision: 0,
      updates: [
        { questionId: 'main-1', status: 'answered', referencedTurnIds: ['turn-2'], at: AT },
        {
          questionId: 'follow-1',
          status: 'skipped_already_answered',
          referencedTurnIds: ['turn-2'],
          at: AT,
        },
      ],
    });

    expect(original.questions[0]?.status).toBe('not_addressed');
    expect(current.revision).toBe(1);
    expect(selectNextOpenQuestion(guide(), current)?.questionId).toBe('follow-2');
    expect(selectNextOpenMainQuestion(guide(), current)?.questionId).toBe('main-2');
    expect(selectNextOpenFollowUpQuestion(guide(), current, 'main-1')?.questionId).toBe('follow-2');
  });

  it('prioritizes current, then partial, then untouched questions', () => {
    const initial = initializeGuideCoverage(guide(), INTERVIEW_ID);
    const partial = applyCoverageUpdates(guide(), initial, {
      interviewId: INTERVIEW_ID,
      guideId: 'guide-1',
      expectedRevision: 0,
      updates: [
        {
          questionId: 'main-2',
          status: 'partially_answered',
          referencedTurnIds: ['turn-1'],
          at: AT,
        },
      ],
    });
    expect(selectNextOpenMainQuestion(guide(), partial)?.questionId).toBe('main-2');

    const current = applyCoverageUpdates(guide(), partial, {
      interviewId: INTERVIEW_ID,
      guideId: 'guide-1',
      expectedRevision: 1,
      updates: [{ questionId: 'main-1', status: 'current', referencedTurnIds: [], at: AT }],
    });
    expect(selectNextOpenMainQuestion(guide(), current)?.questionId).toBe('main-1');
  });

  it('reactivates partially answered coverage without losing transcript evidence', () => {
    const partial = applyCoverageUpdates(guide(), initializeGuideCoverage(guide(), INTERVIEW_ID), {
      interviewId: INTERVIEW_ID,
      guideId: 'guide-1',
      expectedRevision: 0,
      updates: [
        {
          questionId: 'follow-1',
          status: 'partially_answered',
          referencedTurnIds: ['turn-1'],
          at: AT,
        },
      ],
    });

    const current = applyCoverageUpdates(guide(), partial, {
      interviewId: INTERVIEW_ID,
      guideId: 'guide-1',
      expectedRevision: 1,
      updates: [
        {
          questionId: 'follow-1',
          status: 'current',
          referencedTurnIds: [],
          at: AT,
        },
      ],
    });

    expect(current.questions.find((question) => question.questionId === 'follow-1')).toEqual(
      expect.objectContaining({
        status: 'current',
        referencedTurnIds: ['turn-1'],
      }),
    );
  });

  it('rejects cross-interview, cross-guide, unknown-question, and stale writes', () => {
    const state = initializeGuideCoverage(guide(), INTERVIEW_ID);
    expectCoverageError(
      () =>
        applyCoverageUpdates(guide(), state, {
          interviewId: 'interview-2',
          guideId: 'guide-1',
          expectedRevision: 0,
          updates: [],
        }),
      'interview_mismatch',
    );
    expectCoverageError(
      () =>
        applyCoverageUpdates(guide('guide-2'), state, {
          interviewId: INTERVIEW_ID,
          guideId: 'guide-2',
          expectedRevision: 0,
          updates: [],
        }),
      'guide_mismatch',
    );
    expectCoverageError(
      () =>
        applyCoverageUpdates(guide(), state, {
          interviewId: INTERVIEW_ID,
          guideId: 'guide-1',
          expectedRevision: 0,
          updates: [
            { questionId: 'foreign-question', status: 'current', referencedTurnIds: [], at: AT },
          ],
        }),
      'unknown_question',
    );
    expectCoverageError(
      () =>
        applyCoverageUpdates(guide(), state, {
          interviewId: INTERVIEW_ID,
          guideId: 'guide-1',
          expectedRevision: 3,
          updates: [],
        }),
      'stale_revision',
    );
  });

  it('requires transcript evidence and prevents multiple current questions', () => {
    const state = initializeGuideCoverage(guide(), INTERVIEW_ID);
    expectCoverageError(
      () =>
        applyCoverageUpdates(guide(), state, {
          interviewId: INTERVIEW_ID,
          guideId: 'guide-1',
          expectedRevision: 0,
          updates: [{ questionId: 'main-1', status: 'answered', referencedTurnIds: [], at: AT }],
        }),
      'invalid_evidence',
    );
    expectCoverageError(
      () =>
        applyCoverageUpdates(guide(), state, {
          interviewId: INTERVIEW_ID,
          guideId: 'guide-1',
          expectedRevision: 0,
          updates: [
            { questionId: 'main-1', status: 'current', referencedTurnIds: [], at: AT },
            { questionId: 'main-2', status: 'current', referencedTurnIds: [], at: AT },
          ],
        }),
      'multiple_current_questions',
    );
  });

  it('keeps answered coverage terminal and validates shared structural positions', () => {
    const state = applyCoverageUpdates(guide(), initializeGuideCoverage(guide(), INTERVIEW_ID), {
      interviewId: INTERVIEW_ID,
      guideId: 'guide-1',
      expectedRevision: 0,
      updates: [
        { questionId: 'main-1', status: 'answered', referencedTurnIds: ['turn-1'], at: AT },
      ],
    });
    expectCoverageError(
      () =>
        applyCoverageUpdates(guide(), state, {
          interviewId: INTERVIEW_ID,
          guideId: 'guide-1',
          expectedRevision: 1,
          updates: [{ questionId: 'main-1', status: 'current', referencedTurnIds: [], at: AT }],
        }),
      'invalid_status_transition',
    );

    const outOfOrder: ParsedInterviewGuide = {
      ...guide(),
      sections: [{ ...guide().sections[0]!, position: 1 }],
    };
    expectCoverageError(() => initializeGuideCoverage(outOfOrder, INTERVIEW_ID), 'invalid_guide');
  });
});
