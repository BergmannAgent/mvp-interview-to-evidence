import { describe, expect, it } from 'vitest';
import type { SupportedLocale } from '@orgscience/contracts';

import {
  consistencyAnalysisPromptInputSchema,
  coverageAnalysisPromptInputSchema,
  interviewConductorPromptInputSchema,
  interviewDecisionPromptInputSchema,
  transcriptFinalizationPromptInputSchema,
} from './input-schemas.js';
import { DemoInterviewAgentExecutor } from './demo-agent-executor.js';

const now = '2026-08-12T10:00:00.000Z';
const later = '2026-08-12T10:00:01.000Z';
const endingAt = '2026-08-12T10:00:05.000Z';
const endedAt = '2026-08-12T10:00:06.000Z';

const ids = {
  interview: 'interview-demo',
  guide: 'guide-demo',
  section: 'section-demo',
  main: 'main-role',
  followUp: 'follow-up-tenure',
  nextMain: 'main-preparation',
  aiTurn: 'turn-ai-main',
  firstParticipantTurn: 'turn-participant-first',
  latestParticipantTurn: 'turn-participant-latest',
  contradiction: 'contradiction-demo',
  gap: 'gap-demo',
} as const;

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
const nextMainReference = {
  kind: 'main_question',
  guideId: ids.guide,
  sectionId: ids.section,
  mainQuestionId: ids.nextMain,
} as const;

const guide = {
  id: ids.guide,
  sourceLanguage: 'de',
  title: 'Interviewleitfaden: Demo',
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
        {
          id: ids.nextMain,
          position: 1,
          text: 'Wie bereitet sich Ihr Unternehmen auf unerwartete Ereignisse vor?',
          followUpQuestions: [],
        },
      ],
    },
  ],
} as const;

const englishGuide = {
  ...guide,
  sourceLanguage: 'en',
  title: 'Interview guide: Demo',
  sections: [
    {
      ...guide.sections[0],
      title: 'Introduction',
      mainQuestions: [
        {
          ...guide.sections[0].mainQuestions[0],
          text: 'What is your role in the organization?',
          followUpQuestions: [
            {
              ...guide.sections[0].mainQuestions[0].followUpQuestions[0],
              text: 'How long have you worked in this role?',
            },
          ],
        },
        {
          ...guide.sections[0].mainQuestions[1],
          text: 'How does your organization prepare for unexpected events?',
        },
      ],
    },
  ],
} as const;

const transcriptEntries = [
  {
    kind: 'turn',
    turnId: ids.aiTurn,
    interviewId: ids.interview,
    sequenceNumber: 1,
    occurredAt: now,
    speaker: 'ai_interviewer',
    turnType: 'main_question',
    text: 'Welche Rolle haben Sie im Unternehmen?',
    deliveryEventId: 'delivery-main',
    guideReference: mainReference,
    delivery: { status: 'complete' },
  },
  {
    kind: 'turn',
    turnId: ids.firstParticipantTurn,
    interviewId: ids.interview,
    sequenceNumber: 2,
    occurredAt: later,
    speaker: 'participant',
    turnType: 'participant_answer',
    text: 'Ich leite den Bereich Betrieb.',
    guideReference: mainReference,
    sourceProvider: 'demo-stt',
    providerEventId: 'provider-first',
    sourceSegmentId: 'segment-first',
  },
  {
    kind: 'turn',
    turnId: ids.latestParticipantTurn,
    interviewId: ids.interview,
    sequenceNumber: 3,
    occurredAt: '2026-08-12T10:00:02.000Z',
    speaker: 'participant',
    turnType: 'participant_answer',
    text: 'Diese Rolle habe ich seit fuenf Jahren.',
    guideReference: mainReference,
    sourceProvider: 'demo-stt',
    providerEventId: 'provider-latest',
    sourceSegmentId: 'segment-latest',
  },
] as const;

function guideFor(language: SupportedLocale) {
  return language === 'en' ? englishGuide : guide;
}

function activeState(language: SupportedLocale = 'de') {
  return {
    interviewId: ids.interview,
    guideId: ids.guide,
    language,
    lifecycle: { status: 'active', startedAt: now, activeSince: now },
    currentMainQuestion: mainReference,
    coverage: [
      { question: mainReference, status: 'current', transcriptTurnIds: [] },
      { question: followUpReference, status: 'not_addressed', transcriptTurnIds: [] },
      { question: nextMainReference, status: 'not_addressed', transcriptTurnIds: [] },
    ],
    activeWorkflowRunId: 'workflow-demo',
    version: 3,
    createdAt: now,
    updatedAt: '2026-08-12T10:00:03.000Z',
  } as const;
}

