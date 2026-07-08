# Inventory Discovery — Filter Grid to Latest Batch Per Account

**Date:** 2026-07-08
**Status:** Approved
**Branch:** new branch off master-v1 (see Out of Scope)

---

## Problem

`InventoryResource` rows are upserted by natural key (`tenantId`, `accountId`, `resourceType`,
`resourceId`). When a discovery scan runs, matched resources get their `jobRunId`/`discoveredAt`
overwritten, but nothing ever touches rows for resources that disappeared from AWS between scans
(terminated instances, released IPs, deleted volumes, etc). Those rows sit in the table forever
with a stale `jobRunId`, so the inventory grid mixes current and stale data with no way to tell
them apart.

---

## Goals

- The inventory grid always shows only the latest successful batch's resources per account.
- Stale rows are never purged — they remain in Postgres for backward audit.
- Batch currency is tracked **per account**, not per tenant-wide scan, so resyncing a single
  account doesn't affect the currency of other accounts.

## Non-Goals

- No UI to browse/audit stale (non-current) rows — DB-level retention only, queryable directly in
  Postgres. A dedicated audit view is a separate future feature.
- No changes to the discovery scan logic itself (STS assume-role, resource collection, tagging).
- No changes to `upsertResource`/`upsertBatch` callers outside the discovery job's write path.
- No retroactive staleness detection for data written before this change (see Bootstrap Behavior).

---

## Architecture

### Schema change

Add `isCurrent Boolean @default(true)` to `InventoryResource` in `libs/prisma/schema.prisma`,
plus supporting indexes:

```prisma
model InventoryResource {
  // ...existing fields...
  isCurrent    Boolean  @default(true)

  @@unique([tenantId, accountId, resourceType, resourceId])
  @@index([tenantId, resourceType, isCurrent])
  @@index([tenantId, accountId, isCurrent])
  @@map("inventory_resources")
}
```

This is purely additive — no column removed, no row deleted.

### Write path — `apps/workers/src/jobs/discovery/services/pg-writer.ts`

1. The bulk upsert's `ON CONFLICT DO UPDATE` SET clause gets `"isCurrent" = true` added, so a
   resource that reappears after being marked stale (e.g. an IP gets reused) flips back to
   current automatically.

2. After `writeResourcesToPg` completes for an account (success, partial failure, or empty
   result), a new reconciliation step runs, scoped to that account only:

   ```sql
   UPDATE inventory_resources
   SET "isCurrent" = false
   WHERE "tenantId" = $1 AND "accountId" = $2
     AND "isCurrent" = true AND "jobRunId" IS DISTINCT FROM $3
   ```

   `$3` is the current scan's `scanId`. Rows touched by this scan already have `jobRunId = $3`
   (set by the upsert), so they're excluded from the `UPDATE` and remain current. Rows not seen
   in this scan keep their old `jobRunId` and get flipped to `isCurrent = false`.

3. **Reconciliation runs unconditionally per account** — including when the account's scan
   errors out or returns zero resources. This means a hard failure (e.g. broken STS role) marks
   that account's entire previous batch stale, and the grid shows nothing for that account until
   the next successful scan. This is a deliberate tradeoff (confirmed during design) favoring "no
   stale data shown" over "always show *something*." To make this failure mode visible rather
   than silently confusing, the discovery job logs a warning via `createLogger('discovery')` when
   reconciliation runs after a failed/empty scan, including the account ID and error.

### Read path — `apps/web-ui/lib/db/repositories/inventory/postgres.ts`

`listResources` and `listResourcesFulltext` add a hard-coded `isCurrent: true` to their `where`
clause. No new query params, no API route changes (`apps/web-ui/app/api/inventory/resources/route.ts`
is unaffected) — the grid keeps working exactly as today, just without stale rows.

### Bootstrap behavior

The Prisma migration backfills existing rows with `isCurrent = true` (the column default).
Currently-stale data already in the table won't be filtered out until each account's *next*
successful scan reconciles it — there's no reliable signal to retroactively determine staleness
for rows written before this change.

---

## Data Flow

```
Discovery job scans account X (scanId = S)
    ↓
runInventoryScan(account X) → resources[] (may be empty on error)
    ↓
writeResourcesToPg(resources, tenantId, accountId=X, jobRunId=S)
    → upsert by natural key, SET "isCurrent" = true, "jobRunId" = S on every touched row
    ↓
reconcileStaleResources(tenantId, accountId=X, scanId=S)
    → UPDATE ... SET "isCurrent" = false WHERE jobRunId IS DISTINCT FROM S AND isCurrent = true
    ↓ (runs even if resources[] was empty due to a scan error — logged as a warning)
Grid queries listResources(tenantId, accountId?) → WHERE isCurrent = true
    → only account X's batch-S rows (or whatever batch succeeded most recently) are shown
```

---

## Error Handling

- Reconciliation is a single `UPDATE` statement per account — no partial-failure state within it.
- If `reconcileStaleResources` itself throws (DB error), the discovery job's existing per-account
  try/catch in `apps/workers/src/jobs/discovery/index.ts` catches and logs it the same way scan
  errors are handled today; the account's rows keep their previous `isCurrent` state (fail open,
  not silently marked stale by a half-applied reconciliation).
- A warning-level log line is added specifically for the "reconciled after failed/empty scan"
  case so it's visible in CloudWatch without needing to correlate scan errors with a suddenly
  empty grid.

---

## Testing

- `pg-writer.test.ts` (or new `reconcile.test.ts`):
  - Reconciliation flips only the target account's non-matching rows; other accounts/tenants in
    the same tenant are untouched.
  - A resource with a stale `jobRunId` that reappears in a later scan has `isCurrent` reset to
    `true` via the upsert's `ON CONFLICT` clause.
  - Reconciliation runs (and correctly stales out prior rows) even when `resources[]` is empty.
- Repository test (`postgres.test.ts`): `listResources` / `listResourcesFulltext` exclude
  `isCurrent = false` rows.
- Discovery job integration test: reconciliation is invoked once per account, including on the
  error path (mocked `runInventoryScan` throwing).

---

## Files Changed

| File | Change |
|------|--------|
| `libs/prisma/schema.prisma` | Add `isCurrent` column + 2 indexes to `InventoryResource` |
| `libs/prisma/migrations/<timestamp>_add_inventory_is_current/migration.sql` | New migration |
| `apps/workers/src/jobs/discovery/services/pg-writer.ts` | Add `isCurrent = true` to upsert SET clause; add `reconcileStaleResources()` |
| `apps/workers/src/jobs/discovery/index.ts` | Call `reconcileStaleResources()` per account after `writeResourcesToPg`, including on the error path; add warning log for failed/empty-scan reconciliation |
| `apps/web-ui/lib/db/repositories/inventory/postgres.ts` | Add `isCurrent: true` to `listResources` / `listResourcesFulltext` where clauses |

---

## Out of Scope

- `apps/web-ui/lib/db/repositories/inventory/postgres.ts` `upsertResource`/`upsertBatch` (the
  separate Prisma-based write path used by non-discovery callers) — not touched; new rows default
  to `isCurrent = true` via the schema default, but no reconciliation runs for that path.
- The dead `deleteResourcesByAccount` method — left as-is, not removed, not used by this fix.
- Any UI surfacing of batch ID / stale-row browsing.
- Current branch (`fix/scheduler-lastrunat-horizontal-void`) has unrelated uncommitted changes
  (chat route, executor-graphs, bun.lock) — this work should land on its own branch rather than
  stacking on top of unrelated in-progress changes.
