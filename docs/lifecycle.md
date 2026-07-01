# Runtime Lifecycle

This document traces the **complete runtime lifecycle** of the search / retrieval system: how the
daemon is born and dies, how the embedding model session loads and unloads, what a request does
end-to-end per retrieval mode, and how caches and indexes are built, published, pinned, and garbage
collected. It complements [`ARCHITECTURE.md`](ARCHITECTURE.md) (layer graph, dependency rules) and
[`search.md`](search.md) (benchmark + snapshot principles). Every claim cites `file:line` against the
current source.

Iron law (unchanged): results are a pure function of `(snapshot id, query, filters, limit, ranking
version, analyzer identity)`; latency may vary, results may not. This document is about the *latency*
and *lifecycle* half — the resident daemon, the load/unload of the model, and the build/publish/GC of
caches — none of which may change a served result.

---

## 1. Daemon lifecycle (birth & death)

### Auto-start from a client

Every CLI/MCP entry goes through `createSearchDaemonClient` (`src/daemon/client.ts:98`). There is no
in-process search fallback: if the daemon cannot be reached, the client throws
`SEARCH_DAEMON_UNAVAILABLE` (`client.ts:481`).

`ensureReady()` (`client.ts:111-132`) is the birth path:

1. Read the owner record from the registry (`client.ts:112`). If a live, compatible owner already
   answers `Status`, reuse it (`ownerCanBeUsed`, `client.ts:134-150`; validates identity, PID
   liveness, socket ownership, and nonce).
2. Otherwise take a **directory lock** (`registry.withControlLock`, `client.ts:118`;
   `owner-registry.ts:319-342`, `mkdir`-based, stale after `LOCK_STALE_MS = 20_000`) so two cold
   clients cannot both spawn. Under the lock, re-check, fence a stale owner
   (`fenceOrRemoveOwner`, `client.ts:152-176` — sends `Shutdown` to a same-slot live owner), then
   `spawnOwner()`.
3. `spawnOwner()` (`client.ts:178-196`) writes a fresh owner record with a **random 24-byte nonce**
   (`owner-registry.ts:105-107`) and detaches the process: `spawn(binaryPath, ["__search-daemon"],
   { detached: true, stdio: "ignore" })` then `child.unref()` (`client.ts:451-479`).
4. `waitUntilReady()` (`client.ts:198-217`) polls `Status` every 50 ms until `ready`, up to
   `SEARCH_DAEMON_DEFAULT_READY_TIMEOUT_MS = 15000` (`protocol.ts:58`).

### Owner registry, nonce, and separate sockets

The daemon is **per-user, per-runtime**. Identity is `(uid, runtimeHash, binaryVersion,
protocolVersion)` (`owner-registry.ts:26-31`, `desiredOwnerIdentity` `:123-130`). It listens on
**two Unix domain sockets** — a query socket and a control socket — under the runtime directory
(`socketPathsForOwner`, `owner-registry.ts:147-155`; default dir from `XDG_RUNTIME_DIR` else
`os.tmpdir()/optsidian-<uid>`, `:85-91`).

- **Query capability** (`QUERY_DAEMON_METHODS`, `protocol.ts:36-40`): `Status`, `Search`, `Retrieve`.
- **Control capability** (`CONTROL_DAEMON_METHODS`, `protocol.ts:42-51`): `Status`, `LoadVault`,
  `Rebuild`, `Refresh`, `Compact`, `Clear`, `Prune`, `Shutdown`.

Every request except `Status` must carry the owner nonce or it is rejected with
`SEARCH_DAEMON_AUTH_FAILED` (`server.ts:287-289`). The protocol version must match
(`SEARCH_DAEMON_PROTOCOL_VERSION = 2`, `protocol.ts:35`; validated `server.ts:272-274`).

The **ready handshake**: on start the daemon opens both sockets, then sets `phase = "ready"`
(`initialize`, `server.ts:222-224`). Until `daemon` is constructed, both socket handlers throw
`SEARCH_DAEMON_NOT_READY` (`server.ts:161-163, 177-179`). The client's `Status` reports
`ready: phase === "ready"` (`server.ts:419`).

### What keeps the daemon alive

The daemon arms a no-request idle shutdown timer. `daemonIdleMs` defaults to `6 * 60 * 60 * 1000`
and still honors `OPTSIDIAN_SEARCH_DAEMON_IDLE_MS` / `settings.search.daemonIdleMs`
(`server.ts:585-587`). Startup arms the timer after `phase = "ready"` (`server.ts:226-235`);
`handleRequest` clears it at request admission and re-arms it in `finally` after the request completes
(`server.ts:245-269`). When the timer fires, it runs the same shutdown path as explicit `Shutdown`
(`server.ts:477-487`). A later CLI or MCP call auto-boots the daemon through `ensureReady()`.

