# Implementation Plan: Agent Ops — Slack Integration

## Overview

Implement the complete vertical slice for Slack slash command (`/cloud-ops`) integration with the LangGraph agent executor. Tasks follow the data flow: signature verification → run creation → async agent execution → event streaming → result delivery.

## Tasks

- [x] 1. Create DynamoDB models
  - [x] 1.1 Implement `AgentOpsRunModel` in `web-ui/lib/agent-ops/models/agent-ops-run.ts`
    - Define Dynamoose schema with PK/SK, GSI1PK/GSI1SK, all run fields, and TTL attribute
    - Export the Dynamoose model bound to `process.env.AGENT_OPS_TABLE_NAME`
    - _Requirements: Data model — AgentOpsRun_

  - [x] 1.2 Implement `AgentOpsEventModel` in `web-ui/lib/agent-ops/models/agent-ops-event.ts`
    - Define Dynamoose schema with `PK=RUN#<runId>`, `SK=EVENT#<ts>#<nanos>`, all event fields, and TTL attribute
    - Export the Dynamoose model bound to the same table
    - _Requirements: Data model — AgentOpsEvent_

  - [x] 1.3 Write unit tests for model schemas
    - Verify key construction patterns and TTL calculation
    - _Requirements: Data model — AgentOpsRun, AgentOpsEvent_

- [x] 2. Implement Slack validator
  - [x] 2.1 Create `web-ui/lib/agent-ops/slack-validator.ts`
    - Implement `verifySlackSignature(body, timestamp, signature): boolean` using `crypto.createHmac` and `crypto.timingSafeEqual()`
    - Reject missing `SLACK_SIGNING_SECRET`, stale timestamps (> 300s), and mismatched HMACs
    - Implement `parseSlackSlashCommand(body): SlackSlashCommandPayload` using `URLSearchParams`
    - Export `SlackSlashCommandPayload` interface
    - _Requirements: Slack signature verification, replay attack prevention_

  - [x] 2.2 Write property test for `verifySlackSignature`
    - **Property 1: Signature correctness** — for any `(body, timestamp, secret)` triple, `verifySlackSignature` returns `true` iff the signature was computed with the same secret
    - **Validates: Requirements — HMAC-SHA256 verification**

  - [x] 2.3 Write unit tests for `slack-validator.ts`
    - Test valid signature, invalid signature, stale timestamp (> 5 min), missing secret, empty body
    - Test `parseSlackSlashCommand` round-trips all fields including `text` and `response_url`
    - _Requirements: Slack signature verification_

- [x] 3. Implement agent ops service
  - [x] 3.1 Create `web-ui/lib/agent-ops/agent-ops-service.ts` with `createRun()`
    - Generate `runId` (UUID v4) and `threadId` (`agent-ops-<runId>`)
    - Set `status='queued'`, `ttl=now+30days`, build PK/SK and GSI1 keys
    - Write item to DynamoDB via Dynamoose and return the full `AgentOpsRun` object
    - _Requirements: Run creation, single-table design_

  - [x] 3.2 Add `updateRunStatus()` to `agent-ops-service.ts`
    - Accept `status`, optional `result`, and optional `error`
    - Set `completedAt` and `durationMs` when transitioning to `completed` or `failed`
    - _Requirements: Run lifecycle status transitions_

  - [x] 3.3 Add `recordEvent()` to `agent-ops-service.ts`
    - Use `process.hrtime()` nonce in SK to guarantee uniqueness within the same millisecond
    - Swallow all errors (log but never throw) — agent run must not abort on event write failure
    - Cap `content` and `toolOutput` at 10KB before writing
    - _Requirements: Event recording, error swallowing_

  - [x] 3.4 Write property test for event SK uniqueness
    - **Property 2: Event SK uniqueness** — for any `runId`, concurrent calls to `recordEvent` produce strictly unique SKs
    - **Validates: Requirements — nonce-based SK uniqueness_**

  - [x] 3.5 Add `getRun()`, `listRuns()`, and `getRunEvents()` to `agent-ops-service.ts`
    - `getRun` queries by PK+SK; returns `null` if not found
    - `listRuns` queries GSI1 with optional pagination via `lastKey`
    - `getRunEvents` queries by `PK=RUN#<runId>` with SK prefix `EVENT#`
    - _Requirements: Run retrieval and listing_

  - [x] 3.6 Write unit tests for `agent-ops-service.ts`
    - Test `createRun` produces correct DynamoDB keys and `threadId` format
    - Test `recordEvent` swallows errors without throwing
    - Test `updateRunStatus` sets `completedAt` only on terminal states
    - _Requirements: Run creation, event recording, status transitions_

