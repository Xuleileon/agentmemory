import type { HybridSearchResult } from "../types.js";

let pipeline: any = null;
let pipelineLoading: Promise<any> | null = null;
let pipelineUnavailable = false;

async function loadPipeline(): Promise<any> {
  if (pipelineUnavailable) return null;
  if (pipeline) return pipeline;
  if (pipelineLoading) return pipelineLoading;

  pipelineLoading = (async () => {
    try {
      const { pipeline: createPipeline } = await import(
        "@huggingface/transformers"
      );
      pipeline = await createPipeline(
        "text-classification",
        "Xenova/ms-marco-MiniLM-L-6-v2",
        { dtype: "q8" },
      );
      return pipeline;
    } catch {
      pipeline = null;
      pipelineUnavailable = true;
      return null;
    } finally {
      pipelineLoading = null;
    }
  })();
  return pipelineLoading;
}

export function extractRelevanceScore(output: unknown): number | null {
  const entries = Array.isArray(output) ? output : [output];
  if (entries.length === 0) return null;
  if (
    entries.length > 1 &&
    entries.some(
      (entry) =>
        !entry ||
        typeof entry !== "object" ||
        typeof (entry as { label?: unknown }).label !== "string",
    )
  ) {
    return null;
  }

  const entry = entries[0];
  if (!entry || typeof entry !== "object") return null;
  const score = (entry as { score?: unknown }).score;
  if (
    typeof score !== "number" ||
    !Number.isFinite(score) ||
    score < 0 ||
    score > 1
  ) {
    return null;
  }

  const rawLabel = (entry as { label?: unknown }).label;
  if (rawLabel === undefined && entries.length === 1) return score;
  if (typeof rawLabel !== "string") return null;
  const label = rawLabel.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["label_1", "relevant", "true"].includes(label)) return score;
  if (["label_0", "not_relevant", "irrelevant", "false"].includes(label)) {
    return 1 - score;
  }
  return null;
}

export async function rerank(
  query: string,
  results: HybridSearchResult[],
  topK = 20,
): Promise<HybridSearchResult[]> {
  if (results.length <= 1) return results;

  const reranker = await loadPipeline();
  if (!reranker) return results;

  const candidates = results.slice(0, Math.min(results.length, topK));

  const pairs = candidates.map((r) => ({
    text: `${query} [SEP] ${r.observation.title || ""} ${r.observation.narrative || ""}`.slice(0, 512),
    result: r,
  }));

  const scores: Array<{ result: HybridSearchResult; rerankScore: number }> = [];

  for (const pair of pairs) {
    try {
      const output = await reranker(pair.text);
      const score = extractRelevanceScore(output);
      if (score === null) return results;
      scores.push({ result: pair.result, rerankScore: score });
    } catch {
      return results;
    }
  }

  const scoreValues = scores.map((entry) => entry.rerankScore);
  const scoreRange = Math.max(...scoreValues) - Math.min(...scoreValues);
  if (!Number.isFinite(scoreRange) || scoreRange < 1e-6) return results;

  scores.sort((a, b) => b.rerankScore - a.rerankScore);

  const reranked = scores.map((s, i) => ({
    ...s.result,
    combinedScore: s.rerankScore,
    rerankPosition: i + 1,
  }));
  return reranked.concat(results.slice(candidates.length));
}

export function isRerankerAvailable(): boolean {
  return pipeline !== null;
}
