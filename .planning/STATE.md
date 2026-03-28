---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: executing
stopped_at: Completed 05-langgraph-migration-validation 05-01-PLAN.md
last_updated: "2026-03-28T08:01:21.562Z"
last_activity: 2026-03-28
progress:
  total_phases: 5
  completed_phases: 4
  total_plans: 28
  completed_plans: 25
  percent: 20
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-26)

**Core value:** Every DynamoDB table migrated to PostgreSQL with full test coverage and verified data migration scripts
**Current focus:** Phase 05 — langgraph-migration-validation

## Current Position

Phase: 05 (langgraph-migration-validation) — EXECUTING
Plan: 2 of 4
Status: Ready to execute
Last activity: 2026-03-28

Progress: [██░░░░░░░░] 20%

## Performance Metrics

**Velocity:**

- Total plans completed: 0
- Average duration: -
- Total execution time: 0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| - | - | - | - |

**Recent Trend:**

- Last 5 plans: none yet
- Trend: -

*Updated after each plan completion*
| Phase 01-foundation-tenant-config P01 | 5 | 2 tasks | 5 files |
| Phase 01-foundation-tenant-config P05 | 525546min | 1 tasks | 1 files |
| Phase 02-accounts-rbac P01 | 6min | 2 tasks | 4 files |
| Phase 02-accounts-rbac P02 | 7 | 2 tasks | 6 files |
| Phase 02-accounts-rbac P04 | 4min | 2 tasks | 4 files |
| Phase 02-accounts-rbac P05 | 8min | 1 tasks | 1 files |
| Phase 03-schedules-executions-audit P01 | 20 | 2 tasks | 2 files |
| Phase 03-schedules-executions-audit P02 | 6min | 1 tasks | 9 files |
| Phase 03-schedules-executions-audit P04 | 2min | 2 tasks | 3 files |
| Phase 03-schedules-executions-audit P05 | 15min | 2 tasks | 1 files |
| Phase 04-kb-inventory-agent-ops P01 | 12min | 2 tasks | 2 files |
| Phase 04-kb-inventory-agent-ops P03 | 9 | 2 tasks | 9 files |
| Phase 04-kb-inventory-agent-ops P02 | 6min | 2 tasks | 12 files |
| Phase 04-kb-inventory-agent-ops P04 | 11min | 2 tasks | 18 files |
| Phase 04-kb-inventory-agent-ops P05 | 8min | 2 tasks | 2 files |
| Phase 04-kb-inventory-agent-ops P06 | 8min | 2 tasks | 3 files |
| Phase 04-kb-inventory-agent-ops P07 | 12 | 2 tasks | 5 files |
| Phase 05-langgraph-migration-validation P01 | 7min | 2 tasks | 5 files |

## Accumulated Context

### Decisions

Decisions logged in PROJECT.md Key Decisions table.
Key decisions affecting Phase 1:

