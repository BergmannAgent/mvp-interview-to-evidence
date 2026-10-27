import { createStep, createWorkflow } from '@mastra/core/workflows';
import {
  conductorOutputSchema,
  consistencyAnalysisOutputSchema,
  coverageAnalysisOutputSchema,
  idSchema,
  interviewDecisionOutputSchema,
  nonBlankTextSchema,
  type ConductorOutput,
  type ConsistencyAnalysisOutput,
  type CoverageAnalysisOutput,
  type InterviewDecisionOutput,
} from '@orgscience/contracts';
import { z } from 'zod';

import {
  consistencyAnalysisPromptInputSchema,
  coverageAnalysisPromptInputSchema,
  interviewConductorPromptInputSchema,
  interviewDecisionPromptInputSchema,
  type ConsistencyAnalysisPromptInput,
  type CoverageAnalysisPromptInput,
  type InterviewConductorPromptInput,
  type InterviewDecisionPromptInput,
} from '../agents/index.js';

const questionTextByIdSchema = z.record(idSchema, nonBlankTextSchema.max(2_000));

export const interviewTurnWorkflowInputSchema = z.strictObject({
  coverageInput: coverageAnalysisPromptInputSchema,
  consistencyInput: consistencyAnalysisPromptInputSchema,
  questionTextById: questionTextByIdSchema,
  allowTransition: z.boolean(),
});

const coverageStepOutputSchema = z.strictObject({
  workflowInput: interviewTurnWorkflowInputSchema,
  coverageAnalysis: coverageAnalysisOutputSchema,
});

const consistencyStepOutputSchema = z.strictObject({
  workflowInput: interviewTurnWorkflowInputSchema,
  consistencyAnalysis: consistencyAnalysisOutputSchema,
});

const parallelAnalysisOutputSchema = z.strictObject({
  'coverage-analysis': coverageStepOutputSchema,
  'consistency-analysis': consistencyStepOutputSchema,
});

const decisionStepOutputSchema = z.strictObject({
  workflowInput: interviewTurnWorkflowInputSchema,
  coverageAnalysis: coverageAnalysisOutputSchema,
  consistencyAnalysis: consistencyAnalysisOutputSchema,
  decision: interviewDecisionOutputSchema,
});

export const interviewTurnWorkflowOutputSchema = z.strictObject({
  coverageAnalysis: coverageAnalysisOutputSchema,
  consistencyAnalysis: consistencyAnalysisOutputSchema,
  decision: interviewDecisionOutputSchema,
  conductor: conductorOutputSchema,
});

export type InterviewTurnWorkflowInput = z.infer<typeof interviewTurnWorkflowInputSchema>;
export type InterviewTurnWorkflowOutput = z.infer<typeof interviewTurnWorkflowOutputSchema>;

export interface InterviewTurnWorkflowAgentRunner {
  executeCoverageAnalysis(
    input: CoverageAnalysisPromptInput,
    signal: AbortSignal,
  ): Promise<CoverageAnalysisOutput>;
  executeConsistencyAnalysis(
    input: ConsistencyAnalysisPromptInput,
    signal: AbortSignal,
  ): Promise<ConsistencyAnalysisOutput>;
  executeInterviewDecision(
    input: InterviewDecisionPromptInput,
    signal: AbortSignal,
  ): Promise<InterviewDecisionOutput>;
  executeInterviewConductor(
    input: InterviewConductorPromptInput,
    signal: AbortSignal,
  ): Promise<ConductorOutput>;
}

