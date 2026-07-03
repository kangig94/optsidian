import { rpcError, type SearchDaemonRpcError } from './protocol.js';

export type SchedulerSearchRequest = {
  query: string;
  deadlineMs: number;
  cancellationId?: string;
  cancelBeforeRun?: boolean;
};

type SchedulerSearchSuccess = {
  ok: true;
  snapshotId: string;
  matches: Array<{ path: string; score?: number }>;
};

type SchedulerSearchFailure = {
  ok: false;
  snapshotId: string;
  error: SearchDaemonRpcError;
  partialResults?: never;
};

type SchedulerSearchResult = SchedulerSearchSuccess | SchedulerSearchFailure;

export type RequestScheduler = {
  cancel(cancellationId: string): void;
  run<T>(
    request: {
      deadline: number;
      cancellationId?: string;
      snapshotId?: string;
    },
    task: () => Promise<T>,
  ): Promise<T>;
  applyBackpressure(input: {
    backgroundQueueDepth: number;
    queues?: Array<{ name: string; kind: 'query' | 'throughput'; depth: number }>;
  }): { shedQueues: string[]; queryWorkShed: boolean; backgroundQueueDepth: number };
};

const MAX_CANCELLED_IDS = 4096;

export function createRequestScheduler(): RequestScheduler {
  const cancelled = new Set<string>();
  return {
    cancel(cancellationId) {
      rememberCancelled(cancelled, cancellationId);
    },
    async run(request, task) {
      assertRunnable(request.deadline, request.cancellationId, cancelled);
      const result = await task();
      assertRunnable(request.deadline, request.cancellationId, cancelled);
      return result;
    },
    applyBackpressure(input) {
      const queues = input.queues ?? [
        { name: 'throughput-rebuild', kind: 'throughput', depth: input.backgroundQueueDepth },
        { name: 'throughput-refresh', kind: 'throughput', depth: input.backgroundQueueDepth },
        { name: 'throughput-compact', kind: 'throughput', depth: input.backgroundQueueDepth },
      ];
      const priority = ['throughput-rebuild', 'throughput-refresh', 'throughput-compact'];
      return {
        shedQueues: queues
          .filter((queue) => queue.kind === 'throughput' && queue.depth > 0)
          .sort((left, right) => {
            const leftPriority = priority.indexOf(left.name);
            const rightPriority = priority.indexOf(right.name);
            return (
              (leftPriority === -1 ? priority.length : leftPriority) -
                (rightPriority === -1 ? priority.length : rightPriority) || compareCodePoint(left.name, right.name)
            );
          })
          .map((queue) => queue.name),
        queryWorkShed: false,
        backgroundQueueDepth: input.backgroundQueueDepth,
      };
    },
  };
}

function compareCodePoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function rememberCancelled(cancelled: Set<string>, cancellationId: string): void {
  cancelled.delete(cancellationId);
  cancelled.add(cancellationId);
  while (cancelled.size > MAX_CANCELLED_IDS) {
    const oldest = cancelled.values().next();
    if (oldest.done) break;
    cancelled.delete(oldest.value);
  }
}

export function createDeterministicSearchSchedulerForTests(options: {
  activeSnapshotId: string;
  nextSnapshotId: string;
  queryResults: Array<{ path: string; score?: number }>;
  backgroundQueueDepth: number;
}): {
  search(request: SchedulerSearchRequest): Promise<SchedulerSearchResult>;
  publishNextSnapshot(): Promise<void>;
  applyBackpressure(): Promise<{ shedQueues: string[]; queryWorkShed: boolean; backgroundQueueDepth: number }>;
} {
  let activeSnapshotId = options.activeSnapshotId;
  let pinnedSnapshotId: string | undefined;
  const cancelled = new Set<string>();

  return {
    async search(request) {
      const snapshotId = pinnedSnapshotId ?? activeSnapshotId;
      pinnedSnapshotId = snapshotId;
      if (request.cancelBeforeRun && request.cancellationId) cancelled.add(request.cancellationId);
      if (request.deadlineMs <= 0) {
        return {
          ok: false,
          snapshotId,
          error: rpcError('DEADLINE_EXCEEDED', 'search request deadline expired before execution'),
        };
      }
      if (request.cancellationId && cancelled.has(request.cancellationId)) {
        return {
          ok: false,
          snapshotId,
          error: rpcError('CANCELLED', 'search request was cancelled before execution'),
        };
      }
      return {
        ok: true,
        snapshotId,
        matches: [...options.queryResults],
      };
    },
    async publishNextSnapshot() {
      activeSnapshotId = options.nextSnapshotId;
    },
    async applyBackpressure() {
      return {
        shedQueues: ['throughput-rebuild', 'throughput-refresh', 'throughput-compact'],
        queryWorkShed: false,
        backgroundQueueDepth: options.backgroundQueueDepth,
      };
    },
  };
}

function assertRunnable(deadline: number, cancellationId: string | undefined, cancelled: Set<string>): void {
  if (Date.now() >= deadline) {
    throw Object.assign(new Error('request deadline expired before completion'), {
      code: 'DEADLINE_EXCEEDED',
    });
  }
  if (cancellationId && cancelled.has(cancellationId)) {
    throw Object.assign(new Error('request was cancelled'), {
      code: 'CANCELLED',
    });
  }
}
