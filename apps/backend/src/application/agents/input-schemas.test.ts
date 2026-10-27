import { describe, expect, it } from 'vitest';

import {
  agentPromptInputSchema,
  consistencyAnalysisPromptInputSchema,
  coverageAnalysisPromptInputSchema,
  interviewConductorPromptInputSchema,
  interviewDecisionPromptInputSchema,
  transcriptFinalizationPromptInputSchema,
} from './input-schemas.js';

const NOW = '2026-08-12T10:00:00.000Z';
const LATER = '2026-08-12T10:01:00.000Z';
const GUIDE_ID = 'guide-agent-input-1';
const INTERVIEW_ID = 'interview-agent-input-1';

const mainQuestionReference = {
  kind: 'main_question' as const,
  guideId: GUIDE_ID,
  sectionId: 'section-1',
  mainQuestionId: 'main-1',
};

const followUpQuestionReference = {
  kind: 'follow_up_question' as const,
  guideId: GUIDE_ID,
  sectionId: 'section-1',
  mainQuestionId: 'main-1',
  followUpQuestionId: 'follow-up-1',
};

const guide = {
  id: GUIDE_ID,
  title: 'Interviewleitfaden',
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
            {
              id: 'follow-up-1',
              position: 0,
              text: 'Seit wann arbeiten Sie in dieser Position?',
            },
          ],
        },
      ],
    },
  ],
};

function createActiveInterviewState() {
  return {
    interviewId: INTERVIEW_ID,
    guideId: GUIDE_ID,
    lifecycle: { status: 'active' as const, startedAt: NOW, activeSince: NOW },
    currentMainQuestion: mainQuestionReference,
    coverage: [
      {
        question: mainQuestionReference,
        status: 'current' as const,
        transcriptTurnIds: [],
      },
      {
        question: followUpQuestionReference,
        status: 'not_addressed' as const,
        transcriptTurnIds: [],
      },
    ],
    activeWorkflowRunId: 'workflow-1',
    version: 4,
    createdAt: NOW,
    updatedAt: LATER,
  };
}

function createTranscript(finalizedAt: string | null = null) {
  return {
    interviewId: INTERVIEW_ID,
    guideId: GUIDE_ID,
    entries: [
      {
        kind: 'turn' as const,
        turnId: 'ai-turn-1',
        interviewId: INTERVIEW_ID,
        sequenceNumber: 1,
        speaker: 'ai_interviewer' as const,
        text: 'Welche Rolle haben Sie?',
        occurredAt: NOW,
        turnType: 'main_question' as const,
        guideReference: mainQuestionReference,
        deliveryEventId: 'delivery-1',
        delivery: { status: 'complete' as const },
      },
      {
        kind: 'turn' as const,
        turnId: 'participant-turn-1',
        interviewId: INTERVIEW_ID,
        sequenceNumber: 2,
        speaker: 'participant' as const,
        text: 'Ich leite den Bereich Forschung.',
        occurredAt: LATER,
        turnType: 'participant_answer' as const,
        guideReference: mainQuestionReference,
        sourceProvider: 'demo',
        providerEventId: 'provider-event-1',
        sourceSegmentId: 'segment-1',
      },
    ],
    finalizedAt,
  };
}

function commonInput() {
  return {
    interviewId: INTERVIEW_ID,
    interviewStateVersion: 4,
    guide,
    interviewState: createActiveInterviewState(),
    transcript: createTranscript(),
  };
}

const coverageAnalysis = {
  findings: [
    {
      question: mainQuestionReference,
      status: 'partially_answered' as const,
      transcriptTurnIds: ['participant-turn-1'],
      openAspects: ['Dauer in der Position'],
      rationale: 'Die Rolle ist genannt, die Dauer aber noch offen.',
    },
  ],
  referencedTranscriptTurnIds: ['participant-turn-1'],
  rationale: 'Die letzte Antwort deckt einen Teil der Hauptfrage ab.',
};

const consistencyAnalysis = {
  contradictions: [],
  referencedTranscriptTurnIds: ['participant-turn-1'],
  rationale: 'Es liegen keine widerspruechlichen Aussagen vor.',
};

const decision = {
  selectedAction: {
    action: 'ask_follow_up_question' as const,
    target: followUpQuestionReference,
  },
  referencedTranscriptTurnIds: ['participant-turn-1'],
  consideredQuestions: [followUpQuestionReference],
  rationale: 'Die Dauer in der Position ist noch offen.',
};

