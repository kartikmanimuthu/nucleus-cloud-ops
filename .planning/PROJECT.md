# Nucleus Cloud Ops Platform

## What This Is

AWS Cloud Operations Platform — multi-account resource scheduling + AI Ops agent powered by AWS Bedrock. v1.0 completed a full DynamoDB → PostgreSQL migration (Prisma ORM, repository pattern, feature flags, pgvector). v2.0 replaces AWS CDK with Pulumi TypeScript for the core infrastructure stacks (NetworkingStack + ComputeStack), using an S3 backend for state.

## Core Value

A fully operational cloud ops platform with modern IaC: Pulumi TypeScript managing all core AWS infrastructure (VPC, ECS Fargate, ALB, CloudFront, Lambda, DynamoDB, SQS, EventBridge, Cognito) — CDK removed for migrated stacks, WebUIStack stays in CDK.

## Current Milestone: v2.0 Pulumi IaC Migration

**Goal:** Replace AWS CDK with Pulumi TypeScript for NetworkingStack and ComputeStack — full rewrite, CDK removed for those stacks.

**Target features:**
- Pulumi project scaffold with S3 backend + DynamoDB lock table
- NetworkingStack rewrite: VPC, subnets, security groups, NAT gateway
- ComputeStack rewrite: ECS Fargate, ALB, CloudFront, Lambda functions, DynamoDB tables, SQS, EventBridge, Cognito, S3 buckets
- Stack outputs wired to web-ui env vars (same values, different source)
- CDK removed for migrated stacks (bin/, lib/networkingStack.ts, lib/computeStack.ts)

## Current State (v1.0 — 2026-03-28)

- **5 phases complete**, 28 plans, 50+ commits
- **Prisma schema**: 15+ models covering all migrated entities
- **Repository layer**: Interface + DynamoDB + PostgreSQL implementations for every entity
- **Feature flags**: `USE_PG_TENANT_CONFIG`, `USE_PG_ACCOUNTS`, `USE_PG_SCHEDULES`, `USE_PG_AUDIT_LOGS`, `USE_PG_KB`, `USE_PG_INVENTORY`, `USE_PG_AGENT_OPS`, `USE_PG_LANGGRAPH`
- **Migration scripts**: `migrate-all.ts` orchestrates 8 scripts in dependency order; `verify-migration.ts` validates row counts
- **Tests**: 100+ unit tests (Vitest), Playwright E2E tests for all major flows
- **pgvector**: Docker Compose uses `pgvector/pgvector:pg16` for semantic memory search
- **AgentConversationsTable**: Confirmed dead code, removed from CDK

## Requirements

### Validated — v1.0

- ✓ Docker Compose + Prisma ORM foundation (connection pooling, migration tooling, repository factory) — v1.0
- ✓ Tenant config migration (DynamoDB → PostgreSQL) with repository pattern — v1.0
- ✓ Accounts + RBAC migration with server-side filtering and cross-tenant isolation — v1.0
- ✓ Schedules + Executions + Audit Logs migration (Lambda pg-service, dual-write, TTL cleanup) — v1.0
- ✓ Knowledge Base + DataSource migration with atomic counter updates — v1.0
- ✓ Inventory migration (Python discovery Lambda via psycopg2, flat JSONB schema) — v1.0
- ✓ Agent Ops migration (Dynamoose → Prisma, ON CONFLICT lock acquisition) — v1.0
- ✓ LangGraph persistence migration (PostgresSaver, pgvector memory store, PostgresChatHistory) — v1.0
- ✓ Data migration scripts for all tables (migrate-all.ts + verify-migration.ts) — v1.0
- ✓ Unit tests (TDD) for each repository implementation — v1.0
- ✓ Playwright E2E tests for all migrated modules — v1.0
- ✓ AgentConversationsTable confirmed dead code, CDK definition removed — v1.0

### Active — v2.0

- [ ] Pulumi project scaffold: S3 backend, DynamoDB lock table, TypeScript config — PULUMI-01
- [ ] NetworkingStack: VPC, subnets (public/private), security groups, NAT gateway — PULUMI-02
- [ ] ComputeStack — ECS: Fargate cluster, task definitions, ALB, CloudFront — PULUMI-03
- [ ] ComputeStack — Lambda: scheduler, discovery, vector_processor, kb_sync_processor — PULUMI-04
- [ ] ComputeStack — Data: DynamoDB tables, SQS queues, EventBridge rules, Cognito, S3 — PULUMI-05
- [ ] Stack outputs wired to web-ui env vars; CDK removed for migrated stacks — PULUMI-06

### Out of Scope

- Rewriting discovery Lambda from Python to TypeScript — keep Python with psycopg2
- Performance benchmarking DynamoDB vs PostgreSQL — migration correctness was priority
- Schema redesign beyond what migration required — matched existing data model

## Constraints

- **AWS Profile**: All migration scripts use `AWS_PROFILE=PLATFORM-ADMIN` for DynamoDB access
- **Zero downtime**: Feature flags per entity enable instant rollback; DynamoDB tables never deleted
- **Lambda cold starts**: Prisma engine ~2-4MB — monitor cold start impact in production
- **Python Lambda**: Discovery Lambda stays Python with psycopg2
- **Multi-tenant safety**: Every PostgreSQL query includes `WHERE tenant_id = $1`

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Prisma ORM over Drizzle | User prefers Prisma DX; accepted Lambda bundle size trade-off | ✓ Shipped — works well, cold start impact TBD |
| Repository pattern with feature flags | Zero-downtime migration, instant rollback per entity | ✓ Shipped — 8 feature flags, all working |
| Migrate LangGraph tables to PostgreSQL | Consolidate all persistence in one database | ✓ Shipped — PostgresSaver + pgvector memory |
| Keep discovery Lambda in Python | Avoid risky rewrite; add psycopg2 instead | ✓ Shipped — dual-write via pg_writer.py |
| Docker Compose for local dev | Defer cloud DB decision; fast local iteration | ✓ Shipped — pgvector/pgvector:pg16 image |
| AgentConversationsTable is dead code | Zero app code references confirmed by grep | ✓ Confirmed — CDK definition removed |
| Fresh start for LangGraph chat/memory | Ephemeral data (30/90 day TTL); no re-embedding cost | ✓ Accepted — clean cutover |
| Flat JSONB for inventory resources | Avoids EAV complexity; enables JSONB operators | ✓ Shipped — metadata + tags columns |
| ON CONFLICT for scheduled task locks | Atomic lock acquisition without scan-and-compare | ✓ Shipped — ScheduledTaskLock table |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd:transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-03-29 — v2.0 milestone started (Pulumi IaC Migration)*
