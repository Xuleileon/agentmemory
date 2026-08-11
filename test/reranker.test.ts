import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@huggingface/transformers", () => {
  throw new Error("not installed");
});

import {
  extractRelevanceScore,
  rerank,
  isRerankerAvailable,
} from "../src/state/reranker.js";

describe("extractRelevanceScore", () => {
  it("uses relevant labels directly and inverts non-relevant labels", () => {
    expect(extractRelevanceScore([{ label: "LABEL_1", score: 0.8 }])).toBe(0.8);
    expect(extractRelevanceScore([{ label: "relevant", score: 0.7 }])).toBe(0.7);
    expect(extractRelevanceScore([{ label: "LABEL_0", score: 0.9 }])).toBeCloseTo(0.1);
    expect(extractRelevanceScore([{ label: "not_relevant", score: 0.75 }])).toBe(0.25);
  });

  it("rejects non-finite scores and ambiguous multi-class output", () => {
    expect(extractRelevanceScore([{ label: "LABEL_1", score: Number.NaN }])).toBeNull();
    expect(extractRelevanceScore([{ score: 0.9 }, { score: 0.1 }])).toBeNull();
  });
});

describe("reranker", () => {
  it("returns results unchanged when @huggingface/transformers is unavailable", async () => {
    const results = [
      {
        observation: {
          id: "o1",
          title: "First",
          narrative: "First result",
        },
        bm25Score: 0.5,
        vectorScore: 0.6,
        graphScore: 0,
        combinedScore: 0.8,
        sessionId: "s1",
      },
      {
        observation: {
          id: "o2",
          title: "Second",
          narrative: "Second result",
        },
        bm25Score: 0.3,
        vectorScore: 0.4,
        graphScore: 0,
        combinedScore: 0.5,
        sessionId: "s1",
      },
    ] as any;

    const reranked = await rerank("test query", results);
    expect(reranked).toEqual(results);
  });

  it("isRerankerAvailable returns false when not loaded", () => {
    expect(isRerankerAvailable()).toBe(false);
  });

  it("handles single result gracefully", async () => {
    const results = [
      {
        observation: { id: "o1", title: "Only" },
        combinedScore: 1.0,
      },
    ] as any;

    const reranked = await rerank("query", results);
    expect(reranked).toHaveLength(1);
  });

  it("handles empty results", async () => {
    const reranked = await rerank("query", []);
    expect(reranked).toHaveLength(0);
  });
});

describe("reranker with loaded pipeline", () => {
  afterEach(() => {
    vi.doUnmock("@huggingface/transformers");
    vi.resetModules();
  });

  it("invokes the @huggingface/transformers pipeline and reorders by score", async () => {
    const mockPipeline = vi.fn(async (text: string) => [
      { score: text.includes("First") ? 0.9 : 0.1 },
    ]);
    vi.doMock("@huggingface/transformers", () => ({
      pipeline: () => Promise.resolve(mockPipeline),
    }));
    vi.resetModules();

    const { rerank } = await import("../src/state/reranker.js");

    const results = [
      { observation: { id: "o2", title: "Second", narrative: "" }, combinedScore: 0.9 },
      { observation: { id: "o1", title: "First", narrative: "" }, combinedScore: 0.5 },
    ] as any;

    const reranked = await rerank("query", results);

    expect(mockPipeline).toHaveBeenCalled();
    expect(reranked[0].observation.id).toBe("o1");
  });

  it("interprets non-relevant labels in the correct direction", async () => {
    const mockPipeline = vi.fn(async (text: string) =>
      text.includes("First")
        ? [{ label: "LABEL_0", score: 0.9 }]
        : [{ label: "LABEL_1", score: 0.8 }],
    );
    vi.doMock("@huggingface/transformers", () => ({
      pipeline: () => Promise.resolve(mockPipeline),
    }));
    vi.resetModules();
    const { rerank } = await import("../src/state/reranker.js");
    const results = [
      { observation: { id: "first", title: "First" }, combinedScore: 0.7 },
      { observation: { id: "second", title: "Second" }, combinedScore: 0.6 },
    ] as any;

    const reranked = await rerank("query", results);

    expect(reranked.map((result: any) => result.observation.id)).toEqual([
      "second",
      "first",
    ]);
  });

  it("falls back to the original RRF order and scores when output is saturated", async () => {
    vi.doMock("@huggingface/transformers", () => ({
      pipeline: () =>
        Promise.resolve(vi.fn(async () => [{ label: "LABEL_1", score: 1 }])),
    }));
    vi.resetModules();
    const { rerank } = await import("../src/state/reranker.js");
    const results = [
      { observation: { id: "rrf-1", title: "First" }, combinedScore: 0.7 },
      { observation: { id: "rrf-2", title: "Second" }, combinedScore: 0.6 },
    ] as any;

    const reranked = await rerank("query", results);

    expect(reranked.map((result: any) => result.observation.id)).toEqual([
      "rrf-1",
      "rrf-2",
    ]);
    expect(reranked.map((result: any) => result.combinedScore)).toEqual([0.7, 0.6]);
    expect(reranked).toEqual(results);
  });

  it("falls back when any reranker score is non-finite", async () => {
    vi.doMock("@huggingface/transformers", () => ({
      pipeline: () =>
        Promise.resolve(
          vi.fn(async (text: string) => [
            { label: "LABEL_1", score: text.includes("First") ? 0.8 : Infinity },
          ]),
        ),
    }));
    vi.resetModules();
    const { rerank } = await import("../src/state/reranker.js");
    const results = [
      { observation: { id: "rrf-1", title: "First" }, combinedScore: 0.7 },
      { observation: { id: "rrf-2", title: "Second" }, combinedScore: 0.6 },
    ] as any;

    expect(await rerank("query", results)).toEqual(results);
  });

  it("uses varied valid scores while preserving component scores", async () => {
    vi.doMock("@huggingface/transformers", () => ({
      pipeline: () =>
        Promise.resolve(
          vi.fn(async (text: string) => [
            { label: "relevant", score: text.includes("Second") ? 0.9 : 0.2 },
          ]),
        ),
    }));
    vi.resetModules();
    const { rerank } = await import("../src/state/reranker.js");
    const results = [
      {
        observation: { id: "first", title: "First" },
        bm25Score: 0.6,
        vectorScore: 0.4,
        graphScore: 0.2,
        combinedScore: 0.7,
      },
      {
        observation: { id: "second", title: "Second" },
        bm25Score: 0.1,
        vectorScore: 0.8,
        graphScore: 0.3,
        combinedScore: 0.6,
      },
    ] as any;

    const reranked = await rerank("query", results);

    expect(reranked[0]).toMatchObject({
      bm25Score: 0.1,
      vectorScore: 0.8,
      graphScore: 0.3,
      combinedScore: 0.9,
      rerankPosition: 1,
    });
  });
});
