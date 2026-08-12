import { connect, Index, MatchQuery, Operator } from "@lancedb/lancedb";
import type { Connection, Table } from "@lancedb/lancedb";
import type {
  SearchBackend,
  SearchBackendStatus,
  SearchHit,
  SearchRecord,
} from "./search-backend.js";

const TABLE_NAME = "search_records";

type LanceRow = {
  id: string;
  session_id: string;
  text: string;
  vector: number[];
  updated_at: string;
  project: string;
  agent_id: string;
  kind: string;
  source_version: number;
};

function row(record: SearchRecord): LanceRow {
  return {
    id: record.id,
    session_id: record.sessionId,
    text: record.text,
    vector: Array.from(record.vector),
    updated_at: record.updatedAt,
    project: record.project ?? "",
    agent_id: record.agentId ?? "",
    kind: record.kind ?? "observation",
    source_version: record.sourceVersion ?? 1,
  };
}

function escapeSql(value: string): string {
  return value.replaceAll("'", "''");
}

export class LanceSearchBackend implements SearchBackend {
  private connection: Connection | null = null;
  private table: Table | null = null;
  private opening: Promise<void> | null = null;

  constructor(
    private readonly path: string,
    private readonly dimensions: number,
  ) {}

  async open(): Promise<void> {
    if (this.connection) return;
    if (this.opening) return this.opening;
    this.opening = (async () => {
      this.connection = await connect(this.path);
      const names = await this.connection.tableNames();
      if (names.includes(TABLE_NAME)) {
        this.table = await this.connection.openTable(TABLE_NAME);
      }
    })();
    try {
      await this.opening;
    } finally {
      this.opening = null;
    }
  }

  async upsertBatch(records: SearchRecord[]): Promise<void> {
    if (records.length === 0) return;
    for (const record of records) {
      if (record.vector.length !== this.dimensions) {
        throw new Error(
          `Lance search vector dimension mismatch for ${record.id}: ` +
            `expected ${this.dimensions}, received ${record.vector.length}`,
        );
      }
    }
    await this.open();
    const rows = records.map(row);
    if (!this.table) {
      this.table = await this.connection!.createTable(TABLE_NAME, rows, {
        mode: "create",
      });
      await this.ensureIndexes({ vector: false });
      return;
    }
    await this.table
      .mergeInsert("id")
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute(rows, { timeoutMs: 30_000 });
  }

  async appendBatch(records: SearchRecord[]): Promise<void> {
    if (records.length === 0) return;
    for (const record of records) {
      if (record.vector.length !== this.dimensions) {
        throw new Error(
          `Lance search vector dimension mismatch for ${record.id}: ` +
            `expected ${this.dimensions}, received ${record.vector.length}`,
        );
      }
    }
    await this.open();
    const rows = records.map(row);
    if (!this.table) {
      this.table = await this.connection!.createTable(TABLE_NAME, rows, {
        mode: "create",
      });
      return;
    }
    await this.table.add(rows);
  }

  async deleteBatch(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.open();
    if (!this.table) return;
    const values = ids.map((id) => `'${escapeSql(id)}'`).join(",");
    await this.table.delete(`id IN (${values})`);
  }

  async lexicalSearch(query: string, limit: number): Promise<SearchHit[]> {
    await this.open();
    if (!this.table || !query.trim() || limit <= 0) return [];
    const match = new MatchQuery(query.trim(), "text", {
      operator: Operator.Or,
    });
    const rows = await this.table
      .search(match, "fts", "text")
      .select(["id", "session_id", "_score"])
      .limit(limit)
      .toArray({ timeoutMs: 30_000 });
    return rows.map((result) => ({
      obsId: String(result.id),
      sessionId: String(result.session_id),
      score: Number(result._score ?? 0),
    }));
  }

  async vectorSearch(
    vector: Float32Array,
    limit: number,
  ): Promise<SearchHit[]> {
    if (vector.length !== this.dimensions) {
      throw new Error(
        `Lance query vector dimension mismatch: expected ${this.dimensions}, ` +
          `received ${vector.length}`,
      );
    }
    await this.open();
    if (!this.table || limit <= 0) return [];
    const rows = await this.table
      .vectorSearch(Array.from(vector))
      .distanceType("cosine")
      .select(["id", "session_id", "_distance"])
      .limit(limit)
      .toArray({ timeoutMs: 30_000 });
    return rows.map((result) => ({
      obsId: String(result.id),
      sessionId: String(result.session_id),
      score: 1 - Number(result._distance ?? 1),
    }));
  }

  async ensureIndexes(options: { vector?: boolean } = {}): Promise<void> {
    await this.open();
    if (!this.table) return;
    let indices = await this.table.listIndices();
    if (!indices.some((index) => index.columns.includes("text"))) {
      await this.table.createIndex("text", {
        config: Index.fts({
          baseTokenizer: "icu",
          lowercase: true,
          withPosition: true,
        }),
      });
    }
    indices = await this.table.listIndices();
    if (!indices.some((index) => index.columns.includes("id"))) {
      await this.table.createIndex("id", { config: Index.btree() });
    }
    if (
      options.vector === true &&
      !(await this.table.listIndices()).some((index) =>
        index.columns.includes("vector"),
      )
    ) {
      await this.table.createIndex("vector", {
        config: Index.hnswSq({
          distanceType: "cosine",
        numPartitions: 8,
        }),
        replace: false,
      });
    }
  }

  async reset(): Promise<void> {
    await this.open();
    if (this.table) {
      this.table.close();
      this.table = null;
    }
    const names = await this.connection!.tableNames();
    if (names.includes(TABLE_NAME)) {
      await this.connection!.dropTable(TABLE_NAME);
    }
  }

  async status(): Promise<SearchBackendStatus> {
    await this.open();
    if (!this.table) {
      return {
        backend: "lance",
        rowCount: 0,
        dimensions: this.dimensions,
        tableVersion: 0,
        fragmentCount: 0,
        indices: [],
      };
    }
    const [rowCount, tableVersion, stats, indices] = await Promise.all([
      this.table.countRows(),
      this.table.version(),
      this.table.stats(),
      this.table.listIndices(),
    ]);
    return {
      backend: "lance",
      rowCount,
      dimensions: this.dimensions,
      tableVersion,
      fragmentCount: stats.numFragments,
      indices: indices.map((index) => index.name),
    };
  }

  async optimize(): Promise<void> {
    await this.open();
    if (!this.table) return;
    await this.table.optimize();
  }

  async close(): Promise<void> {
    this.table?.close();
    this.connection?.close();
    this.table = null;
    this.connection = null;
  }
}
