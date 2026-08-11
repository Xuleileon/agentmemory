import { describe, expect, it, vi } from "vitest";
import { SearchIndex } from "../src/state/search-index.js";
import { VectorIndex } from "../src/state/vector-index.js";
import type {
  CompressedObservation,
  EmbeddingProvider,
  Memory,
  Session,
} from "../src/types.js";
import { KV } from "../src/state/schema.js";
import {
  buildReplacementIndexes,
  registerIndexMaintenanceFunctions,
} from "../src/functions/index-maintenance.js";

function observation(id: string, sessionId: string): CompressedObservation {
  return {
    id,
    sessionId,
    timestamp: "2026-08-11T00:00:00.000Z",
    type: "discovery",
    title: `Observation ${id}`,
    narrative: `Semantic content for ${id}`,
    facts: [],
    concepts: [],
    files: [],
    importance: 5,
  };
}

function memory(id: string): Memory {
  return {
    id,
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
    type: "fact",
    title: `Memory ${id}`,
    content: `Durable semantic memory ${id}`,
    concepts: [],
    files: [],
    sessionIds: [],
    strength: 7,
    version: 1,
    supersedes: [],
    sourceObservationIds: [],
    isLatest: true,
  };
}

function mockKV(records: {
  memories?: Memory[];
  sessions?: Session[];
  observations?: Record<string, CompressedObservation[]>;
}) {
  return {
    list: async <T>(scope: string): Promise<T[]> => {
      if (scope === KV.memories) return (records.memories ?? []) as T[];
      if (scope === KV.sessions) return (records.sessions ?? []) as T[];
      const prefix = "mem:obs:";
      if (scope.startsWith(prefix)) {
        return (records.observations?.[scope.slice(prefix.length)] ?? []) as T[];
      }
      return [];
    },
  };
}

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (id: string, handler: Function) => functions.set(id, handler),
    trigger: async (id: string, payload: unknown = {}) => {
      const handler = functions.get(id);
      if (!handler) throw new Error(`missing function ${id}`);
      return handler(payload);
    },
  };
}

const provider: EmbeddingProvider = {
  name: "test-embedding",
  dimensions: 3,
  embed: async () => new Float32Array([1, 0, 0]),
  embedBatch: async (texts: string[]) =>
    texts.map((_, index) => new Float32Array([1, index + 1, 0])),
};

function session(id: string): Session {
  return {
    id,
    project: "test",
    cwd: "C:/test",
    startedAt: "2026-08-11T00:00:00.000Z",
    status: "completed",
    observationCount: 1,
  };
}

