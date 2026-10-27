import { afterEach, describe, expect, it, vi } from 'vitest';

import { evaluationExportUrl, getEvaluation, getEvaluationExport } from './api.js';

describe('monitoring evaluation API', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads a selected profile with a read-only GET request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        evaluation: {
          status: 'not_started',
          interviewId: 'interview:custom',
          profileId: 'profile:custom',
          profileFingerprint: 'a'.repeat(64),
          report: null,
          failure: null,
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const snapshot = await getEvaluation('interview:custom', 'profile:custom');

    expect(snapshot.profileId).toBe('profile:custom');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/interviews/interview%3Acustom/evaluation?profileId=profile%3Acustom',
      { headers: { Accept: 'application/json' } },
    );
  });

  it('scopes every export format to the report profile', async () => {
    expect(evaluationExportUrl('interview-1', 'html', 'profile-2')).toBe(
      '/api/v1/interviews/interview-1/evaluation/export?format=html&profileId=profile-2',
    );

    const fetchMock = vi.fn().mockResolvedValue(
      new Response('item_id,score\nexample,5', {
        status: 200,
        headers: {
          'Content-Disposition': 'attachment; filename="custom-report.csv"',
          'Content-Type': 'text/csv',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const file = await getEvaluationExport('interview-1', 'csv', 'profile-2');

    expect(file.fileName).toBe('custom-report.csv');
    expect(await file.blob.text()).toContain('example,5');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/interviews/interview-1/evaluation/export?format=csv&profileId=profile-2',
      { headers: { Accept: 'text/csv' } },
    );
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
