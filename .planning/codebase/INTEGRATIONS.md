# External Integrations

**Analysis Date:** 2026-04-08

## Cloud Services (AWS)

**Compute:**
- ECS Fargate — Hosts web-ui container and workers container (pg-boss job processor); defined in `infra/compute/index.ts`
- AWS Lambda — Two active functions: scheduler (`lambda/scheduler/`), kb_sync_processor (`lambda/kb_sync_processor/`)
- AWS Lambda Web Adapter (`public.ecr.aws/awsguru/aws-lambda-adapter:0.8.4`) — Enables response streaming from Next.js container on ECS (`web-ui/Dockerfile`)

**Networking:**
- VPC + Subnets + NAT Gateways — Defined in `infra/networking/index.ts`
- Application Load Balancer — Front-end for ECS service; `infra/compute/index.ts`
- AWS CloudFront — CDN in front of ALB and S3; `infra/compute/index.ts`
- AWS ACM — TLS certificates; optional custom domain

**Storage:**
- Amazon S3 — Normalized inventory data (`normalized/` prefix triggers SQS), checkpoint bucket, KB sync documents
  - Env var: `CHECKPOINT_S3_BUCKET`
  - Client: `@aws-sdk/client-s3` in `web-ui/lib/agent/tools.ts`
- S3 Vectors (`@aws-sdk/client-s3vectors`) — Vector index for semantic search (Ask AI, knowledge base embeddings)
  - Used in: `web-ui/lib/knowledge-base/embedder.ts`, `web-ui/app/api/ask-ai/route.ts`
  - Env vars: `KB_VECTOR_BUCKET_NAME`, `VECTOR_BUCKET_NAME`

**Messaging / Eventing:**
- Amazon SQS (`@aws-sdk/client-sqs`) — Queue + DLQ triggered from S3 `normalized/` prefix; feeds vector processing
- Amazon EventBridge (`@aws-sdk/client-eventbridge`) — Scheduled rules trigger scheduler Lambda; env var `EVENTBRIDGE_RULE_NAME`
- Amazon SNS (`@aws-sdk/client-sns`) — Email subscription alerts for scheduler events; env var `SUBSCRIPTION_EMAILS`

**AI / ML:**
- AWS Bedrock (`@aws-sdk/client-bedrock-runtime`, `@langchain/aws`, `@ai-sdk/amazon-bedrock`) — LLM inference via Claude 4.5 Sonnet model through `ChatBedrockConverse`; Titan v2 embeddings (1024-dim) for vector search
  - Model factory: `web-ui/lib/agent/model-factory.ts`
  - Embedder: `web-ui/lib/knowledge-base/embedder.ts` (model: `amazon.titan-embed-text-v2:0`)
  - Workers: `workers/src/jobs/kb-sync/` (embedding during KB sync)

**Identity / Access:**
- AWS STS (`@aws-sdk/client-sts`) — Cross-account role assumption for all multi-account resource operations
  - Used in: `web-ui/lib/account-service.ts`, `web-ui/lib/agent/aws-credentials-tool.ts`
  - Env var: `AWS_USE_STS=true`
- AWS IAM — Lambda execution roles, cross-account policies; `infra/compute/index.ts`
- Amazon Cognito (`@aws-sdk/client-cognito-identity-provider`) — User pool for identity management
  - Client singleton: `web-ui/lib/cognito-client.ts`
  - Env vars: `COGNITO_USER_POOL_ID`, `COGNITO_USER_POOL_CLIENT_ID`, `COGNITO_DOMAIN`, `COGNITO_ISSUER`, `COGNITO_IDENTITY_POOL_ID`, `COGNITO_APP_CLIENT_SECRET`

**Resource Discovery & Scheduling (AWS SDK v3 clients):**
- Amazon EC2 (`@aws-sdk/client-ec2`) — Instance start/stop, inventory discovery
- Amazon ECS (`@aws-sdk/client-ecs`) — Service scaling (desired count)
- Amazon RDS (`@aws-sdk/client-rds`) — DB instance start/stop
- Amazon Auto Scaling (`@aws-sdk/client-auto-scaling`) — Group min/max/desired capacity
- Amazon CloudWatch (`@aws-sdk/client-cloudwatch`) — Metrics + alarms
- Used in: `web-ui/lib/account-service.ts`, `web-ui/lib/agent/sandbox.ts`, `lambda/scheduler/src/`, `workers/src/jobs/`

