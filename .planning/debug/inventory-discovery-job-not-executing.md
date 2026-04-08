---
status: investigating
trigger: "inventory discovery job not executing — POST /api/inventory/sync returns 200 with jobId but worker never picks it up"
created: 2026-04-06T00:00:00Z
updated: 2026-04-06T00:00:00Z
---

## Current Focus

hypothesis: Job name mismatch between API producer and worker consumer
test: Compare job name in web-ui/app/api/inventory/sync route vs workers/src/jobs/discovery registration
expecting: Different queue/job names = silent miss (pg-boss drops jobs no worker is listening to)
next_action: Read discovery worker entry point and sync API route

## Symptoms

expected: POST /api/inventory/sync enqueues pg-boss job → worker picks it up → scans AWS → populates inventory_resources + inventory_sync_status
actual: API returns 200 with jobId '92c1d7c1-4921-4a77-b714-fa1d0a28b84d', both tables remain empty, worker logs only show scheduler activity
errors: No explicit errors — silent failure
reproduction: POST /api/inventory/sync from UI
started: Unknown — may never have worked after pg-boss migration

## Eliminated

(none yet)

## Evidence

(none yet)

## Resolution

root_cause:
fix:
verification:
files_changed: []
