import {
  apiErrorEnvelopeSchema,
  evaluationProfileContentSchema,
  evaluationProfileDocumentSchema,
  evaluationProfileListResponseSchema,
  evaluationProfileResponseSchema,
  type EvaluationProfile,
  type EvaluationProfileContent,
  type EvaluationProfileDocument,
  type EvaluationProfileSummary,
} from '@orgscience/contracts';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { EvaluationProfileServiceError } from '../../application/evaluation-profiles/index.js';
import { createBackendHttpApp, type BackendHttpDependencies } from './app.js';
import type { HttpEnvironment } from './error-response.js';
import {
  registerEvaluationProfileHttpRoutes,
  type EvaluationProfileHttpRouteDependencies,
} from './evaluation-profile-routes.js';

const NOW = '2026-08-21T14:00:00.000Z';
const NEXT = '2026-08-21T14:01:00.000Z';
const REQUEST_ID = 'request-evaluation-profile-http-1';
const ALLOWED_ORIGIN = 'http://localhost:5275';

type ProfileRoutes = EvaluationProfileHttpRouteDependencies['evaluationProfiles'];

describe('evaluation profile HTTP boundary', () => {
  it('routes list, get, create, update, duplicate, and delete with canonical contracts', async () => {
    const current = profile('profile-default', 'Default', true);
    const created = profile('profile-created', 'Created');
    const updated = profile('profile-created', 'Updated', false, NEXT);
    const duplicated = profile('profile-copy', 'Copy');
    const list = vi.fn(async () => [summary(current), summary(created)]);
    const get = vi.fn(async () => current);
    const create = vi.fn(async () => created);
    const update = vi.fn(async () => updated);
    const duplicate = vi.fn(async () => duplicated);
    const deleteProfile = vi.fn(async () => duplicated);
    const app = profileApp(
      profileRoutes({ list, get, create, update, duplicate, delete: deleteProfile }),
    );

    const listed = await app.request('/api/v1/evaluation-profiles');
    expect(listed.status).toBe(200);
    expect(evaluationProfileListResponseSchema.parse(await listed.json())).toEqual({
      profiles: [summary(current), summary(created)],
    });

    const loaded = await app.request('/api/v1/evaluation-profiles/profile-default');
    expect(loaded.status).toBe(200);
    expect(evaluationProfileResponseSchema.parse(await loaded.json())).toEqual({
      profile: current,
    });
    expect(get).toHaveBeenCalledExactlyOnceWith('profile-default');

    const createdResponse = await jsonRequest(app, '/api/v1/evaluation-profiles', 'POST', {
      profile: content('Created'),
    });
    expect(createdResponse.status).toBe(201);
    expect(evaluationProfileResponseSchema.parse(await createdResponse.json())).toEqual({
      profile: created,
    });
    expect(create).toHaveBeenCalledExactlyOnceWith(content('Created'));

    const updatedResponse = await jsonRequest(
      app,
      '/api/v1/evaluation-profiles/profile-created',
      'PUT',
      { profile: content('Updated'), expectedUpdatedAt: NOW },
    );
    expect(updatedResponse.status).toBe(200);
    expect(evaluationProfileResponseSchema.parse(await updatedResponse.json())).toEqual({
      profile: updated,
    });
    expect(update).toHaveBeenCalledExactlyOnceWith('profile-created', NOW, content('Updated'));

    const duplicatedResponse = await jsonRequest(
      app,
      '/api/v1/evaluation-profiles/profile-created/duplicate',
      'POST',
      { name: 'Copy' },
    );
    expect(duplicatedResponse.status).toBe(201);
    expect(evaluationProfileResponseSchema.parse(await duplicatedResponse.json())).toEqual({
      profile: duplicated,
    });
    expect(duplicate).toHaveBeenCalledExactlyOnceWith('profile-created', 'Copy');

    const deleted = await app.request(
      `/api/v1/evaluation-profiles/profile-copy?expectedUpdatedAt=${encodeURIComponent(NOW)}`,
      {
        method: 'DELETE',
      },
    );
    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe('');
    expect(deleteProfile).toHaveBeenCalledExactlyOnceWith('profile-copy', NOW);
  });

  it('previews JSON and confirms create and replace imports', async () => {
    const portable = document('profile-import');
    const imported = profile('profile-import', portable.profile.name);
    const replaced = profile('profile-default', portable.profile.name, true, NEXT);
    const previewImport = vi.fn(() => ({ valid: true as const, profile: portable.profile }));
    const importJson = vi
      .fn<ProfileRoutes['importJson']>()
      .mockResolvedValueOnce(imported)
      .mockResolvedValueOnce(replaced);
    const app = profileApp(profileRoutes({ previewImport, importJson }));

    const preview = await jsonRequest(
      app,
      '/api/v1/evaluation-profiles/imports/json/preview',
      'POST',
      portable,
    );
    expect(preview.status).toBe(200);
    expect(await preview.json()).toEqual({ valid: true, profile: portable.profile });
    expect(previewImport).toHaveBeenCalledExactlyOnceWith(portable);

    const createRequest = { mode: 'create' as const, document: portable };
    const confirmedCreate = await jsonRequest(
      app,
      '/api/v1/evaluation-profiles/imports/json/confirm',
      'POST',
      createRequest,
    );
    expect(confirmedCreate.status).toBe(201);
    expect(evaluationProfileResponseSchema.parse(await confirmedCreate.json())).toEqual({
      profile: imported,
    });

    const replaceRequest = {
      mode: 'replace' as const,
      targetProfileId: 'profile-default',
      expectedUpdatedAt: NOW,
      document: portable,
    };
    const confirmedReplace = await jsonRequest(
      app,
      '/api/v1/evaluation-profiles/imports/json/confirm',
      'POST',
      replaceRequest,
    );
    expect(confirmedReplace.status).toBe(200);
    expect(evaluationProfileResponseSchema.parse(await confirmedReplace.json())).toEqual({
      profile: replaced,
    });
    expect(importJson.mock.calls).toEqual([[createRequest], [replaceRequest]]);
  });

  it('serves deterministic export and template JSON artifacts as safe downloads', async () => {
    const exported = artifact(document('profile-export'));
    const template = artifact(document('profile-template'));
    const exportJson = vi.fn(async () => exported);
    const templateArtifact = vi.fn(() => template);
    const app = profileApp(profileRoutes({ exportJson, template: templateArtifact }));

    const download = await app.request('/api/v1/evaluation-profiles/profile-export/export');
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toContain('application/json');
    expect(download.headers.get('content-disposition')).toBe(
      'attachment; filename="profile-export.evaluation-profile.json"',
    );
    expect(download.headers.get('cache-control')).toBe('no-store');
    expect(await download.text()).toBe(exported.body);
    expect(exportJson).toHaveBeenCalledExactlyOnceWith('profile-export');

    const [firstTemplate, secondTemplate] = await Promise.all([
      app.request('/api/v1/evaluation-profiles/templates/json'),
      app.request('/api/v1/evaluation-profiles/templates/json'),
    ]);
    expect(firstTemplate.headers.get('content-disposition')).toBe(
      'attachment; filename="profile-template.evaluation-profile.json"',
    );
    expect(await firstTemplate.text()).toBe(template.body);
    expect(await secondTemplate.text()).toBe(template.body);
    expect(templateArtifact).toHaveBeenCalledTimes(2);
  });

  it('maps default deletion protection and optimistic conflicts to stable 409 errors', async () => {
    const deleteProfile = vi.fn(async (profileId: string): Promise<EvaluationProfile> => {
      throw profileId === 'profile-default'
        ? new EvaluationProfileServiceError(
            'default_required',
            'The default evaluation profile cannot be deleted.',
          )
        : new EvaluationProfileServiceError('conflict', 'The delete token is stale.');
    });
    const update = vi.fn(async (): Promise<EvaluationProfile> => {
      throw new EvaluationProfileServiceError('conflict', 'The update token is stale.');
    });
    const app = profileApp(profileRoutes({ delete: deleteProfile, update }));

    const protectedDelete = await app.request(
      `/api/v1/evaluation-profiles/profile-default?expectedUpdatedAt=${encodeURIComponent(NOW)}`,
      { method: 'DELETE' },
    );
    expect(protectedDelete.status).toBe(409);
    expect(apiErrorEnvelopeSchema.parse(await protectedDelete.json()).error).toMatchObject({
      code: 'DEFAULT_PROFILE_REQUIRED',
      retryable: false,
      fieldErrors: [],
    });

    const conflict = await jsonRequest(app, '/api/v1/evaluation-profiles/profile-default', 'PUT', {
      profile: content('Changed default'),
      expectedUpdatedAt: NOW,
    });
    expect(conflict.status).toBe(409);
    expect(apiErrorEnvelopeSchema.parse(await conflict.json()).error).toMatchObject({
      code: 'EVALUATION_PROFILE_CONFLICT',
      retryable: false,
      fieldErrors: [],
    });

    const staleDelete = await app.request(
      `/api/v1/evaluation-profiles/profile-copy?expectedUpdatedAt=${encodeURIComponent(NOW)}`,
      { method: 'DELETE' },
    );
    expect(staleDelete.status).toBe(409);
    expect(apiErrorEnvelopeSchema.parse(await staleDelete.json()).error.code).toBe(
      'EVALUATION_PROFILE_CONFLICT',
    );
  });

  it('returns machine-readable field errors for invalid and unknown profile fields', async () => {
    const create = vi.fn(async () => profile('unexpected'));
    const importJson = vi.fn(async () => profile('unexpected-import'));
    const previewImport = vi.fn(() => ({
      valid: true as const,
      profile: document('profile-ok').profile,
    }));
    const app = profileApp(profileRoutes({ create, importJson, previewImport }));
    const invalidProfile = { ...content(), name: '', unknownSetting: true };

    const response = await jsonRequest(app, '/api/v1/evaluation-profiles', 'POST', {
      profile: invalidProfile,
    });

    expect(response.status).toBe(400);
    const error = apiErrorEnvelopeSchema.parse(await response.json()).error;
    expect(error.code).toBe('EVALUATION_PROFILE_INVALID');
    expect(error.requestId).toBe(REQUEST_ID);
    expect(error.fieldErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ['profile', 'name'], code: 'too_small' }),
        expect.objectContaining({ path: ['profile'], code: 'unrecognized_keys' }),
      ]),
    );
    expect(create).not.toHaveBeenCalled();

    const invalidImport = await jsonRequest(
      app,
      '/api/v1/evaluation-profiles/imports/json/preview',
      'POST',
      {
        schemaVersion: 1,
        profile: { profileId: 'import-profile', ...content('Imported profile') },
        unknownFileField: true,
      },
    );
    expect(invalidImport.status).toBe(400);
    const importError = apiErrorEnvelopeSchema.parse(await invalidImport.json()).error;
    expect(importError.code).toBe('EVALUATION_PROFILE_IMPORT_INVALID');
    expect(importError.fieldErrors).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: [], code: 'unrecognized_keys' })]),
    );
    expect(previewImport).not.toHaveBeenCalled();
    expect(importJson).not.toHaveBeenCalled();
  });

  it('advertises and applies CORS for browser PUT and DELETE requests', async () => {
    const update = vi.fn(async () => profile('profile-cors', 'CORS update', false, NEXT));
    const deleteProfile = vi.fn(async () => profile('profile-cors'));
    const app = createBackendHttpApp(
      backendDependencies(
        profileRoutes({
          update,
          delete: deleteProfile,
          exportJson: async () => artifact(document('profile-cors')),
        }),
      ),
    );

    for (const method of ['PUT', 'DELETE'] as const) {
      const preflight = await app.request('/api/v1/evaluation-profiles/profile-cors', {
        method: 'OPTIONS',
        headers: {
          Origin: ALLOWED_ORIGIN,
          'Access-Control-Request-Method': method,
          'Access-Control-Request-Headers': 'content-type',
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
      expect(preflight.headers.get('access-control-allow-methods')).toContain(method);
    }

    const updated = await app.request('/api/v1/evaluation-profiles/profile-cors', {
      method: 'PUT',
      headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: content('CORS update'), expectedUpdatedAt: NOW }),
    });
    expect(updated.status).toBe(200);
    expect(updated.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);

    const deleted = await app.request(
      `/api/v1/evaluation-profiles/profile-cors?expectedUpdatedAt=${encodeURIComponent(NOW)}`,
      {
        method: 'DELETE',
        headers: { Origin: ALLOWED_ORIGIN },
      },
    );
    expect(deleted.status).toBe(204);
    expect(deleted.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);

    const downloaded = await app.request('/api/v1/evaluation-profiles/profile-cors/export', {
      headers: { Origin: ALLOWED_ORIGIN },
    });
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get('access-control-expose-headers')).toContain(
      'Content-Disposition',
    );
    expect(downloaded.headers.get('content-disposition')).toContain('profile-cors');
  });
});

