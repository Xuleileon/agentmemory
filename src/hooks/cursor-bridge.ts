#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { config as loadDotEnv } from "dotenv";
import { resolveProject } from "./_project.js";

loadDotEnv({
  path: process.env["AGENTMEMORY_ENV_FILE"] || join(homedir(), ".agentmemory", ".env"),
  override: false,
  quiet: true,
});

const REST_URL = process.env["AGENTMEMORY_URL"] || "http://localhost:3111";
const SECRET = process.env["AGENTMEMORY_SECRET"] || "";
const INJECT_CONTEXT = process.env["AGENTMEMORY_INJECT_CONTEXT"] === "true";

type JsonObject = Record<string, unknown>;

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (SECRET) headers["Authorization"] = `Bearer ${SECRET}`;
  return headers;
}

async function requestJson(
  path: string,
  body: JsonObject,
  timeoutMs = 10_000,
): Promise<JsonObject> {
  const response = await fetch(`${REST_URL}${path}`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`AgentMemory returned HTTP ${response.status}`);
  return (await response.json()) as JsonObject;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sessionId(data: JsonObject): string {
  return (
    stringValue(data["conversation_id"]) ||
    stringValue(data["session_id"]) ||
    stringValue(data["sessionId"]) ||
    stringValue(data["generation_id"]) ||
    "cursor-unknown"
  );
}

function workingDirectory(data: JsonObject): string {
  const roots = Array.isArray(data["workspace_roots"])
    ? data["workspace_roots"]
    : [];
  return (
    stringValue(data["cwd"]) ||
    stringValue(roots[0]) ||
    process.env["CURSOR_PROJECT_DIR"] ||
    process.cwd()
  );
}

function truncate(value: unknown, max = 8000): unknown {
  if (typeof value === "string") {
    return value.length > max ? `${value.slice(0, max)}\n[...truncated]` : value;
  }
  if (value && typeof value === "object") {
    const serialized = JSON.stringify(value);
    return serialized.length > max
      ? `${serialized.slice(0, max)}...[truncated]`
      : value;
  }
  return value;
}

function toolFiles(toolName: unknown, toolInput: unknown): string[] {
  if (typeof toolName !== "string" || !toolInput || typeof toolInput !== "object") {
    return [];
  }
  const normalized = toolName.toLowerCase();
  if (!["read", "write", "grep", "edit", "delete"].includes(normalized)) {
    return [];
  }
  const input = toolInput as JsonObject;
  const keys = normalized === "grep"
    ? ["path", "file", "file_path"]
    : ["file_path", "path", "file"];
  return keys
    .map((key) => stringValue(input[key]))
    .filter((value): value is string => Boolean(value));
}

async function observe(
  data: JsonObject,
  hookType: string,
  observationData: JsonObject,
): Promise<void> {
  const cwd = workingDirectory(data);
  await requestJson("/agentmemory/observe", {
    hookType,
    sessionId: sessionId(data),
    project: resolveProject(cwd),
    cwd,
    timestamp: new Date().toISOString(),
    data: observationData,
  }, 5_000);
}

async function handle(event: string, data: JsonObject): Promise<JsonObject> {
  const id = sessionId(data);
  const cwd = workingDirectory(data);
  const project = resolveProject(cwd);

  switch (event) {
    case "sessionStart": {
      const result = await requestJson("/agentmemory/session/start", {
        sessionId: id,
        project,
        cwd,
      }, 5_000);
      const context = stringValue(result["context"]);
      return INJECT_CONTEXT && context ? { additional_context: context } : {};
    }
    case "beforeSubmitPrompt":
      await observe(data, "prompt_submit", { prompt: data["prompt"] });
      return { continue: true };
    case "preToolUse":
      return { permission: "allow" };
    case "postToolUse": {
      const toolName = data["tool_name"];
      const toolInput = data["tool_input"];
      await observe(data, "post_tool_use", {
        tool_name: toolName,
        tool_input: toolInput,
        tool_output: truncate(data["tool_output"]),
      });

      const files = toolFiles(toolName, toolInput);
      if (!INJECT_CONTEXT || files.length === 0) return {};
      const result = await requestJson("/agentmemory/enrich", {
        sessionId: id,
        project,
        files,
        terms: [],
        toolName,
      }, 5_000);
      const context = stringValue(result["context"]);
      return context ? { additional_context: context } : {};
    }
    case "postToolUseFailure":
      if (data["is_interrupt"] === true) return {};
      await observe(data, "post_tool_failure", {
        tool_name: data["tool_name"],
        tool_input: truncate(data["tool_input"], 4000),
        error: truncate(data["error_message"], 4000),
        failure_type: data["failure_type"],
        duration: data["duration"],
      });
      return {};
    case "afterAgentResponse":
      await observe(data, "agent_response", {
        text: truncate(data["text"]),
      });
      return {};
    case "preCompact":
      await observe(data, "pre_compact", {
        trigger: data["trigger"],
        context_usage_percent: data["context_usage_percent"],
        context_tokens: data["context_tokens"],
        message_count: data["message_count"],
      });
      return {};
    case "subagentStart":
      await observe(data, "subagent_start", {
        agent_id: data["subagent_id"],
        agent_type: data["subagent_type"],
        task: truncate(data["task"], 4000),
        model: data["subagent_model"],
        parallel: data["is_parallel_worker"],
      });
      return { permission: "allow" };
    case "subagentStop":
      await observe(data, "subagent_stop", {
        agent_type: data["subagent_type"],
        status: data["status"],
        task: truncate(data["task"], 4000),
        summary: truncate(data["summary"], 8000),
        modified_files: data["modified_files"],
      });
      return {};
    case "stop":
      await requestJson("/agentmemory/summarize", { sessionId: id }, 120_000);
      return {};
    case "sessionEnd":
      await requestJson("/agentmemory/session/end", { sessionId: id }, 30_000);
      return {};
    default:
      return {};
  }
}

async function main(): Promise<void> {
  const event = process.argv[2] || "";
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk.toString();

  let data: JsonObject = {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      data = parsed as JsonObject;
    }
  } catch {
    process.stdout.write("{}");
    return;
  }

  try {
    process.stdout.write(JSON.stringify(await handle(event, data)));
  } catch {
    // Cursor hooks are telemetry/enrichment only. Never block the agent loop
    // when AgentMemory is unavailable or a provider is rate-limited.
    process.stdout.write("{}");
  }
}

await main();
