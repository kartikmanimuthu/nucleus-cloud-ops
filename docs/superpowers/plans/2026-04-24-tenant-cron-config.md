# Per-Tenant Scheduler & Discovery Cron Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire per-tenant cron frequency config into the scheduler and discovery workers so each tenant's interval is respected, and add a discovery settings UI + API.

**Architecture:** Global pg-boss cron ticks at a fixed cadence; on each tick the worker reads `tenant_configs` for each tenant's `intervalMinutes` (scheduler) or `period` (discovery) plus `lastRunAt`, skips tenants that haven't reached their interval, and writes `lastRunAt` after a successful run. No dynamic pg-boss schedule creation needed.

**Tech Stack:** TypeScript, pg-boss, pg (raw Pool), Next.js API routes, React, TenantConfigService (Prisma), Vitest

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `workers/src/jobs/scheduler/services/pg-service.ts` | Modify | Add `getTenantJobConfig` + `updateTenantJobLastRun` |
| `workers/src/jobs/scheduler/index.ts` | Modify | Add per-tenant frequency check in fan-out loop |
| `workers/src/jobs/discovery/index.ts` | Modify | Add per-tenant frequency check in fan-out loop |
| `workers/src/jobs/scheduler/index.test.ts` | Modify | Update cron assertion + add frequency-skip tests |
| `web-ui/app/api/discovery/settings/route.ts` | Create | GET + PUT for discovery period config |
| `web-ui/app/api/settings/scheduler/route.ts` | Delete | Duplicate of `/api/scheduler/settings` |
| `web-ui/components/settings/discovery-settings.tsx` | Create | Discovery frequency card (Daily/Weekly/Monthly) |
| `web-ui/components/settings/scheduler-settings.tsx` | Modify | Fix default cron from `*/30 * * * *` to `0 * * * *` |

---

### Task 1: Add `getTenantJobConfig` and `updateTenantJobLastRun` to pg-service

**Files:**
- Modify: `workers/src/jobs/scheduler/services/pg-service.ts`

- [ ] **Step 1: Add the two functions at the bottom of the file**

```typescript
// Add after the existing getTenantSchedulerConfig function

export type JobType = 'scheduler-cron' | 'discovery-cron';

export interface SchedulerJobConfig {
  intervalMinutes: number;
  lastRunAt: string | null;
}

export interface DiscoveryJobConfig {
  period: 'daily' | 'weekly' | 'monthly';
  lastRunAt: string | null;
}

export async function getTenantJobConfig(
  tenantId: string,
  jobType: 'scheduler-cron'
): Promise<SchedulerJobConfig>;
export async function getTenantJobConfig(
  tenantId: string,
  jobType: 'discovery-cron'
): Promise<DiscoveryJobConfig>;
export async function getTenantJobConfig(
  tenantId: string,
  jobType: JobType
): Promise<SchedulerJobConfig | DiscoveryJobConfig> {
  const client: PoolClient = await getPool().connect();
  try {
    const result = await client.query(
      `SELECT data FROM tenant_configs WHERE "tenantId" = $1 AND "configKey" = $2 LIMIT 1`,
      [tenantId, jobType]
    );
    if (result.rows.length === 0) {
      return jobType === 'scheduler-cron'
        ? { intervalMinutes: 60, lastRunAt: null }
        : { period: 'daily', lastRunAt: null };
    }
    const data = result.rows[0].data;
    return jobType === 'scheduler-cron'
      ? { intervalMinutes: data.intervalMinutes ?? 60, lastRunAt: data.lastRunAt ?? null }
      : { period: data.period ?? 'daily', lastRunAt: data.lastRunAt ?? null };
  } catch (error) {
    logger.error('[pg-service] Error fetching tenant job config', { tenantId, jobType, error });
    return jobType === 'scheduler-cron'
      ? { intervalMinutes: 60, lastRunAt: null }
      : { period: 'daily', lastRunAt: null };
  } finally {
    client.release();
  }
}

export async function updateTenantJobLastRun(
  tenantId: string,
  jobType: JobType,
  lastRunAt: string
): Promise<void> {
  const client: PoolClient = await getPool().connect();
  try {
    await client.query(
      `INSERT INTO tenant_configs ("id", "tenantId", "configKey", data, "updatedAt", "updatedBy")
       VALUES (gen_random_uuid()::text, $1, $2, $3::jsonb, now(), 'worker')
       ON CONFLICT ("tenantId", "configKey")
       DO UPDATE SET data = tenant_configs.data || $3::jsonb, "updatedAt" = now()`,
      [tenantId, jobType, JSON.stringify({ lastRunAt })]
    );
  } catch (error) {
    logger.error('[pg-service] Error updating tenant job lastRunAt', { tenantId, jobType, error });
    // Non-fatal — next tick will re-run the tenant
  } finally {
    client.release();
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd workers && npx tsc --noEmit
```
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add workers/src/jobs/scheduler/services/pg-service.ts
git commit -m "feat(workers): add getTenantJobConfig and updateTenantJobLastRun to pg-service"
```

### Task 2: Wire per-tenant frequency check into scheduler worker

**Files:**
- Modify: `workers/src/jobs/scheduler/index.ts`
- Modify: `workers/src/jobs/scheduler/index.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `workers/src/jobs/scheduler/index.test.ts` after the existing imports and mocks:

