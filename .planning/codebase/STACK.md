# Technology Stack

**Analysis Date:** 2026-03-26

## Languages

**Primary:**
- TypeScript ~5.6.2 (CDK infrastructure, root) / ^5.0.0 (web-ui, lambdas) - All application and infrastructure code
- TypeScript ^5.7.2 - `lambda/scheduler/` Lambda function
- TypeScript ^5.0.0 - `lambda/kb_sync_processor/` Lambda function

**Secondary:**
- Python 3.x - `lambda/discovery/` and `lambda/vector_processor/` Lambda functions

## Runtime

**Environment:**
- Node.js 20.x (required by scheduler Lambda: `"node": ">=20.0.0"`)
- Container base image: `public.ecr.aws/docker/library/node:20.9.0-slim`
- Python 3.12 (local development)

**Package Manager:**
- npm 10.8.x (root), npm 11.x (web-ui dependency)
- Lockfiles: present at root `package-lock.json`, `web-ui/package-lock.json`, `lambda/scheduler/package-lock.json`, `lambda/kb_sync_processor/package-lock.json`

## Frameworks

**Core:**
- Next.js 15.2.4 (`web-ui/`) - App router, standalone output mode, server-side rendering
- React 19 (`web-ui/`) - UI rendering, functional components only
- AWS CDK v2 (`aws-cdk-lib` ^2.236.0, `aws-cdk` ^2.1104.0) - Infrastructure as Code at root

**AI / Agent:**
- LangGraph (`@langchain/langgraph` ^1.2.0) - Agent state machine workflows
- LangChain (`langchain` ^1.2.28, `@langchain/core` ^1.1.29, `@langchain/aws` ^1.3.0) - Tool definitions, LLM integration
- Vercel AI SDK (`ai` ^5.0.115, `@ai-sdk/react` ^2.0.116, `@ai-sdk/amazon-bedrock` ^3.0.71, `@ai-sdk/anthropic` ^2.0.56) - AI streaming hooks in web-ui
- Model Context Protocol (`@modelcontextprotocol/sdk` ^1.26.0) - MCP server integration

**UI Component Libraries:**
- Radix UI (multiple packages, versions 1.x–2.x) - Accessible UI primitives
- Tailwind CSS ^3.4.17 - Utility-first styling
- shadcn/ui pattern via `components.json` - Component scaffolding
- Lucide React ^0.454.0 - Icon library
- TanStack React Table ^8.21.3 - Data tables
- React Hook Form ^7.54.1 + Zod ^3.24.1 - Form handling and validation
- Recharts (latest) - Charts and analytics
- Monaco Editor ^4.7.0 - Code editor component
- fumadocs-core/mdx/ui ^14.7.7 - Documentation pages

**Data / ORM:**
- dynamoose ^4.1.5 - DynamoDB ORM (web-ui)
- `@aws-sdk/lib-dynamodb` ^3.821.0 - DynamoDB DocumentClient (web-ui)
- mongodb ^7.1.0 - MongoDB client (deep agent checkpointing)
- `@langchain/langgraph-checkpoint-mongodb` ^1.2.0 - LangGraph MongoDB checkpointer

**Testing:**
- Vitest ^4.0.18 (web-ui), Vitest ^2.1.8 (scheduler Lambda) - Unit tests
- Jest ^29.7.0 + ts-jest ^29.2.5 (root) - CDK infrastructure tests
- `@vitest/coverage-v8` ^4.0.18 - Coverage reporting
- fast-check ^4.5.3 - Property-based testing
- Playwright ^1.58.2 - E2E browser tests

**Build/Dev:**
- esbuild ^0.27.3 (root) / ^0.24.2 (scheduler Lambda) - TypeScript Lambda bundling
- tsc (kb_sync_processor Lambda) - TypeScript compilation
- ts-node ^10.9.2 - CDK app execution
- tsx ^4.19.2 - TypeScript execution for Lambda local runners
- PostCSS ^8 + autoprefixer ^10.4.20 - CSS processing

## Key Dependencies

**Critical:**
- `aws-cdk-lib` ^2.236.0 - All AWS infrastructure provisioning
- `@aws-cdk/aws-s3tables-alpha` ^2.236.0-alpha.0 - S3 Tables (Apache Iceberg)
- `cdk-s3-vectors` ^0.3.2 - S3 Vectors index construct
- `@aws-sdk/client-s3vectors` ^3.991.0 - S3 Vectors API client
- `next-auth` ^4.24.11 - Authentication session management
- `@casl/ability` ^6.8.0 - RBAC authorization
- `langfuse-langchain` ^3.38.6 - LLM observability integration
- `deepagents` ^1.8.1 - Deep agent framework
- `@farukada/aws-langgraph-dynamodb-ts` ^0.1.0 - DynamoDB checkpointer for LangGraph

**Infrastructure:**
- `pyiceberg[s3fs,glue]` - Apache Iceberg table management (discovery Lambda)
- `pyarrow` + `pandas` - Data processing (discovery Lambda)
- `boto3` >=1.38.0 - AWS SDK for Python Lambdas
- `dayjs` ^1.11.10 - Date/time scheduling logic (scheduler Lambda, root)
- `croner` ^10.0.1 + `cronstrue` ^3.13.0 - Cron schedule parsing/display
- `uuid` ^13.0.0 - ID generation

## Configuration

**Environment:**
- Root: `.env.example` contains AWS account, CDK context, Langfuse vars
- Web-UI: `web-ui/.env.local.example` contains AWS region, Cognito IDs, DynamoDB table names, NextAuth, Jira, Slack, MongoDB, Langfuse vars
- Scheduler Lambda: `lambda/scheduler/.env.example`
- Key required vars: `AWS_REGION`, `APP_TABLE_NAME`, `AUDIT_TABLE_NAME`, `NEXTAUTH_SECRET`, `COGNITO_USER_POOL_ID`, `COGNITO_USER_POOL_CLIENT_ID`

**Build:**
- Root CDK: `tsconfig.json` (ES2020, commonjs, strict mode), `cdk.json` (ts-node entry)
- Web-UI: `web-ui/tsconfig.json`, `web-ui/next.config.mjs` (standalone output, MDX via fumadocs)
- Web-UI: `web-ui/tailwind.config.ts`, `web-ui/postcss.config.mjs`
- Scheduler Lambda: `lambda/scheduler/tsconfig.json` (esbuild bundles to `dist/index.js`)
- KB Sync Lambda: `lambda/kb_sync_processor/tsconfig.json` (tsc compile)

## Platform Requirements

**Development:**
- Node.js 20+
- Python 3.x (for discovery/vector_processor Lambdas)
- AWS CLI + named profile (e.g., `PLATFORM-ADMIN`)
- Docker (for Langfuse local observability stack via `docker-compose.langfuse.yml`)

**Production:**
- AWS ECS Fargate (web-ui container, Node 20.9.0-slim + AWS Lambda Web Adapter 0.8.4)
- AWS Lambda (scheduler, discovery, vector_processor, kb_sync_processor)
- AWS CloudFront (CDN in front of ALB and S3)
- Deployment: AWS CDK via `npx cdk deploy`

---

*Stack analysis: 2026-03-26*
