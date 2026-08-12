# Incremental Search Backend Design

**Date:** 2026-08-12  
**Status:** Approved for implementation

## Problem

AgentMemory currently treats its in-process BM25 and dense-vector structures as both the live search engine and a durable index. At the current production scale (about 205,000 observations with 2,560-dimensional vectors), that creates three coupled failures:

1. Dense search scans every vector in JavaScript for every query.
2. BM25 keeps nested `Map`/`Set` structures for the full corpus on the V8 heap.
3. A single mutation schedules serialization of both full indexes into iii state storage.

The result is multi-gigabyte steady-state memory, single-core CPU saturation on long queries, large transient copies during persistence, repeated full-write amplification, and queries that can finish in the worker after the MCP caller has already timed out and returned an empty result.

The iii state store contains authoritative memories, sessions, observations, lessons, and graph data. Search indexes are derived data and must not be allowed to dictate the durability or availability of the facts they index.

## Goals

- Keep the existing iii/KV data model as the only source of truth.
- Replace heap-resident brute-force search with a disk-backed, incrementally maintained search projection.
- Make every acknowledged source mutation recoverable even if search indexing fails or the process crashes.
- Preserve hybrid lexical/semantic behavior and project/agent filters.
- Return explicit timeout or degraded-mode information; never turn an execution failure into a valid empty result.
- Make migration reversible without rebuilding or rewriting production facts.
- Correct resource health calculations so a busy core is not reported as whole-machine CPU exhaustion and V8 heap headroom is not inferred from the current committed heap size.

## Non-goals

- Replacing iii/KV with LanceDB.
- Changing memory extraction, summarization, reflection, lessons, graph, or crystal semantics.
- Deleting the current persisted indexes before the replacement has passed restart and recall validation.
- Running another legacy all-or-nothing index rebuild.

## Architecture

### Source of truth and derived projection

The iii state store remains authoritative. LanceDB is stored outside the iii state store under the configured AgentMemory data directory and is always treated as disposable, rebuildable derived data.

The search layer exposes one internal contract:

```ts
interface SearchBackend {
  upsertBatch(records: SearchRecord[]): Promise<void>;
  deleteBatch(ids: string[]): Promise<void>;
  lexicalSearch(query: string, limit: number): Promise<SearchHit[]>;
  vectorSearch(vector: number[], limit: number): Promise<SearchHit[]>;
  status(): Promise<SearchBackendStatus>;
  flush(): Promise<void>;
  close(): Promise<void>;
}
```

The existing in-memory implementation is retained as a rollback adapter during migration. The new Lance implementation owns the searchable text, metadata, and vector columns, but not the full source record.

### Durable mutation journal

Search writes use a durable journal in iii/KV:

1. Persist a pending `upsert` or `delete` journal entry.
2. Commit the authoritative source mutation.
3. Enqueue the search mutation in memory.
4. Apply queued mutations to LanceDB in a bounded microbatch.
5. Mark the journal entry complete only after the LanceDB commit succeeds.

An entry written without a corresponding source mutation is harmless: replay re-reads the source and discards or converts it to the correct current operation. An entry whose source mutation committed but whose indexing did not is replayed at startup. All operations are idempotent by observation ID and source version.

Startup also performs a bounded reconciliation pass so legacy write paths or journal gaps cannot silently create permanent search omissions. Reconciliation is resumable and never blocks the source API from starting.

### Incremental write path

Mutations are deduplicated by record ID and flushed when either threshold is reached:

- 100 unique records, or
- 250 milliseconds since the first queued mutation.

Batch application uses Lance merge-insert/upsert semantics. This avoids creating one fragment/version per observation. Compaction and index optimization are maintenance operations triggered by measurable fragment or version thresholds, not by every write.

### Query path

Hybrid search executes lexical and vector retrieval against the same Lance table, applies existing filters, and combines ranked lists with reciprocal-rank fusion. Source records are fetched only for the bounded result set.

The query budget is split explicitly:

- embedding budget,
- lexical/vector retrieval budget,
- result hydration budget.

