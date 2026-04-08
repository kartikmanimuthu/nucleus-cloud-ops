---
type: quick
description: Per-tenant scheduler cron configuration — settings UI + API + workers per-tenant scheduling
files_modified:
  - web-ui/app/api/settings/scheduler/route.ts
  - web-ui/components/settings/scheduler-settings.tsx
  - web-ui/app/app/settings/organization/page.tsx
  - workers/src/jobs/scheduler/services/pg-service.ts
  - workers/src/jobs/scheduler/index.ts
---

<objective>
Allow each tenant to configure their own scheduler cron expression (default: every 30 min).
Expose a Settings UI under Organization settings, backed by a GET/PUT API that persists to
tenant_configs (key: scheduler_cron). The workers process reads per-tenant cron configs on
startup and schedules a dedicated pg-boss queue per tenant.
</objective>

<context>
@workers/src/jobs/scheduler/index.ts
@workers/src/jobs/scheduler/services/pg-service.ts
@web-ui/lib/tenant-config-service.ts
@web-ui/components/settings/organization-settings-form.tsx
@web-ui/app/app/settings/organization/page.tsx

<interfaces>
TenantConfigService.getConfig<T>(configKey, tenantId): Promise<T | null>
TenantConfigService.saveConfig<T>(configKey, data, tenantId, updatedBy?): Promise<void>

pg-boss schedule API:
  boss.schedule(queueName, cronExpr, data, { tz: 'UTC' })
  boss.work(queueName, { batchSize: 1 }, handler)
  boss.createQueue(queueName)

tenant_configs table: { tenantId, configKey: 'scheduler_cron', data: { cron: string } }
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: GET/PUT /api/settings/scheduler API</name>
  <files>web-ui/app/api/settings/scheduler/route.ts</files>
  <action>
Create `web-ui/app/api/settings/scheduler/route.ts`.

Imports: NextRequest, NextResponse from 'next/server'; authorize from '@/lib/rbac/authorize';
getSessionTenantId from '@/lib/auth-session'; TenantConfigService from '@/lib/tenant-config-service'.

Config key constant: `const SCHEDULER_CRON_KEY = 'scheduler_cron'`
Default cron: `const DEFAULT_CRON = '*/30 * * * *'`

GET handler:
1. authorize('read', 'Schedule') — return authError if non-null
2. tenantId = await getSessionTenantId()
3. config = await TenantConfigService.getConfig<{ cron: string }>(SCHEDULER_CRON_KEY, tenantId)
4. Return { success: true, data: { cron: config?.cron ?? DEFAULT_CRON } }
5. Wrap in try/catch, return 500 on error

PUT handler:
1. authorize('update', 'Schedule') — return authError if non-null
2. Parse body: { cron: string }. Validate cron is non-empty string; return 400 if missing.
3. Basic cron validation: must have exactly 5 space-separated parts; return 400 if invalid.
4. tenantId = await getSessionTenantId()
5. await TenantConfigService.saveConfig(SCHEDULER_CRON_KEY, { cron }, tenantId, 'user')
6. Return { success: true, data: { cron } }
7. Wrap in try/catch, return 500 on error

Add console.log at entry of each handler.
  </action>
  <verify>cd /Users/kartik/Documents/git-repo/nucleus-cloud-ops/.claude/worktrees/agent-ac0c3da9/web-ui && npx tsc --noEmit --pretty 2>&1 | head -30</verify>
  <done>GET returns current cron (or default), PUT validates and saves cron to tenant_configs</done>
</task>

<task type="auto">
  <name>Task 2: Scheduler Settings UI component</name>
  <files>web-ui/components/settings/scheduler-settings.tsx, web-ui/app/app/settings/organization/page.tsx</files>
  <action>
Create `web-ui/components/settings/scheduler-settings.tsx`:

"use client" component. Imports: useState, useEffect from react; Button from '@/components/ui/button';
Input from '@/components/ui/input'; Label from '@/components/ui/label';
Card/CardContent/CardDescription/CardHeader/CardTitle from '@/components/ui/card';
Select/SelectContent/SelectItem/SelectTrigger/SelectValue from '@/components/ui/select';
cronstrue from 'cronstrue'; Clock from 'lucide-react'.

Props: `{ canEdit: boolean }`

State: cron (string, default '*/30 * * * *'), loading (bool), saving (bool), error (string|null), success (bool).

