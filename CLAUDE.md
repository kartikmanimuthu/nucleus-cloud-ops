# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Nucleus Cloud Ops

AWS Cloud Operations Platform — multi-account resource scheduling + AI Ops agent powered by AWS Bedrock.

## Stack

| Layer          | Tech                                                       |
| -------------- | ---------------------------------------------------------- |
| Frontend       | Next.js 15, React 19, Tailwind CSS, Radix UI               |
| AI Agent       | LangGraph, LangChain, AWS Bedrock (Claude 4.5 Sonnet), MCP |
| Infrastructure | Pulumi (networking + compute), ECS Fargate, CloudFront     |
| Database       | PostgreSQL via Prisma ORM (pgvector enabled)               |
| Auth           | NextAuth.js (Cognito + Credentials)                        |
| Testing        | Vitest (web-ui, workers), Jest (root), Playwright (E2E)    |

## Key Commands

```bash
# Setup
export AWS_PROFILE=PLATFORM-ADMIN

# Local database (required before dev)
docker compose up -d postgres          # starts pgvector/pgvector:pg16 on :5432

# Local development — dev server runs on port 3001 (not 3000)
cd web-ui && npm run dev               # auto-runs prisma migrate deploy first

# Database
cd web-ui && npm run db:migrate        # create + apply new migration
cd web-ui && npm run db:generate       # regenerate Prisma client after schema change
cd web-ui && npm run db:studio         # Prisma Studio UI

# Workers
cd workers && npm run dev              # pg-boss worker process (tsx --watch)

# Testing
cd web-ui && npm run test              # Vitest (web-ui)
cd workers && npm run test             # Vitest (workers)
npm test                               # Jest (root)
cd lambda/scheduler && npm run test    # Vitest (scheduler Lambda)

# Linting
cd web-ui && npm run lint
cd lambda/scheduler && npm run lint

# Build
cd web-ui && npm run build
npm run build                          # Compile TypeScript (root)

# Deploy — always networking first, then compute
cd infra/networking && AWS_PROFILE=PLATFORM-ADMIN pulumi up --stack prod --yes
cd infra/compute && AWS_PROFILE=PLATFORM-ADMIN pulumi up --stack prod --yes
cd infra/compute && AWS_PROFILE=PLATFORM-ADMIN pulumi preview --stack prod  # preview first
```

## Environment Setup

```bash
# 1. Install dependencies
npm install && cd web-ui && npm install && cd ../workers && npm install

# 2. Configure environment
cp web-ui/.env.local.example web-ui/.env.local
# Required: DATABASE_URL, AWS_REGION, NEXTAUTH_SECRET, COGNITO_USER_POOL_ID, COGNITO_USER_POOL_CLIENT_ID
# Optional (AI agent): TAVILY_API_KEY, LANGFUSE_* vars

# 3. Start Postgres and run migrations
docker compose up -d postgres
cd web-ui && npm run db:migrate
```

## Project Structure

```
nucleus-cloud-ops/
├── web-ui/
│   ├── app/              # Next.js App Router — pages under app/app/, API routes under app/api/
│   ├── components/       # React UI components, organized by domain
│   ├── lib/
│   │   ├── agent/        # LangGraph AI agents (fast, planning, deep)
│   │   ├── db/           # Prisma client, repository factory, per-domain repositories
│   │   └── rbac/         # CASL-based RBAC (authorize.ts, types.ts)
│   └── hooks/            # Custom React hooks
├── workers/              # pg-boss background job workers
│   └── src/jobs/         # scheduler/, discovery/, kb-sync/
├── prisma/
│   ├── schema.prisma     # Single source of truth for all models
│   └── seed.ts           # Database seed
├── lambda/               # Lambda functions (scheduler, discovery, vector_processor, kb_sync_processor)
├── infra/
│   ├── networking/       # Pulumi: VPC, subnets
│   └── compute/          # Pulumi: ECS, Lambda, RDS, Cognito, CloudFront
├── tests/e2e/            # Playwright E2E tests
└── docs/                 # Architecture, schema design, PRD
```

## Database — PostgreSQL + Prisma

All persistent state is in PostgreSQL. DynamoDB has been fully removed.

- Schema: `prisma/schema.prisma` — single source of truth for all models
- Prisma client output: `web-ui/node_modules/.prisma/client` (web-ui) and `workers/node_modules/.prisma/client` (workers) — run `db:generate` in both after schema changes
- Connection pool: `connection_limit=10` for ECS (web-ui), `connection_limit=3` for Lambda (set in `DATABASE_URL` query param)

