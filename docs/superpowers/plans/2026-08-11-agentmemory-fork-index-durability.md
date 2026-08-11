# AgentMemory Fork and Index Durability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish `Xuleileon/agentmemory`, run it from `E:\agentmemory`, and make BM25/vector indexing durable, observable, rebuildable, and stable across process restarts.

**Architecture:** All index mutations flow through shared indexing helpers and a generation-based, single-flight `IndexPersistence`. Maintenance functions build replacement indexes off to the side, swap only after a complete build, expose status/flush/rebuild through authenticated surfaces, and verify the real Ollama-backed store before and after restart.

**Tech Stack:** TypeScript 6, Node.js 24, Vitest 4, iii-sdk/iii-engine 0.11.2, PowerShell, GitHub CLI, Ollama OpenAI-compatible embeddings.

## Global Constraints

- Production repository is `Xuleileon/agentmemory`; `origin` is the fork and `upstream` is `rohitg00/agentmemory`.
- Production checkout is `E:\agentmemory`; production worker must run `E:\agentmemory\dist\index.mjs`.
- Keep `qwen3-embedding:4b` with `OPENAI_EMBEDDING_DIMENSIONS=2560`.
- Never commit `.env`, credentials, state databases, stream data, logs, or backups.
- Do not stop the current worker until the user-controlled backfill has finished.
- Before switching workers, create and validate a recoverable backup of `C:\Users\dingx\.agentmemory\data\state_store.db`.
- Do not publish an incomplete rebuilt index or replace the last valid manifest after any embedding or persistence failure.
- Every production behavior change follows red-green-refactor and receives a focused commit.

---

### Task 1: Create the production fork and E-drive checkout

**Files:**
- Existing source: `C:\Users\dingx\Documents\Codex\2026-08-11\deepwiki-rohitg00-agentmemory-base-url-c\work\agentmemory-source`
- Create checkout: `E:\agentmemory`

**Interfaces:**
- Consumes: local commits `8d9973d`, `43dc3be`, and `ea575b8`.
- Produces: `Xuleileon/agentmemory` with those commits on `main`, plus an `E:\agentmemory` checkout with `origin` and `upstream` configured.

- [ ] **Step 1: Recheck identities and clean source state**

Run:

```powershell
gh api user --jq .login
git -C "C:\Users\dingx\Documents\Codex\2026-08-11\deepwiki-rohitg00-agentmemory-base-url-c\work\agentmemory-source" status --short
git -C "C:\Users\dingx\Documents\Codex\2026-08-11\deepwiki-rohitg00-agentmemory-base-url-c\work\agentmemory-source" log --oneline -4
```

Expected: login `Xuleileon`, empty status, and the three local commits visible.

- [ ] **Step 2: Create the GitHub fork without cloning**

Run:

```powershell
gh repo fork rohitg00/agentmemory --clone=false --remote=false
gh repo view Xuleileon/agentmemory --json nameWithOwner,isFork,parent,defaultBranchRef
```

Expected: a public fork whose parent is `rohitg00/agentmemory` and default branch is `main`.

- [ ] **Step 3: Push the approved local main to the fork**

Run:

```powershell
git -C "C:\Users\dingx\Documents\Codex\2026-08-11\deepwiki-rohitg00-agentmemory-base-url-c\work\agentmemory-source" remote add fork https://github.com/Xuleileon/agentmemory.git
git -C "C:\Users\dingx\Documents\Codex\2026-08-11\deepwiki-rohitg00-agentmemory-base-url-c\work\agentmemory-source" push fork main:main
```

Expected: GitHub `main` resolves to `ea575b8` or its descendant.

- [ ] **Step 4: Clone to E drive and configure remotes**

Run:

```powershell
git clone https://github.com/Xuleileon/agentmemory.git "E:\agentmemory"
git -C "E:\agentmemory" remote add upstream https://github.com/rohitg00/agentmemory.git
git -C "E:\agentmemory" remote -v
git -C "E:\agentmemory" status --short
```

Expected: `origin` is `Xuleileon/agentmemory`, `upstream` is official, and status is empty.

---

### Task 2: Make index persistence generation-based and single-flight

**Files:**
- Modify: `src/state/index-persistence.ts`
- Modify: `src/functions/search.ts`
- Test: `test/index-persistence.test.ts`

**Interfaces:**
- Produces: `IndexPersistenceStatus`, `IndexPersistence.getStatus()`, generation-aware `scheduleSave()`, and single-flight `save()`.
- Preserves: existing callers may continue using `scheduleSave()` and `save()`.

