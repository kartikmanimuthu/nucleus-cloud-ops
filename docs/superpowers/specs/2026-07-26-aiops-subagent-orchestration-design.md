# AIOps Sub-Agent Orchestration — Design

**Date:** 2026-07-26
**Status:** Approved for planning
**Surface:** Interactive chat (`planning-agent.ts`) first; Agent Ops reuses the runtime later.

## Problem

AI Ops chat runs take ~10 minutes. `planning-agent.ts` is a strictly serial state machine:

```
memory_recall → planner → (generate → guard → tools → generate)* → reflect → revise* → final → memory_save
```

Every lap costs one streaming LLM call plus one tool execution, and the message history grows
monotonically, so late laps are markedly slower than early ones. With `MAX_ITERATIONS = 30` a
seven-step plan realistically burns 15–25 laps.

Four workload shapes contribute, confirmed with the user:

1. Wide fan-out (many accounts × regions × services)
2. Deep sequential investigation
3. Slow individual AWS calls
4. Long final-report generation

No single lever fixes all four. This design ships two complementary layers and explicitly defers a
third.

## Root causes identified in the current code

### Serialization is prompt-enforced, not structural

`planning-agent.ts:404` instructs the executor:

> "Execute exactly the current step — do not skip ahead or bundle future steps into a single call."

LangGraph's `ToolNode` already executes multiple `tool_calls` from one AI message concurrently. The
prompt suppresses that free parallelism, converting an N-way independent sweep into N serial laps
whose only purpose is emitting the next single command. `planning-agent.ts:292` compounds this by
telling the planner to merge related read-only queries into one *step*, while the executor prompt
then forbids merging them into one *turn*.

### Context bloat

Raw tool outputs accumulate in the orchestrator's message list. `prepareContext` compacts, but
compaction itself costs an extra LLM call and loses fidelity.

### Concurrency is currently unsafe (blocker)

`session-manager.ts:159-172` performs an unlocked read-modify-write on a shared per-tenant
credentials file:

```
Agent 1: read  → {profileA}
Agent 2: read  → {profileA}
Agent 1: write → {profileA, profileB}
Agent 2: write → {profileA, profileC}   ← profileB silently lost
```

The agent holding the lost profile then fails with "The config profile could not be found". This is
latent today because nothing runs concurrently; it becomes a routine failure the moment
`get_aws_credentials` is parallelized (which every multi-account fan-out does).

Additionally `assumeRoleForAccount` (`aws-credentials-tool.ts:44`) uses `DurationSeconds: 900`.
Credentials acquired at minute 0 expire at minute 15 — long runs already risk this, and fan-out
makes long runs more likely.

### CloudFront caps silent periods at 60s

`infra/compute/index.ts:962` sets `originReadTimeout: 60` while the ALB is at `idleTimeout: 1200`
(`infra/compute/index.ts:788`). A 10-minute run survives today only because streamed tokens
continuously reset the 60s timer. A fan-out phase where sub-agents think silently for 90s will drop
the connection. Progress heartbeats are therefore a correctness requirement, not a UX nicety.

## Approaches considered

### A. Intra-turn tool parallelism (no sub-agents) — **adopted**

Remove the anti-batching prompt rules; let one AI turn emit N `tool_calls`; add a bounded semaphore
around `ToolNode`.

- Cost is *negative* — fewer LLM laps means cheaper and faster.
- HIL survives untouched: `pendingToolCallsOf` (`guard.ts:16`), the guard's batched risk assessment
  (`guard.ts:105`), and `approval-batch-card.tsx` already handle multi-call turns.
- Does not address context bloat, deep investigation, or report generation.

### B. Sub-agent as a tool — the Claude Code `Task` pattern — **adopted**

A `dispatch_agent` tool. The orchestrator emits several in one turn; `ToolNode` runs them
concurrently; each spawns a lean read-only ReAct loop with its own context, returning one compressed
findings report instead of dozens of raw tool outputs.

- The primary win is **context isolation**, not only parallelism. Keeping the orchestrator's history
  small is what also helps the deep-sequential and report-generation cases.
- Minimal graph surgery — it is a tool, not a topology change.
- Cost: 3–8× tokens on fan-out tasks, which the budget governor bounds.

### C. LangGraph `Send` map-reduce supervisor — **rejected**

Planner marks steps parallelizable; a fan-out node emits `Send()` to N executor branches; a reduce
node merges.

- Only approach in which sub-agents could safely mutate, since each branch is independently
  interruptible.
- But `ReflectionState`/`graphState` has no reducers for concurrent writes to `messages`, `plan`, or
  `toolResults`; streaming attribution via `langgraph_node` breaks with N identical branches; and
  `iterationCount` becomes meaningless. This is a rewrite of the state layer.