**Workers-specific AWS clients (extended discovery):**
- `@aws-sdk/client-acm` — Certificate discovery
- `@aws-sdk/client-api-gateway` — API Gateway discovery
- `@aws-sdk/client-backup` — Backup discovery
- `@aws-sdk/client-cloudfront` — CloudFront distribution discovery
- `@aws-sdk/client-codepipeline` — Pipeline discovery
- `@aws-sdk/client-ecr` — Container registry discovery
- `@aws-sdk/client-efs` — EFS filesystem discovery
- `@aws-sdk/client-eks` — Kubernetes cluster discovery
- `@aws-sdk/client-elastic-load-balancing-v2` — ALB/NLB discovery
- `@aws-sdk/client-elasticache` — ElastiCache discovery
- `@aws-sdk/client-iam` — IAM resource discovery
- `@aws-sdk/client-kms` — KMS key discovery
- `@aws-sdk/client-secrets-manager` — Secrets Manager discovery
- `@aws-sdk/client-ssm` — Systems Manager parameter discovery
- `@aws-sdk/client-wafv2` — WAF discovery
- All in: `workers/package.json`

## APIs & Third-party Services

**Knowledge Base / Document Sources:**
- Atlassian Confluence — KB sync source; `lambda/kb_sync_processor/src/` (`dev:confluence` mode)
  - Auth: env vars `JIRA_BASE_URL`, `JIRA_USER_EMAIL`, `JIRA_API_TOKEN`
- Bitbucket — KB sync source; `lambda/kb_sync_processor/src/` (`dev:bitbucket` mode)
  - Auth: shared Atlassian API token

**Anthropic (direct):**
- `@ai-sdk/anthropic` ^2.0.56 — Alternative LLM provider alongside Bedrock
  - Used via Vercel AI SDK in `web-ui/`

## Auth & Identity

**Primary Auth:**
- NextAuth.js ^4.24.11 — Session management with database sessions (not JWT)
  - Adapter: `@auth/prisma-adapter` ^2.11.1 — Prisma-backed session storage
  - Config: `web-ui/app/api/auth/` routes
  - Session helper: `web-ui/lib/auth-session.ts`
  - Env vars: `NEXTAUTH_URL`, `NEXTAUTH_SECRET`

**Identity Provider:**
- Amazon Cognito — OAuth2/OIDC provider backed by Cognito User Pool
  - Client: `web-ui/lib/cognito-client.ts` (singleton `getCognitoClient()`)
  - OIDC issuer: `https://cognito-idp.<region>.amazonaws.com/<pool-id>`

**Credentials Auth:**
- `bcryptjs` ^3.0.3 — Password hashing for direct credentials login (dual auth: Cognito + Credentials)
  - Model: `AuthUser.passwordHash` in `prisma/schema.prisma`

**Authorization:**
- Custom RBAC system — Per-module permissions with custom roles per tenant
  - Location: `web-ui/lib/rbac/`
  - Model: `CustomRole` + `UserTenantRole` in `prisma/schema.prisma`
  - Tenant isolation: `getTenantClient()` middleware in `web-ui/lib/db/pg-config.ts`

## Databases & Storage

**Primary Application Database:**
- PostgreSQL — All application entities via Prisma ORM
  - Schema: `prisma/schema.prisma` (30+ models including Tenant, Account, Schedule, AuditLog, KnowledgeBase, InventoryResource, AgentOpsRun, ChatMessage, AgentMemory, auth tables)
  - Client singleton: `web-ui/lib/db/pg-config.ts` (`getPrismaClient()`, `getTenantClient()`)
  - Repository pattern: `web-ui/lib/db/repositories/` (12 domain repositories)
  - Repository factory: `web-ui/lib/db/repository-factory.ts`
  - Extensions: pgvector (1024-dim embeddings on `InventoryResource`, `AgentMemory`), tsvector (full-text search on `InventoryResource`)
  - Connection: `DATABASE_URL` env var; ECS uses `connection_limit=10`, Lambda uses `connection_limit=3`
  - Local dev: Docker Compose PostgreSQL (`npm run db:start`)

**Job Queue:**
- pg-boss (PostgreSQL-backed) — Distributed job queue for background processing
  - Config: `workers/src/boss.ts` (retry 3x, 30s delay, exponential backoff, 4h expiry, 7-day delete)
  - Three job types: scheduler (`workers/src/jobs/scheduler/`), discovery (`workers/src/jobs/discovery/`), kb-sync (`workers/src/jobs/kb-sync/`)
  - Entry point: `workers/src/index.ts`

