import assert from "node:assert/strict";
import test from "node:test";

import { SEARCH_WARNING_BOUNDED, SEARCH_WARNING_NON_REPRODUCIBLE } from "../src/core/search/internal-types.ts";
import { normalizeSearchParams } from "../src/core/search/params.ts";
import { SearchQueryScheduler } from "../src/daemon/search-store/query-scheduler.ts";

const textEncoder = new TextEncoder();
const exactBound = { lexicalBound: 0, proximityBound: 0, lambdaExact: 0 };

class FakeLeasePool {
  constructor(slotIds, options = {}) {
    this.slots = new Map(slotIds.map((slotId) => [
      slotId,
      {
        busy: new Set(options.busySlotIds ?? []).has(slotId),
        leased: false
      }
    ]));
    this.throwOnRunSlotIds = new Set(options.throwOnRunSlotIds ?? []);
    this.active = new Map();
    this.leaseCalls = [];
    this.releaseCalls = [];
    this.runCalls = [];
    this.cancelCalls = [];
  }

  idleReadySlotIds() {
    return [...this.slots]
      .filter(([, slot]) => !slot.busy && !slot.leased)
      .map(([slotId]) => slotId);
  }

  leaseIdleSlot() {
    const slotId = this.idleReadySlotIds()[0];
    if (slotId === undefined) return undefined;
    this.slots.get(slotId).leased = true;
    this.leaseCalls.push(slotId);
    return slotId;
  }

  releaseIdleSlot(slotId) {
    this.releaseCalls.push(slotId);
    const slot = this.slots.get(slotId);
    if (!slot || !slot.leased || slot.busy) return false;
    slot.leased = false;
    return true;
  }

  runOnSlot(job, options, slotId) {
    const slot = this.slots.get(slotId);
    if (!slot) throw new Error(`unknown slot ${slotId}`);
    if (!slot.leased) throw new Error(`slot ${slotId} was not leased`);
    if (slot.busy) throw new Error(`slot ${slotId} is busy`);
    if (this.throwOnRunSlotIds.has(slotId)) throw new Error(`slot ${slotId} failed before dispatch`);
    slot.leased = false;
    slot.busy = true;
    this.runCalls.push({ slotId, job, options });
    return new Promise((resolve, reject) => {
      this.active.set(slotId, { slotId, job, options, resolve, reject });
    });
  }

  cancel(cancellationId) {
    this.cancelCalls.push(cancellationId);
    for (const run of [...this.active.values()]) {
      if (run.options.cancellationId === cancellationId) {
        this.rejectSlot(run.slotId, Object.assign(new Error("cancelled"), { code: "CANCELLED" }));
      }
    }
  }

  activeRuns() {
    return [...this.active.values()];
  }

  activeCountsByCancellationId() {
    const counts = new Map();
    for (const run of this.active.values()) {
      counts.set(run.options.cancellationId, (counts.get(run.options.cancellationId) ?? 0) + 1);
    }
    return Object.fromEntries(counts);
  }

  completeSlot(slotId, overrides = {}) {
    const run = this.active.get(slotId);
    if (!run) throw new Error(`slot ${slotId} is not active`);
    this.active.delete(slotId);
    this.slots.get(slotId).busy = false;
    run.resolve({
      snapshotId: run.job.snapshot.snapshotId,
      partitionIds: run.job.snapshot.segments.map((segment) => segment.partitionId).sort((left, right) => left - right),
      requestedLimit: run.job.requestedLimit,
      workEstimate: run.job.workEstimate,
      scoredCount: 0,
      finalists: [],
      ...overrides
    });
  }

  completeAll() {
    for (const slotId of [...this.active.keys()]) this.completeSlot(slotId);
  }

  rejectSlot(slotId, error) {
    const run = this.active.get(slotId);
    if (!run) throw new Error(`slot ${slotId} is not active`);
    this.active.delete(slotId);
    this.slots.get(slotId).busy = false;
    run.reject(error);
  }
}

function sharedHandle(bytes) {
  const buffer = new SharedArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return { buffer, byteOffset: 0, byteLength: bytes.byteLength };
}

