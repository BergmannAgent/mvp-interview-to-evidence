import { describe, expect, it } from 'vitest';
import type { GuideQuestionReference } from '@orgscience/contracts';

import {
  validateConductorOutput,
  validateConsistencyAnalysisOutput,
  validateCoverageAnalysisOutput,
  validateInterviewDecisionOutput,
  validateTranscriptFinalizationOutput,
} from './guardrails.js';
import type {
  ConsistencyAnalysisPromptInput,
  CoverageAnalysisPromptInput,
  InterviewConductorPromptInput,
  InterviewDecisionPromptInput,
  TranscriptFinalizationPromptInput,
} from './input-schemas.js';

const NOW = '2026-08-12T10:00:00.000Z';
const LATER = '2026-08-12T10:01:00.000Z';
const END = '2026-08-12T10:02:00.000Z';
const GUIDE_ID = 'guide-guardrail-1';
const INTERVIEW_ID = 'interview-guardrail-1';

const mainOne = {
  kind: 'main_question' as const,
  guideId: GUIDE_ID,
  sectionId: 'section-1',
  mainQuestionId: 'main-1',
};
const followOne = {
  kind: 'follow_up_question' as const,
  guideId: GUIDE_ID,
  sectionId: 'section-1',
  mainQuestionId: 'main-1',
  followUpQuestionId: 'follow-1',
};
const mainTwo = {
  kind: 'main_question' as const,
  guideId: GUIDE_ID,
  sectionId: 'section-1',
  mainQuestionId: 'main-2',
};
const followTwo = {
  kind: 'follow_up_question' as const,
  guideId: GUIDE_ID,
  sectionId: 'section-1',
  mainQuestionId: 'main-2',
  followUpQuestionId: 'follow-2',
};

const guide = {
  id: GUIDE_ID,
  sourceLanguage: 'de' as const,
  title: 'Interviewleitfaden',
  sections: [
    {
      id: 'section-1',
      position: 0,
      title: 'Abschnitt',
      mainQuestions: [
        {
          id: 'main-1',
          position: 0,
          text: 'Welche Rolle haben Sie?',
          followUpQuestions: [
            { id: 'follow-1', position: 0, text: 'Seit wann arbeiten Sie dort?' },
          ],
        },
        {
          id: 'main-2',
          position: 1,
          text: 'Wie bereiten Sie sich vor?',
          followUpQuestions: [
            { id: 'follow-2', position: 0, text: 'Wer traegt die Verantwortung?' },
          ],
        },
      ],
    },
  ],
};

const transcript = {
  interviewId: INTERVIEW_ID,
  guideId: GUIDE_ID,
  entries: [
    {
      kind: 'turn' as const,
      turnId: 'ai-1',
      interviewId: INTERVIEW_ID,
      sequenceNumber: 1,
      speaker: 'ai_interviewer' as const,
      text: guide.sections[0]!.mainQuestions[0]!.text,
      occurredAt: NOW,
      turnType: 'main_question' as const,
      guideReference: mainOne,
      deliveryEventId: 'delivery-1',
      delivery: { status: 'complete' as const },
    },
    {
      kind: 'turn' as const,
      turnId: 'participant-1',
      interviewId: INTERVIEW_ID,
      sequenceNumber: 2,
      speaker: 'participant' as const,
      text: 'Ich leite Forschung.',
      occurredAt: LATER,
      turnType: 'participant_answer' as const,
      guideReference: mainOne,
      sourceProvider: 'demo',
      providerEventId: 'provider-1',
      sourceSegmentId: 'segment-1',
    },
  ],
  finalizedAt: null,
};

function coverage(
  question: GuideQuestionReference = mainOne,
  status: 'current' | 'answered' | 'not_addressed' = 'current',
) {
  return status === 'answered'
    ? { question, status, transcriptTurnIds: ['participant-1'] }
    : { question, status, transcriptTurnIds: [] };
}

function state(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    interviewId: INTERVIEW_ID,
    guideId: GUIDE_ID,
    language: 'de' as const,
    lifecycle: { status: 'active' as const, startedAt: NOW, activeSince: NOW },
    currentMainQuestion: mainOne,
    coverage: [
      coverage(mainOne),
      coverage(followOne, 'not_addressed'),
      coverage(mainTwo, 'not_addressed'),
      coverage(followTwo, 'not_addressed'),
    ],
    activeWorkflowRunId: 'workflow-1',
    version: 2,
    createdAt: NOW,
    updatedAt: LATER,
    ...overrides,
  };
}

