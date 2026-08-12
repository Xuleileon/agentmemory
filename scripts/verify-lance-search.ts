import { resolve } from "node:path";
import { hydrateProcessEnvFromFile } from "../src/config.js";
import { createEmbeddingProvider } from "../src/providers/embedding/index.js";
import { LanceSearchBackend } from "../src/state/lance-search-backend.js";

async function main(): Promise<void> {
  hydrateProcessEnvFromFile();
  const pathArg = process.argv[2];
  if (!pathArg) throw new Error("usage: verify-lance-search.ts <lance-path> [queries...]");
  const path = resolve(pathArg);
  const queries = process.argv.slice(3);
  if (queries.length === 0) {
    queries.push(
      "agentmemory incremental vector persistence",
      "观远 CLI 最新 状态",
      "远程 显示器 竖屏 自动 切换",
    );
  }
  const provider = createEmbeddingProvider();
  if (!provider) throw new Error("embedding provider is not configured");
  const backend = new LanceSearchBackend(path, provider.dimensions);
  for (const query of queries) {
    const lexicalStarted = performance.now();
    const lexical = await backend.lexicalSearch(query, 10);
    const lexicalMs = performance.now() - lexicalStarted;
    const vectorStarted = performance.now();
    const embedding = await provider.embed(query);
    const embeddedMs = performance.now() - vectorStarted;
    const vector = await backend.vectorSearch(embedding, 10);
    const vectorMs = performance.now() - vectorStarted - embeddedMs;
    process.stdout.write(
      `${JSON.stringify({
        query,
        lexical: { count: lexical.length, ms: Math.round(lexicalMs), ids: lexical.map((hit) => hit.obsId) },
        vector: { count: vector.length, embedMs: Math.round(embeddedMs), searchMs: Math.round(vectorMs), ids: vector.map((hit) => hit.obsId) },
      })}\n`,
    );
  }
  await backend.close();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
