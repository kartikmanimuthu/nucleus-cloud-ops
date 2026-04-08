# Codebase Structure

**Analysis Date:** 2026-04-08

## Directory Layout

```
nucleus-cloud-ops/
├── web-ui/                       # Next.js 15 application (frontend + API)
│   ├── app/                      # Next.js App Router
│   │   ├── layout.tsx            # Root layout (ThemeProvider, NextAuth Providers)
│   │   ├── page.tsx              # Root redirect / marketing page
│   │   ├── globals.css           # Global Tailwind CSS
│   │   ├── login/                # Login page
│   │   ├── signup/               # Signup page
│   │   ├── create-org/           # Organization creation page
│   │   ├── app/                  # Authenticated app pages (all feature routes)
│   │   │   ├── dashboard/        # Dashboard page
│   │   │   ├── accounts/         # AWS Account management (list, detail, create, edit)
│   │   │   ├── agent/            # AI agent chat interface + MCP settings
│   │   │   ├── agent-ops/        # AgentOps management (runs, scheduled tasks, settings)
│   │   │   ├── audit/            # Audit log viewer
│   │   │   ├── channels/         # Notification channels (Slack, Jira, MCP settings)
│   │   │   ├── deep-agent/       # Deep Agent interface
│   │   │   ├── inventory/        # Resource inventory viewer
│   │   │   ├── knowledge-base/   # Knowledge base management + sources + ask
│   │   │   ├── schedules/        # Schedule management (list, detail, create, edit, history, settings)
│   │   │   ├── settings/         # App settings (members, organization, roles)
│   │   │   └── unauthorized/     # 403 page
│   │   ├── api/                  # REST API routes (Next.js route handlers)
│   │   │   ├── accounts/         # CRUD + scan/validate/activity/resources/schedules
│   │   │   ├── agent-ops/        # Run management + scheduled tasks + settings (Jira, Slack, MCP)
│   │   │   ├── ask-ai/           # RAG-based inventory Q&A
│   │   │   ├── audit/            # Audit log queries + stats + correlation
│   │   │   ├── auth/             # NextAuth.js [...nextauth] handler + signup
│   │   │   ├── chat/             # LangGraph agent streaming (POST)
│   │   │   ├── deep-agent/       # Deep agent chat + threads + todos + approve
│   │   │   ├── discovery/        # Discovery execution + status
│   │   │   ├── enhance-prompt/   # Prompt enhancement utility
│   │   │   ├── health/           # Health check endpoint
│   │   │   ├── inventory/        # Resource inventory CRUD + export + sync + status
│   │   │   ├── invitations/      # Invitation management (resend, revoke)
│   │   │   ├── knowledge-base/   # KB CRUD + source sync + upload + query
│   │   │   ├── mcp-servers/      # MCP server listing
│   │   │   ├── scheduler/        # Scheduler execution + settings
│   │   │   ├── schedules/        # Schedule CRUD + execute + history + toggle
│   │   │   ├── settings/         # Members, roles, scheduler settings
│   │   │   ├── skills/           # Skill listing
│   │   │   ├── tenants/          # Org management (check-slug, logo, my-orgs, settings, switch)
│   │   │   ├── threads/          # Chat thread history
│   │   │   └── v1/trigger/       # External webhook triggers (API, Jira, Slack)
│   │   ├── (docs)/               # Fumadocs documentation pages
│   │   └── test-api/             # API test page
│   ├── components/               # React UI components
│   │   ├── ui/                   # Radix-based primitives (shadcn/ui — do not modify)
│   │   ├── accounts/             # Account cards, forms, detail dialogs
│   │   ├── agent/                # Chat interface, thread sidebar, tab bar
│   │   ├── agent-ops/            # AgentOps panels and run viewers
│   │   ├── ai-elements/          # Shared AI response rendering
│   │   ├── audit/                # Audit log tables
│   │   ├── auth/                 # Auth-related components
│   │   ├── channels/             # Slack/Jira channel config
│   │   ├── dashboard/            # Dashboard widgets
│   │   ├── deep-agent/           # Deep agent UI
│   │   ├── inventory/            # Inventory table, Ask AI dialog, source citations
│   │   ├── knowledge-base/       # KB management UI
│   │   ├── schedules/            # Schedule forms and list
│   │   ├── settings/             # Settings panels (members, roles, org)
│   │   ├── sidebar.tsx           # App navigation sidebar
│   │   ├── auth-guard.tsx        # Route-level auth guard
│   │   └── layout-wrapper.tsx    # Sidebar + content layout
│   ├── lib/                      # Business logic and shared utilities
│   │   ├── agent/                # AI agent implementation (LangGraph)
│   │   ├── agent-ops/            # Agent ops orchestration
│   │   ├── db/                   # Database layer (Prisma config + repositories)
│   │   ├── deep-agent/           # Deep agent implementation
│   │   ├── inventory/            # Inventory types and column registry
│   │   ├── knowledge-base/       # KB service, embedder, types
│   │   ├── rbac/                 # Role-based access control
│   │   ├── store/                # In-process stores (thread-store.ts)
│   │   ├── *-service.ts          # Domain service classes
│   │   ├── auth-options.ts       # NextAuth.js configuration
│   │   ├── auth-session.ts       # Session helper functions
│   │   ├── aws-config.ts         # DynamoDB client + table names (legacy)
│   │   ├── boss-client.ts        # pg-boss producer-only singleton
│   │   └── types.ts              # Shared TypeScript types
│   └── hooks/                    # Custom React hooks
├── workers/                      # pg-boss background job workers
│   ├── src/
│   │   ├── index.ts              # Entry point — starts pg-boss, registers jobs
│   │   ├── boss.ts               # pg-boss instance factory
│   │   ├── lib/
│   │   │   └── logger.ts         # Structured logger with service prefix
│   │   └── jobs/
│   │       ├── scheduler/        # Resource scheduling jobs (per-tenant cron)
│   │       ├── discovery/        # Inventory discovery jobs (fan-out + scan)
│   │       └── kb-sync/          # Knowledge base sync jobs
│   ├── Dockerfile                # Worker container image
│   ├── package.json              # Worker dependencies (pg-boss, AWS SDK, Prisma)
│   └── tsconfig.json             # TypeScript config (ESM)
├── prisma/                       # Prisma ORM schema + migrations
│   ├── schema.prisma             # Full database schema (30+ models)
│   └── migrations/               # 25+ migration directories
├── lambda/                       # Lambda functions (legacy, being migrated to workers)
│   ├── scheduler/                # TypeScript: EventBridge-triggered resource scheduler
│   │   └── src/
│   │       ├── index.ts          # Lambda handler
│   │       ├── services/         # Scheduler business logic
│   │       ├── resource-schedulers/ # Per-resource-type schedulers (EC2, ECS, RDS, ASG)
│   │       ├── types/            # TypeScript types
│   │       └── utils/            # Logger, time helpers
│   ├── vector_processor/         # TypeScript+Python: S3→SQS→embed→S3 Vectors pipeline
│   │   └── src/
│   │       ├── index.ts          # SQS Lambda handler
│   │       └── resource-text.ts  # Resource → embeddable text converter
│   └── kb_sync_processor/        # TypeScript: Bedrock Knowledge Base sync
│       └── src/
│           └── index.ts          # KB sync Lambda handler
├── infra/                        # Pulumi infrastructure
│   ├── networking/               # VPC, subnets, subnet groups
│   │   └── index.ts              # Networking stack
│   ├── compute/                  # ECS, Lambda, RDS, DynamoDB, Cognito, CloudFront
│   │   └── index.ts              # Compute stack (main infrastructure)
│   └── bootstrap/                # One-time S3 state + KMS key setup
├── scripts/                      # Migration and maintenance scripts
│   ├── migrate-all.ts            # Orchestrates all DynamoDB → PostgreSQL migrations
│   ├── migrate-*.ts              # Per-entity migration scripts (8 files)
│   ├── verify-migration.ts       # Post-migration verification
│   ├── cleanup-expired.ts        # TTL-based row cleanup (audit, executions, etc.)
│   ├── backfill-embeddings.ts    # Backfill vector embeddings
│   └── generate-env.ts           # Environment file generator
├── tests/                        # E2E Playwright tests
│   └── e2e/                      # Playwright specs
├── docs/                         # Architecture documentation
│   ├── schema-design.md          # DynamoDB single-table schema reference
│   ├── agent-ops/                # AgentOps architecture docs
│   ├── deepagents/               # Deep agent documentation
│   ├── diagram-as-code/          # Architecture diagrams
│   └── superpowers/              # Plans and specs
├── .planning/                    # GSD planning documents
│   └── codebase/                 # Codebase analysis docs (this directory)
├── .claude/                      # Claude Code config (agents, plans, skills)
├── .kiro/                        # Kiro IDE config (agents, chats, plans, steering)
├── docker-compose.yml            # Local PostgreSQL (pgvector/pgvector:pg16)
├── docker-compose.workers.yml    # Local postgres + migrate + workers stack
├── docker-compose.langfuse.yml   # Local Langfuse tracing setup
├── prisma/schema.prisma          # Database schema
├── package.json                  # Root deps (esbuild, Jest, ts-node)
├── tsconfig.json                 # Root TypeScript config (ES2020, commonjs, strict)
├── playwright.config.ts          # Playwright E2E config
└── CLAUDE.md                     # Claude Code project instructions
```

