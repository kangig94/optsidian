# Agent System

## Agent Quick Reference

| Agent | Tier | Model | Purpose |
|-------|------|-------|---------|
| vault-safety-guardian | 1 | opus | Vault mutation safety — atomic writes, patch/edit correctness, frontmatter byte-preservation, path-boundary enforcement |
| contract-guardian | 2 | sonnet | CLI + MCP + native-first contract integrity |
| search-guardian | 2 | sonnet | Search correctness, index identity/versioning, daemon lifecycle |
| code-critic | 3 | sonnet | Code quality review (elegance, complexity, coverage) |
| doc-critic | 3 | sonnet | Documentation quality review |
| test-critic | 3 | sonnet | Test quality review |

`tier-review` also adds `coral:architect` as a tier-1 reviewer by default.

## Consultation Matrix

| Task Type | Mandatory Agent | Recommended Agent |
|-----------|-----------------|-------------------|
| Edit a core mutator or path/access (`src/core/{write,write-file,edit,apply-patch,frontmatter,copy,mkdir,path,vault-access,validation}.ts`) | vault-safety-guardian | code-critic |
| Change the native-first policy, command surface, or CLI adapters (`src/cli/**`) | contract-guardian | doc-critic (if docs change) |
| Add/modify an MCP tool (`src/mcp/**`) | contract-guardian | — |
| Edit the search subsystem or Korean analysis (`src/core/search/**`, `src/core/kiwi/**`) | search-guardian | code-critic |
| Any implementation change | code-critic | — |
| Documentation generated or modified | doc-critic | — |
| Tests written or modified | test-critic | — |

## Roster Rationale

The roster is built from this project's actual failure modes (concern → severity → agent), not a
generic plugin template:

- **vault-safety-guardian** (tier 1) — corrupting or escaping the user's vault is irreversible data
  loss / a security issue, so it routes to opus. It owns both write-atomicity *and* path-boundary
  enforcement because both live on one mutation path (`resolveVaultPath` → core mutator → atomic
  temp+rename); a single guardian reviewing that path is better than two re-reading the same files.
- **contract-guardian** (tier 2) — a diverged CLI/MCP/native-first contract is a bug, not data loss.
- **search-guardian** (tier 2) — incorrect search results / a stale index / a leaked daemon are bugs.
  It also owns daemon lifecycle, since the daemons exist only to serve search.

**Deliberate omissions:**
- **ux-critic** — not created. There is no GUI/visual surface; "UX" here means CLI/MCP output
  contracts, which contract-guardian owns.
- **path-traversal agent** — not created; covered by vault-safety-guardian (same mutation path).
- **daemon-lifecycle agent** — not created; covered by search-guardian.

## Design Principles

### Fresh Context for Verification

When verifying work output, spawn a dedicated subagent instead of self-verifying.

**Why**: The producing agent accumulates context bias through planning, decision-making, and execution — it is predisposed to confirm its own output. A fresh subagent has no prior commitment to the result.

**Pattern**:
- Producer agent generates output (files, plans, code)
- Verifier subagent receives only: inputs (requirements, analysis) + outputs (generated files)
- Verifier has a single goal: do the outputs satisfy the inputs?
- One goal, clean context, higher accuracy

**Anti-pattern**: Agent generates artifacts → same agent "spot-checks" its own work → confirmation bias → defects pass through.

### Shared-Worktree Safety

Parallel review/guardian agents share one working tree but not commit isolation. A default Bash-capable agent that sees unfamiliar changes will try to "tidy up" with `git checkout` / `git stash` / `git reset` — silently reverting every sibling's in-progress work.

**Rule**: every prompt that spawns an agent into a shared worktree MUST forbid state-changing git. Reviewers are read-only — no `git checkout` / `switch` / `stash` / `reset` / `restore` / `clean`, no staging, no committing. To inspect another revision, use read-only git (`git diff <ref>`, `git show <ref>:<path>`, `git log <ref>`) instead of checking it out.

**Enforcement**: the `tier-review` skill embeds this guard in every Phase 3 spawn prompt. Any new parallel-spawn site (skills, orchestrators) MUST carry the same guard. A single `git checkout` in a shared tree reverts all concurrent agents' work — treat the omission as a defect, not a style choice.