function schedulerInput(label, taskCount, options = {}) {
  const search = normalizeSearchParams(options.search ?? { query: "needle", limit: 5 });
  const analysis = {
    raw: "needle",
    primaryChannel: "morph",
    primaryTerms: ["needle"],
    channels: { morph: ["needle"], surface: [], ngram: [] }
  };
  const analyzerIdentity = { name: "scheduler-test", version: "1", node: "test" };
  const deadline = options.deadline ?? Date.now() + 30_000;
  const snapshot = {
    snapshotId: `snapshot-${label}`,
    pinToken: `pin-${label}`,
    bm25Stats: { schemaId: "test", corpusStats: [], rows: [], hash: "scheduler-test" },
    documents: sharedHandle(textEncoder.encode("[]")),
    segments: []
  };
  const base = {
    vault: `/tmp/scheduler-${label}`,
    search,
    analysis,
    analyzerIdentity,
    snapshot,
    deadline,
    cancellationId: label,
    requestId: `request-${label}`,
    explain: options.explain === true
  };
  const tasks = Array.from({ length: taskCount }, (_, index) => {
    const partitionId = index + 1;
    return {
      vault: base.vault,
      search,
      analysis,
      analyzerIdentity,
      snapshot: {
        snapshotId: snapshot.snapshotId,
        pinToken: snapshot.pinToken,
        bm25Stats: snapshot.bm25Stats,
        documents: snapshot.documents,
        segments: [{
          segmentId: `segment-${label}-${partitionId}`,
          partitionId,
          bytes: sharedHandle(new Uint8Array())
        }]
      },
      channels: ["morph", "surface", "ngram"],
      requestedLimit: search.limit,
      workEstimate: 1,
      deadline,
      cancellationId: label,
      mergeKey: `segment-${label}-${partitionId}`
    };
  });
  return {
    ...base,
    plan: {
      snapshotId: snapshot.snapshotId,
      exactBound,
      tasks,
      requestedLimit: search.limit,
      estimatedWork: options.estimatedWork ?? tasks.length,
      mergeKey: `plan-${label}`
    }
  };
}

async function settleSchedulerTurn() {
  await Promise.resolve();
}

test("SearchQueryScheduler uses every idle-ready slot for one active query", async () => {
  const pool = new FakeLeasePool([1, 2, 3, 4]);
  const scheduler = new SearchQueryScheduler(pool, { exhaustiveWorkCeiling: 100 });
  const resultPromise = scheduler.execute(schedulerInput("single", 8));

  await settleSchedulerTurn();

  assert.equal(pool.activeRuns().length, 4);
  assert.deepEqual(pool.activeRuns().map((run) => run.slotId).sort((left, right) => left - right), [1, 2, 3, 4]);
  assert.deepEqual(pool.activeRuns().map((run) => run.job.workEstimate).sort((left, right) => left - right), [2, 2, 2, 2]);

  pool.completeAll();
  const result = await resultPromise;

  assert.equal(result.snapshotId, "snapshot-single");
  assert.deepEqual(result.matches, []);
  assert.deepEqual(pool.cancelCalls, []);
});

test("SearchQueryScheduler gives two active queries a fair first split", async () => {
  const pool = new FakeLeasePool([1, 2, 3, 4]);
  const scheduler = new SearchQueryScheduler(pool, { exhaustiveWorkCeiling: 100 });
  const first = scheduler.execute(schedulerInput("fair-a", 8));
  const second = scheduler.execute(schedulerInput("fair-b", 8));

  await settleSchedulerTurn();

  assert.equal(pool.activeRuns().length, 4);
  assert.deepEqual(pool.activeCountsByCancellationId(), { "fair-a": 2, "fair-b": 2 });

  pool.completeAll();
  await Promise.all([first, second]);
});

test("SearchQueryScheduler relaxes the fair split to consume otherwise idle slots", async () => {
  const pool = new FakeLeasePool([1, 2, 3, 4]);
  const scheduler = new SearchQueryScheduler(pool, { exhaustiveWorkCeiling: 100 });
  const narrow = scheduler.execute(schedulerInput("narrow", 1));
  const wide = scheduler.execute(schedulerInput("wide", 8));

  await settleSchedulerTurn();

  assert.equal(pool.activeRuns().length, 4);
  assert.deepEqual(pool.activeCountsByCancellationId(), { narrow: 1, wide: 3 });

  pool.completeAll();
  await Promise.all([narrow, wide]);
});

