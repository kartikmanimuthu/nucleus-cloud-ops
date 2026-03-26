# DynamoDB to PostgreSQL Migration

## What This Is

Migrating all 10 DynamoDB tables in the Nucleus Cloud Ops platform to PostgreSQL. This includes business data tables (single-table design NucleusAppTable, audit, inventory, agent ops, RBAC), LangGraph persistence tables (checkpoints, writes, chat history, memory), and the potentially-unused AgentConversationsTable. The migration uses Drizzle ORM with a repository pattern and per-entity feature flags for zero-downtime cutover. Local development uses Docker Compose; cloud PostgreSQL (RDS or Aurora) will be decided later.

## Core Value

Every DynamoDB table is migrated to PostgreSQL with full test coverage (unit + E2E) and verified data migration scripts, enabling server-side filtering, real transactions, relational joins, and proper pagination across the entire platform.

## Requirements

### Validated

- Multi-account AWS resource scheduling with cross-account STS AssumeRole
- AI agent (fast, planning, deep) with LangGraph state machines on AWS Bedrock
- Resource discovery via Python Lambda with S3 normalized output
- Knowledge base with vector processing pipeline (S3 -> SQS -> Lambda)
- RBAC with user-tenant-role mappings
- Audit logging with TTL-based retention
- Tenant configuration management
- Agent ops with scheduled tasks and execution locking
- Inventory vector search (Ask AI)
- NextAuth.js authentication
- E2E test suite (Playwright) for accounts, navigation, marketing, docs

### Active

- [ ] Docker Compose + Drizzle ORM foundation (connection pooling, migration tooling, repository factory)
- [ ] Tenant config migration (DynamoDB -> PostgreSQL) with repository pattern
- [ ] Accounts + RBAC migration with server-side filtering
- [ ] Schedules + Executions + Audit Logs migration (includes scheduler Lambda)
- [ ] Knowledge Base + Vector Processor Lambda migration
- [ ] Agent Ops migration (Dynamoose -> Drizzle rewrite)
- [ ] Inventory table migration (Python discovery Lambda via psycopg2)
- [ ] LangGraph tables migration (checkpoints, writes, chat history, memory) using @langchain/langgraph-checkpoint-postgres
- [ ] AgentConversationsTable verification and migration
- [ ] Data migration scripts for all tables (seed from DynamoDB via AWS_PROFILE=PLATFORM-ADMIN)
- [ ] Unit tests (TDD) for each repository implementation
- [ ] Playwright E2E tests after each phase to verify migrated modules
- [ ] TTL replacement (cron job for expired record cleanup)

### Out of Scope

- Cloud PostgreSQL provisioning (RDS/Aurora CDK stacks) -- decide later, start with Docker locally
- Removing DynamoDB table definitions from CDK -- tables stay until full cutover validated
- Rewriting discovery Lambda from Python to TypeScript -- keep Python, add psycopg2
- Performance benchmarking DynamoDB vs PostgreSQL -- migration correctness is priority
- Schema redesign beyond what migration requires -- match existing data model, improve queries

## Context

- **Current state:** All persistent data in DynamoDB (10 tables). Services use static classes with direct DynamoDB DocumentClient calls. No ORM. Client-side filtering and pagination everywhere.
- **Pain points:** Complex filtering requires fetching all records and filtering in JS. No relational joins. Ad-hoc queries impossible. Pagination is cursor-based and inconsistent.
- **Architecture:** Next.js 15 on ECS Fargate + 4 Lambda functions (scheduler TS, discovery Python, vector processor Python+TS, KB sync TS). All share DynamoDB tables.
- **Migration approach:** Repository pattern with interface + two implementations (DynamoDB, PostgreSQL). Feature flag per entity (`USE_PG_<ENTITY>`) for instant rollback. Migrate one entity at a time.
- **ORM choice:** Drizzle ORM -- ~50KB runtime (vs Prisma's 2-4MB), no binary engine, works with esbuild Lambda bundling, SQL-first with TypeScript inference.
- **LangGraph change:** Switching from `@farukada/aws-langgraph-dynamodb-ts` to `@langchain/langgraph-checkpoint-postgres` for all agent persistence.
- **Testing strategy:** Unit tests written TDD-style before each repository implementation. Playwright E2E tests written after each phase to verify end-to-end flows.
- **Codebase map:** Available at `.planning/codebase/` (7 documents).

## Constraints

- **AWS Profile**: All migration scripts use `AWS_PROFILE=PLATFORM-ADMIN` for DynamoDB access
- **Zero downtime**: Feature flags per entity enable instant rollback; DynamoDB tables never deleted during migration
- **Lambda cold starts**: Drizzle ORM chosen over Prisma specifically for Lambda bundle size (~50KB vs 2-4MB)
- **Python Lambda**: Discovery Lambda stays Python; add psycopg2 for PostgreSQL access (no TypeScript rewrite)
- **Multi-tenant safety**: Every PostgreSQL query must include `WHERE tenant_id = $1` -- enforce in repository layer
- **Dual-write for high-risk**: Schedules + Audit phase should dual-write to both backends during validation period
- **Existing tests**: All existing Vitest/Jest/Playwright tests must continue passing throughout migration

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Drizzle ORM over Prisma | ~50KB runtime, no binary engine, esbuild compatible, SQL-first | -- Pending |
| Repository pattern with feature flags | Zero-downtime migration, instant rollback per entity | -- Pending |
| Migrate LangGraph tables to PostgreSQL | Consolidate all persistence in one database; use @langchain/langgraph-checkpoint-postgres | -- Pending |
| Keep discovery Lambda in Python | Avoid risky rewrite; add psycopg2 instead | -- Pending |
| Docker Compose for local dev | Defer cloud DB decision; fast local iteration | -- Pending |
| Verify AgentConversationsTable before migrating | May be dead code -- confirm usage first | -- Pending |
| Unit tests TDD, E2E tests after | TDD catches repository bugs early; E2E validates full flows post-migration | -- Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd:transition`):
1. Requirements invalidated? -> Move to Out of Scope with reason
2. Requirements validated? -> Move to Validated with phase reference
3. New requirements emerged? -> Add to Active
4. Decisions to log? -> Add to Key Decisions
5. "What This Is" still accurate? -> Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check -- still the right priority?
3. Audit Out of Scope -- reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-03-26 after initialization*
