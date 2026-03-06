

This is architecturally significant (new service, new data model, Slack integration, LangGraph state management) — switching to planning mode.

Let me first explore the existing agent-ops codebase to understand what's already built.

I'll gather the essential context about the agent-ops feature across these key areas. Let me start by exploring the structure and reading the most critical files in parallel.

Now let me explore the agent-ops directories and API routes:

Let me also check the docs/agent-ops directory and read key files:

Now let me read the key implementation files to understand the execution flow and state management:

Now let me check the API routes and executor implementation:

Let me check the DynamoDB models and the API routes for agent-ops:

Perfect! Now let me check the run-manager for cancellation support and the Walkthrough documentation:

Perfect! Now let me compile all the findings into a comprehensive summary for the parent agent.

Now I'll provide the final response with all the relevant files and findings:

Now let me read the remaining critical files to understand the full picture.

Now let me check the executor-graphs for the evaluator's approval logic and the existing interrupt mechanism:

Now let me check the `findAwaitingRunBySlackThread` implementation and the `updateRunTrigger` method:

I now have a thorough understanding of the entire codebase. Here's the detailed plan:

---

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## [PLAN ARTIFACT] — Slack Human-in-the-Loop Approval Workflow
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**Task:** Implement a full Slack-native approval workflow for Agent Ops:
`Slack message → Agent triggered → Plan & Execute → [needs approval?] → pause → notify Slack with Block Kit buttons → user clicks Approve/Reject → resume same execution → complete → post result back to Slack`

**Goal:** Transform the existing fire-and-forget Slack integration into an interactive, approval-gated workflow using Slack Block Kit buttons and LangGraph checkpoint-based resume.

---

### What Already Exists (Foundation)

| Component | Status | Notes |
|-----------|--------|-------|
| Slack trigger route | ✅ Built | `/api/v1/trigger/slack` — slash command, HMAC validation |
| Slack notifier | ✅ Built | Posts results/errors/clarifications to threads |
| LangGraph graph | ✅ Built | `createDynamicExecutorGraph` with evaluator → planner → generate → tools → reflect → revise → final |
| DynamoDB checkpointer | ✅ Built | `DynamoDBSaver` — full checkpoint/resume support |
| `interruptBefore: ["tools"]` | ✅ Built | When `autoApprove=false`, graph pauses before tool execution |
| `awaiting_input` status | ✅ Built | Run status + clarification field in DynamoDB |
| Thread-based HIL resume | ✅ Built | `findAwaitingRunBySlackThread` + thread reply detection |
| Run manager | ✅ Built | AbortController registry for cancel/interrupt |
| Bot token support | ✅ Built | `chat.postMessage` via `SlackIntegrationConfig.botToken` |

### What's Missing (The Gap)

| Gap | Description |
|-----|-------------|
| **Block Kit approval message** | Currently posts plain text clarification. Need Block Kit with Approve/Reject buttons |
| **Slack Interactivity endpoint** | No route to receive Slack button click payloads (`action_id` callbacks) |
| **Plan presentation before execution** | Evaluator determines `requiresApproval` but doesn't pause to show the plan to the user before executing |
| **Approval state in DynamoDB** | Need `awaiting_approval` status distinct from `awaiting_input` (clarification) |
| **Graph interrupt at plan stage** | Currently only interrupts before `tools` node. Need to also interrupt after `planner` node when approval is required |
| **Resume with approval** | Current resume re-runs the entire graph. Need to resume from checkpoint with approval signal |
| **Rejection handling** | No way to reject/cancel a paused run from Slack |

---

### Subtasks

**Subtask 1 — Types & Status Updates** (`types.ts`, `executor-state.ts`)
- Add `'awaiting_approval'` to `AgentOpsStatus`
- Add `ApprovalRequest` interface (plan steps, pending tools, approval type)
- Add `approvalRequest` field to `AgentOpsRun`
- Add `approvalStatus` to `ReflectionState` for graph-level awareness

**Subtask 2 — DynamoDB Model Update** (`models/agent-ops-run.ts`)
- Add `approvalRequest` map attribute to schema
- Add `approvalStatus` string attribute

**Subtask 3 — Slack Block Kit Notifier** (`slack-notifier.ts`)
- New `postApprovalRequestToSlack()` function that sends Block Kit message with:
  - Plan summary (numbered steps)
  - Task description
  - Approve ✅ / Reject ❌ buttons with `action_id: agent_ops_approve` / `agent_ops_reject`
  - `value` field containing `runId|tenantId` for correlation
- Update existing thread reply logic to support Block Kit payloads

**Subtask 4 — Graph Interrupt After Planner** (`executor-graphs.ts`)
- Add new `approval_gate` node between `planner` and `generate`
- When `requiresApproval=true` AND `autoApprove=false`, route planner → approval_gate → END (interrupt)
- `approval_gate` node sets state: `nextAction: 'awaiting_approval'`, stores plan in state
- On resume (after approval), route directly to `generate` with existing plan
- Add `interruptBefore: ["approval_gate"]` to compile options when `!autoApprove`

**Subtask 5 — Agent Executor Approval Handling** (`agent-executor.ts`)
- After graph stream completes, check for `awaiting_approval` state (similar to existing `awaiting_input` check)
- When detected: update DynamoDB status to `awaiting_approval`, call `postApprovalRequestToSlack()`
- New `resumeApprovedRun()` function that:
  - Loads the checkpointed graph state
  - Sends approval signal via `graph.updateState()` or re-invokes with approval context
  - Resumes streaming from checkpoint

