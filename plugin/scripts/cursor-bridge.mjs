#!/usr/bin/env node
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { config } from "dotenv";
import { execSync } from "node:child_process";
//#region src/hooks/_project.ts
function resolveProject(cwd) {
	const explicit = process.env["AGENTMEMORY_PROJECT_NAME"];
	if (explicit && explicit.trim()) return explicit.trim();
	const dir = cwd && cwd.trim() ? cwd : process.cwd();
	try {
		const top = execSync("git rev-parse --show-toplevel", {
			cwd: dir,
			stdio: [
				"ignore",
				"pipe",
				"ignore"
			],
			timeout: 500
		}).toString().trim();
		if (top) return basename(top);
	} catch {}
	return basename(dir);
}
//#endregion
//#region src/hooks/cursor-bridge.ts
config({
	path: process.env["AGENTMEMORY_ENV_FILE"] || join(homedir(), ".agentmemory", ".env"),
	override: false,
	quiet: true
});
const REST_URL = process.env["AGENTMEMORY_URL"] || "http://localhost:3111";
const SECRET = process.env["AGENTMEMORY_SECRET"] || "";
const INJECT_CONTEXT = process.env["AGENTMEMORY_INJECT_CONTEXT"] === "true";
function authHeaders() {
	const headers = { "Content-Type": "application/json" };
	if (SECRET) headers["Authorization"] = `Bearer ${SECRET}`;
	return headers;
}
async function requestJson(path, body, timeoutMs = 1e4) {
	const response = await fetch(`${REST_URL}${path}`, {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(timeoutMs)
	});
	if (!response.ok) throw new Error(`AgentMemory returned HTTP ${response.status}`);
	return await response.json();
}
function stringValue(value) {
	return typeof value === "string" && value.length > 0 ? value : void 0;
}
function sessionId(data) {
	return stringValue(data["conversation_id"]) || stringValue(data["session_id"]) || stringValue(data["sessionId"]) || stringValue(data["generation_id"]) || "cursor-unknown";
}
function workingDirectory(data) {
	const roots = Array.isArray(data["workspace_roots"]) ? data["workspace_roots"] : [];
	return stringValue(data["cwd"]) || stringValue(roots[0]) || process.env["CURSOR_PROJECT_DIR"] || process.cwd();
}
function truncate(value, max = 8e3) {
	if (typeof value === "string") return value.length > max ? `${value.slice(0, max)}\n[...truncated]` : value;
	if (value && typeof value === "object") {
		const serialized = JSON.stringify(value);
		return serialized.length > max ? `${serialized.slice(0, max)}...[truncated]` : value;
	}
	return value;
}
function toolFiles(toolName, toolInput) {
	if (typeof toolName !== "string" || !toolInput || typeof toolInput !== "object") return [];
	const normalized = toolName.toLowerCase();
	if (![
		"read",
		"write",
		"grep",
		"edit",
		"delete"
	].includes(normalized)) return [];
	const input = toolInput;
	return (normalized === "grep" ? [
		"path",
		"file",
		"file_path"
	] : [
		"file_path",
		"path",
		"file"
	]).map((key) => stringValue(input[key])).filter((value) => Boolean(value));
}
async function observe(data, hookType, observationData) {
	const cwd = workingDirectory(data);
	await requestJson("/agentmemory/observe", {
		hookType,
		sessionId: sessionId(data),
		project: resolveProject(cwd),
		cwd,
		timestamp: (/* @__PURE__ */ new Date()).toISOString(),
		data: observationData
	}, 5e3);
}
async function handle(event, data) {
	const id = sessionId(data);
	const cwd = workingDirectory(data);
	const project = resolveProject(cwd);
	switch (event) {
		case "sessionStart": {
			const context = stringValue((await requestJson("/agentmemory/session/start", {
				sessionId: id,
				project,
				cwd
			}, 5e3))["context"]);
			return INJECT_CONTEXT && context ? { additional_context: context } : {};
		}
		case "beforeSubmitPrompt":
			await observe(data, "prompt_submit", { prompt: data["prompt"] });
			return { continue: true };
		case "preToolUse": return { permission: "allow" };
		case "postToolUse": {
			const toolName = data["tool_name"];
			const toolInput = data["tool_input"];
			await observe(data, "post_tool_use", {
				tool_name: toolName,
				tool_input: toolInput,
				tool_output: truncate(data["tool_output"])
			});
			const files = toolFiles(toolName, toolInput);
			if (!INJECT_CONTEXT || files.length === 0) return {};
			const context = stringValue((await requestJson("/agentmemory/enrich", {
				sessionId: id,
				project,
				files,
				terms: [],
				toolName
			}, 5e3))["context"]);
			return context ? { additional_context: context } : {};
		}
		case "postToolUseFailure":
			if (data["is_interrupt"] === true) return {};
			await observe(data, "post_tool_failure", {
				tool_name: data["tool_name"],
				tool_input: truncate(data["tool_input"], 4e3),
				error: truncate(data["error_message"], 4e3),
				failure_type: data["failure_type"],
				duration: data["duration"]
			});
			return {};
		case "afterAgentResponse":
			await observe(data, "agent_response", { text: truncate(data["text"]) });
			return {};
		case "preCompact":
			await observe(data, "pre_compact", {
				trigger: data["trigger"],
				context_usage_percent: data["context_usage_percent"],
				context_tokens: data["context_tokens"],
				message_count: data["message_count"]
			});
			return {};
		case "subagentStart":
			await observe(data, "subagent_start", {
				agent_id: data["subagent_id"],
				agent_type: data["subagent_type"],
				task: truncate(data["task"], 4e3),
				model: data["subagent_model"],
				parallel: data["is_parallel_worker"]
			});
			return { permission: "allow" };
		case "subagentStop":
			await observe(data, "subagent_stop", {
				agent_type: data["subagent_type"],
				status: data["status"],
				task: truncate(data["task"], 4e3),
				summary: truncate(data["summary"], 8e3),
				modified_files: data["modified_files"]
			});
			return {};
		case "stop":
			await requestJson("/agentmemory/summarize", { sessionId: id }, 12e4);
			return {};
		case "sessionEnd":
			await requestJson("/agentmemory/session/end", { sessionId: id }, 3e4);
			return {};
		default: return {};
	}
}
async function main() {
	const event = process.argv[2] || "";
	let raw = "";
	for await (const chunk of process.stdin) raw += chunk.toString();
	let data = {};
	try {
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed;
	} catch {
		process.stdout.write("{}");
		return;
	}
	try {
		process.stdout.write(JSON.stringify(await handle(event, data)));
	} catch {
		process.stdout.write("{}");
	}
}
await main();
//#endregion
export {};

//# sourceMappingURL=cursor-bridge.mjs.map