---

## Module Organization

**By Domain (vertical slices):**
Each business domain spans multiple layers:
- Page: `web-ui/app/app/<domain>/`
- API: `web-ui/app/api/<domain>/`
- Components: `web-ui/components/<domain>/`
- Service: `web-ui/lib/<domain>-service.ts` or `web-ui/lib/<domain>/`
- Repository: `web-ui/lib/db/repositories/<entity>/`
- Worker job: `workers/src/jobs/<domain>/`

| Domain | Page | API | Components | Service | Repository | Worker |
|--------|------|-----|------------|---------|------------|--------|
| Accounts | `app/accounts/` | `api/accounts/` | `components/accounts/` | `lib/account-service.ts` | `db/repositories/account/` | — |
| Schedules | `app/schedules/` | `api/schedules/` | `components/schedules/` | `lib/schedule-service.ts` | `db/repositories/schedule/` | `jobs/scheduler/` |
| Inventory | `app/inventory/` | `api/inventory/` | `components/inventory/` | `lib/inventory/` | `db/repositories/inventory/` | `jobs/discovery/` |
| Audit | `app/audit/` | `api/audit/` | `components/audit/` | `lib/audit-service.ts` | `db/repositories/audit-log/` | — |
| Agent | `app/agent/` | `api/chat/` | `components/agent/` | `lib/agent/` | — | — |
| Agent Ops | `app/agent-ops/` | `api/agent-ops/` | `components/agent-ops/` | `lib/agent-ops/` | `db/repositories/agent-ops-run/`, `agent-ops-event/`, `scheduled-task/` | — |
| Knowledge Base | `app/knowledge-base/` | `api/knowledge-base/` | `components/knowledge-base/` | `lib/knowledge-base/` | `db/repositories/knowledge-base/`, `data-source/` | `jobs/kb-sync/` |
| Deep Agent | `app/deep-agent/` | `api/deep-agent/` | `components/deep-agent/` | `lib/deep-agent/` | — | — |
| Settings | `app/settings/` | `api/settings/` | `components/settings/` | `lib/rbac/`, `lib/tenant-settings-service.ts` | `db/repositories/rbac/` | — |
| Tenants | — | `api/tenants/` | — | `lib/tenant-config-service.ts` | `db/repositories/tenant-config/` | — |

