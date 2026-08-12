import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LanceSearchBackend } from "../src/state/lance-search-backend.js";

const dirs: string[] = [];

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentmemory-lance-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("LanceSearchBackend", () => {
  it("supports persistent multi-word lexical and vector retrieval", async () => {
    const path = tempDb();
    const backend = new LanceSearchBackend(path, 4);
    await backend.open();
    await backend.upsertBatch([
      {
        id: "obs-display",
        sessionId: "s1",
        text: "远程显示 自动切换 手机竖屏 Mac横屏 脚本",
        vector: new Float32Array([1, 0, 0, 0]),
        updatedAt: "2026-08-12T00:00:00.000Z",
      },
      {
        id: "obs-index",
        sessionId: "s2",
        text: "incremental vector index persistence checkpoint",
        vector: new Float32Array([0, 1, 0, 0]),
        updatedAt: "2026-08-12T00:00:01.000Z",
      },
    ]);

    const zh = await backend.lexicalSearch("自动切换 手机 竖屏 Mac 横屏", 5);
    expect(zh.map((hit) => hit.obsId)).toContain("obs-display");
    const en = await backend.lexicalSearch("vector index persistence", 5);
    expect(en.map((hit) => hit.obsId)).toContain("obs-index");
    const vector = await backend.vectorSearch(new Float32Array([0, 1, 0, 0]), 1);
    expect(vector[0].obsId).toBe("obs-index");

    await backend.close();
    const reopened = new LanceSearchBackend(path, 4);
    await reopened.open();
    expect((await reopened.status()).rowCount).toBe(2);
    expect((await reopened.lexicalSearch("远程 显示", 5))[0].obsId).toBe("obs-display");
    await reopened.close();
  });

  it("upserts idempotently and deletes by id", async () => {
    const backend = new LanceSearchBackend(tempDb(), 4);
    await backend.open();
    await backend.upsertBatch([
      {
        id: "same",
        sessionId: "s1",
        text: "old text",
        vector: new Float32Array([1, 0, 0, 0]),
        updatedAt: "2026-08-12T00:00:00.000Z",
      },
    ]);
    await backend.upsertBatch([
      {
        id: "same",
        sessionId: "s2",
        text: "new searchable text",
        vector: new Float32Array([0, 1, 0, 0]),
        updatedAt: "2026-08-12T00:00:01.000Z",
      },
    ]);
    expect((await backend.status()).rowCount).toBe(1);
    expect((await backend.lexicalSearch("new searchable", 5))[0].sessionId).toBe("s2");
    await backend.deleteBatch(["same"]);
    expect((await backend.status()).rowCount).toBe(0);
    await backend.close();
  });
});
