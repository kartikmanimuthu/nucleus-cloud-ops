# Convert a Chat into a Recurring Scheduled Task — Design

**Date:** 2026-07-11
**Status:** Approved (design), pending spec review
**Branch:** agent-ops-integration-channel

## Problem

The AIOps chat console already lets a user distill a finished conversation into a
reusable **Skill** (the *Save as skill* Sparkles button). Users want an
analogous one-click flow to turn a conversation into a **recurring Scheduled
Task**: click a button, have the whole chat analyzed and converted into a
self-contained run prompt (plus a name and a suggested cadence), then land on
the Scheduled Tasks screen with the create dialog pre-filled so they only have
to review and save.

The critical requirement: the generated prompt must be efficient and complete
enough that the scheduled task, running unattended, reproduces the work the chat
demonstrated **seamlessly** — with no human available to answer clarifying
questions.

## Key insight: task distillation ≠ skill distillation

These two flows pull in opposite directions and must not share a prompt:

| | Skill distillation | Scheduled-task distillation (this feature) |
|---|---|---|
| Goal | A *generalized, reusable* procedure | A *concrete, self-contained* recurring job |
| Identifiers | Stripped → placeholders (`<account-id>`) | **Retained** (real account IDs, regions, resources, thresholds, channels) |
| Audience | The agent, for *similar future* requests | The agent, running *this exact job* on a schedule, unattended |
| Clarification | N/A | **Never** — the prompt must assume fresh context and ask nothing |

## Flow

1. User clicks the new **Convert to scheduled task** icon button in the chat
   header (sibling of the *Save as skill* button).
2. `handleConvertToScheduledTask` builds the full transcript with the existing
   `buildChatTranscript(messages)`.
3. `POST /api/agent-ops/scheduled-tasks/distill` with `{ threadId, transcript }`.
   The LLM returns `{ name, prompt, suggestedCron, cadenceLabel }`.
4. Client stores the draft in `sessionStorage` under
   `agent-ops:scheduled-task-prefill` and calls
   `router.push('/app/agent-ops/scheduled-tasks?prefill=1')`.
5. The Scheduled Tasks page detects `?prefill=1`, reads **and clears** the
   sessionStorage entry, and auto-opens `ScheduledTaskDialog` pre-filled with
   `name`, `description = prompt`, `scheduleType = 'cron'`,
   `cronExpression = suggestedCron`.
6. User reviews/edits every field and clicks **Save**. The existing
   `POST /api/agent-ops/scheduled-tasks` create path runs unchanged.

Safe defaults that are **not** inferred: `autoApprove = false`,
`notification = none`. The user opts into those explicitly. Timezone stays the
dialog default (tenant/UTC).

## The distillation prompt

System prompt (new `route.ts`) instructs the model to return ONLY a JSON object
(no markdown fences) with keys:

- `name` — short Title Case name for the recurring job (max 6 words).
- `prompt` — the standalone run instruction. It MUST:
  - Open with the recurring objective in one line ("Every run, …").
  - **Retain concrete targets** from the transcript — real account IDs, regions,
    resource names/ARNs, numeric thresholds, channel names. Do NOT placeholder
    them; this is a specific recurring job, not a template.
  - Enumerate the exact ordered steps and **name the real tools/commands** used
    in the chat (AWS CLI/SDK calls, MCP tool names, KB lookups), grounded in the
    actual `TOOL_CALL` / `TOOL_RESULT` blocks in the transcript.
  - Be fully self-contained — no reference to "the previous chat" or "as we
    discussed", assume fresh context each run, and never ask the user anything.
  - End with the deliverable: what to check/compute and what to include in the
    run summary each time.
- `suggestedCron` — a 5-field cron expression inferred from the chat's intent
  (e.g. a daily audit → `0 9 * * *`). Default `0 9 * * *` when the chat gives no
  cadence signal.
- `cadenceLabel` — a short human label for the suggested cadence
  (e.g. "Daily at 9:00 AM"), for display only.

Domain-agnostic, exactly like the skills prompt: infer the domain and tools from
the transcript; do not assume AWS or any specific system.

### Reuse from `app/api/skills/distill/route.ts`

Byte-for-byte consistent handling:
- `MAX_TRANSCRIPT_CHARS = 600_000` guard → 413 with the same friendly message.
- Missing/invalid transcript → 400.
- `resolveDefaultModelConfig(tenantId)` + `createAgentModels(modelConfig).main`.
- Fence-strip then `JSON.parse`; invalid JSON → 502.
- `isProviderConfigError(error)` → 400; other errors → 500.
- `suggestedCron` validated: must be a 5-field string, else fall back to
  `0 9 * * *`.

**RBAC:** `authorize('create', 'Agent')` — the `Agent` subject maps to the
`AIOps` module in `lib/rbac/types.ts`, matching how the other `agent-ops/*`
routes gate (e.g. `authorize('update', 'Agent')`). Note the scheduled-tasks
create route itself is session-gated (no `authorize` call); adding one on the
distill route is a strict improvement and consistent with the agent-ops settings
routes. Tenant resolved server-side via `getSessionTenantId()` — never trusted
from the client.

## Components

| File | Change |
|---|---|
| `app/api/agent-ops/scheduled-tasks/distill/route.ts` | **New** — distill endpoint (mirrors `skills/distill`). |
| `app/api/agent-ops/scheduled-tasks/distill/route.test.ts` | **New** — unit tests. |
| `lib/queries/agent-ops-scheduled-tasks.ts` | Add `useDistillScheduledTask()` mutation (POST to the new route, return `data`). |
| `components/agent/chat-interface.tsx` | Add the icon button + `handleConvertToScheduledTask` (transcript → distill → sessionStorage → `router.push`). |
| `components/agent-ops/scheduled-task-dialog.tsx` | Add optional `prefill` prop + optional controlled `open` / `onOpenChange` so the page can open it pre-filled. Backward compatible — existing uncontrolled call sites keep working. |
| `app/app/agent-ops/scheduled-tasks/page.tsx` | On `?prefill=1`, read + clear sessionStorage, open dialog with prefill, then strip the query param. |

### `prefill` prop shape

```ts
interface ScheduledTaskPrefill {
  name?: string;
  description?: string;   // the run prompt
  cronExpression?: string;
}
```

When `prefill` is present and no `task` is given (create mode), the dialog seeds
`DEFAULT_FORM` with these values.

## Error handling

- Distill request failure (network / provider / oversized) → `toast.error` in the
  chat, no navigation. Mirrors `handleSaveAsSkill`.
- Empty chat (`messages.length === 0`) → button disabled, same as *Save as skill*.
- If the page loads with `?prefill=1` but sessionStorage is empty (e.g. reload) →
  open the empty create dialog (or no-op), no crash; strip the query param.

## Testing

- **Unit** (`route.test.ts`): mock the model; assert
  - valid JSON round-trips into `{ name, prompt, suggestedCron, cadenceLabel }`,
  - missing transcript → 400,
  - oversized transcript → 413,
  - non-JSON model output → 502,
  - invalid `suggestedCron` falls back to `0 9 * * *`.
  Mirrors the existing `skills/distill/route.test.ts`.
- **Manual verify** (running app): open a chat with a couple of tool calls →
  click Convert → confirm navigation and that the dialog is pre-filled with a
  concrete, self-contained prompt + suggested cron; save and confirm the task is
  created.

## Out of scope (YAGNI)

- Inferring `autoApprove` or notification channel from the chat.
- Editing/regenerating the distilled prompt in place before navigation.
- Persisting a link back to the source chat/thread on the task.