**Multi-tenant safety** — every query must be scoped to a tenant:

```typescript
// Always use getTenantClient(), never getPrismaClient() directly in business logic
import { getTenantClient } from '@/lib/db/pg-config';
const db = getTenantClient(tenantId);
await db.account.findMany(); // automatically adds WHERE tenant_id = tenantId
```

**Repository pattern** — never call Prisma directly from services or API routes:

```typescript
import { getAccountRepository } from '@/lib/db/repository-factory';
const repo = getAccountRepository();
await repo.listByTenant(tenantId);
```

Repositories live in `web-ui/lib/db/repositories/<domain>/` with `interface.ts` + `postgres.ts`.

**Gotcha:** `$executeRaw` is NOT intercepted by the tenant extension — callers must manually add `WHERE tenant_id = $1`.

## Agent Architecture

Three agent types in `web-ui/lib/agent/`, all entered via `graph-factory.ts`:

- **fast-agent.ts** — Reflection loop (generator → tools → reflector → revise), `MAX_REFLECT_ITERATIONS=5`
- **planning-agent.ts** — Multi-step (planner → executor → reflector → reviser), `MAX_ITERATIONS=30`
- **deep-agent.ts** — Extended thinking with MongoDB persistence

Key shared modules:

| File                | Purpose                                                                    |
| ------------------- | -------------------------------------------------------------------------- |
| `agent-shared.ts`   | `ReflectionState`, `sanitizeMessagesForBedrock()`                          |
| `model-factory.ts`  | `ChatBedrockConverse` init, tool assembly                                  |
| `tools.ts`          | Tool definitions (execute_command, read_file, write_file, glob, grep, S3)  |
| `prompt-templates.ts` | Reusable prompt fragments (`CORE_PRINCIPLES`, `buildBaseIdentity`, etc.) |
| `mcp-manager.ts`    | MCP server lifecycle (connect/disconnect, credential injection)            |
| `persistence.ts`    | LangGraph checkpointer + chat history (PostgreSQL-backed)                  |

Tool definition pattern:

```typescript
import { tool } from '@langchain/core/tools';
export const myTool = tool(
  async ({ param }: { param: string }) => { ... },
  { name: 'my_tool', description: '...', schema: z.object({ param: z.string() }) }
);
```

**Critical:** Sanitize messages before every Bedrock call — orphaned `tool_call` IDs without a matching `tool_result` cause `ValidationException`. Use `sanitizeMessagesForBedrock()` from `agent-shared.ts`.

## Workers (pg-boss)

Background jobs run in `workers/` as a single Node.js process using pg-boss:

- `workers/src/jobs/scheduler/` — resource start/stop scheduling
- `workers/src/jobs/discovery/` — multi-account resource scanning
- `workers/src/jobs/right-sizing/` — CloudWatch-based right-sizing analysis: per-tenant fan-out scan + weekly pricing refresh. Pure engine + per-type rules (EC2/RDS/EBS/ASG) under `services/`+`rules/`; raw-pg writers (manually tenant-scoped). Gated by `RIGHT_SIZING_ENABLED`. Web-ui side: `/api/right-sizing/*`, `lib/right-sizing-service.ts`, `RightSizing` RBAC subject (→ Inventory module), models `RightSizingRecommendation`/`RightSizingRun`/`PricingCatalogEntry` (the last is global, not tenant-scoped)
- `workers/src/jobs/kb-sync/` — knowledge base sync (S3, Bitbucket, Confluence)
- Workers use `createLogger('service-name')` from `workers/src/lib/logger.ts` — not raw `console`
- web-ui submits jobs via `boss-client.ts`; per-tenant cron via `GET/PUT /api/settings/scheduler`

## API Route Conventions

- **Auth/RBAC**: `authorize(action, Subject)` from `@/lib/rbac/authorize` on every mutating route
- **Data access**: use repository factory (`@/lib/db/repository-factory`), not Prisma directly
- **Responses**: `NextResponse.json({ success: true, data }, { status: N })` or `{ success: false, error: string }`
- **Session**: `getServerSession(authOptions)` or `getSessionUserId()` from `@/lib/auth-session`
- **Audit**: every action modifying AWS resources must call `AuditService` from `@/lib/audit-service`

