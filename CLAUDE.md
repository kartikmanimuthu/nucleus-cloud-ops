# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Nucleus Cloud Ops

AWS Cloud Operations Platform — multi-account resource scheduling + AI Ops agent powered by AWS Bedrock.

## Stack

| Layer          | Tech                                                       |
| -------------- | ---------------------------------------------------------- |
| Frontend       | Next.js 15, React 19, Tailwind CSS, Radix UI, Geist font   |
| Frontend state | TanStack Query (server state), React Hook Form + Zod 4     |
| Frontend UX    | sonner (toasts), framer-motion (transitions)               |
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

# Nx + Bun workspace — run tasks from the repo root via Nx.
# Scripts launch Nx directly as bare `nx` (see "Nx Workspace" below).
bun run dev                            # nx serve web-ui (port 3001, auto-runs prisma migrate deploy)
bun run dev:workers                    # nx serve workers (pg-boss, tsx --watch)
bun run build                          # nx run-many -t build --all (web-ui + workers)
bun run build:web                      # nx build web-ui only
bun run build:workers                  # nx build workers only
bun run test                           # nx run-many -t test --all
bun run lint                           # nx run-many -t lint --all
bun run e2e                            # nx e2e web-ui-e2e (Playwright)
bun run graph                          # nx graph (visualise the task graph)

# Per-project commands (run inside the project dir) — useful when not going through Nx
cd apps/web-ui && bun run dev          # dev server on :3001 (auto-runs prisma migrate deploy)

# Database (schema lives at /libs/prisma/schema.prisma, shared by web-ui + workers)
cd apps/web-ui && bun run db:migrate   # create + apply new migration
cd apps/web-ui && bun run db:generate  # regenerate Prisma client after schema change
cd apps/web-ui && bun run db:studio    # Prisma Studio UI
cd apps/workers && bun run db:generate # regenerate the workers Prisma client (@prisma/client@6)

# Testing
cd apps/web-ui && bun run test         # Vitest (web-ui)
cd apps/workers && bun run test        # Vitest (workers)

# Linting
cd apps/web-ui && bun run lint

# Deploy — always networking first, then compute
cd infra/networking && AWS_PROFILE=PLATFORM-ADMIN pulumi up --stack prod --yes
cd infra/compute && AWS_PROFILE=PLATFORM-ADMIN pulumi up --stack prod --yes
cd infra/compute && AWS_PROFILE=PLATFORM-ADMIN pulumi preview --stack prod  # preview first
```

## Environment Setup

```bash
# 1. Install dependencies (Bun workspaces — single install at root hoists to all apps)
bun install                            # runs `prepare` → prisma generate for web-ui + workers

# 2. Configure environment (single root .env — both apps load it)
cp .env.example .env
# web-ui loads root .env via next.config.mjs (dotenv.config({ path: '../../.env' }))
# workers loads root .env via --env-file=../../.env in dev/start scripts
# Required: DATABASE_URL, AWS_REGION, NEXTAUTH_SECRET, COGNITO_USER_POOL_ID, COGNITO_APP_CLIENT_ID, COGNITO_APP_CLIENT_SECRET
# Optional (AI agent): TAVILY_API_KEY, LANGFUSE_* vars

