import { describe, expect, it } from 'vitest';

import { DatabaseConfigurationError, loadDatabaseConfig, redactDatabaseUrl } from './config.js';

describe('database configuration', () => {
  it('validates a PostgreSQL URL and bounded pool settings', () => {
    const config = loadDatabaseConfig({
      DATABASE_URL: 'postgresql://interview:secret@postgres:5432/interview?sslmode=require',
      DATABASE_POOL_MAX: '12',
      DATABASE_IDLE_TIMEOUT_MS: '45000',
      DATABASE_CONNECTION_TIMEOUT_MS: '5000',
      DATABASE_READINESS_TIMEOUT_MS: '1500',
      DATABASE_APPLICATION_NAME: 'migration-test',
    });

    expect(config).toEqual({
      connectionString: 'postgresql://interview:secret@postgres:5432/interview?sslmode=require',
      redactedConnectionString: 'postgresql://postgres:5432/interview?<redacted>',
      maximumPoolSize: 12,
      idleTimeoutMs: 45_000,
      connectionTimeoutMs: 5_000,
      readinessTimeoutMs: 1_500,
      applicationName: 'migration-test',
    });
  });

  it('uses deterministic defaults', () => {
    const config = loadDatabaseConfig({ DATABASE_URL: 'postgres://localhost/interview' });

    expect(config).toMatchObject({
      maximumPoolSize: 10,
      idleTimeoutMs: 30_000,
      connectionTimeoutMs: 10_000,
      readinessTimeoutMs: 2_000,
      applicationName: 'orgscience-backend',
    });
  });

  it.each(['99', '30001', '1.5', 'not-a-duration'])(
    'rejects invalid readiness timeout %s',
    (timeout) => {
      expect(() =>
        loadDatabaseConfig({
          DATABASE_URL: 'postgres://localhost/interview',
          DATABASE_READINESS_TIMEOUT_MS: timeout,
        }),
      ).toThrow(DatabaseConfigurationError);
    },
  );

  it('rejects invalid protocols, missing databases, and unsafe numeric settings', () => {
    expect(() =>
      loadDatabaseConfig({ DATABASE_URL: 'mysql://user:secret@localhost/interview' }),
    ).toThrow(DatabaseConfigurationError);
    expect(() => loadDatabaseConfig({ DATABASE_URL: 'postgresql://localhost' })).toThrow(
      DatabaseConfigurationError,
    );
    expect(() =>
      loadDatabaseConfig({
        DATABASE_URL: 'postgresql://localhost/interview',
        DATABASE_POOL_MAX: '0',
      }),
    ).toThrow(DatabaseConfigurationError);
  });

  it('never includes credentials or query values in a redacted URL or validation error', () => {
    const secret = 'do-not-log-this';
    expect(
      redactDatabaseUrl(
        `postgresql://sensitive-user:${secret}@db.example.test:5432/research?sslkey=${secret}`,
      ),
    ).toBe('postgresql://db.example.test:5432/research?<redacted>');

    let captured: unknown;
    try {
      loadDatabaseConfig({ DATABASE_URL: `not-a-url-${secret}` });
    } catch (error: unknown) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(DatabaseConfigurationError);
    expect(String(captured)).not.toContain(secret);
  });
});
