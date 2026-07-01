# Skill Distillation Redesign — Design Spec

Date: 2026-07-01
Status: Approved (pending write-up review)

## Problem

The "convert chat to skill" feature (Sparkles button in the chat UI → `/api/skills/distill`)
produces low-quality skills. Investigation found three root causes:

1. **Tool calls are stripped before distillation.** `handleSaveAsSkill` in
   `apps/web-ui/components/agent/chat-interface.tsx` builds the transcript sent to the
   distillation LLM by filtering message `parts` to `type === "text"` only. Every
   `tool-invocation` part — the actual AWS CLI/SDK calls, MCP tool calls (Slack, Jira,
   etc.), their arguments, and their results — is discarded. The LLM only ever sees the
   human-readable narration around the work, never the concrete actions taken. This is
   the primary reason generated skills read like generic "open the console and click
   around" prose instead of grounded, executable procedures.
2. **The prompt is domain-locked to "CloudOps."** `DISTILL_PROMPT` in
   `apps/web-ui/app/api/skills/distill/route.ts` opens with "You are distilling a CloudOps
   chat transcript…", but the agent can connect to arbitrary MCP servers (Slack, Jira,
   Discord, Telegram, webhooks are already wired as channels) — chats are not
   AWS-only. The prompt should infer the domain from the transcript, not assume one.
3. **Hard truncation drops the end of the conversation.** `transcript.slice(0, 24000)`
   keeps only the first 24,000 characters. Conclusions/resolutions in a troubleshooting
   chat are usually near the end, so long chats can lose exactly the part that matters,
   silently, with no user-visible warning.

## Goals

- Ground generated skills in the real tool calls made during the conversation, not just
  the prose narration.
- Make the distillation prompt and pipeline domain-agnostic — chats about AWS, Slack,
  Jira, or anything else the agent can reach via MCP should distill equally well.
- Remove the hard character-count truncation of the human-readable transcript.
- Keep the change contained: no Prisma schema changes, no new UI fields, same output
  contract (`name`, `description`, `tier`, `content`).

## Non-goals

- A multi-stage "extract then draft" pipeline (two LLM calls). Explicitly rejected in
  favor of a single smart pass — same latency/cost as today, fewer failure modes (one
  JSON parse instead of two), sufficient for the problems found.
- Per-model context-window-aware truncation/chunking. No per-model context-window data
  exists in this codebase today (`maxTokens` on provider records is the output
  completion cap, not input context size); building a lookup table is out of scope.
- Adding a "domain" or "category" field to the `Skill` model or its UI. The model
  infers domain implicitly through better prompting; no new metadata is persisted.

## Design

### 1. Transcript construction (client-side)

Extract the transcript-building logic out of `handleSaveAsSkill` (currently inline,
`apps/web-ui/components/agent/chat-interface.tsx`) into a new pure, exported function —
e.g. `apps/web-ui/lib/agent/build-chat-transcript.ts` — so it is unit-testable in
isolation from the chat component. `handleSaveAsSkill` calls this function instead of
building the string inline.

Behavior:

- Parts are processed **in their original order within each message** — text and
  `tool-invocation` parts are interleaved exactly as they occur, not grouped (all text
  first, all tools after). This preserves the actual sequence of reasoning → action →
  reasoning that the transcript already reflects.
- Every text part is included **verbatim, in full — no truncation**.
- Every `tool-invocation` part (identified by `part.type === "tool-invocation"` or the
  presence of `part.toolCallId`, matching the existing `renderToolInvocation` logic in
  the same file) is serialized as a `TOOL_CALL` / `TOOL_RESULT` block:
  - Tool name: `part.toolName || part.name`, falling back to deriving it from
    `part.type` (e.g. `"tool-execute_command"` → `execute_command`) — same precedence
    `renderToolInvocation` already uses.
  - Args: `part.args || part.input`, included **in full, never capped** (arguments are
    small — they represent a decision the agent made, not a data payload).
  - Result: `part.result || part.output`, included in full **unless it exceeds
    `TOOL_RESULT_CHAR_CAP = 4000` characters**, in which case it is truncated to that
    length with a trailing marker, e.g. `[...truncated N more chars]` where N is the
    number of characters removed. This is not a truncation of the *chat* — it is a cap
    on a single large machine-generated data payload (e.g. a big `describe-instances`
    JSON dump) so it does not dominate the prompt with information that adds no
    procedural value beyond "this API returned a list of things."