# 3. Start Postgres and run migrations
docker compose up -d postgres
cd apps/web-ui && bun run db:migrate
```

## Project Structure

```
nucleus-cloud-ops/
├── apps/
│   ├── web-ui/           # Next.js App Router (app/app/ pages, app/api/ routes) + project.json
│   │   ├── app/          # Next.js App Router — pages under app/app/, API routes under app/api/
│   │   ├── components/   # React UI components, organized by domain
│   │   ├── lib/
│   │   │   ├── agent/    # LangGraph AI agents (fast, planning, deep)
│   │   │   ├── db/       # Prisma client, repository factory, per-domain repositories
│   │   │   └── rbac/     # RBAC/ABAC guards (authorize.ts, types.ts) — CASL v7
│   │   └── hooks/        # Custom React hooks
│   ├── workers/          # pg-boss background job workers + project.json
│   │   └── src/jobs/     # scheduler/, discovery/, kb-sync/
│   └── web-ui-e2e/       # Playwright E2E tests (+ project.json, playwright.config.ts, implicit dep on web-ui)
├── libs/
│   └── prisma/           # Prisma schema + migrations + seed (shared by web-ui + workers)
│       ├── schema.prisma # Single source of truth for all models
│       └── seed.ts       # Database seed
├── infra/
│   ├── networking/       # Pulumi: VPC, subnets (+ project.json)
│   ├── compute/          # Pulumi: ECS, RDS, Cognito, CloudFront (+ project.json)
│   └── cicd/             # CodeBuild specs (+ project.json)
└── docs/                 # Architecture, schema design, PRD
```

## Nx Workspace

This repo is an **Nx 21 + Bun** monorepo. Each app/stack has a `project.json`; Nx discovers
`web-ui`, `workers`, `networking`, `compute`, `cicd`, `web-ui-e2e` (`bun run graph` to visualise).

**Always invoke Nx through the root npm scripts** (`bun run build`, `bun run dev`, …). Each script
calls Nx directly as bare `nx <args>` (e.g. `bun run build` → `nx run-many -t build --all`). Nx 21 runs
under Bun; on **Next 15.5.15** the webpack build runs cleanly under Bun's runtime, so no real-Node
indirection is needed.

> History: on Next 15.2.4, `next build` could not run under Bun (`Cannot find module './impl'`, `/404`
> prerender failed with `<Html> should not be imported outside pages/_document`), and `next build`'s
> `.next/standalone` cleanup followed symlinks into the hoisted root `next`, deleting it on repeat
> builds. The repo then carried `scripts/nx-run.sh` (ran Nx under real Node via `sh`) and
> `apps/web-ui/scripts/build.sh` (real-Node `next build` + symlink neutralization) as workarounds.
> Bumping to Next 15.5.15 eliminated **both** bugs, so those two scripts were removed. Do **not**
> re-introduce them — if builds go flaky again, first check whether Next was downgraded.

The `web-ui:build` target (`apps/web-ui/project.json`) runs `NODE_ENV=production next build`
(cwd `apps/web-ui`). The `NODE_ENV=production` prefix is the **only** guard retained: Bun defaults
`NODE_ENV=development`, which breaks the Next `/404` static export (`<Html> should not be imported
outside pages/_document`). With it set, repeat builds are deterministic — the 15.2.4
`.next/standalone` symlink-following deletion is gone in 15.5.15 (verified: `impl.js` survives
back-to-back builds, no neutralizer needed).

Docker builds are unaffected and never relied on the removed scripts: the Dockerfile installs in
isolation with Bun, then builds under `node:20-slim` via `npm run build` (apps/web-ui's own `next
build` script) with `NODE_ENV=production` and a fresh `.next` every time.

## Database — PostgreSQL + Prisma

All persistent state is in PostgreSQL. DynamoDB has been fully removed.

- Schema: `libs/prisma/schema.prisma` — single source of truth for all models
- Prisma client output (dual generators, see schema): `client` → `node_modules/.prisma/client` at the **workspace root** (consumed by the hoisted `@prisma/client@5` used by web-ui + `libs/prisma/seed.ts`); `clientWorkers` → `apps/workers/node_modules/.prisma/client` (consumed by workers' `@prisma/client@6`). `bun install`'s `prepare` hook regenerates both; run `db:generate` in `apps/web-ui` / `apps/workers` after schema changes.
- Connection pool: `connection_limit=10` for ECS (web-ui) — set in the `DATABASE_URL` query param

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

Repositories live in `apps/web-ui/lib/db/repositories/<domain>/` with `interface.ts` + `postgres.ts`.

**Gotcha:** `$executeRaw` is NOT intercepted by the tenant extension — callers must manually add `WHERE tenant_id = $1`.

## Agent Architecture

Three agent types in `apps/web-ui/lib/agent/`, all entered via `graph-factory.ts`:

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
| `memory/memory-service.ts` | Typed long-term memory: `recall`/`remember` (kind-discriminated `AgentMemory` + pgvector HNSW) + working-memory get/put. `saveMemory`/`searchMemory` in `persistence.ts` delegate here. |
| `memory/working-memory.ts` | In-session compaction for long runs: `prepareContext` (budget-aware window + reflector-model summary folding) + `AgentWorkingMemory` snapshot. Gated by `WORKING_MEMORY_ENABLED`. |
| `memory/reconcile.ts` | Save-time conflict resolution: batched LLM judge (ADD/UPDATE/SUPERSEDE/REINFORCE/NOOP) applied via MemoryService with an auditable supersede trail. Gated by `MEMORY_RECONCILE_ENABLED`. |
| `memory/episode.ts` | Episodic memory: one distilled episode (context/reasoning/action/outcome) per tool-using run, replayed as few-shot experience via memoryContext. Gated by `EPISODIC_MEMORY_ENABLED`. |
| `memory/procedural.ts` | Procedural memory: operating rules learned from corrections/failures, injected as "Operating rules (learned)"; matured rules promote to Skills via SkillFormDialog (human-approved). Gated by `PROCEDURAL_MEMORY_ENABLED`. |
| `memory/skill-synthesis.ts` | Domain-level autonomous skill synthesis: when a procedural domain has ≥ `SKILL_SYNTHESIS_MIN_RULES` matured rules, a distiller authors `sys-<domain>` (system, enabled, read-only) with a code-guaranteed rule ledger, re-synthesized as rules mature. Disabled skill = veto. Gated by `AUTO_SKILL_CREATION_ENABLED`. |
| `auto-skill-select.ts` | Chat auto-picks a skill via a reflector catalog match when none selected (`AUTO_SKILL_SELECTION_ENABLED`); no-skill runs see the skill catalog. Agent Ops executor graphs also wire the shared memory recall/save nodes. Memory-lifecycle logs gated by `MEMORY_LOG_VERBOSE`. |

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
- `workers/src/jobs/discovery/` — multi-account resource scanning; also derives the resource dependency graph (`resource_edges`) from raw describe responses via `services/edge-spec.ts` + `services/edge-extractor.ts`. Web-ui side: `lib/db/repositories/resource-graph/`, agent tools `get_resource_neighbors` / `get_blast_radius`. See `docs/RESOURCE_GRAPH_ARCHITECTURE.md`.
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

- UI primitives in `apps/web-ui/components/ui/` — Radix-based, shadcn/ui style (do not modify these)
- Feature components organized by domain: `agent/` (incl. `agent/chat/` — Mission Control chat components), `agent-ops/`, `inventory/`, `schedules/`, `accounts/`, `audit/`, `knowledge-base/`, `channels/`, `deep-agent/`
- Use `@/` path alias for all imports (maps to `apps/web-ui/`)
- Conditional Tailwind: `cn()` utility from `@/lib/utils`

### Frontend stack conventions (apply to all new UI/feature work)

- **Data fetching — TanStack Query (`@tanstack/react-query` ^5)**: never hand-roll `useState`+`useEffect`+`fetch`. Add a typed hook in `apps/web-ui/lib/queries/<domain>.ts` (`useQuery`/`useMutation`) and key it via the central factory in `apps/web-ui/lib/queries/query-keys.ts`. Invalidate with `queryClient.invalidateQueries({ queryKey: queryKeys.<domain>.all })`. Provider: `apps/web-ui/providers/query-provider.tsx`.
- **Toasts — sonner (^1.7)**: single toast system. `apps/web-ui/hooks/use-toast.ts` is a compat shim exposing the legacy `useToast()` / `toast({ variant, title, description })` API over sonner — existing call sites keep working; **new code imports `toast` from `"sonner"` directly**. `<Toaster />` lives in `app/layout.tsx` via `components/ui/sonner.tsx`. (Radix toast has been removed.)
- **Forms — React Hook Form + Zod**: dialogs/forms use `react-hook-form` + `@hookform/resolvers/zod` with a `zod` schema, wired to a query-hook mutation. Do not build forms with manual `useState`.
- **Validation — Zod 4 (`zod` ^4.0)**: upgraded from v3. Use `err.issues` (not `.errors`); `z.record()` requires the key+value two-arg form.
- **Animation — framer-motion (^12)**: route-level fade/slide via `apps/web-ui/components/page-transition.tsx` (already wired into `layout-wrapper.tsx`, respects reduced-motion). Reuse it; do not add ad-hoc CSS transitions for page changes.
- **Loading — `Spinner` primitive** at `apps/web-ui/components/ui/spinner.tsx`; use it instead of bespoke spinner markup.
- **Fonts — Geist (`geist` package)**: `GeistSans`/`GeistMono` wired via CSS vars in `app/layout.tsx` + `tailwind.config.ts`. Inter/Manrope removed; the theme font-switcher toggles between Geist Sans/Mono.

## Background Jobs (no AWS Lambda)

There are **no AWS Lambda functions** in this repo. The former Lambdas (scheduler,
discovery, kb-sync, vector processing) were migrated to **pg-boss jobs** that run inside
the `workers` ECS service — see `apps/workers/src/jobs/` and `infra/DEPLOYMENT.md`
("The compute stack declares no `aws.lambda.Function` resources"). All TypeScript now;
the old Python discovery Lambda was rewritten in TypeScript. Job dirs:
`scheduler/`, `discovery/`, `kb-sync/`, `right-sizing/`, `agent-ops-scheduler/`,
`certificate-expiry-monitor/`. (See the **Workers (pg-boss)** section above.)

## Testing Conventions

- **web-ui**: `cd apps/web-ui && bun run test` — runs Vitest once (`vitest run`, not watch mode)
- **workers**: `cd apps/workers && bun run test` — Vitest
- **root**: `bun run test` at root — `nx run-many -t test --all` across web-ui, workers, libs/rbac (no Jest config exists anywhere in the repo; `jest`/`ts-jest`/`@types/jest` are unused root devDependencies)
- **Known pre-existing timing sensitivity**: a small number of tests (e.g. `apps/workers/src/executor/horizontal.test.ts`, which polls on genuine `setTimeout` rather than `vi.useFakeTimers()` — a deliberate choice per its own comment, to avoid fake-timer async-ordering issues) assume generous real-clock margins and can occasionally flake under added CPU overhead: confirmed reproducible via Nx's `nx:run-commands` executor (`nx run workers:test`, and therefore the root `bun run test`/`test:coverage`/`test:integration` — NOT fixed by `--parallel=1`, so it isn't cross-project contention; root cause not fully isolated, suspect stdio-piping overhead) and, separately, under `--coverage`'s v8 instrumentation overhead (observed once on an unrelated agent-ops-scheduler timing test, not reproducible on immediate re-run). Every project's suite is 100% green natively (`cd apps/<project> && bun run test`, verified repeatedly) — if a timing-sensitive test flakes in CI, retry once before assuming a real regression, and consider fake timers or wider margins as a follow-up rather than distrusting the rest of the suite.
- **Coverage**: `bun run test:coverage` at root (or per-project `test:coverage`) — Vitest `--coverage` via `@vitest/coverage-v8`, configured in each project's `vitest.config.ts`
- **DB-backed integration tests**: files named `*.integration.test.ts` are `describe.skipIf(!DATABASE_URL)`'d — they no-op in a DB-free run and only execute when `DATABASE_URL` is set (`docker compose up -d postgres` + `bun run db:migrate:deploy`, or `bun run test:integration` at root). web-ui's `vitest.config.ts` snapshots `DATABASE_URL`'s presence once via Vite `define` (`__HAS_DB__`) rather than reading `process.env.DATABASE_URL` live in each test file — constructing a real `PrismaClient` triggers Prisma's own `.env` auto-load as a side effect, which would otherwise leak a truthy `DATABASE_URL` into later test files in the same worker
- Test files: `*.test.ts` colocated with source or in `tests/`/`__tests__/` subdirectory
- Property-based tests use `fast-check` (see `apps/web-ui/tests/agent-ops/`)

## E2E Testing with Playwright

### Setup & Config

The E2E suite is an Nx project at `apps/web-ui-e2e/` (project name `web-ui-e2e`, `implicitDependencies: ["web-ui"]`). Config lives at `apps/web-ui-e2e/playwright.config.ts`; specs + `auth.setup.ts` sit directly in that directory. The dev server auto-starts via the `webServer` config (`cd ../.. && bun run dev` → `next dev -p 3001`).

```bash
# Run all E2E tests via Nx (starts dev server automatically)
bun run e2e

