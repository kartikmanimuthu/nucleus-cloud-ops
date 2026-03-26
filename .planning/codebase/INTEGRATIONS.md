# External Integrations

**Analysis Date:** 2026-03-26

## Cloud Services (AWS)

**Compute:**
- ECS Fargate - Hosts web-UI container and discovery Lambda runner; defined in `lib/computeStack.ts`
- AWS Lambda - Four functions: scheduler (`lambda/scheduler/`), discovery (`lambda/discovery/`), vector_processor (`lambda/vector_processor/`), kb_sync_processor (`lambda/kb_sync_processor/`)
- AWS Lambda Web Adapter (`public.ecr.aws/awsguru/aws-lambda-adapter:0.8.4`) - Enables response streaming from Next.js container

**Networking:**
- VPC + Subnets + NAT Gateways - Defined in `lib/networkingStack.ts`
- Application Load Balancer - Front-end for ECS service; `lib/computeStack.ts`
- AWS CloudFront - CDN in front of ALB and S3; `lib/computeStack.ts`, `lib/webUIStack.ts`
- AWS ACM - TLS certificates; optional custom domain; `lib/computeStack.ts`

**Storage:**
- Amazon S3 - Normalized inventory data (`normalized/` prefix triggers SQS), checkpoint bucket, KB sync documents; `lib/computeStack.ts`
- S3 Tables (Apache Iceberg, `@aws-cdk/aws-s3tables-alpha`) - Iceberg table format for inventory; `lib/computeStack.ts`
- S3 Vectors (`cdk-s3-vectors`, `@aws-sdk/client-s3vectors`) - Vector index for semantic search (Ask AI); `lib/computeStack.ts`, `lambda/kb_sync_processor/`, `lambda/vector_processor/`

**Messaging / Eventing:**
- Amazon SQS - Queue + DLQ triggered from S3 `normalized/` prefix; feeds vector_processor Lambda; `lib/computeStack.ts`
- Amazon EventBridge - Scheduled rules (every 30 min) trigger scheduler Lambda; `lib/cdkStack.ts`; env var `EVENTBRIDGE_RULE_NAME`
- Amazon SNS - Email subscription alerts for scheduler events; `lib/cdkStack.ts`; env var `SUBSCRIPTION_EMAILS`

**Database:**
- Amazon DynamoDB - Single-table design (`NucleusAppTable`) + audit table (`NucleusAuditTable`); checkpoint tables for LangGraph agent state; schema documented in `docs/schema-design.md`
  - Client: `@aws-sdk/lib-dynamodb` (DocumentClient) + `dynamoose` ORM
  - Tables (env vars): `APP_TABLE_NAME`, `AUDIT_TABLE_NAME`, `DYNAMODB_USERS_TEAMS_TABLE`, `DYNAMODB_CHECKPOINT_TABLE`, `DYNAMODB_WRITES_TABLE`, `DYNAMODB_CHAT_HISTORY_TABLE`, `DYNAMODB_MEMORY_TABLE`

**AI / ML:**
- AWS Bedrock (`@aws-sdk/client-bedrock-runtime`, `@langchain/aws`, `@ai-sdk/amazon-bedrock`) - LLM inference; Claude 4.5 Sonnet model via `ChatBedrockConverse`; Titan v2 embeddings (1024-dim) for vector search
  - Used in: `web-ui/lib/agent/model-factory.ts`, `lambda/kb_sync_processor/src/`, `lambda/vector_processor/src/`

**Identity / Access:**
- AWS STS (`@aws-sdk/client-sts`) - Cross-account role assumption (`CrossAccountRoleForCostOptimizationScheduler`) for all multi-account resource operations; env var `AWS_USE_STS=true`
- AWS IAM - Lambda execution roles, cross-account policies; `lib/computeStack.ts`, `lib/cdkStack.ts`
- Amazon Cognito (`@aws-sdk/client-cognito-identity-provider`) - User pool + identity pool; env vars `COGNITO_USER_POOL_ID`, `COGNITO_USER_POOL_CLIENT_ID`, `COGNITO_DOMAIN`, `COGNITO_ISSUER`, `COGNITO_IDENTITY_POOL_ID`

**Resource Discovery & Scheduling:**
- Amazon EC2 (`@aws-sdk/client-ec2`) - Instance start/stop; inventory discovery
- Amazon ECS (`@aws-sdk/client-ecs`) - Service scaling (desired count)
- Amazon RDS (`@aws-sdk/client-rds`) - DB instance start/stop
- Amazon Auto Scaling (`@aws-sdk/client-auto-scaling`) - Group min/max/desired capacity
- Amazon CloudWatch (`@aws-sdk/client-cloudwatch`) - Metrics + alarms; DLQ depth alarm; `lib/computeStack.ts`

**Data / Glue / Iceberg:**
- AWS Glue (via `pyiceberg[s3fs,glue]`) - Iceberg catalog for discovery Lambda; `lambda/discovery/requirements.txt`

