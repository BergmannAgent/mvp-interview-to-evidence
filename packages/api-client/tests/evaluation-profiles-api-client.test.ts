import type {
  EvaluationProfile,
  EvaluationProfileContent,
  EvaluationProfileDocument,
} from '@orgscience/contracts';
import { EVALUATION_PROFILE_XLSX_MEDIA_TYPE } from '@orgscience/contracts';
import { describe, expect, it, vi } from 'vitest';

import { EvaluationProfilesApiClient, type EvaluationProfilesFetch } from '../src/index.js';

const now = '2026-08-21T12:00:00.000Z';

function content(name = 'General evidence profile'): EvaluationProfileContent {
  return {
    name,
    description: 'A guide-independent coding profile.',
    coderPrompt: 'Code each item from transcript evidence.',
    scale: { minimum: 1, maximum: 7 },
    dimensions: [{ dimensionId: 'dimension-1', name: 'Capability', order: 0 }],
    items: [
      {
        itemId: 'item-1',
        dimensionId: 'dimension-1',
        name: 'Adaptation',
        codingInstruction: 'Assess demonstrated adaptation.',
        order: 0,
        anchors: [1, 2, 3, 4, 5, 6, 7].map((score) => ({
          score,
          criterion: `Criterion ${String(score)}`,
        })) as EvaluationProfileContent['items'][number]['anchors'],
      },
    ],
  };
}

function profile(profileId = 'profile-1', name?: string): EvaluationProfile {
  return {
    profileId,
    ...content(name),
    isDefault: profileId === 'profile-1',
    createdAt: now,
    updatedAt: now,
  };
}

function document(profileId = 'portable-1'): EvaluationProfileDocument {
  return {
    schemaVersion: 1,
    profile: { profileId, ...content() },
  };
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
}

function mockFetch(...responses: Response[]): ReturnType<typeof vi.fn<EvaluationProfilesFetch>> {
  const fetch = vi.fn<EvaluationProfilesFetch>();
  for (const response of responses) fetch.mockResolvedValueOnce(response);
  return fetch;
}

