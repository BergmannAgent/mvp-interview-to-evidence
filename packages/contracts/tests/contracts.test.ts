import { describe, expect, it } from 'vitest';

import {
  API_ERROR_LIMITS,
  AiTextStreamSequenceError,
  apiErrorEnvelopeSchema,
  canonicalTranscriptSchema,
  canonicalTranscriptTurnSchema,
  conductorOutputSchema,
  consistencyAnalysisOutputSchema,
  coverageAnalysisOutputSchema,
  guideQuestionReferenceSchema,
  guideImportResponseSchema,
  guideResponseSchema,
  guideStructureSchema,
  idSchema,
  INTERVIEW_GUIDE_LIMITS,
  interviewCreateRequestSchema,
  interviewCreateResponseSchema,
  interviewDecisionOutputSchema,
  interviewDetailResponseSchema,
  interviewGuideSchema,
  interviewListQuerySchema,
  interviewLifecycleStateSchema,
  interviewStateSchema,
  interviewSummaryPageSchema,
  livenessResponseSchema,
  monitoringEventSchema,
  mvpRealtimeTurnIntentRequestSchema,
  providerEventIdSchema,
  readinessResponseSchema,
  reduceAiTextStreamEvent,
  transcriptFinalizationReportSchema,
  transcriptProviderSchema,
  transcriptSegmentSchema,
  timestampSchema,
  workflowStepRunSchema,
} from '../src/index.js';

const ids = {
  guide: '01989f13-2ff8-7000-8000-000000000001',
  guideOther: '01989f13-2ff8-7000-8000-000000000002',
  section: '01989f13-2ff8-7000-8000-000000000003',
  main: '01989f13-2ff8-7000-8000-000000000004',
  followUp: '01989f13-2ff8-7000-8000-000000000005',
  interview: '01989f13-2ff8-7000-8000-000000000006',
  interviewOther: '01989f13-2ff8-7000-8000-000000000007',
  turn: '01989f13-2ff8-7000-8000-000000000008',
  turnTwo: '01989f13-2ff8-7000-8000-000000000009',
  segment: '01989f13-2ff8-7000-8000-00000000000a',
  utterance: '01989f13-2ff8-7000-8000-00000000000b',
  gap: '01989f13-2ff8-7000-8000-00000000000c',
  event: '01989f13-2ff8-7000-8000-00000000000d',
  run: '01989f13-2ff8-7000-8000-00000000000e',
  workflow: '01989f13-2ff8-7000-8000-00000000000f',
  contradiction: '01989f13-2ff8-7000-8000-000000000010',
  request: '01989f13-2ff8-7000-8000-000000000011',
} as const;

const now = '2026-08-06T10:00:00.000Z';
const later = '2026-08-06T10:00:01.000Z';
const mainReference = {
  kind: 'main_question',
  guideId: ids.guide,
  sectionId: ids.section,
  mainQuestionId: ids.main,
} as const;
const followUpReference = {
  kind: 'follow_up_question',
  guideId: ids.guide,
  sectionId: ids.section,
  mainQuestionId: ids.main,
  followUpQuestionId: ids.followUp,
} as const;

describe('Realtime turn intent contract', () => {
  it('allows a bounded repair and repetitions only for off-topic or misunderstood answers', () => {
    const repetition = {
      clientEventId: ids.event,
      action: 'repeat_question',
      questionId: ids.main,
      spokenText: 'Welche Rolle haben Sie?',
      answerDisposition: 'off_topic',
      missingAspect: null,
      requestedEvidenceType: null,
    };
    expect(mvpRealtimeTurnIntentRequestSchema.safeParse(repetition).success).toBe(true);
    expect(
      mvpRealtimeTurnIntentRequestSchema.safeParse({
        ...repetition,
        answerDisposition: 'question_misunderstood',
        repairAttempt: 1,
      }).success,
    ).toBe(true);
    for (const answerDisposition of ['answered', 'partial', 'declined', 'dont_know']) {
      expect(
        mvpRealtimeTurnIntentRequestSchema.safeParse({ ...repetition, answerDisposition }).success,
      ).toBe(false);
    }
    for (const repairAttempt of [-1, 2, 0.5, '1']) {
      expect(
        mvpRealtimeTurnIntentRequestSchema.safeParse({ ...repetition, repairAttempt }).success,
      ).toBe(false);
    }
  });

  it('accepts one guide-bounded question or a question-free completion only', () => {
    expect(
      mvpRealtimeTurnIntentRequestSchema.safeParse({
        clientEventId: ids.event,
        action: 'ask_follow_up_question',
        questionId: ids.followUp,
        spokenText: 'Koennen Sie das an einem konkreten Beispiel erlaeutern?',
        answerDisposition: 'answered',
        missingAspect: null,
        requestedEvidenceType: null,
      }).success,
    ).toBe(true);
    expect(
      mvpRealtimeTurnIntentRequestSchema.safeParse({
        clientEventId: ids.event,
        action: 'complete_interview',
        questionId: null,
        spokenText: 'Vielen Dank fuer das Gespraech.',
        answerDisposition: 'answered',
        missingAspect: null,
        requestedEvidenceType: null,
      }).success,
    ).toBe(true);
    expect(
      mvpRealtimeTurnIntentRequestSchema.safeParse({
        clientEventId: ids.event,
        action: 'ask_main_question',
        questionId: ids.main,
        spokenText: 'Was ist passiert? Und wer war beteiligt?',
        answerDisposition: 'answered',
        missingAspect: null,
        requestedEvidenceType: null,
      }).success,
    ).toBe(false);
    expect(
      mvpRealtimeTurnIntentRequestSchema.safeParse({
        clientEventId: ids.event,
        action: 'complete_interview',
        questionId: ids.main,
        spokenText: 'Sind wir fertig?',
        answerDisposition: 'answered',
        missingAspect: null,
        requestedEvidenceType: null,
      }).success,
    ).toBe(false);
  });

  it('requires one concrete missing aspect for a clarification', () => {
    const specific = {
      clientEventId: ids.event,
      action: 'ask_clarification_question',
      questionId: ids.main,
      spokenText: 'Welche konkreten Aufgaben uebernehmen Sie im digitalen Vertrieb selbst?',
      answerDisposition: 'partial',
      missingAspect: 'Aufgaben im digitalen Vertrieb',
      requestedEvidenceType: 'responsibility',
    } as const;

    expect(mvpRealtimeTurnIntentRequestSchema.safeParse(specific).success).toBe(true);
    expect(
      mvpRealtimeTurnIntentRequestSchema.safeParse({
        ...specific,
        spokenText: 'Koennen Sie Ihre letzte Antwort bitte noch etwas genauer erlaeutern?',
      }).success,
    ).toBe(true);
    expect(
      mvpRealtimeTurnIntentRequestSchema.safeParse({
        ...specific,
        answerDisposition: 'dont_know',
      }).success,
    ).toBe(false);
    expect(
      mvpRealtimeTurnIntentRequestSchema.safeParse({
        ...specific,
        action: 'ask_main_question',
      }).success,
    ).toBe(false);
  });
});