- Rejected because every real fan-out workload in the product (audits, inventories, right-sizing
  sweeps, security reviews) is read-only. Parallel mutation is a problem we do not have.

**Decision: ship A and B together.** A alone leaves context bloat; B alone still serializes inside
each sub-agent.

## Architecture

```
Orchestrator (planning-agent — topology unchanged)
  memory_recall → planner → generate ⇄ guard ⇄ tools → reflect ⇄ revise → final
                                          │
                                          ├── execute_command      (parallel — Layer A)
                                          ├── execute_command      (parallel — Layer A)
                                          └── dispatch_agent ──────────────┐  (Layer B)
                                                                           │
                                    ┌──────────────────────────────────────┘
                                    ▼  (ephemeral, non-checkpointed, read-only)
                            Sub-agent ReAct loop
                            generate → tools → generate   (≤ 8 laps)
                                    ▼
                            compressed findings report (~1500 tokens)
```

### Why one sub-agent per tool call

`dispatch_agent` takes a single sub-agent spec, not an array. The orchestrator emits N calls in one
turn and `ToolNode`'s existing parallelism *is* the fan-out. This avoids a second concurrency
mechanism and gives each sub-agent its own tool card in the UI for free.

### Why a plain loop, not a compiled sub-graph

Sub-agents are ephemeral and non-resumable. A checkpointer would add a Postgres write per lap for no
benefit. The sub-agent is a plain `while` loop over `model.invoke` + tool execution.

## Components

### 1. `session-manager` concurrency fix (prerequisite)

**File:** `apps/web-ui/lib/agent/session-manager.ts`

- Per-tenant async mutex serializing the read-modify-write in `createSessionProfile`.
- Atomic write: write to a temp file in the same directory, then `fs.rename`.
- Mutex map keyed by resolved credentials-file path, so the legacy shared-file path is covered too.
- Lazy credential refresh: `get_aws_credentials` re-assumes the role when the cached profile is
  within 120 s of its `expiresAt` rather than handing back a profile that will expire mid-command.
  Pre-existing weakness (`DurationSeconds: 900` vs. 10-minute runs), but fan-out makes long runs more
  likely, so it lands here.

### 2. Layer A — parallel tool calls

**Files:** `apps/web-ui/lib/agent/planning-agent.ts`, `apps/web-ui/lib/agent/fast-agent.ts`

- Replace the executor's "do not bundle" rule with explicit guidance to batch **independent
  read-only** calls into one turn, while keeping dependent calls sequential and keeping mutations one
  at a time.
- Reviser prompt gets the same treatment.
- Wrap `ToolNode` invocation in a bounded semaphore (`TOOL_CONCURRENCY`, default 6) so a 45-call turn
  does not open 45 simultaneous AWS CLI subprocesses.

The guard, approval routing, and the batch approval card need no changes.

### 3. Layer B — `dispatch_agent`

**New file:** `apps/web-ui/lib/agent/subagent.ts`

Tool contract:

```ts
dispatch_agent({
  role: string,           // "EC2 inventory auditor for account 1234"
  task: string,           // full standalone brief — the sub-agent sees NO parent history
  expectedOutput: string  // "instance IDs with CPU <5% over 14d, with evidence"
}) → string               // structured findings report, hard-capped (see SUBAGENT_REPORT_MAX_CHARS)
```

The report cap is enforced in characters, not tokens, so it is deterministic and testable:
`SUBAGENT_REPORT_MAX_CHARS = 6000` (≈1500 tokens). Over-length reports are truncated with an
explicit `[TRUNCATED — report exceeded cap]` marker, reusing `truncateOutput` from `agent-shared.ts`.

The tool description explicitly requires `task` to be self-contained. Under-specified sub-agent
briefs are the dominant failure mode reported in Anthropic's multi-agent research: sub-agents
duplicate each other's work or return unusable fragments.

Sub-agent internals:

- Reuses the orchestrator's `createAgentModels(modelConfig)` instances — they are stateless per
  invoke, so no new model construction per sub-agent.
- Own message list seeded only with its system prompt and `task`.
- Read-only tool subset (see §4).
- `SUBAGENT_MAX_ITERATIONS = 8`, `SUBAGENT_TIMEOUT_MS = 180_000`.
- Returns a structured report: findings, evidence (resource IDs, metric values), and an explicit
  "could not determine" section, truncated per `SUBAGENT_REPORT_MAX_CHARS`.

### 4. The read-only jail

Two independent layers:

1. **Filtered tool list.** Sub-agents receive read-only tools only. Excluded: `dispatch_agent`
   (depth cap = 1), `ask_user` (no human reachable from inside a tool call), `write_file`,
   `edit_file`, `write_file_to_s3`.
