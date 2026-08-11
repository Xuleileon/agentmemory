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
import { memoryToObservation } from "../state/memory-utils.js";

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
  rebuild: (data?: { batchSize?: number }) => Promise<IndexRebuildResult>;
  startRebuild: (data?: { batchSize?: number }) => IndexRebuildStartResult;
  getRebuildStatus: () => IndexRebuildJobStatus;
  repair: (data?: IndexRepairOptions) => Promise<IndexRepairResult>;
  startRepair: (data?: IndexRepairOptions) => IndexRepairStartResult;
  getRepairStatus: () => IndexRepairJobStatus;
}

export type IndexRebuildState = "idle" | "running" | "succeeded" | "failed";

export interface IndexRebuildJobStatus {
  state: IndexRebuildState;
  batchSize?: number;
  startedAt?: string;
  finishedAt?: string;
  result?: IndexRebuildResult;
  error?: string;
}

export interface IndexRebuildStartResult extends IndexRebuildJobStatus {
  accepted: boolean;
}

export interface IndexRepairOptions {
  batchSize?: number;
  checkpointEvery?: number;
  maxDurationMs?: number;
}

export interface IndexRepairResult {
  success: boolean;
  scanned: number;
  missing: number;
  repaired: number;
  failed: number;
  failedIds: string[];
  checkpoints: number;
  bm25Count: number;
  vectorCount: number;
  dimensions: number;
  error?: string;
}

export interface IndexRepairProgress {
  scanned: number;
  missing: number;
  repaired: number;
  failed: number;
  checkpoints: number;
}

export interface IndexRepairJobStatus {
  state: IndexRebuildState;
  batchSize?: number;
  checkpointEvery?: number;
  maxDurationMs?: number;
  startedAt?: string;
  finishedAt?: string;
  progress?: IndexRepairProgress;
  result?: IndexRepairResult;
  error?: string;
}

export interface IndexRepairStartResult extends IndexRepairJobStatus {
  accepted: boolean;
}