function transcript(finalizedAt: string | null = null) {
  return {
    interviewId: ids.interview,
    guideId: ids.guide,
    entries: [...transcriptEntries],
    finalizedAt,
  } as const;
}

function coverageInput(language: SupportedLocale = 'de') {
  return coverageAnalysisPromptInputSchema.parse({
    agentName: 'coverage_analysis',
    interviewId: ids.interview,
    interviewStateVersion: 3,
    guide: guideFor(language),
    interviewState: activeState(language),
    transcript: transcript(),
    latestParticipantTurnId: ids.latestParticipantTurn,
    currentQuestion: mainReference,
    candidateQuestionIds: [ids.main, ids.followUp, ids.nextMain],
  });
}

function consistencyInput(language: SupportedLocale = 'de') {
  return consistencyAnalysisPromptInputSchema.parse({
    agentName: 'consistency_analysis',
    interviewId: ids.interview,
    interviewStateVersion: 3,
    guide: guideFor(language),
    interviewState: activeState(language),
    transcript: transcript(),
    latestParticipantTurnId: ids.latestParticipantTurn,
    currentQuestion: mainReference,
    allowedContradictionIds: [ids.contradiction],
    existingContradictionIds: [],
  });
}

const coverageAnalysis = {
  findings: [
    {
      question: mainReference,
      status: 'answered',
      transcriptTurnIds: [ids.latestParticipantTurn],
      openAspects: [],
      rationale: 'Der aktuelle Nutzerturn beantwortet die Hauptfrage.',
    },
  ],
  referencedTranscriptTurnIds: [ids.latestParticipantTurn],
  rationale: 'Die Antwort enthaelt ausreichende Evidenz.',
} as const;

const noContradictions = {
  contradictions: [],
  referencedTranscriptTurnIds: [],
  rationale: 'Es wurden keine Widersprueche erkannt.',
} as const;

function decisionInput(
  candidateQuestionIds: readonly string[] = [ids.nextMain, ids.followUp],
  language: SupportedLocale = 'de',
) {
  return interviewDecisionPromptInputSchema.parse({
    agentName: 'interview_decision',
    interviewId: ids.interview,
    interviewStateVersion: 3,
    guide: guideFor(language),
    interviewState: activeState(language),
    transcript: transcript(),
    coverageAnalysis,
    consistencyAnalysis: noContradictions,
    currentQuestion: mainReference,
    candidateQuestionIds,
  });
}

function completedState(language: SupportedLocale = 'de') {
  return {
    ...activeState(language),
    lifecycle: { status: 'completed', startedAt: now, endingAt, endedAt },
    currentMainQuestion: null,
    coverage: [mainReference, followUpReference, nextMainReference].map((question) => ({
      question,
      status: 'answered' as const,
      transcriptTurnIds: [ids.latestParticipantTurn],
    })),
    activeWorkflowRunId: null,
    updatedAt: endedAt,
  } as const;
}

function transcriptWithTechnicalGap() {
  return {
    ...transcript(endedAt),
    entries: [
      ...transcriptEntries,
      {
        kind: 'technical_gap',
        gapId: ids.gap,
        interviewId: ids.interview,
        sequenceNumber: 4,
        occurredAt: endingAt,
        source: 'transport',
        sourceProvider: null,
        relatedUtteranceId: null,
        description: 'Ein Transportsegment fehlte.',
        relatedSegmentId: null,
        sourceEventId: 'transport-event-demo',
      },
    ],
  } as const;
}

function executionContext(signal: AbortSignal = new AbortController().signal) {
  return { runId: 'agent-run-demo', workflowRunId: 'workflow-demo', signal };
}

