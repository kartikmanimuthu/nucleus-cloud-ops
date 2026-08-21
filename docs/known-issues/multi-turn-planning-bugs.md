# Multi-Turn Planning — Bugs, Fixes, and Open Issues

Investigation of the AI Ops planning agent (`apps/web-ui/lib/agent/planning-agent.ts`)
prompted by the report: *"multi-turn works, but on the second and later messages the
planner plans as if it has no history — even though the answers clearly use history."*

That report was accurate. The investigation confirmed it and surfaced several
adjacent defects. This document records all of them: what is fixed, what is still
open, and how each was verified.

**Branch:** `fix/multi-turn-planning`

---

## Summary

| # | Issue | Severity | Status |
|---|---|---|---|
| 1 | Planner received no conversation history | High | **Fixed** |
| 2 | Plan-parsing regex discarded valid plans | High | **Fixed** |
| 3 | Iteration budget leaked across turns | Medium | **Fixed** |
| 4 | `finalNode` fabricated values that contradicted tool output | High | **Fixed** |
| 5 | Stale AWS profile reused across turns | Medium | Open |
| 6 | Planner role-plays a fake run, shown to the user as "Thinking" | Medium | Open |
| 7 | `taskDescription` is turn-scoped | Low | Open (deliberate) |
| 8 | Tenant `maxIterations` setting silently capped at 30 | Low | Open |
| 9 | Context bloat / token cost on tool-heavy turns | Low | Open |
| 10 | Pre-existing: `mcp-config` test failure, `tsc` error, no Bedrock `sessionToken` | Low | Open |

Only **#6** is model-dependent. Everything else is a code defect that reproduces
regardless of model or provider.

---

## Fixed

### 1. Planner received no conversation history

**Symptom.** On turn 2+, the plan ignored the conversation. A follow-up like
*"now do the same for apps/workers"* produced a plan for something entirely
different, while the final answer read as history-aware.

**Root cause.** `planNode` invoked the model with exactly two messages — its system
prompt and the newest user message:

```ts
const lastMessage = messages[messages.length - 1];
const _auditInputs_plan = [plannerSystemPrompt, lastMessage];
response = await model.invoke(_auditInputs_plan) as AIMessage;
```

The history was present in state the whole time (`messages` reducer concatenates,
capped at 100 — `agent-shared.ts:113-121`), and the executor and reviser both read a
windowed view of it via `prepareContext(...)`. Only the planner was excluded.

**Evidence.** Instrumented the real compiled graph over two turns on one thread:

```
turn 2  PLANNER   inputs = 2   [system, "now do the same for prod"]
turn 2  EXECUTOR  inputs = 10, 12, 14   (full history, both turns)
turn 2  REVISER   inputs = 18, 22
```

Live against Bedrock, before the fix:

```
turn 1  "Read apps/web-ui/package.json and report the pinned next/react versions"
        -> 1. Read apps/web-ui/package.json
           2. Extract and report the pinned versions

turn 2  "now do the same for apps/workers"
        -> 1. Call list_aws_accounts to identify the target account
           2. Call get_aws_credentials for the matched account ID
           3. Describe all ECS clusters, services, tasks; list Auto Scaling groups
              and EC2 instances tagged 'worker'; query Lambda; check EKS clusters
           4. Query CloudWatch metrics (CPU, memory, network) over 7 days
           5. Compose a complete inventory and performance summary
```

It read "workers" as AWS worker infrastructure, because it had no idea the previous
turn was about reading a `package.json`.

**Fix.** `buildConversationDigest()` (`planning-agent.ts:107`) renders prior turns as
**plain text** in the planner's system prompt: previous user requests, previous
delivered answers, and the previous plan with per-step statuses. Two follow-up rules
are appended, but only when a digest exists (so first-turn behaviour is byte-identical
to before).

**Why plain text and not the message window.** The planner runs on `model`, which has
no tools bound. Bedrock Converse rejects any request whose messages carry
`toolUse`/`toolResult` blocks without a `toolConfig`, and
`sanitizeMessagesForBedrock` deliberately *preserves* those blocks
(`agent-shared.ts:725-819`). Verified live:

```
unbound model + messages containing tool blocks  -> ValidationException:
   "The toolConfig field must be defined when using toolUse and
    toolResult content blocks."
same messages, tools bound (control)             -> OK
unbound model + plain-text history only          -> OK
```

Worse, `planNode` swallows its own invoke errors and falls back to a one-step plan
(`planning-agent.ts:~455`), so the naive fix would have silently degraded every
follow-up turn with nothing but a server log line to show it.

