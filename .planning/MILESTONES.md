# Milestones

## v1.0 DynamoDB to PostgreSQL Migration (Shipped: 2026-03-28)

**Phases completed:** 5 phases, 28 plans, 41 tasks

**Key accomplishments:**

- 1. [Rule 3 - Blocking] Downgraded Prisma from v7 to v5
- Prisma 5 singleton (getPrismaClient) with Next.js hot-reload safety and feature-flag-driven repository factory (getTenantConfigRepository) for zero-downtime DynamoDB-to-PostgreSQL cutover
- ITenantConfigRepository interface + DynamoDB and PostgreSQL repository implementations with Prisma upsert and real typed import in repository-factory.ts
- Vitest unit tests (16 total) for DynamoDB and PostgreSQL tenant config repositories, plus tenant-config-service.ts rewritten as a thin delegation layer routing to the repository factory
- Idempotent DynamoDB-to-PostgreSQL migration script for tenant configs using ScanCommand pagination, tenant FK safety, and Prisma upsert with "Migrated X/Y records..." progress logging
- One-liner:
- Prisma Account and UserTenantRole models with PostgreSQL migration, indexes, and CHECK constraint enforcing role values
- Account and RBAC repository layer: interface contracts + DynamoDB (legacy path) + PostgreSQL (server-side queries) implementations for zero-downtime migration cutover
- Service layer wired to repository pattern: account-service.ts and role-service.ts now delegate all persistence through getAccountRepository()/getRbacRepository() factory functions; 36 Vitest tests verify all 4 repository implementations
- Idempotent data migration scripts for accounts (GSI1 query) and RBAC (full scan + role validation) from DynamoDB to PostgreSQL using the same Prisma upsert pattern as migrate-tenant-configs.ts
- 13 Vitest unit tests for AccountPostgresRepository covering query scoping, pagination, ILIKE search, and 3 cross-tenant isolation tests confirming tenantId is always enforced in WHERE clauses; plus 9 Playwright E2E tests verifying the accounts page API contract, server-side filtering params, and tenant isolation at the HTTP level
- Prisma Schedule, ScheduleExecution, TargetedResource, and AuditLog models with PostgreSQL migration, all 4 tables applied, CHECK constraints on enum fields, and expiresAt TTL indexes
- One-liner:
- One-liner:
- Playwright E2E test suite verifying schedule CRUD, execution history (GET /api/schedules/:id/history), and audit log API contracts with server-side filter param verification
- 7 Prisma models (KnowledgeBase, DataSource, InventoryResource, AgentOpsRun, AgentOpsEvent, ScheduledTask, ScheduledTaskLock) added to schema and migrated to PostgreSQL with CHECK constraints
- IKnowledgeBaseRepository and IDataSourceRepository with DynamoDB + PostgreSQL implementations, atomic counter updates, and TDD unit tests — 42 tests passing
- Task 1 — Inventory Repository (TypeScript)
- Playwright E2E tests for KB management, agent ops dashboard, and scheduled tasks — 3 describe groups per file, semantic selectors, spinner-wait pattern
- agent-ops-service.ts, scheduled-task-service.ts, and inventory/resources/route.ts rewired to repository factory, making USE_PG_AGENT_OPS and USE_PG_INVENTORY feature flags functional end-to-end
- InventoryVectorKey Prisma model added, vector_processor and kb_sync_processor Lambdas wired to PostgreSQL with dual-write, and migrate-inventory.ts created for DynamoDB → PostgreSQL inventory migration
- pgvector Docker image, AgentMemory (vector(1024)) + ChatMessage Prisma models, @langchain/langgraph-checkpoint-postgres installed, AgentConversationsTable dead code removed from CDK
- migrate-all.ts orchestrates 8 scripts in dependency order with --from resume and --dry-run passthrough; verify-migration.ts compares DynamoDB vs PostgreSQL row counts per entity and exits non-zero on mismatch
- Playwright E2E tests validating agent chat send/receive, thread history persistence across reload, and thread list with data-testid selectors on chat-interface.tsx

---