# Run a specific test file (from the e2e project dir)
cd apps/web-ui-e2e && bunx playwright test accounts.spec.ts      # AWS Accounts module (60 tests)
cd apps/web-ui-e2e && bunx playwright test navigation.spec.ts    # App navigation flows
cd apps/web-ui-e2e && bunx playwright test marketing.spec.ts     # Marketing/landing page
cd apps/web-ui-e2e && bunx playwright test docs.spec.ts          # Documentation pages

# Run in headed mode (see the browser)
bun run e2e -- --headed

# Run with UI mode (interactive debugger)
bun run e2e:ui

# Show last HTML report
cd apps/web-ui-e2e && bunx playwright show-report

# Generate test code interactively (codegen)
bun run codegen
```

### Using Playwright MCP for Testing

The Playwright MCP server (configured in `.mcp.json`) lets Claude Code interact with the running app directly. Use it to:

- Inspect live UI state before writing assertions
- Debug failing tests by navigating to the page and taking snapshots
- Verify selectors before committing them to test files

Workflow: start the dev server manually (`cd apps/web-ui && bun run dev`), then use Playwright MCP tools to explore the page, then write the test.

### Test File Conventions

- Files: `apps/web-ui-e2e/<feature>.spec.ts`
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

For complex pages, extract a Page Object in `apps/web-ui-e2e/pages/`:

```typescript
// apps/web-ui-e2e/pages/inventory-page.ts
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
// apps/web-ui-e2e/auth.setup.ts — run once, save session
import { test as setup } from '@playwright/test';
setup('authenticate', async ({ page }) => {
  await page.goto('/api/auth/signin');
  // ... fill credentials
  await page.context().storageState({ path: '.auth/user.json' });
});
```

Then reference in `apps/web-ui-e2e/playwright.config.ts` via `storageState: path.join(__dirname, '.auth/user.json')`.

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
| `infra/compute` | Pulumi | ECS (web-ui + workers), RDS PostgreSQL, Cognito, CloudFront (no Lambda) |

Pulumi state: `s3://nucleus-pulumi-state` · Secrets: `awskms://alias/pulumi-secrets`