test("SearchQueryScheduler never schedules onto busy-ready slots", async () => {
  const pool = new FakeLeasePool([1, 2, 3, 4], { busySlotIds: [2, 4] });
  const scheduler = new SearchQueryScheduler(pool, { exhaustiveWorkCeiling: 100 });
  const resultPromise = scheduler.execute(schedulerInput("busy", 4));

  await settleSchedulerTurn();

  assert.deepEqual(pool.activeRuns().map((run) => run.slotId).sort((left, right) => left - right), [1, 3]);
  assert.deepEqual(pool.leaseCalls, [1, 3]);
  assert.equal(pool.runCalls.some((run) => run.slotId === 2 || run.slotId === 4), false);

  pool.completeAll();
  await resultPromise;
});

test("SearchQuerySession aborts exhaustive work over the ceiling before leasing", async () => {
  const pool = new FakeLeasePool([1, 2, 3]);
  const scheduler = new SearchQueryScheduler(pool, {
    env: { OPTSIDIAN_SEARCH_EXHAUSTIVE_WORK_CEILING: "2" }
  });

  await assert.rejects(
    scheduler.execute(schedulerInput("ceiling", 3, { estimatedWork: 3 })),
    (error) => {
      assert.equal(error.code, "DEADLINE_EXCEEDED");
      assert.match(error.message, /query exhaustive work bound 3 exceeds ceiling 2/u);
      return true;
    }
  );

  assert.deepEqual(pool.leaseCalls, []);
  assert.deepEqual(pool.runCalls, []);
  assert.deepEqual(pool.cancelCalls, []);
});

test("SearchQuerySession cancellation cancels live leased work", async () => {
  const pool = new FakeLeasePool([1, 2]);
  const scheduler = new SearchQueryScheduler(pool, { exhaustiveWorkCeiling: 100 });
  const session = scheduler.submit(schedulerInput("cancel-live", 4));

  await settleSchedulerTurn();

  assert.equal(pool.activeRuns().length, 2);
  session.cancel();

  await assert.rejects(session.result, (error) => {
    assert.equal(error.code, "CANCELLED");
    return true;
  });
  assert.deepEqual(pool.cancelCalls, ["cancel-live"]);
  assert.equal(pool.activeRuns().length, 0);
});

test("SearchQueryScheduler cancellation rejects pending sessions before slot admission", async () => {
  const pool = new FakeLeasePool([1], { busySlotIds: [1] });
  const scheduler = new SearchQueryScheduler(pool, { exhaustiveWorkCeiling: 100 });
  const session = scheduler.submit(schedulerInput("cancel-pending", 1));

  await settleSchedulerTurn();

  assert.equal(pool.runCalls.length, 0);
  scheduler.cancel("cancel-pending");

  await assert.rejects(session.result, (error) => {
    assert.equal(error.code, "CANCELLED");
    return true;
  });

  pool.slots.get(1).busy = false;
  const next = scheduler.execute(schedulerInput("after-cancel", 1));
  await settleSchedulerTurn();

  assert.deepEqual(pool.runCalls.map((run) => run.options.cancellationId), ["after-cancel"]);
  pool.completeAll();
  await next;
});

test("SearchQueryScheduler remembers cancellation before a session is submitted", async () => {
  const pool = new FakeLeasePool([1]);
  const scheduler = new SearchQueryScheduler(pool, { exhaustiveWorkCeiling: 100 });

  scheduler.cancel("pre-cancel");

  await assert.rejects(
    scheduler.execute(schedulerInput("pre-cancel", 1)),
    (error) => {
      assert.equal(error.code, "CANCELLED");
      return true;
    }
  );
  assert.deepEqual(pool.leaseCalls, []);
  assert.deepEqual(pool.runCalls, []);
});