function coverageInput(): CoverageAnalysisPromptInput {
  return {
    agentName: 'coverage_analysis',
    interviewId: INTERVIEW_ID,
    interviewStateVersion: 2,
    guide,
    interviewState: state(),
    transcript,
    latestParticipantTurnId: 'participant-1',
    currentQuestion: mainOne,
    candidateQuestionIds: ['main-1', 'follow-1'],
  };
}

function coverageOutput() {
  return {
    findings: [
      {
        question: mainOne,
        status: 'partially_answered' as const,
        transcriptTurnIds: ['participant-1'],
        openAspects: ['Dauer'],
        rationale: 'Die Funktion ist beantwortet, die Dauer bleibt offen.',
      },
    ],
    referencedTranscriptTurnIds: ['participant-1'],
    rationale: 'Die letzte Antwort liefert teilweise Evidenz.',
  };
}

function consistencyInput(): ConsistencyAnalysisPromptInput {
  return {
    agentName: 'consistency_analysis',
    interviewId: INTERVIEW_ID,
    interviewStateVersion: 2,
    guide,
    interviewState: state(),
    transcript,
    latestParticipantTurnId: 'participant-1',
    currentQuestion: mainOne,
    allowedContradictionIds: ['reserved-1'],
    existingContradictionIds: ['existing-1'],
  };
}

function contradiction(id = 'reserved-1', turns = ['participant-1', 'participant-2']) {
  return {
    id,
    transcriptTurnIds: turns,
    description: 'Die Aussagen zur Verantwortung sind moeglicherweise widerspruechlich.',
    suggestedClarificationQuestion: 'Wer trug letztlich die Verantwortung?',
    shouldClarify: true,
    rationale: 'Zwei Aussagen nennen unterschiedliche Verantwortliche.',
  };
}

function transcriptWithEarlierParticipant() {
  const entries = transcript.entries.map((entry, index) => ({
    ...entry,
    sequenceNumber: index + 2,
  }));
  return {
    ...transcript,
    entries: [
      {
        kind: 'turn' as const,
        turnId: 'participant-2',
        interviewId: INTERVIEW_ID,
        sequenceNumber: 1,
        speaker: 'participant' as const,
        text: 'Zunaechst war Frau A verantwortlich.',
        occurredAt: NOW,
        turnType: 'participant_answer' as const,
        guideReference: null,
        sourceProvider: 'demo',
        providerEventId: 'provider-2',
        sourceSegmentId: 'segment-2',
      },
      ...entries,
    ],
  };
}

function consistencyOutput() {
  return {
    contradictions: [contradiction()],
    referencedTranscriptTurnIds: ['participant-1', 'participant-2'],
    rationale: 'Eine Aussage steht moeglicherweise im Widerspruch zur letzten Antwort.',
  };
}

function decisionInput(
  overrides: Partial<InterviewDecisionPromptInput> = {},
): InterviewDecisionPromptInput {
  return {
    agentName: 'interview_decision',
    interviewId: INTERVIEW_ID,
    interviewStateVersion: 2,
    guide,
    interviewState: state(),
    transcript,
    coverageAnalysis: coverageOutput(),
    consistencyAnalysis: {
      contradictions: [],
      referencedTranscriptTurnIds: [],
      rationale: 'Keine Widersprueche erkannt.',
    },
    currentQuestion: mainOne,
    candidateQuestionIds: ['main-1', 'follow-1', 'main-2', 'follow-2'],
    ...overrides,
  };
}

function followUpDecision() {
  return {
    selectedAction: { action: 'ask_follow_up_question' as const, target: followOne },
    referencedTranscriptTurnIds: ['participant-1'],
    consideredQuestions: [followOne],
    rationale: 'Die Dauer ist noch offen.',
  };
}