**Subtask 6 — Slack Interactivity Endpoint** (`app/api/v1/trigger/slack/interactions/route.ts`)
- New `POST /api/v1/trigger/slack/interactions` route
- Handles Slack `block_actions` payload (button clicks)
- Validates Slack signature (reuse existing `verifySlackSignature`)
- Parses `action_id` (approve/reject) and `value` (runId|tenantId)
- On approve: call `resumeApprovedRun()`, post "✅ Approved! Executing..." to thread
- On reject: update run status to `cancelled`, post "❌ Rejected" to thread
- Returns 200 immediately (Slack requires < 3s response)

**Subtask 7 — Agent Ops Service Updates** (`agent-ops-service.ts`)
- Add `updateRunApproval()` method
- Add `findAwaitingApprovalRun()` method for lookup by runId

---

### Files to Create
- `web-ui/app/api/v1/trigger/slack/interactions/route.ts` — Slack interactivity webhook

### Files to Modify
- `web-ui/lib/agent-ops/types.ts` — new status, interfaces
- `web-ui/lib/agent-ops/executor-state.ts` — approval state field
- `web-ui/lib/agent-ops/models/agent-ops-run.ts` — schema update
- `web-ui/lib/agent-ops/slack-notifier.ts` — Block Kit approval message
- `web-ui/lib/agent-ops/executor-graphs.ts` — approval_gate node + routing
- `web-ui/lib/agent-ops/agent-executor.ts` — approval detection + resume
- `web-ui/lib/agent-ops/agent-ops-service.ts` — approval CRUD methods

### Files to Delete
- None

---

### Parallelizable
Yes — Subtasks 1-2 (types/model) and Subtask 3 (Block Kit notifier) are independent and can run concurrently. Subtasks 4-7 depend on 1-2.

### Approach
The key insight is that LangGraph's `DynamoDBSaver` checkpointer already persists full graph state. When `autoApprove=false`, the graph already interrupts before `tools`. We extend this by:
1. Adding an `approval_gate` node that interrupts after the planner produces a plan
2. Posting the plan as a Block Kit message with Approve/Reject buttons
3. When the user clicks Approve, the Slack interactivity webhook resumes the graph from its checkpoint
4. The graph continues from where it left off (no re-execution)

This is a "checkpoint-resume" pattern, not a "re-run" pattern. The graph state (plan, messages, evaluation) is fully preserved in DynamoDB.

### Key Decisions
- **Approval gate as a separate node** (not inline in planner) — cleaner separation of concerns, easier to test, and allows the planner to complete fully before the interrupt
- **Block Kit buttons over thread replies** — more reliable UX, prevents accidental approvals, and Slack's interactivity API provides structured payloads
- **`awaiting_approval` as distinct status** — separates "I need more info" (clarification) from "I have a plan, approve it" (approval gate)
- **Reuse existing `verifySlackSignature`** — same HMAC validation for the interactivity endpoint
- **Resume via `graph.invoke()` with checkpoint** — LangGraph's `getState()` + re-invoke pattern resumes from the exact interrupt point

### Risks / Side Effects
- **Slack 3-second timeout**: The interactivity endpoint must respond within 3 seconds. The actual resume is fire-and-forget (same pattern as current trigger)
- **Stale approvals**: If a run times out or is cancelled before the user clicks Approve, the interactivity handler must check current status before resuming
- **Slack app configuration**: The Slack app must have Interactivity enabled with the Request URL pointing to `/api/v1/trigger/slack/interactions`
- **Existing `autoApprove=true` flows unaffected**: The approval gate only activates when `autoApprove=false` AND `requiresApproval=true`

### Assumptions
- Slack app already has a Bot Token (`xoxb-...`) configured in `TenantConfigService` under `agent-ops-slack`
- The Slack app's Interactivity Request URL will be configured to point to the new endpoint
- `autoApprove` defaults to `true` (current behavior), so this is opt-in per run or per Slack command flag

---

### Architecture Flow (End-to-End)

```
#ops-channel
┌─ User: /cloud-ops deploy staging with tag v2.3.1
│
│   [1] POST /api/v1/trigger/slack
│       → HMAC verify → create run (status: queued)
│       → executeAgentRun() fire-and-forget
│       → Return 200 + "🚀 Agent Ops Started"
│
│   [2] LangGraph: evaluator → mode=plan, requiresApproval=true
│       → planner → generates 3-step plan
│       → approval_gate → sets nextAction='awaiting_approval'
│       → graph INTERRUPTS (checkpoint saved to DynamoDB)
│
│   [3] agent-executor detects awaiting_approval
│       → DynamoDB: status='awaiting_approval', approvalRequest={plan, tools}
│       → postApprovalRequestToSlack() → Block Kit message:
│
│   └─ 🤖 Bot: Here's my plan:
│              1. Pull image tag v2.3.1
│              2. Update ECS task definition  
│              3. Trigger rolling deploy
│              [✅ Approve]  [❌ Reject]     ← Block Kit buttons
│
│   [4] User clicks ✅ Approve
│       → POST /api/v1/trigger/slack/interactions
│       → Parse action_id=agent_ops_approve, value=runId|tenantId
│       → Verify run status is still awaiting_approval
│       → Post "✅ Approved! Executing..." to thread
│       → resumeApprovedRun() fire-and-forget:
│           → Load checkpoint from DynamoDB
│           → graph.invoke(null, {configurable: {thread_id}})
│           → Graph resumes from approval_gate → generate → tools → reflect → final
│       → Return 200 immediately
│
│   [5] Graph completes
│       → DynamoDB: status='completed', result={summary, toolsUsed}
│       → postResultToSlack() → thread reply:
│
│   └─ 🤖 Bot: 🎉 Done! Deployment complete. Service healthy.
│              • ECS task def updated: arn:aws:ecs:...
│              • Rolling deploy: 3/3 tasks healthy
│              • Duration: 47s
```

---

→ Awaiting your approval to proceed. Any changes before I start?