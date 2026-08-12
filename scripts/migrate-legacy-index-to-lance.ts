import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { LanceSearchBackend } from "../src/state/lance-search-backend.js";
import type { CompressedObservation, Memory, Session } from "../src/types.js";
import type { SearchRecord } from "../src/state/search-backend.js";

type Manifest = {
  v: 1;
  generation: string;
  format: string;
  count: number;
  shards: Array<{ scope: string; key: string; chars: number }>;
  chars: number;
};

type BuildCheckpoint = {
  version: 1;
  generation: string;
  nextShard: number;
  rows: number;
  missingDocuments: number;
  invalidVectors: number;
};

type Args = {
  stateStore: string;
  target: string;
  dimensions: number;
  checkpointEvery: number;
  buildVectorIndex: boolean;
};

type ScopeEnvelope = Record<string, unknown>;

export function extractFirstJsonObject(buffer: Buffer): string {
  const text = buffer.toString("utf8");
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (start < 0) {
      if (char === "{") {
        start = index;
        depth = 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) {
      return text.slice(start, index + 1);
    }
  }
  throw new Error("iii scope file does not contain a complete JSON object");
}

export function readScopeFile(path: string): ScopeEnvelope {
  return JSON.parse(extractFirstJsonObject(readFileSync(path))) as ScopeEnvelope;
}

function scopeFile(stateStore: string, scope: string): string {
  return join(stateStore, `${encodeURIComponent(scope)}.bin`);
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`invalid argument near ${key ?? "<end>"}`);
    }
    values.set(key.slice(2), value);
  }
  const stateStore = values.get("state-store");
  const target = values.get("target");
  if (!stateStore || !target) {
    throw new Error("required: --state-store <dir> --target <*.building>");
  }
  if (!basename(target).endsWith(".building")) {
    throw new Error("target must end in .building to prevent overwriting a live index");
  }
  return {
    stateStore: resolve(stateStore),
    target: resolve(target),
    dimensions: Number(values.get("dimensions") ?? 2560),
    checkpointEvery: Math.max(1, Number(values.get("checkpoint-every") ?? 10)),
    buildVectorIndex: values.get("vector-index") !== "false",
  };
}

function manifestFromState(stateStore: string): Manifest {
  const indexScope = readScopeFile(scopeFile(stateStore, "mem:index:bm25"));
  const manifest = indexScope["vectors:manifest"] as Manifest | undefined;
  if (
    !manifest ||
    manifest.v !== 1 ||
    manifest.format !== "vector-entry-chunks" ||
    !Array.isArray(manifest.shards) ||
    !Number.isInteger(manifest.count)
  ) {
    throw new Error("active vector-entry-chunks manifest is missing or invalid");
  }
  return manifest;
}

function readCheckpoint(path: string, generation: string): BuildCheckpoint {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as BuildCheckpoint;
    if (value.version === 1 && value.generation === generation) return value;
  } catch {}
  return {
    version: 1,
    generation,
    nextShard: 0,
    rows: 0,
    missingDocuments: 0,
    invalidVectors: 0,
  };
}

function saveCheckpoint(path: string, checkpoint: BuildCheckpoint): void {
  writeFileSync(path, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
}

function buildDocumentLookup(stateStore: string, dbPath: string, generation: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA temp_store=MEMORY");
  db.exec(
    "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS docs (" +
      "id TEXT PRIMARY KEY, session_id TEXT NOT NULL, text TEXT NOT NULL," +
      "updated_at TEXT NOT NULL, project TEXT NOT NULL, agent_id TEXT NOT NULL," +
      "kind TEXT NOT NULL, source_version INTEGER NOT NULL)",
  );
  const meta = db.prepare("SELECT value FROM meta WHERE key = ?");
  if ((meta.get("generation") as { value?: string } | undefined)?.value === generation &&
      (meta.get("complete") as { value?: string } | undefined)?.value === "true") {
    return db;
  }

  db.exec("DELETE FROM docs; DELETE FROM meta; BEGIN IMMEDIATE");
  const insert = db.prepare(
    "INSERT OR REPLACE INTO docs " +
      "(id, session_id, text, updated_at, project, agent_id, kind, source_version) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  try {
    const sessionScope = readScopeFile(scopeFile(stateStore, "mem:sessions"));
    const projects = new Map<string, string>();
    for (const value of Object.values(sessionScope)) {
      const session = value as Session;
      if (session?.id) projects.set(session.id, session.project ?? "");
    }

    const memoryScope = readScopeFile(scopeFile(stateStore, "mem:memories"));
    for (const value of Object.values(memoryScope)) {
      const memory = value as Memory;
      if (!memory?.id || memory.isLatest === false || !memory.title || !memory.content) continue;
      insert.run(
        memory.id,
        memory.sessionIds?.[0] ?? "memory",
        `${memory.title} ${memory.content}`.slice(0, 16_000),
        memory.updatedAt || memory.createdAt,
        memory.project ?? "",
        memory.agentId ?? "",
        "memory",
        memory.version ?? 1,
      );
    }

    const observationFiles = readdirSync(stateStore).filter(
      (name) => name.startsWith("mem%3Aobs%3A") && name.endsWith(".bin"),
    );
    for (let index = 0; index < observationFiles.length; index++) {
      const scope = readScopeFile(join(stateStore, observationFiles[index]));
      for (const value of Object.values(scope)) {
        const observation = value as CompressedObservation;
        if (!observation?.id || !observation.title || !observation.narrative) continue;
        insert.run(
          observation.id,
          observation.sessionId,
          `${observation.title} ${observation.narrative}`.slice(0, 16_000),
          observation.timestamp,
          projects.get(observation.sessionId) ?? "",
          observation.agentId ?? "",
          "observation",
          1,
        );
      }
      if ((index + 1) % 250 === 0) {
        process.stdout.write(`${JSON.stringify({ phase: "documents", files: index + 1, totalFiles: observationFiles.length })}\n`);
      }
    }
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("generation", generation);
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("complete", "true");
    db.exec("COMMIT");
    return db;
  } catch (error) {
    db.exec("ROLLBACK");
    db.close();
    throw error;
  }
}

function decodeVector(base64: string, dimensions: number): Float32Array | null {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.byteLength !== dimensions * Float32Array.BYTES_PER_ELEMENT) return null;
  return new Float32Array(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength / Float32Array.BYTES_PER_ELEMENT,
  );
}

