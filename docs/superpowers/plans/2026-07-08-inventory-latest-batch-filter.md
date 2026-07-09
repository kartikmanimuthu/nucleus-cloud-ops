# Inventory Latest-Batch Grid Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the inventory grid from showing stale resources (e.g. terminated instances, released IPs) alongside current ones, while keeping every historical row in Postgres for audit.

**Architecture:** Add an `isCurrent` boolean to `InventoryResource`, defaulting to `true`. The discovery job's upsert already stamps every touched row with the scan's `jobRunId`; after an account's batch write completes (success, partial failure, or hard error), a new `reconcileStaleResources()` call flips `isCurrent = false` on that account's rows whose `jobRunId` doesn't match the current scan — nothing is deleted. The grid's repository read path filters on `isCurrent = true`.

**Tech Stack:** Prisma (schema + migration), raw `pg` (discovery job's write path, `apps/workers`), Prisma-backed repository (`apps/web-ui`), Vitest.

## Global Constraints

- Batch currency is tracked **per account**, not per tenant-wide scan (spec: `docs/superpowers/specs/2026-07-08-inventory-latest-batch-filter-design.md`).
- Stale rows are never deleted — only flagged `isCurrent = false`.
- Reconciliation runs unconditionally per account, even when that account's scan fails or returns zero resources — this is a deliberate tradeoff, not a bug. When it flips rows to stale after an empty/failed scan, a warning must be logged.
- No new API params, no UI changes, no audit-view toggle — the grid's existing query surface is unchanged except for the added filter.
- Multi-tenant safety: every reconciliation/read query must be scoped by `tenantId` (project-wide rule; `$executeRaw`/raw `pg` queries are not auto-scoped).
- This is a new branch off `master-v1` — the current worktree branch (`fix/scheduler-lastrunat-horizontal-void`) has unrelated in-progress changes and must not be touched.

---

## Pre-existing test baseline (do not try to fix these — out of scope)

Before starting, note the current test state so you don't mistake pre-existing issues for regressions you caused:

- `apps/web-ui/lib/db/repositories/inventory/postgres.test.ts` — 18/19 pass. The 1 failure (`adds ILIKE name filter for searchTerm`) is a pre-existing bug unrelated to this work (`listResourcesFulltext` calls `client.$queryRawUnsafe`, which the test's mock Prisma client doesn't implement). Leave it failing.
- `apps/workers/src/jobs/discovery/__tests__/pg-writer.test.ts` and `index.test.ts` — 25/25 pass.

---

### Task 0: Create a new branch

**Files:** none

- [ ] **Step 1: Create and check out a new branch off `master-v1`**

```bash
git fetch origin master-v1
git checkout -b fix/inventory-stale-batch-grid origin/master-v1
```

- [ ] **Step 2: Confirm the branch is clean and based on master-v1**

```bash
git status --short
git log --oneline -1
```

Expected: no changes reported by `git status`, and the log shows the tip of `master-v1`.

---

### Task 1: Schema — add `isCurrent` to `InventoryResource`

**Files:**
- Modify: `libs/prisma/schema.prisma:339-360` (the `InventoryResource` model)
- Create: `libs/prisma/migrations/20260708180000_add_inventory_is_current/migration.sql`

**Interfaces:**
- Produces: `InventoryResource.isCurrent: boolean` (Prisma-generated field, default `true`) — Tasks 2–4 read/write this column.

- [ ] **Step 1: Edit the model**

In `libs/prisma/schema.prisma`, change:

```prisma
model InventoryResource {
  id           String   @id @default(cuid())
  tenantId     String
  accountId    String
  region       String
  resourceType String
  resourceId   String
  name         String?
  status       String?
  tags         Json     @default("{}")
  metadata     Json     @default("{}")
  jobRunId     String?
  discoveredAt DateTime @default(now())
  updatedAt    DateTime @updatedAt

  searchVector Unsupported("tsvector")?

  @@unique([tenantId, accountId, resourceType, resourceId])
  @@index([tenantId, resourceType])
  @@index([tenantId, accountId])
  @@map("inventory_resources")
}
```

to:

```prisma
model InventoryResource {
  id           String   @id @default(cuid())
  tenantId     String
  accountId    String
  region       String
  resourceType String
  resourceId   String
  name         String?
  status       String?
  tags         Json     @default("{}")
  metadata     Json     @default("{}")
  jobRunId     String?
  isCurrent    Boolean  @default(true)
  discoveredAt DateTime @default(now())
  updatedAt    DateTime @updatedAt

  searchVector Unsupported("tsvector")?

  @@unique([tenantId, accountId, resourceType, resourceId])
  @@index([tenantId, resourceType, isCurrent])
  @@index([tenantId, accountId, isCurrent])
  @@map("inventory_resources")
}
```

(The two existing indexes `[tenantId, resourceType]` and `[tenantId, accountId]` are replaced with versions that append `isCurrent`, since every read-path query filters on it.)

- [ ] **Step 2: Start local Postgres**

```bash
docker compose up -d postgres
```

Expected: `pgvector/pgvector:pg16` container running on `:5432` (check with `docker compose ps`).

- [ ] **Step 3: Generate and apply the migration**

```bash
cd apps/web-ui && bun run db:migrate -- --name add_inventory_is_current
```

Expected output includes `The following migration(s) have been created and applied` and a new folder `libs/prisma/migrations/<timestamp>_add_inventory_is_current/`.

- [ ] **Step 4: Verify the generated SQL**

```bash
cat ../../libs/prisma/migrations/*_add_inventory_is_current/migration.sql
```

Expected: contains an `ALTER TABLE "inventory_resources" ADD COLUMN "isCurrent" BOOLEAN NOT NULL DEFAULT true;` statement and `CREATE INDEX` statements for `(tenantId, resourceType, isCurrent)` and `(tenantId, accountId, isCurrent)` (exact index naming is Prisma-generated — just confirm the three columns appear together per index).

- [ ] **Step 5: Regenerate the workers Prisma client**

```bash
cd ../workers && bun run db:generate
```

(`apps/web-ui`'s client was already regenerated as part of `db:migrate`.)

- [ ] **Step 6: Commit**

```bash
git add libs/prisma/schema.prisma libs/prisma/migrations
git commit -m "feat(db): add isCurrent flag to InventoryResource for batch reconciliation"
```

---

### Task 2: `pg-writer.ts` — reactivate-on-upsert + `reconcileStaleResources`

**Files:**
- Modify: `apps/workers/src/jobs/discovery/services/pg-writer.ts:76-90` (upsert SQL)
- Modify: `apps/workers/src/jobs/discovery/services/pg-writer.ts` (add new exported function, place after `writeResourcesToPg`, before `saveSyncStatus`)
- Test: `apps/workers/src/jobs/discovery/__tests__/pg-writer.test.ts`

**Interfaces:**
- Consumes: `getPool()` from `./db.js` (existing), `createLogger` from `../../../lib/logger.js` (existing, already imported as `log`).
- Produces: `reconcileStaleResources(tenantId: string, accountId: string, jobRunId: string): Promise<number>` — Task 3 calls this after `writeResourcesToPg`.

- [ ] **Step 1: Write the failing tests**

Add to `apps/workers/src/jobs/discovery/__tests__/pg-writer.test.ts`, inside the top-level `describe('pg-writer', ...)` block:

Add this test inside the existing `describe('writeResourcesToPg', ...)` block (after the `'should include tenantId and accountId in every row'` test):

```ts
    it('reactivates previously-stale rows via isCurrent = true on conflict', async () => {
      const resources: Resource[] = [
        { resourceType: 'ec2_instances', resourceId: 'i-1', region: 'us-east-1', service: 'ec2', tags: {}, rawData: {} },
      ];

      await writeResourcesToPg(resources, 'tenant-1', 'acc-123', 'job-1');

      const sql = mockQuery.mock.calls[0][0];
      expect(sql).toContain('"isCurrent" = true');
    });
```

Add a new top-level `describe` block (sibling to `describe('writeResourcesToPg', ...)`, `describe('saveSyncStatus', ...)`, `describe('extractMetadata', ...)`):

```ts
  describe('reconcileStaleResources', () => {
    it('marks rows stale when jobRunId differs from the current scan', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 3 });

      const count = await reconcileStaleResources('tenant-1', 'acc-123', 'scan-999');

      expect(count).toBe(3);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('SET "isCurrent" = false'),
        ['tenant-1', 'acc-123', 'scan-999'],
      );
    });

    it('scopes the UPDATE to tenantId, accountId, and a differing jobRunId', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await reconcileStaleResources('tenant-1', 'acc-123', 'scan-999');

      const sql = mockQuery.mock.calls[0][0];
      expect(sql).toContain('"tenantId" = $1');
      expect(sql).toContain('"accountId" = $2');
      expect(sql).toContain('IS DISTINCT FROM $3');
      expect(mockRelease).toHaveBeenCalled();
    });

    it('returns 0 when rowCount is null', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: null });

      const count = await reconcileStaleResources('tenant-1', 'acc-123', 'scan-999');

      expect(count).toBe(0);
    });

    it('releases the client and rethrows on query error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('db down'));

      await expect(
        reconcileStaleResources('tenant-1', 'acc-123', 'scan-999'),
      ).rejects.toThrow('db down');
      expect(mockRelease).toHaveBeenCalled();
    });
  });
```

Update the import line at the top of the test file from:

```ts
import { writeResourcesToPg, saveSyncStatus, extractMetadata } from '../services/pg-writer.js';
```

to:

```ts
import { writeResourcesToPg, saveSyncStatus, extractMetadata, reconcileStaleResources } from '../services/pg-writer.js';
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/workers && bunx vitest run src/jobs/discovery/__tests__/pg-writer.test.ts
```

Expected: FAIL — `reconcileStaleResources` is not exported, and the "reactivates previously-stale rows" test fails because the current SQL has no `"isCurrent" = true`.

- [ ] **Step 3: Implement**

In `apps/workers/src/jobs/discovery/services/pg-writer.ts`, change the upsert SQL (lines 76-90) from:

```ts
      const sql = `
        INSERT INTO inventory_resources
          (id, "tenantId", "accountId", region, "resourceType", "resourceId",
           name, status, tags, metadata, "jobRunId", "discoveredAt", "updatedAt")
        VALUES ${placeholders.join(', ')}
        ON CONFLICT ("tenantId", "accountId", "resourceType", "resourceId")
        DO UPDATE SET
          name = EXCLUDED.name,
          status = EXCLUDED.status,
          tags = EXCLUDED.tags,
          metadata = EXCLUDED.metadata,
          "jobRunId" = EXCLUDED."jobRunId",
          "discoveredAt" = EXCLUDED."discoveredAt",
          "updatedAt" = NOW()
      `;
```

to:

```ts
      const sql = `
        INSERT INTO inventory_resources
          (id, "tenantId", "accountId", region, "resourceType", "resourceId",
           name, status, tags, metadata, "jobRunId", "discoveredAt", "updatedAt")
        VALUES ${placeholders.join(', ')}
        ON CONFLICT ("tenantId", "accountId", "resourceType", "resourceId")
        DO UPDATE SET
          name = EXCLUDED.name,
          status = EXCLUDED.status,
          tags = EXCLUDED.tags,
          metadata = EXCLUDED.metadata,
          "jobRunId" = EXCLUDED."jobRunId",
          "discoveredAt" = EXCLUDED."discoveredAt",
          "updatedAt" = NOW(),
          "isCurrent" = true
      `;
```

Then add this new function after `writeResourcesToPg` (before the `saveSyncStatus` section comment):

```ts
// ---------------------------------------------------------------------------
// reconcileStaleResources — mark resources not seen in the current scan as
// isCurrent = false, scoped to one account. Never deletes rows.
// ---------------------------------------------------------------------------

export async function reconcileStaleResources(
  tenantId: string,
  accountId: string,
  jobRunId: string,
): Promise<number> {
  const client: PoolClient = await getPool().connect();
  try {
    const result = await client.query(
      `UPDATE inventory_resources
       SET "isCurrent" = false
       WHERE "tenantId" = $1 AND "accountId" = $2
         AND "isCurrent" = true AND "jobRunId" IS DISTINCT FROM $3`,
      [tenantId, accountId, jobRunId],
    );
    return result.rowCount ?? 0;
  } catch (error) {
    log.error('Failed reconciling stale resources', {
      tenantId,
      accountId,
      jobRunId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    client.release();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/workers && bunx vitest run src/jobs/discovery/__tests__/pg-writer.test.ts
```

Expected: PASS, all tests in the file (the pre-existing ones plus the new ones).

- [ ] **Step 5: Commit**

```bash
git add apps/workers/src/jobs/discovery/services/pg-writer.ts apps/workers/src/jobs/discovery/__tests__/pg-writer.test.ts
git commit -m "feat(discovery): reconcile stale inventory rows per account after each scan"
```

---

### Task 3: `index.ts` — wire reconciliation into `handleDiscoveryScan`

**Files:**
- Modify: `apps/workers/src/jobs/discovery/index.ts:1-148`
- Create: `apps/workers/src/jobs/discovery/__tests__/handle-discovery-scan.test.ts`

**Interfaces:**
- Consumes: `reconcileStaleResources(tenantId, accountId, jobRunId): Promise<number>` from Task 2.
- Produces: nothing new consumed by later tasks — `handleDiscoveryScan` remains the pg-boss handler entry point.

- [ ] **Step 1: Write the failing tests**

Create `apps/workers/src/jobs/discovery/__tests__/handle-discovery-scan.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetTenantAccounts = vi.fn();
const mockUpdateAccountSyncStatus = vi.fn().mockResolvedValue(undefined);
const mockWriteAuditLog = vi.fn().mockResolvedValue(undefined);
const mockAssumeRole = vi.fn();
const mockRunInventoryScan = vi.fn();
const mockWriteResourcesToPg = vi.fn();
const mockSaveSyncStatus = vi.fn().mockResolvedValue(undefined);
const mockReconcileStaleResources = vi.fn().mockResolvedValue(0);

// createLogger builds a fresh closure per call (not memoized by module name — see
// apps/workers/src/lib/logger.ts), so a logger obtained by calling the real createLogger
// in this test would be a different instance than the one index.ts holds in its module-level
// `log` const. Mock the module so both index.ts and this test share the same logger object.
const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

vi.mock('../services/account-service.js', () => ({
  getAllTenants: vi.fn().mockResolvedValue([]),
  getTenantAccounts: mockGetTenantAccounts,
  updateAccountSyncStatus: mockUpdateAccountSyncStatus,
}));

vi.mock('../services/audit-service.js', () => ({
  writeAuditLog: mockWriteAuditLog,
}));

vi.mock('../services/sts-service.js', () => ({
  assumeRole: mockAssumeRole,
}));

vi.mock('../services/scanner.js', () => ({
  runInventoryScan: mockRunInventoryScan,
}));

vi.mock('../services/pg-writer.js', () => ({
  writeResourcesToPg: mockWriteResourcesToPg,
  saveSyncStatus: mockSaveSyncStatus,
  reconcileStaleResources: mockReconcileStaleResources,
}));

vi.mock('../../scheduler/services/pg-service.js', () => ({
  getTenantJobConfig: vi.fn().mockResolvedValue({ period: 'daily', lastRunAt: null }),
  updateTenantJobLastRun: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../lib/logger.js', () => ({
  createLogger: vi.fn(() => mockLogger),
}));

import { handleDiscoveryScan } from '../index.js';

const account = {
  id: 'acc-row-1',
  tenantId: 'tenant-1',
  accountId: 'acc-123',
  name: 'Prod',
  roleArn: 'arn:aws:iam::123:role/Nucleus',
  regions: ['us-east-1'],
  active: true,
};

describe('handleDiscoveryScan — reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTenantAccounts.mockResolvedValue([account]);
    mockAssumeRole.mockResolvedValue({ credentials: {} });
    mockUpdateAccountSyncStatus.mockResolvedValue(undefined);
    mockSaveSyncStatus.mockResolvedValue(undefined);
    mockReconcileStaleResources.mockResolvedValue(0);
  });

  it('reconciles the account after a successful scan with resources', async () => {
    mockRunInventoryScan.mockResolvedValue({
      resources: [{ resourceType: 'ec2_instances', resourceId: 'i-1', region: 'us-east-1', service: 'ec2', tags: {}, rawData: {} }],
      regionsScanned: 1,
      servicesScanned: 1,
      elapsedMs: 10,
      errors: [],
    });

    await handleDiscoveryScan({ type: 'scan', tenantId: 'tenant-1', triggeredBy: 'cron' });

    expect(mockWriteResourcesToPg).toHaveBeenCalledOnce();
    expect(mockReconcileStaleResources).toHaveBeenCalledOnce();
    expect(mockReconcileStaleResources).toHaveBeenCalledWith('tenant-1', 'acc-123', expect.stringMatching(/^scan-/));
  });

  it('reconciles the account even when the scan returns zero resources', async () => {
    mockRunInventoryScan.mockResolvedValue({
      resources: [],
      regionsScanned: 1,
      servicesScanned: 1,
      elapsedMs: 10,
      errors: [],
    });

    await handleDiscoveryScan({ type: 'scan', tenantId: 'tenant-1', triggeredBy: 'cron' });

    expect(mockReconcileStaleResources).toHaveBeenCalledOnce();
  });

  it('reconciles the account even when the scan throws before any resources are written', async () => {
    mockAssumeRole.mockRejectedValue(new Error('assume role denied'));

    await handleDiscoveryScan({ type: 'scan', tenantId: 'tenant-1', triggeredBy: 'cron' });

    expect(mockWriteResourcesToPg).not.toHaveBeenCalled();
    expect(mockReconcileStaleResources).toHaveBeenCalledOnce();
    expect(mockReconcileStaleResources).toHaveBeenCalledWith('tenant-1', 'acc-123', expect.stringMatching(/^scan-/));
  });

  it('logs a warning when reconciliation stales rows after an empty scan', async () => {
    mockRunInventoryScan.mockResolvedValue({
      resources: [],
      regionsScanned: 1,
      servicesScanned: 1,
      elapsedMs: 10,
      errors: [],
    });
    mockReconcileStaleResources.mockResolvedValue(5);

    await handleDiscoveryScan({ type: 'scan', tenantId: 'tenant-1', triggeredBy: 'cron' });

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('stale'),
      expect.objectContaining({ tenantId: 'tenant-1', accountId: 'acc-123', staleCount: 5 }),
    );
  });

  it('does not warn when reconciliation stales nothing after an empty scan', async () => {
    mockRunInventoryScan.mockResolvedValue({
      resources: [],
      regionsScanned: 1,
      servicesScanned: 1,
      elapsedMs: 10,
      errors: [],
    });
    mockReconcileStaleResources.mockResolvedValue(0);

    await handleDiscoveryScan({ type: 'scan', tenantId: 'tenant-1', triggeredBy: 'cron' });

    expect(mockLogger.warn).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/workers && bunx vitest run src/jobs/discovery/__tests__/handle-discovery-scan.test.ts
```

Expected: FAIL — `reconcileStaleResources` mock is never called because `index.ts` doesn't call it yet.

- [ ] **Step 3: Implement**

In `apps/workers/src/jobs/discovery/index.ts`:

Change the import on line 7 from:

```ts
import { writeResourcesToPg, saveSyncStatus } from './services/pg-writer.js';
```

to:

```ts
import { writeResourcesToPg, saveSyncStatus, reconcileStaleResources } from './services/pg-writer.js';
```

Add this helper function after `resolveScanfilePath` (before `loadScanConfigs`):

```ts
async function reconcileAndWarnIfEmpty(
    tenantId: string,
    accountId: string,
    scanId: string,
    resourceCount: number,
): Promise<void> {
    const staleCount = await reconcileStaleResources(tenantId, accountId, scanId);
    if (resourceCount === 0 && staleCount > 0) {
        log.warn('Reconciliation marked previously-current resources stale after an empty/failed scan', {
            tenantId,
            accountId,
            scanId,
            staleCount,
        });
    }
}
```

Change the per-account loop body (lines 79-116) from:

```ts
    for (const account of targetAccounts) {
        try {
            log.debug('Scanning account', { tenantId, accountId: account.accountId, regions: account.regions });

            const credentials = await assumeRole(account.roleArn, account.accountId, account.regions?.[0] ?? 'ap-south-1', account.externalId);
            const regions = Array.isArray(account.regions) ? account.regions : [account.regions];

            const result = await runInventoryScan(credentials, regions, scanConfigs);
            totalResources += result.resources.length;

            await writeResourcesToPg(result.resources, tenantId, account.accountId, scanId);
            await updateAccountSyncStatus(tenantId, account.accountId, {
                lastSyncedAt: new Date().toISOString(),
                lastSyncStatus: (result.errors?.length ?? 0) > 0 ? 'partial' : 'success',
                lastSyncResourceCount: result.resources.length,
            });

            accountsSynced++;
            if (result.errors?.length) errors.push(...result.errors);

            log.info('Account scan complete', {
                tenantId,
                accountId: account.accountId,
                resourceCount: result.resources.length,
                hasErrors: (result.errors?.length ?? 0) > 0,
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push(`Account ${account.accountId}: ${msg}`);
            log.error('Account scan failed', { tenantId, accountId: account.accountId, error: msg });

            await updateAccountSyncStatus(tenantId, account.accountId, {
                lastSyncedAt: new Date().toISOString(),
                lastSyncStatus: 'error',
                lastSyncResourceCount: 0,
                lastSyncError: msg,
            });
        }
    }
```

to:

```ts
    for (const account of targetAccounts) {
        try {
            log.debug('Scanning account', { tenantId, accountId: account.accountId, regions: account.regions });

            const credentials = await assumeRole(account.roleArn, account.accountId, account.regions?.[0] ?? 'ap-south-1', account.externalId);
            const regions = Array.isArray(account.regions) ? account.regions : [account.regions];

            const result = await runInventoryScan(credentials, regions, scanConfigs);
            totalResources += result.resources.length;

            await writeResourcesToPg(result.resources, tenantId, account.accountId, scanId);
            await reconcileAndWarnIfEmpty(tenantId, account.accountId, scanId, result.resources.length);
            await updateAccountSyncStatus(tenantId, account.accountId, {
                lastSyncedAt: new Date().toISOString(),
                lastSyncStatus: (result.errors?.length ?? 0) > 0 ? 'partial' : 'success',
                lastSyncResourceCount: result.resources.length,
            });

            accountsSynced++;
            if (result.errors?.length) errors.push(...result.errors);

            log.info('Account scan complete', {
                tenantId,
                accountId: account.accountId,
                resourceCount: result.resources.length,
                hasErrors: (result.errors?.length ?? 0) > 0,
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push(`Account ${account.accountId}: ${msg}`);
            log.error('Account scan failed', { tenantId, accountId: account.accountId, error: msg });

            await reconcileAndWarnIfEmpty(tenantId, account.accountId, scanId, 0);
            await updateAccountSyncStatus(tenantId, account.accountId, {
                lastSyncedAt: new Date().toISOString(),
                lastSyncStatus: 'error',
                lastSyncResourceCount: 0,
                lastSyncError: msg,
            });
        }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/workers && bunx vitest run src/jobs/discovery/__tests__/handle-discovery-scan.test.ts src/jobs/discovery/__tests__/index.test.ts src/jobs/discovery/__tests__/pg-writer.test.ts
```

Expected: PASS on all three files (confirms the new tests pass and nothing in the existing `index.test.ts`/`pg-writer.test.ts` regressed).

- [ ] **Step 5: Commit**

```bash
git add apps/workers/src/jobs/discovery/index.ts apps/workers/src/jobs/discovery/__tests__/handle-discovery-scan.test.ts
git commit -m "feat(discovery): call reconcileStaleResources per account, warn on empty-scan staling"
```

---

### Task 4: Repository read path — filter `isCurrent = true`

**Files:**
- Modify: `apps/web-ui/lib/db/repositories/inventory/postgres.ts:78-96` (`listResources`) and `:109-173` (`listResourcesFulltext`)
- Test: `apps/web-ui/lib/db/repositories/inventory/postgres.test.ts`

**Interfaces:**
- Consumes: `InventoryResource.isCurrent` from Task 1's migration (via the regenerated Prisma client).
- Produces: nothing new consumed elsewhere — this is the grid's terminal read path.

- [ ] **Step 1: Write the failing tests**

Add to `apps/web-ui/lib/db/repositories/inventory/postgres.test.ts`, inside `describe('listResources', ...)` (after the `'cross-tenant isolation'` test):

```ts
        it('filters to isCurrent = true rows', async () => {
            mockPrisma.inventoryResource.count.mockResolvedValue(1);
            mockPrisma.inventoryResource.findMany.mockResolvedValue([makeRow()]);

            const repo = new InventoryPostgresRepository();
            await repo.listResources({ tenantId: 'org-default' });

            const callArg = mockPrisma.inventoryResource.findMany.mock.calls[0][0];
            expect(callArg.where.isCurrent).toBe(true);

            const countArg = mockPrisma.inventoryResource.count.mock.calls[0][0];
            expect(countArg.where.isCurrent).toBe(true);
        });
```

Add a new `describe` block (sibling to `describe('listResources', ...)`) for the fulltext path:

```ts
    describe('listResourcesFulltext (via searchTerm)', () => {
        it('includes isCurrent = true in the WHERE clause', async () => {
            mockPrisma.$queryRawUnsafe = vi
                .fn()
                .mockResolvedValueOnce([{ total: 0 }])
                .mockResolvedValueOnce([]);

            const repo = new InventoryPostgresRepository();
            await repo.listResources({ tenantId: 'org-default', searchTerm: 'prod' });

            const countSql = mockPrisma.$queryRawUnsafe.mock.calls[0][0];
            const dataSql = mockPrisma.$queryRawUnsafe.mock.calls[1][0];
            expect(countSql).toContain('"isCurrent" = true');
            expect(dataSql).toContain('"isCurrent" = true');
        });
    });
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/web-ui && bunx vitest run lib/db/repositories/inventory/postgres.test.ts
```

Expected: the two new tests FAIL (`callArg.where.isCurrent` is `undefined`; the raw SQL strings don't contain `"isCurrent" = true`). The pre-existing `'adds ILIKE name filter for searchTerm'` failure is expected and unrelated — ignore it.

- [ ] **Step 3: Implement**

In `apps/web-ui/lib/db/repositories/inventory/postgres.ts`, change the `where` construction in `listResources` (lines 78-83) from:

```ts
            // Standard Prisma path (no search term)
            const where: Record<string, unknown> = { tenantId };

            if (accountId) where.accountId = accountId;
            else if (accountIds?.length) where.accountId = { in: accountIds };
            if (region) where.region = region;
            if (resourceType) where.resourceType = resourceType;
```

to:

```ts
            // Standard Prisma path (no search term)
            const where: Record<string, unknown> = { tenantId, isCurrent: true };

            if (accountId) where.accountId = accountId;
            else if (accountIds?.length) where.accountId = { in: accountIds };
            if (region) where.region = region;
            if (resourceType) where.resourceType = resourceType;
```

Change the `listResourcesFulltext` where-clause seed (line 118) from:

```ts
        let whereClause = `WHERE "tenantId" = $1 AND "searchVector" @@ plainto_tsquery('english', $2)`;
```

to:

```ts
        let whereClause = `WHERE "tenantId" = $1 AND "isCurrent" = true AND "searchVector" @@ plainto_tsquery('english', $2)`;
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/web-ui && bunx vitest run lib/db/repositories/inventory/postgres.test.ts
```

Expected: 20/21 pass — the two new tests pass; the same 1 pre-existing unrelated failure remains (`adds ILIKE name filter for searchTerm`).

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/db/repositories/inventory/postgres.ts apps/web-ui/lib/db/repositories/inventory/postgres.test.ts
git commit -m "fix(inventory): exclude stale (isCurrent=false) rows from the grid read path"
```

---

### Task 5: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full workers test suite**

```bash
cd apps/workers && bun run test
```

Expected: PASS (no regressions beyond the pre-existing baseline noted above).

- [ ] **Step 2: Run the full web-ui test suite**

```bash
cd apps/web-ui && bun run test
```

Expected: PASS except the 1 pre-existing unrelated failure (`adds ILIKE name filter for searchTerm`).

- [ ] **Step 3: Typecheck both apps**

```bash
cd apps/web-ui && bunx tsc --noEmit
cd apps/workers && bunx tsc --noEmit
```

Expected: no new errors introduced by this change (compare against whatever pre-existing baseline error count the repo already has, per `CLAUDE.md`'s note that the build ignores tsc/eslint errors — this is just a sanity check, not a hard gate).

- [ ] **Step 4: Manual smoke test against local Postgres**

```bash
docker compose up -d postgres
cd apps/workers && bun run dev
# in another terminal, trigger a scan for a real/seeded tenant+account, e.g. via the web-ui's
# "Sync Now" button or POST /api/inventory/sync, then re-run it a second time after manually
# deleting/tagging a resource out of scanfile scope to simulate disappearance
```

Confirm via `psql`:

```sql
SELECT "resourceId", "jobRunId", "isCurrent" FROM inventory_resources WHERE "accountId" = '<account>';
```

Expected: rows from the most recent scan have `isCurrent = true`; a resource resynced with a stale `jobRunId` from a prior scan shows `isCurrent = false` and is excluded from `GET /api/inventory/resources`.

---

## Files Changed Summary

| File | Task |
|------|------|
| `libs/prisma/schema.prisma` | 1 |
| `libs/prisma/migrations/20260708180000_add_inventory_is_current/migration.sql` | 1 |
| `apps/workers/src/jobs/discovery/services/pg-writer.ts` | 2 |
| `apps/workers/src/jobs/discovery/__tests__/pg-writer.test.ts` | 2 |
| `apps/workers/src/jobs/discovery/index.ts` | 3 |
| `apps/workers/src/jobs/discovery/__tests__/handle-discovery-scan.test.ts` | 3 |
| `apps/web-ui/lib/db/repositories/inventory/postgres.ts` | 4 |
| `apps/web-ui/lib/db/repositories/inventory/postgres.test.ts` | 4 |
