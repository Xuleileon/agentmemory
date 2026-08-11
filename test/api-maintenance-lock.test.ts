import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerApiTriggers } from "../src/triggers/api.js";

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (id: string, handler: Function) => functions.set(id, handler),
    registerTrigger: () => {},
    trigger: vi.fn(async () => ({ success: true })),
    functions,
  };
}

describe("observe maintenance lock", () => {
  let tempRoot: string | undefined;

  afterEach(() => {
    delete process.env.AGENTMEMORY_MAINTENANCE_LOCK_FILE;
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  });

  it("acknowledges but does not persist observations while locked", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "agentmemory-maintenance-"));
    const lockFile = join(tempRoot, "maintenance.lock");
    writeFileSync(lockFile, "index rebuild");
    process.env.AGENTMEMORY_MAINTENANCE_LOCK_FILE = lockFile;
    const sdk = mockSdk();
    registerApiTriggers(sdk as never, {} as never);

    const response = await sdk.functions.get("api::observe")!({ body: {} });

    expect(response).toEqual({
      status_code: 202,
      body: { success: true, skipped: true, reason: "maintenance_lock" },
    });
    expect(sdk.trigger).not.toHaveBeenCalledWith(
      expect.objectContaining({ function_id: "mem::observe" }),
    );
  });
});
