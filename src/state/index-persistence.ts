import { SearchIndex } from "./search-index.js";
import { VectorIndex } from "./vector-index.js";
import type { StateKV } from "./kv.js";
import { KV, generateId } from "./schema.js";
import { logger } from "../logger.js";
import { safeAudit } from "../functions/audit.js";

const DEBOUNCE_MS = 5000;
const FAILURE_LOG_THROTTLE_MS = 60_000;
const INDEX_PERSISTENCE_FUNCTION_ID = "mem::index-persistence";
const BM25_KEY = "data";
const BM25_MANIFEST_KEY = "data:manifest";
const BM25_SHARD_SCOPE_PREFIX = `${KV.bm25Index}:bm25:`;
const VECTOR_KEY = "vectors";
const VECTOR_MANIFEST_KEY = "vectors:manifest";
const VECTOR_SHARD_SCOPE_PREFIX = `${KV.bm25Index}:vectors:`;
const INDEX_SHARD_KEY = "data";
const DEFAULT_INDEX_SHARD_CHARS = 2_000_000;

type IndexShardManifest = {
  v: 1;
  generation?: string;
  format?: "serialized" | "vector-entry-chunks";
  count?: number;
  shards: Array<{ scope: string; key: string; chars: number }>;
  chars: number;
};

type IndexPersistenceOptions = {
  shardChars?: number;
  createGeneration?: () => string;
};

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

function shardChars(options: IndexPersistenceOptions): number {
  const configured = options.shardChars;
  if (typeof configured !== "number" || !Number.isFinite(configured)) {
    return DEFAULT_INDEX_SHARD_CHARS;
  }
  const wholeChars = Math.floor(configured);
  return wholeChars >= 1 ? wholeChars : DEFAULT_INDEX_SHARD_CHARS;
}

function createIndexGeneration(): string {
  return generateId("idx");
}