Full deploy guide: `infra/DEPLOYMENT.md`

### Deploy

```bash
# Install deps (required after fresh clone)
cd infra/networking && npm install && pulumi install
cd infra/compute && npm install && pulumi install

# Deploy — always networking first, then compute
# pulumi up auto-builds the web-ui + workers Docker images when source changes
cd infra/networking && AWS_PROFILE=PLATFORM-ADMIN pulumi up --stack prod --yes
cd infra/compute && AWS_PROFILE=PLATFORM-ADMIN pulumi up --stack prod --yes

# Preview before deploying
cd infra/compute && AWS_PROFILE=PLATFORM-ADMIN pulumi preview --stack prod

# View outputs
cd infra/compute && AWS_PROFILE=PLATFORM-ADMIN pulumi stack output --stack prod
```

What `pulumi up` does automatically (change detection = recursive sha256 of the source dirs, used as the image tag — see `infra/compute/index.ts`):
- `apps/web-ui/` or `libs/prisma/` changed → builds ARM64 web-ui Docker image, pushes to ECR with unique digest, creates new ECS task definition revision, ECS rolls out automatically
- `apps/workers/` or `libs/prisma/` changed → builds the workers Docker image and rolls out the workers ECS service the same way

### Post-Deploy Verification

1. CloudFront URL responds: `https://d2o00a2uwp9po0.cloudfront.net` (`/` returns 307 to `/app/dashboard` when signed out)
2. ECS services (web-ui + workers) desired count matches running count (ECS console)
3. Check CloudWatch ECS task logs for errors in the 5 minutes post-deploy
4. Run smoke test: `bun run e2e` (runs `apps/web-ui-e2e` Playwright suite)

