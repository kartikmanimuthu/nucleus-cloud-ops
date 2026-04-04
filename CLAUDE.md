# Nucleus Cloud Ops

AWS Cloud Operations Platform — multi-account resource scheduling + AI Ops agent powered by AWS Bedrock.

## Stack

| Layer          | Tech                                                       |
| -------------- | ---------------------------------------------------------- |
| Frontend       | Next.js 15, React 19, Tailwind CSS, Radix UI               |
| AI Agent       | LangGraph, LangChain, AWS Bedrock (Claude 4.5 Sonnet), MCP |
| Infrastructure | Pulumi (networking + compute), ECS Fargate, CloudFront |
| Auth           | NextAuth.js                                                |
| Testing        | Vitest (web-ui), Jest (root)                               |

## Key Commands

```bash

# Setup AWS Profile
export AWS_PROFILE=PLATFORM-ADMIN

# Local development
cd web-ui && npm run dev        # Next.js dev server → http://localhost:3000

# Testing
cd web-ui && npm run test       # Vitest (web-ui)
npm test                        # Jest (root)

# Linting
cd web-ui && npm run lint       # ESLint for web-ui

# Build
cd web-ui && npm run build      # Next.js production build
npm run build                   # Compile TypeScript (root)

# Deploy — Pulumi (networking + compute)
cd infra/networking && AWS_PROFILE=PLATFORM-ADMIN pulumi up --stack prod --yes
cd infra/compute && AWS_PROFILE=PLATFORM-ADMIN pulumi up --stack prod --yes
```

## Environment Setup

```bash
# 1. Install dependencies
npm install
cd web-ui && npm install

# 2. Configure environment
cp web-ui/.env.local.example web-ui/.env.local
# Required vars: AWS_REGION, DYNAMODB_TABLE_NAME, DYNAMODB_AUDIT_TABLE_NAME, NEXTAUTH_SECRET
# Optional (AI agent): DYNAMODB_CHECKPOINT_TABLE, DYNAMODB_WRITES_TABLE, TAVILY_API_KEY

# 3. AWS credentials
export AWS_PROFILE=your-profile   # or configure ~/.aws/credentials
```

## Project Structure

```
nucleus-cloud-ops/
├── web-ui/
│   ├── app/              # Next.js app router (pages + API routes)
│   ├── components/       # React UI components
│   │   └── agent/        # Agent-specific UI (chat, ops panel)
│   ├── lib/
│   │   ├── agent/        # AI agent implementation (LangGraph)
│   │   │   ├── fast-agent.ts       # Quick response agent
│   │   │   ├── planning-agent.ts   # Multi-step planning agent
│   │   │   └── agent-shared.ts     # Shared tools, prompts, state
│   │   └── ...           # AWS clients, DynamoDB helpers, utilities
│   └── hooks/            # Custom React hooks
├── lib/                  # Shared TypeScript utilities
├── infra/                # Pulumi infrastructure
│   ├── networking/       # VPC, subnets, subnet groups
│   ├── compute/          # ECS, Lambda, RDS, DynamoDB, Cognito, CloudFront
│   ├── bootstrap/        # One-time S3 state + KMS key setup
│   ├── build-lambdas.sh  # Builds Lambda zip artifacts
│   └── build-images.sh   # Builds and pushes WebUI Docker image
├── lambda/               # Lambda functions (scheduler, discovery, vector)
├── bin/                  # Entry points
├── docs/                 # Architecture, schema design, PRD
└── test/                 # Jest tests
```

## Coding Conventions

- **TypeScript everywhere**, strict mode enabled
- **React**: functional components + hooks only, no class components
- **Styling**: Radix UI primitives + Tailwind CSS utility classes
- **AWS**: SDK v3 only (`@aws-sdk/client-*`) — never SDK v2
- **Agent**: LangGraph `StateGraph` for all agent workflows
- **API**: Next.js API routes in `web-ui/app/api/`

## Agent Architecture

The AI agent lives in `web-ui/lib/agent/`. Key patterns:

- Tools are defined with `DynamicStructuredTool` from LangChain
- Agent state uses LangGraph `Annotation` for type-safe state management
- Cross-account AWS calls always go through `sts:AssumeRole`
- Checkpoints stored in DynamoDB (`DYNAMODB_CHECKPOINT_TABLE`)

## Constraints

- **DO NOT** modify `infra/networking/index.ts` or `infra/compute/index.ts` without running `pulumi preview --stack prod` first
- **DynamoDB single-table design** — consult `docs/schema-design.md` before adding entities
- **Never hardcode AWS credentials** — all cross-account ops use STS AssumeRole
- **Git**: main branch is `master`; active feature work on `agent-ops-implementation`
- **Audit log** every action that modifies AWS resources (existing pattern in `lib/agent/`)

## DynamoDB Single-Table Patterns

Two tables in use — consult `docs/schema-design.md` before adding any entity:

