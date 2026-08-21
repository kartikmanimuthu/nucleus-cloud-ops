# Deep stream → v3 migration plan

Companion to `docs/superpowers/specs/2026-08-12-deep-stream-v3-contract.md`, which holds the
UI contract this must satisfy. This file records the **verified** v3 API facts and the build
order.

Rule for this work: **no workarounds.** If something looks like it needs hand-rolled plumbing,
re-read the docs first — every workaround so far has become a bug.

---

## Verified facts

### From the docs (event-streaming page, verbatim examples)

**Awaiting handles inline is the documented pattern.** Example 3:
```ts
for await (const message of stream.messages) {
  console.log("[coordinator]", await message.text);
}
```

**Nested consumers must be fire-and-forget**, not awaited in the parent loop. Example 6:
```ts
await Promise.all([
  (async () => { for await (const message of stream.messages) { … } })(),
  (async () => {
    for await (const subagent of stream.subagents) {
      void (async () => { for await (const message of subagent.messages) { … } })();
    }
  })(),
]);
```

**Tool status is a tri-state, awaited.** Example 4:
```ts
const status = await call.status;
if (status === "finished") console.log(await call.output);
else if (status === "error") console.error(await call.error);
```

**The raw iterator carries everything, with a namespace that identifies the source.** Example 7:
```ts
for await (const event of stream) {
  if (event.method !== "messages") continue;
  const data = event.params.data;
  if (data.event !== "content-block-delta") continue;
  const block = data.delta ?? {};
  if (block.type === "text-delta") {
    const isSubagent = event.params.namespace.some((seg) => seg.startsWith("tools:"));
    console.log(`[${isSubagent ? "subagent" : "coordinator"}] ${block.text}`);
  }
}
```

`subagent.taskInput`, `subagent.output`, `subagent.messages`, `subagent.toolCalls`,
`subagent.subagents` all exist (Examples 1, 2, 5).

### Measured against our own agent

| Fact | Value |
|---|---|
| `await agent.streamEvents(input, {version:"v3"})` | returns `GraphRunStream`; **must be awaited** |
| projections present | `messages`, `subagents`, `toolCalls`, `values`, `extensions` |
| `toolCalls` item keys | `name`, **`callId`**, `input`, `output`, `status`, `error` |
| `messages` item keys | `_buffer`, `namespace`, `node`; `.text` is a **promise** |
| `values` updates in one run | 13, keys incl. `todos`, `messages`, `files`, `skillsMetadata` |
| raw `method` values seen | `lifecycle`, `checkpoints`, `values`, `tasks`, `updates`, `messages`, `tools` |
| writer payloads | surface only on v3, as `method:"custom"` |

**`callId` is the decisive find.** The whole tool-pairing bug family existed because the v2 loop
had to invent ids from `run_id` and reconcile them across three branches. v3 hands us the real
tool call id, so input and output pair by construction.

---

## Design decision: the projections, exactly as documented

Examples 1–6 are all projections. Example 7 ("Concurrent with raw events") is an *additional*
option, not the primary one. **We use the projections.**

An earlier draft of this plan chose the raw iterator instead, justified by a spike of mine that
stalled at one message handle. That was the wrong reasoning: I hit friction with the documented
path and routed around it, which is the exact habit that produced the last four bugs. The spike
deviated from Example 6 — it consumed `messages`, `toolCalls`, `values` **and** the raw `stream`
simultaneously, a combination the docs never show. The fix is to follow Example 6, not to abandon
the projections.

Documented consumption, to be followed literally:

```ts
await Promise.all([
  (async () => {
    for await (const message of stream.messages) { /* await message.text */ }
  })(),
  (async () => {
    for await (const subagent of stream.subagents) {
      void (async () => { for await (const message of subagent.messages) { … } })();
    }
  })(),
]);
```

Rules taken directly from the examples:
- top-level projections are consumed inside `Promise.all`, one async IIFE each
- nested (per-subagent) consumers are launched with `void`, never awaited in the parent loop
- handles (`message.text`, `call.status`, `call.output`, `subagent.output`) are awaited
- **do not** iterate the raw `stream` alongside the projections — no example does

---

## Unknowns — all resolved from the type definitions

