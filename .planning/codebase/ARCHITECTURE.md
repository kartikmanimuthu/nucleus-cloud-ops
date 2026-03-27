# Architecture

**Analysis Date:** 2026-03-26

## Pattern Overview

**Overall:** Modular monolith (Next.js full-stack) + event-driven serverless backend + Infrastructure-as-Code (AWS CDK v2)

**Key Characteristics:**
- Next.js App Router serves both UI pages and REST API routes from a single ECS Fargate container
- AI agent runs server-side inside the Next.js process using LangGraph StateGraph — no separate agent service
- AWS Lambda functions handle async/scheduled work (resource scheduling, discovery, vector processing, KB sync)
- All persistent state lives in DynamoDB (single-table design) or S3; no relational database
- Cross-account AWS operations use STS AssumeRole exclusively — no hardcoded credentials
- CDK manages all AWS infrastructure: two stacks (`NetworkingStack` → `ComputeStack`)

---

## Layers

**Infrastructure (CDK):**
- Purpose: Defines and provisions all AWS resources
- Location: `lib/`, `bin/`
- Contains: VPC/networking, ECS Fargate cluster, DynamoDB tables, Lambda functions, CloudFront, Cognito, S3 buckets, SQS queues, EventBridge rules
- Depends on: AWS CDK v2 constructs, `lib/config.ts` for env-driven configuration
- Key stacks: `lib/networkingStack.ts` → `lib/computeStack.ts` (dependency order must be preserved)

**Frontend + API Layer (Next.js App Router):**
- Purpose: Serves the React UI and handles all HTTP API requests
- Location: `web-ui/app/`
- Contains: Page components under `web-ui/app/app/`, REST API route handlers under `web-ui/app/api/`
- Depends on: Service layer (`web-ui/lib/*-service.ts`), agent layer (`web-ui/lib/agent/`), AWS SDK v3
- Deployed as: Docker container on ECS Fargate, fronted by CloudFront

**Service Layer:**
- Purpose: Business logic for each domain — accounts, schedules, audit, inventory, etc.
- Location: `web-ui/lib/`
- Key files: `account-service.ts`, `schedule-service.ts`, `audit-service.ts`, `schedule-execution-service.ts`, `tenant-config-service.ts`
- Pattern: Static classes (e.g. `AccountService.getAccounts()`); all DynamoDB access via `getDynamoDBDocumentClient()` from `aws-config.ts`
- Depends on: `web-ui/lib/aws-config.ts` for DynamoDB client + table names

**AI Agent Layer:**
- Purpose: LangGraph-powered AI agents for cloud operations tasks
- Location: `web-ui/lib/agent/`
- Three agent types:
  - `fast-agent.ts` — Reflection loop (generator → tools → reflector → revise), MAX_REFLECT_ITERATIONS=5
  - `planning-agent.ts` — Multi-step (planner → executor → reflector → reviser), MAX_ITERATIONS=30
  - `deep-agent.ts` — Extended thinking backed by `deepagents` library with MongoDB-compatible persistence
- Entry: `graph-factory.ts` exports `createFastGraph`, `createReflectionGraph`, `createDeepGraph`
- Shared: `agent-shared.ts` (state types, `ReflectionState`, `sanitizeMessagesForBedrock`), `model-factory.ts` (ChatBedrockConverse init, tool assembly), `persistence.ts` (DynamoDBSaver checkpointer + DynamoDBStore + DynamoDBChatMessageHistory)

**RBAC / Authorization Layer:**
- Purpose: Role-based access control for all mutating API routes
- Location: `web-ui/lib/rbac/`
- Pattern: Every mutating route calls `authorize(action, subject)` from `web-ui/lib/rbac/authorize.ts` before proceeding; uses CASL library for ABAC conditions
- Session: `getServerSession(authOptions)` or `getSessionUserId()` from `web-ui/lib/auth-session.ts`

