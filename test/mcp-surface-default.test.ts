import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  getAllTools,
  getVisibleTools,
} from "../src/mcp/tools-registry.js";

// plugin manifests and README advertise 51 MCP tools. The old
// default was AGENTMEMORY_TOOLS=core which silently capped the surface
// at 8 essentials with no indication the other 43 existed. Default
// flipped to "all"; the lean set is still accessible via
// AGENTMEMORY_TOOLS=core.
describe("MCP tool surface default (#553)", () => {
  const ORIG = process.env["AGENTMEMORY_TOOLS"];
  beforeEach(() => {
    delete process.env["AGENTMEMORY_TOOLS"];
  });
  afterEach(() => {
    if (ORIG === undefined) delete process.env["AGENTMEMORY_TOOLS"];
    else process.env["AGENTMEMORY_TOOLS"] = ORIG;
  });

  it("default returns the full 51-tool surface, matching plugin advertising", () => {
    const visible = getVisibleTools();
    const all = getAllTools();
    expect(visible.length).toBe(all.length);
    expect(visible.length).toBeGreaterThanOrEqual(48);
  });

  it("AGENTMEMORY_TOOLS=all returns the same full set", () => {
    process.env["AGENTMEMORY_TOOLS"] = "all";
    expect(getVisibleTools().length).toBe(getAllTools().length);
  });

  it("AGENTMEMORY_TOOLS=core returns the 8 essential tools", () => {
    process.env["AGENTMEMORY_TOOLS"] = "core";
    const names = new Set(getVisibleTools().map((t) => t.name));
    expect(names.size).toBe(8);
    for (const t of [
      "memory_save",
      "memory_recall",
      "memory_consolidate",
      "memory_smart_search",
      "memory_sessions",
      "memory_diagnose",
      "memory_lesson_save",
      "memory_reflect",
    ]) {
      expect(names.has(t)).toBe(true);
    }
  });

  it("memory_smart_search exposes an exact project filter", () => {
    const tool = getAllTools().find((entry) => entry.name === "memory_smart_search");
    expect(tool?.inputSchema.properties).toHaveProperty("project");
  });

  it("exposes index status, flush, and atomic rebuild with a positive batch size", () => {
    const tools = new Map(getAllTools().map((tool) => [tool.name, tool]));
    expect(tools.get("memory_index_status")?.inputSchema.properties).toEqual({});
    expect(tools.get("memory_index_flush")?.inputSchema.properties).toEqual({});
    expect(
      tools.get("memory_index_rebuild")?.inputSchema.properties.batchSize,
    ).toMatchObject({ type: "number", minimum: 1 });
    expect(tools.get("memory_index_rebuild")?.description).toMatch(/expensive/i);
    expect(tools.get("memory_index_rebuild")?.description).toMatch(/atomic/i);
  });

  it("protects every index maintenance REST trigger with api auth", () => {
    const source = readFileSync("src/triggers/api.ts", "utf-8");
    for (const [path, method] of [
      ["/agentmemory/index/status", "GET"],
      ["/agentmemory/index/flush", "POST"],
      ["/agentmemory/index/rebuild", "POST"],
    ]) {
      const escaped = path.replaceAll("/", "\\/");
      expect(source).toMatch(
        new RegExp(
          `api_path:\\s*["']${escaped}["'][\\s\\S]{0,180}` +
            `http_method:\\s*["']${method}["'][\\s\\S]{0,180}` +
            `middleware_function_ids:\\s*\\[\\s*["']middleware::api-auth["']`,
        ),
      );
    }
  });

  it("maps the three MCP tools only to their index maintenance function IDs", () => {
    const source = readFileSync("src/mcp/server.ts", "utf-8");
    for (const tool of [
      "memory_index_status",
      "memory_index_flush",
      "memory_index_rebuild",
    ]) {
      expect(source).toContain(`case "${tool}"`);
    }
    for (const functionId of [
      "mem::index-status",
      "mem::index-flush",
      "mem::index-rebuild",
    ]) {
      expect(source).toContain(`"${functionId}"`);
    }
  });

  it("plugin .mcp.json provides default env interpolation so CC parse never fails (#510)", () => {
    const raw = readFileSync("plugin/.mcp.json", "utf-8");
    const cfg = JSON.parse(raw) as {
      mcpServers: { agentmemory: { env: Record<string, string> } };
    };
    const env = cfg.mcpServers.agentmemory.env;
    // Per Claude Code MCP docs: ${VAR} without a default fails config
    // parse when VAR is unset, silently dropping the server. ${VAR:-x}
    // form is what unblocks fresh installs that haven't exported
    // AGENTMEMORY_URL.
    expect(env["AGENTMEMORY_URL"]).toMatch(/\$\{AGENTMEMORY_URL:-/);
    expect(env["AGENTMEMORY_SECRET"]).toMatch(/\$\{AGENTMEMORY_SECRET:-/);
    expect(env["AGENTMEMORY_TOOLS"]).toMatch(/\$\{AGENTMEMORY_TOOLS:-all\}/);
  });
});