function statePath(scope: string, key: string): string {
  return `${scope}/${key}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isValidShardDescriptor(
  shard: unknown,
): shard is IndexShardManifest["shards"][number] {
  if (!shard || typeof shard !== "object") return false;
  const candidate = shard as { scope?: unknown; key?: unknown; chars?: unknown };
  return (
    typeof candidate.scope === "string" &&
    candidate.scope.length > 0 &&
    typeof candidate.key === "string" &&
    candidate.key.length > 0 &&
    Number.isInteger(candidate.chars) &&
    candidate.chars >= 0
  );
}

export class IndexPersistence {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastFailureLogAt = 0;
  private dirtyGeneration = 0;
  private persistedGeneration = 0;
  private savePromise: Promise<void> | null = null;
  private lastSuccessAt: string | undefined;
  private lastErrorAt: string | undefined;
  private lastError: string | undefined;
  private persistedBm25Count = 0;
  private persistedVectorCount = 0;

  constructor(
    private kv: StateKV,
    private bm25: SearchIndex,
    private vector: VectorIndex | null,
    private options: IndexPersistenceOptions = {},
  ) {}

  scheduleSave(): void {
    this.dirtyGeneration++;
    if (this.timer) clearTimeout(this.timer);
    // setTimeout discards the returned promise, so any rejection inside
    // save() would surface as unhandledRejection and crash the process
    // under sustained iii-engine write timeouts (issue #204). Funnel
    // rejections through logFailure() instead.
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flushDirty();
    }, DEBOUNCE_MS);
  }

  save(): Promise<void> {
    this.dirtyGeneration++;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    return this.flushDirty();
  }

  getStatus(): IndexPersistenceStatus {
    return {
      dirtyGeneration: this.dirtyGeneration,
      persistedGeneration: this.persistedGeneration,
      dirty: this.dirtyGeneration > this.persistedGeneration,
      saving: this.savePromise !== null,
      lastSuccessAt: this.lastSuccessAt,
      lastErrorAt: this.lastErrorAt,
      lastError: this.lastError,
      memoryBm25Count: this.bm25.size,
      memoryVectorCount: this.vector?.size ?? 0,
      persistedBm25Count: this.persistedBm25Count,
      persistedVectorCount: this.persistedVectorCount,
    };
  }

  private flushDirty(): Promise<void> {
    if (this.savePromise) return this.savePromise;

    const run = async (): Promise<void> => {
      while (this.persistedGeneration < this.dirtyGeneration) {
        const targetGeneration = this.dirtyGeneration;
        try {
          await this.saveBm25Index(this.bm25.serialize());
          if (this.vector) {
            await this.saveVectorIndex(this.vector);
          }
          this.persistedGeneration = targetGeneration;
          this.persistedBm25Count = this.bm25.size;
          this.persistedVectorCount = this.vector?.size ?? 0;
          this.lastSuccessAt = new Date().toISOString();
          this.lastErrorAt = undefined;
          this.lastError = undefined;
        } catch (err) {
          this.recordFailure(err);
          break;
        }
      }
    };

    this.savePromise = run().finally(() => {
      this.savePromise = null;
    });
    return this.savePromise;
  }

  async load(): Promise<{
    bm25: SearchIndex | null;
    vector: VectorIndex | null;
  }> {
    let bm25: SearchIndex | null = null;
    let vector: VectorIndex | null = null;

    const bm25Data = await this.loadBm25Data();
    if (bm25Data && typeof bm25Data === "string") {
      bm25 = SearchIndex.deserialize(bm25Data);
      this.persistedBm25Count = bm25.size;
    }

    vector = await this.loadVectorIndex();
    if (vector) {
      this.persistedVectorCount = vector.size;
    }

    return { bm25, vector };
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private logFailure(err: unknown): void {
    const now = Date.now();
    // Throttle: persistence failures under load arrive in bursts
    // (iii-engine queue pressure). Logging every debounce flush adds
    // noise without information.
    if (now - this.lastFailureLogAt < FAILURE_LOG_THROTTLE_MS) return;
    this.lastFailureLogAt = now;
    const code = (err as { code?: string })?.code;
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("index persistence: failed to save BM25/vector index", {
      code,
      message,
      hint:
        code === "TIMEOUT"
          ? "iii-engine state::set timed out; recent index updates remain in memory and will retry on the next debounce flush"
          : undefined,
    });
  }

  private recordFailure(err: unknown): void {
    this.lastErrorAt = new Date().toISOString();
    this.lastError = errorMessage(err);
    this.logFailure(err);
  }

  private async saveBm25Index(serialized: string): Promise<void> {
    await this.saveShardedIndex(
      serialized,
      BM25_MANIFEST_KEY,
      BM25_KEY,
      BM25_SHARD_SCOPE_PREFIX,
    );
  }

  private async saveVectorIndex(vector: VectorIndex): Promise<void> {
    await this.saveChunkedIndex(
      vector.serializeChunks(shardChars(this.options)),
      VECTOR_MANIFEST_KEY,
      VECTOR_KEY,
      VECTOR_SHARD_SCOPE_PREFIX,
      { format: "vector-entry-chunks", count: vector.size },
    );
  }

  private async saveShardedIndex(
    serialized: string,
    manifestKey: string,
    legacyKey: string,
    scopePrefix: string,
  ): Promise<void> {
    const chunkSize = shardChars(this.options);
    function* chunks(): Generator<string> {
      for (let offset = 0; offset < serialized.length; offset += chunkSize) {
        yield serialized.slice(offset, offset + chunkSize);
      }
    }
    await this.saveChunkedIndex(
      chunks(),
      manifestKey,
      legacyKey,
      scopePrefix,
      { format: "serialized" },
    );
  }

  private async saveChunkedIndex(
    chunks: Iterable<string>,
    manifestKey: string,
    legacyKey: string,
    scopePrefix: string,
    metadata: Pick<IndexShardManifest, "format" | "count">,
  ): Promise<void> {
    const previous = await this.kv
      .get<IndexShardManifest>(KV.bm25Index, manifestKey)
      .catch(() => null);
    const generation =
      this.options.createGeneration?.() ?? createIndexGeneration();
    const shards: IndexShardManifest["shards"] = [];
    let chars = 0;

    try {
      for (const chunk of chunks) {
        const shardIndex = shards.length;
        const scope = `${scopePrefix}${generation}:${String(shardIndex).padStart(
          5,
          "0",
        )}`;
        const shard = { scope, key: INDEX_SHARD_KEY, chars: chunk.length };
        // Record the intended shard before state::set. Some adapters can
        // commit and then reject on an acknowledgement timeout; rollback must
        // still delete that possibly-committed shard.
        shards.push(shard);
        await this.kv.set(shard.scope, shard.key, chunk);
        chars += chunk.length;
        await this.auditIndexPersistence("shard_write", [
          statePath(shard.scope, shard.key),
        ], {
          scope: shard.scope,
          key: shard.key,
          manifestKey,
          generation,
          chars: chunk.length,
        });
      }
    } catch (err) {
      await this.deleteShards(shards, "shard_write_rollback");
      throw err;
    }

    const nextManifest: IndexShardManifest = {
      v: 1,
      generation,
      ...metadata,
      shards,
      chars,
    };
    try {
      await this.kv.set<IndexShardManifest>(
        KV.bm25Index,
        manifestKey,
        nextManifest,
      );
      await this.auditIndexPersistence("manifest_publish", [
        statePath(KV.bm25Index, manifestKey),
      ], {
        manifestKey,
        generation,
        chars,
        shards: shards.length,
        result: "committed",
      });
    } catch (err) {
      if (await this.isManifestPublished(manifestKey, nextManifest)) {
        await this.auditIndexPersistence("manifest_publish", [
          statePath(KV.bm25Index, manifestKey),
        ], {
          manifestKey,
          generation,
          chars,
          shards: shards.length,
          result: "committed_after_error",
          error: errorMessage(err),
        });
      } else {
        await this.deleteShards(shards, "manifest_publish_rollback");
      }
      throw err;
    }

    await this.deleteKey(KV.bm25Index, legacyKey, "legacy_cleanup");
    if (previous?.v === 1 && Array.isArray(previous.shards)) {
      const currentShardIds = new Set(
        shards.map((shard) => `${shard.scope}\0${shard.key}`),
      );
      for (const shard of previous.shards) {
        if (currentShardIds.has(`${shard.scope}\0${shard.key}`)) continue;
        await this.deleteShards([shard], "previous_generation_cleanup");
      }
    }
  }

  private async auditIndexPersistence(
    action: string,
    targetIds: string[],
    details: Record<string, unknown>,
  ): Promise<void> {
    await safeAudit(
      this.kv,
      "index_persist",
      INDEX_PERSISTENCE_FUNCTION_ID,
      targetIds,
      { action, ...details },
    );
  }

  private async deleteKey(
    scope: string,
    key: string,
    reason: string,
  ): Promise<void> {
    let result = "deleted";
    let error: string | undefined;
    try {
      await this.kv.delete(scope, key);
    } catch (err) {
      result = "failed";
      error = errorMessage(err);
    }
    await this.auditIndexPersistence("delete", [statePath(scope, key)], {
      scope,
      key,
      reason,
      result,
      error,
    });
  }

  private async deleteShards(
    shards: IndexShardManifest["shards"],
    reason: string,
  ): Promise<void> {
    for (const shard of shards) {
      await this.deleteKey(shard.scope, shard.key, reason);
    }
  }

  private async isManifestPublished(
    manifestKey: string,
    expected: IndexShardManifest,
  ): Promise<boolean> {
    const published = await this.kv
      .get<IndexShardManifest>(KV.bm25Index, manifestKey)
      .catch(() => null);
    if (
      published?.v !== 1 ||
      published.generation !== expected.generation ||
      published.chars !== expected.chars ||
      published.format !== expected.format ||
      published.count !== expected.count ||
      !Array.isArray(published.shards) ||
      published.shards.length !== expected.shards.length
    ) {
      return false;
    }
    return published.shards.every((shard, index) => {
      const expectedShard = expected.shards[index];
      if (!expectedShard) return false;
      return (
        shard.scope === expectedShard.scope &&
        shard.key === expectedShard.key &&
        shard.chars === expectedShard.chars
      );
    });
  }

  private async loadBm25Data(): Promise<string | null> {
    return this.loadShardedData(BM25_KEY, BM25_MANIFEST_KEY, "BM25");
  }

  private async loadVectorIndex(): Promise<VectorIndex | null> {
    const manifest = await this.readIndexValue<IndexShardManifest>(
      KV.bm25Index,
      VECTOR_MANIFEST_KEY,
      "vector",
      "manifest",
    );
    if (!manifest.ok) return null;
    if (manifest.value != null && typeof manifest.value === "object") {
      if (manifest.value.format === "vector-entry-chunks") {
        return this.loadVectorEntryChunks(manifest.value);
      }
      const serialized = await this.loadManifestData(manifest.value, "vector");
      return serialized === null ? null : VectorIndex.deserialize(serialized);
    }

    const legacy = await this.readIndexValue<string>(
      KV.bm25Index,
      VECTOR_KEY,
      "vector",
      "legacy",
    );
    if (!legacy.ok) return null;
    return typeof legacy.value === "string"
      ? VectorIndex.deserialize(legacy.value)
      : null;
  }

  private async loadVectorEntryChunks(
    manifest: IndexShardManifest,
  ): Promise<VectorIndex | null> {
    if (
      manifest.v !== 1 ||
      !Array.isArray(manifest.shards) ||
      manifest.shards.length === 0 ||
      !Number.isInteger(manifest.chars) ||
      manifest.chars < 0 ||
      !Number.isInteger(manifest.count) ||
      (manifest.count as number) < 0 ||
      manifest.shards.some((shard) => !isValidShardDescriptor(shard))
    ) {
      logger.warn("index persistence: vector shard manifest invalid");
      return null;
    }

    const vector = new VectorIndex();
    let chars = 0;
    let entries = 0;
    for (const shard of manifest.shards) {
      const chunk = await this.kv
        .get<string>(shard.scope, shard.key)
        .catch(() => null);
      if (typeof chunk !== "string") {
        logger.warn("index persistence: vector shard missing", {
          scope: shard.scope,
          key: shard.key,
        });
        return null;
      }
      if (chunk.length !== shard.chars) {
        logger.warn("index persistence: vector shard length mismatch", {
          scope: shard.scope,
          key: shard.key,
          expected: shard.chars,
          actual: chunk.length,
        });
        return null;
      }
      try {
        entries += vector.loadSerializedChunk(chunk);
      } catch (err) {
        logger.warn("index persistence: vector shard invalid", {
          scope: shard.scope,
          key: shard.key,
          message: errorMessage(err),
        });
        return null;
      }
      chars += chunk.length;
    }
    if (
      chars !== manifest.chars ||
      entries !== manifest.count ||
      vector.size !== manifest.count
    ) {
      logger.warn("index persistence: vector manifest totals mismatch", {
        expectedChars: manifest.chars,
        actualChars: chars,
        expectedCount: manifest.count,
        actualCount: vector.size,
      });
      return null;
    }
    return vector;
  }

  private async loadShardedData(
    legacyKey: string,
    manifestKey: string,
    label: string,
  ): Promise<string | null> {
    const manifest = await this.readIndexValue<IndexShardManifest>(
      KV.bm25Index,
      manifestKey,
      label,
      "manifest",
    );
    if (!manifest.ok) return null;
    // #797: some iii-state adapters return `undefined` (not `null`) for
    // a missing key. The previous `value !== null` check passed
    // undefined through to loadManifestData, which then crashed on
    // `manifest.v` with TypeError. Treat both null and undefined as
    // "no manifest" and fall through to the legacy path. The shape
    // check stays so a malformed-but-present row still fails closed.
    if (
      manifest.value != null &&
      typeof manifest.value === "object"
    ) {
      return this.loadManifestData(manifest.value, label);
    }

    const legacy = await this.readIndexValue<string>(
      KV.bm25Index,
      legacyKey,
      label,
      "legacy",
    );
    if (!legacy.ok) return null;
    if (legacy.value && typeof legacy.value === "string") return legacy.value;
    return null;
  }

  private async readIndexValue<T>(
    scope: string,
    key: string,
    label: string,
    source: "manifest" | "legacy",
  ): Promise<{ ok: true; value: T | null } | { ok: false }> {
    try {
      return { ok: true, value: await this.kv.get<T>(scope, key) };
    } catch (err) {
      logger.warn(`index persistence: ${label} ${source} read failed`, {
        scope,
        key,
        message: errorMessage(err),
      });
      return { ok: false };
    }
  }

  private async loadManifestData(
    manifest: IndexShardManifest,
    label: string,
  ): Promise<string | null> {
    if (
      manifest.v !== 1 ||
      !Array.isArray(manifest.shards) ||
      manifest.shards.length === 0 ||
      !Number.isInteger(manifest.chars) ||
      manifest.chars < 0
    ) {
      logger.warn(`index persistence: ${label} shard manifest invalid`);
      return null;
    }
    for (const shard of manifest.shards) {
      if (!isValidShardDescriptor(shard)) {
        logger.warn(`index persistence: ${label} shard manifest invalid`);
        return null;
      }
    }
    const loadedShards = await Promise.all(
      manifest.shards.map(async (shard) => ({
        shard,
        chunk: await this.kv.get<string>(shard.scope, shard.key).catch(() => null),
      })),
    );
    const chunks: string[] = [];
    let chars = 0;
    for (const { shard, chunk } of loadedShards) {
      if (typeof chunk !== "string") {
        logger.warn(`index persistence: ${label} shard missing`, {
          scope: shard.scope,
          key: shard.key,
        });
        return null;
      }
      if (chunk.length !== shard.chars) {
        logger.warn(`index persistence: ${label} shard length mismatch`, {
          scope: shard.scope,
          key: shard.key,
          expected: shard.chars,
          actual: chunk.length,
        });
        return null;
      }
      chunks.push(chunk);
      chars += chunk.length;
    }
    if (chars !== manifest.chars) {
      logger.warn(`index persistence: ${label} total length mismatch`, {
        expected: manifest.chars,
        actual: chars,
      });
      return null;
    }
    return chunks.join("");
  }
}
