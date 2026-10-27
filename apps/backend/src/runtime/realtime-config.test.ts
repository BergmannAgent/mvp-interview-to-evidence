import { describe, expect, it } from 'vitest';

import { loadRealtimeRuntimeConfig, RealtimeRuntimeConfigurationError } from './realtime-config.js';

describe('realtime runtime configuration', () => {
  it('uses bounded production defaults without requiring optional environment settings', () => {
    const config = loadRealtimeRuntimeConfig({ UNRELATED_VALUE: 'ignored' });

    expect(config).toEqual({
      pollIntervalMs: 1_000,
      replayPageSize: 250,
      maximumReplayEvents: 50_000,
      maximumSubscribers: 200,
      maximumSubscribersPerInterview: 20,
      heartbeatIntervalMs: 15_000,
      retryMs: 1_000,
      writeTimeoutMs: 5_000,
      maximumFrameBytes: 262_144,
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('loads explicit values for deterministic deployments and constrained tests', () => {
    expect(
      loadRealtimeRuntimeConfig({
        REALTIME_POLL_INTERVAL_MS: '50',
        REALTIME_REPLAY_PAGE_SIZE: '10',
        REALTIME_MAXIMUM_REPLAY_EVENTS: '100',
        REALTIME_MAXIMUM_SUBSCRIBERS: '12',
        REALTIME_MAXIMUM_SUBSCRIBERS_PER_INTERVIEW: '3',
        REALTIME_HEARTBEAT_INTERVAL_MS: '250',
        REALTIME_RETRY_MS: '500',
        REALTIME_WRITE_TIMEOUT_MS: '100',
        REALTIME_MAXIMUM_FRAME_BYTES: '4096',
      }),
    ).toEqual({
      pollIntervalMs: 50,
      replayPageSize: 10,
      maximumReplayEvents: 100,
      maximumSubscribers: 12,
      maximumSubscribersPerInterview: 3,
      heartbeatIntervalMs: 250,
      retryMs: 500,
      writeTimeoutMs: 100,
      maximumFrameBytes: 4_096,
    });
  });

  it.each([
    { REALTIME_REPLAY_PAGE_SIZE: '100', REALTIME_MAXIMUM_REPLAY_EVENTS: '99' },
    { REALTIME_MAXIMUM_SUBSCRIBERS: '2', REALTIME_MAXIMUM_SUBSCRIBERS_PER_INTERVIEW: '3' },
    { REALTIME_RETRY_MS: '249' },
    { REALTIME_MAXIMUM_FRAME_BYTES: '1023' },
    { REALTIME_POLL_INTERVAL_MS: 'not-a-number' },
    { REALTIME_POLL_INTERVAL_MS: '1000', REALTIME_HEARTBEAT_INTERVAL_MS: '999' },
  ])('rejects invalid or internally inconsistent values %j', (environment) => {
    expect(() => loadRealtimeRuntimeConfig(environment)).toThrow(RealtimeRuntimeConfigurationError);
  });
});