---

## Key Files

**Entry Points:**
- `web-ui/app/layout.tsx` — Root layout (ThemeProvider, auth Providers, LayoutWrapper)
- `web-ui/app/api/chat/route.ts` — AI agent chat streaming endpoint
- `workers/src/index.ts` — pg-boss worker process entry
- `infra/compute/index.ts` — Pulumi compute stack (main infrastructure)
- `scripts/migrate-all.ts` — DynamoDB → PostgreSQL migration orchestrator

**Database:**
- `prisma/schema.prisma` — Full database schema (30+ models including auth, business, agent, RBAC)
- `web-ui/lib/db/pg-config.ts` — Prisma client singleton + `getTenantClient()` tenant isolation middleware
- `web-ui/lib/db/repository-factory.ts` — Factory functions for all 12 repositories
- `workers/src/boss.ts` — pg-boss instance factory

**Auth & RBAC:**
- `web-ui/lib/auth-options.ts` — NextAuth.js config (Cognito + Credentials providers, JWT callbacks)
- `web-ui/lib/auth-session.ts` — `getAuthSession()`, `getSessionUserId()`, `getSessionTenantId()`
- `web-ui/lib/rbac/authorize.ts` — `authorize(action, subject)` API route guard
- `web-ui/lib/rbac/permissions.ts` — Predefined role permission matrix
- `web-ui/lib/rbac/types.ts` — Module, Action, PredefinedRole type definitions