const SESSION_READ_BATCH = 10;
const DEFAULT_EMBED_BATCH = 32;
const DEFAULT_REPAIR_CHECKPOINT_EVERY = 25_000;

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
  options: { batchSize?: number } = {},
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
    batchSize: options.batchSize,
  });
  for (const id of memoryResult.failedIds) failedIds.add(id);

  let sessions: Session[] = [];
  try {
    sessions = await kv.list<Session>(KV.sessions);
  } catch (err) {
    failedIds.add(KV.sessions);
    logger.warn("index rebuild: failed to load sessions", { error: message(err) });
  }

  const embedBatchSize =
    Number.isInteger(options.batchSize) && (options.batchSize as number) > 0
      ? (options.batchSize as number)
      : DEFAULT_EMBED_BATCH;
  const pendingObservations: CompressedObservation[] = [];
  const indexObservationBatch = async (count: number): Promise<void> => {
    const batch = pendingObservations.splice(0, count);
    const result = await indexRecordsInto(batch, [], {
      bm25,
      vector,
      embeddingProvider,
      batchSize: embedBatchSize,
    });
    for (const id of result.failedIds) failedIds.add(id);
  };

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
    pendingObservations.push(
      ...observations.flat().filter((item) => item.title && item.narrative),
    );
    while (pendingObservations.length >= embedBatchSize) {
      await indexObservationBatch(embedBatchSize);
    }
  }

  if (pendingObservations.length > 0) {
    await indexObservationBatch(pendingObservations.length);
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

export async function repairMissingIndexes(
  kv: StateKV,
  options: IndexMaintenanceOptions,
  controls: IndexRepairOptions = {},
  onProgress?: (progress: IndexRepairProgress) => void,
): Promise<IndexRepairResult> {
  const vector = options.vector;
  const embeddingProvider = options.embeddingProvider;
  if (!vector || !embeddingProvider) {
    return {
      success: false,
      scanned: 0,
      missing: 0,
      repaired: 0,
      failed: 1,
      failedIds: ["embedding-provider-unavailable"],
      checkpoints: 0,
      bm25Count: options.bm25.size,
      vectorCount: vector?.size ?? 0,
      dimensions: embeddingProvider?.dimensions ?? 0,
      error: "embedding provider is not configured",
    };
  }

  const batchSize =
    Number.isInteger(controls.batchSize) && (controls.batchSize as number) > 0
      ? (controls.batchSize as number)
      : DEFAULT_EMBED_BATCH;
  const checkpointEvery =
    Number.isInteger(controls.checkpointEvery) &&
    (controls.checkpointEvery as number) > 0
      ? (controls.checkpointEvery as number)
      : DEFAULT_REPAIR_CHECKPOINT_EVERY;
  const maxDurationMs =
    Number.isInteger(controls.maxDurationMs) &&
    (controls.maxDurationMs as number) > 0
      ? (controls.maxDurationMs as number)
      : undefined;
  const startedAtMs = Date.now();
  const timeBudgetExceeded = (): boolean =>
    maxDurationMs !== undefined && Date.now() - startedAtMs >= maxDurationMs;
  const failedIds = new Set<string>();
  const pendingMemories: Memory[] = [];
  const pendingObservations: CompressedObservation[] = [];
  let scanned = 0;
  let missing = 0;
  let repaired = 0;
  let checkpoints = 0;
  let repairedSinceCheckpoint = 0;
  let dirtySinceCheckpoint = false;
  let timedOut = false;
  let checkpointFailed = false;

  const progress = (): IndexRepairProgress => ({
    scanned,
    missing,
    repaired,
    failed: failedIds.size,
    checkpoints,
  });
  const publish = (): void => onProgress?.(progress());

  const checkpoint = async (): Promise<void> => {
    if (!dirtySinceCheckpoint) return;
    await options.persistence.save();
    const status = options.persistence.getStatus();
    if (status.dirty) {
      throw new Error(
        typeof status.lastError === "string"
          ? status.lastError
          : "index checkpoint remains dirty",
      );
    }
    checkpoints++;
    repairedSinceCheckpoint = 0;
    dirtySinceCheckpoint = false;
    publish();
  };

  const flushVectors = async (): Promise<void> => {
    if (pendingMemories.length === 0 && pendingObservations.length === 0) return;
    const memories = pendingMemories.splice(0, pendingMemories.length);
    const observations = pendingObservations.splice(0, pendingObservations.length);
    const queuedIds = [
      ...memories.map((item) => item.id),
      ...observations.map((item) => item.id),
    ];
    const sink = new SearchIndex();
    const result = await indexRecordsInto(observations, memories, {
      bm25: sink,
      vector,
      embeddingProvider,
      batchSize,
    });
    for (const id of result.failedIds) failedIds.add(id);
    for (const id of queuedIds) {
      if (!failedIds.has(id) && vector.has(id) && options.bm25.has(id)) {
        repaired++;
        repairedSinceCheckpoint++;
      }
    }
    if (result.vectorized > 0) dirtySinceCheckpoint = true;
    if (repairedSinceCheckpoint >= checkpointEvery) await checkpoint();
    publish();
  };

  const inspectMemory = async (memory: Memory): Promise<void> => {
    if (memory.isLatest === false || !memory.title || !memory.content) return;
    scanned++;
    const missingBm25 = !options.bm25.has(memory.id);
    const missingVector = !vector.has(memory.id);
    if (!missingBm25 && !missingVector) return;
    missing++;
    if (missingBm25) {
      try {
        options.bm25.add(memoryToObservation(memory));
        dirtySinceCheckpoint = true;
      } catch (err) {
        failedIds.add(memory.id);
        logger.warn("index repair: BM25 memory write failed", {
          id: memory.id,
          error: message(err),
        });
      }
    }
    if (missingVector) {
      pendingMemories.push(memory);
      if (pendingMemories.length + pendingObservations.length >= batchSize) {
        await flushVectors();
      }
    } else if (!failedIds.has(memory.id)) {
      repaired++;
      repairedSinceCheckpoint++;
      if (repairedSinceCheckpoint >= checkpointEvery) await checkpoint();
    }
  };

  const inspectObservation = async (obs: CompressedObservation): Promise<void> => {
    if (!obs.title || !obs.narrative) return;
    scanned++;
    const missingBm25 = !options.bm25.has(obs.id);
    const missingVector = !vector.has(obs.id);
    if (!missingBm25 && !missingVector) return;
    missing++;
    if (missingBm25) {
      try {
        options.bm25.add(obs);
        dirtySinceCheckpoint = true;
      } catch (err) {
        failedIds.add(obs.id);
        logger.warn("index repair: BM25 observation write failed", {
          id: obs.id,
          error: message(err),
        });
      }
    }
    if (missingVector) {
      pendingObservations.push(obs);
      if (pendingMemories.length + pendingObservations.length >= batchSize) {
        await flushVectors();
      }
    } else if (!failedIds.has(obs.id)) {
      repaired++;
      repairedSinceCheckpoint++;
      if (repairedSinceCheckpoint >= checkpointEvery) await checkpoint();
    }
  };

  let error: string | undefined;
  try {
    let memories: Memory[] = [];
    try {
      memories = await kv.list<Memory>(KV.memories);
    } catch (err) {
      failedIds.add(KV.memories);
      logger.warn("index repair: failed to load memories", { error: message(err) });
    }
    for (const memory of memories) {
      if (timeBudgetExceeded()) {
        timedOut = true;
        break;
      }
      await inspectMemory(memory);
    }

    let sessions: Session[] = [];
    try {
      sessions = await kv.list<Session>(KV.sessions);
    } catch (err) {
      failedIds.add(KV.sessions);
      logger.warn("index repair: failed to load sessions", { error: message(err) });
    }
    for (
      let offset = 0;
      !timedOut && offset < sessions.length;
      offset += SESSION_READ_BATCH
    ) {
      if (timeBudgetExceeded()) {
        timedOut = true;
        break;
      }
      const chunk = sessions.slice(offset, offset + SESSION_READ_BATCH);
      const observations = await Promise.all(
        chunk.map(async (session) => {
          try {
            return await kv.list<CompressedObservation>(KV.observations(session.id));
          } catch (err) {
            failedIds.add(session.id);
            logger.warn("index repair: failed to load session observations", {
              sessionId: session.id,
              error: message(err),
            });
            return [];
          }
        }),
      );
      for (const obs of observations.flat()) {
        if (timeBudgetExceeded()) {
          timedOut = true;
          break;
        }
        await inspectObservation(obs);
      }
      publish();
    }
    await flushVectors();
    await checkpoint();
    if (timedOut && maxDurationMs !== undefined) {
      error = `index repair exceeded ${maxDurationMs}ms time budget`;
      failedIds.add("repair-time-budget-exceeded");
    }
  } catch (err) {
    checkpointFailed = true;
    error = `index repair checkpoint failed: ${message(err)}`;
  }

  const failures = Array.from(failedIds);
  return {
    success: failures.length === 0 && error === undefined,
    scanned,
    missing,
    repaired,
    failed: failures.length + (checkpointFailed ? 1 : 0),
    failedIds: checkpointFailed ? [...failures, "index-checkpoint"] : failures,
    checkpoints,
    bm25Count: options.bm25.size,
    vectorCount: vector.size,
    dimensions: embeddingProvider.dimensions,
    ...(error ? { error } : {}),
  };
}

export function registerIndexMaintenanceFunctions(
  sdk: ISdk,
  kv: StateKV,
  options: IndexMaintenanceOptions,
): IndexMaintenanceController {
  let rebuildPromise: Promise<IndexRebuildResult> | null = null;
  let rebuildStatus: IndexRebuildJobStatus = { state: "idle" };
  let repairPromise: Promise<IndexRepairResult> | null = null;
  let repairStatus: IndexRepairJobStatus = { state: "idle" };

  const rebuild = (data: { batchSize?: number } = {}): Promise<IndexRebuildResult> => {
    if (rebuildPromise) return rebuildPromise;
    if (repairPromise) {
      return Promise.resolve({
        success: false,
        bm25Count: options.bm25.size,
        vectorCount: options.vector?.size ?? 0,
        failed: 1,
        failedIds: ["index-repair-running"],
        dimensions: options.embeddingProvider?.dimensions ?? 0,
        error: "incremental index repair is already running",
      });
    }

    const startedAt = new Date().toISOString();
    rebuildStatus = {
      state: "running",
      ...(data.batchSize ? { batchSize: data.batchSize } : {}),
      startedAt,
    };

    const task = (async () => {
      const generationBefore = options.persistence.getStatus().dirtyGeneration;
      const replacement = await buildReplacementIndexes(
        kv,
        options.embeddingProvider,
        { batchSize: data.batchSize },
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
        options.vector.adoptFrom(replacement.vector);
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
    });

    rebuildPromise = task()
      .then((result) => {
        rebuildStatus = {
          state: result.success ? "succeeded" : "failed",
          ...(data.batchSize ? { batchSize: data.batchSize } : {}),
          startedAt,
          finishedAt: new Date().toISOString(),
          result,
          ...(result.error ? { error: result.error } : {}),
        };
        return result;
      })
      .catch((err: unknown) => {
        rebuildStatus = {
          state: "failed",
          ...(data.batchSize ? { batchSize: data.batchSize } : {}),
          startedAt,
          finishedAt: new Date().toISOString(),
          error: message(err),
        };
        throw err;
      })
      .finally(() => {
        rebuildPromise = null;
      });

    return rebuildPromise;
  };

  const startRebuild = (
    data: { batchSize?: number } = {},
  ): IndexRebuildStartResult => {
    if (repairPromise) {
      return {
        accepted: false,
        state: "idle",
        error: "incremental index repair is already running",
      };
    }
    const accepted = rebuildPromise === null;
    void rebuild(data).catch((err: unknown) => {
      logger.error("background index rebuild failed", { error: message(err) });
    });
    return { accepted, ...rebuildStatus };
  };

  const getRebuildStatus = (): IndexRebuildJobStatus => ({ ...rebuildStatus });

  const repair = (data: IndexRepairOptions = {}): Promise<IndexRepairResult> => {
    if (repairPromise) return repairPromise;
    if (rebuildPromise) {
      return Promise.resolve({
        success: false,
        scanned: 0,
        missing: 0,
        repaired: 0,
        failed: 1,
        failedIds: ["index-rebuild-running"],
        checkpoints: 0,
        bm25Count: options.bm25.size,
        vectorCount: options.vector?.size ?? 0,
        dimensions: options.embeddingProvider?.dimensions ?? 0,
        error: "atomic index rebuild is already running",
      });
    }

    const startedAt = new Date().toISOString();
    repairStatus = {
      state: "running",
      ...(data.batchSize ? { batchSize: data.batchSize } : {}),
      ...(data.checkpointEvery ? { checkpointEvery: data.checkpointEvery } : {}),
      ...(data.maxDurationMs ? { maxDurationMs: data.maxDurationMs } : {}),
      startedAt,
      progress: { scanned: 0, missing: 0, repaired: 0, failed: 0, checkpoints: 0 },
    };
    repairPromise = repairMissingIndexes(kv, options, data, (next) => {
      repairStatus = { ...repairStatus, progress: next };
    })
      .then((result) => {
        repairStatus = {
          ...repairStatus,
          state: result.success ? "succeeded" : "failed",
          finishedAt: new Date().toISOString(),
          progress: {
            scanned: result.scanned,
            missing: result.missing,
            repaired: result.repaired,
            failed: result.failed,
            checkpoints: result.checkpoints,
          },
          result,
          ...(result.error ? { error: result.error } : {}),
        };
        return result;
      })
      .catch((err: unknown) => {
        repairStatus = {
          ...repairStatus,
          state: "failed",
          finishedAt: new Date().toISOString(),
          error: message(err),
        };
        throw err;
      })
      .finally(() => {
        repairPromise = null;
      });
    return repairPromise;
  };

  const startRepair = (data: IndexRepairOptions = {}): IndexRepairStartResult => {
    if (rebuildPromise) {
      return {
        accepted: false,
        state: "idle",
        error: "atomic index rebuild is already running",
      };
    }
    const accepted = repairPromise === null;
    void repair(data).catch((err: unknown) => {
      logger.error("background index repair failed", { error: message(err) });
    });
    return { accepted, ...repairStatus };
  };

  const getRepairStatus = (): IndexRepairJobStatus => ({ ...repairStatus });

  sdk.registerFunction("mem::index-status", async () => ({
    success: true,
    ...options.persistence.getStatus(),
    provider: options.embeddingProvider?.name ?? null,
    dimensions: options.embeddingProvider?.dimensions ?? 0,
    rebuild: getRebuildStatus(),
    repair: getRepairStatus(),
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

  sdk.registerFunction(
    "mem::index-rebuild",
    async (data: { batchSize?: number; background?: boolean } = {}) =>
      data.background ? startRebuild(data) : rebuild(data),
  );
  sdk.registerFunction(
    "mem::index-repair",
    async (
      data: IndexRepairOptions & { background?: boolean } = {},
    ) => (data.background ? startRepair(data) : repair(data)),
  );
  return {
    rebuild,
    startRebuild,
    getRebuildStatus,
    repair,
    startRepair,
    getRepairStatus,
  };
}