> **DO** treat the daemon as warm between requests within the idle window.
> **DON'T** confuse daemon idle shutdown with model idle unload; embedding model sessions keep their
> own shorter idle lifecycle.

### Profile runtimes (per profile × vault) also stay resident

The daemon multiplexes **profile runtimes** keyed by a hash of the `SearchRuntimeProfile` (analyzer
mode, ngram, embedding provider/model, ranking, worker counts, caps —
`runtime-profile.ts:13-56`, `searchRuntimeProfileHash` `:179-181`). `ProfileManager`
(`profile-manager.ts:156`) lazily creates one `ProfileRuntime` per distinct profile
(`ProfileRuntime.create`, `profile-manager.ts:71-118`) — each with its own worker pools, vector
generation pool, and search store. Profile runtimes are still retained until daemon shutdown:
`release` decrements the active-request count and calls a profile-level `armIdleTimer` that only
clears the timer (`profile-manager.ts:288-302`). `closeEntryIfIdle` (`:304-307`) exists but has no
scheduled caller. Profile runtimes are therefore torn down only by `ProfileManager.close()` on daemon shutdown
(`:253-257`). A single default profile is the norm; a distinct `profile` in the request payload spins
up a second resident runtime.

### Explicit shutdown

The `Shutdown` control method (`server.ts:384-393`) requires the nonce, replies `{ok, shuttingDown}`,
then asynchronously runs `shutdown()` on an `unref`'d timer. `shutdown()` (`server.ts:443-464`) sets
`phase = "shutting-down"`, removes the owner record, closes both RPC servers, closes all profile
runtimes (`profiles.close()`), unlinks both sockets, and resolves the `waitForShutdown` promise that
keeps `runSearchDaemon` alive (`server.ts:94-96`).

### Startup partial-failure cleanup & crash recovery

- **Partial-start cleanup**: if construction fails after a socket is opened, `SearchDaemon.start`'s
  `catch` closes whichever RPC servers opened, unlinks both socket paths, and removes the owner record
  (`server.ts:192-215`). Orphan sockets are also unlinked *before* binding (`removeOrphanSocket`,
  `server.ts:147-148, 528-534`).
- **Process error handlers**: uncaught exceptions / unhandled rejections log to stderr and
  `process.exit(1)` for both the daemon (`server.ts:540-558`) and its workers
  (`worker-entry.ts:377-395`).
- **Crash / restart recovery**: a fresh daemon re-derives its owner slot from env
  (`resolveOwnerFromEnv`, `server.ts:503-526`) and reclaims the sockets. On the index side, the corpus
  active pointer is validated at read time and a dangling pointer is dropped (`recoverVault`,
  `snapshot-store.ts:1395-1403`), and a background GC re-runs. At the daemon ready transition,
  retrieval startup recovery demotes stale `building` records and sweeps orphan staging.

### Key constants & env vars

| Name | Value | Source |
|------|-------|--------|
| `SEARCH_DAEMON_PROTOCOL_VERSION` | `2` | `protocol.ts:35` |
| Ready poll timeout | `15000` ms | `SEARCH_DAEMON_DEFAULT_READY_TIMEOUT_MS`, `protocol.ts:58` |
| Owner control lock stale | `20_000` ms | `LOCK_STALE_MS`, `owner-registry.ts:61` |
| Daemon idle timeout | `6 hours` by default; armed after startup and each request | `server.ts:477-487, 585-587` |
| Nonce | random 24 bytes | `randomNonce`, `owner-registry.ts:105-107` |
| Runtime dir override | `OPTSIDIAN_SEARCH_DAEMON_RUNTIME_DIR` | `owner-registry.ts:85-91` |
| Idle-ms override | `OPTSIDIAN_SEARCH_DAEMON_IDLE_MS` | `server.ts:585` |

---

## 2. Embedding model session lifecycle (load / unload)

The model session is **separate from the daemon**: the daemon is resident, but the model loads on
demand and unloads on idle. It lives inside the **embedding worker** (`worker-entry.ts`, `kind:
"embedding"`), which owns a single module-level `ModelSessionLifecycle` keyed by a stable provider key
(`worker-entry.ts:49-51, 225-239`). The pool has `size = 1` by default
(`OPTSIDIAN_SEARCH_EMBEDDING_WORKERS`, `pools.ts:426, 453-462`) and does not auto-warm.

### Load triggers — encode is the only trigger

The lifecycle loads a session lazily inside `ModelSessionLifecycle.encode` → `ensureSession`
(`model-session/lifecycle.ts:69-136`). Two things trigger `EmbeddingWorkerPool.encode`
(`pools.ts:342-344`), both routed through `worker-entry.ts:211-223` (`modelEncode`):