function content(name = 'General evidence profile'): EvaluationProfileContent {
  return evaluationProfileContentSchema.parse({
    name,
    description: 'A guide-independent coding profile.',
    coderPrompt: 'Code each item from canonical transcript evidence.',
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
        })),
      },
    ],
  });
}

function profile(
  profileId: string,
  name = 'General evidence profile',
  isDefault = false,
  updatedAt = NOW,
): EvaluationProfile {
  return {
    profileId,
    ...content(name),
    isDefault,
    createdAt: NOW,
    updatedAt,
  };
}

function summary(value: EvaluationProfile): EvaluationProfileSummary {
  return {
    profileId: value.profileId,
    name: value.name,
    description: value.description,
    isDefault: value.isDefault,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function document(profileId: string): EvaluationProfileDocument {
  return evaluationProfileDocumentSchema.parse({
    schemaVersion: 1,
    profile: { profileId, ...content() },
  });
}

function artifact(value: EvaluationProfileDocument) {
  return {
    body: `${JSON.stringify(value, null, 2)}\n`,
    contentType: 'application/json; charset=utf-8' as const,
    fileName: `${value.profile.profileId}.evaluation-profile.json`,
  };
}

function profileRoutes(overrides: Partial<ProfileRoutes> = {}): ProfileRoutes {
  const current = profile('profile-default', 'Default', true);
  const currentDocument = document(current.profileId);
  return {
    list: async () => [summary(current)],
    get: async () => current,
    create: async () => profile('profile-created', 'Created'),
    update: async () => profile('profile-created', 'Updated', false, NEXT),
    duplicate: async () => profile('profile-copy', 'Copy'),
    delete: async () => current,
    exportJson: async () => artifact(currentDocument),
    template: () => artifact(document('profile-template')),
    previewImport: (candidate) => {
      const parsed = evaluationProfileDocumentSchema.parse(candidate);
      return { valid: true, profile: parsed.profile };
    },
    importJson: async () => current,
    guardrails: () => ({
      evidenceSource: 'final_participant_turns_only',
      exactQuotesRequired: true,
      validTurnReferencesRequired: true,
      fabricatedContentForbidden: true,
      hiddenChainOfThoughtForbidden: true,
      structuredOutputLocked: true,
      scoreRangeLocked: 'integer_1_7_or_non_score',
      aggregationLocked: true,
    }),
    ...overrides,
  };
}

function profileApp(evaluationProfiles: ProfileRoutes): Hono<HttpEnvironment> {
  const app = new Hono<HttpEnvironment>();
  app.use('*', async (context, next) => {
    context.set('requestId', REQUEST_ID);
    await next();
  });
  registerEvaluationProfileHttpRoutes(app, {
    clock: { now: () => NOW },
    evaluationProfiles,
  });
  return app;
}

function backendDependencies(evaluationProfiles: ProfileRoutes): BackendHttpDependencies {
  const unexpected = async (): Promise<never> => {
    throw new Error('Unexpected unrelated HTTP service call');
  };
  return {
    allowedOrigins: [ALLOWED_ORIGIN],
    clock: { now: () => NOW },
    readiness: { check: async () => 'ready' },
    importGuide: { execute: unexpected },
    getGuide: { execute: unexpected },
    createInterview: { execute: unexpected },
    getInterview: { execute: unexpected },
    listInterviews: { execute: unexpected },
    getMonitoringSnapshot: { execute: unexpected },
    getMonitoringEventHistory: { execute: unexpected },
    openMonitoringEventStream: { execute: unexpected },
    evaluationProfiles,
  };
}

async function jsonRequest(
  app: Hono<HttpEnvironment>,
  path: string,
  method: 'POST' | 'PUT',
  body: unknown,
): Promise<Response> {
  return app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