- [x] 4. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Implement agent executor
  - [x] 5.1 Create `web-ui/lib/agent-ops/agent-executor.ts` with `executeAgentRun(run)`
    - Create sandbox directory at `/tmp/agent-ops/<runId>/`
    - Mark run `in_progress`, build `GraphConfig`, invoke `createDynamicExecutorGraph(config)`
    - Stream events via `graph.streamEvents(input, { version: 'v2', configurable: { thread_id } })`
    - Always delete sandbox directory in `finally` block
    - _Requirements: Agent execution lifecycle, sandbox isolation_

  - [x] 5.2 Implement `processLangGraphEvent()` inside `agent-executor.ts`
    - Map `on_chain_start`, `on_chain_end`, `on_chat_model_end`, `on_tool_start`, `on_tool_end` to `AgentEventType`
    - Track `toolsUsed` (Set, monotonically growing), `iterationCount`, and `finalContent`
    - Skip `on_chat_model_stream` and `on_chain_stream` events
    - Extract final content from `on_chain_end` (node=`final`) or `on_chat_model_end`
    - _Requirements: LangGraph event mapping, tool tracking_

  - [x] 5.3 Add completion and failure handling to `executeAgentRun()`
    - On success: call `updateRunStatus('completed', { result: { summary, toolsUsed, iterations } })`
    - On failure: call `updateRunStatus('failed', { error: error.message })` and `recordEvent('error', 'executor', ...)`
    - _Requirements: Run completion, error handling_

  - [x] 5.4 Write unit tests for `agent-executor.ts`
    - Test status transitions `queued → in_progress → completed` and `queued → in_progress → failed`
    - Test sandbox directory is always cleaned up (even on error)
    - Test `toolsUsed` grows monotonically and never shrinks
    - _Requirements: Agent execution lifecycle_

- [x] 6. Implement Slack trigger route
  - [x] 6.1 Create `web-ui/app/api/v1/trigger/slack/route.ts`
    - Read raw body as text (before any parsing) for HMAC verification
    - Call `verifySlackSignature()` — return `401` on failure
    - Call `parseSlackSlashCommand()` — return `200` with usage hint if `text` is empty
    - Call `agentOpsService.createRun()` with `source='slack'`
    - Fire `executeAgentRun(run)` without `await`; attach `.then()` / `.catch()` to post result/error to `response_url`
    - Return `200` with ephemeral acknowledgement message within Slack's 3-second window
    - Set `export const maxDuration = 10`
    - _Requirements: Slack slash command handler, fire-and-forget execution_

  - [x] 6.2 Write unit tests for the Slack route
    - Test `401` on invalid signature
    - Test `200` with usage hint on empty `text`
    - Test `200` acknowledgement with `runId` on valid request
    - Verify `executeAgentRun` is called without `await` (fire-and-forget)
    - _Requirements: Slack slash command handler_

- [x] 7. Wire result delivery back to Slack
  - [x] 7.1 Implement `postResultToSlack()` and `postErrorToSlack()` helpers in `web-ui/lib/agent-ops/slack-notifier.ts`
    - `postResultToSlack`: POST to `response_url` with `{ text: '✅ Complete\n<summary>' }`
    - `postErrorToSlack`: POST to `response_url` with `{ text: '❌ Agent Ops failed: <msg>' }`
    - Log but swallow errors if the `response_url` POST fails (run record already reflects final status)
    - _Requirements: Async result delivery, error scenario 5_

  - [x] 7.2 Wire `postResultToSlack` / `postErrorToSlack` into the route's `.then()` / `.catch()` handlers
    - Import from `slack-notifier.ts` and attach in `route.ts`
    - _Requirements: Async result delivery_

  - [x] 7.3 Write unit tests for `slack-notifier.ts`
    - Test successful POST formats the message correctly
    - Test failure is swallowed without throwing
    - _Requirements: Async result delivery_

- [x] 8. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP
- The design uses TypeScript throughout — all files are `.ts`
- `fast-check` is the property-based test library (already in the Next.js ecosystem)
- Property tests validate universal correctness; unit tests cover specific examples and edge cases
- Each task references the relevant design section for traceability