```typescript
// Add to existing vi.mock block for pg-service
vi.mock('./services/pg-service.js', () => ({
  getActiveTenants: vi.fn().mockResolvedValue([
    { id: 'tenant-1', name: 'Tenant One' },
  ]),
  getTenantSchedulerConfig: vi.fn().mockResolvedValue({ intervalMinutes: 60 }),
  getTenantJobConfig: vi.fn().mockResolvedValue({ intervalMinutes: 60, lastRunAt: null }),
  updateTenantJobLastRun: vi.fn().mockResolvedValue(undefined),
  getSchedules: vi.fn().mockResolvedValue([]),
  getAccounts: vi.fn().mockResolvedValue([]),
  getScheduleById: vi.fn().mockResolvedValue(null),
  logExecution: vi.fn().mockResolvedValue(undefined),
}));

// Add these test cases inside describe('scheduler job registration')
it('should register cron as 0 * * * *', async () => {
  await register(mockBoss, mockExecutor);
  expect(mockSchedule).toHaveBeenCalledWith(
    'scheduler-scan',
    '0 * * * *',
    {},
    { tz: 'UTC' }
  );
});

it('should skip tenant when interval has not elapsed', async () => {
  const { getTenantJobConfig, updateTenantJobLastRun } = await import('./services/pg-service.js');
  const recentRun = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago
  vi.mocked(getTenantJobConfig).mockResolvedValueOnce({ intervalMinutes: 60, lastRunAt: recentRun });

  await register(mockBoss, mockExecutor);
  const workCallback = mockWork.mock.calls[0][1];
  await workCallback([{ id: 'job-1', data: {} }]);

  expect(updateTenantJobLastRun).not.toHaveBeenCalled();
});

it('should run tenant when interval has elapsed', async () => {
  const { getTenantJobConfig, updateTenantJobLastRun } = await import('./services/pg-service.js');
  const oldRun = new Date(Date.now() - 90 * 60 * 1000).toISOString(); // 90 min ago
  vi.mocked(getTenantJobConfig).mockResolvedValueOnce({ intervalMinutes: 60, lastRunAt: oldRun });

  await register(mockBoss, mockExecutor);
  const workCallback = mockWork.mock.calls[0][1];
  await workCallback([{ id: 'job-1', data: {} }]);

  expect(updateTenantJobLastRun).toHaveBeenCalledWith('tenant-1', 'scheduler-cron', expect.any(String));
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd workers && npx vitest run src/jobs/scheduler/index.test.ts
```
Expected: new tests FAIL (getTenantJobConfig not called yet)

- [ ] **Step 3: Update scheduler index.ts**

Replace the `register` function in `workers/src/jobs/scheduler/index.ts`:

