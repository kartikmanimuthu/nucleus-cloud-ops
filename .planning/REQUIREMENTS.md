# Requirements: DynamoDB to PostgreSQL Migration

**Defined:** 2026-03-26
**Core Value:** Every DynamoDB table migrated to PostgreSQL with full test coverage and verified data migration scripts

## v1 Requirements

### Foundation

- [ ] **FOUND-01**: Docker Compose starts PostgreSQL 16 locally with health check and persistent volume
- [ ] **FOUND-02**: Prisma ORM configured with schema file, migration directory, and TypeScript client generation
- [ ] **FOUND-03**: PostgreSQL connection singleton (pg-config.ts) with pool sizes: max 10 for ECS, max 3 for Lambda
- [ ] **FOUND-04**: Repository factory reads `USE_PG_<ENTITY>` env vars and returns correct implementation
- [ ] **FOUND-05**: npm scripts added: db:start, db:stop, db:generate, db:migrate, db:studio
- [ ] **FOUND-06**: .env.local.example updated with DATABASE_URL and all USE_PG_* flags

### Tenant Config Migration

- [ ] **TCFG-01**: Prisma schema defines tenants and tenant_configs tables with correct types and constraints
- [ ] **TCFG-02**: Repository interface defined with getConfig, saveConfig, deleteConfig, listConfigs
- [ ] **TCFG-03**: DynamoDB repository implementation extracted from existing tenant-config-service.ts
- [ ] **TCFG-04**: PostgreSQL repository implementation using Prisma client
- [ ] **TCFG-05**: tenant-config-service.ts delegates to repository factory (no direct DynamoDB calls)
- [ ] **TCFG-06**: TDD unit tests pass for both DynamoDB and PostgreSQL repository implementations
- [ ] **TCFG-07**: Data migration script seeds tenant configs from DynamoDB (AWS_PROFILE=PLATFORM-ADMIN)
- [ ] **TCFG-08**: Existing Vitest tests continue passing with USE_PG_TENANT_CONFIG=true

### Accounts + RBAC Migration

