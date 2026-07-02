# Runtime Lifecycle

This document traces the **complete runtime lifecycle** of the search / retrieval system: how the
daemon is born and dies, how the embedding model session loads and unloads, what a request does
end-to-end per retrieval mode, and how caches and indexes are built, published, pinned, and garbage
collected. It complements [`ARCHITECTURE.md`](ARCHITECTURE.md) (layer graph, dependency rules) and
[`search.md`](search.md) (benchmark + snapshot principles). References prefer stable symbols and file
names; exact line numbers are included only where they are useful orientation, not as a mechanically
maintained citation set.

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

`ensureReady()` is a lock-free verdict loop:

1. Read the daemon-authored tenancy record from the registry. If it matches the desired slot and the
   single socket answers `Status`, reuse it.
2. If no usable owner exists, spawn `node <bin> __search-daemon`. The client does **not** write the
   owner record and does not take a directory lock; the daemon's successful `listen()` is the exclusive
   tenancy commit.
3. While the daemon is constructing, the same socket serves `Status` and `WaitReady` from a boot
   responder. `WaitReady` is a long poll, so clients do not busy-poll readiness.
4. Lifecycle failures (`STALE_INCARNATION`, `DAEMON_STARTING`, `DAEMON_DRAINING`, transient connect
   errors) resync until the caller's deadline. Semantic failures such as malformed payloads, invalid
   vaults, and real protocol mismatches surface immediately.

### Owner registry, incarnation, and the single socket

The daemon is **per-user, per-runtime**. The tenancy slot is `(uid, runtimeHash, protocolVersion)`;
the record also carries `binaryVersion`, `epoch`, `incarnationId`, `pid`, `socketPath`, and
`startedAt`. It listens on exactly **one Unix domain socket** under the runtime directory
(`socketPathForOwner`; default dir from `XDG_RUNTIME_DIR` else `os.tmpdir()/optsidian-<uid>`).

The single dispatcher preserves the method-level capability split:

- **Query methods** (`QUERY_DAEMON_METHODS`): `Status`, `WaitReady`, `Search`, `Retrieve`.
- **Control methods** (`CONTROL_DAEMON_METHODS`): `Status`, `WaitReady`, `LoadVault`, `Rebuild`,
  `Refresh`, `Compact`, `Clear`, `Prune`, `Shutdown`.

Every method except `Status` and `WaitReady` must carry the current `incarnation` value. A mismatched
incarnation is a retryable `STALE_INCARNATION`. The protocol version is
`SEARCH_DAEMON_PROTOCOL_VERSION = 4`, and a genuine protocol mismatch is a semantic `BAD_REQUEST`.

The **ready handshake**: the daemon binds first, then writes the tenancy record. The record is therefore
never observable until the socket is established. During construction, `Status` returns
`phase:"starting"` and `WaitReady` waits for the monotonic phase transition to `ready` or `draining`.

### What keeps the daemon alive

The daemon arms a no-request idle shutdown timer. `daemonIdleMs` defaults to `6 * 60 * 60 * 1000`
and still honors `OPTSIDIAN_SEARCH_DAEMON_IDLE_MS` / `settings.search.daemonIdleMs`
(`daemonIdleMs`, `server.ts`). Startup arms the timer after `phase = "ready"` (`SearchDaemon.initialize`);
`SearchDaemon.handleRequest` clears it at request admission and re-arms it in `finally` after the
request completes. When the timer fires, it runs the same `drain("draining")` path as explicit
`Shutdown`. A later CLI or MCP call auto-boots the daemon through `ensureReady()`.

> **DO** treat the daemon as warm between requests within the idle window.
> **DON'T** confuse daemon idle shutdown with model idle unload; embedding model sessions keep their
> own shorter idle lifecycle.

### Profile runtimes (per profile × vault) also stay resident

