# Architecture

**Analysis Date:** 2026-04-08

## Pattern Overview

**Overall:** Multi-tier monorepo with Next.js App Router serving UI + API, a separate pg-boss worker process for async jobs, PostgreSQL as the primary datastore (migrated from DynamoDB), and Pulumi IaC for AWS infrastructure.

**Key Characteristics:**
- Single Next.js 15 process serves both React UI pages and REST API routes from ECS Fargate
- pg-boss (PostgreSQL-backed job queue) handles async work via a separate Docker container (`workers/`)
- Repository pattern with interface/implementation split abstracts all database access behind `web-ui/lib/db/repositories/`
- Multi-tenant isolation enforced at the Prisma ORM layer via `getTenantClient()` middleware
- LangGraph StateGraph powers three AI agent types (fast, planning, deep) running server-side inside Next.js
- Dual persistence backend for LangGraph: DynamoDB (legacy) or PostgreSQL, toggled by `USE_PG_LANGGRAPH` env var
- All business data fully migrated to PostgreSQL; DynamoDB tables retained for rollback safety

---

## Layers

**Infrastructure (Pulumi):**
- Purpose: Provisions all AWS resources — VPC, ECS, DynamoDB, Lambda, CloudFront, Cognito, RDS, S3, SQS
- Location: `infra/networking/index.ts`, `infra/compute/index.ts`
- Pattern: Two Pulumi stacks with explicit dependency order (networking → compute)
- Depends on: `@pulumi/pulumi`, `@pulumi/aws`, `@pulumi/awsx`, `@pulumi/command`
- State: S3 backend (`s3://nucleus-pulumi-state`), KMS secrets (`awskms://alias/pulumi-secrets`)

**Presentation (Next.js Pages):**
- Purpose: Server-rendered React pages for each domain
- Location: `web-ui/app/app/` (authenticated app pages), `web-ui/app/(docs)/` (documentation)
- Contains: Page components organized by domain — accounts, schedules, inventory, agent, agent-ops, audit, knowledge-base, deep-agent, settings, channels, dashboard
- Depends on: Component layer, service layer (via API calls from client components)

**API (Next.js Route Handlers):**
- Purpose: REST endpoints for all CRUD operations, AI chat streaming, webhook triggers
- Location: `web-ui/app/api/`
- Key route groups:
  - `web-ui/app/api/accounts/` — AWS account CRUD + scan/validate
  - `web-ui/app/api/schedules/` — Schedule CRUD + execute + history + toggle
  - `web-ui/app/api/agent-ops/` — Agent ops run management + scheduled tasks
  - `web-ui/app/api/chat/` — LangGraph agent streaming (POST)
  - `web-ui/app/api/ask-ai/` — RAG-based inventory Q&A
  - `web-ui/app/api/inventory/` — Resource inventory CRUD + export + sync
  - `web-ui/app/api/knowledge-base/` — KB CRUD + source sync + query
  - `web-ui/app/api/audit/` — Audit log queries + stats + correlation
  - `web-ui/app/api/auth/` — NextAuth.js handler + signup
  - `web-ui/app/api/settings/` — Members, roles, scheduler settings
  - `web-ui/app/api/tenants/` — Org management, slug check, logo, switch
  - `web-ui/app/api/invitations/` — Invite management (resend, revoke)
  - `web-ui/app/api/v1/trigger/` — External webhook triggers (API, Jira, Slack)
  - `web-ui/app/api/deep-agent/` — Deep agent chat + thread management
  - `web-ui/app/api/discovery/` — Discovery execution + status
  - `web-ui/app/api/threads/` — Chat thread history
- Pattern: Named exports (`GET`, `POST`, `PUT`, `DELETE`) per `route.ts` file
- Auth: Every mutating route calls `authorize(action, subject)` from `web-ui/lib/rbac/authorize.ts`
- Session: `getAuthSession()` or `getSessionUserId()` from `web-ui/lib/auth-session.ts`
- Response: Always `NextResponse.json(data, { status: N })`