Source: `@langchain/langgraph/dist/stream/{types,run-stream}.d.ts` and
`@langchain/core/dist/language_models/stream.d.ts`.

**Why my spike stalled — the actual answer.** `message.text` is a `TextContentStream`, which is
*dual-interface*:

> - **Iterate**: yields incremental text deltas.
> - **Await**: resolves to the complete concatenated text.
> - **`.full`**: yields the running accumulated text after each delta.

I *awaited* it, which blocks until that message finishes. For streaming UI we **iterate** it for
deltas. Nothing about the projections was broken; I used the wrong half of the interface.

### `GraphRunStream`

| Member | Type | Use |
|---|---|---|
| `messages` | `AsyncIterable<ChatModelStreamHandle>` | one handle per message-start → message-finish |
| `toolCalls` | `AsyncIterable<ToolCallStream>` | tool cards |
| `subagents` | `AsyncIterable<SubagentRunStream>` | subagent cards (deepagents overlay) |
| `values` | `AsyncIterable<TValues> & PromiseLike<TValues>` | iterate = snapshots, await = final state |
| `output` | `Promise<TValues>` | final state |
| `interrupted` | `boolean` | **HITL detection, no `getState` needed** |
| `interrupts` | `readonly InterruptPayload[]` | **the interrupt payloads directly** |
| `lifecycle` | `AsyncIterable<LifecycleEntry>` | run/subgraph enter-exit, terminal status |
| `messagesFrom(node)` | filtered messages | not needed for deep |
| `abort(reason)` / `signal` | cancellation | replaces the manual abort controller |

### `ChatModelStream` (each `messages` handle)

`text`, `toolCalls`, `reasoning`, `usage`, `output`. `text` and `reasoning` are
`AsyncIterable<string> & PromiseLike<string>` — **iterate for deltas**. This maps 1:1 onto the
UI contract's `text-start`/`text-delta`/`text-end` and `reasoning-*` parts.

### `ToolCallStream`

```ts
readonly name: string;
readonly callId: string;          // "Correlates with protocol toolCallId"
readonly input: unknown;          // finalized when the call is observable
readonly output: Promise<unknown>;
readonly status: Promise<ToolCallStatus>;   // "running" | "finished" | "error"
readonly error: Promise<string | undefined>;
```

Three status states, not two — Example 4 only demonstrates `finished` and `error`.

### Consumption rules (docs Example 6)

- projections consumed inside `Promise.all`, one async IIFE each
- nested per-subagent consumers launched with `void`, never awaited in the parent loop
- **do not** iterate the raw `stream` alongside the projections — no example does, and that
  combination is exactly what my stalled spike did

### Contract rows this now covers directly

Rows 6 and 11 (usage, reasoning) come free from `ChatModelStream.usage` / `.reasoning`, and rows
20/21 (approval, clarification) can read `run.interrupts` instead of a separate `getState`.

---

## Build order

`processStream` is **not touched**. Deep selects `processDeepStream`:

```ts
mode === 'deep' ? processDeepStream(...) : processStream(...)
```

Reverting = flipping that conditional. Fast/plan cannot regress.

| Step | Deliverable | Contract rows |
|---|---|---|
| 1 | Spike: capture the five unknowns | — |
| 2 | `processDeepStream` skeleton: `start`, text from `messages`, `finish`, `error`, empty-message guard | 1, 9, 23, 24, 25 |
| 3 | Tool cards from `callId` — delete the run_id pairing, `deepUngated`, `runIdToEmittedId` | 14, 15, 17 |
| 4 | Subagent cards from `stream.subagents` — delete `taskStartEvent`/`taskEndEvent` synthesis | 5, 22 |
| 5 | Plan rail from `values.todos` | 8, 19 |
| 6 | Usage from model events | 6 |
| 7 | Approval / clarification / resume — reuses the already-fixed `pendingActions`/`toResumeMap` | 3, 4, 16, 20, 21 |
| 8 | Verification matrix, in the browser | all |

Each step commits separately.

## What this deletes

- run_id → tool-card pairing across three branches (`autoApprove` / `deepUngated` / `isResumedFromApproval`)
- `runIdToEmittedId`, `pendingToolCalls` bookkeeping for deep
- `taskStartEvent` / `taskEndEvent` synthesis in `stream-adapt.ts`
- the `mode === 'deep'` special cases threaded through `processStream`