### Rollback

```bash
git revert HEAD
cd infra/compute && AWS_PROFILE=PLATFORM-ADMIN pulumi up --stack prod
```

### Environment Notes

- **AWS_PROFILE**: `PLATFORM-ADMIN` for all production operations
- **`npx pulumi` fails**: use the global `pulumi` CLI directly (`brew install pulumi`), not npx

<!-- GSD:project-start source:PROJECT.md -->
## Project

Multi-tenant AWS Cloud Operations Platform. All 10 DynamoDB tables have been migrated to PostgreSQL (Prisma ORM + repository pattern). Auth supports Cognito + Credentials with custom RBAC, per-tenant roles, email invitations, and org switching. Background jobs run via pg-boss workers.

Active constraints:
- **ORM**: Prisma ORM with repository pattern; schema at `libs/prisma/schema.prisma`
- **Multi-tenant safety**: Every query scoped via `getTenantClient(tenantId)` — `$executeRaw` is NOT intercepted, scope manually
- **Background jobs**: pg-boss jobs in `apps/workers/` (ECS) — no AWS Lambda. Discovery was rewritten from Python to TypeScript.
- **AWS Profile**: `PLATFORM-ADMIN` for all production operations
<!-- GSD:project-end -->

<!-- GSD:stack-start source:codebase/STACK.md -->
## Technology Stack