**Service Layer:**
- Purpose: Business logic for each domain
- Location: `web-ui/lib/`
- Key files:
  - `web-ui/lib/account-service.ts` — AWS account CRUD + cross-account STS validation
  - `web-ui/lib/schedule-service.ts` — Schedule CRUD
  - `web-ui/lib/schedule-execution-service.ts` — Execution history
  - `web-ui/lib/audit-service.ts` — Immutable audit log writes
  - `web-ui/lib/invitation-service.ts` — Email invitations via Resend
  - `web-ui/lib/tenant-config-service.ts` — Per-tenant config key-value store
  - `web-ui/lib/tenant-settings-service.ts` — Tenant name/slug/logo management
  - `web-ui/lib/knowledge-base/service.ts` — KB + data source management
  - `web-ui/lib/agent-ops/agent-ops-service.ts` — Agent ops run management
  - `web-ui/lib/agent-ops/scheduled-task-service.ts` — Scheduled task CRUD
  - `web-ui/lib/agent-ops/scheduler-engine.ts` — Cron-based task scheduling
  - `web-ui/lib/agent-ops/slack-notifier.ts`, `jira-notifier.ts` — Notification delivery
  - `web-ui/lib/agent-ops/agent-executor.ts` — Executes agent runs
  - `web-ui/lib/agent-ops/run-manager.ts` — Manages run lifecycle
- Pattern: Static class methods (e.g., `AccountService.getAccounts()`) that delegate to repository layer
- Depends on: Repository layer (`web-ui/lib/db/repository-factory.ts`), AWS SDK v3

**Repository Layer (Data Access):**
- Purpose: All PostgreSQL persistence via Prisma ORM, abstracted behind interfaces
- Location: `web-ui/lib/db/`
- Pattern: Interface + PostgreSQL implementation per entity:
  - `web-ui/lib/db/repositories/<entity>/interface.ts` — TypeScript interface
  - `web-ui/lib/db/repositories/<entity>/postgres.ts` — Prisma implementation
  - `web-ui/lib/db/repositories/<entity>/postgres.test.ts` — Unit tests
- Factory: `web-ui/lib/db/repository-factory.ts` — lazy-loads implementations via `require()`
- 12 repositories: account, agent-ops-event, agent-ops-run, audit-log, data-source, inventory, knowledge-base, rbac, schedule, schedule-execution, scheduled-task, tenant-config
- Depends on: `web-ui/lib/db/pg-config.ts` (Prisma client singleton + tenant scoping)

**Tenant Isolation Layer:**
- Purpose: Automatic row-level tenant scoping on all Prisma queries
- Location: `web-ui/lib/db/pg-config.ts`
- Key function: `getTenantClient(tenantId)` — wraps Prisma via `$extends` query middleware
- Injects `tenantId` into WHERE/data for all CRUD operations on tenant-scoped models
- 18 tenant-scoped models defined in `TENANT_SCOPED_MODELS` set
- Caveat: `$executeRaw` and `$queryRawUnsafe` are NOT intercepted — callers must manually scope

**AI Agent Layer:**
- Purpose: LangGraph-powered AI agents for cloud operations
- Location: `web-ui/lib/agent/`
- Three agent types:
  - `web-ui/lib/agent/fast-agent.ts` — Reflection loop (generator → tools → reflector → revise), MAX_REFLECT_ITERATIONS=5
  - `web-ui/lib/agent/planning-agent.ts` — Multi-step (planner → executor → reflector → reviser), MAX_ITERATIONS=30
  - `web-ui/lib/agent/deep-agent.ts` — Extended thinking with MongoDB persistence