- [ ] **Step 1: Write failing concurrency and retry tests**

Add tests that gate the first `kv.set`, call `save()` concurrently, and assert only one first-generation shard write runs. Add a mutation during that gate and assert a second generation is committed. Add a first-save failure followed by success and assert dirty remains true until retry.

Core assertions:

```ts
expect(maxConcurrentWrites).toBe(1);
expect(persistence.getStatus().dirty).toBe(false);
expect(persistence.getStatus().persistedGeneration)
  .toBe(persistence.getStatus().dirtyGeneration);
expect(persistence.getStatus().lastError).toContain("TIMEOUT");
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
pnpm vitest run test/index-persistence.test.ts
```

Expected: FAIL because `getStatus`, generation tracking, and single-flight behavior do not exist.

- [ ] **Step 3: Implement minimal generation and save-loop state**

Add this public shape:

```ts
export interface IndexPersistenceStatus {
  dirtyGeneration: number;
  persistedGeneration: number;
  dirty: boolean;
  saving: boolean;
  lastSuccessAt?: string;
  lastErrorAt?: string;
  lastError?: string;
  memoryBm25Count: number;
  memoryVectorCount: number;
  persistedBm25Count: number;
  persistedVectorCount: number;
}
```

`scheduleSave()` increments `dirtyGeneration`, resets the debounce timer, and starts the shared save loop after five seconds. `save()` also marks dirty, cancels the timer, and returns the existing `savePromise` when one exists. The loop snapshots the target generation, serializes and saves both indexes, advances `persistedGeneration` only after both manifests commit, and repeats while dirty is newer. On failure it records the error, leaves dirty newer than persisted, and resolves without creating an unhandled rejection.

- [ ] **Step 4: Keep search-layer persistence hooks explicit**

Retain these entry points in `src/functions/search.ts`:

```ts
export function scheduleIndexSave(): void {
  indexPersistence?.scheduleSave();
}

export async function flushIndexSave(): Promise<void> {
  await indexPersistence?.save();
}
```

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```powershell
pnpm vitest run test/index-persistence.test.ts
```

Expected: all index persistence tests pass with no unhandled rejection.

- [ ] **Step 6: Commit**

```powershell
git add src/state/index-persistence.ts src/functions/search.ts test/index-persistence.test.ts
git commit -m "fix: serialize durable index checkpoints"
```

---

### Task 3: Wire every index mutation into durable checkpoints

**Files:**
- Modify: `src/functions/search.ts`
- Modify: `src/functions/remember.ts`
- Modify: `src/functions/observe.ts`
- Modify: `src/functions/compress.ts`
- Modify: `src/functions/export-import.ts`
- Modify: `src/functions/replay.ts`
- Test: `test/export-import.test.ts`
- Test: `test/remember-bm25-index.test.ts`
- Test: `test/vector-index-populate.test.ts`
- Test: `test/replay.test.ts`

**Interfaces:**
- Consumes: Task 2 `scheduleIndexSave()` and `flushIndexSave()`.
- Produces: every successful BM25/vector mutation is eventually durable; bulk requests perform one final flush rather than one full save per row.

- [ ] **Step 1: Write failing import vector-and-flush tests**

Configure a deterministic embedding provider and vector index in `test/export-import.test.ts`, inject a persistence spy, import one memory and one observation, then assert:

```ts
expect(getVectorIndex()?.size).toBe(2);
expect(persistence.save).toHaveBeenCalledTimes(1);
```

Add an embedding failure case that asserts KV import succeeds while vector size reports the gap and the warning is recorded.

- [ ] **Step 2: Write failing live-write and replay checkpoint tests**

Assert successful remember/observation compression schedules persistence, and a replay batch calls one final flush after indexing all records.

- [ ] **Step 3: Run the focused suite and verify RED**

Run:

```powershell
pnpm vitest run test/export-import.test.ts test/remember-bm25-index.test.ts test/vector-index-populate.test.ts test/replay.test.ts
```

Expected: new checkpoint assertions fail.

- [ ] **Step 4: Add persistence scheduling at mutation boundaries**

After a successful guarded vector/BM25 addition in live paths, call `scheduleIndexSave()`. In import and replay, use `indexRecords(...)` for memory and observation batches and call `flushIndexSave()` once after the whole request. Do not call `save()` from inside per-record loops.

