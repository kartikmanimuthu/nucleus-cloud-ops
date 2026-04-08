---
phase: quick
plan: 260408-nhh
type: execute
wave: 1
depends_on: []
files_modified:
  - web-ui/lib/agent/persistence.ts
  - web-ui/lib/agent/persistence.test.ts
  - web-ui/lib/agent/agent-shared.ts
  - web-ui/app/api/chat/route.ts
  - web-ui/app/api/threads/route.ts
  - web-ui/app/api/threads/[threadId]/route.ts
  - web-ui/app/api/threads/[threadId]/history/route.ts
  - web-ui/package.json
  - web-ui/.env.local.example
  - web-ui/content/docs/installation.mdx
  - web-ui/content/docs/faq.mdx
autonomous: true
must_haves:
  truths:
    - "persistence.ts only has PostgreSQL code path — no DynamoDB imports, no feature flag branching"
    - "All 4 thread/chat API routes use PostgreSQL-only code — no DYNAMODB_CHAT_HISTORY_TABLE conditionals"
    - "agent-shared.ts getCheckpointer() delegates to persistence without DynamoDB fallback checks"
    - "@farukada/aws-langgraph-dynamodb-ts removed from package.json"
    - "Dead DYNAMODB_*_TABLE env vars removed from .env.local.example"
  artifacts:
    - path: "web-ui/lib/agent/persistence.ts"
      provides: "PostgreSQL-only persistence singleton"
    - path: "web-ui/lib/agent/persistence.test.ts"
      provides: "Tests for PostgreSQL-only persistence"
  key_links:
    - from: "web-ui/lib/agent/agent-shared.ts"
      to: "web-ui/lib/agent/persistence.ts"
      via: "getCheckpointer/getMemoryStore imports"
      pattern: "getPersistenceCheckpointer|getPersistenceMemoryStore"
---

<objective>
Remove all DynamoDB dead code and USE_PG_LANGGRAPH feature flag checks from the agent persistence layer and thread API routes. PostgreSQL is the only backend — the dual-backend architecture is dead weight.

Purpose: Eliminate ~200 lines of dead DynamoDB code, simplify persistence to a single code path, remove the `@farukada/aws-langgraph-dynamodb-ts` dependency.
Output: Clean PostgreSQL-only persistence layer, simplified API routes, smaller bundle.
</objective>

<context>
@web-ui/lib/agent/persistence.ts
@web-ui/lib/agent/agent-shared.ts
@web-ui/app/api/chat/route.ts
@web-ui/app/api/threads/route.ts
@web-ui/app/api/threads/[threadId]/route.ts
@web-ui/app/api/threads/[threadId]/history/route.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: Remove DynamoDB from persistence layer and agent-shared</name>
  <files>web-ui/lib/agent/persistence.ts, web-ui/lib/agent/persistence.test.ts, web-ui/lib/agent/agent-shared.ts</files>
  <action>
**persistence.ts:**
1. Remove the `@farukada/aws-langgraph-dynamodb-ts` import (line 21-25) entirely
2. Remove `HumanMessage, AIMessage, ToolMessage, SystemMessage` imports from `@langchain/core/messages` (only needed for DynamoDB chat history adapter) — keep only if still used by PG code (they are NOT used by PG path)
3. Update `PersistenceInstances` interface: change `checkpointer` type from `DynamoDBSaver | PostgresSaver` to just `PostgresSaver`, change `store` type from `DynamoDBStore | PostgresMemoryStore` to just `PostgresMemoryStore`
4. In `initPersistence()`: remove the `usePg` feature flag check (line 193), remove the entire `if (usePg) { ... }` conditional — make the PostgreSQL path the ONLY path. Delete the entire DynamoDB backend block (lines 214-271)
5. Update `getCheckpointer()` return type from `DynamoDBSaver | PostgresSaver` to `PostgresSaver`
6. Update `getMemoryStore()` return type from `DynamoDBStore | PostgresMemoryStore` to `PostgresMemoryStore`
7. Update the module docstring to remove all DynamoDB references and USE_PG_LANGGRAPH mentions — describe it as PostgreSQL-only persistence
8. Remove the `g` type that references `DynamoDBSaver` — update to only reference PostgreSQL types

**agent-shared.ts:**
1. In `getCheckpointer()` (lines 487-499): remove the `usePg`, `hasDynamo`, `hasDatabase` checks and the FileSaver fallback for "no DB configured". Simply delegate to `getPersistenceCheckpointer()` directly. The FileSaver fallback is dead code since DATABASE_URL is always set in production.
2. Remove the comment on line 485 about "USE_PG_LANGGRAPH feature flag"
3. Remove `FileSaver` import (line 3) if it becomes unused
4. Remove `BaseCheckpointSaver` import (line 4) if the return type can use the concrete PostgresSaver type instead — or keep it if it's the interface type needed by callers

**persistence.test.ts:**
1. Remove the entire "DynamoDB backend" describe block (lines 70-118) — all 4 DynamoDB tests
2. Remove the `@farukada/aws-langgraph-dynamodb-ts` mock (lines 12-16)
3. Remove the singleton test that uses DynamoDB env vars (lines 152-165) — rewrite it to use DATABASE_URL instead
4. Keep the PostgreSQL backend tests and public API export tests
5. Update test descriptions to remove "USE_PG_LANGGRAPH" references — these are now just "persistence module" tests
  </action>
  <verify>
    <automated>cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/pg-boss-migration/web-ui && npx vitest run lib/agent/persistence.test.ts --reporter=verbose 2>&1 | tail -30</automated>
  </verify>
  <done>persistence.ts has zero DynamoDB imports/code, agent-shared.ts delegates directly to persistence without feature flags, all persistence tests pass against PostgreSQL-only code</done>
