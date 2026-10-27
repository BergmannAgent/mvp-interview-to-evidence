import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  canonicalTranscriptSchema,
  guideStructureSchema,
  INTERVIEW_GUIDE_LIMITS as CONTRACT_GUIDE_LIMITS,
  interviewGuideSchema,
  interviewLifecycleStateSchema,
} from '../packages/contracts/src/index.js';
import {
  appendAiTranscriptTurn,
  createReadyInterview,
  createTranscriptAggregate,
  ingestFinalParticipantSegment,
  initializeGuideCoverage,
  INTERVIEW_GUIDE_LIMITS as DOMAIN_GUIDE_LIMITS,
  parseInterviewGuideMarkdown,
  recordTranscriptTechnicalGap,
  toCanonicalTranscriptSnapshot,
  toInterviewGuideSnapshot,
  toInterviewLifecycleSnapshot,
  transitionInterview,
  type InterviewLifecycleAction,
  type InterviewLifecycleState,
} from '../packages/domain/src/index.js';

const T0 = '2026-08-06T10:00:00.000Z';
const T1 = '2026-08-06T10:01:00.000Z';
const T2 = '2026-08-06T10:02:00.000Z';
const T3 = '2026-08-06T10:03:00.000Z';
const T4 = '2026-08-06T10:04:00.000Z';
const T5 = '2026-08-06T10:05:00.000Z';

describe('foundation boundaries', () => {
  it('keeps guide cardinality limits aligned across domain and transport contracts', () => {
    expect(CONTRACT_GUIDE_LIMITS).toEqual(DOMAIN_GUIDE_LIMITS);
  });

  it('moves the committed guide from parser to coverage and persistence contracts', () => {
    const markdown = readFileSync(
      new URL('../examples/organizational-resilience.md', import.meta.url),
      'utf8',
    );
    const result = parseInterviewGuideMarkdown(markdown);
    if (!result.success) {
      throw new Error(result.issues.map((issue) => issue.message).join('\n'));
    }

    expect(guideStructureSchema.parse(result.guide)).toEqual(result.guide);
    expect(initializeGuideCoverage(result.guide, 'interview-1').questions).toHaveLength(17);

    const persisted = toInterviewGuideSnapshot(result.guide, markdown, T0);
    expect(interviewGuideSchema.parse(persisted)).toEqual(persisted);
  });

  it('projects every lifecycle variant into the shared lifecycle contract', () => {
    const snapshots: unknown[] = [];
    let state: InterviewLifecycleState = createReadyInterview({
      interviewId: 'interview-1',
      guideId: 'guide-1',
      createdAt: T0,
    });
    snapshots.push(toInterviewLifecycleSnapshot(state));

    for (const action of [
      { type: 'start', at: T1 },
      { type: 'pause', at: T2 },
      { type: 'resume', at: T3 },
      { type: 'begin_ending', at: T4 },
      { type: 'complete', at: T5 },
    ] satisfies readonly InterviewLifecycleAction[]) {
      state = applyLifecycleAction(state, action);
      snapshots.push(toInterviewLifecycleSnapshot(state));
    }

    const failed = applyLifecycleAction(
      createReadyInterview({ interviewId: 'interview-2', guideId: 'guide-1', createdAt: T0 }),
      {
        type: 'fail',
        at: T1,
        failure: { code: 'provider_unavailable', message: 'Provider unavailable' },
      },
    );
    snapshots.push(toInterviewLifecycleSnapshot(failed));

    expect(snapshots.map((snapshot) => interviewLifecycleStateSchema.parse(snapshot))).toEqual(
      snapshots,
    );
  });

  it('round-trips heard-only turns and a standalone technical gap through the canonical contract', () => {
    const guideId = 'guide-1';
    const interviewId = 'interview-1';
    const reference = {
      kind: 'main_question',
      guideId,
      sectionId: 'section-1',
      mainQuestionId: 'main-1',
    } as const;

    let transcript = createTranscriptAggregate(interviewId, guideId, [reference]);
    transcript = appendAiTranscriptTurn(transcript, {
      interviewId,
      turnId: 'turn-greeting',
      deliveryEventId: 'delivery-greeting',
      turnType: 'greeting',
      spokenText: 'Willkommen zum Interview.',
      occurredAt: T0,
      guideReference: null,
      delivery: { status: 'complete' },
    }).aggregate;
    transcript = appendAiTranscriptTurn(transcript, {
      interviewId,
      turnId: 'turn-main-1',
      deliveryEventId: 'delivery-main-1',
      turnType: 'main_question',
      spokenText: 'Welche Rolle haben Sie im Unternehmen?',
      occurredAt: T1,
      guideReference: reference,
      delivery: { status: 'complete' },
    }).aggregate;
    transcript = ingestFinalParticipantSegment(transcript, {
      interviewId,
      sourceProvider: 'demo-stt',
      utteranceId: 'utterance-1',
      providerEventId: 'provider-final-1',
      segmentId: 'segment-1',
      turnId: 'turn-answer-1',
      text: '  Ich leite das Resilienzprogramm.  ',
      occurredAt: T2,
      observedAt: T2,
      finalizedAt: T2,
      guideReference: reference,
    }).aggregate;
    transcript = recordTranscriptTechnicalGap(transcript, {
      interviewId,
      gapId: 'gap-1',
      sourceEventId: 'stt-gap-1',
      source: 'speech_to_text',
      sourceProvider: 'demo-stt',
      relatedUtteranceId: 'utterance-gap-1',
      description: 'Ein separates Audiosegment konnte nicht final transkribiert werden.',
      occurredAt: T3,
      relatedSegmentId: null,
    }).aggregate;
    transcript = appendAiTranscriptTurn(transcript, {
      interviewId,
      turnId: 'turn-closing',
      deliveryEventId: 'delivery-closing',
      turnType: 'closing',
      spokenText: 'Vielen Dank für Ihre Teilnahme.',
      occurredAt: T4,
      guideReference: null,
      delivery: { status: 'complete' },
    }).aggregate;

    const snapshot = toCanonicalTranscriptSnapshot(transcript, T5);
    expect(canonicalTranscriptSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot.entries[2]).toMatchObject({
      text: '  Ich leite das Resilienzprogramm.  ',
      providerEventId: 'provider-final-1',
    });
    expect(snapshot.entries[3]).toMatchObject({ kind: 'technical_gap', gapId: 'gap-1' });
  });
});

function applyLifecycleAction(
  state: InterviewLifecycleState,
  action: InterviewLifecycleAction,
): InterviewLifecycleState {
  const result = transitionInterview(state, action);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.state;
}