The daemon multiplexes **profile runtimes** keyed by a hash of the `SearchRuntimeProfile` (analyzer
mode, ngram, embedding provider/model, ranking, worker counts, caps —
`runtime-profile.ts:13-56`, `searchRuntimeProfileHash` `:179-181`). `ProfileManager`
(`profile-manager.ts:226-243`) lazily creates one `ProfileRuntime` per distinct profile
(`ProfileRuntime.create`, `profile-manager.ts:101-153`) — each with profile-scoped analyzer/search
resources and a search store, plus leases on the process-scoped `EmbedScheduler` and
`VectorGenerationManager`. Profile runtimes remain resident while the daemon is alive and are torn down
by `ProfileManager.close()` during daemon shutdown (`profile-manager.ts:329-334`). A single default
profile is the norm; a distinct `profile` in the request payload spins up a second resident runtime.

### Explicit shutdown

The `Shutdown` control method replies `{ok, shuttingDown}` and schedules `drain("draining")` on an
`unref`'d timer. `drain(phase)` is the only daemon teardown path for explicit shutdown, idle expiry, and
startup failure after bind. It moves the monotonic phase to `draining`, wakes `WaitReady` waiters,
relinquishes the RPC server/socket, unlinks the socket path, and removes the owner record **before**
slow teardown of profile runtimes (`profiles.close()`) and the embed scheduler (`embedScheduler.close()`).
The RPC server then waits for admitted handlers to drain or observe cancellation, preventing
use-after-close and un-journaled save loss.

The socket path and owner slot must be fully relinquished *before* slow teardown (the 2fe1f70 ordering):
otherwise a client arriving mid-shutdown can auto-boot a successor daemon that binds the same socket path,
and this daemon's later teardown would delete the successor's live socket.

### Startup partial-failure cleanup & crash recovery

- **Partial-start cleanup**: if construction fails after the socket is opened, startup enters the same
  `drain("draining")` ordering. The daemon relinquishes the socket and removes its owner record before
  slow scheduler/profile teardown, so no half-established tenancy is advertised.
- **Stale socket recovery**: a stale socket path is unlinked only after a connect probe proves that no
  listener is present (`ECONNREFUSED`). A provably live listener is not reclaimed.
- **Process error handlers**: uncaught exceptions / unhandled rejections log to stderr and
  `process.exit(1)` for both the daemon (`server.ts:540-558`) and its workers
  (`worker-entry.ts:377-395`).
- **Crash / restart recovery**: a fresh daemon re-derives its desired slot from env, binds the single
  socket, reads the previous record, writes `epoch + 1` with a fresh random `incarnationId`, and starts
  serving. Process liveness is proven through `ProcessToken` start identity, so pid reuse cannot
  deadlock or cause a live holder to be mis-reclaimed. On the index side, the corpus active pointer is
  validated at read time and a dangling pointer is dropped (`recoverVault`,
  `snapshot-store.ts:1395-1403`), and a background GC re-runs. At the daemon ready transition,
  retrieval startup recovery demotes stale `building` records and sweeps orphan staging.
- **Write fencing**: the production `TenancyFenceProvider` is bind-backed. Snapshot publish CAS receives
  `(epoch, incarnationId, claimId, processToken)`, so stale cross-incarnation publish work cannot commit
  after a successor takes over.

### Key constants & env vars

| Name | Value | Source |
|------|-------|--------|
| `SEARCH_DAEMON_PROTOCOL_VERSION` | `4` | `protocol.ts` |
| Ready wait timeout | `15000` ms | `SEARCH_DAEMON_DEFAULT_READY_TIMEOUT_MS`, `protocol.ts` |
| Daemon idle timeout | `6 hours` by default; armed after startup and each request | `daemonIdleMs`, `SearchDaemon.initialize`, `SearchDaemon.handleRequest`, `SearchDaemon.drain` |
| Incarnation id | random per daemon bind winner | `randomIncarnationId`, `owner-registry.ts` |
| Epoch | previous owner record epoch + 1 | `nextOwnerEpoch`, `owner-registry.ts` |
| Runtime dir override | `OPTSIDIAN_SEARCH_DAEMON_RUNTIME_DIR` | `owner-registry.ts:85-91` |
| Idle-ms override | `OPTSIDIAN_SEARCH_DAEMON_IDLE_MS` | `daemonIdleMs` |

