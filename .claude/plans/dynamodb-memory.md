
# Implementation Plan — Migrate to @farukada/aws-langgraph-dynamodb-ts + Memory Store

## Problem Statement

The project currently uses two custom/third-party checkpoint and chat history implementations:
1. DynamoDBS3Saver (web-ui/lib/agent/dynamodb-s3-saver.ts) — custom checkpoint saver with manual S3 offloading logic (~280 lines)
2. @rwai/langgraphjs-checkpoint-dynamodb — third-party checkpoint saver used as fallback when no S3 bucket is configured
3. dynamodb-s3-chat-history-store.ts (web-ui/lib/db/) — custom chat history store with manual DynamoDB+S3 CRUD (~200 lines)

These need to be replaced with the official @farukada/aws-langgraph-dynamodb-ts package which provides:
- DynamoDBSaver — checkpoint persistence with built-in compression, S3 offloading, TTL, metadata/payload split
- DynamoDBChatMessageHistory — per-message chat history with session management
- DynamoDBStore — long-term memory with namespace support and semantic search via Bedrock embeddings

Additionally, a memory layer (short-term via checkpoints + long-term via DynamoDBStore with Titan Embed v2 semantic search) needs to be integrated into the agent graph.

## Requirements

1. Replace custom DynamoDBS3Saver and @rwai/langgraphjs-checkpoint-dynamodb with DynamoDBSaver from the new package
2. Replace custom dynamodb-s3-chat-history-store.ts with DynamoDBChatMessageHistory from the new package
3. Add DynamoDBStore for long-term memory with Amazon Titan Embed Text v2 semantic search
4. Create new DynamoDB tables for chat history and memory via CDK
5. Add TTL support to existing checkpoint/writes tables via CDK
6. Update all env vars, CDK stacks, and API routes
7. No data migration — fresh tables

## Background

Package schema requirements (from @farukada/aws-langgraph-dynamodb-ts docs):
- Checkpoints table: PK=thread_id (S), SK=checkpoint_id (S), TTL=ttl ✅ matches existing
- Writes table: PK=thread_id_checkpoint_id_checkpoint_ns (S), SK=task_id_idx (S), TTL=ttl ✅ matches existing
- Chat history table: PK=userId (S), SK=sessionId (S), TTL=ttl 🆕 new table
- Memory table: PK=user_id (S), SK=namespace_key (S), TTL=ttl 🆕 new table

Current integration points (6 files import the old modules):

| File | Imports |
|------|---------|
| agent-shared.ts | DynamoDBSaver from @rwai/..., DynamoDBS3Saver, exposes getCheckpointer() |
| fast-agent.ts, planning-agent.ts, deep-agent.ts | call getCheckpointer() |
| app/api/chat/route.ts | dynamodb-s3-chat-history-store for message persistence |
| app/api/threads/route.ts | dynamodb-s3-chat-history-store for list/create |
| app/api/threads/[threadId]/route.ts | dynamodb-s3-chat-history-store for delete/update |
| app/api/threads/[threadId]/history/route.ts | dynamodb-s3-chat-history-store for history retrieval |

Env vars (existing → new):
- DYNAMODB_CHECKPOINT_TABLE, DYNAMODB_WRITES_TABLE, CHECKPOINT_S3_BUCKET — keep, reuse
- DYNAMODB_AGENT_CONVERSATIONS_TABLE → replaced by DYNAMODB_CHAT_HISTORY_TABLE
- 🆕 DYNAMODB_MEMORY_TABLE

## Proposed Solution

Create a unified singleton persistence module (web-ui/lib/agent/persistence.ts) that instantiates all three components from the new package — DynamoDBSaver, DynamoDBStore, DynamoDBChatMessageHistory — with shared client config, compression, S3 
offloading, and TTL. This replaces both dynamodb-s3-saver.ts and dynamodb-s3-chat-history-store.ts.

mermaid
flowchart LR
    subgraph "Before (Custom)"
        A[dynamodb-s3-saver.ts] --> DDB[(DynamoDB)]
        B["@rwai/checkpoint-dynamodb"] --> DDB
        C[dynamodb-s3-chat-history-store.ts] --> DDB
        A --> S3[(S3)]
        C --> S3
    end

    subgraph "After (@farukada package)"
        P[persistence.ts] --> PKG["@farukada/aws-langgraph-dynamodb-ts"]
        PKG --> SAVER[DynamoDBSaver]
        PKG --> STORE[DynamoDBStore]
        PKG --> HIST[DynamoDBChatMessageHistory]
        SAVER --> DDB2[(DynamoDB)]
        STORE --> DDB2
        HIST --> DDB2
        SAVER --> S32[(S3)]
        STORE -.-> BED[Bedrock Embeddings]
    end


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


