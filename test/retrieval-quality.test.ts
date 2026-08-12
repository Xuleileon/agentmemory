import { describe, expect, it } from "vitest";
import type { CompressedObservation } from "../src/types.js";
import {
  classifyRetrievalQuality,
  isAgentMemoryRetrievalToolName,
  shouldProjectObservation,
} from "../src/state/retrieval-quality.js";

function observation(
  overrides: Partial<CompressedObservation> = {},
): CompressedObservation {
  return {
    id: "obs_1",
    sessionId: "ses_1",
    timestamp: "2026-08-12T00:00:00.000Z",
    type: "task",
    title: "Diagnose Windows mouse stuttering",
    facts: ["The runaway process saturated CPU scheduling."],
    narrative: "Stopped the runaway process and verified input recovered.",
    concepts: ["Windows", "mouse stuttering"],
    files: [],
    importance: 8,
    ...overrides,
  };
}

describe("retrieval quality policy", () => {
  it.each([
    "mcp__agentmemory__memory_recall",
    "mcp__agentmemory__memory_smart_search",
    "agentmemory:memory recall",
    "agentmemory:memory smart search",
    "memory_recall",
    "memory_smart_search",
  ])("recognizes AgentMemory retrieval tool %s", (toolName) => {
    expect(isAgentMemoryRetrievalToolName(toolName)).toBe(true);
  });

  it.each(["Glob", "Grep", "web_search", "memory_save"])(
    "does not confuse ordinary tool %s with AgentMemory retrieval",
    (toolName) => {
      expect(isAgentMemoryRetrievalToolName(toolName)).toBe(false);
    },
  );

  it("excludes newly tagged AgentMemory recall observations", () => {
    const result = classifyRetrievalQuality(
      observation({
        type: "search",
        title: "memory_recall",
        sourceHookType: "post_tool_use",
        sourceToolName: "mcp__agentmemory__memory_recall",
      }),
    );

    expect(result).toEqual({
      exclude: true,
      multiplier: 0,
      reason: "agentmemory-self-retrieval",
    });
  });

  it("excludes historical generated memory-search telemetry", () => {
    const result = classifyRetrievalQuality(
      observation({
        type: "search",
        title: "Memory recall for mouse stuttering and task manager freeze",
        facts: ["Tool used: mcp__agentmemory__memory_recall"],
        narrative: "The agent queried its memory for troubleshooting steps.",
        concepts: ["memory recall"],
        importance: 2,
      }),
    );

    expect(result.exclude).toBe(true);
    expect(result.reason).toBe("historical-self-retrieval");
  });

  it("keeps ordinary Glob observations searchable", () => {
    const result = classifyRetrievalQuality(
      observation({
        type: "search",
        title: "Glob",
        narrative: '{"pattern":"MEMORY.md","path":"C:/work"}',
        sourceToolName: "Glob",
      }),
    );

    expect(result.exclude).toBe(false);
    expect(result.multiplier).toBeGreaterThan(0);
  });

  it("excludes empty generic post-tool shells", () => {
    const result = classifyRetrievalQuality(
      observation({
        type: "other",
        title: "post_tool_use",
        facts: [],
        narrative: "",
        concepts: [],
        files: [],
      }),
    );

    expect(result.exclude).toBe(true);
    expect(result.reason).toBe("empty-hook-shell");
  });

  it("promotes explicit memories over generic prompt observations", () => {
    const memory = classifyRetrievalQuality(
      observation({ id: "mem_diagnosis", type: "decision" }),
    );
    const prompt = classifyRetrievalQuality(
      observation({
        id: "obs_prompt",
        type: "conversation",
        title: "prompt_submit",
        sourceHookType: "prompt_submit",
      }),
    );

    expect(memory.exclude).toBe(false);
    expect(prompt.exclude).toBe(false);
    expect(memory.multiplier).toBeGreaterThan(prompt.multiplier);
  });

  it("keeps self-retrieval observations in the fact source but out of projection", () => {
    const selfSearch = observation({
      type: "search",
      sourceHookType: "post_tool_use",
      sourceToolName: "mcp__agentmemory__memory_smart_search",
    });
    const glob = observation({
      type: "search",
      sourceHookType: "post_tool_use",
      sourceToolName: "Glob",
    });

    expect(shouldProjectObservation(selfSearch)).toBe(false);
    expect(shouldProjectObservation(glob)).toBe(true);
  });
});
