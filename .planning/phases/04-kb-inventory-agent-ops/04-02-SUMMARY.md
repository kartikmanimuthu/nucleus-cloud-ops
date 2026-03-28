---
phase: 04-kb-inventory-agent-ops
plan: 02
subsystem: database
tags: [prisma, postgresql, dynamodb, repository-pattern, knowledge-base, tdd]

requires:
  - phase: 04-kb-inventory-agent-ops
    plan: 01
    provides: KnowledgeBase and DataSource Prisma models in schema.prisma

provides:
  - IKnowledgeBaseRepository interface + DynamoDB + PostgreSQL implementations
  - IDataSourceRepository interface + DynamoDB + PostgreSQL implementations
  - getKnowledgeBaseRepository() and getDataSourceRepository() in repository-factory.ts
  - USE_PG_KB feature flag wiring (controls both KB and DataSource backends)
  - USE_PG_INVENTORY=false added to .env.local.example

affects: [04-03, 04-04, 04-05]

tech-stack:
  added: []
  patterns:
    - "IKnowledgeBaseRepository: 7 methods including atomic updateDataSourceCount/updateVectorCount"
    - "IDataSourceRepository: tenantId on all methods for multi-tenant safety (D-17)"
    - "PostgreSQL atomic counters via Prisma increment (no read-modify-write)"
    - "DynamoDB atomic counters via if_not_exists + :delta expression"
    - "updateMany with tenantId+id in where clause for safe multi-tenant updates/deletes"

key-files:
  created:
    - web-ui/lib/db/repositories/knowledge-base/interface.ts
    - web-ui/lib/db/repositories/knowledge-base/dynamo.ts
    - web-ui/lib/db/repositories/knowledge-base/postgres.ts
    - web-ui/lib/db/repositories/knowledge-base/dynamo.test.ts
    - web-ui/lib/db/repositories/knowledge-base/postgres.test.ts
    - web-ui/lib/db/repositories/data-source/interface.ts
    - web-ui/lib/db/repositories/data-source/dynamo.ts
    - web-ui/lib/db/repositories/data-source/postgres.ts
    - web-ui/lib/db/repositories/data-source/dynamo.test.ts
    - web-ui/lib/db/repositories/data-source/postgres.test.ts
  modified:
    - web-ui/lib/db/repository-factory.ts
    - web-ui/.env.local.example

key-decisions:
  - "DataSourceDynamoRepository ignores tenantId param — DynamoDB key pattern uses KB# PK which already scopes to a specific KB; tenantId accepted for interface compatibility"
  - "updateMany used instead of update for KB/DataSource postgres repos — avoids Prisma compound-key requirement; tenantId+id in where clause enforces tenant safety"
  - "USE_PG_KB flag controls both KnowledgeBase and DataSource repos — they're a unit; splitting flags would allow inconsistent state"

metrics:
  duration: 6min
  completed: 2026-03-28
  tasks: 2
  files: 12
---

# Phase 4 Plan 02: KB + DataSource Repository Layer Summary

**IKnowledgeBaseRepository and IDataSourceRepository with DynamoDB + PostgreSQL implementations, atomic counter updates, and TDD unit tests — 42 tests passing**

## Performance

- **Duration:** 6 min
- **Started:** 2026-03-28T06:05:00Z
- **Completed:** 2026-03-28T06:11:00Z
- **Tasks:** 2
- **Files modified:** 12

## Accomplishments

- 10 repository files created (interface + dynamo + postgres + 2 tests per entity)
- IKnowledgeBaseRepository: 7 methods including atomic `updateDataSourceCount` and `updateVectorCount`
- IDataSourceRepository: 5 methods with `tenantId` on all signatures for multi-tenant safety
- PostgreSQL implementations use Prisma `increment` for atomic counter updates (no read-modify-write race)
- DynamoDB implementations use `if_not_exists + :delta` expression for atomic counters
- Repository factory extended with `getKnowledgeBaseRepository()` and `getDataSourceRepository()` (USE_PG_KB flag)
- `.env.local.example` updated with `USE_PG_INVENTORY=false` (was missing)
- 42 unit tests passing across all 4 test files

## Task Commits

1. **Task 1: KB repository interface + DynamoDB + PostgreSQL + TDD tests** - `8385bbb` (feat)
2. **Task 2: DataSource repository + factory wiring + env flags** - `efef817` (feat)

