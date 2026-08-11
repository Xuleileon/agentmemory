import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const BRIDGE = join(
  import.meta.dirname,
  "..",
  "src",
  "hooks",
  "cursor-bridge.ts",
);

type CapturedRequest = {
  path: string;
  body: Record<string, unknown>;
};

const children = new Set<ReturnType<typeof spawn>>();

afterEach(() => {
  for (const child of children) child.kill();
  children.clear();
});

async function runBridge(
  event: string,
  payload: Record<string, unknown>,
  options: { inject?: boolean } = {},
): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
  requests: CapturedRequest[];
}> {
  const requests: CapturedRequest[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk.toString();
    });
    req.on("end", () => {
      requests.push({
        path: req.url ?? "",
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, context: "remembered Cursor context" }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("test server did not bind to a TCP port");
  }

  try {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", BRIDGE, event],
      {
        env: {
          PATH: process.env["PATH"] ?? "",
          AGENTMEMORY_URL: `http://127.0.0.1:${address.port}`,
          AGENTMEMORY_SECRET: "",
          AGENTMEMORY_INJECT_CONTEXT: options.inject ? "true" : "false",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    children.add(child);

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.stdin.end(JSON.stringify(payload));

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`Cursor bridge timed out for ${event}`));
      }, 10_000);
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    children.delete(child);
    return { exitCode, stdout, stderr, requests };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const common = {
  conversation_id: "cursor-conversation-1",
  generation_id: "cursor-generation-1",
  hook_event_name: "test",
  workspace_roots: ["C:\\repo\\cursor-project"],
  cwd: "C:\\repo\\cursor-project",
};

describe("Cursor native AgentMemory hook bridge", () => {
  it("registers conversation_id and returns native sessionStart context", async () => {
    const result = await runBridge(
      "sessionStart",
      { ...common, session_id: "cursor-conversation-1", composer_mode: "agent" },
      { inject: true },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      additional_context: "remembered Cursor context",
    });
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]).toMatchObject({
      path: "/agentmemory/session/start",
      body: {
        sessionId: "cursor-conversation-1",
        cwd: "C:\\repo\\cursor-project",
      },
    });
  });

  it("captures both the user prompt and final assistant response", async () => {
    const prompt = await runBridge("beforeSubmitPrompt", {
      ...common,
      prompt: "Fix the authentication race",
    });
    const response = await runBridge("afterAgentResponse", {
      ...common,
      text: "Fixed the race and added a regression test.",
    });

    expect(prompt.exitCode, prompt.stderr).toBe(0);
    expect(JSON.parse(prompt.stdout)).toEqual({ continue: true });
    expect(prompt.requests[0]).toMatchObject({
      path: "/agentmemory/observe",
      body: {
        hookType: "prompt_submit",
        sessionId: "cursor-conversation-1",
        data: { prompt: "Fix the authentication race" },
      },
    });
    expect(response.requests[0]).toMatchObject({
      path: "/agentmemory/observe",
      body: {
        hookType: "agent_response",
        sessionId: "cursor-conversation-1",
        data: { text: "Fixed the race and added a regression test." },
      },
    });
  });

  it("captures successful tools and injects native postToolUse context", async () => {
    const result = await runBridge(
      "postToolUse",
      {
        ...common,
        tool_name: "Read",
        tool_input: { path: "src/auth.ts" },
        tool_output: '{"content":"source"}',
      },
      { inject: true },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      additional_context: "remembered Cursor context",
    });
    expect(result.requests.map((request) => request.path)).toEqual([
      "/agentmemory/observe",
      "/agentmemory/enrich",
    ]);
    expect(result.requests[0]?.body).toMatchObject({
      hookType: "post_tool_use",
      sessionId: "cursor-conversation-1",
      data: {
        tool_name: "Read",
        tool_input: { path: "src/auth.ts" },
        tool_output: '{"content":"source"}',
      },
    });
    expect(result.requests[1]?.body).toMatchObject({
      sessionId: "cursor-conversation-1",
      files: ["src/auth.ts"],
      toolName: "Read",
    });
  });

  it("captures tool failures without treating user interrupts as errors", async () => {
    const failure = await runBridge("postToolUseFailure", {
      ...common,
      tool_name: "Shell",
      tool_input: { command: "npm test" },
      error_message: "Command timed out",
      failure_type: "timeout",
      is_interrupt: false,
    });
    const interrupted = await runBridge("postToolUseFailure", {
      ...common,
      tool_name: "Shell",
      error_message: "Cancelled",
      is_interrupt: true,
    });

    expect(failure.requests[0]?.body).toMatchObject({
      hookType: "post_tool_failure",
      sessionId: "cursor-conversation-1",
      data: {
        tool_name: "Shell",
        error: "Command timed out",
        failure_type: "timeout",
      },
    });
    expect(interrupted.requests).toHaveLength(0);
  });

  it("summarizes on stop and closes the same conversation on sessionEnd", async () => {
    const stopped = await runBridge("stop", {
      ...common,
      status: "completed",
      loop_count: 0,
    });
    const ended = await runBridge("sessionEnd", {
      ...common,
      session_id: "cursor-conversation-1",
      reason: "user_close",
    });

    expect(stopped.requests.map((request) => request.path)).toEqual([
      "/agentmemory/summarize",
    ]);
    expect(stopped.requests[0]?.body).toEqual({
      sessionId: "cursor-conversation-1",
    });
    expect(ended.requests.map((request) => request.path)).toEqual([
      "/agentmemory/session/end",
    ]);
    expect(ended.requests[0]?.body).toEqual({
      sessionId: "cursor-conversation-1",
    });
  });
});