## APIs & Third-party Services

**Knowledge Base / Document Sources:**
- Atlassian Confluence - KB sync source; `lambda/kb_sync_processor/src/` (`dev:confluence` mode)
  - Auth: env var `JIRA_BASE_URL`, `JIRA_USER_EMAIL`, `JIRA_API_TOKEN`
- Bitbucket - KB sync source; `lambda/kb_sync_processor/src/` (`dev:bitbucket` mode)
  - Auth: shared Atlassian API token

**Observability:**
- Langfuse - LLM trace logging for agent calls; optional but integrated
  - Package: `langfuse-langchain` ^3.38.6 in web-ui
  - Config: `web-ui/lib/agent/langfuse-config.ts`
  - Self-hosted locally via `docker-compose.langfuse.yml` (PostgreSQL 16 + ClickHouse 24.12 + Redis + MinIO + Langfuse server)
  - Env vars: `LANGFUSE_ENABLED`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST`

## Auth Providers

**Primary Auth:**
- NextAuth.js ^4.24.11 - Session management, route protection via `web-ui/middleware.ts`
  - Config: `web-ui/app/api/auth/` (implied by `withAuth` middleware)
  - Env vars: `NEXTAUTH_URL`, `NEXTAUTH_SECRET`

**Identity Provider:**
- Amazon Cognito - OAuth2/OIDC provider backed by Cognito User Pool
  - OIDC issuer: `https://cognito-idp.<region>.amazonaws.com/<pool-id>`
  - Env vars: `COGNITO_ISSUER`, `COGNITO_DOMAIN`, `COGNITO_APP_CLIENT_ID`, `COGNITO_APP_CLIENT_SECRET`

**Authorization:**
- CASL (`@casl/ability` ^6.8.0, `@casl/react` ^5.0.1) - RBAC ability definitions; `web-ui/lib/rbac/`

## Notifications / Webhooks

**Slack:**
- Slack incoming webhooks / API - Agent Ops notifications and alerts
  - Files: `web-ui/lib/agent-ops/slack-notifier.ts`, `web-ui/lib/agent-ops/slack-validator.ts`
  - Env var: `SLACK_SIGNING_SECRET`

**Jira:**
- Atlassian Jira REST API - Issue creation and webhook callbacks from CI/CD events
  - Files: `web-ui/lib/agent-ops/jira-notifier.ts`, `web-ui/lib/agent-ops/jira-validator.ts`
  - Env vars: `JIRA_WEBHOOK_SECRET`, `JIRA_BASE_URL`, `JIRA_USER_EMAIL`, `JIRA_API_TOKEN`

**SNS Email:**
- Amazon SNS email subscriptions - Scheduler action alerts; env var `SUBSCRIPTION_EMAILS`

## Data Stores

**Primary Application Database:**
- Amazon DynamoDB (single-table) - All application entities (accounts, schedules, resources, agent ops)
  - Env vars: `APP_TABLE_NAME` (default: `nucleus-app-app-table`), `AUDIT_TABLE_NAME`

**Agent Checkpointing:**
- Amazon DynamoDB - LangGraph checkpoint tables for fast-agent and planning-agent
  - Env vars: `DYNAMODB_CHECKPOINT_TABLE`, `DYNAMODB_WRITES_TABLE`
  - Client: `@farukada/aws-langgraph-dynamodb-ts` ^0.1.0

**Deep Agent Persistence (optional):**
- MongoDB / AWS DocumentDB - LangGraph MongoDB checkpointer for deep-agent
  - Package: `mongodb` ^7.1.0, `@langchain/langgraph-checkpoint-mongodb` ^1.2.0
  - Env vars: `MONGODB_URI`, `MONGODB_DB_NAME` (commented out by default)

**Object Storage:**
- Amazon S3 - Normalized inventory JSON, vector processor payloads, KB documents, CDK Lambda assets
  - Env var: `CHECKPOINT_S3_BUCKET`

**Vector Store:**
- Amazon S3 Vectors - Semantic embeddings for inventory Ask AI feature
  - Packages: `cdk-s3-vectors`, `@aws-sdk/client-s3vectors`

**Iceberg Tables:**
- Amazon S3 Tables (Apache Iceberg) - Columnar inventory data storage
  - Package: `@aws-cdk/aws-s3tables-alpha`, `pyiceberg[s3fs,glue]`

**Local Dev Observability (Docker Compose):**
- PostgreSQL 16 - Langfuse metadata/auth store (`docker-compose.langfuse.yml`)
- ClickHouse 24.12 - Langfuse trace analytics store (`docker-compose.langfuse.yml`)
- Redis - Langfuse queue/cache (`docker-compose.langfuse.yml`)
- MinIO - Langfuse local S3-compatible blob store (`docker-compose.langfuse.yml`)

---

*Integration audit: 2026-03-26*