2. **Runtime interception.** Every sub-agent tool call is re-checked through `classifyTool`
   (`tool-classifier.ts`). A mutative or unknown-named tool is refused with: *"You cannot mutate
   state. Report the recommended change in your findings; the orchestrator will execute it under
   human approval."*

Layer 2 matters because MCP tools with unrecognized names hit `classifyTool`'s fail-closed default.
In the orchestrator that default means "ask the human"; inside a sub-agent, where no human is
reachable, it must mean "block".

**Consequence: the existing HIL story is unchanged.** Mutations only ever occur on the single
guarded orchestrator path, so `guard.ts`, `gate-routing.ts`, and `interruptBefore:
["approval_gate"]` need no modification.

### 5. Budget governor

**New file:** `apps/web-ui/lib/agent/subagent-budget.ts`

Run-scoped, in-memory, keyed by `threadId`. A run executes on a single ECS replica, so in-process
state is sufficient; no distributed coordination.

| Control | Default | Env override |
|---|---|---|
| Max concurrent sub-agents | 3 | `SUBAGENT_MAX_CONCURRENCY` |
| Max sub-agents per run | 8 | `SUBAGENT_MAX_PER_RUN` |
| Max sub-agent tokens per run | 400 000 | `SUBAGENT_MAX_TOKENS_PER_RUN` |
| Max iterations per sub-agent | 8 | `SUBAGENT_MAX_ITERATIONS` |
| Sub-agent timeout | 180 s | `SUBAGENT_TIMEOUT_MS` |

- Tokens metered from `usage_metadata` on each sub-agent model response.
- **On exhaustion `dispatch_agent` does not throw.** It returns *"Sub-agent budget exhausted; perform
  this work yourself, serially."* The run degrades to current behaviour rather than failing.
- Bedrock `ThrottlingException` → exponential backoff retry inside the sub-agent loop. The low
  concurrency cap is the primary defence.
- Budget entries are removed when the run ends, and are bounded by a max-entries LRU so an abandoned
  run cannot leak memory.

The whole of Layer B is gated by `SUBAGENTS_ENABLED` (default off at first deploy), matching the
existing `WORKING_MEMORY_ENABLED` / `EPISODIC_MEMORY_ENABLED` convention. Per-tenant configurability
is deliberately out of scope — bounded defaults were chosen over configurability.

### 6. Streaming, UI, and heartbeat

Sub-agent tokens are **not** streamed into the transcript. Three concurrent token streams interleaved
into one linear chat column are unreadable, and the sub-agent's narration was never the deliverable —
it is the same step-ceremony prose the executor prompt already suppresses.

**New stream part** (`apps/web-ui/app/api/chat/stream-parts.ts`):

```ts
{
  type: 'data-subagent',
  id: `subagent-${subagentId}`,
  data: { id, role, task, status: 'running' | 'done' | 'failed',
          toolCount, tokensIn, tokensOut, summary?: string }
}
```

Plumbing: sub-agent model invocations are tagged via `.withConfig({ metadata: { subagent_id } })`.
`route.ts` already discriminates on `event.metadata?.langgraph_node`; it gains a branch routing any
event carrying `subagent_id` to a `data-subagent` part instead of the transcript. No side channel is
required.

**Heartbeat:** a `data-subagent` tick is emitted every 15 s while any sub-agent is in flight.
Tool-completion events alone are insufficient — a single sub-agent thinking for 90 s would exceed
CloudFront's 60 s `originReadTimeout`.

**Client:** `run-state.ts` gains a `case 'data-subagent'` and a `subagents: Map<string, SubagentState>`
field. New `apps/web-ui/components/agent/chat/subagent-card.tsx` renders collapsed cards:

```
  ⏳ Auditing account 1111 (Prod)      6 tools · 12.4k tokens
  ✅ Auditing account 2222 (Staging)   4 tools ·  8.1k tokens
  ⏳ Auditing account 3333 (Dev)       9 tools · 15.2k tokens
```

### 7. Expandable cards and transcript persistence

Cards expand to show that sub-agent's full transcript after it completes.

Stream data parts are **not** persisted today — chat history is rebuilt from the LangGraph
checkpointer, and `build-chat-transcript.ts` handles only text and tool-invocation parts. Live
in-session expansion therefore works from client state, but expansion after a page reload requires
storage.

The full transcript must **not** be placed in the `dispatch_agent` `ToolMessage` — that message
enters the orchestrator's context and would defeat the entire point of context isolation.

**New Prisma model** (`libs/prisma/schema.prisma`), following the `AgentOpsEvent` TTL pattern:

