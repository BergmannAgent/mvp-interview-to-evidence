import { describe, expect, it } from 'vitest';

import type { MvpInterviewSession, MvpTranscriptTurn, SectionMemory } from '@orgscience/contracts';
import type { InterviewGuideSnapshot } from '@orgscience/domain';

import {
  buildRealtimeInterviewInstructions,
  selectRealtimeTranscriptTurns,
} from './realtime-interview-instructions.js';

const AT = '2026-09-11T12:00:00.000Z';
const INTERVIEW_ID = 'interview-context-selection';
const GUIDE_ID = 'guide-context-selection';
const OLD_SECTION = 'section-origin';
const CURRENT_SECTION = 'section-current';
const OLD_MAIN = 'main-origin';
const CURRENT_MAIN = 'main-current';

const guide: InterviewGuideSnapshot = {
  id: GUIDE_ID,
  sourceLanguage: 'de',
  title: 'Kontextauswahl',
  sourceMarkdown: '# Kontextauswahl',
  createdAt: AT,
  sections: [
    {
      id: OLD_SECTION,
      position: 0,
      title: 'Ursprung',
      mainQuestions: [
        { id: OLD_MAIN, position: 0, text: 'Was war vorher?', followUpQuestions: [] },
      ],
    },
    {
      id: CURRENT_SECTION,
      position: 1,
      title: 'Aktuell',
      mainQuestions: [
        { id: CURRENT_MAIN, position: 0, text: 'Was ist jetzt?', followUpQuestions: [] },
      ],
    },
  ],
};
const oldReference = {
  kind: 'main_question',
  guideId: GUIDE_ID,
  sectionId: OLD_SECTION,
  mainQuestionId: OLD_MAIN,
} as const;
const currentReference = {
  kind: 'main_question',
  guideId: GUIDE_ID,
  sectionId: CURRENT_SECTION,
  mainQuestionId: CURRENT_MAIN,
} as const;

describe('Realtime section-memory instructions', () => {
  it('uses memories for old sections while retaining the current and latest verbatim turns', () => {
    const session = activeSession();
    const memory = oldSectionMemory();
    const selected = selectRealtimeTranscriptTurns({ session, guide, sectionMemories: [memory] });

    expect(selected.map((turn) => turn.turnId)).not.toContain('old-question-early');
    expect(selected.map((turn) => turn.turnId)).not.toContain('old-answer-early');
    expect(selected.map((turn) => turn.turnId)).toEqual(
      expect.arrayContaining([
        'old-question-late',
        'old-answer-late',
        'current-question',
        'current-answer',
      ]),
    );
    const instructions = buildRealtimeInterviewInstructions({
      session,
      guide,
      sectionMemories: [memory],
    });
    expect(instructions).toContain('SECTION_MEMORY_DATA');
    expect(instructions).toContain('Wir hatten einen klaren Ablauf.');
    expect(instructions).not.toContain('Fruehe alte Antwort, die entfernt wird.');
    expect(instructions).toContain('Aktuelle Antwort bleibt vollstaendig.');
  });

  it('retains the complete raw transcript when no validated memory exists', () => {
    const session = activeSession();
    expect(selectRealtimeTranscriptTurns({ session, guide })).toEqual(session.transcript);
    expect(buildRealtimeInterviewInstructions({ session, guide })).toContain(
      'Fruehe alte Antwort, die entfernt wird.',
    );
  });
});

function activeSession(): MvpInterviewSession {
  const transcript: MvpTranscriptTurn[] = [
    turn('greeting', 1, 'ai_interviewer', 'greeting', 'Guten Tag.', null),
    turn(
      'old-question-early',
      2,
      'ai_interviewer',
      'main_question',
      'Was war vorher?',
      oldReference,
    ),
    turn(
      'old-answer-early',
      3,
      'participant',
      'participant_answer',
      'Fruehe alte Antwort, die entfernt wird.',
      oldReference,
    ),
    turn('old-question-late', 4, 'ai_interviewer', 'main_question', 'Noch etwas?', oldReference),
    turn(
      'old-answer-late',
      5,
      'participant',
      'participant_answer',
      'Wir hatten einen klaren Ablauf.',
      oldReference,
    ),
    turn(
      'current-question',
      6,
      'ai_interviewer',
      'main_question',
      'Was ist jetzt?',
      currentReference,
    ),
    turn(
      'current-answer',
      7,
      'participant',
      'participant_answer',
      'Aktuelle Antwort bleibt vollstaendig.',
      currentReference,
    ),
  ];
  return {
    interviewId: INTERVIEW_ID,
    guideId: GUIDE_ID,
    language: 'de',
    guideTitle: guide.title,
    status: 'active',
    stateVersion: 1,
    currentQuestionIndex: 1,
    totalQuestions: 2,
    currentQuestion: {
      questionId: CURRENT_MAIN,
      sectionId: CURRENT_SECTION,
      sectionTitle: 'Aktuell',
      kind: 'main',
      text: 'Was ist jetzt?',
      reference: currentReference,
    },
    startedAt: AT,
    endedAt: null,
    updatedAt: AT,
    partialTranscript: null,
    transcript,
    technicalGaps: [],
    finalizedAt: null,
  };
}

function oldSectionMemory(): SectionMemory {
  return {
    interviewId: INTERVIEW_ID,
    guideId: GUIDE_ID,
    sectionId: OLD_SECTION,
    sectionTitle: 'Ursprung',
    coveredQuestionIds: [OLD_MAIN],
    partiallyCoveredQuestionIds: [],
    facts: [
      { statement: 'Wir hatten einen klaren Ablauf.', transcriptTurnIds: ['old-answer-late'] },
    ],
    examples: [],
    limitations: [],
    openAspects: [],
    possibleContradictions: [],
    sourceThroughSequenceNumber: 5,
    compactedAt: AT,
  };
}

function turn(
  turnId: string,
  sequenceNumber: number,
  speaker: MvpTranscriptTurn['speaker'],
  turnType: MvpTranscriptTurn['turnType'],
  text: string,
  guideReference: MvpTranscriptTurn['guideReference'],
): MvpTranscriptTurn {
  return {
    turnId,
    interviewId: INTERVIEW_ID,
    sequenceNumber,
    speaker,
    turnType,
    text,
    occurredAt: AT,
    guideReference,
    interrupted: false,
  };
}
