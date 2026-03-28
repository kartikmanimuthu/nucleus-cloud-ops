# Phase 4: KB + Inventory + Agent Ops - Context

**Gathered:** 2026-03-28
**Status:** Ready for planning

<domain>
## Phase Boundary

Migrate three subsystems to PostgreSQL: Knowledge Base (KB + DataSource entities), Inventory (discovered AWS resources from Python discovery Lambda), and Agent Ops (Dynamoose-backed runs, events, and scheduled tasks). Each gets Prisma schema, repository interface + two implementations (DynamoDB + PostgreSQL), service wiring, TDD unit tests, data migration scripts, and Playwright E2E tests. The Python discovery Lambda gets psycopg2 added to write inventory to PostgreSQL alongside its existing DynamoDB writes.

AgentConversationsTable is confirmed dead code — no migration needed in this phase.

</domain>

<decisions>
## Implementation Decisions

### Inventory table schema
- **D-01:** Flat single table `inventory_resources` with JSONB columns for flexibility
- **D-02:** Common typed columns: `id`, `tenant_id`, `account_id`, `region`, `resource_type`, `resource_id`, `name`, `status`, `tags JSONB`, `metadata JSONB`, `discovered_at TIMESTAMPTZ`, `updated_at TIMESTAMPTZ`
- **D-03:** Resource-specific fields (e.g., EC2 `instanceType`, `vpcId`; RDS `engine`) go into `metadata JSONB` — no per-resource-type tables
- **D-04:** Index on `(tenant_id, resource_type)` and `(tenant_id, account_id)` for common query patterns

### Agent ops migration scope
- **D-05:** Data layer only — migrate the 3 Dynamoose model files to Prisma repositories
- **D-06:** Files to migrate: `models/agent-ops-run.ts` → `repositories/agent-ops-run-postgres.ts`, `models/agent-ops-event.ts` → `repositories/agent-ops-event-postgres.ts`, `models/scheduled-task.ts` → `repositories/scheduled-task-postgres.ts`
- **D-07:** `agent-executor.ts` (33KB), `executor-graphs.ts` (32KB), and `agent-ops-service.ts` (12KB) are NOT touched — they call the repository interface, no DynamoDB-specific logic to remove
- **D-08:** Feature flag `USE_PG_AGENT_OPS` controls routing in repository factory

### Python Lambda psycopg2 approach
- **D-09:** Add `psycopg2-binary>=2.9.0` to `lambda/discovery/requirements.txt` — no Lambda layer needed
- **D-10:** Discovery Lambda connects via `DATABASE_URL` env var (same pattern as TypeScript services)
- **D-11:** No CDK changes needed — Lambda already has VPC access; psycopg2-binary bundles at deploy time
- **D-12:** Discovery Lambda writes inventory to PostgreSQL in addition to existing DynamoDB writes during dual-write period; controlled by `USE_PG_INVENTORY` env var

### AgentConversationsTable
- **D-13:** Confirmed dead code — zero app code references found (CONCERNS.md + grep audit)
- **D-14:** No migration in Phase 4; Phase 5 (LANG-05) handles final audit + CDK removal

### Inherited decisions (from prior phases — do not re-ask)
- **D-15:** ORM: Prisma (user chose DX over Lambda bundle size)
- **D-16:** Repository pattern with feature flags per entity for zero-downtime cutover
- **D-17:** Multi-tenant safety: every PostgreSQL query must include `WHERE tenant_id = $1`
- **D-18:** TDD unit tests before each repository implementation; Playwright E2E after phase

### Claude's Discretion
- Exact Prisma schema field names and constraints (follow patterns from phases 1-3)
- Connection pool size for KB/inventory repositories (follow ECS=10, Lambda=3 pattern)
- Scheduled task lock acquisition implementation (ON CONFLICT as noted in REQUIREMENTS.md AOPS-04)
- Data migration script batching strategy for inventory (follow 500-record batch pattern from audit logs)

</decisions>

<specifics>
## Specific Ideas

- Scheduled task lock acquisition must use `ON CONFLICT` (not scan-and-compare) — this is a hard requirement from AOPS-04, confirmed by the concurrent lock attempt test requirement
- Discovery Lambda dual-write: write to both DynamoDB and PostgreSQL during validation, controlled by `USE_PG_INVENTORY` flag — same dual-write pattern as schedules/audit in Phase 3
- Agent ops `findAwaitingApprovalRun` must use PostgreSQL `WHERE` instead of scanning 50+ records per source (AOPS-06) — this is a correctness fix, not just a migration

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements
- `.planning/REQUIREMENTS.md` §KB-01–KB-09 — Knowledge base + inventory + vector key requirements
- `.planning/REQUIREMENTS.md` §AOPS-01–AOPS-09 — Agent ops migration requirements (all 9 items)

