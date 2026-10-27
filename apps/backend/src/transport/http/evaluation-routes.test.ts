import {
  apiErrorEnvelopeSchema,
  evaluationSnapshotResponseSchema,
  evaluationSnapshotSchema,
} from '@orgscience/contracts';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import type { HttpEnvironment } from './error-response.js';
import {
  registerEvaluationHttpRoutes,
  type EvaluationHttpRouteDependencies,
} from './evaluation-routes.js';

const NOW = '2026-08-21T12:00:00.000Z';
const INTERVIEW_ID = 'interview-evaluation-http-1';
const PROFILE_ID = 'profile-research';
const PROFILE_FINGERPRINT = 'a'.repeat(64);

type EvaluationRoutes = EvaluationHttpRouteDependencies['evaluation'];

const notStarted = evaluationSnapshotSchema.parse({
  status: 'not_started',
  interviewId: INTERVIEW_ID,
  profileId: PROFILE_ID,
  profileFingerprint: PROFILE_FINGERPRINT,
  report: null,
  failure: null,
});

const running = evaluationSnapshotSchema.parse({
  status: 'running',
  evaluationId: 'evaluation-http-1',
  interviewId: INTERVIEW_ID,
  profileId: PROFILE_ID,
  profileFingerprint: PROFILE_FINGERPRINT,
  startedAt: NOW,
  report: null,
  failure: null,
});

describe('evaluation HTTP boundary', () => {
  it('loads an evaluation without starting or retrying a run', async () => {
    const get = vi.fn(async () => notStarted);
    const run = vi.fn(async () => running);
    const retry = vi.fn(async () => running);
    const app = evaluationApp(evaluationRoutes({ get, run, retry }));

    const response = await app.request(
      `/api/v1/interviews/${INTERVIEW_ID}/evaluation?profileId=${PROFILE_ID}`,
    );

    expect(response.status).toBe(200);
    expect(evaluationSnapshotResponseSchema.parse(await response.json())).toEqual({
      evaluation: notStarted,
    });
    expect(get).toHaveBeenCalledExactlyOnceWith(INTERVIEW_ID, PROFILE_ID);
    expect(run).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
  });

  it('starts an evaluation explicitly with the selected profile', async () => {
    const run = vi.fn(async () => running);
    const app = evaluationApp(evaluationRoutes({ run }));

    const response = await jsonRequest(app, `/api/v1/interviews/${INTERVIEW_ID}/evaluation`, {
      profileId: PROFILE_ID,
    });

    expect(response.status).toBe(200);
    expect(evaluationSnapshotResponseSchema.parse(await response.json())).toEqual({
      evaluation: running,
    });
    expect(run).toHaveBeenCalledExactlyOnceWith(INTERVIEW_ID, PROFILE_ID);
  });

  it('uses the default profile when an explicit start omits profileId', async () => {
    const run = vi.fn(async () => running);
    const app = evaluationApp(evaluationRoutes({ run }));

    const response = await jsonRequest(app, `/api/v1/interviews/${INTERVIEW_ID}/evaluation`, {});

    expect(response.status).toBe(200);
    expect(run).toHaveBeenCalledExactlyOnceWith(INTERVIEW_ID, undefined);
  });

  it('keeps retry as an explicit run alias with optional profile selection', async () => {
    const retry = vi.fn(async () => running);
    const app = evaluationApp(evaluationRoutes({ retry }));

    const response = await jsonRequest(app, `/api/v1/interviews/${INTERVIEW_ID}/evaluation/retry`, {
      profileId: PROFILE_ID,
    });

    expect(response.status).toBe(200);
    expect(evaluationSnapshotResponseSchema.parse(await response.json())).toEqual({
      evaluation: running,
    });
    expect(retry).toHaveBeenCalledExactlyOnceWith(INTERVIEW_ID, PROFILE_ID);
  });

  it('passes profile selection to HTML export and serves it inline with restrictive headers', async () => {
    const exportArtifact = vi.fn(async () => ({
      contentType: 'text/html; charset=utf-8' as const,
      fileName: 'evaluation.html',
      body: '<!doctype html><title>Report</title>',
    }));
    const app = evaluationApp(evaluationRoutes({ export: exportArtifact }));

    const response = await app.request(
      `/api/v1/interviews/${INTERVIEW_ID}/evaluation/export?format=html&profileId=${PROFILE_ID}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('content-disposition')).toBe('inline; filename="evaluation.html"');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(exportArtifact).toHaveBeenCalledExactlyOnceWith(INTERVIEW_ID, 'html', PROFILE_ID);
  });

  it('serves Markdown as an attachment and permits default profile selection', async () => {
    const exportArtifact = vi.fn(async () => ({
      contentType: 'text/markdown; charset=utf-8' as const,
      fileName: 'evaluation.md',
      body: '# Report\n',
    }));
    const app = evaluationApp(evaluationRoutes({ export: exportArtifact }));

    const response = await app.request(
      `/api/v1/interviews/${INTERVIEW_ID}/evaluation/export?format=markdown`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="evaluation.md"',
    );
    expect(response.headers.get('content-security-policy')).toBeNull();
    expect(exportArtifact).toHaveBeenCalledExactlyOnceWith(INTERVIEW_ID, 'markdown', undefined);
  });

  it('rejects invalid profile selection before calling the service', async () => {
    const get = vi.fn(async () => notStarted);
    const app = evaluationApp(evaluationRoutes({ get }));

    const response = await app.request(
      `/api/v1/interviews/${INTERVIEW_ID}/evaluation?profileId=not%20valid`,
    );

    expect(response.status).toBe(400);
    expect(apiErrorEnvelopeSchema.parse(await response.json()).error.code).toBe('VALIDATION_ERROR');
    expect(get).not.toHaveBeenCalled();
  });
});

function evaluationApp(evaluation: EvaluationRoutes): Hono<HttpEnvironment> {
  const app = new Hono<HttpEnvironment>();
  app.use('*', async (context, next) => {
    context.set('requestId', 'request-evaluation-http-1');
    await next();
  });
  registerEvaluationHttpRoutes(app, {
    clock: { now: () => NOW },
    evaluation,
  });
  return app;
}

function evaluationRoutes(overrides: Partial<EvaluationRoutes> = {}): EvaluationRoutes {
  return {
    get: async () => notStarted,
    run: async () => running,
    retry: async () => running,
    export: async () => ({
      contentType: 'application/json; charset=utf-8',
      fileName: 'evaluation.json',
      body: '{}',
    }),
    ...overrides,
  };
}

function jsonRequest(app: Hono<HttpEnvironment>, path: string, body: unknown): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}
