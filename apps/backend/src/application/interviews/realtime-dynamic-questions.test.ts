import type { MvpRealtimeTurnIntentRequest } from '@orgscience/contracts';
import {
  applyCoverageUpdates,
  initializeGuideCoverage,
  type InterviewGuideSnapshot,
} from '@orgscience/domain';
import { describe, expect, it } from 'vitest';

import type { PersistedInterview } from '../persistence/index.js';
import {
  applyRealtimeTurnIntentCoverage,
  resolveRealtimeTurnIntent,
} from './canonical-interview-session-service.js';

const AT = '2026-09-30T12:00:00.000Z';
const guide: InterviewGuideSnapshot = {
  id: 'dynamic-guide',
  sourceLanguage: 'de',
  title: 'Interview',
  sourceMarkdown: '# Interview',
  createdAt: AT,
  sections: [
    {
      id: 'section',
      position: 0,
      title: 'Vorgehen',
      mainQuestions: [
        {
          id: 'main',
          position: 0,
          text: 'Wie handelt Ihre Organisation unter schwierigen Bedingungen?',
          followUpQuestions: [],
        },
        { id: 'next', position: 1, text: 'Wie bereiten Sie sich vor?', followUpQuestions: [] },
      ],
    },
  ],
};

function state(sourceGuide = guide): PersistedInterview {
  return {
    interviewId: 'dynamic-interview',
    guideId: sourceGuide.id,
    language: sourceGuide.sourceLanguage,
    lifecycle: {
      status: 'active',
      interviewId: 'dynamic-interview',
      guideId: sourceGuide.id,
      createdAt: AT,
      revision: 1,
      startedAt: AT,
      activeSince: AT,
    },
    coverage: applyCoverageUpdates(
      sourceGuide,
      initializeGuideCoverage(sourceGuide, 'dynamic-interview'),
      {
        interviewId: 'dynamic-interview',
        guideId: sourceGuide.id,
        expectedRevision: 0,
        updates: [{ questionId: 'main', status: 'current', referencedTurnIds: [], at: AT }],
      },
    ),
    version: 1,
    activeWorkflowRunId: null,
    createdAt: AT,
    updatedAt: AT,
  };
}

const intent: MvpRealtimeTurnIntentRequest = {
  clientEventId: 'dynamic-plan',
  action: 'ask_clarification_question',
  questionId: 'main',
  spokenText: 'Was war Ihre erste konkrete Massnahme?',
  answerDisposition: 'partial',
  missingAspect: 'erste konkrete Massnahme',
  requestedEvidenceType: 'action',
};