const guideStructure = {
  id: ids.guide,
  title: 'Interviewleitfaden: Organizational Resilience',
  sourceLanguage: 'de',
  sections: [
    {
      id: ids.section,
      position: 0,
      title: 'Einfuehrung',
      mainQuestions: [
        {
          id: ids.main,
          position: 0,
          text: 'Welche Rolle haben Sie im Unternehmen?',
          followUpQuestions: [
            {
              id: ids.followUp,
              position: 0,
              text: 'Seit wann arbeiten Sie in dieser Position?',
            },
          ],
        },
      ],
    },
  ],
} as const;

describe('shared primitives', () => {
  it('requires explicit offsets and exact millisecond timestamp precision', () => {
    for (const valid of [
      '2026-08-06T10:00:00.000Z',
      '2026-08-06T12:00:00.000+02:00',
      '2026-08-06T04:30:00.123-05:30',
    ]) {
      expect(timestampSchema.safeParse(valid).success).toBe(true);
    }

    for (const invalid of [
      '2026-08-06',
      '2026-08-06T10:00:00Z',
      '2026-08-06T10:00:00.0Z',
      '2026-08-06T10:00:00.00Z',
      '2026-08-06T10:00:00.0006Z',
      '2026-08-06T10:00:00.0000+02:00',
      new Date('2026-08-06T10:00:00.000Z'),
    ]) {
      expect(timestampSchema.safeParse(invalid).success).toBe(false);
    }
  });
});

describe('interview guide contracts', () => {
  it('accepts deterministic prefixed guide IDs and rejects unsafe identifiers', () => {
    expect(idSchema.safeParse('main-question_01abcxyz').success).toBe(true);
    expect(idSchema.safeParse('../other-guide').success).toBe(false);
    expect(idSchema.safeParse('guide id').success).toBe(false);
  });

  it('separates parsed guide structure from persisted guide metadata', () => {
    expect(guideStructureSchema.parse(guideStructure)).toEqual(guideStructure);
    const persisted = { ...guideStructure, sourceMarkdown: '# Interviewleitfaden', createdAt: now };
    expect(interviewGuideSchema.parse(persisted)).toEqual(persisted);
    expect(interviewGuideSchema.safeParse({ ...persisted, privateNotes: 'no' }).success).toBe(
      false,
    );
  });

  it('requires at least one main question, unique IDs, and zero-based contiguous positions', () => {
    expect(
      guideStructureSchema.safeParse({
        ...guideStructure,
        sections: [{ ...guideStructure.sections[0], position: 1 }],
      }).success,
    ).toBe(false);
    expect(
      guideStructureSchema.safeParse({
        ...guideStructure,
        sections: [{ ...guideStructure.sections[0], mainQuestions: [] }],
      }).success,
    ).toBe(false);
  });

  it('bounds aggregate guide cardinality across sections and questions', () => {
    const tooManyMainQuestions = {
      ...guideStructure,
      sections: [
        makeGuideSection(0, 250, 0),
        makeGuideSection(1, INTERVIEW_GUIDE_LIMITS.maximumMainQuestions - 249, 250),
      ],
    };
    expect(guideStructureSchema.safeParse(tooManyMainQuestions).success).toBe(false);

    const tooManyFollowUps = {
      ...guideStructure,
      sections: [
        makeGuideSection(0, 1, 0, 751),
        makeGuideSection(1, 1, 1, INTERVIEW_GUIDE_LIMITS.maximumFollowUpQuestions - 750),
      ],
    };
    expect(guideStructureSchema.safeParse(tooManyFollowUps).success).toBe(false);

    const tooManyTotalQuestions = {
      ...guideStructure,
      sections: [
        makeGuideSection(
          0,
          INTERVIEW_GUIDE_LIMITS.maximumTotalQuestions -
            INTERVIEW_GUIDE_LIMITS.maximumFollowUpQuestions +
            1,
          0,
          INTERVIEW_GUIDE_LIMITS.maximumFollowUpQuestions,
        ),
      ],
    };
    expect(guideStructureSchema.safeParse(tooManyTotalQuestions).success).toBe(false);
  });

  it('accepts exact aggregate guide cardinality boundaries', () => {
    const maximumSections = {
      ...guideStructure,
      sections: Array.from({ length: INTERVIEW_GUIDE_LIMITS.maximumSections }, (_, index) =>
        makeGuideSection(index, 1, index),
      ),
    };
    expect(guideStructureSchema.safeParse(maximumSections).success).toBe(true);

    const maximumMainQuestions = {
      ...guideStructure,
      sections: [makeGuideSection(0, INTERVIEW_GUIDE_LIMITS.maximumMainQuestions, 0)],
    };
    expect(guideStructureSchema.safeParse(maximumMainQuestions).success).toBe(true);

    const maximumTotalQuestions = {
      ...guideStructure,
      sections: [
        makeGuideSection(
          0,
          INTERVIEW_GUIDE_LIMITS.maximumTotalQuestions -
            INTERVIEW_GUIDE_LIMITS.maximumFollowUpQuestions,
          0,
          INTERVIEW_GUIDE_LIMITS.maximumFollowUpQuestions,
        ),
      ],
    };
    expect(guideStructureSchema.safeParse(maximumTotalQuestions).success).toBe(true);
  });

  it('rejects raw aggregate cardinality before detailed node traversal', () => {
    const invalidQuestions = Array.from(
      { length: INTERVIEW_GUIDE_LIMITS.maximumMainQuestions },
      () => ({ id: 'duplicate', position: -1, text: '', followUpQuestions: [] }),
    );
    const oversized = {
      id: 'duplicate',
      title: '',
      sections: Array.from({ length: INTERVIEW_GUIDE_LIMITS.maximumSections }, (_, index) => ({
        id: 'duplicate',
        position: index + 1,
        title: '',
        mainQuestions: invalidQuestions,
      })),
    };
    const result = guideStructureSchema.safeParse(oversized);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual([
        expect.objectContaining({ code: 'too_big', path: ['sections', 1, 'mainQuestions'] }),
      ]);
    }
  });

  it('requires discriminated, guide-scoped question references', () => {
    expect(guideQuestionReferenceSchema.safeParse(mainReference).success).toBe(true);
    expect(guideQuestionReferenceSchema.safeParse(followUpReference).success).toBe(true);
    const unscoped = {
      kind: mainReference.kind,
      sectionId: mainReference.sectionId,
      mainQuestionId: mainReference.mainQuestionId,
    };
    expect(guideQuestionReferenceSchema.safeParse(unscoped).success).toBe(false);
    expect(
      guideQuestionReferenceSchema.safeParse({ ...mainReference, followUpQuestionId: ids.followUp })
        .success,
    ).toBe(false);
  });
});

