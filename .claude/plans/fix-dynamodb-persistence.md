# Fix DynamoDB Persistence: Auth, userId Scoping & Chat History

## Problem Statement

After migrating to `@farukada/aws-langgraph-dynamodb-ts`, no data populates in DynamoDB tables.

Root causes:
1. `resolvedUserId` is out of scope in `processStream`'s `finally` block (separate function, no closure)
2. `user_id` missing from `streamEvents`/`invoke` configurable — `DynamoDBStore.batch()` fails
3. `getSessionUserId()` silently falls back to `'system'` instead of failing with 401
4. userId format doesn't match `USER#<sub>` convention used in users-teams table
5. Non-streaming `invoke` path has no chat history persistence
6. Thread creation seeds an empty HumanMessage via `chatHistory.addMessage()`

## Requirements

- userId resolved server-side only from NextAuth/Cognito session (`session.user.sub`)
- Return 401 if no authenticated session (no `'system'` fallback)
- userId format: `USER#<cognito-sub>` (consistent with users-teams table PK convention)
- All 4 DynamoDB tables (checkpoints, writes, chat-history, memory) must receive data
- `processStream` must have access to `resolvedUserId` for the `finally` block
- `user_id` must be in every `configurable` object passed to LangGraph

## Task Breakdown

### Task 1: Fix `auth-session.ts` — enforce auth, use `USER#` prefix
- File: `web-ui/lib/auth-session.ts`
- `getSessionUserId()` → throw if no session/sub (no `'system'` fallback)
- Return format: `USER#${sub}` (sub first, email second)

### Task 2: Fix `chat/route.ts` — userId resolution and 401
- File: `web-ui/app/api/chat/route.ts`
- Replace inline session resolution (lines 52-60) with `getSessionUserId()`
- Return 401 if it throws
- Strip `USER#` prefix for Langfuse userId

### Task 3: Fix `processStream` — pass `resolvedUserId` as parameter
- File: `web-ui/app/api/chat/route.ts`
- Add `resolvedUserId: string` param to `processStream` signature
- Pass it from the call site

### Task 4: Fix `configurable` objects — add `user_id` everywhere
- File: `web-ui/app/api/chat/route.ts`
- Add `user_id: resolvedUserId` to `streamEvents` configurable (line ~252)
- Add `user_id: resolvedUserId` to `invoke` configurable (line ~274)
- Pass full config (with `user_id`) to `processStream`

### Task 5: Add chat history persistence to non-streaming path
- File: `web-ui/app/api/chat/route.ts`
- After `graph.invoke()`, persist messages via `chatHistory.addMessages()`

### Task 6: Fix thread creation — don't seed empty HumanMessage
- File: `web-ui/app/api/threads/route.ts`
- Replace `chatHistory.addMessage(userId, id, new HumanMessage(''), ...)` with direct DynamoDB update (metadata only)

### Task 7: Update thread API routes to use `getSessionUserId()` with 401
- Files: `web-ui/app/api/threads/route.ts`, `web-ui/app/api/threads/[threadId]/route.ts`, `web-ui/app/api/threads/[threadId]/history/route.ts`
- Wrap `getSessionUserId()` in try/catch, return 401 on failure

### Task 8: Verify build
- `cd web-ui && npx tsc --noEmit`
- Confirm no remaining `'system'` fallback in auth/chat paths




===========



The remaining 'system' references are in unrelated files (admin, scheduler, schedules) — those are audit log entries, not userId for our persistence layer. All chat/thread routes now use getSessionUserId() with 401 on failure.

Here's a summary of all changes made:

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


## Changes Summary

### Files Modified (7 files)

web-ui/lib/auth-session.ts — Task 1
- getSessionUserId() now throws on unauthenticated (no 'system' fallback)
- Returns USER#<cognito-sub> format (consistent with users-teams table PK)

web-ui/app/api/chat/route.ts — Tasks 2, 3, 4, 5
- Replaced inline session resolution with getSessionUserId(), returns 401 on failure
- Added resolvedUserId: string parameter to processStream function signature
- Added user_id: resolvedUserId to streamEvents configurable, invoke configurable, and the config passed to processStream
- Added chat history persistence to the non-streaming invoke path
- Added resolvedUserId guard to the finally block condition
- Langfuse userId strips the USER# prefix

web-ui/app/api/threads/route.ts — Tasks 6, 7
- POST: replaced chatHistory.addMessage(userId, id, new HumanMessage(''), ...) with direct DynamoDB update (metadata only, no phantom empty message)
- Both GET and POST: return 401 on unauthenticated
- Removed HumanMessage import

web-ui/app/api/threads/[threadId]/route.ts — Task 7
- DELETE and PATCH: return 401 on unauthenticated

web-ui/app/api/threads/[threadId]/history/route.ts — Task 7
- GET: return 401 on unauthenticated

web-ui/lib/agent/deep-agent.ts — Cleanup
- Removed 'system' fallback: createMemoryTools(config.userId ?? 'system') → config.userId ? createMemoryTools(config.userId) : []

web-ui/lib/agent/model-factory.ts — Cleanup
- Removed userId = 'system' default in assembleTools destructuring
- Memory tools only created when userId is provided

### Data Flow (after fix)

Cognito → NextAuth session.user.sub → getSessionUserId() → "USER#<sub>"
  ↓
chat/route.ts: resolvedUserId = "USER#<sub>"
  ├─ graphConfig.userId → agent graphs → createMemoryTools(userId) → saveMemory/searchMemory
  ├─ configurable.user_id → DynamoDBStore.batch() → memory table PK
  ├─ chatHistory.addMessages(resolvedUserId, ...) → chat-history table PK
  └─ DynamoDB seed metadata → chat-history table PK


 ▸ Credits: 21.20 • Time: 5m 51s
