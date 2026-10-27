import { describe, expect, it } from 'vitest';

import {
  TranscriptDomainError,
  appendAiTranscriptTurn,
  createTranscriptAggregate,
  ingestFinalParticipantSegment,
  ingestPartialParticipantSegment,
  recordTranscriptTechnicalGap,
  validateFinalTranscript,
  type AppendAiTurnInput,
  type FinalParticipantSegmentInput,
  type FollowUpQuestionGuideReference,
  type MainQuestionGuideReference,
  type TranscriptAggregate,
  type TranscriptInvariantIssueCode,
} from './aggregate.js';
import { toCanonicalTranscriptSnapshot } from './snapshot.js';

const INTERVIEW_ID = 'interview-1';
const GUIDE_ID = 'guide-1';
const T0 = '2026-08-06T10:00:00.000Z';
const T1 = '2026-08-06T10:01:00.000Z';
const T2 = '2026-08-06T10:02:00.000Z';
const T3 = '2026-08-06T10:03:00.000Z';
const T4 = '2026-08-06T10:04:00.000Z';
const T5 = '2026-08-06T10:05:00.000Z';
const T6 = '2026-08-06T10:06:00.000Z';
const SOURCE_PROVIDER = 'demo-stt';
const NATIVE_EVENT_PREFIX = 'projects/acme/events/evt:abc+def=@?/';
const NATIVE_PROVIDER_EVENT_ID = `${NATIVE_EVENT_PREFIX}${'x'.repeat(
  300 - NATIVE_EVENT_PREFIX.length,
)}`;

const mainReference: MainQuestionGuideReference = {
  kind: 'main_question',
  guideId: GUIDE_ID,
  sectionId: 'section-1',
  mainQuestionId: 'main-1',
};

const followUpReference: FollowUpQuestionGuideReference = {
  kind: 'follow_up_question',
  guideId: GUIDE_ID,
  sectionId: 'section-1',
  mainQuestionId: 'main-1',
  followUpQuestionId: 'follow-up-1',
};

const participantFinal: FinalParticipantSegmentInput = {
  interviewId: INTERVIEW_ID,
  sourceProvider: SOURCE_PROVIDER,
  utteranceId: 'utterance-1',
  providerEventId: 'provider-final-1',
  segmentId: 'segment-1',
  turnId: 'turn-answer-1',
  text: '  I lead the resilience program.  ',
  occurredAt: T2,
  observedAt: T2,
  finalizedAt: T2,
  guideReference: mainReference,
};

const mainQuestionInput: AppendAiTurnInput = {
  interviewId: INTERVIEW_ID,
  turnId: 'turn-main-1',
  deliveryEventId: 'delivery-main-1',
  turnType: 'main_question',
  spokenText: 'What is your role?',
  occurredAt: T1,
  guideReference: mainReference,
  delivery: { status: 'complete' },
};

function emptyAggregate(): TranscriptAggregate {
  return createTranscriptAggregate(INTERVIEW_ID, GUIDE_ID, [mainReference, followUpReference]);
}

function withGreeting(): TranscriptAggregate {
  return appendAiTranscriptTurn(emptyAggregate(), {
    interviewId: INTERVIEW_ID,
    turnId: 'turn-greeting',
    deliveryEventId: 'delivery-greeting',
    turnType: 'greeting',
    spokenText: 'Welcome to the interview.',
    occurredAt: T0,
    guideReference: null,
    delivery: { status: 'complete' },
  }).aggregate;
}

function withQuestion(): TranscriptAggregate {
  return appendAiTranscriptTurn(withGreeting(), mainQuestionInput).aggregate;
}

function completeTranscript(): TranscriptAggregate {
  const answer = ingestFinalParticipantSegment(withQuestion(), participantFinal).aggregate;
  return appendAiTranscriptTurn(answer, {
    interviewId: INTERVIEW_ID,
    turnId: 'turn-closing',
    deliveryEventId: 'delivery-closing',
    turnType: 'closing',
    spokenText: 'Thank you for participating.',
    occurredAt: T3,
    guideReference: null,
    delivery: { status: 'complete' },
  }).aggregate;
}

function expectTranscriptError(callback: () => unknown, code: TranscriptDomainError['code']): void {
  try {
    callback();
    throw new Error('Expected TranscriptDomainError');
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(TranscriptDomainError);
    expect((error as TranscriptDomainError).code).toBe(code);
  }
}

function issueCodes(aggregate: TranscriptAggregate): TranscriptInvariantIssueCode[] {
  return validateFinalTranscript(aggregate).issues.map((issue) => issue.code);
}