If semantic retrieval fails but lexical retrieval succeeds, the response is marked degraded and returns lexical results. If the whole operation exceeds its budget, the caller receives a structured timeout error. A timeout is never represented as `results: []`.

### Shadow migration

Migration has four states:

1. `legacy`: existing search is authoritative.
2. `shadow-build`: live mutations are journaled while Lance is bulk-filled from source data.
3. `shadow-query`: legacy results are returned while both engines are queried and compared.
4. `lance`: Lance results are authoritative; legacy snapshots remain read-only rollback artifacts.

Cutover requires all acceptance criteria below. Switching is a configuration change followed by a controlled restart. Rollback switches the configuration to `legacy` and restarts; no source data migration is involved.

### Legacy persistence

While `legacy` is authoritative, its persisted snapshots remain enabled. After successful Lance cutover, automatic full legacy snapshot serialization is disabled. The last verified legacy snapshot is retained for rollback but receives no per-mutation rewrites. This removes the current write-amplification path without weakening source durability.

### Health semantics

- Process CPU is retained as core-equivalent utilization for diagnostics.
- Health CPU uses process CPU divided by available logical processors and is capped at 100%.
- Heap pressure uses V8 `heap_size_limit`, not `heapTotal`.
- RSS is reported as an absolute diagnostic and as a fraction of host memory; it does not independently make the service critical merely because the searchable corpus is large.
- Search status reports backend, pending journal count, last applied mutation, fragment count, index freshness, and degraded reason.

## Configuration

```env
AGENTMEMORY_SEARCH_BACKEND=legacy|shadow|lance
AGENTMEMORY_LANCE_PATH=C:/Users/dingx/.agentmemory/data/search.lance
AGENTMEMORY_SEARCH_BATCH_SIZE=100
AGENTMEMORY_SEARCH_BATCH_MS=250
AGENTMEMORY_SEARCH_TIMEOUT_MS=30000
AGENTMEMORY_SEARCH_SHADOW_SAMPLE_RATE=1
AGENTMEMORY_LEGACY_INDEX_PERSISTENCE=auto|manual
```

Defaults preserve existing behavior until migration is explicitly enabled.

## Failure handling

- Lance unavailable: source writes continue, journal grows, health becomes degraded, and startup/retry drains the backlog later.
- Embedding unavailable: text is still journaled; lexical indexing proceeds and vector enrichment remains pending.
- Process crash during bulk build: existing Lance generation remains untouched; resumable build metadata identifies the last completed source page.
- Process crash during incremental batch: uncompleted journal entries replay idempotently.
- Shadow mismatch: no cutover; legacy remains authoritative.
- Cutover regression: set backend to `legacy`, restart, and use the retained verified snapshot.

## Acceptance criteria

- Source totals remain consistent across migration and restart.
- A newly acknowledged observation is searchable within 2 seconds at P99.
- No mutation triggers serialization of the full legacy BM25 or vector corpus after Lance cutover.
- Full AgentMemory idle resident-memory increase attributable to search is at most 2 GB.
- Per-query additional peak memory is at most 512 MB.
- P95 hybrid query latency is at most 100 ms and P99 at most 250 ms after warm-up on the production corpus, excluding external embedding latency; end-to-end latency is reported separately.
- False-empty responses caused by timeouts are zero.
- ANN Recall@10 is at least 97% against sampled exact dense search.
- Hybrid nDCG@10 loses no more than 1% against the exact dense plus corrected lexical baseline.
- Shadow count/checksum reconciliation has no unexplained missing records.
- Two controlled restarts preserve counts, query behavior, and a fully drained mutation journal.
- The Lance directory can be removed and rebuilt without changing source totals.

## Disk reclamation

Old iii index scopes are deleted only after cutover, two restart validations, and a fresh backup. If iii storage does not physically shrink after logical deletion, source data is exported into a new clean store without derived index scopes and atomically swapped while the old store is retained as rollback. This is a separate final migration step and is never combined with search cutover.
