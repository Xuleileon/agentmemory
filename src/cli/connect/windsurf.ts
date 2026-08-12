import { homedir } from "node:os";
import { join } from "node:path";
import { createJsonMcpAdapter } from "./json-mcp-adapter.js";

export const adapter = createJsonMcpAdapter({
  name: "windsurf",
  displayName: "Windsurf",
  detectDir: join(homedir(), ".codeium", "windsurf"),
  configPath: join(homedir(), ".codeium", "windsurf", "mcp_config.json"),
  docs: "https://docs.windsurf.com/windsurf/cascade/mcp",
  protocolNote:
    "→ Using MCP via ~/.codeium/windsurf/mcp_config.json. Memory bridge runs at :3111 underneath.",
});
