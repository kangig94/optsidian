export type DaemonMetricsSnapshot = {
  requests: number;
  failures: number;
  activeRequests: number;
  startedAt: string;
};

export class DaemonMetrics {
  private requests = 0;
  private failures = 0;
  private activeRequests = 0;
  readonly startedAt = new Date().toISOString();

  beginRequest(): void {
    this.requests += 1;
    this.activeRequests += 1;
  }

  finishRequest(failed: boolean): void {
    if (failed) this.failures += 1;
    this.activeRequests = Math.max(0, this.activeRequests - 1);
  }

  snapshot(): DaemonMetricsSnapshot {
    return {
      requests: this.requests,
      failures: this.failures,
      activeRequests: this.activeRequests,
      startedAt: this.startedAt
    };
  }
}
