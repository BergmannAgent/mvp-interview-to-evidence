import { ApiError, type EvaluableInterview } from '@orgscience/api-client';
import { INTERVIEW_DISPLAY_NAME_MAX_LENGTH, type SupportedLocale } from '@orgscience/contracts';
import { LocaleProvider } from '@orgscience/frontend-i18n';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import {
  DeleteInterviewDialog,
  RenameInterviewDialog,
  interviewManagementError,
} from './InterviewManagementDialogs.js';

describe('InterviewManagementDialogs', () => {
  it.each(['de', 'en'] as const)(
    'localizes rename controls in %s while preserving the original interview name',
    (locale) => {
      const original = interview();
      const input = JSON.stringify(original);
      const onConfirm = vi.fn();
      const html = renderLocalized(
        <RenameInterviewDialog
          interview={original}
          busy={false}
          error={null}
          onConfirm={onConfirm}
          onClose={() => undefined}
        />,
        locale,
      );

      expect(html).toContain(locale === 'en' ? 'Rename interview' : 'Interview umbenennen');
      expect(html).toContain(locale === 'en' ? 'Interview name' : 'Interviewname');
      expect(html).toContain('value="Interview Anna"');
      expect(html).toContain('manual-interview');
      expect(html).toContain(`maxLength="${String(INTERVIEW_DISPLAY_NAME_MAX_LENGTH)}"`);
      expect(html).toContain(
        locale === 'en' ? 'Use the guide title as the name' : 'Leitfadentitel als Namen verwenden',
      );
      expect(html).toContain(
        locale === 'en' ? 'aria-label="Close dialog"' : 'aria-label="Dialog schließen"',
      );
      expect(JSON.stringify(original)).toBe(input);
      expect(onConfirm).not.toHaveBeenCalled();
    },
  );

  it('allows resetting only a persisted custom name and blocks saving an overlong fallback title', () => {
    const named = renderRename(interview());
    expect(buttonWithLabel(named, 'Leitfadentitel als Namen verwenden')).not.toContain('disabled');

    const fallback = interview(null);
    const html = renderRename(fallback);
    expect(html).toContain('value="Originaler Leitfaden"');
    expect(buttonWithLabel(html, 'Leitfadentitel als Namen verwenden')).toContain('disabled');

    const longGuide = {
      ...fallback,
      session: {
        ...fallback.session,
        guideTitle: 'x'.repeat(INTERVIEW_DISPLAY_NAME_MAX_LENGTH + 1),
      },
    };
    const save = (renderRename(longGuide).match(/<button\b[^>]*>[\s\S]*?<\/button>/gu) ?? []).find(
      (button) => button.includes('Speichern'),
    );
    expect(save).toContain('disabled=""');
  });

  it.each(['de', 'en'] as const)(
    'presents explicit permanent deletion and safe cancel in %s without invoking any mutation',
    (locale) => {
      const onConfirm = vi.fn();
      const onClose = vi.fn();
      const html = renderLocalized(
        <DeleteInterviewDialog
          interview={interview()}
          busy={false}
          error={null}
          onConfirm={onConfirm}
          onClose={onClose}
        />,
        locale,
      );
      expect(html).toContain(locale === 'en' ? 'Delete permanently' : 'Endgültig löschen');
      expect(html).toContain(
        locale === 'en'
          ? 'This action cannot be undone.'
          : 'Diese Aktion kann nicht rückgängig gemacht werden.',
      );
      expect(html).toContain(
        locale === 'en'
          ? 'The guide and evaluation profiles are kept.'
          : 'Der Leitfaden und die Bewertungsprofile bleiben erhalten.',
      );
      expect(html).toMatch(
        new RegExp(
          `<button[^>]*data-modal-initial-focus="true"[^>]*>${locale === 'en' ? 'Cancel' : 'Abbrechen'}</button>`,
          'u',
        ),
      );
      expect(html).toContain('Interview Anna');
      expect(html).toContain('manual-interview');
      expect(onConfirm).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    },
  );

  it('disables all confirmation and cancel controls during a write and renders sanitized errors', () => {
    for (const Dialog of [DeleteInterviewDialog, RenameInterviewDialog]) {
      const html = renderLocalized(
        <Dialog
          interview={interview()}
          busy
          error="Kontrollierter Fehler"
          onConfirm={() => undefined}
          onClose={() => undefined}
        />,
        'de',
      );
      const buttons = html.match(/<button\b[^>]*>/gu) ?? [];
      expect(buttons.length).toBeGreaterThan(2);
      expect(buttons.every((button) => button.includes('disabled=""'))).toBe(true);
      expect(html).toContain('aria-busy="true"');
      expect(html).toContain('role="alert">Kontrollierter Fehler');
    }
  });

  it.each(['de', 'en'] as const)(
    'maps busy/not-found failures to safe %s messages and hides provider/internal details',
    (locale) => {
      const busy = new ApiError({
        kind: 'http',
        status: 409,
        message: 'internal database stack',
        code: 'INTERVIEW_STATE_CONFLICT',
      });
      const missing = new ApiError({
        kind: 'http',
        status: 404,
        message: 'internal identifier details',
        code: 'NOT_FOUND',
      });
      expect(interviewManagementError(busy, 'delete', locale)).toContain(
        locale === 'en' ? 'Pause or end' : 'Pausiere oder beende',
      );
      expect(interviewManagementError(missing, 'rename', locale)).toContain(
        locale === 'en' ? 'no longer available' : 'nicht mehr verfügbar',
      );
      expect(interviewManagementError(new Error('provider secret stack'), 'rename', locale)).toBe(
        locale === 'en'
          ? 'The interview could not be renamed.'
          : 'Das Interview konnte nicht umbenannt werden.',
      );
      expect(interviewManagementError(busy, 'delete', locale)).not.toContain('internal');
    },
  );
});

function renderRename(value: EvaluableInterview): string {
  return renderLocalized(
    <RenameInterviewDialog
      interview={value}
      busy={false}
      error={null}
      onConfirm={() => undefined}
      onClose={() => undefined}
    />,
    'de',
  );
}

function buttonWithLabel(html: string, label: string): string {
  return (
    (html.match(/<button\b[^>]*>/gu) ?? []).find((button) =>
      button.includes(`aria-label="${label}"`),
    ) ?? ''
  );
}

function renderLocalized(node: ReactNode, locale: SupportedLocale): string {
  return renderToStaticMarkup(<LocaleProvider lockedLocale={locale}>{node}</LocaleProvider>);
}

function interview(displayName: string | null = 'Interview Anna'): EvaluableInterview {
  const now = '2026-10-01T10:00:00.000Z';
  return {
    summary: {
      interviewId: 'manual-interview',
      guideId: 'guide',
      guideTitle: 'Originaler Leitfaden',
      displayName,
      language: 'de',
      status: 'completed',
      currentMainQuestionId: null,
      activeWorkflowRunId: null,
      createdAt: now,
      startedAt: now,
      updatedAt: now,
    },
    session: {
      interviewId: 'manual-interview',
      guideId: 'guide',
      guideTitle: 'Originaler Leitfaden',
      language: 'de',
      status: 'completed',
      stateVersion: 1,
      currentQuestionIndex: 1,
      totalQuestions: 1,
      currentQuestion: null,
      startedAt: now,
      endedAt: now,
      finalizedAt: now,
      updatedAt: now,
      partialTranscript: null,
      transcript: [],
      technicalGaps: [],
    },
  };
}