describe("atomic index maintenance", () => {
  it("builds replacement BM25 and vector indexes from memories and observations", async () => {
    const result = await buildReplacementIndexes(
      mockKV({
        memories: [memory("mem_new")],
        sessions: [session("sess_1")],
        observations: { sess_1: [observation("obs_new", "sess_1")] },
      }) as never,
      provider,
    );

    expect(result.success).toBe(true);
    expect(result.bm25Count).toBe(2);
    expect(result.vectorCount).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.failedIds).toEqual([]);
    expect(result.dimensions).toBe(3);
  });

  it("does not replace active indexes when any embedding batch fails", async () => {
    const failingProvider: EmbeddingProvider = {
      ...provider,
      embedBatch: async () => {
        throw new Error("embedding endpoint unavailable");
      },
    };
    const activeBm25 = new SearchIndex();
    activeBm25.add(observation("obs_active", "sess_active"));
    const activeVector = new VectorIndex();
    activeVector.add("obs_active", "sess_active", new Float32Array([1, 0, 0]));
    const sdk = mockSdk();
    const save = vi.fn(async () => {});
    registerIndexMaintenanceFunctions(
      sdk as never,
      mockKV({
        sessions: [session("sess_1")],
        observations: { sess_1: [observation("obs_new", "sess_1")] },
      }) as never,
      {
        bm25: activeBm25,
        vector: activeVector,
        embeddingProvider: failingProvider,
        persistence: {
          save,
          getStatus: () => ({ dirty: false }),
        },
      },
    );

    const result = await sdk.trigger("mem::index-rebuild") as {
      success: boolean;
      failed: number;
    };

    expect(result.success).toBe(false);
    expect(result.failed).toBe(1);
    expect(activeBm25.has("obs_active")).toBe(true);
    expect(activeBm25.has("obs_new")).toBe(false);
    expect(activeVector.size).toBe(1);
    expect(save).not.toHaveBeenCalled();
  });

  it("swaps complete replacements and forces a durable checkpoint", async () => {
    const activeBm25 = new SearchIndex();
    activeBm25.add(observation("obs_old", "sess_old"));
    const activeVector = new VectorIndex();
    activeVector.add("obs_old", "sess_old", new Float32Array([1, 0, 0]));
    const sdk = mockSdk();
    const save = vi.fn(async () => {});
    expect(typeof (activeVector as any).adoptFrom).toBe("function");
    const adoptFrom = vi.spyOn(activeVector as any, "adoptFrom");
    registerIndexMaintenanceFunctions(
      sdk as never,
      mockKV({
        memories: [memory("mem_new")],
        sessions: [session("sess_1")],
        observations: { sess_1: [observation("obs_new", "sess_1")] },
      }) as never,
      {
        bm25: activeBm25,
        vector: activeVector,
        embeddingProvider: provider,
        persistence: {
          save,
          getStatus: () => ({ dirty: false }),
        },
      },
    );

    const result = await sdk.trigger("mem::index-rebuild") as {
      success: boolean;
      bm25Count: number;
      vectorCount: number;
    };

    expect(result).toMatchObject({ success: true, bm25Count: 2, vectorCount: 2 });
    expect(activeBm25.has("obs_old")).toBe(false);
    expect(activeBm25.has("obs_new")).toBe(true);
    expect(activeBm25.has("mem_new")).toBe(true);
    expect(activeVector.size).toBe(2);
    expect(adoptFrom).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("aborts the swap when a live index mutation lands during the rebuild", async () => {
    const activeBm25 = new SearchIndex();
    activeBm25.add(observation("obs_active", "sess_active"));
    const activeVector = new VectorIndex();
    activeVector.add("obs_active", "sess_active", new Float32Array([1, 0, 0]));
    const sdk = mockSdk();
    const save = vi.fn(async () => {});
    let statusReads = 0;
    registerIndexMaintenanceFunctions(
      sdk as never,
      mockKV({
        sessions: [session("sess_1")],
        observations: { sess_1: [observation("obs_new", "sess_1")] },
      }) as never,
      {
        bm25: activeBm25,
        vector: activeVector,
        embeddingProvider: provider,
        persistence: {
          save,
          getStatus: () => ({
            dirty: true,
            dirtyGeneration: statusReads++ === 0 ? 10 : 11,
          }),
        },
      },
    );

    const result = await sdk.trigger("mem::index-rebuild") as {
      success: boolean;
      failedIds: string[];
    };

    expect(result.success).toBe(false);
    expect(result.failedIds).toEqual(["concurrent-index-mutation"]);
    expect(activeBm25.has("obs_active")).toBe(true);
    expect(activeBm25.has("obs_new")).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it("reports active persistence and embedding dimensions", async () => {
    const sdk = mockSdk();
    registerIndexMaintenanceFunctions(
      sdk as never,
      mockKV({}) as never,
      {
        bm25: new SearchIndex(),
        vector: new VectorIndex(),
        embeddingProvider: provider,
        persistence: {
          save: vi.fn(async () => {}),
          getStatus: () => ({
            dirty: false,
            memoryBm25Count: 12,
            memoryVectorCount: 12,
          }),
        },
      },
    );

    const status = await sdk.trigger("mem::index-status") as Record<string, unknown>;
    expect(status).toMatchObject({
      success: true,
      dirty: false,
      memoryBm25Count: 12,
      memoryVectorCount: 12,
      provider: "test-embedding",
      dimensions: 3,
    });
  });

  it("runs production rebuilds in the background and exposes their terminal status", async () => {
    let releaseEmbedding!: (value: Float32Array[]) => void;
    const deferredProvider: EmbeddingProvider = {
      ...provider,
      embedBatch: () =>
        new Promise<Float32Array[]>((resolve) => {
          releaseEmbedding = resolve;
        }),
    };
    const sdk = mockSdk();
    registerIndexMaintenanceFunctions(
      sdk as never,
      mockKV({ memories: [memory("mem_background")] }) as never,
      {
        bm25: new SearchIndex(),
        vector: new VectorIndex(),
        embeddingProvider: deferredProvider,
        persistence: {
          save: vi.fn(async () => {}),
          getStatus: () => ({ dirty: false, dirtyGeneration: 1 }),
        },
      },
    );

    const started = await Promise.race([
      sdk.trigger("mem::index-rebuild", { batchSize: 1, background: true }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("background start blocked")), 25),
      ),
    ]) as Record<string, unknown>;
    expect(started).toMatchObject({ accepted: true, state: "running" });

    const running = await sdk.trigger("mem::index-status") as Record<string, any>;
    expect(running.rebuild).toMatchObject({ state: "running", batchSize: 1 });

    releaseEmbedding([new Float32Array([1, 0, 0])]);
    await vi.waitFor(async () => {
      const status = await sdk.trigger("mem::index-status") as Record<string, any>;
      expect(status.rebuild).toMatchObject({
        state: "succeeded",
        result: { success: true, bm25Count: 1, vectorCount: 1 },
      });
    });
  });

  it("honors an explicit positive embedding batch size", async () => {
    const embedBatch = vi.fn(async (texts: string[]) =>
      texts.map(() => new Float32Array([1, 0, 0])),
    );
    const result = await buildReplacementIndexes(
      mockKV({
        memories: [memory("mem_1"), memory("mem_2")],
      }) as never,
      { ...provider, embedBatch },
      { batchSize: 1 },
    );

    expect(result.success).toBe(true);
    expect(embedBatch).toHaveBeenCalledTimes(2);
    expect(embedBatch.mock.calls.every(([texts]) => texts.length === 1)).toBe(true);
  });

  it("fills embedding batches across session read chunks", async () => {
    const embedBatch = vi.fn(async (texts: string[]) =>
      texts.map(() => new Float32Array([1, 0, 0])),
    );
    const sessions = Array.from({ length: 11 }, (_, index) =>
      session(`sess_${index}`),
    );
    const observations = Object.fromEntries(
      sessions.map((item, index) => [
        item.id,
        [observation(`obs_${index}`, item.id)],
      ]),
    );

    const result = await buildReplacementIndexes(
      mockKV({ sessions, observations }) as never,
      { ...provider, embedBatch },
      { batchSize: 8 },
    );

    expect(result.success).toBe(true);
    expect(result.vectorCount).toBe(11);
    expect(embedBatch.mock.calls.map(([texts]) => texts.length)).toEqual([8, 3]);
  });

  it("repairs only missing entries and is idempotent on the next run", async () => {
    const embedBatch = vi.fn(async (texts: string[]) =>
      texts.map(() => new Float32Array([1, 0, 0])),
    );
    const activeBm25 = new SearchIndex();
    const existingMemory = memory("mem_existing");
    const missingObservation = observation("obs_missing", "sess_1");
    activeBm25.add({
      ...missingObservation,
      id: existingMemory.id,
      sessionId: "memory",
      title: existingMemory.title,
      narrative: existingMemory.content,
    });
    activeBm25.add(missingObservation);
    const activeVector = new VectorIndex();
    activeVector.add(existingMemory.id, "memory", new Float32Array([1, 0, 0]));
    const save = vi.fn(async () => {});
    const sdk = mockSdk();
    registerIndexMaintenanceFunctions(
      sdk as never,
      mockKV({
        memories: [existingMemory],
        sessions: [session("sess_1")],
        observations: { sess_1: [missingObservation] },
      }) as never,
      {
        bm25: activeBm25,
        vector: activeVector,
        embeddingProvider: { ...provider, embedBatch },
        persistence: {
          save,
          getStatus: () => ({ dirty: false }),
        },
      },
    );

    const first = await sdk.trigger("mem::index-repair", {
      batchSize: 8,
      checkpointEvery: 100,
    }) as Record<string, number | boolean>;
    expect(first).toMatchObject({
      success: true,
      scanned: 2,
      missing: 1,
      repaired: 1,
      failed: 0,
      vectorCount: 2,
    });
    expect(embedBatch).toHaveBeenCalledTimes(1);
    expect(embedBatch.mock.calls[0][0]).toEqual([
      `${missingObservation.title} ${missingObservation.narrative}`,
    ]);
    expect(save).toHaveBeenCalledTimes(1);

    embedBatch.mockClear();
    save.mockClear();
    const second = await sdk.trigger("mem::index-repair", {
      batchSize: 8,
      checkpointEvery: 100,
    }) as Record<string, number | boolean>;
    expect(second).toMatchObject({
      success: true,
      scanned: 2,
      missing: 0,
      repaired: 0,
      failed: 0,
      vectorCount: 2,
    });
    expect(embedBatch).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("checkpoints a large missing-vector repair and exposes progress", async () => {
    const embedBatch = vi.fn(async (texts: string[]) =>
      texts.map(() => new Float32Array([1, 0, 0])),
    );
    const save = vi.fn(async () => {});
    const sdk = mockSdk();
    registerIndexMaintenanceFunctions(
      sdk as never,
      mockKV({
        memories: [memory("mem_1"), memory("mem_2"), memory("mem_3")],
      }) as never,
      {
        bm25: new SearchIndex(),
        vector: new VectorIndex(),
        embeddingProvider: { ...provider, embedBatch },
        persistence: {
          save,
          getStatus: () => ({ dirty: false }),
        },
      },
    );

    const result = await sdk.trigger("mem::index-repair", {
      batchSize: 1,
      checkpointEvery: 2,
    }) as Record<string, number | boolean>;
    expect(result).toMatchObject({
      success: true,
      scanned: 3,
      missing: 3,
      repaired: 3,
      failed: 0,
      checkpoints: 2,
      bm25Count: 3,
      vectorCount: 3,
    });
    expect(embedBatch).toHaveBeenCalledTimes(3);
    expect(save).toHaveBeenCalledTimes(2);

    const status = await sdk.trigger("mem::index-status") as Record<string, any>;
    expect(status.repair).toMatchObject({
      state: "succeeded",
      result: { success: true, repaired: 3, checkpoints: 2 },
    });
  });

  it("skips a failed embedding item and continues repairing later records", async () => {
    let calls = 0;
    const embedBatch = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("one bad record");
      return [new Float32Array([1, 0, 0])];
    });
    const save = vi.fn(async () => {});
    const sdk = mockSdk();
    registerIndexMaintenanceFunctions(
      sdk as never,
      mockKV({ memories: [memory("mem_bad"), memory("mem_good")] }) as never,
      {
        bm25: new SearchIndex(),
        vector: new VectorIndex(),
        embeddingProvider: { ...provider, embedBatch },
        persistence: {
          save,
          getStatus: () => ({ dirty: false }),
        },
      },
    );

    const result = await sdk.trigger("mem::index-repair", {
      batchSize: 1,
      checkpointEvery: 10,
    }) as Record<string, any>;
    expect(result).toMatchObject({
      success: false,
      scanned: 2,
      missing: 2,
      repaired: 1,
      failed: 1,
      failedIds: ["mem_bad"],
      vectorCount: 1,
      checkpoints: 1,
    });
    expect(embedBatch).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("checkpoints completed work and fails when the repair time budget expires", async () => {
    let now = 0;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => now);
    const embedBatch = vi.fn(async () => {
      now = 6;
      return [new Float32Array([1, 0, 0])];
    });
    const save = vi.fn(async () => {});
    const sdk = mockSdk();
    registerIndexMaintenanceFunctions(
      sdk as never,
      mockKV({ memories: [memory("mem_1"), memory("mem_2")] }) as never,
      {
        bm25: new SearchIndex(),
        vector: new VectorIndex(),
        embeddingProvider: { ...provider, embedBatch },
        persistence: {
          save,
          getStatus: () => ({ dirty: false }),
        },
      },
    );

    const result = await sdk.trigger("mem::index-repair", {
      batchSize: 1,
      checkpointEvery: 100,
      maxDurationMs: 5,
    }) as Record<string, any>;

    expect(result).toMatchObject({
      success: false,
      scanned: 1,
      repaired: 1,
      failed: 1,
      failedIds: ["repair-time-budget-exceeded"],
      vectorCount: 1,
      checkpoints: 1,
      error: "index repair exceeded 5ms time budget",
    });
    expect(embedBatch).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
    dateNow.mockRestore();
  });
});
