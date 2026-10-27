import { z } from 'zod';

const realtimeEnvironmentSchema = z
  .object({
    REALTIME_POLL_INTERVAL_MS: z.coerce.number().int().min(10).max(60_000).default(1_000),
    REALTIME_REPLAY_PAGE_SIZE: z.coerce.number().int().min(1).max(1_000).default(250),
    REALTIME_MAXIMUM_REPLAY_EVENTS: z.coerce.number().int().min(1).max(1_000_000).default(50_000),
    REALTIME_MAXIMUM_SUBSCRIBERS: z.coerce.number().int().min(1).max(10_000).default(200),
    REALTIME_MAXIMUM_SUBSCRIBERS_PER_INTERVIEW: z.coerce
      .number()
      .int()
      .min(1)
      .max(1_000)
      .default(20),
    REALTIME_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(10).max(60_000).default(15_000),
    REALTIME_RETRY_MS: z.coerce.number().int().min(250).max(60_000).default(1_000),
    REALTIME_WRITE_TIMEOUT_MS: z.coerce.number().int().min(10).max(30_000).default(5_000),
    REALTIME_MAXIMUM_FRAME_BYTES: z.coerce
      .number()
      .int()
      .min(1_024)
      .max(1_048_576)
      .default(262_144),
  })
  .superRefine((configuration, context) => {
    if (configuration.REALTIME_MAXIMUM_REPLAY_EVENTS < configuration.REALTIME_REPLAY_PAGE_SIZE) {
      context.addIssue({
        code: 'custom',
        path: ['REALTIME_MAXIMUM_REPLAY_EVENTS'],
        message: 'REALTIME_MAXIMUM_REPLAY_EVENTS must be at least REALTIME_REPLAY_PAGE_SIZE',
      });
    }
    if (
      configuration.REALTIME_MAXIMUM_SUBSCRIBERS_PER_INTERVIEW >
      configuration.REALTIME_MAXIMUM_SUBSCRIBERS
    ) {
      context.addIssue({
        code: 'custom',
        path: ['REALTIME_MAXIMUM_SUBSCRIBERS_PER_INTERVIEW'],
        message:
          'REALTIME_MAXIMUM_SUBSCRIBERS_PER_INTERVIEW must not exceed REALTIME_MAXIMUM_SUBSCRIBERS',
      });
    }
    if (configuration.REALTIME_POLL_INTERVAL_MS > configuration.REALTIME_HEARTBEAT_INTERVAL_MS) {
      context.addIssue({
        code: 'custom',
        path: ['REALTIME_POLL_INTERVAL_MS'],
        message: 'REALTIME_POLL_INTERVAL_MS must not exceed REALTIME_HEARTBEAT_INTERVAL_MS',
      });
    }
  });

export interface RealtimeRuntimeConfig {
  readonly pollIntervalMs: number;
  readonly replayPageSize: number;
  readonly maximumReplayEvents: number;
  readonly maximumSubscribers: number;
  readonly maximumSubscribersPerInterview: number;
  readonly heartbeatIntervalMs: number;
  readonly retryMs: number;
  readonly writeTimeoutMs: number;
  readonly maximumFrameBytes: number;
}

export class RealtimeRuntimeConfigurationError extends Error {
  public readonly issues: readonly string[];

  public constructor(issues: readonly string[]) {
    super(`Invalid realtime runtime configuration: ${issues.join('; ')}`);
    this.name = 'RealtimeRuntimeConfigurationError';
    this.issues = issues;
  }
}

export function loadRealtimeRuntimeConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): RealtimeRuntimeConfig {
  const result = realtimeEnvironmentSchema.safeParse(environment);
  if (!result.success) {
    throw new RealtimeRuntimeConfigurationError(
      result.error.issues.map((issue) => {
        const path = issue.path.length === 0 ? 'realtime' : issue.path.map(String).join('.');
        return `${path}: ${issue.message}`;
      }),
    );
  }

  return Object.freeze({
    pollIntervalMs: result.data.REALTIME_POLL_INTERVAL_MS,
    replayPageSize: result.data.REALTIME_REPLAY_PAGE_SIZE,
    maximumReplayEvents: result.data.REALTIME_MAXIMUM_REPLAY_EVENTS,
    maximumSubscribers: result.data.REALTIME_MAXIMUM_SUBSCRIBERS,
    maximumSubscribersPerInterview: result.data.REALTIME_MAXIMUM_SUBSCRIBERS_PER_INTERVIEW,
    heartbeatIntervalMs: result.data.REALTIME_HEARTBEAT_INTERVAL_MS,
    retryMs: result.data.REALTIME_RETRY_MS,
    writeTimeoutMs: result.data.REALTIME_WRITE_TIMEOUT_MS,
    maximumFrameBytes: result.data.REALTIME_MAXIMUM_FRAME_BYTES,
  });
}
