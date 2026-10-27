import { describe, expect, it } from 'vitest';

import {
  monitoringEventSchema,
  mvpRealtimeCommandResponseSchema,
  SECTION_MEMORY_MAX_SERIALIZED_CHARACTERS,
  sectionMemorySchema,
} from '../src/index.js';

const AT = '2026-09-11T12:00:00.000Z';

describe('section-memory contracts', () => {
  it('accepts scoped evidence and rejects duplicate or scoring data', () => {
    const memory = {
      interviewId: 'interview-1',
      guideId: 'guide-1',
      sectionId: 'section-1',
      sectionTitle: 'Beliebiger Abschnitt',
      coveredQuestionIds: ['question-1'],
      partiallyCoveredQuestionIds: [],
      facts: [{ statement: 'Ein belegter Fakt.', transcriptTurnIds: ['turn-1'] }],
      examples: [],
      limitations: [],
      openAspects: [],
      possibleContradictions: [],
      sourceThroughSequenceNumber: 4,
      compactedAt: AT,
    } as const;

    expect(sectionMemorySchema.safeParse(memory).success).toBe(true);
    expect(
      sectionMemorySchema.safeParse({
        ...memory,
        coveredQuestionIds: ['question-1', 'question-1'],
      }).success,
    ).toBe(false);
    expect(sectionMemorySchema.safeParse({ ...memory, score: 7 }).success).toBe(false);
    const oversizedMemory = {
      ...memory,
      openAspects: Array.from({ length: 30 }, (_, index) => ({
        questionId: `question-open-${index}`,
        description: `Open aspect ${index}: ${'x'.repeat(480)}`,
      })),
    };
    expect(JSON.stringify(oversizedMemory).length).toBeGreaterThan(
      SECTION_MEMORY_MAX_SERIALIZED_CHARACTERS,
    );
    expect(sectionMemorySchema.safeParse(oversizedMemory).success).toBe(false);
  });

  it('validates the optional Realtime context update and section-compacted event', () => {
    const command = {
      session: {
        interviewId: 'interview-1',
        guideId: 'guide-1',
        language: 'de',
        guideTitle: 'Leitfaden',
        status: 'active',
        currentQuestionIndex: 0,
        totalQuestions: 1,
        currentQuestion: null,
        startedAt: AT,
        endedAt: null,
        updatedAt: AT,
        partialTranscript: null,
        transcript: [],
        technicalGaps: [],
        finalizedAt: null,
      },
      newAiTurns: [],
      nextAiTurn: null,
      contextUpdate: {
        revision: 'section-memory:revision-1',
        instructions: 'Updated interview instructions',
        removeConversationItemIds: ['provider-item-1'],
      },
    } as const;
    expect(mvpRealtimeCommandResponseSchema.safeParse(command).success).toBe(true);

    const event = {
      eventId: 'event-1',
      interviewId: 'interview-1',
      runId: 'workflow-1',
      sequenceNumber: 8,
      occurredAt: AT,
      category: 'interview',
      type: 'interview.section_compacted',
      payload: {
        guideId: 'guide-1',
        sectionId: 'section-1',
        sectionTitle: 'Beliebiger Abschnitt',
        sourceThroughSequenceNumber: 4,
        factCount: 1,
        compactedAt: AT,
      },
    } as const;
    expect(monitoringEventSchema.safeParse(event).success).toBe(true);
    expect(
      monitoringEventSchema.safeParse({
        ...event,
        payload: { ...event.payload, score: 7 },
      }).success,
    ).toBe(false);
  });
});