- Entry: `web-ui/lib/agent/graph-factory.ts` exports `createFastGraph`, `createReflectionGraph`, `createDeepGraph`
- Shared: `web-ui/lib/agent/agent-shared.ts` (state types, `ReflectionState`, `sanitizeMessagesForBedrock`)
- Models: `web-ui/lib/agent/model-factory.ts` (ChatBedrockConverse init, tool assembly)
- Persistence: `web-ui/lib/agent/persistence.ts` — dual-backend singleton:
  - DynamoDB (default): DynamoDBSaver, DynamoDBStore, DynamoDBChatMessageHistory
  - PostgreSQL (`USE_PG_LANGGRAPH=true`): PostgresSaver, PostgresMemoryStore (pgvector), PostgresChatHistory
- Tools: `web-ui/lib/agent/tools.ts` (execute_command, read_file, write_file, glob, grep, S3, AWS credentials)
- MCP: `web-ui/lib/agent/mcp-config.ts`, `mcp-manager.ts`, `mcp-tools.ts`
- Skills: `web-ui/lib/agent/skills/` — domain-specific SKILL.md files loaded by `skill-loader.ts`

**Agent Ops Layer:**
- Purpose: Orchestrates agent runs triggered from Slack, Jira, API, or scheduled tasks
- Location: `web-ui/lib/agent-ops/`
- Key files:
  - `web-ui/lib/agent-ops/agent-executor.ts` — Executes agent runs
  - `web-ui/lib/agent-ops/run-manager.ts` — Manages run lifecycle
  - `web-ui/lib/agent-ops/scheduler-engine.ts` — Cron-based task scheduling
  - `web-ui/lib/agent-ops/slack-notifier.ts`, `jira-notifier.ts` — Notification delivery
  - `web-ui/lib/agent-ops/tool-classifier.ts` — Classifies tool calls for UI display
  - `web-ui/lib/agent-ops/types.ts` — Type definitions

**Workers (pg-boss):**
- Purpose: Background job processing — resource scheduling, inventory discovery, KB sync
- Location: `workers/src/`
- Entry: `workers/src/index.ts` — starts pg-boss, registers all job handlers, graceful shutdown
- Boss config: `workers/src/boss.ts` — creates pg-boss instance from `DATABASE_URL` with retry/expiry settings
- Three job domains:
  - `workers/src/jobs/scheduler/` — Per-tenant cron-based resource start/stop (EC2, RDS, ECS, ASG, DocDB)
  - `workers/src/jobs/discovery/` — Fan-out multi-account inventory scanning → PostgreSQL + vector embeddings
  - `workers/src/jobs/kb-sync/` — Knowledge base data source sync (file upload, S3, Confluence, Bitbucket)
- Pattern: Each domain exports `register(boss)` that creates queues, schedules cron, and registers workers
- Web-UI producer: `web-ui/lib/boss-client.ts` — singleton pg-boss client in producer-only mode (`noScheduling: true, noSupervisor: true`)

**RBAC Layer:**
- Purpose: Role-based access control for all mutating API routes
- Location: `web-ui/lib/rbac/`
- Key files:
  - `web-ui/lib/rbac/authorize.ts` — `authorize(action, subject)` returns null (OK) or NextResponse (401/403)
  - `web-ui/lib/rbac/permissions.ts` — Predefined role permission matrix
  - `web-ui/lib/rbac/custom-role-service.ts` — DB-backed custom role permissions
  - `web-ui/lib/rbac/role-service.ts` — Role lookups
  - `web-ui/lib/rbac/types.ts` — Module/action/role type definitions
- Predefined roles: Owner, Admin, Member, Viewer
- Custom roles: per-tenant, stored in `custom_roles` table with JSON permission sets
- SuperAdmin flag on AuthUser bypasses all checks

**Auth Layer:**
- Purpose: Authentication via NextAuth.js with dual providers
- Location: `web-ui/lib/auth-options.ts`, `web-ui/lib/auth-session.ts`
- Providers: Cognito (SSO) + Credentials (email/password with bcrypt)
- Session: JWT strategy, 24-hour max age
- Adapter: PrismaAdapter with custom model mapping (AuthUser → user, AuthAccount → account, AuthSession → session)
- Account lockout: 5 failed attempts → 15-minute lockout
- Tenant resolution: JWT callback queries `UserTenantRole` for active tenant, auto-accepts pending invitations on first login

