# Codebase Structure

**Analysis Date:** 2026-03-26

## Directory Layout

```
nucleus-cloud-ops/
├── bin/                          # CDK app entry point
│   └── cdkStack.ts               # Instantiates NetworkingStack + ComputeStack
├── lib/                          # CDK stack definitions
│   ├── config.ts                 # Env-driven config loader (AppConfig interface)
│   ├── networkingStack.ts        # VPC, subnets, security groups
│   ├── computeStack.ts           # ECS Fargate, ALB, CloudFront, DynamoDB tables, Lambdas, Cognito
│   ├── webUIStack.ts             # (legacy) S3+CloudFront static deploy — currently inactive
│   └── cdkStack.ts               # (legacy) original scheduler-only stack — currently inactive
├── web-ui/                       # Next.js 15 application (frontend + API)
│   ├── app/                      # Next.js App Router
│   │   ├── layout.tsx            # Root layout (ThemeProvider, NextAuth Providers)
│   │   ├── page.tsx              # Root redirect
│   │   ├── globals.css           # Global Tailwind CSS
│   │   ├── login/                # Login page
│   │   ├── app/                  # Authenticated app pages (all feature routes)
│   │   │   ├── dashboard/        # Dashboard page
│   │   │   ├── accounts/         # AWS Account management
│   │   │   ├── agent/            # AI agent chat interface
│   │   │   ├── agent-ops/        # AgentOps management (runs, scheduled tasks)
│   │   │   ├── audit/            # Audit log viewer
│   │   │   ├── channels/         # Notification channels (Slack, Jira)
│   │   │   ├── deep-agent/       # Deep Agent interface
│   │   │   ├── inventory/        # Resource inventory viewer
│   │   │   ├── knowledge-base/   # Knowledge base management
│   │   │   ├── schedules/        # Schedule management
│   │   │   ├── settings/         # App settings
│   │   │   └── unauthorized/     # 403 page
│   │   ├── api/                  # REST API routes (Next.js route handlers)
│   │   │   ├── accounts/         # CRUD for AWS accounts + scan/validate
│   │   │   ├── agent-ops/        # AgentOps run management + scheduled tasks
│   │   │   ├── ask-ai/           # RAG-based inventory Q&A (S3 Vectors + Bedrock)
│   │   │   ├── audit/            # Audit log queries + stats
│   │   │   ├── auth/             # NextAuth.js [...nextauth] handler
│   │   │   ├── chat/             # LangGraph agent streaming (POST)
│   │   │   ├── deep-agent/       # Deep agent chat + thread management
│   │   │   ├── enhance-prompt/   # Prompt enhancement utility
│   │   │   ├── health/           # Health check endpoint
│   │   │   ├── inventory/        # Resource inventory CRUD + export + sync
│   │   │   ├── knowledge-base/   # KB CRUD + source sync + query
│   │   │   ├── mcp-servers/      # MCP server listing
│   │   │   ├── scheduler/        # Scheduler execution + settings
│   │   │   ├── schedules/        # Schedule CRUD + execute + history + toggle
│   │   │   ├── skills/           # Skill listing
│   │   │   ├── threads/          # Chat thread history
│   │   │   ├── v1/trigger/       # External webhook triggers (API, Jira, Slack)
│   │   │   └── admin/            # Admin user management
│   │   └── (docs)/               # Fumadocs documentation pages
│   ├── components/               # React UI components
│   │   ├── ui/                   # Radix-based primitives (shadcn/ui — do not modify)
│   │   ├── agent/                # Chat interface, thread sidebar, tab bar
│   │   ├── agent-ops/            # AgentOps panels and run viewers
│   │   ├── ai-elements/          # Shared AI response rendering
│   │   ├── inventory/            # Inventory table, Ask AI dialog, source citations
│   │   ├── accounts/             # Account cards, forms
│   │   ├── schedules/            # Schedule forms and list
│   │   ├── audit/                # Audit log tables
│   │   ├── knowledge-base/       # KB management UI
│   │   ├── channels/             # Slack/Jira channel config
│   │   ├── deep-agent/           # Deep agent UI
│   │   ├── dashboard/            # Dashboard widgets
│   │   ├── settings/             # Settings panels
│   │   ├── auth/                 # Auth-related components
│   │   ├── sidebar.tsx           # App navigation sidebar
│   │   ├── auth-guard.tsx        # Route-level auth guard
│   │   ├── layout-wrapper.tsx    # Sidebar + content layout
│   │   ├── schedule-form.tsx     # Shared schedule form
│   │   └── theme-*.tsx           # Theme provider + toggle
│   ├── lib/                      # Business logic and shared utilities
│   │   ├── agent/                # AI agent implementation (LangGraph)
│   │   │   ├── fast-agent.ts     # Reflection loop agent (MAX_REFLECT_ITERATIONS=5)
│   │   │   ├── planning-agent.ts # Multi-step planning agent (MAX_ITERATIONS=30)
│   │   │   ├── deep-agent.ts     # Deep agent (extended thinking, deepagents lib)
│   │   │   ├── graph-factory.ts  # Exports createFastGraph, createReflectionGraph, createDeepGraph
│   │   │   ├── agent-shared.ts   # ReflectionState, graphState, sanitizeMessagesForBedrock
│   │   │   ├── model-factory.ts  # ChatBedrockConverse init, assembleTools()
│   │   │   ├── persistence.ts    # DynamoDBSaver, DynamoDBStore, DynamoDBChatMessageHistory singletons
│   │   │   ├── tools.ts          # Tool definitions (execute_command, read_file, glob, grep, S3, AWS)
│   │   │   ├── prompt-templates.ts # Reusable prompt fragments
│   │   │   ├── mcp-config.ts     # MCP server definitions
│   │   │   ├── mcp-manager.ts    # MCP server lifecycle
│   │   │   ├── mcp-tools.ts      # LangChain tool wrappers for MCP
│   │   │   ├── aws-credentials-tool.ts  # STS credential injection for agent
│   │   │   ├── langfuse-config.ts       # Optional Langfuse tracing
│   │   │   ├── session-manager.ts       # Agent session management
│   │   │   ├── sandbox.ts               # Execution sandbox
│   │   │   ├── file-saver.ts            # File output utilities
│   │   │   └── skills/                  # Skill markdown files + loader
│   │   ├── rbac/                 # Role-based access control
│   │   │   ├── authorize.ts      # `authorize(action, subject)` helper for API routes
│   │   │   ├── abilities.ts      # CASL ability definitions per role
│   │   │   ├── server-ability.ts # Server-side ability builder
│   │   │   ├── role-service.ts   # DynamoDB role lookups
│   │   │   ├── types.ts          # Actions, Subjects types
│   │   │   ├── index.ts          # Re-exports
│   │   │   └── AbilityContext.tsx # Client-side ability React context
│   │   ├── db/                   # Database adapters
│   │   │   ├── agent-chat-history-store.ts  # DynamoDB chat history store
│   │   │   └── mongo-client.ts              # MongoDB client (deep agent)
│   │   ├── store/                # In-process stores
│   │   │   └── thread-store.ts   # In-memory thread store (fallback without DynamoDB)
│   │   ├── account-service.ts    # AWS account CRUD + STS validation
│   │   ├── audit-service.ts      # Audit log reads/writes
│   │   ├── schedule-service.ts   # Schedule CRUD
│   │   ├── schedule-execution-service.ts  # Schedule trigger + history
│   │   ├── tenant-config-service.ts       # Per-tenant settings
│   │   ├── aws-config.ts         # DynamoDB client + table name exports
│   │   ├── auth-options.ts       # NextAuth.js authOptions (Cognito provider)
│   │   ├── auth-session.ts       # `getSessionUserId()` helper
│   │   ├── resource-types.ts     # AWS resource type definitions
│   │   ├── types.ts              # Shared TypeScript types
│   │   ├── utils.ts              # `cn()` utility (Tailwind class merge)
│   │   ├── date-utils.ts         # Date formatting helpers
│   │   ├── cf-template-generator.ts  # CloudFormation template generator
│   │   ├── client-account-service.ts # Client-side account API wrapper
│   │   ├── client-schedule-service.ts # Client-side schedule API wrapper
│   │   └── client-audit-service*.ts  # Client-side audit API wrappers
│   └── hooks/                    # Custom React hooks
├── lambda/                       # Lambda functions
│   ├── scheduler/                # TypeScript: EventBridge-triggered resource scheduler
│   │   └── src/
│   │       ├── index.ts          # Lambda handler (full scan / partial scan)
│   │       ├── services/         # Scheduler business logic
│   │       ├── resource-schedulers/ # Per-resource-type schedulers (EC2, ECS, RDS, ASG)
│   │       ├── types/            # TypeScript types
│   │       └── utils/            # Logger, helpers
│   ├── discovery/                # Python: Multi-account resource discovery
│   │   └── src/
│   │       ├── main.py           # ECS task entry point
│   │       ├── inventory_runner.py # Parallel resource scanning
│   │       ├── data_processor.py # DynamoDB writes + S3 normalized output
│   │       ├── config_generator.py # Scan configuration builder
│   │       └── audit_logger.py   # Audit log writer
│   ├── vector_processor/         # TypeScript+Python: S3→SQS→embed→S3 Vectors pipeline
│   │   └── src/
│   │       ├── index.ts          # SQS Lambda handler
│   │       ├── resource-text.ts  # Resource → embeddable text converter
│   │       ├── index.py          # Python embedding handler (Titan v2)
│   │       └── vector_utils.py   # S3 Vectors API utilities
│   └── kb_sync_processor/        # TypeScript: Bedrock Knowledge Base sync
│       └── src/
│           └── index.ts          # KB sync Lambda handler
├── test/                         # CDK Jest tests
├── tests/                        # E2E Playwright tests
│   └── e2e/                      # Playwright specs + page objects
├── docs/                         # Architecture documentation
│   ├── schema-design.md          # DynamoDB single-table schema (MUST READ before adding entities)
│   ├── agent-ops/                # AgentOps architecture docs
│   ├── deepagents/               # Deep agent documentation
│   └── diagram-as-code/          # Architecture diagrams
├── .claude/                      # Claude Code config (agents, plans, skills)
├── .planning/                    # GSD planning documents
│   └── codebase/                 # Codebase analysis docs (this directory)
├── bin/cdkStack.ts               # CDK app entry point
├── cdk.json                      # CDK app config + feature flags
├── cdk.context.json              # CDK context cache (VPC/AZ lookups — commit this)
├── tsconfig.json                 # Root TypeScript config (CDK)
├── package.json                  # Root deps (CDK, Jest, esbuild)
├── playwright.config.ts          # Playwright E2E config
└── docker-compose.langfuse.yml   # Local Langfuse tracing setup
```

