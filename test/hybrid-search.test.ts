import { describe, it, expect, beforeEach } from "vitest";
import { HybridSearch } from "../src/state/hybrid-search.js";
import { SearchIndex } from "../src/state/search-index.js";
import type { CompressedObservation, EmbeddingProvider } from "../src/types.js";
import type { SearchBackend } from "../src/state/search-backend.js";

function makeObs(
  overrides: Partial<CompressedObservation> = {},
): CompressedObservation {
  return {
    id: "obs_1",
    sessionId: "ses_1",
    timestamp: new Date().toISOString(),
    type: "file_edit",
    title: "Edit auth middleware",
    subtitle: "JWT validation",
    facts: ["Added token check"],
    narrative: "Modified the auth middleware to validate JWT tokens",
    concepts: ["authentication", "jwt"],
    files: ["src/middleware/auth.ts"],
    importance: 7,
    ...overrides,
  };
}

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      return (store.get(scope)?.get(key) as T) ?? null;
    },
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

describe("HybridSearch", () => {
  let bm25: SearchIndex;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    bm25 = new SearchIndex();
    kv = mockKV();
  });

  it("returns BM25-only results when no vector index is provided", async () => {
    const obs = makeObs({ id: "obs_1", sessionId: "ses_1" });
    bm25.add(obs);
    await kv.set("mem:obs:ses_1", "obs_1", obs);

    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const results = await hybrid.search("auth");

    expect(results.length).toBe(1);
    expect(results[0].observation.id).toBe("obs_1");
    expect(results[0].vectorScore).toBe(0);
    expect(results[0].bm25Score).toBeGreaterThan(0);
  });

  it("returns empty results for no-match query", async () => {
    const obs = makeObs({ id: "obs_1", sessionId: "ses_1" });
    bm25.add(obs);
    await kv.set("mem:obs:ses_1", "obs_1", obs);

    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const results = await hybrid.search("database");
    expect(results).toEqual([]);
  });

  it("combinedScore is derived from bm25Score when no vector index", async () => {
    const obs = makeObs({ id: "obs_1", sessionId: "ses_1" });
    bm25.add(obs);
    await kv.set("mem:obs:ses_1", "obs_1", obs);

    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const results = await hybrid.search("auth");

    expect(results[0].combinedScore).toBeGreaterThan(0);
    expect(results[0].vectorScore).toBe(0);
    expect(results[0].graphScore).toBe(0);
  });

  it("results are sorted by combinedScore descending", async () => {
    const obs1 = makeObs({
      id: "obs_1",
      sessionId: "ses_1",
      title: "auth handler",
      narrative: "auth auth auth module",
      concepts: ["auth"],
    });
    const obs2 = makeObs({
      id: "obs_2",
      sessionId: "ses_1",
      title: "database setup",
      narrative: "auth connection config",
      concepts: ["database"],
    });
    bm25.add(obs1);
    bm25.add(obs2);
    await kv.set("mem:obs:ses_1", "obs_1", obs1);
    await kv.set("mem:obs:ses_1", "obs_2", obs2);

    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const results = await hybrid.search("auth");

    expect(results.length).toBe(2);
    expect(results[0].combinedScore).toBeGreaterThanOrEqual(
      results[1].combinedScore,
    );
  });

  it("respects limit parameter", async () => {
    for (let i = 0; i < 10; i++) {
      const obs = makeObs({
        id: `obs_${i}`,
        sessionId: "ses_1",
        title: `auth feature ${i}`,
      });
      bm25.add(obs);
      await kv.set("mem:obs:ses_1", `obs_${i}`, obs);
    }

    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const results = await hybrid.search("auth", 3);
    expect(results.length).toBe(3);
  });

  it("skips observations not found in KV", async () => {
    const obs = makeObs({ id: "obs_missing", sessionId: "ses_1" });
    bm25.add(obs);

    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const results = await hybrid.search("auth");
    expect(results).toEqual([]);
  });

  it("falls back to KV.memories when an indexed entry is a saved memory (#265)", async () => {
    // mem::remember writes to KV.memories under the synthetic sessionId
    // "memory" — the BM25 index sees that synthetic sessionId, but
    // KV.observations("memory") never has anything.
    const indexable = makeObs({
      id: "mem_abc",
      sessionId: "memory",
      title: "Test memory for search",
      narrative: "Test memory for search",
      concepts: ["test", "search"],
    });
    bm25.add(indexable);

    const memory = {
      id: "mem_abc",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      type: "fact",
      title: "Test memory for search",
      content: "Test memory for search",
      concepts: ["test", "search"],
      files: [],
      sessionIds: [],
      strength: 7,
      version: 1,
      isLatest: true,
    };
    await kv.set("mem:memories", "mem_abc", memory);

    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const results = await hybrid.search("test memory search");

    expect(results.length).toBe(1);
    expect(results[0].observation.id).toBe("mem_abc");
    expect(results[0].observation.narrative).toBe("Test memory for search");
    expect(results[0].observation.concepts).toEqual(["test", "search"]);
  });

  it("uses the disk-backed search backend without touching legacy indexes", async () => {
    const obs = makeObs({ id: "obs_lance", sessionId: "ses_lance" });
    await kv.set("mem:obs:ses_lance", "obs_lance", obs);
    const backend = {
      lexicalSearch: async () => [
        { obsId: "obs_lance", sessionId: "ses_lance", score: 2 },
      ],
      vectorSearch: async () => [
        { obsId: "obs_lance", sessionId: "ses_lance", score: 0.95 },
      ],
    } as Pick<SearchBackend, "lexicalSearch" | "vectorSearch">;
    const provider: EmbeddingProvider = {
      name: "test",
      dimensions: 2,
      embed: async () => new Float32Array([1, 0]),
      embedBatch: async () => [new Float32Array([1, 0])],
    };
    const hybrid = new HybridSearch(
      bm25,
      null,
      provider,
      kv as never,
      0.4,
      0.6,
      0,
      false,
      backend,
    );

    const results = await hybrid.search("auth middleware");

    expect(results).toHaveLength(1);
    expect(results[0].observation.id).toBe("obs_lance");
    expect(results[0].bm25Score).toBe(2);
    expect(results[0].vectorScore).toBe(0.95);
  });

  it("filters self-search telemetry and replenishes the requested result limit", async () => {
    const telemetry = makeObs({
      id: "obs_telemetry",
      sessionId: "ses_meta",
      type: "search",
      title: "Memory recall for mouse stuttering and task manager freeze",
      facts: ["Tool used: mcp__agentmemory__memory_recall"],
      narrative: "The agent queried its memory for mouse stuttering.",
      concepts: ["memory recall"],
      importance: 2,
    });
    const prompt = makeObs({
      id: "obs_prompt",
      sessionId: "ses_prompt",
      type: "conversation",
      title: "prompt_submit",
      narrative: "mouse stuttering task manager freeze",
      sourceHookType: "prompt_submit",
    });
    const glob = makeObs({
      id: "obs_glob",
      sessionId: "ses_glob",
      type: "search",
      title: "Glob",
      narrative: '{"pattern":"*mouse*","path":"C:/work"}',
      sourceHookType: "post_tool_use",
      sourceToolName: "Glob",
    });
    await kv.set("mem:obs:ses_meta", telemetry.id, telemetry);
    await kv.set("mem:obs:ses_prompt", prompt.id, prompt);
    await kv.set("mem:obs:ses_glob", glob.id, glob);
    await kv.set("mem:memories", "mem_diagnosis", {
      id: "mem_diagnosis",
      createdAt: "2026-07-12T05:17:16.936Z",
      updatedAt: "2026-07-12T05:17:16.936Z",
      type: "bug",
      title: "Windows 鼠标卡顿与任务管理器死机深度诊断",
      content: "A runaway background process saturated CPU scheduling.",
      concepts: ["mouse stuttering", "task manager freeze"],
      files: [],
      sessionIds: [],
      strength: 9,
      version: 1,
      isLatest: true,
    });

    const backend = {
      lexicalSearch: async () => [
        { obsId: telemetry.id, sessionId: telemetry.sessionId, score: 10 },
        { obsId: prompt.id, sessionId: prompt.sessionId, score: 9 },
        { obsId: "mem_diagnosis", sessionId: "memory", score: 8 },
        { obsId: glob.id, sessionId: glob.sessionId, score: 7 },
      ],
      vectorSearch: async () => [],
    } as Pick<SearchBackend, "lexicalSearch" | "vectorSearch">;
    const hybrid = new HybridSearch(
      bm25,
      null,
      null,
      kv as never,
      0.4,
      0.6,
      0,
      false,
      backend,
    );

    const results = await hybrid.search("鼠标卡顿", 2);

    expect(results).toHaveLength(2);
    expect(results[0].observation.id).toBe("mem_diagnosis");
    expect(results.map((result) => result.observation.id)).toContain("obs_glob");
    expect(results.map((result) => result.observation.id)).not.toContain(
      "obs_telemetry",
    );
  });
});
