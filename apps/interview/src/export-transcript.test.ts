import type { InterviewGuide, MvpTranscriptGap, SupportedLocale } from '@orgscience/contracts';
import { describe, expect, it } from 'vitest';

import { createTranscriptExport } from './export-transcript.js';
import type { DisplayTranscriptTurn } from './model.js';

const canonicalText = 'Original text: ä, ö, ü — unchanged.';
const guide: InterviewGuide = {
  id: 'guide-1',
  sourceLanguage: 'en',
  title: 'Research interview',
  sourceMarkdown: '# Research interview',
  createdAt: '2026-08-31T09:00:00.000Z',
  sections: [],
};
const turns: readonly DisplayTranscriptTurn[] = [
  {
    id: 'turn-1',
    sequenceNumber: 1,
    speaker: 'participant',
    turnType: 'participant_answer',
    text: canonicalText,
    occurredAt: '2026-08-31T09:01:00.000Z',
    guideReference: null,
    interrupted: false,
  },
  {
    id: 'turn-3',
    sequenceNumber: 3,
    speaker: 'ai_interviewer',
    turnType: 'closing',
    text: 'Thank you for the interview.',
    occurredAt: '2026-08-31T09:03:00.000Z',
    guideReference: null,
    interrupted: false,
  },
];
const technicalGaps: readonly MvpTranscriptGap[] = [
  {
    gapId: 'gap-1',
    interviewId: 'interview-1',
    sequenceNumber: 2,
    source: 'transport',
    description: 'Audio packet missing.',
    occurredAt: '2026-08-31T09:02:00.000Z',
  },
];

function exportAs(format: 'json' | 'markdown' | 'text', language: SupportedLocale): string {
  return createTranscriptExport({
    format,
    language,
    guide,
    interviewId: 'interview-1',
    startedAt: '2026-08-31T09:00:00.000Z',
    endedAt: '2026-08-31T09:05:00.000Z',
    turns,
    technicalGaps,
  });
}

describe('createTranscriptExport', () => {
  it('adds versioned language metadata to the JSON artifact', () => {
    expect(JSON.parse(exportAs('json', 'en'))).toMatchObject({
      schemaVersion: 2,
      interviewId: 'interview-1',
      language: 'en',
      guide: { id: 'guide-1', sourceLanguage: 'en' },
      turns: [{ text: canonicalText }, { text: 'Thank you for the interview.' }],
      technicalGaps: [{ description: 'Audio packet missing.' }],
    });
  });

  it('localizes only labels and preserves canonical turn and gap text byte-for-byte', () => {
    const german = exportAs('markdown', 'de');
    const english = exportAs('markdown', 'en');

    expect(german).toContain('Sprache: Deutsch');
    expect(german).toContain('Interviewpartner');
    expect(english).toContain('Language: English');
    expect(english).toContain('Participant');
    expect(german).toContain(canonicalText);
    expect(english).toContain(canonicalText);
    expect(german).toContain('Audio packet missing.');
    expect(english).toContain('Audio packet missing.');
  });

  it('places a technical gap between surrounding turns by canonical sequence', () => {
    for (const format of ['markdown', 'text'] as const) {
      const exported = exportAs(format, 'en');
      expect(exported.indexOf(canonicalText)).toBeLessThan(
        exported.indexOf('Audio packet missing.'),
      );
      expect(exported.indexOf('Audio packet missing.')).toBeLessThan(
        exported.indexOf('Thank you for the interview.'),
      );
    }
  });

  it('is deterministic for repeated requests', () => {
    expect(exportAs('text', 'en')).toBe(exportAs('text', 'en'));
  });
});