describe('dynamic Realtime questions', () => {
  it('accepts three distinct concrete probes and keeps the same current guide question', () => {
    const questions = [
      intent,
      {
        ...intent,
        spokenText: 'Wer trug die Verantwortung fuer diese Massnahme?',
        missingAspect: 'Verantwortung fuer diese Massnahme',
        requestedEvidenceType: 'responsibility' as const,
      },
      {
        ...intent,
        spokenText: 'Welches konkrete Ergebnis hatte diese Massnahme?',
        missingAspect: 'konkretes Ergebnis',
        requestedEvidenceType: 'outcome' as const,
      },
    ];
    const texts: string[] = [];
    const aspects: string[] = [];
    for (const question of questions) {
      const planned = resolveRealtimeTurnIntent(guide, state(), question, {
        latestParticipantText: 'Wir haben schnell reagiert.',
        priorClarificationTexts: texts,
        priorClarificationAspects: aspects,
      });
      expect(planned).toMatchObject({
        ok: true,
        value: {
          text: question.spokenText,
          targetQuestionId: 'main',
          turnType: 'clarification_question',
        },
      });
      if (!planned.ok) continue;
      const updated = applyRealtimeTurnIntentCoverage(
        guide,
        state(),
        {
          kind: 'turn',
          interviewId: 'dynamic-interview',
          turnId: 'answer',
          sequenceNumber: 3,
          speaker: 'participant',
          turnType: 'participant_answer',
          text: 'Wir haben schnell reagiert.',
          occurredAt: AT,
          sourceProvider: 'test',
          providerEventId: 'test-event',
          sourceSegmentId: 'segment',
          guideReference: {
            kind: 'main_question',
            guideId: guide.id,
            sectionId: 'section',
            mainQuestionId: 'main',
          },
        },
        planned.value,
        AT,
      );
      expect(updated).toMatchObject({
        ok: true,
        value: {
          questions: expect.arrayContaining([
            { ...state().coverage.questions[0], referencedTurnIds: ['answer'], updatedAt: AT },
          ]),
        },
      });
      texts.push(question.spokenText);
      if (question.missingAspect !== null) aspects.push(question.missingAspect);
    }
    expect(
      resolveRealtimeTurnIntent(guide, state(), intent, {
        latestParticipantText: 'Das war alles.',
        priorClarificationTexts: texts,
      }),
    ).toMatchObject({
      ok: true,
      value: { targetQuestionId: 'next', currentQuestionResolution: 'partially_answered' },
    });
  });

  it.each(['off_topic', 'question_misunderstood'] as const)(
    'repeats %s once without trusting a replacement topic',
    (answerDisposition) => {
      const repetition: MvpRealtimeTurnIntentRequest = {
        ...intent,
        action: 'repeat_question',
        spokenText: 'Welche Farbe hat Ihr Auto?',
        answerDisposition,
        missingAspect: null,
        requestedEvidenceType: null,
      };
      expect(
        resolveRealtimeTurnIntent(guide, state(), repetition, {
          latestParticipantText: 'Ich fahre ein rotes Auto.',
          priorClarificationTexts: [],
          repetitionCount: 0,
        }),
      ).toMatchObject({
        ok: true,
        value: {
          targetQuestionId: 'main',
          turnType: 'clarification_question',
          text: `Ich stelle die Frage noch einmal: ${guide.sections[0]?.mainQuestions[0]?.text}`,
        },
      });
      expect(
        resolveRealtimeTurnIntent(guide, state(), repetition, {
          latestParticipantText: 'Mein Auto ist rot.',
          priorClarificationTexts: [],
          repetitionCount: 1,
        }),
      ).toMatchObject({
        ok: true,
        value: { targetQuestionId: 'next', currentQuestionResolution: 'partially_answered' },
      });
    },
  );

  it('rejects a generic or repeated aspect once, then advances on a failed repair', () => {
    for (const candidate of [
      { ...intent, spokenText: 'Koennen Sie mehr dazu sagen?' },
      { ...intent, questionId: 'foreign-question' },
      {
        ...intent,
        spokenText: 'Welche Massnahme planen Sie fuer Ihre privaten Immobilieninvestitionen?',
        missingAspect: 'private Immobilieninvestitionen',
      },
      intent,
    ]) {
      const history = {
        latestParticipantText: 'Wir haben schnell reagiert.',
        priorClarificationTexts: [],
        priorClarificationAspects: ['erste konkrete Massnahme'],
      };
      expect(resolveRealtimeTurnIntent(guide, state(), candidate, history)).toMatchObject({
        ok: false,
        error: { constraint: expect.stringContaining('realtime_turn_intent_rejected:') },
      });
      expect(
        resolveRealtimeTurnIntent(guide, state(), { ...candidate, repairAttempt: 1 }, history),
      ).toMatchObject({
        ok: true,
        value: { targetQuestionId: 'next', currentQuestionResolution: 'partially_answered' },
      });
    }
  });

  it('accepts an English probe and repeats the exact English guide question once', () => {
    const englishGuide: InterviewGuideSnapshot = {
      ...guide,
      sourceLanguage: 'en',
      sections: [
        {
          id: 'section',
          position: 0,
          title: 'Response',
          mainQuestions: [
            {
              id: 'main',
              position: 0,
              text: 'How does your organization act under difficult conditions?',
              followUpQuestions: [],
            },
            { id: 'next', position: 1, text: 'How do you prepare?', followUpQuestions: [] },
          ],
        },
      ],
    };
    const probe: MvpRealtimeTurnIntentRequest = {
      ...intent,
      spokenText: 'What was your first concrete action?',
      missingAspect: 'first concrete action',
      requestedEvidenceType: 'action',
    };
    expect(
      resolveRealtimeTurnIntent(englishGuide, state(englishGuide), probe, {
        latestParticipantText: 'We reacted quickly.',
        priorClarificationTexts: [],
      }),
    ).toMatchObject({ ok: true, value: { targetQuestionId: 'main', text: probe.spokenText } });
    expect(
      resolveRealtimeTurnIntent(englishGuide, state(englishGuide), {
        ...probe,
        action: 'repeat_question',
        missingAspect: null,
        requestedEvidenceType: null,
        answerDisposition: 'question_misunderstood',
      }),
    ).toMatchObject({
      ok: true,
      value: {
        targetQuestionId: 'main',
        text: 'Let me ask that again: How does your organization act under difficult conditions?',
      },
    });
  });

  it.each(['de', 'en'] as const)('accepts a negative yes/no answer in %s', (language) => {
    const sourceGuide = {
      ...guide,
      sourceLanguage: language,
      sections: [
        {
          ...guide.sections[0]!,
          mainQuestions: [
            {
              ...guide.sections[0]!.mainQuestions[0]!,
              text:
                language === 'de'
                  ? 'Gibt es formale Notfallplaene?'
                  : 'Do you have formal emergency plans?',
              followUpQuestions: [
                {
                  id: 'follow',
                  position: 0,
                  text:
                    language === 'de'
                      ? 'Wie gehen Sie stattdessen vor?'
                      : 'What do you do instead?',
                },
              ],
            },
            guide.sections[0]!.mainQuestions[1]!,
          ],
        },
      ],
    };
    expect(
      resolveRealtimeTurnIntent(
        sourceGuide,
        state(sourceGuide),
        {
          ...intent,
          action: 'ask_follow_up_question',
          questionId: 'follow',
          missingAspect: null,
          requestedEvidenceType: null,
        },
        {
          latestParticipantText: language === 'de' ? 'Nein.' : 'No.',
          priorClarificationTexts: [],
        },
      ),
    ).toMatchObject({
      ok: true,
      value: { targetQuestionId: 'follow', currentQuestionResolution: 'answered' },
    });
  });
});