## Component Patterns

- UI primitives in `web-ui/components/ui/` — Radix-based, shadcn/ui style (do not modify these)
- Feature components organized by domain: `agent/`, `agent-ops/`, `inventory/`, `schedules/`, `accounts/`, `audit/`, `knowledge-base/`, `channels/`, `deep-agent/`
- Use `@/` path alias for all imports (maps to `web-ui/`)
- Conditional Tailwind: `cn()` utility from `@/lib/utils`

## Lambda Runtimes

Four Lambda functions with different runtimes:

| Directory                     | Language            | Build   | Tests  |
| ----------------------------- | ------------------- | ------- | ------ |
| `lambda/scheduler/`         | TypeScript          | esbuild | Vitest |
| `lambda/discovery/`         | Python              | —      | —     |
| `lambda/vector_processor/`  | Python + TypeScript | —      | —     |
| `lambda/kb_sync_processor/` | TypeScript          | tsc     | —     |

## Testing Conventions

- **web-ui**: `cd web-ui && npm run test` — runs Vitest once (`vitest run`, not watch mode)
- **root**: `npm test` at root — Jest with ts-jest
- **Lambda scheduler**: `cd lambda/scheduler && npm run test` — own Vitest setup
- Test files: `*.test.ts` colocated with source or in `tests/` subdirectory
- Property-based tests use `fast-check` (see `web-ui/tests/agent-ops/`)

## E2E Testing with Playwright

### Setup & Config

Config lives at `playwright.config.ts` (root). Tests live in `tests/e2e/`. The dev server auto-starts via `webServer` config.

```bash
# Run all E2E tests (starts dev server automatically)
npx playwright test

# Run a specific test file
npx playwright test tests/e2e/accounts.spec.ts      # AWS Accounts module (60 tests)
npx playwright test tests/e2e/navigation.spec.ts    # App navigation flows
npx playwright test tests/e2e/marketing.spec.ts     # Marketing/landing page
npx playwright test tests/e2e/docs.spec.ts          # Documentation pages

# Run in headed mode (see the browser)
npx playwright test --headed

# Run with UI mode (interactive debugger)
npx playwright test --ui

# Show last HTML report
npx playwright show-report

# Generate test code interactively (codegen)
npx playwright codegen http://localhost:3001
```

### Using Playwright MCP for Testing

The Playwright MCP server (configured in `.mcp.json`) lets Claude Code interact with the running app directly. Use it to:

- Inspect live UI state before writing assertions
- Debug failing tests by navigating to the page and taking snapshots
- Verify selectors before committing them to test files

Workflow: start the dev server manually (`cd web-ui && npm run dev`), then use Playwright MCP tools to explore the page, then write the test.

### Test File Conventions

- Files: `tests/e2e/<feature>.spec.ts`
- Group related tests with `test.describe('<Feature>')`
- Use `test.beforeEach` for shared navigation/setup
- One assertion focus per test — don't test multiple features in one test

### Locator Best Practices

**Prefer** (in order):

1. `page.getByRole('button', { name: 'Send' })` — semantic, resilient
2. `page.getByTestId('ask-ai-input')` — add `data-testid` to components when needed
3. `page.getByLabel('Search')` — for form inputs
4. `page.getByText('Ask AI about your inventory')` — for visible text

**Avoid:**

- CSS selectors like `.btn-primary` — break on style changes
- XPath — brittle and unreadable
- `:has-text()` pseudo-selectors — use `getByText()` instead

### Waiting & Async

**Never use `waitForTimeout`** — it makes tests slow and flaky. Use explicit waits instead:

```typescript
// BAD
await page.waitForTimeout(3000);

// GOOD — wait for a specific element or network state
await expect(page.getByRole('region', { name: 'AI Response' })).toBeVisible();
await page.waitForResponse(resp => resp.url().includes('/api/ask-ai'));
await page.waitForLoadState('networkidle');
```

### Page Object Pattern

For complex pages, extract a Page Object in `tests/e2e/pages/`:

```typescript
// tests/e2e/pages/inventory-page.ts
export class InventoryPage {
  constructor(private page: Page) {}

  async goto() {
    await this.page.goto('/inventory');
    await this.page.waitForLoadState('networkidle');
  }

  async openAskAI() {
    await this.page.getByRole('button', { name: 'Ask AI' }).click();
    await expect(this.page.getByRole('dialog')).toBeVisible();
  }

  async askQuestion(question: string) {
    await this.page.getByRole('textbox', { name: 'Ask a question' }).fill(question);
    await this.page.getByRole('button', { name: 'Send' }).click();
  }
}
```