- **`origin=text` query encode** — a text retrieval query is embedded via
  `encodeRetrieveQueryVector` (`service.ts:93-124`, `inputKind: "query"` → `origin: "query-text"`).
- **Document embed** during retrieval-snapshot build — `createWorkerEmbeddingSetBuilder` batches every
  document's dense text through the same pool (`inputKind: "document"` → `origin: "document-embed"`,
  `snapshot-store.ts:1629-1676`, invoked from `buildRetrievalSnapshotPublication`
  `snapshot-store.ts:922`).

**`origin=note` and note-path sides of `origin=pair` do NOT load the model.** They read a
**precomputed** stored vector from the pinned retrieval snapshot's embedding set
(`resolveRetrieveOrigin`, `service.ts:581-650`): `origin=note` and note-path `origin=pair` sides look
the source note up by path in `pin.embeddingSet.records`; `origin=pair` encodes only a raw-text side.
`origin=global` returns no query vector at all and never touches the model.

### Device selection: GPU if VRAM headroom, else CPU

`pickDevice()` (`lifecycle.ts:198-201`) probes free VRAM and picks GPU only when
`freeBytes >= requiredVramBytes * 1.5` — a **1.5× headroom multiplier**; otherwise CPU. The required
and free VRAM come from `OPTSIDIAN_SEARCH_MODEL_REQUIRED_VRAM_MB` and
`OPTSIDIAN_SEARCH_MODEL_FREE_VRAM_MB` (both default `0`, so **default is CPU**;
`worker-entry.ts:285-305`). The ONNX execution provider is chosen from the device and platform:
CoreML on macOS, CUDA on Linux, else CPU (`worker-entry.ts:275-279`), and the ONNX session creation
tries providers in order with **CPU fallback** (`createOnnxSessionWithFallback` +
`candidateExecutionProviders`, `local-onnx.ts:287-321`; Linux `["cuda","cpu"]`, darwin
`["coreml","cpu"]`).

### Single-flight coalescing

Concurrent encodes share one in-flight load. `ensureSession` returns the live session if present, else
joins the current `loading` promise or the current `coldLoad` promise (`lifecycle.ts:112-136`).
Waiters are counted (`waiters`, `coldLoadWaiters`); a load is cancelled only when the **last** waiter
leaves before it settles (`releaseColdLoadWaiter` / `releaseSharedLoadWaiter`,
`lifecycle.ts:319-334`).

### Idle unload

After every encode, `armIdleUnload()` (`lifecycle.ts:86, 336-346`) schedules
`unload()` on an `unref`'d timer. The idle window is `idleMs`, default `5 * 60 * 1000`
(`ModelSessionLifecycle` default `lifecycle.ts:62`; supplied by `worker-entry.ts:289-293` from
`OPTSIDIAN_SEARCH_MODEL_IDLE_MS`, default 5 min). If `idleMs <= 0` the session unloads **immediately**
after each encode (`lifecycle.ts:338-341`). `unload()` clears the timer and closes the session
(`lifecycle.ts:91-96`). This is why "zero footprint at rest" applies to the *model*, not the daemon.

### CPU → GPU promotion

After a successful encode on a CPU session, `promoteCpuSessionIfGpuAvailable`
(`lifecycle.ts:87, 174-196`) re-probes VRAM; if GPU is now available it loads a GPU session in the
background, swaps it in, and closes the CPU one (guarded by a load generation so a superseded load is
discarded). Promotion is suppressed once after a GPU OOM (`suppressPromotionAfterGpuOom`,
`lifecycle.ts:145-148, 177-180`).

### Load deadline, cancellation, per-waiter cancellation

- **Encode deadline**: `Date.now() + modelEncodeDeadlineMs()` (default `60_000`,
  `OPTSIDIAN_SEARCH_MODEL_ENCODE_DEADLINE_MS`, `worker-entry.ts:211-216, 295-299`). If the request
  deadline is within 100 ms the daemon **skips** dense encode entirely and warns instead of failing
  (`service.ts:100-103`).
- **GPU OOM fallback**: a GPU load that throws an OOM error falls back to CPU
  (`startLoadWithFallback`, `lifecycle.ts:138-150`; `defaultIsOomError` `:381-384`).
- **Deadline / abort**: `waitForLoadPromise` (`lifecycle.ts:267-317`) races the load against a
  deadline timer and an `AbortSignal`; on expiry it releases the waiter and rejects
  `DEADLINE_EXCEEDED` / `CANCELLED`. A superseded load is closed and rejected `CANCELLED`
  (`lifecycle.ts:157-161`).

