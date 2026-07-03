type MaybePromise<T> = T | Promise<T>;

type LevelReconcilerBatch<TIntent> = {
  dirty: boolean;
  intents: readonly TIntent[];
  signal: AbortSignal;
};

export type LevelReconcilerOptions<TWorld, TFolded, TActionResult, TIntent> = {
  enumerate(signal: AbortSignal): MaybePromise<TWorld>;
  fold(world: TWorld, batch: LevelReconcilerBatch<TIntent>): MaybePromise<TFolded>;
  act(folded: TFolded, batch: LevelReconcilerBatch<TIntent>): MaybePromise<TActionResult>;
  ack?(result: TActionResult, batch: LevelReconcilerBatch<TIntent>): MaybePromise<void>;
  onError?(error: unknown): MaybePromise<void>;
};

export type StopOptions = {
  drain?: boolean;
};

type Deferred = {
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
};

export class LevelReconciler<TWorld, TFolded, TActionResult = void, TIntent = void> {
  private readonly options: LevelReconcilerOptions<TWorld, TFolded, TActionResult, TIntent>;
  private readonly abortController = new AbortController();
  private readonly intents: TIntent[] = [];
  private readonly drainWaiters: Deferred[] = [];

  private dirty = false;
  private running = false;
  private started = false;
  private stopping = false;
  private drainOnStop = true;
  private stopped = false;
  private wakeWaiter: (() => void) | undefined;
  private loopPromise: Promise<void> | undefined;

  constructor(options: LevelReconcilerOptions<TWorld, TFolded, TActionResult, TIntent>) {
    this.options = options;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.loopPromise = this.runLoop();
  }

  markDirty(): void {
    if (this.stopping || this.stopped) return;
    this.dirty = true;
    this.wake();
  }

  enqueueIntent(intent: TIntent): void {
    if (this.stopping || this.stopped) return;
    this.intents.push(intent);
    this.wake();
  }

  async drain(): Promise<void> {
    if (this.isIdle()) return;
    const deferred = createDeferred();
    this.drainWaiters.push(deferred);
    await deferred.promise;
  }

  async stop(options: StopOptions = {}): Promise<void> {
    if (this.stopped) return;
    this.stopping = true;
    this.drainOnStop = options.drain ?? true;
    if (!this.drainOnStop) {
      this.dirty = false;
      this.intents.length = 0;
      this.abortController.abort(new Error('LevelReconciler stopped without drain.'));
    }
    this.wake();
    if (!this.started) {
      this.stopped = true;
      this.resolveDrainWaiters();
      return;
    }
    await this.loopPromise;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get pendingIntentCount(): number {
    return this.intents.length;
  }

  private async runLoop(): Promise<void> {
    try {
      while (true) {
        await this.waitForWork();
        if (this.stopping && (!this.drainOnStop || !this.hasWork())) break;
        if (!this.hasWork()) continue;

        const batch: LevelReconcilerBatch<TIntent> = {
          dirty: this.dirty,
          intents: this.intents.splice(0),
          signal: this.abortController.signal,
        };
        this.dirty = false;
        this.running = true;
        try {
          const world = await this.options.enumerate(this.abortController.signal);
          const folded = await this.options.fold(world, batch);
          const result = await this.options.act(folded, batch);
          await this.options.ack?.(result, batch);
        } catch (error) {
          if (this.options.onError) await this.options.onError(error);
          else throw error;
        } finally {
          this.running = false;
          this.resolveDrainWaitersIfIdle();
        }
      }
    } finally {
      this.stopped = true;
      this.resolveDrainWaiters();
    }
  }

  private async waitForWork(): Promise<void> {
    if (this.hasWork() || this.stopping) return;
    await new Promise<void>((resolve) => {
      this.wakeWaiter = resolve;
    });
    this.wakeWaiter = undefined;
  }

  private wake(): void {
    const resolve = this.wakeWaiter;
    if (!resolve) return;
    this.wakeWaiter = undefined;
    resolve();
  }

  private hasWork(): boolean {
    return this.dirty || this.intents.length > 0;
  }

  private isIdle(): boolean {
    return !this.running && !this.hasWork();
  }

  private resolveDrainWaitersIfIdle(): void {
    if (!this.isIdle()) return;
    this.resolveDrainWaiters();
  }

  private resolveDrainWaiters(): void {
    const waiters = this.drainWaiters.splice(0);
    for (const waiter of waiters) waiter.resolve();
  }
}

function createDeferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
