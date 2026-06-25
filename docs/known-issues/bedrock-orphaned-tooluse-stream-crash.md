# Bug: Bedrock `ValidationException` (orphaned `tool_use`) crashes the chat stream

> **Status:** ✅ Fixed (2026-06-25) — `sanitizeMessagesForBedrock` now enforces tool_use/tool_result adjacency. See §8.
> **Severity:** High — terminates an in-flight AI chat response with a 500-style stream error; user loses the answer
> **First observed:** 2026-06-25, ~09:57:54 IST (production)
> **Component:** Web UI AI Ops agent (`fast-agent`), Next.js chat streaming route
> **Environment:** ECS `nucleus-cloud-ops-web-ui-service`, cluster `nucleus-cloud-ops-ecs-cluster`, region **ap-south-1**, account `970547372609`

---

## 1. Symptom

During a long agent conversation, the chat stream aborts and the following appears in
`/ecs/nucleus-cloud-ops-web-ui-service` (CloudWatch):

```
Main stream error: ValidationException: Expected toolResult blocks at messages.0.content
  for the following Ids: tooluse_7eO4Yy8l1uyhSoZiIbAZM9
  at handleError (.next/server/chunks/7181.js:7:21864)
⨯ Error: failed to pipe response
  [cause]: ValidationException: Expected toolResult blocks at messages.0.content
           for the following Ids: tooluse_7eO4Yy8l1uyhSoZiIbAZM9
```

- The error surfaces at `web-ui/app/api/chat/route.ts:671` (`console.error("Main stream error:", error)`),
  which then calls `controller.error(error)` → the AI SDK reports `failed to pipe response`.
- The user's chat response **fails mid/late-stream** instead of completing.
- It was observed at the **end of a ~30-iteration `fast-agent` run** (thread `1782359757948`,
  tenant `cmobralb00005ec8ozxrzie0a`), i.e. a deep, multi-tool investigation conversation.

### What this error means (Bedrock Converse API contract)

The Bedrock Converse API requires that when an `assistant` message contains a `toolUse`
block, the **immediately following** message must contain a matching `toolResult` block for
every `toolUse` id. `messages.0.content` means the message at **index 0** of the array sent
to Bedrock is an assistant `tool_use` message whose id (`tooluse_7eO4Yy8l...`) has **no
matching `toolResult` in the next message**.

This is the exact failure class that `sanitizeMessagesForBedrock()` exists to prevent — but
in this case it did not repair it. See root cause below.

---

## 2. Scope / impact

- **This is the only genuine platform bug** found in the 2026-06-25 log burst. The other
  ~180 error lines in that window were the AI agent's own `execute_command` tool output
  (malformed AWS CLI, `JSONDecodeError`, `ClusterNotFoundException`, `KeyError: 'CurrentRole'`)
  while a user investigated a Redis/Valkey spike in unrelated `stx-pre-trade-*` services.
  Those are cosmetic log noise, not defects.
- ECS/infra was healthy throughout (2/2 tasks, steady state). This is a **logic bug in message
  windowing/sanitization**, not an infrastructure problem.
- Triggers on **long conversations** where history is windowed/truncated, so it is
  intermittent and correlates with conversation depth.

---

## 3. Relevant code paths

| File | Lines | Role |
| --- | --- | --- |
| `web-ui/app/api/chat/route.ts` | ~663–683 | Stream error handler — where the error is logged/propagated |
| `web-ui/lib/agent/fast-agent.ts` | 113–115 | `agentNode`: builds the message array sent to Bedrock |
| `web-ui/lib/agent/agent-shared.ts` | 222–335 | `getRecentMessages()` — windowing + role-formatting |
| `web-ui/lib/agent/agent-shared.ts` | 345–406 | `sanitizeMessagesForBedrock()` — synthetic `tool_result` insertion |

The hot path in `fast-agent.ts`:

```ts
const recentMessages = getRecentMessages(messages, 20);      // window + reformat
const safeMessages   = sanitizeMessagesForBedrock(recentMessages);
const response       = await modelWithTools.invoke([systemPrompt, ...safeMessages]);  // ← throws
```