function makeGuideSection(
  sectionPosition: number,
  mainQuestionCount: number,
  mainQuestionIdOffset: number,
  firstQuestionFollowUpCount = 0,
) {
  return {
    id: `section-${String(sectionPosition)}`,
    position: sectionPosition,
    title: `Abschnitt ${String(sectionPosition)}`,
    mainQuestions: Array.from({ length: mainQuestionCount }, (_, questionPosition) => ({
      id: `main-${String(mainQuestionIdOffset + questionPosition)}`,
      position: questionPosition,
      text: `Hauptfrage ${String(mainQuestionIdOffset + questionPosition)}?`,
      followUpQuestions:
        questionPosition === 0
          ? Array.from({ length: firstQuestionFollowUpCount }, (_, followUpPosition) => ({
              id: `follow-${String(sectionPosition)}-${String(followUpPosition)}`,
              position: followUpPosition,
              text: `Vertiefungsfrage ${String(followUpPosition)}?`,
            }))
          : [],
    })),
  };
}

describe('HTTP contracts', () => {
  const interviewGuide = {
    ...guideStructure,
    sourceMarkdown: '# Interviewleitfaden\n\n## Einfuehrung',
    createdAt: now,
  } as const;
  const interviewState = {
    interviewId: ids.interview,
    guideId: ids.guide,
    language: 'de',
    lifecycle: { status: 'ready' },
    currentMainQuestion: null,
    coverage: [
      {
        question: mainReference,
        status: 'not_addressed',
        transcriptTurnIds: [],
      },
    ],
    activeWorkflowRunId: null,
    version: 0,
    createdAt: now,
    updatedAt: now,
  } as const;

  it('defines strict liveness and dependency-aware readiness shapes', () => {
    expect(livenessResponseSchema.parse({ status: 'ok', checkedAt: now })).toEqual({
      status: 'ok',
      checkedAt: now,
    });
    expect(
      livenessResponseSchema.safeParse({ status: 'ok', checkedAt: now, database: 'ready' }).success,
    ).toBe(false);
    expect(livenessResponseSchema.safeParse({ status: 'ready', checkedAt: now }).success).toBe(
      false,
    );

    expect(
      readinessResponseSchema.safeParse({
        status: 'ready',
        checkedAt: now,
        checks: { database: 'ready' },
      }).success,
    ).toBe(true);
    expect(
      readinessResponseSchema.safeParse({
        status: 'not_ready',
        checkedAt: now,
        checks: { database: 'not_ready' },
      }).success,
    ).toBe(true);
    expect(
      readinessResponseSchema.safeParse({
        status: 'ready',
        checkedAt: now,
        checks: { database: 'not_ready' },
      }).success,
    ).toBe(false);
    expect(
      readinessResponseSchema.safeParse({
        status: 'ready',
        checkedAt: '2026-08-06T10:00:00.0006Z',
        checks: { database: 'ready' },
      }).success,
    ).toBe(false);
  });

  it('wraps imported and fetched guides without weakening the guide contract', () => {
    expect(guideImportResponseSchema.parse({ outcome: 'inserted', interviewGuide })).toEqual({
      outcome: 'inserted',
      interviewGuide,
    });
    expect(
      guideImportResponseSchema.safeParse({
        outcome: 'updated',
        interviewGuide,
      }).success,
    ).toBe(false);
    expect(
      guideImportResponseSchema.safeParse({
        outcome: 'existing',
        interviewGuide,
        internalHash: 'secret',
      }).success,
    ).toBe(false);
    expect(guideResponseSchema.safeParse({ interviewGuide }).success).toBe(true);
    expect(guideResponseSchema.safeParse({ guide: interviewGuide }).success).toBe(false);
  });

  it('validates interview creation and detail responses at the HTTP boundary', () => {
    expect(
      interviewCreateRequestSchema.parse({ interviewId: ids.interview, guideId: ids.guide }),
    ).toEqual({ interviewId: ids.interview, guideId: ids.guide, language: 'de' });
    expect(
      interviewCreateRequestSchema.safeParse({ interviewId: '../interview', guideId: ids.guide })
        .success,
    ).toBe(false);
    expect(
      interviewCreateRequestSchema.safeParse({ interviewId: ids.interview, guideId: 'guide id' })
        .success,
    ).toBe(false);
    expect(
      interviewCreateRequestSchema.safeParse({
        interviewId: ids.interview,
        guideId: ids.guide,
        status: 'ready',
      }).success,
    ).toBe(false);

    expect(
      interviewCreateResponseSchema.safeParse({ outcome: 'inserted', interviewState }).success,
    ).toBe(true);
    expect(interviewDetailResponseSchema.safeParse({ interviewState }).success).toBe(true);
    expect(
      interviewDetailResponseSchema.safeParse({ interviewState, repositoryVersion: 1 }).success,
    ).toBe(false);
  });

  it('normalizes bounded list query values and uses transport-safe defaults', () => {
    expect(interviewListQuerySchema.parse({})).toEqual({ after: null, limit: 20 });
    expect(interviewListQuerySchema.parse({ after: null, limit: '100' })).toEqual({
      after: null,
      limit: 100,
    });
    expect(
      interviewListQuerySchema.parse({ after: 'eyJpZCI6ImludGVydmlldy0xIn0', limit: 1 }),
    ).toEqual({
      after: 'eyJpZCI6ImludGVydmlldy0xIn0',
      limit: 1,
    });

    for (const invalidLimit of [0, 101, 1.5, '0', '01', '1.5', null, true]) {
      expect(interviewListQuerySchema.safeParse({ limit: invalidLimit }).success).toBe(false);
    }
    for (const invalidCursor of ['', 'not/base64', 'x'.repeat(1_025), 123]) {
      expect(interviewListQuerySchema.safeParse({ after: invalidCursor }).success).toBe(false);
    }
    expect(interviewListQuerySchema.safeParse({ unexpected: true }).success).toBe(false);
  });

  it('validates bounded cursor pages and strict interview summaries', () => {
    const summary = {
      interviewId: ids.interview,
      guideId: ids.guide,
      guideTitle: guideStructure.title,
      language: 'de',
      status: 'ready',
      currentMainQuestionId: null,
      activeWorkflowRunId: null,
      createdAt: now,
      updatedAt: later,
      startedAt: null,
    } as const;
    const page = {
      interviews: [summary],
      nextCursor: 'eyJpZCI6ImludGVydmlldy0xIn0',
    } as const;

    expect(interviewSummaryPageSchema.parse(page)).toEqual(page);
    expect(
      interviewSummaryPageSchema.safeParse({
        ...page,
        interviews: [{ ...summary, interviewId: 'interview id' }],
      }).success,
    ).toBe(false);
    expect(
      interviewSummaryPageSchema.safeParse({
        ...page,
        interviews: [{ ...summary, status: 'ready', startedAt: now }],
      }).success,
    ).toBe(false);
    for (const status of ['active', 'paused', 'ending', 'completed'] as const) {
      expect(
        interviewSummaryPageSchema.safeParse({
          ...page,
          interviews: [{ ...summary, status, startedAt: null }],
        }).success,
      ).toBe(false);
      expect(
        interviewSummaryPageSchema.safeParse({
          ...page,
          interviews: [{ ...summary, status, startedAt: now }],
        }).success,
      ).toBe(true);
    }
    expect(
      interviewSummaryPageSchema.safeParse({
        ...page,
        interviews: [{ ...summary, updatedAt: '2026-08-06T09:59:59.999Z' }],
      }).success,
    ).toBe(false);
    expect(interviewSummaryPageSchema.safeParse({ ...page, totalCount: 1 }).success).toBe(false);
    expect(
      interviewSummaryPageSchema.safeParse({ interviews: [], nextCursor: 'x'.repeat(1_025) })
        .success,
    ).toBe(false);
  });
});

