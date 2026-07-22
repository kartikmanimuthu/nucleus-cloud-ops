# AI Ops Chat — History Reasoning-Block Rendering (Phase 2)

Date: 2026-07-21
Status: Approved (design)
Scope: Phase 2 of the 3-part effort. Read-path only. No storage/write change.

## Problem

When a user reopens a previous AI Ops chat session, reasoning content can render
as a raw JSON blob, e.g.:

    [{"type":"reasoning","reasoning":"","signature":"..."}]

instead of rendering the way the live stream does (a collapsible "Thought for Ns"
block, or — for empty reasoning — nothing at all). Everything else in a reopened
session (plan, tool calls, answer) already renders correctly; only reasoning that
was stored as an array of content blocks is broken.

## Root cause

Live and history both feed the same reducer (`buildTranscript` in
`lib/agent-chat/events.ts`) → `AgentTurn` → `ThinkingBlock`. A `reasoning` part
becomes a `thinking` event and renders as the collapsible block. The divergence
is purely at the persistence boundary.

**Write path** (`app/api/chat/route.ts`, `finally` block):
- `route.ts:1183` — the phase marker is prepended only when
  `typeof msg.content === 'string'`. Array content gets no marker.
- `route.ts:1208` — `const content = typeof m.content === 'string' ? m.content :
  JSON.stringify(m.content)`. Array content is stringified whole into storage.

**Read path** (`app/api/threads/[threadId]/history/route.ts`):
- `extractDisplayText` (`:88-105`) parses the JSON array but keeps only
  `type:'text'` blocks. A pure-reasoning array has no text block, so it returns
  the raw JSON string unchanged.
- `convertPlainMessage` (`:107-129`) → `buildPhaseParts` (`:55-79`) →
  `normalizeLegacyContent` (`legacy-normalizer.ts:24-31`) finds no marker →
  classifies it as `phase: 'text'` → emits `[{ type: 'text', text: <raw JSON> }]`
  → the reducer renders it verbatim as an answer.

Marker-prefixed **string** content (planning / reflection / revision / memory,
and execution/final prose) is unaffected — it reconstructs correctly today. Only
**array** content with reasoning blocks is broken.

## Key behavioral fact (defines "match live")

The shared reducer drops any reasoning part whose text is empty
(`events.ts:159-161`: `const text = stripSentinel(part.text ?? ''); if
(text.length === 0) return;`). In the live stream, the signature-only
`"reasoning":""` blocks therefore render as **nothing**. So matching live means:

- empty-text reasoning → renders nothing (message vanishes, no empty box);
- reasoning with real text → a "Thought for Ns" collapsible block;
- text/answer blocks → the answer, as today.

## Fix — read-path reconstruction (backward-compatible)

All changes are in `app/api/threads/[threadId]/history/route.ts`. Nothing about
how messages are stored changes, so the fix repairs **already-stored** history
and future history alike, with no migration and no risk to the write path.

### New helper: `reconstructAiContentParts(content)`

- Input: an AI message's stored content — either the JSON string from
  `chat_messages` (`convertPlainMessage`) or the raw `msg.content` value from the
  checkpoint fallback (`convertMessage`).
- Normalize to an array: if the value is already an array use it; if it is a
  string that JSON-parses to an array, use that; otherwise return `null`.
- Return `null` when the content is not a content-block array (so the caller
  uses the existing string/marker path unchanged).
