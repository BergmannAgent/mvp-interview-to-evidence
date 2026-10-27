import {
  MVP_REALTIME_CLIENT_PROTOCOL_HEADER,
  MVP_REALTIME_CLIENT_PROTOCOL_VERSION,
} from '@orgscience/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InterviewApi } from './interview-api.js';

describe('Interview API Realtime protocol', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('identifies the frontend protocol on provider session requests', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          clientSecret: 'ephemeral-secret',
          expiresAt: 1_800_000_000,
          sessionId: 'realtime-session-1',
          model: 'gpt-realtime-2.1',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await new InterviewApi('http://backend.test').createVoiceSession('interview-1');

    const request = fetchMock.mock.calls[0];
    expect(request).toBeDefined();
    expect(new Headers(request?.[1]?.headers).get(MVP_REALTIME_CLIENT_PROTOCOL_HEADER)).toBe(
      MVP_REALTIME_CLIENT_PROTOCOL_VERSION,
    );
    expect(request?.[1]?.body).toBeUndefined();
  });

  it('sends the selected source and interview language', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      )
      .mockResolvedValueOnce(
        new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );
    const api = new InterviewApi('http://backend.test');
    await expect(
      api.importGuide(new File(['# Guide'], 'guide.md', { type: 'text/markdown' }), 'en'),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(api.createInterview('guide-1', 'en')).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });

    const guideBody = fetchMock.mock.calls[0]?.[1]?.body;
    expect(guideBody).toBeInstanceOf(FormData);
    expect((guideBody as FormData).get('sourceLanguage')).toBe('en');
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      language: 'en',
    });
  });
});
