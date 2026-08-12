import type { CompressedObservation } from "../types.js";

export interface RetrievalQuality {
  exclude: boolean;
  multiplier: number;
  reason: string;
}

function normalizeToolName(toolName: string): string {
  return toolName
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function isAgentMemoryRetrievalToolName(
  toolName: string | undefined,
): boolean {
  if (!toolName?.trim()) return false;
  const normalized = normalizeToolName(toolName);
  if (
    normalized === "memory_recall" ||
    normalized === "memory_smart_search"
  ) {
    return true;
  }
  return (
    /(?:^|_)agentmemory(?:_|$)/.test(normalized) &&
    /(?:^|_)memory_(?:recall|smart_search)(?:_|$)/.test(normalized)
  );
}

function historicalSelfRetrieval(observation: CompressedObservation): boolean {
  if (observation.type !== "search") return false;
  const evidence = [
    observation.title,
    observation.subtitle ?? "",
    observation.narrative,
    ...observation.facts,
  ].join("\n");

  if (
    /mcp__agentmemory__memory_(?:recall|smart_search)\b/i.test(evidence) ||
    /agentmemory:memory\s+(?:recall|smart\s+search)\b/i.test(evidence)
  ) {
    return true;
  }

  return /^memory\s+(?:recall|search|smart\s+search)\s+for\b/i.test(
    observation.title.trim(),
  );
}

function isEmptyHookShell(observation: CompressedObservation): boolean {
  if (!/^(?:post_tool_use|pre_tool_use)$/i.test(observation.title.trim())) {
    return false;
  }
  return (
    observation.facts.length === 0 &&
    observation.concepts.length === 0 &&
    observation.files.length === 0 &&
    !observation.narrative.trim()
  );
}

function baseMultiplier(observation: CompressedObservation): number {
  if (observation.id.startsWith("mem_")) return 1.5;
  switch (observation.type) {
    case "decision":
      return 1.35;
    case "discovery":
      return 1.2;
    case "error":
      return 1.15;
    case "task":
      return 1.1;
    case "file_edit":
    case "file_write":
      return 1.05;
    case "command_run":
      return 0.85;
    case "search":
      return 0.8;
    case "file_read":
    case "web_fetch":
      return 0.75;
    case "conversation":
      return 0.65;
    case "notification":
    case "subagent":
    case "image":
    case "other":
      return 0.6;
  }
}

export function classifyRetrievalQuality(
  observation: CompressedObservation,
): RetrievalQuality {
  if (isAgentMemoryRetrievalToolName(observation.sourceToolName)) {
    return {
      exclude: true,
      multiplier: 0,
      reason: "agentmemory-self-retrieval",
    };
  }
  if (historicalSelfRetrieval(observation)) {
    return {
      exclude: true,
      multiplier: 0,
      reason: "historical-self-retrieval",
    };
  }
  if (isEmptyHookShell(observation)) {
    return { exclude: true, multiplier: 0, reason: "empty-hook-shell" };
  }

  const title = observation.title.trim();
  if (/^(?:post_tool_use|pre_tool_use)$/i.test(title)) {
    return { exclude: false, multiplier: 0.15, reason: "generic-tool-hook" };
  }
  if (/^prompt_submit$/i.test(title) || observation.sourceHookType === "prompt_submit") {
    return { exclude: false, multiplier: 0.25, reason: "generic-prompt-hook" };
  }
  if (/^#\s*(?:AGENTS|CLAUDE)\.md\s+instructions$/i.test(title)) {
    return { exclude: false, multiplier: 0.1, reason: "injected-instructions" };
  }

  return {
    exclude: false,
    multiplier: baseMultiplier(observation),
    reason: `type:${observation.type}`,
  };
}

export function shouldProjectObservation(
  observation: CompressedObservation,
): boolean {
  return !classifyRetrievalQuality(observation).exclude;
}