export async function migrateLegacyIndex(args: Args): Promise<void> {
  const manifest = manifestFromState(args.stateStore);
  const checkpointPath = `${args.target}.checkpoint.json`;
  const dbPath = `${args.target}.docs.sqlite`;
  const checkpoint = readCheckpoint(checkpointPath, manifest.generation);
  const db = buildDocumentLookup(args.stateStore, dbPath, manifest.generation);
  const select = db.prepare(
    "SELECT session_id, text, updated_at, project, agent_id, kind, source_version FROM docs WHERE id = ?",
  );
  const backend = new LanceSearchBackend(args.target, args.dimensions);
  await backend.open();
  const existing = await backend.status();
  if (existing.rowCount !== checkpoint.rows) {
    throw new Error(
      `checkpoint/table mismatch: checkpoint=${checkpoint.rows}, table=${existing.rowCount}; ` +
        "keep the artifacts for diagnosis and restart with a new .building target",
    );
  }

  for (let shardIndex = checkpoint.nextShard; shardIndex < manifest.shards.length; shardIndex++) {
    const shard = manifest.shards[shardIndex];
    const envelope = readScopeFile(scopeFile(args.stateStore, shard.scope));
    if (typeof envelope.data !== "string" || envelope.data.length !== shard.chars) {
      throw new Error(`vector shard ${shard.scope} is missing or has the wrong length`);
    }
    const rows = JSON.parse(envelope.data) as Array<[
      string,
      { embedding?: string; sessionId?: string },
    ]>;
    const records: SearchRecord[] = [];
    for (const [id, vectorEntry] of rows) {
      const doc = select.get(id) as {
        session_id: string;
        text: string;
        updated_at: string;
        project: string;
        agent_id: string;
        kind: string;
        source_version: number;
      } | undefined;
      if (!doc) {
        checkpoint.missingDocuments++;
        continue;
      }
      const vector = vectorEntry.embedding
        ? decodeVector(vectorEntry.embedding, args.dimensions)
        : null;
      if (!vector) {
        checkpoint.invalidVectors++;
        continue;
      }
      records.push({
        id,
        sessionId: doc.session_id || vectorEntry.sessionId || "unknown",
        text: doc.text,
        vector,
        updatedAt: doc.updated_at,
        project: doc.project,
        agentId: doc.agent_id,
        kind: doc.kind as SearchRecord["kind"],
        sourceVersion: doc.source_version,
      });
    }
    await backend.appendBatch(records);
    checkpoint.rows += records.length;
    checkpoint.nextShard = shardIndex + 1;
    if (
      checkpoint.nextShard % args.checkpointEvery === 0 ||
      checkpoint.nextShard === manifest.shards.length
    ) {
      saveCheckpoint(checkpointPath, checkpoint);
      process.stdout.write(
        `${JSON.stringify({ phase: "vectors", ...checkpoint, totalShards: manifest.shards.length })}\n`,
      );
    }
  }

  await backend.ensureIndexes({ vector: args.buildVectorIndex });
  await backend.optimize();
  const status = await backend.status();
  await backend.close();
  db.close();
  if (status.rowCount !== checkpoint.rows) {
    throw new Error(`final Lance row count mismatch: expected ${checkpoint.rows}, got ${status.rowCount}`);
  }
  process.stdout.write(
    `${JSON.stringify({ phase: "complete", manifestCount: manifest.count, ...checkpoint, status })}\n`,
  );
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  migrateLegacyIndex(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
