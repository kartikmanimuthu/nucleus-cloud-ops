# Per-Tenant Scheduler & Discovery Cron Configuration

**Date:** 2026-04-24
**Status:** Approved

## Problem

The scheduler and discovery workers use hardcoded global pg-boss cron expressions. A UI exists for scheduler frequency but the worker ignores it. Discovery has no UI at all. Neither job respects per-tenant configuration.

## Approach

Global tick + per-tenant frequency check. One global pg-boss cron fires at a fixed cadence (the minimum granularity). On each tick, the worker reads each tenant's configured interval and `lastRunAt` timestamp from `tenant_configs`. If not enough time has elapsed, the tenant is skipped. No dynamic pg-boss schedule creation needed.

## Data Model

Two keys in the existing `tenant_configs` table (no schema changes):

```
key: "scheduler-cron"
data: { intervalMinutes: 60, lastRunAt: "2026-04-24T10:00:00Z" }

key: "discovery-cron"
data: { period: "daily" | "weekly" | "monthly", lastRunAt: "2026-04-24T00:00:00Z" }
```

- `lastRunAt` is written by the worker after each successful tenant pass, never by the UI
- Default if no config row exists: `intervalMinutes: 60` for scheduler, `period: "daily"` for discovery
- `null` `lastRunAt` means the tenant has never run — always run on first tick

Period → minimum elapsed time mapping:
- `daily` → 24 hours
- `weekly` → 7 days
- `monthly` → 30 days

## Worker Logic

### Scheduler (`workers/src/jobs/scheduler/index.ts`)

Global tick: `0 * * * *` (every hour — minimum granularity).

Per-tenant logic on each tick:
1. Read `scheduler-cron` config for tenant → `{ intervalMinutes, lastRunAt }`
2. If `now - lastRunAt < intervalMinutes * 60s` → skip
3. Run full scan for tenant
4. Write `lastRunAt = now` to `tenant_configs`

### Discovery (`workers/src/jobs/discovery/index.ts`)

Global tick: `0 0 * * *` (daily at midnight UTC — minimum granularity).

Per-tenant logic on each tick:
1. Read `discovery-cron` config for tenant → `{ period, lastRunAt }`
2. Compute threshold: daily=24h, weekly=7d, monthly=30d
3. If `now - lastRunAt < threshold` → skip
4. Run discovery scan for tenant
5. Write `lastRunAt = now` to `tenant_configs`

Both workers use `pg-service.ts` for the config read/write — a new `getTenantJobConfig` and `updateTenantJobLastRun` function added there.

## API

### Scheduler (existing, no change)
- `GET /api/scheduler/settings` — returns `{ intervalMinutes, cronExpression, lastRunAt }`
- `PUT /api/scheduler/settings` — accepts `{ scheduleInterval: 5 | 15 | 30 | 60 }`

### Discovery (new)
- `GET /api/discovery/settings` — returns `{ period, lastRunAt, nextEligibleAt }`
- `PUT /api/discovery/settings` — accepts `{ period: "daily" | "weekly" | "monthly" }`

Both routes: RBAC via `authorize()`, audit log on PUT, `TenantConfigService` for persistence.

### Cleanup
- Remove `/api/settings/scheduler` — duplicate of `/api/scheduler/settings`, dead code

## UI

### Scheduler settings (existing `SchedulerSettingsPage`)
- Update default cron display from `*/30 * * * *` to `0 * * * *`
- Update `SchedulerSettings` component default state to match

### Discovery settings (new `DiscoverySettings` component)
- Location: new card in inventory settings or alongside the existing inventory scan controls
- Presets: Daily / Weekly / Monthly (no custom cron input — discovery is too heavy)
- Shows: current period, last run time, next eligible run time
- "Save" button calls `PUT /api/discovery/settings`
- "Scan Now" button calls existing `POST /api/discovery/execute`

## Files Affected

| File | Change |
|------|--------|
| `workers/src/jobs/scheduler/index.ts` | Add per-tenant frequency check |
| `workers/src/jobs/discovery/index.ts` | Add per-tenant frequency check |
| `workers/src/jobs/scheduler/services/pg-service.ts` | Add `getTenantJobConfig`, `updateTenantJobLastRun` |
| `web-ui/app/api/discovery/settings/route.ts` | New GET + PUT |
| `web-ui/app/api/settings/scheduler/route.ts` | Delete (duplicate) |
| `web-ui/components/settings/scheduler-settings.tsx` | Fix default cron value |
| `web-ui/components/settings/discovery-settings.tsx` | New component |

## Out of Scope

- Per-tenant pg-boss schedules (dynamic schedule creation) — not needed with this approach
- Sub-daily discovery intervals — discovery is too resource-intensive
- Scheduler intervals below 5 minutes