**Verified after fix.** Live, twice, fresh threads:

```
turn 2  "now do the same for apps/workers"
        -> 1. Read the file apps/workers/package.json
           2. Extract and report the pinned versions of 'next' and 'react'
```

And in the real UI, `"and what about ecs in the same region?"` correctly resolved
`us-east-1` and produced the right ECS report — even though memory offered *both*
`us-east-1` and `ap-south-1`, so memory alone could not have disambiguated it.

---

### 2. Plan-parsing regex discarded valid plans

**Symptom.** Production log:

```
[Planner] Plan parsing failed: SyntaxError: Unexpected non-whitespace
character after JSON at position 555 (line 3 column 1)
📋 [PLANNER] Plan Generated:
1. Analyze and respond to user request        <- degenerate fallback
```

**Root cause.** The plan was extracted with a greedy regex running from the first `[`
to the **last** `]` anywhere in the response:

```ts
const jsonMatch = content.match(/\[[\s\S]*\]/);
```

The model had emitted a perfectly valid 5-step array, then ignored *"only return the
JSON array"* and role-played the entire execution — prose, fake `<function_calls>`
blocks, invented results, all of it full of `Reservations[].Instances[]` and
`Tags[?Key=='Name']|[0]`. The regex swallowed the lot, `JSON.parse` died at position
555 (exactly where the real array closed), and a valid plan sitting at offset 0 was
thrown away.

`parseReflectorResponse` in the same file already used a balanced-brace scan for `{}`
for precisely this reason. The planner never got the same treatment.

**Fix.** `parsePlanResponse()` (`planning-agent.ts:165`) walks each `[` in turn:
string-aware balanced-bracket scan, attempt parse, and on failure advance to the next
candidate. Falls back only when nothing in the response yields a usable array of
strings.

**Verified.** Fed the parser the **actual 6,468-byte production planner response**
extracted from the chat export — the one the old code reduced to a one-liner — and it
recovers all five real steps verbatim. Shape matrix (13 cases in
`planner-multi-turn.test.ts`):