**Component Layer:**
- Purpose: React UI components organized by domain
- Location: `web-ui/components/`
- Domain folders: `accounts/`, `agent/`, `agent-ops/`, `ai-elements/`, `audit/`, `auth/`, `channels/`, `dashboard/`, `deep-agent/`, `inventory/`, `knowledge-base/`, `schedules/`, `settings/`
- Primitives: `web-ui/components/ui/` — Radix-based shadcn/ui components (do not modify)
- Shared layout: `web-ui/components/sidebar.tsx`, `layout-wrapper.tsx`, `auth-guard.tsx`

---

## Data Flow

**Web Request Lifecycle:**
1. CloudFront → ALB → ECS Fargate (Next.js container)
2. Next.js App Router matches page or API route
3. API routes: auth check → RBAC authorize → service layer → repository → Prisma → PostgreSQL
4. Pages: server-side render → client hydration → API calls for data

**AI Agent Chat Flow:**
1. POST `/api/chat` with messages, threadId, mode (plan/fast/deep)
2. Auth + tenant resolution from session
3. Thread lock acquired (prevents duplicate LangGraph executions)
4. Graph created via `graph-factory.ts` based on mode
5. LangGraph StateGraph streams responses via `createUIMessageStreamResponse` (Vercel AI SDK format)
6. Phase markers (`PLANNING_PHASE_START`, `EXECUTION_PHASE_START`, etc.) annotate reasoning vs. output
7. Checkpoints persisted to DynamoDB or PostgreSQL (based on `USE_PG_LANGGRAPH`)
8. Chat history saved via persistence layer

**Background Job Flow (pg-boss):**
1. Web-UI enqueues job via `getBoss().send(queueName, data)` (producer-only client in `web-ui/lib/boss-client.ts`)
2. Workers container polls pg-boss queues (`workers/src/index.ts`)
3. Job handler executes (scheduler scan, discovery scan, KB sync)
4. Results written to PostgreSQL via Prisma or direct pg queries
5. Failed jobs auto-retry per pg-boss config (retryLimit=3, retryDelay=30s, exponential backoff)

**Discovery Scan Flow:**
1. `discovery-fan-out` cron fires every 5 minutes
2. Fan-out handler queries all tenants, sends one `discovery-scan` job per tenant (with `singletonKey` for dedup)
3. Scan handler: get tenant accounts → STS AssumeRole → scan AWS resources → write to PostgreSQL → generate vector embeddings → update sync status → audit log
4. Queue config: `discovery-scan` expires in 30 min (zombie protection), retryLimit=2

**Scheduler Flow:**
1. Per-tenant cron queues registered on worker startup (`scheduler-scan:<tenantId>`)
2. Cron interval configurable per tenant (5/15/30/60 min) via `getTenantSchedulerConfig()`
3. Handler runs full or partial schedule scan → STS AssumeRole → start/stop resources
4. Live interval changes handled via `scheduler-reschedule` queue (web-ui settings API enqueues)

**KB Sync Flow:**
1. Web-UI API enqueues `kb-sync` job with type (file-upload, s3-sync, confluence-sync, bitbucket-sync)
2. Worker handler: delete old vectors → process source → chunk → embed via Bedrock Titan → store vectors → update data source status
3. batchSize=3 to avoid Bedrock rate limiting

**State Management:**
- Business data: PostgreSQL via Prisma (all entities — accounts, schedules, audit, inventory, agent ops, RBAC, KB, tenants)
- LangGraph state: DynamoDB or PostgreSQL (checkpoints, memory, chat history) — toggled by `USE_PG_LANGGRAPH`
- Deep agent state: MongoDB (separate persistence path via `web-ui/lib/deep-agent/db/`)
- Job queue state: pg-boss tables in PostgreSQL (auto-managed)
- Client state: React `useState` per component, no global state library

---

