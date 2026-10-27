import { describe, expect, it } from 'vitest';

import {
  monitoringEventHistoryPageSchema,
  monitoringEventHistoryQuerySchema,
  type MonitoringEvent,
} from '../src/index.js';

const INTERVIEW_ID = 'interview-history-1';
const NOW = '2026-08-12T11:00:00.000Z';

function event(sequenceNumber: number): MonitoringEvent {
  return {
    eventId: `event-${String(sequenceNumber)}`,
    interviewId: INTERVIEW_ID,
    language: 'de',
    runId: `run-${String(sequenceNumber)}`,
    sequenceNumber,
    occurredAt: NOW,
    category: 'interview',
    type: 'interview.status_changed',
    payload: {
      previousStatus: sequenceNumber === 1 ? null : 'ready',
      nextStatus: 'ready',
      changedAt: NOW,
    },
  };
}

describe('monitoring event history contracts', () => {
  it('normalizes a bounded query and rejects unknown or ambiguous parameters', () => {
    expect(monitoringEventHistoryQuerySchema.parse({})).toEqual({
      afterSequence: 0,
      throughSequence: null,
      limit: 100,
    });
    expect(
      monitoringEventHistoryQuerySchema.parse({
        afterSequence: '12',
        throughSequence: '20',
        limit: '500',
      }),
    ).toEqual({ afterSequence: 12, throughSequence: 20, limit: 500 });
    expect(
      monitoringEventHistoryQuerySchema.safeParse({
        afterSequence: '12',
        throughSequence: '11',
      }).success,
    ).toBe(false);
    expect(monitoringEventHistoryQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(monitoringEventHistoryQuerySchema.safeParse({ limit: '501' }).success).toBe(false);
    expect(monitoringEventHistoryQuerySchema.safeParse({ unknown: 'value' }).success).toBe(false);
  });

  it('accepts contiguous pages with an explicit continuation cursor', () => {
    const page = {
      interviewId: INTERVIEW_ID,
      afterSequence: 0,
      highWaterSequence: 3,
      events: [event(1), event(2)],
      hasMore: true,
      nextAfterSequence: 2,
    } as const;

    expect(monitoringEventHistoryPageSchema.safeParse(page).success).toBe(true);
    expect(
      monitoringEventHistoryPageSchema.safeParse({ ...page, nextAfterSequence: 1 }).success,
    ).toBe(false);
    expect(
      monitoringEventHistoryPageSchema.safeParse({ ...page, events: [event(2)] }).success,
    ).toBe(false);
    expect(
      monitoringEventHistoryPageSchema.safeParse({
        ...page,
        events: [{ ...event(1), interviewId: 'interview-other' }],
        nextAfterSequence: 1,
      }).success,
    ).toBe(false);
  });

  it('requires a final page to reach its captured high-water mark', () => {
    expect(
      monitoringEventHistoryPageSchema.safeParse({
        interviewId: INTERVIEW_ID,
        afterSequence: 2,
        highWaterSequence: 3,
        events: [event(3)],
        hasMore: false,
        nextAfterSequence: null,
      }).success,
    ).toBe(true);
    expect(
      monitoringEventHistoryPageSchema.safeParse({
        interviewId: INTERVIEW_ID,
        afterSequence: 0,
        highWaterSequence: 3,
        events: [event(1)],
        hasMore: false,
        nextAfterSequence: null,
      }).success,
    ).toBe(false);
    expect(
      monitoringEventHistoryPageSchema.safeParse({
        interviewId: INTERVIEW_ID,
        afterSequence: 0,
        highWaterSequence: 3,
        events: [],
        hasMore: false,
        nextAfterSequence: null,
      }).success,
    ).toBe(false);
    expect(
      monitoringEventHistoryPageSchema.safeParse({
        interviewId: INTERVIEW_ID,
        afterSequence: 3,
        highWaterSequence: 3,
        events: [],
        hasMore: false,
        nextAfterSequence: null,
      }).success,
    ).toBe(true);
  });
});