> Note: the same pattern is used in `planning-agent.ts` (215, 503) and
> `agent-ops/executor-graphs.ts` (296, 501), so the fix likely needs to apply to all of them.
> The `reflectNode` (`fast-agent.ts:246`) is **not** the culprit — it passes string-extracted
> content and is wrapped in try/catch.

---

## 4. Root cause (identified)

Two functions interact badly when the conversation is long enough to be windowed:

### 4a. `getRecentMessages()` can separate an AI `tool_use` from its `tool_result`

After trimming to the window, `getRecentMessages` runs a **role-alternation formatter**
(`agent-shared.ts:306–335`) that inserts synthetic `HumanMessage("Proceed.")` /
`AIMessage("Acknowledged.")` messages between consecutive same-role messages, and a
**"start with first message" pass** (`agent-shared.ts:292–304`) that can `unshift` the
original first message (`firstMsg = validMessages[0]`) to index 0.

The formatter treats a `ToolMessage` as its own role and does **not** guarantee that an AI
`tool_use` message stays immediately adjacent to its `ToolMessage` results. The result array
can therefore end up as:

```
[0] AIMessage   (tool_use id=tooluse_7eO4...)   ← index 0
[1] HumanMessage("Proceed.")                    ← NOT a tool_result
[2] ToolMessage (tool_call_id=tooluse_7eO4...)  ← result exists, but not adjacent
...
```

### 4b. `sanitizeMessagesForBedrock()` does not repair the *non-adjacent* case

`sanitizeMessagesForBedrock` (`agent-shared.ts:345–406`):

1. **Pass 1** collects every `tool_call_id` that has a `ToolMessage` **anywhere** in the array
   into `answeredToolCallIds` (line 348–354).
2. **Pass 2** for each AI message consumes only **consecutive** following `ToolMessage`s
   (line 386–391), then inserts a synthetic placeholder **only if** the id is **not** in
   `answeredToolCallIds` (line 396: `if (answeredToolCallIds.has(id)) continue;`).

So if the matching `ToolMessage` exists but is **not adjacent** (separated by the injected
`"Proceed."` message from 4a), then:

- Pass 1 adds the id to `answeredToolCallIds`.
- Pass 2 finds no consecutive `ToolMessage`, but `answeredToolCallIds.has(id)` is `true`, so it
  **skips** inserting the synthetic placeholder.
- The array sent to Bedrock has an AI `tool_use` at index 0 followed by a `HumanMessage` →
  Bedrock rejects it with `Expected toolResult blocks at messages.0.content`.

**In short:** the sanitizer assumes "answered somewhere" == "answered adjacently". Bedrock
requires adjacency. The role-alternation formatter breaks adjacency. The two assumptions
collide on long, tool-heavy conversations.

A secondary contributor: the "ensure starts with first message" pass (line 293–304) can place
an AI-with-`tool_calls` message at index 0; if its results were trimmed out of the window
entirely, the same orphan results.

---

## 5. Suggested fix directions (for whoever picks this up)

Pick one; (A) is the most direct.

- **(A) Make `sanitizeMessagesForBedrock` enforce adjacency, not mere existence.**
  Instead of a global `answeredToolCallIds` set, verify that the matching `ToolMessage`
  immediately follows the AI message. If a `tool_use` id's result is present but non-adjacent,
  either (i) move the `ToolMessage` to directly follow its AI message, or (ii) insert a
  synthetic placeholder regardless. Today's "answered anywhere → skip" logic (line 396) is the
  precise defect.

- **(B) Reorder the pipeline so sanitization is the *last* step.**
  Run the role-alternation formatter **before** the tool-pairing repair, or fold tool-pairing
  into `getRecentMessages` so no pass can separate a `tool_use` from its `tool_result` after
  repair. Currently `getRecentMessages` reformats *after* it has already tried to keep pairs
  together, and `sanitizeMessagesForBedrock` runs on the already-reordered output.

- **(C) Treat `ToolMessage` as "attached" to its preceding AI message in the formatter.**
  The alternation pass (line 306–335) should never insert a `Human`/`AI` filler between an AI
  `tool_use` message and its trailing `ToolMessage`s; it should skip over a complete
  tool-call group as a unit.