## Key Design Patterns

**Repository Pattern:**
- Every entity has `interface.ts` + `postgres.ts` in `web-ui/lib/db/repositories/<entity>/`
- Factory functions in `web-ui/lib/db/repository-factory.ts` instantiate implementations
- Services call factory functions, never Prisma directly
- `isUsingPostgres()` always returns true (migration complete)

**Tenant Client Middleware:**
- `getTenantClient(tenantId)` in `web-ui/lib/db/pg-config.ts` wraps Prisma via `$extends`
- Automatically injects `tenantId` into all reads, writes, deletes for 18 tenant-scoped models
- Throws if `tenantId` is falsy — prevents accidental cross-tenant queries
- Repositories use `getTenantClient()` for tenant-scoped queries, `getPrismaClient()` for platform-level queries

**Singleton Pattern:**
- `getPrismaClient()` — global singleton surviving Next.js hot reloads (dev uses `globalThis`, prod uses module-level)
- `getBoss()` — lazy singleton pg-boss client for web-ui (producer-only)
- `getPersistence()` — globalThis-cached persistence instances (checkpointer, store, chatHistory)
- `getDynamoDBDocumentClient()` — singleton DynamoDB client (legacy, still used for LangGraph DynamoDB backend)

**pg-boss Job Queue Pattern:**
- Workers container: `workers/src/boss.ts` creates full pg-boss instance (scheduling + supervision)
- Web-UI: `web-ui/lib/boss-client.ts` creates producer-only instance (`noScheduling: true, noSupervisor: true`)
- Each job domain exports `register(boss)` that creates queues, schedules cron, and registers handlers
- Fan-out pattern for discovery: one cron job fans out to per-tenant scan jobs with `singletonKey` dedup
- Config: retryLimit=3, retryDelay=30s, retryBackoff=true, expireInHours=4, archiveCompletedAfterSeconds=86400, deleteAfterDays=7

**LangGraph StateGraph:**
- Three agent types share `ReflectionState` from `web-ui/lib/agent/agent-shared.ts`
- Graph factory (`web-ui/lib/agent/graph-factory.ts`) re-exports all graph constructors
- Model factory (`web-ui/lib/agent/model-factory.ts`) creates main (8192 tokens, streaming) + reflector (1024 tokens, non-streaming) model pairs
- Messages capped at 100 in state reducer to prevent checkpoint bloat

**Human-in-the-Loop (HITL):**
- When `autoApprove=false`, the agent emits `tool-input-available` events and pauses
- UI shows approval dialog; user approval/rejection sent back as a `tool` role message
- API resumes the graph via `graph.updateState()`

---

## Entry Points

**Next.js App (ECS Fargate):**
- Location: `web-ui/app/layout.tsx`
- Triggers: HTTP requests via CloudFront → ALB
- Responsibilities: Root layout with ThemeProvider, auth Providers, LayoutWrapper

**Chat API:**
- Location: `web-ui/app/api/chat/route.ts`
- Triggers: POST from chat UI
- Responsibilities: Auth, thread lock, graph selection (plan/fast/deep), LangGraph streaming, message persistence
- Max duration: 300s (5 minutes)

**Ask AI API:**
- Location: `web-ui/app/api/ask-ai/route.ts`
- Triggers: POST from inventory Ask AI dialog
- Responsibilities: Embed question, query vectors, fetch resources, stream answer via Claude

**Workers Process:**
- Location: `workers/src/index.ts`
- Triggers: Docker container start (`docker-compose.workers.yml` or ECS)
- Responsibilities: Start pg-boss, register all job handlers (scheduler, discovery, kb-sync), graceful shutdown (SIGTERM/SIGINT with 30s timeout)

**Scheduler Lambda (legacy):**
- Location: `lambda/scheduler/src/index.ts`
- Triggers: EventBridge cron or manual invocation
- Note: Being superseded by `workers/src/jobs/scheduler/` pg-boss worker

