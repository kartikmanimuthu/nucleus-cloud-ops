---
phase: 14-tenant-context-enforcement
plan: "02"
subsystem: agent-persistence
tags: [tenant-isolation, chat-history, thread-ids, memory-store]
dependency_graph:
  requires: [14-01]
  provides: [tenant-scoped-chat-history, namespaced-thread-ids, tenant-validated-thread-access]
  affects: [web-ui/lib/agent/persistence.ts, web-ui/app/api/chat/route.ts, web-ui/app/api/threads/route.ts]
tech_stack:
  added: []
  patterns: [tenant-namespaced-thread-ids, tenant-validated-access, configurable-tenant-id]
key_files:
  created: []
  modified:
    - web-ui/lib/agent/persistence.ts
    - web-ui/lib/agent/model-factory.ts
    - web-ui/lib/agent/deep-agent.ts
    - web-ui/lib/agent-ops/executor-graphs.ts
    - web-ui/app/api/chat/route.ts
    - web-ui/app/api/threads/route.ts
decisions:
  - "Thread ID format: tenantId:userId:timestamp — embeds tenant for O(1) validation without DB lookup"
  - "Legacy bare threads (no colon) allowed for owning user only — backward compatible"
  - "DynamoDB adapter accepts tenantId param but ignores it — single-tenant backend, interface compatible"
metrics:
  duration_seconds: 1199
  completed_date: "2026-04-01"
  tasks_completed: 2
  files_modified: 6
requirements: [ISOL-05]
---

# Phase 14 Plan 02: LangGraph Thread Tenant Isolation Summary

Fixed userId/tenantId conflation in persistence layer and enforced tenant isolation on all LangGraph thread operations: namespaced IDs, 403 on cross-tenant access, and tenant-filtered thread listing.

## What Was Built

**Task 1 — persistence.ts tenantId/userId fix:**
- `ChatHistoryInterface` updated: `addMessages/getMessages/clearMessages` now accept `tenantId` as first parameter
- `PostgresChatHistory` stores real `tenantId` (not `userId`) in the `tenantId` column — D-15 bug fixed
- `PostgresMemoryStore.batch()` extracts `tenant_id` from configurable separately from `user_id` — D-14 bug fixed
- `saveMemory(tenantId, userId, ...)` and `searchMemory(tenantId, userId, ...)` updated signatures
- `createMemoryTools(tenantId, userId)` updated — all callers (executor-graphs, deep-agent, assembleTools) updated
- DynamoDB adapter accepts `tenantId` for interface compatibility but passes through to single-tenant backend

**Task 2 — chat + threads route tenant enforcement:**
- New threads: `tenantId:userId:timestamp` format (D-12)
- Existing namespaced threads: embedded tenantId validated against session — mismatch returns 403 (D-13)
- Legacy bare threads: allowed for owning user only (backward compatible)
- Thread list: filtered by `tenantId:` prefix for new threads, by `userId` for legacy threads
- Both streaming and non-streaming `chatHistory.addMessages` pass real `tenantId`
- All graph `configurable` objects include `tenant_id: resolvedTenantId` for memory store scoping
- `threads POST` validates tenant ownership on namespaced thread IDs

## Decisions Made

- Thread ID format `tenantId:userId:timestamp` embeds tenant for O(1) validation without DB lookup
- Legacy bare threads (no colon) allowed for owning user only — backward compatible with existing DynamoDB data
- DynamoDB adapter accepts tenantId param but ignores it — single-tenant backend, interface compatible

## Deviations from Plan

**1. [Rule 2 - Missing critical functionality] Pass tenantId through graphConfig to deep-agent and executor-graphs**
- Found during: Task 1
- Issue: `createMemoryTools` callers in `deep-agent.ts` and `executor-graphs.ts` only had `userId`, no `tenantId` available
- Fix: Destructured `tenantId` from `config` in both files (using `as any` cast since `GraphConfig` type doesn't yet include `tenantId`); updated `createMemoryTools` signature to require both
- Files modified: `web-ui/lib/agent/deep-agent.ts`, `web-ui/lib/agent-ops/executor-graphs.ts`
- Commit: feb2907

## Known Stubs

None — all tenant enforcement is wired to real session data.

## Self-Check: PASSED

- FOUND: web-ui/lib/agent/persistence.ts
- FOUND: web-ui/app/api/chat/route.ts
- FOUND: web-ui/app/api/threads/route.ts
- FOUND: .planning/phases/14-tenant-context-enforcement/14-02-SUMMARY.md
- FOUND commit: feb2907 (Task 1)
- FOUND commit: 6a8a2b6 (Task 2)