- ORM: Prisma (not Drizzle) — user prefers Prisma DX; accepted Lambda bundle size trade-off (~2-4MB)
- Repository pattern with feature flags — zero-downtime, instant rollback per entity
- Docker Compose for local dev — cloud DB (RDS/Aurora) deferred until migration validated
- [Phase 01-foundation-tenant-config]: Prisma 5 over Prisma 7: v7 removed datasource url from schema files (breaking change), v5 matches plan schema format
- [Phase 01-foundation-tenant-config]: Tenant FK safety: upsert parent tenants row before tenantConfig upsert to satisfy FK constraint; tenantId used as name placeholder
- [Phase 02-accounts-rbac]: No FK relations from Account/UserTenantRole to Tenant: plain tenantId string for zero-downtime migration
- [Phase 02-accounts-rbac]: Role CHECK constraint applied via ALTER TABLE post-migration: Prisma 5 does not emit CHECK constraints natively
- [Phase 02-accounts-rbac]: AccountDynamoRepository preserves GSI1 + client-side filter: maintains identical DynamoDB path behaviour
- [Phase 02-accounts-rbac]: RbacDynamoRepository uses getDynamoDBDocumentClient() singleton instead of per-instance DynamoDBClient
- [Phase 02-accounts-rbac]: Root package.json extended with @aws-sdk/client-dynamodb and @aws-sdk/lib-dynamodb: migration scripts run from project root, these packages were only in web-ui/package.json
- [Phase 02-accounts-rbac]: migrate-rbac.ts uses ScanCommand with EntityType filter (not QueryCommand): UsersTeamsTable has no GSI — full scan is the only option
- [Phase 02-accounts-rbac]: postgres.test.ts created from scratch (not appended): Plan 02-03 was skipped; base tests + cross-tenant isolation tests created together
- [Phase 02-accounts-rbac]: getAccount cross-tenant test uses findFirst (matches actual postgres.ts) not findUnique with compound key as plan template showed
- [Phase 03-schedules-executions-audit]: expiresAt DateTime used for TTL replacement: enables WHERE expiresAt < NOW() queries without epoch conversion; matches Prisma type system
- [Phase 03-schedules-executions-audit]: resources Json on Schedule duplicates TargetedResource data: avoids join in hot scheduler Lambda read path; TargetedResource table serves UI/admin queries
- [Phase 03-schedules-executions-audit]: Manual migrate diff workflow required: prisma migrate dev requires interactive TTY; migrate diff + file creation + migrate deploy used instead
- [Phase 03-schedules-executions-audit]: ScheduleDynamoRepository preserves GSI1 TYPE#SCHEDULE in-memory filter pattern for identical DynamoDB path behaviour
- [Phase 03-schedules-executions-audit]: AuditLogPostgresRepository adds tenantId scoping on getAuditLogs — DynamoDB path has no tenant filter; PostgreSQL enforces multi-tenant safety
- [Phase 03-schedules-executions-audit]: AuditLogPostgresRepository.createAuditLog falls back to org-default tenantId for backward compatibility until Plan 03-03 wires tenantId through service layer
- [Phase 03-schedules-executions-audit]: migrate-schedules.ts migrates both TYPE#SCHEDULE and TYPE#EXECUTION in one script — cohesive same-source-table related entities
- [Phase 03-schedules-executions-audit]: migrate-audit-logs.ts batched createMany(500) with skipDuplicates — efficient for large audit tables, idempotent ON CONFLICT DO NOTHING
- [Phase 03-schedules-executions-audit]: cleanup-expired.ts DRY_RUN=true flag enables safe pre-flight counting before any deletes; replaces DynamoDB automatic TTL
- [Phase 03-schedules-executions-audit]: Used /api/schedules/:id/history endpoint (not /executions) — matched actual route under [scheduleId]/history/route.ts
- [Phase 03-schedules-executions-audit]: Audit API response uses data field (not logs) — confirmed from audit/route.ts returning { success, data: logs, nextPageToken, count }
- [Phase 04-kb-inventory-agent-ops]: InventoryResource uses flat table with JSONB metadata/tags — avoids EAV complexity, enables JSONB operators for filtering
- [Phase 04-kb-inventory-agent-ops]: AgentOpsEvent FK references composite (tenantId, runId) on AgentOpsRun — tenant-safe cascade delete without cross-tenant leakage
- [Phase 04-kb-inventory-agent-ops]: ScheduledTaskLock has no tenantId — lock is per-task execution slot; taskId already encodes tenant scope
- [Phase 04-kb-inventory-agent-ops]: InventoryDynamoRepository uses GSI1/GSI2/GSI3 query patterns from existing inventory table schema
- [Phase 04-kb-inventory-agent-ops]: pg_writer.py uses camelCase column names matching Prisma schema without @map
- [Phase 04-kb-inventory-agent-ops]: Dual-write is non-blocking: PostgreSQL failures caught and logged, DynamoDB remains primary
- [Phase 04-kb-inventory-agent-ops]: DataSourceDynamoRepository ignores tenantId param — DynamoDB KB# PK already scopes to KB; tenantId accepted for interface compatibility
- [Phase 04-kb-inventory-agent-ops]: USE_PG_KB flag controls both KnowledgeBase and DataSource repos — they're a unit to avoid inconsistent state
- [Phase 04-kb-inventory-agent-ops]: AgentOpsRunPostgresRepository.findAwaitingApprovalRun uses single WHERE query instead of scanning 3 sources x 100 records (AOPS-06)
- [Phase 04-kb-inventory-agent-ops]: ScheduledTaskPostgresRepository.tryAcquireExecutionLock uses ON CONFLICT (taskId, scheduledAt) DO NOTHING for atomic lock acquisition (AOPS-04)
- [Phase 04-kb-inventory-agent-ops]: migrate-agent-ops.ts uses full table scan — AgentOpsTable has no GSI covering all item types
- [Phase 04-kb-inventory-agent-ops]: E2E tests check for spinner disappearance before content assertions — avoids flaky races with async data fetching
- [Phase 04-kb-inventory-agent-ops]: agent-ops-service.ts getRunEvents passes tenantId='default' for backward compat — DynamoDB event PK is RUN#<runId> with no tenant scope
- [Phase 04-kb-inventory-agent-ops]: inventory route drops account name enrichment (BatchGetItem) — no DynamoDB imports allowed; enrichment deferred to IInventoryRepository interface
- [Phase 04-kb-inventory-agent-ops]: InventoryVectorKey has no tenantId — accountId is the natural unique key for vector key tracking
- [Phase 04-kb-inventory-agent-ops]: Lambda PrismaClient uses lazy singleton pattern to avoid cold-start connection overhead
- [Phase 05-langgraph-migration-validation]: pgvector/pgvector:pg16 replaces postgres:16-alpine — same PG16 base, adds vector extension support
- [Phase 05-langgraph-migration-validation]: AgentMemory uses Unsupported('vector(1024)') — Prisma 5 has no native pgvector type; raw SQL required for similarity queries
- [Phase 05-langgraph-migration-validation]: AgentConversationsTable confirmed dead code via grep audit (zero app code refs) before CDK removal

### Pending Todos

None yet.

### Blockers/Concerns

- Lambda bundle size: Prisma engine is ~2-4MB. Monitor cold start impact once Lambda phases begin (Phase 3+).
- AgentConversationsTable: Usage unverified — must confirm dead code or live usage before Phase 5.

## Session Continuity

Last session: 2026-03-28T08:01:21.558Z
Stopped at: Completed 05-langgraph-migration-validation 05-01-PLAN.md
Resume file: None
