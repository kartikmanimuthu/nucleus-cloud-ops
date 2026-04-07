---
phase: quick
plan: 260408-1mm
status: completed
---

# Quick Task 260408-1mm: Fix inventory discovery worker reliability

## What changed

### `workers/src/jobs/discovery/index.ts`
- Fan-out handler now checks `boss.send()` return value — logs a warning when `null` (job silently dropped due to singletonKey)
- Removed `expireInHours: 2` from send options — queue-level `expireInSeconds: 1800` (30 min) governs singletonKey release instead of 2 hours
- Moved `saveSyncStatus()` call to after status computation, passing the actual scan outcome

### `workers/src/jobs/discovery/services/pg-writer.ts`
- `saveSyncStatus()` now accepts a `status` parameter and writes it to the DB `status` column
- Previously omitted the column, always defaulting to `"completed"` even on failure

## Root cause

The jobs were triggering and executing correctly. Three reliability issues caused the appearance of failure:
1. `singletonKey` silently dropped duplicate jobs with no log signal
2. `expireInHours: 2` on send options overrode the queue's 30-min expiry, blocking new jobs for 2 hours after a stuck scan
3. `saveSyncStatus` never wrote the actual status, so the UI always showed "completed"

## Verification

TypeScript compiles clean: `npx tsc --noEmit` — zero errors