| Name | Value | Source |
|------|-------|--------|
| Model idle unload | `5 min` (`0` ⇒ unload immediately) | `OPTSIDIAN_SEARCH_MODEL_IDLE_MS`, `worker-entry.ts:289-293` |
| Encode deadline | `60_000` ms | `OPTSIDIAN_SEARCH_MODEL_ENCODE_DEADLINE_MS`, `worker-entry.ts:295-299` |
| VRAM headroom multiplier | `1.5×` | `lifecycle.ts:200` |
| Required / free VRAM | `0` MB default (⇒ CPU) | `worker-entry.ts:285, 301-305` |
| EP order | CUDA→CPU (linux) / CoreML→CPU (darwin) | `local-onnx.ts:313-321` |

---

## 3. Search / Retrieve request lifecycle by mode

### Retrieval modes

`SearchRetrievalMode` normalizes to one of three (`params.ts:84-90`): **`lexical`** (default),
**`vector`**, **`hybrid`**. The request `origin` (for `Retrieve`) is one of
`text | note | pair | global` (`RetrieveOrigin`, `core/types.ts:171`).

The client splits the transport (`client.ts:298-305`): a `search` request with `retrieval` `vector`
or `hybrid` is rewritten into a `Retrieve` (`searchPayloadToRetrieve` sets `origin: "text"`,
`client.ts:409-416`); plain lexical `search` uses `Search`; `explain` always uses `Retrieve` with
`debug + explain` (`client.ts:306-321`). The daemon dispatch is `server.ts:292-311`.

### Lexical (`Search`, or `retrieval=lexical`)

`DaemonSearchStoreService.search` (`service.ts:175-183`) rejects any non-lexical retrieval, then
`executeSearch` (`service.ts:294-303`):

1. **Pin** the active corpus snapshot: `store.pin(vault, snapshotId?, ...)`
   (`snapshot-store.ts:411-431`) — ensures an active snapshot exists (building it if needed via
   `ensureActiveSnapshot`), loads it, `refCount += 1`, adds a `pinToken`.
2. Analyze the query once (latency analyzer pool or inline analyzer, cached by analyzer identity + raw
   query + settings hash; `queryAnalysis`, `service.ts:533-579`).
3. Run positional retrieval over the pinned corpus snapshot via `SearchQueryScheduler.execute`
   (`service.ts:338-358`), which fans shard tasks onto the search-execution pool.
4. **Release** the pin in `finally` (`service.ts:300-302`). Release is **refcount-only** — it deletes
   the pin token and decrements `refCount`; no file deletion or GC happens on the query path
   (`snapshot-store.ts:635-643`).

A metadata-only search (tag filter, no query text) skips positional retrieval and scans document
metadata (`executeMetadataSearchFromSnapshotHandle`, `service.ts:323-331`).

### Vector / dense (`retrieval=vector`)

`DaemonSearchStoreService.retrieve` (`service.ts:185-278`) is the dense/hybrid entry. The order is
**pin-before-encode**:

1. **Pin the retrieval snapshot** first: `store.ensureActiveRetrievalSnapshot`
   (`snapshot-store.ts:444-466`). This is the query path that **can build** — if the active retrieval
   snapshot is missing or its `snapshotId`/`corpusSnapshotId` don't match the freshly-ensured corpus,
   it publishes a retrieval snapshot *inline* and re-pins. If the pin is not ready, `retrieve` returns
   `status: "index-not-ready"` with the pin `reason` (`service.ts:187-199`) — it never scans embedding
   JSON in-process.
2. Resolve the query vector (`resolveRetrieveOrigin`, `service.ts:581-650`): `origin=text` **encodes**
   the query text through the model; `origin=note` uses the stored source vector; `origin=pair` uses
   stored note vectors and encodes only a raw-text side; `origin=global` yields no vector.
3. Dense search against the **pinned built coral-needle generation**: `searchActiveDenseGeneration`
   (`service.ts:372-408`) calls `vectorPool.searchActiveBuiltIndex` with `expectedGenerationId =
   pin.vector.generationId` and `candidateK = max(limit, limit*4)`. A generation mismatch or missing
   active spec returns `index-not-ready` with `vector-active-spec-mismatched` /
   `vector-active-spec-missing` (`service.ts:389-399`).
4. Vector-only shaping (`vectorOnlyRetrieveResult`, `service.ts:410-478`): each dense hit is mapped to
   a document via `documentsForPin`, filtered by path/tag, scored by `denseAgreementFromCosine`
   (`provider.ts:70-73`), truncated to `limit`.
5. **Release** the pin in `finally` (`service.ts:275-277`), refcount-only.

### Hybrid (`retrieval=hybrid`)

