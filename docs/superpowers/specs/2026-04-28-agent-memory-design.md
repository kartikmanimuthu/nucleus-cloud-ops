# Agent Long-Term Memory — Design Spec

**Date:** 2026-04-28
**Branch:** ai-memory
**Status:** Approved

## Problem

The AI agent has memory tools (`save_memory`, `search_memory`) registered but never uses them because:

1. `LONG_TERM_MEMORY_GUIDANCE` in `prompt-templates.ts` is dead code — never imported into any agent
2. No graph node proactively searches memory before starting a task
3. No graph node proactively saves learnings after completing a task
4. The search query in `persistence.ts` ignores the `namespacePrefix` filter — returns all tenant memories
5. The guidance text references "DynamoDB" when the store is PostgreSQL

The agent has a filing cabinet but nobody told it to check or file anything.

## Goal

The agent should automatically recall relevant memories before every task and save new learnings after every task, enabling self-improvement across sessions.

## Approach: Deterministic Graph Nodes

Add two new nodes to both fast-agent and planning-agent graphs:

- **`memory_recall`** — runs once before the first working node
- **`memory_save`** — runs once after the final node

These are graph nodes, not prompt hints. Memory usage is deterministic, not LLM-discretionary.

## Design

### State Schema Change

One new field in `ReflectionState` and `graphState`:

```typescript
memoryContext: {
    reducer: (x: string, y: string) => y || x,
    default: () => "",
}
```

### memory_recall Node

**Position in graph:** `START → memory_recall → [first working node]`

**Steps:**

1. Extract the user's last human message as the search query
2. Semantic search across all namespaces (no prefix filter), limit 10 results
3. Pass results through the reflector model with a relevance-filter prompt:
   - Input: user task + raw memory results
   - Output: JSON array of relevant memory keys with one-line reasons
4. Format relevant memories as a markdown section for injection into system prompts
5. Return `{ memoryContext: formattedString }`

**Failure handling:** Log warning, return empty `memoryContext`. Memory never blocks task execution.

**Skip condition:** If no store is available (store is null), skip entirely and return empty memoryContext.

### memory_save Node

**Position in graph:**
- Fast agent: after the agent's final response (before `END`)
- Planning agent: after the `final` node (before `END`)

**Steps:**

1. Single reflector model call analyzing the completed session
2. Extract memories across four categories:
   - Infrastructure facts → `["infra", "<account-id-or-general>"]`
   - User preferences → `["user", "preferences"]`
   - Task outcomes → `["patterns", "<service-type>"]`
   - Error resolutions → `["errors", "<service-type>"]`
3. LLM returns JSON array: `{ namespace: string[], key: string, value: { fact, source, confidence } }`
4. Filter to `confidence: "high"` or `"medium"` only
5. Call `saveMemory()` for each extracted memory
6. Deduplication: prompt includes existing memories from recall to avoid re-saving known facts

**Failure handling:** Log warning, continue. Failed save doesn't affect user response.

### Prompt Integration

All system prompts in both agents get a conditional memory section:

```typescript
const memorySection = state.memoryContext
  ? `\n## Relevant Context from Memory\n${state.memoryContext}\n`
  : '';
```

Inserted alongside identity, skills, account context sections.

### Graph Topology Changes

**Fast Agent:**
```
START → memory_recall → agent → tools ↔ agent → reflect ↔ agent → memory_save → END
```
Note: The fast agent currently ends via conditional edges returning `__end__`. With the save node, those edges route to `memory_save` instead of `END`, and `memory_save` has an unconditional edge to `END`.

**Planning Agent:**
```
START → memory_recall → planner → generate → tools ↔ generate → reflect ↔ revise → final → memory_save → END
```

### Bug Fixes

1. **Remove dead `LONG_TERM_MEMORY_GUIDANCE`** from `prompt-templates.ts` — replaced by dynamic memoryContext
2. **Fix namespace filter in search** (`persistence.ts`): add `WHERE namespace LIKE ${prefix}%` to both vector and fallback queries
3. **Fix `namespacePrefix` handling**: when empty array, search all; when populated, filter by joined prefix

## Files Changed

| File | Change |
|------|--------|
| `web-ui/lib/agent/agent-shared.ts` | Add `memoryContext` to `ReflectionState` and `graphState` |
| `web-ui/lib/agent/fast-agent.ts` | Add `memory_recall` and `memory_save` nodes, rewire graph |
| `web-ui/lib/agent/planning-agent.ts` | Add `memory_recall` and `memory_save` nodes, rewire graph |
| `web-ui/lib/agent/prompt-templates.ts` | Remove dead `LONG_TERM_MEMORY_GUIDANCE` constant |
| `web-ui/lib/agent/persistence.ts` | Fix namespace prefix filtering in search query |
| `web-ui/lib/agent/model-factory.ts` | No changes needed — memory tools already wired correctly |

## Memory Namespace Conventions

| Category | Namespace | Example Key |
|----------|-----------|-------------|
| Infrastructure facts | `["infra", "<account-id>"]` | `prod-ecs-cluster-region` |
| User preferences | `["user", "preferences"]` | `preferred-output-format` |
| Task outcomes | `["patterns", "<service>"]` | `ecs-oom-resolution` |
| Error resolutions | `["errors", "<service>"]` | `rds-connection-timeout-fix` |

## Non-Goals

- Memory expiration/cleanup (existing 90-day TTL handles this)
- Memory UI in the frontend (future work)
- Cross-tenant memory sharing
- Memory versioning or conflict resolution
