# Smart Search Retrieval Quality Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prevent AgentMemory self-search telemetry and generic hook shells from outranking durable memories in `memory_smart_search` while preserving all source observations.

**Architecture:** Add a pure retrieval-quality policy used both when deciding whether a newly captured observation should enter search projection and when ranking historical candidates after KV enrichment. Keep LanceDB unchanged, over-fetch a bounded candidate set, then filter, weight, diversify, and optionally rerank.

**Tech Stack:** TypeScript, Vitest, iii SDK, LanceDB, PowerShell production verification.

---

### Task 1: Define the retrieval-quality contract

**Files:**
- Create: `src/state/retrieval-quality.ts`
- Create: `test/retrieval-quality.test.ts`
- Modify: `src/types.ts`

**Step 1: Write failing policy tests**

Cover literal fixtures for:

```ts
expect(classifyRetrievalQuality(agentMemoryRecall)).toMatchObject({ exclude: true });
expect(classifyRetrievalQuality(historicalRecall)).toMatchObject({ exclude: true });
expect(classifyRetrievalQuality(globSearch)).toMatchObject({ exclude: false });
expect(classifyRetrievalQuality(explicitMemory).multiplier)
  .toBeGreaterThan(classifyRetrievalQuality(promptShell).multiplier);
```

**Step 2: Run the test and verify RED**

Run: `pnpm vitest run test/retrieval-quality.test.ts`

Expected: FAIL because `src/state/retrieval-quality.ts` does not exist.

**Step 3: Implement the minimal pure policy**

Add optional source fields to `CompressedObservation`, normalize tool names, classify proven self-search telemetry, and return a deterministic multiplier/reason.

**Step 4: Run the test and verify GREEN**

Run: `pnpm vitest run test/retrieval-quality.test.ts`

Expected: all policy tests PASS.

### Task 2: Preserve source metadata and stop future feedback loops

**Files:**
- Modify: `src/functions/compress-synthetic.ts`
- Modify: `src/functions/compress.ts`
- Modify: `src/functions/observe.ts`
- Modify: `test/auto-compress.test.ts`
- Modify: `test/observe-implicit-session.test.ts`

**Step 1: Write failing capture tests**

Assert that synthetic and LLM-compressed observations retain `sourceHookType`/`sourceToolName`, and that an AgentMemory recall tool observation is persisted in KV but not sent to search projection/indexing.

**Step 2: Run the focused tests and verify RED**

Run: `pnpm vitest run test/auto-compress.test.ts test/observe-implicit-session.test.ts`

Expected: new assertions FAIL because metadata is absent and self-search is still indexed.

**Step 3: Implement minimal capture wiring**

Populate the optional metadata fields and guard only the search-projection/index calls with `shouldProjectObservation`; keep KV and stream writes unconditional.

**Step 4: Run focused tests and verify GREEN**

Run: `pnpm vitest run test/auto-compress.test.ts test/observe-implicit-session.test.ts`

Expected: all focused tests PASS.

### Task 3: Apply quality-aware bounded retrieval

**Files:**
- Modify: `src/state/hybrid-search.ts`
- Modify: `test/hybrid-search.test.ts`

**Step 1: Write failing hybrid behavior tests**

Create real KV observations where the first Lance candidates are self-search telemetry and generic shells, followed by a diagnosis. Assert:

```ts
expect(results[0].observation.id).toBe("mem_diagnosis");
expect(results).toHaveLength(requestedLimit);
expect(results.some(r => r.observation.title === "Glob")).toBe(true);
```

Add a separate ordering fixture proving decisions outrank generic prompts with comparable RRF ranks.

**Step 2: Run the test and verify RED**

Run: `pnpm vitest run test/hybrid-search.test.ts`

Expected: the telemetry appears first or prevents the requested limit from being filled.

**Step 3: Implement bounded over-fetch/filter/rank**

Fetch at least `max(limit * 8, 40)` and at most 400 candidates from lexical/vector streams. Enrich candidates, exclude proven telemetry, multiply the fused score by retrieval quality, sort, diversify by session, and reapply the multiplier to optional reranker scores.

**Step 4: Run focused tests and verify GREEN**

Run: `pnpm vitest run test/retrieval-quality.test.ts test/hybrid-search.test.ts test/smart-search.test.ts`

Expected: all focused retrieval tests PASS.

### Task 4: Build and broad regression verification

**Files:**
- No new production files expected.

**Step 1: Run related regression suites**

Run: `pnpm vitest run test/search.test.ts test/smart-search.test.ts test/hybrid-search.test.ts test/mcp-prompts.test.ts test/mcp-standalone-proxy.test.ts test/lance-search-backend.test.ts`

Expected: all tests PASS.

**Step 2: Run the full unit suite**

Run: `pnpm test`

Expected: exit code 0 and zero failed tests.

**Step 3: Build distributable artifacts**

Run: `pnpm build`

Expected: exit code 0 and refreshed `dist` artifacts.

### Task 5: Deploy and verify the real production path

**Files:**
- Runtime: `E:/agentmemory/dist/index.mjs`
- Runtime data: `C:/Users/dingx/.agentmemory/data/`

**Step 1: Restart through the existing supervised production path**

Do not delete data or invoke index rebuild. Confirm exactly one E-drive worker after restart.

**Step 2: Verify service and index invariants**

Check `/agentmemory/livez` and `/agentmemory/index/status`.

Expected: live, backend `lance`, projection pending `0`, build `idle`, and row count remains in the existing 205k range.

**Step 3: Verify actual MCP behavior**

Run both `memory_recall` and `memory_smart_search` for:

- `显示器方向自动切换 手机竖屏 远程控制 分辨率`
- `鼠标卡顿`
- `automatic portrait display switching for remote phone connection`

Expected: multi-term searches return results; `鼠标卡顿` ranks the real Windows diagnosis ahead of memory-search telemetry; no `Memory recall for ...` or empty `post_tool_use` appears in the top results.

**Step 4: Verify persistence and feedback-loop prevention**

Restart once more, rerun `鼠标卡顿`, and verify the search just performed has not become a new top result. Confirm Lance still reports pending `0` and build `idle`.