---

## 2. Embedding model session lifecycle (load / unload)

The model session is **separate from the daemon**: the daemon is resident, but the model loads on
demand and unloads on idle. The daemon now creates one process-scoped `EmbedScheduler` during
startup (`server.ts:159-163`) and passes it into `ProfileManager`; the scheduler owns the embedding
worker pool and one `VectorGenerationManager` (`embed-scheduler.ts:57-100`). Profile runtimes lease
those process owners rather than constructing their own vector/model owners
(`profile-manager.ts:101-153`), while still owning their profile-specific analyzer/search resources.

The model itself still lives inside the **embedding worker** (`worker-entry.ts`, `kind:
"embedding"`), which owns a single module-level `ModelSessionLifecycle` keyed by a stable provider key
(`worker-entry.ts:49-51, 225-239`). The scheduler is the admission and fairness layer in front of that
worker: priority lanes are `query > save > refresh > rebuild` (`embed-scheduler.ts:54-86`), query
encodes are single-flighted (`embed-scheduler.ts:104-140`), and daemon close drains the scheduler before
closing the model worker and vector manager (`embed-scheduler.ts:187-207`).

### Load triggers — encode is the only trigger

The lifecycle loads a session lazily inside `ModelSessionLifecycle.encode` -> `ensureSession`
(`model-session/lifecycle.ts:69-136`). Every encode now enters through `EmbedScheduler.encode`
(`embed-scheduler.ts:104-140`):

- **`origin=text` query encode** — a text retrieval query is embedded only after retrieve has pinned the
  lexical corpus and attached a usable, space-comparable dense generation. If dense cannot contribute,
  `resolveRetrieveOriginVector` returns without calling `encodeRetrieveQueryVector`
  (`service.ts:699-716`).
- **Document embed** during retrieval generation build — `createWorkerEmbeddingSetBuilder` batches
  document dense text through the scheduler in 32-document slices (`snapshot-store.ts:334,
  1883-1991`). Load/rebuild/refresh use their corresponding lanes, and save-on-write uses the `save`
  lane through `publishSaveSnapshot` (`snapshot-store.ts:456-461`).

**`origin=note`, `origin=pair`, and `origin=global` do NOT load the model.** They resolve source text
from the pinned lexical corpus, then use stored vectors from the attached dense generation
(`service.ts:631-765`). If a source vector is absent, stale by `contentHash`, or dense is not usable,
the result is a soft `index-not-ready` with the dense signal attached, not an on-demand encode.
`origin=pair` accepts note-path sides only; raw text in either side is rejected at the daemon boundary
(`service.ts:659-667`).

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
`lifecycle.ts:145-148, 177-180`) and the scheduler also suppresses promotion while rebuild-lane work is
active (`embed-scheduler.ts:116-137, 312-315`).

### Load deadline, cancellation, per-waiter cancellation

- **Encode deadline**: `Date.now() + modelEncodeDeadlineMs()` (default `60_000`,
  `OPTSIDIAN_SEARCH_MODEL_ENCODE_DEADLINE_MS`, `worker-entry.ts:211-216, 295-299`). If the request
  deadline is within 100 ms the daemon **skips** dense encode entirely and warns instead of failing
  (`DaemonSearchStoreService.encodeRetrieveQueryVector`).
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

The client chooses the daemon method: a `search` request with `retrieval` `vector` or `hybrid` is
rewritten into a `Retrieve` (`searchPayloadToRetrieve` sets `origin: "text"`); plain lexical `search`
uses `Search`; `explain` always uses `Retrieve` with debug + explain. Retrieve-derived search results
carry the retrieve `dense` signal through `searchResultFromRetrieve`. The daemon routes all methods
through one socket dispatcher.

### Lexical (`Search`, or `retrieval=lexical`)

`DaemonSearchStoreService.search` (`service.ts:214-222`) rejects any non-lexical retrieval, then
`executeSearch` (`service.ts:350-359`):

