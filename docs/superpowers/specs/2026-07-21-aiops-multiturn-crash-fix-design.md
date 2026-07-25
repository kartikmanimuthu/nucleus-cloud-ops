# AI Ops Chat — Multi-Turn / Resume Crash Fix (Phase 1)

Date: 2026-07-21
Status: Approved (design)
Scope: Phase 1 of a 3-part effort. This spec covers only the crash-fix.

## Problem

On the AI Ops chat, a brand-new chat with a single query works. But a **second
query on the same chat fails**, and reopening a **previous history session and
asking again fails** the same way. Both surface as a Bedrock error:

> ValidationException: The content field in the Message object at messages.N is empty.

### Why turn 2+ and resume are the same bug

On any turn after the first — whether a live chat's next query or a reopened
history session — the backend does **not** trust the browser's message array. It
reloads the full prior conversation from the LangGraph **Postgres checkpointer**
(keyed by `thread_id`, no TTL) and appends only the new user message
(`apps/web-ui/app/api/chat/route.ts:420-486`). This is the intended "resume where
it left off" design and it already exists. Both #2 (live multi-turn) and the
functional core of #3 (resume + ask again) flow through this identical replay
path.

### Root cause

On turn 1, the model can emit an AI message whose `content` array contains
**only a reasoning/thinking block** (no text block, no tool calls) — e.g. Claude
Sonnet consumes its output budget mid-reasoning. Turn 1 still succeeds because a
`finalize` step synthesizes the real answer, but that reasoning-only message is
checkpointed into thread state.

On the next turn the checkpoint is replayed through
`sanitizeMessagesForBedrock()` (`apps/web-ui/lib/agent/agent-shared.ts`):

- `getRecentMessages()` filters empty-content messages **before** stripping, so
  it keeps this message (its content array is non-empty at that point).
- `sanitizeMessagesForBedrock()` → `stripReasoningBlocks()` removes the reasoning
  block, leaving `content: []`, and then **pushes it unconditionally**
  (`agent-shared.ts:713-714`) with no tool calls.
- The message is sent to Bedrock with empty content → ValidationException.

Nothing re-checks for emptiness *after* stripping. The gap is currently
untested (`sanitize-bedrock.test.ts` covers null-text reasoning and
thinking+text+tool_use, but not reasoning-only-becomes-empty).

## Fix

Single change site: `sanitizeMessagesForBedrock()` in
`apps/web-ui/lib/agent/agent-shared.ts` (lines 711-714). This is the one function
every Bedrock invoke routes through (`fast-agent.ts:139`,
`planning-agent.ts:427` and `:767`).

After `const cleaned = stripReasoningBlocks(msg)`: if `cleaned` is an AI message
with **empty content AND no tool calls**, **replace its content with a minimal
non-empty placeholder** (`"(reasoning omitted)"`) before pushing it. Do not drop
it.

### Why replace, not drop

Dropping the message breaks Bedrock's strict Human/AI role alternation.
`getRecentMessages()` runs *before* `sanitize` and already enforces alternation
(`agent-shared.ts:593-613`, inserting `"Proceed."` / `"Acknowledged."`); nothing
merges consecutive same-role messages anywhere before the Bedrock call. Turn 1
persists both the reasoning-only AI message *and* the `finalize` answer as two
adjacent AI messages (`fast-agent.ts:270`), so on turn 2 the sequence is
`[Human(q1), AI(reasoning-only), Human("Proceed."), AI(final), Human(q2)]`.
Dropping `AI(reasoning-only)` leaves `Human(q1)` and `Human("Proceed.")`
adjacent → a *different* ValidationException. Replacing the emptied content with
a placeholder keeps the assistant slot filled, so alternation stays valid:
`[Human(q1), AI("(reasoning omitted)"), Human("Proceed."), AI(final), Human(q2)]`.
The placeholder is consistent with the synthetic messages the code already uses
(`"Proceed."`, `"Acknowledged."`, `"[Tool result unavailable — synthetic
placeholder]"`).

### Predicate (the safety hinges here)

- `hasToolCalls` = `tool_calls.length > 0` **OR** the content array contains a
  `tool_use` block.
- `contentEmpty` = an empty array, or an array whose blocks are all empty /
  whitespace-only `text` blocks; or a string that is empty / whitespace.
- **Replace content only when** `isAIMessage && contentEmpty && !hasToolCalls`.

This never touches a valid tool-use turn (empty text but real `tool_calls` is
legitimate for Bedrock) and never touches a normal text answer. It rewrites only
the message that is otherwise guaranteed to trigger the empty-content
ValidationException, and leaves message count and roles intact.

## Why it is production-safe

- The turn-1 single-query path is unaffected: it does not replay old
  reasoning-only messages, and a live turn never produces an already-empty
  message at this boundary.
- Message count and role order are preserved (content is rewritten in place, not
  removed), so role alternation cannot regress.
- The tool-result adjacency logic (`agent-shared.ts:718-752`) is untouched — the
  replaced message has no tool calls, so the `pendingIds` block is a no-op for
  it.
- No schema, infra, feature-flag, or API-contract change. One pure function.

## Testing

TDD — write the failing tests first, in
`apps/web-ui/lib/agent/sanitize-bedrock.test.ts`:

1. **The bug (must fail before the fix):** a reasoning-only AI message
   (`content: [ { reasoningContent: { reasoningText: { text: null } } } ]`, no
   text, no tool_calls) placed between valid messages → after `sanitize` that
   message is present with **non-empty** content (the `"(reasoning omitted)"`
   placeholder) and no empty-content AI message survives. Today it survives with
   `content: []`, so this fails before the fix.
2. **Alternation preserved:** given
   `[Human, AI(reasoning-only), Human, AI(text), Human]`, the sanitized output
   has the same length and role order with no consecutive same-role pair.
3. **The guard (must not over-rewrite):** an AI message with empty content
   **but** `tool_calls` present → content left untouched, with its `ToolMessage`
   still re-emitted immediately after it.
4. **Normal answer untouched:** a plain-text AI message is returned by the same
   reference (unchanged), as the existing test at
   `sanitize-bedrock.test.ts:41-46` asserts.
5. Full existing suite (`cd apps/web-ui && bun run test`) passes — no
   regression.

Beyond unit tests, verify manually: reproduce a real turn-2 on a fresh chat, and
reopen a history session and ask again — confirm no ValidationException and the
agent continues with prior context.

## What this fixes

- #2 — live multi-turn (second query on the same chat).
- #3 — the functional core of resume: reopening a history session and asking a
  new question no longer crashes and continues from the restored checkpoint
  context.

## Out of scope (tracked for later phases)

- **Phase 2 — reasoning render in history (#1):** array-content reasoning is
  persisted via `JSON.stringify` (`route.ts:1208`) with no phase marker
  (`route.ts:1183`), so on replay the history route renders it as a raw-JSON
  `text` answer instead of a "Thought for Ns" thinking block. Separate spec.
- **Gap A — direct-chat continuity:** greeting / simple-Q&A turns
  (`apps/web-ui/app/api/chat/direct-chat.ts`) bypass the checkpointer, so a
  session made only of those has an empty checkpoint and falls back to a lossy
  display-history replay. Triage separately.
