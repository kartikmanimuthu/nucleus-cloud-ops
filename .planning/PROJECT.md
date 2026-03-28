# DynamoDB to PostgreSQL Migration

## What This Is

Completed migration of all 10 DynamoDB tables in the Nucleus Cloud Ops platform to PostgreSQL. Business data tables (NucleusAppTable single-table design, audit, inventory, agent ops, RBAC), LangGraph persistence tables (checkpoints, writes, chat history, memory), and the AgentConversationsTable (confirmed dead code, CDK definition removed) are all migrated. Uses Prisma ORM with a repository pattern and per-entity feature flags for zero-downtime cutover. Local development uses Docker Compose with pgvector.

## Core Value

Every DynamoDB table migrated to PostgreSQL with full test coverage (unit + E2E) and verified data migration scripts — enabling server-side filtering, real transactions, relational joins, and proper pagination across the entire platform. ✓ Shipped v1.0.

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

### Active (Next Milestone)

- [ ] Cloud PostgreSQL provisioning (RDS or Aurora Serverless v2 CDK stack) — PROD-01
- [ ] RDS Proxy for Lambda connection pooling in production — PROD-02
- [ ] Remove DynamoDB table definitions from CDK after full cutover validation — PROD-03
- [ ] pg_cron or EventBridge Lambda for TTL cleanup in production — PROD-04
- [ ] CloudWatch alarms for PostgreSQL connection pool saturation — PROD-05
- [ ] Full cutover: flip all USE_PG_* flags to true in production

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

**Next milestone** (`/gsd:new-milestone`): Production infrastructure — RDS/Aurora CDK stack, RDS Proxy, full cutover validation, DynamoDB table removal.

---
*Last updated: 2026-03-28 after v1.0 milestone completion — all 5 phases shipped*
