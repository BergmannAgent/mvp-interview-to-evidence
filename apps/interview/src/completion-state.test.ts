import { mvpInterviewSessionSchema, type MvpInterviewSession } from '@orgscience/contracts';
import { describe, expect, it } from 'vitest';

import { isAuthoritativeTranscriptFinalized } from './completion-state.js';

describe('isAuthoritativeTranscriptFinalized', () => {
  it('keeps downloads disabled after a reload until the authoritative session arrives', () => {
    expect(isAuthoritativeTranscriptFinalized(null, 'interview-1')).toBe(false);
    expect(isAuthoritativeTranscriptFinalized(session(), 'interview-1')).toBe(true);
  });

  it('rejects pending, non-terminal, and cross-interview session data', () => {
    expect(isAuthoritativeTranscriptFinalized(session({ finalizedAt: null }), 'interview-1')).toBe(
      false,
    );
    expect(
      isAuthoritativeTranscriptFinalized(
        session({ status: 'active', endedAt: null, finalizedAt: null }),
        'interview-1',
      ),
    ).toBe(false);
    expect(isAuthoritativeTranscriptFinalized(session(), 'interview-2')).toBe(false);
  });
});

function session(overrides: Partial<MvpInterviewSession> = {}): MvpInterviewSession {
  return mvpInterviewSessionSchema.parse({
    interviewId: 'interview-1',
    guideId: 'guide-1',
    language: 'de',
    guideTitle: 'Leitfaden',
    status: 'completed',
    currentQuestionIndex: 0,
    totalQuestions: 1,
    currentQuestion: null,
    startedAt: '2026-09-01T10:00:00.000Z',
    endedAt: '2026-09-01T10:05:00.000Z',
    updatedAt: '2026-09-01T10:05:01.000Z',
    partialTranscript: null,
    transcript: [],
    technicalGaps: [],
    finalizedAt: '2026-09-01T10:05:02.000Z',
    ...overrides,
  });
}