**Lambda Functions (async/scheduled):**
- Purpose: Background processing independent of the web process
- Location: `lambda/`
- Four functions:
  - `lambda/scheduler/` (TypeScript) — Evaluates active schedules, starts/stops EC2/ECS/RDS resources cross-account via STS AssumeRole; triggered by EventBridge every 30 minutes
  - `lambda/discovery/` (Python) — Multi-account AWS resource discovery using parallel ThreadPoolExecutor; writes to DynamoDB inventory table and S3 `normalized/` prefix
  - `lambda/vector_processor/` (TypeScript + Python) — SQS-triggered; reads S3 `normalized/` objects, embeds with Amazon Titan v2, stores in S3 Vectors index
  - `lambda/kb_sync_processor/` (TypeScript) — Syncs knowledge base data sources to Bedrock KB

**UI Component Layer:**
- Purpose: React components for each domain
- Location: `web-ui/components/`
- Domain folders: `agent/`, `agent-ops/`, `inventory/`, `accounts/`, `schedules/`, `audit/`, `knowledge-base/`, `channels/`, `deep-agent/`
- Primitives: `web-ui/components/ui/` — Radix-based shadcn/ui components (do not modify)

---

## Data Flow

**User Chat (AI Agent):**
1. User submits message in `web-ui/components/agent/chat-interface.tsx`
2. POST to `web-ui/app/api/chat/route.ts`
3. Route resolves session via `getSessionUserId()`, acquires per-thread lock (prevents duplicate LangGraph executions)
4. Selects graph mode (`fast` / `plan` / `deep`) and calls `createFastGraph` / `createReflectionGraph` / `createDeepGraph` from `graph-factory.ts`
5. Graph executes with tools (shell, file I/O, AWS credentials, MCP) against AWS accounts via STS AssumeRole
6. Response streams back as `UIMessageChunk` events (Vercel AI SDK format); phase markers (`PLANNING_PHASE_START`, `EXECUTION_PHASE_START`, etc.) annotate reasoning vs. output
7. New messages persisted to `DYNAMODB_CHAT_HISTORY_TABLE` after stream completes

**Inventory Discovery → Ask AI (RAG):**
1. Discovery Lambda (`lambda/discovery/`) runs periodically or on-demand; scans all active AWS accounts
2. Writes normalized JSON to S3 `normalized/` prefix
3. S3 event → SQS → Vector Processor Lambda embeds resources with Titan Embed v2; stores vectors in S3 Vectors bucket
4. User queries inventory via `web-ui/app/api/ask-ai/route.ts`
5. Route embeds question, queries S3 Vectors index, fetches matching resources, passes context to Claude for answer
6. Streaming response returned to `web-ui/components/inventory/ask-ai-dialog.tsx`

**Schedule Execution:**
1. EventBridge rule fires every 30 minutes → Scheduler Lambda (`lambda/scheduler/`)
2. Lambda reads active schedules from DynamoDB (`SCHEDULE#<id>` + `RESOURCE#<arn>` items)
3. For each resource, assumes cross-account role (`CrossAccountRoleForCostOptimizationScheduler`) via STS
4. Starts or stops EC2 instances, ECS services, RDS clusters based on cron windows
5. Writes execution result to audit table (`NucleusAuditTable`)

**State Management:**
- LangGraph thread state: DynamoDBSaver checkpointer (DYNAMODB_CHECKPOINT_TABLE + DYNAMODB_WRITES_TABLE), with optional S3 offload for large checkpoints
- Long-term agent memory: DynamoDBStore with Bedrock embeddings (DYNAMODB_MEMORY_TABLE), 90-day TTL
- Chat session history: DynamoDBChatMessageHistory (DYNAMODB_CHAT_HISTORY_TABLE), 30-day TTL
- App config state (accounts, schedules): NucleusAppTable (single-table design, GSI1/GSI2/GSI3)
- Audit logs: NucleusAuditTable (immutable, 30-day TTL via `expire_at`)

---

## Key Design Patterns

**LangGraph Reflection Loop:**
All agent types use a state machine graph. The planning agent's loop: `planner → generate → tools (ToolNode) → reflect → revise → final`. Nodes are LangGraph graph nodes; tool execution is a built-in `ToolNode`. State is typed via `graphState` channels in `agent-shared.ts`.