- **(D) Defensive: catch this specific `ValidationException` in `agentNode`** and retry once
  with a hard-repaired array (drop any unpaired `tool_use`/`tool_result`). This is a safety net,
  not a root-cause fix — prefer (A)–(C).

> Whatever the fix, apply it to **all** sanitize call sites: `fast-agent.ts:114`,
> `planning-agent.ts:215,503`, `executor-graphs.ts:296,501`.

---

## 6. How to reproduce / verify

1. **Unit test (preferred).** Construct a `BaseMessage[]` that mimics the windowed output:
   an `AIMessage` with a `tool_use` block at index 0, a `HumanMessage("Proceed.")` at index 1,
   and the matching `ToolMessage` at index 2. Assert that after `sanitizeMessagesForBedrock`
   the `tool_use` at index 0 is immediately followed by a `toolResult` for its id.
   (Colocate near existing agent tests; `web-ui` uses Vitest — `cd web-ui && npm run test`.)
2. **Log search to find more occurrences:**
   ```bash
   AWS_PROFILE=STX-CLOUD-PLATFORM aws logs filter-log-events \
     --region ap-south-1 \
     --log-group-name /ecs/nucleus-cloud-ops-web-ui-service \
     --filter-pattern 'Expected toolResult blocks'
   ```
3. **Trace the failing conversation:** thread `1782359757948` (tenant `cmobralb00005ec8ozxrzie0a`,
   user `USER#cmobracwo0000ec8o1c3x0y13`). The stored chat history for this thread is the
   real-world fixture — its message sequence around the window boundary is what tripped the bug.

---

## 7. Evidence (raw)

CloudWatch stream `web-ui/WebUIContainer/d008494ace764de78d058a938152b85b`, 2026-06-25 09:57:54 IST:

```
Main stream error: ValidationException: Expected toolResult blocks at messages.0.content
  for the following Ids: tooluse_7eO4Yy8l1uyhSoZiIbAZM9
at handleError (.next/server/chunks/7181.js:7:21864)
⨯ Error: failed to pipe response
[cause]: ValidationException: Expected toolResult blocks at messages.0.content
  for the following Ids: tooluse_7eO4Yy8l1uyhSoZiIbAZM9
```

Model in use at the time: `global.anthropic.claude-sonnet-4-6` (fast-agent generator).

---

## 8. Resolution (2026-06-25)

Applied **fix direction (A)** — `sanitizeMessagesForBedrock()` now enforces
*adjacency*, not mere existence.

The function was rewritten (`web-ui/lib/agent/agent-shared.ts`) to:

1. **Index** every `ToolMessage` by its `tool_call_id` (first occurrence wins).
2. **Skip** `ToolMessage`s where they sit in the input array, and instead
   **re-emit** each result *immediately after* its owning AI `tool_use` message,
   in `tool_use` order. A real `ToolMessage` is used if one exists anywhere in
   the array (so a result separated from its `tool_use` by an injected
   `"Proceed."` is pulled back into place); otherwise a synthetic placeholder is
   inserted.
3. **Drop** orphan `ToolMessage`s whose `tool_use` is absent from the window —
   Bedrock also rejects a `toolResult` with no preceding `toolUse`.

This removes the old "answered anywhere → skip placeholder" defect (the previous
`if (answeredToolCallIds.has(id)) continue;` at line 396) and guarantees the
Bedrock Converse adjacency contract regardless of how upstream windowing
reordered the array.

**Single fix point covers all call sites.** Because `fast-agent.ts`,
`planning-agent.ts`, and `agent-ops/executor-graphs.ts` all funnel through this
one shared function, the repair applies everywhere at once — no per-call-site
change was needed.

**Tests** (`web-ui/tests/agent-ops/agent-shared.test.ts`): added the §6 unit
test (AI `tool_use` → `HumanMessage("Proceed.")` → `ToolMessage`, asserting the
result is adjacent after sanitization) plus an orphan-result-dropped case. Full
suite: 15/15 passing.
