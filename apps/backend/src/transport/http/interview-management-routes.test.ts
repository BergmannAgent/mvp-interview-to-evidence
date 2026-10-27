import { type InterviewSummary } from '@orgscience/contracts';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { failure, success } from '../../application/persistence/index.js';
import type { ManageInterviewsService } from '../../application/interviews/manage-interviews.js';
import type { HttpEnvironment } from './error-response.js';
import { registerInterviewManagementRoutes } from './interview-management-routes.js';

const NOW = '2026-10-01T12:00:00.000Z';
const summary: InterviewSummary = {
  interviewId: 'interview-1',
  guideId: 'guide-1',
  language: 'de',
  guideTitle: 'Original guide',
  displayName: 'Interview Anna',
  status: 'paused',
  currentMainQuestionId: null,
  activeWorkflowRunId: null,
  createdAt: NOW,
  updatedAt: NOW,
  startedAt: NOW,
};

function testApp(
  service: Pick<ManageInterviewsService, 'rename' | 'delete'>,
): Hono<HttpEnvironment> {
  const app = new Hono<HttpEnvironment>();
  app.use('*', async (context, next) => {
    context.set('requestId', 'request-management');
    await next();
  });
  registerInterviewManagementRoutes(app, service, { now: () => NOW });
  return app;
}

describe('interview management HTTP boundary', () => {
  it.each(['Interview Anna', null])('validates and forwards a name or reset: %s', async (name) => {
    const rename = vi.fn(async () => success({ ...summary, displayName: name }));
    const app = testApp({ rename, delete: async () => success(undefined) });
    const result = await app.request('/api/v1/interviews/interview-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: name }),
    });
    expect(result.status).toBe(200);
    expect(rename).toHaveBeenCalledWith('interview-1', name);
    expect(await result.json()).toEqual({ interview: { ...summary, displayName: name } });
  });

  it.each([
    { displayName: '' },
    { displayName: 'x'.repeat(201) },
    { displayName: 'Name', status: 'completed' },
  ])('rejects invalid or state-changing rename payloads before application work', async (body) => {
    const rename = vi.fn(async () => success(summary));
    const result = await testApp({ rename, delete: async () => success(undefined) }).request(
      '/api/v1/interviews/interview-1',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    expect(result.status).toBe(400);
    expect(rename).not.toHaveBeenCalled();
  });

  it('returns empty 204 only after a successful deletion', async () => {
    const remove = vi.fn(async () => success(undefined));
    const result = await testApp({ rename: async () => success(summary), delete: remove }).request(
      '/api/v1/interviews/interview-1',
      { method: 'DELETE' },
    );
    expect(remove).toHaveBeenCalledWith('interview-1');
    expect(result.status).toBe(204);
    expect(await result.text()).toBe('');
  });

  it('exposes a controlled 409 for an interview with pending processing', async () => {
    const app = testApp({
      rename: async () => success(summary),
      delete: async () =>
        failure({
          code: 'interview_busy',
          interviewId: 'interview-1',
          reason: 'active_evaluation',
        }),
    });
    const result = await app.request('/api/v1/interviews/interview-1', { method: 'DELETE' });
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({
      error: { code: 'INTERVIEW_STATE_CONFLICT', fieldErrors: [{ code: 'active_evaluation' }] },
    });
  });

  it('does not report success for a missing interview', async () => {
    const app = testApp({
      rename: async () => success(summary),
      delete: async () => failure({ code: 'not_found', resource: 'interview', id: 'interview-1' }),
    });
    expect((await app.request('/api/v1/interviews/interview-1', { method: 'DELETE' })).status).toBe(
      404,
    );
  });
});