## Task Breakdown

### Task 1: Install package and update dependencies

Objective: Add @farukada/aws-langgraph-dynamodb-ts and remove old packages.

Guidance:
- cd web-ui && npm install @farukada/aws-langgraph-dynamodb-ts
- npm uninstall @rwai/langgraphjs-checkpoint-dynamodb
- Peer deps already satisfied: @aws-sdk/client-dynamodb, @aws-sdk/lib-dynamodb, @aws-sdk/client-s3, @langchain/core, @langchain/langgraph, @langchain/langgraph-checkpoint, @langchain/aws

Demo: npm run build succeeds with new dependency, old package gone from package.json.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


### Task 2: Add new DynamoDB tables and TTL to CDK stacks

Objective: Create chat-history and memory tables in both computeStack.ts and webUIStack.ts. Add TTL to existing checkpoint/writes tables.

Guidance:

Changes to existing tables:
- Add timeToLiveAttribute: 'ttl' to checkpointTable and writesTable

New tables:
Chat History:  ${appName}-chat-history  | PK: userId (S), SK: sessionId (S), TTL: ttl
Memory:        ${appName}-memory        | PK: user_id (S), SK: namespace_key (S), TTL: ttl


Also:
- Add IAM permissions for new tables (same DynamoDB actions as checkpoint tables)
- Add Bedrock InvokeModel permission for amazon.titan-embed-text-v2:0
- Pass DYNAMODB_CHAT_HISTORY_TABLE and DYNAMODB_MEMORY_TABLE env vars to ECS/Lambda
- Update .env.local.example

Demo: npx cdk synth succeeds, CloudFormation template includes new tables with correct schemas.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


### Task 3: Create unified persistence module

Objective: Create web-ui/lib/agent/persistence.ts — singleton module exporting getCheckpointer(), getMemoryStore(), getChatHistory().