1. **Pin** the active corpus snapshot: `store.pin(vault, snapshotId?, ...)`
   (`snapshot-store.ts:517-537`) — ensures an active snapshot exists (building it if needed via
   `ensureActiveSnapshot`), loads it, `refCount += 1`, adds a `pinToken`.
2. Analyze the query once (latency analyzer pool or inline analyzer, cached by analyzer identity + raw
   query + settings hash; `queryAnalysis`, `service.ts:533-579`).
3. Run positional retrieval over the pinned corpus snapshot via `SearchQueryScheduler.execute`
   (`service.ts:361-418`), which fans shard tasks onto the search-execution pool.
4. **Release** the pin in `finally` (`service.ts:356-358`). Release is **refcount-only** — it deletes
   the pin token and decrements `refCount`; no file deletion or GC happens on the query path
   (`snapshot-store.ts:869-877`).

A metadata-only search (tag filter, no query text) skips positional retrieval and scans document
metadata (`executeMetadataSearchFromSnapshotHandle`, `service.ts:323-331`).

### Vector / dense (`retrieval=vector`)

`DaemonSearchStoreService.retrieve` (`service.ts:245-334`) is the dense/hybrid entry. The order is
**lexical pin first, dense attach second, encode only if dense can contribute**:

1. **Pin the lexical corpus**: `store.pinLexicalReadContext` ensures and pins the active immutable
   corpus snapshot, loads live documents, and builds the live `contentHash` map
   (`service.ts:245-250`, `snapshot-store.ts:574-612`). It does **not** publish a retrieval snapshot or
   require dense freshness.
2. **Optionally attach dense**: `store.tryAttachDenseGeneration` validates the committed retrieval
   envelope, corpus/link sidecars, vector active pointer, vector metadata, embedding-space identity, and
   vector DB readability (`DaemonSnapshotStore.tryAttachDenseGeneration`). Failure records a dense
   signal such as `cold`, `rebuilding`, or `stale`; it is not itself a ranking gate.
3. **Resolve the origin vector**: `origin=text` encodes only when an attached dense generation is
   space-comparable and the selected mode consumes dense (`resolveRetrieveOriginVector` /
   `encodeRetrieveQueryVector`). When dense cannot contribute, `origin=text` stays vectorless and can
   still execute the lexical fallback. `origin=note`, `origin=pair`, and `origin=global` read stored
   vectors from the dense generation, masked against the live lexical `contentHash`; absent/stale source
   vectors return soft `index-not-ready` with `reason:"source-vector-missing"` and the dense signal.
4. **Search dense only when usable**: attached dense search uses the read lease's `searchVector`
   (`service.ts:431-454`). Vector-only shaping still applies path/tag filters and the per-doc
   `contentHash` mask before returning hits (`service.ts:456-528`).
5. **Fallback and release**: for `origin=text`, if dense does not contribute, even `retrieval=vector`
   falls through to the lexical execution path with the dense signal attached (`DaemonSearchStoreService.retrieve`).
   Stored-vector origins do not synthesize a query vector; missing source vectors return the soft
   not-ready result above. `releaseReadContext` releases the dense vector lease/GC pin, then the lexical
   pin, exactly once.

### Hybrid (`retrieval=hybrid`)

Hybrid follows the same lexical-first prefix. When dense contributes, `executeSearchWithPin` passes the
query vector, attached embedding set, dense search hits, and live content hashes to the search-execution
worker (`service.ts:287-304, 361-418`). Fusion happens **inside the search-execution worker**, not the
daemon: lexical, dense, and link-adjacency candidate sets are fused by **RRF** (`fuseCandidateSets`,
`search-execution.ts:33, 415-428`). Dense candidates are built only from attached dense hits whose
stored `record.contentHash` still matches the live lexical document hash
(`search-execution.ts:437-489`). For `origin=text`, if dense is cold, stale, rebuilding, unreadable, or
space-mismatched, hybrid is lexical/link only; ranking is not influenced by the dense signal field
itself. For `origin=note`, `origin=pair`, and `origin=global`, the source query vector must be a usable
stored vector from the attached generation or the response is soft `index-not-ready`.