function conductorInput(
  overrides: Partial<InterviewConductorPromptInput> = {},
): InterviewConductorPromptInput {
  return {
    agentName: 'interview_conductor',
    interviewId: INTERVIEW_ID,
    interviewStateVersion: 2,
    guide,
    interviewState: state(),
    transcript,
    decision: followUpDecision(),
    selectedQuestionText: guide.sections[0]!.mainQuestions[0]!.followUpQuestions[0]!.text,
    requiredClarificationQuestion: null,
    allowGreeting: false,
    allowTransition: true,
    ...overrides,
  };
}

function conductorOutput() {
  return {
    action: 'ask' as const,
    preface: { turnType: 'transition' as const, text: 'Danke fuer die Einordnung.' },
    question: {
      turnType: 'follow_up_question' as const,
      text: 'Seit wann arbeiten Sie dort?',
      guideReference: followOne,
    },
    referencedTranscriptTurnIds: ['participant-1'],
    rationale: 'Die Dauer ist noch offen.',
  };
}

function finalizationInput(): TranscriptFinalizationPromptInput {
  return {
    agentName: 'transcript_finalization',
    interviewId: INTERVIEW_ID,
    interviewStateVersion: 2,
    guide,
    interviewState: state({
      lifecycle: { status: 'completed', startedAt: NOW, endingAt: END, endedAt: END },
      activeWorkflowRunId: null,
    }),
    transcript: {
      ...transcript,
      entries: [
        ...transcript.entries,
        {
          kind: 'technical_gap' as const,
          gapId: 'gap-1',
          interviewId: INTERVIEW_ID,
          sequenceNumber: 3,
          description: 'Audiouebertragung fehlte kurz.',
          occurredAt: END,
          relatedSegmentId: null,
          sourceEventId: 'gap-source-1',
          source: 'transport' as const,
          sourceProvider: null,
          relatedUtteranceId: null,
        },
      ],
      finalizedAt: END,
    },
    deterministicValidation: { valid: true, issues: [] },
  };
}

function gapFinalizationOutput() {
  return {
    status: 'valid_with_gaps' as const,
    checkedCanonicalEntries: [
      { entryId: 'ai-1', kind: 'turn' as const },
      { entryId: 'participant-1', kind: 'turn' as const },
      { entryId: 'gap-1', kind: 'technical_gap' as const },
    ],
    checks: {
      chronologyValid: true,
      sequenceValid: true,
      speakerAssignmentsValid: true,
      noDuplicateTurns: true,
    },
    issues: [
      {
        code: 'technical_gap' as const,
        severity: 'warning' as const,
        canonicalEntryIds: ['gap-1'],
        description: 'Die technische Luecke bleibt sichtbar.',
      },
    ],
    rationale: 'Alle Eintraege wurden geprueft; eine technische Luecke bleibt erhalten.',
  };
}

function issueCodes(result: ReturnType<typeof validateCoverageAnalysisOutput>): string[] {
  return result.ok ? [] : result.issues.map((issue) => issue.code);
}

describe('coverage guardrail', () => {
  it('accepts exact participant evidence and rejects foreign candidates', () => {
    expect(validateCoverageAnalysisOutput(coverageInput(), coverageOutput()).ok).toBe(true);
    expect(
      issueCodes(
        validateCoverageAnalysisOutput(coverageInput(), {
          ...coverageOutput(),
          findings: [{ ...coverageOutput().findings[0]!, question: mainTwo }],
        }),
      ),
    ).toContain('question_not_allowed');
  });

  it('rejects AI evidence, missing latest evidence, and a non-exact reference union', () => {
    expect(
      issueCodes(
        validateCoverageAnalysisOutput(coverageInput(), {
          ...coverageOutput(),
          findings: [
            {
              ...coverageOutput().findings[0]!,
              transcriptTurnIds: ['ai-1'],
            },
          ],
          referencedTranscriptTurnIds: ['ai-1'],
        }),
      ),
    ).toEqual(expect.arrayContaining(['invalid_evidence', 'latest_turn_missing']));
    expect(
      issueCodes(
        validateCoverageAnalysisOutput(coverageInput(), {
          ...coverageOutput(),
          referencedTranscriptTurnIds: ['participant-1', 'ai-1'],
        }),
      ),
    ).toContain('reference_mismatch');
    expect(
      issueCodes(
        validateCoverageAnalysisOutput(coverageInput(), {
          findings: [
            {
              question: followOne,
              status: 'not_addressed',
              transcriptTurnIds: [],
              openAspects: ['Dauer'],
              rationale: 'Die Vertiefung wurde nicht beantwortet.',
            },
          ],
          referencedTranscriptTurnIds: [],
          rationale: 'Die aktuelle Frage fehlt unzulaessigerweise.',
        }),
      ),
    ).toContain('current_question_missing');
  });
});

