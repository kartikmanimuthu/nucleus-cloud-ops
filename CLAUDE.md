# Nucleus Cloud Ops

AWS Cloud Operations Platform — multi-account resource scheduling + AI Ops agent powered by AWS Bedrock.

## Stack

| Layer | Tech |
|-------|------|
| Frontend | Next.js 15, React 19, Tailwind CSS, Radix UI |
| AI Agent | LangGraph, LangChain, AWS Bedrock (Claude 4.5 Sonnet), MCP |
| Infrastructure | AWS CDK v2, ECS Fargate, CloudFront, DynamoDB |
| Auth | NextAuth.js |
| Testing | Vitest (web-ui), Jest (CDK) |

## Key Commands

```bash
# Local development
cd web-ui && npm run dev        # Next.js dev server → http://localhost:3000

# Testing
cd web-ui && npm run test       # Vitest (web-ui)
npm test                        # Jest (CDK stacks)

# Linting
cd web-ui && npm run lint       # ESLint for web-ui

# Build
cd web-ui && npm run build      # Next.js production build
npm run build                   # Compile CDK TypeScript

# Deploy
npx cdk deploy WebUIStack --profile <profile>   # Deploy web UI stack
npx cdk deploy --all --profile <profile>        # Deploy all stacks
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
├── lib/                  # CDK stack definitions
│   ├── computeStack.ts   # ECS, ALB, CloudFront
│   ├── networkingStack.ts # VPC, subnets
│   └── webUIStack.ts     # Web UI deployment
├── lambda/               # Lambda functions (scheduler, discovery, vector)
├── bin/                  # CDK app entry point
├── docs/                 # Architecture, schema design, PRD
└── test/                 # CDK Jest tests
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

- **DO NOT** modify `lib/computeStack.ts` or `lib/networkingStack.ts` without running `cdk diff` first
- **DynamoDB single-table design** — consult `docs/schema-design.md` before adding entities
- **Never hardcode AWS credentials** — all cross-account ops use STS AssumeRole
- **Git**: main branch is `master`; active feature work on `agent-ops-implementation`
- **Audit log** every action that modifies AWS resources (existing pattern in `lib/agent/`)

## DynamoDB Single-Table Patterns

Two tables in use — consult `docs/schema-design.md` before adding any entity:

- **NucleusAppTable** (single-table design): `pk` + `sk` as strings; GSI1 uses `gsi1pk` / `gsi1sk`
- **NucleusAuditTable**: immutable logs with TTL via `expire_at` (30-day retention)

Key PK/SK patterns:
| Entity | PK | SK |
|--------|----|----|
| Account | `ACCOUNT#<AccountId>` | `METADATA` |
| Schedule | `SCHEDULE#<ScheduleId>` | `METADATA` |
| Targeted Resource | `SCHEDULE#<ScheduleId>` | `RESOURCE#<ResourceArn>` |

GSI1 patterns for list queries: `TYPE#ACCOUNT`, `TYPE#SCHEDULE`, `ACCOUNT#<AccountId>`

**Always** use `@aws-sdk/lib-dynamodb` (DocumentClient) — never the raw DynamoDB client.

## Agent Architecture (Detailed)

Three agent types in `web-ui/lib/agent/`:
- **fast-agent.ts** — Reflection loop (generator → tools → reflector → revise), MAX_REFLECT_ITERATIONS=5
- **planning-agent.ts** — Multi-step (planner → executor → reflector → reviser), MAX_ITERATIONS=30
- **deep-agent.ts** — Extended thinking with MongoDB persistence

