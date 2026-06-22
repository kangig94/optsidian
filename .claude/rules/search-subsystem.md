---
paths:
  - "src/core/search/**"
  - "src/core/kiwi/**"
---
# Search Subsystem

The search subsystem is Orama full-text indexing plus Kiwi Korean morphology, served behind two
background daemons. Its iron law is **identity versioning**: anything that changes index contents
must make stale indexes detectable.

## Principles

- **Version on any index-affecting change.** Touching the analyzer, the token channels (`morph` / `surface` / `ngram`), the indexed field set, or the ranking in a way that alters what gets stored requires bumping `SEARCH_SCHEMA_VERSION` and/or the analyzer/cache identity. An index built under an old identity must not be served as if current.
- **Three paths must agree.** The persisted on-disk index, the in-memory overlay for small recent diffs, and live analysis all feed the read-time planner. A change to analysis must update all three consistently, or results diverge by which path served them.
- **Two daemons, not three.** `__analyzer-daemon` (`analyzer.ts`) reuses the Kiwi WASM across CLI invocations; `__index-daemon` (`warm-daemon.ts`) warms recently-accessed vaults. Reconcile work runs under mkdir-based locks — it is not a daemon. Daemon changes must preserve the socket protocol version (encoded in the socket name), the lock discipline, and the idle-shutdown cleanup.
- **Kiwi is standalone.** `kiwi/*` loads and leases the WASM analyzer and downloads the SHA256-pinned model artifact; it must not import `search/*`.

## DO / DON'T

| DO | DON'T |
|----|-------|
| Bump `SEARCH_SCHEMA_VERSION` / analyzer identity when index contents change | Change tokenization and reuse an existing on-disk index |
| Update persisted + overlay + live analysis together | Fix one retrieval path and let the others drift |
| Version the socket name when the daemon protocol changes | Change the request/response shape on the existing socket name |
| Keep `kiwi/*` free of `search/*` imports | Reach into search ranking from the Kiwi loader |
| Release locks and honor idle-shutdown on every exit path | Leave a writer lock or daemon socket behind on error |
