import { remainingDeadlineMs } from "../protocol.js";
import type { WorkerPoolRunOptions } from "../worker-pool.js";
import { searchExecutionWarningLabels } from "../../core/search/internal-types.js";
import type {
  SearchExecutionResult,
  SearchShardExecutionJob,
  SearchShardExecutionResult
} from "../search-execution.js";
import { SearchQueryPlanner, type SearchPlan, type SearchQueryPlanInput, type ShardTaskPlan } from "./query-planner.js";
import { ResultAggregator } from "./result-aggregator.js";
import { ResultHydrator } from "./result-hydrator.js";
import { applySearchWarnings } from "./result-shaping.js";
import type { PersistedDocumentRecord } from "./types.js";

export type SearchQuerySchedulerInput = SearchQueryPlanInput & {
  requestId?: string;
  plan?: SearchPlan;
  documents?: ReadonlyMap<string, PersistedDocumentRecord>;
};

export type SearchQueryLeasePool = {
  idleReadySlotIds(): number[];
  leaseIdleSlot(): number | undefined;
  releaseIdleSlot(slotId: number): boolean;
  runOnSlot(job: SearchShardExecutionJob, options: WorkerPoolRunOptions, slotId: number): Promise<SearchShardExecutionResult>;
  cancel(cancellationId: string): void;
};

export type SearchQuerySchedulerOptions = {
  exhaustiveWorkCeiling?: number;
  env?: NodeJS.ProcessEnv;
  planner?: SearchQueryPlanner;
  testOrdering?: SearchQuerySchedulerTestOrdering;
};

export type SearchQueryShardTask = {
  units: readonly ShardTaskPlan[];
  job: SearchShardExecutionJob;
  workEstimate: number;
  mergeKey: string;
};

export type SearchQuerySchedulerTestOrdering = {
  orderPendingTasks?: (tasks: readonly ShardTaskPlan[]) => readonly ShardTaskPlan[];
};

const DEFAULT_EXHAUSTIVE_WORK_CEILING = 10_000_000;
const MAX_CANCELLED_IDS = 4096;

export class SearchQueryScheduler {
  private readonly activeSessions: SearchQuerySession[] = [];
  private readonly cancelled = new Set<string>();
  private readonly exhaustiveWorkCeiling: number;
  private readonly planner: SearchQueryPlanner;
  private readonly pool: SearchQueryLeasePool;
  private readonly testOrdering: SearchQuerySchedulerTestOrdering | undefined;
  private drainQueued = false;
  private nextSessionIndex = 0;

  constructor(pool: SearchQueryLeasePool, options: SearchQuerySchedulerOptions = {}) {
    this.pool = pool;
    this.planner = options.planner ?? new SearchQueryPlanner();
    this.testOrdering = options.testOrdering;
    this.exhaustiveWorkCeiling =
      options.exhaustiveWorkCeiling ??
      envPositiveInt(options.env ?? process.env, "OPTSIDIAN_SEARCH_EXHAUSTIVE_WORK_CEILING") ??
      DEFAULT_EXHAUSTIVE_WORK_CEILING;
  }