### Auth in E2E Tests

The app uses NextAuth. For tests that require auth, use `storageState` to reuse a logged-in session:

```typescript
// tests/e2e/auth.setup.ts — run once, save session
import { test as setup } from '@playwright/test';
setup('authenticate', async ({ page }) => {
  await page.goto('/api/auth/signin');
  // ... fill credentials
  await page.context().storageState({ path: 'tests/e2e/.auth/user.json' });
});
```

Then reference in `playwright.config.ts` via `storageState: 'tests/e2e/.auth/user.json'`.

### What to Test E2E

Write E2E tests for:

- Critical user flows (login → view inventory → schedule action)
- AI agent interactions (open chat, send message, verify response renders)
- Cross-component workflows (filter inventory → open Ask AI → verify filter applied)

Do NOT write E2E tests for:

- Unit logic (use Vitest)
- API contract validation (use integration tests)
- Every UI state permutation (use component tests)

---

## Deployment Process

All infrastructure is managed by **Pulumi** — no CDK.

### Stack Overview

| Stack | Tool | Manages |
|-------|------|---------|
| `infra/networking` | Pulumi | VPC, subnets, subnet groups |
| `infra/compute` | Pulumi | ECS, Lambda, RDS PostgreSQL, Cognito, CloudFront |

Pulumi state: `s3://nucleus-pulumi-state` · Secrets: `awskms://alias/pulumi-secrets`

Full deploy guide: `infra/DEPLOYMENT.md`

### Deploy

```bash
# Install deps (required after fresh clone)
cd infra/networking && npm install && pulumi install
cd infra/compute && npm install && pulumi install

# Deploy — always networking first, then compute
# pulumi up auto-builds lambdas + Docker image when source changes
cd infra/networking && AWS_PROFILE=PLATFORM-ADMIN pulumi up --stack prod --yes
cd infra/compute && AWS_PROFILE=PLATFORM-ADMIN pulumi up --stack prod --yes

# Preview before deploying
cd infra/compute && AWS_PROFILE=PLATFORM-ADMIN pulumi preview --stack prod

# View outputs
cd infra/compute && AWS_PROFILE=PLATFORM-ADMIN pulumi stack output --stack prod
```

What `pulumi up` does automatically:
- Lambda source changed → runs `build-lambdas.sh`, uploads new zip
- `web-ui/` or `prisma/` changed → builds ARM64 Docker image, pushes to ECR with unique digest, creates new ECS task definition revision, ECS rolls out automatically

### Post-Deploy Verification

1. CloudFront URL responds 200: `https://d11lr8aqp8vqde.cloudfront.net`
2. ECS service desired count matches running count (ECS console)
3. Check CloudWatch for Lambda errors in the 5 minutes post-deploy
4. Run smoke test: `npx playwright test tests/e2e/ --project=chromium`

### Rollback

```bash
git revert HEAD
cd infra/compute && AWS_PROFILE=PLATFORM-ADMIN pulumi up --stack prod
```

### Environment Notes

- **AWS_PROFILE**: `PLATFORM-ADMIN` for all production operations
- **Scheduler Lambda dayjs issue**: known pre-existing esbuild bundling warning — does not block deploy
- **`npx pulumi` fails**: use the global `pulumi` CLI directly (`brew install pulumi`), not npx

<!-- GSD:project-start source:PROJECT.md -->
## Project

Multi-tenant AWS Cloud Operations Platform. All 10 DynamoDB tables have been migrated to PostgreSQL (Prisma ORM + repository pattern). Auth supports Cognito + Credentials with custom RBAC, per-tenant roles, email invitations, and org switching. Background jobs run via pg-boss workers.

Active constraints:
- **ORM**: Prisma ORM with repository pattern; schema at `prisma/schema.prisma`
- **Multi-tenant safety**: Every query scoped via `getTenantClient(tenantId)` — `$executeRaw` is NOT intercepted, scope manually
- **Python Lambda**: Discovery Lambda stays Python (no TypeScript rewrite)
- **AWS Profile**: `PLATFORM-ADMIN` for all production operations
<!-- GSD:project-end -->