describe('DemoInterviewAgentExecutor', () => {
  const executor = new DemoInterviewAgentExecutor();

  it('marks the current allowed question answered using only the latest participant turn', async () => {
    const result = await executor.executeCoverageAnalysis(coverageInput(), executionContext());

    expect(result).toMatchObject({ ok: true, model: { mode: 'demo' }, repairCount: 0 });
    if (!result.ok) return;
    expect(result.output.findings).toEqual([
      expect.objectContaining({
        question: mainReference,
        status: 'answered',
        transcriptTurnIds: [ids.latestParticipantTurn],
        openAspects: [],
      }),
    ]);
    expect(result.output.referencedTranscriptTurnIds).toEqual([ids.latestParticipantTurn]);
  });

  it('returns a conservative consistency analysis without invented contradictions', async () => {
    const result = await executor.executeConsistencyAnalysis(
      consistencyInput(),
      executionContext(),
    );

    expect(result).toMatchObject({ ok: true, repairCount: 0 });
    if (!result.ok) return;
    expect(result.output.contradictions).toEqual([]);
    expect(result.output.referencedTranscriptTurnIds).toEqual([]);
  });

  it('selects the first open candidate in canonical guide order', async () => {
    const result = await executor.executeInterviewDecision(decisionInput(), executionContext());

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.output.selectedAction).toEqual({
      action: 'ask_follow_up_question',
      target: followUpReference,
    });
    expect(result.output.consideredQuestions).toEqual([followUpReference, nextMainReference]);
  });

  it('does not reselect a question that the latest coverage finding answered', async () => {
    const result = await executor.executeInterviewDecision(
      decisionInput([ids.main, ids.nextMain]),
      executionContext(),
    );

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.output.selectedAction).toEqual({
      action: 'ask_main_question',
      target: nextMainReference,
    });
    expect(result.output.consideredQuestions).toEqual([nextMainReference]);
  });

  it('moves to an unasked main question instead of repeating a partially answered follow-up', async () => {
    const followUpAiTurn = {
      ...transcriptEntries[0],
      turnId: 'turn-ai-follow-up',
      sequenceNumber: 3,
      occurredAt: '2026-08-12T10:00:01.500Z',
      turnType: 'follow_up_question' as const,
      text: 'Seit wann arbeiten Sie in dieser Position?',
      deliveryEventId: 'delivery-follow-up',
      guideReference: followUpReference,
    };
    const latestFollowUpAnswer = {
      ...transcriptEntries[2],
      sequenceNumber: 4,
      guideReference: followUpReference,
    };
    const input = interviewDecisionPromptInputSchema.parse({
      ...decisionInput([ids.followUp, ids.nextMain]),
      interviewState: {
        ...activeState(),
        coverage: [
          {
            question: mainReference,
            status: 'answered',
            transcriptTurnIds: [ids.firstParticipantTurn],
          },
          {
            question: followUpReference,
            status: 'current',
            transcriptTurnIds: [ids.firstParticipantTurn],
          },
          { question: nextMainReference, status: 'not_addressed', transcriptTurnIds: [] },
        ],
      },
      transcript: {
        ...transcript(),
        entries: [transcriptEntries[0], transcriptEntries[1], followUpAiTurn, latestFollowUpAnswer],
      },
      coverageAnalysis: {
        findings: [
          {
            question: followUpReference,
            status: 'partially_answered',
            transcriptTurnIds: [ids.latestParticipantTurn],
            openAspects: ['Konkretes Beispiel'],
            rationale: 'Die Vertiefungsfrage ist nur teilweise beantwortet.',
          },
        ],
        referencedTranscriptTurnIds: [ids.latestParticipantTurn],
        rationale: 'Die Antwort liefert nur Teile der erfragten Information.',
      },
      currentQuestion: followUpReference,
    });

    const result = await executor.executeInterviewDecision(input, executionContext());

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.output.selectedAction).toEqual({
      action: 'ask_main_question',
      target: nextMainReference,
    });
  });

  it('binds a clarification decision to the validated contradiction', async () => {
    const input = interviewDecisionPromptInputSchema.parse({
      ...decisionInput([ids.main, ids.followUp]),
      consistencyAnalysis: {
        contradictions: [
          {
            id: ids.contradiction,
            transcriptTurnIds: [ids.firstParticipantTurn, ids.latestParticipantTurn],
            description: 'Die genannten Zeitraeume unterscheiden sich.',
            suggestedClarificationQuestion:
              'Welcher Zeitraum ist fuer Ihre aktuelle Rolle korrekt?',
            shouldClarify: true,
            rationale: 'Zwei finale Nutzerturns nennen unterschiedliche Zeitraeume.',
          },
        ],
        referencedTranscriptTurnIds: [ids.firstParticipantTurn, ids.latestParticipantTurn],
        rationale: 'Ein moeglicher Widerspruch soll neutral geklaert werden.',
      },
    });

    const result = await executor.executeInterviewDecision(input, executionContext());

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.output.selectedAction).toEqual({
      action: 'ask_clarification_question',
      target: mainReference,
      basis: {
        kind: 'contradiction',
        contradictionId: ids.contradiction,
        sourceQuestion: 'Welcher Zeitraum ist fuer Ihre aktuelle Rolle korrekt?',
      },
      clarificationObjective: 'Den dokumentierten moeglichen Widerspruch neutral klaeren.',
    });
    expect(result.output.referencedTranscriptTurnIds).toEqual([
      ids.firstParticipantTurn,
      ids.latestParticipantTurn,
    ]);
  });

  it('completes when all allowed candidates are already terminal', async () => {
    const terminalState = {
      ...activeState(),
      currentMainQuestion: null,
      coverage: [mainReference, followUpReference, nextMainReference].map((question) => ({
        question,
        status: 'answered' as const,
        transcriptTurnIds: [ids.latestParticipantTurn],
      })),
    };
    const input = interviewDecisionPromptInputSchema.parse({
      ...decisionInput([ids.followUp]),
      interviewState: terminalState,
      currentQuestion: null,
    });

    const result = await executor.executeInterviewDecision(input, executionContext());

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.output.selectedAction).toEqual({ action: 'complete_interview' });
    expect(result.output.consideredQuestions).toEqual([]);
  });

  it('reproduces exact guide and clarification questions in conductor outputs', async () => {
    const guideDecision = {
      selectedAction: { action: 'ask_follow_up_question', target: followUpReference },
      referencedTranscriptTurnIds: [ids.latestParticipantTurn],
      consideredQuestions: [followUpReference],
      rationale: 'Die Vertiefungsfrage ist noch offen.',
    } as const;
    const guideInput = interviewConductorPromptInputSchema.parse({
      agentName: 'interview_conductor',
      interviewId: ids.interview,
      interviewStateVersion: 3,
      guide,
      interviewState: activeState(),
      transcript: transcript(),
      decision: guideDecision,
      selectedQuestionText: 'Seit wann arbeiten Sie in dieser Position?',
      requiredClarificationQuestion: null,
      allowGreeting: false,
      allowTransition: true,
    });

    const guideResult = await executor.executeInterviewConductor(guideInput, executionContext());
    expect(guideResult).toMatchObject({ ok: true });
    if (!guideResult.ok) return;
    expect(guideResult.output).toMatchObject({
      action: 'ask',
      preface: { turnType: 'transition' },
      question: {
        turnType: 'follow_up_question',
        text: 'Seit wann arbeiten Sie in dieser Position?',
        guideReference: followUpReference,
      },
    });

    const clarificationQuestion = 'Welcher Zeitraum ist fuer Ihre aktuelle Rolle korrekt?';
    const clarificationInput = interviewConductorPromptInputSchema.parse({
      ...guideInput,
      decision: {
        selectedAction: {
          action: 'ask_clarification_question',
          target: mainReference,
          basis: {
            kind: 'contradiction',
            contradictionId: ids.contradiction,
            sourceQuestion: clarificationQuestion,
          },
          clarificationObjective: 'Den moeglichen Widerspruch neutral klaeren.',
        },
        referencedTranscriptTurnIds: [ids.firstParticipantTurn, ids.latestParticipantTurn],
        consideredQuestions: [mainReference],
        rationale: 'Der moegliche Widerspruch wird zuerst geklaert.',
      },
      selectedQuestionText: null,
      requiredClarificationQuestion: clarificationQuestion,
      allowTransition: false,
    });

    const clarificationResult = await executor.executeInterviewConductor(
      clarificationInput,
      executionContext(),
    );
    expect(clarificationResult).toMatchObject({ ok: true });
    if (!clarificationResult.ok) return;
    expect(clarificationResult.output).toMatchObject({
      action: 'ask',
      preface: null,
      question: {
        turnType: 'clarification_question',
        text: clarificationQuestion,
        guideReference: mainReference,
      },
    });

    const closingInput = interviewConductorPromptInputSchema.parse({
      ...guideInput,
      decision: {
        selectedAction: { action: 'complete_interview' },
        referencedTranscriptTurnIds: [ids.latestParticipantTurn],
        consideredQuestions: [],
        rationale: 'Alle Hauptfragen sind beantwortet.',
      },
      selectedQuestionText: null,
      requiredClarificationQuestion: null,
      allowTransition: false,
    });
    const closingResult = await executor.executeInterviewConductor(
      closingInput,
      executionContext(),
    );
    expect(closingResult).toMatchObject({
      ok: true,
      output: {
        action: 'close',
        closingText: 'Vielen Dank fuer das Gespraech und Ihre Zeit.',
      },
    });
  });

  it('checks every canonical entry and reports each technical gap exactly once', async () => {
    const completeInput = transcriptFinalizationPromptInputSchema.parse({
      agentName: 'transcript_finalization',
      interviewId: ids.interview,
      interviewStateVersion: 3,
      guide,
      interviewState: completedState(),
      transcript: transcript(endedAt),
      deterministicValidation: { valid: true, issues: [] },
    });
    const completeResult = await executor.executeTranscriptFinalization(
      completeInput,
      executionContext(),
    );
    expect(completeResult).toMatchObject({
      ok: true,
      output: { status: 'valid', issues: [] },
    });

    const input = transcriptFinalizationPromptInputSchema.parse({
      agentName: 'transcript_finalization',
      interviewId: ids.interview,
      interviewStateVersion: 3,
      guide,
      interviewState: completedState(),
      transcript: transcriptWithTechnicalGap(),
      deterministicValidation: { valid: true, issues: [] },
    });

    const result = await executor.executeTranscriptFinalization(input, executionContext());

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.output.status).toBe('valid_with_gaps');
    expect(result.output.checkedCanonicalEntries).toEqual([
      { entryId: ids.aiTurn, kind: 'turn' },
      { entryId: ids.firstParticipantTurn, kind: 'turn' },
      { entryId: ids.latestParticipantTurn, kind: 'turn' },
      { entryId: ids.gap, kind: 'technical_gap' },
    ]);
    expect(result.output.issues).toEqual([
      expect.objectContaining({
        code: 'technical_gap',
        severity: 'warning',
        canonicalEntryIds: [ids.gap],
        description: 'Technische Luecke im kanonischen Transkript.',
      }),
    ]);
    expect(result.output.rationale).toBe(
      'Alle kanonischen Eintraege sind geprueft; technische Luecken bleiben sichtbar.',
    );

    const invalidInput = transcriptFinalizationPromptInputSchema.safeParse({
      ...completeInput,
      deterministicValidation: {
        valid: false,
        issues: [
          {
            code: 'sequence_error',
            message: 'Die deterministische Sequenzpruefung ist fehlgeschlagen.',
            entryId: ids.aiTurn,
          },
        ],
      },
    });
    expect(invalidInput.success).toBe(false);
  });

  it('keeps every deterministic system text in English for an English interview', async () => {
    const englishCoverageInput = coverageInput('en');
    const originalTranscript = structuredClone(englishCoverageInput.transcript);
    const coverageResult = await executor.executeCoverageAnalysis(
      englishCoverageInput,
      executionContext(),
    );
    expect(coverageResult).toMatchObject({
      ok: true,
      output: {
        findings: [
          {
            status: 'answered',
            rationale: 'The current demo turn answers the active guide question.',
          },
        ],
        rationale: 'The deterministic demo analysis uses only the latest final participant turn.',
      },
    });
    expect(englishCoverageInput.transcript).toEqual(originalTranscript);

    const consistencyResult = await executor.executeConsistencyAnalysis(
      consistencyInput('en'),
      executionContext(),
    );
    expect(consistencyResult).toMatchObject({
      ok: true,
      output: {
        contradictions: [],
        rationale: 'The deterministic demo mode reports no unsupported contradictions.',
      },
    });

    const decisionResult = await executor.executeInterviewDecision(
      decisionInput([ids.nextMain, ids.followUp], 'en'),
      executionContext(),
    );
    expect(decisionResult).toMatchObject({
      ok: true,
      output: {
        selectedAction: { action: 'ask_follow_up_question', target: followUpReference },
        rationale: 'The first unanswered allowed question in canonical guide order is selected.',
      },
    });
    if (!decisionResult.ok) return;

    const conductorInput = interviewConductorPromptInputSchema.parse({
      agentName: 'interview_conductor',
      interviewId: ids.interview,
      interviewStateVersion: 3,
      guide: englishGuide,
      interviewState: activeState('en'),
      transcript: transcript(),
      decision: decisionResult.output,
      selectedQuestionText: 'How long have you worked in this role?',
      requiredClarificationQuestion: null,
      allowGreeting: false,
      allowTransition: true,
    });
    const conductorResult = await executor.executeInterviewConductor(
      conductorInput,
      executionContext(),
    );
    expect(conductorResult).toMatchObject({
      ok: true,
      output: {
        action: 'ask',
        preface: {
          turnType: 'transition',
          text: 'Thank you. Let us move on to the next topic.',
        },
        question: {
          turnType: 'follow_up_question',
          text: 'How long have you worked in this role?',
          guideReference: followUpReference,
        },
      },
    });

    const greetingInput = interviewConductorPromptInputSchema.parse({
      ...conductorInput,
      transcript: { ...transcript(), entries: [] },
      decision: {
        selectedAction: { action: 'ask_main_question', target: mainReference },
        referencedTranscriptTurnIds: [],
        consideredQuestions: [mainReference],
        rationale: 'The first main question opens the interview.',
      },
      selectedQuestionText: 'What is your role in the organization?',
      allowGreeting: true,
      allowTransition: false,
    });
    const greetingResult = await executor.executeInterviewConductor(
      greetingInput,
      executionContext(),
    );
    expect(greetingResult).toMatchObject({
      ok: true,
      output: {
        preface: { turnType: 'greeting', text: 'Hello, and thank you for participating.' },
        question: { text: 'What is your role in the organization?' },
      },
    });

    const closingInput = interviewConductorPromptInputSchema.parse({
      ...conductorInput,
      decision: {
        selectedAction: { action: 'complete_interview' },
        referencedTranscriptTurnIds: [ids.latestParticipantTurn],
        consideredQuestions: [],
        rationale: 'All guide questions are complete.',
      },
      selectedQuestionText: null,
      allowTransition: false,
    });
    const closingResult = await executor.executeInterviewConductor(
      closingInput,
      executionContext(),
    );
    expect(closingResult).toMatchObject({
      ok: true,
      output: {
        action: 'close',
        closingText: 'Thank you for the conversation and for your time.',
        rationale: 'The guide is complete, so the interview is closed briefly.',
      },
    });

    const finalizationInput = transcriptFinalizationPromptInputSchema.parse({
      agentName: 'transcript_finalization',
      interviewId: ids.interview,
      interviewStateVersion: 3,
      guide: englishGuide,
      interviewState: completedState('en'),
      transcript: transcriptWithTechnicalGap(),
      deterministicValidation: { valid: true, issues: [] },
    });
    const finalizationResult = await executor.executeTranscriptFinalization(
      finalizationInput,
      executionContext(),
    );
    expect(finalizationResult).toMatchObject({
      ok: true,
      output: {
        status: 'valid_with_gaps',
        issues: [
          {
            code: 'technical_gap',
            severity: 'warning',
            description: 'Technical gap in the canonical transcript.',
          },
        ],
        rationale: 'All canonical entries were checked; technical gaps remain visible.',
      },
    });

    const controller = new AbortController();
    controller.abort();
    const aborted = await executor.executeCoverageAnalysis(
      coverageInput('en'),
      executionContext(controller.signal),
    );
    expect(aborted).toMatchObject({
      ok: false,
      error: {
        code: 'aborted',
        message: 'The demo agent execution was aborted.',
        retryable: false,
      },
    });
  });

  it('returns a typed failure when execution is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await executor.executeCoverageAnalysis(
      coverageInput(),
      executionContext(controller.signal),
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'aborted',
        message: 'Die Ausfuehrung des Demo-Agenten wurde abgebrochen.',
        retryable: false,
      },
      model: { mode: 'demo', provider: null, model: null },
      repairCount: 0,
    });
  });

  it('rejects an invalid execution run identity', async () => {
    const result = await executor.executeCoverageAnalysis(coverageInput(), {
      runId: 'invalid run id',
      workflowRunId: 'workflow-demo',
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invalid_input', retryable: false },
      repairCount: 0,
    });
  });

  it('rejects execution from a workflow that does not own the active state', async () => {
    const result = await executor.executeCoverageAnalysis(coverageInput(), {
      runId: 'agent-run-demo',
      workflowRunId: 'workflow-other',
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invalid_input', retryable: false },
      repairCount: 0,
    });
  });

  it('is idempotently deterministic across run identities', async () => {
    const input = decisionInput();

    const first = await executor.executeInterviewDecision(input, {
      runId: 'agent-run-one',
      workflowRunId: 'workflow-demo',
      signal: new AbortController().signal,
    });
    const second = await executor.executeInterviewDecision(input, {
      runId: 'agent-run-two',
      workflowRunId: 'workflow-demo',
      signal: new AbortController().signal,
    });

    expect(second).toEqual(first);
  });
});