describe('consistency guardrail', () => {
  it('accepts a reserved new ID and rejects unreserved or existing IDs', () => {
    const input = { ...consistencyInput(), transcript: transcriptWithEarlierParticipant() };
    expect(validateConsistencyAnalysisOutput(input, consistencyOutput()).ok).toBe(true);
    expect(
      validateConsistencyAnalysisOutput(input, {
        ...consistencyOutput(),
        contradictions: [contradiction('unreserved-1')],
      }).ok,
    ).toBe(false);
    expect(
      validateConsistencyAnalysisOutput(
        { ...input, allowedContradictionIds: ['existing-1'] },
        { ...consistencyOutput(), contradictions: [contradiction('existing-1')] },
      ).ok,
    ).toBe(false);
  });

  it('rejects AI evidence and contradictions that omit the latest turn', () => {
    const input = { ...consistencyInput(), transcript: transcriptWithEarlierParticipant() };
    expect(
      validateConsistencyAnalysisOutput(input, {
        contradictions: [contradiction('reserved-1', ['participant-2', 'ai-1'])],
        referencedTranscriptTurnIds: ['participant-2', 'ai-1'],
        rationale: 'Die Evidenz ist unzulaessig.',
      }).ok,
    ).toBe(false);
    expect(
      validateConsistencyAnalysisOutput(input, {
        contradictions: [contradiction('reserved-1', ['participant-2', 'participant-3'])],
        referencedTranscriptTurnIds: ['participant-2', 'participant-3'],
        rationale: 'Die letzte Antwort fehlt.',
      }).ok,
    ).toBe(false);
  });

  it('rejects a suggestive clarification question', () => {
    const input = { ...consistencyInput(), transcript: transcriptWithEarlierParticipant() };
    const output = consistencyOutput();
    expect(
      validateConsistencyAnalysisOutput(input, {
        ...output,
        contradictions: [
          {
            ...output.contradictions[0]!,
            suggestedClarificationQuestion:
              'Wuerden Sie nicht zustimmen, dass Frau A verantwortlich war?',
          },
        ],
      }).ok,
    ).toBe(false);
  });
});