- Output format is flat, readable text (not JSON) since it is prose context for an LLM:

  ```
  ASSISTANT: I'll check EC2 costs for the last 3 months.
  TOOL_CALL: execute_command({"command":"aws ce get-cost-and-usage ..."})
  TOOL_RESULT: {"ResultsByTime":[...]}  [...truncated 3120 more chars]
  ASSISTANT: Top driver is EC2 at $4,200/mo, up 18% from last month...
  ```

### 2. API route (`apps/web-ui/app/api/skills/distill/route.ts`)

- Remove `transcript.slice(0, 24000)` entirely. The full assembled transcript is sent
  to `main.invoke(...)`.
- Add a pre-flight size guard **before** calling the LLM (see Error Handling below).
- Replace `DISTILL_PROMPT` with a domain-agnostic version:

  ```
  You are distilling an AI agent's chat transcript into a reusable "skill" — a
  generalized procedure the same agent can follow again for similar future requests.

  The transcript may include TOOL_CALL / TOOL_RESULT blocks showing the exact
  tools, commands, or API calls the agent actually used (AWS CLI, AWS SDK calls,
  Slack/Jira/other MCP tool calls, file operations, etc.) — this platform is not
  limited to any one domain. Infer the actual domain and tools from the
  transcript itself; do not assume AWS or any other specific system.

  Return ONLY a JSON object (no markdown fences) with keys:
  - "name": short Title Case name (max 5 words)
  - "description": one sentence describing when to use this skill
  - "tier": one of "read-only" | "mutation" | "approval-gated" — pick based on
    what the actual tool calls did:
    - "read-only": every tool call only queried/read/listed state, nothing was
      changed anywhere
    - "mutation": at least one tool call created, updated, deleted, sent, or
      posted something in any external system (cloud resources, tickets,
      messages, files, etc.)
    - "approval-gated": the transcript shows a destructive/irreversible action,
      or the agent explicitly asked for human confirmation before proceeding
  - "content": a markdown SKILL body with a one-line intro and a numbered,
    generalized step-by-step procedure GROUNDED in the actual tool calls made
    (name the real commands/API calls/tool names used, not generic UI
    navigation). Strip one-off identifiers (specific account/resource IDs,
    ticket numbers, usernames) and replace with placeholders — describe the
    repeatable method, not the one-off answer.

  Transcript:
  ```

- The `tier` value set (`read-only` | `mutation` | `approval-gated`) is unchanged — it
  is also hardcoded as a Zod enum in `components/skills/skill-form-dialog.tsx`, so
  keeping the same three values avoids touching the form/schema. Only the
  classification *guidance* in the prompt changes, generalized away from
  "creates/updates/deletes resources" to "changed something in any external system."

### 3. Error handling

- **Size guard:** no per-model context-window data exists in this codebase (`maxTokens`
  on provider records is the output completion cap, not input size — confirmed in
  `model-resolver.ts` / `model-factory.ts`). Rather than build a fragile per-model
  lookup table, use one conservative constant:
  `MAX_TRANSCRIPT_CHARS = 600_000` (~150k tokens at a rough 4 chars/token — comfortably
  under mainstream 128k–200k-token context windows, high enough that no realistic chat
  hits it; a backstop against pathological input, not a routine limiter).
- If the assembled transcript exceeds this, return **HTTP 413** before calling the LLM:
  `{ success: false, error: "This conversation is too long to distill in a single pass
  (~Nk chars, limit ~600k). Try a shorter portion of the chat, or configure a
  larger-context model as your tenant default." }`.
- All other error handling (provider config errors, JSON-parse failures, tier
  validation fallback) is unchanged.

### 4. Testing (Vitest, `apps/web-ui`)

- New `build-chat-transcript.test.ts`:
  - Text parts are preserved verbatim and untruncated, including long text.
  - `tool-invocation` parts are serialized with tool name, full args, and result.
  - A tool result over ~4000 chars is capped with a truncation marker; args are never
    capped regardless of size.
  - A tool result under the cap is included in full, unmodified.
- Updated/new `distill/route.test.ts` (or equivalent):
  - A long transcript (under the size guard) reaches `main.invoke` with no truncation
    applied (mock the model, assert the full string is present in the call).
  - A transcript over `MAX_TRANSCRIPT_CHARS` returns 413 and `main.invoke` is never
    called.
  - Existing behavior unchanged: invalid/non-JSON model response → 502; unrecognized
    `tier` value → falls back to `read-only`.

## Out of scope / explicitly deferred

- Two-stage (extract-then-draft) distillation pipeline.
- Per-model/provider context-window lookup for precise overflow detection.
- New `Skill` schema fields (e.g. a persisted "domain"/"category").
- Client-side pre-flight size check before the POST is sent (the 600k-char case is rare
  enough that a server-side-only check is sufficient for now).
