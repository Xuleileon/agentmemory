export interface SearchRecord {
  id: string;
  sessionId: string;
  text: string;
  vector: Float32Array;
  updatedAt: string;
  project?: string;
  agentId?: string;
  kind?: "memory" | "observation" | "synthetic";
  sourceVersion?: number;
}

export interface SearchHit {
  obsId: string;
  sessionId: string;
  score: number;
}

export interface SearchBackendStatus {
  backend: "lance";
  rowCount: number;
  dimensions: number;
  tableVersion: number;
  fragmentCount: number;
  indices: string[];
}

export interface SearchBackend {
  open(): Promise<void>;
  upsertBatch(records: SearchRecord[]): Promise<void>;
  appendBatch(records: SearchRecord[]): Promise<void>;
  deleteBatch(ids: string[]): Promise<void>;
  lexicalSearch(query: string, limit: number): Promise<SearchHit[]>;
  vectorSearch(vector: Float32Array, limit: number): Promise<SearchHit[]>;
  status(): Promise<SearchBackendStatus>;
  reset(): Promise<void>;
  ensureIndexes(options?: { vector?: boolean }): Promise<void>;
  optimize(): Promise<void>;
  close(): Promise<void>;
}
