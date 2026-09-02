# Nucleus Ops — Tech Stack

A multi-tenant **AWS Cloud Operations Platform**: multi-account resource scheduling + an AI Ops agent powered by AWS Bedrock. This document catalogs the full stack from a full-stack development standpoint, sourced from the live `package.json` manifests and `CLAUDE.md`.

---

## Monorepo & Tooling

| Concern | Choice |
|---|---|
| Monorepo orchestrator | **Nx 21** (bare `nx` invoked from root npm scripts) |
| Package manager / runtime | **Bun 1.2.12** (workspaces, single hoisted install) |
| Node baseline | **Node.js 20.x** (`>=20.0.0`) |
| Language | **TypeScript ~5.6.2** (infra/root) · `^5.7.2` (workers) · `^5` (web-ui) |
| Build bundlers | tsc (workers), Next webpack (web-ui), Pulumi (infra) |
| Task visualization | `nx graph` |

---

## Frontend (`apps/web-ui`)

| Layer | Library |
|---|---|
| Framework | **Next.js 15.5.15** (App Router, `output: "standalone"`, SSR) |
| UI runtime | **React 19** (`react`, `react-dom`) |
| Styling | **Tailwind CSS ^3.4.17** + `tailwindcss-animate` + `@tailwindcss/typography`; `autoprefixer`, `postcss`, `postcss-import` |
| Component primitives | **Radix UI** (≈27 primitives: dialog, dropdown-menu, select, tabs, toast, tooltip, accordion, etc.) in shadcn/ui style; `class-variance-authority`, `clsx`, `tailwind-merge` (`cn()`), `cmdk`, `vaul`, `sonner`, `input-otp`, `embla-carousel-react`, `react-resizable-panels` |
| Icons | **lucide-react** ^0.454.0 |
| Tables | **TanStack React Table** ^8.21.3 |
| Forms/validation | **react-hook-form** ^7.54.1 + `@hookform/resolvers` + **Zod** ^4.0.0 |
| Charts | **Recharts** (latest) |
| Code editor | **Monaco** (`@monaco-editor/react` ^4.7.0) |
| Docs/MDX | **fumadocs** (`fumadocs-core` ^14.7.7, `fumadocs-ui` ^14.7.7, `fumadocs-mdx` ^10.0.2) + `@mdx-js/react`, `remark-gfm`, `react-markdown` |
| Theming | `next-themes` |
| Dates | `date-fns`, `date-fns-tz`, `dayjs`, `croner`, `cronstrue`, `react-day-picker` |
| Doc/PDF export | `html2pdf.js`, `jspdf`, `jszip`, `xlsx` |
| Markdown/PDF ingest | `pdf-parse`, `cheerio` |
| Crypto/misc | `bcryptjs`, `tweetnacl`, `uuid`, `jwt-decode` |

---

## Auth

| Concern | Choice |
|---|---|
| Session/auth | **NextAuth.js** (`next-auth` ^4.24.11) — Cognito + Credentials providers |
| DB sessions | `@auth/prisma-adapter` ^2.11.1 |
| Identity provider | **AWS Cognito** (user pool + app client) |
| Authorization | Custom **RBAC** (per-tenant roles, per-module permissions) — note: CLAUDE.md mentions CASL historically; the in-repo `lib/rbac/` is the custom system |

---

## Database & Persistence

| Concern | Choice |
|---|---|
| Primary DB | **PostgreSQL** (RDS in prod) |
| ORM | **Prisma** — `@prisma/client` v5 (web-ui + seed) and v6 (workers); dual generators; schema at `libs/prisma/schema.prisma` |
| Vector support | **pgvector** (embeddings in Postgres) |
| Driver | `pg` ^8.20.0 |
| Job queue | **pg-boss** (^10.4.2 web-ui, ^10.1.5 workers) |
| Long-term agent memory | MongoDB ^7.1.0 (deep-agent checkpointing) via `@langchain/langgraph-checkpoint-mongodb`; also `@langchain/langgraph-checkpoint-postgres` |
| Object storage | **AWS S3** (norm/inventory, KB docs, LangGraph large checkpoints) |
| Vectors at scale | **S3 Vectors** (`@aws-sdk/client-s3vectors`) |

---

## AI / Agent Layer

| Concern | Choice |
|---|---|
| Agent orchestration | **LangGraph** ^1.2.0 + **LangChain** ^1.2.28 (`@langchain/core` ^1.1.39, `@langchain/aws` ^1.3.0, `@langchain/openai` ^1.3.0) |
| Streaming hooks (UI) | **Vercel AI SDK** (`ai` ^5.0.115, `@ai-sdk/react`, `@ai-sdk/amazon-bedrock`, `@ai-sdk/anthropic`, `@ai-sdk/langchain`) |
| LLM provider | **AWS Bedrock** — Claude Sonnet 4.6 (`anthropic.claude-sonnet-4-6`) |
| MCP integration | `@modelcontextprotocol/sdk` ^1.26.0 |
| Deep agent framework | `deepagents` ^1.8.1 |
| Observability | **Langfuse** (`langfuse-langchain` ^3.38.6) |
| Agent types | fast-agent (reflection loop), planning-agent (multi-step), deep-agent (extended thinking) |