**Human-in-the-Loop (HITL):**
When `autoApprove=false`, the agent emits `tool-input-available` events and pauses; the UI shows an approval dialog. User approval/rejection is sent back as a `tool` role message. The API resumes the graph via `graph.updateState()`.

**DynamoDB Single-Table Design:**
NucleusAppTable, NucleusAuditTable, and NucleusInventoryTable all use `pk` + `sk` as primary keys with GSI1/GSI2/GSI3 for secondary access patterns. Always use `@aws-sdk/lib-dynamodb` (DocumentClient). Entity patterns are documented in `docs/schema-design.md`.

**Service Layer Pattern:**
All business logic behind static service classes. API routes import from `@/lib/<domain>-service.ts` and never access DynamoDB directly.

**MCP (Model Context Protocol):**
Agents dynamically load MCP tools at runtime via `mcp-manager.ts`. MCP server definitions live in `mcp-config.ts`. AWS credentials are injected into credential-sensitive servers. This allows extending agent capabilities without code changes.

**RBAC (CASL-based):**
Roles are stored in DynamoDB. Every API route calls `authorize()` before business logic. Client-side ability context uses `AbilityContext.tsx` from `web-ui/lib/rbac/`.

---

## Entry Points

**Web UI (Next.js):**
- Location: `web-ui/app/layout.tsx`
- Triggers: HTTP request to ECS Fargate container
- Responsibilities: Wraps all pages in `ThemeProvider`, `ThemeConfigProvider`, `LayoutWrapper`, NextAuth `Providers`

**AI Chat API:**
- Location: `web-ui/app/api/chat/route.ts`
- Triggers: POST from chat UI component
- Responsibilities: Auth, thread lock, graph selection, streaming, DynamoDB message persistence

**Ask AI (RAG) API:**
- Location: `web-ui/app/api/ask-ai/route.ts`
- Triggers: POST from inventory Ask AI dialog
- Responsibilities: Embed question, query S3 Vectors, fetch DynamoDB resources, stream answer via Claude

**Scheduler Lambda:**
- Location: `lambda/scheduler/src/index.ts`
- Triggers: EventBridge cron (every 30 min) or manual invocation
- Responsibilities: Full or partial schedule scan, STS AssumeRole, resource start/stop

**Discovery Lambda:**
- Location: `lambda/discovery/src/main.py`
- Triggers: ECS task or scheduled invocation
- Responsibilities: Multi-account parallel resource scan, DynamoDB inventory writes, S3 normalized output

**CDK App:**
- Location: `bin/cdkStack.ts`
- Triggers: `cdk deploy` / `cdk synth`
- Responsibilities: Instantiates `NetworkingStack` then `ComputeStack` with config from env vars

---

## Error Handling

**Strategy:** Catch-and-return pattern in API routes; let LangGraph handle agent-level retries

**Patterns:**
- API routes: `try/catch` → `NextResponse.json({ error }, { status: 5xx })`
- Agent stream: Abort errors (client disconnect) handled silently; real errors logged and propagated via `controller.error()`
- Lambda: Top-level try/catch in handler returns `{ success: false, errors: [...] }` SchedulerResult
- DynamoDB: `handleDynamoDBError()` utility in `web-ui/lib/aws-config.ts` maps DynamoDB error codes to user-friendly messages

---

## Cross-Cutting Concerns

**Logging:** `console.log` / `console.error` throughout; Lambda scheduler uses `logger` utility from `lambda/scheduler/src/utils/logger.ts`; Langfuse optional tracing for agent calls via `langfuse-config.ts`

**Validation:** Zod schemas on tool inputs (LangChain `DynamicStructuredTool`); RBAC authorization guard before all mutations

**Authentication:** NextAuth.js with Cognito User Pool as provider; session resolved server-side via `getServerSession(authOptions)` from `web-ui/lib/auth-options.ts`; user ID stored as `USER#<sub>` prefix

**Multi-tenancy:** `DEFAULT_TENANT_ID` env var; tenant-aware PK patterns (`TENANT#<id>`) in account service; `tenant-config-service.ts` for per-tenant settings

---

*Architecture analysis: 2026-03-26*
