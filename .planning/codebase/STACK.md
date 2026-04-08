# Technology Stack

**Analysis Date:** 2026-04-08

## Languages

**Primary:**
- TypeScript ~5.6.2 (root, Pulumi infra `infra/networking/`, `infra/compute/`)
- TypeScript ^5.0 (`web-ui/package.json`, `lambda/kb_sync_processor/package.json`)
- TypeScript ^5.7.2 (`lambda/scheduler/package.json`, `workers/package.json`)

**Secondary:**
- Python 3.x — `lambda/discovery/` (resource discovery ECS task; directory exists but empty on this branch)

## Runtime

**Environment:**
- Node.js 20.x (required by scheduler Lambda and workers: `"node": ">=20.0.0"`)
- Container base image: `public.ecr.aws/docker/library/node:20.9.0-slim` (both `web-ui/Dockerfile` and `workers/Dockerfile`)

**Package Manager:**
- npm (all packages — root, web-ui, workers, lambda/scheduler, lambda/kb_sync_processor, infra/networking, infra/compute)
- Lockfiles present: `package-lock.json` (root), `web-ui/package-lock.json`, `lambda/scheduler/package-lock.json`, `workers/package-lock.json`

## Frameworks

**Core:**
- Next.js 15.2.4 (`web-ui/package.json`) — App Router, standalone output mode, MDX via fumadocs
- React 19 (`web-ui/package.json`) — Functional components only
- Prisma ORM ^5.22.0 (`prisma/schema.prisma`, `web-ui/package.json`, root) / ^6.0.0 (`workers/package.json`) — PostgreSQL data access with tenant-scoped client via `$extends`
- pg-boss ^10.1.5 (`workers/package.json`) / ^10.4.2 (`web-ui/package.json`) — PostgreSQL-backed distributed job queue (replaces Lambda-based cron scheduling)

**AI/Agent:**
- LangGraph `@langchain/langgraph` ^1.2.0 — Agent state machine workflows
- LangChain `langchain` ^1.2.28, `@langchain/core` ^1.1.29, `@langchain/aws` ^1.3.0 — Tool definitions, LLM integration
- Vercel AI SDK `ai` ^5.0.115, `@ai-sdk/react` ^2.0.116, `@ai-sdk/amazon-bedrock` ^3.0.71, `@ai-sdk/anthropic` ^2.0.56 — Streaming hooks
- Model Context Protocol `@modelcontextprotocol/sdk` ^1.26.0 — MCP server integration
- deepagents ^1.8.1 — Deep agent framework

**UI:**
- Radix UI (multiple packages, 1.x–2.x) — Accessible UI primitives (shadcn/ui pattern via `components.json`)
- Tailwind CSS ^3.4.17 + tailwindcss-animate ^1.0.7 — Utility-first styling
- TanStack React Table ^8.21.3 — Data tables
- Recharts (latest) — Charts and analytics
- Monaco Editor ^4.7.0 — Code editor component
- Lucide React ^0.454.0 — Icon library
- fumadocs-core/mdx/ui ^14.7.7 — Documentation pages
- cmdk 1.0.4 — Command palette
- sonner ^1.7.1 — Toast notifications
- vaul ^1.0.0 — Drawer component
- embla-carousel-react 8.5.1 — Carousel

**Infrastructure:**
- Pulumi `@pulumi/pulumi` ^3.228.0, `@pulumi/aws` ^7.23.0, `@pulumi/awsx` ^3.4.0, `@pulumi/command` ^1.2.1, `@pulumi/random` ^4.19.1 — IaC (`infra/networking/`, `infra/compute/`)

**Testing:**
- Vitest ^4.0.18 (`web-ui/`) — Unit tests with `@vitest/coverage-v8` ^4.0.18
- Vitest ^2.1.8 (`lambda/scheduler/`, `workers/`) — Unit tests
- Jest ^29.7.0 + ts-jest ^29.2.5 (root) — Root-level tests
- fast-check ^4.5.3 (`web-ui/`) — Property-based testing
- Playwright ^1.58.2 (root) — E2E browser tests