---

## Backend Services & Workers (`apps/workers`)

| Concern | Choice |
|---|---|
| Worker process | Single Node process via **pg-boss** (`pg-boss` ^10.1.5) |
| Jobs | scheduler/, discovery/, right-sizing/, kb-sync/, agent-ops-scheduler/, certificate-expiry-monitor/ |
| AWS SDK | **AWS SDK v3** — ~30 service clients across web-ui + workers (EC2, ECS, RDS, S3, SQS, STS, EventBridge, CloudWatch, IAM, Cognito, Lambda, ACM, WAFv2, EKS, EFS, Elasticache, CodePipeline, Secrets Manager, SSM, Backup, etc.) |
| Cross-account | STS `AssumeRole` exclusively (never hardcoded creds) |
| Concurrency | `p-limit` ^7.3.0 |
| Logging | `createLogger('service-name')` (workers); raw `console` (web-ui API routes) |
| Env loading | `--env-file=../../.env` (workers dev/start) · `dotenv.config({path:'../../.env'})` (web-ui) |

---

## Background Jobs (`apps/workers/src/jobs/`)

There are **no AWS Lambda functions** in this repository. The former Lambdas were migrated
to pg-boss jobs that run inside the `workers` ECS service, and the Python discovery
function was rewritten in TypeScript.

| Job | Purpose |
|---|---|
| `scheduler/` | Evaluates schedules and starts/stops resources across accounts |
| `discovery/` | Multi-account, multi-region resource scan (AWS SDK v3) |
| `right-sizing/` | CloudWatch-based recommendations + weekly pricing refresh |
| `kb-sync/` | Knowledge-base ingestion and embedding (S3, Bitbucket, Confluence) |
| `agent-ops-scheduler/` | Fires scheduled autonomous agent runs |
| `certificate-expiry-monitor/` | Flags ACM certificates nearing expiry |

---

## Infrastructure as Code (`infra/`)

| Stack | Manages | Libs |
|---|---|---|
| `infra/networking` | VPC, subnets, subnet groups | `@pulumi/pulumi` ^3.228, `@pulumi/aws` ^7.23, `@pulumi/awsx` ^3.3.1 |
| `infra/compute` | ECS Fargate (web-ui + workers), RDS PostgreSQL, Cognito, CloudFront, S3 (no Lambda) | `@pulumi/pulumi`, `@pulumi/aws`, `@pulumi/awsx` ^3.4, `@pulumi/command` ^1.2.1, `@pulumi/random` ^4.19.1 |

Deploy order: **networking → compute**. State backend: S3 (`s3://nucleus-pulumi-state`), secrets via KMS (`awskms://alias/pulumi-secrets`). Prod profile: `PLATFORM-ADMIN`.

---

## Testing

| Level | Tool |
|---|---|
| Unit — web-ui | **Vitest** ^4.0.18 + `@vitest/coverage-v8` |
| Unit — workers | **Vitest** ^2.1.8 |
| Unit — root | Jest ^29.7.0 + ts-jest ^29.2.5 |
| Property-based | `fast-check` ^4.5.3 |
| E2E browser | **Playwright** ^1.58.2 (`apps/web-ui-e2e/`, `implicitDependencies: ["web-ui"]`, `webServer` auto-starts `bun run dev` on :3001) |
| Misc | `puppeteer` ^24.38.0 (root devDep) |

---

## Linting / Type Checking

- **ESLint** ^9 + **eslint-config-next** 15.5.15 (extends `next/core-web-vitals` + `next/typescript`, which pulls in `@typescript-eslint/recommended` — hence the `no-explicit-any` rule currently flagging ~99 pre-existing files)
- **Nx plugin** `@nx/eslint-plugin` ^21
- Type checking via `tsc --noEmit` (workers `typecheck` target; web-ui has no `typecheck` target due to pre-existing tsc errors)

---

## Deployment & Runtime (prod)

| Concern | Choice |
|---|---|
| Container runtime | **ECS Fargate** — two services: `web-ui` and `workers`, both on `node:20-slim` |
| Image build | Dockerfile installs with Bun, builds under `node:20-slim` via `npm run build` (real Node + fresh `.next`) |
| CDN | **AWS CloudFront** in front of ALB + S3 — https://d2o00a2uwp9po0.cloudfront.net |
| Background jobs | pg-boss jobs in the `workers` service (per-tenant cron); no AWS Lambda |
| Audit | Every AWS-mutating action logged via `AuditService` (`audit_log` table, 30-day TTL) |

---

## Key Architectural Constraints

- **Multi-tenant safety**: every query goes through `getTenantClient(tenantId)`; `$executeRaw` is NOT intercepted — scope manually.
- **Repository pattern**: never call Prisma directly from services/API routes — use `@/lib/db/repository-factory`.
- **Path alias**: `@/` → `web-ui/` root.
- **Build guard**: the `web-ui:build` target uses `NODE_ENV=production next build` (Bun defaults NODE_ENV to `development`, which breaks Next's `/404` static export).
- **DynamoDB fully removed** — all state in PostgreSQL/S3.
- **AWS SDK v3 only** (never v2).
- **Cross-account AWS ops** use STS AssumeRole exclusively — no hardcoded credentials.