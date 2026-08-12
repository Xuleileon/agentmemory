import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  renameSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import * as p from "@clack/prompts";

// Env values use ${VAR:-default} expansion so the wired MCP entry
// inherits AGENTMEMORY_URL / AGENTMEMORY_SECRET / AGENTMEMORY_TOOLS
// from the user's shell, but never fails parse when the var is unset
// (#510). Earlier `${VAR}` form caused Claude Code to silently drop the
// server when no shell-level export existed — per the Claude Code MCP
// docs, "If a required environment variable is not set and has no
// default value, Claude Code will fail to parse the config."
//
// Defaults match the documented runtime: localhost:3111 (no auth, all
// tools). One wired entry now serves local AND remote (Kubernetes /
// reverse-proxied) deployments without doctor-warning duplicates (#375)
// AND fresh installs that haven't exported envs (#510).
function inferStandaloneEntrypoint(): string {
  const override = process.env["AGENTMEMORY_MCP_ENTRYPOINT"]?.trim();
  if (override) return resolve(override);

  const moduleDir = dirname(fileURLToPath(import.meta.url));
  if (moduleDir.replace(/\\/g, "/").endsWith("/src/cli/connect")) {
    return resolve(moduleDir, "../../../dist/standalone.mjs");
  }
  return resolve(moduleDir, "standalone.mjs");
}

export const AGENTMEMORY_LOCAL_MCP_PATH = inferStandaloneEntrypoint();

export const AGENTMEMORY_MCP_BLOCK = {
  command: "node",
  args: [AGENTMEMORY_LOCAL_MCP_PATH],
  env: {
    AGENTMEMORY_URL: "${AGENTMEMORY_URL:-http://localhost:3111}",
    AGENTMEMORY_SECRET: "${AGENTMEMORY_SECRET:-}",
    AGENTMEMORY_TOOLS: "${AGENTMEMORY_TOOLS:-all}",
    AGENTMEMORY_FORCE_PROXY: "1",
    AGENTMEMORY_CALL_TIMEOUT_MS: "120000",
  },
};

export const AGENTMEMORY_COPILOT_MCP_BLOCK = {
  type: "local" as const,
  ...AGENTMEMORY_MCP_BLOCK,
  tools: ["*"],
};

export function isLocalForkMcpEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const candidate = entry as Record<string, unknown>;
  const command = candidate["command"];
  const args = candidate["args"];
  return (
    typeof command === "string" &&
    /(?:^|[\\/])node(?:\.exe)?$/i.test(command) &&
    Array.isArray(args) &&
    args.length === 1 &&
    typeof args[0] === "string" &&
    /(?:^|[\\/])dist[\\/]standalone\.mjs$/i.test(args[0])
  );
}

export function backupsDir(): string {
  return join(homedir(), ".agentmemory", "backups");
}

export function ensureBackupsDir(): string {
  const dir = backupsDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function backupFile(
  sourcePath: string,
  agent: string,
  ext = "json",
): string {
  ensureBackupsDir();
  const stamp = timestampSlug();
  const target = join(backupsDir(), `${agent}-${stamp}.${ext}`);
  copyFileSync(sourcePath, target);
  return target;
}

export function readJsonSafe<T = unknown>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  renameSync(tmp, path);
}

export function logInstalled(label: string, target: string): void {
  p.log.success(`${label} → wired into ${target}`);
}

export function logAlreadyWired(label: string, target: string): void {
  p.log.info(`${label} already wired in ${target} (use --force to re-install)`);
}

export function logBackup(target: string): void {
  p.log.info(`Backup: ${target}`);
}