## Files Created/Modified

- `web-ui/lib/db/repositories/knowledge-base/interface.ts` — IKnowledgeBaseRepository (7 methods)
- `web-ui/lib/db/repositories/knowledge-base/dynamo.ts` — TENANT#/KB# key pattern, atomic counters
- `web-ui/lib/db/repositories/knowledge-base/postgres.ts` — Prisma, tenantId scoping, increment
- `web-ui/lib/db/repositories/knowledge-base/dynamo.test.ts` — 13 tests
- `web-ui/lib/db/repositories/knowledge-base/postgres.test.ts` — 11 tests
- `web-ui/lib/db/repositories/data-source/interface.ts` — IDataSourceRepository (5 methods + tenantId)
- `web-ui/lib/db/repositories/data-source/dynamo.ts` — KB#/DATASOURCE# key pattern
- `web-ui/lib/db/repositories/data-source/postgres.ts` — Prisma, tenantId+kbId scoping
- `web-ui/lib/db/repositories/data-source/dynamo.test.ts` — 9 tests
- `web-ui/lib/db/repositories/data-source/postgres.test.ts` — 9 tests
- `web-ui/lib/db/repository-factory.ts` — added getKnowledgeBaseRepository + getDataSourceRepository
- `web-ui/.env.local.example` — added USE_PG_INVENTORY=false

## Decisions Made

- DataSourceDynamoRepository ignores tenantId param — DynamoDB key pattern uses KB# PK which already scopes to a specific KB; tenantId accepted for interface compatibility only
- `updateMany` used instead of `update` for KB/DataSource postgres repos — avoids Prisma compound-key requirement; tenantId+id in where clause enforces tenant safety
- USE_PG_KB flag controls both KnowledgeBase and DataSource repos — they're a unit; splitting flags would allow inconsistent state

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing] Added USE_PG_INVENTORY=false to .env.local.example**
- **Found during:** Task 2
- **Issue:** Plan specified adding USE_PG_KB, USE_PG_INVENTORY, USE_PG_AGENT_OPS to .env.local.example, but USE_PG_INVENTORY was missing (USE_PG_KB and USE_PG_AGENT_OPS were already present from a parallel agent)
- **Fix:** Added USE_PG_INVENTORY=false between USE_PG_KB and USE_PG_AGENT_OPS
- **Files modified:** web-ui/.env.local.example
- **Committed in:** efef817

**2. [Rule 2 - Missing] repository-factory.ts already had inventory/agent-ops entries**
- **Found during:** Task 2
- **Issue:** A parallel agent (04-03/04-04) had already added IInventoryRepository, IAgentOpsRunRepository, IAgentOpsEventRepository, IScheduledTaskRepository imports and factory functions to repository-factory.ts
- **Fix:** Added only the KB/DataSource imports and factory functions without duplicating existing entries
- **Files modified:** web-ui/lib/db/repository-factory.ts
- **Committed in:** efef817

## Known Stubs

None — all repository methods are fully implemented. KB service still uses DynamoDB directly (not wired to repository factory yet — that's Plan 04-02 scope boundary; service wiring is a separate plan).

---

## Self-Check: PASSED

- `web-ui/lib/db/repositories/knowledge-base/interface.ts` — FOUND
- `web-ui/lib/db/repositories/knowledge-base/dynamo.ts` — FOUND
- `web-ui/lib/db/repositories/knowledge-base/postgres.ts` — FOUND
- `web-ui/lib/db/repositories/knowledge-base/dynamo.test.ts` — FOUND
- `web-ui/lib/db/repositories/knowledge-base/postgres.test.ts` — FOUND
- `web-ui/lib/db/repositories/data-source/interface.ts` — FOUND
- `web-ui/lib/db/repositories/data-source/dynamo.ts` — FOUND
- `web-ui/lib/db/repositories/data-source/postgres.ts` — FOUND
- `web-ui/lib/db/repositories/data-source/dynamo.test.ts` — FOUND
- `web-ui/lib/db/repositories/data-source/postgres.test.ts` — FOUND
- Commit 8385bbb — FOUND
- Commit efef817 — FOUND
- 42 tests passing — VERIFIED

*Phase: 04-kb-inventory-agent-ops*
*Completed: 2026-03-28*
