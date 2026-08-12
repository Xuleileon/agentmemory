import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompressedObservation } from "../src/types.js";

const searchMocks = vi.hoisted(() => ({
  add: vi.fn(),
  vectorIndexAddGuarded: vi.fn().mockResolvedValue(false),
  scheduleIndexSave: vi.fn(),
  prepareSearchUpsert: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/functions/search.js", () => ({
  getSearchIndex: () => ({ add: searchMocks.add }),
  vectorIndexAddGuarded: searchMocks.vectorIndexAddGuarded,
  scheduleIndexSave: searchMocks.scheduleIndexSave,
  prepareSearchUpsert: searchMocks.prepareSearchUpsert,
}));

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    store,
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    update: async (
      scope: string,
      key: string,
      updates: Array<{ path: string; value: unknown }>,
    ) => {
      const value = (store.get(scope)?.get(key) as Record<string, unknown>) ?? {};
      for (const update of updates) value[update.path] = update.value;
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, value);
    },
    delete: async (scope: string, key: string) => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> =>
      Array.from(store.get(scope)?.values() ?? []) as T[],
  };
}

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (id: string, handler: Function) => functions.set(id, handler),
    trigger: async (
      idOrInput: string | { function_id: string; payload: unknown },
      data?: unknown,
    ) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      return functions.get(id)?.(payload) ?? null;
    },
  };
}

describe("observe retrieval-quality projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AGENTMEMORY_AUTO_COMPRESS = "false";
  });

  it("persists AgentMemory recall observations but does not project them", async () => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    await sdk.trigger("mem::observe", {
      sessionId: "ses_feedback",
      project: "agentmemory",
      cwd: "E:/agentmemory",
      hookType: "post_tool_use",
      timestamp: "2026-08-12T00:00:00.000Z",
      data: {
        tool_name: "mcp__agentmemory__memory_recall",
        tool_input: { query: "feedback-loop-sentinel" },
        tool_output: { results: [] },
      },
    });

    const stored = Array.from(
      kv.store.get("mem:obs:ses_feedback")?.values() ?? [],
    ) as CompressedObservation[];
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      sourceHookType: "post_tool_use",
      sourceToolName: "mcp__agentmemory__memory_recall",
    });
    expect(searchMocks.prepareSearchUpsert).not.toHaveBeenCalled();
    expect(searchMocks.add).not.toHaveBeenCalled();
    expect(searchMocks.vectorIndexAddGuarded).not.toHaveBeenCalled();
    expect(searchMocks.scheduleIndexSave).not.toHaveBeenCalled();
  });
});
