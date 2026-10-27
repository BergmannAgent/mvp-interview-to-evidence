import type { EvaluableInterview } from '@orgscience/api-client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  filterInterviews,
  interviewDeletionBlocked,
  InterviewDirectory,
} from './InterviewDirectory.js';

describe('InterviewDirectory', () => {
  it('keeps interview selection enabled while disabling management actions during evaluation loading', () => {
    const html = renderToStaticMarkup(
      <InterviewDirectory
        interviews={[interview('selected-id', 'Guide title')]}
        selectedInterviewId="selected-id"
        loading={false}
        disabled={false}
        managementDisabled
        error={null}
        onSelect={() => undefined}
        onReload={() => undefined}
        onRename={() => undefined}
        onDelete={() => undefined}
      />,
    );
    const buttons = html.match(/<button\b[^>]*>/gu) ?? [];
    const selection = buttons.find((button) => button.includes('class="interview-directory-row"'));
    const rename = buttons.find((button) =>
      button.includes('aria-label="Interview umbenennen: Guide title"'),
    );
    const deletion = buttons.find((button) =>
      button.includes('aria-label="Interview löschen: Guide title"'),
    );
    expect(selection).toBeDefined();
    expect(selection).not.toContain('disabled=""');
    expect(rename).toContain('disabled=""');
    expect(deletion).toContain('disabled=""');
  });

  it.each(['de', 'en'] as const)(
    'searches a custom display name and renders separate management buttons in %s',
    (locale) => {
      const original = interview('custom-id', 'Originaler Leitfaden');
      const named = {
        ...original,
        summary: { ...original.summary, displayName: 'Interview Anna' },
      };
      expect(filterInterviews([named], 'anna')).toEqual([named]);
      expect(filterInterviews([named], 'originaler')).toEqual([named]);
      expect(filterInterviews([named], 'custom-id')).toEqual([named]);

      const html = renderToStaticMarkup(
        <InterviewDirectory
          interviews={[named]}
          selectedInterviewId="custom-id"
          interfaceLanguage={locale}
          loading={false}
          disabled={false}
          error={null}
          onSelect={() => undefined}
          onReload={() => undefined}
          onRename={() => undefined}
          onDelete={() => undefined}
        />,
      );
      expect(html).toContain('<strong>Interview Anna</strong>');
      expect(html).toContain(
        `aria-label="${locale === 'en' ? 'Rename interview' : 'Interview umbenennen'}: Interview Anna"`,
      );
      expect(html).toContain(
        `aria-label="${locale === 'en' ? 'Delete interview' : 'Interview löschen'}: Interview Anna"`,
      );
      const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/gu) ?? [];
      expect(buttons.every((button) => (button.match(/<button\b/gu) ?? []).length === 1)).toBe(
        true,
      );
      expect(named.session.guideTitle).toBe('Originaler Leitfaden');
    },
  );

  it('blocks deletion for active/ending interviews, active workflows and running evaluations', () => {
    const original = interview('selected-id', 'Guide title');
    expect(interviewDeletionBlocked(original)).toBe(false);
    for (const status of ['active', 'ending'] as const) {
      expect(
        interviewDeletionBlocked({ ...original, summary: { ...original.summary, status } }),
      ).toBe(true);
    }
    expect(
      interviewDeletionBlocked({
        ...original,
        summary: { ...original.summary, activeWorkflowRunId: 'workflow' },
      }),
    ).toBe(true);
    expect(interviewDeletionBlocked(original, 'selected-id')).toBe(true);
    expect(interviewDeletionBlocked(original, 'different-id')).toBe(false);
    const html = renderToStaticMarkup(
      <InterviewDirectory
        interviews={[original]}
        selectedInterviewId="selected-id"
        loading={false}
        disabled={false}
        runningEvaluationInterviewId="selected-id"
        error={null}
        onSelect={() => undefined}
        onReload={() => undefined}
        onRename={() => undefined}
        onDelete={() => undefined}
      />,
    );
    const deletion = (html.match(/<button\b[^>]*>/gu) ?? []).find((button) =>
      button.includes('aria-label="Interview löschen: Guide title"'),
    );
    expect(deletion).toContain('disabled=""');
    expect(html).toContain('Vor dem Löschen das Interview pausieren oder beenden');
  });

  it('searches guide titles and interview ids, orders by completion without changing input', () => {
    const older = interview('old-id', 'Production', '2026-09-28T10:00:00.000Z');
    const newer = interview('new-id', 'Research', '2026-09-30T10:00:00.000Z');
    const interviews = [older, newer];
    expect(filterInterviews(interviews, '')).toEqual([newer, older]);
    expect(filterInterviews(interviews, ' RESEARCH ')).toEqual([newer]);
    expect(filterInterviews(interviews, 'OLD-ID')).toEqual([older]);
    expect(filterInterviews(interviews, 'missing')).toEqual([]);
    expect(interviews).toEqual([older, newer]);
  });

  it('marks the selected interview and presents a collapsed accessible mobile selection', () => {
    const html = renderToStaticMarkup(
      <InterviewDirectory
        interviews={[interview('selected-id', 'Guide title')]}
        selectedInterviewId="selected-id"
        loading={false}
        disabled={false}
        error={null}
        onSelect={() => undefined}
        onReload={() => undefined}
        onRename={() => undefined}
        onDelete={() => undefined}
      />,
    );
    expect(html).toContain('Guide title');
    expect(html).toContain('aria-current="true"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="studio-interview-directory-body"');
    expect(html).not.toContain('Bewertungsprofil');
  });

  it('keeps empty, loading, and failure states explicit', () => {
    const props = {
      interviews: [],
      selectedInterviewId: null,
      disabled: false,
      error: null,
      onSelect: () => undefined,
      onReload: () => undefined,
      onRename: () => undefined,
      onDelete: () => undefined,
    };
    expect(renderToStaticMarkup(<InterviewDirectory {...props} loading />)).toContain(
      'Interviews werden geladen.',
    );
    expect(renderToStaticMarkup(<InterviewDirectory {...props} loading={false} />)).toContain(
      'Noch keine Interviews mit gespeicherten Antworten.',
    );
    expect(
      renderToStaticMarkup(
        <InterviewDirectory {...props} loading={false} error="Service unavailable" />,
      ),
    ).toContain('role="alert"');
  });

  it('renders English navigation and the actual failed status for a non-finalised source', () => {
    const completed = interview('failed-id', 'Deutscher Leitfaden');
    const failed: EvaluableInterview = {
      ...completed,
      summary: { ...completed.summary, status: 'failed' },
      session: { ...completed.session, finalizedAt: null },
    };
    const html = renderToStaticMarkup(
      <InterviewDirectory
        interviews={[failed]}
        selectedInterviewId="failed-id"
        interfaceLanguage="en"
        loading={false}
        disabled={false}
        error={null}
        onSelect={() => undefined}
        onReload={() => undefined}
        onRename={() => undefined}
        onDelete={() => undefined}
      />,
    );
    expect(html).toContain('Interviews with answers');
    expect(html).toContain('Stopped with an error');
    expect(html).toContain('Deutscher Leitfaden');
    expect(html).toContain('DE');
    expect(html).not.toContain('Interviews durchsuchen');
  });
});

function interview(
  interviewId: string,
  guideTitle: string,
  endedAt = '2026-09-30T10:00:00.000Z',
): EvaluableInterview {
  return {
    summary: {
      interviewId,
      guideId: 'guide-id',
      guideTitle,
      language: 'de',
      status: 'completed',
      currentMainQuestionId: null,
      activeWorkflowRunId: null,
      createdAt: endedAt,
      updatedAt: endedAt,
      startedAt: endedAt,
    },
    session: {
      interviewId,
      guideId: 'guide-id',
      guideTitle,
      language: 'de',
      status: 'completed',
      stateVersion: 1,
      currentQuestionIndex: 1,
      totalQuestions: 1,
      currentQuestion: null,
      startedAt: endedAt,
      endedAt,
      updatedAt: endedAt,
      partialTranscript: null,
      transcript: [],
      technicalGaps: [],
      finalizedAt: endedAt,
    },
  };
}