<!-- GSD:stack-start source:codebase/STACK.md -->
## Technology Stack

## Languages
- TypeScript ~5.6.2 (root, Pulumi infra) / ^5.0.0 (web-ui, lambdas) - All application and infrastructure code
- TypeScript ^5.7.2 - `lambda/scheduler/` Lambda function
- TypeScript ^5.0.0 - `lambda/kb_sync_processor/` Lambda function
- Python 3.x - `lambda/discovery/` and `lambda/vector_processor/` Lambda functions
## Runtime
- Node.js 20.x (required by scheduler Lambda: `"node": ">=20.0.0"`)
- Container base image: `public.ecr.aws/docker/library/node:20.9.0-slim`
- Python 3.12 (local development)
- npm 10.8.x (root), npm 11.x (web-ui dependency)
- Lockfiles: present at root `package-lock.json`, `web-ui/package-lock.json`, `lambda/scheduler/package-lock.json`, `lambda/kb_sync_processor/package-lock.json`
## Frameworks
- Next.js 15.2.4 (`web-ui/`) - App router, standalone output mode, server-side rendering
- React 19 (`web-ui/`) - UI rendering, functional components only
- Pulumi (`@pulumi/pulumi` ^3.228.0, `@pulumi/aws` ^7.23.0, `@pulumi/awsx` ^3.4.0, `@pulumi/command` ^1.2.1) - Infrastructure as Code (`infra/`)
- LangGraph (`@langchain/langgraph` ^1.2.0) - Agent state machine workflows
- LangChain (`langchain` ^1.2.28, `@langchain/core` ^1.1.29, `@langchain/aws` ^1.3.0) - Tool definitions, LLM integration
- Vercel AI SDK (`ai` ^5.0.115, `@ai-sdk/react` ^2.0.116, `@ai-sdk/amazon-bedrock` ^3.0.71, `@ai-sdk/anthropic` ^2.0.56) - AI streaming hooks in web-ui
- Model Context Protocol (`@modelcontextprotocol/sdk` ^1.26.0) - MCP server integration
- Radix UI (multiple packages, versions 1.x–2.x) - Accessible UI primitives
- Tailwind CSS ^3.4.17 - Utility-first styling
- shadcn/ui pattern via `components.json` - Component scaffolding
- Lucide React ^0.454.0 - Icon library
- TanStack React Table ^8.21.3 - Data tables
- React Hook Form ^7.54.1 + Zod ^3.24.1 - Form handling and validation
- Recharts (latest) - Charts and analytics
- Monaco Editor ^4.7.0 - Code editor component
- fumadocs-core/mdx/ui ^14.7.7 - Documentation pages
- `@prisma/client` - PostgreSQL ORM (web-ui + workers)
- mongodb ^7.1.0 - MongoDB client (deep agent checkpointing)
- `@langchain/langgraph-checkpoint-mongodb` ^1.2.0 - LangGraph MongoDB checkpointer
- Vitest ^4.0.18 (web-ui), Vitest ^2.1.8 (scheduler Lambda) - Unit tests
- Jest ^29.7.0 + ts-jest ^29.2.5 (root) - Root-level tests
- `@vitest/coverage-v8` ^4.0.18 - Coverage reporting
- fast-check ^4.5.3 - Property-based testing
- Playwright ^1.58.2 - E2E browser tests
- esbuild ^0.27.3 (root) / ^0.24.2 (scheduler Lambda) - TypeScript Lambda bundling
- tsc (kb_sync_processor Lambda) - TypeScript compilation
- ts-node ^10.9.2 - TypeScript execution (scripts, local runners)
- tsx ^4.19.2 - TypeScript execution for Lambda local runners
- PostCSS ^8 + autoprefixer ^10.4.20 - CSS processing
## Key Dependencies
- `@pulumi/pulumi` ^3.228.0 + `@pulumi/aws` ^7.23.0 + `@pulumi/awsx` ^3.4.0 - All AWS infrastructure provisioning
- `@aws-sdk/client-s3vectors` ^3.991.0 - S3 Vectors API client
- `next-auth` ^4.24.11 - Authentication session management
- `@casl/ability` ^6.8.0 - RBAC authorization
- `langfuse-langchain` ^3.38.6 - LLM observability integration
- `deepagents` ^1.8.1 - Deep agent framework
- `@farukada/aws-langgraph-dynamodb-ts` ^0.1.0 - DynamoDB checkpointer for LangGraph
- `pyiceberg[s3fs,glue]` - Apache Iceberg table management (discovery Lambda)
- `pyarrow` + `pandas` - Data processing (discovery Lambda)
- `boto3` >=1.38.0 - AWS SDK for Python Lambdas
- `dayjs` ^1.11.10 - Date/time scheduling logic (scheduler Lambda, root)
- `croner` ^10.0.1 + `cronstrue` ^3.13.0 - Cron schedule parsing/display
- `uuid` ^13.0.0 - ID generation
## Configuration
- Root: `.env.example` contains AWS account, Pulumi config, Langfuse vars
- Web-UI: `web-ui/.env.local.example` contains AWS region, Cognito IDs, DATABASE_URL, NextAuth, Jira, Slack, MongoDB, Langfuse vars
- Scheduler Lambda: `lambda/scheduler/.env.example`
- Key required vars: `DATABASE_URL`, `AWS_REGION`, `NEXTAUTH_SECRET`, `COGNITO_USER_POOL_ID`, `COGNITO_USER_POOL_CLIENT_ID`
- Root: `tsconfig.json` (ES2020, commonjs, strict mode)
- Web-UI: `web-ui/tsconfig.json`, `web-ui/next.config.mjs` (standalone output, MDX via fumadocs)
- Web-UI: `web-ui/tailwind.config.ts`, `web-ui/postcss.config.mjs`
- Scheduler Lambda: `lambda/scheduler/tsconfig.json` (esbuild bundles to `dist/index.js`)
- KB Sync Lambda: `lambda/kb_sync_processor/tsconfig.json` (tsc compile)
## Platform Requirements
- Node.js 20+
- Python 3.x (for discovery/vector_processor Lambdas)
- AWS CLI + named profile (e.g., `PLATFORM-ADMIN`)
- Docker (for Langfuse local observability stack via `docker-compose.langfuse.yml`)
- AWS ECS Fargate (web-ui container, Node 20.9.0-slim + AWS Lambda Web Adapter 0.8.4)
- AWS Lambda (scheduler, discovery, vector_processor, kb_sync_processor)
- AWS CloudFront (CDN in front of ALB and S3)
- Deployment: Pulumi via `pulumi up --stack prod`
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

