# Phase 5: LangGraph + Migration Validation - Context

**Gathered:** 2026-03-28
**Status:** Ready for planning

<domain>
## Phase Boundary

Migrate all LangGraph persistence (checkpoints, writes, chat history, memory store) from DynamoDB to PostgreSQL using `@langchain/langgraph-checkpoint-postgres`. Replace `@farukada/aws-langgraph-dynamodb-ts` entirely. Add pgvector to Docker Compose PostgreSQL for semantic memory search. Write migrate-all.ts orchestration script and verify-migration.ts row count validator. Confirm AgentConversationsTable is dead code and remove its CDK definition.

</domain>

<decisions>
## Implementation Decisions

### LangGraph checkpoint + writes
- **D-01:** Replace `@farukada/aws-langgraph-dynamodb-ts` with `@langchain/langgraph-checkpoint-postgres` for checkpoints and writes
- **D-02:** Feature flag `USE_PG_LANGGRAPH` controls the switch in `persistence.ts`
- **D-03:** `persistence.ts` public API stays identical (`getCheckpointer()`, `getMemoryStore()`, `getChatHistory()`) — callers unchanged

### Memory store: pgvector
- **D-04:** Use pgvector extension in the existing Docker Compose PostgreSQL — switch base image to `pgvector/pgvector:pg16`
- **D-05:** Add `AgentMemory` Prisma model with `embedding Unsupported("vector(1024)")` for Titan v2 embeddings (1024-dim)
- **D-06:** Prisma schema uses `Unsupported("vector(1024)")` — raw SQL for vector similarity queries (Prisma doesn't support pgvector natively)
- **D-07:** Memory TTL: 90 days (`expiresAt` DateTime column, same pattern as other tables)

### Chat history + memory: fresh start
- **D-08:** No migration scripts for chat history or agent memory — fresh start on PostgreSQL
- **D-09:** Rationale: both are ephemeral (30-day and 90-day TTL); re-embedding memory would cost Bedrock API calls; old data expires anyway
- **D-10:** LANG-08 satisfied with documented decision: "Fresh start chosen — ephemeral data, TTL-based retention"
- **D-11:** `migrate-all.ts` skips `DYNAMODB_CHAT_HISTORY_TABLE` and `DYNAMODB_MEMORY_TABLE`

### migrate-all.ts orchestration
- **D-12:** Stop-on-first-error strategy — dependency order must be respected
- **D-13:** Migration order: `migrate-tenants.ts` → `migrate-accounts.ts` → `migrate-rbac.ts` → `migrate-schedules.ts` → `migrate-audit-logs.ts` → `migrate-kb.ts` → `migrate-inventory.ts` → `migrate-agent-ops.ts`
- **D-14:** On failure: print which script failed + resume command: `npx tsx scripts/migrate-all.ts --from <script-name>`
- **D-15:** `--from <script>` flag skips all scripts before the named one (for resuming after fixing a failure)
- **D-16:** `--dry-run` flag runs all scripts in dry-run mode (no writes) for pre-flight validation

### verify-migration.ts
- **D-17:** Compares DynamoDB item counts vs PostgreSQL row counts per table
- **D-18:** Output format: table with columns `Table | DynamoDB | PostgreSQL | Match | Delta`
- **D-19:** Uses `AWS_PROFILE=PLATFORM-ADMIN` for DynamoDB access (same as all migration scripts)
- **D-20:** Non-zero exit code if any table has count mismatch (enables CI integration)

### AgentConversationsTable CDK removal
- **D-21:** Final grep audit confirms zero app code references (already confirmed in Phase 4 D-13)
- **D-22:** Remove `AgentConversationsTable` DynamoDB construct from `lib/computeStack.ts`
- **D-23:** Note in verify-migration.ts output: "AgentConversationsTable: confirmed dead code, CDK definition removed"

### Inherited decisions (from prior phases — do not re-ask)
- **D-24:** ORM: Prisma (user chose DX over Lambda bundle size)
- **D-25:** Repository pattern with feature flags per entity for zero-downtime cutover
- **D-26:** Multi-tenant safety: every PostgreSQL query must include `WHERE tenant_id = $1`
- **D-27:** TDD unit tests before each repository implementation; Playwright E2E after phase
- **D-28:** Prisma migration workflow: `prisma migrate diff` + manual file creation + `prisma migrate deploy` (no interactive TTY)

### Claude's Discretion
- Exact Prisma schema for `agent_checkpoints`, `agent_checkpoint_writes`, `chat_messages` tables (follow `@langchain/langgraph-checkpoint-postgres` schema if it provides one, otherwise design to match the library's expectations)
- pgvector similarity search SQL (cosine distance vs L2 — use cosine for text embeddings)
- Connection pool size for LangGraph persistence (follow ECS=10, Lambda=3 pattern)
- Whether `@langchain/langgraph-checkpoint-postgres` manages its own schema or needs Prisma models

</decisions>

<specifics>
## Specific Ideas

- `persistence.ts` must keep the same public API (`getCheckpointer()`, `getMemoryStore()`, `getChatHistory()`) — the 3 agent files (fast-agent.ts, planning-agent.ts, deep-agent.ts) import from it and must not need changes
- pgvector similarity search should use cosine distance (`<=>` operator) — appropriate for normalized text embeddings from Titan v2
- `migrate-all.ts --from` flag enables safe resumption after fixing a failure mid-run — important for large datasets
- verify-migration.ts should exit non-zero on mismatch so it can be used in CI/CD pre-cutover checks

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### LangGraph persistence (current implementation)
- `web-ui/lib/agent/persistence.ts` — current DynamoDB persistence singleton (public API to preserve)
- `web-ui/lib/agent/fast-agent.ts` — imports getCheckpointer(), getMemoryStore() — must not change
- `web-ui/lib/agent/planning-agent.ts` — imports getCheckpointer() — must not change

### Requirements
- `.planning/REQUIREMENTS.md` §LANG-01–LANG-08 — LangGraph persistence migration requirements
- `.planning/REQUIREMENTS.md` §MIGR-03–MIGR-04 — migrate-all.ts and verify-migration.ts requirements

### Existing migration scripts (follow these patterns)
- `scripts/migrate-schedules.ts` — migration script pattern (idempotent, batched, progress logging, AWS_PROFILE)
- `scripts/migrate-kb.ts` — KB migration pattern
- `scripts/migrate-agent-ops.ts` — agent ops migration pattern (full table scan)

### Existing infrastructure
- `docker-compose.yml` — current PostgreSQL 16 setup (needs pgvector image swap)
- `prisma/schema.prisma` — existing schema to extend with LangGraph + memory models
- `web-ui/lib/pg-config.ts` — PostgreSQL connection singleton (ECS=10, Lambda=3 pool sizes)
- `lib/computeStack.ts` — CDK stack containing AgentConversationsTable to remove

### Schema design reference
- `docs/schema-design.md` — DynamoDB single-table design (understand what's being migrated)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `web-ui/lib/pg-config.ts` — PostgreSQL connection singleton, reuse directly
- `web-ui/lib/repository-factory.ts` — extend with `USE_PG_LANGGRAPH` flag
- `scripts/migrate-schedules.ts` — migration script template to follow exactly

### Established Patterns
- `persistence.ts` singleton uses `globalThis` cache to survive Next.js hot reloads — preserve this pattern
- Feature flag naming: `USE_PG_LANGGRAPH` (controls checkpointer + chatHistory + memory store together)
- Prisma migration: `prisma migrate diff` + manual file + `prisma migrate deploy` (no TTY)
- TDD: write failing unit tests first, then implement

### Integration Points
- `web-ui/lib/agent/persistence.ts` — the only file that needs to change for LangGraph migration; all 3 agent files import from it
- `docker-compose.yml` — swap `postgres:16` image to `pgvector/pgvector:pg16`
- `lib/computeStack.ts` — remove AgentConversationsTable DynamoDB construct

### Key Complexity: @langchain/langgraph-checkpoint-postgres
- This library may manage its own PostgreSQL schema (not Prisma) — researcher must check if it uses `CREATE TABLE` internally or expects pre-existing tables
- If it manages its own schema: just initialize it with a pg connection string
- If it needs pre-existing tables: add Prisma models for `checkpoints` and `checkpoint_writes`

</code_context>

<deferred>
## Deferred Ideas

- Production RDS/Aurora CDK stack — Phase 5 scope is local Docker only (PROD-01..PROD-05 are v2 requirements)
- Removing all DynamoDB table CDK definitions — only AgentConversationsTable removed in Phase 5; other tables stay until full cutover validated
- pg_cron for TTL cleanup in production — out of scope (PROD-04)

</deferred>

---

*Phase: 05-langgraph-migration-validation*
*Context gathered: 2026-03-28*