describe('transcript routing and provider segments', () => {
  it('rejects every input routed to another interview', () => {
    expectTranscriptError(
      () =>
        ingestPartialParticipantSegment(emptyAggregate(), {
          interviewId: 'other-interview',
          sourceProvider: SOURCE_PROVIDER,
          utteranceId: 'utterance-1',
          providerEventId: 'provider-partial-1',
          segmentId: 'segment-1',
          text: 'partial',
          revision: 0,
          observedAt: T0,
        }),
      'interview_mismatch',
    );
    expectTranscriptError(
      () =>
        ingestFinalParticipantSegment(withQuestion(), {
          ...participantFinal,
          interviewId: 'other-interview',
        }),
      'interview_mismatch',
    );
    expectTranscriptError(
      () =>
        appendAiTranscriptTurn(emptyAggregate(), { ...mainQuestionInput, interviewId: 'other' }),
      'interview_mismatch',
    );
    expectTranscriptError(
      () =>
        recordTranscriptTechnicalGap(emptyAggregate(), {
          interviewId: 'other',
          gapId: 'gap-1',
          sourceEventId: 'source-gap-1',
          source: 'transport',
          sourceProvider: null,
          relatedUtteranceId: null,
          description: 'Connection lost.',
          occurredAt: T0,
          relatedSegmentId: null,
        }),
      'interview_mismatch',
    );
  });

  it('keeps partials non-canonical, replaces revisions, and detects event reuse', () => {
    const accepted = ingestPartialParticipantSegment(emptyAggregate(), {
      interviewId: INTERVIEW_ID,
      sourceProvider: SOURCE_PROVIDER,
      utteranceId: 'utterance-1',
      providerEventId: 'provider-partial-1',
      segmentId: 'segment-1',
      text: 'I lead',
      revision: 0,
      observedAt: T0,
    });
    const updated = ingestPartialParticipantSegment(accepted.aggregate, {
      interviewId: INTERVIEW_ID,
      sourceProvider: SOURCE_PROVIDER,
      utteranceId: 'utterance-1',
      providerEventId: 'provider-partial-2',
      segmentId: 'segment-1',
      text: 'I lead the program',
      revision: 1,
      observedAt: T1,
    });
    const duplicate = ingestPartialParticipantSegment(
      updated.aggregate,
      updated.aggregate.partials[0]!,
    );

    expect(accepted.aggregate.entries).toEqual([]);
    expect(updated.status).toBe('updated');
    expect(updated.aggregate.partials).toEqual([
      expect.objectContaining({ providerEventId: 'provider-partial-2', revision: 1 }),
    ]);
    expect(duplicate.status).toBe('ignored_stale');
    expectTranscriptError(
      () =>
        ingestPartialParticipantSegment(updated.aggregate, {
          ...updated.aggregate.partials[0]!,
          text: 'same event, changed payload',
        }),
      'conflicting_partial_event',
    );
    expectTranscriptError(
      () =>
        ingestPartialParticipantSegment(updated.aggregate, {
          ...updated.aggregate.partials[0]!,
          utteranceId: 'another-utterance',
          providerEventId: 'provider-partial-another-utterance',
          revision: 2,
        }),
      'conflicting_partial_segment',
    );
  });

  it('keeps empty and whitespace partials lossless up to the shared text limit', () => {
    for (const text of ['', '   ', 'x'.repeat(20_000), '😀'.repeat(20_000)]) {
      const accepted = ingestPartialParticipantSegment(emptyAggregate(), {
        interviewId: INTERVIEW_ID,
        sourceProvider: SOURCE_PROVIDER,
        utteranceId: 'utterance-empty-text',
        providerEventId: `provider-event-${text.length}`,
        segmentId: 'segment-empty-text',
        text,
        revision: 0,
        observedAt: T0,
      });

      expect(accepted.aggregate.partials[0]?.text).toBe(text);
    }

    expectTranscriptError(
      () =>
        ingestPartialParticipantSegment(emptyAggregate(), {
          interviewId: INTERVIEW_ID,
          sourceProvider: SOURCE_PROVIDER,
          utteranceId: 'utterance-long-text',
          providerEventId: 'provider-event-long-text',
          segmentId: 'segment-long-text',
          text: 'x'.repeat(20_001),
          revision: 0,
          observedAt: T0,
        }),
      'invalid_text',
    );
    expectTranscriptError(
      () =>
        ingestPartialParticipantSegment(emptyAggregate(), {
          interviewId: INTERVIEW_ID,
          sourceProvider: SOURCE_PROVIDER,
          utteranceId: 'utterance-long-unicode-text',
          providerEventId: 'provider-event-long-unicode-text',
          segmentId: 'segment-long-unicode-text',
          text: '😀'.repeat(20_001),
          revision: 0,
          observedAt: T0,
        }),
      'invalid_text',
    );
  });

  it('enforces shared bounds for final turn text and technical gap descriptions', () => {
    const maximumTurnText = 't'.repeat(20_000);
    const maximumGapDescription = 'g'.repeat(1_000);

    const participant = ingestFinalParticipantSegment(withQuestion(), {
      ...participantFinal,
      text: maximumTurnText,
    });
    const ai = appendAiTranscriptTurn(emptyAggregate(), {
      ...mainQuestionInput,
      spokenText: maximumTurnText,
    });
    const gap = recordTranscriptTechnicalGap(emptyAggregate(), {
      interviewId: INTERVIEW_ID,
      gapId: 'gap-maximum-description',
      sourceEventId: 'source-maximum-description',
      source: 'transport',
      sourceProvider: null,
      relatedUtteranceId: null,
      description: maximumGapDescription,
      occurredAt: T0,
      relatedSegmentId: null,
    });

    expect(participant.turn.text).toBe(maximumTurnText);
    expect(ai.turn.text).toBe(maximumTurnText);
    expect(gap.gap.description).toBe(maximumGapDescription);

    for (const write of [
      () =>
        ingestFinalParticipantSegment(withQuestion(), {
          ...participantFinal,
          text: `${maximumTurnText}x`,
        }),
      () =>
        appendAiTranscriptTurn(emptyAggregate(), {
          ...mainQuestionInput,
          spokenText: `${maximumTurnText}x`,
        }),
      () =>
        recordTranscriptTechnicalGap(emptyAggregate(), {
          interviewId: INTERVIEW_ID,
          gapId: 'gap-overlong-description',
          sourceEventId: 'source-overlong-description',
          source: 'transport',
          sourceProvider: null,
          relatedUtteranceId: null,
          description: `${maximumGapDescription}x`,
          occurredAt: T0,
          relatedSegmentId: null,
        }),
    ]) {
      expectTranscriptError(write, 'invalid_text');
    }
  });

  it('preserves native provider event IDs while keeping internal IDs constrained', () => {
    const partial = ingestPartialParticipantSegment(emptyAggregate(), {
      interviewId: INTERVIEW_ID,
      sourceProvider: SOURCE_PROVIDER,
      utteranceId: 'utterance-native-event',
      providerEventId: NATIVE_PROVIDER_EVENT_ID,
      segmentId: 'segment-native-event',
      text: 'Exact partial',
      revision: 0,
      observedAt: T0,
    });
    const final = ingestFinalParticipantSegment(withQuestion(), {
      ...participantFinal,
      providerEventId: NATIVE_PROVIDER_EVENT_ID,
    });
    const aiTurn = appendAiTranscriptTurn(emptyAggregate(), {
      ...mainQuestionInput,
      deliveryEventId: NATIVE_PROVIDER_EVENT_ID,
    });

    expect(partial.aggregate.partials[0]?.providerEventId).toBe(NATIVE_PROVIDER_EVENT_ID);
    expect(final.turn.providerEventId).toBe(NATIVE_PROVIDER_EVENT_ID);
    expect(final.turn.turnId).toBe(participantFinal.turnId);
    expect(aiTurn.turn.deliveryEventId).toBe(NATIVE_PROVIDER_EVENT_ID);

    for (const providerEventId of [
      ` ${NATIVE_PROVIDER_EVENT_ID.slice(1)}`,
      `${NATIVE_PROVIDER_EVENT_ID.slice(1)} `,
      `${NATIVE_PROVIDER_EVENT_ID}x`,
    ]) {
      expectTranscriptError(
        () =>
          ingestPartialParticipantSegment(emptyAggregate(), {
            interviewId: INTERVIEW_ID,
            sourceProvider: SOURCE_PROVIDER,
            utteranceId: 'utterance-invalid-event',
            providerEventId,
            segmentId: 'segment-invalid-event',
            text: '',
            revision: 0,
            observedAt: T0,
          }),
        'invalid_identifier',
      );
    }

    expectTranscriptError(
      () =>
        appendAiTranscriptTurn(emptyAggregate(), {
          ...mainQuestionInput,
          turnId: NATIVE_PROVIDER_EVENT_ID,
          deliveryEventId: 'provider-delivery-valid',
        }),
      'invalid_identifier',
    );
  });

  it('keeps equal STT identities distinct across providers', () => {
    const firstPartial = ingestPartialParticipantSegment(emptyAggregate(), {
      interviewId: INTERVIEW_ID,
      sourceProvider: 'stt-a',
      utteranceId: 'shared-utterance',
      providerEventId: 'shared-event',
      segmentId: 'shared-segment',
      text: 'Provider A partial',
      revision: 0,
      observedAt: T0,
    });
    const secondPartial = ingestPartialParticipantSegment(firstPartial.aggregate, {
      interviewId: INTERVIEW_ID,
      sourceProvider: 'stt-b',
      utteranceId: 'shared-utterance',
      providerEventId: 'shared-event',
      segmentId: 'shared-segment',
      text: 'Provider B partial',
      revision: 0,
      observedAt: T1,
    });
    expect(secondPartial.status).toBe('accepted');
    expect(secondPartial.aggregate.partials).toHaveLength(2);

    const firstGap = recordTranscriptTechnicalGap(emptyAggregate(), {
      interviewId: INTERVIEW_ID,
      gapId: 'gap-provider-a',
      sourceEventId: 'shared-gap-event',
      source: 'speech_to_text',
      sourceProvider: 'stt-a',
      relatedUtteranceId: 'shared-utterance',
      description: 'Provider A did not finalize the segment.',
      occurredAt: T0,
      relatedSegmentId: 'shared-segment',
    });
    const secondGap = recordTranscriptTechnicalGap(firstGap.aggregate, {
      interviewId: INTERVIEW_ID,
      gapId: 'gap-provider-b',
      sourceEventId: 'shared-gap-event',
      source: 'speech_to_text',
      sourceProvider: 'stt-b',
      relatedUtteranceId: 'shared-utterance',
      description: 'Provider B did not finalize the segment.',
      occurredAt: T1,
      relatedSegmentId: 'shared-segment',
    });
    expect(secondGap.aggregate.entries).toHaveLength(2);

    const firstFinal = ingestFinalParticipantSegment(withQuestion(), {
      ...participantFinal,
      sourceProvider: 'stt-a',
      utteranceId: 'shared-final-utterance',
      providerEventId: 'shared-final-event',
      segmentId: 'shared-final-segment',
    }).aggregate;
    const nextQuestion = appendAiTranscriptTurn(firstFinal, {
      ...mainQuestionInput,
      turnId: 'turn-main-provider-b',
      deliveryEventId: 'delivery-main-provider-b',
      occurredAt: T3,
    }).aggregate;
    const secondFinal = ingestFinalParticipantSegment(nextQuestion, {
      ...participantFinal,
      sourceProvider: 'stt-b',
      utteranceId: 'shared-final-utterance',
      providerEventId: 'shared-final-event',
      segmentId: 'shared-final-segment',
      turnId: 'turn-answer-provider-b',
      occurredAt: T4,
      observedAt: T4,
      finalizedAt: T4,
    }).aggregate;
    const duplicateCodes = issueCodes(secondFinal).filter((code) => code.startsWith('duplicate_'));
    expect(duplicateCodes).toEqual([]);
  });

  it('persists exact final text once and ignores a later partial revision', () => {
    const partial = ingestPartialParticipantSegment(withQuestion(), {
      interviewId: INTERVIEW_ID,
      sourceProvider: SOURCE_PROVIDER,
      utteranceId: 'utterance-1',
      providerEventId: 'provider-partial-1',
      segmentId: 'segment-1',
      text: 'I lead...',
      revision: 0,
      observedAt: T1,
    }).aggregate;
    const final = ingestFinalParticipantSegment(partial, participantFinal);
    const retry = ingestFinalParticipantSegment(final.aggregate, participantFinal);
    const latePartial = ingestPartialParticipantSegment(final.aggregate, {
      interviewId: INTERVIEW_ID,
      sourceProvider: SOURCE_PROVIDER,
      utteranceId: 'utterance-1',
      providerEventId: 'provider-partial-late',
      segmentId: 'segment-late',
      text: 'must not replace final',
      revision: 99,
      observedAt: T3,
    });

    expect(final.turn.text).toBe(participantFinal.text);
    expect(final.turn).toMatchObject({
      interviewId: INTERVIEW_ID,
      providerEventId: 'provider-final-1',
      sequenceNumber: 3,
      sourceSegmentId: 'segment-1',
    });
    expect(final.aggregate.finals).toEqual([participantFinal]);
    expect(retry.status).toBe('duplicate');
    expect(retry.aggregate).toBe(final.aggregate);
    expect(latePartial.status).toBe('ignored_finalized');

    const offsetRetry = ingestFinalParticipantSegment(final.aggregate, {
      ...participantFinal,
      occurredAt: '2026-08-06T12:02:00.000+02:00',
      observedAt: '2026-08-06T12:02:00.000+02:00',
      finalizedAt: '2026-08-06T12:02:00.000+02:00',
    });
    expect(offsetRetry.status).toBe('duplicate');
  });

  it('deduplicates stable utterance retries while rejecting conflicting identities', () => {
    const final = ingestFinalParticipantSegment(withQuestion(), participantFinal).aggregate;
    expectTranscriptError(
      () => ingestFinalParticipantSegment(final, { ...participantFinal, text: 'changed' }),
      'conflicting_final_segment',
    );
    const transportRetry = ingestFinalParticipantSegment(final, {
      ...participantFinal,
      providerEventId: 'another-provider-event',
      segmentId: 'another-segment',
      turnId: 'another-turn',
    });
    expect(transportRetry.status).toBe('duplicate');
    expect(transportRetry.turn.turnId).toBe(participantFinal.turnId);
    expectTranscriptError(
      () =>
        ingestFinalParticipantSegment(final, {
          ...participantFinal,
          utteranceId: 'another-utterance',
        }),
      'conflicting_final_segment',
    );
  });

  it('rejects guide references from another guide', () => {
    expectTranscriptError(
      () =>
        appendAiTranscriptTurn(withGreeting(), {
          ...mainQuestionInput,
          guideReference: { ...mainReference, guideId: 'guide-2' },
        }),
      'guide_mismatch',
    );
    expectTranscriptError(
      () =>
        ingestFinalParticipantSegment(withQuestion(), {
          ...participantFinal,
          guideReference: { ...mainReference, guideId: 'guide-2' },
        }),
      'guide_mismatch',
    );
  });

  it('rejects unknown and structurally misassigned guide questions', () => {
    expectTranscriptError(
      () =>
        appendAiTranscriptTurn(withGreeting(), {
          ...mainQuestionInput,
          guideReference: { ...mainReference, mainQuestionId: 'unknown-main' },
        }),
      'unknown_guide_question',
    );
    expectTranscriptError(
      () =>
        appendAiTranscriptTurn(withGreeting(), {
          ...mainQuestionInput,
          guideReference: { ...mainReference, sectionId: 'wrong-section' },
        }),
      'guide_question_mismatch',
    );
    expectTranscriptError(
      () =>
        ingestFinalParticipantSegment(withQuestion(), {
          ...participantFinal,
          guideReference: { ...mainReference, mainQuestionId: 'unknown-main' },
        }),
      'unknown_guide_question',
    );
    expectTranscriptError(
      () =>
        appendAiTranscriptTurn(withGreeting(), {
          ...mainQuestionInput,
          turnType: 'follow_up_question',
          guideReference: { ...followUpReference, mainQuestionId: 'wrong-parent' },
        }),
      'guide_question_mismatch',
    );
  });

  it('validates the immutable index structure and omits it only from canonical snapshots', () => {
    expectTranscriptError(
      () =>
        createTranscriptAggregate(INTERVIEW_ID, GUIDE_ID, [
          mainReference,
          { ...followUpReference, mainQuestionId: 'unknown-parent' },
        ]),
      'invalid_guide_index',
    );

    const aggregate = emptyAggregate();
    expect(Object.isFrozen(aggregate.guideQuestionIndex)).toBe(true);
    expect(JSON.stringify(aggregate)).toContain('follow-up-1');
    const snapshot = toCanonicalTranscriptSnapshot(completeTranscript(), T4);
    expect(Object.keys(snapshot)).toEqual(['interviewId', 'guideId', 'entries', 'finalizedAt']);
    expect(JSON.stringify(snapshot)).not.toContain('follow-up-1');
  });

  it('retains exact reference validation after a JSON persistence roundtrip', () => {
    const restored = JSON.parse(JSON.stringify(withGreeting())) as TranscriptAggregate;
    expect(appendAiTranscriptTurn(restored, mainQuestionInput).status).toBe('appended');
    expectTranscriptError(
      () =>
        appendAiTranscriptTurn(restored, {
          ...mainQuestionInput,
          guideReference: { ...mainReference, sectionId: 'wrong-after-restore' },
        }),
      'guide_question_mismatch',
    );
  });
});

