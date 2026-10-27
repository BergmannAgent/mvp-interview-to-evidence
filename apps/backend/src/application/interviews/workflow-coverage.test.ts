import { describe, expect, it } from 'vitest';

import {
  applyCoverageUpdates,
  buildGuideQuestionCatalog,
  initializeGuideCoverage,
  type TranscriptAggregate,
} from '@orgscience/domain';

import { coverageAnalysisPromptInputSchema } from '../agents/index.js';
import type { PersistedInterview } from '../persistence/index.js';
import type { InterviewTurnWorkflowOutput } from '../workflows/index.js';
import {
  applyRealtimeTurnIntentCoverage,
  applyWorkflowCoverage,
  confirmedInterruptedUtterance,
  confirmedUtterancesMatch,
  interviewClosingText,
  interviewGreetingText,
  resolveRealtimeTurnIntent,
  restoreParticipantQuestionForWorkflow,
  shouldReissueTechnicalGap,
  workflowCandidateQuestionIds,
} from './canonical-interview-session-service.js';
import { projectInterviewView } from './interview-view.js';

const AT = '2026-08-14T12:00:00.000Z';
const INTERVIEW_ID = 'interview-workflow-coverage';
const GUIDE_ID = 'guide-workflow-coverage';
const MAIN_ID = 'main-role';
const PARTIAL_FOLLOW_UP_ID = 'follow-up-decisions';
const CURRENT_FOLLOW_UP_ID = 'follow-up-tenure';
const NEXT_MAIN_ID = 'main-risk';

const guide = {
  id: GUIDE_ID,
  sourceLanguage: 'de',
  title: 'Interviewleitfaden: Workflow Coverage',
  sourceMarkdown: '# Interviewleitfaden: Workflow Coverage',
  createdAt: AT,
  sections: [
    {
      id: 'section-context',
      position: 0,
      title: 'Kontext',
      mainQuestions: [
        {
          id: MAIN_ID,
          position: 0,
          text: 'Welche Rolle haben Sie?',
          followUpQuestions: [
            {
              id: PARTIAL_FOLLOW_UP_ID,
              position: 0,
              text: 'Welche Entscheidungen treffen Sie?',
            },
            {
              id: CURRENT_FOLLOW_UP_ID,
              position: 1,
              text: 'Wie lange sind Sie in dieser Rolle?',
            },
          ],
        },
        {
          id: NEXT_MAIN_ID,
          position: 1,
          text: 'Wie identifizieren Sie Risiken?',
          followUpQuestions: [],
        },
      ],
    },
  ],
} as const;
const englishGuide = {
  ...guide,
  sourceLanguage: 'en',
  title: 'Interview guide: Workflow Coverage',
  sections: [
    {
      id: 'section-context',
      position: 0,
      title: 'Context',
      mainQuestions: [
        {
          id: MAIN_ID,
          position: 0,
          text: 'What is your role in the organization?',
          followUpQuestions: [
            {
              id: PARTIAL_FOLLOW_UP_ID,
              position: 0,
              text: 'Which decisions are you responsible for?',
            },
            {
              id: CURRENT_FOLLOW_UP_ID,
              position: 1,
              text: 'How long have you been in this role?',
            },
          ],
        },
        {
          id: NEXT_MAIN_ID,
          position: 1,
          text: 'How do you identify risks?',
          followUpQuestions: [],
        },
      ],
    },
  ],
} as const;
const guideContract = { id: guide.id, title: guide.title, sections: guide.sections };

const mainReference = {
  kind: 'main_question',
  guideId: GUIDE_ID,
  sectionId: 'section-context',
  mainQuestionId: MAIN_ID,
} as const;
const partialFollowUpReference = {
  kind: 'follow_up_question',
  guideId: GUIDE_ID,
  sectionId: 'section-context',
  mainQuestionId: MAIN_ID,
  followUpQuestionId: PARTIAL_FOLLOW_UP_ID,
} as const;
const currentFollowUpReference = {
  kind: 'follow_up_question',
  guideId: GUIDE_ID,
  sectionId: 'section-context',
  mainQuestionId: MAIN_ID,
  followUpQuestionId: CURRENT_FOLLOW_UP_ID,
} as const;

