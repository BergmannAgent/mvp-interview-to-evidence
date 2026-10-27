import { mvpInterviewSessionSchema, type MvpInterviewSession } from '@orgscience/contracts';
import { describe, expect, it } from 'vitest';

import {
  compareAuthoritativeSession,
  shouldApplyAuthoritativeSession,
} from './session-freshness.js';

describe('authoritative interview session freshness', () => {
  it('rejects an older active poll after the completed snapshot was applied', () => {
    const completed = session({
      status: 'completed',
      currentQuestionIndex: 51,
      currentQuestion: null,
      updatedAt: '2026-09-19T16:17:01.295Z',
      endedAt: '2026-09-19T16:17:01.295Z',
      finalizedAt: '2026-09-19T16:17:01.487Z',
    });
    const staleActive = session({
      status: 'active',
      currentQuestionIndex: 47,
      updatedAt: '2026-09-19T16:16:13.938Z',
      transcript: [transcriptTurn(125)],
    });

    expect(shouldApplyAuthoritativeSession(completed, staleActive)).toBe(false);
  });

  it('accepts a newer session even when its question index is lower', () => {
    const previous = session({
      status: 'active',
      currentQuestionIndex: 50,
      updatedAt: '2026-09-19T16:16:13.938Z',
    });
    const newer = session({
      status: 'active',
      currentQuestionIndex: 47,
      updatedAt: '2026-09-19T16:16:20.000Z',
    });

    expect(shouldApplyAuthoritativeSession(previous, newer)).toBe(true);
    expect(compareAuthoritativeSession(newer, previous)).toBeGreaterThan(0);
  });

  it('prefers the completed state when timestamps are equal', () => {
    const active = session({ status: 'active', updatedAt: '2026-09-19T16:17:01.295Z' });
    const completed = session({
      status: 'completed',
      currentQuestionIndex: 51,
      currentQuestion: null,
      updatedAt: '2026-09-19T16:17:01.295Z',
      endedAt: '2026-09-19T16:17:01.295Z',
      finalizedAt: '2026-09-19T16:17:01.295Z',
    });

    expect(shouldApplyAuthoritativeSession(active, completed)).toBe(true);
  });

  it('uses state version even if a late partial gives an old snapshot a newer timestamp', () => {
    const current = session({ stateVersion: 71 });
    const stale = session({ stateVersion: 70, updatedAt: '2026-09-19T19:00:00.000Z' });
    expect(shouldApplyAuthoritativeSession(current, stale)).toBe(false);
  });

  it('does not lose final turns or finalization on an equal-version response', () => {
    const current = session({ transcript: [transcriptTurn(125)] });
    expect(shouldApplyAuthoritativeSession(current, session())).toBe(false);
    const finalized = session({ finalizedAt: '2026-09-19T19:00:00.000Z' });
    expect(shouldApplyAuthoritativeSession(finalized, session())).toBe(false);
  });

  it('does not accept a delayed response belonging to a different interview', () => {
    expect(shouldApplyAuthoritativeSession(session(), session({ interviewId: 'other' }))).toBe(
      false,
    );
  });
});

function session(overrides: Partial<MvpInterviewSession> = {}): MvpInterviewSession {
  return mvpInterviewSessionSchema.parse({
    interviewId: 'interview-1',
    guideId: 'guide-1',
    language: 'de',
    guideTitle: 'Testleitfaden',
    status: 'active',
    currentQuestionIndex: 0,
    totalQuestions: 51,
    currentQuestion: null,
    startedAt: '2026-09-19T16:00:00.000Z',
    endedAt: null,
    updatedAt: '2026-09-19T16:00:00.000Z',
    partialTranscript: null,
    transcript: [],
    technicalGaps: [],
    finalizedAt: null,
    ...overrides,
  });
}

function transcriptTurn(sequenceNumber: number): MvpInterviewSession['transcript'][number] {
  return {
    turnId: `turn-${sequenceNumber}`,
    interviewId: 'interview-1',
    sequenceNumber,
    speaker: 'participant',
    turnType: 'participant_answer',
    text: 'Antwort',
    occurredAt: '2026-09-19T16:16:13.000Z',
    guideReference: null,
    interrupted: false,
  };
}
