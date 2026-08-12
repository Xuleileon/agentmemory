# Smart Search Retrieval Quality Design

## Goal

Make `memory_smart_search` consistently return durable task knowledge ahead of AgentMemory's own search telemetry and generic hook shells, without deleting source history, changing LanceDB's schema, or rebuilding the index.

## Current failure

LanceDB correctly returns lexical and vector candidates, but RRF currently ranks every observation only by stream rank. A memory-search tool call is captured as another observation whose generated title repeats the original query, so later searches rank the meta-observation ahead of the underlying diagnosis. Generic `post_tool_use`, `prompt_submit`, and injected instruction observations can also occupy the bounded candidate window.

## Architecture

Introduce a pure retrieval-quality policy shared by capture and hybrid retrieval.

- Capture keeps every observation in KV and streams for replay/audit.
- AgentMemory's own `memory_recall` and `memory_smart_search` tool observations are not projected into search indexes going forward.
- Hybrid retrieval over-fetches bounded Lance candidates, enriches them from KV, removes known self-search telemetry and empty generic shells, applies deterministic type/source quality multipliers, then performs session diversification and optional reranking.
- Historical rows remain untouched in LanceDB; the same policy filters them at query time.

This preserves the fact source and avoids a full reindex. The policy is deterministic and does not add an LLM call to the retrieval path.

## Classification rules

### Exclude from normal retrieval

- Observations whose recorded source tool is AgentMemory `memory_recall` or `memory_smart_search`.
- Historical generated search observations proven to be AgentMemory recall/search telemetry by their title or facts/narrative.
- Empty `post_tool_use` shells with a generic title and no semantic fields.

### Down-rank but retain

- Generic `prompt_submit` and other lifecycle-shaped observations.
- Generic injected agent-instruction payloads.
- Ordinary tool searches such as Glob/Grep remain searchable; they are not confused with AgentMemory self-search.

### Promote

- Explicit memories (`mem_*`) and decisions.
- Discoveries, errors, concrete tasks, and file mutations receive smaller boosts.

## Data compatibility

`CompressedObservation` gains optional `sourceHookType` and `sourceToolName` fields. Existing records without them use conservative historical heuristics. LanceDB does not need new columns because classification occurs after KV enrichment.

## Failure handling

- If embedding or graph retrieval fails, existing lexical fallback remains unchanged.
- If quality classification cannot prove a record is self-search telemetry, it is retained with a conservative multiplier.
- If filtering removes candidates, bounded over-fetching supplies replacements up to the caller's requested limit when relevant candidates exist.

## Verification

- Unit tests prove source-tool detection, historical telemetry filtering, generic-shell handling, and quality ordering.
- Hybrid tests prove filtered candidates are replenished and ordinary Glob/Grep search observations remain available.
- Capture tests prove self-search observations persist in KV but do not enqueue/index.
- Existing search, smart-search, MCP, project isolation, and Lance tests remain green.
- Production MCP checks verify Chinese multi-term recall and that `鼠标卡顿` ranks the actual diagnosis above telemetry.
- Runtime status must remain Lance, `projection.pending=0`, and `build.state=idle`; no rebuild is triggered.