**Legacy DynamoDB (still referenced):**
- Amazon DynamoDB — Single-table design tables still referenced in code alongside PostgreSQL
  - Client: `web-ui/lib/aws-config.ts` (`getDynamoDBDocumentClient()`)
  - ORM: `dynamoose` ^4.1.5 (serverExternalPackages)
  - Tables (env vars): `APP_TABLE_NAME`, `AUDIT_TABLE_NAME`, `DYNAMODB_USERS_TEAMS_TABLE`, `DYNAMODB_CHECKPOINT_TABLE`, `DYNAMODB_WRITES_TABLE`, `DYNAMODB_CHAT_HISTORY_TABLE`, `DYNAMODB_MEMORY_TABLE`

**Agent Checkpointing:**
- PostgreSQL via `@langchain/langgraph-checkpoint-postgres` ^1.0.1 — Primary LangGraph checkpointer (when `USE_PG_LANGGRAPH=true`)
- DynamoDB via `@farukada/aws-langgraph-dynamodb-ts` ^0.1.0 — Legacy checkpointer (feature-flagged)
- Both managed in: `web-ui/lib/agent/persistence.ts`

**Deep Agent Persistence (optional):**
- MongoDB / AWS DocumentDB — LangGraph MongoDB checkpointer for deep-agent
  - Packages: `mongodb` ^7.1.0, `@langchain/langgraph-checkpoint-mongodb` ^1.2.0
  - Client: `web-ui/lib/db/mongo-client.ts`, `web-ui/lib/deep-agent/db/safe-mongo-saver.ts`
  - Env vars: `MONGODB_URI`, `MONGODB_DB_NAME` (commented out by default in `.env.local.example`)

**Object Storage:**
- Amazon S3 — Normalized inventory JSON, vector processor payloads, KB documents, checkpoint offload
  - Env var: `CHECKPOINT_S3_BUCKET`

**Vector Store:**
- Amazon S3 Vectors — Semantic embeddings for inventory Ask AI and knowledge base search
  - Client: `@aws-sdk/client-s3vectors`
  - Embedder: `web-ui/lib/knowledge-base/embedder.ts`

## Observability

**LLM Tracing:**
- Langfuse — LLM trace logging for agent calls; feature-flagged via `LANGFUSE_ENABLED`
  - Package: `langfuse-langchain` ^3.38.6
  - Config: `web-ui/lib/agent/langfuse-config.ts` (dynamic import, zero overhead when disabled)
  - Env vars: `LANGFUSE_ENABLED`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST`

**Logging:**
- `console.log` / `console.error` — Raw console logging throughout (no structured logging library)
- Workers prefix log lines with `[workers]` and service name for job disambiguation

**Monitoring:**
- Amazon CloudWatch — Lambda metrics, DLQ depth alarms
  - Defined in: `infra/compute/index.ts`

## Notifications / Webhooks

**Slack:**
- Slack incoming webhooks / API — Agent Ops notifications and alerts
  - Env var: `SLACK_SIGNING_SECRET`

**Jira:**
- Atlassian Jira REST API — Issue creation and webhook callbacks
  - Env vars: `JIRA_WEBHOOK_SECRET`, `JIRA_BASE_URL`, `JIRA_USER_EMAIL`, `JIRA_API_TOKEN`

**SNS Email:**
- Amazon SNS email subscriptions — Scheduler action alerts
  - Env var: `SUBSCRIPTION_EMAILS`

## Environment Configuration

**Required env vars (web-ui):**
- `DATABASE_URL` — PostgreSQL connection string
- `AWS_REGION` — AWS region
- `NEXTAUTH_SECRET` — NextAuth session encryption
- `COGNITO_USER_POOL_ID` — Cognito user pool
- `COGNITO_USER_POOL_CLIENT_ID` — Cognito app client

**Required env vars (workers):**
- `DATABASE_URL` — PostgreSQL connection string (shared with pg-boss)

**Required env vars (lambda/scheduler):**
- `DATABASE_URL` — PostgreSQL connection string (`connection_limit=3`)

**Secrets location:**
- `.env.local` (web-ui, gitignored)
- `.env` (workers, root — gitignored)
- Pulumi secrets encrypted via KMS (`awskms://alias/pulumi-secrets`)
- ECS task definitions inject env vars at runtime from Pulumi config

---

*Integration audit: 2026-04-08*