**AI Agent:**
- `web-ui/lib/agent/graph-factory.ts` — Re-exports all graph constructors
- `web-ui/lib/agent/agent-shared.ts` — ReflectionState, graphState, sanitizeMessagesForBedrock
- `web-ui/lib/agent/model-factory.ts` — ChatBedrockConverse init + assembleTools()
- `web-ui/lib/agent/persistence.ts` — Dual-backend persistence (DynamoDB or PostgreSQL)
- `web-ui/lib/agent/tools.ts` — All agent tool definitions
- `web-ui/lib/agent/mcp-config.ts` — MCP server definitions
- `web-ui/lib/agent/mcp-manager.ts` — MCP server lifecycle management

**Workers:**
- `workers/src/jobs/scheduler/index.ts` — Per-tenant cron scheduler registration
- `workers/src/jobs/scheduler/services/scheduler-service.ts` — Full/partial scan execution
- `workers/src/jobs/scheduler/services/pg-service.ts` — PostgreSQL queries for schedules
- `workers/src/jobs/discovery/index.ts` — Discovery fan-out + scan registration
- `workers/src/jobs/discovery/services/scanner.ts` — AWS resource scanning
- `workers/src/jobs/discovery/services/pg-writer.ts` — PostgreSQL inventory writes
- `workers/src/jobs/discovery/services/vector-processor.ts` — Embedding generation
- `workers/src/jobs/kb-sync/index.ts` — KB sync job registration
- `workers/src/jobs/kb-sync/handlers/` — Per-source-type sync handlers

**Configuration:**
- `web-ui/lib/aws-config.ts` — DynamoDB client singleton + table name exports (legacy)
- `web-ui/lib/boss-client.ts` — pg-boss producer-only singleton for web-ui
- `web-ui/lib/cognito-client.ts` — Cognito client for user management

---

## Dependency Graph

**High-level module dependencies:**
```
Pages (web-ui/app/app/) → Components (web-ui/components/)
                        → API Routes (web-ui/app/api/) via fetch

API Routes → Service Layer (web-ui/lib/*-service.ts)
           → RBAC (web-ui/lib/rbac/authorize.ts)
           → Auth (web-ui/lib/auth-session.ts)
           → Boss Client (web-ui/lib/boss-client.ts) [for job enqueue]

Service Layer → Repository Factory (web-ui/lib/db/repository-factory.ts)
              → Audit Service (web-ui/lib/audit-service.ts)

Repository Factory → Repository Implementations (web-ui/lib/db/repositories/*/postgres.ts)
                   → Prisma Client (web-ui/lib/db/pg-config.ts)

Agent Layer → Model Factory (web-ui/lib/agent/model-factory.ts)
            → Persistence (web-ui/lib/agent/persistence.ts)
            → Tools (web-ui/lib/agent/tools.ts)
            → MCP Manager (web-ui/lib/agent/mcp-manager.ts)

Workers → pg-boss (workers/src/boss.ts)
        → Job Handlers (workers/src/jobs/*/index.ts)
        → Prisma Client (via @prisma/client directly)
        → AWS SDK v3 (STS, EC2, RDS, ECS, etc.)
```

**Import path aliases:**
- `@/` maps to `web-ui/` root (configured in `web-ui/tsconfig.json`)
- Always use `@/` for cross-directory imports in web-ui
- Relative imports only within the same directory
- Workers use `.js` extensions in imports (ESM: `import { foo } from './bar.js'`)

---

## Configuration Files

**TypeScript:**
- `tsconfig.json` — Root config (ES2020, commonjs, strict mode)
- `web-ui/tsconfig.json` — Next.js config (bundler moduleResolution, `@/` path alias)
- `workers/tsconfig.json` — Workers config (ESM, ES2022)
- `lambda/scheduler/tsconfig.json` — Scheduler Lambda config
- `lambda/kb_sync_processor/tsconfig.json` — KB sync Lambda config

**Next.js:**
- `web-ui/next.config.mjs` — Standalone output, MDX via fumadocs, webpack config
- `web-ui/tailwind.config.ts` — Tailwind CSS configuration
- `web-ui/postcss.config.mjs` — PostCSS with autoprefixer
- `web-ui/components.json` — shadcn/ui component configuration

**Database:**
- `prisma/schema.prisma` — Prisma schema (PostgreSQL, 30+ models)
- `docker-compose.yml` — Local PostgreSQL with pgvector
- `docker-compose.workers.yml` — Full local stack (postgres + migrate + workers)

**Testing:**
- `playwright.config.ts` — Playwright E2E config (auto-starts dev server)
- `web-ui/vitest.config.ts` — Web-UI Vitest config (if present)
- `workers/vitest.config.ts` — Workers Vitest config

