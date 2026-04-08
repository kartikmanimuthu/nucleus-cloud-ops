# Codebase Concerns

**Analysis Date:** 2026-04-08

---

## Technical Debt

**DynamoDB Legacy Artifacts in PostgreSQL Repository Types:**
- Issue: PostgreSQL repository transform functions synthesize fake DynamoDB keys (`PK`, `SK`, `GSI1PK`, `GSI1SK`, `EntityType`) on every read. These fields served the DynamoDB single-table design but are meaningless in PostgreSQL.
- Files: `web-ui/lib/db/repositories/agent-ops-run/postgres.ts` (lines 52-55), `web-ui/lib/db/repositories/agent-ops-event/postgres.ts` (lines 29-30), `web-ui/lib/db/repositories/scheduled-task/postgres.ts` (lines 58-61), `web-ui/lib/db/repositories/rbac/postgres.ts` (lines 106-108)
- Impact: Unnecessary computation on every read, confusing type definitions, misleading field names. The types in `web-ui/lib/agent-ops/types.ts` (lines 74-77, 113-114, 140-143) and `web-ui/lib/rbac/types.ts` (lines 64-66) still mandate these fields.
- Fix approach: Remove PK/SK/GSI fields from type definitions and repository transform functions. Update any consumers that reference these fields.

**Stale USE_PG_* Feature Flag References:**
- Issue: Many service files still reference `USE_PG_*` feature flags in comments even though `isUsingPostgres()` always returns `true` and DynamoDB implementations have been removed from the repository layer.
- Files: `web-ui/lib/db/repository-factory.ts` (line 102), `web-ui/lib/tenant-config-service.ts` (line 6), `web-ui/lib/audit-service.ts` (line 2), `web-ui/lib/db/repositories/account/interface.ts` (line 6), `web-ui/app/api/inventory/resources/route.ts` (line 8), `web-ui/lib/rbac/role-service.ts` (line 4), `web-ui/lib/agent-ops/scheduled-task-service.ts` (line 5), `web-ui/lib/agent-ops/agent-ops-service.ts` (line 5)
- Impact: Misleading documentation; developers may think feature flags are still active.
- Fix approach: Remove all `USE_PG_*` references from comments and the `isUsingPostgres()` stub from `web-ui/lib/db/repository-factory.ts`.

**Health Check Still Uses DynamoDB:**
- Issue: The `/api/health` endpoint checks DynamoDB connectivity (ScanCommand on NucleusAppTable) instead of PostgreSQL, which is now the primary data store.
- Files: `web-ui/app/api/health/route.ts` (lines 2, 34-41)
- Impact: Health check reports "healthy" even if PostgreSQL is down; reports "degraded" if DynamoDB is unreachable even though most data now lives in PostgreSQL.
- Fix approach: Replace DynamoDB scan with a PostgreSQL connectivity check (e.g., `SELECT 1` via Prisma).