describe('decision guardrail', () => {
  it('uses effective coverage findings over stale persisted coverage for completion', () => {
    const allTerminalInput = decisionInput({
      interviewState: state({
        currentMainQuestion: null,
        coverage: [
          coverage(mainOne),
          coverage(followOne, 'not_addressed'),
          coverage(mainTwo, 'answered'),
          coverage(followTwo, 'not_addressed'),
        ],
      }),
      coverageAnalysis: {
        findings: [
          {
            question: mainOne,
            status: 'answered',
            transcriptTurnIds: ['participant-1'],
            openAspects: [],
            rationale: 'Die Hauptfrage ist vollstaendig beantwortet.',
          },
        ],
        referencedTranscriptTurnIds: ['participant-1'],
        rationale: 'Die letzte Antwort schliesst die offene Hauptfrage.',
      },
      currentQuestion: null,
      candidateQuestionIds: [],
    });
    const completion = {
      selectedAction: { action: 'complete_interview' as const },
      referencedTranscriptTurnIds: ['participant-1'],
      consideredQuestions: [],
      rationale: 'Alle Hauptfragen sind beantwortet.',
    };
    expect(validateInterviewDecisionOutput(allTerminalInput, completion).ok).toBe(true);
    expect(
      validateInterviewDecisionOutput(decisionInput({ candidateQuestionIds: [] }), completion).ok,
    ).toBe(false);
  });

  it('accepts a normal open target and enforces main order and follow-up parent', () => {
    expect(validateInterviewDecisionOutput(decisionInput(), followUpDecision()).ok).toBe(true);
    const outOfOrder = {
      selectedAction: { action: 'ask_main_question' as const, target: mainTwo },
      referencedTranscriptTurnIds: [],
      consideredQuestions: [mainTwo],
      rationale: 'Waehlt die spaetere Hauptfrage.',
    };
    expect(validateInterviewDecisionOutput(decisionInput(), outOfOrder).ok).toBe(false);
    const wrongParent = {
      selectedAction: { action: 'ask_follow_up_question' as const, target: followTwo },
      referencedTranscriptTurnIds: [],
      consideredQuestions: [followTwo],
      rationale: 'Waehlt eine Vertiefung unter einer anderen Hauptfrage.',
    };
    expect(validateInterviewDecisionOutput(decisionInput(), wrongParent).ok).toBe(false);
    expect(
      validateInterviewDecisionOutput(decisionInput(), {
        ...followUpDecision(),
        referencedTranscriptTurnIds: [],
      }).ok,
    ).toBe(false);
  });

  it('rejects repeating an answered-once partial follow-up while the next main question is unasked', () => {
    const earlierParticipant = {
      kind: 'turn' as const,
      turnId: 'participant-earlier',
      interviewId: INTERVIEW_ID,
      sequenceNumber: 2,
      speaker: 'participant' as const,
      text: 'Ich leite Forschung.',
      occurredAt: LATER,
      turnType: 'participant_answer' as const,
      guideReference: mainOne,
      sourceProvider: 'demo',
      providerEventId: 'provider-earlier',
      sourceSegmentId: 'segment-earlier',
    };
    const followUpAiTurn = {
      kind: 'turn' as const,
      turnId: 'ai-follow-up',
      interviewId: INTERVIEW_ID,
      sequenceNumber: 3,
      speaker: 'ai_interviewer' as const,
      text: 'Seit wann arbeiten Sie dort?',
      occurredAt: '2026-08-12T10:01:30.000Z',
      turnType: 'follow_up_question' as const,
      guideReference: followOne,
      deliveryEventId: 'delivery-follow-up',
      delivery: { status: 'complete' as const },
    };
    const latestParticipant = {
      kind: 'turn' as const,
      turnId: 'participant-1',
      interviewId: INTERVIEW_ID,
      sequenceNumber: 4,
      speaker: 'participant' as const,
      text: 'Seit einiger Zeit.',
      occurredAt: END,
      turnType: 'participant_answer' as const,
      guideReference: followOne,
      sourceProvider: 'demo',
      providerEventId: 'provider-1',
      sourceSegmentId: 'segment-1',
    };
    const input = decisionInput({
      interviewState: state({
        coverage: [
          coverage(mainOne, 'answered'),
          { question: followOne, status: 'current', transcriptTurnIds: ['participant-earlier'] },
          coverage(mainTwo, 'not_addressed'),
          coverage(followTwo, 'not_addressed'),
        ],
      }),
      transcript: {
        ...transcript,
        entries: [transcript.entries[0]!, earlierParticipant, followUpAiTurn, latestParticipant],
      },
      coverageAnalysis: {
        findings: [
          {
            question: followOne,
            status: 'partially_answered',
            transcriptTurnIds: ['participant-1'],
            openAspects: ['Konkretes Beispiel'],
            rationale: 'Die Antwort bleibt teilweise offen.',
          },
        ],
        referencedTranscriptTurnIds: ['participant-1'],
        rationale: 'Die Vertiefungsfrage ist teilweise beantwortet.',
      },
      currentQuestion: followOne,
      candidateQuestionIds: ['follow-1', 'main-2', 'follow-2'],
    });

    expect(validateInterviewDecisionOutput(input, followUpDecision()).ok).toBe(false);
    expect(
      validateInterviewDecisionOutput(input, {
        selectedAction: { action: 'ask_main_question', target: mainTwo },
        referencedTranscriptTurnIds: ['participant-1'],
        consideredQuestions: [mainTwo],
        rationale: 'Wechselt zur naechsten noch nicht gestellten Hauptfrage.',
      }).ok,
    ).toBe(true);
  });

  it('rejects an unbound clarification', () => {
    const clarification = {
      selectedAction: {
        action: 'ask_clarification_question' as const,
        target: mainOne,
        basis: {
          kind: 'contradiction' as const,
          contradictionId: 'missing-contradiction',
          sourceQuestion: 'Wer trug letztlich die Verantwortung?',
        },
        clarificationObjective: 'Verantwortung klaeren',
      },
      referencedTranscriptTurnIds: [],
      consideredQuestions: [mainOne],
      rationale: 'Versucht eine nicht belegte Klaerung.',
    };
    expect(validateInterviewDecisionOutput(decisionInput(), clarification).ok).toBe(false);
  });
});

