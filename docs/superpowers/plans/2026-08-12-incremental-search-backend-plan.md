# Incremental Search Backend Implementation Plan

**Goal:** Replace heap-resident brute-force search and full-snapshot persistence with a recoverable, incrementally maintained LanceDB search projection while preserving iii/KV as the source of truth.

**Design:** `docs/superpowers/specs/2026-08-12-incremental-search-backend-design.md`

## Task 1: Capture baselines and protect production

- Record source totals, current index totals, current process memory, query latency, and current configuration without secrets.
- Add a production migration lock that blocks legacy rebuild/repair during shadow migration.
- Verify the existing backup and rollback worker command before changing runtime configuration.

## Task 2: Fix query failure semantics with TDD

- Add failing tests proving an MCP proxy timeout cannot become `{ results: [] }`.
- Add failing tests for long multi-word Chinese and English query handling.
- Make the proxy timeout configurable and propagate a structured timeout/degraded response.
- Preserve lexical results when only embedding/vector retrieval fails.

## Task 3: Fix resource health semantics with TDD

- Add failing tests for a one-core-saturated process on a multi-core host.
- Add failing tests proving `heapTotal` growth is not itself a critical-memory signal.
- Normalize health CPU by logical processor count.
- Evaluate heap pressure against V8 heap limit and report RSS/host-memory diagnostics.
- Update viewer labels and API fields without breaking existing consumers.

## Task 4: Introduce the search backend contract

- Add backend-neutral record, hit, status, and query types.
- Wrap the existing BM25/vector implementation as the legacy backend.
- Route hybrid search through the backend contract while keeping `legacy` as default.
- Add contract tests shared by backends.

## Task 5: Implement LanceDB storage

- Add the pinned LanceDB Node dependency and Windows native package lock data.
- Create the Lance table schema for ID, source version, searchable text, filters, timestamp, and vector.
- Implement bounded merge-insert/upsert and delete batches.
- Implement lexical and ANN queries plus filtering.
- Add table/version/fragment status and explicit close/flush behavior.
- Verify against a temporary on-disk database before production wiring.

## Task 6: Implement durable incremental synchronization

- Add the search mutation journal KV scope and types.
- Write journal-before-source helpers for observation upsert/delete paths.
- Add a 100-record/250-ms deduplicating microbatch queue.
- Replay pending entries idempotently on startup.
- Add bounded resumable reconciliation and status reporting.
- Add crash-point tests covering journal-only, source-only, and applied-but-unacknowledged states.

## Task 7: Implement shadow build and comparison

- Add a resumable bulk builder that streams source observations without constructing another full-corpus copy.
- Keep live mutations in the journal during the build and drain them before declaring the generation ready.
- Add shadow-query sampling and normalized rank/result comparison metrics.
- Add migration status and control endpoints without exposing destructive defaults.
- Prevent legacy rebuild/repair from running while shadow migration is active.

## Task 8: Validate on production data without cutover

- Build the Lance projection under a new directory.
- Verify record counts, checksums, filters, and pending journal count.
- Benchmark single-word, multi-word Chinese, multi-word English, cross-language, project-filtered, and recent-record queries.
- Measure ANN Recall@10, hybrid nDCG@10, P50/P95/P99, RSS, heap, CPU, disk growth, and indexing freshness.
- Leave legacy authoritative if any acceptance threshold fails.

## Task 9: Cut over and verify persistence

- Create a fresh pre-cutover backup.
- Switch to `lance`, set legacy persistence to `manual`, rebuild, and restart under the watchdog.
- Verify source totals, Lance totals, pending journal zero, health, multi-word recall, and recent hook ingestion.
- Perform a second controlled restart and repeat the checks.
- Retain the last legacy snapshot and documented one-command rollback.

## Task 10: Reclaim obsolete derived storage and finish

- After the stability window, logically delete obsolete iii legacy index generations.
- Verify whether physical storage is reusable or reclaimable.
- If physical shrink is required, export authoritative scopes, build a clean store, validate totals/checksums, and atomically swap with the old store retained.
- Run focused tests, full unit tests, typecheck/build, TODO scan, git status/diff review, and runtime smoke tests.
- Commit and push narrowly scoped changes to `main`.
