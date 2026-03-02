

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


Implementation Plan — Fix DynamoDB Persistence: Auth, userId Scoping & Chat History

Problem Statement:
After migrating to @farukada/aws-langgraph-dynamodb-ts, no data is populating in DynamoDB tables. Root causes: (1) resolvedUserId is out of scope in processStream's finally block, (2) user_id is missing from streamEvents/invoke configurable, (3) 
getSessionUserId() silently falls back to 'system' instead of failing, (4) userId format doesn't match the USER#<sub> convention used in the users-teams table, (5) non-streaming path doesn't persist chat history, (6) thread creation seeds an empty 
HumanMessage.

Requirements:
- userId resolved server-side only from NextAuth/Cognito session (session.user.sub)
- Return 401 if no authenticated session (no 'system' fallback)
- userId format: USER#<cognito-sub> (consistent with users-teams table)
- All 4 DynamoDB tables (checkpoints, writes, chat-history, memory) must receive data
- processStream must have access to resolvedUserId for the finally block
- user_id must be in every configurable object passed to LangGraph

Background:
- auth-options.ts extracts Cognito sub from the id_token JWT and puts it on session.user.sub
- role-service.ts uses USER#${sub} as PK in the users-teams table
- chat/route.ts resolves userId inline (duplicating auth-session.ts logic) and the processStream function can't access it
- streamEvents and invoke both pass configurable: { thread_id } without user_id, so DynamoDBStore.batch() fails
- The non-streaming invoke path has no chat history persistence at all

Proposed Solution:
Fix auth-session.ts to return USER#<sub> and throw on unauthenticated requests. Fix chat/route.ts to pass resolvedUserId into processStream and include user_id in all configurable objects. Add chat history persistence to the non-streaming path. Fix
thread creation to not seed empty messages.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


Task Breakdown:

Task 1: Fix auth-session.ts — enforce auth, use USER# prefix

Objective: getSessionUserId() must return USER#<cognito-sub> or throw (no fallback).

Implementation:
- Change getSessionUserId() to throw an error if no session or no sub/email
- Format: USER#${sub} (using sub first, then email)
- Remove the 'system' fallback and the try/catch that swallows errors
- Export a second helper getSessionUserIdOrNull() for cases where a soft check is needed (returns string | null)

Files: web-ui/lib/auth-session.ts

Demo: Calling getSessionUserId() without a valid Cognito session throws, and with a valid session returns USER#<sub>.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


Task 2: Fix chat/route.ts — userId resolution and 401 on unauthenticated

Objective: Replace inline session resolution with getSessionUserId(), return 401 if unauthenticated.

Implementation:
- Replace the inline getServerSession + try/catch block (lines 52-60) with a call to getSessionUserId() from auth-session.ts
- Wrap in try/catch: if it throws, return 401 Unauthorized
- Remove the 'system' fallback
- langfuseUserId derives from the resolved userId (strip USER# prefix for Langfuse since it expects a plain ID)

Files: web-ui/app/api/chat/route.ts

Demo: Unauthenticated requests to /api/chat return 401. Authenticated requests proceed with USER#<sub>.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


Task 3: Fix processStream — pass resolvedUserId as parameter

Objective: The finally block in processStream needs resolvedUserId in scope.

Implementation:
- Add resolvedUserId: string parameter to processStream function signature (after config)
- Update the call site (line ~261) to pass resolvedUserId
- The finally block on line 635 already uses resolvedUserId — it just needs to be the parameter, not the outer variable

Files: web-ui/app/api/chat/route.ts

Demo: After a chat stream completes, messages appear in the chat-history DynamoDB table with the correct USER#<sub> userId.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


Task 4: Fix configurable objects — add user_id everywhere

Objective: Every LangGraph configurable must include user_id so DynamoDBStore can scope memory operations.

Implementation:
- streamEvents configurable (line ~252): change from { thread_id: threadId } to { thread_id: threadId, user_id: resolvedUserId }
- invoke configurable (line ~274): same change
- processStream config argument (line ~269): pass { configurable: { thread_id: threadId, user_id: resolvedUserId } } instead of just { thread_id }
- The existing config on line 140 already has user_id — reuse it for all three call sites

Files: web-ui/app/api/chat/route.ts

Demo: save_memory and search_memory tools work during agent execution; items appear in the memory DynamoDB table with user_id = USER#<sub>.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


Task 5: Add chat history persistence to non-streaming path

Objective: The else branch (non-streaming invoke) must also persist messages to chat history.

Implementation:
- After graph.invoke() returns and before releaseThreadLock(), add the same persistence logic as the streaming finally block:
  - Get final state messages from result.messages
  - Call chatHistory.addMessages(resolvedUserId, threadId, messages, title)
- Wrap in try/catch so persistence failure doesn't break the response

Files: web-ui/app/api/chat/route.ts

Demo: Non-streaming chat requests also populate the chat-history table.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


Task 6: Fix thread creation — don't seed empty HumanMessage

Objective: POST /api/threads should create session metadata without inserting a phantom empty message.

Implementation:
- In app/api/threads/route.ts POST handler, replace chatHistory.addMessage(userId, id, new HumanMessage(''), title) with a direct DynamoDB update call (same pattern as the eager seed in chat/route.ts lines 85-92)
- This creates the metadata row (title, createdAt, updatedAt, messageCount=0) without adding an empty message to the messages array

Files: web-ui/app/api/threads/route.ts

Demo: Creating a new thread from the sidebar doesn't insert a phantom empty message. Thread appears in list immediately.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


Task 7: Update all thread API routes to use getSessionUserId() with 401

Objective: All thread routes should fail with 401 if unauthenticated, consistent with Task 2.

Implementation:
- GET /api/threads — wrap getSessionUserId() in try/catch, return 401 on failure
- POST /api/threads — same
- DELETE /api/threads/[threadId] — same
- PATCH /api/threads/[threadId] — same
- GET /api/threads/[threadId]/history — same
- The eager seed in chat/route.ts (line 89) already uses resolvedUserId which is now guaranteed to be USER#<sub> (from Task 2)

Files: web-ui/app/api/threads/route.ts, web-ui/app/api/threads/[threadId]/route.ts, web-ui/app/api/threads/[threadId]/history/route.ts

Demo: All thread endpoints return 401 for unauthenticated requests. Authenticated requests use USER#<sub> consistently.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


Task 8: Verify build and end-to-end

Objective: Confirm no type errors and all tables receive data.

Implementation:
- Run cd web-ui && npx tsc --noEmit — should pass
- Run npm run build — should succeed
- Verify no remaining references to 'system' fallback in auth/chat paths

Demo: Clean build. Sending a chat message populates: checkpoints table, writes table, chat-history table. Using save_memory tool populates the memory table. All with USER#<sub> as the userId/user_id.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