Import failure handling remains:

```ts
try {
  await indexRecords(indexObs, indexMems);
  await flushIndexSave();
} catch (err) {
  logger.warn("Import indexing failed; rebuild can recover", {
    error: err instanceof Error ? err.message : String(err),
  });
}
```

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the command from Step 3. Expected: all selected tests pass.

- [ ] **Step 6: Commit**

```powershell
git add src/functions/search.ts src/functions/remember.ts src/functions/observe.ts src/functions/compress.ts src/functions/export-import.ts src/functions/replay.ts test/export-import.test.ts test/remember-bm25-index.test.ts test/vector-index-populate.test.ts test/replay.test.ts
git commit -m "fix: checkpoint all searchable writes"
```

---

### Task 4: Build indexes off-path and swap only on complete rebuild

**Files:**
- Create: `src/functions/index-maintenance.ts`
- Modify: `src/functions/search.ts`
- Modify: `src/index.ts`
- Test: `test/index-maintenance.test.ts`

**Interfaces:**
- Produces: `buildReplacementIndexes`, `registerIndexMaintenanceFunctions`, `mem::index-status`, `mem::index-flush`, and `mem::index-rebuild`.
- Consumes: active `StateKV`, embedding provider, search/vector indexes, and Task 2 persistence status.

- [ ] **Step 1: Write failing atomic-rebuild tests**

Test a successful build containing memory and observation vectors, an embedding failure that leaves active indexes untouched, and a successful swap followed by forced persistence.

Expected result shape:

```ts
export interface IndexRebuildResult {
  success: boolean;
  bm25Count: number;
  vectorCount: number;
  failed: number;
  failedIds: string[];
  dimensions: number;
}
```

- [ ] **Step 2: Run the new test and verify RED**

Run:

```powershell
pnpm vitest run test/index-maintenance.test.ts
```

Expected: FAIL because the module and functions do not exist.

- [ ] **Step 3: Implement temporary-index construction**

Add an `indexRecordsInto` helper accepting explicit targets:

```ts
export interface IndexTargets {
  bm25: SearchIndex;
  vector: VectorIndex | null;
  embeddingProvider: EmbeddingProvider | null;
}
```

`buildReplacementIndexes` walks latest memories and every session's observations in bounded batches. It writes only to temporary `SearchIndex` and `VectorIndex` instances. If any ID fails, return `success: false` and do not call `restoreFrom` on active indexes.

- [ ] **Step 4: Register status, flush, and rebuild functions**

Register:

```ts
mem::index-status  // read-only status plus active provider dimensions
mem::index-flush   // await durable checkpoint
mem::index-rebuild // build temporary indexes, swap on complete success, flush
```

Call `registerIndexMaintenanceFunctions(...)` in `src/index.ts` only after the persistence object has been created and wired.

- [ ] **Step 5: Run tests and verify GREEN**

Run:

