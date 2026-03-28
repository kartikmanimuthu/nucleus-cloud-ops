---
phase: 04-kb-inventory-agent-ops
plan: 07
subsystem: database
tags: [prisma, postgresql, dynamodb, lambda, dual-write, migration]

requires:
  - phase: 04-kb-inventory-agent-ops
    provides: KB/inventory/agent-ops Prisma models and repositories

provides:
  - InventoryVectorKey Prisma model with migration SQL
  - vector_processor Lambda dual-write to PostgreSQL (USE_PG_INVENTORY)
  - kb_sync_processor Lambda dual-write to PostgreSQL (USE_PG_KB)
  - scripts/migrate-inventory.ts for DynamoDB → PostgreSQL inventory migration

affects: [05-langgraph-persistence, verification]

tech-stack:
  added: []
  patterns:
    - "Lambda PrismaClient singleton: lazy _prisma with max 3 connections, DATABASE_URL from env"
    - "Dual-write pattern: PG flag controls read source; both backends written during validation period"

key-files:
  created:
    - prisma/migrations/20260328_add_inventory_vector_keys/migration.sql
    - scripts/migrate-inventory.ts
  modified:
    - prisma/schema.prisma
    - lambda/vector_processor/src/index.ts
    - lambda/kb_sync_processor/src/index.ts

key-decisions:
  - "InventoryVectorKey has no tenantId — accountId is the natural unique key for vector key tracking"
  - "Lambda PrismaClient uses lazy singleton pattern to avoid cold-start connection overhead"
  - "USE_PG_INVENTORY controls read source only; writes go to both backends during dual-write period"

patterns-established:
  - "Lambda PG wiring: import PrismaClient, lazy singleton getPrisma(), USE_PG_* env flag"
  - "Dual-write: if (USE_PG) await pgFn(); always await dynamoFn(); — DynamoDB never removed during validation"

requirements-completed: [KB-01, KB-03, KB-04, KB-08]

duration: 12min
completed: 2026-03-28
---

# Phase 4 Plan 07: KB + Inventory Gap Closure Summary

**InventoryVectorKey Prisma model added, vector_processor and kb_sync_processor Lambdas wired to PostgreSQL with dual-write, and migrate-inventory.ts created for DynamoDB → PostgreSQL inventory migration**

## Performance

- **Duration:** ~12 min
- **Started:** 2026-03-28T06:35:00Z
- **Completed:** 2026-03-28T06:47:00Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- Added InventoryVectorKey Prisma model (KB-01) with accountId unique constraint and vectorKeys array, plus migration SQL
- Wired vector_processor Lambda to PostgreSQL with USE_PG_INVENTORY dual-write — reads from PG when flag is true, always writes to both (KB-04)
- Wired kb_sync_processor Lambda to PostgreSQL with USE_PG_KB dual-write for getDataSource, updateDS, and updateKBVectorCount (KB-03)
- Created scripts/migrate-inventory.ts migrating both inventory resources and vector key records from DynamoDB to PostgreSQL (KB-08)

## Task Commits

1. **Task 1: Add InventoryVectorKey model + wire vector_processor and kb_sync_processor** - `de3ebcf` (feat)
2. **Task 2: Create migrate-inventory.ts migration script** - `a0b5888` (feat)

## Files Created/Modified
- `prisma/schema.prisma` - Added InventoryVectorKey model after InventoryResource
- `prisma/migrations/20260328_add_inventory_vector_keys/migration.sql` - Creates inventory_vector_keys table with unique index on accountId
- `lambda/vector_processor/src/index.ts` - PrismaClient singleton, getPreviousVectorKeysPg, saveVectorKeysPg, USE_PG_INVENTORY dual-write
- `lambda/kb_sync_processor/src/index.ts` - PrismaClient singleton, getDataSourcePg, updateDSPg, updateKBVectorCountPg, USE_PG_KB dual-write
- `scripts/migrate-inventory.ts` - Full table scan migration for inventory_resources + inventory_vector_keys, batched upserts (500), idempotent

## Decisions Made
- InventoryVectorKey has no tenantId — accountId is the natural unique key; vector key tracking is per-account, not per-tenant
- Lambda PrismaClient uses lazy singleton (not module-level instantiation) to avoid cold-start connection overhead
- USE_PG_INVENTORY controls which backend is READ from; writes always go to both during dual-write period

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## Next Phase Readiness
- All KB-01, KB-03, KB-04, KB-08 verification gaps closed
- Phase 04 verification can now be re-run against the complete implementation
- Phase 05 (LangGraph persistence) can proceed independently

---
*Phase: 04-kb-inventory-agent-ops*
*Completed: 2026-03-28*
