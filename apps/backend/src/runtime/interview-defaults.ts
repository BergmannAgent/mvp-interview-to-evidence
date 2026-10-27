import { readFile } from 'node:fs/promises';

import type { SupportedLocale } from '@orgscience/contracts';
import { parseInterviewGuideMarkdown } from '@orgscience/domain';
import type { ImportGuideService } from '../application/guides/import-guide.js';
import type { AppUnitOfWork } from '../application/persistence/index.js';

const DEFAULT_GUIDES: readonly { language: SupportedLocale; fileName: string }[] = [
  { language: 'de', fileName: 'interviewleitfaden-organizational-resilience-9-items.md' },
  { language: 'en', fileName: 'interviewleitfaden-organizational-resilience-9-items.en.md' },
];

export function createInterviewDefaultsInitializer(
  unitOfWork: AppUnitOfWork,
  importer: ImportGuideService,
): () => Promise<void> {
  let ready = false;
  let pending: Promise<void> | undefined;
  return () => {
    if (ready) return Promise.resolve();
    pending ??= initialize()
      .then(() => {
        ready = true;
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };

  async function initialize(): Promise<void> {
    const settings = await unitOfWork.read(({ interviewSettings }) =>
      interviewSettings.getSettings(),
    );
    if (!settings.ok) throw new Error('Could not load interview settings.');
    for (const guide of DEFAULT_GUIDES) {
      if (settings.value.some((setting) => setting.language === guide.language)) continue;
      const markdown = await readFile(
        new URL(`../../../../guides/${guide.fileName}`, import.meta.url),
        'utf8',
      );
      const parsed = parseInterviewGuideMarkdown(markdown, guide.language);
      if (!parsed.success) throw new Error('The configured interview guide is invalid.');
      const existing = await unitOfWork.read(({ guides }) => guides.getById(parsed.guide.id));
      if (!existing.ok && existing.error.code !== 'not_found')
        throw new Error('Could not read the configured interview guide.');
      const imported = existing.ok
        ? existing
        : await importer.execute({ markdown, sourceLanguage: guide.language });
      if (!imported.ok) throw new Error('Could not initialize the configured interview guide.');
      const selected = 'guide' in imported.value ? imported.value.guide : imported.value;
      if (selected.sourceLanguage !== guide.language)
        throw new Error('The configured guide language is invalid.');
      const result = await unitOfWork.transaction(({ interviewSettings }) =>
        interviewSettings.saveSetting(
          { language: guide.language, guideId: selected.id, updatedAt: selected.createdAt },
          true,
        ),
      );
      if (!result.ok) throw new Error('Could not initialize interview settings.');
    }
  }
}