---

## Module Breakdown

**`bin/`** — CDK entry point. Reads config, instantiates stacks in dependency order. Do not add business logic here.

**`lib/`** — CDK stack definitions only. `computeStack.ts` is the primary stack (65KB); it provisions DynamoDB tables, ECS Fargate, ALB, CloudFront, Cognito, Lambda functions, SQS, S3, EventBridge. Run `cdk diff` before modifying `computeStack.ts` or `networkingStack.ts`.

**`web-ui/app/api/`** — Every subdirectory is an API route. Route handlers are thin: they authorize, call a service or agent, and return `NextResponse.json(...)`. No business logic inside route files.

**`web-ui/app/app/`** — Authenticated page components. Each subdirectory is a feature (accounts, schedules, inventory, etc.).

**`web-ui/lib/agent/`** — The AI agent brain. All three agents share `agent-shared.ts` state, `model-factory.ts` model/tool assembly, and `persistence.ts` DynamoDB singletons. New agent behavior goes here; tools go in `tools.ts`; new MCP servers go in `mcp-config.ts`.

**`web-ui/lib/rbac/`** — Authorization layer. Every API route that mutates state must call `authorize()` from this module. Roles stored in DynamoDB; ability rules in `abilities.ts`.

**`web-ui/components/ui/`** — Radix-based primitives (Button, Dialog, Table, etc.). These are shadcn/ui style — do not modify. Consume them; don't change them.

