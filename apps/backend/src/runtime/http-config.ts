import { isIP } from 'node:net';

import { z } from 'zod';

const hostnameLabelPattern = /^(?!-)[a-z\d-]{1,63}(?<!-)$/i;

const backendHostSchema = z
  .string({ error: 'BACKEND_HOST is required' })
  .trim()
  .min(1, 'BACKEND_HOST is required')
  .max(253, 'BACKEND_HOST must contain at most 253 characters')
  .refine(isValidHost, 'BACKEND_HOST must be an IP address or hostname');

const backendPortSchema = z.coerce
  .number()
  .int('BACKEND_PORT must be an integer')
  .min(1, 'BACKEND_PORT must be at least 1')
  .max(65_535, 'BACKEND_PORT must be at most 65535');

const shutdownTimeoutSchema = z.coerce
  .number()
  .int('BACKEND_SHUTDOWN_TIMEOUT_MS must be an integer')
  .min(100, 'BACKEND_SHUTDOWN_TIMEOUT_MS must be at least 100')
  .max(120_000, 'BACKEND_SHUTDOWN_TIMEOUT_MS must be at most 120000')
  .default(5_000);

const allowedOriginsSchema = z
  .string({ error: 'HTTP_ALLOWED_ORIGINS is required' })
  .trim()
  .min(1, 'HTTP_ALLOWED_ORIGINS is required')
  .superRefine((value, context) => {
    const origins = value.split(',').map((origin) => origin.trim());
    const canonicalOrigins = new Set<string>();

    for (const [index, origin] of origins.entries()) {
      if (origin.length === 0) {
        context.addIssue({
          code: 'custom',
          message: `HTTP_ALLOWED_ORIGINS entry ${index + 1} must not be empty`,
        });
        continue;
      }

      const canonicalOrigin = parseCanonicalHttpOrigin(origin);
      if (canonicalOrigin === undefined) {
        context.addIssue({
          code: 'custom',
          message: `HTTP_ALLOWED_ORIGINS entry ${index + 1} must be an http or https origin without credentials, path, query, or fragment`,
        });
        continue;
      }

      if (canonicalOrigins.has(canonicalOrigin)) {
        context.addIssue({
          code: 'custom',
          message: `HTTP_ALLOWED_ORIGINS entry ${index + 1} duplicates another origin`,
        });
        continue;
      }

      canonicalOrigins.add(canonicalOrigin);
    }
  });

const httpEnvironmentSchema = z.strictObject({
  BACKEND_HOST: backendHostSchema,
  BACKEND_PORT: backendPortSchema,
  BACKEND_SHUTDOWN_TIMEOUT_MS: shutdownTimeoutSchema,
  HTTP_ALLOWED_ORIGINS: allowedOriginsSchema,
});

export interface HttpRuntimeConfig {
  readonly host: string;
  readonly port: number;
  readonly shutdownTimeoutMs: number;
  readonly allowedOrigins: readonly string[];
}

export class HttpRuntimeConfigurationError extends Error {
  public readonly issues: readonly string[];

  public constructor(issues: readonly string[]) {
    super(`Invalid HTTP runtime configuration: ${issues.join('; ')}`);
    this.name = 'HttpRuntimeConfigurationError';
    this.issues = issues;
  }
}

export function loadHttpRuntimeConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): HttpRuntimeConfig {
  const result = httpEnvironmentSchema.safeParse({
    BACKEND_HOST: environment.BACKEND_HOST,
    BACKEND_PORT: environment.BACKEND_PORT,
    BACKEND_SHUTDOWN_TIMEOUT_MS: environment.BACKEND_SHUTDOWN_TIMEOUT_MS,
    HTTP_ALLOWED_ORIGINS: environment.HTTP_ALLOWED_ORIGINS,
  });

  if (!result.success) {
    throw new HttpRuntimeConfigurationError(
      result.error.issues.map((issue) => {
        const path = issue.path.length === 0 ? 'http' : issue.path.map(String).join('.');
        return `${path}: ${issue.message}`;
      }),
    );
  }

  return Object.freeze({
    host: result.data.BACKEND_HOST,
    port: result.data.BACKEND_PORT,
    shutdownTimeoutMs: result.data.BACKEND_SHUTDOWN_TIMEOUT_MS,
    allowedOrigins: Object.freeze(
      result.data.HTTP_ALLOWED_ORIGINS.split(',').map((origin) => {
        const canonicalOrigin = parseCanonicalHttpOrigin(origin.trim());
        if (canonicalOrigin === undefined) {
          throw new Error('HTTP origin passed validation without a canonical representation');
        }
        return canonicalOrigin;
      }),
    ),
  });
}

function isValidHost(value: string): boolean {
  if (isIP(value) !== 0) {
    return true;
  }

  const hostname = value.endsWith('.') ? value.slice(0, -1) : value;
  return (
    hostname.length > 0 && hostname.split('.').every((label) => hostnameLabelPattern.test(label))
  );
}

function parseCanonicalHttpOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.pathname !== '/' ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) {
      return undefined;
    }

    return url.origin;
  } catch {
    return undefined;
  }
}