> **DO** pin the lexical corpus before optional dense attach and before any query encode.
> **DON'T** treat dense freshness as a readiness gate; dense is an enrichment and the query only bumps
> and drops refcounts.

### Request admission, deadlines, cancellation

`SearchDaemon.handleRequest` validates protocol, incarnation, and deadline, registers the request
cancellation id, and runs through the scheduler. Default query deadline is
`SEARCH_DAEMON_DEFAULT_SEARCH_DEADLINE_MS = 3000` for `Retrieve` (`protocol.ts:60, 528-532`); a cold
lifecycle command gets a work-sized deadline `60s + 750ms·files + 5s·MiB`
(`vaultLifecycleDeadlineMs`, `protocol.ts:539-545`; applied client-side `client.ts:394-397`). A closed
RPC connection cancels its in-flight requests.

---

## 4. Cache & index lifecycle (the lifelines)

The search subsystem persists **four distinct artifacts**, each content-addressed and independently
GC'd.

### The four artifacts and their identities

| Artifact | Identity | Built by | On disk |
|----------|----------|----------|---------|
| **Lexical corpus snapshot** (segments + manifest) | `corpusSnapshotId` = hash of segment content-hashes + identity tuple | `buildCanonicalSearchSnapshot` (analyzer throughput pool) | `stores/<vaultHash>/{segments,snapshots}` |
| **Link-graph sidecar** | `linkGraphId` = `buildLinkGraphSidecar({corpusSnapshotId, edges})` | published with the corpus (`snapshot-store.ts:839-850`) | `stores/<vaultHash>/link-graphs` |
| **coral-needle vector generation** | `generationId = vectorGenerationIdForManifest(embeddingSpaceId, embeddingRecipeFreshnessId, corpusRevision, docIds/content hashes/projection hashes)` (`embedding-set.ts:223-247`); `embeddingSetId` remains the content hash over recipe + projected vectors (`embedding-set.ts:206-221`) | `vectorManager.buildStagingGeneration` → `promoteBuiltGeneration` | `vectors/stores/<profile>/<vaultHash>/<embeddingSetId>/generations` |
| **Composite retrieval snapshot** (envelope) | `retrievalSnapshotId` = `sha256(corpusSnapshotId, linkGraphId, embeddingSetId, retrieverPlanIdentity, rankingFeatureVersion)` (`snapshot-store.ts:2145-2159`) | `buildRetrievalSnapshotPublication` | `stores/<vaultHash>/retrievals` |

`retrieverPlanIdentity` folds the positional + dense + link-adjacency retrievers and the RRF fusion
parameters (`retrievalPlanIdentityFor`, `snapshot-store.ts:1823-1848`). `embeddingSpaceId` and
`embeddingRecipeFreshnessId` are additive sibling fields on vector metadata and retrieval envelopes
(`types.ts:129-147`, `vector-store/types.ts:74-86`); they are intentionally not folded into
`embeddingSetId` or `computeRetrievalSnapshotId` (`snapshot-store.ts:2145-2159`). Adding
`embeddingSpaceId` to the retrieval envelope did bump `SNAPSHOT_PERSISTENCE_SCHEMA_HASH`
(`types.ts:22-77`), so persisted retrieval envelopes self-heal once, but `INDEX_BUILD_VERSION` and
`ANALYZER_VERSION` do not change.

At read time, `tryAttachDenseGeneration` validates the committed retrieval envelope, lexical/link
sidecars, vector active pointer, vector generation metadata, embedding-space comparability, and DB
readability. For `origin=text`, a failure means lexical-only with a dense signal, not a failed retrieve.
For stored-vector origins, no usable source vector can be resolved, so the response is soft
`index-not-ready` / `source-vector-missing` with the same dense signal.

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

- **`LoadVault`** → `ensureIndexedSnapshot` → `refreshIndexedSnapshot` (`snapshot-store.ts:422-441,
  927-967`).