describe('workflow coverage application', () => {
  it('reissues an unconfirmed audio turn once, but not after the same consecutive gap', () => {
    const transcript: TranscriptAggregate = {
      interviewId: INTERVIEW_ID,
      guideId: GUIDE_ID,
      guideQuestionIndex: [mainReference],
      nextSequenceNumber: 1,
      entries: [],
      partials: [],
      finals: [],
    };

    expect(shouldReissueTechnicalGap(transcript, 'unconfirmed_interruption')).toBe(true);
    expect(
      shouldReissueTechnicalGap(
        {
          ...transcript,
          nextSequenceNumber: 2,
          entries: [
            {
              kind: 'technical_gap',
              interviewId: INTERVIEW_ID,
              sequenceNumber: 1,
              gapId: 'gap-unconfirmed-audio',
              sourceEventId: 'provider-response-failed',
              source: 'audio_output',
              sourceProvider: null,
              relatedUtteranceId: null,
              relatedSegmentId: null,
              description:
                'Die AI-Audioausgabe wurde unterbrochen, bevor ein gesprochener Teil bestaetigt werden konnte.',
              occurredAt: AT,
            },
          ],
        },
        'unconfirmed_interruption',
      ),
    ).toBe(false);
  });

  it('maps a Realtime tool intent to a trusted guide reference and advances coverage', () => {
    const coverage = applyCoverageUpdates(guide, initializeGuideCoverage(guide, INTERVIEW_ID), {
      interviewId: INTERVIEW_ID,
      guideId: GUIDE_ID,
      expectedRevision: 0,
      updates: [
        {
          questionId: MAIN_ID,
          status: 'answered',
          referencedTurnIds: ['answer-main'],
          at: AT,
        },
        {
          questionId: PARTIAL_FOLLOW_UP_ID,
          status: 'current',
          referencedTurnIds: [],
          at: AT,
        },
      ],
    });
    const state = activeState(coverage);
    const answer = participant('answer-current-tool-question', 4, partialFollowUpReference);
    const planned = resolveRealtimeTurnIntent(guide, state, {
      clientEventId: 'intent-tool-follow-up',
      action: 'ask_follow_up_question',
      questionId: CURRENT_FOLLOW_UP_ID,
      spokenText: 'Wie lange arbeiten Sie bereits in dieser Rolle?',
      answerDisposition: 'answered',
      missingAspect: null,
      requestedEvidenceType: null,
    });

    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.value).toEqual({
      turnType: 'follow_up_question',
      guideReference: currentFollowUpReference,
      targetQuestionId: CURRENT_FOLLOW_UP_ID,
      text: 'Wie lange sind Sie in dieser Rolle?',
      currentQuestionResolution: 'answered',
    });

    const advanced = applyRealtimeTurnIntentCoverage(guide, state, answer, planned.value, AT);
    expect(advanced.ok).toBe(true);
    if (!advanced.ok) return;
    expect(
      advanced.value.questions.find((question) => question.questionId === PARTIAL_FOLLOW_UP_ID),
    ).toMatchObject({ status: 'answered', referencedTurnIds: [answer.turnId] });
    expect(
      advanced.value.questions.find((question) => question.questionId === CURRENT_FOLLOW_UP_ID),
    ).toMatchObject({ status: 'current' });
  });

  it('normalizes untrusted tool output to canonical guide questions and a safe closing', () => {
    const coverage = applyCoverageUpdates(guide, initializeGuideCoverage(guide, INTERVIEW_ID), {
      interviewId: INTERVIEW_ID,
      guideId: GUIDE_ID,
      expectedRevision: 0,
      updates: [
        {
          questionId: MAIN_ID,
          status: 'current',
          referencedTurnIds: [],
          at: AT,
        },
      ],
    });
    const state = activeState(coverage);

    const normalizedMain = resolveRealtimeTurnIntent(guide, state, {
      clientEventId: 'intent-wrong-kind',
      action: 'ask_main_question',
      questionId: PARTIAL_FOLLOW_UP_ID,
      spokenText: 'Wie identifizieren Sie Risiken?',
      answerDisposition: 'answered',
      missingAspect: null,
      requestedEvidenceType: null,
    });
    expect(normalizedMain).toMatchObject({
      ok: true,
      value: {
        turnType: 'main_question',
        targetQuestionId: NEXT_MAIN_ID,
        text: 'Wie identifizieren Sie Risiken?',
      },
    });
    const normalizedFollowUp = resolveRealtimeTurnIntent(guide, state, {
      clientEventId: 'intent-unknown-follow-up',
      action: 'ask_follow_up_question',
      questionId: 'hallucinated-question-id',
      spokenText: 'Wie lange arbeiten Sie bereits in dieser Rolle?',
      answerDisposition: 'answered',
      missingAspect: null,
      requestedEvidenceType: null,
    });
    expect(normalizedFollowUp).toMatchObject({
      ok: true,
      value: {
        turnType: 'follow_up_question',
        targetQuestionId: CURRENT_FOLLOW_UP_ID,
        text: 'Wie lange sind Sie in dieser Rolle?',
      },
    });
    expect(
      resolveRealtimeTurnIntent(guide, state, {
        clientEventId: 'intent-two-questions',
        action: 'ask_main_question',
        questionId: MAIN_ID,
        spokenText: 'Welche Rolle haben Sie? Und seit wann?',
        answerDisposition: 'answered',
        missingAspect: null,
        requestedEvidenceType: null,
      }),
    ).toMatchObject({
      ok: true,
      value: {
        turnType: 'main_question',
        targetQuestionId: NEXT_MAIN_ID,
        text: 'Wie identifizieren Sie Risiken?',
      },
    });
    expect(
      resolveRealtimeTurnIntent(guide, state, {
        clientEventId: 'intent-early-closing',
        action: 'complete_interview',
        questionId: null,
        spokenText: 'Vielen Dank fuer das Gespraech.',
        answerDisposition: 'answered',
        missingAspect: null,
        requestedEvidenceType: null,
      }),
    ).toMatchObject({
      ok: true,
      value: {
        turnType: 'main_question',
        targetQuestionId: NEXT_MAIN_ID,
        text: 'Wie identifizieren Sie Risiken?',
      },
    });

    const completedCoverage = applyCoverageUpdates(guide, coverage, {
      interviewId: INTERVIEW_ID,
      guideId: GUIDE_ID,
      expectedRevision: coverage.revision,
      updates: [
        {
          questionId: NEXT_MAIN_ID,
          status: 'answered',
          referencedTurnIds: ['answer-next-main'],
          at: AT,
        },
      ],
    });
    const closing = resolveRealtimeTurnIntent(guide, activeState(completedCoverage), {
      clientEventId: 'intent-closing',
      action: 'complete_interview',
      questionId: null,
      spokenText: 'Vielen Dank fuer das Gespraech.',
      answerDisposition: 'answered',
      missingAspect: null,
      requestedEvidenceType: null,
    });
    expect(closing).toMatchObject({
      ok: true,
      value: {
        turnType: 'closing',
        guideReference: null,
        targetQuestionId: null,
        text: 'Vielen Dank fuer das Gespraech und Ihre Zeit.',
        currentQuestionResolution: 'answered',
      },
    });
  });

  it('preserves a specific clarification and advances after three clarifications', () => {
    const coverage = applyCoverageUpdates(guide, initializeGuideCoverage(guide, INTERVIEW_ID), {
      interviewId: INTERVIEW_ID,
      guideId: GUIDE_ID,
      expectedRevision: 0,
      updates: [{ questionId: MAIN_ID, status: 'current', referencedTurnIds: [], at: AT }],
    });
    const state = activeState(coverage);
    const intent = {
      clientEventId: 'intent-specific-clarification',
      action: 'ask_clarification_question',
      questionId: MAIN_ID,
      spokenText: 'Welche konkreten Aufgaben uebernehmen Sie in dieser Rolle selbst?',
      answerDisposition: 'partial',
      missingAspect: 'Aufgaben in dieser Rolle',
      requestedEvidenceType: 'responsibility',
    } as const;

    const first = resolveRealtimeTurnIntent(guide, state, intent, {
      latestParticipantText: 'Ich bin fuer den digitalen Vertrieb verantwortlich.',
      priorClarificationTexts: [],
    });
    expect(first).toMatchObject({
      ok: true,
      value: {
        turnType: 'clarification_question',
        targetQuestionId: MAIN_ID,
        text: intent.spokenText,
        currentQuestionResolution: 'partially_answered',
      },
    });

    const repeated = resolveRealtimeTurnIntent(guide, state, intent, {
      latestParticipantText: 'Ich bin fuer den digitalen Vertrieb verantwortlich.',
      priorClarificationTexts: [
        intent.spokenText,
        'Wer uebernimmt die Verantwortung?',
        'Wie treffen Sie Entscheidungen?',
      ],
    });
    expect(repeated).toMatchObject({
      ok: true,
      value: {
        turnType: 'follow_up_question',
        targetQuestionId: PARTIAL_FOLLOW_UP_ID,
        text: 'Welche Entscheidungen treffen Sie?',
        currentQuestionResolution: 'partially_answered',
      },
    });
    if (!repeated.ok) return;
    const applied = applyRealtimeTurnIntentCoverage(
      guide,
      state,
      participant('answer-after-clarification-budget', 4, mainReference),
      repeated.value,
      AT,
    );
    expect(applied).toMatchObject({ ok: true });
    if (!applied.ok) return;
    expect(
      applied.value.questions.find((question) => question.questionId === MAIN_ID),
    ).toMatchObject({ status: 'partially_answered' });
    expect(
      applied.value.questions.find((question) => question.questionId === PARTIAL_FOLLOW_UP_ID),
    ).toMatchObject({ status: 'current' });
  });

  it('advances after an unsuccessful repair of a generic or mismatched clarification', () => {
    const coverage = applyCoverageUpdates(guide, initializeGuideCoverage(guide, INTERVIEW_ID), {
      interviewId: INTERVIEW_ID,
      guideId: GUIDE_ID,
      expectedRevision: 0,
      updates: [{ questionId: MAIN_ID, status: 'current', referencedTurnIds: [], at: AT }],
    });
    const state = activeState(coverage);
    const baseIntent = {
      clientEventId: 'intent-rejected-clarification',
      action: 'ask_clarification_question',
      questionId: MAIN_ID,
      answerDisposition: 'partial',
      missingAspect: 'Aufgaben in dieser Rolle',
      requestedEvidenceType: 'responsibility',
      repairAttempt: 1,
    } as const;

    for (const spokenText of [
      'Koennen Sie Ihre letzte Antwort bitte noch etwas genauer erlaeutern?',
      'Wann hat die Organisation zuletzt ihren Standort gewechselt?',
      'Koennen Sie dazu ein konkretes Beispiel nennen?',
    ]) {
      expect(
        resolveRealtimeTurnIntent(
          guide,
          state,
          { ...baseIntent, spokenText },
          {
            latestParticipantText: 'Ich bin fuer den digitalen Vertrieb verantwortlich.',
            priorClarificationTexts: [],
          },
        ),
      ).toMatchObject({
        ok: true,
        value: {
          turnType: 'follow_up_question',
          targetQuestionId: PARTIAL_FOLLOW_UP_ID,
          text: 'Welche Entscheidungen treffen Sie?',
          currentQuestionResolution: 'partially_answered',
        },
      });
    }

    for (const questionId of [NEXT_MAIN_ID, 'hallucinated-question-id']) {
      expect(
        resolveRealtimeTurnIntent(
          guide,
          state,
          {
            ...baseIntent,
            questionId,
            spokenText: 'Welche konkreten Aufgaben uebernehmen Sie in dieser Rolle selbst?',
          },
          {
            latestParticipantText: 'Ich bin fuer den digitalen Vertrieb verantwortlich.',
            priorClarificationTexts: [],
          },
        ),
      ).toMatchObject({
        ok: true,
        value: { targetQuestionId: PARTIAL_FOLLOW_UP_ID },
      });
    }

    expect(
      resolveRealtimeTurnIntent(
        guide,
        state,
        {
          ...baseIntent,
          spokenText: 'Welche Rolle spielt Ihr Privatvermoegen bei Immobilienkaeufen?',
          missingAspect: 'Rolle des Privatvermoegens bei Immobilienkaeufen',
        },
        {
          latestParticipantText: 'Ich bin fuer den digitalen Vertrieb verantwortlich.',
          priorClarificationTexts: [],
        },
      ),
    ).toMatchObject({
      ok: true,
      value: { targetQuestionId: PARTIAL_FOLLOW_UP_ID },
    });

    expect(
      resolveRealtimeTurnIntent(
        guide,
        state,
        {
          ...baseIntent,
          spokenText: 'Wie finanzieren Sie Ihre privaten Immobilienkaeufe?',
          missingAspect: 'Finanzierung privater Immobilienkaeufe',
        },
        {
          latestParticipantText: 'Ich bin Teamleiter; privat kaufe ich Immobilien.',
          priorClarificationTexts: [],
        },
      ),
    ).toMatchObject({
      ok: true,
      value: { targetQuestionId: PARTIAL_FOLLOW_UP_ID },
    });

    expect(
      resolveRealtimeTurnIntent(
        guide,
        state,
        {
          ...baseIntent,
          spokenText: 'Welche privaten Immobilienkaeufe waren in dieser Rolle besonders teuer?',
          missingAspect: 'private Immobilienkaeufe in dieser Rolle',
        },
        {
          latestParticipantText: 'Ich bin fuer den digitalen Vertrieb verantwortlich.',
          priorClarificationTexts: [],
        },
      ),
    ).toMatchObject({
      ok: true,
      value: { targetQuestionId: PARTIAL_FOLLOW_UP_ID },
    });

    expect(
      resolveRealtimeTurnIntent(
        guide,
        state,
        {
          ...baseIntent,
          spokenText: 'Welche Person entschied das letztlich?',
          missingAspect: 'entscheidende Person',
          requestedEvidenceType: 'contradiction',
        },
        {
          latestParticipantText: 'Ich habe die Entscheidung vorbereitet.',
          priorClarificationTexts: [
            'Wer war fuer die Entscheidung verantwortlich?',
            'Welche Aufgabe haben Sie?',
            'Wie treffen Sie Entscheidungen?',
          ],
        },
      ),
    ).toMatchObject({
      ok: true,
      value: { targetQuestionId: PARTIAL_FOLLOW_UP_ID },
    });
  });

  it('accepts a complete provider-confirmed utterance only byte-for-byte', () => {
    const exact = '  Grüße, 東京! Ça va?  ';
    expect(confirmedUtterancesMatch(exact, exact)).toBe(true);

    for (const changed of [
      '  Grüße, 東京! Ça va!  ',
      '  grüße, 東京! Ça va?  ',
      ' Grüße, 東京! Ça va?  ',
      '  Gru\u0308ße, 東京! Ça va?  ',
      '  Grüße, 东京! Ça va?  ',
    ]) {
      expect(confirmedUtterancesMatch(exact, changed)).toBe(false);
    }
  });

  it('returns an interrupted provider-confirmed prefix without trimming or normalization', () => {
    const generated = '  Grüße, 東京! Ça va? Weiter.  ';
    const confirmedPrefix = '  Grüße, 東京! Ça va? ';

    expect(confirmedInterruptedUtterance(generated, generated, confirmedPrefix)).toBe(
      confirmedPrefix,
    );
    for (const changedGenerated of [
      '  Grüße, 東京! Ça va! Weiter.  ',
      '  grüße, 東京! Ça va? Weiter.  ',
      ' Grüße, 東京! Ça va? Weiter.  ',
      '  Gru\u0308ße, 東京! Ça va? Weiter.  ',
      '  Grüße, 东京! Ça va? Weiter.  ',
    ]) {
      expect(
        confirmedInterruptedUtterance(generated, changedGenerated, confirmedPrefix),
      ).toBeNull();
    }
    expect(confirmedInterruptedUtterance(generated, generated, '')).toBeNull();
    expect(confirmedInterruptedUtterance(generated, generated, `${confirmedPrefix}X`)).toBeNull();
  });

  it('skips the remaining topic after a refusal or missing information on its main question', () => {
    const coverage = applyCoverageUpdates(guide, initializeGuideCoverage(guide, INTERVIEW_ID), {
      interviewId: INTERVIEW_ID,
      guideId: GUIDE_ID,
      expectedRevision: 0,
      updates: [{ questionId: MAIN_ID, status: 'current', referencedTurnIds: [], at: AT }],
    });
    const state = activeState(coverage);
    const baseIntent = {
      clientEventId: 'intent-skip-main-topic',
      action: 'ask_clarification_question',
      questionId: MAIN_ID,
      spokenText: 'Welche konkrete Verantwortung haben Sie in dieser Rolle?',
      answerDisposition: 'partial',
      missingAspect: 'Verantwortung in dieser Rolle',
      requestedEvidenceType: 'responsibility',
    } as const;

    for (const latestParticipantText of [
      'Nein.',
      'Nein, das gab es bei uns nicht.',
      'Das weiss ich nicht.',
      'Das moechte ich nicht beantworten.',
      'Ich moechte das nicht beantworten.',
      'Das habe ich bereits beantwortet.',
      'Ich habe dir das schon genauer gesagt.',
    ]) {
      expect(
        resolveRealtimeTurnIntent(guide, state, baseIntent, {
          latestParticipantText,
          priorClarificationTexts: [],
        }),
      ).toMatchObject({
        ok: true,
        value: {
          turnType: 'main_question',
          targetQuestionId: NEXT_MAIN_ID,
          text: 'Wie identifizieren Sie Risiken?',
        },
      });
    }
  });

  it('advances after short complete facts, refusals, and already-answered feedback', () => {
    const coverage = applyCoverageUpdates(guide, initializeGuideCoverage(guide, INTERVIEW_ID), {
      interviewId: INTERVIEW_ID,
      guideId: GUIDE_ID,
      expectedRevision: 0,
      updates: [
        {
          questionId: MAIN_ID,
          status: 'answered',
          referencedTurnIds: ['answer-main'],
          at: AT,
        },
        {
          questionId: PARTIAL_FOLLOW_UP_ID,
          status: 'answered',
          referencedTurnIds: ['answer-decisions'],
          at: AT,
        },
        {
          questionId: CURRENT_FOLLOW_UP_ID,
          status: 'current',
          referencedTurnIds: [],
          at: AT,
        },
      ],
    });
    const state = activeState(coverage);
    const clarification = {
      clientEventId: 'intent-unnecessary-clarification',
      action: 'ask_clarification_question',
      questionId: CURRENT_FOLLOW_UP_ID,
      spokenText: 'In welchem konkreten Jahr haben Sie diese Rolle begonnen?',
      answerDisposition: 'partial',
      missingAspect: 'Jahr des Rollenbeginns',
      requestedEvidenceType: 'timeframe',
    } as const;

    expect(
      resolveRealtimeTurnIntent(guide, state, clarification, {
        latestParticipantText: 'Seit drei Jahren.',
        priorClarificationTexts: [],
      }),
    ).toMatchObject({
      ok: true,
      value: { targetQuestionId: NEXT_MAIN_ID, currentQuestionResolution: 'answered' },
    });

    const roleCoverage = applyCoverageUpdates(guide, initializeGuideCoverage(guide, INTERVIEW_ID), {
      interviewId: INTERVIEW_ID,
      guideId: GUIDE_ID,
      expectedRevision: 0,
      updates: [{ questionId: MAIN_ID, status: 'current', referencedTurnIds: [], at: AT }],
    });
    expect(
      resolveRealtimeTurnIntent(
        guide,
        activeState(roleCoverage),
        {
          ...clarification,
          questionId: MAIN_ID,
          spokenText: 'Welche konkreten Aufgaben uebernehmen Sie in dieser Rolle?',
          missingAspect: 'Aufgaben in dieser Rolle',
        },
        {
          latestParticipantText: 'Ich bin Leiter des digitalen Vertriebs.',
          priorClarificationTexts: [],
        },
      ),
    ).toMatchObject({
      ok: true,
      value: {
        targetQuestionId: PARTIAL_FOLLOW_UP_ID,
        currentQuestionResolution: 'answered',
      },
    });

    for (const [latestParticipantText, resolution] of [
      ['Nein.', 'partially_answered'],
      ['Das weiss ich nicht.', 'partially_answered'],
      ['Das moechte ich nicht beantworten.', 'partially_answered'],
      ['Das habe ich bereits beantwortet.', 'skipped_already_answered'],
    ] as const) {
      expect(
        resolveRealtimeTurnIntent(guide, state, clarification, {
          latestParticipantText,
          priorClarificationTexts: [],
        }),
      ).toMatchObject({
        ok: true,
        value: {
          turnType: 'main_question',
          targetQuestionId: NEXT_MAIN_ID,
          currentQuestionResolution: resolution,
        },
      });
    }
  });

  it('applies equivalent English answer and clarification guardrails', () => {
    const coverage = applyCoverageUpdates(
      englishGuide,
      initializeGuideCoverage(englishGuide, INTERVIEW_ID),
      {
        interviewId: INTERVIEW_ID,
        guideId: GUIDE_ID,
        expectedRevision: 0,
        updates: [{ questionId: MAIN_ID, status: 'current', referencedTurnIds: [], at: AT }],
      },
    );
    const state = activeState(coverage, 'en');
    const baseIntent = {
      clientEventId: 'intent-english-clarification',
      action: 'ask_clarification_question',
      questionId: MAIN_ID,
      answerDisposition: 'partial',
      missingAspect: 'responsibilities in digital sales',
      requestedEvidenceType: 'responsibility',
    } as const;

    expect(
      resolveRealtimeTurnIntent(
        englishGuide,
        state,
        {
          ...baseIntent,
          spokenText: 'Which responsibilities do you personally handle in digital sales?',
        },
        {
          latestParticipantText: 'I work in digital sales.',
          priorClarificationTexts: [],
        },
      ),
    ).toMatchObject({
      ok: true,
      value: {
        turnType: 'clarification_question',
        targetQuestionId: MAIN_ID,
        currentQuestionResolution: 'partially_answered',
      },
    });

    for (const genericQuestion of ['Could you elaborate?', 'Could you say more?']) {
      expect(
        resolveRealtimeTurnIntent(
          englishGuide,
          state,
          { ...baseIntent, spokenText: genericQuestion, repairAttempt: 1 },
          {
            latestParticipantText: 'I work in digital sales.',
            priorClarificationTexts: [],
          },
        ),
      ).toMatchObject({
        ok: true,
        value: { turnType: 'follow_up_question', targetQuestionId: PARTIAL_FOLLOW_UP_ID },
      });
    }

    expect(
      resolveRealtimeTurnIntent(
        englishGuide,
        state,
        {
          ...baseIntent,
          spokenText: 'Which responsibilities do you personally handle in digital sales?',
        },
        {
          latestParticipantText: 'I am Head of Digital Sales.',
          priorClarificationTexts: [],
        },
      ),
    ).toMatchObject({
      ok: true,
      value: {
        targetQuestionId: PARTIAL_FOLLOW_UP_ID,
        currentQuestionResolution: 'answered',
      },
    });

    for (const [latestParticipantText, resolution] of [
      ['No.', 'partially_answered'],
      ["I don't know.", 'partially_answered'],
      ["I'd rather not answer.", 'partially_answered'],
      ["That doesn't apply.", 'partially_answered'],
      ['I already answered that.', 'skipped_already_answered'],
    ] as const) {
      expect(
        resolveRealtimeTurnIntent(
          englishGuide,
          state,
          {
            ...baseIntent,
            spokenText: 'Which responsibilities do you personally handle in digital sales?',
          },
          { latestParticipantText, priorClarificationTexts: [] },
        ),
      ).toMatchObject({
        ok: true,
        value: {
          turnType: 'main_question',
          targetQuestionId: NEXT_MAIN_ID,
          currentQuestionResolution: resolution,
        },
      });
    }
  });

  it('provides canonical greeting and closing text for both interview languages', () => {
    expect(interviewGreetingText('de')).toContain('Guten Tag');
    expect(interviewClosingText('de')).toBe('Vielen Dank fuer das Gespraech und Ihre Zeit.');
    expect(interviewGreetingText('en')).toContain('thank you');
    expect(interviewClosingText('en')).toBe('Thank you for the conversation and for your time.');
  });

  it('restores the answered question for a legacy recovery state without a current pointer', () => {
    const coverage = applyCoverageUpdates(guide, initializeGuideCoverage(guide, INTERVIEW_ID), {
      interviewId: INTERVIEW_ID,
      guideId: GUIDE_ID,
      expectedRevision: 0,
      updates: [
        {
          questionId: MAIN_ID,
          status: 'answered',
          referencedTurnIds: ['answer-main'],
          at: AT,
        },
        {
          questionId: PARTIAL_FOLLOW_UP_ID,
          status: 'partially_answered',
          referencedTurnIds: ['answer-partial-follow-up'],
          at: AT,
        },
        {
          questionId: CURRENT_FOLLOW_UP_ID,
          status: 'answered',
          referencedTurnIds: ['answer-tenure'],
          at: AT,
        },
      ],
    });
    const state: PersistedInterview = {
      interviewId: INTERVIEW_ID,
      guideId: GUIDE_ID,
      lifecycle: {
        status: 'active',
        interviewId: INTERVIEW_ID,
        guideId: GUIDE_ID,
        createdAt: AT,
        revision: 1,
        startedAt: AT,
        activeSince: AT,
      },
      coverage,
      version: 1,
      activeWorkflowRunId: null,
      createdAt: AT,
      updatedAt: AT,
    };
    const participantTurn = participant(
      'answer-after-repeated-partial',
      8,
      partialFollowUpReference,
    );

    const restored = restoreParticipantQuestionForWorkflow(guide, state, participantTurn, AT);

    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(
      restored.value.coverage.questions.find(
        (question) => question.questionId === PARTIAL_FOLLOW_UP_ID,
      ),
    ).toMatchObject({
      status: 'current',
      referencedTurnIds: ['answer-partial-follow-up'],
    });
    expect(restored.value.coverage.revision).toBe(coverage.revision + 1);
  });

  it('reactivates a partial follow-up, keeps its parent current, and accepts its next answer', () => {
    const coverage = applyCoverageUpdates(guide, initializeGuideCoverage(guide, INTERVIEW_ID), {
      interviewId: INTERVIEW_ID,
      guideId: GUIDE_ID,
      expectedRevision: 0,
      updates: [
        {
          questionId: MAIN_ID,
          status: 'answered',
          referencedTurnIds: ['answer-main'],
          at: AT,
        },
        {
          questionId: PARTIAL_FOLLOW_UP_ID,
          status: 'partially_answered',
          referencedTurnIds: ['answer-partial-follow-up'],
          at: AT,
        },
        {
          questionId: CURRENT_FOLLOW_UP_ID,
          status: 'current',
          referencedTurnIds: [],
          at: AT,
        },
      ],
    });
    const state: PersistedInterview = {
      interviewId: INTERVIEW_ID,
      guideId: GUIDE_ID,
      lifecycle: {
        status: 'active',
        interviewId: INTERVIEW_ID,
        guideId: GUIDE_ID,
        createdAt: AT,
        revision: 1,
        startedAt: AT,
        activeSince: AT,
      },
      coverage,
      version: 1,
      activeWorkflowRunId: 'workflow-current-answer',
      createdAt: AT,
      updatedAt: AT,
    };
    const participantTurn = participant('answer-current-follow-up', 6, currentFollowUpReference);
    expect(workflowCandidateQuestionIds(buildGuideQuestionCatalog(guide), state, MAIN_ID)).toEqual([
      PARTIAL_FOLLOW_UP_ID,
      CURRENT_FOLLOW_UP_ID,
      NEXT_MAIN_ID,
    ]);
    const output: InterviewTurnWorkflowOutput = {
      coverageAnalysis: {
        findings: [
          {
            question: currentFollowUpReference,
            status: 'answered',
            transcriptTurnIds: [participantTurn.turnId],
            openAspects: [],
            rationale: 'Die Dauer wurde beantwortet.',
          },
        ],
        referencedTranscriptTurnIds: [participantTurn.turnId],
        rationale: 'Die aktuelle Vertiefungsfrage ist beantwortet.',
      },
      consistencyAnalysis: {
        contradictions: [],
        referencedTranscriptTurnIds: [],
        rationale: 'Keine Widersprueche.',
      },
      decision: {
        selectedAction: {
          action: 'ask_follow_up_question',
          target: partialFollowUpReference,
        },
        referencedTranscriptTurnIds: [participantTurn.turnId],
        consideredQuestions: [partialFollowUpReference],
        rationale: 'Die teilweise beantwortete Vertiefung wird erneut aktiviert.',
      },
      conductor: {
        action: 'ask',
        preface: null,
        question: {
          turnType: 'follow_up_question',
          text: 'Welche Entscheidungen treffen Sie?',
          guideReference: partialFollowUpReference,
        },
        referencedTranscriptTurnIds: [participantTurn.turnId],
        rationale: 'Stellt genau eine Leitfadenfrage.',
      },
    };

    const applied = applyWorkflowCoverage(guide, state, participantTurn, output, AT);

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(
      applied.value.questions.find((question) => question.questionId === PARTIAL_FOLLOW_UP_ID),
    ).toMatchObject({
      status: 'current',
      referencedTurnIds: ['answer-partial-follow-up'],
    });
    expect(
      applied.value.questions.find((question) => question.questionId === CURRENT_FOLLOW_UP_ID),
    ).toMatchObject({ status: 'answered', referencedTurnIds: [participantTurn.turnId] });

    const nextState: PersistedInterview = {
      ...state,
      lifecycle: { ...state.lifecycle, revision: 2 },
      coverage: applied.value,
      version: 2,
      activeWorkflowRunId: 'workflow-next-answer',
    };
    const view = projectInterviewView(nextState, guide);
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect(view.value.currentMainQuestion).toEqual(mainReference);

    const nextParticipantTurn = participant(
      'answer-reactivated-follow-up',
      8,
      partialFollowUpReference,
    );
    expect(
      coverageAnalysisPromptInputSchema.safeParse({
        agentName: 'coverage_analysis',
        interviewId: INTERVIEW_ID,
        interviewStateVersion: 2,
        guide: guideContract,
        interviewState: view.value,
        transcript: {
          interviewId: INTERVIEW_ID,
          guideId: GUIDE_ID,
          entries: [
            aiTurn('ai-main', 1, 'main_question', mainReference, 'Welche Rolle haben Sie?'),
            participant('answer-main', 2, mainReference),
            aiTurn(
              'ai-partial-follow-up',
              3,
              'follow_up_question',
              partialFollowUpReference,
              'Welche Entscheidungen treffen Sie?',
            ),
            participant('answer-partial-follow-up', 4, partialFollowUpReference),
            aiTurn(
              'ai-current-follow-up',
              5,
              'follow_up_question',
              currentFollowUpReference,
              'Wie lange sind Sie in dieser Rolle?',
            ),
            participantTurn,
            aiTurn(
              'ai-reactivated-follow-up',
              7,
              'follow_up_question',
              partialFollowUpReference,
              'Welche Entscheidungen treffen Sie?',
            ),
            nextParticipantTurn,
          ],
          finalizedAt: null,
        },
        latestParticipantTurnId: nextParticipantTurn.turnId,
        currentQuestion: partialFollowUpReference,
        candidateQuestionIds: [PARTIAL_FOLLOW_UP_ID, NEXT_MAIN_ID],
      }).success,
    ).toBe(true);
  });
});

