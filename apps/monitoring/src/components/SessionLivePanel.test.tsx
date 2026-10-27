import { mvpInterviewSessionSchema } from '@orgscience/contracts';
import { LocaleProvider } from '@orgscience/frontend-i18n';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { SessionTranscriptPanel } from './SessionLivePanel.js';

describe('SessionTranscriptPanel', () => {
  it('renders technical gaps in canonical sequence and marks canonical content language', () => {
    const session = mvpInterviewSessionSchema.parse({
      interviewId: 'interview-1',
      guideId: 'guide-1',
      language: 'en',
      guideTitle: 'Research interview',
      status: 'completed',
      currentQuestionIndex: 0,
      totalQuestions: 1,
      currentQuestion: null,
      startedAt: '2026-09-01T10:00:00.000Z',
      endedAt: '2026-09-01T10:05:00.000Z',
      updatedAt: '2026-09-01T10:05:01.000Z',
      partialTranscript: null,
      transcript: [
        {
          turnId: 'turn-1',
          interviewId: 'interview-1',
          sequenceNumber: 1,
          speaker: 'participant',
          turnType: 'participant_answer',
          text: 'Text before gap.',
          occurredAt: '2026-09-01T10:01:00.000Z',
          guideReference: null,
          interrupted: false,
        },
        {
          turnId: 'turn-3',
          interviewId: 'interview-1',
          sequenceNumber: 3,
          speaker: 'ai_interviewer',
          turnType: 'closing',
          text: 'Text after gap.',
          occurredAt: '2026-09-01T10:03:00.000Z',
          guideReference: null,
          interrupted: false,
        },
      ],
      technicalGaps: [
        {
          gapId: 'gap-2',
          interviewId: 'interview-1',
          sequenceNumber: 2,
          source: 'transport',
          description: 'Technical gap between turns.',
          occurredAt: '2026-09-01T10:02:00.000Z',
        },
      ],
      finalizedAt: '2026-09-01T10:05:02.000Z',
    });
    const html = renderToStaticMarkup(
      <LocaleProvider fallbackLocale="de" storageKey="monitoring-session-test">
        <SessionTranscriptPanel session={session} />
      </LocaleProvider>,
    );

    expect(html.indexOf('Text before gap.')).toBeLessThan(
      html.indexOf('Technical gap between turns.'),
    );
    expect(html.indexOf('Technical gap between turns.')).toBeLessThan(
      html.indexOf('Text after gap.'),
    );
    expect(html).toContain('<p lang="en">Text before gap.</p>');
    expect(html).toContain('<p lang="en">Technical gap between turns.</p>');
  });
});