- **NucleusAppTable** (single-table design): `pk` + `sk` as strings; GSI1 uses `gsi1pk` / `gsi1sk`
- **NucleusAuditTable**: immutable logs with TTL via `expire_at` (30-day retention)

Key PK/SK patterns:

| Entity            | PK                        | SK                         |
| ----------------- | ------------------------- | -------------------------- |
| Account           | `ACCOUNT#<AccountId>`   | `METADATA`               |
| Schedule          | `SCHEDULE#<ScheduleId>` | `METADATA`               |
| Targeted Resource | `SCHEDULE#<ScheduleId>` | `RESOURCE#<ResourceArn>` |

GSI1 patterns for list queries: `TYPE#ACCOUNT`, `TYPE#SCHEDULE`, `ACCOUNT#<AccountId>`

**Always** use `@aws-sdk/lib-dynamodb` (DocumentClient) — never the raw DynamoDB client.

## Agent Architecture (Detailed)

Three agent types in `web-ui/lib/agent/`:

- **fast-agent.ts** — Reflection loop (generator → tools → reflector → revise), MAX_REFLECT_ITERATIONS=5
- **planning-agent.ts** — Multi-step (planner → executor → reflector → reviser), MAX_ITERATIONS=30
- **deep-agent.ts** — Extended thinking with MongoDB persistence

Key shared modules:

| File                    | Purpose                                                                   |
| ----------------------- | ------------------------------------------------------------------------- |
| `agent-shared.ts`     | State types (ReflectionState), message sanitization, checkpointer init    |
| `model-factory.ts`    | ChatBedrockConverse init, tool assembly                                   |
| `tools.ts`            | Tool definitions (execute_command, read_file, write_file, glob, grep, S3) |
| `prompt-templates.ts` | Reusable prompt fragments (CORE_PRINCIPLES, buildBaseIdentity, etc.)      |
| `mcp-config.ts`       | MCP server definitions and merge logic                                    |
| `mcp-manager.ts`      | MCP server lifecycle (connect/disconnect, credential injection)           |
| `mcp-tools.ts`        | LangChain tool wrappers for MCP resources                                 |

Tool definition pattern:

```typescript
import { tool } from '@langchain/core/tools';
export const myTool = tool(
  async ({ param }: { param: string }) => { ... },
  { name: 'my_tool', description: '...', schema: z.object({ param: z.string() }) }
);
```

**Critical:** Messages must be sanitized before Bedrock calls — orphaned `tool_call` IDs without matching `tool_result` cause `ValidationException`. Use `sanitizeMessagesForBedrock()` from `agent-shared.ts`.

## API Route Conventions

All routes in `web-ui/app/api/` follow these patterns:

- **Auth/RBAC**: `authorize()` from `@/lib/rbac/authorize` — every mutating route needs this
- **Services**: import from `@/lib/<domain>-service.ts` (e.g., `account-service.ts`, `audit-service.ts`)
- **AWS clients**: `getDynamoDBDocumentClient()` from `@/lib/aws-config`
- **Responses**: always `NextResponse.json(data, { status: N })`
- **Session**: `getServerSession(authOptions)` or `getSessionUserId()` from `@/lib/auth-session`

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
npx playwright codegen http://localhost:3000
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
| `infra/compute` | Pulumi | ECS, Lambda, RDS, DynamoDB, Cognito, CloudFront |

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

**DynamoDB to PostgreSQL Migration**

Migrating all 10 DynamoDB tables in the Nucleus Cloud Ops platform to PostgreSQL. This includes business data tables (single-table design NucleusAppTable, audit, inventory, agent ops, RBAC), LangGraph persistence tables (checkpoints, writes, chat history, memory), and the potentially-unused AgentConversationsTable. The migration uses Drizzle ORM with a repository pattern and per-entity feature flags for zero-downtime cutover. Local development uses Docker Compose; cloud PostgreSQL (RDS or Aurora) will be decided later.

**Core Value:** Every DynamoDB table is migrated to PostgreSQL with full test coverage (unit + E2E) and verified data migration scripts, enabling server-side filtering, real transactions, relational joins, and proper pagination across the entire platform.

### Constraints