export function createInterviewTurnWorkflow(runner: InterviewTurnWorkflowAgentRunner) {
  const coverageStep = createStep({
    id: 'coverage-analysis',
    inputSchema: interviewTurnWorkflowInputSchema,
    outputSchema: coverageStepOutputSchema,
    execute: async ({ inputData, abortSignal }) => ({
      workflowInput: inputData,
      coverageAnalysis: await runner.executeCoverageAnalysis(inputData.coverageInput, abortSignal),
    }),
  });

  const consistencyStep = createStep({
    id: 'consistency-analysis',
    inputSchema: interviewTurnWorkflowInputSchema,
    outputSchema: consistencyStepOutputSchema,
    execute: async ({ inputData, abortSignal }) => ({
      workflowInput: inputData,
      consistencyAnalysis: await runner.executeConsistencyAnalysis(
        inputData.consistencyInput,
        abortSignal,
      ),
    }),
  });

  const decisionStep = createStep({
    id: 'interview-decision',
    inputSchema: parallelAnalysisOutputSchema,
    outputSchema: decisionStepOutputSchema,
    execute: async ({ inputData, abortSignal }) => {
      const analysis = combineParallelAnalysis(inputData);
      const input = createDecisionInput(analysis);
      return {
        ...analysis,
        decision: await runner.executeInterviewDecision(input, abortSignal),
      };
    },
  });

  const conductorStep = createStep({
    id: 'conductor-question-generation',
    inputSchema: decisionStepOutputSchema,
    outputSchema: interviewTurnWorkflowOutputSchema,
    execute: async ({ inputData, abortSignal }) => {
      const input = createConductorInput(inputData);
      return {
        coverageAnalysis: inputData.coverageAnalysis,
        consistencyAnalysis: inputData.consistencyAnalysis,
        decision: inputData.decision,
        conductor: await runner.executeInterviewConductor(input, abortSignal),
      };
    },
  });

  return createWorkflow({
    id: 'interview-turn-workflow',
    description: 'Analyzes one final participant turn and selects one guide-bounded response.',
    inputSchema: interviewTurnWorkflowInputSchema,
    outputSchema: interviewTurnWorkflowOutputSchema,
  })
    .parallel([coverageStep, consistencyStep])
    .then(decisionStep)
    .then(conductorStep)
    .commit();
}

function createDecisionInput(
  input: Omit<z.infer<typeof decisionStepOutputSchema>, 'decision'>,
): InterviewDecisionPromptInput {
  const base = input.workflowInput.coverageInput;
  return interviewDecisionPromptInputSchema.parse({
    agentName: 'interview_decision',
    interviewId: base.interviewId,
    interviewStateVersion: base.interviewStateVersion,
    guide: base.guide,
    interviewState: base.interviewState,
    transcript: base.transcript,
    coverageAnalysis: input.coverageAnalysis,
    consistencyAnalysis: input.consistencyAnalysis,
    currentQuestion: base.currentQuestion,
    candidateQuestionIds: base.candidateQuestionIds,
  });
}

function combineParallelAnalysis(
  input: z.infer<typeof parallelAnalysisOutputSchema>,
): Omit<z.infer<typeof decisionStepOutputSchema>, 'decision'> {
  return {
    workflowInput: input['coverage-analysis'].workflowInput,
    coverageAnalysis: input['coverage-analysis'].coverageAnalysis,
    consistencyAnalysis: input['consistency-analysis'].consistencyAnalysis,
  };
}

function createConductorInput(
  input: z.infer<typeof decisionStepOutputSchema>,
): InterviewConductorPromptInput {
  const base = input.workflowInput.coverageInput;
  const action = input.decision.selectedAction;
  const selectedQuestionText =
    action.action === 'ask_main_question'
      ? (input.workflowInput.questionTextById[action.target.mainQuestionId] ?? null)
      : action.action === 'ask_follow_up_question'
        ? (input.workflowInput.questionTextById[action.target.followUpQuestionId] ?? null)
        : null;
  const requiredClarificationQuestion =
    action.action === 'ask_clarification_question' ? action.basis.sourceQuestion : null;

  return interviewConductorPromptInputSchema.parse({
    agentName: 'interview_conductor',
    interviewId: base.interviewId,
    interviewStateVersion: base.interviewStateVersion,
    guide: base.guide,
    interviewState: base.interviewState,
    transcript: base.transcript,
    decision: input.decision,
    selectedQuestionText,
    requiredClarificationQuestion,
    allowGreeting: false,
    allowTransition: input.workflowInput.allowTransition,
  });
}
