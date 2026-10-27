import { describe, expect, it } from 'vitest';

import { InMemoryRealtimeSignalHub } from './signal-hub.js';

describe('InMemoryRealtimeSignalHub', () => {
  it('isolates interviews and gives multiple tabs independent wake-ups', async () => {
    const hub = new InMemoryRealtimeSignalHub();
    const tabOne = hub.subscribe('interview-1');
    const tabTwo = hub.subscribe('interview-1');
    const otherInterview = hub.subscribe('interview-2');
    expect(tabOne).not.toBeNull();
    expect(tabTwo).not.toBeNull();
    expect(otherInterview).not.toBeNull();
    if (tabOne === null || tabTwo === null || otherInterview === null) return;

    hub.signal('interview-1');

    await expect(tabOne.wait(50)).resolves.toBe('signaled');
    await expect(tabTwo.wait(50)).resolves.toBe('signaled');
    await expect(otherInterview.wait(10)).resolves.toBe('timeout');
    expect(hub.subscriberCount).toBe(3);
  });

  it('coalesces wake-ups to constant memory without losing the next database poll', async () => {
    const hub = new InMemoryRealtimeSignalHub();
    const subscription = hub.subscribe('interview-1');
    expect(subscription).not.toBeNull();
    if (subscription === null) return;

    for (let index = 0; index < 10_000; index += 1) hub.signal('interview-1');

    await expect(subscription.wait(50)).resolves.toBe('signaled');
    await expect(subscription.wait(10)).resolves.toBe('timeout');
  });

  it('enforces the per-interview limit without consuming capacity for another interview', () => {
    const hub = new InMemoryRealtimeSignalHub({
      maximumSubscribers: 3,
      maximumSubscribersPerInterview: 2,
    });
    const first = hub.subscribe('interview-1');
    const second = hub.subscribe('interview-1');

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(hub.subscribe('interview-1')).toBeNull();
    expect(hub.subscribe('interview-2')).not.toBeNull();
    expect(hub.subscriberCount).toBe(3);
  });

  it('enforces the global limit across interviews', () => {
    const hub = new InMemoryRealtimeSignalHub({
      maximumSubscribers: 2,
      maximumSubscribersPerInterview: 2,
    });

    expect(hub.subscribe('interview-1')).not.toBeNull();
    expect(hub.subscribe('interview-2')).not.toBeNull();
    expect(hub.subscribe('interview-3')).toBeNull();
    expect(hub.subscriberCount).toBe(2);
  });

  it('releases capacity exactly once when a subscription closes', () => {
    const hub = new InMemoryRealtimeSignalHub({
      maximumSubscribers: 1,
      maximumSubscribersPerInterview: 1,
    });
    const first = hub.subscribe('interview-1');
    expect(first).not.toBeNull();
    if (first === null) return;

    expect(hub.subscribe('interview-2')).toBeNull();
    first.close();
    first.close();

    expect(hub.subscriberCount).toBe(0);
    expect(hub.subscribe('interview-2')).not.toBeNull();
    expect(hub.subscriberCount).toBe(1);
  });

  it.each([
    [{ maximumSubscribers: 0 }, 'maximumSubscribers'],
    [{ maximumSubscribers: 1.5 }, 'maximumSubscribers'],
    [{ maximumSubscribersPerInterview: 0 }, 'maximumSubscribersPerInterview'],
    [
      { maximumSubscribers: 1, maximumSubscribersPerInterview: 2 },
      'maximumSubscribersPerInterview',
    ],
  ] as const)('rejects invalid capacity options %j', (options, expectedOption) => {
    expect(() => new InMemoryRealtimeSignalHub(options)).toThrow(expectedOption);
  });

  it('unblocks active waits and removes subscriptions on tab disconnect or shutdown', async () => {
    const hub = new InMemoryRealtimeSignalHub();
    const disconnected = hub.subscribe('interview-1');
    const shutdown = hub.subscribe('interview-1');
    expect(disconnected).not.toBeNull();
    expect(shutdown).not.toBeNull();
    if (disconnected === null || shutdown === null) return;

    const disconnectedWait = disconnected.wait(1_000);
    disconnected.close();
    await expect(disconnectedWait).resolves.toBe('closed');
    expect(disconnected.getCloseReason()).toBe('client_closed');
    expect(hub.subscriberCount).toBe(1);

    const shutdownWait = shutdown.wait(1_000);
    hub.close();
    await expect(shutdownWait).resolves.toBe('closed');
    expect(shutdown.getCloseReason()).toBe('server_shutdown');
    expect(hub.subscriberCount).toBe(0);
    expect(hub.subscribe('interview-1')).toBeNull();
    hub.close();
    expect(hub.subscriberCount).toBe(0);
  });
});
