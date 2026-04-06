---
phase: quick
plan: 260406-rju
subsystem: scheduler
tags: [scheduler, cron, per-tenant, pg-boss, settings-ui, tenant-config]
dependency_graph:
  requires: [tenant_configs table, TenantConfigService, pg-boss workers]
  provides: [per-tenant scheduler cron config API, SchedulerSettings UI, per-tenant pg-boss queues]
  affects: [workers/scheduler, web-ui/settings/organization]
tech_stack:
  added: []
  patterns: [TenantConfigService.getConfig/saveConfig, pg-boss per-tenant queue per cron]
key_files:
  created:
    - web-ui/app/api/settings/scheduler/route.ts
    - web-ui/components/settings/scheduler-settings.tsx
  modified:
    - web-ui/app/app/settings/organization/page.tsx
    - workers/src/jobs/scheduler/services/pg-service.ts
    - workers/src/jobs/scheduler/index.ts
decisions:
  - "Per-tenant queue naming: scheduler-scan-{tenantId} — avoids cron conflicts between tenants"
  - "Fallback to single global queue when USE_PG_SCHEDULES=false (DynamoDB mode)"
  - "getTenantSchedulerCron falls back to DEFAULT_SCHEDULER_CRON on DB error — non-fatal"
metrics:
  duration: 384s
  completed: 2026-04-06
  tasks: 4
  files: 5
---

# Quick Task 260406-rju: Per-Tenant Scheduler Cron Configuration Summary

Per-tenant scheduler cron configuration via Settings UI + API + pg-boss per-tenant queues.

## What Was Built

**API** (`web-ui/app/api/settings/scheduler/route.ts`): GET returns current cron from `tenant_configs` (default `*/30 * * * *`); PUT validates 5-part cron and saves via `TenantConfigService`.

**UI** (`web-ui/components/settings/scheduler-settings.tsx`): Card with preset select (5 common intervals + Custom), raw cron input, `cronstrue` human-readable description, and Save button. Renders below `OrganizationSettingsForm` on the Organization settings page.

**Workers** (`workers/src/jobs/scheduler/index.ts` + `pg-service.ts`): When `USE_PG_SCHEDULES=true`, reads all active tenants on startup, fetches each tenant's configured cron, and creates a dedicated pg-boss queue `scheduler-scan-{tenantId}` per tenant. Falls back to single global `scheduler-scan` queue with default cron when `USE_PG_SCHEDULES=false`.

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check: PASSED
