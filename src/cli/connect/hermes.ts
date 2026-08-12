import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import * as p from "@clack/prompts";
import type { ConnectAdapter, ConnectOptions, ConnectResult } from "./types.js";
import {
  AGENTMEMORY_MCP_BLOCK,
  logAlreadyWired,
  logInstalled,
} from "./util.js";

const HERMES_DIR = join(homedir(), ".hermes");
const HERMES_CONFIG = join(HERMES_DIR, "config.yaml");
const DOCS = "https://github.com/rohitg00/agentmemory/tree/main/integrations/hermes";

function localConfig(): string {
  const entrypoint = AGENTMEMORY_MCP_BLOCK.args[0]!.replace(/'/g, "''");
  return [
    "mcp_servers:",
    "  agentmemory:",
    `    command: ${AGENTMEMORY_MCP_BLOCK.command}`,
    `    args: ['${entrypoint}']`,
    "    env:",
    '      AGENTMEMORY_URL: "http://localhost:3111"',
    '      AGENTMEMORY_FORCE_PROXY: "1"',
    '      AGENTMEMORY_CALL_TIMEOUT_MS: "120000"',
    "memory:",
    "  provider: agentmemory",
    "",
  ].join("\n");
}

function isLocallyWired(yaml: string): boolean {
  return (
    /agentmemory\s*:/i.test(yaml) &&
    /dist[\\/]+standalone\.mjs/i.test(yaml)
  );
}

export const adapter: ConnectAdapter = {
  name: "hermes",
  displayName: "Hermes Agent",
  category: "native",
  docs: DOCS,
  protocolNote:
    "→ Using MCP. Hooks are also available — see https://github.com/rohitg00/agentmemory/tree/main/integrations/hermes.",

  detect(): boolean {
    return existsSync(HERMES_DIR);
  },

  async install(opts: ConnectOptions): Promise<ConnectResult> {
    const exists = existsSync(HERMES_CONFIG);
    const current = exists ? readFileSync(HERMES_CONFIG, "utf-8") : "";
    if (isLocallyWired(current)) {
      logAlreadyWired("Hermes Agent", HERMES_CONFIG);
      return { kind: "already-wired", mutatedPath: HERMES_CONFIG };
    }

    if (!exists || current.trim().length === 0) {
      if (opts.dryRun) {
        p.log.info(`[dry-run] Would create ${HERMES_CONFIG}`);
        return { kind: "installed", mutatedPath: HERMES_CONFIG };
      }
      mkdirSync(dirname(HERMES_CONFIG), { recursive: true });
      writeFileSync(HERMES_CONFIG, localConfig(), "utf-8");
      logInstalled("Hermes Agent", HERMES_CONFIG);
      return { kind: "installed", mutatedPath: HERMES_CONFIG };
    }

    p.log.warn(
      "Hermes config already exists and needs a structure-aware YAML merge; leaving it unchanged.",
    );
    p.note(
      [
        `Add to ${HERMES_CONFIG}:`,
        "",
        "  mcp_servers:",
        "    agentmemory:",
        `      command: ${AGENTMEMORY_MCP_BLOCK.command}`,
        `      args: ['${AGENTMEMORY_MCP_BLOCK.args[0]!.replace(/'/g, "''")}']`,
        "",
        "  memory:",
        "    provider: agentmemory",
        "",
        `Full guide: ${DOCS}`,
      ].join("\n"),
      "Hermes manual install",
    );
    return {
      kind: "stub",
      reason: "existing-yaml-merge-not-implemented",
    };
  },
};
