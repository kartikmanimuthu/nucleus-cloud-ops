---
phase: quick
plan: 260406-vff
type: execute
wave: 1
depends_on: []
files_modified:
  - workers/src/jobs/discovery/index.ts
autonomous: true
requirements: [QUICK-260406-VFF]
must_haves:
  truths:
    - "Every discovery log line uses [discovery] prefix with structured context object"
    - "Per-account start and success logs exist in the scan loop"
    - "Fan-out handler logs tenant count in structured context"
  artifacts:
    - path: "workers/src/jobs/discovery/index.ts"
      provides: "Consistent structured logging matching scheduler pattern"
      contains: "console.log"
  key_links: []
---

<objective>
Add structured logging to the discovery worker matching the scheduler worker pattern.

Purpose: Discovery worker logs are inconsistent — some lines lack structured context objects, per-account start/success logs are missing. Aligning with the scheduler pattern makes log aggregation and debugging uniform across all workers.
Output: Updated discovery/index.ts with consistent `[discovery]` prefixed logs and structured context objects.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@workers/src/jobs/scheduler/index.ts (reference pattern)
@workers/src/jobs/discovery/index.ts (target file)
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add structured logging to discovery worker</name>
  <files>workers/src/jobs/discovery/index.ts</files>
  <action>
Update all console.log/console.error calls in workers/src/jobs/discovery/index.ts to match the scheduler pattern from workers/src/jobs/scheduler/index.ts. Specific changes:

1. Fan-out handler (line ~38): Add structured context to the trigger log:
   `console.log('[discovery] Fan-out triggered', { jobId: job.id })`
   Update completion log to include structured context:
   `console.log('[discovery] Fan-out complete', { tenantCount: tenants.length })`

2. Scan handler — job start (line ~67): Already has structured context — keep as-is but ensure consistency.

3. Per-account loop (inside `for (const account of targetAccounts)`):
   - Add start log before assumeRole:
     `console.log('[discovery] Scanning account', { tenantId, accountId: account.accountId, regions: account.regions })`
   - Add success log after accountsSynced++ (after updateAccountSyncStatus):
     `console.log('[discovery] Account scan complete', { tenantId, accountId: account.accountId, resourceCount: result.resources.length, hasErrors: (result.errors?.length ?? 0) > 0 })`
   - Update existing error log (line ~110) to include tenantId in structured context:
     `console.error('[discovery] Account scan failed', { tenantId, accountId: account.accountId, error: msg })`

4. Registration log (line ~140): Add queue count context:
   `console.log('[discovery] Registered queues', { queues: ['discovery-fan-out', 'discovery-scan'], cron: '0 2 * * *' })`

Do NOT touch any service imports, business logic, audit logging, or pg-boss configuration. Only modify console.log/console.error calls.
  </action>
  <verify>
    <automated>cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/pg-boss-migration && npx tsc --noEmit --project workers/tsconfig.json 2>&1 | head -20</automated>
  </verify>
  <done>All console.log/console.error calls in discovery/index.ts use [discovery] prefix with structured context objects. Per-account start and success logs exist. No business logic changed.</done>
</task>

</tasks>

<verification>
- Every console.log in discovery/index.ts has a structured context object as second argument
- Per-account loop has start, success, and error log lines
- Fan-out handler logs tenant count
- No changes to imports, business logic, or pg-boss config
</verification>

<success_criteria>
TypeScript compiles without errors. All log lines in discovery/index.ts follow the `console.log('[discovery] message', { key: value })` pattern matching the scheduler worker.
</success_criteria>

<output>
After completion, create `.planning/quick/260406-vff-add-logging-for-inventory-discovery-work/260406-vff-SUMMARY.md`
</output>