**Build/Dev:**
- esbuild ^0.27.3 (root) / ^0.24.2 (`lambda/scheduler/`) — Lambda bundling (externals: `@aws-sdk/*`, `pg`)
- tsc (`lambda/kb_sync_processor/`, `workers/`) — TypeScript compilation
- ts-node ^10.9.2 (root) — TypeScript execution for scripts
- tsx ^4.19.2 (root, `lambda/scheduler/`, `lambda/kb_sync_processor/`, `workers/`) — TypeScript execution for local runners and dev mode
- PostCSS ^8 + autoprefixer ^10.4.20 + postcss-import ^16.1.1 — CSS processing
- ESLint ^9 + eslint-config-next 15.3.3 (`web-ui/`) — Linting (no Prettier detected)

## Key Dependencies

**Critical:**
- `@prisma/client` ^5.22.0 (web-ui, root) / ^6.0.0 (workers) — PostgreSQL ORM with tenant-scoped middleware
- `pg` ^8.20.0 (`lambda/scheduler/`, `workers/`) — Raw PostgreSQL client for non-Prisma contexts
- `pg-boss` ^10.x — Distributed job queue backed by PostgreSQL (scheduler, discovery, kb-sync jobs)
- `next-auth` ^4.24.11 + `@auth/prisma-adapter` ^2.11.1 — Authentication with database sessions
- `bcryptjs` ^3.0.3 — Password hashing for credentials auth
- `zod` ^3.24.1 — Schema validation
- `react-hook-form` ^7.54.1 + `@hookform/resolvers` ^3.9.1 — Form handling

**AWS SDK v3 (always v3, never v2):**
- `@aws-sdk/client-s3vectors` ^3.991.0+ — S3 Vectors API for knowledge base embeddings
- `@aws-sdk/client-bedrock-runtime` — LLM inference and embeddings
- `@aws-sdk/client-sts` — Cross-account role assumption
- `@aws-sdk/client-cognito-identity-provider` — User management
- `@aws-sdk/client-ec2`, `client-ecs`, `client-rds`, `client-auto-scaling` — Resource scheduling/discovery
- `@aws-sdk/client-s3`, `client-sqs`, `client-sns`, `client-eventbridge`, `client-lambda`, `client-cloudwatch` — Infrastructure services
- `@aws-sdk/lib-dynamodb` ^3.821.0 — DynamoDB DocumentClient (legacy, still used alongside PostgreSQL)
- `@aws-sdk/credential-providers` ^3.821.0 — Credential chain
- Workers additionally use: `client-acm`, `client-api-gateway`, `client-backup`, `client-cloudfront`, `client-codepipeline`, `client-ecr`, `client-efs`, `client-eks`, `client-elastic-load-balancing-v2`, `client-elasticache`, `client-iam`, `client-kms`, `client-secrets-manager`, `client-ssm`, `client-wafv2`

**Agent Persistence:**
- `@langchain/langgraph-checkpoint-postgres` ^1.0.1 — LangGraph PostgreSQL checkpointer (primary)
- `@farukada/aws-langgraph-dynamodb-ts` ^0.1.0 — DynamoDB checkpointer (legacy, feature-flagged via `USE_PG_LANGGRAPH`)
- `mongodb` ^7.1.0 + `@langchain/langgraph-checkpoint-mongodb` ^1.2.0 — Deep agent checkpointing
- `dynamoose` ^4.1.5 — DynamoDB ORM (legacy, serverExternalPackages in `web-ui/next.config.mjs`)

**Utility:**
- `dayjs` ^1.11.10 — Date/time scheduling logic
- `croner` ^10.0.1 + `cronstrue` ^3.13.0 — Cron schedule parsing/display
- `uuid` ^13.0.0 / ^11.0.3 — ID generation
- `p-limit` ^7.3.0 — Concurrency control (workers)
- `cheerio` ^1.2.0 — HTML parsing
- `pdf-parse` — PDF text extraction
- `xlsx` ^0.18.5 — Excel file handling
- `jspdf` ^4.0.0 + `html2pdf.js` ^0.14.0 — PDF generation
- `react-markdown` ^10.1.0 + `remark-gfm` ^4.0.1 — Markdown rendering
- `langfuse-langchain` ^3.38.6 — LLM observability (feature-flagged via `LANGFUSE_ENABLED`)
- `class-variance-authority` ^0.7.1 + `clsx` ^2.1.1 + `tailwind-merge` ^2.5.5 — CSS class utilities
- `date-fns` (latest) — Date utilities
- `next-themes` (latest) — Theme switching
- `dotenv` ^16.5.0 / ^17.3.1 — Environment variable loading

