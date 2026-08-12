import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  AGENTMEMORY_COPILOT_MCP_BLOCK,
  AGENTMEMORY_MCP_BLOCK,
} from "../src/cli/connect/util.js";

function expectLocalFork(command: string, args: string[]): void {
  expect(command.toLowerCase()).toMatch(/(?:^|[\\/])node(?:\.exe)?$/);
  expect(args).toHaveLength(1);
  expect(args[0]!.replace(/\\/g, "/")).toMatch(/\/dist\/standalone\.mjs$/);
  expect(args.join(" ")).not.toContain("@agentmemory/mcp");
}

describe("local fork MCP launch contract", () => {
  it("uses the bundled standalone entrypoint for every generated config", () => {
    expectLocalFork(AGENTMEMORY_MCP_BLOCK.command, AGENTMEMORY_MCP_BLOCK.args);
    expectLocalFork(
      AGENTMEMORY_COPILOT_MCP_BLOCK.command,
      AGENTMEMORY_COPILOT_MCP_BLOCK.args,
    );
    expect(AGENTMEMORY_MCP_BLOCK.env.AGENTMEMORY_FORCE_PROXY).toBe("1");
    expect(AGENTMEMORY_MCP_BLOCK.env.AGENTMEMORY_CALL_TIMEOUT_MS).toBe(
      "120000",
    );
  });

  it("keeps both plugin MCP manifests on the local fork", () => {
    for (const path of ["plugin/.mcp.json", "plugin/.mcp.copilot.json"]) {
      const config = JSON.parse(readFileSync(path, "utf-8"));
      const entry = config.mcpServers.agentmemory;
      expectLocalFork(entry.command, entry.args);
      expect(entry.env.AGENTMEMORY_FORCE_PROXY).toBe("1");
      expect(entry.env.AGENTMEMORY_CALL_TIMEOUT_MS).toBe("120000");
    }
  });

  it("contains no official MCP shim in connect implementations or manifests", () => {
    for (const path of [
      "src/cli/connect/util.ts",
      "src/cli/connect/codex.ts",
      "src/cli/connect/opencode.ts",
      "src/cli/connect/continue.ts",
      "plugin/.mcp.json",
      "plugin/.mcp.copilot.json",
    ]) {
      expect(readFileSync(path, "utf-8"), path).not.toContain(
        "@agentmemory/mcp",
      );
    }
  });

  it("keeps automated connect enabled on Windows", () => {
    const source = readFileSync("src/cli/connect/index.ts", "utf-8");
    expect(source).not.toContain("automated `connect` is not supported");
    expect(source).not.toContain('platform() === "win32"');
  });
});

describe("Windows production autostart contract", () => {
  it("registers a hidden boot-time watchdog without battery shutdown", () => {
    const script = readFileSync(
      "scripts/register-agentmemory-autostart.ps1",
      "utf-8",
    );
    expect(script).toContain("New-ScheduledTaskTrigger -AtStartup");
    expect(script).toContain("New-ScheduledTaskTrigger -AtLogOn");
    expect(script).toContain("-WindowStyle Hidden");
    expect(script).toContain("-Hidden");
    expect(script).toContain("-AllowStartIfOnBatteries");
    expect(script).toContain("-DontStopIfGoingOnBatteries");
    expect(script).toContain("-LogonType S4U");
    expect(script).toContain("AgentMemoryWatchdog");

    const watchdog = readFileSync(
      "scripts/agentmemory-watchdog.ps1",
      "utf-8",
    );
    expect(watchdog).toContain("relativeWorkerPattern");
    expect(watchdog).toContain("iii-exec");
  });
});