## Languages
- TypeScript ~5.6.2 (root, Pulumi infra) / ^5.0.0 (web-ui, workers) - All application and infrastructure code
- No Python — the former Python discovery/vector Lambdas were removed; all background work is TypeScript pg-boss jobs in `apps/workers/`
## Runtime
- Node.js 20.x
- Container base image: `public.ecr.aws/docker/library/node:20.9.0-slim`
- Bun (workspace package manager + Nx task runner)
- Lockfiles: `bun.lock` at the workspace root (single Bun workspace)
## Frameworks
- Next.js 15.5.15 (`apps/web-ui/`) - App router, standalone output mode, server-side rendering
- React 19 (`apps/web-ui/`) - UI rendering, functional components only
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
- TanStack React Query ^5.66.0 - Server-state data layer (hooks in `lib/queries/`, keys in `lib/queries/query-keys.ts`)
- React Hook Form ^7.54.1 + Zod ^4.0.0 - Form handling and validation (Zod upgraded 3→4; `@t3-oss/env-nextjs` ^0.13.0 for v4 peer compat)
- sonner ^1.7.1 - Toast notifications (replaced Radix toast)
- framer-motion ^12.0.0 - Page transitions (`components/page-transition.tsx`)
- geist ^1.3.1 - Geist Sans/Mono font (replaced Inter + Manrope)
- Recharts (latest) - Charts and analytics
- Monaco Editor ^4.7.0 - Code editor component
- fumadocs-core/mdx/ui ^14.7.7 - Documentation pages
- `@prisma/client` - PostgreSQL ORM (web-ui + workers)
- mongodb ^7.1.0 - MongoDB client (deep agent checkpointing)
- `@langchain/langgraph-checkpoint-mongodb` ^1.2.0 - LangGraph MongoDB checkpointer
- Vitest ^4.0.18 (web-ui, libs/rbac) / ^2.1.8 (workers, pinned separately) - Unit tests
- Jest ^29.7.0 + ts-jest ^29.2.5 (root devDependencies) - unused; no jest config exists anywhere in the repo
- `@vitest/coverage-v8` ^4.0.18 (web-ui, libs/rbac) / ^2.1.8 (workers) - Coverage reporting, version-matched to each project's own vitest
- fast-check ^4.5.3 - Property-based testing
- Playwright ^1.58.2 - E2E browser tests
- ts-node ^10.9.2 - TypeScript execution (scripts, local runners)
- tsx ^4.19.2 - TypeScript execution for workers dev/local runners
- PostCSS ^8 + autoprefixer ^10.4.20 - CSS processing
## Key Dependencies
- `@pulumi/pulumi` ^3.228.0 + `@pulumi/aws` ^7.23.0 + `@pulumi/awsx` ^3.4.0 - All AWS infrastructure provisioning
- `@aws-sdk/client-s3vectors` ^3.991.0 - S3 Vectors API client
- `next-auth` ^4.24.11 - Authentication session management
- `@casl/ability` ^7.0.1 + `@casl/react` ^7.0.1 + `@casl/prisma` ^2.0.2 - RBAC/ABAC authorization. **v7, not v6** — use `createMongoAbility()`, never `new Ability()`; `PureAbility` is renamed `Ability`, `rulesToQuery` is `rulesToCondition`, and `packRules`/`unpackRules` live in the `@casl/ability/extra` subpath
- `langfuse-langchain` ^3.38.6 - LLM observability integration
- `deepagents` ^1.8.1 - Deep agent framework
- `@farukada/aws-langgraph-dynamodb-ts` ^0.1.0 - DynamoDB checkpointer for LangGraph
- `@aws-sdk/client-*` (ec2, rds, cloudwatch, autoscaling, …) - per-service AWS SDK v3 clients used by the workers discovery scan
- `dayjs` ^1.11.x - Date/time scheduling logic (workers scheduler job, root)
- `croner` ^10.0.1 + `cronstrue` ^3.13.0 - Cron schedule parsing/display
- `uuid` ^13.0.0 - ID generation
## Configuration
- Root: `.env.example` (single, tracked) — AWS account/region, Pulumi config, Cognito IDs, DATABASE_URL, NextAuth, Jira, Slack, MongoDB, Langfuse vars. Copy to `.env` at the repo root; both apps load it (web-ui via `next.config.mjs` dotenv, workers via `--env-file=../../.env`).
- Root: `tsconfig.json` (ES2020, commonjs, strict mode)
- Web-UI: `apps/web-ui/tsconfig.json`, `apps/web-ui/next.config.mjs` (standalone output, MDX via fumadocs)
- Web-UI: `apps/web-ui/tailwind.config.ts`, `apps/web-ui/postcss.config.mjs`
- Workers: `apps/workers/tsconfig.json` (pg-boss job process)
## Platform Requirements
- Node.js 20+
- Bun (workspace install + Nx task runner)
- AWS CLI + named profile (e.g., `PLATFORM-ADMIN`)
- Docker (for Postgres via `docker compose up -d postgres`; Langfuse local stack via `docker-compose.langfuse.yml`)
- AWS ECS Fargate — two services: web-ui container (Node 20.9.0-slim, Next.js via Bun, `docker-entrypoint.sh` runs Prisma migrate then starts Next on :3000) and workers container (pg-boss jobs)
- AWS CloudFront (CDN in front of ALB and S3)
- Deployment: Pulumi via `pulumi up --stack prod`
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

