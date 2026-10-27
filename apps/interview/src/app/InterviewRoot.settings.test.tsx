import type { InterviewGuide } from '@orgscience/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RestoredInterviewSession } from '../model.js';
import { InterviewRoot } from './InterviewRoot.js';

const state = vi.hoisted(() => ({
  restored: null as RestoredInterviewSession | null,
  guide: null as InterviewGuide | null,
  loading: false,
  preference: 'de' as string | null,
  createInterview: vi.fn(),
}));

vi.mock('../session-storage.js', () => ({
  restoreInterviewSession: () => state.restored,
  persistInterviewSession: vi.fn(),
  clearInterviewSession: vi.fn(),
}));

vi.mock('../api/interview-api.js', () => ({
  interviewApi: { createInterview: state.createInterview },
  InterviewApiError: class extends Error {},
}));

vi.mock('../hooks/use-interview-guide-settings.js', () => ({
  useInterviewGuideSettings: () => ({
    guide: state.guide,
    guides: [],
    loading: state.loading,
    error: null,
    reload: vi.fn(),
  }),
}));

function englishGuide(): InterviewGuide {
  return {
    id: 'english-guide',
    title: 'Interview guide: Test',
    sourceLanguage: 'en',
    createdAt: '2026-10-01T09:00:00.000Z',
    sourceMarkdown:
      '# Interview guide: Test\n\n## Background\n\n### Main question\nWhat is your role?\n',
    sections: [
      {
        id: 'section-background',
        title: 'Background',
        position: 0,
        mainQuestions: [
          { id: 'question-role', text: 'What is your role?', position: 0, followUpQuestions: [] },
        ],
      },
    ],
  };
}

describe('interview preparation and language locking', () => {
  beforeEach(() => {
    state.restored = null;
    state.guide = englishGuide();
    state.loading = false;
    state.preference = 'de';
    state.createInterview.mockClear();
    vi.stubGlobal('window', {
      localStorage: { getItem: () => state.preference },
      location: { href: 'http://localhost:5273/' },
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('starts the preparation screen in English without a stored UI preference', () => {
    state.preference = null;
    const html = renderToStaticMarkup(<InterviewRoot />);
    expect(html).toContain('Interview guide: Test');
    expect(html).toContain('aria-label="Interview language"');
    expect(html).toContain('value="en" selected');
  });

  it('does not create an interview merely by rendering a configured guide', () => {
    const html = renderToStaticMarkup(<InterviewRoot />);
    expect(state.createInterview).not.toHaveBeenCalled();
    expect(html).toContain('Interview guide: Test');
    expect(html).toContain('interview-settings-dialog');
    expect(html).toContain('type="file"');
    expect(html).toContain('hidden=""');
    expect(html).toContain('button--join');
  });

  it('keeps start disabled while the configured guide is loading', () => {
    state.guide = null;
    state.loading = true;
    const html = renderToStaticMarkup(<InterviewRoot />);
    expect(html).toMatch(
      /<button[^>]*class="button button--primary button--join"[^>]*disabled=""/u,
    );
    expect(state.createInterview).not.toHaveBeenCalled();
  });

  it('restores an English active interview in English despite a German UI preference', () => {
    state.restored = {
      guide: englishGuide(),
      interviewId: 'restored-english-interview',
      phase: 'listening',
      inputMode: 'text',
      promptIndex: 0,
      turns: [],
      startedAt: '2026-10-01T09:00:00.000Z',
      endedAt: null,
    };
    const html = renderToStaticMarkup(<InterviewRoot />);
    expect(html).toContain('meeting-page');
    expect(html).toContain('AI interviewer');
    expect(html).not.toContain('language-switcher');
    expect(state.createInterview).not.toHaveBeenCalled();
  });

  it('allows the UI language selector again after an interview has ended', () => {
    state.restored = {
      guide: englishGuide(),
      interviewId: 'completed-english-interview',
      phase: 'completed',
      inputMode: 'text',
      promptIndex: 1,
      turns: [],
      startedAt: '2026-10-01T09:00:00.000Z',
      endedAt: '2026-10-01T09:05:00.000Z',
    };
    const html = renderToStaticMarkup(<InterviewRoot />);
    expect(html).toContain('completion-page');
    expect(html).toContain('language-switcher');
    expect(html).toContain('Neues Interview');
    expect(state.createInterview).not.toHaveBeenCalled();
  });
});