## Language & Style
- `web-ui/tsconfig.json`: `"strict": true`, `"noEmit": true`, `"moduleResolution": "bundler"`, `"isolatedModules": true`
- Root `tsconfig.json`: `"strict": true`, `"noImplicitAny": true`, `"strictNullChecks": true`, `"noImplicitReturns": true`, `"noImplicitThis": true`, `"alwaysStrict": true`
- `noUnusedLocals` and `noUnusedParameters` are both `false` (not enforced)
- `web-ui/.eslintrc.json` extends `next/core-web-vitals` and `next/typescript` — no additional custom rules
- ESLint run: `cd web-ui && npm run lint`
- Lambda scheduler has its own ESLint: `cd lambda/scheduler && npm run lint`
- No Prettier config detected — formatting not enforced by tooling
- Indentation: 4 spaces in service/lib files; 2 spaces in UI components (both patterns coexist)
## Naming Conventions
- React components: `kebab-case.tsx` (e.g., `accounts-client-component.tsx`, `account-details-dialog.tsx`)
- Services: `kebab-case-service.ts` (e.g., `account-service.ts`, `audit-service.ts`, `client-account-service.ts`)
- Hooks: `use-kebab-case.ts` (e.g., `use-debounce.ts`, `use-mobile.tsx`)
- API routes: directory-based with `route.ts` (e.g., `web-ui/app/api/accounts/route.ts`)
- Test files: `<module>.test.ts` or `<module>.property.test.ts`
- Lambda handlers: `src/index.ts`
- React components: `PascalCase` named exports (e.g., `export function AccountsList(...)`)
- Service classes: `PascalCase` class with static methods (e.g., `class AccountService { static async getAccounts(...) }`)
- Utility functions: `camelCase` (e.g., `cn()`, `useDebounce()`)
- Hooks: `use` prefix + camelCase (e.g., `useDebounce`, `useDebouncedCallback`)
- Types/interfaces: `PascalCase` (e.g., `UIAccount`, `AccountMetadata`, `ReflectionState`)
- Enum-style string constants: `SCREAMING_SNAKE_CASE` (e.g., `AGENT_OPS_TABLE_NAME`, `TTL_30_DAYS`, `MAX_REFLECT_ITERATIONS`)
- camelCase for local variables and function parameters
## Import Patterns
- `@/` maps to `web-ui/` root (`tsconfig.json` paths: `"@/*": ["./*"]`)
- Always use `@/` for cross-directory imports in web-ui: `import { AccountService } from '@/lib/account-service'`
- Relative imports only within the same directory
- Services barrel: individual files per domain in `web-ui/lib/` (no barrel index)
- UI primitives: `web-ui/components/ui/` — Radix-based shadcn/ui components (do not modify)
- Feature components: `web-ui/components/<domain>/` (e.g., `accounts/`, `agent/`, `inventory/`)
## Component Patterns
- Functional components only — no class components
- `"use client"` directive required for any component using hooks or browser APIs
- Props typed inline with object destructuring: `function Component({ prop }: { prop: Type })`
- Named exports (not default exports) for components
- Local state: `useState` for component-level state
- Side effects: `useEffect` with explicit dependency arrays
- No global state library (no Redux/Zustand) — server state via API calls
- Forms: `react-hook-form` with `@hookform/resolvers` + `zod` schemas
- Tailwind CSS utility classes — never raw CSS unless in `styles/`
- `cn()` utility from `@/lib/utils` for conditional class merging (`clsx` + `tailwind-merge`)
- Radix UI primitives wrapped in `web-ui/components/ui/` — consume these, never rebuild
## API Patterns
- All routes in `web-ui/app/api/<domain>/route.ts`
- Named exports for HTTP methods: `export async function GET(...)`, `export async function POST(...)`
- Parameters: `NextRequest` as first arg; dynamic segments via `params` second arg
- Always `NextResponse.json(data, { status: N })`
- Success: `{ success: true, data: ..., totalCount?: ... }`
- Error: `{ success: false, error: string }`
- Default status 200 for success, 500 for server errors, 403 for auth errors
- `console.log` for operation start: `'API - GET /api/accounts - Fetching accounts'`
- `console.error` for caught errors: `'API - Error fetching accounts:', error`
- Web-ui API routes: raw `console.log`/`console.error` (no structured logging)
- Workers: use `createLogger('service-name')` from `workers/src/lib/logger.ts` — supports LOG_LEVEL env var
- Data access via repository factory (`@/lib/db/repository-factory`) — never call Prisma directly from routes
- Cross-account calls via `STSClient + AssumeRoleCommand` — never hardcode credentials
- `authorize(action, Subject)` from `@/lib/rbac/authorize` — returns `null` (OK) or `NextResponse` (403)
- Actions: `'read' | 'create' | 'update' | 'delete'`
- Subjects: `'Account' | 'Schedule' | ...` (defined in `web-ui/lib/rbac/types.ts`)
## Agent Patterns
- Every action modifying AWS resources must be audit-logged via `AuditService` from `@/lib/audit-service`
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

