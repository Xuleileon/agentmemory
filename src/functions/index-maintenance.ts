import type { ISdk } from "iii-sdk";
import type {
  CompressedObservation,
  EmbeddingProvider,
  Memory,
  Session,
} from "../types.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import { SearchIndex } from "../state/search-index.js";
import { VectorIndex } from "../state/vector-index.js";
import type { IndexPersistenceStatus } from "../state/index-persistence.js";
import { indexRecordsInto } from "./search.js";
import { logger } from "../logger.js";

export interface IndexRebuildResult {
  success: boolean;
  bm25Count: number;
  vectorCount: number;
  failed: number;
  failedIds: string[];
  dimensions: number;
  error?: string;
}

export interface ReplacementIndexBuild extends IndexRebuildResult {
  bm25: SearchIndex;
  vector: VectorIndex | null;
}

type PersistenceStatus = Pick<IndexPersistenceStatus, "dirty"> &
  Partial<IndexPersistenceStatus>;

export interface IndexMaintenanceOptions {
  bm25: SearchIndex;
  vector: VectorIndex | null;
  embeddingProvider: EmbeddingProvider | null;
  persistence: {
    save: () => Promise<void>;
    getStatus: () => PersistenceStatus;
  };
}

export interface IndexMaintenanceController {
  rebuild: () => Promise<IndexRebuildResult>;
}

const SESSION_READ_BATCH = 10;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function publicResult(build: ReplacementIndexBuild): IndexRebuildResult {
  const {
    success,
    bm25Count,
    vectorCount,
    failed,
    failedIds,
    dimensions,
    error,
  } = build;
  return {
    success,
    bm25Count,
    vectorCount,
    failed,
    failedIds,
    dimensions,
    ...(error ? { error } : {}),
  };
}

export async function buildReplacementIndexes(
  kv: StateKV,
  embeddingProvider: EmbeddingProvider | null,
): Promise<ReplacementIndexBuild> {
  const bm25 = new SearchIndex();
  const vector = embeddingProvider ? new VectorIndex() : null;
  const failedIds = new Set<string>();

  let memories: Memory[] = [];
  try {
    memories = await kv.list<Memory>(KV.memories);
  } catch (err) {
    failedIds.add(KV.memories);
    logger.warn("index rebuild: failed to load memories", { error: message(err) });
  }

  const memoryResult = await indexRecordsInto([], memories, {
    bm25,
    vector,
    embeddingProvider,
  });
  for (const id of memoryResult.failedIds) failedIds.add(id);

  let sessions: Session[] = [];
  try {
    sessions = await kv.list<Session>(KV.sessions);
  } catch (err) {
    failedIds.add(KV.sessions);
    logger.warn("index rebuild: failed to load sessions", { error: message(err) });
  }

  for (let offset = 0; offset < sessions.length; offset += SESSION_READ_BATCH) {
    const chunk = sessions.slice(offset, offset + SESSION_READ_BATCH);
    const observations = await Promise.all(
      chunk.map(async (session) => {
        try {
          return await kv.list<CompressedObservation>(KV.observations(session.id));
        } catch (err) {
          failedIds.add(session.id);
          logger.warn("index rebuild: failed to load session observations", {
            sessionId: session.id,
            error: message(err),
          });
          return [];
        }
      }),
    );
    const observationResult = await indexRecordsInto(observations.flat(), [], {
      bm25,
      vector,
      embeddingProvider,
    });
    for (const id of observationResult.failedIds) failedIds.add(id);
  }

  const failures = Array.from(failedIds);
  return {
    success: failures.length === 0,
    bm25Count: bm25.size,
    vectorCount: vector?.size ?? 0,
    failed: failures.length,
    failedIds: failures,
    dimensions: embeddingProvider?.dimensions ?? 0,
    bm25,
    vector,
  };
}

export function registerIndexMaintenanceFunctions(
  sdk: ISdk,
  kv: StateKV,
  options: IndexMaintenanceOptions,
): IndexMaintenanceController {
  let rebuildPromise: Promise<IndexRebuildResult> | null = null;

  const rebuild = (): Promise<IndexRebuildResult> => {
    if (rebuildPromise) return rebuildPromise;

    rebuildPromise = (async () => {
      const generationBefore = options.persistence.getStatus().dirtyGeneration;
      const replacement = await buildReplacementIndexes(
        kv,
        options.embeddingProvider,
      );
      if (!replacement.success) return publicResult(replacement);

      // A live write that lands while the off-path build is running updates
      // the active index and advances this generation. Swapping now would
      // discard that write, so abort and let the caller retry once traffic is
      // quiet (the production full backfill pauses hooks before invoking us).
      const generationAfter = options.persistence.getStatus().dirtyGeneration;
      if (
        typeof generationBefore === "number" &&
        typeof generationAfter === "number" &&
        generationAfter !== generationBefore
      ) {
        return {
          ...publicResult(replacement),
          success: false,
          failed: 1,
          failedIds: ["concurrent-index-mutation"],
          error: "index changed during rebuild; retry",
        };
      }

      options.bm25.restoreFrom(replacement.bm25);
      if (options.vector && replacement.vector) {
        options.vector.restoreFrom(replacement.vector);
      } else if (options.vector) {
        options.vector.clear();
      }

      try {
        await options.persistence.save();
      } catch (err) {
        return {
          ...publicResult(replacement),
          success: false,
          error: `index checkpoint failed: ${message(err)}`,
        };
      }

      const status = options.persistence.getStatus();
      if (status.dirty) {
        return {
          ...publicResult(replacement),
          success: false,
          error:
            typeof status.lastError === "string"
              ? `index checkpoint failed: ${status.lastError}`
              : "index checkpoint remains dirty",
        };
      }
      return publicResult(replacement);
    })().finally(() => {
      rebuildPromise = null;
    });

    return rebuildPromise;
  };

  sdk.registerFunction("mem::index-status", async () => ({
    success: true,
    ...options.persistence.getStatus(),
    provider: options.embeddingProvider?.name ?? null,
    dimensions: options.embeddingProvider?.dimensions ?? 0,
  }));

  sdk.registerFunction("mem::index-flush", async () => {
    await options.persistence.save();
    const status = options.persistence.getStatus();
    return {
      success: !status.dirty,
      ...status,
      provider: options.embeddingProvider?.name ?? null,
      dimensions: options.embeddingProvider?.dimensions ?? 0,
    };
  });

  sdk.registerFunction("mem::index-rebuild", rebuild);
  return { rebuild };
}
