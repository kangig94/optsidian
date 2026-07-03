---
paths:
  - "src/core/search/**"
  - "src/core/kiwi/**"
  - "src/daemon/**"
---
# Search Subsystem

Search is a purpose-built **positional** inverted index plus Kiwi Korean morphology, served by one
long-running `search-daemon`. Its iron law is **deterministic identity**: results are a pure function
of `(snapshot id, query, filters, limit, ranking version, ranking tuning hash, analyzer identity)`, and a stale or
non-canonical index must be detectable. Latency may vary; results may not.

## Principles

- **One daemon, not three.** A single per-user, per-runtime `search-daemon` serves every vault over framed RPC. There is no analyzer daemon, no index-warm daemon, no foreground `searchVault` fallback, and no read-path reconcile. CLI and MCP are thin RPC clients that auto-start the daemon, wait for ready, and fail clearly if it cannot — never an in-process search.

- **One immutable snapshot, not three drifting paths.** A search pins exactly one immutable snapshot for the request's full lifetime; background indexing builds a new snapshot and commits a new edition to the append-only ledger (MVCC). The ledger head is the active snapshot. There is no overlay / persisted / live merge to keep "in agreement" — readers never block writers, and a rebuild during a search cannot change that request's pinned snapshot.

- **Content-addressed, canonical identity.** `snapshot id = hash(segment content-hashes + identity tuple)` — content-true, not an mtime/size proxy. Rebuilding identical logical content yields byte-identical segments (stable byte order, fixed integer encoding, canonical floats). The identity tuple carries every index-affecting input — build version (segment encoding + partition scheme + engine + identity normalizer), field-set version, partition bits, analyzer identity, search settings, ranking-feature version — plus a reserved `retrieverIdentity` slot. Any change to indexed contents flows into this id; an index built under an old identity must never be served as current.

- **Positional postings are the one primitive.** `term → [(docId, fieldId, [positions])]` is the only stored structure. Phrase is consecutive positions and proximity is within-window-k — *traversal*, not separate stored side indexes; ngram is an analyzer channel feeding the same postings. Position/phrase reconstruction at query time is forbidden — the engine reads positions, it does not re-tokenize document lines.

- **Pure core, daemon owns the shell.** `core/search/*` is raw-in / structured-out behind a single `SearchEngine` surface (`search` / `explain` / `snippetsFor`); `src/daemon/*` owns all process I/O (socket, snapshots, worker pools, watcher, lifecycle) as an L3 adapter peer of `cli/` and `mcp/`. Search reaches the core only through RPC — a policy/lint invariant (the search core is not re-exported through the adapter barrel), not a layer hop. Core never imports adapters.

- **Two analyzer pools by lifecycle.** An always-warm **latency pool** (query analysis only) and a **throughput pool** (index / rebuild / compaction), each a `worker_threads` pool with one leased Kiwi instance per worker. Indexing has no API to enqueue on the latency pool, so it physically cannot starve search. No concurrent calls into one Kiwi instance; failed workers are retired and replaced.

- **Snippets come from the snapshot.** A span-addressed snippet store — line entries keyed by `(segmentId, lineNo)` with byte offsets + precomputed channel term-sets, with paragraph/section as a derived view — is built at index time; query-time snippet selection is lookup + scoring. Search never rereads matched files or tokenizes lines.

- **Kiwi is standalone.** `kiwi/*` loads and leases the WASM analyzer and downloads the SHA256-pinned model artifact; it must never import `search/*`. Each analyzer worker leases exactly one Kiwi instance.

## DO / DON'T

| DO | DON'T |
|----|-------|
| Fold every index-affecting input into the snapshot id (incl. builder + ranking version) | Change what gets indexed and serve an existing snapshot id as current |
| Pin one immutable snapshot per request; commit a new ledger edition atomically | Mutate active reader state, or merge overlay / persisted / live paths |
| Emit canonical bytes — stable order, fixed ints, canonical floats | Reproduce old persist→restore divergence with non-canonical encoding |
| Serve phrase/proximity by reading positions from the postings | Reconstruct positions/phrases from a split token stream at query time |
| Reach the search core only via daemon RPC | Call the search core in-process or re-export it through the adapter barrel |
| Route query analysis to the latency pool, indexing to the throughput pool | Let a rebuild enqueue on the latency pool and starve search |
| Serve snippets from the snapshot store | Reread matched files or retokenize lines at search time |
| Keep `kiwi/*` free of `search/*` imports; one leased Kiwi per worker | Reach into search from the Kiwi loader, or share one Kiwi instance across concurrent calls |