Same pin + encode + dense-search prefix as vector, then instead of vector-only shaping it runs the
full ranked query with the dense hits fused in: `executeSearchWithPin({...searchPayload, debug:true},
..., pin, { queryVector, denseSearchResults, sourceDocumentId, sourcePath, excludeDocumentIds })`
(`service.ts:240-274`). Fusion happens **inside the search-execution worker**, not the daemon:
`SearchQueryScheduler` carries `queryVector` / `denseSearchResults` / `rrfK` down into the shard job
(`query-scheduler.ts:511-518`), and the worker fuses lexical + dense + link-adjacency candidate sets
via **RRF** (`fuseCandidateSets`, `search-execution.ts:33, 426-428`), with dense candidates built from
`denseSearchResults` + `denseAgreementFromCosine` (`search-execution.ts:437-455`) and link-adjacency
candidates from the link graph carried on the snapshot handle. The pinned retrieval snapshot supplies
the link graph and ranking identity; the daemon released the pin only after fusion completes.

> **DO** pin the retrieval snapshot before encoding the query and before dense search — the pinned
> generation id is what dense search validates against.
> **DON'T** GC anything on the query path; the query only bumps and drops refcounts.

### Request admission, deadlines, cancellation

`SearchDaemon.handleRequest` (`server.ts:234-259`) validates protocol/nonce/deadline, registers the
request cancellation id, and runs through the scheduler. Default query deadline is
`SEARCH_DAEMON_DEFAULT_SEARCH_DEADLINE_MS = 3000` for `Retrieve` (`protocol.ts:60, 528-532`); a cold
lifecycle command gets a work-sized deadline `60s + 750ms·files + 5s·MiB`
(`vaultLifecycleDeadlineMs`, `protocol.ts:539-545`; applied client-side `client.ts:394-397`). A closed
RPC connection cancels its in-flight requests (`server.ts:166-171, 261-269`).

---

## 4. Cache & index lifecycle (the lifelines)

The search subsystem persists **four distinct artifacts**, each content-addressed and independently
GC'd.

### The four artifacts and their identities

| Artifact | Identity | Built by | On disk |
|----------|----------|----------|---------|
| **Lexical corpus snapshot** (segments + manifest) | `corpusSnapshotId` = hash of segment content-hashes + identity tuple | `buildCanonicalSearchSnapshot` (analyzer throughput pool) | `stores/<vaultHash>/{segments,snapshots}` |
| **Link-graph sidecar** | `linkGraphId` = `buildLinkGraphSidecar({corpusSnapshotId, edges})` | published with the corpus (`snapshot-store.ts:839-850`) | `stores/<vaultHash>/link-graphs` |
| **coral-needle vector generation** | `generationId = gen-<embeddingSetId[:24]>`; `embeddingSetId` = content hash over recipe + every doc's projected vector (`embedding-set.ts:151-166`) | `vectorPool.buildStagingGeneration` → `promoteBuiltGeneration` | `vectors/stores/<profile>/<vaultHash>/<embeddingSetId>/generations` |
| **Composite retrieval snapshot** (envelope) | `retrievalSnapshotId` = `sha256(corpusSnapshotId, linkGraphId, embeddingSetId, retrieverPlanIdentity, rankingFeatureVersion)` (`snapshot-store.ts:1709-1723`) | `buildRetrievalSnapshotPublication` | `stores/<vaultHash>/retrievals` |

`retrieverPlanIdentity` folds the positional + dense + link-adjacency retrievers and the RRF fusion
parameters (`retrievalPlanIdentityFor`, `snapshot-store.ts:1823-1848`). The whole point: **query-time
pins recompute the expected `retrievalSnapshotId` and reject a served snapshot that was built under a
different identity** (`tryPinActiveRetrievalSnapshot`, `snapshot-store.ts:503-599`), returning
reasons `retrieval-snapshot-mismatched`, `embedding-set-mismatched`, `corpus-missing`,
`link-graph-missing`, `vector-active-spec-*`, or a freshness reason.

Where the caches live on disk (`cache-paths.ts`; root = `XDG_CACHE_HOME` else `~/.cache`, then
`optsidian`, `cache-root.ts:4-6`):

- Lexical store: `search/stores/<vaultStateHash>/{segments,snapshots,retrievals,link-graphs,active,tmp}`
  (`search-store/cache-paths.ts:24-49`). Two active pointers: corpus `active/<vaultHash>` and retrieval
  `active/<vaultHash>.retrieval`.
- Vector store: `vectors/stores/<profileHash>/<vaultStateHash>/<embeddingSetId>/{generations,staging,active,tmp}`
  plus a per-vault `retrieval-freshness.json` (`vector-store/cache-paths.ts:26-62`).
- coral-needle runtime binding: `coral-needle/<version>/<platform>-<arch>/coral-needle.node`
  (`vector-store/artifact.ts:147-153`).