### Existing data models (read before writing Prisma schema)
- `web-ui/lib/knowledge-base/service.ts` — DynamoDB key patterns for KB (TENANT#, KB#, DATASOURCE#)
- `web-ui/lib/knowledge-base/types.ts` — KnowledgeBase and DataSource TypeScript types
- `web-ui/lib/agent-ops/models/agent-ops-run.ts` — AgentOpsRun Dynamoose schema (all fields)
- `web-ui/lib/agent-ops/models/agent-ops-event.ts` — AgentOpsEvent Dynamoose schema
- `web-ui/lib/agent-ops/models/scheduled-task.ts` — ScheduledTask Dynamoose schema
- `web-ui/lib/agent-ops/types.ts` — Agent ops TypeScript types

### Existing service layer (understand before wiring repositories)
- `web-ui/lib/agent-ops/agent-ops-service.ts` — Service methods to delegate to repository
- `web-ui/lib/agent-ops/scheduled-task-service.ts` — Scheduled task service methods
- `web-ui/lib/knowledge-base/service.ts` — KB service methods

### Lambda files (understand before adding psycopg2)
- `lambda/discovery/src/main.py` — Discovery Lambda entry point and DynamoDB write patterns
- `lambda/discovery/requirements.txt` — Current Python dependencies
- `lambda/vector_processor/src/index.ts` — Vector processor (TypeScript, stores vector keys)

### Prior phase patterns (follow these conventions)
- `web-ui/lib/repositories/` — Existing repository implementations from phases 1-3
- `web-ui/lib/pg-config.ts` — PostgreSQL connection singleton (ECS=10, Lambda=3 pool sizes)
- `scripts/migrate-schedules.ts` — Migration script pattern to follow
- `scripts/cleanup-expired.ts` — TTL cleanup script pattern

### Schema design reference
- `docs/schema-design.md` — DynamoDB single-table design (PK/SK patterns for all entities)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `web-ui/lib/pg-config.ts` — PostgreSQL connection singleton, reuse directly
- `web-ui/lib/repository-factory.ts` — Repository factory with `USE_PG_*` flag pattern, extend for new entities
- `web-ui/lib/repositories/` — Existing interface + DynamoDB + PostgreSQL repo pattern to follow exactly
- `scripts/migrate-*.ts` — Migration script template (idempotent, batched, progress logging)

### Established Patterns
- Repository interface → DynamoDB impl → PostgreSQL impl (3 files per entity)
- Feature flag naming: `USE_PG_<ENTITY>` (e.g., `USE_PG_AGENT_OPS`, `USE_PG_KB`, `USE_PG_INVENTORY`)
- Multi-tenant: every query scoped by `tenantId` parameter
- Prisma migration workflow: `prisma migrate diff` + manual file creation + `prisma migrate deploy` (no interactive TTY)
- TDD: write failing unit tests first, then implement repository

### Integration Points
- `web-ui/lib/agent-ops/agent-ops-service.ts` — Replace direct Dynamoose model calls with repository factory calls
- `web-ui/lib/agent-ops/scheduled-task-service.ts` — Same pattern
- `lambda/discovery/src/main.py` — Add psycopg2 write after existing DynamoDB write
- `lambda/vector_processor/src/index.ts` — Add repository call for vector key storage
- `lambda/kb_sync_processor/src/` — Add repository call for data source updates (KB-03)

### Agent Ops Complexity Note
- `agent-executor.ts` (33KB) and `executor-graphs.ts` (32KB) are NOT touched
- These files import from `models/` — after migration they'll import from `repositories/` via the factory
- The ~15 agent-ops API routes under `web-ui/app/api/agent-ops/` need to work with `USE_PG_AGENT_OPS=true`

</code_context>

<deferred>
## Deferred Ideas

- AgentConversationsTable CDK removal — Phase 5 (LANG-05 already covers this)
- Vector processor Lambda full TypeScript rewrite — out of scope, keep Python+TS hybrid
- Inventory schema redesign beyond migration needs — out of scope per PROJECT.md constraints
- Performance benchmarking DynamoDB vs PostgreSQL for inventory queries — out of scope

</deferred>

---

*Phase: 04-kb-inventory-agent-ops*
*Context gathered: 2026-03-28*
