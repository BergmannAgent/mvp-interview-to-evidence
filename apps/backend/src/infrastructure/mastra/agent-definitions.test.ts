import { Agent } from '@mastra/core/agent';
import type { AgentName } from '@orgscience/contracts';
import { describe, expect, it } from 'vitest';

import { AgentConfigurationError, createInterviewAgents } from './agent-definitions.js';

const EXPECTED_AGENTS: Readonly<Record<AgentName, string>> = {
  coverage_analysis: 'Coverage Analysis Agent',
  consistency_analysis: 'Consistency Analysis Agent',
  interview_decision: 'Interview Decision Agent',
  interview_conductor: 'Interview Conductor Agent',
  transcript_finalization: 'Transcript Finalization Agent',
};

describe('createInterviewAgents', () => {
  it('creates the complete stable Mastra agent registry without provider calls', async () => {
    const model = 'openai/gpt-5.4-mini';
    const agents = createInterviewAgents(model);

    expect(Object.keys(agents)).toEqual(Object.keys(EXPECTED_AGENTS));

    for (const agentName of Object.keys(EXPECTED_AGENTS) as AgentName[]) {
      const agent = agents[agentName];

      expect(agent).toBeInstanceOf(Agent);
      expect(agent.id).toBe(agentName);
      expect(agent.name).toBe(EXPECTED_AGENTS[agentName]);
      expect(agent.model).toBe(model);
      expect(agent.maxRetries).toBe(0);
      expect(await agent.listTools()).toEqual({});
      expect(agent.hasOwnMemory()).toBe(false);
    }
  });

  it('configures guide-bounded and auditable role instructions', async () => {
    const agents = createInterviewAgents('openai/gpt-5.4-mini');

    const coverageInstructions = await agents.coverage_analysis.getInstructions();
    const consistencyInstructions = await agents.consistency_analysis.getInstructions();
    const decisionInstructions = await agents.interview_decision.getInstructions();
    const conductorInstructions = await agents.interview_conductor.getInstructions();
    const finalizationInstructions = await agents.transcript_finalization.getInstructions();

    expect(coverageInstructions).toContain('Do not invent content');
    expect(coverageInstructions).toContain('or communicate with the participant');
    expect(consistencyInstructions).toContain('Report possible contradictions conservatively');
    expect(decisionInstructions).toContain('Do not formulate participant-facing prose');
    expect(decisionInstructions).toContain(
      'only for an item in consistencyAnalysis.contradictions whose shouldClarify value is true',
    );
    expect(decisionInstructions).toContain(
      'its suggestedClarificationQuestion verbatim to basis.sourceQuestion',
    );
    expect(decisionInstructions).toContain('Coverage openAspects are not contradictions');
    expect(decisionInstructions).not.toContain('allowed open aspect');
    expect(conductorInstructions).toContain('ask exactly one');
    expect(conductorInstructions).toContain('neutral, non-leading question');
    expect(finalizationInstructions).toContain(
      'never rewrite, paraphrase, complete, repair, or invent',
    );

    for (const instructions of [
      coverageInstructions,
      consistencyInstructions,
      decisionInstructions,
      conductorInstructions,
      finalizationInstructions,
    ]) {
      expect(instructions).toContain('never provide private chain of thought');
    }
  });

  it.each(['', '   ', ' openai/gpt-5.4-mini', 'openai/gpt-5.4-mini\n'])(
    'rejects an invalid model configuration: %j',
    (model) => {
      expect(() => createInterviewAgents(model)).toThrowError(AgentConfigurationError);
      expect(() => createInterviewAgents(model)).toThrow(
        'Agent model must be a non-empty, trimmed string.',
      );
    },
  );
});