PRESETS array:
  { label: 'Every 15 minutes', value: '*/15 * * * *' }
  { label: 'Every 30 minutes', value: '*/30 * * * *' }
  { label: 'Every hour', value: '0 * * * *' }
  { label: 'Every 2 hours', value: '0 */2 * * *' }
  { label: 'Every 6 hours', value: '0 */6 * * *' }
  { label: 'Custom', value: 'custom' }

useEffect on mount: fetch GET /api/settings/scheduler, set cron from response.

humanReadable: compute via try/catch cronstrue.toString(cron) — empty string on error.
isValidCron: cron.trim().split(/\s+/).length === 5 (basic check).

Render a Card with title "Scheduler Frequency" and description "Configure how often the resource scheduler runs for your organization."

Inside CardContent:
1. A Select for presets — selectedPreset is the matching preset value or 'custom'.
   On change: if not 'custom', set cron to preset value.
2. An Input for the raw cron expression (always visible, editable when canEdit).
   Show humanReadable below in muted text if valid, or "Invalid cron expression" in red if not.
3. A Save button (disabled when !canEdit || saving || !isValidCron).
   On click: PUT /api/settings/scheduler with { cron }, show success/error state.

Show success toast-style message "Saved" for 3s after successful save.
  </action>
  <verify>cd /Users/kartik/Documents/git-repo/nucleus-cloud-ops/.claude/worktrees/agent-ac0c3da9/web-ui && npx tsc --noEmit --pretty 2>&1 | head -30</verify>
  <done>SchedulerSettings component renders preset select + cron input + human-readable description + save button</done>
</task>

<task type="auto">
  <name>Task 3: Wire SchedulerSettings into Organization settings page</name>
  <files>web-ui/app/app/settings/organization/page.tsx</files>
  <action>
Update `web-ui/app/app/settings/organization/page.tsx` to be a server component that passes
canEdit to both OrganizationSettingsForm and SchedulerSettings.

Since OrganizationSettingsForm is already a client component that reads session internally,
keep the page simple:

1. Import SchedulerSettings from '@/components/settings/scheduler-settings'
2. The page is a server component — use getServerSession to get role.
3. Derive canEdit: role === 'Owner' || role === 'Admin' || isSuperAdmin.
4. Render OrganizationSettingsForm first, then SchedulerSettings below it, passing canEdit.

If the page is currently just `return <OrganizationSettingsForm />`, change it to:
```tsx
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { OrganizationSettingsForm } from "@/components/settings/organization-settings-form";
import { SchedulerSettings } from "@/components/settings/scheduler-settings";

export default async function OrganizationSettingsPage() {
    const session = await getServerSession(authOptions);
    const role = (session?.user as { role?: string } | undefined)?.role;
    const isSuperAdmin = (session?.user as { isSuperAdmin?: boolean } | undefined)?.isSuperAdmin;
    const canEdit = role === 'Owner' || role === 'Admin' || isSuperAdmin === true;
    return (
        <div className="space-y-6">
            <OrganizationSettingsForm />
            <SchedulerSettings canEdit={canEdit} />
        </div>
    );
}
```
  </action>
  <verify>cd /Users/kartik/Documents/git-repo/nucleus-cloud-ops/.claude/worktrees/agent-ac0c3da9/web-ui && npx tsc --noEmit --pretty 2>&1 | head -30</verify>
  <done>Organization settings page renders SchedulerSettings below OrganizationSettingsForm</done>
</task>

<task type="auto">
  <name>Task 4: Per-tenant cron scheduling in workers</name>
  <files>workers/src/jobs/scheduler/services/pg-service.ts, workers/src/jobs/scheduler/index.ts</files>
  <action>
**pg-service.ts** — add getTenantSchedulerCron:

```typescript
/**
 * Get the scheduler cron expression for a tenant.
 * Reads from tenant_configs where configKey = 'scheduler_cron'.
 * Falls back to DEFAULT_CRON if not configured.
 */
export const DEFAULT_SCHEDULER_CRON = '*/30 * * * *';

export async function getTenantSchedulerCron(tenantId: string): Promise<string> {
    const client: PoolClient = await getPool().connect();
    try {
        const result = await client.query(
            `SELECT data FROM tenant_configs WHERE "tenantId" = $1 AND "configKey" = 'scheduler_cron' LIMIT 1`,
            [tenantId]
        );
        if (result.rows.length > 0) {
            const data = result.rows[0].data as { cron?: string };
            return data?.cron || DEFAULT_SCHEDULER_CRON;
        }
        return DEFAULT_SCHEDULER_CRON;
    } catch (error) {
        logger.error('[pg-service] Error fetching tenant scheduler cron', error);
        return DEFAULT_SCHEDULER_CRON;
    } finally {
        client.release();
    }
}
```

