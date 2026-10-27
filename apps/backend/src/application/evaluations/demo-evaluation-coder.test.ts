import {
  evaluationProfileDocumentSchema,
  mvpInterviewSessionSchema,
  type SupportedLocale,
} from '@orgscience/contracts';
import { describe, expect, it } from 'vitest';

import { DemoEvaluationCoder } from './demo-evaluation-coder.js';

const STARTED_AT = '2026-08-31T09:00:00.000Z';
const ANSWERED_AT = '2026-08-31T09:01:00.000Z';
const ENDED_AT = '2026-08-31T09:02:00.000Z';
const PARTICIPANT_TEXT = 'Original participant wording remains canonical.';

const profile = evaluationProfileDocumentSchema.parse({
  schemaVersion: 1,
  profile: {
    profileId: 'profile-demo-localization',
    name: 'Demo localization profile',
    description: '',
    coderPrompt: 'Evaluate only supported participant evidence.',
    scale: { minimum: 1, maximum: 7 },
    dimensions: [{ dimensionId: 'process', name: 'Process', order: 0 }],
    items: [
      {
        itemId: 'process-item',
        dimensionId: 'process',
        name: 'Process item',
        codingInstruction: 'Assess the documented process.',
        order: 0,
        anchors: ([1, 2, 3, 4, 5, 6, 7] as const).map((score) => ({
          score,
          criterion: `Process anchor ${String(score)}`,
        })),
      },
    ],
  },
});

function session(language: SupportedLocale) {
  return mvpInterviewSessionSchema.parse({
    interviewId: `interview-demo-${language}`,
    guideId: `guide-demo-${language}`,
    language,
    guideTitle: language === 'de' ? 'Demo-Leitfaden' : 'Demo guide',
    status: 'completed',
    currentQuestionIndex: 1,
    totalQuestions: 1,
    currentQuestion: null,
    startedAt: STARTED_AT,
    endedAt: ENDED_AT,
    updatedAt: ENDED_AT,
    finalizedAt: ENDED_AT,
    partialTranscript: null,
    technicalGaps: [],
    transcript: [
      {
        turnId: `turn-ai-${language}`,
        interviewId: `interview-demo-${language}`,
        sequenceNumber: 1,
        speaker: 'ai_interviewer',
        turnType: 'main_question',
        text: language === 'de' ? 'Wie arbeiten Sie?' : 'How do you work?',
        occurredAt: STARTED_AT,
        guideReference: null,
      },
      {
        turnId: `turn-participant-${language}`,
        interviewId: `interview-demo-${language}`,
        sequenceNumber: 2,
        speaker: 'participant',
        turnType: 'participant_answer',
        text: PARTICIPANT_TEXT,
        occurredAt: ANSWERED_AT,
        guideReference: null,
      },
    ],
  });
}

describe('DemoEvaluationCoder localization', () => {
  it.each([
    {
      language: 'de' as const,
      missingInformation: 'Der Demo-Modus nimmt keine fachliche Klassifikation vor.',
      itemRationale:
        'Der deterministische Demo-Coder behaelt jedes Profilitem bei, ohne eine unbelegte Bewertung zu vergeben.',
      overallRationale:
        'Die deterministische profilgesteuerte Demo-Codierung prueft den technischen Ablauf, ohne eine fachliche Bewertung zu erzeugen.',
      aborted: 'Die Auswertungscodierung wurde abgebrochen.',
    },
    {
      language: 'en' as const,
      missingInformation: 'Demo mode does not perform subject-matter classification.',
      itemRationale:
        'The deterministic demo coder preserves every profile item without assigning an unsupported score.',
      overallRationale:
        'Deterministic profile-driven demo coding verifies the technical flow without producing a subject-matter assessment.',
      aborted: 'Evaluation coding was aborted.',
    },
  ])(
    'uses $language text without changing canonical evidence or machine codes',
    async ({ language, missingInformation, itemRationale, overallRationale, aborted }) => {
      const inputSession = session(language);
      const transcriptBefore = structuredClone(inputSession.transcript);
      const coder = new DemoEvaluationCoder();

      const result = await coder.code(
        { profile, session: inputSession },
        { runId: `evaluation-demo-${language}`, signal: new AbortController().signal },
      );

      expect(result).toEqual({
        ok: true,
        output: {
          items: [
            {
              itemId: 'process-item',
              dimensionId: 'process',
              status: 'insufficient_evidence',
              score: null,
              confidence: 0,
              supportingEvidence: [],
              counterEvidence: [],
              missingInformation: [missingInformation],
              rationale: itemRationale,
            },
          ],
          rationale: overallRationale,
        },
      });
      expect(inputSession.transcript).toEqual(transcriptBefore);
      expect(inputSession.transcript[1]?.text).toBe(PARTICIPANT_TEXT);

      const controller = new AbortController();
      controller.abort();
      const abortedResult = await coder.code(
        { profile, session: inputSession },
        { runId: `evaluation-demo-aborted-${language}`, signal: controller.signal },
      );
      expect(abortedResult).toEqual({
        ok: false,
        error: { code: 'aborted', message: aborted, retryable: false },
      });
    },
  );
});