- When it is an array, map block-by-block, preserving order, into
  `HistoryMessage['parts']`:
  - `text` block (`type === 'text'`, string `text`) → `{ type: 'text', text }`
  - reasoning block → `{ type: 'reasoning', text: <extracted> }` **only if the
    extracted text is non-empty**; empty reasoning blocks are skipped at the
    source (mirrors the reducer's drop, so no empty turns).
  - `tool_use` block → skipped (tool calls are reconstructed separately from
    `metadata.tool_calls`; skipping avoids a duplicate tool part).
  - any other block type → skipped.

Reasoning-block detection + text extraction handles the shapes that occur:
- `{ type: 'reasoning', reasoning: string, signature? }` → text = `reasoning`
- `{ type: 'thinking', thinking: string }` → text = `thinking`
- `{ type: 'redacted_reasoning' | 'redacted_thinking' | 'reasoning_content', … }`
  → typically no text → contributes nothing
- `{ reasoningContent: { reasoningText: { text: string } } }` (raw Bedrock) →
  text = `reasoningText.text`

The emitted `reasoning` part carries no `data-phase`; it renders as a generic
"Thought for Ns" block (phase-specific banner coloring is not reconstructed for
raw extended-thinking blocks — consistent with existing reload limitations noted
in `history/route.ts`).

### Wiring

- `convertPlainMessage` (DB path), **AI branch only**: call
  `reconstructAiContentParts(msg.content)` first. If non-null, use those parts;
  else fall back to today's `extractDisplayText` + `buildPhaseParts`. Then append
  tool-invocation parts from `metadata.tool_calls` exactly as today, and keep the
  existing `if (parts.length === 0) return null` guard — a message that
  reconstructs to nothing (empty-reasoning-only, no tool calls) is dropped, so it
  vanishes like live. The `HistoryMessage.content` string field is set to the
  concatenation of the reconstructed `text` blocks (empty string when there are
  none) — reasoning text is never placed in `content`, only in `reasoning` parts.
- `convertMessage` (checkpoint-fallback path), **AI branch only**: same
  first-try/fallback, passing the raw `msg.content` (which may already be an
  array).
- The human and tool branches are untouched. `extractDisplayText` continues to
  handle user multimodal text+image arrays; the new reconstruction is gated to
  the AI role.

## Result

- `[{"type":"reasoning","reasoning":"",...}]` → dropped → nothing shown.
- reasoning block with text → "Thought for Ns" block.
- mixed `[reasoning, text]` → a reasoning part + the answer, in order.
- planning / reflection / marker strings, tool calls, answers → unchanged.
- raw JSON → gone from the interactive transcript.

## Why it is production-safe

- Read path only. The write path, storage format, and live stream are untouched,
  so nothing about how sessions are recorded or streamed changes.
- Additive branch: array content takes a new path; every existing string/marker
  case falls through to today's exact code. Regression tests lock that.
- Gated to the AI role, so the human multimodal path cannot regress.
- No schema, infra, feature-flag, or API-contract change.

## Testing

Unit tests (Vitest) against the history route's conversion. If the target
functions are not exported, export `reconstructAiContentParts` (and, if needed,
`convertPlainMessage`) for testing, or add a thin exported wrapper — no behavior
change.

1. Pure empty-reasoning array (`[{type:'reasoning',reasoning:''}]`) on an AI
   message with no tool calls → message is dropped (`convertPlainMessage` returns
   `null`).
2. Reasoning-with-text array → yields exactly one `reasoning` part carrying that
   text, no `text` part.
3. Mixed `[reasoning(text), text]` → yields a `reasoning` part then a `text`
   part, in that order.
4. `[reasoning(empty), tool_use]` + `metadata.tool_calls` for the same id →
   exactly one tool-invocation part, no `reasoning` part, no duplicate tool part.
5. `{reasoningContent:{reasoningText:{text:'…'}}}` block → reasoning part with
   that text (raw Bedrock shape).
6. Regression — marker string content (`PLANNING_PHASE_START\n…`,
   `REFLECTION_PHASE_START\n…`) → identical output to today (reasoning part,
   humanized where applicable).
7. Regression — human multimodal array (`[{type:'text'},{type:'image_url'}]`) →
   unchanged (still routed through `extractDisplayText`, not the new helper).

Beyond units: reopen a real session that currently shows raw JSON and confirm the
blob is gone and the transcript matches the live rendering.

## Out of scope (flagged, not fixed here)

- The write/storage format (`route.ts:1183`, `:1208`) — left as-is; the read path
  interprets it.
- Export paths (`lib/chat-export.ts`, `lib/agent-ops/export-markdown.ts`,
  `lib/agent-ops/export-pdf.ts`) may share the raw-JSON / "Thinking:" issue.
  Separate follow-up unless explicitly pulled in.
- Phase-banner coloring for reconstructed raw extended-thinking blocks (they
  render as generic "Thought" blocks).