describe('interview and transcript contracts', () => {
  it('uses the domain lifecycle vocabulary and rejects obsolete or impossible fields', () => {
    expect(
      interviewLifecycleStateSchema.safeParse({
        status: 'paused',
        startedAt: now,
        pausedAt: later,
      }).success,
    ).toBe(true);
    expect(interviewLifecycleStateSchema.safeParse({ status: 'in_progress' }).success).toBe(false);
    expect(
      interviewLifecycleStateSchema.safeParse({
        status: 'completed',
        startedAt: now,
        endingAt: later,
      }).success,
    ).toBe(false);
  });

  it('enforces failure origin and lifecycle timestamp semantics', () => {
    const failure = { code: 'VOICE_FAILED', message: 'Voice provider unavailable' };
    expect(
      interviewLifecycleStateSchema.safeParse({
        status: 'failed',
        startedAt: null,
        failedAt: now,
        failedFrom: 'ready',
        failure,
      }).success,
    ).toBe(true);
    expect(
      interviewLifecycleStateSchema.safeParse({
        status: 'failed',
        startedAt: now,
        failedAt: later,
        failedFrom: 'ready',
        failure,
      }).success,
    ).toBe(false);
  });

  it('correlates the current main question with exactly one current coverage record', () => {
    const state = {
      interviewId: ids.interview,
      guideId: ids.guide,
      lifecycle: { status: 'active', startedAt: now, activeSince: now },
      currentMainQuestion: mainReference,
      coverage: [
        {
          question: followUpReference,
          status: 'current',
          transcriptTurnIds: [],
        },
      ],
      activeWorkflowRunId: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    } as const;

    expect(interviewStateSchema.safeParse(state).success).toBe(true);
    expect(
      interviewStateSchema.safeParse({
        ...state,
        coverage: [
          {
            ...state.coverage[0],
            transcriptTurnIds: [ids.turn],
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      interviewStateSchema.safeParse({
        ...state,
        currentMainQuestion: null,
      }).success,
    ).toBe(false);
    expect(
      interviewStateSchema.safeParse({
        ...state,
        coverage: [{ ...state.coverage[0], status: 'not_addressed' }],
      }).success,
    ).toBe(false);
    expect(
      interviewStateSchema.safeParse({
        ...state,
        currentMainQuestion: { ...mainReference, mainQuestionId: ids.turn },
      }).success,
    ).toBe(false);
    expect(
      interviewStateSchema.safeParse({
        ...state,
        coverage: [
          ...state.coverage,
          { question: mainReference, status: 'current', transcriptTurnIds: [] },
        ],
      }).success,
    ).toBe(false);
  });

  it('requires unique transcript evidence IDs within each coverage record', () => {
    const state = {
      interviewId: ids.interview,
      guideId: ids.guide,
      lifecycle: { status: 'ready' },
      currentMainQuestion: null,
      coverage: [
        {
          question: mainReference,
          status: 'answered',
          transcriptTurnIds: [ids.turn, ids.turn],
        },
      ],
      activeWorkflowRunId: null,
      version: 0,
      createdAt: now,
      updatedAt: now,
    } as const;

    const result = interviewStateSchema.safeParse(state);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ['coverage', 0, 'transcriptTurnIds', 1],
        }),
      );
    }
  });

  it('keeps strict participant-only partial and final STT segments distinct', () => {
    const partial = {
      segmentId: ids.segment,
      interviewId: ids.interview,
      provider: 'livekit',
      providerEventId: 'provider-1',
      utteranceId: ids.utterance,
      speaker: 'participant',
      text: 'Ich arbeite',
      observedAt: now,
      status: 'partial',
      revision: 1,
    } as const;

    expect(transcriptSegmentSchema.safeParse(partial).success).toBe(true);
    expect(
      transcriptSegmentSchema.safeParse({ ...partial, speaker: 'ai_interviewer' }).success,
    ).toBe(false);
    expect(transcriptSegmentSchema.safeParse({ ...partial, status: 'final' }).success).toBe(false);
    expect(
      transcriptSegmentSchema.safeParse({
        ...partial,
        status: 'final',
        text: 'Final text',
        observedAt: later,
        finalizedAt: now,
      }).success,
    ).toBe(false);
  });

  it('keeps partial text lossless while enforcing the shared 20000-character boundary', () => {
    const partial = {
      segmentId: ids.segment,
      interviewId: ids.interview,
      provider: 'livekit',
      providerEventId: 'provider-1',
      utteranceId: ids.utterance,
      speaker: 'participant',
      observedAt: now,
      status: 'partial',
      revision: 1,
    } as const;

    for (const text of ['', '   ', 'x'.repeat(20_000)]) {
      const parsed = transcriptSegmentSchema.parse({ ...partial, text });
      expect(parsed.text).toBe(text);
    }
    expect(
      transcriptSegmentSchema.safeParse({ ...partial, text: 'x'.repeat(20_001) }).success,
    ).toBe(false);
    expect(
      transcriptSegmentSchema.safeParse({ ...partial, text: '😀'.repeat(20_000) }).success,
    ).toBe(true);
    expect(
      transcriptSegmentSchema.safeParse({ ...partial, text: '😀'.repeat(20_001) }).success,
    ).toBe(false);
  });

  it('uses Unicode code-point lengths and rejects ECMAScript boundary whitespace', () => {
    expect(transcriptProviderSchema.safeParse('😀'.repeat(100)).success).toBe(true);
    expect(transcriptProviderSchema.safeParse('😀'.repeat(101)).success).toBe(false);
    expect(providerEventIdSchema.safeParse('😀'.repeat(300)).success).toBe(true);
    expect(providerEventIdSchema.safeParse('😀'.repeat(301)).success).toBe(false);

    for (const whitespace of ['\t', '\n', '\u00a0', '\u3000', '\ufeff']) {
      expect(transcriptProviderSchema.safeParse(`${whitespace}provider`).success).toBe(false);
      expect(providerEventIdSchema.safeParse(`event${whitespace}`).success).toBe(false);
    }
  });

  it('preserves bounded native provider event IDs separately from internal turn IDs', () => {
    const prefix = 'projects/acme/events/evt:abc+def=@?/';
    const nativeEventId = `${prefix}${'x'.repeat(300 - prefix.length)}`;
    const rawSegment = {
      segmentId: ids.segment,
      interviewId: ids.interview,
      provider: 'livekit',
      providerEventId: nativeEventId,
      utteranceId: ids.utterance,
      speaker: 'participant',
      text: 'Exact provider text',
      observedAt: now,
      status: 'final',
      finalizedAt: later,
    } as const;
    const participantTurn = {
      kind: 'turn',
      turnId: ids.turn,
      interviewId: ids.interview,
      sequenceNumber: 1,
      occurredAt: later,
      speaker: 'participant',
      turnType: 'participant_answer',
      text: rawSegment.text,
      guideReference: mainReference,
      sourceProvider: rawSegment.provider,
      providerEventId: nativeEventId,
      sourceSegmentId: rawSegment.segmentId,
    } as const;
    const aiTurn = {
      kind: 'turn',
      turnId: ids.turnTwo,
      interviewId: ids.interview,
      sequenceNumber: 2,
      occurredAt: later,
      speaker: 'ai_interviewer',
      turnType: 'closing',
      text: 'Vielen Dank.',
      guideReference: null,
      deliveryEventId: nativeEventId,
      delivery: { status: 'complete' },
    } as const;

    expect(transcriptSegmentSchema.parse(rawSegment).providerEventId).toBe(nativeEventId);
    expect(canonicalTranscriptTurnSchema.parse(participantTurn)).toMatchObject({
      providerEventId: nativeEventId,
    });
    expect(canonicalTranscriptTurnSchema.parse(aiTurn)).toMatchObject({
      deliveryEventId: nativeEventId,
    });
    expect(
      canonicalTranscriptTurnSchema.safeParse({ ...participantTurn, turnId: nativeEventId })
        .success,
    ).toBe(false);

    for (const invalidProviderEventId of [
      ` ${nativeEventId.slice(1)}`,
      `${nativeEventId.slice(1)} `,
      `${nativeEventId}x`,
    ]) {
      expect(
        transcriptSegmentSchema.safeParse({
          ...rawSegment,
          providerEventId: invalidProviderEventId,
        }).success,
      ).toBe(false);
      expect(
        canonicalTranscriptTurnSchema.safeParse({
          ...aiTurn,
          deliveryEventId: invalidProviderEventId,
        }).success,
      ).toBe(false);
    }
  });

  it('rejects invalid speaker and turn-type combinations', () => {
    expect(
      canonicalTranscriptTurnSchema.safeParse({
        kind: 'turn',
        turnId: ids.turn,
        interviewId: ids.interview,
        sequenceNumber: 1,
        occurredAt: now,
        speaker: 'participant',
        turnType: 'main_question',
        text: 'Welche Rolle haben Sie?',
        guideReference: mainReference,
        sourceSegmentId: ids.segment,
      }).success,
    ).toBe(false);
  });

  it('validates one contiguous canonical entry stream including standalone gaps', () => {
    const transcript = {
      interviewId: ids.interview,
      guideId: ids.guide,
      entries: [
        {
          kind: 'turn',
          turnId: ids.turn,
          interviewId: ids.interview,
          sequenceNumber: 1,
          occurredAt: now,
          speaker: 'ai_interviewer',
          turnType: 'main_question',
          text: 'Welche Rolle haben Sie?',
          deliveryEventId: ids.utterance,
          guideReference: mainReference,
          delivery: { status: 'complete' },
        },
        {
          kind: 'technical_gap',
          gapId: ids.gap,
          interviewId: ids.interview,
          sequenceNumber: 2,
          occurredAt: later,
          source: 'speech_to_text',
          sourceProvider: 'demo-stt',
          relatedUtteranceId: ids.utterance,
          description: 'Audio was unavailable for one segment.',
          relatedSegmentId: ids.segment,
          sourceEventId: ids.event,
        },
      ],
      finalizedAt: later,
    } as const;

    expect(canonicalTranscriptSchema.safeParse(transcript).success).toBe(true);
    expect(
      canonicalTranscriptSchema.safeParse({
        ...transcript,
        entries: [transcript.entries[0], { ...transcript.entries[1], sequenceNumber: 3 }],
      }).success,
    ).toBe(false);
    expect(
      canonicalTranscriptSchema.safeParse({
        ...transcript,
        entries: [
          {
            ...transcript.entries[0],
            guideReference: { ...mainReference, guideId: ids.guideOther },
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe('structured agent output contracts', () => {
  it('enforces coverage status/evidence coherence and unique question findings', () => {
    const output = {
      findings: [
        {
          question: mainReference,
          status: 'partially_answered',
          transcriptTurnIds: [ids.turn],
          openAspects: ['Verantwortlichkeit'],
          rationale: 'Der Ablauf ist beschrieben, die Verantwortung fehlt.',
        },
      ],
      referencedTranscriptTurnIds: [ids.turn],
      rationale: 'Der letzte Turn liefert partielle Evidenz.',
    } as const;
    expect(coverageAnalysisOutputSchema.safeParse(output).success).toBe(true);
    expect(
      coverageAnalysisOutputSchema.safeParse({
        ...output,
        findings: [{ ...output.findings[0], openAspects: ['Wer trägt die Verantwortung?'] }],
      }).success,
    ).toBe(true);
    expect(
      coverageAnalysisOutputSchema.safeParse({
        ...output,
        findings: [{ ...output.findings[0], status: 'answered', openAspects: ['Noch offen'] }],
      }).success,
    ).toBe(false);
    expect(
      coverageAnalysisOutputSchema.safeParse({
        ...output,
        findings: [output.findings[0], output.findings[0]],
      }).success,
    ).toBe(false);
  });

  it('requires distinct contradiction evidence and unique referenced turns', () => {
    const output = {
      contradictions: [
        {
          id: ids.contradiction,
          transcriptTurnIds: [ids.turn, ids.turnTwo],
          description: 'Die Zeitangaben unterscheiden sich.',
          suggestedClarificationQuestion: 'Welche Zeitangabe ist korrekt?',
          shouldClarify: true,
          rationale: 'Zwei Turns nennen unterschiedliche Zeitpunkte.',
        },
      ],
      referencedTranscriptTurnIds: [ids.turn, ids.turnTwo],
      rationale: 'Die Aussagen koennen nicht gleichzeitig zutreffen.',
    } as const;
    expect(consistencyAnalysisOutputSchema.safeParse(output).success).toBe(true);
    expect(
      consistencyAnalysisOutputSchema.safeParse({
        ...output,
        contradictions: [{ ...output.contradictions[0], transcriptTurnIds: [ids.turn, ids.turn] }],
      }).success,
    ).toBe(false);
  });

  it('requires a selected decision target to be considered exactly once', () => {
    const output = {
      selectedAction: { action: 'ask_main_question', target: mainReference },
      referencedTranscriptTurnIds: [ids.turn],
      consideredQuestions: [mainReference],
      rationale: 'Die Hauptfrage ist noch offen.',
    } as const;
    expect(interviewDecisionOutputSchema.safeParse(output).success).toBe(true);
    expect(
      interviewDecisionOutputSchema.safeParse({ ...output, consideredQuestions: [] }).success,
    ).toBe(false);
  });

  it('binds clarification decisions to a contradiction and a considered target', () => {
    const output = {
      selectedAction: {
        action: 'ask_clarification_question',
        target: mainReference,
        basis: {
          kind: 'contradiction',
          contradictionId: ids.contradiction,
          sourceQuestion: 'Welche Zeitangabe ist korrekt?',
        },
        clarificationObjective: 'Die widerspruechlichen Zeitangaben neutral klaeren.',
      },
      referencedTranscriptTurnIds: [ids.turn, ids.turnTwo],
      consideredQuestions: [mainReference],
      rationale: 'Ein relevanter Widerspruch muss vor dem Themenwechsel geklaert werden.',
    } as const;

    expect(interviewDecisionOutputSchema.safeParse(output).success).toBe(true);
    expect(
      interviewDecisionOutputSchema.safeParse({
        ...output,
        selectedAction: {
          action: 'ask_clarification_question',
          target: mainReference,
          basis: { kind: 'contradiction', sourceQuestion: 'Welche Zeitangabe ist korrekt?' },
          clarificationObjective: 'Die widerspruechlichen Zeitangaben neutral klaeren.',
        },
      }).success,
    ).toBe(false);
    expect(
      interviewDecisionOutputSchema.safeParse({
        ...output,
        selectedAction: { ...output.selectedAction, target: followUpReference },
      }).success,
    ).toBe(false);
    expect(
      interviewDecisionOutputSchema.safeParse({
        ...output,
        selectedAction: {
          ...output.selectedAction,
          privateReasoning: 'This field must never cross the contract boundary.',
        },
      }).success,
    ).toBe(false);
    expect(
      interviewDecisionOutputSchema.safeParse({
        ...output,
        unexpectedField: true,
      }).success,
    ).toBe(false);
  });

  it('enforces exactly one explicit conductor question', () => {
    const output = {
      action: 'ask',
      preface: null,
      question: {
        turnType: 'main_question',
        text: 'Welche Rolle haben Sie?',
        guideReference: mainReference,
      },
      referencedTranscriptTurnIds: [],
      rationale: 'Die erste offene Hauptfrage wird gestellt.',
    } as const;

    expect(conductorOutputSchema.safeParse(output).success).toBe(true);
    expect(
      conductorOutputSchema.safeParse({
        ...output,
        question: { ...output.question, text: 'Welche Rolle? Seit wann?' },
      }).success,
    ).toBe(false);
  });

  it('enforces finalization status/check/issue coherence and rejects hidden fields', () => {
    const report = {
      status: 'valid',
      checkedCanonicalEntries: [{ entryId: ids.turn, kind: 'turn' }],
      checks: {
        chronologyValid: true,
        sequenceValid: true,
        speakerAssignmentsValid: true,
        noDuplicateTurns: true,
      },
      issues: [],
      rationale: 'Alle kanonischen Turns sind konsistent.',
    } as const;

    expect(transcriptFinalizationReportSchema.safeParse(report).success).toBe(true);
    expect(
      transcriptFinalizationReportSchema.safeParse({
        ...report,
        chainOfThought: 'must never be exposed',
      }).success,
    ).toBe(false);
    expect(
      transcriptFinalizationReportSchema.safeParse({
        ...report,
        status: 'valid_with_gaps',
      }).success,
    ).toBe(false);
    const withGap = {
      ...report,
      status: 'valid_with_gaps',
      checkedCanonicalEntries: [
        { entryId: ids.turn, kind: 'turn' },
        { entryId: ids.gap, kind: 'technical_gap' },
      ],
      issues: [
        {
          code: 'technical_gap',
          severity: 'warning',
          canonicalEntryIds: [ids.gap],
          description: 'Ein Audiosegment konnte nicht final transkribiert werden.',
        },
      ],
    } as const;
    expect(transcriptFinalizationReportSchema.safeParse(withGap).success).toBe(true);
    expect(
      transcriptFinalizationReportSchema.safeParse({
        ...withGap,
        issues: [{ ...withGap.issues[0], canonicalEntryIds: [] }],
      }).success,
    ).toBe(false);
    expect(
      transcriptFinalizationReportSchema.safeParse({
        ...withGap,
        issues: [{ ...withGap.issues[0], canonicalEntryIds: ['ghost-gap'] }],
      }).success,
    ).toBe(false);
    expect(
      transcriptFinalizationReportSchema.safeParse({
        ...withGap,
        issues: [{ ...withGap.issues[0], canonicalEntryIds: [ids.turn] }],
      }).success,
    ).toBe(false);
  });
});

describe('monitoring and API boundary contracts', () => {
  it('ties workflow event types to run identity, status, and end metadata', () => {
    const event = {
      eventId: ids.event,
      interviewId: ids.interview,
      runId: ids.workflow,
      sequenceNumber: 1,
      occurredAt: now,
      category: 'workflow',
      type: 'workflow.started',
      payload: {
        workflowRunId: ids.workflow,
        status: 'running',
        startedAt: now,
        endedAt: null,
        durationMs: null,
        errorCode: null,
      },
    } as const;
    expect(monitoringEventSchema.safeParse(event).success).toBe(true);
    expect(monitoringEventSchema.safeParse({ ...event, runId: ids.run }).success).toBe(false);
    expect(
      monitoringEventSchema.safeParse({
        ...event,
        type: 'workflow.completed',
      }).success,
    ).toBe(false);
  });

  it('validates run status against terminal timing and error fields', () => {
    expect(
      workflowStepRunSchema.safeParse({
        stepRunId: ids.run,
        workflowRunId: ids.workflow,
        step: 'coverage_analysis',
        status: 'succeeded',
        startedAt: now,
        endedAt: null,
        durationMs: null,
        inputAvailable: true,
        outputAvailable: true,
        retryCount: 0,
        errorCode: null,
      }).success,
    ).toBe(false);
  });

  it('allowlists auditable agent-start inputs and rejects private prompt data', () => {
    const event = {
      eventId: ids.event,
      interviewId: ids.interview,
      language: 'de',
      runId: ids.run,
      sequenceNumber: 1,
      occurredAt: now,
      category: 'agent',
      type: 'agent.started',
      payload: {
        run: {
          agentRunId: ids.run,
          workflowRunId: ids.workflow,
          agentName: 'coverage_analysis',
          status: 'running',
          startedAt: now,
          endedAt: null,
          durationMs: null,
          retryCount: 0,
          errorCode: null,
          model: { mode: 'demo', provider: null, model: null },
        },
        input: {
          interviewStateVersion: 3,
          transcriptTurnIds: [ids.turn],
          canonicalEntryIds: [ids.turn],
          guideQuestionIds: [ids.main],
        },
      },
    } as const;

    expect(monitoringEventSchema.safeParse(event).success).toBe(true);
    for (const forbiddenField of ['reasoning', 'rawPrompt', 'sourceMarkdown'] as const) {
      expect(
        monitoringEventSchema.safeParse({
          ...event,
          payload: {
            ...event.payload,
            input: { ...event.payload.input, [forbiddenField]: 'private' },
          },
        }).success,
      ).toBe(false);
    }
    expect(
      monitoringEventSchema.safeParse({
        ...event,
        payload: {
          ...event.payload,
          input: { ...event.payload.input, transcriptTurnIds: [ids.turn, ids.turn] },
        },
      }).success,
    ).toBe(false);
  });

  it('rejects nested interview mismatches and non-contiguous state versions', () => {
    const state = {
      interviewId: ids.interview,
      guideId: ids.guide,
      lifecycle: { status: 'ready' },
      currentMainQuestion: null,
      coverage: [],
      activeWorkflowRunId: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    } as const;
    const event = {
      eventId: ids.event,
      interviewId: ids.interview,
      runId: ids.run,
      sequenceNumber: 1,
      occurredAt: now,
      category: 'state_update',
      type: 'state.updated',
      payload: { previousVersion: 0, nextVersion: 1, state },
    } as const;
    expect(monitoringEventSchema.safeParse(event).success).toBe(true);
    expect(
      monitoringEventSchema.safeParse({
        ...event,
        payload: { ...event.payload, nextVersion: 2 },
      }).success,
    ).toBe(false);
    expect(
      monitoringEventSchema.safeParse({
        ...event,
        payload: { ...event.payload, state: { ...state, interviewId: ids.interviewOther } },
      }).success,
    ).toBe(false);
  });

  it('supports a standalone persisted technical-gap event with interview scoping', () => {
    const event = {
      eventId: ids.event,
      interviewId: ids.interview,
      runId: ids.run,
      sequenceNumber: 1,
      occurredAt: now,
      category: 'transcript',
      type: 'transcript.gap_persisted',
      payload: {
        kind: 'technical_gap',
        gapId: ids.gap,
        interviewId: ids.interview,
        sequenceNumber: 2,
        occurredAt: now,
        source: 'transport',
        sourceProvider: null,
        relatedUtteranceId: null,
        description: 'A final event was not delivered.',
        relatedSegmentId: null,
        sourceEventId: ids.event,
      },
    } as const;
    expect(monitoringEventSchema.safeParse(event).success).toBe(true);
    expect(
      monitoringEventSchema.safeParse({
        ...event,
        payload: { ...event.payload, interviewId: ids.interviewOther },
      }).success,
    ).toBe(false);
  });

  it('accepts each typed AI text stream phase and validates delta sequence', () => {
    const base = {
      eventId: ids.event,
      interviewId: ids.interview,
      language: 'de',
      runId: ids.run,
      sequenceNumber: 1,
      occurredAt: now,
      category: 'transcript',
    } as const;
    const events = [
      {
        ...base,
        type: 'transcript.ai_text_stream_started',
        payload: {
          utteranceId: ids.utterance,
          turnId: ids.turn,
          nextDeltaSequenceNumber: 1,
          startedAt: now,
        },
      },
      {
        ...base,
        type: 'transcript.ai_text_delta',
        payload: {
          utteranceId: ids.utterance,
          turnId: ids.turn,
          deltaSequenceNumber: 1,
          textDelta: 'Welche Rolle',
        },
      },
      {
        ...base,
        type: 'transcript.ai_text_stream_completed',
        payload: {
          utteranceId: ids.utterance,
          turnId: ids.turn,
          lastDeltaSequenceNumber: 1,
          generatedText: 'Welche Rolle haben Sie?',
          confirmedSpokenText: 'Welche Rolle haben Sie?',
          completedAt: later,
        },
      },
      {
        ...base,
        type: 'transcript.ai_text_stream_interrupted',
        payload: {
          utteranceId: ids.utterance,
          turnId: ids.turn,
          lastDeltaSequenceNumber: 1,
          generatedText: 'Welche Rolle haben Sie?',
          confirmedSpokenText: 'Welche Rolle',
          interruptedAt: later,
        },
      },
    ];
    for (const event of events) {
      expect(monitoringEventSchema.safeParse(event).success).toBe(true);
    }
    expect(
      monitoringEventSchema.safeParse({
        ...events[1],
        payload: { ...events[1]?.payload, deltaSequenceNumber: 0 },
      }).success,
    ).toBe(false);
    expect(
      monitoringEventSchema.safeParse({
        ...events[1],
        payload: { ...events[1]?.payload, textDelta: ' ' },
      }).success,
    ).toBe(true);
    expect(
      monitoringEventSchema.safeParse({
        ...events[1],
        payload: { ...events[1]?.payload, textDelta: '' },
      }).success,
    ).toBe(false);
    expect(
      monitoringEventSchema.safeParse({
        ...events[2],
        payload: {
          ...events[2]?.payload,
          confirmedSpokenText: 'Welche Rolle haben Sie im Unternehmen?',
        },
      }).success,
    ).toBe(true);
    expect(
      monitoringEventSchema.safeParse({
        ...events[3],
        payload: { ...events[3]?.payload, confirmedSpokenText: 'Nicht erzeugt' },
      }).success,
    ).toBe(false);

    const maximumUnicodeText = '😀'.repeat(20_000);
    expect(
      monitoringEventSchema.safeParse({
        ...events[2],
        payload: {
          ...events[2]?.payload,
          generatedText: maximumUnicodeText,
          confirmedSpokenText: maximumUnicodeText,
        },
      }).success,
    ).toBe(true);
    expect(
      monitoringEventSchema.safeParse({
        ...events[2],
        payload: {
          ...events[2]?.payload,
          generatedText: `${maximumUnicodeText}😀`,
          confirmedSpokenText: `${maximumUnicodeText}😀`,
        },
      }).success,
    ).toBe(false);
    expect(
      monitoringEventSchema.safeParse({
        ...events[3],
        payload: {
          ...events[3]?.payload,
          generatedText: maximumUnicodeText,
          confirmedSpokenText: '',
        },
      }).success,
    ).toBe(true);
    expect(
      monitoringEventSchema.safeParse({
        ...events[3],
        payload: {
          ...events[3]?.payload,
          generatedText: `${maximumUnicodeText}😀`,
          confirmedSpokenText: '',
        },
      }).success,
    ).toBe(false);
  });

  it('reduces AI text streams only in contiguous, single-terminal order', () => {
    const base = {
      eventId: ids.event,
      interviewId: ids.interview,
      language: 'de',
      runId: ids.run,
      sequenceNumber: 1,
      occurredAt: now,
      category: 'transcript',
    } as const;
    const started = {
      ...base,
      type: 'transcript.ai_text_stream_started',
      payload: {
        utteranceId: ids.utterance,
        turnId: ids.turn,
        nextDeltaSequenceNumber: 1,
        startedAt: now,
      },
    } as const;
    const deltaOne = {
      ...base,
      type: 'transcript.ai_text_delta',
      payload: {
        utteranceId: ids.utterance,
        turnId: ids.turn,
        deltaSequenceNumber: 1,
        textDelta: 'Welche Rolle ',
      },
    } as const;
    const deltaTwo = {
      ...deltaOne,
      payload: { ...deltaOne.payload, deltaSequenceNumber: 2, textDelta: 'haben Sie?' },
    } as const;

    expect(() => reduceAiTextStreamEvent(null, deltaOne)).toThrow(AiTextStreamSequenceError);
    const streaming = reduceAiTextStreamEvent(
      reduceAiTextStreamEvent(reduceAiTextStreamEvent(null, started), deltaOne),
      deltaTwo,
    );
    expect(streaming).toMatchObject({
      status: 'streaming',
      lastDeltaSequenceNumber: 2,
      generatedText: 'Welche Rolle haben Sie?',
    });
    expect(() =>
      reduceAiTextStreamEvent(streaming, {
        ...deltaTwo,
        payload: { ...deltaTwo.payload, deltaSequenceNumber: 4 },
      }),
    ).toThrow(AiTextStreamSequenceError);

    const completedEvent = {
      ...base,
      type: 'transcript.ai_text_stream_completed',
      payload: {
        utteranceId: ids.utterance,
        turnId: ids.turn,
        lastDeltaSequenceNumber: 2,
        generatedText: 'Welche Rolle haben Sie?',
        confirmedSpokenText: 'Welche Rolle haben Sie?',
        completedAt: later,
      },
    } as const;
    const completed = reduceAiTextStreamEvent(streaming, completedEvent);
    expect(completed.status).toBe('completed');
    expect(() => reduceAiTextStreamEvent(completed, completedEvent)).toThrow(
      AiTextStreamSequenceError,
    );
  });

  it('ties voice playback event types to auditable state transitions', () => {
    const event = {
      eventId: ids.event,
      interviewId: ids.interview,
      runId: ids.run,
      sequenceNumber: 1,
      occurredAt: now,
      category: 'voice',
      type: 'voice.playback_started',
      payload: {
        previousState: 'processing',
        nextState: 'speaking',
        utteranceId: ids.utterance,
        turnId: ids.turn,
        provider: 'demo',
      },
    } as const;

    expect(monitoringEventSchema.safeParse(event).success).toBe(true);
    expect(
      monitoringEventSchema.safeParse({
        ...event,
        payload: { ...event.payload, nextState: 'idle' },
      }).success,
    ).toBe(false);
    expect(
      monitoringEventSchema.safeParse({
        ...event,
        payload: { ...event.payload, utteranceId: null },
      }).success,
    ).toBe(false);
    expect(
      monitoringEventSchema.safeParse({
        ...event,
        payload: { ...event.payload, previousState: 'speaking' },
      }).success,
    ).toBe(false);
    expect(
      monitoringEventSchema.safeParse({
        ...event,
        payload: { ...event.payload, previousState: 'failed' },
      }).success,
    ).toBe(false);
  });

  it('provides a stable strict API error envelope without stack traces', () => {
    const envelope = {
      error: {
        code: 'GUIDE_INVALID',
        message: 'The guide contains no main question.',
        requestId: ids.request,
        occurredAt: now,
        retryable: false,
        fieldErrors: [{ path: ['sections'], code: 'too_small', message: 'Add a main question.' }],
      },
    } as const;

    expect(apiErrorEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(
      apiErrorEnvelopeSchema.safeParse({
        error: { ...envelope.error, stack: 'internal details' },
      }).success,
    ).toBe(false);

    const maximumFieldErrors = Array.from(
      { length: API_ERROR_LIMITS.maximumFieldErrors },
      (_, index) => ({ path: ['field', index], code: 'invalid', message: 'Invalid field.' }),
    );
    expect(
      apiErrorEnvelopeSchema.safeParse({
        error: { ...envelope.error, fieldErrors: maximumFieldErrors },
      }).success,
    ).toBe(true);
    expect(
      apiErrorEnvelopeSchema.safeParse({
        error: {
          ...envelope.error,
          fieldErrors: [
            ...maximumFieldErrors,
            { path: ['field'], code: 'invalid', message: 'One too many.' },
          ],
        },
      }).success,
    ).toBe(false);
  });
});