Key shared modules:
| File | Purpose |
|------|---------|
| `agent-shared.ts` | State types (ReflectionState), message sanitization, checkpointer init |
| `model-factory.ts` | ChatBedrockConverse init, tool assembly |
| `tools.ts` | Tool definitions (execute_command, read_file, write_file, glob, grep, S3) |
| `prompt-templates.ts` | Reusable prompt fragments (CORE_PRINCIPLES, buildBaseIdentity, etc.) |
| `mcp-config.ts` | MCP server definitions and merge logic |
| `mcp-manager.ts` | MCP server lifecycle (connect/disconnect, credential injection) |
| `mcp-tools.ts` | LangChain tool wrappers for MCP resources |

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
| Directory | Language | Build | Tests |
|-----------|----------|-------|-------|
| `lambda/scheduler/` | TypeScript | esbuild | Vitest |
| `lambda/discovery/` | Python | — | — |
| `lambda/vector_processor/` | Python + TypeScript | — | — |
| `lambda/kb_sync_processor/` | TypeScript | tsc | — |

## Testing Conventions

- **web-ui**: `cd web-ui && npm run test` — runs Vitest once (`vitest run`, not watch mode)
- **CDK**: `npm test` at root — Jest with ts-jest
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
npx playwright test tests/e2e/ask-ai.spec.ts

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

## CDK Deployment Process

### Pre-Deploy Checklist

Before any `cdk deploy`:
1. Run `npx cdk diff --profile <profile>` — review all changes
2. For `computeStack.ts` or `networkingStack.ts` changes — get a second review
3. Verify `.env` has correct `AWS_ACCOUNT_ID` and `AWS_REGION`
4. Confirm target AWS profile: `aws sts get-caller-identity --profile <profile>`
5. Run `npm run build` at root to compile CDK TypeScript

### Stack Dependency Order

Deploy in this order (dependencies flow top → bottom):

```
NetworkingStack   → VPC, subnets, security groups
ComputeStack      → ECS cluster, ALB, CloudFront (depends on Networking)
WebUIStack        → S3 + CloudFront for Next.js static assets
```

Lambda functions are bundled inside ComputeStack/WebUIStack — no separate deploy needed.

### Deploy Commands

```bash
# Verify AWS identity first
aws sts get-caller-identity --profile STX-CLOUD-PLATFORM-ADMIN

# Diff before deploy (always)
npx cdk diff --profile STX-CLOUD-PLATFORM-ADMIN
npx cdk diff WebUIStack --profile STX-CLOUD-PLATFORM-ADMIN

# Deploy single stack (most common — web UI changes)
npx cdk deploy WebUIStack --profile STX-CLOUD-PLATFORM-ADMIN

# Deploy all stacks (infrastructure changes)
npx cdk deploy --all --profile STX-CLOUD-PLATFORM-ADMIN

# Deploy with approval prompt disabled (CI only)
npx cdk deploy --all --require-approval never --profile STX-CLOUD-PLATFORM-ADMIN

# Synthesize CloudFormation without deploying (validate)
npx cdk synth --profile STX-CLOUD-PLATFORM-ADMIN
```

### Post-Deploy Verification

After deploying:
1. Check CloudFormation console — stack status should be `UPDATE_COMPLETE`
2. For WebUIStack: verify CloudFront distribution URL returns 200
3. For ComputeStack: check ECS service desired count matches running count
4. Check CloudWatch for Lambda errors in the 5 minutes post-deploy
5. Run a smoke test: `npx playwright test tests/e2e/ --project=chromium`

### Rollback

CDK doesn't have a built-in rollback command. Options:
- **CloudFormation rollback**: In AWS Console → CloudFormation → select stack → "Roll back"
- **Code rollback**: `git revert` the change, then `cdk deploy` again
- **Manual**: For WebUIStack, re-deploy the previous S3 asset version via CloudFront invalidation

### Environment-Specific Notes

- **AWS_PROFILE**: `STX-CLOUD-PLATFORM-ADMIN` for production deployments
- **CDK context**: stored in `cdk.context.json` — commit this file, it caches VPC/AZ lookups
- **cdk.out/**: generated CloudFormation templates — do not commit, already in `.gitignore`
- **Lambda bundling**: esbuild bundles TypeScript lambdas at synth time — requires Node 20+
- **Scheduler Lambda dayjs issue**: known pre-existing esbuild bundling warning — does not block deploy
