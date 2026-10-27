import { z } from 'zod';

const databaseUrlSchema = z
  .string()
  .trim()
  .min(1, 'DATABASE_URL is required')
  .superRefine((value, context) => {
    try {
      const url = new URL(value);
      if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
        context.addIssue({
          code: 'custom',
          message: 'DATABASE_URL must use the postgres or postgresql protocol',
        });
      }
      if (url.hostname.length === 0) {
        context.addIssue({ code: 'custom', message: 'DATABASE_URL must contain a host' });
      }
      if (url.pathname.length <= 1) {
        context.addIssue({ code: 'custom', message: 'DATABASE_URL must name a database' });
      }
      if (url.hash.length > 0) {
        context.addIssue({ code: 'custom', message: 'DATABASE_URL must not contain a fragment' });
      }
    } catch {
      context.addIssue({ code: 'custom', message: 'DATABASE_URL must be a valid URL' });
    }
  });

const databaseEnvironmentSchema = z.object({
  DATABASE_URL: databaseUrlSchema,
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DATABASE_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(30_000),
  DATABASE_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(10_000),
  DATABASE_READINESS_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(2_000),
  DATABASE_APPLICATION_NAME: z.string().trim().min(1).max(100).default('orgscience-backend'),
});

export interface DatabaseConfig {
  readonly connectionString: string;
  readonly redactedConnectionString: string;
  readonly maximumPoolSize: number;
  readonly idleTimeoutMs: number;
  readonly connectionTimeoutMs: number;
  readonly readinessTimeoutMs: number;
  readonly applicationName: string;
}

export class DatabaseConfigurationError extends Error {
  public readonly issues: readonly string[];

  public constructor(issues: readonly string[]) {
    super(`Invalid database configuration: ${issues.join('; ')}`);
    this.name = 'DatabaseConfigurationError';
    this.issues = issues;
  }
}

export function loadDatabaseConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): DatabaseConfig {
  const result = databaseEnvironmentSchema.safeParse(environment);
  if (!result.success) {
    throw new DatabaseConfigurationError(
      result.error.issues.map((issue) => {
        const path = issue.path.length === 0 ? 'database' : issue.path.map(String).join('.');
        return `${path}: ${issue.message}`;
      }),
    );
  }

  return Object.freeze({
    connectionString: result.data.DATABASE_URL,
    redactedConnectionString: redactDatabaseUrl(result.data.DATABASE_URL),
    maximumPoolSize: result.data.DATABASE_POOL_MAX,
    idleTimeoutMs: result.data.DATABASE_IDLE_TIMEOUT_MS,
    connectionTimeoutMs: result.data.DATABASE_CONNECTION_TIMEOUT_MS,
    readinessTimeoutMs: result.data.DATABASE_READINESS_TIMEOUT_MS,
    applicationName: result.data.DATABASE_APPLICATION_NAME,
  });
}

export function redactDatabaseUrl(value: string): string {
  try {
    const url = new URL(value);
    const queryMarker = url.search.length === 0 ? '' : '?<redacted>';
    return `${url.protocol}//${url.host}${url.pathname}${queryMarker}`;
  } catch {
    return '<invalid-database-url>';
  }
}
