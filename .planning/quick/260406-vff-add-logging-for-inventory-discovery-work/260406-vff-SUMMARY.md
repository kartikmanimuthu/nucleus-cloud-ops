---
quick_id: 260406-vff
status: completed
date: 2026-04-06
---

# Quick Task 260406-vff: Add Logging for Inventory Discovery Worker

## What Was Done

Updated `workers/src/jobs/discovery/index.ts` to use consistent structured logging matching the scheduler worker pattern.

## Changes

**File:** `workers/src/jobs/discovery/index.ts` (+16 / -7)

| Location | Before | After |
|----------|--------|-------|
| Fan-out trigger | Template string, no context object | `{ jobId }` structured context |
| Fan-out complete | Template string with count | `{ tenantCount }` structured context |
| Scan start | Had context but missing `jobId` | Added `jobId` to context |
| Per-account start | Missing | Added `[discovery] Scanning account` with `{ tenantId, accountId, regions }` |
| Per-account success | Missing | Added `[discovery] Account scan complete` with `{ tenantId, accountId, resourceCount, hasErrors }` |
| Per-account error | Template string | `{ tenantId, accountId, error }` structured context |
| Scan completion | Missing `errorCount` | Added `errorCount: errors.length` to context |
| Registration | Plain string | `{ queues, cron }` structured context |

## Verification

- TypeScript compiles (3 pre-existing errors unrelated to this change)
- No business logic modified — only `console.log`/`console.error` calls updated
- All log lines follow `console.log('[discovery] message', { key: value })` pattern
