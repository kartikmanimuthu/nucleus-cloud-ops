# Milestones

## v3.0 Multi-Tenancy (Shipped: 2026-04-01)

**Phases completed:** 6 phases (12–17), 18 plans
**Timeline:** 2026-03-31 → 2026-04-01
**Requirements:** 36/47 complete (11 deferred to v4.0)

**Key accomplishments:**

- Dual auth (Cognito + Credentials) with Prisma adapter, database sessions, normalized session shape `{ id, email, tenantId, role, isSuperAdmin }`
- Custom RBAC replacing CASL — static ROLE_PERMISSIONS map + custom roles per tenant with per-module granular permissions (Owner/Admin/Member/Viewer × Accounts/Schedules/AI Ops/Inventory/Settings)
- Row-level tenant isolation via scoped Prisma client factory (`getTenantClient` using `$extends`), LangGraph thread namespacing (`tenantId:userId:timestamp`), Lambda tenant filtering
- Self-service signup + org creation with slug uniqueness enforcement, middleware redirect for users without a tenant
- Email invitations via Resend with 48h expiry tokens, accept/decline flow, multi-org membership for existing users
- Org switcher in sidebar (multi-org dropdown, single-org static display), tenant settings (display name, timezone, notifications, logo upload via S3 presigned URLs)

**Known deferrals:**
- ADMIN-01–07: Super Admin Panel → v4.0
- SUSP-01–04: Tenant Suspension → v4.0

**Archive:** `.planning/milestones/v3.0-ROADMAP.md`

---

## v2.0 Pulumi IaC Migration (Shipped: 2026-03-30)

**Phases completed:** 6 phases (6–11), 17 plans
**Timeline:** 2026-03-29 → 2026-03-30

**Key accomplishments:**

- Pulumi TypeScript project scaffold with S3 backend + KMS secrets provider — no passphrase, CI-ready
- `nucleus-vpc` deployed via `awsx.ec2.Vpc` — 4-tier subnets, 2 NAT gateways, S3+DynamoDB gateway endpoints, stable StackReference outputs
- All 9 DynamoDB tables + 4 S3 buckets + 4 SQS queues + CloudWatch alarm + full Cognito stack deployed with `retainOnDelete: true`
- 3 TypeScript Lambdas (Scheduler, VectorProcessor, KBSyncProcessor) + Discovery ECS task deployed with esbuild pre-build script and correct SQS/EventBridge triggers
- ECS Fargate + ALB + CloudFront deployed with 50+ env vars wired via `pulumi.all()`, `forceNewDeployment: true`, circuit breaker, auto scaling
- `scripts/generate-env.ts` generates `web-ui/.env.local` from `pulumi stack output --json --show-secrets`
- CDK NetworkingStack + ComputeStack source files deleted; `bin/webUIStack.ts` created; WebUIStack CDK synth verified
- S3 Vectors + S3 Tables wrapped in `aws.cloudformation.Stack` using CFN templates from `cdk synth`

**Archive:** `.planning/milestones/v2.0-ROADMAP.md`

---

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
