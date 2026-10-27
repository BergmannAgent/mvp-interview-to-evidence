import { describe, expect, it } from 'vitest';

import {
  interviewClosingText,
  interviewGreetingText,
  interviewTechnicalGapDescription,
  toAgentGuideContract,
} from './canonical-interview-session-service.js';

const CREATED_AT = '2026-08-14T10:00:00.000Z';

describe('canonical interview session locale copy', () => {
  it('keeps spoken framing and technical gap descriptions in the interview language', () => {
    expect(interviewGreetingText('en')).toMatch(/^Hello/u);
    expect(interviewClosingText('en')).toMatch(/^Thank you/u);
    expect(interviewTechnicalGapDescription('en', 'pending_ai_cancelled')).toBe(
      'The pending AI output was cancelled when the interview ended.',
    );
    expect(interviewTechnicalGapDescription('en', 'partial_not_finalized')).toMatch(
      /^A partial speech recognition segment/u,
    );
    expect(interviewTechnicalGapDescription('de', 'exact_utterance_mismatch')).toMatch(
      /^Der Anbieter/u,
    );
    expect(interviewTechnicalGapDescription('de', 'unconfirmed_interruption')).toMatch(
      /^Die AI-Audioausgabe/u,
    );
  });

  it('preserves an English guide language at the agent contract boundary', () => {
    const guide = toAgentGuideContract({
      id: 'guide-english-agent-contract',
      sourceLanguage: 'en',
      title: 'Interview guide',
      sourceMarkdown: '# Interview guide',
      createdAt: CREATED_AT,
      sections: [
        {
          id: 'section-1',
          position: 0,
          title: 'Introduction',
          mainQuestions: [
            {
              id: 'main-1',
              position: 0,
              text: 'What is your role?',
              followUpQuestions: [],
            },
          ],
        },
      ],
    });

    expect(guide.sourceLanguage).toBe('en');
  });
});
