import { mvpInterviewSessionSchema, type MvpTranscriptTurn } from '@orgscience/contracts';
import { describe, expect, it } from 'vitest';
import { interviewProgress } from './interview-progress.js';

describe('interview question progress', () => {
  it('keeps advancing when question 48 is asked after 51', () => {
    const order = [...Array.from({ length: 47 }, (_, i) => i + 1), 49, 50, 51, 48];
    const transcript: MvpTranscriptTurn[] = [];
    const counts: number[] = [];
    for (const [index, question] of order.entries()) {
      const current = questionReference(question);
      const session = mvpInterviewSessionSchema.parse({
        interviewId: 'interview',
        guideId: 'guide',
        guideTitle: 'Guide',
        status: 'active',
        currentQuestionIndex: question - 1,
        totalQuestions: 51,
        currentQuestion: {
          questionId: `q-${question}`,
          sectionId: 'section',
          sectionTitle: 'Section',
          kind: 'follow_up',
          text: 'Question?',
          reference: current,
        },
        startedAt: null,
        endedAt: null,
        updatedAt: '2026-09-19T12:00:00.000Z',
        partialTranscript: null,
        transcript,
      });
      counts.push(interviewProgress(session));
      transcript.push({
        turnId: `turn-${index}`,
        interviewId: 'interview',
        sequenceNumber: index + 1,
        speaker: 'ai_interviewer',
        turnType: 'follow_up_question',
        text: 'Question?',
        occurredAt: session.updatedAt,
        guideReference: current,
        interrupted: false,
      });
    }
    expect(counts).toEqual(Array.from({ length: 51 }, (_, i) => i + 1));
  });

  it('does not count clarification, repetition, and answers as new guide questions', () => {
    const base = {
      interviewId: 'interview',
      guideId: 'guide',
      guideTitle: 'Guide',
      status: 'active',
      currentQuestionIndex: 50,
      totalQuestions: 51,
      currentQuestion: null,
      startedAt: null,
      endedAt: null,
      updatedAt: '2026-09-19T12:00:00.000Z',
      partialTranscript: null,
    };
    const transcript = ['follow_up_question', 'participant_answer', 'clarification_question'].map(
      (turnType, i) => ({
        turnId: `turn-${i}`,
        interviewId: 'interview',
        sequenceNumber: i + 1,
        speaker: turnType === 'participant_answer' ? 'participant' : 'ai_interviewer',
        turnType,
        text: 'Text',
        occurredAt: base.updatedAt,
        guideReference: questionReference(51),
      }),
    );
    expect(interviewProgress(mvpInterviewSessionSchema.parse({ ...base, transcript }))).toBe(1);
  });
});

function questionReference(question: number) {
  return {
    kind: 'follow_up_question' as const,
    guideId: 'guide',
    sectionId: 'section',
    mainQuestionId: 'main',
    followUpQuestionId: `q-${question}`,
  };
}