- ONNX embedding model + tokenizer artifacts: under the same cache root, fetched from Hugging Face
  (`local-onnx.ts` / `dense/artifacts.ts:466`).

### Build / publish path

- **`LoadVault`** → `ensureIndexedSnapshot` → `refreshIndexedSnapshot` (`snapshot-store.ts:323-342`).
- **`Rebuild`** → always `publishFreshSnapshot(..., {prepareRetrieval:true})`
  (`snapshot-store.ts:344-355`).
- **`Refresh`** → `refreshIndexedSnapshot` (`snapshot-store.ts:697-733`): computes a **content delta**
  (sha256 per file vs stored `contentHash`, `snapshotContentDelta`); if `changedCount === 0` it keeps
  the active snapshot and only ensures the retrieval snapshot matches
  (`prepareRetrievalSnapshotForSnapshot`); otherwise it reports the delta
  (`reportRefreshDelta`, `snapshot-store.ts:727, 2114-2132`) and rebuilds the whole snapshot. **The
  delta only decides rebuild-vs-not; there is no incremental segment patching.**
- **`publishFreshSnapshot`** (`snapshot-store.ts:751-811`): builds the corpus, kicks off the retrieval
  publication (embedding + vector build) **concurrently**, publishes the corpus + flips the corpus
  active pointer, then awaits and publishes the retrieval snapshot.
- **`publishBuiltSnapshot`** (`snapshot-store.ts:829-902`): stores the link-graph sidecar, writes +
  fsyncs + content-verifies each segment (skips segments already present with matching hash), writes
  the manifest, **durable-renames the active pointer**, then `recoverVault` + `markSweepGc`. All
  writes are temp-file + fsync + rename.
- **`buildRetrievalSnapshotPublication`** (`snapshot-store.ts:916-1040`): builds the embedding set
  (`embeddingSetBuilder.build`, `:922`) → builds a **staging** vector generation and **promotes** it
  (`vectorPool.buildStagingGeneration` + `promoteBuiltGeneration`, `:961-968`) → constructs the
  retrieval envelope with `freshness:{state:"fresh", corpusRevision: corpusSnapshotId}`.
- **`publishRetrievalSnapshotPublication`** (`snapshot-store.ts:1042-1067`): stores the envelope,
  writes freshness `markFresh`, durable-renames the **retrieval** active pointer, `markSweepGc`.

Embedding happens **on load/rebuild/refresh** (inside `buildRetrievalSnapshotPublication`), **not on
note-save** — see §6.

### Vector generation swap (drain by refcount)

Promotion flips the active pointer and retires the old generation without disrupting in-flight readers
(`VectorGenerationPool`, `vector-store/pool.ts`): `flipActive` sets the new handle active and calls
`retire(old)` (`pool.ts:256-262`); `retire` marks the old handle `draining` and removes it from
`activeByKey` (`:264-269`); `closeWhenDrained` waits until `refCount === 0` (readers released) before
closing the native instance (`:271-284`). Each search acquires a pin (`acquireActive` bumps
`refCount`, `pool.ts:238-245`) and releases it after `searchVector` (`:247-254`). A pinned old
generation stays open until its last reader drains.

### Freshness state machine

`RetrievalFreshnessStore` (`vector-store/freshness.ts`) persists `retrieval-freshness.json` with state
`fresh | dirty | building | failed` (`freshness.ts:8`). Transitions: `markDirty` (`:60`),
`markBuilding` (`:71`), `markFresh` (`:82`), `markFailed` (`:92`). On restart the **default read state
is `dirty`/unknown** (`defaultDirtyUnknown`, `:157-164`). `startupReconcile` (`:104-127`) demotes a
`building` record to `dirty` and re-marks `fresh` only if the on-disk corpus revision matches;
`resetBuildingToDirty` (`:129-137`) and `recoverRetrievalStaging` (`:171-181`) sweep staging on
recovery. `tryPinActiveRetrievalSnapshot` refuses to serve unless the state is `fresh` and every
published field (retrievalSnapshotId, embeddingSetId, linkGraphId, corpusSnapshotId,
vectorGenerationId, corpusRevision) matches the envelope (`snapshot-store.ts:547-567`), mapping any
non-fresh state to a `retrieval-state-*` reason (`freshnessStateReason`, `snapshot-store.ts:2253-2258`).

> **Reality note**: the corpus-driven publish path only ever writes `markFresh`
> (`snapshot-store.ts:1049`). `markDirty` / `markBuilding` / `markFailed` and the reconcile helpers are
> only reachable from the currently-unwired embed-on-save watcher — see §6.

### Garbage collection — background, refcount-gated

