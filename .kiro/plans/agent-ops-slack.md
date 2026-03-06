Let me explore the existing agent-ops code first to understand what's already there.

Now let me look at the existing slack validator and the agent executor to understand the full flow:

Now I have a thorough understanding of the codebase. Let me brainstorm and plan this with you.

---

Here's what I understand you want to build:

```
Slack message → Agent Ops triggered → Plan & Execute → 
  [needs approval?] → pause → notify Slack → 
  user replies "approved" → resume same execution → 
  complete → post result back to Slack
```

The good news: the infrastructure for ~80% of this already exists. Let me map what's there vs what's missing.

---

## What Already Exists

- `slack-validator.ts` — verifies Slack signatures, parses slash commands
- `slack-notifier.ts` — posts results/errors/clarifications back to Slack threads
- `agent-executor.ts` — runs the LangGraph, handles `awaiting_input` state, posts clarification to Slack
- `executor-graphs.ts` — the graph already has `interruptBefore: ["tools"]` when `autoApprove=false`
- `agent-ops-service.ts` — `findAwaitingRunBySlackThread()` already exists for HIL lookup
- `types.ts` — `SlackTriggerMeta` has `threadTs` for thread correlation

---

## What's Missing (The Gap)

The current flow handles **clarification** (ambiguous task) but the **approval gate** for tool execution is incomplete end-to-end:

1. **Approval notification to Slack** — when the graph hits `interruptBefore: ["tools"]`, it sets `awaiting_input` but never posts the pending tool list to Slack with an approve/reject prompt
2. **Slack reply handler** — no route/handler exists to receive the user's "approved" reply from Slack and resume the LangGraph thread
3. **Resume with approval** — the `ResumeRequest` type exists but the executor doesn't have a `resumeAgentRun()` function that calls `graph.invoke(null, ...)` to continue from the checkpoint
4. **Approval message format** — need a structured Slack message showing what tools are about to run (with approve/deny buttons or a reply keyword)

---

## Proposed Design

```
[Slack slash command]
        ↓
/api/agent-ops/slack  (existing trigger endpoint)
        ↓
createRun() → executeAgentRun() → graph runs
        ↓
graph hits interruptBefore["tools"]
        ↓
postApprovalRequestToSlack()  ← NEW
  "🔧 About to run: bash_exec, aws_cli
   Reply 'approve <runId>' or 'deny <runId>'"
        ↓
status = awaiting_input (tool_approval)
        ↓
[User replies in Slack thread]
        ↓
/api/agent-ops/slack  (same endpoint, detects reply pattern)
        ↓
findAwaitingRunBySlackThread() → resumeAgentRun()  ← NEW
        ↓
graph.invoke(null, { thread_id }) → continues from checkpoint
        ↓
execution completes → postResultToSlack()  ← already exists
```

---

## Files to Create/Modify

- `slack-notifier.ts` — add `postApprovalRequestToSlack()` 
- `agent-executor.ts` — add `resumeAgentRun()` function, fix the approval interrupt path to actually notify Slack
- `types.ts` — add `ApprovalRequest` type, extend `AgentOpsClarification` with `type: 'clarification' | 'tool_approval'`
- `/api/agent-ops/slack/route.ts` — extend to detect approval replies and route to resume (need to find this file)

Let me check the API route:

Let me read the existing Slack route and the runId route to complete the picture:

Now I have the full picture. Here's the complete plan:

---

## Understanding the Task

You want a full Slack → Agent Ops → Plan & Execute → **Approval Gate** → Resume → Complete → Slack loop. Specifically:

1. Slack triggers a run
2. Agent plans and starts executing
3. Before running tools (when `autoApprove=false`), it **pauses and posts an approval request to Slack** with the pending tool list
4. User replies "approve `<runId>`" or "deny `<runId>`" in the thread
5. The Slack route detects this pattern, resumes the LangGraph from its checkpoint
6. Execution completes and posts the result back to Slack

---

## What's Missing vs What Exists

The current code handles **clarification** (ambiguous task → ask user → restart with enriched task). But the **tool approval** path is broken:
- `agent-executor.ts` sets `awaiting_input` for tool interrupts but never posts to Slack
- The Slack route's HIL resume calls `executeAgentRun()` (restarts from scratch) instead of `graph.invoke(null, ...)` (resumes from checkpoint)
- No `resumeAgentRun()` function exists

---

## Files to Change

- `web-ui/lib/agent-ops/slack-notifier.ts` — add `postApprovalRequestToSlack()`
- `web-ui/lib/agent-ops/agent-executor.ts` — fix the tool interrupt path to notify Slack + add `resumeAgentRun()`
- `web-ui/app/api/v1/trigger/slack/route.ts` — detect `approve <runId>` / `deny <runId>` reply pattern and route to `resumeAgentRun()`