## Language & Style
- `apps/web-ui/tsconfig.json`: `"strict": true`, `"noEmit": true`, `"moduleResolution": "bundler"`, `"isolatedModules": true`
- Root `tsconfig.json`: `"strict": true`, `"noImplicitAny": true`, `"strictNullChecks": true`, `"noImplicitReturns": true`, `"noImplicitThis": true`, `"alwaysStrict": true`
- `noUnusedLocals` and `noUnusedParameters` are both `false` (not enforced)
- `apps/web-ui/.eslintrc.json` extends `next/core-web-vitals` and `next/typescript` — no additional custom rules
- ESLint run: `cd apps/web-ui && bun run lint` (or `bun run lint` at root for all projects)
- No Prettier config detected — formatting not enforced by tooling
- Indentation: 4 spaces in service/lib files; 2 spaces in UI components (both patterns coexist)
## Naming Conventions
- React components: `kebab-case.tsx` (e.g., `accounts-client-component.tsx`, `account-details-dialog.tsx`)
- Services: `kebab-case-service.ts` (e.g., `account-service.ts`, `audit-service.ts`, `client-account-service.ts`)
- Hooks: `use-kebab-case.ts` (e.g., `use-debounce.ts`, `use-mobile.tsx`)
- API routes: directory-based with `route.ts` (e.g., `apps/web-ui/app/api/accounts/route.ts`)
- Test files: `<module>.test.ts` or `<module>.property.test.ts`
- Worker jobs: `apps/workers/src/jobs/<job>/index.ts`
- React components: `PascalCase` named exports (e.g., `export function AccountsList(...)`)
- Service classes: `PascalCase` class with static methods (e.g., `class AccountService { static async getAccounts(...) }`)
- Utility functions: `camelCase` (e.g., `cn()`, `useDebounce()`)
- Hooks: `use` prefix + camelCase (e.g., `useDebounce`, `useDebouncedCallback`)
- Types/interfaces: `PascalCase` (e.g., `UIAccount`, `AccountMetadata`, `ReflectionState`)
- Enum-style string constants: `SCREAMING_SNAKE_CASE` (e.g., `AGENT_OPS_TABLE_NAME`, `TTL_30_DAYS`, `MAX_REFLECT_ITERATIONS`)
- camelCase for local variables and function parameters
## Import Patterns
- `@/` maps to `apps/web-ui/` root (`tsconfig.json` paths: `"@/*": ["./*"]`)
- Always use `@/` for cross-directory imports in web-ui: `import { AccountService } from '@/lib/account-service'`
- Relative imports only within the same directory
- Services barrel: individual files per domain in `apps/web-ui/lib/` (no barrel index)
- UI primitives: `apps/web-ui/components/ui/` — Radix-based shadcn/ui components (do not modify)
- Feature components: `apps/web-ui/components/<domain>/` (e.g., `accounts/`, `agent/`, `inventory/`)
## Component Patterns
- Functional components only — no class components
- `"use client"` directive required for any component using hooks or browser APIs
- Props typed inline with object destructuring: `function Component({ prop }: { prop: Type })`
- Named exports (not default exports) for components
- Local state: `useState` for component-level state
- Side effects: `useEffect` with explicit dependency arrays
- No client global-state library (no Redux/Zustand); **server state via TanStack Query hooks** in `lib/queries/<domain>.ts` (keys in `lib/queries/query-keys.ts`) — not raw `useEffect`+`fetch`
- Forms: `react-hook-form` with `@hookform/resolvers` + `zod` schemas (Zod v4)
- Toasts: import `toast` from `"sonner"` (legacy `useToast()` shim in `hooks/use-toast.ts`)
- Tailwind CSS utility classes — never raw CSS unless in `styles/`
- `cn()` utility from `@/lib/utils` for conditional class merging (`clsx` + `tailwind-merge`)
- Radix UI primitives wrapped in `apps/web-ui/components/ui/` — consume these, never rebuild
## API Patterns
- All routes in `apps/web-ui/app/api/<domain>/route.ts`
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
- Subjects: `'Account' | 'Schedule' | ...` (defined in `apps/web-ui/lib/rbac/types.ts`)
## Agent Patterns
- Every action modifying AWS resources must be audit-logged via `AuditService` from `@/lib/audit-service`
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