## Configuration

**Environment:**
- Root: `.env.example` — AWS account, Pulumi config, Langfuse vars
- Web-UI: `web-ui/.env.local.example` — AWS region, Cognito IDs, DynamoDB table names, NextAuth, Jira, Slack, MongoDB, Langfuse, PostgreSQL `DATABASE_URL`, feature flags
- Workers: `workers/.env.example` — `DATABASE_URL`, AWS config
- Scheduler Lambda: `lambda/scheduler/.env.example`
- Key required vars: `DATABASE_URL`, `AWS_REGION`, `NEXTAUTH_SECRET`, `COGNITO_USER_POOL_ID`, `COGNITO_USER_POOL_CLIENT_ID`
- Feature flags (all `true` — PostgreSQL is sole backend): `USE_PG_TENANT_CONFIG`, `USE_PG_ACCOUNTS`, `USE_PG_SCHEDULES`, `USE_PG_AUDIT`, `USE_PG_KB`, `USE_PG_INVENTORY`, `USE_PG_AGENT_OPS`

**Build:**
- `web-ui/next.config.mjs` — standalone output, MDX via fumadocs, `serverExternalPackages: ['aws-sdk', 'dynamoose']`, `ignoreBuildErrors: true`, `ignoreDuringBuilds: true` (ESLint)
- `web-ui/tailwind.config.ts` — Tailwind configuration
- `web-ui/postcss.config.mjs` — PostCSS with autoprefixer
- `web-ui/tsconfig.json` — strict, bundler moduleResolution, `@/*` path alias to web-ui root
- Root `tsconfig.json` — ES2020 target, commonjs module, strict mode
- `workers/tsconfig.json` — Workers TypeScript config (ESM module type)
- `lambda/scheduler/` — esbuild bundles to `dist/index.js`, externals `@aws-sdk/*` and `pg`

**Prisma:**
- Schema: `prisma/schema.prisma` — PostgreSQL provider, output to `web-ui/node_modules/.prisma/client`
- Binary targets: `native` + `linux-arm64-openssl-3.0.x` (for ARM64 ECS Fargate)
- Migrations: `prisma/migrations/`
- Seed: `prisma/seed.ts`
- Dev commands in `web-ui/package.json`: `db:start`, `db:stop`, `db:generate`, `db:migrate`, `db:studio`, `db:seed`, `db:reset`
- Pre-dev/pre-start hooks run `prisma migrate deploy` automatically

## Platform Requirements

**Development:**
- Node.js 20+
- Docker (for local PostgreSQL via `docker compose up -d postgres`)
- AWS CLI + named profile (e.g., `PLATFORM-ADMIN`) for DynamoDB/AWS access
- npm for all package management

**Production:**
- AWS ECS Fargate — web-ui container (Node 20.9.0-slim + AWS Lambda Web Adapter 0.8.4, port 8080)
- AWS ECS Fargate — workers container (Node 20.9.0-slim, pg-boss job processor with 3 job types: scheduler, discovery, kb-sync)
- AWS Lambda — scheduler function (esbuild bundle, Node 20)
- AWS Lambda — kb_sync_processor function (tsc compile)
- AWS CloudFront — CDN in front of ALB and S3
- PostgreSQL (RDS or Aurora) — primary data store (with pgvector extension for embeddings)
- Deployment: Pulumi via `pulumi up --stack prod` (networking → compute order)
- Pulumi state: S3 backend (`s3://nucleus-pulumi-state`), KMS secrets (`awskms://alias/pulumi-secrets`)

---

*Stack analysis: 2026-04-08*