- [ ] **ACCT-01**: Prisma schema defines accounts table with indexes on tenant_id and active
- [ ] **ACCT-02**: Prisma schema defines user_tenant_roles table with role CHECK constraint
- [ ] **ACCT-03**: Account repository replaces client-side filtering with PostgreSQL WHERE/ILIKE/LIMIT/OFFSET
- [ ] **ACCT-04**: RBAC repository handles getUserTenantRole, getUserAllRoles, assignUserRole, getTenantUsers
- [ ] **ACCT-05**: account-service.ts delegates to repository (scanResources/validateCredentials unchanged)
- [ ] **ACCT-06**: role-service.ts delegates to repository
- [ ] **ACCT-07**: TDD unit tests for account + RBAC repositories (both backends)
- [ ] **ACCT-08**: Data migration scripts for accounts (GSI1 TYPE#ACCOUNT) and RBAC (UsersTeamsTable)
- [ ] **ACCT-09**: Playwright E2E tests verify account listing, filtering, creation after migration
- [ ] **ACCT-10**: Cross-tenant isolation test confirms no data leakage between tenants

### Schedules + Executions + Audit Migration

- [ ] **SCHED-01**: Prisma schema defines schedules, schedule_executions, audit_logs tables with indexes
- [ ] **SCHED-02**: Schedule repository replaces GSI1 query + client filter with server-side WHERE/ORDER BY
- [ ] **SCHED-03**: Execution repository handles create, update, getHistory, getRecentExecutions
- [ ] **SCHED-04**: Audit repository handles createAuditLog (fire-and-forget) and getAuditLogs with server-side filtering
- [ ] **SCHED-05**: Scheduler Lambda has pg-service.ts alongside dynamodb-service.ts, switchable via feature flag
- [ ] **SCHED-06**: Scheduler Lambda connection pool: max 3, idleTimeoutMillis 10000
- [ ] **SCHED-07**: schedule-service.ts, schedule-execution-service.ts, audit-service.ts delegate to repositories
- [ ] **SCHED-08**: TDD unit tests for schedule, execution, audit repositories (both backends)
- [ ] **SCHED-09**: Data migration scripts for schedules (TYPE#SCHEDULE), executions (TYPE#EXECUTION), audit logs (TYPE#LOG)
- [ ] **SCHED-10**: Audit log migration handles large dataset with batched inserts (chunks of 500)
- [ ] **SCHED-11**: TTL cleanup script deletes expired audit_logs and schedule_executions
- [ ] **SCHED-12**: Playwright E2E tests verify schedule CRUD, execution history, audit log viewing
- [ ] **SCHED-13**: Dual-write mode available for validation period (write to both backends, read from PG)

### Knowledge Base + Inventory + Vector Migration

- [ ] **KB-01**: Prisma schema defines knowledge_bases, data_sources, inventory_vector_keys tables
- [ ] **KB-02**: Knowledge base repository handles CRUD + atomic counter updates (vector_count, data_source_count)
- [ ] **KB-03**: kb_sync_processor Lambda uses repository for data source updates
- [ ] **KB-04**: vector_processor Lambda uses repository for vector key storage and audit logging
- [ ] **KB-05**: Inventory table Prisma schema defined for discovered AWS resources
- [ ] **KB-06**: Discovery Lambda (Python) uses psycopg2 to write to PostgreSQL inventory table
- [ ] **KB-07**: TDD unit tests for KB, inventory, vector key repositories
- [ ] **KB-08**: Data migration scripts for knowledge bases, data sources, vector keys, inventory
- [ ] **KB-09**: Playwright E2E tests verify KB management and Ask AI functionality

### Agent Ops Migration (Dynamoose Rewrite)

- [ ] **AOPS-01**: Prisma schema defines agent_ops_runs, agent_ops_events, scheduled_tasks, scheduled_task_locks
- [ ] **AOPS-02**: Agent ops run repository replaces all Dynamoose Model.create/get/query/update calls
- [ ] **AOPS-03**: Agent ops event repository handles chronological event recording and retrieval
- [ ] **AOPS-04**: Scheduled task repository handles CRUD + execution locking (ON CONFLICT for lock acquisition)
- [ ] **AOPS-05**: All ~15 agent-ops API routes work with PostgreSQL backend
- [ ] **AOPS-06**: findAwaitingApprovalRun queries use PostgreSQL WHERE instead of scanning 50+ records per source
- [ ] **AOPS-07**: TDD unit tests for all agent ops repositories (both backends)
- [ ] **AOPS-08**: Data migration script for agent ops (RUN#, EVENT#, SCHED# items from AgentOpsTable)
- [ ] **AOPS-09**: Playwright E2E tests verify agent ops dashboard, run listing, scheduled tasks

### LangGraph Persistence Migration

- [ ] **LANG-01**: @langchain/langgraph-checkpoint-postgres replaces @farukada/aws-langgraph-dynamodb-ts for checkpoints and writes
- [ ] **LANG-02**: PostgreSQL-backed chat message history replaces DynamoDBChatMessageHistory
- [ ] **LANG-03**: PostgreSQL-backed memory store replaces DynamoDBStore (with Bedrock embeddings)
- [ ] **LANG-04**: persistence.ts updated to use PostgreSQL persistence with same public API
- [ ] **LANG-05**: Agent conversations table verified for usage; migrated if used, CDK definition dropped if dead code
- [ ] **LANG-06**: TDD unit tests for chat history and memory store PostgreSQL implementations
- [ ] **LANG-07**: Playwright E2E tests verify agent chat, thread history, memory recall
- [ ] **LANG-08**: Data migration script for chat history and memory (or fresh start if ephemeral data is acceptable)

### Data Migration Infrastructure

- [ ] **MIGR-01**: Each migration script uses AWS_PROFILE=PLATFORM-ADMIN for DynamoDB access
- [ ] **MIGR-02**: All scripts are idempotent (ON CONFLICT DO UPDATE) for safe re-runs
- [ ] **MIGR-03**: migrate-all.ts runs scripts in dependency order (tenants → accounts → schedules → ...)
- [ ] **MIGR-04**: verify-migration.ts compares row counts between DynamoDB and PostgreSQL per table
- [ ] **MIGR-05**: cleanup-expired.ts handles TTL replacement for all tables with expires_at
- [ ] **MIGR-06**: Progress logging shows "Migrated X/Y records..." during execution

## v2 Requirements

### Production Infrastructure
- **PROD-01**: RDS PostgreSQL or Aurora Serverless v2 CDK stack
- **PROD-02**: RDS Proxy for Lambda connection pooling in production
- **PROD-03**: Remove DynamoDB table definitions from CDK after full cutover validation
- **PROD-04**: pg_cron or EventBridge Lambda for TTL cleanup in production
- **PROD-05**: CloudWatch alarms for PostgreSQL connection pool saturation

### Performance
- **PERF-01**: Keyset pagination for large datasets (audit logs, agent events)
- **PERF-02**: Read replicas for heavy read queries (inventory, audit)
- **PERF-03**: Connection pool monitoring dashboard

## Out of Scope

| Feature | Reason |
|---------|--------|
| Cloud PostgreSQL provisioning (RDS/Aurora) | Deferred — start with Docker locally, decide cloud DB later |
| DynamoDB table removal from CDK | Tables stay as rollback path until full cutover validated |
| Rewriting discovery Lambda to TypeScript | Keep Python, add psycopg2 — avoid risky rewrite |
| DynamoDB-to-PostgreSQL real-time sync/CDC | One-time migration scripts sufficient |
| Performance benchmarking DynamoDB vs PG | Migration correctness is priority |
| Schema redesign beyond migration needs | Match existing data model, improve queries only |
| Multi-region PostgreSQL | Not needed at current scale |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| FOUND-01 | Phase 1 | Pending |
| FOUND-02 | Phase 1 | Pending |
| FOUND-03 | Phase 1 | Pending |
| FOUND-04 | Phase 1 | Pending |
| FOUND-05 | Phase 1 | Pending |
| FOUND-06 | Phase 1 | Pending |
| TCFG-01 | Phase 1 | Pending |
| TCFG-02 | Phase 1 | Pending |
| TCFG-03 | Phase 1 | Pending |
| TCFG-04 | Phase 1 | Pending |
| TCFG-05 | Phase 1 | Pending |
| TCFG-06 | Phase 1 | Pending |
| TCFG-07 | Phase 1 | Pending |
| TCFG-08 | Phase 1 | Pending |
| ACCT-01 | Phase 2 | Pending |
| ACCT-02 | Phase 2 | Pending |
| ACCT-03 | Phase 2 | Pending |
| ACCT-04 | Phase 2 | Pending |
| ACCT-05 | Phase 2 | Pending |
| ACCT-06 | Phase 2 | Pending |
| ACCT-07 | Phase 2 | Pending |
| ACCT-08 | Phase 2 | Pending |
| ACCT-09 | Phase 2 | Pending |
| ACCT-10 | Phase 2 | Pending |
| SCHED-01 | Phase 3 | Pending |
| SCHED-02 | Phase 3 | Pending |
| SCHED-03 | Phase 3 | Pending |
| SCHED-04 | Phase 3 | Pending |
| SCHED-05 | Phase 3 | Pending |
| SCHED-06 | Phase 3 | Pending |
| SCHED-07 | Phase 3 | Pending |
| SCHED-08 | Phase 3 | Pending |
| SCHED-09 | Phase 3 | Pending |
| SCHED-10 | Phase 3 | Pending |
| SCHED-11 | Phase 3 | Pending |
| SCHED-12 | Phase 3 | Pending |
| SCHED-13 | Phase 3 | Pending |
| KB-01 | Phase 4 | Pending |
| KB-02 | Phase 4 | Pending |
| KB-03 | Phase 4 | Pending |
| KB-04 | Phase 4 | Pending |
| KB-05 | Phase 4 | Pending |
| KB-06 | Phase 4 | Pending |
| KB-07 | Phase 4 | Pending |
| KB-08 | Phase 4 | Pending |
| KB-09 | Phase 4 | Pending |
| AOPS-01 | Phase 4 | Pending |
| AOPS-02 | Phase 4 | Pending |
| AOPS-03 | Phase 4 | Pending |
| AOPS-04 | Phase 4 | Pending |
| AOPS-05 | Phase 4 | Pending |
| AOPS-06 | Phase 4 | Pending |
| AOPS-07 | Phase 4 | Pending |
| AOPS-08 | Phase 4 | Pending |
| AOPS-09 | Phase 4 | Pending |
| LANG-01 | Phase 5 | Pending |
| LANG-02 | Phase 5 | Pending |
| LANG-03 | Phase 5 | Pending |
| LANG-04 | Phase 5 | Pending |
| LANG-05 | Phase 5 | Pending |
| LANG-06 | Phase 5 | Pending |
| LANG-07 | Phase 5 | Pending |
| LANG-08 | Phase 5 | Pending |
| MIGR-01 | Phase 1 | Pending |
| MIGR-02 | Phase 1 | Pending |
| MIGR-03 | Phase 5 | Pending |
| MIGR-04 | Phase 5 | Pending |
| MIGR-05 | Phase 3 | Pending |
| MIGR-06 | Phase 1 | Pending |

**Coverage:**
- v1 requirements: 62 total
- Mapped to phases: 62
- Unmapped: 0

---
*Requirements defined: 2026-03-26*
*Last updated: 2026-03-26 after initial definition*