test("SearchQuerySession releases a lease when dispatch fails before the slot is consumed", async () => {
  const pool = new FakeLeasePool([1], { throwOnRunSlotIds: [1] });
  const scheduler = new SearchQueryScheduler(pool, { exhaustiveWorkCeiling: 100 });

  await assert.rejects(
    scheduler.execute(schedulerInput("dispatch-fail", 1)),
    /slot 1 failed before dispatch/u
  );

  assert.deepEqual(pool.leaseCalls, [1]);
  assert.deepEqual(pool.releaseCalls, [1]);
  assert.deepEqual(pool.idleReadySlotIds(), [1]);
});

test("SearchQuerySession bounded shard budget ceases scheduling without cancelling in-flight work", async () => {
  const pool = new FakeLeasePool([1, 2]);
  const scheduler = new SearchQueryScheduler(pool, { exhaustiveWorkCeiling: 100 });
  const resultPromise = scheduler.execute(schedulerInput("shard-budget-stop", 2, {
    search: {
      query: "needle",
      limit: 5,
      coverage: "bounded",
      budget: { shards: 1 }
    }
  }));

  await settleSchedulerTurn();

  assert.equal(pool.activeRuns().length, 1);
  assert.equal(pool.runCalls.length, 1);
  assert.deepEqual(pool.runCalls[0].job.snapshot.segments.map((segment) => segment.partitionId), [1]);

  pool.completeAll();
  const result = await resultPromise;

  assert.equal(result.snapshotId, "snapshot-shard-budget-stop");
  assert.deepEqual(result.warnings, [SEARCH_WARNING_BOUNDED]);
  assert.deepEqual(pool.cancelCalls, []);
});

test("SearchQuerySession applies bounded and non-reproducible warnings for time budgets", async () => {
  const pool = new FakeLeasePool([1]);
  const scheduler = new SearchQueryScheduler(pool, { exhaustiveWorkCeiling: 100 });
  const resultPromise = scheduler.execute(schedulerInput("time-budget", 1, {
    search: {
      query: "needle",
      limit: 5,
      coverage: "bounded",
      budget: { timeMs: 60_000 }
    }
  }));

  await settleSchedulerTurn();
  assert.equal(pool.activeRuns().length, 1);

  pool.completeAll();
  const result = await resultPromise;

  assert.deepEqual(result.warnings, [SEARCH_WARNING_BOUNDED, SEARCH_WARNING_NON_REPRODUCIBLE]);
});

test("SearchQuerySession bounded explain marks incomplete candidate set in result and trace warnings", async () => {
  const pool = new FakeLeasePool([1]);
  const scheduler = new SearchQueryScheduler(pool, { exhaustiveWorkCeiling: 100 });
  const resultPromise = scheduler.execute(schedulerInput("approx-explain", 1, {
    explain: true,
    search: {
      query: "needle",
      limit: 5,
      coverage: "bounded",
      budget: { shards: 1 }
    }
  }));

  await settleSchedulerTurn();
  pool.completeAll();
  const result = await resultPromise;

  assert.deepEqual(result.warnings, [SEARCH_WARNING_BOUNDED]);
  assert.ok(result.explainTrace);
  assert.deepEqual(result.explainTrace.warnings, [SEARCH_WARNING_BOUNDED]);
  assert.equal(result.explainTrace.inputs.candidateSet.complete, false);
});

test("SearchQuerySession time budget ceases scheduling pending work without cancelling in-flight work", async () => {
  const pool = new FakeLeasePool([1]);
  const scheduler = new SearchQueryScheduler(pool, { exhaustiveWorkCeiling: 100 });
  const resultPromise = scheduler.execute(schedulerInput("time-budget-fired", 3, {
    search: {
      query: "needle",
      limit: 5,
      coverage: "bounded",
      budget: { timeMs: 1 }
    }
  }));

  await settleSchedulerTurn();
  assert.equal(pool.activeRuns().length, 1);
  assert.equal(pool.runCalls.length, 1);

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(pool.activeRuns().length, 1);
  assert.equal(pool.runCalls.length, 1);
  assert.deepEqual(pool.cancelCalls, []);

  pool.completeAll();
  const result = await resultPromise;
  await settleSchedulerTurn();

  assert.deepEqual(result.warnings, [SEARCH_WARNING_BOUNDED, SEARCH_WARNING_NON_REPRODUCIBLE]);
  assert.equal(pool.runCalls.length, 1);
  assert.deepEqual(pool.cancelCalls, []);
});
