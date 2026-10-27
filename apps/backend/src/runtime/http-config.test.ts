import { describe, expect, it } from 'vitest';

import { HttpRuntimeConfigurationError, loadHttpRuntimeConfig } from './http-config.js';

describe('HTTP runtime configuration', () => {
  it('loads an explicit host, port, and unique canonical origin allowlist', () => {
    const config = loadHttpRuntimeConfig({
      BACKEND_HOST: '0.0.0.0',
      BACKEND_PORT: '3000',
      BACKEND_SHUTDOWN_TIMEOUT_MS: '7500',
      HTTP_ALLOWED_ORIGINS: 'http://localhost:5173/, https://monitor.example.test:443',
      UNRELATED_ENVIRONMENT_VALUE: 'ignored',
    });

    expect(config).toEqual({
      host: '0.0.0.0',
      port: 3_000,
      shutdownTimeoutMs: 7_500,
      allowedOrigins: ['http://localhost:5173', 'https://monitor.example.test'],
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.allowedOrigins)).toBe(true);
  });

  it('requires every HTTP runtime setting to be configured explicitly', () => {
    expect(() => loadHttpRuntimeConfig({})).toThrow(HttpRuntimeConfigurationError);
    expect(() =>
      loadHttpRuntimeConfig({
        BACKEND_HOST: 'localhost',
        BACKEND_PORT: '3000',
      }),
    ).toThrow(/HTTP_ALLOWED_ORIGINS is required/);
  });

  it.each(['0', '65536', '3.5', 'not-a-port'])('rejects invalid backend port %s', (port) => {
    expect(() =>
      loadHttpRuntimeConfig({
        BACKEND_HOST: 'localhost',
        BACKEND_PORT: port,
        HTTP_ALLOWED_ORIGINS: 'http://localhost:5173',
      }),
    ).toThrow(HttpRuntimeConfigurationError);
  });

  it.each(['99', '120001', '1.5', 'not-a-duration'])(
    'rejects invalid shutdown timeout %s',
    (timeout) => {
      expect(() =>
        loadHttpRuntimeConfig({
          BACKEND_HOST: 'localhost',
          BACKEND_PORT: '3000',
          BACKEND_SHUTDOWN_TIMEOUT_MS: timeout,
          HTTP_ALLOWED_ORIGINS: 'http://localhost:5173',
        }),
      ).toThrow(HttpRuntimeConfigurationError);
    },
  );

  it.each([
    'http://localhost/path',
    'https://example.test?token=value',
    'https://example.test#part',
    'https://user:password@example.test',
    'ws://example.test',
    'example.test',
  ])('rejects non-origin allowlist entry %s', (origin) => {
    expect(() =>
      loadHttpRuntimeConfig({
        BACKEND_HOST: 'backend.internal',
        BACKEND_PORT: '3000',
        HTTP_ALLOWED_ORIGINS: origin,
      }),
    ).toThrow(HttpRuntimeConfigurationError);
  });

  it('rejects empty and canonically duplicate origins', () => {
    const baseEnvironment = {
      BACKEND_HOST: '::1',
      BACKEND_PORT: '3000',
    };

    expect(() =>
      loadHttpRuntimeConfig({
        ...baseEnvironment,
        HTTP_ALLOWED_ORIGINS: 'http://localhost:5173,',
      }),
    ).toThrow(/must not be empty/);
    expect(() =>
      loadHttpRuntimeConfig({
        ...baseEnvironment,
        HTTP_ALLOWED_ORIGINS: 'https://example.test,https://example.test:443/',
      }),
    ).toThrow(/duplicates another origin/);
  });

  it.each(['https://backend.example.test', 'bad host', '-backend.internal', 'backend/internal'])(
    'rejects invalid backend host %s',
    (host) => {
      expect(() =>
        loadHttpRuntimeConfig({
          BACKEND_HOST: host,
          BACKEND_PORT: '3000',
          HTTP_ALLOWED_ORIGINS: 'http://localhost:5173',
        }),
      ).toThrow(HttpRuntimeConfigurationError);
    },
  );
});