```prisma
model AgentSubagentRun {
  id         String   @id @default(cuid())
  tenantId   String
  threadId   String
  subagentId String
  role       String
  task       String
  status     String   // running|done|failed
  toolCount  Int      @default(0)
  tokensIn   Int      @default(0)
  tokensOut  Int      @default(0)
  summary    String?
  transcript Json?    // full message list — fetched on demand, never sent to the orchestrator
  createdAt  DateTime @default(now())
  expiresAt  DateTime // 30-day TTL, matching ChatMessage

  @@index([tenantId, threadId, createdAt])
  @@index([expiresAt])
  @@map("agent_subagent_runs")
}
```

Written through the repository pattern (`apps/web-ui/lib/db/repositories/agent/`) using
`getTenantClient(tenantId)`. Fetched on expand via `GET /api/chat/subagents/[threadId]`, guarded by
`authorize('read', 'AIOps')` and scoped to the caller's tenant.

> **Migration note:** per `prisma-migrate-dev-drops-raw-sql-indexes`, audit the generated migration
> SQL for silent `DROP INDEX` statements against the existing HNSW/GIN indexes before applying.

## Error handling

Follows the existing never-crash-the-run convention throughout `planning-agent.ts`:

| Failure | Behaviour |
|---|---|
| Sub-agent model/provider error | Returns an error report string; run continues |
| Sub-agent hits iteration cap | Returns partial findings marked incomplete |
| Sub-agent exceeds timeout | Aborted; returns partial findings marked incomplete |
| One sub-agent fails | Siblings unaffected — each is an independent tool call |
| All sub-agents fail | Orchestrator sees N error reports and may retry serially |
| Budget exhausted | Graceful degradation message, not an error |
| Transcript persistence fails | Logged and swallowed — never blocks the run |

## Testing

**Unit (Vitest, `apps/web-ui`):**

- Budget governor: semaphore bounds concurrency; exhaustion returns the degradation message rather
  than throwing; per-run counters reset.
- Read-only jail: mutative tool rejected; unknown-named tool rejected (fail-closed); read-only tool
  permitted.
- Report truncation at the token cap, with marker.
- Sub-agent timeout returns partial findings.
- `stream-parts`: `data-subagent` part construction.
- `run-state`: `data-subagent` reducer builds and updates the map correctly.

**Concurrency:**

- `createSessionProfile` under `Promise.all` of 10 concurrent writes — all 10 profiles must survive.
  *This test fails against the current implementation and is the regression test for the prerequisite
  fix.*

**Integration:**

- Mocked model emitting three `dispatch_agent` calls in one turn; assert concurrent execution,
  correct merge of the three reports, and that no raw sub-agent tool output entered the orchestrator's
  message list.

**Not covered:** E2E. A multi-minute agent run is too slow and flaky for the Playwright suite.

## Measurement

`llmAuditLog` (`agent-shared.ts:368`) already records per-node latency and token counts but is never
aggregated. A per-run summary line is added — total wall time split by node, LLM time vs tool time,
sub-agent count and token spend — logged at run end.

A baseline is captured **before** Layer A ships, so the contribution of each layer is attributable
rather than assumed.

## Sequencing

| # | Work | Gate |
|---|---|---|
| 0 | `session-manager` mutex + atomic write + concurrency test | Blocker for 2 and 3 |
| 1 | Per-run timing summary from `llmAuditLog` | Baseline before changes |
| 2 | Layer A — parallel tool calls | Measure against baseline |
| 3 | Layer B — `dispatch_agent`, jail, budget governor | Behind `SUBAGENTS_ENABLED` |
| 4 | `data-subagent` streaming, heartbeat, collapsed cards | With 3 |
| 5 | `AgentSubagentRun` persistence + expand-after-reload | With 4 |

## Explicitly out of scope

- **Prompt caching.** Deferred to future work by user decision. Noted here because the executor
  system prompt is large and byte-identical across every lap, and `createAgentModels` sets no cache
  configuration — it is likely the single largest remaining win for the deep-sequential case, where
  parallelism is structurally impossible.
- **Parallel mutations** (approach C). Requires a state-reducer rewrite; no current workload needs it.
- **Recursive sub-agents.** Depth capped at 1, matching Claude Code. Depth 2+ makes cost and latency
  unpredictable and debugging impractical.
- **Agent debate / critic panels.** The reflector already fills the critique role.
- **Shared scratchpad files between sub-agents.** Reintroduces exactly the race condition being fixed
  in step 0.
- **Per-tenant budget configuration UI.** Bounded defaults were chosen over configurability.
- **Agent Ops adoption.** The runtime is written to be surface-agnostic, but wiring it into
  `executor-graphs.ts` is separate work.
- **Raising `DurationSeconds` beyond 900 s.** The refresh-on-near-expiry fix in step 0 covers the
  failure mode without widening the credential lifetime.