```powershell
pnpm vitest run test/index-maintenance.test.ts test/index-persistence.test.ts test/vector-index-dimensions.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 6: Commit**

```powershell
git add src/functions/index-maintenance.ts src/functions/search.ts src/index.ts test/index-maintenance.test.ts
git commit -m "feat: add atomic index rebuild controls"
```

---

### Task 5: Expose authenticated maintenance status and controls

**Files:**
- Modify: `src/triggers/api.ts`
- Modify: `src/mcp/tools-registry.ts`
- Modify: `src/mcp/server.ts`
- Modify: `src/mcp/standalone.ts`
- Test: `test/mcp-surface-default.test.ts`
- Test: `test/mcp-standalone-proxy.test.ts`
- Test: `test/integration.test.ts`

**Interfaces:**
- Consumes: Task 4 internal functions.
- Produces: authenticated REST paths `/agentmemory/index/status`, `/agentmemory/index/flush`, `/agentmemory/index/rebuild` and corresponding MCP tools.

- [ ] **Step 1: Write failing surface tests**

Assert all three REST triggers use `middleware::api-auth`, standalone MCP forwards the three calls, and the tool registry contains exact schemas with rebuild accepting optional positive `batchSize`.

- [ ] **Step 2: Run surface tests and verify RED**

```powershell
pnpm vitest run test/mcp-surface-default.test.ts test/mcp-standalone-proxy.test.ts
```

Expected: FAIL because maintenance surfaces are absent.

- [ ] **Step 3: Add the minimal authenticated adapters**

REST handlers invoke only the Task 4 function IDs. MCP tools use names `memory_index_status`, `memory_index_flush`, and `memory_index_rebuild`; descriptions state that rebuild is expensive and atomic.

- [ ] **Step 4: Run surface and integration tests**

```powershell
pnpm vitest run test/mcp-surface-default.test.ts test/mcp-standalone-proxy.test.ts test/integration.test.ts
```

Expected: all selected tests pass and tool-count snapshots match the new surface.

- [ ] **Step 5: Commit**

```powershell
git add src/triggers/api.ts src/mcp/tools-registry.ts src/mcp/server.ts src/mcp/standalone.ts test/mcp-surface-default.test.ts test/mcp-standalone-proxy.test.ts test/integration.test.ts
git commit -m "feat: expose index maintenance controls"
```

---

### Task 6: Reject saturated or misinterpreted reranker output

**Files:**
- Modify: `src/state/reranker.ts`
- Test: `test/reranker.test.ts`
- Test: `test/hybrid-search.test.ts`

**Interfaces:**
- Produces: `extractRelevanceScore(output): number | null` and reranking that preserves component scores and falls back to RRF order on invalid/no-variance output.

- [ ] **Step 1: Write failing output-shape tests**

Cover relevant and non-relevant labels, all-ones output, non-finite output, and a valid varied score set. Assert fallback returns the original array order and original `combinedScore` values.

```ts
expect(reranked.map((r) => r.observation.id)).toEqual(["rrf-1", "rrf-2"]);
expect(reranked.map((r) => r.combinedScore)).toEqual([0.7, 0.6]);
```

- [ ] **Step 2: Run reranker tests and verify RED**

```powershell
pnpm vitest run test/reranker.test.ts test/hybrid-search.test.ts
```

Expected: saturated and label-direction tests fail.

- [ ] **Step 3: Implement score parsing and variance gate**

Treat explicitly relevant labels (`LABEL_1`, `relevant`, `true`) as direct confidence and explicitly non-relevant labels (`LABEL_0`, `not_relevant`, `false`) as `1 - confidence`. Reject missing labels when the model returns multiple classes, non-finite scores, or candidate score range below `1e-6`. On rejection return original RRF results unchanged.

- [ ] **Step 4: Run tests and verify GREEN**

Run the command from Step 2. Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```powershell
git add src/state/reranker.ts test/reranker.test.ts test/hybrid-search.test.ts
git commit -m "fix: fall back from invalid reranker scores"
```

---

### Task 7: Prevent CLI/worker checkout drift

**Files:**
- Modify: `src/cli.ts`
- Test: `test/cli-data-dir.test.ts`
- Test: `test/cli-doctor-fixes.test.ts`
- Modify: `README.md`

**Interfaces:**
- Produces: runtime config generation that can pin the fork config with `AGENTMEMORY_III_CONFIG`, plus status/doctor evidence showing the configured worker executable.

- [ ] **Step 1: Write failing runtime-config tests**

Given a bundled config with relative `src/**/*.ts` and `dist/index.mjs`, assert generated runtime config contains absolute paths rooted at the selected config's package directory. Given an explicit absolute user exec path, assert it is preserved. Add a doctor diagnostic that reports a mismatch between CLI package root and worker exec root.

- [ ] **Step 2: Run CLI tests and verify RED**

```powershell
pnpm vitest run test/cli-data-dir.test.ts test/cli-doctor-fixes.test.ts
```

Expected: absolute worker-root and mismatch assertions fail.

- [ ] **Step 3: Resolve relative worker paths safely**

Change runtime rendering to accept the source config path:

```ts
function renderIiiConfig(
  template: string,
  dataDir: string,
  configPath: string,
): string
```

Resolve only relative `watch` and `node dist/index.mjs` entries against `dirname(configPath)`. Preserve explicit absolute user paths. In deployment set `AGENTMEMORY_III_CONFIG=E:\agentmemory\iii-config.yaml` so `~/.agentmemory/iii-config.yaml` cannot win precedence.

- [ ] **Step 4: Document pinned-fork operation and upgrade flow**

Document `origin`/`upstream`, build/start commands, explicit config pinning, and the rule that production updates require tests, build, index status, and restart verification.

- [ ] **Step 5: Run tests and verify GREEN**

Run the command from Step 2. Expected: all selected tests pass.

- [ ] **Step 6: Commit**

```powershell
git add src/cli.ts test/cli-data-dir.test.ts test/cli-doctor-fixes.test.ts README.md
git commit -m "fix: pin runtime worker to selected checkout"
```

---

### Task 8: Run repository-wide verification and publish main

**Files:**
- No new production files.

**Interfaces:**
- Consumes: Tasks 1-7.
- Produces: a tested and built `Xuleileon/agentmemory:main`.

- [ ] **Step 1: Install dependencies without changing lockfile**

```powershell
Set-Location "E:\agentmemory"
pnpm install --frozen-lockfile
```

- [ ] **Step 2: Run all tests**

```powershell
pnpm test
```

Expected: zero failed tests.

- [ ] **Step 3: Build distributable output**

```powershell
pnpm build
```

Expected: exit code 0 and fresh `dist/index.mjs` plus `dist/cli.mjs`.

- [ ] **Step 4: Verify repository hygiene**

```powershell
git diff --check
git status --short
git grep -n -E "sk-[A-Za-z0-9]|OPENAI_API_KEY=.*[^=]" -- . ":(exclude).env.example"
```

Expected: no whitespace errors, only intended source changes before commit, and no secrets.

- [ ] **Step 5: Push fork main**

```powershell
git push origin main
gh repo view Xuleileon/agentmemory --json defaultBranchRef,url
```

Expected: remote `main` matches local `HEAD`.

---

### Task 9: Back up, switch production, rebuild vectors, and prove restart durability

**Files:**
- Back up: `C:\Users\dingx\.agentmemory\data\state_store.db`
- Modify runtime config: `C:\Users\dingx\.agentmemory\iii-config.yaml`
- Preserve secrets: `C:\Users\dingx\.agentmemory\.env`

**Interfaces:**
- Consumes: built fork, completed external backfill, maintenance REST endpoints.
- Produces: a running fork worker whose persisted vector count survives two restarts and whose new writes are durable.

- [ ] **Step 1: Confirm the external backfill is finished**

Inspect the known process command lines and backfill manifest timestamps. Continue only when no Claude/Codex enrichment process is writing and counts are stable across two checks.

- [ ] **Step 2: Capture baseline and stop hook writes**

Record health, memory counts, current index files, and the English/Chinese display-switcher queries. Temporarily disable only AgentMemory hook execution while preserving hook configuration for restoration.

- [ ] **Step 3: Create a recoverable state backup**

Use a timestamped directory under `C:\Users\dingx\.agentmemory\backups`. Copy the state directory with one PowerShell pipeline after resolving and verifying both absolute paths remain under `.agentmemory`. Compare recursive file counts and total byte counts between source and backup before proceeding.

- [ ] **Step 4: Pin and start the fork worker**

Set `AGENTMEMORY_III_CONFIG=E:\agentmemory\iii-config.yaml` in the existing `.env`, stop the old worker normally, and start:

```powershell
node "E:\agentmemory\dist\cli.mjs" --verbose
```

Expected: status reports fork version, worker exec path `E:\agentmemory\dist\index.mjs`, Ollama provider `qwen3-embedding:4b`, and 2560 dimensions.

- [ ] **Step 5: Run the complete atomic rebuild**

Call authenticated `POST /agentmemory/index/rebuild` with a measured batch size beginning at 32. Poll status without starting another rebuild. If any item fails, preserve the old manifest, record IDs, retry failed provider conditions, and rerun the complete rebuild.

Expected successful invariants:

```text
success = true
failed = 0
memoryVectorCount = persistedVectorCount
dimensions = 2560
dirty = false
```

- [ ] **Step 6: Verify persisted files and first restart**

Record vector manifest generation, shard byte total, and status counts. Run the pure-Chinese query for the English remote display memory. Restart normally and assert the same vector count, dimension, manifest generation, and target recall.

- [ ] **Step 7: Verify new live writes and second restart**

Restore AgentMemory hooks. Create one uniquely named observation and one uniquely named memory through normal hook/API paths, wait longer than the five-second debounce, and assert disk counts increase. Restart again and recall both unique records.

- [ ] **Step 8: Final production checks**

Run health, status, diagnostics, English/Chinese semantic recall, latest-project status recall, and lessons/graph recall. Confirm the circuit breaker is closed, index dirty is false, and no persistence error appeared after the second restart.

- [ ] **Step 9: Record deployment evidence and commit documentation if changed**

If README operational commands changed during live verification, update them through `apply_patch`, run `git diff --check`, commit as `docs: record durable index operations`, and push `main` again. Do not commit runtime logs, database files, or credentials.
