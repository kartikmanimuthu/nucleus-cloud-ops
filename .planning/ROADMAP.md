# Roadmap: DynamoDB to PostgreSQL Migration

## Overview

Five phases migrate all 10 DynamoDB tables to PostgreSQL using Prisma ORM and the repository pattern. Each phase delivers a complete, runnable slice of the system — foundation first, then entities in FK-dependency order (tenants before accounts before schedules), then independent feature tables (KB, Inventory, Agent Ops), then LangGraph persistence last. Feature flags per entity enable instant rollback at any point. TDD unit tests precede each repository implementation; Playwright E2E tests follow each phase.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Foundation + Tenant Config** - Docker Compose, Prisma, connection pooling, repository factory, and first migrated entity (tenant configs)
- [ ] **Phase 2: Accounts + RBAC** - Accounts and role-based access control with server-side filtering, cross-tenant isolation
- [ ] **Phase 3: Schedules + Executions + Audit** - Full scheduling system with scheduler Lambda, dual-write mode, TTL cleanup
- [ ] **Phase 4: KB + Inventory + Agent Ops** - Knowledge base, Python discovery Lambda (psycopg2), vector keys, and full Dynamoose rewrite for agent ops
- [ ] **Phase 5: LangGraph + Migration Validation** - LangGraph checkpoint/history/memory migration, migration orchestration scripts, and final count verification

## Phase Details

### Phase 1: Foundation + Tenant Config
**Goal**: The PostgreSQL infrastructure exists and the first entity (tenant config) is verifiably running on it
**Depends on**: Nothing (first phase)
**Requirements**: FOUND-01, FOUND-02, FOUND-03, FOUND-04, FOUND-05, FOUND-06, TCFG-01, TCFG-02, TCFG-03, TCFG-04, TCFG-05, TCFG-06, TCFG-07, TCFG-08, MIGR-01, MIGR-02, MIGR-06
**Success Criteria** (what must be TRUE):
  1. `docker compose up` starts PostgreSQL 16 and `npm run db:migrate` applies the schema without error
  2. Running with `USE_PG_TENANT_CONFIG=true`, tenant config reads and writes go to PostgreSQL; with flag off, DynamoDB is used — no code change required to switch
  3. All existing Vitest tests pass with the PostgreSQL flag enabled
  4. The tenant config data migration script runs idempotently and produces a "Migrated X/Y records..." progress log
**Plans**: 5 plans

Plans:
- [x] 01-01-PLAN.md — Docker Compose + Prisma schema (tenants + tenant_configs) + .env.local.example
- [ ] 01-02-PLAN.md — PostgreSQL connection singleton (pg-config.ts) + repository factory
- [ ] 01-03-PLAN.md — ITenantConfigRepository interface + DynamoDB repo + PostgreSQL repo
- [ ] 01-04-PLAN.md — Service wiring (tenant-config-service.ts delegation) + TDD unit tests
- [x] 01-05-PLAN.md — Data migration script (DynamoDB → PostgreSQL, idempotent)

### Phase 2: Accounts + RBAC
**Goal**: Account listing, filtering, and role assignment run entirely on PostgreSQL with verified cross-tenant isolation
**Depends on**: Phase 1
**Requirements**: ACCT-01, ACCT-02, ACCT-03, ACCT-04, ACCT-05, ACCT-06, ACCT-07, ACCT-08, ACCT-09, ACCT-10
**Success Criteria** (what must be TRUE):
  1. Account list page filters by name, status, and region without fetching all records first (server-side WHERE/ILIKE)
  2. A user assigned a role in tenant A cannot see tenant B accounts — confirmed by cross-tenant isolation test
  3. Playwright E2E tests for account listing, filtering, and creation pass against the PostgreSQL backend
  4. Data migration script moves all accounts and RBAC records from DynamoDB; verify-migration shows matching row counts
**Plans**: 5 plans

Plans:
- [x] 02-01-PLAN.md — Prisma Account and UserTenantRole models + migration
- [x] 02-02-PLAN.md — Account and UserTenantRole repository implementations (TDD)
- [ ] 02-03-PLAN.md — Account service wiring + RBAC integration
- [x] 02-04-PLAN.md — Account data migration script (DynamoDB → PostgreSQL)
- [x] 02-05-PLAN.md — Playwright E2E tests for accounts with PostgreSQL backend

**UI hint**: yes

