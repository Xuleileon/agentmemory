import { describe, expect, it, vi } from "vitest";
import { registerApiTriggers } from "../src/triggers/api.js";
import { KV } from "../src/state/schema.js";
import type { Session } from "../src/types.js";

function session(index: number): Session {
  return {
    id: `ses_${index}`,
    project: index % 2 === 0 ? "alpha" : "beta",
    cwd: `C:/repo/${index}`,
    startedAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    status: index === 3 ? "active" : "completed",
    observationCount: index + 1,
  };
}

function mockKV(sessions: Session[]) {
  return {
    get: vi.fn(async (_scope: string, key: string) => ({
      sessionId: key,
      content: `summary ${key}`,
    })),
    set: async <T>(_scope: string, _key: string, data: T) => data,
    delete: async () => {},
    update: async () => {},
    list: vi.fn(async <T>(scope: string): Promise<T[]> =>
      (scope === KV.sessions ? sessions : []) as T[]),
  };
}

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (id: string, handler: Function) => functions.set(id, handler),
    registerTrigger: () => {},
    trigger: async (input: { function_id: string; payload?: unknown }) =>
      functions.get(input.function_id)?.(input.payload),
    functions,
  };
}

async function call(
  sdk: ReturnType<typeof mockSdk>,
  functionId: "api::sessions" | "api::replay::sessions",
  query_params: Record<string, string> = {},
) {
  return sdk.functions.get(functionId)!({ query_params, headers: {} }) as Promise<{
    status_code: number;
    body: Record<string, any>;
  }>;
}

describe("session API pagination", () => {
  it("sorts before slicing and enriches summaries only for the requested page", async () => {
    const kv = mockKV([session(0), session(1), session(2), session(3)]);
    const sdk = mockSdk();
    registerApiTriggers(sdk as never, kv as never);

    const response = await call(sdk, "api::sessions", { limit: "2", offset: "1" });

    expect(response.status_code).toBe(200);
    expect(response.body.sessions.map((item: Session) => item.id)).toEqual([
      "ses_2",
      "ses_1",
    ]);
    expect(response.body).toMatchObject({
      total: 4,
      active: 1,
      totalObservations: 10,
      limit: 2,
      offset: 1,
    });
    expect(kv.get).toHaveBeenCalledTimes(2);
  });

  it("bounds default and explicit replay responses", async () => {
    const sessions = Array.from({ length: 600 }, (_, index) => session(index));
    const kv = mockKV(sessions);
    const sdk = mockSdk();
    registerApiTriggers(sdk as never, kv as never);

    const normal = await call(sdk, "api::sessions");
    const replay = await call(sdk, "api::replay::sessions", { limit: "5000" });

    expect(normal.body.sessions).toHaveLength(100);
    expect(normal.body.total).toBe(600);
    expect(replay.body.sessions).toHaveLength(500);
    expect(replay.body).toMatchObject({ total: 600, limit: 500, offset: 0 });
  });

  it("returns distinct projects without loading session summaries", async () => {
    const kv = mockKV([session(0), session(1), session(2)]);
    const sdk = mockSdk();
    registerApiTriggers(sdk as never, kv as never);

    const response = await call(sdk, "api::sessions", { projects: "true" });

    expect(response.body.projects).toEqual(["alpha", "beta"]);
    expect(response.body.total).toBe(3);
    expect(kv.get).not.toHaveBeenCalled();
  });
});