describe('conductor guardrail', () => {
  it('accepts matching action, reference, text, preface, and evidence subset', () => {
    expect(validateConductorOutput(conductorInput(), conductorOutput()).ok).toBe(true);
  });

  it('rejects action/reference, clarification text, preface, and evidence mismatches', () => {
    expect(
      validateConductorOutput(conductorInput(), { ...conductorOutput(), action: 'close' }).ok,
    ).toBe(false);
    expect(
      validateConductorOutput(conductorInput(), {
        ...conductorOutput(),
        question: { ...conductorOutput().question, guideReference: followTwo },
      }).ok,
    ).toBe(false);
    expect(
      validateConductorOutput(conductorInput(), {
        ...conductorOutput(),
        question: {
          ...conductorOutput().question,
          text: 'Wuerden Sie nicht zustimmen, dass Sie dort lange arbeiten?',
        },
      }).ok,
    ).toBe(false);
    expect(
      validateConductorOutput(conductorInput(), {
        ...conductorOutput(),
        referencedTranscriptTurnIds: [],
      }).ok,
    ).toBe(false);
    expect(
      validateConductorOutput(conductorInput({ allowTransition: false }), conductorOutput()).ok,
    ).toBe(false);
    expect(
      validateConductorOutput(conductorInput(), {
        ...conductorOutput(),
        referencedTranscriptTurnIds: ['ai-1'],
      }).ok,
    ).toBe(false);

    const clarificationDecision = {
      selectedAction: {
        action: 'ask_clarification_question' as const,
        target: mainOne,
        basis: {
          kind: 'contradiction' as const,
          contradictionId: 'reserved-1',
          sourceQuestion: 'Wer trug letztlich die Verantwortung?',
        },
        clarificationObjective: 'Verantwortung klaeren',
      },
      referencedTranscriptTurnIds: ['participant-1'],
      consideredQuestions: [mainOne],
      rationale: 'Eine Klaerung ist erforderlich.',
    };
    expect(
      validateConductorOutput(
        conductorInput({
          decision: clarificationDecision,
          selectedQuestionText: null,
          requiredClarificationQuestion: 'Wer trug letztlich die Verantwortung?',
          allowTransition: false,
        }),
        {
          ...conductorOutput(),
          preface: null,
          question: {
            turnType: 'clarification_question',
            text: 'War Frau A verantwortlich?',
            guideReference: mainOne,
          },
        },
      ).ok,
    ).toBe(false);
  });
});

describe('transcript finalization guardrail', () => {
  it('accepts exact entries, deterministic checks, and one warning for each gap', () => {
    expect(
      validateTranscriptFinalizationOutput(finalizationInput(), gapFinalizationOutput()).ok,
    ).toBe(true);
  });

  it('rejects incomplete entries, any failed deterministic check, and missing gap accounting', () => {
    const output = gapFinalizationOutput();
    expect(
      validateTranscriptFinalizationOutput(finalizationInput(), {
        ...output,
        checkedCanonicalEntries: output.checkedCanonicalEntries.slice(0, 2),
      }).ok,
    ).toBe(false);
    expect(
      validateTranscriptFinalizationOutput(finalizationInput(), {
        ...output,
        checks: { ...output.checks, chronologyValid: false },
      }).ok,
    ).toBe(false);
    expect(
      validateTranscriptFinalizationOutput(finalizationInput(), {
        ...output,
        status: 'valid',
        issues: [],
      }).ok,
    ).toBe(false);
  });

  it('rejects invalid deterministic validation that the agent reports as valid', () => {
    const input = finalizationInput();
    const invalidInput: TranscriptFinalizationPromptInput = {
      ...input,
      deterministicValidation: {
        valid: false,
        issues: [{ code: 'sequence_error', message: 'Sequence mismatch', entryId: 'ai-1' }],
      },
    };
    expect(validateTranscriptFinalizationOutput(invalidInput, gapFinalizationOutput()).ok).toBe(
      false,
    );
  });
});
