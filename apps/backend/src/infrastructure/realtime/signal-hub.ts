import type {
  MonitoringSignalHub,
  MonitoringSignalCloseReason,
  MonitoringSignalSubscription,
  MonitoringSignalWaitResult,
} from '../../application/index.js';

export interface RealtimeSignalPublisher {
  signal(interviewId: string): void;
}

export interface ClosableRealtimeSignalHub extends MonitoringSignalHub, RealtimeSignalPublisher {
  readonly subscriberCount: number;
  close(): void;
}

export interface RealtimeSignalHubOptions {
  readonly maximumSubscribers: number;
  readonly maximumSubscribersPerInterview: number;
}

const defaultOptions: RealtimeSignalHubOptions = {
  maximumSubscribers: 200,
  maximumSubscribersPerInterview: 20,
};

export class InMemoryRealtimeSignalHub implements ClosableRealtimeSignalHub {
  readonly #subscriptions = new Map<string, Set<SignalSubscription>>();
  readonly #options: RealtimeSignalHubOptions;
  #closed = false;

  public constructor(options: Partial<RealtimeSignalHubOptions> = {}) {
    this.#options = validateOptions({ ...defaultOptions, ...options });
  }

  public get subscriberCount(): number {
    let count = 0;
    for (const subscriptions of this.#subscriptions.values()) count += subscriptions.size;
    return count;
  }

  public subscribe(interviewId: string): MonitoringSignalSubscription | null {
    if (this.#closed) return null;
    if (this.subscriberCount >= this.#options.maximumSubscribers) return null;

    const subscriptions = this.#subscriptions.get(interviewId) ?? new Set<SignalSubscription>();
    if (subscriptions.size >= this.#options.maximumSubscribersPerInterview) return null;

    const subscription = new SignalSubscription(() => {
      const activeSubscriptions = this.#subscriptions.get(interviewId);
      activeSubscriptions?.delete(subscription);
      if (activeSubscriptions?.size === 0) this.#subscriptions.delete(interviewId);
    });
    subscriptions.add(subscription);
    this.#subscriptions.set(interviewId, subscriptions);
    return subscription;
  }

  public signal(interviewId: string): void {
    if (this.#closed) return;
    for (const subscription of this.#subscriptions.get(interviewId) ?? []) {
      subscription.signal();
    }
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const subscriptions = [...this.#subscriptions.values()].flatMap((entries) => [...entries]);
    for (const subscription of subscriptions) {
      subscription.close('server_shutdown');
    }
    this.#subscriptions.clear();
  }
}

function validateOptions(options: RealtimeSignalHubOptions): RealtimeSignalHubOptions {
  validatePositiveSafeInteger(options.maximumSubscribers, 'maximumSubscribers');
  validatePositiveSafeInteger(
    options.maximumSubscribersPerInterview,
    'maximumSubscribersPerInterview',
  );
  if (options.maximumSubscribersPerInterview > options.maximumSubscribers) {
    throw new TypeError('maximumSubscribersPerInterview must not exceed maximumSubscribers');
  }
  return options;
}

function validatePositiveSafeInteger(value: number, optionName: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${optionName} must be a positive safe integer`);
  }
}

class SignalSubscription implements MonitoringSignalSubscription {
  readonly #onClose: () => void;
  #closeReason: MonitoringSignalCloseReason | null = null;
  #pendingSignal = false;
  #waiter:
    | {
        readonly resolve: (result: MonitoringSignalWaitResult) => void;
        readonly timeout: ReturnType<typeof setTimeout>;
      }
    | undefined;

  public constructor(onClose: () => void) {
    this.#onClose = onClose;
  }

  public wait(timeoutMs: number): Promise<MonitoringSignalWaitResult> {
    if (this.#closeReason !== null) return Promise.resolve('closed');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      return Promise.reject(new TypeError('Signal wait timeout must be a positive safe integer'));
    }
    if (this.#pendingSignal) {
      this.#pendingSignal = false;
      return Promise.resolve('signaled');
    }
    if (this.#waiter !== undefined) {
      return Promise.reject(new Error('Only one signal wait may be active per subscription'));
    }

    return new Promise((resolvePromise) => {
      const timeout = setTimeout(() => {
        this.#waiter = undefined;
        resolvePromise('timeout');
      }, timeoutMs);
      this.#waiter = { resolve: resolvePromise, timeout };
    });
  }

  public signal(): void {
    if (this.#closeReason !== null || this.#pendingSignal) return;
    const waiter = this.#waiter;
    if (waiter === undefined) {
      this.#pendingSignal = true;
      return;
    }
    this.#waiter = undefined;
    clearTimeout(waiter.timeout);
    waiter.resolve('signaled');
  }

  public getCloseReason(): MonitoringSignalCloseReason | null {
    return this.#closeReason;
  }

  public close(reason: MonitoringSignalCloseReason = 'client_closed'): void {
    if (this.#closeReason !== null) return;
    this.#closeReason = reason;
    const waiter = this.#waiter;
    this.#waiter = undefined;
    if (waiter !== undefined) {
      clearTimeout(waiter.timeout);
      waiter.resolve('closed');
    }
    this.#onClose();
  }
}
