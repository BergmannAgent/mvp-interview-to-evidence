import { mvpInterviewSessionSchema } from '@orgscience/contracts';
import {
  initializeGuideCoverage,
  type GuideCoverageState,
  type InterviewGuideSnapshot,
  type InterviewLifecycleState,
  type TranscriptAggregate,
} from '@orgscience/domain';
import { describe, expect, it } from 'vitest';

import type { PersistedInterview, StoredFinalization } from '../persistence/index.js';
import { projectCanonicalSession } from './canonical-session-projection.js';

const INTERVIEW_ID = 'interview-projection-1';
const GUIDE_ID = 'guide-projection-1';
const T0 = '2026-08-14T08:00:00.000Z';
const T1 = '2026-08-14T08:01:00.000Z';
const T2 = '2026-08-14T08:02:00.000Z';
const T3 = '2026-08-14T08:03:00.000Z';
const T4 = '2026-08-14T08:04:00.000Z';
const T5 = '2026-08-14T08:05:00.000Z';
const T6 = '2026-08-14T08:06:00.000Z';
const T7 = '2026-08-14T08:07:00.000Z';
const T8 = '2026-08-14T08:08:00.000Z';
const T9 = '2026-08-14T08:09:00.000Z';

const mainReference = {
  kind: 'main_question' as const,
  guideId: GUIDE_ID,
  sectionId: 'section-1',
  mainQuestionId: 'main-1',
};
const followUpReference = {
  kind: 'follow_up_question' as const,
  guideId: GUIDE_ID,
  sectionId: 'section-1',
  mainQuestionId: 'main-1',
  followUpQuestionId: 'follow-up-1',
};
const secondMainReference = {
  kind: 'main_question' as const,
  guideId: GUIDE_ID,
  sectionId: 'section-1',
  mainQuestionId: 'main-2',
};

const guide: InterviewGuideSnapshot = {
  id: GUIDE_ID,
  sourceLanguage: 'de',
  title: 'Interviewleitfaden',
  sourceMarkdown: '# Interviewleitfaden',
  createdAt: T0,
  sections: [
    {
      id: 'section-1',
      position: 0,
      title: 'Einfuehrung',
      mainQuestions: [
        {
          id: 'main-1',
          position: 0,
          text: 'Welche Rolle haben Sie?',
          followUpQuestions: [
            { id: 'follow-up-1', position: 0, text: 'Seit wann arbeiten Sie dort?' },
          ],
        },
        {
          id: 'main-2',
          position: 1,
          text: 'Was ist Ihnen besonders wichtig?',
          followUpQuestions: [],
        },
      ],
    },
  ],
};

describe('projectCanonicalSession', () => {
  it('projects canonical turns, gaps, interruption state, current question, and latest partial', () => {
    const transcript = activeTranscript();
    const result = projectCanonicalSession({
      guide,
      interview: persistedInterview(activeLifecycle(), currentFollowUpCoverage()),
      transcript,
      finalization: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(mvpInterviewSessionSchema.safeParse(result.value).success).toBe(true);
    expect(result.value).toMatchObject({
      status: 'active',
      stateVersion: 1,
      currentQuestionIndex: 1,
      totalQuestions: 3,
      currentQuestion: {
        questionId: 'follow-up-1',
        kind: 'follow_up',
        reference: followUpReference,
      },
      partialTranscript: 'Aktuellste offene Teilantwort',
      finalizedAt: null,
      updatedAt: T7,
    });
    expect(result.value.transcript.map((turn) => turn.sequenceNumber)).toEqual([1, 3, 4]);
    expect(result.value.transcript.map((turn) => turn.interrupted)).toEqual([false, true, false]);
    expect(result.value.technicalGaps).toEqual([
      {
        gapId: 'gap-1',
        interviewId: INTERVIEW_ID,
        sequenceNumber: 2,
        source: 'audio_output',
        description: 'Audioausgabe war kurz nicht verfuegbar.',
        occurredAt: T2,
      },
    ]);
  });

  it('projects finalization timestamps and suppresses partial text for a completed session', () => {
    const transcript = activeTranscript();
    const result = projectCanonicalSession({
      guide,
      interview: persistedInterview(
        completedLifecycle(),
        initializeGuideCoverage(guide, INTERVIEW_ID),
      ),
      transcript,
      finalization: storedFinalization(transcript),
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        status: 'completed',
        currentQuestionIndex: 3,
        currentQuestion: null,
        startedAt: T1,
        endedAt: T8,
        updatedAt: T9,
        partialTranscript: null,
        finalizedAt: T9,
      },
    });
  });

  it('does not expose a partial segment that already has a canonical final', () => {
    const base = activeTranscript();
    const resolvedPartial = {
      interviewId: INTERVIEW_ID,
      sourceProvider: 'openai-realtime',
      utteranceId: 'utterance-final-1',
      providerEventId: 'provider-partial-resolved',
      segmentId: 'segment-final-1',
      text: 'Bereits finalisierte Teilantwort',
      revision: 2,
      observedAt: T8,
    };
    const result = projectCanonicalSession({
      guide,
      interview: persistedInterview(activeLifecycle(), currentFollowUpCoverage()),
      transcript: { ...base, partials: [...base.partials, resolvedPartial] },
      finalization: null,
    });

    expect(result).toMatchObject({
      ok: true,
      value: { partialTranscript: 'Aktuellste offene Teilantwort' },
    });
  });

  it.each([
    ['ready', readyLifecycle(), 'ready', 0, 'main-1', null],
    ['paused', pausedLifecycle(), 'paused', 0, 'main-1', null],
    ['ending', endingLifecycle(), 'active', 3, null, null],
    ['failed', failedLifecycle(), 'completed', 3, null, T3],
  ] as const)(
    'maps the %s lifecycle into the compatibility status',
    (_name, lifecycle, expectedStatus, expectedIndex, expectedQuestionId, expectedEndedAt) => {
      const result = projectCanonicalSession({
        guide,
        interview: persistedInterview(lifecycle, initializeGuideCoverage(guide, INTERVIEW_ID)),
        transcript: emptyTranscript(),
        finalization: null,
      });

      expect(result).toMatchObject({
        ok: true,
        value: {
          status: expectedStatus,
          currentQuestionIndex: expectedIndex,
          currentQuestion: expectedQuestionId === null ? null : { questionId: expectedQuestionId },
          endedAt: expectedEndedAt,
        },
      });
    },
  );

  it('fails closed when the transcript belongs to another interview', () => {
    const result = projectCanonicalSession({
      guide,
      interview: persistedInterview(readyLifecycle(), initializeGuideCoverage(guide, INTERVIEW_ID)),
      transcript: { ...emptyTranscript(), interviewId: 'interview-other' },
      finalization: null,
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'application_invariant',
        resource: 'interview_view',
        id: INTERVIEW_ID,
        message: 'Canonical session scopes are inconsistent',
      },
    });
  });
});