- **`Rebuild`** → always `publishFreshSnapshot(..., {prepareRetrieval:true})`
  (`snapshot-store.ts:443-454`).
- **`Refresh`** → `refreshIndexedSnapshot` (`snapshot-store.ts:463-473, 931-967`): computes a **content delta**
  (sha256 per file vs stored `contentHash`, `snapshotContentDelta`); if `changedCount === 0` it keeps
  the active snapshot and only ensures the retrieval snapshot matches
  (`prepareRetrievalSnapshotForSnapshot`); otherwise it reports the delta
  (`reportRefreshDelta`, `snapshot-store.ts:2609-2617`) and rebuilds the whole snapshot. **The
  delta only decides rebuild-vs-not; there is no incremental segment patching.**
- **`publishSaveSnapshot`** (`snapshot-store.ts:456-461`): save-on-write entrypoint. It runs the same
  canonical full lexical rebuild as refresh/rebuild, but tags embedding work with the scheduler `save`
  lane and prepares a retrieval publication for the new corpus revision.
- **`publishFreshSnapshot`** (`snapshot-store.ts:985-1045`): builds the corpus, kicks off the retrieval
  publication (embedding + vector build) **concurrently**, publishes the corpus + flips the corpus
  active pointer, then awaits and publishes the retrieval snapshot.
- **`publishBuiltSnapshot`** (`snapshot-store.ts:1063-1136`): stores the link-graph sidecar, writes +
  fsyncs + content-verifies each segment (skips segments already present with matching hash), writes
  the manifest, **durable-renames the active pointer**, then `recoverVault` + `markSweepGc`. All
  writes are temp-file + fsync + rename.
- **`buildRetrievalSnapshotPublication`** (`snapshot-store.ts:1150-1290`): builds the embedding set
  (`embeddingSetBuilder.build`, `:1156`) → computes `embeddingSpaceId`, recipe freshness id, and
  manifest-addressed `generationId` (`:1164-1185`) → builds a **staging** vector generation and
  **promotes** it (`vectorPool.buildStagingGeneration` + `promoteBuiltGeneration`, `:1205-1216`) →
  constructs the retrieval envelope with `embeddingSpaceId`, `embeddingRecipeFreshnessId`, and
  `freshness:{state:"fresh", corpusRevision: corpusSnapshotId}`.
- **`publishRetrievalSnapshotPublication`** (`snapshot-store.ts:1292-1317`): stores the envelope,
  writes freshness `markFresh`, durable-renames the **retrieval** active pointer, `markSweepGc`.

Embedding happens on load/rebuild/refresh and on save-on-write. Save-on-write is intentionally a
debounced **full lexical rebuild** followed by dense generation for that exact lexical revision; true
incremental lexical patching is deferred (§6).

### Vector generation swap (drain by refcount)

Promotion flips the active pointer and retires the old generation without disrupting in-flight readers
(`VectorGenerationPool`, `vector-store/pool.ts`). The process-scoped `VectorGenerationManager`
extends that pool but keeps handles keyed by profile/vault/embedding set/generation
(`embed-scheduler.ts:18-20`, `profile-manager.ts:101-153`). `pinReadableGeneration` first reuses an
active in-memory handle, then lazy-opens a committed active generation after daemon restart if needed
(`pool.ts:240-280`).
Concurrent lazy-opens for the same `(key, generationId)` are single-flighted by `lazyOpenByGeneration`
(`pool.ts:95, 352-368`). A pinned old generation stays open until its last reader drains; a read context
releases the vector lease and GC pin before releasing its lexical pin (`snapshot-store.ts:741-750`).

### Freshness state machine

`RetrievalFreshnessStore` (`vector-store/freshness.ts`) persists `retrieval-freshness.json` with state
`fresh | dirty | building | failed` (`freshness.ts:8`). Transitions remain `markDirty` (`:60`),
`markBuilding` (`:71`), `markFresh` (`:82`), and `markFailed` (`:92`), with startup reconciliation for
stale `building` records (`:104-137`). Freshness is no longer a read-path gate. It feeds only the
reported retrieve signal:

