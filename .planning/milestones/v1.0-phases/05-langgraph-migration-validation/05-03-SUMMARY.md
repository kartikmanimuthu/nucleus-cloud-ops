---
phase: 05-langgraph-migration-validation
plan: 03
subsystem: database
tags: [migration, dynamodb, postgresql, prisma, typescript, orchestration, verification]

requires:
  - phase: 05-01
    provides: pgvector schema, AgentMemory model, checkpoint-postgres migration

provides:
  - migrate-all.ts: one-command orchestration of all 8 migration scripts in dependency order
  - verify-migration.ts: CI-ready row count comparison between DynamoDB and PostgreSQL

affects: [05-04, ops-runbooks, ci-pipeline]

tech-stack:
  added: []
  patterns:
    - "stop-on-first-error with --from resume flag for safe incremental migration"
    - "spawnSync child process orchestration with stdio: inherit for live output"
    - "GSI1 query COUNT vs full scan COUNT strategy per DynamoDB table structure"
    - "Prisma.$queryRaw with Prisma.raw for dynamic table name in count queries"

key-files:
  created:
    - scripts/migrate-all.ts
    - scripts/verify-migration.ts
  modified: []

key-decisions:
  - "spawnSync with stdio: inherit chosen over execSync — live child output visible to operator"
  - "GSI1 query COUNT for APP_TABLE entities (accurate per-type), full scan COUNT for dedicated tables (AUDIT, AGENT_OPS)"
  - "verify-migration.ts exits non-zero on both count mismatch AND connectivity errors — CI-safe"
  - "AgentConversationsTable noted as dead code removed (D-23); chat history + memory noted as fresh start (D-08/D-09)"

patterns-established:
  - "Orchestration pattern: MIGRATION_ORDER array + spawnSync loop with --from slice for resume"
  - "Verification pattern: parallel DynamoDB + PostgreSQL count fetch per entity, formatted table output"

requirements-completed: [MIGR-03, MIGR-04, LANG-05, LANG-08]

duration: 5min
completed: 2026-03-28
---

# Phase 05 Plan 03: Migration Orchestration + Verification Summary

**migrate-all.ts orchestrates 8 scripts in dependency order with --from resume and --dry-run passthrough; verify-migration.ts compares DynamoDB vs PostgreSQL row counts per entity and exits non-zero on mismatch**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-28T08:01:21Z
- **Completed:** 2026-03-28T08:06:18Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- migrate-all.ts runs all 8 migration scripts in dependency order (tenant-configs → accounts → rbac → schedules → audit-logs → kb → inventory → agent-ops)
- Stop-on-first-error with printed resume command (`--from <script-name>`) and `--dry-run` passthrough
- verify-migration.ts counts 13 entity types across DynamoDB and PostgreSQL, renders formatted table with Match/Delta columns, exits non-zero on any mismatch
- Documents fresh start decision for chat history + memory tables (LANG-08 / D-08/D-09)

## Task Commits

1. **Task 1: Create migrate-all.ts orchestration script** - `0b6736d` (feat)
2. **Task 2: Create verify-migration.ts row count comparison script** - `cbec8bb` (feat)

## Files Created/Modified

- `scripts/migrate-all.ts` — Orchestrates 8 migration scripts via spawnSync, --from resume, --dry-run passthrough, fresh start note
- `scripts/verify-migration.ts` — DynamoDB vs PostgreSQL row count comparison for 13 entity types, formatted table output, non-zero exit on mismatch

## Decisions Made

- spawnSync with `stdio: 'inherit'` chosen so child script output streams live to the operator's terminal
- GSI1 query COUNT used for APP_TABLE entities (accurate per entity type); full scan COUNT used for dedicated tables (AUDIT_TABLE, AGENT_OPS_TABLE)
- verify-migration.ts exits non-zero on connectivity errors as well as count mismatches — CI pipelines should not silently pass on unreachable databases

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- All migration scripts can now be run with a single command: `npx tsx scripts/migrate-all.ts`
- Post-migration validation ready: `npx tsx scripts/verify-migration.ts`
- Phase 05-04 (final validation + cutover runbook) can proceed

---
*Phase: 05-langgraph-migration-validation*
*Completed: 2026-03-28*