function persistedInterview(
  lifecycle: InterviewLifecycleState,
  coverage: GuideCoverageState,
): PersistedInterview {
  return {
    interviewId: INTERVIEW_ID,
    guideId: GUIDE_ID,
    lifecycle,
    coverage,
    version: lifecycle.revision,
    activeWorkflowRunId: null,
    createdAt: T0,
    updatedAt: lifecycleUpdatedAt(lifecycle),
  };
}

function lifecycleUpdatedAt(lifecycle: InterviewLifecycleState): string {
  switch (lifecycle.status) {
    case 'ready':
      return T0;
    case 'active':
      return T3;
    case 'paused':
    case 'ending':
      return T2;
    case 'completed':
      return T8;
    case 'failed':
      return T3;
  }
}

function currentFollowUpCoverage(): GuideCoverageState {
  const initial = initializeGuideCoverage(guide, INTERVIEW_ID);
  return {
    ...initial,
    revision: 1,
    questions: initial.questions.map((question) =>
      question.questionId === 'follow-up-1'
        ? { ...question, status: 'current', updatedAt: T1 }
        : question,
    ),
  };
}

function emptyTranscript(): TranscriptAggregate {
  return {
    interviewId: INTERVIEW_ID,
    guideId: GUIDE_ID,
    guideQuestionIndex: [mainReference, followUpReference, secondMainReference],
    nextSequenceNumber: 1,
    entries: [],
    partials: [],
    finals: [],
  };
}