## Pattern Overview
- Next.js App Router serves both UI pages and REST API routes from a single ECS Fargate container
- AI agent runs server-side inside the Next.js process using LangGraph StateGraph — no separate agent service
- pg-boss workers (ECS) handle ALL async/scheduled work (resource scheduling, discovery, KB sync incl. embeddings/vectors, right-sizing); there are no AWS Lambda functions
- All persistent state lives in PostgreSQL (via Prisma ORM) or S3; DynamoDB has been fully removed
- Cross-account AWS operations use STS AssumeRole exclusively — no hardcoded credentials
- Pulumi manages all AWS infrastructure: two stacks (`infra/networking` → `infra/compute`)
## Layers
- Purpose: Defines and provisions all AWS resources
- Location: `infra/networking/`, `infra/compute/`
- Contains: VPC/networking, ECS Fargate cluster (web-ui + workers services), RDS PostgreSQL, CloudFront, Cognito, S3 buckets (no Lambda)
- Depends on: Pulumi (`@pulumi/aws`, `@pulumi/pulumi`, `@pulumi/awsx`, `@pulumi/command`)
- Key stacks: `infra/networking` → `infra/compute` (dependency order must be preserved)
- Purpose: Serves the React UI and handles all HTTP API requests
- Location: `apps/web-ui/app/`
- Contains: Page components under `apps/web-ui/app/app/`, REST API route handlers under `apps/web-ui/app/api/`
- Depends on: Service layer (`apps/web-ui/lib/*-service.ts`), agent layer (`apps/web-ui/lib/agent/`), AWS SDK v3
- Deployed as: Docker container on ECS Fargate, fronted by CloudFront
- Purpose: Business logic for each domain — accounts, schedules, audit, inventory, etc.
- Location: `apps/web-ui/lib/`
- Key files: `account-service.ts`, `schedule-service.ts`, `audit-service.ts`, `schedule-execution-service.ts`, `tenant-config-service.ts`
- Pattern: Static classes (e.g. `AccountService.getAccounts()`); all data access via repository factory (`@/lib/db/repository-factory`)
- Depends on: `apps/web-ui/lib/db/pg-config.ts` for Prisma client + `getTenantClient()`
- Purpose: LangGraph-powered AI agents for cloud operations tasks
- Location: `apps/web-ui/lib/agent/`
- Three agent types:
- Entry: `graph-factory.ts` exports `createFastGraph`, `createReflectionGraph`, `createDeepGraph`
- Shared: `agent-shared.ts` (state types, `ReflectionState`, `sanitizeMessagesForBedrock`), `model-factory.ts` (ChatBedrockConverse init, tool assembly), `persistence.ts` (PostgreSQL-backed checkpointer + chat history)
- Purpose: Role-based access control for all mutating API routes
- Location: `apps/web-ui/lib/rbac/`
- Pattern: Every mutating route calls `authorize(action, subject)` from `apps/web-ui/lib/rbac/authorize.ts` before proceeding. Today this resolves against a hardcoded `Record<Module, Action[]>` matrix (`permissions.ts`, `types.ts`) — **not** CASL, and there are no ABAC conditions. The migration to a database-driven CASL v7 rule compiler is in progress on `feature/casl-abac`; `libs/rbac/` holds the framework-free half
- Session: `getServerSession(authOptions)` or `getSessionUserId()` from `apps/web-ui/lib/auth-session.ts`
- Purpose: Background processing independent of the web process
- Location: `apps/workers/src/jobs/` (pg-boss jobs in the workers ECS service)
- Jobs: scheduler, discovery, kb-sync, right-sizing, agent-ops-scheduler, certificate-expiry-monitor
- Purpose: React components for each domain
- Location: `apps/web-ui/components/`
- Domain folders: `agent/`, `agent-ops/`, `inventory/`, `accounts/`, `schedules/`, `audit/`, `knowledge-base/`, `channels/`, `deep-agent/`
- Primitives: `apps/web-ui/components/ui/` — Radix-based shadcn/ui components (do not modify)
## Data Flow
- LangGraph thread state: PostgreSQL-backed checkpointer (`persistence.ts`), with optional S3 offload for large checkpoints
- Long-term agent memory: PostgreSQL store with Bedrock embeddings, 90-day TTL
- Chat session history: PostgreSQL (`agent_chat_history` table), 30-day TTL
- App config state (accounts, schedules, RBAC): PostgreSQL via Prisma repositories
- Audit logs: `audit_log` table (immutable, 30-day TTL via `expire_at`)
## Key Design Patterns
## Entry Points
- Location: `apps/web-ui/app/layout.tsx`
- Triggers: HTTP request to ECS Fargate container
- Responsibilities: Wraps all pages in `ThemeProvider`, `ThemeConfigProvider`, `LayoutWrapper`, NextAuth `Providers`
- Location: `apps/web-ui/app/api/chat/route.ts`
- Triggers: POST from chat UI component
- Responsibilities: Auth, thread lock, graph selection, streaming, PostgreSQL message persistence
- Location: `apps/web-ui/app/api/ask-ai/route.ts`
- Triggers: POST from inventory Ask AI dialog
- Responsibilities: Embed question, query S3 Vectors, fetch PostgreSQL resources, stream answer via Claude
- Location: `apps/workers/src/jobs/scheduler/`
- Triggers: pg-boss cron (per-tenant schedule) or manual job submission
- Responsibilities: Full or partial schedule scan, STS AssumeRole, resource start/stop
- Location: `apps/workers/src/jobs/discovery/`
- Triggers: pg-boss job (scheduled or on-demand)
- Responsibilities: Multi-account parallel resource scan (AWS SDK v3), PostgreSQL inventory writes
- Location: `infra/compute/index.ts`
- Triggers: `pulumi up --stack prod`
- Responsibilities: Provisions all compute resources (ECS web-ui + workers, RDS PostgreSQL, Cognito, CloudFront)
## Error Handling
- API routes: `try/catch` → `NextResponse.json({ error }, { status: 5xx })`
- Agent stream: Abort errors (client disconnect) handled silently; real errors logged and propagated via `controller.error()`
- Workers: each pg-boss job has top-level try/catch; failures are retried per pg-boss config and logged via `createLogger()`
## Cross-Cutting Concerns
<!-- GSD:architecture-end -->

<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd:profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->

