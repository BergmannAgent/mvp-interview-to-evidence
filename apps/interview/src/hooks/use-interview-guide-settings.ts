import type { GuideSummary, InterviewGuide, SupportedLocale } from '@orgscience/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';

import { interviewApi } from '../api/interview-api.js';

export function useInterviewGuideSettings(language: SupportedLocale, enabled: boolean) {
  const [guide, setGuide] = useState<InterviewGuide | null>(null);
  const [guides, setGuides] = useState<readonly GuideSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const generation = useRef(0);

  const reload = useCallback(async (): Promise<void> => {
    const requestGeneration = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const [settings, available] = await Promise.all([
        interviewApi.settings.getSettings(),
        interviewApi.settings.listGuides(language),
      ]);
      const selected = settings.settings.find((setting) => setting.language === language);
      const loaded =
        selected === undefined ? null : await interviewApi.settings.getGuide(selected.guideId);
      if (requestGeneration !== generation.current) return;
      setGuides(available.guides);
      setGuide(loaded?.interviewGuide ?? null);
    } catch (cause: unknown) {
      if (requestGeneration === generation.current) {
        setGuide(null);
        setError(cause);
      }
    } finally {
      if (requestGeneration === generation.current) setLoading(false);
    }
  }, [language]);

  useEffect(() => {
    if (!enabled) return undefined;
    setGuide(null);
    void reload();
    return () => {
      generation.current += 1;
    };
  }, [enabled, reload]);

  return {
    guide: guide?.sourceLanguage === language ? guide : null,
    guides: guides.filter((entry) => entry.sourceLanguage === language),
    loading,
    error,
    reload,
  };
}