describe('canonical AI turns and technical gaps', () => {
  it('stores only heard AI text and returns identical delivery retries as no-ops', () => {
    const input: AppendAiTurnInput = {
      ...mainQuestionInput,
      spokenText: 'Please describe the situation',
      delivery: { status: 'interrupted', interruptedAt: T2 },
    };
    const appended = appendAiTranscriptTurn(withGreeting(), input);
    const retry = appendAiTranscriptTurn(appended.aggregate, input);

    expect(appended.turn.text).toBe('Please describe the situation');
    expect(appended.turn.deliveryEventId).toBe('delivery-main-1');
    expect(retry.status).toBe('duplicate');
    expect(retry.aggregate).toBe(appended.aggregate);
    expectTranscriptError(
      () => appendAiTranscriptTurn(appended.aggregate, { ...input, spokenText: 'changed' }),
      'conflicting_ai_turn',
    );
  });

  it('returns identical gap retries as no-ops and rejects conflicting retries', () => {
    const input = {
      interviewId: INTERVIEW_ID,
      gapId: 'gap-1',
      sourceEventId: 'source-gap-1',
      source: 'speech_to_text' as const,
      sourceProvider: SOURCE_PROVIDER,
      relatedUtteranceId: 'utterance-lost',
      description: 'Final transcription was not received.',
      occurredAt: T2,
      relatedSegmentId: 'segment-lost',
    };
    const partial = ingestPartialParticipantSegment(withQuestion(), {
      interviewId: INTERVIEW_ID,
      sourceProvider: SOURCE_PROVIDER,
      utteranceId: 'utterance-lost',
      providerEventId: 'provider-partial-lost',
      segmentId: 'segment-lost',
      text: 'unconfirmed',
      revision: 0,
      observedAt: T1,
    }).aggregate;
    const appended = recordTranscriptTechnicalGap(partial, input);
    const retry = recordTranscriptTechnicalGap(appended.aggregate, input);

    expect(appended.status).toBe('appended');
    expect(appended.gap).toEqual({
      kind: 'technical_gap',
      gapId: 'gap-1',
      interviewId: INTERVIEW_ID,
      sequenceNumber: 3,
      sourceEventId: 'source-gap-1',
      source: 'speech_to_text',
      sourceProvider: SOURCE_PROVIDER,
      relatedUtteranceId: 'utterance-lost',
      description: input.description,
      occurredAt: T2,
      relatedSegmentId: 'segment-lost',
    });
    expect(appended.aggregate.partials).toEqual([]);
    expect(retry.status).toBe('duplicate');
    expect(retry.aggregate).toBe(appended.aggregate);
    expectTranscriptError(
      () => recordTranscriptTechnicalGap(appended.aggregate, { ...input, description: 'changed' }),
      'conflicting_gap',
    );
    expect(
      ingestPartialParticipantSegment(appended.aggregate, {
        interviewId: INTERVIEW_ID,
        sourceProvider: SOURCE_PROVIDER,
        utteranceId: input.relatedUtteranceId,
        providerEventId: 'late-partial-after-gap',
        segmentId: 'late-segment-after-gap',
        text: 'must remain non-canonical',
        revision: 2,
        observedAt: T3,
      }).status,
    ).toBe('ignored_finalized');
    expectTranscriptError(
      () =>
        ingestFinalParticipantSegment(appended.aggregate, {
          ...participantFinal,
          utteranceId: input.relatedUtteranceId,
          providerEventId: 'late-final-after-gap',
          segmentId: 'late-segment-after-gap',
          turnId: 'late-turn-after-gap',
        }),
      'conflicting_final_segment',
    );
    expectTranscriptError(
      () =>
        ingestFinalParticipantSegment(appended.aggregate, {
          ...participantFinal,
          utteranceId: 'different-utterance-after-gap',
          providerEventId: 'late-final-same-segment-after-gap',
          segmentId: input.relatedSegmentId,
          turnId: 'late-turn-same-segment-after-gap',
        }),
      'conflicting_final_segment',
    );
    expectTranscriptError(
      () =>
        recordTranscriptTechnicalGap(appended.aggregate, {
          ...input,
          gapId: 'gap-same-segment-different-utterance',
          sourceEventId: 'source-gap-same-segment-different-utterance',
          relatedUtteranceId: 'different-gap-utterance',
        }),
      'conflicting_gap',
    );
  });

  it('keeps STT gap source identities isolated by provider', () => {
    const gapped = recordTranscriptTechnicalGap(withGreeting(), {
      interviewId: INTERVIEW_ID,
      gapId: 'foreign-provider-gap',
      sourceEventId: 'foreign-provider-gap-event',
      source: 'speech_to_text',
      sourceProvider: 'foreign-stt',
      relatedUtteranceId: 'foreign-utterance',
      description: 'A different provider reported a gap.',
      occurredAt: T1,
      relatedSegmentId: participantFinal.segmentId,
    }).aggregate;
    const questioned = appendAiTranscriptTurn(gapped, {
      ...mainQuestionInput,
      occurredAt: T2,
    }).aggregate;

    const result = ingestFinalParticipantSegment(questioned, {
      ...participantFinal,
      occurredAt: T3,
      observedAt: T3,
      finalizedAt: T3,
    });

    expect(result.status).toBe('appended');
  });

  it('detects persisted STT gaps that share a provider segment', () => {
    const first = recordTranscriptTechnicalGap(withGreeting(), {
      interviewId: INTERVIEW_ID,
      gapId: 'persisted-gap-one',
      sourceEventId: 'persisted-gap-event-one',
      source: 'speech_to_text',
      sourceProvider: SOURCE_PROVIDER,
      relatedUtteranceId: 'persisted-gap-utterance-one',
      description: 'First persisted gap.',
      occurredAt: T1,
      relatedSegmentId: 'persisted-shared-gap-segment',
    }).aggregate;
    const corrupted: TranscriptAggregate = {
      ...first,
      nextSequenceNumber: first.nextSequenceNumber + 1,
      entries: [
        ...first.entries,
        {
          kind: 'technical_gap',
          interviewId: INTERVIEW_ID,
          sequenceNumber: first.nextSequenceNumber,
          gapId: 'persisted-gap-two',
          sourceEventId: 'persisted-gap-event-two',
          source: 'speech_to_text',
          sourceProvider: SOURCE_PROVIDER,
          relatedUtteranceId: 'persisted-gap-utterance-two',
          description: 'Second persisted gap for the same provider segment.',
          occurredAt: T2,
          relatedSegmentId: 'persisted-shared-gap-segment',
        },
      ],
    };

    expect(issueCodes(corrupted)).toContain('duplicate_segment_id');
  });

  it('rejects an STT gap whose provider segment already has a final', () => {
    const aggregate = ingestFinalParticipantSegment(withQuestion(), participantFinal).aggregate;

    expectTranscriptError(
      () =>
        recordTranscriptTechnicalGap(aggregate, {
          interviewId: INTERVIEW_ID,
          gapId: 'gap-after-final',
          sourceEventId: 'source-gap-after-final',
          source: 'speech_to_text',
          sourceProvider: participantFinal.sourceProvider,
          relatedUtteranceId: 'different-gap-utterance',
          description: 'A late gap must not replace the final transcript.',
          occurredAt: T3,
          relatedSegmentId: participantFinal.segmentId,
        }),
      'conflicting_gap',
    );
    expect(aggregate.entries).toHaveLength(3);
    expect(aggregate.nextSequenceNumber).toBe(4);
  });

  it('detects a persisted final and STT gap sharing a provider segment', () => {
    const aggregate = ingestFinalParticipantSegment(withQuestion(), participantFinal).aggregate;
    const corrupted: TranscriptAggregate = {
      ...aggregate,
      nextSequenceNumber: 5,
      entries: [
        ...aggregate.entries,
        {
          kind: 'technical_gap',
          interviewId: INTERVIEW_ID,
          sequenceNumber: 4,
          gapId: 'persisted-segment-gap',
          sourceEventId: 'persisted-segment-gap-event',
          source: 'speech_to_text',
          sourceProvider: participantFinal.sourceProvider,
          relatedUtteranceId: 'different-gap-utterance',
          description: 'Corrupt duplicate representation of a final segment.',
          occurredAt: T3,
          relatedSegmentId: participantFinal.segmentId,
        },
      ],
    };

    expect(issueCodes(corrupted)).toContain('conflicting_finalization_record');
  });

  it('enforces globally unique canonical entry IDs across turns and gaps', () => {
    const gap = recordTranscriptTechnicalGap(emptyAggregate(), {
      interviewId: INTERVIEW_ID,
      gapId: 'shared-id',
      sourceEventId: 'source-gap-1',
      source: 'transport',
      sourceProvider: null,
      relatedUtteranceId: null,
      description: 'Transport unavailable.',
      occurredAt: T0,
      relatedSegmentId: null,
    }).aggregate;
    expectTranscriptError(
      () => appendAiTranscriptTurn(gap, { ...mainQuestionInput, turnId: 'shared-id' }),
      'duplicate_entry_id',
    );
  });

  it('uses monotonic sequenceNumber and rejects timestamp regression', () => {
    const transcript = ingestFinalParticipantSegment(withQuestion(), participantFinal).aggregate;
    expect(transcript.entries.map((entry) => entry.sequenceNumber)).toEqual([1, 2, 3]);
    expect(transcript.nextSequenceNumber).toBe(4);
    expectTranscriptError(
      () =>
        appendAiTranscriptTurn(transcript, {
          interviewId: INTERVIEW_ID,
          turnId: 'transition-1',
          deliveryEventId: 'delivery-transition-1',
          turnType: 'transition',
          spokenText: 'Thank you.',
          occurredAt: T1,
          guideReference: mainReference,
          delivery: { status: 'complete' },
        }),
      'timestamp_regression',
    );
  });
});