### Phase 3: Schedules + Executions + Audit
**Goal**: The full scheduling system — web UI, scheduler Lambda, and audit logs — runs on PostgreSQL with dual-write validation capability
**Depends on**: Phase 2
**Requirements**: SCHED-01, SCHED-02, SCHED-03, SCHED-04, SCHED-05, SCHED-06, SCHED-07, SCHED-08, SCHED-09, SCHED-10, SCHED-11, SCHED-12, SCHED-13, MIGR-05
**Success Criteria** (what must be TRUE):
  1. Schedule CRUD, execution history, and audit log viewing work end-to-end in the Playwright E2E suite
  2. The scheduler Lambda reads and writes schedules from PostgreSQL using a max-3 connection pool without exhaustion errors
  3. Dual-write mode can be enabled to write to both DynamoDB and PostgreSQL simultaneously; reads come from PostgreSQL
  4. The TTL cleanup script deletes expired audit_logs and schedule_executions and runs idempotently
  5. Audit log migration handles the full dataset in batched inserts of 500 records with progress logging
**Plans**: 5 plans

Plans:
- [x] 03-01-PLAN.md — Prisma Schedule, ScheduleExecution, TargetedResource, AuditLog models + migration
- [x] 03-02-PLAN.md — Schedule, ScheduleExecution, AuditLog repository implementations (interface + DynamoDB + PostgreSQL)
- [x] 03-03-PLAN.md — Service wiring + Lambda pg-service (max-3 pool) + dual-write + 6 Vitest test files
- [x] 03-04-PLAN.md — Data migration scripts (migrate-schedules, migrate-audit-logs batched 500) + cleanup-expired TTL script
- [x] 03-05-PLAN.md — Playwright E2E tests for schedule CRUD, execution history, audit logs + human checkpoint

**UI hint**: yes

### Phase 4: KB + Inventory + Agent Ops
**Goal**: Knowledge base management, inventory AI search, and the full agent ops system run on PostgreSQL — including the Python discovery Lambda and the Dynamoose rewrite
**Depends on**: Phase 2
**Requirements**: KB-01, KB-02, KB-03, KB-04, KB-05, KB-06, KB-07, KB-08, KB-09, AOPS-01, AOPS-02, AOPS-03, AOPS-04, AOPS-05, AOPS-06, AOPS-07, AOPS-08, AOPS-09
**Success Criteria** (what must be TRUE):
  1. The Python discovery Lambda writes discovered AWS resources to PostgreSQL via psycopg2; the inventory page shows results from PostgreSQL
  2. Ask AI (inventory vector search) returns results after the vector_processor Lambda stores keys in PostgreSQL
  3. Agent ops dashboard, run listing, and scheduled tasks all work via PostgreSQL — no Dynamoose calls remain in agent-ops API routes
  4. Scheduled task lock acquisition uses ON CONFLICT (not scan-and-compare), confirmed by concurrent lock attempt test
  5. All ~15 agent-ops API routes return correct responses with `USE_PG_AGENT_OPS=true`
**Plans**: 5 plans

Plans:
- [x] 04-01-PLAN.md — Prisma schema (KnowledgeBase, DataSource, InventoryResource, AgentOpsRun, AgentOpsEvent, ScheduledTask, ScheduledTaskLock) + migration
- [ ] 04-02-PLAN.md — KB + DataSource repository implementations (interface + DynamoDB + PostgreSQL) + factory wiring + TDD tests
- [ ] 04-03-PLAN.md — Inventory repository + Python discovery Lambda psycopg2 writer + data_processor dual-write
- [ ] 04-04-PLAN.md — Agent ops repositories (AgentOpsRun, AgentOpsEvent, ScheduledTask with ON CONFLICT lock) + data migration scripts
- [ ] 04-05-PLAN.md — Playwright E2E tests for KB management, agent ops dashboard, scheduled tasks + human checkpoint

**UI hint**: yes

### Phase 5: LangGraph + Migration Validation
**Goal**: All agent persistence (checkpoints, writes, chat history, memory) runs on PostgreSQL, and the complete migration is verified with matching row counts across all tables
**Depends on**: Phase 3
**Requirements**: LANG-01, LANG-02, LANG-03, LANG-04, LANG-05, LANG-06, LANG-07, LANG-08, MIGR-03, MIGR-04
**Success Criteria** (what must be TRUE):
  1. Agent chat conversations persist across browser refreshes — thread history and memory recall work end-to-end on PostgreSQL
  2. `migrate-all.ts` runs scripts in dependency order (tenants -> accounts -> schedules -> KB -> agent ops -> LangGraph) without error
  3. `verify-migration.ts` reports matching row counts between DynamoDB and PostgreSQL for every migrated table
  4. AgentConversationsTable usage is confirmed or ruled out; if dead code, CDK definition is flagged for removal
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5
Note: Phase 4 depends on Phase 2 (not Phase 3) — can begin Phase 4 in parallel with Phase 3 if needed.

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation + Tenant Config | 2/5 | In Progress|  |
| 2. Accounts + RBAC | 4/5 | In Progress|  |
| 3. Schedules + Executions + Audit | 4/5 | In Progress|  |
| 4. KB + Inventory + Agent Ops | 1/5 | In Progress|  |
| 5. LangGraph + Migration Validation | 0/TBD | Not started | - |
