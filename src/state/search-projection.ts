import type { SearchJournalEntry } from "../types.js";
import { logger } from "../logger.js";
import type { StateKV } from "./kv.js";
import { KV } from "./schema.js";
import type { SearchBackend, SearchRecord } from "./search-backend.js";

type ProjectionOptions = {
  batchSize?: number;
  batchMs?: number;
  resolveRecord?: (entry: SearchJournalEntry) => Promise<SearchRecord | null>;
};

function journalUpsert(record: SearchRecord): SearchJournalEntry {
  return {
    id: record.id,
    operation: "upsert",
    createdAt: new Date().toISOString(),
    record: {
      id: record.id,
      sessionId: record.sessionId,
      updatedAt: record.updatedAt,
      ...(record.project ? { project: record.project } : {}),
      ...(record.agentId ? { agentId: record.agentId } : {}),
      ...(record.kind ? { kind: record.kind } : {}),
      ...(record.sourceVersion !== undefined
        ? { sourceVersion: record.sourceVersion }
        : {}),
    },
  };
}

function journalDelete(id: string): SearchJournalEntry {
  return {
    id,
    operation: "delete",
    createdAt: new Date().toISOString(),
  };
}

type PendingMutation = {
  entry: SearchJournalEntry;
  record?: SearchRecord;
};

export class SearchProjection {
  private readonly batchSize: number;
  private readonly batchMs: number;
  private readonly pending = new Map<string, PendingMutation>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushPromise: Promise<void> | null = null;
  private building = false;
  private lastAppliedAt: string | undefined;
  private lastError: string | undefined;
  private readonly resolveRecord?: ProjectionOptions["resolveRecord"];

  constructor(
    private readonly kv: StateKV,
    private readonly backend: SearchBackend,
    options: ProjectionOptions = {},
  ) {
    this.batchSize = Math.max(1, Math.floor(options.batchSize ?? 100));
    this.batchMs = Math.max(1, Math.floor(options.batchMs ?? 250));
    this.resolveRecord = options.resolveRecord;
  }

  async start(): Promise<void> {
    await this.backend.open();
    const entries = await this.kv
      .list<SearchJournalEntry>(KV.searchJournal)
      .catch(() => []);
    for (const entry of entries) {
      if (entry?.id && (entry.operation === "upsert" || entry.operation === "delete")) {
        this.pending.set(entry.id, { entry });
      }
    }
    if (this.pending.size > 0) await this.flush();
  }

  async enqueueUpsert(record: SearchRecord): Promise<void> {
    const entry = journalUpsert(record);
    await this.kv.set(KV.searchJournal, entry.id, entry);
    this.pending.set(entry.id, { entry, record });
    await this.afterEnqueue();
  }

  async prepareUpsert(
    metadata: Omit<SearchRecord, "text" | "vector">,
  ): Promise<void> {
    const placeholder: SearchRecord = {
      ...metadata,
      text: "",
      vector: new Float32Array(0),
    };
    const entry = journalUpsert(placeholder);
    await this.kv.set(KV.searchJournal, entry.id, entry);
    this.pending.set(entry.id, { entry });
  }

  async enqueueDelete(id: string): Promise<void> {
    const entry = journalDelete(id);
    await this.kv.set(KV.searchJournal, entry.id, entry);
    this.pending.set(entry.id, { entry });
    await this.afterEnqueue();
  }

  async prepareDelete(id: string): Promise<void> {
    const entry = journalDelete(id);
    await this.kv.set(KV.searchJournal, entry.id, entry);
    this.pending.set(entry.id, { entry });
  }

  beginBuild(): void {
    this.building = true;
    this.clearTimer();
  }

  async finishBuild(): Promise<void> {
    this.building = false;
    const journal = await this.kv
      .list<SearchJournalEntry>(KV.searchJournal)
      .catch(() => []);
    for (const entry of journal) {
      if (entry?.id && !this.pending.has(entry.id)) {
        this.pending.set(entry.id, { entry });
      }
    }
    await this.flush();
  }

  async flush(): Promise<void> {
    if (this.building || this.pending.size === 0) return;
    if (this.flushPromise) return this.flushPromise;
    this.clearTimer();
    const run = async (): Promise<void> => {
      const batch = Array.from(this.pending.values()).slice(0, this.batchSize);
      const upserts: SearchRecord[] = [];
      const deletes: string[] = [];
      for (const mutation of batch) {
        const entry = mutation.entry;
        if (entry.operation === "delete") {
          deletes.push(entry.id);
        } else {
          const record =
            mutation.record ?? (await this.resolveRecord?.(entry)) ?? null;
          if (record) upserts.push(record);
          else deletes.push(entry.id);
        }
      }
      try {
        if (upserts.length > 0) await this.backend.upsertBatch(upserts);
        if (deletes.length > 0) await this.backend.deleteBatch(deletes);
        for (let offset = 0; offset < batch.length; offset += 10) {
          await Promise.all(
            batch.slice(offset, offset + 10).map(async (mutation) => {
            const entry = mutation.entry;
            const current = this.pending.get(entry.id);
            if (current !== mutation) return;
            await this.kv.delete(KV.searchJournal, entry.id);
            this.pending.delete(entry.id);
            }),
          );
        }
        this.lastAppliedAt = new Date().toISOString();
        this.lastError = undefined;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        logger.warn("search projection batch failed; journal retained", {
          batchSize: batch.length,
          error: this.lastError,
        });
        throw error;
      }
    };
    this.flushPromise = run().finally(() => {
      this.flushPromise = null;
      if (!this.building && this.pending.size > 0) this.schedule();
    });
    return this.flushPromise;
  }

  getStatus(): {
    pending: number;
    building: boolean;
    lastAppliedAt?: string;
    lastError?: string;
  } {
    return {
      pending: this.pending.size,
      building: this.building,
      ...(this.lastAppliedAt ? { lastAppliedAt: this.lastAppliedAt } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  stop(): void {
    this.clearTimer();
  }

  private async afterEnqueue(): Promise<void> {
    if (this.building) return;
    if (this.pending.size >= this.batchSize) {
      await this.flush();
    } else {
      this.schedule();
    }
  }

  private schedule(): void {
    if (this.timer || this.building) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush().catch(() => {});
    }, this.batchMs);
    this.timer.unref();
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