describe('final transcript validation', () => {
  it('accepts complete grammar and explicitly checks required main questions', () => {
    const complete = completeTranscript();
    expect(
      validateFinalTranscript(complete, {
        requiredMainQuestionIds: ['main-1'],
        requireAnswersForRequiredMainQuestions: true,
      }),
    ).toEqual({ valid: true, issues: [] });
    expect(
      validateFinalTranscript(complete, { requiredMainQuestionIds: ['main-1', 'main-2'] }).issues,
    ).toContainEqual(expect.objectContaining({ code: 'missing_required_main_question' }));
  });

  it('detects persisted canonical text beyond the shared limits', () => {
    const complete = completeTranscript();
    const oversizedTurn: TranscriptAggregate = {
      ...complete,
      entries: complete.entries.map((entry) =>
        entry.kind === 'turn' && entry.turnType === 'closing'
          ? { ...entry, text: 't'.repeat(20_001) }
          : entry,
      ),
    };

    const questionWithGap = recordTranscriptTechnicalGap(withQuestion(), {
      interviewId: INTERVIEW_ID,
      gapId: 'gap-persisted-description-limit',
      sourceEventId: 'source-persisted-description-limit',
      source: 'speech_to_text',
      sourceProvider: SOURCE_PROVIDER,
      relatedUtteranceId: 'utterance-persisted-description-limit',
      description: 'g'.repeat(1_000),
      occurredAt: T2,
      relatedSegmentId: null,
    }).aggregate;
    const closedWithGap = appendAiTranscriptTurn(questionWithGap, {
      interviewId: INTERVIEW_ID,
      turnId: 'turn-closing-persisted-description-limit',
      deliveryEventId: 'delivery-closing-persisted-description-limit',
      turnType: 'closing',
      spokenText: 'Thank you for participating.',
      occurredAt: T3,
      guideReference: null,
      delivery: { status: 'complete' },
    }).aggregate;
    const oversizedGap: TranscriptAggregate = {
      ...closedWithGap,
      entries: closedWithGap.entries.map((entry) =>
        entry.kind === 'technical_gap' ? { ...entry, description: 'g'.repeat(1_001) } : entry,
      ),
    };

    expect(issueCodes(oversizedTurn)).toEqual(['invalid_text']);
    expect(issueCodes(oversizedGap)).toEqual(['invalid_text']);
    expectTranscriptError(
      () => toCanonicalTranscriptSnapshot(oversizedTurn, T4),
      'invalid_transcript',
    );
    expectTranscriptError(
      () => toCanonicalTranscriptSnapshot(oversizedGap, T4),
      'invalid_transcript',
    );
  });

  it('requires exactly one greeting and requires it to be first', () => {
    const noGreeting = appendAiTranscriptTurn(emptyAggregate(), mainQuestionInput).aggregate;
    expect(issueCodes(noGreeting)).toContain('missing_greeting');

    const secondGreeting = appendAiTranscriptTurn(withGreeting(), {
      interviewId: INTERVIEW_ID,
      turnId: 'turn-greeting-2',
      deliveryEventId: 'delivery-greeting-2',
      turnType: 'greeting',
      spokenText: 'Welcome again.',
      occurredAt: T1,
      guideReference: null,
      delivery: { status: 'complete' },
    }).aggregate;
    expect(issueCodes(secondGreeting)).toContain('multiple_greetings');

    const greetingAfterQuestion = appendAiTranscriptTurn(noGreeting, {
      interviewId: INTERVIEW_ID,
      turnId: 'turn-greeting-late',
      deliveryEventId: 'delivery-greeting-late',
      turnType: 'greeting',
      spokenText: 'Welcome late.',
      occurredAt: T2,
      guideReference: null,
      delivery: { status: 'complete' },
    }).aggregate;
    expect(issueCodes(greetingAfterQuestion)).toContain('greeting_not_first');
  });

  it('requires a main question and a question before every participant answer', () => {
    const aggregate = withGreeting();
    expectTranscriptError(
      () => ingestFinalParticipantSegment(aggregate, participantFinal),
      'participant_without_question',
    );
    expect(aggregate.entries).toHaveLength(1);
    expect(aggregate.finals).toEqual([]);

    const answerWithoutQuestion: TranscriptAggregate = {
      ...aggregate,
      nextSequenceNumber: 3,
      entries: [
        ...aggregate.entries,
        {
          kind: 'turn',
          interviewId: INTERVIEW_ID,
          sequenceNumber: 2,
          turnId: participantFinal.turnId,
          sourceProvider: participantFinal.sourceProvider,
          providerEventId: participantFinal.providerEventId,
          speaker: 'participant',
          turnType: 'participant_answer',
          text: participantFinal.text,
          occurredAt: participantFinal.occurredAt,
          guideReference: participantFinal.guideReference,
          sourceSegmentId: participantFinal.segmentId,
        },
      ],
      finals: [{ ...participantFinal }],
    };
    const codes = issueCodes(answerWithoutQuestion);
    expect(codes).toContain('missing_main_question');
    expect(codes).toContain('participant_without_question');
  });

  it('rejects a participant answer that does not reference the immediately open question', () => {
    const aggregate = withQuestion();

    expectTranscriptError(
      () =>
        ingestFinalParticipantSegment(aggregate, {
          ...participantFinal,
          guideReference: followUpReference,
        }),
      'participant_question_reference_mismatch',
    );
    expect(aggregate.entries).toHaveLength(2);
    expect(aggregate.finals).toEqual([]);
    expect(aggregate.nextSequenceNumber).toBe(3);
  });

  it('detects a persisted participant reference that differs from its open question', () => {
    const answered = ingestFinalParticipantSegment(withQuestion(), participantFinal).aggregate;
    const corrupt: TranscriptAggregate = {
      ...answered,
      entries: answered.entries.map((entry) =>
        entry.kind === 'turn' && entry.speaker === 'participant'
          ? { ...entry, guideReference: followUpReference }
          : entry,
      ),
      finals: answered.finals.map((final) => ({
        ...final,
        guideReference: followUpReference,
      })),
    };
    const closed = appendAiTranscriptTurn(corrupt, {
      interviewId: INTERVIEW_ID,
      turnId: 'turn-closing-after-mismatched-reference',
      deliveryEventId: 'delivery-closing-after-mismatched-reference',
      turnType: 'closing',
      spokenText: 'Thank you for participating.',
      occurredAt: T3,
      guideReference: null,
      delivery: { status: 'complete' },
    }).aggregate;

    expect(issueCodes(closed)).toEqual(['participant_question_reference_mismatch']);
    expectTranscriptError(() => toCanonicalTranscriptSnapshot(closed, T4), 'invalid_transcript');
  });

  it('rejects consecutive participant answers and duplicate source segments', () => {
    const first = ingestFinalParticipantSegment(withQuestion(), participantFinal).aggregate;
    const secondInput: FinalParticipantSegmentInput = {
      ...participantFinal,
      providerEventId: 'provider-final-2',
      utteranceId: 'utterance-2',
      segmentId: 'segment-2',
      turnId: 'turn-answer-2',
      occurredAt: T3,
      observedAt: T3,
      finalizedAt: T3,
    };
    expectTranscriptError(
      () => ingestFinalParticipantSegment(first, secondInput),
      'participant_without_question',
    );
    const consecutive: TranscriptAggregate = {
      ...first,
      nextSequenceNumber: 5,
      entries: [
        ...first.entries,
        {
          kind: 'turn',
          interviewId: INTERVIEW_ID,
          sequenceNumber: 4,
          turnId: secondInput.turnId,
          sourceProvider: secondInput.sourceProvider,
          providerEventId: secondInput.providerEventId,
          speaker: 'participant',
          turnType: 'participant_answer',
          text: secondInput.text,
          occurredAt: secondInput.occurredAt,
          guideReference: secondInput.guideReference,
          sourceSegmentId: secondInput.segmentId,
        },
      ],
      finals: [...first.finals, { ...secondInput }],
    };
    expect(issueCodes(consecutive)).toEqual(
      expect.arrayContaining(['consecutive_participant_answers', 'participant_without_question']),
    );

    const secondTurn = consecutive.entries.find(
      (entry) => entry.kind === 'turn' && entry.turnId === 'turn-answer-2',
    )!;
    const corrupt: TranscriptAggregate = {
      ...consecutive,
      entries: consecutive.entries.map((entry) =>
        entry === secondTurn && entry.kind === 'turn' && entry.speaker === 'participant'
          ? { ...entry, sourceSegmentId: 'segment-1' }
          : entry,
      ),
    };
    expect(issueCodes(corrupt)).toContain('duplicate_participant_source_segment');
  });

  it('requires a terminal closing and an answer to the last question', () => {
    expect(issueCodes(withQuestion())).toEqual(
      expect.arrayContaining(['missing_closing', 'unanswered_last_question']),
    );

    const complete = completeTranscript();
    const afterClosing = recordTranscriptTechnicalGap(complete, {
      interviewId: INTERVIEW_ID,
      gapId: 'gap-after-close',
      sourceEventId: 'source-after-close',
      source: 'transport',
      sourceProvider: null,
      relatedUtteranceId: null,
      description: 'Late transport marker.',
      occurredAt: T4,
      relatedSegmentId: null,
    }).aggregate;
    expect(issueCodes(afterClosing)).toContain('closing_not_terminal');
  });

  it('rejects a new question before the prior question has an answer or STT gap', () => {
    const withClarification = appendAiTranscriptTurn(withQuestion(), {
      interviewId: INTERVIEW_ID,
      turnId: 'turn-clarification-before-answer',
      deliveryEventId: 'delivery-clarification-before-answer',
      turnType: 'clarification_question',
      spokenText: 'Could you make that more concrete?',
      occurredAt: T2,
      guideReference: mainReference,
      delivery: { status: 'complete' },
    }).aggregate;
    const answeredClarification = ingestFinalParticipantSegment(withClarification, {
      ...participantFinal,
      providerEventId: 'provider-final-clarification',
      utteranceId: 'utterance-clarification',
      segmentId: 'segment-clarification',
      turnId: 'turn-answer-clarification',
      occurredAt: T3,
      observedAt: T3,
      finalizedAt: T3,
    }).aggregate;
    const closedAfterAnswer = appendAiTranscriptTurn(answeredClarification, {
      interviewId: INTERVIEW_ID,
      turnId: 'turn-closing-after-clarification',
      deliveryEventId: 'delivery-closing-after-clarification',
      turnType: 'closing',
      spokenText: 'Thank you for participating.',
      occurredAt: T4,
      guideReference: null,
      delivery: { status: 'complete' },
    }).aggregate;

    expect(issueCodes(closedAfterAnswer)).toContain('unanswered_question_before_next_question');

    const gapAfterClarification = recordTranscriptTechnicalGap(withClarification, {
      interviewId: INTERVIEW_ID,
      gapId: 'gap-after-replacing-question',
      sourceEventId: 'source-gap-after-replacing-question',
      source: 'speech_to_text',
      sourceProvider: SOURCE_PROVIDER,
      relatedUtteranceId: 'utterance-lost-clarification',
      description: 'The response to the clarification could not be transcribed.',
      occurredAt: T3,
      relatedSegmentId: 'segment-lost-clarification',
    }).aggregate;
    const closedAfterGap = appendAiTranscriptTurn(gapAfterClarification, {
      interviewId: INTERVIEW_ID,
      turnId: 'turn-closing-after-replaced-question-gap',
      deliveryEventId: 'delivery-closing-after-replaced-question-gap',
      turnType: 'closing',
      spokenText: 'Thank you for participating.',
      occurredAt: T4,
      guideReference: null,
      delivery: { status: 'complete' },
    }).aggregate;

    expect(issueCodes(closedAfterGap)).toEqual(
      expect.arrayContaining([
        'unanswered_question_before_next_question',
        'unanswered_required_main_question',
      ]),
    );
  });

  it('exports known gaps and early endings while retaining finalization findings', () => {
    const questionWithGap = recordTranscriptTechnicalGap(withQuestion(), {
      interviewId: INTERVIEW_ID,
      gapId: 'gap-unanswered',
      sourceEventId: 'source-unanswered',
      source: 'speech_to_text',
      sourceProvider: SOURCE_PROVIDER,
      relatedUtteranceId: 'utterance-unanswered',
      description: 'A final participant transcription was not available.',
      occurredAt: T2,
      relatedSegmentId: null,
    }).aggregate;
    const closedWithGap = appendAiTranscriptTurn(questionWithGap, {
      interviewId: INTERVIEW_ID,
      turnId: 'turn-closing-after-gap',
      deliveryEventId: 'delivery-closing-after-gap',
      turnType: 'closing',
      spokenText: 'Thank you for participating.',
      occurredAt: T3,
      guideReference: null,
      delivery: { status: 'complete' },
    }).aggregate;

    expect(issueCodes(closedWithGap)).toEqual([]);
    expect(toCanonicalTranscriptSnapshot(closedWithGap, T4).entries).toContainEqual(
      expect.objectContaining({ kind: 'technical_gap', gapId: 'gap-unanswered' }),
    );

    const audioGap = recordTranscriptTechnicalGap(withQuestion(), {
      interviewId: INTERVIEW_ID,
      gapId: 'gap-audio-unanswered',
      sourceEventId: 'audio-source-unanswered',
      source: 'audio_output',
      sourceProvider: null,
      relatedUtteranceId: null,
      description: 'Audio playback could not be confirmed.',
      occurredAt: T2,
      relatedSegmentId: null,
    }).aggregate;
    const closedWithAudioGap = appendAiTranscriptTurn(audioGap, {
      interviewId: INTERVIEW_ID,
      turnId: 'turn-closing-after-audio-gap',
      deliveryEventId: 'delivery-closing-after-audio-gap',
      turnType: 'closing',
      spokenText: 'Thank you for participating.',
      occurredAt: T3,
      guideReference: null,
      delivery: { status: 'complete' },
    }).aggregate;
    expect(issueCodes(closedWithAudioGap)).toContain('unanswered_last_question');

    const endedEarly = appendAiTranscriptTurn(withGreeting(), {
      interviewId: INTERVIEW_ID,
      turnId: 'turn-early-closing',
      deliveryEventId: 'delivery-early-closing',
      turnType: 'closing',
      spokenText: 'Das Interview wurde vorzeitig beendet.',
      occurredAt: T1,
      guideReference: null,
      delivery: { status: 'complete' },
    }).aggregate;
    expect(issueCodes(endedEarly)).toContain('missing_main_question');
    expect(toCanonicalTranscriptSnapshot(endedEarly, T2).entries).toHaveLength(2);
  });

  it('requires every main question in the guide index by default', () => {
    const secondMainReference = {
      kind: 'main_question' as const,
      guideId: GUIDE_ID,
      sectionId: 'section-1',
      mainQuestionId: 'main-2',
    };
    const incomplete: TranscriptAggregate = {
      ...completeTranscript(),
      guideQuestionIndex: [mainReference, followUpReference, secondMainReference],
    };

    expect(issueCodes(incomplete)).toContain('missing_required_main_question');
  });

  it('blocks snapshots with duplicate provider utterance identities', () => {
    const firstAnswer = ingestFinalParticipantSegment(withQuestion(), participantFinal).aggregate;
    const followUp = appendAiTranscriptTurn(firstAnswer, {
      interviewId: INTERVIEW_ID,
      turnId: 'turn-follow-up-duplicate-utterance',
      deliveryEventId: 'delivery-follow-up-duplicate-utterance',
      turnType: 'follow_up_question',
      spokenText: 'How long have you held that role?',
      occurredAt: T3,
      guideReference: followUpReference,
      delivery: { status: 'complete' },
    }).aggregate;
    const secondAnswer = ingestFinalParticipantSegment(followUp, {
      ...participantFinal,
      utteranceId: 'utterance-2',
      providerEventId: 'provider-final-2',
      segmentId: 'segment-2',
      turnId: 'turn-answer-2',
      text: 'For three years.',
      occurredAt: T4,
      observedAt: T4,
      finalizedAt: T4,
      guideReference: followUpReference,
    }).aggregate;
    const closed = appendAiTranscriptTurn(secondAnswer, {
      interviewId: INTERVIEW_ID,
      turnId: 'turn-closing-duplicate-utterance',
      deliveryEventId: 'delivery-closing-duplicate-utterance',
      turnType: 'closing',
      spokenText: 'Thank you for participating.',
      occurredAt: T5,
      guideReference: null,
      delivery: { status: 'complete' },
    }).aggregate;
    const corrupted: TranscriptAggregate = {
      ...closed,
      finals: closed.finals.map((final, index) =>
        index === 1 ? { ...final, utteranceId: participantFinal.utteranceId } : final,
      ),
    };

    expect(issueCodes(corrupted)).toEqual(['duplicate_utterance_id']);
    expectTranscriptError(() => toCanonicalTranscriptSnapshot(corrupted, T6), 'invalid_transcript');
  });

  it('blocks export until every partial is finalized or represented by a technical gap', () => {
    const partial = ingestPartialParticipantSegment(withQuestion(), {
      interviewId: INTERVIEW_ID,
      sourceProvider: SOURCE_PROVIDER,
      utteranceId: 'utterance-unresolved',
      providerEventId: 'provider-partial-unresolved',
      segmentId: 'segment-unresolved',
      text: 'This speech was not finalized.',
      revision: 0,
      observedAt: T2,
    }).aggregate;
    const closed = appendAiTranscriptTurn(partial, {
      interviewId: INTERVIEW_ID,
      turnId: 'turn-closing-with-unresolved-partial',
      deliveryEventId: 'delivery-closing-with-unresolved-partial',
      turnType: 'closing',
      spokenText: 'Thank you for participating.',
      occurredAt: T3,
      guideReference: null,
      delivery: { status: 'complete' },
    }).aggregate;

    expect(issueCodes(closed)).toContain('unresolved_partial_segment');
    expectTranscriptError(() => toCanonicalTranscriptSnapshot(closed, T4), 'invalid_transcript');

    const recovered = recordTranscriptTechnicalGap(closed, {
      interviewId: INTERVIEW_ID,
      gapId: 'gap-for-unresolved-partial',
      sourceEventId: 'source-for-unresolved-partial',
      source: 'speech_to_text',
      sourceProvider: SOURCE_PROVIDER,
      relatedUtteranceId: 'utterance-unresolved',
      description: 'The participant audio did not produce a final transcription.',
      occurredAt: T4,
      relatedSegmentId: 'segment-unresolved',
    }).aggregate;

    expect(recovered.partials).toEqual([]);
    expect(
      toCanonicalTranscriptSnapshot(recovered, '2026-08-06T10:05:00.000Z').entries,
    ).toContainEqual(
      expect.objectContaining({
        kind: 'technical_gap',
        relatedSegmentId: 'segment-unresolved',
      }),
    );
  });

  it('detects corrupt routing, sequence, guide, partial, and next-sequence state', () => {
    const complete = completeTranscript();
    const corrupt: TranscriptAggregate = {
      ...complete,
      nextSequenceNumber: 99,
      entries: complete.entries.map((entry) =>
        entry.kind === 'turn' && entry.turnType === 'main_question'
          ? {
              ...entry,
              interviewId: 'other-interview',
              sequenceNumber: 1,
              guideReference: { ...mainReference, guideId: 'other-guide' },
            }
          : entry,
      ),
      partials: [
        {
          interviewId: 'other-interview',
          sourceProvider: SOURCE_PROVIDER,
          utteranceId: 'utterance-1',
          providerEventId: 'provider-final-1',
          segmentId: 'segment-1',
          text: 'late',
          revision: 2,
          observedAt: T4,
        },
      ],
    };
    expect(issueCodes(corrupt)).toEqual(
      expect.arrayContaining([
        'invalid_next_sequence',
        'non_monotonic_sequence',
        'interview_mismatch',
        'guide_mismatch',
        'late_partial_segment',
        'duplicate_provider_event_id',
      ]),
    );
  });

  it('checks exact guide-question membership during final validation', () => {
    const complete = completeTranscript();
    const mainTurn = complete.entries.find(
      (entry) => entry.kind === 'turn' && entry.turnType === 'main_question',
    );
    expect(mainTurn).toBeDefined();
    Object.assign(mainTurn!, {
      guideReference: { ...mainReference, sectionId: 'wrong-section' },
    });

    expect(issueCodes(complete)).toContain('guide_question_mismatch');
  });
});