function activeTranscript(): TranscriptAggregate {
  return {
    interviewId: INTERVIEW_ID,
    guideId: GUIDE_ID,
    guideQuestionIndex: [mainReference, followUpReference, secondMainReference],
    nextSequenceNumber: 5,
    entries: [
      {
        kind: 'turn',
        interviewId: INTERVIEW_ID,
        sequenceNumber: 1,
        turnId: 'turn-greeting',
        deliveryEventId: 'delivery-greeting',
        speaker: 'ai_interviewer',
        turnType: 'greeting',
        text: 'Guten Tag.',
        occurredAt: T1,
        guideReference: null,
        delivery: { status: 'complete' },
      },
      {
        kind: 'technical_gap',
        interviewId: INTERVIEW_ID,
        sequenceNumber: 2,
        gapId: 'gap-1',
        sourceEventId: 'gap-source-1',
        source: 'audio_output',
        description: 'Audioausgabe war kurz nicht verfuegbar.',
        occurredAt: T2,
        relatedSegmentId: null,
        sourceProvider: null,
        relatedUtteranceId: null,
      },
      {
        kind: 'turn',
        interviewId: INTERVIEW_ID,
        sequenceNumber: 3,
        turnId: 'turn-follow-up',
        deliveryEventId: 'delivery-follow-up',
        speaker: 'ai_interviewer',
        turnType: 'follow_up_question',
        text: 'Seit wann arbeiten Sie dort?',
        occurredAt: T3,
        guideReference: followUpReference,
        delivery: { status: 'interrupted', interruptedAt: T4 },
      },
      {
        kind: 'turn',
        interviewId: INTERVIEW_ID,
        sequenceNumber: 4,
        turnId: 'turn-answer',
        sourceProvider: 'openai-realtime',
        providerEventId: 'provider-final-1',
        speaker: 'participant',
        turnType: 'participant_answer',
        text: 'Seit drei Jahren.',
        occurredAt: T5,
        guideReference: followUpReference,
        sourceSegmentId: 'segment-final-1',
      },
    ],
    partials: [
      {
        interviewId: INTERVIEW_ID,
        sourceProvider: 'openai-realtime',
        utteranceId: 'utterance-open-1',
        providerEventId: 'provider-partial-1',
        segmentId: 'segment-open-1',
        text: 'Aeltere offene Teilantwort',
        revision: 1,
        observedAt: T6,
      },
      {
        interviewId: INTERVIEW_ID,
        sourceProvider: 'openai-realtime',
        utteranceId: 'utterance-open-2',
        providerEventId: 'provider-partial-2',
        segmentId: 'segment-open-2',
        text: 'Aktuellste offene Teilantwort',
        revision: 1,
        observedAt: T7,
      },
    ],
    finals: [
      {
        interviewId: INTERVIEW_ID,
        sourceProvider: 'openai-realtime',
        utteranceId: 'utterance-final-1',
        providerEventId: 'provider-final-1',
        segmentId: 'segment-final-1',
        turnId: 'turn-answer',
        text: 'Seit drei Jahren.',
        occurredAt: T5,
        observedAt: T5,
        finalizedAt: T6,
        guideReference: followUpReference,
      },
    ],
  };
}

function storedFinalization(transcript: TranscriptAggregate): StoredFinalization {
  return {
    interviewId: INTERVIEW_ID,
    finalizationId: 'finalization-1',
    stateVersion: 2,
    agentRunId: 'agent-finalization-1',
    finalizedAt: T9,
    deterministicValidation: { valid: true, issues: [] },
    agentReport: {
      status: 'valid_with_gaps',
      checkedCanonicalEntries: transcript.entries.map((entry) => ({
        entryId: entry.kind === 'turn' ? entry.turnId : entry.gapId,
        kind: entry.kind,
      })),
      checks: {
        chronologyValid: true,
        sequenceValid: true,
        speakerAssignmentsValid: true,
        noDuplicateTurns: true,
      },
      issues: [
        {
          code: 'technical_gap',
          severity: 'warning',
          canonicalEntryIds: ['gap-1'],
          description: 'Eine technische Audio-Luecke wurde kanonisch dokumentiert.',
        },
      ],
      rationale: 'Das Transkript ist vollstaendig, die technische Luecke bleibt sichtbar.',
    },
    transcriptFingerprint: 'fingerprint-1',
    entryCount: transcript.entries.length,
    technicalGapCount: 1,
  };
}

function readyLifecycle(): InterviewLifecycleState {
  return {
    status: 'ready',
    interviewId: INTERVIEW_ID,
    guideId: GUIDE_ID,
    createdAt: T0,
    revision: 0,
  };
}

function activeLifecycle(): InterviewLifecycleState {
  return {
    status: 'active',
    interviewId: INTERVIEW_ID,
    guideId: GUIDE_ID,
    createdAt: T0,
    revision: 1,
    startedAt: T1,
    activeSince: T1,
  };
}

function pausedLifecycle(): InterviewLifecycleState {
  return {
    status: 'paused',
    interviewId: INTERVIEW_ID,
    guideId: GUIDE_ID,
    createdAt: T0,
    revision: 1,
    startedAt: T1,
    pausedAt: T2,
  };
}

function endingLifecycle(): InterviewLifecycleState {
  return {
    status: 'ending',
    interviewId: INTERVIEW_ID,
    guideId: GUIDE_ID,
    createdAt: T0,
    revision: 2,
    startedAt: T1,
    endingAt: T2,
    endingFrom: 'active',
  };
}

function completedLifecycle(): InterviewLifecycleState {
  return {
    status: 'completed',
    interviewId: INTERVIEW_ID,
    guideId: GUIDE_ID,
    createdAt: T0,
    revision: 2,
    startedAt: T1,
    endingAt: T7,
    endedAt: T8,
  };
}

function failedLifecycle(): InterviewLifecycleState {
  return {
    status: 'failed',
    interviewId: INTERVIEW_ID,
    guideId: GUIDE_ID,
    createdAt: T0,
    revision: 1,
    startedAt: T1,
    failedAt: T3,
    failedFrom: 'active',
    failure: { code: 'provider_error', message: 'Realtime provider failed' },
  };
}