```typescript
import type PgBoss from 'pg-boss';
import { createLogger } from '../../lib/logger.js';
import type { JobExecutor } from '../../executor/index.js';
import { runFullScan, runPartialScan } from './services/scheduler-service.js';
import { getActiveTenants, getTenantJobConfig, updateTenantJobLastRun } from './services/pg-service.js';
import type { SchedulerEvent } from './types/index.js';

const log = createLogger('scheduler');

const JOB_NAME = 'scheduler-scan';

export async function handleSchedulerJob(jobData: unknown): Promise<void> {
  const event = jobData as SchedulerEvent | undefined;
  const isPartialScan = event?.scheduleId || event?.scheduleName;
  const triggeredBy = event?.triggeredBy || 'system';

  log.info('Processing scheduler job', {
    mode: isPartialScan ? 'partial' : 'full',
    triggeredBy,
  });

  if (isPartialScan) {
    const result = await runPartialScan(event as SchedulerEvent, triggeredBy);
    log.info('Partial scan complete', { result });
  } else {
    const result = await runFullScan(triggeredBy);
    log.info('Full scan complete', { result });
  }
}

export async function register(boss: PgBoss, executor: JobExecutor): Promise<void> {
  executor.registerHandler?.(JOB_NAME, handleSchedulerJob);

  await boss.createQueue(JOB_NAME);

  // Global tick — every hour (minimum granularity)
  await boss.schedule(JOB_NAME, '0 * * * *', {}, { tz: 'UTC' });

  await boss.work<SchedulerEvent>(
    JOB_NAME,
    { batchSize: 1 },
    async (jobs) => {
      const tenants = await getActiveTenants();
      for (const tenant of tenants) {
        const config = await getTenantJobConfig(tenant.id, 'scheduler-cron');
        const thresholdMs = config.intervalMinutes * 60 * 1000;
        const lastRun = config.lastRunAt ? new Date(config.lastRunAt).getTime() : 0;
        if (Date.now() - lastRun < thresholdMs) {
          log.info('Skipping tenant — interval not elapsed', {
            tenantId: tenant.id,
            intervalMinutes: config.intervalMinutes,
            lastRunAt: config.lastRunAt,
          });
          continue;
        }
        for (const job of jobs) {
          await executor.execute(JOB_NAME, job.data);
        }
        await updateTenantJobLastRun(tenant.id, 'scheduler-cron', new Date().toISOString());
      }
    },
  );

  log.info('Registered scheduler-scan job + cron');
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd workers && npx vitest run src/jobs/scheduler/index.test.ts
```
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add workers/src/jobs/scheduler/index.ts workers/src/jobs/scheduler/index.test.ts
git commit -m "feat(workers): add per-tenant frequency check to scheduler worker"
```

### Task 3: Wire per-tenant frequency check into discovery worker

**Files:**
- Modify: `workers/src/jobs/discovery/index.ts`
- Create: `workers/src/jobs/discovery/__tests__/frequency.test.ts`

- [ ] **Step 1: Write failing tests**

Create `workers/src/jobs/discovery/__tests__/frequency.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock pg-service before importing the module under test
vi.mock('../services/account-service.js', () => ({
  getAllTenants: vi.fn().mockResolvedValue([{ id: 'tenant-1', name: 'Tenant One' }]),
  getTenantAccounts: vi.fn().mockResolvedValue([]),
  updateAccountSyncStatus: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../scheduler/services/pg-service.js', () => ({
  getTenantJobConfig: vi.fn().mockResolvedValue({ period: 'daily', lastRunAt: null }),
  updateTenantJobLastRun: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/audit-service.js', () => ({ writeAuditLog: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../services/sts-service.js', () => ({ assumeRole: vi.fn() }));
vi.mock('../services/scanner.js', () => ({ runInventoryScan: vi.fn().mockResolvedValue({ resources: [], errors: [] }) }));
vi.mock('../services/pg-writer.js', () => ({
  writeResourcesToPg: vi.fn().mockResolvedValue(undefined),
  saveSyncStatus: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../services/vector-processor.js', () => ({ processAccountVectors: vi.fn().mockResolvedValue(undefined) }));
vi.mock('fs', () => ({ readFileSync: vi.fn().mockReturnValue('[]') }));

import { periodToMs, shouldRunTenant } from '../index.js';

describe('discovery frequency helpers', () => {
  it('periodToMs returns 24h for daily', () => {
    expect(periodToMs('daily')).toBe(24 * 60 * 60 * 1000);
  });

  it('periodToMs returns 7d for weekly', () => {
    expect(periodToMs('weekly')).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('periodToMs returns 30d for monthly', () => {
    expect(periodToMs('monthly')).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('shouldRunTenant returns true when lastRunAt is null', () => {
    expect(shouldRunTenant(null, 'daily')).toBe(true);
  });

  it('shouldRunTenant returns false when interval has not elapsed', () => {
    const recentRun = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(); // 12h ago
    expect(shouldRunTenant(recentRun, 'daily')).toBe(false);
  });

  it('shouldRunTenant returns true when interval has elapsed', () => {
    const oldRun = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25h ago
    expect(shouldRunTenant(oldRun, 'daily')).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd workers && npx vitest run src/jobs/discovery/__tests__/frequency.test.ts
```
Expected: FAIL — `periodToMs` and `shouldRunTenant` not exported

- [ ] **Step 3: Update discovery index.ts**

Add the two exported helpers and update the `register` function. Edit `workers/src/jobs/discovery/index.ts`:

After the imports, add:

```typescript
import { getTenantJobConfig, updateTenantJobLastRun } from '../scheduler/services/pg-service.js';
```

Add these two exported helpers before the `handleDiscoveryScan` function:

```typescript
export function periodToMs(period: 'daily' | 'weekly' | 'monthly'): number {
  switch (period) {
    case 'daily':   return 24 * 60 * 60 * 1000;
    case 'weekly':  return 7 * 24 * 60 * 60 * 1000;
    case 'monthly': return 30 * 24 * 60 * 60 * 1000;
  }
}

export function shouldRunTenant(
  lastRunAt: string | null,
  period: 'daily' | 'weekly' | 'monthly'
): boolean {
  if (!lastRunAt) return true;
  return Date.now() - new Date(lastRunAt).getTime() >= periodToMs(period);
}
```

Replace the fan-out worker callback in `register` (the `boss.work<DiscoveryFanOutJob>` block) with:

```typescript
  await boss.work<DiscoveryFanOutJob>(
    'discovery-fan-out',
    { batchSize: 1 },
    async ([job]) => {
      log.info('Fan-out triggered', { jobId: job.id });
      const tenants = await getAllTenants();
      for (const tenant of tenants) {
        const config = await getTenantJobConfig(tenant.id, 'discovery-cron');
        if (!shouldRunTenant(config.lastRunAt, config.period)) {
          log.info('Skipping discovery — interval not elapsed', {
            tenantId: tenant.id,
            period: config.period,
            lastRunAt: config.lastRunAt,
          });
          continue;
        }
        const jobId = await boss.send(
          'discovery-scan',
          { type: 'scan', tenantId: tenant.id, triggeredBy: 'cron' } satisfies DiscoveryScanJob,
          {
            singletonKey: `tenant:${tenant.id}`,
            retryLimit: 2,
            retryDelay: 60,
            retryBackoff: true,
          }
        );
        if (jobId === null) {
          log.warn('Scan job already queued or active, skipping', { tenantId: tenant.id });
        } else {
          await updateTenantJobLastRun(tenant.id, 'discovery-cron', new Date().toISOString());
          log.debug('Scan job enqueued', { tenantId: tenant.id, jobId });
        }
      }
      log.info('Fan-out complete', { tenantCount: tenants.length });
    }
  );
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd workers && npx vitest run src/jobs/discovery/__tests__/frequency.test.ts
```
Expected: all tests PASS

- [ ] **Step 5: Verify TypeScript compiles**

```bash
cd workers && npx tsc --noEmit
```
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add workers/src/jobs/discovery/index.ts workers/src/jobs/discovery/__tests__/frequency.test.ts
git commit -m "feat(workers): add per-tenant frequency check to discovery worker"
```

### Task 4: Create discovery settings API

**Files:**
- Create: `web-ui/app/api/discovery/settings/route.ts`

- [ ] **Step 1: Create the route file**

```typescript
// web-ui/app/api/discovery/settings/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { TenantConfigService } from '@/lib/tenant-config-service';
import { AuditService } from '@/lib/audit-service';

const CONFIG_KEY = 'discovery-cron';
const VALID_PERIODS = ['daily', 'weekly', 'monthly'] as const;
type Period = typeof VALID_PERIODS[number];

function periodToNextEligible(lastRunAt: string | null, period: Period): string | null {
  if (!lastRunAt) return null;
  const ms = { daily: 86400000, weekly: 604800000, monthly: 2592000000 }[period];
  return new Date(new Date(lastRunAt).getTime() + ms).toISOString();
}

export async function GET() {
  console.log('API - GET /api/discovery/settings - Fetching discovery cron config');

  const authError = await authorize('read', 'Discovery');
  if (authError) return authError;

  try {
    const tenantId = await getSessionTenantId();
    if (!tenantId) {
      return NextResponse.json({ success: false, error: 'No tenant context' }, { status: 403 });
    }

    const config = await TenantConfigService.getConfig<{ period: Period; lastRunAt?: string }>(
      CONFIG_KEY,
      tenantId
    );
    const period: Period = config?.period ?? 'daily';
    const lastRunAt = config?.lastRunAt ?? null;

    return NextResponse.json({
      success: true,
      data: {
        period,
        lastRunAt,
        nextEligibleAt: periodToNextEligible(lastRunAt, period),
      },
    });
  } catch (error) {
    console.error('API - Error fetching discovery settings:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to fetch discovery settings' },
      { status: 500 }
    );
  }
}

export async function PUT(request: NextRequest) {
  console.log('API - PUT /api/discovery/settings - Saving discovery cron config');

  const authError = await authorize('update', 'Discovery');
  if (authError) return authError;

  try {
    const tenantId = await getSessionTenantId();
    if (!tenantId) {
      return NextResponse.json({ success: false, error: 'No tenant context' }, { status: 403 });
    }

    const body = await request.json();
    const { period } = body as { period?: string };

    if (!period || !(VALID_PERIODS as readonly string[]).includes(period)) {
      return NextResponse.json(
        { success: false, error: 'period must be one of: daily, weekly, monthly' },
        { status: 400 }
      );
    }

    const session = await getServerSession(authOptions);
    const updatedBy = session?.user?.email || 'api-user';

    // Preserve existing lastRunAt when updating period
    const existing = await TenantConfigService.getConfig<{ period: Period; lastRunAt?: string }>(
      CONFIG_KEY,
      tenantId
    );
    await TenantConfigService.saveConfig(
      CONFIG_KEY,
      { period: period as Period, lastRunAt: existing?.lastRunAt ?? null },
      tenantId,
      updatedBy
    );

    await AuditService.logUserAction({
      eventType: 'inventory.discovery.settings.updated',
      severity: 'medium',
      apiRoute: 'PUT /api/discovery/settings',
      httpMethod: 'PUT',
      action: 'Update Discovery Settings',
      resourceType: 'settings',
      resourceId: CONFIG_KEY,
      resourceName: 'Discovery Cron Settings',
      user: updatedBy,
      userType: 'user',
      status: 'success',
      details: `Updated discovery scan period to ${period}`,
      tenantId,
    });

    return NextResponse.json({ success: true, data: { period } });
  } catch (error) {
    console.error('API - Error saving discovery settings:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to save discovery settings' },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd web-ui && npx tsc --noEmit
```
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add web-ui/app/api/discovery/settings/route.ts
git commit -m "feat(api): add GET/PUT /api/discovery/settings for per-tenant discovery period"
```

### Task 5: Create DiscoverySettings UI component

**Files:**
- Create: `web-ui/components/settings/discovery-settings.tsx`

- [ ] **Step 1: Create the component**

```typescript
// web-ui/components/settings/discovery-settings.tsx
"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Search } from "lucide-react";

type Period = "daily" | "weekly" | "monthly";

const PRESETS: { label: string; value: Period; description: string }[] = [
  { label: "Daily", value: "daily", description: "Scan all accounts once per day" },
  { label: "Weekly", value: "weekly", description: "Scan all accounts once per week" },
  { label: "Monthly", value: "monthly", description: "Scan all accounts once per month" },
];

function formatDate(iso: string | null): string {
  if (!iso) return "Never";
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function DiscoverySettings({ canEdit }: { canEdit: boolean }) {
  const [period, setPeriod] = useState<Period>("daily");
  const [lastRunAt, setLastRunAt] = useState<string | null>(null);
  const [nextEligibleAt, setNextEligibleAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    fetch("/api/discovery/settings")
      .then((r) => r.json())
      .then((data) => {
        if (data.success) {
          setPeriod(data.data.period);
          setLastRunAt(data.data.lastRunAt);
          setNextEligibleAt(data.data.nextEligibleAt);
        }
      })
      .catch(() => {/* keep defaults */})
      .finally(() => setLoading(false));
  }, []);

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSuccess(false);
    try {
      const res = await fetch("/api/discovery/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ period }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Failed to save");
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Search className="h-5 w-5" />
          Discovery Scan Frequency
        </CardTitle>
        <CardDescription>
          Configure how often the inventory discovery scan runs for your organization.
          Discovery is resource-intensive — daily or less frequent is recommended.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label>Frequency</Label>
          <Select
            value={period}
            onValueChange={(val) => setPeriod(val as Period)}
            disabled={!canEdit}
          >
            <SelectTrigger className="w-full max-w-xs">
              <SelectValue placeholder="Select frequency" />
            </SelectTrigger>
            <SelectContent>
              {PRESETS.map((p) => (
                <SelectItem key={p.value} value={p.value}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-sm text-muted-foreground">
            {PRESETS.find((p) => p.value === period)?.description}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <p className="text-muted-foreground">Last run</p>
            <p className="font-medium">{formatDate(lastRunAt)}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Next eligible</p>
            <p className="font-medium">{formatDate(nextEligibleAt)}</p>
          </div>
        </div>

        {canEdit && (
          <div className="flex items-center gap-3">
            <Button onClick={handleSave} disabled={saving} size="sm">
              {saving ? "Saving..." : "Save"}
            </Button>
            {success && <span className="text-sm text-green-600">Saved</span>}
            {error && <span className="text-sm text-destructive">{error}</span>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd web-ui && npx tsc --noEmit
```
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add web-ui/components/settings/discovery-settings.tsx
git commit -m "feat(ui): add DiscoverySettings component for per-tenant discovery frequency"
```

### Task 6: Fix scheduler-settings default cron + wire DiscoverySettings into schedules settings page

**Files:**
- Modify: `web-ui/components/settings/scheduler-settings.tsx`
- Modify: `web-ui/app/app/schedules/settings/page.tsx`

- [ ] **Step 1: Fix default cron in SchedulerSettings component**

In `web-ui/components/settings/scheduler-settings.tsx`, change line 28:

```typescript
// Before
const [cron, setCron] = useState("*/30 * * * *");

// After
const [cron, setCron] = useState("0 * * * *");
```

- [ ] **Step 2: Add DiscoverySettings to the schedules settings page**

In `web-ui/app/app/schedules/settings/page.tsx`, add the import at the top:

```typescript
import { DiscoverySettings } from "@/components/settings/discovery-settings";
```

Then add the `DiscoverySettings` card after the existing two-column grid (after the closing `</div>` of the `{!loading && settings && (` block, before the Information Card):

```tsx
{/* Discovery Settings */}
<DiscoverySettings canEdit={true} />
```

The full updated return structure around that area:

```tsx
      {/* Settings Content */}
      {!loading && settings && (
        <div className="grid gap-6 md:grid-cols-2">
          {/* ... existing Current Configuration and Update Schedule Interval cards ... */}
        </div>
      )}

      {/* Discovery Settings */}
      <DiscoverySettings canEdit={true} />

      {/* Information Card */}
      <Card>
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd web-ui && npx tsc --noEmit
```
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add web-ui/components/settings/scheduler-settings.tsx web-ui/app/app/schedules/settings/page.tsx
git commit -m "feat(ui): wire DiscoverySettings into schedules settings page, fix scheduler default cron"
```

### Task 7: Remove duplicate /api/settings/scheduler route

**Files:**
- Delete: `web-ui/app/api/settings/scheduler/route.ts`

- [ ] **Step 1: Verify nothing imports the old route**

```bash
grep -r "settings/scheduler" /Users/kartik/.superset/worktrees/nucleus-cloud-ops/infra-changes/web-ui --include="*.ts" --include="*.tsx" -l
```
Expected: only `web-ui/app/api/settings/scheduler/route.ts` itself (no consumers)

- [ ] **Step 2: Delete the file**

```bash
rm web-ui/app/api/settings/scheduler/route.ts
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd web-ui && npx tsc --noEmit
```
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add -u web-ui/app/api/settings/scheduler/route.ts
git commit -m "chore: remove duplicate /api/settings/scheduler route"
```

---

### Task 8: Run full test suite and verify

**Files:** none

- [ ] **Step 1: Run workers tests**

```bash
cd workers && npx vitest run
```
Expected: all tests PASS

- [ ] **Step 2: Run web-ui tests**

```bash
cd web-ui && npm run test
```
Expected: all tests PASS

- [ ] **Step 3: Run web-ui lint**

```bash
cd web-ui && npm run lint
```
Expected: no errors

- [ ] **Step 4: Final commit if any lint fixes were needed**

```bash
git add -A && git commit -m "chore: fix lint issues after tenant cron config implementation"
```
Only run this step if lint produced auto-fixable changes. If lint has errors that need manual fixes, fix them first.

---