**index.ts** — replace hardcoded single cron with per-tenant scheduling:

```typescript
import PgBoss from 'pg-boss';
import { runFullScan, runPartialScan } from './services/scheduler-service.js';
import { getActiveTenants, getTenantSchedulerCron, DEFAULT_SCHEDULER_CRON } from './services/pg-service.js';
import type { SchedulerEvent } from './types/index.js';

const USE_PG_SCHEDULES = process.env.USE_PG_SCHEDULES === 'true';

export async function register(boss: PgBoss): Promise<void> {
  if (USE_PG_SCHEDULES) {
    // Per-tenant scheduling: each tenant gets its own queue with its configured cron
    const tenants = await getActiveTenants();
    console.log(`[scheduler] Scheduling ${tenants.length} tenant queues`);

    for (const tenant of tenants) {
      const queueName = `scheduler-scan-${tenant.id}`;
      const cron = await getTenantSchedulerCron(tenant.id);

      await boss.createQueue(queueName);
      await boss.schedule(queueName, cron, { tenantId: tenant.id }, { tz: 'UTC' });

      await boss.work<SchedulerEvent>(
        queueName,
        { batchSize: 1 },
        async (jobs) => {
          for (const job of jobs) {
            const event = { ...job.data, tenantId: tenant.id };
            const isPartialScan = event?.scheduleId || event?.scheduleName;
            const triggeredBy = event?.triggeredBy || 'system';

            console.log(`[scheduler] Processing job ${job.id} for tenant ${tenant.id}`, {
              mode: isPartialScan ? 'partial' : 'full',
              triggeredBy,
            });

            if (isPartialScan) {
              const result = await runPartialScan(event, triggeredBy);
              console.log(`[scheduler] Partial scan complete for tenant ${tenant.id}`, result);
            } else {
              const result = await runFullScan(triggeredBy);
              console.log(`[scheduler] Full scan complete for tenant ${tenant.id}`, result);
            }
          }
        },
      );

      console.log(`[scheduler] Registered queue ${queueName} with cron: ${cron}`);
    }
  } else {
    // Fallback: single global queue with default cron (DynamoDB mode)
    await boss.createQueue('scheduler-scan');
    await boss.schedule('scheduler-scan', DEFAULT_SCHEDULER_CRON, {}, { tz: 'UTC' });

    await boss.work<SchedulerEvent>(
      'scheduler-scan',
      { batchSize: 1 },
      async (jobs) => {
        for (const job of jobs) {
          const event = job.data;
          const isPartialScan = event?.scheduleId || event?.scheduleName;
          const triggeredBy = event?.triggeredBy || 'system';

          console.log(`[scheduler] Processing job ${job.id}`, {
            mode: isPartialScan ? 'partial' : 'full',
            triggeredBy,
          });

          if (isPartialScan) {
            const result = await runPartialScan(event, triggeredBy);
            console.log(`[scheduler] Partial scan complete`, result);
          } else {
            const result = await runFullScan(triggeredBy);
            console.log(`[scheduler] Full scan complete`, result);
          }
        }
      },
    );

    console.log(`[scheduler] Registered global scheduler-scan with cron: ${DEFAULT_SCHEDULER_CRON}`);
  }
}
```
  </action>
  <verify>cd /Users/kartik/Documents/git-repo/nucleus-cloud-ops/.claude/worktrees/agent-ac0c3da9/workers && npx tsc --noEmit --pretty 2>&1 | head -30</verify>
  <done>Workers schedule per-tenant queues with per-tenant cron when USE_PG_SCHEDULES=true; falls back to global queue otherwise</done>
</task>

</tasks>

<verification>
1. `cd web-ui && npx tsc --noEmit` — no type errors
2. `cd workers && npx tsc --noEmit` — no type errors
3. GET /api/settings/scheduler returns { success: true, data: { cron: '*/30 * * * *' } } for unconfigured tenant
4. PUT /api/settings/scheduler with { cron: '0 * * * *' } saves and returns updated cron
5. Organization settings page shows Scheduler Frequency card with preset select + cron input
</verification>

<success_criteria>
- GET/PUT /api/settings/scheduler reads/writes scheduler_cron from tenant_configs
- SchedulerSettings UI shows preset select, cron input, human-readable description
- Organization settings page includes SchedulerSettings card
- Workers schedule per-tenant queues with per-tenant cron when USE_PG_SCHEDULES=true
- No TypeScript errors in web-ui or workers
</success_criteria>