- `cold`: no committed readable dense generation attached to the lexical pin.
- `rebuilding`: embedding space mismatch or persisted freshness is `building`.
- `stale`: space matches, no build is in flight, but at least one live lexical document is absent/masked
  by `contentHash`, or freshness is `failed`.
- `fresh`: space matches and every live lexical document has usable dense coverage.

The derivation lives in `denseSignalForUsability` (`snapshot-store.ts:2295-2310`). `pendingCount` is the
number of absent/masked live documents, and `generationAgeMs` is computed from vector generation
metadata (`snapshot-store.ts:2312-2316`). The signal is returned on ready and soft-not-ready retrieve
responses (`types.ts:176-220`) and is never part of scoring.

### Garbage collection — background, refcount-gated

`markSweepGc` (`snapshot-store.ts:1426-1429`) → `queueGc` schedules a **background** sweep on
`setImmediate(...)` + `unref()` (`:1502-1519`), serialized per vault. `runBackgroundGc`
(`:1521-1526`) runs `markSweepSearchGc` (retrieval envelopes, snapshots, segments, link graphs) →
`markSweepVectorGc` (vector generation dirs, then empty store roots) → stale-tmp sweep.

**GC roots** (`gcRootsAsync`, `snapshot-store.ts:1431-1487`) are refcount- and in-flight-gated: the
active corpus + active retrieval and their transitive artifacts, everything in the in-flight publish
sets, **loaded snapshots with `refCount > 0`**, the newest `retentionCount` snapshot + retrieval files,
and **pinned vector generations** (`pinnedVectorGenerations`, incremented per retrieval pin,
`:1623-1646`). So a pinned or in-flight artifact always survives. Stale vector generations that are not
a GC root are removed (`markSweepVectorGc`, `:1564-1608`); an empty vector store root is deleted and
removed from the `VectorCacheCatalog`.

**Retention** (`retentionCount`) defaults to `2` in the running daemon — `ProfileManager` passes
`normalized.cache.snapshotRetention` (`runtime-profile.ts:98`, default 2; env
`OPTSIDIAN_SEARCH_SNAPSHOT_RETENTION_COUNT`) into `createDaemonSnapshotStore`
(`profile-manager.ts:95`). The store's own fallback when constructed without that option is
`DEFAULT_RETENTION_COUNT = 8` (`snapshot-store.ts:245, 293-297`). In-memory loaded-snapshot budgets
are separate: count cap and byte cap (`enforceBudget`, evicts only `refCount === 0`, LRU;
`snapshot-store.ts:1407-1424`).

**Manual GC**: `Prune` (`SearchCacheCatalog.prune`) removes store directories unused for
`unusedDays` (default in catalog), skipping store ids protected by any live pin
(`profile-manager.ts:270-290`).

**Vector dedup**: there is **no per-vector deduplication before build** —
`vectorChunksForEmbeddingSet` maps 1 record → 1 chunk (`snapshot-store.ts:2209-2223`). "Dedup" in this
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

1. Client `ensureReady` finds no usable owner and detaches `node <bin> __search-daemon`.
2. Daemon binds the single socket, writes the tenancy record with a fresh `incarnationId` and monotonic
   `epoch`, constructs the runtime, and transitions from `starting` to `ready`. Clients wait through
   `WaitReady` rather than polling.
3. Lexical `search` → `Search` RPC → `store.pin` builds the corpus snapshot on first touch
   (`ensureActiveSnapshot` → `publishFreshSnapshot`), warms one search-execution worker on that
   snapshot, then runs the positional query (`service.ts:294-358`).
4. Pin released refcount-only; a background GC is queued (`markSweepGc` on publish).

### (b) Note edit → save producer → lexical publish → dense attach

A profile/vault runtime starts one `VaultChangeProducer` when a vault is known
(`profile-manager.ts:161-174`). The producer coalesces `.md` file changes into dirty marks and falls
back to periodic content-delta scanning when native watch registration fails (`watcher.ts:42-274`).
Dirty marks enqueue `publishSaveSnapshot` on the scheduler `save` lane (`profile-manager.ts:205-223`).

