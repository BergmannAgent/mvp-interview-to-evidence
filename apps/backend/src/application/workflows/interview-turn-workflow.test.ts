import type {
  ConductorOutput,
  ConsistencyAnalysisOutput,
  CoverageAnalysisOutput,
  InterviewDecisionOutput,
} from '@orgscience/contracts';
import { describe, expect, it } from 'vitest';

import {
  createInterviewTurnWorkflow,
  type InterviewTurnWorkflowAgentRunner,
  type InterviewTurnWorkflowInput,
} from './interview-turn-workflow.js';

const NOW = '2026-08-14T10:00:00.000Z';
const LATER = '2026-08-14T10:01:00.000Z';
const GUIDE_ID = 'guide-parallel-workflow-1';
const INTERVIEW_ID = 'interview-parallel-workflow-1';
const WORKFLOW_RUN_ID = 'workflow-parallel-workflow-1';

const mainQuestion = {
  kind: 'main_question' as const,
  guideId: GUIDE_ID,
  sectionId: 'section-1',
  mainQuestionId: 'main-1',
};
const followUpQuestion = {
  kind: 'follow_up_question' as const,
  guideId: GUIDE_ID,
  sectionId: 'section-1',
  mainQuestionId: 'main-1',
  followUpQuestionId: 'follow-up-1',
};

const workflowInput: InterviewTurnWorkflowInput = {
  coverageInput: {
    agentName: 'coverage_analysis',
    ...commonInput(),
    latestParticipantTurnId: 'participant-turn-1',
    currentQuestion: mainQuestion,
    candidateQuestionIds: ['main-1', 'follow-up-1'],
  },
  consistencyInput: {
    agentName: 'consistency_analysis',
    ...commonInput(),
    latestParticipantTurnId: 'participant-turn-1',
    currentQuestion: mainQuestion,
    allowedContradictionIds: ['contradiction-1'],
    existingContradictionIds: [],
  },
  questionTextById: {
    'main-1': 'Welche Rolle haben Sie?',
    'follow-up-1': 'Seit wann arbeiten Sie in dieser Position?',
  },
  allowTransition: false,
};

const coverageAnalysis: CoverageAnalysisOutput = {
  findings: [
    {
      question: mainQuestion,
      status: 'answered',
      transcriptTurnIds: ['participant-turn-1'],
      openAspects: [],
      rationale: 'Die aktuelle Hauptfrage wurde beantwortet.',
    },
  ],
  referencedTranscriptTurnIds: ['participant-turn-1'],
  rationale: 'Die Antwort belegt die aktuelle Hauptfrage.',
};

const consistencyAnalysis: ConsistencyAnalysisOutput = {
  contradictions: [],
  referencedTranscriptTurnIds: [],
  rationale: 'Es liegt kein belegter Widerspruch vor.',
};

const decision: InterviewDecisionOutput = {
  selectedAction: { action: 'ask_follow_up_question', target: followUpQuestion },
  referencedTranscriptTurnIds: ['participant-turn-1'],
  consideredQuestions: [mainQuestion, followUpQuestion],
  rationale: 'Die offene Vertiefungsfrage wird als naechstes gestellt.',
};

const conductor: ConductorOutput = {
  action: 'ask',
  preface: null,
  question: {
    turnType: 'follow_up_question',
    text: 'Seit wann arbeiten Sie in dieser Position?',
    guideReference: followUpQuestion,
  },
  referencedTranscriptTurnIds: ['participant-turn-1'],
  rationale: 'Die validierte Leitfadenfrage wird unveraendert gestellt.',
};

describe('interview turn workflow', () => {
  it('runs coverage and consistency concurrently before decision and conductor', async () => {
    const events: string[] = [];
    const bothAnalysesStarted = deferred<void>();
    const releaseAnalyses = deferred<void>();
    let startedAnalyses = 0;
    const markAnalysisStarted = (name: string): void => {
      events.push(`${name}:started`);
      startedAnalyses += 1;
      if (startedAnalyses === 2) bothAnalysesStarted.resolve();
    };
    const runner: InterviewTurnWorkflowAgentRunner = {
      executeCoverageAnalysis: async () => {
        markAnalysisStarted('coverage');
        await releaseAnalyses.promise;
        events.push('coverage:completed');
        return coverageAnalysis;
      },
      executeConsistencyAnalysis: async () => {
        markAnalysisStarted('consistency');
        await releaseAnalyses.promise;
        events.push('consistency:completed');
        return consistencyAnalysis;
      },
      executeInterviewDecision: async (input) => {
        events.push('decision');
        expect(input.coverageAnalysis).toEqual(coverageAnalysis);
        expect(input.consistencyAnalysis).toEqual(consistencyAnalysis);
        return decision;
      },
      executeInterviewConductor: async () => {
        events.push('conductor');
        return conductor;
      },
    };
    const workflow = createInterviewTurnWorkflow(runner);
    const run = await workflow.createRun({ runId: WORKFLOW_RUN_ID, disableScorers: true });
    const execution = run.start({ inputData: workflowInput });

    const startedInParallel = await Promise.race([
      bothAnalysesStarted.promise.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
    ]);
    releaseAnalyses.resolve();
    const result = await execution;

    expect(startedInParallel).toBe(true);
    expect(events.slice(0, 2).sort()).toEqual(['consistency:started', 'coverage:started']);
    expect(events.indexOf('decision')).toBeGreaterThan(events.indexOf('coverage:completed'));
    expect(events.indexOf('decision')).toBeGreaterThan(events.indexOf('consistency:completed'));
    expect(events.at(-1)).toBe('conductor');
    expect(result).toMatchObject({
      status: 'success',
      result: { coverageAnalysis, consistencyAnalysis, decision, conductor },
    });
  });
});

function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value | PromiseLike<Value>) => void;
} {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function commonInput() {
  return {
    interviewId: INTERVIEW_ID,
    interviewStateVersion: 4,
    guide: {
      id: GUIDE_ID,
      sourceLanguage: 'de' as const,
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
    },
    interviewState: {
      interviewId: INTERVIEW_ID,
      guideId: GUIDE_ID,
      language: 'de' as const,
      lifecycle: { status: 'active' as const, startedAt: NOW, activeSince: NOW },
      currentMainQuestion: mainQuestion,
      coverage: [
        { question: mainQuestion, status: 'current' as const, transcriptTurnIds: [] },
        {
          question: followUpQuestion,
          status: 'not_addressed' as const,
          transcriptTurnIds: [],
        },
      ],
      activeWorkflowRunId: WORKFLOW_RUN_ID,
      version: 4,
      createdAt: NOW,
      updatedAt: LATER,
    },
    transcript: {
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
          guideReference: mainQuestion,
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
          guideReference: mainQuestion,
          sourceProvider: 'demo',
          providerEventId: 'provider-event-1',
          sourceSegmentId: 'segment-1',
        },
      ],
      finalizedAt: null,
    },
  };
}