`markSweepGc` (`snapshot-store.ts:1176-1179`) → `queueGc` schedules a **background** sweep on
`setImmediate(...)` + `unref()` (`:1252-1269`), serialized per vault. `runBackgroundGc`
(`:1271-1276`) runs `markSweepSearchGc` (retrieval envelopes, snapshots, segments, link graphs) →
`markSweepVectorGc` (vector generation dirs, then empty store roots) → stale-tmp sweep.

**GC roots** (`gcRootsAsync`, `snapshot-store.ts:1181-1236`) are refcount- and in-flight-gated: the
active corpus + active retrieval and their transitive artifacts, everything in the in-flight publish
sets, **loaded snapshots with `refCount > 0`**, the newest `retentionCount` snapshot + retrieval files,
and **pinned vector generations** (`pinnedVectorGenerations`, incremented per retrieval pin,
`:1373-1393`). So a pinned or in-flight artifact always survives. Stale vector generations that are not
a GC root are removed (`markSweepVectorGc`, `:1314-1358`); an empty vector store root is deleted and
removed from the `VectorCacheCatalog`.

**Retention** (`retentionCount`) defaults to `2` in the running daemon — `ProfileManager` passes
`normalized.cache.snapshotRetention` (`runtime-profile.ts:98`, default 2; env
`OPTSIDIAN_SEARCH_SNAPSHOT_RETENTION_COUNT`) into `createDaemonSnapshotStore`
(`profile-manager.ts:95`). The store's own fallback when constructed without that option is
`DEFAULT_RETENTION_COUNT = 8` (`snapshot-store.ts:245, 293-297`). In-memory loaded-snapshot budgets
are separate: count cap and byte cap (`enforceBudget`, evicts only `refCount === 0`, LRU;
`snapshot-store.ts:1160-1174`).

**Manual GC**: `Prune` (`SearchCacheCatalog.prune`) removes store directories unused for
`unusedDays` (default in catalog), skipping store ids protected by any live pin
(`profile-manager.ts:270-290`).

**Vector dedup**: there is **no per-vector deduplication before build** —
`vectorChunksForEmbeddingSet` maps 1 record → 1 chunk (`snapshot-store.ts:1773-1787`). "Dedup" in this
subsystem is only cache-catalog record dedup by `storeId` (`cache-catalog.ts:369`). Content-addressing
comes from the `embeddingSetId` being a hash over projected vectors, so identical corpora yield an
identical generation.

### coral-needle runtime artifact lifecycle

The native vector index is `coral-needle` (`CORAL_NEEDLE_VERSION = "v0.2.0"`,
`vector-store/artifact.ts:10`). `ensureCoralNeedleBinding` (`artifact.ts:124`):

- Honors `OPTSIDIAN_CORAL_NEEDLE_BINDING` as an explicit path override (`artifact.ts:128-132`).
- Otherwise resolves the platform/arch release asset and downloads it from GitHub releases via
  `net/github.ts` `downloadFileStreaming(..., { sendAuth: false })` (`artifact.ts:8, 191-194`).
- **Verifies SHA256 + exact size twice**: the archive (`verifyArchiveData`, `:308-315`) and the
  extracted `.node` binding (`verifyBindingData`, `:317-324`), against hard-coded per-asset digests
  (`RELEASE_ASSETS`, `:51-102`). Install is atomic (temp dir → rename) under a 30 s directory lock
  (`CORAL_NEEDLE_INSTALL_TIMEOUT_MS`, `:14, 164`).
- Cached at `<cacheRoot>/coral-needle/v0.2.0/<platform>-<arch>/coral-needle.node` beside a manifest
  (`artifact.ts:147-153, 202-206`).

Each `CoralNeedleInstance` runs as a **forked subprocess** (`process-instance.ts:83-87`) that lazily
`require`s the native `.node` on first use (`process-entry.ts`, via `loadCoralNeedleBinding`,
`binding.ts:30-53`), isolating a native crash from the daemon. Roles are `staging` (build) and `query`
(promoted generation). Native `searchVector` is the production dense search. Production always uses
the subprocess factory that lazy-downloads the managed coral-needle binding; test-only in-memory
doubles live under `test/` and are injected directly through `VectorGenerationPool({ factory })`.

---

## 5. End-to-end timelines

### (a) Cold first query after daemon start

1. Client `ensureReady` finds no owner → takes the control lock → `spawnOwner` detaches
   `node <bin> __search-daemon` (`client.ts:118-126, 451-479`).
2. Daemon opens query + control sockets, `phase = "ready"` (`server.ts:157-224`); client's `Status`
   poll returns ready within ≤15 s (`client.ts:198-217`).
3. Lexical `search` → `Search` RPC → `store.pin` builds the corpus snapshot on first touch
   (`ensureActiveSnapshot` → `publishFreshSnapshot`), warms one search-execution worker on that
   snapshot, then runs the positional query (`service.ts:294-358`).