**`web-ui/components/<domain>/`** — Feature-specific React components. Each domain folder matches the corresponding `app/app/<domain>/` page.

**`lambda/scheduler/`** — TypeScript Lambda. Triggered every 30 min by EventBridge. Reads DynamoDB schedules, assumes cross-account roles, executes resource start/stop. Tests via Vitest at `lambda/scheduler/`.

**`lambda/discovery/`** — Python ECS task. Parallel multi-account scan using ThreadPoolExecutor. Outputs normalized JSON to S3. No Vitest/pytest tests present.

**`lambda/vector_processor/`** — Hybrid TypeScript+Python. SQS-triggered. Converts S3 normalized resources to embeddings and writes to S3 Vectors index for RAG.

**`lambda/kb_sync_processor/`** — TypeScript Lambda. Syncs external data sources to Bedrock Knowledge Base.

**`docs/`** — Architecture documentation. `schema-design.md` is authoritative for DynamoDB entity patterns — consult before adding any new entity.

**`tests/e2e/`** — Playwright end-to-end tests. Auto-starts dev server via `playwright.config.ts` `webServer` config.

---

## Entry Points

**Browser → Next.js:**
- Root layout: `web-ui/app/layout.tsx`
- App pages root: `web-ui/app/app/` (each subdirectory = a route)
- Login: `web-ui/app/login/`