function activeState(
  coverage: PersistedInterview['coverage'],
  language: PersistedInterview['language'] = 'de',
): PersistedInterview {
  return {
    interviewId: INTERVIEW_ID,
    guideId: GUIDE_ID,
    language,
    lifecycle: {
      status: 'active',
      interviewId: INTERVIEW_ID,
      guideId: GUIDE_ID,
      createdAt: AT,
      revision: 1,
      startedAt: AT,
      activeSince: AT,
    },
    coverage,
    version: 1,
    activeWorkflowRunId: null,
    createdAt: AT,
    updatedAt: AT,
  };
}

function participant(
  turnId: string,
  sequenceNumber: number,
  guideReference:
    typeof mainReference | typeof partialFollowUpReference | typeof currentFollowUpReference,
  text = `Antwort ${turnId}`,
) {
  return {
    kind: 'turn' as const,
    turnId,
    interviewId: INTERVIEW_ID,
    sequenceNumber,
    speaker: 'participant' as const,
    turnType: 'participant_answer' as const,
    text,
    occurredAt: new Date(Date.parse(AT) + sequenceNumber * 1_000).toISOString(),
    guideReference,
    sourceProvider: 'test',
    providerEventId: `provider:${turnId}`,
    sourceSegmentId: `segment:${turnId}`,
  };
}

function aiTurn(
  turnId: string,
  sequenceNumber: number,
  turnType: 'main_question' | 'follow_up_question',
  guideReference:
    typeof mainReference | typeof partialFollowUpReference | typeof currentFollowUpReference,
  text: string,
) {
  return {
    kind: 'turn' as const,
    turnId,
    interviewId: INTERVIEW_ID,
    sequenceNumber,
    speaker: 'ai_interviewer' as const,
    turnType,
    text,
    occurredAt: new Date(Date.parse(AT) + sequenceNumber * 1_000).toISOString(),
    guideReference,
    deliveryEventId: `delivery:${turnId}`,
    delivery: { status: 'complete' as const },
  };
}