```
PARSED   | plain array
PARSED   | array + trailing prose            <- the production failure
PARSED   | markdown ```json fence
PARSED   | prose before, array after
PARSED   | bracketed aside first:  Plan (steps [1-5]): ["a","b"]
PARSED   | unterminated bracket first:  [oops never closes ["a","b"]
PARSED   | empty array first:  [] ["a","b"]
PARSED   | object aside first:  {"note":"skip"} Plan: ["a","b"]
PARSED   | brackets inside step strings ("Reservations[].Instances[]")
PARSED   | escaped quotes in step text
PARSED   | plan wrapped in an object  {"plan":[...]}
FALLBACK | empty string / unterminated array / array of non-strings
```

Worst-case cost on a deliberately adversarial input (4,000 unterminated bracket
candidates in 11.7KB): 56ms — negligible beside the 2–30s LLM call in the same node.

**Note on the trigger.** The broken code affected every model; whether a given model
trips it varies. Observed on `sonnet-4-6` in 1 of 4 planner calls — intermittent, not
deterministic. `sonnet-4-5` and `sonnet-5` never tripped it in testing. The fix is in
code precisely so the next model swap doesn't reintroduce the failure.

---

### 3. Iteration budget leaked across turns

**Symptom.**

```
turn 1 ends:   🤔 [REFLECTOR] Iteration: 6/30
turn 2 opens:  ⚡ [EXECUTOR]  Iteration 7/30
```

`iterationCount` never reset. Turn 3 would open near 10, and a few turns into a thread
every new request would start at the cap and be forced straight to reflection.

**Fix.** `planNode` now returns `iterationCount: 0` (`planning-agent.ts:513`). The
iteration cap is a per-**request** budget. `planNode` runs once per new request — an
approval-gate resume re-enters at the gate, not the planner — so an in-flight approval
keeps its budget.

**Verified.** Unit test asserts the post-turn-2 count never exceeds turn 2's own
executor/reviser call count. Confirmed in the real UI after the fix:

```
turn 1 ends:   REFLECTOR Iteration: 4/30
turn 2 opens:  EXECUTOR  Iteration 1/30
```

---

### 4. `finalNode` fabricated values that contradicted tool output

**Symptom.** The user-facing answer states numbers that contradict the tool output and
the agent's own in-chat message.

| | value |
|---|---|
| Ground truth in file | `next: 15.5.15`, `react: ^19` |
| Tool output (correct, in state) | the real `package.json` |
| Executor's own in-chat message | `next: 15.5.15`, `react: ^19` ✓ |
| **Final answer shown to user** | **`next: 15.0.3`, `react: 19.0.0`** ✗ |

Reproduced twice with **different** wrong values (`14.2.5 / 18.3.1`, then
`15.0.3 / 19.0.0`) — non-deterministic fabrication, not a stuck constant.

**Root cause — two compounding code defects, not model misbehaviour:**

1. Tool output is truncated to 1,000 chars when collected
   (`planning-agent.ts:680`), then to **500 chars again** in `finalNode`
   (`planning-agent.ts:1012`). The 500-char cut lands mid-`scripts`, so the
   `dependencies` block never reaches the model. It is answering blind.
2. The correct answer already existed in the conversation, but at ~60 chars it fell
   under the 800-char promotion threshold in `findRenderedDeliverable`
   (`agent-shared.ts:521`), so it was discarded in favour of re-synthesis.

Any model would be guessing here. Whether it guesses or admits ignorance is the
model's part; the missing data is ours.

**Does not fire when** the deliverable clears 800 chars — `finalNode` then logs
`Promoting already-rendered deliverable verbatim (no LLM call)` and there is no
fabrication surface. Both turns of the post-fix UI run took that path, and all 11 CPU
figures in the report matched the raw CloudWatch output exactly.

**Fix — three parts.**

1. **Identify the deliverable instead of measuring it.** `isDeliverableTurn()`
   (`planning-agent.ts`) returns true when an executor turn calls no tools and leaves no
   plan step open — either it consumed the last step, or the plan was already exhausted.
   `generateNode` marks that message via `tagMessageAsDeliverable()`, and
   `findRenderedDeliverable` promotes a marked message regardless of length. The `>= 800`
   rule stays as a fallback for reviser turns (which carry no marker) and for threads
   checkpointed before marking existed; whichever qualifying message comes last wins, so
   a later revision still supersedes an earlier answer.

   **The "already exhausted" case is the common one, not an edge case.** The tools node
   completes each `in_progress` step, so two tool turns finish a 2-step plan and the
   compose prose then arrives with nothing open. A first implementation required
   `openIdx >= 0` and therefore never fired in live runs — caught only because the live
   check measured whether marking actually engaged, not just whether the answer was right.

2. **Stop starving the synthesis path.** `buildToolDigest()` replaces
   `toolResults.slice(-3)` + `truncateOutput(…, 500)`. Entries are already capped at 10
   by the reducer and 1,000 chars at collection, so the full set is ≤10KB — there was
   never a reason to show 1.5KB of it. The second truncation was what removed the
   `dependencies` block.

3. **Grounding rule fails safe.** Requires an explicit "not captured" statement rather
   than a redirection the model can rationalise past.

**Verified.** 14 unit tests (`final-deliverable.test.ts`) — including a graph test that
reproduces the fabrication deterministically. Live against Bedrock, **9 runs of the exact
scenario that produced `15.0.3 / 19.0.0`: 9/9 correct.** Five promoted verbatim with no
LLM call at all; four went through synthesis and were correct because the data was no
longer truncated away.

One calibration note: `MIN_MARKED_DELIVERABLE` guards against promoting a stub like
`"Done."`. It is set to **20**, not 40 — a live run produced a correct answer of exactly
38 chars that a floor of 40 rejected. The asymmetry justifies biasing low: promoting a
stub is visibly wrong, whereas rejecting a real answer falls back into the fabrication
path.

**Follow-up: the early-exit gap.** The first version of Part 1 only marked a turn when
no plan step was left open, which missed a second route to the same failure.
`shouldContinueFromGenerate` sends a no-tool turn straight to `final` when it sees
`iterationCount <= 1`, so an over-planned conversational follow-up ("say that again")
ends the run on move one with steps 2..n still pending — unmarked, and re-synthesized.
Proven with a stub run: the executor produced the answer and the user was shown
`SYNTHESIZED_BY_FINAL_NODE`. `isDeliverableTurn` now also returns true when
`iterationCount === 0` on a no-tool turn, which is exactly the condition under which
that edge ends the run. Note this case was never *worse* than before the fix — it took
the synthesis path either way, but now with untruncated data.

**Residual risk.** Parts 2 and 3 reduce but cannot eliminate fabrication — a model with
complete data can still invent. Part 1 is the part that removes the failure mode for
composed answers by never reaching synthesis. Synthesis still runs when no compose turn
exists at all (forced completion, max iterations, reflector error), and there it remains
model-trust-dependent.

---

## Open

### 5. Stale AWS profile reused across turns

**Symptom.** Turn 2, iteration 1 — the planner's step 1 was *"Get AWS credentials"*,
but the executor skipped it and ran `describe-instances` with the profile name from
**turn 1**:

```
--profile nucleus_agent_970547372609_1786345920124_3f03635f
aws: [ERROR]: The config profile (…_1786345920124_3f03635f) could not be found
```

Both regional calls failed. It self-corrected — called `get_aws_credentials` on
iteration 2, re-ran successfully on iteration 3 — at a cost of one wasted iteration and
two failed AWS calls.

**Root cause.** Two things combine:

1. The old profile name persists in the conversation as a turn-1 tool result. The
   executor reads its message window, sees a profile name, and reuses it.
2. `cleanupAllAgentProfiles()` is a **module-load side effect**
   (`session-manager.ts:329`) and deletes the entire per-tenant credentials root
   (`session-manager.ts:250`). In dev, every hot recompile of a route importing
   `session-manager` re-runs it, so the profile is gone mid-thread.

In production the module loads once per process, so the profile survives until its
15-minute expiry — a fast follow-up would succeed and a slower one would fail with an
expired-token error instead. Either way, carrying a profile name across turns is not
safe.

**Not caused by the fixes above** — the executor has always seen prior-turn tool
results, and nothing in this branch touches its prompt. The issue is simply more
visible now that multi-turn planning works.

**Recommended fix (preferred: structural).** Have `execute_command` detect
`could not be found` / expired-token on a `--profile` call and transparently
re-acquire; or stop the startup cleanup from wiping profiles that are still valid. A
prompt instruction ("profile names are per-run") would also help but depends on model
compliance.

---

### 6. Planner role-plays a fake run, shown to the user as "Thinking" — model-dependent

**Symptom.** The planner emits its array and then writes out an entire fake execution:
prose, `<function_calls>` blocks, invented tool results (*"Good — credentials
verified"*). The UI streams planner tokens as **"Thinking"**, so the user is shown
commands that never ran and results that were never obtained. Cost when it fires:
~2,400 wasted output tokens.

**Status.** Issue #2 means the *plan* now survives this, but the misleading display
does not.

**Frequency.** Intermittent on `sonnet-4-6` — 1 of 4 observed planner calls. Not
observed on `sonnet-4-5` or `sonnet-5` (2 clean runs each, complete responses were the
bare array and nothing else).

```
sonnet-4-6  turn 1  out = 2,479 tokens   <- role-played the whole run
sonnet-4-6  other 3 calls                 clean
sonnet-5    2 runs, 161 and 165 chars     bare array only
```

**Recommended fix.** Either move to a model that doesn't do it, or stop streaming
planner tokens to the UI as "Thinking" (the planner's raw output is internal — its
only consumer is `parsePlanResponse`). A prompt guard is the third option, but it
could not be verified here: this SSO role has an explicit IAM deny on
`anthropic.claude-sonnet-4-6`, so the misbehaving model is not drivable from the test
harness.

---

### 7. `taskDescription` is turn-scoped — investigated, NOT worth fixing

`taskDescription` is set from the newest message alone (`planning-agent.ts:458`), so on
a follow-up like *"can you do the similar analysis ec2 intances as well?"* that fragment
becomes the task-of-record. It has **four** consumers, not two:

```
taskDescription
├─ reflector     "Original Task: …"      (planning-agent.ts:775)
├─ finalNode     "User's request: …"     (planning-agent.ts:1050)
├─ memory save   "**Original Task:** …"  (memory-nodes.ts:232)     persists
└─ episode       "**Task:** …"           (memory/episode.ts:71)    persists
```

An earlier revision of this document rated it Low on the strength of the first two, then
raised it to Medium on the assumption that the two persisting consumers were writing
fragments into long-term memory. **Both assessments were wrong, and the evidence is
direct.** Querying `agent_memories` for the episodes saved from the two real multi-turn
threads:

```
thread 1786345769097  (turn 2: "can you do the similar analysis ec2 intances as well?")
  context: "User requested EC2 instance health and performance analysis across
            ap-south-1 and us-east-1 ... similar to a previously performed
            analysis on another service."

thread 1786343725502  (turn 2: "and what about ecs in the same region?")
  context: "User asked about ECS health in us-east-1 ... following a prior EC2
            health check in the same region."
```

Accurate and self-contained, both capturing the cross-turn relationship. The reason is
that neither persisting consumer relies on the fragment: the episode distiller also
receives the **resolved plan with statuses**, 4,000 chars of tool executions, the errors
and the reflection; the memory-save node also receives the **last 20 messages** (8,000
chars) plus existing memory. The fragment is a weak signal among strong ones. The
reflector likewise receives the resolved plan, and judged both real multi-turn threads
correctly.

Only `finalNode` sees the fragment with nothing to compensate — and after issue #4 that
path runs far less often.

**Decision: leave it.** Fixing it means editing four prompts, including the reflector,
where carried-over context risks being read as current scope (it would start flagging
the previous turn's work as unfinished). Four prompt changes and a real regression risk
for no measured benefit is a bad trade.

---

### 8. Tenant `maxIterations` setting silently capped at 30

`reflectNode` respects the tenant-resolved value, but all four conditional edges use
the hardcoded `MAX_ITERATIONS`:

```
planning-agent.ts:875   if (iterationCount >= maxIterations …)      <- tenant value
planning-agent.ts:1074  if (iterationCount >= MAX_ITERATIONS)       <- hardcoded 30
planning-agent.ts:1105  if (iterationCount >= MAX_ITERATIONS)
planning-agent.ts:1118  if (iterationCount >= MAX_ITERATIONS)
planning-agent.ts:1131  if (isComplete || iterationCount >= MAX_ITERATIONS)
```

A tenant raising the limit above 30 is ignored. Line 876 also logs
`MAX_ITERATIONS` while comparing against `maxIterations`, so the message lies when the
two differ.

---

### 9. Context bloat / token cost on tool-heavy turns

One observed turn consumed `in=463,715` tokens across 4 executor calls, feeding a
108KB `describe-services` payload back repeatedly. Correctness is unaffected; this is
latency and spend. Later runs with smaller payloads were healthy (`in=58,752` and
`in=115,308`), so the trigger is large tool outputs rather than multi-turn itself.

---

### 10. Pre-existing, unrelated to this branch

- **`mcp-config.test.ts`** — `mergeConfigs` drops the `aws-documentation` default when
  a remote user entry is overlaid. Confirmed failing with this branch's changes
  stashed.
- **`tsc`** — one error in `planning-agent.ts` on the
  `workflow.compile({ checkpointer, store })` typing. Same error count before and
  after this branch's changes.
- **Bedrock provider config has no `sessionToken`** — `ResolvedModelConfig`
  (`agent-shared.ts:28-29`) carries `accessKeyId`/`secretAccessKey` only, so SSO
  temporary credentials cannot drive the Bedrock provider path; only long-lived keys
  work.

---

## Model / provider dependence

Useful when planning a model migration:

| Issue | Model-dependent? |
|---|---|
| 1 Planner history | No — the code passed exactly two messages |
| 2 Plan parsing | Bug: no. **Trigger: yes** — only chatty models trip it |
| 3 Iteration budget | No — pure state bug |
| 4 `finalNode` fabrication | Mostly no — the code truncated the data away first |
| 5 Stale AWS profile | No |
| 6 Planner role-play | **Yes — the only one** |
| 7 `taskDescription` | No |
| 8 `maxIterations` cap | No |
| 9 Context bloat | No (tokenizer changes the magnitude, not the cause) |

Two constraints are genuinely **provider**-specific, and neither is an app bug: the
Bedrock Converse `toolConfig` rule (which dictated the plain-text digest in fix #1),
and the missing `sessionToken` on the Bedrock provider path (#10).

---

## Verification

- `apps/web-ui/lib/agent/__tests__/final-deliverable.test.ts` — 16 tests: the
  deliverable-turn rule, the promotion floor, the tool digest, and a graph test that
  reproduces the fabrication deterministically.
- `apps/web-ui/lib/agent/__tests__/planner-multi-turn.test.ts` — 9 tests: digest
  present on turn 2 and absent on turn 1, plan survives a planner overrun, per-turn
  iteration budget, and the 13-case parser shape matrix.
- Suite: 554 passed, 1 failed (`mcp-config.test.ts`, pre-existing — verified failing
  with this branch stashed).
- `tsc`: 3 errors across `planning-agent.ts` / `agent-shared.ts`, identical to baseline
  with this branch's changes stashed (two are a pre-existing `MCPConfigJson` typing issue,
  one the `workflow.compile` store/checkpointer typing).
- Live: two two-turn runs on `sonnet-4-5`, two on `sonnet-5`, nine single-turn grounding
  runs on `sonnet-4-5` for issue #4, plus two real UI threads on `sonnet-4-6`.

### Reproducing the live checks

```bash
cd apps/web-ui && bun run test          # unit + integration
LLM_AUDIT=full bun run dev              # dumps every node's exact input messages
```

`LLM_AUDIT=full` (`agent-shared.ts:302-307`) is the fastest way to confirm what the
planner actually receives on a given turn.
