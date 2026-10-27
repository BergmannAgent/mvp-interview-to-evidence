export type MonitoringSignalWaitResult = 'signaled' | 'timeout' | 'closed';
export type MonitoringSignalCloseReason = 'client_closed' | 'server_shutdown';

export interface MonitoringSignalSubscription {
  wait(timeoutMs: number): Promise<MonitoringSignalWaitResult>;
  getCloseReason(): MonitoringSignalCloseReason | null;
  close(reason?: MonitoringSignalCloseReason): void;
}

export interface MonitoringSignalHub {
  subscribe(interviewId: string): MonitoringSignalSubscription | null;
}
