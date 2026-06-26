# Nucleus Cloud Ops — Features Guide

Nucleus Cloud Ops is a multi-tenant AWS Cloud Operations Platform that combines **multi-account resource scheduling**, **automatic inventory discovery**, **immutable audit logging**, and **AI-powered operations agents**. This guide describes every feature area available in the product.

---

## Table of Contents

1. [Dashboard & Cost Optimization](#dashboard--cost-optimization)
2. [AWS Account Management](#aws-account-management)
3. [Inventory & Resource Discovery](#inventory--resource-discovery)
4. [Schedule Management & Resource Scheduling](#schedule-management--resource-scheduling)
5. [Right Sizing (Cost Optimization)](#right-sizing-cost-optimization)
6. [Audit Logging & Compliance](#audit-logging--compliance)
7. [AI DevOps Agent (Interactive Chat)](#ai-devops-agent-interactive-chat)
8. [Agent Ops — Headless Triggered Agent](#agent-ops--headless-triggered-agent)
9. [Deep Agent](#deep-agent)
10. [Knowledge Base & RAG](#knowledge-base--rag)
11. [Channels & Gateway Integrations](#channels--gateway-integrations)
12. [Certificate Manager](#certificate-manager)
13. [RBAC, User Management & Tenant Settings](#rbac-user-management--tenant-settings)
14. [Settings & Customization](#settings--customization)
15. [Background Jobs & Async Execution](#background-jobs--async-execution)
16. [Documentation Hub](#documentation-hub)
17. [Infrastructure & Deployment](#infrastructure--deployment)

---

## Dashboard & Cost Optimization

A centralized executive view of scheduling operations, estimated savings, active accounts, agent runs, and audit activity.

### Key Capabilities

- View KPI cards: estimated savings, resources managed, active accounts, agent runs, schedule success rate, and audit events.
- Analyze cost trends over time (24h, 7d, 30d, 90d) and savings broken down by AWS account.
- Monitor operational health, inventory overview, knowledge-base statistics, agent analytics, and security audit sections.
- Quick navigation into accounts, schedules, inventory, audit logs, and agent chat.

### Relevant Code

- `web-ui/app/app/dashboard/page.tsx`
- `web-ui/components/dashboard/`
- `web-ui/lib/dashboard-service.ts`
- `web-ui/lib/dashboard-types.ts`
- `web-ui/app/api/dashboard/`

---

## AWS Account Management

Connect and manage multiple AWS accounts from a single interface using secure cross-account IAM roles via `sts:AssumeRole`.

### Key Capabilities

- Add, edit, delete, and import AWS accounts.
- Auto-generate CloudFormation templates for the cross-account IAM role.
- Validate assume-role connectivity before saving.
- View account status, discovered resource counts, and last sync times.
- Bulk account actions for large organizations.

### Relevant Code

- `web-ui/app/app/accounts/`
- `web-ui/components/accounts/`
- `web-ui/lib/account-service.ts`
- `web-ui/lib/client-account-service.ts`
- `web-ui/lib/cf-template-generator.ts`
- `web-ui/app/api/accounts/`
- `web-ui/lib/db/repositories/account/`

---

## Inventory & Resource Discovery

Automatically discover and inventory AWS resources across all connected accounts and regions.

### Key Capabilities

- Trigger manual or scheduled discovery scans.
- Browse discovered resources in a searchable, filterable grid.
- View resource details including tags, metadata, and current state.
- Export inventory data for reporting.
- Ask AI about inventory resources through the built-in RAG pipeline.

### Supported Resource Types

- EC2 instances, RDS databases, ECS services, Auto Scaling Groups, DocumentDB clusters.

### Relevant Code

- `web-ui/app/app/inventory/`
- `web-ui/components/inventory/`
- `web-ui/lib/inventory/`
- `web-ui/app/api/inventory/`
- `workers/src/jobs/discovery/`
- `libs/prisma/schema.prisma` (`InventoryResource`, `InventorySyncStatus`)

---

## Schedule Management & Resource Scheduling

Create time-based start/stop schedules for AWS resources across accounts to reduce non-production costs.

### Key Capabilities

- Create, edit, duplicate, and delete schedules with start/end times, active days, timezone, and target accounts.
- Select resources via full discovery scan, partial scan, or manual selection.
- Activate/deactivate schedules, execute on demand, and view execution history.
- Configure scheduler settings such as cron interval.
- Track schedule executions: resources started, stopped, skipped, or failed.

### Supported Resource Types

- EC2, RDS, ECS, Auto Scaling Groups, DocumentDB.

### Relevant Code

- `web-ui/app/app/schedules/`
- `web-ui/components/schedules/`
- `web-ui/lib/schedule-service.ts`
- `web-ui/lib/schedule-execution-service.ts`
- `web-ui/lib/client-schedule-service.ts`
- `web-ui/app/api/schedules/`
- `web-ui/app/api/scheduler/`
- `workers/src/jobs/scheduler/`
- `libs/prisma/schema.prisma` (`Schedule`, `ScheduleExecution`, `TargetedResource`)

---

## Right Sizing (Cost Optimization)

Analyzes real CloudWatch utilization of discovered compute/storage resources and produces
cost-saving right-sizing recommendations with a review workflow. Complements the Cost
Scheduler: scheduling saves by *stopping* resources, right-sizing saves by matching a
resource's *shape* to its actual demand. **v1 is recommend + review only** — no automated
resizing (the `applied` status is reserved for a future phase).

### Key Capabilities

- Classifies each resource as over-provisioned, under-provisioned, idle, or optimized from
  CPU, memory (CloudWatch agent), network, and IOPS over a configurable lookback (default 14d).
- Recommends a target instance type / DB class / volume change (incl. gp2→gp3) with estimated
  monthly savings, confidence (from data coverage), and risk level.
- Review workflow: approve / dismiss / snooze, fully audit-logged.
- Filterable table + KPI summary cards + per-recommendation detail dialog with utilization charts.
- Scheduled per-tenant refresh (pg-boss fan-out) + on-demand "Run scan"; pricing from a cached
  catalog refreshed weekly from the AWS Price List API.
- Queryable by the AI agent (text-to-SQL + `get_right_sizing_recommendations` tool).

### Supported Resource Types

- EC2 instances, RDS instances, EBS volumes, Auto Scaling Groups.
  (ASG analysis is dormant until autoscaling groups are added to discovery.)

### Configuration

- Gated by the `RIGHT_SIZING_ENABLED` feature flag (set `NEXT_PUBLIC_RIGHT_SIZING_ENABLED=true`
  to show the sidebar nav). RBAC: the `RightSizing` subject maps to the `Inventory` module.
- Assumed-role IAM (read-only): `cloudwatch:GetMetricData`, `cloudwatch:ListMetrics`,
  `ec2:Describe*`, `rds:Describe*`. The Price List API is called from the platform account.

### Relevant Code

- `web-ui/app/app/right-sizing/` · `web-ui/components/right-sizing/`
- `web-ui/lib/right-sizing-service.ts` · `web-ui/lib/right-sizing/` (config, types, feature flag)
- `web-ui/app/api/right-sizing/` (recommendations, runs, summary)
- `web-ui/lib/db/repositories/right-sizing/` · `web-ui/lib/db/repositories/pricing/`
- `web-ui/lib/agent/right-sizing-tool.ts`
- `workers/src/jobs/right-sizing/` (orchestrator, engine, rules, metric collector, pricing refresh)
- `prisma/schema.prisma` (`RightSizingRecommendation`, `RightSizingRun`, `PricingCatalogEntry`)
- `prisma/seed-pricing.ts`

---

## Right Sizing (Cost Optimization)

Analyzes real CloudWatch utilization of discovered compute/storage resources and produces
cost-saving right-sizing recommendations with a review workflow. Complements the Cost
Scheduler: scheduling saves by *stopping* resources, right-sizing saves by matching a
resource's *shape* to its actual demand. **v1 is recommend + review only** — no automated
resizing (the `applied` status is reserved for a future phase).

### Key Capabilities

- Classifies each resource as over-provisioned, under-provisioned, idle, or optimized from
  CPU, memory (CloudWatch agent), network, and IOPS over a configurable lookback (default 14d).
- Recommends a target instance type / DB class / volume change (incl. gp2→gp3) with estimated
  monthly savings, confidence (from data coverage), and risk level.
- Review workflow: approve / dismiss / snooze, fully audit-logged.
- Filterable table + KPI summary cards + per-recommendation detail dialog with utilization charts.
- Scheduled per-tenant refresh (pg-boss fan-out) + on-demand "Run scan"; pricing from a cached
  catalog refreshed weekly from the AWS Price List API.
- Queryable by the AI agent (text-to-SQL + `get_right_sizing_recommendations` tool).

### Supported Resource Types

- EC2 instances, RDS instances, EBS volumes, Auto Scaling Groups.
  (ASG analysis is dormant until autoscaling groups are added to discovery.)

### Configuration

- Gated by the `RIGHT_SIZING_ENABLED` feature flag (set `NEXT_PUBLIC_RIGHT_SIZING_ENABLED=true`
  to show the sidebar nav). RBAC: the `RightSizing` subject maps to the `Inventory` module.
- Assumed-role IAM (read-only): `cloudwatch:GetMetricData`, `cloudwatch:ListMetrics`,
  `ec2:Describe*`, `rds:Describe*`. The Price List API is called from the platform account.

### Relevant Code

- `web-ui/app/app/right-sizing/` · `web-ui/components/right-sizing/`
- `web-ui/lib/right-sizing-service.ts` · `web-ui/lib/right-sizing/` (config, types, feature flag)
- `web-ui/app/api/right-sizing/` (recommendations, runs, summary)
- `web-ui/lib/db/repositories/right-sizing/` · `web-ui/lib/db/repositories/pricing/`
- `web-ui/lib/agent/right-sizing-tool.ts`
- `workers/src/jobs/right-sizing/` (orchestrator, engine, rules, metric collector, pricing refresh)
- `prisma/schema.prisma` (`RightSizingRecommendation`, `RightSizingRun`, `PricingCatalogEntry`)
- `prisma/seed-pricing.ts`

---

## Audit Logging & Compliance

Immutable, tiered-retention audit trail for user actions, system events, agent tool executions, and external triggers.

### Key Capabilities

- View, filter, and search audit logs by status, user, date range, severity, and event type.
- Export audit logs for compliance reporting.
- View detailed log entries with full JSON context and correlation IDs.
- Dashboard audit stats for operational monitoring.

### Relevant Code

- `web-ui/app/app/audit/`
- `web-ui/components/audit/`
- `web-ui/lib/audit-service.ts`
- `web-ui/lib/client-audit-service.ts`
- `web-ui/app/api/audit/`
- `docs/audit-logging-requirements.md`
- `libs/prisma/schema.prisma` (`AuditLog`)

---

## AI DevOps Agent (Interactive Chat)

Natural-language cloud operations assistant powered by Claude via AWS Bedrock, using LangGraph with reflection, planning, execution, and revision.

### Key Capabilities

- Chat with the agent to analyze costs, run security audits, debug issues, or manage infrastructure.
- Choose from specialized skills: Cost Analyser, Cost Estimator, Cost Optimizer, Debugging, General Questionnaire, Network Ops, Security Analysis, SWE DevOps.
- Upload images for multimodal analysis.
- Select AWS account context, AI model, and auto-approve mode.
- View threaded chat history persisted in PostgreSQL.

### Available Tools

- AWS CLI execution with cross-account credentials.
- File read/write/list operations.
- S3 object access.
- Shell commands and web search.
- MCP (Model Context Protocol) server integrations.

### Relevant Code

- `web-ui/app/app/agent/`
- `web-ui/components/agent/`
- `web-ui/lib/agent/`
- `web-ui/lib/agent/skills/`
- `web-ui/lib/agent/tools.ts`
- `web-ui/lib/agent/planning-agent.ts`
- `web-ui/lib/agent/fast-agent.ts`
- `web-ui/lib/agent/model-factory.ts`
- `web-ui/lib/agent/mcp-tools.ts`
- `web-ui/lib/agent/memory-nodes.ts`
- `web-ui/app/api/chat/`
- `web-ui/app/api/ask-ai/`
- `docs/MULTIMODAL_SUPPORT.md`

---

## Agent Ops — Headless Triggered Agent

Asynchronous, headless AI agent runs triggered from external channels or scheduled tasks. Supports human-in-the-loop approvals and clarifications.

### Key Capabilities

- Create, view, and manage agent-ops runs.
- Configure scheduled agent tasks with cron expressions.
- Approve, reject, cancel, or resume agent runs.
- Configure Slack, Jira, Discord, Telegram, webhook, and MCP settings for inbound triggers.
- View run details and event timeline.

### Relevant Code

- `web-ui/app/app/agent-ops/`
- `web-ui/components/agent-ops/`
- `web-ui/lib/agent-ops/`
- `web-ui/lib/agent-ops/agent-ops-service.ts`
- `web-ui/lib/agent-ops/agent-executor.ts`
- `web-ui/lib/agent-ops/scheduled-task-service.ts`
- `web-ui/app/api/agent-ops/`
- `workers/src/jobs/agent-ops-scheduler/`
- `libs/prisma/schema.prisma` (`AgentOpsRun`, `AgentOpsEvent`, `ScheduledTask`, `ScheduledTaskLock`)

---

## Deep Agent

Advanced agent module built on the `deepagents` package with specialized sub-agents, long-term memory via MongoDB, and per-tool human-in-the-loop approval.

### Key Capabilities

- Use an advanced agent mode with deeper reasoning for complex tasks.
- Manage threads and todo panels.
- Approve individual tool calls before execution.
- Select skills and MCP servers for specialized workflows.

### Relevant Code

- `web-ui/app/app/deep-agent/`
- `web-ui/components/deep-agent/`
- `web-ui/lib/deep-agent/`
- `web-ui/lib/deep-agent/deep-agent-graph.ts`
- `web-ui/app/api/deep-agent/`

---

## Knowledge Base & RAG

Tenant-scoped knowledge bases with vector embeddings for semantic search and retrieval-augmented generation.

### Key Capabilities

- Create and manage knowledge bases per tenant.
- Add data sources: direct file upload, S3 bucket, Confluence, and Bitbucket.
- Sync data sources and track vector counts.
- Ask natural-language questions against a knowledge base.
- View source citations in answers.

### Relevant Code

- `web-ui/app/app/knowledge-base/`
- `web-ui/components/knowledge-base/`
- `web-ui/lib/knowledge-base/`
- `web-ui/lib/knowledge-base/service.ts`
- `web-ui/lib/knowledge-base/embedder.ts`
- `web-ui/app/api/knowledge-base/`
- `workers/src/jobs/kb-sync/`
- `libs/prisma/schema.prisma` (`KnowledgeBase`, `DataSource`, `KbDocumentChunk`)

---

## Channels & Gateway Integrations

Inbound and outbound channel gateway that connects the agent to Slack, Jira, Discord, Telegram, webhooks, and API triggers.

### Key Capabilities

- Configure channel settings for each integration.
- Receive inbound tasks from Slack slash commands, Jira webhooks, Discord interactions, Telegram messages, and generic webhooks.
- Send results, approval requests, and clarification questions back to the originating channel.
- Route events through an internal event bus.

### Relevant Code

- `web-ui/app/app/channels/`
- `web-ui/components/channels/`
- `web-ui/lib/gateway/`
- `web-ui/lib/gateway/gateway-service.ts`
- `web-ui/lib/gateway/adapter-registry.ts`
- `web-ui/lib/gateway/adapters/`
- `web-ui/app/api/v1/gateway/`
- `web-ui/app/api/v1/trigger/`

---

## Certificate Manager

Upload and manage TLS certificates, track expiry status, and deploy certificates to AWS accounts and ACM.

### Key Capabilities

- Upload certificate body, private key, and chain.
- View certificate status (active, expiring, expired).
- Associate certificates with AWS accounts.
- Deploy certificates to ACM.
- Download certificate content and re-import certificates.
- Daily expiry monitoring via background job.

### Relevant Code

- `web-ui/app/app/certificates/`
- `web-ui/components/certificates/`
- `web-ui/lib/certificate-utils.ts`
- `web-ui/app/api/certificates/`
- `workers/src/jobs/certificate-expiry-monitor/`
- `libs/prisma/schema.prisma` (`Certificate`)

---

## RBAC, User Management & Tenant Settings

Multi-tenant access control with predefined roles and custom roles, plus tenant-scoped settings and member invitations.

### Key Capabilities

- Invite, resend, and revoke organization members.
- Assign predefined roles: Owner, Admin, Member, Viewer.
- Create custom roles with per-module permissions.
- Switch between organizations.
- Update organization profile, logo, and timezone.
- Configure auth providers and self-hosted LLM providers.

### Relevant Code

- `web-ui/app/app/settings/`
- `web-ui/components/settings/`
- `web-ui/lib/rbac/`
- `web-ui/lib/rbac/permissions.ts`
- `web-ui/lib/rbac/custom-role-service.ts`
- `web-ui/lib/tenant-settings-service.ts`
- `web-ui/lib/tenant-config-service.ts`
- `web-ui/lib/invitation-service.ts`
- `web-ui/app/api/settings/`
- `web-ui/app/api/invitations/`
- `web-ui/app/api/tenants/`
- `libs/prisma/schema.prisma` (`UserTenantRole`, `CustomRole`, `Invitation`, `Tenant`, `TenantConfig`, `ProviderModel`, `AuthUser`)

---

## Settings & Customization

Personalization and platform configuration for users and organizations.

### Key Capabilities

- Switch themes: light, dark, or system.
- Choose from multiple accent color schemes.
- Customize typography and border radius.
- Update user profile and notification preferences.
- Configure discovery, scheduler, MCP, provider, and theme settings.

### Relevant Code

- `web-ui/components/settings/theme-settings.tsx`
- `web-ui/components/settings/theme-registry.ts`
- `web-ui/components/settings/profile-form.tsx`
- `web-ui/components/settings/organization-settings-form.tsx`
- `web-ui/components/settings/discovery-settings.tsx`
- `web-ui/components/settings/scheduler-settings.tsx`
- `web-ui/components/settings/mcp-settings.tsx`
- `web-ui/components/settings/provider-settings.tsx`

---

## Background Jobs & Async Execution

All background processing is handled by pg-boss worker jobs running on ECS Fargate, with job queues stored in PostgreSQL.

### Key Jobs

| Job | Purpose |
|-----|---------|
| **Scheduler Scan** | Evaluates schedules every 5 minutes and starts/stops resources across EC2, RDS, ECS, ASG, and DocumentDB. |
| **Discovery Fan-out / Scan** | Daily scan of all connected accounts to refresh the inventory. |
| **KB Sync** | Processes file uploads, S3 syncs, Confluence, and Bitbucket ingestion with vector embeddings. |
| **Agent Ops Scheduler** | Cron-triggered scheduled agent tasks. |
| **Certificate Expiry Monitor** | Daily monitoring of TLS certificate expiry. |

### Relevant Code

- `workers/src/jobs/scheduler/`
- `workers/src/jobs/discovery/`
- `workers/src/jobs/kb-sync/`
- `workers/src/jobs/agent-ops-scheduler/`
- `workers/src/jobs/certificate-expiry-monitor/`
- `workers/src/executor/`
- `workers/src/boss.ts`
- `workers/src/index.ts`

---

## Documentation Hub

Built-in documentation pages rendered with Fumadocs, accessible from the application.

### Relevant Code

- `web-ui/app/(docs)/docs/`
- `docs/`

---

## Infrastructure & Deployment

Infrastructure as Code using Pulumi. Deploys networking, compute (ECS Fargate for Next.js and workers), RDS PostgreSQL, Cognito auth, S3, IAM, and CI/CD pipelines.

### Key Capabilities

- **Networking stack**: VPC, public/private/database/intra subnets, subnet groups.
- **Compute stack**: ECS cluster, RDS PostgreSQL, Cognito user pools, S3 buckets with lifecycle policies, ECR, IAM roles.
- **CI/CD stack**: CodePipeline/CodeBuild with buildspecs for preview, build, and deploy.

### Relevant Code

- `infra/networking/index.ts`
- `infra/compute/index.ts`
- `infra/cicd/index.ts`
- `infra/cicd/buildspec-*.yml`
- `docker-compose.yml`
- `docker-compose.workers.yml`
- `docs/deployment.md`
- `infra/DEPLOYMENT.md`

---

## Core Technology Stack

| Layer | Technology |
|-------|------------|
| Frontend | Next.js 15, React 19, Tailwind CSS, Radix UI, Recharts |
| Backend API | Next.js App Router API routes |
| AI/Agent | LangGraph, LangChain, AWS Bedrock (Claude), `deepagents`, MCP |
| Database | PostgreSQL + Prisma ORM |
| Vector Search | pgvector |
| Background Jobs | pg-boss + ECS Fargate workers |
| Auth | NextAuth.js + AWS Cognito + credentials provider |
| Infrastructure | Pulumi (networking/compute/cicd) |
| Object Storage | Amazon S3 |
| Messaging/Channels | Slack, Jira, Discord, Telegram, Webhook adapters |

---

## Best Practices

### Schedule Design

1. Start conservative: begin with fewer resources and expand.
2. Add buffer time around business hours.
3. Use **Execute Now** to validate before activation.
4. Monitor audit logs after initial deployment.

### Account Management

1. Grant least-privilege IAM permissions only.
2. Review connected accounts monthly.
3. Use descriptive account names for clarity.

### AI Agent Usage

1. Be specific: detailed prompts yield better results.
2. Verify actions before enabling auto-approve.
3. Iterate with follow-up questions to refine results.

---

## Getting Help

- **Documentation**: `docs/` folder in the repository.
- **Issues**: GitHub Issues for bug reports.
- **Audit Trail**: Check Audit Logs for troubleshooting.
