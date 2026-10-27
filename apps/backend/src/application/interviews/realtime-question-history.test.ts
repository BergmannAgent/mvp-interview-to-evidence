import type { AiTranscriptTurn, TranscriptAggregate } from '@orgscience/domain';
import { describe, expect, it } from 'vitest';

import type { StoredAiDelivery } from '../persistence/index.js';
import { realtimeQuestionHistory } from './realtime-question-history.js';

const AT = '2026-09-30T12:00:00.000Z';
const reference = {
  kind: 'main_question',
  guideId: 'guide',
  sectionId: 'section',
  mainQuestionId: 'main',
} as const;

function turn(id: string, sequenceNumber: number): AiTranscriptTurn {
  return {
    kind: 'turn',
    interviewId: 'interview',
    turnId: id,
    sequenceNumber,
    speaker: 'ai_interviewer',
    turnType: 'clarification_question',
    text: `Welche Massnahme ${id}?`,
    occurredAt: AT,
    deliveryEventId: `event-${id}`,
    delivery: { status: 'complete' },
    guideReference: reference,
  };
}

function delivery(
  entry: AiTranscriptTurn,
  purpose: 'clarification' | 'repeat' = 'clarification',
  source = 'answer',
): StoredAiDelivery {
  return {
    interviewId: 'interview',
    deliveryId: `delivery-${entry.turnId}`,
    jobId: 'job',
    workflowRunId: 'run',
    turnId: entry.turnId,
    utteranceId: entry.turnId,
    turnType: 'clarification_question',
    guideReference: reference,
    proposedText: entry.text,
    createdAt: AT,
    reservedSequenceNumber: entry.sequenceNumber,
    status: 'complete',
    provider: 'test',
    providerDeliveryEventId: entry.deliveryEventId,
    confirmedSpokenText: entry.text,
    resolvedAt: AT,
    interruptedAt: null,
    planningMetadata: {
      purpose,
      sourceParticipantTurnId: source,
      answerDisposition: purpose === 'repeat' ? 'off_topic' : 'partial',
      missingAspect: purpose === 'repeat' ? null : `Massnahme ${entry.turnId}`,
      requestedEvidenceType: purpose === 'repeat' ? null : 'action',
    },
  };
}

function aggregate(entries: TranscriptAggregate['entries']): TranscriptAggregate {
  return {
    interviewId: 'interview',
    guideId: 'guide',
    guideQuestionIndex: [reference],
    nextSequenceNumber: entries.length + 1,
    entries,
    partials: [],
    finals: [],
  };
}

describe('persisted Realtime question history', () => {
  it('counts repetitions separately and deduplicates reissued audio for the same source answer', () => {
    const entries = [turn('repeat', 1), turn('first', 2), turn('reissued', 3), turn('second', 4)];
    const receipts = entries.map((entry, index) =>
      delivery(
        entry,
        index === 0 ? 'repeat' : 'clarification',
        index === 3 ? 'answer-two' : 'answer-one',
      ),
    );
    const history = realtimeQuestionHistory(aggregate(entries), 'main', receipts);
    expect(history).toEqual({
      repetitionCount: 1,
      priorClarificationTexts: [entries[1]?.text, entries[3]?.text],
      priorClarificationAspects: ['Massnahme first', 'Massnahme second'],
    });
    expect(realtimeQuestionHistory(aggregate(entries), 'other-main', receipts)).toEqual({
      repetitionCount: 0,
      priorClarificationTexts: [],
      priorClarificationAspects: [],
    });
  });

  it('does not consume a clarification for failed or unspoken deliveries', () => {
    const entry = turn('gap', 1);
    for (const status of ['pending', 'gapped', 'cancelled'] as const) {
      expect(
        realtimeQuestionHistory(aggregate([]), 'main', [{ ...delivery(entry), status }])
          .priorClarificationTexts,
      ).toEqual([]);
    }
    expect(
      realtimeQuestionHistory(aggregate([entry]), 'main', [
        { ...delivery(entry), confirmedSpokenText: '' },
      ]).priorClarificationTexts,
    ).toEqual([]);
  });

  it('retains legacy confirmed questions and counts a partially spoken interruption once', () => {
    const legacy = turn('legacy', 1);
    const interrupted: AiTranscriptTurn = {
      ...turn('interrupted', 2),
      text: 'Welche erste Massnahme',
      delivery: { status: 'interrupted', interruptedAt: AT },
    };
    const history = realtimeQuestionHistory(aggregate([legacy, interrupted]), 'main', [
      {
        ...delivery(interrupted),
        status: 'interrupted',
        confirmedSpokenText: interrupted.text,
        proposedText: 'Welche erste Massnahme haben Sie ergriffen?',
        interruptedAt: AT,
      },
    ]);
    expect(history.priorClarificationTexts).toEqual([
      legacy.text,
      'Welche erste Massnahme haben Sie ergriffen?',
    ]);
    expect(history.repetitionCount).toBe(0);
  });
});