function createCoverageInput() {
  return {
    agentName: 'coverage_analysis' as const,
    ...commonInput(),
    latestParticipantTurnId: 'participant-turn-1',
    currentQuestion: mainQuestionReference,
    candidateQuestionIds: ['main-1', 'follow-up-1'],
  };
}

function createConsistencyInput() {
  return {
    agentName: 'consistency_analysis' as const,
    ...commonInput(),
    latestParticipantTurnId: 'participant-turn-1',
    currentQuestion: mainQuestionReference,
    allowedContradictionIds: ['contradiction-reserved-1'],
    existingContradictionIds: ['contradiction-existing-1'],
  };
}

function createDecisionInput() {
  return {
    agentName: 'interview_decision' as const,
    ...commonInput(),
    coverageAnalysis,
    consistencyAnalysis,
    currentQuestion: mainQuestionReference,
    candidateQuestionIds: ['main-1', 'follow-up-1'],
  };
}

function createConductorInput() {
  return {
    agentName: 'interview_conductor' as const,
    ...commonInput(),
    decision,
    selectedQuestionText: 'Seit wann arbeiten Sie in dieser Position?',
    requiredClarificationQuestion: null,
    allowGreeting: false,
    allowTransition: true,
  };
}

function createFinalizationInput() {
  const activeState = createActiveInterviewState();
  return {
    agentName: 'transcript_finalization' as const,
    ...commonInput(),
    interviewState: {
      ...activeState,
      lifecycle: {
        status: 'completed' as const,
        startedAt: NOW,
        endingAt: LATER,
        endedAt: LATER,
      },
      activeWorkflowRunId: null,
    },
    transcript: createTranscript(LATER),
    deterministicValidation: { valid: true, issues: [] },
  };
}