- **AWS Profile**: All migration scripts use `AWS_PROFILE=PLATFORM-ADMIN` for DynamoDB access
- **Zero downtime**: Feature flags per entity enable instant rollback; DynamoDB tables never deleted during migration
- **Lambda cold starts**: Drizzle ORM chosen over Prisma specifically for Lambda bundle size (~50KB vs 2-4MB)
- **Python Lambda**: Discovery Lambda stays Python; add psycopg2 for PostgreSQL access (no TypeScript rewrite)
- **Multi-tenant safety**: Every PostgreSQL query must include `WHERE tenant_id = $1` -- enforce in repository layer
- **Dual-write for high-risk**: Schedules + Audit phase should dual-write to both backends during validation period
- **Existing tests**: All existing Vitest/Jest/Playwright tests must continue passing throughout migration
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
- dynamoose ^4.1.5 - DynamoDB ORM (web-ui)
- `@aws-sdk/lib-dynamodb` ^3.821.0 - DynamoDB DocumentClient (web-ui)
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
- Web-UI: `web-ui/.env.local.example` contains AWS region, Cognito IDs, DynamoDB table names, NextAuth, Jira, Slack, MongoDB, Langfuse vars
- Scheduler Lambda: `lambda/scheduler/.env.example`
- Key required vars: `AWS_REGION`, `APP_TABLE_NAME`, `AUDIT_TABLE_NAME`, `NEXTAUTH_SECRET`, `COGNITO_USER_POOL_ID`, `COGNITO_USER_POOL_CLIENT_ID`
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
- Utility functions: `camelCase` (e.g., `cn()`, `useDebounce()`, `handleDynamoDBError()`)
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
- No structured logging library — raw console
- Always `getDynamoDBDocumentClient()` from `@/lib/aws-config` — never instantiate DynamoDB directly
- Always `@aws-sdk/lib-dynamodb` (DocumentClient) — never raw DynamoDB client
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
- AWS Lambda functions handle async/scheduled work (resource scheduling, discovery, vector processing, KB sync)
- All persistent state lives in DynamoDB (single-table design) or S3; no relational database
- Cross-account AWS operations use STS AssumeRole exclusively — no hardcoded credentials
- Pulumi manages all AWS infrastructure: two stacks (`infra/networking` → `infra/compute`)
## Layers
- Purpose: Defines and provisions all AWS resources
- Location: `infra/networking/`, `infra/compute/`
- Contains: VPC/networking, ECS Fargate cluster, DynamoDB tables, Lambda functions, CloudFront, Cognito, S3 buckets, SQS queues, EventBridge rules
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
- Pattern: Static classes (e.g. `AccountService.getAccounts()`); all DynamoDB access via `getDynamoDBDocumentClient()` from `aws-config.ts`
- Depends on: `web-ui/lib/aws-config.ts` for DynamoDB client + table names
- Purpose: LangGraph-powered AI agents for cloud operations tasks
- Location: `web-ui/lib/agent/`
- Three agent types:
- Entry: `graph-factory.ts` exports `createFastGraph`, `createReflectionGraph`, `createDeepGraph`
- Shared: `agent-shared.ts` (state types, `ReflectionState`, `sanitizeMessagesForBedrock`), `model-factory.ts` (ChatBedrockConverse init, tool assembly), `persistence.ts` (DynamoDBSaver checkpointer + DynamoDBStore + DynamoDBChatMessageHistory)
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
- LangGraph thread state: DynamoDBSaver checkpointer (DYNAMODB_CHECKPOINT_TABLE + DYNAMODB_WRITES_TABLE), with optional S3 offload for large checkpoints
- Long-term agent memory: DynamoDBStore with Bedrock embeddings (DYNAMODB_MEMORY_TABLE), 90-day TTL
- Chat session history: DynamoDBChatMessageHistory (DYNAMODB_CHAT_HISTORY_TABLE), 30-day TTL
- App config state (accounts, schedules): NucleusAppTable (single-table design, GSI1/GSI2/GSI3)
- Audit logs: NucleusAuditTable (immutable, 30-day TTL via `expire_at`)
## Key Design Patterns
## Entry Points
- Location: `web-ui/app/layout.tsx`
- Triggers: HTTP request to ECS Fargate container
- Responsibilities: Wraps all pages in `ThemeProvider`, `ThemeConfigProvider`, `LayoutWrapper`, NextAuth `Providers`
- Location: `web-ui/app/api/chat/route.ts`
- Triggers: POST from chat UI component
- Responsibilities: Auth, thread lock, graph selection, streaming, DynamoDB message persistence
- Location: `web-ui/app/api/ask-ai/route.ts`
- Triggers: POST from inventory Ask AI dialog
- Responsibilities: Embed question, query S3 Vectors, fetch DynamoDB resources, stream answer via Claude
- Location: `lambda/scheduler/src/index.ts`
- Triggers: EventBridge cron (every 30 min) or manual invocation
- Responsibilities: Full or partial schedule scan, STS AssumeRole, resource start/stop
- Location: `lambda/discovery/src/main.py`
- Triggers: ECS task or scheduled invocation
- Responsibilities: Multi-account parallel resource scan, DynamoDB inventory writes, S3 normalized output
- Location: `infra/compute/index.ts`
- Triggers: `pulumi up --stack prod`
- Responsibilities: Provisions all compute resources (ECS, Lambda, RDS, DynamoDB, Cognito, CloudFront)
## Error Handling
- API routes: `try/catch` → `NextResponse.json({ error }, { status: 5xx })`
- Agent stream: Abort errors (client disconnect) handled silently; real errors logged and propagated via `controller.error()`
- Lambda: Top-level try/catch in handler returns `{ success: false, errors: [...] }` SchedulerResult
- DynamoDB: `handleDynamoDBError()` utility in `web-ui/lib/aws-config.ts` maps DynamoDB error codes to user-friendly messages
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
