---
phase: 05-langgraph-migration-validation
plan: 01
subsystem: database
tags: [pgvector, prisma, langgraph, postgres, dynamodb, cdk]

requires:
  - phase: 04-kb-inventory-agent-ops
    provides: AgentOpsRun, AgentOpsEvent, ScheduledTask, InventoryResource models

provides:
  - pgvector/pgvector:pg16 Docker image replacing postgres:16-alpine
  - AgentMemory Prisma model with vector(1024) embedding column for semantic search
  - ChatMessage Prisma model for agent thread history
  - "@langchain/langgraph-checkpoint-postgres installed in web-ui"
  - AgentConversationsTable removed from CDK (confirmed dead code)

affects: [05-langgraph-migration-validation, langgraph-persistence, agent-memory]

tech-stack:
  added:
    - "@langchain/langgraph-checkpoint-postgres (web-ui)"
    - "pgvector/pgvector:pg16 Docker image"
  patterns:
    - "Unsupported('vector(1024)') for pgvector columns — Prisma has no native pgvector type"
    - "Dead code audit via grep before CDK removal"

key-files:
  created:
    - prisma/migrations/20260328132327_add_langgraph_persistence/migration.sql
  modified:
    - docker-compose.yml
    - prisma/schema.prisma
    - web-ui/package.json
    - lib/computeStack.ts

key-decisions:
  - "pgvector/pgvector:pg16 replaces postgres:16-alpine — same PG16 base, adds vector extension support"
  - "AgentMemory uses Unsupported('vector(1024)') — Prisma 5 has no native pgvector type; raw SQL required for similarity queries"
  - "AgentConversationsTable confirmed dead code via grep audit (zero app code refs) before CDK removal"
  - "@langchain/langgraph-checkpoint-postgres manages its own checkpoint/writes tables via PostgresSaver.setup() — no Prisma models needed for those"

patterns-established:
  - "pgvector columns: use Unsupported() in Prisma schema, raw SQL for vector queries"

requirements-completed: [LANG-01, LANG-03, LANG-05]

duration: 7min
completed: 2026-03-28
---

# Phase 05 Plan 01: LangGraph Persistence Foundation Summary

**pgvector Docker image, AgentMemory (vector(1024)) + ChatMessage Prisma models, @langchain/langgraph-checkpoint-postgres installed, AgentConversationsTable dead code removed from CDK**

## Performance

- **Duration:** ~7 min
- **Started:** 2026-03-28T13:12:45Z
- **Completed:** 2026-03-28T13:19:53Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- Switched Docker Compose to pgvector/pgvector:pg16 image enabling vector extension
- Added AgentMemory model with `Unsupported("vector(1024)")` embedding column and ChatMessage model to Prisma schema
- Installed @langchain/langgraph-checkpoint-postgres in web-ui
- Confirmed AgentConversationsTable has zero app code references and removed all 5 CDK references

## Task Commits

1. **Task 1: pgvector image + AgentMemory/ChatMessage models + checkpoint-postgres** - `d931eab` (feat)
2. **Task 2: Remove AgentConversationsTable dead code from CDK** - `8547915` (feat)

## Files Created/Modified
- `docker-compose.yml` - postgres:16-alpine → pgvector/pgvector:pg16
- `prisma/schema.prisma` - AgentMemory (vector(1024)) and ChatMessage models appended
- `web-ui/package.json` - @langchain/langgraph-checkpoint-postgres added
- `lib/computeStack.ts` - AgentConversationsTable construct, GSI, IAM policy entry, and env var removed
- `prisma/migrations/20260328132327_add_langgraph_persistence/migration.sql` - CREATE EXTENSION vector + agent_memories + chat_messages tables

## Decisions Made
- `Unsupported("vector(1024)")` used for embedding column — Prisma 5 has no native pgvector type; raw SQL needed for similarity queries
- @langchain/langgraph-checkpoint-postgres manages its own `checkpoints` and `checkpoint_writes` tables via `PostgresSaver.setup()` — no Prisma models added for those
- AgentConversationsTable removal confirmed safe via grep audit showing zero app code references

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Prisma migrate diff required --shadow-database-url flag**
- **Found during:** Task 1 (migration generation)
- **Issue:** `prisma migrate diff --from-migrations` requires a shadow database URL; no local DB running in CI context
- **Fix:** Wrote migration SQL manually following established project pattern (same approach used in prior phases)
- **Files modified:** prisma/migrations/20260328132327_add_langgraph_persistence/migration.sql
- **Verification:** SQL reviewed against schema models; CREATE EXTENSION + CREATE TABLE + indexes match Prisma schema
- **Committed in:** d931eab (Task 1 commit)

**2. [Rule 3 - Blocking] Stale empty migration dirs from failed tooling attempts**
- **Found during:** Task 1 (migration generation)
- **Issue:** Four empty/error-content migration dirs created during flag discovery; would cause `prisma migrate deploy` to fail
- **Fix:** Wrote no-op SQL (`-- no-op: duplicate migration directory`) to each dir so Prisma treats them as applied
- **Files modified:** 20260328132334, 20260328132348, 20260328132355, 20260328132403 migration dirs
- **Committed in:** d931eab (Task 1 commit)

---

**Total deviations:** 2 auto-fixed (2 blocking)
**Impact on plan:** Both fixes necessary for migration correctness. No scope creep.

## Issues Encountered
- `prisma migrate diff --from-migrations-directory` flag does not exist in this Prisma version — correct flag is `--from-migrations`, which then requires `--shadow-database-url`. Resolved by writing migration SQL manually.

## Next Phase Readiness
- pgvector extension available in Docker Compose PostgreSQL
- AgentMemory and ChatMessage tables ready for migration deploy
- @langchain/langgraph-checkpoint-postgres available for LangGraph PostgreSQL checkpointer wiring
- AgentConversationsTable CDK dead code cleared

---
*Phase: 05-langgraph-migration-validation*
*Completed: 2026-03-28*
