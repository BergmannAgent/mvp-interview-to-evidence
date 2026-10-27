import { createHash } from 'node:crypto';

import type { InterviewGuideSetting, SupportedLocale } from '@orgscience/contracts';
import type { InterviewGuideSnapshot } from '@orgscience/domain';
import { describe, expect, it, vi } from 'vitest';

import { ImportGuideService } from '../application/guides/import-guide.js';
import { InterviewSettingsService } from '../application/guides/interview-settings.js';
import {
  failure,
  success,
  type AppReadContext,
  type AppTransaction,
  type AppUnitOfWork,
  type ImportedGuideRecord,
  type InterviewSettingsRepository,
} from '../application/persistence/index.js';
import { createInterviewDefaultsInitializer } from './interview-defaults.js';

const NOW = '2026-10-01T10:00:00.000Z';

describe('persistent interview guide defaults', () => {
  it('initializes the two explicitly named guides once across concurrent callers', async () => {
    const harness = settingsHarness();
    const initialize = createInterviewDefaultsInitializer(harness.unitOfWork, harness.importer);
    await Promise.all([initialize(), initialize(), initialize()]);
    expect(harness.imported).toHaveLength(2);
    expect(harness.imported.map((guide) => guide.guide.sourceLanguage)).toEqual(['de', 'en']);
    expect(
      harness.imported.every(
        (guide) =>
          guide.guide.sections.reduce(
            (count, section) => count + section.mainQuestions.length,
            0,
          ) === 12,
      ),
    ).toBe(true);
    expect([...harness.settings.keys()].toSorted()).toEqual(['de', 'en']);
    await initialize();
    expect(harness.imported).toHaveLength(2);
  });

  it('never replaces the persisted user choice on a reconstructed initializer', async () => {
    const harness = settingsHarness();
    await createInterviewDefaultsInitializer(harness.unitOfWork, harness.importer)();
    harness.settings.set('de', {
      language: 'de',
      guideId: 'guide-selected-by-user',
      updatedAt: NOW,
    });
    await createInterviewDefaultsInitializer(harness.unitOfWork, harness.importer)();
    expect(harness.settings.get('de')?.guideId).toBe('guide-selected-by-user');
    expect(harness.imported).toHaveLength(2);
  });

  it('reuses existing matching-language guide IDs even when original Markdown whitespace differs', async () => {
    const harness = settingsHarness();
    await createInterviewDefaultsInitializer(harness.unitOfWork, harness.importer)();
    harness.settings.clear();
    for (const [id, guide] of harness.guides) {
      harness.guides.set(id, { ...guide, sourceMarkdown: `${guide.sourceMarkdown}\n` });
    }
    await createInterviewDefaultsInitializer(harness.unitOfWork, harness.importer)();
    expect(harness.settings.size).toBe(2);
    expect(harness.imported).toHaveLength(2);
  });

  it('allows retry after an initialization failure', async () => {
    const harness = settingsHarness();
    harness.failNextImport();
    const initialize = createInterviewDefaultsInitializer(harness.unitOfWork, harness.importer);
    await expect(initialize()).rejects.toThrow('initialize');
    await initialize();
    expect(harness.settings.size).toBe(2);
  });

  it('rejects a guide from the wrong language without saving a new setting', async () => {
    const harness = settingsHarness();
    const initialize = createInterviewDefaultsInitializer(harness.unitOfWork, harness.importer);
    await initialize();
    const english = harness.imported.find((record) => record.guide.sourceLanguage === 'en');
    if (!english) throw new Error('Missing English fixture');
    const before = harness.settings.get('de');
    const service = new InterviewSettingsService(
      harness.unitOfWork,
      { now: () => NOW },
      initialize,
    );
    const result = await service.update('de', english.guideId);
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'application_validation', field: 'guideId' },
    });
    expect(harness.settings.get('de')).toEqual(before);
  });

  it('stores a same-language explicit choice and reads it back, independent of import age', async () => {
    const harness = settingsHarness();
    const initialize = createInterviewDefaultsInitializer(harness.unitOfWork, harness.importer);
    await initialize();
    const imported = await harness.importer.execute({
      sourceLanguage: 'de',
      markdown:
        '# Interviewleitfaden: Meine Auswahl\n\n## Einstieg\n\n### Hauptfrage\nWas ist Ihre Aufgabe?\n',
    });
    if (!imported.ok) throw new Error('Could not import selection');
    const service = new InterviewSettingsService(
      harness.unitOfWork,
      { now: () => NOW },
      initialize,
    );
    expect(await service.update('de', imported.value.guide.id)).toEqual({
      ok: true,
      value: { language: 'de', guideId: imported.value.guide.id, updatedAt: NOW },
    });
    const read = await service.get();
    expect(read).toMatchObject({
      ok: true,
      value: expect.arrayContaining([
        { language: 'de', guideId: imported.value.guide.id, updatedAt: NOW },
      ]),
    });
  });
});

function settingsHarness() {
  const settings = new Map<SupportedLocale, InterviewGuideSetting>();
  const imported: ImportedGuideRecord[] = [];
  const guides = new Map<string, InterviewGuideSnapshot>();
  let failImport = false;
  const repository: InterviewSettingsRepository = {
    async listGuides() {
      return success([]);
    },
    async getSettings() {
      return success([...settings.values()]);
    },
    async saveSetting(setting, onlyIfAbsent = false) {
      const existing = settings.get(setting.language);
      if (existing !== undefined && onlyIfAbsent) return success(existing);
      settings.set(setting.language, setting);
      return success(setting);
    },
  };
  const scopedContext = {
    interviewSettings: repository,
    guides: {
      async import(_id: string, record: ImportedGuideRecord) {
        if (failImport) {
          failImport = false;
          return failure({ code: 'internal', retryable: false });
        }
        imported.push(record);
        guides.set(record.guideId, record.guide);
        return success({ outcome: 'inserted' as const, value: record });
      },
      async getById(id: string) {
        const guide = guides.get(id);
        return guide === undefined
          ? failure({ code: 'not_found', resource: 'guide', id })
          : success(guide);
      },
    },
  };
  // Only the guide/settings ports are used by this focused application fixture.
  const unitOfWork: AppUnitOfWork = {
    async read(operation) {
      return operation(scopedContext as unknown as AppReadContext);
    },
    async transaction(operation) {
      return operation(scopedContext as unknown as AppTransaction);
    },
  };
  const importer = new ImportGuideService(
    unitOfWork,
    { now: () => NOW },
    {
      digestUtf8: (value) => createHash('sha256').update(value).digest('hex'),
    },
  );
  return {
    settings,
    guides,
    imported,
    unitOfWork,
    importer,
    failNextImport: vi.fn(() => {
      failImport = true;
    }),
  };
}
