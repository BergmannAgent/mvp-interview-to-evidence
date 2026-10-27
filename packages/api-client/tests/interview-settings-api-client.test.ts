import { describe, expect, it } from 'vitest';

import {
  InterviewSettingsApiClient,
  type ValidatedApiRequest,
} from '../src/interview-settings-api-client.js';

const now = '2026-10-01T09:00:00.000Z';

function harness(response: unknown) {
  const calls: { path: string; init?: RequestInit }[] = [];
  const request: ValidatedApiRequest = async (path, schema, init) => {
    calls.push({ path, ...(init === undefined ? {} : { init }) });
    const parsed = schema.safeParse(response);
    if (!parsed.success) throw new Error('Invalid API response');
    return parsed.data;
  };
  return { calls, client: new InterviewSettingsApiClient(request) };
}

describe('InterviewSettingsApiClient', () => {
  it('loads persisted settings without selecting a newest guide locally', async () => {
    const response = { settings: [{ language: 'de', guideId: 'guide-explicit', updatedAt: now }] };
    const { calls, client } = harness(response);
    await expect(client.getSettings()).resolves.toEqual(response);
    expect(calls).toEqual([{ path: '/api/v1/interview-settings' }]);
  });

  it.each(['de', 'en'] as const)(
    'lists only the explicitly requested %s guide language',
    async (language) => {
      const { calls, client } = harness({ guides: [] });
      await expect(client.listGuides(language)).resolves.toEqual({ guides: [] });
      expect(calls).toEqual([{ path: `/api/v1/guides?sourceLanguage=${language}` }]);
    },
  );

  it('persists a selected guide in the settings route rather than creating an interview', async () => {
    const response = {
      settings: [{ language: 'en', guideId: 'guide:v1:english', updatedAt: now }],
    };
    const { calls, client } = harness(response);
    await expect(client.updateSetting('en', 'guide:v1:english')).resolves.toEqual(response);
    expect(calls).toEqual([
      {
        path: '/api/v1/interview-settings/en',
        init: {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ guideId: 'guide:v1:english' }),
        },
      },
    ]);
  });

  it('URL-encodes a persisted opaque guide ID', async () => {
    const { calls, client } = harness({});
    await expect(client.getGuide('guide:v1:english')).rejects.toThrow('Invalid API response');
    expect(calls).toEqual([{ path: '/api/v1/guides/guide%3Av1%3Aenglish' }]);
  });

  it('rejects malformed settings and mismatched guide response shapes', async () => {
    await expect(
      harness({
        settings: [{ language: 'fr', guideId: 'guide-1', updatedAt: now }],
      }).client.getSettings(),
    ).rejects.toThrow('Invalid API response');
    await expect(
      harness({
        guides: [{ id: 'guide-1', title: 'Guide', sourceLanguage: 'en' }],
      }).client.listGuides('en'),
    ).rejects.toThrow('Invalid API response');
  });
});
