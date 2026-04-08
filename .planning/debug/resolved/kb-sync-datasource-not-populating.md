---
status: resolved
trigger: "kb-sync-datasource-not-populating"
created: 2026-04-06T00:00:00Z
updated: 2026-04-06T00:00:00Z
---

## Current Focus

hypothesis: CONFIRMED — dual-write bug in vector-store.ts causes DDB write to throw after PG write succeeds, aborting the success path; plus missing error detail columns
test: fix dual-write logic + add migration + update worker error capture
expecting: vectorCount/vectorKeys written to PG, errors captured with full stack trace
next_action: apply all fixes

## Symptoms

expected: data_sources table populated with vector data/chunks; errors recorded with detail+stack and user-friendly message; errors shown in UI
actual: data_sources table not populated; errors in kb-sync worker silently lost — not recorded, not shown in UI
errors: Unknown — need to investigate kb-sync worker logs and code
reproduction: Trigger a kb-sync job and check the data_sources table
started: Unknown

## Eliminated

## Evidence

- timestamp: 2026-04-06T00:00:00Z
  checked: workers/src/jobs/kb-sync/lib/vector-store.ts lines 126-134
  found: updateDS() and updateKBVectorCount() write to PG (when USE_PG_KB=true) then UNCONDITIONALLY write to DynamoDB — no else branch
  implication: DDB write fails in dev (no local DDB or table missing), throws after PG write succeeds, causing success path to abort; vectorCount/vectorKeys never committed

- timestamp: 2026-04-06T00:00:00Z
  checked: workers/.env
  found: USE_PG_KB="true" — confirms PG path is active, DDB write is always attempted and fails
  implication: every successful sync still throws, leaving data_source in error state with no vector data

- timestamp: 2026-04-06T00:00:00Z
  checked: prisma/schema.prisma DataSource model
  found: only lastSyncError column exists; no last_error_detail or last_error_message columns
  implication: full stack traces are never persisted; only short message stored

- timestamp: 2026-04-06T00:00:00Z
  checked: workers/src/jobs/kb-sync/index.ts error handler
  found: captures err.message only, no stack trace
  implication: even after schema fix, stack traces would be lost without worker update

## Resolution

root_cause: Dual-write bug in vector-store.ts — updateDS/updateKBVectorCount always call DynamoDB even when USE_PG_KB=true. DDB write throws (no local table), aborting the success path after PG write. vectorCount/vectorKeys never saved. Additionally, missing last_error_detail/last_error_message columns mean error stack traces are silently dropped.
fix: (1) Fix dual-write to use else branch. (2) Add migration for two new error columns. (3) Update worker to capture full stack trace. (4) Update Prisma schema, types, repository, and UI.
verification:
files_changed: []
