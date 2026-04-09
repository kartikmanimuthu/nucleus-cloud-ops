# Quick Task 260408-nhh: Remove DynamoDB Dead Code from Agent Persistence

**Date:** 2026-04-08
**Commit:** 519c9a8

## What Changed

Removed the dual-backend DynamoDB/PostgreSQL architecture from the agent persistence layer. PostgreSQL is now the sole backend — no feature flags, no fallback paths.

## Files Modified (10)

- `web-ui/lib/agent/persistence.ts` — Removed DynamoDBSaver, DynamoDBStore, DynamoDBChatMessageHistory imports and code paths; removed USE_PG_LANGGRAPH branching
- `web-ui/lib/agent/agent-shared.ts` — Removed FileSaver fallback, USE_PG_LANGGRAPH checks; getCheckpointer() now delegates directly to persistence
- `web-ui/lib/agent/persistence.test.ts` — Removed all DynamoDB test cases; rewrote as PostgreSQL-only test suite
- `web-ui/app/api/chat/route.ts` — Removed DynamoDB session metadata seeding block and feature flag conditionals around chat history persistence
- `web-ui/app/api/threads/route.ts` — Removed DynamoDB scan/update blocks from GET and POST handlers
- `web-ui/app/api/threads/[threadId]/route.ts` — Removed DynamoDB DELETE and PATCH handlers; removed DynamoDB SDK imports
- `web-ui/app/api/threads/[threadId]/history/route.ts` — Removed USE_PG_LANGGRAPH/DYNAMODB_CHAT_HISTORY_TABLE conditional
- `web-ui/package.json` — Removed `@farukada/aws-langgraph-dynamodb-ts` dependency
- `web-ui/package-lock.json` — Regenerated (5 packages removed)
- `web-ui/.env.local.example` — Removed 6 dead env vars (DYNAMODB_CHECKPOINT_TABLE, DYNAMODB_WRITES_TABLE, DYNAMODB_CHAT_HISTORY_TABLE, DYNAMODB_MEMORY_TABLE, DYNAMODB_USERS_TEAMS_TABLE, CHECKPOINT_S3_BUCKET)

## Lines Removed

~410 lines of dead code deleted across 10 files.

## Verification

- `npx vitest run lib/agent/persistence.test.ts` — 5/5 tests pass
- `grep -r "USE_PG_LANGGRAPH\|@farukada\|DYNAMODB_CHECKPOINT_TABLE" web-ui/lib/ web-ui/app/` — zero matches