---

## Approach

The key insight: LangGraph's `interruptBefore` + checkpointer means the graph state is frozen in DynamoDB. To resume, you call `graph.invoke(null, { configurable: { thread_id } })` — passing `null` as input tells it to continue from the checkpoint. No need to re-run from scratch.

For approval detection in the Slack route, we check if the message matches `^(approve|deny)\s+<runId>` before the existing thread-based HIL check.

---

## Risks

- The `resumeAgentRun()` needs to rebuild the same graph (same `graphConfig`) — we need to store enough config on the run record to reconstruct it. The `AgentOpsRun` already has `model`, `accountId`, `mcpServerIds`, `autoApprove` — we're good.
- Denial path: when user denies, we mark the run `cancelled` and post a message. No graph resume needed.
- The existing thread-based HIL (clarification resume) currently calls `executeAgentRun()` which restarts — this is intentional for clarification (new task with enriched context). We keep that as-is and only add the new approval path.

---



I'll start by understanding the existing codebase in the agent-ops folder, then plan this out properly since you referenced `#planning-workflow`.

I'll systematically explore the agent-ops module and related architecture to understand the current implementation and identify what's needed for the Slack-integrated workflow.

Let me start by examining the key directories and documentation:

Now let me examine the agent-ops module files and the models directory:

Now let me read the key agent-ops files to understand the current implementation:

Now let me check the API routes and infrastructure to understand how runs are triggered:

Let me check the agent-ops API routes more closely:

Let me check for Slack webhook handlers:

Let me check if there's a Slack webhook route and look at the test to understand the expected flow:

Perfect! Now let me check the Slack trigger route to see the complete implementation:

Excellent! Now let me check the CDK infrastructure to understand the deployment:

I'll now provide a comprehensive summary of my findings about the agent-ops module and the Slack-integrated workflow architecture.

Now let me read the remaining critical files to complete my understanding.

Now I have a thorough understanding of the codebase. Let me present the plan.

---

## Planning Phase

### 1. Understanding the Task

You want a full Slack-driven approval workflow:

**Slack message → Agent Ops triggered → Plan & Execute → [needs approval?] → pause → notify Slack → user replies "approved" → resume same execution → complete → post result back to Slack**

The codebase already has ~80% of the plumbing. The agent executor already handles `autoApprove=false` and pauses at tool interrupts, setting status to `awaiting_input` with `missingInfo: 'tool_approval'`. What's missing is:

- A dedicated `awaiting_approval` status (currently overloads `awaiting_input`)
- Slack notification when approval is needed (currently silent)
- A way for Slack users to reply "approved"/"rejected" and have it route correctly
- An `/approve` API endpoint to handle the approval action
- Thread-based detection of approval replies in the Slack trigger

### 2. Files to Create/Modify

| File | Action | Reason |
|------|--------|--------|
| `web-ui/lib/agent-ops/types.ts` | Modify | Add `'awaiting_approval'` to `AgentOpsStatus` |
| `web-ui/lib/agent-ops/slack-notifier.ts` | Modify | Add `postApprovalRequestToSlack()` function |
| `web-ui/lib/agent-ops/agent-executor.ts` | Modify | Post approval notification to Slack when pausing for tool approval |
| `web-ui/lib/agent-ops/agent-ops-service.ts` | Modify | Add `findAwaitingApprovalBySlackThread()` method |
| `web-ui/app/api/agent-ops/[runId]/approve/route.ts` | Create | New endpoint to handle approval/rejection |
| `web-ui/app/api/v1/trigger/slack/route.ts` | Modify | Detect approval replies ("approved"/"rejected") in thread and route to approve flow |

### 3. Approach

- Add `'awaiting_approval'` as a distinct status so it's semantically clear vs `awaiting_input` (clarification)
- When the executor hits a tool interrupt with `autoApprove=false`, it posts a Slack message listing the pending tools and asking for approval
- The Slack trigger endpoint detects thread replies matching approval patterns ("approve", "approved", "yes", "reject", "rejected", "no") and routes them to the approve endpoint
- The approve endpoint resumes the LangGraph execution from its checkpoint, passing the approval decision
- On completion, the existing `postResultToSlack` handles posting the result back

### 4. Risks

- LangGraph checkpoint state must survive the pause period (already stored in DynamoDB, so this is fine)
- Slack's `response_url` expires after 30 minutes, so we use `botToken` + `chat.postMessage` for thread replies (already supported)
- The approval reply detection needs to be careful not to confuse approval replies with new task requests in the same thread
- Adding a new status value requires checking all places that filter on status (the DynamoDB queries use string equality, so this is safe)

### 5. Shall I proceed?