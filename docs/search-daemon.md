# Search Daemon Architecture

Optsidian search is served by one daemon and one lexical engine. CLI and MCP search/index commands
are RPC clients; there is no direct in-process search fallback.

## Current Shape

```text
CLI / MCP
  |
  | daemon RPC
  v
Search daemon
  |-- owner registry and nonce-authenticated socket
  |-- vault state machines
  |-- immutable snapshot store
  |-- query-analysis cache
  |-- query analyzer worker pool
  |-- index analyzer worker pool
  |-- search-execution worker pool
  |-- positional retriever
  |-- deterministic reranker
  |-- snippet and feature store
```

The daemon serves multiple vaults. Each vault is identified by canonical realpath and the current
search identity. A vault moves through `unloaded -> loading -> ready -> updating -> ready`, or to
`failed` when loading/indexing cannot complete.

## RPC

The daemon protocol is MessagePack framed RPC with a protocol version, request id, request nonce,
deadline, and method. The current method set is:

```text
Search
Explain
Status
LoadVault
Rebuild
Refresh
Compact
Clear
Shutdown
```

The shared client starts the daemon when needed, waits for readiness, authenticates the owner nonce,
and fails clearly if the daemon cannot serve the request.

## Snapshot Model

Search reads from immutable snapshots. A snapshot id is the hash of the canonical snapshot manifest.
The manifest covers segment hashes, live-document manifest hash, tombstones, and the identity tuple:

- schema version
- field-set version
- partition version
- analyzer identity
- search settings hash
- index builder version
- ranking feature version
- retriever identity

Index work builds a new snapshot and publishes it by durable active-pointer swap. Requests pin the
snapshot they read, so rebuilds and refreshes cannot change result ordering mid-request. Garbage
collection keeps active, in-flight, pinned, and retained snapshots.

## Positional-Only V1

V1 retrieval is lexical and positional only. Each snapshot stores:

- document metadata
- snapshot-resident canonical field text
- analyzer token channels per field
- positional postings
- per-field term statistics
- line snippet data
- identity/tag/path/title feature payloads
- build diagnostics outside snapshot identity

Postings are the single retrieval primitive: `term -> doc -> field -> positions`. Phrase matching,
proximity, rarity, coverage, snippets, and debug evidence are derived from postings and snapshot
feature payloads. Korean ngram terms are analyzer-channel terms that feed the same postings, not a
separate side index.

Exact and phrase identity tiers are preserved in `ranking/identity.ts` and operate over
snapshot-resident canonical field text.

## Worker Pools

Analyzer parallelism comes from isolated worker pools:

- query workers: latency-sensitive query analysis
- index workers: throughput-oriented snapshot builds
- search-execution workers: cancellation/deadline-aware retrieval and ranking

Settings:

- `search.queryWorkers`
- `search.indexWorkers`
- `search.snapshotRetentionCount`
- `search.queryCacheSize`
- `search.memoryBudgetCount`
- `search.memoryBudgetBytes`
- `search.daemonIdleMs`
- `search.extraLangs`
- `search.analyzer`

Timeouts are request/RPC-level policy. The daemon idle policy is process-level policy.

## Future Retrieval

Vector, learned-sparse, and hybrid retrieval are not part of v1. Any future retriever must be
versioned in snapshot identity, publish deterministic feature payloads, and keep positional lexical
retrieval as an explainable baseline.

## Operational Invariants

- CLI and MCP use the same daemon API.
- Search does not reread matched files to produce snippets.
- Search does not reconstruct proximity or rarity from files at query time.
- Same-query concurrent search returns identical paths and snippets for a pinned snapshot.
- Rebuild during search does not alter the pinned request result.
- Daemon restart reloads the latest valid snapshot.
- Debug output identifies snapshot id, analyzer identity, channels, retrieval score, ranking score,
  proximity, rarity, coverage, and snippet source.