**Linting:**
- `web-ui/.eslintrc.json` — ESLint extending next/core-web-vitals + next/typescript

**Infrastructure:**
- `infra/networking/Pulumi.yaml` — Networking stack config
- `infra/compute/Pulumi.yaml` — Compute stack config
- `infra/compute/Pulumi.prod.yaml` — Production stack secrets

**Environment:**
- `.env.example` — Root environment template
- `web-ui/.env.local.example` — Web-UI environment template
- `workers/.env.example` — Workers environment template
- `lambda/scheduler/.env.example` — Scheduler Lambda environment template

**Docker:**
- `docker-compose.yml` — Local PostgreSQL (pgvector:pg16)
- `docker-compose.workers.yml` — Local dev stack (postgres + prisma migrate + workers)
- `docker-compose.langfuse.yml` — Local Langfuse observability stack
- `workers/Dockerfile` — Worker container image

---

## Where to Add New Code

**New API endpoint:**
1. Create directory under `web-ui/app/api/<domain>/` with `route.ts`
2. Import service from `@/lib/<domain>-service.ts`
3. Call `authorize(action, subject)` from `@/lib/rbac/authorize` at the top
4. Return `NextResponse.json(data, { status: N })`

**New page:**
1. Create directory under `web-ui/app/app/<feature>/page.tsx`
2. Add `"use client"` directive if using hooks or browser APIs
3. Add route to sidebar in `web-ui/components/sidebar.tsx`

**New UI component:**
- Feature-specific: `web-ui/components/<domain>/kebab-case.tsx`
- Generic primitive: `web-ui/components/ui/` (rare — only for new Radix-based primitives)

**New service:**
1. Add `web-ui/lib/<domain>-service.ts` as a static class
2. Delegate persistence to repository via `web-ui/lib/db/repository-factory.ts`
3. Add client-side wrapper `web-ui/lib/client-<domain>-service.ts` if needed by React components

**New repository (database entity):**
1. Add model to `prisma/schema.prisma`
2. Create migration: `npx prisma migrate dev --name <name>`
3. Create `web-ui/lib/db/repositories/<entity>/interface.ts`
4. Create `web-ui/lib/db/repositories/<entity>/postgres.ts`
5. Create `web-ui/lib/db/repositories/<entity>/postgres.test.ts`
6. Add factory function to `web-ui/lib/db/repository-factory.ts`
7. If tenant-scoped, add model name to `TENANT_SCOPED_MODELS` in `web-ui/lib/db/pg-config.ts`

**New agent tool:**
1. Add to `web-ui/lib/agent/tools.ts` using `tool()` from `@langchain/core/tools`
2. Export and add to `assembleTools()` in `web-ui/lib/agent/model-factory.ts`

**New pg-boss worker job:**
1. Create `workers/src/jobs/<name>/index.ts` exporting `register(boss: PgBoss)`
2. Create queue, schedule cron (if needed), register handler
3. Import and call `register()` in `workers/src/index.ts`
4. Add producer call in web-ui via `getBoss().send(queueName, data)` from `web-ui/lib/boss-client.ts`

**New Pulumi resource:**
1. Add to `infra/compute/index.ts`
2. Run `pulumi preview --stack prod` before deploying

---

## Special Directories

**`.planning/codebase/`:**
- Purpose: GSD codebase analysis documents (ARCHITECTURE.md, STRUCTURE.md, etc.)
- Generated: By `/gsd:map-codebase` command
- Committed: Yes

**`web-ui/.next/`:**
- Purpose: Next.js build output
- Generated: Yes (`npm run build`)
- Committed: No

**`web-ui/node_modules/.prisma/client/`:**
- Purpose: Generated Prisma client (output configured in `prisma/schema.prisma`)
- Generated: Yes (`npx prisma generate`)
- Committed: No

**`prisma/migrations/`:**
- Purpose: Database migration history (25+ migrations)
- Generated: Yes (`npx prisma migrate dev`)
- Committed: Yes — required for `prisma migrate deploy` in production

**`workers/dist/`:**
- Purpose: Compiled worker JavaScript
- Generated: Yes (`tsc`)
- Committed: No

**`.claude/`:**
- Purpose: Claude Code agent definitions, plans, skills
- Generated: Partially (plans are generated; agents/skills are manually curated)
- Committed: Yes

**`.kiro/`:**
- Purpose: Kiro IDE configuration (agents, chats, plans, steering)
- Generated: Partially
- Committed: Yes

---

*Structure analysis: 2026-04-08*
