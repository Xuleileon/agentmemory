import { describe, expect, it, vi } from "vitest";
import { SearchProjection } from "../src/state/search-projection.js";
import type { SearchBackend, SearchRecord } from "../src/state/search-backend.js";

function record(id: string): SearchRecord {
  return {
    id,
    sessionId: "s1",
    text: `text ${id}`,
    vector: new Float32Array([1, 0]),
    updatedAt: "2026-08-12T00:00:00.000Z",
  };
}

function harness() {
  const scopes = new Map<string, Map<string, unknown>>();
  const bucket = (scope: string) => {
    let value = scopes.get(scope);
    if (!value) {
      value = new Map();
      scopes.set(scope, value);
    }
    return value;
  };
  const kv = {
    get: vi.fn(async (scope: string, key: string) => bucket(scope).get(key) ?? null),
    set: vi.fn(async (scope: string, key: string, value: unknown) => {
      bucket(scope).set(key, value);
      return value;
    }),
    delete: vi.fn(async (scope: string, key: string) => {
      bucket(scope).delete(key);
    }),
    list: vi.fn(async (scope: string) => Array.from(bucket(scope).values())),
  };
  const backend: SearchBackend = {
    open: vi.fn(async () => {}),
    upsertBatch: vi.fn(async () => {}),
    appendBatch: vi.fn(async () => {}),
    deleteBatch: vi.fn(async () => {}),
    lexicalSearch: vi.fn(async () => []),
    vectorSearch: vi.fn(async () => []),
    status: vi.fn(async () => ({
      backend: "lance" as const,
      rowCount: 0,
      dimensions: 2,
      tableVersion: 0,
      fragmentCount: 0,
      indices: [],
    })),
    optimize: vi.fn(async () => {}),
    reset: vi.fn(async () => {}),
    ensureIndexes: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  return { kv, backend, scopes };
}

describe("SearchProjection", () => {
  it("persists journal entries before applying a deduplicated microbatch", async () => {
    const { kv, backend } = harness();
    const projection = new SearchProjection(kv as never, backend, {
      batchSize: 100,
      batchMs: 60_000,
    });
    await projection.enqueueUpsert(record("a"));
    await projection.enqueueUpsert({ ...record("a"), text: "new a" });

    expect(kv.set).toHaveBeenCalledTimes(2);
    expect(backend.upsertBatch).not.toHaveBeenCalled();
    await projection.flush();

    expect(backend.upsertBatch).toHaveBeenCalledTimes(1);
    const rows = vi.mocked(backend.upsertBatch).mock.calls[0][0];
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe("new a");
    expect(kv.delete).toHaveBeenCalled();
    projection.stop();
  });

  it("keeps failed batches journaled for replay", async () => {
    const { kv, backend, scopes } = harness();
    vi.mocked(backend.upsertBatch).mockRejectedValueOnce(new Error("disk busy"));
    const projection = new SearchProjection(kv as never, backend, {
      batchSize: 100,
      batchMs: 60_000,
    });
    await projection.enqueueUpsert(record("a"));
    await expect(projection.flush()).rejects.toThrow("disk busy");
    expect(scopes.get("mem:search-journal")?.size).toBe(1);
    projection.stop();
  });

  it("holds live writes during a shadow build and drains them afterwards", async () => {
    const { kv, backend } = harness();
    const projection = new SearchProjection(kv as never, backend, {
      batchSize: 1,
      batchMs: 1,
    });
    projection.beginBuild();
    await projection.enqueueUpsert(record("live"));
    expect(backend.upsertBatch).not.toHaveBeenCalled();
    await projection.finishBuild();
    expect(backend.upsertBatch).toHaveBeenCalledTimes(1);
    projection.stop();
  });
});
