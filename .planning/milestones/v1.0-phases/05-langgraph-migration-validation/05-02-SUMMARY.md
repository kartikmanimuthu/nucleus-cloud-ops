---
plan: 05-02
phase: 05-langgraph-migration-validation
status: complete
tasks_completed: 2
files_created:
  - web-ui/lib/agent/persistence.test.ts
files_modified:
  - web-ui/lib/agent/persistence.ts
commits:
  - 648ba2b feat(05-02): rewrite persistence.ts with USE_PG_LANGGRAPH flag + TDD tests
requirements_satisfied: [LANG-01, LANG-02, LANG-03, LANG-04, LANG-06]
---

# Plan 05-02 Summary: persistence.ts Rewrite + TDD Tests

## What Was Built

`persistence.ts` now supports both DynamoDB and PostgreSQL backends via the `USE_PG_LANGGRAPH` feature flag. The public API (`getCheckpointer`, `getMemoryStore`, `getChatHistory`, `saveMemory`, `searchMemory`) is identical — zero changes required in any caller.

**PostgreSQL path (USE_PG_LANGGRAPH=true):**
- `PostgresSaver.fromConnString(DATABASE_URL)` + `setup()` for checkpoints (library manages its own schema)
- `PostgresChatHistory` class using Prisma `ChatMessage` model (30-day TTL)
- `PostgresMemoryStore` class using Prisma `AgentMemory` model + raw SQL pgvector cosine distance queries (90-day TTL)

**DynamoDB path (default):** All existing code preserved unchanged.

**Singleton pattern:** `globalThis` cache preserved for Next.js hot reload survival.

## Tests

9/9 unit tests passing in `persistence.test.ts`:
- DynamoDB backend selected when `USE_PG_LANGGRAPH` unset or false
- PostgreSQL backend selected when `USE_PG_LANGGRAPH=true`
- Singleton pattern verified (same instance on repeated calls)
- All 5 public exports verified

## Self-Check: PASSED
