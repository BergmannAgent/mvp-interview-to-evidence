import { LocaleProvider } from '@orgscience/frontend-i18n';
import type { SupportedLocale } from '@orgscience/contracts';
import { useState } from 'react';

import { restoreInterviewSession } from '../session-storage.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { InterviewApp } from './InterviewApp.js';

export function InterviewRoot() {
  const [lockedLocale, setLockedLocale] = useState<SupportedLocale | null>(() => {
    const restored = restoreInterviewSession();
    return restored !== null && restored.endedAt === null
      ? (restored.guide.sourceLanguage ?? 'de')
      : null;
  });
  return (
    <LocaleProvider lockedLocale={lockedLocale}>
      <ErrorBoundary>
        <InterviewApp onLanguageLock={setLockedLocale} />
      </ErrorBoundary>
    </LocaleProvider>
  );
}