Expected net: **fewer lines than today.**

## Risk

Step 7 is the one that has produced every HITL bug so far. It goes last, on a path already proven
by steps 2–6, and it now builds on `pendingActions` reading interrupts from state — which is
verified against a live thread (13 actions recovered where the old code returned 0).

Step 3 is where the largest class of bugs disappears, since `callId` removes the invention of ids
entirely.

---

## Upstream patch: `patches/@langchain%2Fcore@1.2.1.patch`

v3 could not run at all until this was fixed. `@langchain/core`'s compat bridge starts a tool
block with `args: ""` and finalizes it with `JSON.parse(chunk.args ?? "{}")`. When the model
calls a tool with **no arguments** the provider streams zero input bytes, `args` stays `""`, and
`JSON.parse("")` throws — the call becomes `invalid_tool_call`, the agent sees no tool call, and
the run stops. `list_aws_accounts` (`schema: z.object({})`) is exactly that case, and the deep
prompt calls it first.

Measured on our own agent, same prompt, same graph:

| Path | Messages | Result |
|---|---|---|
| `invoke` | 4 | tool ran |
| `streamEvents` v2 | 4 | tool ran |
| `streamEvents` v3 | 2 | `invalid_tool_call`, run died |

The patch is one line, in both the ESM and CJS builds:

```js
- parsedArgs = JSON.parse(chunk.args ?? "{}");
+ parsedArgs = JSON.parse(chunk.args?.trim() ? chunk.args : "{}");
```

Checked against 1.2.5 (latest at the time): same code, still unfixed. Adding an optional
parameter to the tool schema does **not** work around it — verified live; the model still sends
zero bytes. Delete the patch once upstream ships a fix.

**Gotcha — patching a dependency requires clearing `.next`.** Next bundles `@langchain/core`
into `.next/server/vendor-chunks/@langchain.js`, and webpack's persistent cache in `.next/cache`
happily reuses the pre-patch module: the file on disk is fixed while the running server still
executes the old code, reproducing the bug exactly. `tsx` harnesses do not go through webpack, so
they pass while the UI fails. After any `bun patch`, run `rm -rf apps/web-ui/.next` before
restarting. To check which version is actually live:

```bash
grep -o 'JSON.parse(chunk.args[^)]*)' apps/web-ui/.next/server/vendor-chunks/@langchain.js
# patched build prints nothing; a stale build prints JSON.parse(chunk.args ?? "{}")
```

---

## Upstream patch 2: `patches/langchain@1.5.2.patch` — the `respond` decision

The JS HITL docs specify **four** decision types and name `respond` as the one for `ask_user`:

> "Use `respond` for 'ask user' style tools where the tool's real implementation is the human's
> reply."

No published release implements it. `DecisionType` is `["approve", "edit", "reject"]` in 1.5.2
(installed) and in 1.5.5 (latest); the newest prerelease tag is older still. Sending the
documented decision therefore failed at runtime:

```
Unexpected human decision: {"type":"respond","message":"ap-south-1 and us-east-1"}.
Decision type 'respond' is not allowed for tool 'ask_user'.
```

The patch adds `respond` to both builds, as documented — three edits each:

1. `ALLOWED_DECISIONS` gains `"respond"`, so `interruptOn: { ask_user: true }` permits it.
2. `processDecision` gains a `respond` branch returning the human's message as the tool result.
   Unlike `reject` it does **not** set `status: "error"` — the answer is a normal result.
3. The control-flow predicate treats `respond` like `reject`: the call is answered synthetically,
   so the tools node must be skipped and the model re-invoked. Without this the tool would execute
   *and* receive a synthetic result for the same `tool_call_id`.

Watch out: the ESM build imports `ToolMessage` directly, the CJS build namespaces it as
`_langchain_core_messages.ToolMessage`. Using the bare name in the CJS build throws
`ToolMessage is not defined` only at runtime, on the resume path.

Known limitation, inherited from `reject`: if a batch mixes a responded call with approved ones,
the approved calls are dropped and the graph returns to the model. Delete this patch once a
release ships `respond`.