describe('EvaluationProfilesApiClient', () => {
  it('normalizes the base URL and lists profile summaries', async () => {
    const fetch = mockFetch(
      jsonResponse({
        profiles: [
          {
            profileId: 'profile-1',
            name: 'Default',
            description: '',
            isDefault: true,
            createdAt: now,
            updatedAt: now,
          },
        ],
      }),
    );
    const client = new EvaluationProfilesApiClient({
      baseUrl: ' https://profiles.example.test/// ',
      fetch,
    });

    await expect(client.listProfiles()).resolves.toMatchObject({
      profiles: [{ profileId: 'profile-1' }],
    });
    expect(fetch).toHaveBeenCalledWith(
      'https://profiles.example.test/api/v1/evaluation-profiles',
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    const headers = fetch.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get('Accept')).toBe('application/json');
  });

  it('uses the CRUD and duplicate routes with validated JSON requests', async () => {
    const created = profile('profile-2', 'Created');
    const updated = profile('profile:2', 'Updated');
    const duplicated = profile('profile-3', 'Copy');
    const fetch = mockFetch(
      jsonResponse({ profile: created }, { status: 201 }),
      jsonResponse({ profile: updated }),
      jsonResponse({ profile: duplicated }, { status: 201 }),
      new Response(null, { status: 204 }),
    );
    const client = new EvaluationProfilesApiClient({ fetch });

    await client.createProfile({ profile: content('Created') });
    await client.updateProfile('profile:2', {
      profile: content('Updated'),
      expectedUpdatedAt: now,
    });
    await client.duplicateProfile('profile:2', { name: 'Copy' });
    await client.deleteProfile('profile:2', now);

    expect(fetch.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ['/api/v1/evaluation-profiles', 'POST'],
      ['/api/v1/evaluation-profiles/profile%3A2', 'PUT'],
      ['/api/v1/evaluation-profiles/profile%3A2/duplicate', 'POST'],
      [
        '/api/v1/evaluation-profiles/profile%3A2?expectedUpdatedAt=2026-08-21T12%3A00%3A00.000Z',
        'DELETE',
      ],
    ]);
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ profile: content('Created') }));
    expect((fetch.mock.calls[0]?.[1]?.headers as Headers).get('Content-Type')).toBe(
      'application/json',
    );
  });

  it('rejects valid profile payloads that do not match get or update scope', async () => {
    const getClient = new EvaluationProfilesApiClient({
      fetch: mockFetch(jsonResponse({ profile: profile('profile-other') })),
    });
    await expect(getClient.getProfile('profile-requested')).rejects.toMatchObject({
      kind: 'contract',
      code: 'INVALID_RESPONSE',
    });

    const updateClient = new EvaluationProfilesApiClient({
      fetch: mockFetch(jsonResponse({ profile: profile('profile-other', 'Updated') })),
    });
    await expect(
      updateClient.updateProfile('profile-requested', {
        profile: content('Updated'),
        expectedUpdatedAt: now,
      }),
    ).rejects.toMatchObject({ kind: 'contract', code: 'INVALID_RESPONSE' });
  });

  it('requires duplicates to have a new non-default identity and the requested name', async () => {
    for (const invalidDuplicate of [
      profile('profile-source', 'Copy'),
      profile('profile-1', 'Copy'),
      profile('profile-copy', 'Wrong name'),
    ]) {
      const client = new EvaluationProfilesApiClient({
        fetch: mockFetch(jsonResponse({ profile: invalidDuplicate }, { status: 201 })),
      });
      await expect(
        client.duplicateProfile('profile-source', { name: 'Copy' }),
      ).rejects.toMatchObject({ kind: 'contract', code: 'INVALID_RESPONSE' });
    }
  });

  it('rejects an unexpected default profile from the create operation', async () => {
    const unexpectedDefault = { ...profile('profile-created', 'Created'), isDefault: true };
    const client = new EvaluationProfilesApiClient({
      fetch: mockFetch(jsonResponse({ profile: unexpectedDefault }, { status: 201 })),
    });

    await expect(client.createProfile({ profile: content('Created') })).rejects.toMatchObject({
      kind: 'contract',
      code: 'INVALID_RESPONSE',
    });
  });

  it('sends a raw document for preview and a mode request for confirmation', async () => {
    const portable = document();
    const imported = profile('portable-1');
    const fetch = mockFetch(
      jsonResponse({ valid: true, profile: portable.profile }),
      jsonResponse({ profile: imported }, { status: 201 }),
    );
    const client = new EvaluationProfilesApiClient({ fetch });

    await client.previewJsonImport(portable);
    await client.confirmJsonImport({ mode: 'create', document: portable });

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/evaluation-profiles/imports/json/preview',
      '/api/v1/evaluation-profiles/imports/json/confirm',
    ]);
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(portable));
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(
      JSON.stringify({ mode: 'create', document: portable }),
    );
  });

  it('binds import previews and create or replace confirmations to submitted scope and content', async () => {
    const portable = document('portable-requested');
    const mismatchedPreview = new EvaluationProfilesApiClient({
      fetch: mockFetch(jsonResponse({ valid: true, profile: document('portable-other').profile })),
    });
    await expect(mismatchedPreview.previewJsonImport(portable)).rejects.toMatchObject({
      kind: 'contract',
      code: 'INVALID_RESPONSE',
    });

    const mismatchedCreate = new EvaluationProfilesApiClient({
      fetch: mockFetch(jsonResponse({ profile: profile('portable-other') }, { status: 201 })),
    });
    await expect(
      mismatchedCreate.confirmJsonImport({ mode: 'create', document: portable }),
    ).rejects.toMatchObject({ kind: 'contract', code: 'INVALID_RESPONSE' });

    const unexpectedDefaultCreate = new EvaluationProfilesApiClient({
      fetch: mockFetch(
        jsonResponse(
          {
            profile: {
              ...profile('portable-requested'),
              isDefault: true,
            },
          },
          { status: 201 },
        ),
      ),
    });
    await expect(
      unexpectedDefaultCreate.confirmJsonImport({ mode: 'create', document: portable }),
    ).rejects.toMatchObject({ kind: 'contract', code: 'INVALID_RESPONSE' });

    const mismatchedReplace = new EvaluationProfilesApiClient({
      fetch: mockFetch(jsonResponse({ profile: profile('profile-other') })),
    });
    await expect(
      mismatchedReplace.confirmJsonImport({
        mode: 'replace',
        targetProfileId: 'profile-target',
        expectedUpdatedAt: now,
        document: portable,
      }),
    ).rejects.toMatchObject({ kind: 'contract', code: 'INVALID_RESPONSE' });

    const mismatchedContent = new EvaluationProfilesApiClient({
      fetch: mockFetch(jsonResponse({ profile: profile('profile-target', 'Different content') })),
    });
    await expect(
      mismatchedContent.confirmJsonImport({
        mode: 'replace',
        targetProfileId: 'profile-target',
        expectedUpdatedAt: now,
        document: portable,
      }),
    ).rejects.toMatchObject({ kind: 'contract', code: 'INVALID_RESPONSE' });
  });

  it('lets the preview endpoint report field errors for an unknown imported document', async () => {
    const malformedDocument = {
      schemaVersion: 1,
      profile: { profileId: 'imported', dimensions: [] },
    };
    const fetch = mockFetch(
      jsonResponse(
        {
          error: {
            code: 'EVALUATION_PROFILE_IMPORT_INVALID',
            message: 'The imported profile is invalid.',
            requestId: 'request-preview',
            occurredAt: now,
            retryable: false,
            fieldErrors: [
              {
                path: ['profile', 'dimensions'],
                code: 'too_small',
                message: 'At least one dimension is required.',
              },
            ],
          },
        },
        { status: 400 },
      ),
    );

    await expect(
      new EvaluationProfilesApiClient({ fetch }).previewJsonImport(malformedDocument),
    ).rejects.toMatchObject({
      code: 'EVALUATION_PROFILE_IMPORT_INVALID',
      fieldErrors: [{ path: ['profile', 'dimensions'], code: 'too_small' }],
    });
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(malformedDocument));
  });

  it('returns canonical deterministic JSON download artifacts and safe names', async () => {
    const portable = document('profile-export');
    const fetch = mockFetch(
      jsonResponse(portable, {
        headers: {
          'Content-Disposition': `attachment; filename*=UTF-8''My%20Profile.json`,
        },
      }),
      jsonResponse(portable),
    );
    const client = new EvaluationProfilesApiClient({ fetch });

    const exported = await client.exportProfile('profile-export');
    const template = await client.getJsonTemplate();

    expect(exported).toEqual({
      fileName: 'My-Profile.json',
      mediaType: 'application/json',
      document: portable,
      text: `${JSON.stringify(portable, null, 2)}\n`,
    });
    expect(template.fileName).toBe('evaluation-profile-template.json');
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/evaluation-profiles/profile-export/export',
      '/api/v1/evaluation-profiles/templates/json',
    ]);
  });

  it('rejects a valid exported document from a different profile scope', async () => {
    const client = new EvaluationProfilesApiClient({
      fetch: mockFetch(jsonResponse(document('profile-other'))),
    });

    await expect(client.exportProfile('profile-requested')).rejects.toMatchObject({
      kind: 'contract',
      code: 'INVALID_RESPONSE',
    });
  });

  it('downloads the versioned XLSX template as a validated binary artifact', async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
    const fetch = mockFetch(
      new Response(bytes, {
        headers: {
          'Content-Type': EVALUATION_PROFILE_XLSX_MEDIA_TYPE,
          'Content-Disposition': 'attachment; filename="evaluation-profile-template-v1.xlsx"',
        },
      }),
    );

    await expect(new EvaluationProfilesApiClient({ fetch }).getXlsxTemplate()).resolves.toEqual({
      fileName: 'evaluation-profile-template-v1.xlsx',
      mediaType: EVALUATION_PROFILE_XLSX_MEDIA_TYPE,
      bytes,
    });
    expect(fetch).toHaveBeenCalledWith(
      '/api/v1/evaluation-profiles/templates/xlsx',
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    expect((fetch.mock.calls[0]?.[1]?.headers as Headers).get('Accept')).toBe(
      EVALUATION_PROFILE_XLSX_MEDIA_TYPE,
    );
  });

  it('previews XLSX with a browser boundary and explicitly confirms the canonical document', async () => {
    const portable = document('xlsx-import');
    const imported = profile('xlsx-import');
    const response = {
      valid: true as const,
      document: portable,
      source: {
        fileName: 'profile.xlsx',
        templateVersion: 1 as const,
        dimensions: 1,
        items: 1,
        anchors: 7,
      },
    };
    const fetch = mockFetch(
      jsonResponse(response),
      jsonResponse({ profile: imported }, { status: 201 }),
    );
    const file = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'profile.xlsx', {
      type: EVALUATION_PROFILE_XLSX_MEDIA_TYPE,
    });
    const client = new EvaluationProfilesApiClient({ fetch });

    const preview = await client.previewXlsxImport(file);
    expect(preview).toEqual(response);
    await expect(
      client.confirmJsonImport({ mode: 'create', document: preview.document }),
    ).resolves.toEqual({ profile: imported });

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/evaluation-profiles/imports/xlsx/preview',
      '/api/v1/evaluation-profiles/imports/json/confirm',
    ]);
    const previewInit = fetch.mock.calls[0]?.[1];
    expect(previewInit?.method).toBe('POST');
    expect(previewInit?.body).toBeInstanceOf(FormData);
    expect((previewInit?.headers as Headers).has('Content-Type')).toBe(false);
    expect(((previewInit?.body as FormData).get('file') as File).name).toBe('profile.xlsx');

    const confirmInit = fetch.mock.calls[1]?.[1];
    expect(confirmInit?.method).toBe('POST');
    expect((confirmInit?.headers as Headers).get('Content-Type')).toBe('application/json');
    expect(confirmInit?.body).toBe(JSON.stringify({ mode: 'create', document: preview.document }));
  });

  it('rejects invalid XLSX files before fetch and invalid template media types after fetch', async () => {
    const invalidFileFetch = vi.fn<EvaluationProfilesFetch>();
    const invalidFileClient = new EvaluationProfilesApiClient({ fetch: invalidFileFetch });

    await expect(
      invalidFileClient.previewXlsxImport(new File(['legacy'], 'profile.xlsm')),
    ).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      fieldErrors: [expect.objectContaining({ code: 'invalid_file_name' })],
    });
    expect(invalidFileFetch).not.toHaveBeenCalled();

    const wrongMediaFetch = mockFetch(
      new Response('not xlsx', { headers: { 'Content-Type': 'text/plain' } }),
    );
    await expect(
      new EvaluationProfilesApiClient({ fetch: wrongMediaFetch }).getXlsxTemplate(),
    ).rejects.toMatchObject({ kind: 'contract', code: 'INVALID_RESPONSE' });
  });

  it('loads the immutable guardrail contract', async () => {
    const guardrails = {
      evidenceSource: 'final_participant_turns_only',
      exactQuotesRequired: true,
      validTurnReferencesRequired: true,
      fabricatedContentForbidden: true,
      hiddenChainOfThoughtForbidden: true,
      structuredOutputLocked: true,
      scoreRangeLocked: 'integer_1_7_or_non_score',
      aggregationLocked: true,
    } as const;
    const fetch = mockFetch(jsonResponse({ guardrails }));

    await expect(new EvaluationProfilesApiClient({ fetch }).getLockedGuardrails()).resolves.toEqual(
      { guardrails },
    );
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/v1/evaluation-profiles/meta/guardrails');
  });

  it('preserves a valid machine-readable API error envelope', async () => {
    const fetch = mockFetch(
      jsonResponse(
        {
          error: {
            code: 'CONFLICT',
            message: 'The profile changed.',
            requestId: 'request-1',
            occurredAt: now,
            retryable: false,
            fieldErrors: [
              { path: ['expectedUpdatedAt'], code: 'stale', message: 'Reload the profile.' },
            ],
          },
        },
        { status: 409 },
      ),
    );

    const result = new EvaluationProfilesApiClient({ fetch }).getProfile('profile-1');
    await expect(result).rejects.toMatchObject({
      name: 'ApiError',
      kind: 'http',
      status: 409,
      code: 'CONFLICT',
      requestId: 'request-1',
      retryable: false,
      fieldErrors: [{ path: ['expectedUpdatedAt'], code: 'stale' }],
    });
  });

  it('uses safe errors for malformed HTTP responses and invalid success payloads', async () => {
    const fetch = mockFetch(
      new Response('<html>failed</html>', { status: 503 }),
      jsonResponse({ profile: { unexpected: true } }),
    );
    const client = new EvaluationProfilesApiClient({ fetch });

    await expect(client.getProfile('profile-1')).rejects.toMatchObject({
      kind: 'http',
      status: 503,
      code: 'HTTP_ERROR',
      retryable: true,
    });
    await expect(client.getProfile('profile-1')).rejects.toMatchObject({
      kind: 'contract',
      status: 200,
      code: 'INVALID_RESPONSE',
    });
  });

  it('rejects invalid requests before fetch and wraps network failures', async () => {
    const fetch = vi.fn<EvaluationProfilesFetch>().mockRejectedValue(new Error('offline'));
    const client = new EvaluationProfilesApiClient({ fetch });

    await expect(
      client.createProfile({ profile: { ...content(), dimensions: [] } }),
    ).rejects.toMatchObject({
      name: 'ApiError',
      code: 'INVALID_REQUEST',
      fieldErrors: expect.arrayContaining([
        expect.objectContaining({ path: ['profile', 'dimensions'], code: 'too_small' }),
        expect.objectContaining({ path: ['profile', 'items', 0, 'dimensionId'], code: 'custom' }),
      ]),
    });
    expect(fetch).not.toHaveBeenCalled();

    await expect(client.listProfiles()).rejects.toMatchObject({
      kind: 'network',
      status: null,
      code: 'NETWORK_ERROR',
      retryable: true,
    });
  });

  it('requires delete to use the explicit no-content contract', async () => {
    const fetch = mockFetch(jsonResponse({ deleted: true }));

    await expect(
      new EvaluationProfilesApiClient({ fetch }).deleteProfile('profile-1', now),
    ).rejects.toMatchObject({
      kind: 'contract',
      status: 200,
      code: 'INVALID_RESPONSE',
    });
  });
});
