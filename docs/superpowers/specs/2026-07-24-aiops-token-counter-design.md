# AI Ops Chat — Token Counter (incoming / outgoing) Design

Date: 2026-07-24
Status: Approved (design)
Scope: Live + persisted cumulative token counter in the AI Ops chat header.

## Goal

Show a running "incoming / outgoing token" total in the AI Ops chat header
(next to the elapsed timer in `transcript-header.tsx`). The number is the
**cumulative billed total** — the sum of `input_tokens` and `output_tokens`
across every model call in the session — and it **survives page reload** and is
shown when reopening a past session.

## Data source (already present)

Every Bedrock/Anthropic response carries LangChain `AIMessage.usage_metadata`
(`{ input_tokens, output_tokens, total_tokens }`). Today it is read only for an
optional console audit line (`agent-shared.ts` `llmAuditLog`) and otherwise
discarded. `usage_metadata` also survives checkpoint round-trips
(`agent-shared.ts` copies it in `stripReasoningBlocks` / `sanitizeMessagesForBedrock`).

## Core model: "sum of all `data-usage` parts"

The counter equals the sum of every `data-usage` part the client has seen. The
live path and the history path both feed that one accumulator and are designed to
produce the **same** total.

Why this needs care: one visible turn (one assistant bubble) involves many model
calls — planner, each executor iteration, reflector, guard, memory. The live
stream sees all of them via `on_chat_model_end`; that is the true billed total.
The persisted `chat_messages` are only the *visible* messages, so copying each
message's own `usage_metadata` would miss the hidden calls and the number would
drop on reload. To keep live and reload equal:

- The server accumulates a **request-scoped run total** = Σ input / Σ output over
  every `on_chat_model_end` in the request.
- **Live:** each model-call end streams a `data-usage` part (that call's input /
  output). The client sums them → the counter ticks up as the agent works.
- **Persist:** the run total (covering hidden calls too) is attached to the
  turn's final assistant message as `metadata.usage_metadata`.
- **Reload:** the history route reconstructs one `data-usage` part per turn from
  that stored total.

Live (N per-call parts summing to T) and reload (one part = T) both sum to T for
the turn, so the total is identical before and after reload.

## Changes (6 files; follow the existing `data-phase` / `data-memory` pattern)

### Server
1. `app/api/chat/stream-parts.ts` — add
   `buildUsagePart(input: number, output: number)` returning
   `{ type: 'data-usage', data: { input, output } }`.
2. `app/api/chat/route.ts`:
   - In the `on_chat_model_end` branch (~line 932): read
     `event.data?.output?.usage_metadata`; add `input_tokens` / `output_tokens`
     to a request-scoped `runUsage` accumulator; `safeEnqueue(buildUsagePart(...))`
     with that call's input/output. Guard for missing usage (skip if absent).
   - In the persist mapping (~lines 1206-1219): on the **last** AI message of
     `newMessages`, set `metadata.usage_metadata = { input_tokens: runUsage.input,
     output_tokens: runUsage.output }` (alongside the existing `tool_calls`
     metadata). Only one message per run carries it, to avoid double counting.
3. `app/api/threads/[threadId]/history/route.ts` — in `convertPlainMessage`
   (AI branch), when `metadata.usage_metadata` is present, append
   `{ type: 'data-usage', data: { input, output } }` to the parts (mirrors the
   existing `data-phase` reconstruction). Read `input_tokens`/`output_tokens`
   (fall back to `input`/`output`). Do the same in `convertMessage` only if the
   checkpoint carries it (optional; primary path is `chat_messages`).

### Client
4. `components/agent/chat/run-state.ts` — add
   `tokenUsage: { input: number; output: number }` to `RunState` (default
   `{ input: 0, output: 0 }`), and a `case 'data-usage':` in `deriveRunState`
   that adds `part.data.input` / `part.data.output` across all parts. Flows
   through `runState` automatically — no `use-chat-session.ts` change.
5. `components/agent/workspace/transcript-header.tsx` — render
   `runState.tokenUsage` in the `ml-auto` row just before the elapsed timer /
   menu, styled `font-mono text-xs text-muted-foreground` to match. Hidden when
   both values are 0. Format: `↓ {in} · ↑ {out}` with a `title` tooltip showing
   exact counts (↓ = incoming/input, ↑ = outgoing/output).
6. `formatTokens(n)` helper (colocate in `run-state.ts` or an existing util):
   `< 1000` → the integer; `>= 1000` → one-decimal `k` (e.g. `48200 → "48.2k"`);
   `>= 1_000_000` → one-decimal `m`.

## `events.ts` interaction

The transcript reducer (`lib/agent-chat/events.ts`) switches on `part.type`; a
`data-usage` part falls to the existing `default` branch and emits no transcript
event. No change needed there; a test locks this (no stray event).

## Error handling

- Missing/partial `usage_metadata` on a call → skip that call's contribution
  (no part emitted); never throw.
- Persist step: if `runUsage` is `{0,0}` or there is no AI message in
  `newMessages`, attach nothing.
- History: if `metadata.usage_metadata` is absent or malformed, emit no usage
  part (the turn simply contributes 0).

## Scope / known exclusions (optional follow-ups, not in this spec)

- Pre-graph triage / auto-skill-select model calls made **before**
  `graph.streamEvents` are not counted (small).
- Direct-chat greetings (`app/api/chat/direct-chat.ts`, separate persist path)
  are not counted unless the same hook is added there.
- The separate `/api/deep-agent` workspace (different route/UI) is out of scope.

## Testing

- `run-state.ts`: `deriveRunState` sums multiple `data-usage` parts into
  `tokenUsage`; absent parts → `{0,0}`.
- `stream-parts.ts`: `buildUsagePart(3,4)` → `{ type:'data-usage', data:{input:3,output:4} }`.
- history route: an AI message whose `metadata.usage_metadata` is set yields
  exactly one `data-usage` part with the right numbers; absent → none.
- `events.ts`: a `data-usage` part produces no transcript event.
- `formatTokens`: `999→"999"`, `1000→"1.0k"`, `48200→"48.2k"`, `1_500_000→"1.5m"`.
- Consistency: for one turn, the sum of the live per-call parts equals the single
  persisted run-total part (documented assertion in the run-state test using both
  shapes).