The save lane performs a debounced **full lexical rebuild** through the canonical
`buildCanonicalSearchSnapshot` → `publishBuiltSnapshot` path, reusing unchanged segment bytes/hashes on
disk (`snapshot-store.ts:456-461, 985-1136`). Dense generation is then built and promoted for the same
lexical corpus revision (`snapshot-store.ts:1150-1317`). During the gap, reads pin the new lexical
revision and changed/new docs simply ride lexical-only because their dense records are absent or
`contentHash`-mismatched.

### (c) `origin=text` hybrid query — model cold vs warm

- **Warm and dense usable**: `retrieve` pins lexical, attaches dense, encodes the query from the live
  model session, searches the attached vector lease, RRF fuses in the worker, and releases the read
  context (`service.ts:245-334`).
- **Model cold but dense usable**: `origin=text` encode triggers `ensureSession` -> `pickDevice` (CPU by
  default) -> `startLoad` -> session cached -> `armIdleUnload` (`lifecycle.ts:69-89`). Query encodes
  are single-flighted by the scheduler (`embed-scheduler.ts:104-140`).
- **Dense cold/stale/rebuilding/unreadable**: no model load is attempted for `origin=text`; the query is
  served lexical/link-only with `dense.state` explaining why dense did not contribute
  (`resolveRetrieveOriginVector`).

### (d) Generation swap while a query is in flight

1. Query A pins lexical and attaches dense through `pinReadableGeneration`, which returns a vector
   lease for the committed generation (`snapshot-store.ts:614-739`, `pool.ts:240-280`).
2. A `Rebuild`, `Refresh`, or save-lane build promotes a new generation. The manager keeps handles
   separate by vector key and generation id, and old handles drain by refcount (`pool.ts:88-99,
   240-280`).
3. Query A's `searchVector` on the old lease completes; `releaseReadContext` drops the vector lease/GC
   pin and lexical pin (`snapshot-store.ts:741-750`). Query B can attach the new generation. No query
   ever reads a half-closed index.

### (e) Model idle-unload

After the last encode, `armIdleUnload` schedules `unload` at `idleMs` (5 min default) on an `unref`'d
timer; when it fires the session closes and VRAM/CPU memory is released
(`lifecycle.ts:86, 336-352`). The **daemon stays up** — only the model session is freed. A later
encode re-loads on demand.

### (f) Daemon restart with a dirty index

1. New daemon binds the single owner socket, proves the previous holder is not listening when needed,
   increments the slot epoch, and writes a fresh tenancy record.
2. On the next lifecycle/query, `recoverVault` validates the corpus active pointer and drops it if the
   manifest is missing, then queues a background GC (`snapshot-store.ts:1395-1403`).
3. The daemon schedules startup recovery after `phase = "ready"`: `startupReconcile` demotes stale
   `building` records, re-marks matching published records as `fresh`, and `recoverRetrievalStaging`
   sweeps orphan vector/link/lexical staging.
4. The first retrieve after restart can still attach an on-disk committed dense generation even if no
   in-memory vector handle exists: `pinReadableGeneration` validates the active pointer and metadata,
   then lazy-opens the generation with single-flight protection (`pool.ts:240-280, 352-368`).

---

## 6. Known follow-ups

1. **True incremental lexical rebuild is deferred.** Save-on-write currently performs a debounced full
   lexical rebuild and relies on `publishBuiltSnapshot` to reuse unchanged segment hashes/bytes on disk
   (`snapshot-store.ts:456-461, 1063-1136`). That is coherent with the dense generation for the same
   corpus revision, but it still reparses the full corpus. A future true-incremental lexical builder
   must preserve the canonical full-rebuild identity exactly: global link resolution, global BM25
   reduction, reused segment decoding, affected partition selection by `partitionIdForDocument`, and a
   determinism gate proving incremental output has the same `retrievalSnapshotId` and `linkGraphId` as a
   full rebuild of identical content.