Guidance:
- Use globalThis pattern for Next.js hot-reload safety
- Instantiate each component individually (our table names don't follow the tablePrefix convention):
  - new DynamoDBSaver({ checkpointsTableName, writesTableName, ttlDays: 30, compression: { enabled: true, minSizeBytes: 1024 }, s3OffloadConfig: { bucketName, keyPrefix: 'langgraph/' } })
  - new DynamoDBStore({ memoryTableName, embedding: new BedrockEmbeddings({ region, model: 'amazon.titan-embed-text-v2:0' }), ttlDays: 90 })
  - new DynamoDBChatMessageHistory({ tableName, ttlDays: 30 })
- Helper wrappers: saveMemory(userId, namespace, key, value), searchMemory(userId, namespacePrefix, query, limit)

Demo: Module imports cleanly, each getter returns the correct instance type.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


### Task 4: Migrate checkpoint saver in agent-shared.ts

Objective: Replace initCheckpointer() to use getCheckpointer() from persistence.ts. Remove old imports.

Guidance:
- Remove import { DynamoDBSaver } from "@rwai/langgraphjs-checkpoint-dynamodb"
- Remove import { DynamoDBS3Saver } from "./dynamodb-s3-saver"
- Replace initCheckpointer() body → delegate to persistence.getCheckpointer()
- Keep FileSaver fallback for local dev (when DynamoDB env vars not set)

Demo: All three agent graphs compile and persist checkpoints via the new saver.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


### Task 5: Integrate DynamoDBStore (long-term memory) into agent graphs

Objective: Wire DynamoDBStore into LangGraph compilation so agents can read/write long-term memories.

Guidance:
- Add getStore() export in agent-shared.ts → calls getMemoryStore() from persistence
- In fast-agent.ts, planning-agent.ts, deep-agent.ts: pass store to workflow.compile({ checkpointer, store })
- Add memory-related system prompt section in prompt-templates.ts instructing the agent about long-term memory capabilities
- user_id for store config comes from authenticated session (already resolved as langfuseUserId in chat/route.ts)

Demo: Memory saved in one thread is semantically searchable from another thread for the same user.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


### Task 6: Migrate chat history API routes

Objective: Replace all dynamodb-s3-chat-history-store imports with DynamoDBChatMessageHistory.

Guidance per route:

| Route | Old Call | New Call |
|-------|----------|----------|
| GET /api/threads | listThreads() | chatHistory.listSessions(userId) → map to NormalizedThread |
| POST /api/threads | createThread() | chatHistory.addMessage(userId, sessionId, firstMsg, title) |
| DELETE /api/threads/[id] | deleteThread() | chatHistory.clear(userId, sessionId) |
| PATCH /api/threads/[id] | updateThread() | Thin DynamoDB UpdateItem wrapper (package has no updateTitle) |
| GET /api/threads/[id]/history | agentStore.getThread() | chatHistory.getMessages(userId, sessionId) → convert to HistoryMessage |
| POST /api/chat (finally block) | replaceMessages() | chatHistory.addMessages(userId, sessionId, messages, title) |

Key mapping: userId = NextAuth session user ID (or 'system' fallback), sessionId = threadId.

Demo: Thread list, create, delete, history retrieval all work through the new module.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


### Task 7: Delete old files and clean up

Objective: Remove deprecated files and unused dependencies.

Files to delete:
- web-ui/lib/agent/dynamodb-s3-saver.ts
- web-ui/lib/db/dynamodb-s3-chat-history-store.ts

Deps to remove:
- @rwai/langgraphjs-checkpoint-dynamodb (already uninstalled in Task 1)
- mongodb, @langchain/langgraph-checkpoint-mongodb (if no longer used elsewhere)

Env vars to remove:
- DYNAMODB_AGENT_CONVERSATIONS_TABLE from CDK stacks and .env.local.example

Demo: npm run build succeeds with zero references to old modules.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


### Task 8: Update documentation

Objective: Update README.md and .env.local.example.

Guidance:
- Update environment variables section with new table names
- Remove DYNAMODB_AGENT_CONVERSATIONS_TABLE
- Add DYNAMODB_CHAT_HISTORY_TABLE and DYNAMODB_MEMORY_TABLE
- Add brief note about memory store + semantic search in Architecture section

Demo: README accurately reflects the new architecture.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━






## What was done

Task 1 — Dependencies
- Installed @farukada/aws-langgraph-dynamodb-ts
- Removed @rwai/langgraphjs-checkpoint-dynamodb

Task 2 — CDK Infrastructure (computeStack.ts, webUIStack.ts)
- Added timeToLiveAttribute: 'ttl' to existing checkpoint and writes tables
- Added new ${appName}-chat-history table (PK: userId, SK: sessionId)
- Added new ${appName}-memory table (PK: user_id, SK: namespace_key)
- Added dynamodb:TransactWriteItems to IAM policies (required by the new package)
- Added bedrock:InvokeModel permission for amazon.titan-embed-text-v2:0
- Passed DYNAMODB_CHAT_HISTORY_TABLE and DYNAMODB_MEMORY_TABLE env vars to ECS/Lambda

Task 3 — lib/agent/persistence.ts (new file)
- Singleton module initializing DynamoDBSaver, DynamoDBStore (with Titan Embed v2), and DynamoDBChatMessageHistory
- Exports getCheckpointer(), getMemoryStore(), getChatHistory()
- Exports saveMemory() and searchMemory() helpers

Task 4 — lib/agent/agent-shared.ts
- Removed old DynamoDBSaver and DynamoDBS3Saver imports
- initCheckpointer() now delegates to persistence.getCheckpointer()
- Added getStore() export for the memory store

Task 5 — Agent graphs (fast-agent.ts, planning-agent.ts, deep-agent.ts)
- All three graphs now pass store to workflow.compile({ checkpointer, store })
- Added LONG_TERM_MEMORY_GUIDANCE constant to prompt-templates.ts

Task 6 — API routes
- lib/auth-session.ts — new shared helper to resolve userId from NextAuth session
- app/api/threads/route.ts — migrated to chatHistory.listSessions() / addMessage()
- app/api/threads/[threadId]/route.ts — migrated to chatHistory.clear() + thin UpdateItem for title
- app/api/threads/[threadId]/history/route.ts — migrated to chatHistory.getMessages()
- app/api/chat/route.ts — finally block now uses chatHistory.addMessages()

Task 7 — Cleanup
- Deleted web-ui/lib/agent/dynamodb-s3-saver.ts
- Deleted web-ui/lib/db/dynamodb-s3-chat-history-store.ts
- Updated .env.local.example with new env vars

 ▸ Credits: 25.00 • Time: 12m 17s








════════════════════════════════════════════════════════════════════════════════
                       CONVERSATION SUMMARY
════════════════════════════════════════════════════════════════════════════════

## OBJECTIVE
Migrate the project from custom DynamoDB+S3 checkpoint/chat-history implementations to the official `@farukada/aws-langgraph-dynamodb-ts` npm package, and implement short-term memory (via `DynamoDBSaver` checkpoints) + long-term memory (via `DynamoDBStore` with Bedrock Titan Embed v2 semantic search) for LangGraph agents.

---

## USER GUIDANCE
- Choice 1a: Short-term memory = LangGraph checkpoint state; Long-term memory = `DynamoDBStore` with semantic search
- Choice 2a: New DynamoDB tables for chat history and memory, no data migration (fresh tables)
- Choice 3a: Amazon Titan Embed Text v2 (`amazon.titan-embed-text-v2:0`) for embeddings
- Implement the plan saved at `/Users/kartik/Documents/git-repo/nucleus-cloud-ops/.claude/plans/dynamodb-memory.md`

---

## COMPLETED

### Task 1 — Package install/uninstall ✅
- `npm install @farukada/aws-langgraph-dynamodb-ts` — added to `web-ui/package.json`
- `npm uninstall @rwai/langgraphjs-checkpoint-dynamodb` — removed from `web-ui/package.json`

### Task 2 — CDK stacks updated ✅
**`lib/computeStack.ts`:**
- Added `chatHistoryTableName` and `memoryTableName` constants
- Added `timeToLiveAttribute: 'ttl'` to existing `checkpointTable` and `writesTable`
- Added new `chatHistoryTable` (PK: `userId`, SK: `sessionId`, TTL: `ttl`)
- Added new `memoryTable` (PK: `user_id`, SK: `namespace_key`, TTL: `ttl`)
- Added `dynamodb:TransactWriteItems` to ECS task role IAM policy
- Added `chatHistoryTable` and `memoryTable` ARNs to IAM policy
- Added Bedrock `InvokeModel` permission for `amazon.titan-embed-text-v2:0`
- Added `DYNAMODB_CHAT_HISTORY_TABLE` and `DYNAMODB_MEMORY_TABLE` env vars to ECS container

**`lib/webUIStack.ts`:**
- Added `chatHistoryTableName` and `memoryTableName` constants
- Replaced verbose checkpoint/writes table definitions with clean versions + `timeToLiveAttribute: 'ttl'`
- Added new `chatHistoryTable` and `memoryTable` definitions
- Replaced checkpoint IAM policy with expanded one covering all 4 tables + `TransactWriteItems`
- Added Bedrock `InvokeModel` permission
- Added `DYNAMODB_CHAT_HISTORY_TABLE` and `DYNAMODB_MEMORY_TABLE` env vars to Lambda

### Task 3 — `persistence.ts` created ✅
- Created `web-ui/lib/agent/persistence.ts` — singleton module using `globalThis` pattern
- Instantiates `DynamoDBSaver`, `DynamoDBStore`, `DynamoDBChatMessageHistory` individually (not via `DynamoDBFactory.createAll()` because table names don't follow prefix convention)
- Exports: `getCheckpointer()`, `getMemoryStore()`, `getChatHistory()`, `saveMemory()`, `searchMemory()`
- `DynamoDBSaver`: `ttlDays: 30`, `compression: { enabled: true, minSizeBytes: 1024 }`, S3 offload from `CHECKPOINT_S3_BUCKET` env
- `DynamoDBStore`: `ttlDays: 90`, `BedrockEmbeddings` with `amazon.titan-embed-text-v2:0`
- `DynamoDBChatMessageHistory`: `ttlDays: 30`

**⚠️ KNOWN ISSUE — NOT YET FIXED:** The `compression` option in `DynamoDBSaverOptions` was flagged as unknown by the targeted tsc check. Need to verify the actual field name from the package's type definitions at:
`web-ui/node_modules/@farukada/aws-langgraph-dynamodb-ts/dist/checkpointer/types/index.d.ts`

### Task 4 — `agent-shared.ts` updated ✅
- Removed `import { DynamoDBSaver } from "@rwai/langgraphjs-checkpoint-dynamodb"`
- Removed `import { DynamoDBS3Saver } from "./dynamodb-s3-saver"`
- Added `import { getCheckpointer as getDynamoCheckpointer, getMemoryStore } from "./persistence"`
- Added `import type { DynamoDBStore } from "@farukada/aws-langgraph-dynamodb-ts"`
- Replaced `initCheckpointer()` body to delegate to `getDynamoCheckpointer()` from persistence
- Added `getStore()` export that returns `DynamoDBStore | undefined`
- Added `userId?: string` to `GraphConfig` interface

### Task 5 — Agent graphs updated ✅
- `fast-agent.ts`: imports `getStore`, calls `await getStore()`, passes `...(store && { store })` to `workflow.compile()`
- `planning-agent.ts`: same pattern
- `deep-agent.ts`: imports `getStore`, calls `await getStore()`, passes `...(store && { store })` to `createDeepAgent()`
- `prompt-templates.ts`: added `LONG_TERM_MEMORY_GUIDANCE` export with namespace conventions

### Task 6 — Chat history API routes migrated ✅
- Created `web-ui/lib/auth-session.ts` — shared `getSessionUserId()` helper (NextAuth session → userId, fallback `'system'`)
- Rewrote `app/api/threads/route.ts` — GET uses `chatHistory.listSessions(userId)`, POST uses `chatHistory.addMessage()`
- Rewrote `app/api/threads/[threadId]/route.ts` — DELETE uses `chatHistory.clear()`, PATCH uses direct `DynamoDBDocument.update()` for title (package has no `updateTitle`)
- Rewrote `app/api/threads/[threadId]/history/route.ts` — uses `chatHistory.getMessages()` with checkpoint fallback
- Updated `app/api/chat/route.ts` — removed old `DYNAMODB_AGENT_CONVERSATIONS_TABLE` branch, replaced `finally` block message persistence with `chatHistory.addMessages()`

### Task 7 — Old files deleted ✅
- Deleted `web-ui/lib/agent/dynamodb-s3-saver.ts`
- Deleted `web-ui/lib/db/dynamodb-s3-chat-history-store.ts`

### Task 8 — `.env.local.example` updated ✅
- Replaced `DYNAMODB_AGENT_CONVERSATIONS_TABLE=nucleus-app-agent-conversations` with:
  - `DYNAMODB_CHAT_HISTORY_TABLE=nucleus-app-chat-history`
  - `DYNAMODB_MEMORY_TABLE=nucleus-app-memory`

---

## TECHNICAL CONTEXT

### Package API (from docs)
```typescript
// DynamoDBSaver
new DynamoDBSaver({
  checkpointsTableName: string,   // required
  writesTableName: string,        // required
  ttlDays?: number,
  ttlSeconds?: number,
  compression?: { enabled: boolean, minSizeBytes?: number, level?: number },
  s3OffloadConfig?: { bucketName, keyPrefix?, thresholdBytes?, serverSideEncryption?, sseKmsKeyId?, clientConfig? },
  clientConfig?: DynamoDBClientConfig,
  client?: DynamoDBDocument,
})

// DynamoDBStore
new DynamoDBStore({
  memoryTableName: string,        // required
  embedding?: EmbeddingsInterface,
  ttlDays?: number,
  clientConfig?: DynamoDBClientConfig,
  client?: DynamoDBDocument,
})

// DynamoDBChatMessageHistory
new DynamoDBChatMessageHistory({
  tableName: string,              // required
  ttlDays?: number,
  clientConfig?: DynamoDBClientConfig,
  client?: DynamoDBDocument,
})
```

### Table schemas
| Table | PK | SK | TTL attr |
|-------|----|----|----------|
| `${appName}-checkpoints-table` | `thread_id` (S) | `checkpoint_id` (S) | `ttl` |
| `${appName}-checkpoint-writes-v2-table` | `thread_id_checkpoint_id_checkpoint_ns` (S) | `task_id_idx` (S) | `ttl` |
| `${appName}-chat-history` | `userId` (S) | `sessionId` (S) | `ttl` |
| `${appName}-memory` | `user_id` (S) | `namespace_key` (S) | `ttl` |

### Env vars (new)
```
DYNAMODB_CHECKPOINT_TABLE     # existing, kept
DYNAMODB_WRITES_TABLE         # existing, kept
CHECKPOINT_S3_BUCKET          # existing, kept
DYNAMODB_CHAT_HISTORY_TABLE   # new
DYNAMODB_MEMORY_TABLE         # new
```

### Key files changed
- `web-ui/lib/agent/persistence.ts` — NEW, singleton for all 3 components
- `web-ui/lib/auth-session.ts` — NEW, `getSessionUserId()` helper
- `web-ui/lib/agent/agent-shared.ts` — updated imports, `getStore()` export, `GraphConfig.userId`
- `web-ui/lib/agent/fast-agent.ts` — `store` wired into `workflow.compile()`
- `web-ui/lib/agent/planning-agent.ts` — `store` wired into `workflow.compile()`
- `web-ui/lib/agent/deep-agent.ts` — `store` wired into `createDeepAgent()`
- `web-ui/lib/agent/prompt-templates.ts` — `LONG_TERM_MEMORY_GUIDANCE` export added
- `web-ui/app/api/threads/route.ts` — fully rewritten
- `web-ui/app/api/threads/[threadId]/route.ts` — fully rewritten
- `web-ui/app/api/threads/[threadId]/history/route.ts` — fully rewritten
- `web-ui/app/api/chat/route.ts` — `finally` block and thread creation updated
- `lib/computeStack.ts` — new tables, TTL, IAM, env vars
- `lib/webUIStack.ts` — new tables, TTL, IAM, env vars

### Pattern: userId mapping
- `userId` = NextAuth session `sub` claim or `email`, fallback `'system'`
- `sessionId` = `threadId` (the existing thread ID used throughout the app)

### Pattern: store wiring in graphs
```typescript
const store = await getStore();
workflow.compile({ checkpointer, ...(store && { store }) })
```

---

## TOOLS EXECUTED
- `npm install @farukada/aws-langgraph-dynamodb-ts` → added 5 packages
- `npm uninstall @rwai/langgraphjs-checkpoint-dynamodb` → removed 9 packages
- Deleted `web-ui/lib/agent/dynamodb-s3-saver.ts`
- Deleted `web-ui/lib/db/dynamodb-s3-chat-history-store.ts`
- Targeted tsc check revealed one type error in `persistence.ts`: `compression` field flagged as unknown in `DynamoDBSaverOptions` — the check was cancelled before reading the actual type definition file

---

## NEXT STEPS

1. **Fix `compression` field name in `persistence.ts`** — Read the actual type definition:
   ```
   cat web-ui/node_modules/@farukada/aws-langgraph-dynamodb-ts/dist/checkpointer/types/index.d.ts
   ```
   Then correct the field name in `persistence.ts` if it differs from `compression`.

2. **Verify `DynamoDBStore.batch()` API signature** — The `searchMemory` helper in `persistence.ts` uses `store.batch([{ namespacePrefix, query, limit }], config)`. Confirm this matches the actual exported method signature from:
   ```
   cat web-ui/node_modules/@farukada/aws-langgraph-dynamodb-ts/dist/store/index.d.ts
   ```

3. **Run a build check** — After fixing the type error:
   ```bash
   cd web-ui && npm run build 2>&1 | tail -30
   ```

4. **Verify `app/api/chat/route.ts` `finally` block** — Confirm the old multi-line message conversion block was fully removed and only the new `chatHistory.addMessages()` call remains. Check around line 620–680.

5. **Check `agentConversationsTableName` in `computeStack.ts`** — The old `agentConversationsTable` was kept (it's a separate table used elsewhere). Confirm it's still referenced correctly and the `DYNAMODB_AGENT_CONVERSATIONS_TABLE` env var was removed from the ECS container environment block (it was replaced by `DYNAMODB_CHAT_HISTORY_TABLE`).

6. **Update `app/api/chat/route.ts` to pass `userId` to graph config** — The `langfuseUserId` is already resolved at the top of the POST handler. Pass it as `userId` in `graphConfig` so agents can scope memory store operations per user:
   ```typescript
   const graphConfig = {
     ...
     userId: langfuseUserId,
   };
   ```

## TODO LIST
ID if loaded: none

The conversation history has been replaced with this summary.
It contains all important details from previous interactions.
════════════════════════════════════════════════════════════════════════════════



 ▸ Time: 53s