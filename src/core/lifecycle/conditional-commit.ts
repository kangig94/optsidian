import { processTokenEquals, type ProcessToken } from "./process-token.js";

export type MaybePromise<T> = T | Promise<T>;

export type CurrentWriterToken = {
  epoch: number;
  incarnationId: string;
  claimId: string;
  processToken: ProcessToken;
};

export type TenancyFenceProvider<TToken extends CurrentWriterToken = CurrentWriterToken> = {
  currentWriterToken(): MaybePromise<TToken | undefined>;
};

export type ConditionalCommitResult<TResult> =
  | { ok: true; value: TResult }
  | { ok: false; reason: "not-current" | "not-head" | "rejected"; message?: string };

export type ConditionalCommit<TCandidate, TExpected, TResult, TToken extends CurrentWriterToken = CurrentWriterToken> = {
  commit(candidate: TCandidate, expected: TExpected, writerToken: TToken): Promise<ConditionalCommitResult<TResult>>;
};

export type AttemptOwner<T> = {
  current: Attempt<T> | undefined | null;
};

export type AttemptProducer<T> = (signal: AbortSignal) => MaybePromise<T>;

export type AttemptOptions<T> = {
  install?: (value: T) => MaybePromise<void>;
  close?: (value: T) => MaybePromise<void>;
};

export type AttemptWaiter<T> = {
  readonly promise: Promise<T>;
  leave(): boolean;
};

type Waiter<T> = {
  active: boolean;
  resolve(value: T): void;
  reject(error: unknown): void;
  cleanup(): void;
};

export class AttemptCancelledError extends Error {
  constructor(message = "Attempt was cancelled.") {
    super(message);
    this.name = "AttemptCancelledError";
  }
}

export class AttemptSupersededError extends Error {
  constructor(message = "Attempt was superseded before commit.") {
    super(message);
    this.name = "AttemptSupersededError";
  }
}

export class Attempt<T> {
  readonly owner: AttemptOwner<T>;

  private readonly producer: AttemptProducer<T>;
  private readonly install: (value: T) => MaybePromise<void>;
  private readonly closeProducedValue: (value: T) => MaybePromise<void>;
  private readonly abortController = new AbortController();
  private readonly waiters = new Map<number, Waiter<T>>();
  private readonly resultPromise: Promise<T>;

  private nextWaiterId = 1;
  private settled = false;
  private installed = false;

  constructor(owner: AttemptOwner<T>, producer: AttemptProducer<T>, options: AttemptOptions<T> = {}) {
    this.owner = owner;
    this.producer = producer;
    this.install = options.install ?? (() => undefined);
    this.closeProducedValue = options.close ?? (() => undefined);
    this.resultPromise = this.run();
    this.resultPromise.catch(() => undefined);
  }

  static start<T>(owner: AttemptOwner<T>, producer: AttemptProducer<T>, options: AttemptOptions<T> = {}): Attempt<T> {
    const attempt = new Attempt(owner, producer, options);
    owner.current = attempt;
    return attempt;
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  get waiterCount(): number {
    return this.waiters.size;
  }

  get aborted(): boolean {
    return this.abortController.signal.aborted;
  }

  get isInstalled(): boolean {
    return this.installed;
  }

  get result(): Promise<T> {
    return this.resultPromise;
  }

  join(options: { signal?: AbortSignal } = {}): AttemptWaiter<T> {
    const waiterId = this.nextWaiterId;
    this.nextWaiterId += 1;

    let abortListener: (() => void) | undefined;
    const promise = new Promise<T>((resolve, reject) => {
      const waiter: Waiter<T> = {
        active: true,
        resolve,
        reject,
        cleanup() {
          if (abortListener) options.signal?.removeEventListener("abort", abortListener);
          abortListener = undefined;
        }
      };
      this.waiters.set(waiterId, waiter);

      abortListener = () => {
        this.leaveWaiter(waiterId, abortReason(options.signal) ?? new AttemptCancelledError("Attempt waiter was cancelled."));
      };
      if (options.signal?.aborted) {
        abortListener();
        return;
      }
      options.signal?.addEventListener("abort", abortListener, { once: true });

      this.resultPromise.then(
        (value) => {
          if (!waiter.active) return;
          waiter.active = false;
          waiter.cleanup();
          this.waiters.delete(waiterId);
          resolve(value);
        },
        (error) => {
          if (!waiter.active) return;
          waiter.active = false;
          waiter.cleanup();
          this.waiters.delete(waiterId);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      );
    });

    return {
      promise,
      leave: () => this.leaveWaiter(waiterId, new AttemptCancelledError("Attempt waiter left before completion."))
    };
  }

  wait(options: { signal?: AbortSignal } = {}): Promise<T> {
    return this.join(options).promise;
  }

  private async run(): Promise<T> {
    try {
      const value = await this.producer(this.abortController.signal);
      const installedValue = await this.installIfCurrent(value);
      this.settled = true;
      this.resolveWaiters(installedValue);
      return installedValue;
    } catch (error) {
      this.settled = true;
      this.rejectWaiters(error);
      throw error;
    }
  }

  private async installIfCurrent(value: T): Promise<T> {
    if (this.abortController.signal.aborted) {
      await this.closeProducedValue(value);
      throw new AttemptCancelledError("Attempt produced a value after cancellation.");
    }
    if (this.owner.current !== this) {
      await this.closeProducedValue(value);
      throw new AttemptSupersededError();
    }
    try {
      await this.install(value);
      this.installed = true;
      return value;
    } catch (error) {
      await this.closeProducedValue(value);
      throw error;
    }
  }

  private leaveWaiter(waiterId: number, reason: unknown): boolean {
    const waiter = this.waiters.get(waiterId);
    if (!waiter || !waiter.active) return false;
    waiter.active = false;
    waiter.cleanup();
    this.waiters.delete(waiterId);
    waiter.reject(reason);
    if (this.waiters.size === 0 && !this.settled && !this.abortController.signal.aborted) {
      this.abortController.abort(reason);
    }
    return true;
  }

  private resolveWaiters(value: T): void {
    for (const [waiterId, waiter] of this.waiters) {
      if (!waiter.active) continue;
      waiter.active = false;
      waiter.cleanup();
      waiter.resolve(value);
      this.waiters.delete(waiterId);
    }
  }

  private rejectWaiters(error: unknown): void {
    for (const [waiterId, waiter] of this.waiters) {
      if (!waiter.active) continue;
      waiter.active = false;
      waiter.cleanup();
      waiter.reject(error);
      this.waiters.delete(waiterId);
    }
  }
}

export async function isCurrentWriterToken<TToken extends CurrentWriterToken>(
  provider: TenancyFenceProvider<TToken>,
  expected: TToken
): Promise<boolean> {
  const current = await provider.currentWriterToken();
  return current !== undefined && currentWriterTokensEqual(current, expected);
}

export function currentWriterTokensEqual(left: CurrentWriterToken, right: CurrentWriterToken): boolean {
  return (
    left.epoch === right.epoch &&
    left.incarnationId === right.incarnationId &&
    left.claimId === right.claimId &&
    processTokenEquals(left.processToken, right.processToken)
  );
}

function abortReason(signal: AbortSignal | undefined): unknown {
  return signal && "reason" in signal ? signal.reason : undefined;
}