**Audit Route DELETE Still Uses Raw DynamoDB:**
- Issue: The audit log DELETE endpoint directly imports `getDynamoDBDocumentClient` and `AUDIT_TABLE_NAME` and uses `DeleteCommand` — bypassing the repository pattern entirely. The code itself acknowledges this is broken with inline comments like "For now, let's assume we pass full Keys or skip DELETE."
- Files: `web-ui/app/api/audit/route.ts` (lines 4-5, 97-114)
- Impact: Deletes go to DynamoDB while reads go to PostgreSQL via the repository. Data inconsistency.
- Fix approach: Either remove the DELETE endpoint (audit logs should be immutable/TTL'd) or route through `AuditLogPostgresRepository`.

**Repository Factory Uses `require()` Instead of Static Imports:**
- Issue: All 12 repository factory functions use `require()` with eslint-disable comments instead of standard ES module imports.
- Files: `web-ui/lib/db/repository-factory.ts` (lines 27-95)
- Impact: Loses tree-shaking, type-checking at import time, and IDE navigation. The original reason (conditional DynamoDB/PostgreSQL loading) no longer applies since DynamoDB implementations are removed.
- Fix approach: Replace `require()` calls with static `import` statements.

**kb-sync Worker Dual-Write with DynamoDB:**
- Issue: The kb-sync worker still maintains full DynamoDB read/write paths alongside PostgreSQL, gated by `USE_PG_KB` env var. This is the last remaining dual-write code path in the workers.
- Files: `workers/src/jobs/kb-sync/lib/vector-store.ts` (lines 1-192)
- Impact: Two code paths to maintain; risk of data divergence if flag is misconfigured.
- Fix approach: Remove DynamoDB code paths once `USE_PG_KB=true` is confirmed stable in production.

**LangGraph Persistence Dual Backend:**
- Issue: `persistence.ts` supports both DynamoDB and PostgreSQL backends via `USE_PG_LANGGRAPH` flag. The DynamoDB path imports `@farukada/aws-langgraph-dynamodb-ts` which adds bundle weight even when unused.
- Files: `web-ui/lib/agent/persistence.ts` (lines 1-335)
- Impact: Two full persistence implementations to maintain; DynamoDB imports increase bundle size.
- Fix approach: Remove DynamoDB backend once `USE_PG_LANGGRAPH=true` is confirmed stable.

**TODO Comments — Missing Error Feedback:**
- Issue: Multiple form components have `// TODO: Toast` or `// TODO: Show error toast` where user-facing error feedback is missing.
- Files: `web-ui/components/schedule-form.tsx` (lines 198, 230), `web-ui/app/app/accounts/page-updated.tsx` (line 105), `web-ui/app/app/schedules/[scheduleId]/edit/edit-schedule-form.tsx` (line 116)
- Impact: Users get no feedback when operations fail silently.
- Fix approach: Add toast notifications using the existing `sonner` toast library (already in `package.json`).

**Orphaned page-updated.tsx File:**
- Issue: `web-ui/app/app/accounts/page-updated.tsx` exists alongside `page.tsx` but is not imported or referenced anywhere.
- Files: `web-ui/app/app/accounts/page-updated.tsx`
- Impact: Dead code with a stub `// TODO: Implement export functionality`.
- Fix approach: Remove the file or merge its content into the canonical `page.tsx`.

---

## Security Concerns

**API Routes Missing Auth Checks:**
- Risk: Several API routes have no `authorize()`, `getServerSession()`, or `getSessionTenantId()` calls, meaning they are accessible to any authenticated user without RBAC enforcement — or in some cases, without any auth at all.
- Files:
  - `web-ui/app/api/enhance-prompt/route.ts` — POST with zero auth, directly invokes Bedrock LLM
  - `web-ui/app/api/skills/route.ts` — GET with zero auth
  - `web-ui/app/api/ask-ai/route.ts` — POST with zero auth, invokes Bedrock and queries inventory vectors
  - `web-ui/app/api/deep-agent/chat/route.ts` — POST with zero auth
  - `web-ui/app/api/deep-agent/todos/route.ts` — GET/POST/PATCH/DELETE with zero auth
  - `web-ui/app/api/deep-agent/threads/route.ts` — GET/POST with zero auth
  - `web-ui/app/api/deep-agent/threads/[threadId]/route.ts` — GET/DELETE with zero auth
  - `web-ui/app/api/deep-agent/approve/route.ts` — POST with zero auth
  - All `web-ui/app/api/agent-ops/*` sub-routes — use `getSessionTenantId()` but no `authorize()` RBAC check
- Current mitigation: Next.js middleware (`web-ui/middleware.ts`) enforces session tokens at the route level for most paths, but individual routes do not perform RBAC checks.
- Recommendations: Add `authorize()` calls to all mutating endpoints; add at minimum `getSessionTenantId()` to all read endpoints for tenant scoping.

**No Rate Limiting on AI Endpoints:**
- Risk: AI-powered endpoints (`/api/chat`, `/api/ask-ai`, `/api/enhance-prompt`, `/api/deep-agent/chat`) invoke AWS Bedrock with no rate limiting. A malicious or buggy client could rack up significant Bedrock costs.
- Files: `web-ui/app/api/chat/route.ts`, `web-ui/app/api/ask-ai/route.ts`, `web-ui/app/api/enhance-prompt/route.ts`, `web-ui/app/api/deep-agent/chat/route.ts`
- Current mitigation: None detected in application code. CloudFront WAF could be configured but no WAF rules are defined in Pulumi infra.
- Recommendations: Add per-user rate limiting (e.g., `upstash/ratelimit` or middleware-based token bucket); add WAF rate rules via Pulumi.

**No Input Validation (Zod) on API Route Bodies:**
- Risk: API routes parse `request.json()` and destructure fields directly without schema validation. Malformed or malicious payloads pass through to database or AWS SDK calls.
- Files: Majority of routes under `web-ui/app/api/` — zero `safeParse` or `z.object()` calls found in route handlers (Zod is available in `package.json` via `@hookform/resolvers`).
- Recommendations: Add Zod schema validation at the top of each route handler before touching business logic.

**Non-Null Assertions on Environment Variables:**
- Risk: Multiple files use `process.env.VAR_NAME!` (non-null assertion) which silently produces `undefined` at runtime if the variable is missing, leading to cryptic errors.
- Files: `web-ui/lib/agent/persistence.ts` (lines 196, 215-218), `web-ui/app/api/tenants/logo/route.ts` (line 55), `web-ui/app/api/knowledge-base/[kbId]/upload/route.ts` (line 16), `lambda/kb_sync_processor/src/index.ts` (lines 20-23), `workers/src/jobs/kb-sync/lib/vector-store.ts` (line 11), `workers/src/jobs/kb-sync/handlers/file-upload.ts` (line 15)
- Recommendations: Validate required env vars at startup with explicit error messages, or use a typed env config module.

**Jira Webhook Secret in URL Query Parameter:**
- Risk: Native Jira webhooks authenticate via `?secret=<value>` query parameter. Query params are logged by ALB access logs, CloudFront, and any proxy in the path.
- Files: `web-ui/app/api/v1/trigger/jira/route.ts` (line 53)
- Current mitigation: Automation-rule path uses the `Authorization` header (safer). The query-param path is a documented fallback for native webhooks only.
- Recommendations: Prefer Jira Automation rules over native webhooks in production; strip the param from logs.

---

## Performance Risks

**Inventory Batch Upsert Uses Sequential Prisma Transactions:**
- Problem: `upsertBatch()` creates an array of individual `upsert()` calls wrapped in `$transaction()`. For large discovery scans (thousands of resources), this generates one SQL statement per resource.
- Files: `web-ui/lib/db/repositories/inventory/postgres.ts` (lines 278-312)
- Cause: Prisma does not support bulk upsert natively; the `$transaction` approach sends N individual queries.
- Improvement path: Use raw SQL `INSERT ... ON CONFLICT DO UPDATE` for batch operations, similar to the pattern in `web-ui/lib/db/repositories/scheduled-task/postgres.ts` (line 218).

**ScheduledTask updateLastRun Does Two Round Trips:**
- Problem: `updateLastRun()` first calls `getScheduledTask()` to compute `nextRunAt`, then issues the update — two database round trips per task execution.
- Files: `web-ui/lib/db/repositories/scheduled-task/postgres.ts` (lines 193-212)
- Cause: `computeNextRunAt()` needs the current cron expression, which requires a read.
- Improvement path: Pass cron expression as a parameter from the caller, or use a single raw SQL query with subselect.

**No Pagination on Cross-Tenant Queries:**
- Problem: `listAllActiveTasks()` and `listRunsBySource()` fetch all matching records with no limit, which will degrade as tenant count grows.
- Files: `web-ui/lib/db/repositories/scheduled-task/postgres.ts` (line 134), `web-ui/lib/db/repositories/agent-ops-run/postgres.ts` (line 184)
- Improvement path: Add cursor-based pagination or a reasonable default limit.

**Missing Vector Index for Cosine Distance Queries:**
- Problem: `InventoryResource.embedding` (vector(1024)) and `AgentMemory.embedding` (vector(1024)) columns are used with `<=>` cosine distance operator but no HNSW or IVFFlat index is visible in the Prisma schema. Without a vector index, every similarity search is a sequential scan.
- Files: `prisma/schema.prisma` (lines 281, 445), `web-ui/lib/db/repositories/inventory/postgres.ts` (lines 357-418), `web-ui/lib/agent/persistence.ts` (lines 164-170)
- Improvement path: Add HNSW index via raw migration SQL: `CREATE INDEX ON inventory_resources USING hnsw (embedding vector_cosine_ops)`.

**Large Files Exceeding Reasonable Complexity:**
- Problem: Several files exceed 500 lines, indicating they may benefit from decomposition.
- Files: `web-ui/lib/inventory/column-registry.tsx` (1648 lines), `web-ui/app/app/accounts/[accountId]/page.tsx` (803 lines), `web-ui/app/api/chat/route.ts` (747 lines), `web-ui/lib/agent-ops/agent-executor.ts` (679 lines), `web-ui/lib/agent-ops/executor-graphs.ts` (678 lines), `web-ui/lib/agent/planning-agent.ts` (656 lines)
- Improvement path: Extract sub-components, helper functions, or split into multiple modules.

---

## Scalability Concerns

**Single Prisma Client Singleton — No External Connection Pooler:**
- Problem: `getPrismaClient()` creates a single PrismaClient with default connection pool (10 connections for ECS). Under high concurrency, this can exhaust the pool.
- Files: `web-ui/lib/db/pg-config.ts` (lines 24-42)
- Current capacity: 10 connections per ECS container.
- Scaling path: Add PgBouncer or RDS Proxy in front of PostgreSQL; increase pool size for ECS; ensure Lambda/worker functions use `connection_limit=3` in DATABASE_URL.

**Workers Use Separate Raw `pg` Pools — No Shared Connection Management:**
- Problem: Each worker job type (discovery, kb-sync, scheduler) creates its own `pg.Pool` instance with `max: 3`. If multiple job types run concurrently in the same pg-boss process, total connections = 3 * N job types + pg-boss's own pool.
- Files: `workers/src/jobs/discovery/services/db.ts` (line 13), `workers/src/jobs/kb-sync/lib/vector-store.ts` (lines 20-33), `workers/src/jobs/scheduler/services/pg-service.ts` (line 19)
- Scaling path: Share a single pool across all worker jobs, or use pg-boss's built-in pool.

**Three Database Systems in Production:**
- Problem: The platform currently requires PostgreSQL, DynamoDB, and MongoDB — three different database systems with different operational characteristics, backup strategies, and failure modes.
- Files: `web-ui/lib/db/pg-config.ts` (PostgreSQL), `web-ui/lib/aws-config.ts` (DynamoDB), `web-ui/lib/db/mongo-client.ts` (MongoDB)
- Impact: Tripled operational complexity for monitoring, backups, and incident response.
- Scaling path: Consolidate to PostgreSQL only — remove DynamoDB once all feature flags are flipped; migrate deep agent from MongoDB to PostgreSQL.

---

## Data Integrity

**Raw SQL Bypasses Tenant Isolation:**
- Problem: `$executeRaw` and `$queryRawUnsafe` are explicitly NOT intercepted by the `getTenantClient()` middleware (documented in `web-ui/lib/db/pg-config.ts` line 88). Callers must manually include `WHERE tenantId = $N` in every raw query.
- Files: `web-ui/lib/db/repositories/inventory/postgres.ts` (lines 134, 151, 391), `web-ui/lib/db/repositories/scheduled-task/postgres.ts` (line 218), `web-ui/lib/agent/persistence.ts` (lines 135, 164), `scripts/backfill-embeddings.ts` (lines 157, 190, 212)
- Risk: A missing `tenantId` filter in any raw query leaks data across tenants.
- Safe modification: Always parameterize `tenantId` as `$1` in raw queries; add integration tests that verify tenant isolation for raw SQL paths.

**No Foreign Key from Most Models to Tenant:**
- Problem: Most models use `tenantId` as a plain string with no FK to the `tenants` table (documented as "for zero-downtime migration compatibility"). This means orphaned records can exist for deleted tenants.
- Files: `prisma/schema.prisma` — `Account` (line 54), `Schedule` (line 105), `AuditLog` (line 180), `KnowledgeBase` (line 220), `InventoryResource` (line 268), `AgentOpsRun` (line 325), `ScheduledTask` (line 390), `AgentMemory` (line 441), `ChatMessage` (line 461)
- Risk: No referential integrity enforcement; tenant deletion leaves orphaned data across all tables.
- Fix approach: Add FK constraints now that migration is complete, with `ON DELETE CASCADE` or a cleanup job.

**Fallback to 'org-default' Tenant ID:**
- Problem: Multiple code paths fall back to `'org-default'` when tenantId is missing, which could silently assign data to the wrong tenant.
- Files: `web-ui/lib/db/repositories/inventory/postgres.ts` (line 202), `web-ui/lib/db/repositories/schedule/postgres.ts` (line 100), `workers/src/jobs/kb-sync/lib/vector-store.ts` (line 14), `web-ui/lib/agent/persistence.ts` (line 120), migration scripts throughout `scripts/`
- Risk: Data assigned to `org-default` is effectively unowned and may be visible to the wrong tenant.
- Fix approach: Replace fallbacks with explicit errors; ensure all write paths require a valid tenantId.

**TTL Cleanup Script Not Automated and Incomplete:**
- Problem: `scripts/cleanup-expired.ts` handles TTL expiry for `audit_logs` and `schedule_executions` only, but it's a manual script — not scheduled via cron, EventBridge, or pg_cron. It also misses 5 other tables with `expiresAt` columns.
- Files: `scripts/cleanup-expired.ts`
- Missing tables: `agent_ops_runs.expiresAt`, `agent_ops_events.expiresAt`, `agent_memories.expiresAt`, `chat_messages.expiresAt`, `scheduled_task_locks.expiresAt`, `invitations.expiresAt`
- Risk: Expired records accumulate indefinitely, degrading query performance and increasing storage costs.
- Fix approach: Schedule the script via pg_cron or a pg-boss recurring job; extend it to cover all tables with `expiresAt` columns.

---

## Operational Risks

**No Structured Logging in web-ui:**
- Problem: The web-ui uses raw `console.log`/`console.error` throughout (253+ occurrences across 50+ files) — no structured JSON logging, no log levels, no correlation IDs. The workers have a structured logger (`workers/src/lib/logger.ts`) but the web-ui does not.
- Files: All API routes, all service files, all repository files in `web-ui/`.
- Impact: Difficult to search/filter logs in CloudWatch; no way to trace a request across service boundaries.
- Recommendations: Adopt a structured logger (pino or winston) with JSON output and request-scoped correlation IDs for the web-ui layer.

**No Database Migration Verification in CI:**
- Problem: Prisma migrations run via `predev` and `prestart` scripts (`prisma migrate deploy`), but there's no CI step to verify migrations apply cleanly.
- Files: `web-ui/package.json` (lines 6-8)
- Risk: A broken migration could fail on production startup with no prior warning.
- Recommendations: Add `prisma migrate deploy --dry-run` or `prisma migrate status` to CI pipeline.

**MongoDB/DocumentDB Dependency Undocumented:**
- Problem: The deep-agent feature requires a MongoDB/DocumentDB connection. The mongo client falls back to `mongodb://localhost:27017` silently when env vars are missing.
- Files: `web-ui/lib/db/mongo-client.ts` (line 42)
- Risk: In production, if DocumentDB env vars are missing, the deep agent silently connects to localhost (which doesn't exist in ECS), causing cryptic connection errors.
- Recommendations: Log a warning or throw when MongoDB vars are missing in production; document the required infrastructure provisioning.

---

## Dependency Risks

**`@farukada/aws-langgraph-dynamodb-ts` — Low-Adoption, Pre-1.0 Package:**
- Risk: Pre-1.0 semver, single-author, very low npm download counts. Used for DynamoDB-based LangGraph checkpointing.
- Files: `web-ui/lib/agent/persistence.ts` (line 25), `web-ui/package.json`
- Impact: If the package is abandoned, security patches and LangGraph compatibility updates won't happen.
- Migration plan: Complete migration to `USE_PG_LANGGRAPH=true` (PostgresSaver) and remove this dependency.

**`deepagents` Package — Third-Party, Low-Visibility:**
- Risk: Small third-party package with no obvious open-source repository visible in the npm registry. Supply-chain provenance is unclear.
- Files: `web-ui/package.json`
- Impact: Any compromise of this package's npm account would affect the application.
- Migration plan: Audit the package source; consider vendoring if the deep-agent feature is critical.

**`next-auth` v4 — End of Active Development:**
- Risk: `next-auth@^4.24.11` is in maintenance-only mode. Auth.js v5 is the active branch with breaking API changes. The project uses Next.js 15 with React 19, which Auth.js v5 targets natively.
- Files: `web-ui/package.json`, `web-ui/lib/auth-options.ts`
- Impact: Security patches may not be backported to v4 indefinitely.
- Migration plan: Schedule migration to Auth.js v5; main changes are session callback signatures and the `auth()` helper replacing `getServerSession()`.

**`xlsx` Package — Abandoned Upstream:**
- Risk: `xlsx` (SheetJS CE) v0.18.x has known prototype-pollution vulnerabilities and the CE branch has been abandoned. The maintainer moved to a commercial-only model.
- Files: `web-ui/package.json`, `web-ui/app/api/inventory/export/route.ts`
- Impact: Library receives no security patches.
- Migration plan: Switch to `exceljs` which is actively maintained and MIT-licensed.

**Three Database Systems = Three Dependency Trees:**
- Risk: PostgreSQL (Prisma + pg), DynamoDB (@aws-sdk + dynamoose + @farukada), MongoDB (mongodb + @langchain/langgraph-checkpoint-mongodb) — each brings its own dependency tree, increasing attack surface and bundle size.
- Files: `web-ui/package.json`, `workers/package.json`
- Migration plan: Consolidate to PostgreSQL only.

---

## Code Quality

**Excessive `as any` Type Assertions:**
- Issue: Over 50 instances of `as any` across the codebase, particularly in deep-agent, agent, and test files.
- Files: `web-ui/lib/deep-agent/db/safe-mongo-saver.ts` (6 instances), `web-ui/lib/agent/file-saver.ts` (5 instances), `web-ui/lib/agent/planning-agent.ts` (line 250), `web-ui/components/audit/export-audit-dialog.tsx` (line 128), `web-ui/app/app/schedules/[scheduleId]/history/[executionId]/page.tsx` (lines 140-141)
- Impact: Bypasses TypeScript's type safety; hides potential runtime errors.
- Fix approach: Replace with proper type narrowing or generic types.

**Empty Catch Blocks:**
- Issue: ~30 instances of `catch { }` or `catch { /* non-fatal */ }` that silently swallow errors with no logging.
- Files: `web-ui/lib/agent-ops/agent-executor.ts` (lines 111, 165, 340, 586, 677), `web-ui/app/api/agent-ops/[runId]/approve/route.ts` (lines 108, 128, 144, 160), `web-ui/app/api/deep-agent/chat/route.ts` (lines 94, 163, 289), `web-ui/app/api/mcp-servers/route.ts` (lines 26, 63, 114)
- Impact: Errors disappear silently; debugging production issues becomes much harder.
- Fix approach: Add at minimum `console.warn` or structured log in catch blocks marked "non-fatal".

**Inconsistent Indentation — No Prettier Config:**
- Issue: Service/lib files use 4-space indentation while UI components use 2-space indentation. No `.prettierrc` detected to enforce consistency.
- Files: Codebase-wide.
- Impact: Inconsistent code style; merge conflicts from formatting differences.
- Fix approach: Add a `.prettierrc` with a single indentation standard and run a one-time format pass.

---

## Test Coverage Gaps

**Deep Agent Module — Zero Auth Testing:**
- What's not tested: All deep agent API routes (`/api/deep-agent/*`) have no auth checks and no tests verifying access control.
- Files: `web-ui/app/api/deep-agent/chat/route.ts`, `web-ui/app/api/deep-agent/todos/route.ts`, `web-ui/app/api/deep-agent/threads/route.ts`, `web-ui/app/api/deep-agent/approve/route.ts`
- Risk: Unauthenticated access to AI agent execution and thread management.
- Priority: High

**Raw SQL Tenant Isolation Not Tested:**
- What's not tested: The `$queryRawUnsafe` calls in inventory fulltext search and vector search manually include `tenantId` but have no integration tests verifying cross-tenant isolation for these raw SQL paths.
- Files: `web-ui/lib/db/repositories/inventory/postgres.ts` (lines 108-168, 357-418)
- Risk: A missing `tenantId` filter in raw SQL silently leaks data across tenants.
- Priority: High

**Cleanup Script — No Tests:**
- What's not tested: `scripts/cleanup-expired.ts` has no tests. It deletes production data.
- Files: `scripts/cleanup-expired.ts`
- Risk: A bug could delete non-expired records or fail silently.
- Priority: Medium

**Worker Jobs — Minimal Integration Test Coverage:**
- What's not tested: Worker jobs in `workers/src/jobs/` have unit tests for individual services but no integration tests for the full job execution flow (fan-out -> scan -> write -> vector processing).
- Files: `workers/src/jobs/discovery/`, `workers/src/jobs/kb-sync/`, `workers/src/jobs/scheduler/`
- Risk: Regressions in the job orchestration layer go undetected.
- Priority: Medium

**API Route Tests — Very Low Coverage:**
- What's not tested: There are 60+ API routes under `web-ui/app/api/` and only `web-ui/app/api/schedules/schedules-api.test.ts` exists as a route-level test. All other routes have zero test coverage.
- Files: `web-ui/app/api/` (entire directory)
- Risk: Route-level regressions (auth, validation, error handling) go undetected.
- Priority: Medium

---

*Concerns audit: 2026-04-08*