**Agent Chat:**
- API: `web-ui/app/api/chat/route.ts`
- Graph factory: `web-ui/lib/agent/graph-factory.ts`

**Inventory Ask AI:**
- API: `web-ui/app/api/ask-ai/route.ts`

**Scheduler Lambda:**
- Handler: `lambda/scheduler/src/index.ts`

**Discovery:**
- Handler: `lambda/discovery/src/main.py`

**CDK Deploy:**
- Entry: `bin/cdkStack.ts` → `lib/computeStack.ts`

---

## Naming Conventions

**Files:**
- Next.js route handlers: `route.ts` (colocated with route segment directory)
- Next.js pages: `page.tsx`
- Service classes: `<domain>-service.ts` (e.g. `account-service.ts`)
- Client-side API wrappers: `client-<domain>-service.ts`
- React components: `kebab-case.tsx`
- Lambda handlers: `index.ts` (TypeScript) or `main.py` (Python)

**Directories:**
- API routes: match the URL path (e.g. `app/api/accounts/[accountId]/scan/`)
- Feature pages: kebab-case matching domain (e.g. `app/app/agent-ops/`)
- Component domains: kebab-case matching page domains

---

## Where to Add New Code

**New API endpoint:**
- Create directory under `web-ui/app/api/<domain>/` with `route.ts`
- Import service from `@/lib/<domain>-service.ts`
- Call `authorize()` from `@/lib/rbac/authorize` at the top

**New page:**
- Create directory under `web-ui/app/app/<feature>/page.tsx`
- Wrap with `AuthGuard` from `@/components/auth-guard`

**New UI component:**
- Place in `web-ui/components/<domain>/` if feature-specific
- Place in `web-ui/components/ui/` only if it's a new generic primitive (rare)

**New service:**
- Add `web-ui/lib/<domain>-service.ts` as a static class
- Import `getDynamoDBDocumentClient()` and table names from `@/lib/aws-config`
- Add client-side wrapper `web-ui/lib/client-<domain>-service.ts` if needed by React components

**New agent tool:**
- Add to `web-ui/lib/agent/tools.ts` using `tool()` from `@langchain/core/tools`
- Export and add to `assembleTools()` in `web-ui/lib/agent/model-factory.ts`

**New DynamoDB entity:**
- Read `docs/schema-design.md` first
- Define PK/SK pattern following existing `ENTITY#<id>` convention
- Add GSI if required (GSI1/GSI2/GSI3 already provisioned)
- Update `docs/schema-design.md` with the new pattern

**New Lambda function:**
- Create directory under `lambda/<name>/`
- Register it in `lib/computeStack.ts` (Lambda construct + IAM role + EventBridge/SQS trigger)
- TypeScript: use esbuild bundling; Python: include `requirements.txt`

**New CDK resource:**
- Add to `lib/computeStack.ts`
- Run `npx cdk diff --profile PLATFORM-ADMIN` before deploying

---

## Special Directories

**`.planning/codebase/`:**
- Purpose: GSD codebase analysis documents
- Generated: By `/gsd:map-codebase` command
- Committed: Yes

**`cdk.out/`:**
- Purpose: Synthesized CloudFormation templates
- Generated: Yes (`cdk synth`)
- Committed: No (in `.gitignore`)

**`web-ui/.next/`:**
- Purpose: Next.js build output
- Generated: Yes (`npm run build`)
- Committed: No

**`.claude/`:**
- Purpose: Claude Code agent definitions, plans, skills
- Generated: Partially (plans are generated; agents/skills are manually curated)
- Committed: Yes

---

*Structure analysis: 2026-03-26*