describe('agent prompt input schemas', () => {
  it.each([
    ['coverage', coverageAnalysisPromptInputSchema, createCoverageInput()],
    ['consistency', consistencyAnalysisPromptInputSchema, createConsistencyInput()],
    ['decision', interviewDecisionPromptInputSchema, createDecisionInput()],
    ['conductor', interviewConductorPromptInputSchema, createConductorInput()],
    ['finalization', transcriptFinalizationPromptInputSchema, createFinalizationInput()],
  ])('accepts a valid %s input', (_name, schema, input) => {
    const directResult = schema.safeParse(input);
    const unionResult = agentPromptInputSchema.safeParse(input);
    expect(directResult.success, directResult.error?.message).toBe(true);
    expect(unionResult.success, unionResult.error?.message).toBe(true);
  });

  it('rejects state and transcript data from another interview', () => {
    const input = createCoverageInput();
    const wrongState = {
      ...input,
      interviewState: { ...input.interviewState, interviewId: 'interview-other' },
    };
    const wrongTranscript = {
      ...input,
      transcript: { ...input.transcript, interviewId: 'interview-other' },
    };

    expect(coverageAnalysisPromptInputSchema.safeParse(wrongState).success).toBe(false);
    expect(coverageAnalysisPromptInputSchema.safeParse(wrongTranscript).success).toBe(false);
  });

  it('rejects guide mismatches and question IDs outside the guide hierarchy', () => {
    const input = createCoverageInput();

    expect(
      coverageAnalysisPromptInputSchema.safeParse({
        ...input,
        guide: { ...input.guide, id: 'guide-other' },
      }).success,
    ).toBe(false);
    expect(
      coverageAnalysisPromptInputSchema.safeParse({
        ...input,
        candidateQuestionIds: ['unknown-question'],
      }).success,
    ).toBe(false);
  });

  it('requires the persisted interview language to match the guide source language', () => {
    const input = createCoverageInput();
    expect(
      coverageAnalysisPromptInputSchema.safeParse({
        ...input,
        guide: { ...input.guide, sourceLanguage: 'en' },
      }).success,
    ).toBe(false);

    const englishInput = {
      ...input,
      guide: { ...input.guide, sourceLanguage: 'en' },
      interviewState: { ...input.interviewState, language: 'en' },
    };
    expect(coverageAnalysisPromptInputSchema.safeParse(englishInput).success).toBe(true);
  });

  it('rejects a stale interview state version', () => {
    expect(
      interviewDecisionPromptInputSchema.safeParse({
        ...createDecisionInput(),
        interviewStateVersion: 3,
      }).success,
    ).toBe(false);
  });

  it('allows an empty decision candidate set but requires coverage candidates', () => {
    expect(
      interviewDecisionPromptInputSchema.safeParse({
        ...createDecisionInput(),
        candidateQuestionIds: [],
      }).success,
    ).toBe(true);
    expect(
      coverageAnalysisPromptInputSchema.safeParse({
        ...createCoverageInput(),
        candidateQuestionIds: [],
      }).success,
    ).toBe(false);
  });

  it('requires reserved and existing contradiction IDs to be disjoint', () => {
    expect(consistencyAnalysisPromptInputSchema.safeParse(createConsistencyInput()).success).toBe(
      true,
    );
    expect(
      consistencyAnalysisPromptInputSchema.safeParse({
        ...createConsistencyInput(),
        allowedContradictionIds: ['contradiction-existing-1'],
      }).success,
    ).toBe(false);
  });

  it('requires the latest participant turn to exist and belong to the participant', () => {
    expect(
      coverageAnalysisPromptInputSchema.safeParse({
        ...createCoverageInput(),
        latestParticipantTurnId: 'missing-turn',
      }).success,
    ).toBe(false);
    expect(
      consistencyAnalysisPromptInputSchema.safeParse({
        ...createConsistencyInput(),
        latestParticipantTurnId: 'ai-turn-1',
      }).success,
    ).toBe(false);
  });

  it('binds the latest participant turn and coverage candidates to the current question', () => {
    expect(
      coverageAnalysisPromptInputSchema.safeParse({
        ...createCoverageInput(),
        candidateQuestionIds: ['follow-up-1'],
      }).success,
    ).toBe(false);
    expect(
      coverageAnalysisPromptInputSchema.safeParse({
        ...createCoverageInput(),
        currentQuestion: followUpQuestionReference,
        candidateQuestionIds: ['follow-up-1'],
      }).success,
    ).toBe(false);
  });

  it('requires persisted coverage for every guide question', () => {
    const input = createCoverageInput();
    expect(
      coverageAnalysisPromptInputSchema.safeParse({
        ...input,
        interviewState: {
          ...input.interviewState,
          coverage: input.interviewState.coverage.slice(0, 1),
        },
      }).success,
    ).toBe(false);
  });

  it('requires completed state and finalized transcript for finalization', () => {
    const input = createFinalizationInput();

    expect(
      transcriptFinalizationPromptInputSchema.safeParse({
        ...input,
        interviewState: createActiveInterviewState(),
      }).success,
    ).toBe(false);
    expect(
      transcriptFinalizationPromptInputSchema.safeParse({
        ...input,
        transcript: createTranscript(),
      }).success,
    ).toBe(false);
    expect(
      transcriptFinalizationPromptInputSchema.safeParse({
        ...input,
        interviewState: {
          ...input.interviewState,
          activeWorkflowRunId: 'workflow-still-running',
        },
      }).success,
    ).toBe(false);
    expect(
      transcriptFinalizationPromptInputSchema.safeParse({
        ...input,
        deterministicValidation: {
          valid: false,
          issues: [{ code: 'sequence_error', message: 'Sequence mismatch' }],
        },
      }).success,
    ).toBe(false);
  });

  it('requires active workflow-owned state for non-finalization agents', () => {
    const input = createCoverageInput();
    expect(
      coverageAnalysisPromptInputSchema.safeParse({
        ...input,
        transcript: createTranscript(LATER),
      }).success,
    ).toBe(false);
    expect(
      coverageAnalysisPromptInputSchema.safeParse({
        ...input,
        interviewState: {
          ...input.interviewState,
          lifecycle: { status: 'paused', startedAt: NOW, pausedAt: LATER },
          activeWorkflowRunId: null,
        },
      }).success,
    ).toBe(false);
    expect(
      coverageAnalysisPromptInputSchema.safeParse({
        ...input,
        interviewState: { ...input.interviewState, activeWorkflowRunId: null },
      }).success,
    ).toBe(false);
  });

  it('enforces conductor input shape coherence', () => {
    expect(
      interviewConductorPromptInputSchema.safeParse({
        ...createConductorInput(),
        selectedQuestionText: null,
      }).success,
    ).toBe(false);
    expect(
      interviewConductorPromptInputSchema.safeParse({
        ...createConductorInput(),
        requiredClarificationQuestion: 'Warum war das so?',
      }).success,
    ).toBe(false);
  });

  it('rejects extra root and nested validation properties', () => {
    expect(
      coverageAnalysisPromptInputSchema.safeParse({
        ...createCoverageInput(),
        hiddenReasoning: 'must not cross the boundary',
      }).success,
    ).toBe(false);

    const finalization = createFinalizationInput();
    expect(
      transcriptFinalizationPromptInputSchema.safeParse({
        ...finalization,
        deterministicValidation: {
          ...finalization.deterministicValidation,
          internalTrace: 'not allowed',
        },
      }).success,
    ).toBe(false);
  });
});