4. Pin released refcount-only; a background GC is queued (`markSweepGc` on publish).

### (b) Note edit → embed-on-save → republish (design vs reality)

The **intended** flow: a `.md` change fires `startRetrievalSaveWatcher` → `EmbedOnSaveIndexPlane`
marks freshness `dirty`, debounces `250 ms`, marks `building`, embeds the changed note, builds +
promotes a new vector generation, and marks `fresh` (or `failed` + rollback)
(`vector-store/watcher.ts:32-141`). **Reality**: this watcher is not wired into the daemon (§6), so
today a note edit produces a new snapshot only when the next `Refresh`/`Rebuild`/`LoadVault` (or an
inline Retrieve rebuild) runs, at which point the corpus is rebuilt, the embedding set + vector
generation are rebuilt, and both active pointers flip (`snapshot-store.ts:751-811`).

### (c) `origin=text` hybrid query — model cold vs warm

- **Warm** (model loaded): `retrieve` pins the retrieval snapshot, `encodeRetrieveQueryVector` returns
  from the live session (`clearIdleUnload`, no load; `lifecycle.ts:113-115`), dense search runs against
  the pinned generation, RRF fuses in the worker, pin released (`service.ts:185-278`).
- **Cold** (model unloaded): the encode triggers `ensureSession` → `pickDevice` (CPU by default) →
  `startLoad` → session cached → `armIdleUnload` (`lifecycle.ts:69-89`). If the request deadline is
  within 100 ms, the daemon skips dense encode and warns instead (`service.ts:100-103`). Subsequent
  concurrent encodes coalesce onto the same load (`lifecycle.ts:117-136`).

### (d) Generation swap while a query is in flight

1. Query A pins retrieval snapshot → `acquireActive` bumps the vector generation `refCount`
   (`pool.ts:238-245`), starts `searchVector`.
2. A `Rebuild` promotes a new generation → `flipActive` points active at the new handle and `retire`s
   the old one (`draining = true`, removed from `activeByKey`, `pool.ts:256-269`).
3. Query A's `searchVector` on the old handle completes; `release` drops `refCount` to 0
   (`pool.ts:247-254`); `closeWhenDrained` then closes the old native instance
   (`pool.ts:271-284`). Query B pins the new active generation. No query ever reads a half-closed
   index.

### (e) Model idle-unload

After the last encode, `armIdleUnload` schedules `unload` at `idleMs` (5 min default) on an `unref`'d
timer; when it fires the session closes and VRAM/CPU memory is released
(`lifecycle.ts:86, 336-352`). The **daemon stays up** — only the model session is freed. A later
encode re-loads on demand.

### (f) Daemon restart with a dirty index

1. New daemon reclaims the owner slot and sockets (`server.ts:503-526, 147-148`).
2. On the next lifecycle/query, `recoverVault` validates the corpus active pointer and drops it if the
   manifest is missing, then queues a background GC (`snapshot-store.ts:1395-1403`).
3. The daemon schedules startup recovery after `phase = "ready"`: `startupReconcile` demotes stale
   `building` records, re-marks matching published records as `fresh`, and `recoverRetrievalStaging`
   sweeps orphan vector/link/lexical staging.

---

## 6. Known follow-ups (reality is incomplete here)

These are places where the code contains machinery that is **not exercised by the running daemon
today**. They are documented so readers do not assume behavior the runtime does not deliver.

1. **Profile runtime idle eviction is inert.** The daemon arms a 6-hour no-request shutdown timer by
   default (`OPTSIDIAN_SEARCH_DAEMON_IDLE_MS` / `settings.search.daemonIdleMs` override it), but
   profile runtimes still retain their own resources until daemon shutdown.

2. **Embed-on-save is unwired.** `EmbedOnSaveIndexPlane` and `startRetrievalSaveWatcher`
   (`vector-store/watcher.ts`) are referenced only by their own module and one test — no code in
   `server.ts` / `profile-manager.ts` instantiates the watcher. Consequently the freshness state
   machine's `markDirty` / `markBuilding` / `markFailed` transitions and the 250 ms save debounce are
   not exercised in production; the publish path only ever writes `markFresh`
   (`snapshot-store.ts:1049`). Re-embedding happens on `LoadVault`/`Rebuild`/`Refresh`, not on save.

3. **coral-needle release availability is external.** The production path uses the real native binding
   by default. Whether the pinned GitHub release (`kangig94/coral-needle` v0.2.0) is available for the
   current platform is external; an unsupported platform/arch raises `RuntimeError`, and a missing
   `.node` raises `CORAL_NEEDLE_UNAVAILABLE` (`binding.ts:49-52`).