## Pattern Overview
- Next.js App Router serves both UI pages and REST API routes from a single ECS Fargate container
- AI agent runs server-side inside the Next.js process using LangGraph StateGraph — no separate agent service
- pg-boss workers handle async/scheduled work (resource scheduling, discovery, KB sync); vector processing remains in Lambda
- All persistent state lives in PostgreSQL (via Prisma ORM) or S3; DynamoDB has been fully removed
- Cross-account AWS operations use STS AssumeRole exclusively — no hardcoded credentials
- Pulumi manages all AWS infrastructure: two stacks (`infra/networking` → `infra/compute`)
## Layers
- Purpose: Defines and provisions all AWS resources
- Location: `infra/networking/`, `infra/compute/`
- Contains: VPC/networking, ECS Fargate cluster, RDS PostgreSQL, Lambda functions, CloudFront, Cognito, S3 buckets, SQS queues, EventBridge rules
- Depends on: Pulumi (`@pulumi/aws`, `@pulumi/pulumi`, `@pulumi/awsx`, `@pulumi/command`)
- Key stacks: `infra/networking` → `infra/compute` (dependency order must be preserved)
- Purpose: Serves the React UI and handles all HTTP API requests
- Location: `web-ui/app/`
- Contains: Page components under `web-ui/app/app/`, REST API route handlers under `web-ui/app/api/`
- Depends on: Service layer (`web-ui/lib/*-service.ts`), agent layer (`web-ui/lib/agent/`), AWS SDK v3
- Deployed as: Docker container on ECS Fargate, fronted by CloudFront
- Purpose: Business logic for each domain — accounts, schedules, audit, inventory, etc.
- Location: `web-ui/lib/`
- Key files: `account-service.ts`, `schedule-service.ts`, `audit-service.ts`, `schedule-execution-service.ts`, `tenant-config-service.ts`
- Pattern: Static classes (e.g. `AccountService.getAccounts()`); all data access via repository factory (`@/lib/db/repository-factory`)
- Depends on: `web-ui/lib/db/pg-config.ts` for Prisma client + `getTenantClient()`
- Purpose: LangGraph-powered AI agents for cloud operations tasks
- Location: `web-ui/lib/agent/`
- Three agent types:
- Entry: `graph-factory.ts` exports `createFastGraph`, `createReflectionGraph`, `createDeepGraph`
- Shared: `agent-shared.ts` (state types, `ReflectionState`, `sanitizeMessagesForBedrock`), `model-factory.ts` (ChatBedrockConverse init, tool assembly), `persistence.ts` (PostgreSQL-backed checkpointer + chat history)
- Purpose: Role-based access control for all mutating API routes
- Location: `web-ui/lib/rbac/`
- Pattern: Every mutating route calls `authorize(action, subject)` from `web-ui/lib/rbac/authorize.ts` before proceeding; uses CASL library for ABAC conditions
- Session: `getServerSession(authOptions)` or `getSessionUserId()` from `web-ui/lib/auth-session.ts`
- Purpose: Background processing independent of the web process
- Location: `lambda/`
- Four functions:
- Purpose: React components for each domain
- Location: `web-ui/components/`
- Domain folders: `agent/`, `agent-ops/`, `inventory/`, `accounts/`, `schedules/`, `audit/`, `knowledge-base/`, `channels/`, `deep-agent/`
- Primitives: `web-ui/components/ui/` — Radix-based shadcn/ui components (do not modify)
## Data Flow
- LangGraph thread state: PostgreSQL-backed checkpointer (`persistence.ts`), with optional S3 offload for large checkpoints
- Long-term agent memory: PostgreSQL store with Bedrock embeddings, 90-day TTL
- Chat session history: PostgreSQL (`agent_chat_history` table), 30-day TTL
- App config state (accounts, schedules, RBAC): PostgreSQL via Prisma repositories
- Audit logs: `audit_log` table (immutable, 30-day TTL via `expire_at`)
## Key Design Patterns
## Entry Points
- Location: `web-ui/app/layout.tsx`
- Triggers: HTTP request to ECS Fargate container
- Responsibilities: Wraps all pages in `ThemeProvider`, `ThemeConfigProvider`, `LayoutWrapper`, NextAuth `Providers`
- Location: `web-ui/app/api/chat/route.ts`
- Triggers: POST from chat UI component
- Responsibilities: Auth, thread lock, graph selection, streaming, PostgreSQL message persistence
- Location: `web-ui/app/api/ask-ai/route.ts`
- Triggers: POST from inventory Ask AI dialog
- Responsibilities: Embed question, query S3 Vectors, fetch PostgreSQL resources, stream answer via Claude
- Location: `lambda/scheduler/src/index.ts`
- Triggers: EventBridge cron (every 30 min) or manual invocation
- Responsibilities: Full or partial schedule scan, STS AssumeRole, resource start/stop
- Location: `lambda/discovery/src/main.py`
- Triggers: ECS task or scheduled invocation
- Responsibilities: Multi-account parallel resource scan, PostgreSQL inventory writes, S3 normalized output
- Location: `infra/compute/index.ts`
- Triggers: `pulumi up --stack prod`
- Responsibilities: Provisions all compute resources (ECS, Lambda, RDS PostgreSQL, Cognito, CloudFront)
## Error Handling
- API routes: `try/catch` → `NextResponse.json({ error }, { status: 5xx })`
- Agent stream: Abort errors (client disconnect) handled silently; real errors logged and propagated via `controller.error()`
- Lambda: Top-level try/catch in handler returns `{ success: false, errors: [...] }` SchedulerResult
## Cross-Cutting Concerns
<!-- GSD:architecture-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd:quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd:debug` for investigation and bug fixing
- `/gsd:execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->

<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd:profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->