</task>

<task type="auto">
  <name>Task 2: Remove DynamoDB from API routes, package.json, and env/docs</name>
  <files>web-ui/app/api/chat/route.ts, web-ui/app/api/threads/route.ts, web-ui/app/api/threads/[threadId]/route.ts, web-ui/app/api/threads/[threadId]/history/route.ts, web-ui/package.json, web-ui/.env.local.example, web-ui/content/docs/installation.mdx, web-ui/content/docs/faq.mdx</files>
  <action>
**chat/route.ts:**
1. Lines 101-128 (session metadata seeding): Remove the `USE_PG_LANGGRAPH` and `DYNAMODB_CHAT_HISTORY_TABLE` conditionals. Keep ONLY the PG mode comment/log (line 103-104). Remove the entire `else if (process.env.DYNAMODB_CHAT_HISTORY_TABLE)` block (lines 105-121) that imports DynamoDBClient and seeds metadata. Keep the final `else` block that uses `threadStore` as the PG fallback.
2. Lines 327 and 692: Replace `process.env.DYNAMODB_CHAT_HISTORY_TABLE || process.env.USE_PG_LANGGRAPH === 'true'` conditions with just `true` (or remove the conditional entirely since PG is always active). The chat history persistence should always run.

**threads/route.ts (GET + POST):**
1. GET handler: Remove the entire `if (process.env.DYNAMODB_CHAT_HISTORY_TABLE)` block (lines 24-68) that does DynamoDB scan. Keep only the `threadStore.listThreads()` path.
2. POST handler: Remove the entire `if (process.env.DYNAMODB_CHAT_HISTORY_TABLE)` block (lines 99-120) that does DynamoDB update. Keep only the `threadStore.createThread()` path.
3. Remove any now-unused DynamoDB SDK imports.

**threads/[threadId]/route.ts (DELETE + PATCH):**
1. Remove the top-level `DynamoDBDocument` and `DynamoDBClient` imports (lines 4-5)
2. DELETE handler: Remove the `if (process.env.DYNAMODB_CHAT_HISTORY_TABLE)` block (lines 22-30). Keep only the `threadStore.deleteThread()` path. Note: the DynamoDB path calls `chatHistory.clear()` — the threadStore path already handles deletion.
3. PATCH handler: Remove the `if (process.env.DYNAMODB_CHAT_HISTORY_TABLE)` block (lines 49-70). Keep only the `threadStore.updateThread()` path.

**threads/[threadId]/history/route.ts:**
1. Line 124: Replace `process.env.DYNAMODB_CHAT_HISTORY_TABLE || process.env.USE_PG_LANGGRAPH === 'true'` with just `true` (or remove the conditional). The chat history lookup via `getChatHistory()` should always run since PG is the only backend.

**web-ui/package.json:**
1. Remove `"@farukada/aws-langgraph-dynamodb-ts": "^0.1.0"` from dependencies

**web-ui/.env.local.example:**
1. Remove these 4 lines (37-40): DYNAMODB_CHECKPOINT_TABLE, DYNAMODB_WRITES_TABLE, DYNAMODB_CHAT_HISTORY_TABLE, DYNAMODB_MEMORY_TABLE
2. Remove CHECKPOINT_S3_BUCKET (line 41) — only used by DynamoDB checkpoint offload

**web-ui/content/docs/installation.mdx:**
1. Line 56: Remove the `DYNAMODB_CHECKPOINT_TABLE` row from the env vars table

**web-ui/content/docs/faq.mdx:**
1. Line 70: Update the "Is conversation history saved?" answer to say "PostgreSQL" instead of "DynamoDB with configurable TTL (via DYNAMODB_CHECKPOINT_TABLE)"
  </action>
  <verify>
    <automated>cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/pg-boss-migration/web-ui && npx tsc --noEmit 2>&1 | head -30</automated>
  </verify>
  <done>All 4 API routes have zero DynamoDB conditionals, @farukada package removed from package.json, dead env vars removed from .env.local.example, docs updated to reference PostgreSQL</done>
</task>

</tasks>

<verification>
1. `cd web-ui && npx tsc --noEmit` — zero type errors
2. `cd web-ui && npx vitest run lib/agent/persistence.test.ts` — all tests pass
3. `grep -r "DYNAMODB_CHECKPOINT_TABLE\|DYNAMODB_WRITES_TABLE\|DYNAMODB_CHAT_HISTORY_TABLE\|DYNAMODB_MEMORY_TABLE\|USE_PG_LANGGRAPH\|@farukada" web-ui/lib/ web-ui/app/ web-ui/package.json web-ui/.env.local.example` — zero matches
</verification>

<success_criteria>
- Zero references to DynamoDB in persistence layer, agent-shared, or thread API routes
- Zero references to USE_PG_LANGGRAPH feature flag anywhere in web-ui/lib/ or web-ui/app/
- @farukada/aws-langgraph-dynamodb-ts removed from package.json
- TypeScript compiles cleanly
- Persistence tests pass
</success_criteria>

<output>
After completion, create `.planning/quick/260408-nhh-remove-dynamodb-dead-code-and-feature-fl/260408-nhh-SUMMARY.md`
</output>
