import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const entrypoint = new URL("../dist/standalone.mjs", import.meta.url).pathname
  .replace(/^\/(?:[A-Za-z]:)/, (value) => value.slice(1))
  .replace(/\//g, "\\");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entrypoint],
  env: {
    ...process.env,
    AGENTMEMORY_URL: "http://127.0.0.1:3111",
    AGENTMEMORY_FORCE_PROXY: "1",
    AGENTMEMORY_CALL_TIMEOUT_MS: "120000",
  },
  stderr: "pipe",
});
const client = new Client({ name: "local-fork-verifier", version: "1.0.0" });

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const status = await client.callTool({
    name: "memory_index_status",
    arguments: {},
  });
  const recall = await client.callTool({
    name: "memory_recall",
    arguments: {
      query: "显示器方向自动切换 手机竖屏 远程控制 分辨率",
      limit: 3,
    },
  });
  const statusText = status.content?.find((item) => item.type === "text")?.text ?? "";
  const recallText = recall.content?.find((item) => item.type === "text")?.text ?? "";
  const parsedStatus = JSON.parse(statusText);
  const parsedRecall = JSON.parse(recallText);
  console.log(
    JSON.stringify({
      entrypoint,
      toolCount: listed.tools.length,
      backend: parsedStatus.searchBackend?.backend,
      rowCount: parsedStatus.searchBackend?.rowCount,
      pending: parsedStatus.searchBackend?.projection?.pending,
      recallCount: Array.isArray(parsedRecall) ? parsedRecall.length : parsedRecall.results?.length,
    }),
  );
} finally {
  await client.close();
}
