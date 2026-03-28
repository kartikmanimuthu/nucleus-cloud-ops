---
phase: 04-kb-inventory-agent-ops
plan: "03"
subsystem: inventory
tags: [inventory, repository, postgresql, dynamodb, python, psycopg2, dual-write]
dependency_graph:
  requires: [04-01]
  provides: [IInventoryRepository, InventoryPostgresRepository, InventoryDynamoRepository, pg_writer]
  affects: [lambda/discovery, web-ui/lib/db/repository-factory]
tech_stack:
  added: [psycopg2-binary>=2.9.0]
  patterns: [repository-pattern, feature-flag, dual-write, ON-CONFLICT-upsert, groupBy-counts]
key_files:
  created:
    - web-ui/lib/db/repositories/inventory/interface.ts
    - web-ui/lib/db/repositories/inventory/dynamo.ts
    - web-ui/lib/db/repositories/inventory/postgres.ts
    - web-ui/lib/db/repositories/inventory/dynamo.test.ts
    - web-ui/lib/db/repositories/inventory/postgres.test.ts
    - lambda/discovery/src/pg_writer.py
  modified:
    - web-ui/lib/db/repository-factory.ts
    - lambda/discovery/requirements.txt
    - lambda/discovery/src/data_processor.py
decisions:
  - "InventoryDynamoRepository uses GSI1/GSI2/GSI3 query patterns from existing inventory table schema"
  - "pg_writer.py uses camelCase column names (tenantId, accountId, etc.) matching Prisma schema without @map"
  - "Dual-write is non-blocking: PostgreSQL failures are caught and logged, DynamoDB remains primary"
  - "upsertBatch uses Prisma $transaction for atomicity; DynamoDB uses BatchWriteCommand in chunks of 25"
metrics:
  duration: 9min
  completed_date: "2026-03-28"
  tasks_completed: 2
  files_changed: 9
---

# Phase 4 Plan 03: Inventory Repository + Python pg_writer Summary

Inventory repository (interface + DynamoDB + PostgreSQL) with 29 TDD tests, plus psycopg2 dual-write integration in the Python discovery Lambda.

## Tasks Completed

| Task | Description | Commit |
|------|-------------|--------|
| 1 | Inventory repository interface + DynamoDB + PostgreSQL + TDD tests | 0cb9844 |
| 2 | Python discovery Lambda psycopg2 writer + dual-write integration | 8cae84f |

## What Was Built

**Task 1 — Inventory Repository (TypeScript)**

- `IInventoryRepository` interface with 6 methods: `listResources`, `getResource`, `upsertResource`, `upsertBatch`, `getResourceCounts`, `deleteResourcesByAccount`
- `InventoryDynamoRepository`: queries GSI1 (all inventory), GSI2 (by region), GSI3 (by resource type), main table (by account). Client-side filtering for tenant isolation, region, and search term.
- `InventoryPostgresRepository`: server-side WHERE/ILIKE/LIMIT/OFFSET via Prisma. `groupBy` for resource counts. `upsert` with compound unique key `(tenantId, accountId, resourceType, resourceId)`. `$transaction` for batch upserts.
- `getInventoryRepository()` added to `repository-factory.ts` with `USE_PG_INVENTORY` feature flag.
- 29 tests passing: 15 postgres (all methods + cross-tenant isolation), 14 dynamo (all methods + cross-tenant isolation).

**Task 2 — Python pg_writer (Lambda)**

- `psycopg2-binary>=2.9.0` added to `lambda/discovery/requirements.txt`
- `pg_writer.py`: batched `ON CONFLICT ("tenantId", "accountId", "resourceType", "resourceId") DO UPDATE` upsert using camelCase column names matching Prisma schema. Connects via `DATABASE_URL`. Controlled by `USE_PG_INVENTORY`.
- `data_processor.py`: dual-write call added after DynamoDB write succeeds. Non-blocking — exceptions are caught and logged, DynamoDB remains primary.

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None — all methods are fully implemented.

## Self-Check: PASSED

Files exist:
- web-ui/lib/db/repositories/inventory/interface.ts ✓
- web-ui/lib/db/repositories/inventory/dynamo.ts ✓
- web-ui/lib/db/repositories/inventory/postgres.ts ✓
- lambda/discovery/src/pg_writer.py ✓

Commits exist:
- 0cb9844 feat(04-03): inventory repository interface + DynamoDB + PostgreSQL + TDD tests ✓
- 8cae84f feat(04-03): Python discovery Lambda psycopg2 writer + dual-write integration ✓
