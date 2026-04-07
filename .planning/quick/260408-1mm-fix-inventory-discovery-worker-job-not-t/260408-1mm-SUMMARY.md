---
phase: quick
plan: 260408-1mm
status: completed
---

# Quick Task 260408-1mm: Fix inventory discovery worker reliability

## What changed

### `workers/src/jobs/discovery/index.ts`
- Migrated `discovery-scan` queue from `standard` to `stately` policy — only 1 job per tenant per state (created OR active), preventing duplicate pileup
- Auto-detects old `standard` policy on startup, deletes and recreates with `stately`
- Fan-out handler checks `boss.send()` return value — logs warning when `null` (deduped by stately policy)
- Removed `expireInHours: 2` from send options — queue-level 30-min expiry governs singletonKey release
- Moved `saveSyncStatus()` after status computation, passing actual scan outcome

### `workers/src/jobs/discovery/services/pg-writer.ts`
- `saveSyncStatus()` now accepts and writes a `status` parameter to the DB column
- Previously omitted the column, always defaulting to `"completed"` even on failure

### `web-ui/app/api/inventory/sync/route.ts`
- Removed per-send `expireInMinutes: 30` override — uses queue-level expiry

### `web-ui/app/api/discovery/execute/route.ts`
- Removed per-send `expireInHours: 2` override — uses queue-level expiry
- Added null-check on `boss.send()` return — returns 409 when scan already queued/active

## Root cause

The `discovery-scan` queue had `policy: 'standard'` — `singletonKey` on `send()` does NOT deduplicate with standard policy. Every 5-min fan-out created 3 new jobs that all got queued. DB evidence: 6 active jobs (all same tenant), 28 created jobs piling up, none completing because the worker was saturated.

## Verification

TypeScript compiles clean in both `workers/` and `web-ui/` — zero errors