**Pulumi Compute Stack:**
- Location: `infra/compute/index.ts`
- Triggers: `pulumi up --stack prod`
- Responsibilities: Provisions all compute resources (ECS, Lambda, RDS, DynamoDB, Cognito, CloudFront)

**Migration Scripts:**
- Location: `scripts/migrate-all.ts` (orchestrator), `scripts/migrate-*.ts` (per-entity)
- Triggers: Manual execution via `ts-node`
- Responsibilities: DynamoDB → PostgreSQL data migration for all entities

---

## Error Handling

**Strategy:** Try/catch at API route boundaries with consistent error response format; pg-boss auto-retry for worker failures.

**Patterns:**
- API routes: `try/catch` → `NextResponse.json({ success: false, error: message }, { status: 500 })`
- Agent stream: Abort errors (client disconnect) handled silently; real errors logged and propagated via `controller.error()`
- pg-boss workers: Errors thrown from handlers trigger pg-boss retry (configurable `retryLimit`, `retryDelay`, `retryBackoff`)
- Discovery: Per-account errors collected; scan only fails if ALL accounts fail (partial success is OK)
- KB sync: Errors update data source status to `error` with `lastErrorMessage` + `lastErrorDetail`, then re-throw for pg-boss retry
- DynamoDB: `handleDynamoDBError()` in `web-ui/lib/aws-config.ts` maps error codes to user-friendly messages
- Auth: 401 for unauthenticated, 403 for unauthorized (via `authorize()` helper)
- Account lockout: 5 failed login attempts → 15-minute lockout with countdown message

---

## Cross-Cutting Concerns

**Authentication:**
- NextAuth.js with JWT strategy, dual providers (Cognito SSO + Credentials with bcrypt)
- Config: `web-ui/lib/auth-options.ts`
- Session helpers: `web-ui/lib/auth-session.ts` — `getAuthSession()`, `getSessionUserId()`, `getSessionTenantId()`
- Adapter: PrismaAdapter mapping to `auth_users`, `auth_accounts`, `auth_sessions`, `verification_tokens` tables

**Authorization (RBAC):**
- `authorize(action, subject)` from `web-ui/lib/rbac/authorize.ts` — called in every mutating API route
- Predefined roles (Owner/Admin/Member/Viewer) + custom roles with per-module JSON permission sets
- SuperAdmin flag on AuthUser bypasses all checks
- Custom roles stored in `custom_roles` table, looked up via `getCustomRolePermissions()`

**Tenant Isolation:**
- `getTenantClient(tenantId)` auto-injects tenantId into all Prisma queries for 18 tenant-scoped models
- Defined in `TENANT_SCOPED_MODELS` set in `web-ui/lib/db/pg-config.ts`
- Raw SQL (`$executeRaw`) is NOT intercepted — callers must manually scope
- Workers also scope by tenantId (per-tenant queues for scheduler, tenantId in discovery scan jobs)

**Logging:**
- Web-UI: `console.log` / `console.error` — no structured logging library
- Workers: `createLogger(service)` from `workers/src/lib/logger.ts` — structured logger with service prefix and log levels
- Agent: Langfuse integration via `web-ui/lib/agent/langfuse-config.ts` for LLM observability

**Audit:**
- `AuditService.logUserAction()` from `web-ui/lib/audit-service.ts` — every AWS-modifying action must be logged
- Workers write audit logs via `workers/src/jobs/discovery/services/audit-service.ts`
- Audit logs stored in `audit_logs` table with 30-day TTL (cleanup via `scripts/cleanup-expired.ts`)

**Feature Flags:**
- `USE_PG_LANGGRAPH` — toggles LangGraph persistence between DynamoDB and PostgreSQL
- `isUsingPostgres()` in `web-ui/lib/db/repository-factory.ts` — always returns true (all business data on PostgreSQL)
- Legacy flags (`USE_PG_SCHEDULES`, `USE_PG_KB`) still referenced in `docker-compose.workers.yml`

---

*Architecture analysis: 2026-04-08*
