---
phase: quick
plan: 260331-ocp
subsystem: inventory/ask-ai
tags: [pgvector, ask-ai, inventory, migration, s3-vectors-removal]
dependency_graph:
  requires: [prisma/schema.prisma, web-ui/lib/db/repositories/inventory/]
  provides: [pgvector semantic search for ask-ai, embedding column on inventory_resources]
  affects: [web-ui/app/api/ask-ai/route.ts]
tech_stack:
  added: [pgvector ivfflat index, $queryRawUnsafe cosine distance]
  patterns: [repository pattern, VectorSearchResult interface]
key_files:
  created:
    - prisma/migrations/20260331_add_inventory_embedding/migration.sql
  modified:
    - prisma/schema.prisma
    - web-ui/lib/db/repositories/inventory/interface.ts
    - web-ui/lib/db/repositories/inventory/postgres.ts
    - web-ui/lib/db/repositories/inventory/dynamo.ts
    - web-ui/app/api/ask-ai/route.ts
decisions:
  - "searchByVector uses $queryRawUnsafe with <=> cosine distance operator — Prisma has no native pgvector support"
  - "Exhaustive queries skip embedding generation entirely — listResources(limit=2000) is sufficient"
  - "tenantId='default' hardcoded — matches all migrated inventory data"
  - "DynamoDB searchByVector stub returns [] — no vector capability in DynamoDB path"
metrics:
  duration: 6min
  completed: "2026-03-31"
  tasks_completed: 2
  files_changed: 5
---

# Phase quick Plan 260331-ocp: Migrate Ask AI from S3 Vectors + DynamoDB to PostgreSQL pgvector

Ask AI route rewired from S3 Vectors + DynamoDB to PostgreSQL pgvector — exhaustive queries use `listResources(limit=2000)`, semantic queries use `searchByVector()` with ivfflat cosine distance.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add embedding column + searchByVector to repository layer | 2f9b889 | prisma/schema.prisma, migrations/20260331_add_inventory_embedding/migration.sql, interface.ts, postgres.ts, dynamo.ts |
| 2 | Rewrite ask-ai route to use PostgreSQL repository | 2ee82cf | web-ui/app/api/ask-ai/route.ts |

## What Was Built

- `embedding vector(1024)` and `contentHash TEXT` columns added to `inventory_resources` table
- ivfflat index on embedding column with cosine ops (lists=100) for fast ANN search
- `VectorSearchResult` interface and `searchByVector()` method added to `IInventoryRepository`
- `InventoryPostgresRepository.searchByVector()` uses `$queryRawUnsafe` with `<=>` cosine distance operator, parameterized for tenant/account/region scoping
- `InventoryDynamoRepository.searchByVector()` stub returns `[]` (DynamoDB has no vector capability)
- `ask-ai/route.ts` fully rewritten: removed S3VectorsClient, DynamoDBClient, unmarshall, queryDynamoExhaustive(), searchVectors() — replaced with `getInventoryRepository()` calls

## Deviations from Plan

None — plan executed exactly as written.

One deviation in migration apply: `20260331_add_inventory_sync_status` was already applied to the DB but not recorded in Prisma's migration history. Resolved with `prisma migrate resolve --applied` before deploying the embedding migration. This is a pre-existing state issue, not caused by this plan.

## Verification

- `npx prisma validate` — schema valid
- `npx tsc --noEmit` — zero type errors
- No S3VectorsClient/DynamoDB imports in ask-ai route (grep confirmed)
- `getInventoryRepository` and `searchByVector` wired in route (grep confirmed)

## Self-Check: PASSED

- prisma/migrations/20260331_add_inventory_embedding/migration.sql — FOUND
- prisma/schema.prisma has embedding column — FOUND
- web-ui/lib/db/repositories/inventory/interface.ts has searchByVector — FOUND
- web-ui/app/api/ask-ai/route.ts uses getInventoryRepository — FOUND
- Commits 2f9b889 and 2ee82cf — FOUND