  execute(input: SearchQuerySchedulerInput): Promise<SearchExecutionResult> {
    try {
      return this.submit(input).result;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  submit(input: SearchQuerySchedulerInput): SearchQuerySession {
    assertRemainingDeadline(input.deadline, "before query planning");
    assertNotCancelled(input.cancellationId, this.cancelled);
    const plan = input.plan ?? this.planner.plan(input);
    assertNotCancelled(input.cancellationId, this.cancelled);
    const session = new SearchQuerySession({
      input,
      plan,
      pool: this.pool,
      exhaustiveWorkCeiling: this.exhaustiveWorkCeiling,
      testOrdering: this.testOrdering,
      onRunnable: () => this.requestDrain(),
      onTerminal: (terminalSession) => this.removeSession(terminalSession)
    });
    session.start();
    if (session.isActive) {
      this.activeSessions.push(session);
      this.requestDrain();
    }
    return session;
  }

  cancel(cancellationId: string): void {
    rememberCancelled(this.cancelled, cancellationId);
    const error = Object.assign(new Error("query session was cancelled"), { code: "CANCELLED" });
    for (const session of [...this.activeSessions]) {
      if (session.cancellationId === cancellationId) session.cancel(error);
    }
  }

  private requestDrain(): void {
    if (this.drainQueued) return;
    this.drainQueued = true;
    queueMicrotask(() => {
      this.drainQueued = false;
      this.drain();
    });
  }

  private drain(): void {
    this.expireElapsedSessions();
    if (this.activeSessions.length === 0) return;
    const idleReadyCount = this.pool.idleReadySlotIds().length;
    if (idleReadyCount <= 0) return;
    const leaseOrder = this.allocateLeaseOrder(idleReadyCount);
    if (leaseOrder.length === 0) return;

    const remainingBySession = new Map<SearchQuerySession, number>();
    for (const session of leaseOrder) {
      remainingBySession.set(session, (remainingBySession.get(session) ?? 0) + 1);
    }
    for (const session of leaseOrder) {
      const leasesRemaining = remainingBySession.get(session) ?? 0;
      if (leasesRemaining <= 0) continue;
      remainingBySession.set(session, leasesRemaining - 1);
      if (!this.scheduleOne(session, leasesRemaining)) break;
    }
  }

  private expireElapsedSessions(): void {
    for (const session of [...this.activeSessions]) session.expireIfDeadlineElapsed("before leasing");
  }

  private allocateLeaseOrder(idleReadyCount: number): SearchQuerySession[] {
    const schedulable = this.activeSessions.filter((session) => session.canSchedule);
    if (schedulable.length === 0) return [];

    const totalRunning = schedulable.reduce((sum, session) => sum + session.runningCount, 0);
    const fairTarget = Math.max(1, Math.floor((idleReadyCount + totalRunning) / schedulable.length));
    const allocated = new Map<SearchQuerySession, number>();
    const order: SearchQuerySession[] = [];
    let remaining = idleReadyCount;

    while (remaining > 0) {
      const session = this.selectNextSession((candidate) =>
        candidate.canSchedule &&
        candidate.runningCount + (allocated.get(candidate) ?? 0) < fairTarget &&
        candidate.pendingCount > (allocated.get(candidate) ?? 0)
      );
      if (!session) break;
      allocated.set(session, (allocated.get(session) ?? 0) + 1);
      order.push(session);
      remaining -= 1;
    }

    while (remaining > 0) {
      const session = this.selectNextSession((candidate) =>
        candidate.canSchedule &&
        candidate.pendingCount > (allocated.get(candidate) ?? 0)
      );
      if (!session) break;
      allocated.set(session, (allocated.get(session) ?? 0) + 1);
      order.push(session);
      remaining -= 1;
    }

    return order;
  }

  private selectNextSession(predicate: (session: SearchQuerySession) => boolean): SearchQuerySession | undefined {
    if (this.activeSessions.length === 0) return undefined;
    const start = this.nextSessionIndex % this.activeSessions.length;
    for (let offset = 0; offset < this.activeSessions.length; offset += 1) {
      const index = (start + offset) % this.activeSessions.length;
      const session = this.activeSessions[index];
      if (!predicate(session)) continue;
      this.nextSessionIndex = (index + 1) % this.activeSessions.length;
      return session;
    }
    return undefined;
  }

  private scheduleOne(session: SearchQuerySession, leasesRemainingForSession: number): boolean {
    if (!session.expireIfDeadlineElapsed("before leasing")) return true;
    if (!session.canSchedule) return true;
    const slotId = this.pool.leaseIdleSlot();
    if (slotId === undefined) return false;
    if (!session.expireIfDeadlineElapsed("after leasing") || !session.canSchedule) {
      this.pool.releaseIdleSlot(slotId);
      return true;
    }
    const task = session.takeShardTask(leasesRemainingForSession);
    if (!task) {
      this.pool.releaseIdleSlot(slotId);
      return true;
    }
    session.dispatch(slotId, task);
    return true;
  }

  private removeSession(session: SearchQuerySession): void {
    const index = this.activeSessions.indexOf(session);
    if (index < 0) return;
    this.activeSessions.splice(index, 1);
    if (this.activeSessions.length === 0) {
      this.nextSessionIndex = 0;
    } else if (this.nextSessionIndex > index) {
      this.nextSessionIndex -= 1;
    } else {
      this.nextSessionIndex %= this.activeSessions.length;
    }
    this.requestDrain();
  }
}

export class SearchQuerySession {
  private readonly exhaustiveWorkCeiling: number;
  private readonly input: SearchQuerySchedulerInput;
  private readonly onRunnable: () => void;
  private readonly onTerminal: (session: SearchQuerySession) => void;
  private readonly pending: ShardTaskPlan[];
  private readonly plan: SearchPlan;
  private readonly pool: SearchQueryLeasePool;
  private readonly warnings: string[];
  private readonly aggregator: ResultAggregator;
  private readonly hydrator = new ResultHydrator();
  private readonly resultDeferred = deferred<SearchExecutionResult>();
  private readonly inFlight = new Map<number, SearchQueryShardTask>();
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  private timeBudgetTimer: ReturnType<typeof setTimeout> | undefined;
  private schedulingStopped = false;
  private state: "pending" | "active" | "fulfilled" | "rejected" = "pending";

  constructor(args: {
    input: SearchQuerySchedulerInput;
    plan: SearchPlan;
    pool: SearchQueryLeasePool;
    exhaustiveWorkCeiling: number;
    testOrdering?: SearchQuerySchedulerTestOrdering;
    onRunnable: () => void;
    onTerminal: (session: SearchQuerySession) => void;
  }) {
    this.input = args.input;
    this.plan = args.plan;
    this.pool = args.pool;
    this.exhaustiveWorkCeiling = args.exhaustiveWorkCeiling;
    this.onRunnable = args.onRunnable;
    this.onTerminal = args.onTerminal;
    this.pending = orderedPendingTasks(
      budgetedTaskPrefix(args.plan.tasks, args.input.search),
      args.testOrdering?.orderPendingTasks
    );
    this.warnings = searchExecutionWarningLabels(args.input.search);
    this.aggregator = new ResultAggregator({
      exactBound: args.plan.exactBound,
      analysis: args.input.analysis
    });
  }

  get result(): Promise<SearchExecutionResult> {
    return this.resultDeferred.promise;
  }

  get isActive(): boolean {
    return this.state === "active";
  }

  get canSchedule(): boolean {
    return (
      this.state === "active" &&
      !this.schedulingStopped &&
      this.pending.length > 0 &&
      remainingDeadlineMs(this.input.deadline) > 0
    );
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  get runningCount(): number {
    return this.inFlight.size;
  }

  get cancellationId(): string {
    return this.input.cancellationId;
  }

  start(): void {
    if (this.state !== "pending") return;
    if (!this.expireIfDeadlineElapsed("before query scheduling")) return;
    const ceilingEstimate = this.workCeilingEstimate();
    if (ceilingEstimate > this.exhaustiveWorkCeiling) {
      this.reject(workCeilingError(ceilingEstimate, this.exhaustiveWorkCeiling), false);
      return;
    }
    if (this.pending.length === 0) {
      this.fulfill(this.hydrate());
      return;
    }
    this.state = "active";
    this.armDeadlineTimer();
    this.armTimeBudgetTimer();
  }

  cancel(error: Error = Object.assign(new Error("query session was cancelled"), { code: "CANCELLED" })): void {
    this.reject(error, true);
  }

  expireIfDeadlineElapsed(label: string): boolean {
    if (remainingDeadlineMs(this.input.deadline) > 0) return true;
    this.reject(deadlineError(label), true);
    return false;
  }

  takeShardTask(leasesRemainingForSession: number): SearchQueryShardTask | undefined {
    if (!this.canSchedule) return undefined;
    const batchSize = this.shardBatchSize(leasesRemainingForSession);
    const units = this.pending.splice(0, batchSize);
    if (units.length === 0) return undefined;
    return shardTaskFromUnits(units, this.plan.exactBound);
  }

  dispatch(slotId: number, task: SearchQueryShardTask): void {
    if (this.state !== "active") {
      this.pool.releaseIdleSlot(slotId);
      return;
    }
    this.inFlight.set(slotId, task);
    let promise: Promise<SearchShardExecutionResult>;
    try {
      promise = this.pool.runOnSlot(task.job, this.workerOptions, slotId);
    } catch (error) {
      this.inFlight.delete(slotId);
      this.pool.releaseIdleSlot(slotId);
      this.reject(error instanceof Error ? error : new Error(String(error)), true);
      return;
    }
    promise.then(
      (result) => this.completeShard(slotId, result),
      (error: unknown) => {
        this.inFlight.delete(slotId);
        this.pool.releaseIdleSlot(slotId);
        this.reject(error instanceof Error ? error : new Error(String(error)), true);
      }
    ).finally(() => this.onRunnable());
  }

  private get workerOptions(): WorkerPoolRunOptions {
    return {
      deadline: this.input.deadline,
      cancellationId: this.input.cancellationId,
      requestId: this.input.requestId ?? this.input.cancellationId,
      vault: this.input.vault
    };
  }

  private completeShard(slotId: number, result: SearchShardExecutionResult): void {
    this.inFlight.delete(slotId);
    if (this.state !== "active") return;
    if (result.snapshotId !== this.input.snapshot.snapshotId) {
      this.reject(
        Object.assign(new Error(`shard returned snapshot ${result.snapshotId}, expected ${this.input.snapshot.snapshotId}`), { code: "INTERNAL" }),
        true
      );
      return;
    }
    this.aggregator.ingest(result);
    if (this.pending.length === 0 && this.inFlight.size === 0) this.fulfill(this.hydrate());
  }

  private hydrate(): SearchExecutionResult {
    const result = this.hydrator.hydrate({
      search: this.input.search,
      snapshot: this.input.snapshot,
      analyzerIdentity: this.input.analyzerIdentity,
      explain: this.input.explain,
      documents: this.input.documents,
      aggregation: this.aggregator.finalize()
    });
    return applySearchWarnings(result, this.warnings);
  }

  private workCeilingEstimate(): number {
    const budget = this.input.search.budget;
    if (this.input.search.mode === "approximate" && (budget?.work !== undefined || budget?.shards !== undefined)) {
      return this.pending.reduce((sum, task) => sum + task.workEstimate, 0);
    }
    return this.plan.estimatedWork;
  }

  private shardBatchSize(leasesRemainingForSession: number): number {
    if (this.input.search.mode === "approximate" && this.input.search.budget?.timeMs !== undefined) return 1;
    return Math.max(1, Math.ceil(this.pending.length / Math.max(1, leasesRemainingForSession)));
  }

  private armDeadlineTimer(): void {
    const remaining = remainingDeadlineMs(this.input.deadline);
    if (remaining <= 0) {
      this.reject(deadlineError("before query scheduling"), true);
      return;
    }
    this.deadlineTimer = setTimeout(() => {
      this.reject(deadlineError("during query execution"), true);
    }, remaining);
    this.deadlineTimer.unref();
  }

  private armTimeBudgetTimer(): void {
    const timeMs = this.input.search.mode === "approximate" ? this.input.search.budget?.timeMs : undefined;
    if (timeMs === undefined) return;
    this.timeBudgetTimer = setTimeout(() => {
      if (this.state !== "active") return;
      this.schedulingStopped = true;
      this.pending.length = 0;
      if (this.inFlight.size === 0) this.fulfill(this.hydrate());
    }, timeMs);
    this.timeBudgetTimer.unref();
  }

  private clearTimers(): void {
    if (this.deadlineTimer) {
      clearTimeout(this.deadlineTimer);
      this.deadlineTimer = undefined;
    }
    if (this.timeBudgetTimer) {
      clearTimeout(this.timeBudgetTimer);
      this.timeBudgetTimer = undefined;
    }
  }

  private fulfill(result: SearchExecutionResult): void {
    if (this.state === "fulfilled" || this.state === "rejected") return;
    this.state = "fulfilled";
    this.clearTimers();
    this.resultDeferred.resolve(result);
    this.onTerminal(this);
  }

  private reject(error: Error, cancelLiveWork: boolean): void {
    if (this.state === "fulfilled" || this.state === "rejected") return;
    this.state = "rejected";
    this.schedulingStopped = true;
    this.pending.length = 0;
    this.clearTimers();
    if (cancelLiveWork && this.inFlight.size > 0) this.pool.cancel(this.input.cancellationId);
    this.resultDeferred.reject(error);
    this.onTerminal(this);
  }
}

function budgetedTaskPrefix(tasks: readonly ShardTaskPlan[], search: SearchQuerySchedulerInput["search"]): ShardTaskPlan[] {
  if (search.mode !== "approximate") return [...tasks];
  const budget = search.budget;
  if (!budget) return [...tasks];

  let prefix = budget.shards === undefined ? [...tasks] : [...tasks.slice(0, budget.shards)];
  if (budget.work !== undefined) {
    let usedWork = 0;
    let count = 0;
    for (const task of prefix) {
      if (usedWork + task.workEstimate > budget.work) break;
      usedWork += task.workEstimate;
      count += 1;
    }
    prefix = prefix.slice(0, count);
  }
  return prefix;
}

function orderedPendingTasks(
  tasks: readonly ShardTaskPlan[],
  orderPendingTasks: SearchQuerySchedulerTestOrdering["orderPendingTasks"] | undefined
): ShardTaskPlan[] {
  if (!orderPendingTasks) return [...tasks];
  const ordered = [...orderPendingTasks(tasks)];
  const expected = new Set(tasks);
  const actual = new Set(ordered);
  if (ordered.length !== tasks.length || actual.size !== expected.size || ordered.some((task) => !expected.has(task))) {
    throw Object.assign(new Error("scheduler test ordering must preserve the pending shard task set"), { code: "INTERNAL" });
  }
  return ordered;
}

function shardTaskFromUnits(units: readonly ShardTaskPlan[], exactBound: SearchPlan["exactBound"]): SearchQueryShardTask {
  const first = units[0];
  if (!first) throw Object.assign(new Error("cannot build a shard task from an empty unit batch"), { code: "INTERNAL" });
  if (!exactBound) throw Object.assign(new Error("search shard task requires exact-bound evidence"), { code: "INTERNAL" });
  const workEstimate = units.reduce((sum, unit) => sum + unit.workEstimate, 0);
  const job: SearchShardExecutionJob = {
    vault: first.vault,
    search: first.search,
    pathFilter: first.pathFilter,
    analysis: first.analysis,
    analyzerIdentity: first.analyzerIdentity,
    snapshot: {
      snapshotId: first.snapshot.snapshotId,
      pinToken: first.snapshot.pinToken,
      bm25Stats: first.snapshot.bm25Stats,
      documents: first.snapshot.documents,
      segments: units.flatMap((unit) => unit.snapshot.segments)
    },
    channels: first.channels,
    exactBound,
    requestedLimit: first.requestedLimit,
    workEstimate,
    deadline: first.deadline,
    cancellationId: first.cancellationId,
    explain: first.explain
  };
  return {
    units,
    job,
    workEstimate,
    mergeKey: units.map((unit) => unit.mergeKey).join("\u0000")
  };
}

function assertRemainingDeadline(deadline: number, label: string): void {
  if (remainingDeadlineMs(deadline) <= 0) throw deadlineError(label);
}

function assertNotCancelled(cancellationId: string, cancelled: ReadonlySet<string>): void {
  if (!cancelled.has(cancellationId)) return;
  throw Object.assign(new Error("query session was cancelled"), { code: "CANCELLED" });
}

function deadlineError(label: string): Error {
  return Object.assign(new Error(`request deadline expired ${label}`), { code: "DEADLINE_EXCEEDED" });
}

function workCeilingError(estimatedWork: number, ceiling: number): Error {
  return Object.assign(
    new Error(`query exhaustive work bound ${estimatedWork} exceeds ceiling ${ceiling}`),
    { code: "DEADLINE_EXCEEDED" }
  );
}

function envPositiveInt(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const raw = env[key]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  return Math.max(1, Number(raw));
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

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}
