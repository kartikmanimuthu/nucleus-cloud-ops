---
phase: 04-kb-inventory-agent-ops
plan: 06
subsystem: database
tags: [postgres, prisma, repository-pattern, agent-ops, inventory, feature-flags]

requires:
  - phase: 04-kb-inventory-agent-ops
    provides: "AgentOpsRun/Event/ScheduledTask/Inventory repository implementations + factory functions"

provides:
  - "agent-ops-service.ts delegates all persistence to getAgentOpsRunRepository() + getAgentOpsEventRepository()"
  - "scheduled-task-service.ts delegates all persistence to getScheduledTaskRepository()"
  - "inventory/resources/route.ts reads from getInventoryRepository().listResources()"
  - "USE_PG_AGENT_OPS and USE_PG_INVENTORY feature flags now functional end-to-end"

affects: [05-langgraph-persistence, agent-ops-api-routes, inventory-page]

tech-stack:
  added: []
  patterns:
    - "Service layer delegates to repository factory — zero direct Dynamoose/DynamoDB imports in service files"
    - "API route delegates to repository factory — zero DynamoDB SDK imports in route files"

key-files:
  created: []
  modified:
    - web-ui/lib/agent-ops/agent-ops-service.ts
    - web-ui/lib/agent-ops/scheduled-task-service.ts
    - web-ui/app/api/inventory/resources/route.ts

key-decisions:
  - "agent-ops-service.ts getRunEvents passes tenantId='default' for backward compat — DynamoDB PK is RUN#<runId> with no tenant scope"
  - "inventory route drops account name enrichment (BatchGetItem) — no DynamoDB imports allowed; enrichment can be added to repo interface later"
  - "inventory route maps cursor/page params to offset pagination matching IInventoryRepository.listResources()"

patterns-established:
  - "Service layer pattern: import factory function, call repo method, return result — no persistence logic in service"
  - "Route pattern: import getXxxRepository, call listResources/getX, return NextResponse.json"

requirements-completed: [AOPS-02, AOPS-03, AOPS-04, AOPS-05, AOPS-06, KB-05]

duration: 8min
completed: 2026-03-28
---

# Phase 04 Plan 06: Gap Closure — Service + Route Wiring Summary

**agent-ops-service.ts, scheduled-task-service.ts, and inventory/resources/route.ts rewired to repository factory, making USE_PG_AGENT_OPS and USE_PG_INVENTORY feature flags functional end-to-end**

## Performance

- **Duration:** ~8 min
- **Started:** 2026-03-28T06:30:00Z
- **Completed:** 2026-03-28T06:38:00Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- Removed all Dynamoose/DynamoDB imports from agent-ops-service.ts and scheduled-task-service.ts
- Removed all DynamoDB SDK imports from inventory/resources/route.ts (303 lines → 47 lines)
- All ~15 agent-ops API routes now use PostgreSQL when USE_PG_AGENT_OPS=true (via service → factory → postgres repo)
- findAwaitingApprovalRun now uses single WHERE query (AOPS-06 fix)
- tryAcquireExecutionLock now uses ON CONFLICT via postgres repo (AOPS-04 fix)

## Task Commits

1. **Task 1: Rewrite agent-ops-service.ts and scheduled-task-service.ts** - `9cacd2b` (feat)
2. **Task 2: Rewrite inventory/resources/route.ts** - `6238dd8` (feat)

## Files Created/Modified
- `web-ui/lib/agent-ops/agent-ops-service.ts` - Removed Dynamoose, delegates to getAgentOpsRunRepository() + getAgentOpsEventRepository()
- `web-ui/lib/agent-ops/scheduled-task-service.ts` - Removed DynamoDBClient/ScheduledTaskModel, delegates to getScheduledTaskRepository()
- `web-ui/app/api/inventory/resources/route.ts` - Removed DynamoDB SDK, delegates to getInventoryRepository().listResources()

## Decisions Made
- getRunEvents passes tenantId='default' for backward compat — DynamoDB event PK is RUN#<runId> with no tenant scope; postgres repo accepts it
- Account name enrichment (BatchGetItem) dropped from inventory route — no DynamoDB imports allowed; can be added to IInventoryRepository interface in a future plan
- accountIds comma-separated param normalized to single accountId before passing to listResources (IInventoryRepository has accountId: string, not accountIds: string[])

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## Next Phase Readiness
- Phase 04 gap closure complete — all service/route wiring done
- Phase 05 (LangGraph persistence) can proceed
- Remaining gap: Lambda files (kb_sync_processor, discovery) still use direct DynamoDB — tracked in 04-07-PLAN.md if it exists

---
*Phase: 04-kb-inventory-agent-ops*
*Completed: 2026-03-28*
