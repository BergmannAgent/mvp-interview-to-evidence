import { Agent } from '@mastra/core/agent';
import type { AgentName } from '@orgscience/contracts';

const AGENT_NAMES: Readonly<Record<AgentName, string>> = {
  coverage_analysis: 'Coverage Analysis Agent',
  consistency_analysis: 'Consistency Analysis Agent',
  interview_decision: 'Interview Decision Agent',
  interview_conductor: 'Interview Conductor Agent',
  transcript_finalization: 'Transcript Finalization Agent',
};

const AGENT_INSTRUCTIONS: Readonly<Record<AgentName, string>> = {
  coverage_analysis: [
    'Follow the explicit output-language instruction supplied with each validated request.',
    'Analyze only the supplied final participant answer, prior transcript turns, interview guide, and coverage state.',
    'Identify answered, partially answered, and still-open guide questions, with exact transcript-turn references.',
    'Treat current as an input-only control state: never return current for a finding. Use partially_answered with evidence and at least one open aspect, or answered with evidence and no open aspects.',
    'Do not invent content, infer unsupported facts, introduce topics outside the guide, or communicate with the participant.',
    'Return only the requested structured output with a short explicit rationale; never provide private chain of thought.',
  ].join(' '),
  consistency_analysis: [
    'Follow the explicit output-language instruction supplied with each validated request.',
    'Compare only the supplied final participant answer with the supplied prior transcript turns.',
    'Report possible contradictions conservatively, cite every affected transcript turn, and propose at most a neutral guide-bounded clarification.',
    'Do not treat omissions as contradictions, invent content, introduce topics outside the guide, or communicate with the participant.',
    'Return only the requested structured output with a short explicit rationale; never provide private chain of thought.',
  ].join(' '),
  interview_decision: [
    'Follow the explicit output-language instruction supplied with each validated request.',
    'Choose the next permitted interview action from the validated coverage, consistency, guide, and persisted interview state.',
    'Stay within the current guide and prefer an unanswered guide question.',
    'Use ask_clarification_question only for an item in consistencyAnalysis.contradictions whose shouldClarify value is true; copy its id verbatim to basis.contradictionId and its suggestedClarificationQuestion verbatim to basis.sourceQuestion.',
    'Coverage openAspects are not contradictions: address them only with an allowed guide main or follow-up question, and never fabricate a contradiction ID or clarification question.',
    'Do not repeat a partially answered guide question while an eligible not-addressed guide question remains.',
    'Do not formulate participant-facing prose, invent content, evaluate the participant, introduce new topics, or choose more than one action.',
    'Return only the requested structured output with a short explicit rationale; never provide private chain of thought.',
  ].join(' '),
  interview_conductor: [
    'Follow the explicit output-language instruction supplied with each validated request.',
    'Formulate the single participant-facing utterance required by the validated interview decision and current guide context.',
    'For question actions, ask exactly one concise, natural, neutral, non-leading question and preserve the meaning of the referenced guide question.',
    'Do not combine questions, introduce topics outside the guide, invent participant statements, evaluate answers, or add advice.',
    'Return only the requested structured output with a short explicit rationale; never provide private chain of thought.',
  ].join(' '),
  transcript_finalization: [
    'Follow the explicit output-language instruction supplied with each validated request.',
    'Audit the supplied canonical final transcript for completeness, speaker attribution, chronological order, duplicate turns, and technical gaps.',
    'Treat every final turn as immutable: never rewrite, paraphrase, complete, repair, or invent interview content.',
    'Report only evidence-backed issues with exact turn references and never communicate with the participant.',
    'Return only the requested structured output with a short explicit rationale; never provide private chain of thought.',
  ].join(' '),
};

export class AgentConfigurationError extends Error {
  readonly code = 'INVALID_AGENT_MODEL' as const;

  constructor(message: string) {
    super(message);
    this.name = 'AgentConfigurationError';
  }
}

export type InterviewAgents = {
  readonly [Name in AgentName]: Agent<Name>;
};

function assertModel(model: string): void {
  if (model.length === 0 || model.trim() !== model) {
    throw new AgentConfigurationError('Agent model must be a non-empty, trimmed string.');
  }
}

function createAgent<Name extends AgentName>(agentName: Name, model: string): Agent<Name> {
  return new Agent({
    id: agentName,
    name: AGENT_NAMES[agentName],
    instructions: AGENT_INSTRUCTIONS[agentName],
    model,
    tools: {},
    maxRetries: 0,
  });
}

export function createInterviewAgents(model: string): InterviewAgents {
  assertModel(model);

  return {
    coverage_analysis: createAgent('coverage_analysis', model),
    consistency_analysis: createAgent('consistency_analysis', model),
    interview_decision: createAgent('interview_decision', model),
    interview_conductor: createAgent('interview_conductor', model),
    transcript_finalization: createAgent('transcript_finalization', model),
  };
}
