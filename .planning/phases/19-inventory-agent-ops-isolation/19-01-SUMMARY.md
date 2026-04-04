---
phase: 19-inventory-agent-ops-isolation
plan: "01"
subsystem: inventory
tags: [tenant-isolation, repository, api-routes, postgres]
dependency_graph:
  requires: []
  provides: [tenant-scoped-inventory-repository, tenant-scoped-inventory-api]
  affects: [inventory-list, inventory-sync, inventory-status, lambda-write-path]
tech_stack:
  added: []
  patterns: [getTenantClient, getSessionTenantId, account-tenantId-lookup]
key_files:
  created: []
  modified:
    - web-ui/lib/db/repositories/inventory/postgres.ts
    - web-ui/app/api/inventory/resources/route.ts
    - web-ui/app/api/inventory/sync/route.ts
    - web-ui/app/api/inventory/status/route.ts
decisions:
  - "getPrismaClient() retained only for cross-entity account→tenantId lookup in upsertResource/upsertBatch (acceptable per CONTEXT.md)"
  - "upsertBatch stamps all resources with resolvedTenantId before transaction — single account lookup per batch"
  - "status/route.ts getLiveStats() scoped by tenantId FilterExpression on DynamoDB GSI1 scan"
  - "export/route.ts confirmed already uses getSessionTenantId() — not modified"
metrics:
  duration: "~10 minutes"
  completed: "2026-04-03"
  tasks_completed: 2
  files_modified: 4
---

# Phase 19 Plan 01: Inventory Tenant Isolation Summary

Tenant-scoped InventoryPostgresRepository using getTenantClient(tenantId) with D-03/D-04 account→tenantId lookup in Lambda write path, plus 3 hardened inventory API routes replacing hardcoded 'default' tenantId with getSessionTenantId().

## Tasks Completed

| Task | Description | Commit |
|------|-------------|--------|
| 1 | Migrate InventoryPostgresRepository to getTenantClient + D-03/D-04 account lookup | 8460799 |
| 2 | Harden inventory API routes with getSessionTenantId | d9ca89b |

## What Was Done

**Task 1 — Repository:**
- Replaced all 7 `getPrismaClient()` Prisma calls with `getTenantClient(tenantId)` across `listResources`, `getResource`, `getResourceCounts`, `deleteResourcesByAccount`, `searchByVector`
- `upsertResource`: resolves tenantId from `account.findFirst({ where: { accountId } })` when tenantId is falsy/`'default'`/`'org-default'`; skips write with error log if account not found
- `upsertBatch`: same lookup on `resources[0].accountId`, stamps all resources with `resolvedTenantId`, uses single `getTenantClient(resolvedTenantId)` for the entire `$transaction`
- `getPrismaClient()` retained only for the cross-entity account lookup (not intercepted by tenant middleware — intentional)

**Task 2 — API Routes:**
- `resources/route.ts`: replaced `const tenantId = 'default'` with `await getSessionTenantId()`
- `sync/route.ts`: added `getSessionTenantId()`, passed `tenantId` to both `AuditService.logResourceAction` calls and to EventBridge `Detail` JSON
- `status/route.ts`: added `getSessionTenantId()`, scoped `getLiveStats(tenantId)` with DynamoDB FilterExpression, scoped account queries by tenant prefix
- `export/route.ts`: confirmed already correct — not modified

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None — all tenant scoping is wired to live session data.

## Self-Check: PASSED

- `web-ui/lib/db/repositories/inventory/postgres.ts` — FOUND
- `web-ui/app/api/inventory/resources/route.ts` — FOUND
- `web-ui/app/api/inventory/sync/route.ts` — FOUND
- `web-ui/app/api/inventory/status/route.ts` — FOUND
- Commit 8460799 — FOUND
- Commit d9ca89b — FOUND
- `getTenantClient` count in repo: 8 matches (import + 7 call sites)
- `account.findFirst` count in repo: 2 matches (upsertResource + upsertBatch)
- No hardcoded `'default'` in resources/route.ts: 0 matches
- All 4 inventory routes import `getSessionTenantId`: confirmed
