# ChatBotPersona Router + Real-Time Narration — Design Spec

**Date:** 2026-07-28
**Status:** Approved (revised 2026-07-28 after Opus 5 plan review — see §Revisions)
**Branch:** `feat/chatbot-persona-agent-ops`

## Problem

Every inbound Telegram/Slack message that reaches the Channel Gateway (see `docs/superpowers/specs/2026-05-01-channel-gateway-design.md`) becomes a full Agent Ops run — a "hi" costs the same as a real task, because `GatewayService.handleInbound` has no intent gate before `agentOpsService.createRun()`. Separately, once a run is underway the user gets no readable progress: `TelegramAdapter.sendStreamChunk` renders raw internal event text (`[tool_call] execute_command`), and — as the plan review established — it is never even invoked, because nothing in the codebase emits the `run:event` bus event it depends on.

## Goal

Insert one router step in front of Agent Ops run creation that replies immediately to small talk without starting a run, and make real task runs narrate their progress as a plain-English, step-by-step checklist. Reuse existing building blocks wherever they already solve part of the problem — this is additive to the Channel Gateway, not a rework of it.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Classifier | Reuse `triageChatMessage()` (`lib/agent/triage.ts`) unchanged | Already channel-agnostic, already fail-open to `'task'` on any error, already one cheap reflector call. No fork needed. |
| Classifier failure | Fail open to `'task'` | Matches `triageChatMessage`'s existing behavior. A wasted run is cheaper than silently dropping a real request. |
| Awaiting-answer gate | None needed — already exists | Telegram's `findResumableTelegramRun` and Slack's `findAwaitingRunBySlackThread` already populate `replyContext` in `parseInbound`, before `handleInbound`'s existing `if (message.replyContext)` check. The classifier is placed strictly after that check, so it never sees a message that is actually an answer to a pending clarification/approval. |
| **Direct-reply channel scope** | **Telegram only for v1** | The direct-reply path runs two sequential LLM calls before returning the HTTP response. Slack slash commands and Discord interactions both enforce a hard **3-second** response window (Discord's `sendAck` already returns deferred-type 5 for exactly this reason). Telegram's webhook has no such limit. Other channels get no `sendDirectReply` at all — the interface method is optional, so its absence makes the router fall through to today's behavior with zero risk. |
| Jira direct reply | Excluded | Jira's webhook caller discards response bodies; replies are only visible via `JiraAdapter.postComment`. Returning JSON text there would produce no run *and* no visible reply — a silent drop, violating the fail-open rule. |
| Rollout flag | New `CHATBOT_PERSONA_ENABLED` (+ `CHATBOT_PERSONA_CHANNELS` allowlist), default OFF, independent of `CHAT_TRIAGE_ENABLED` | Opt-in dark launch. The branch is additionally skipped when `chatTriageEnabled()` is false, so the disabled-triage kill-switch path can't burn an `autoSelectSkill` call per inbound message. |
| Direct-reply delivery | New optional `sendDirectReply(req, text): Promise<Response>` on `ChannelAdapter`, implemented by Telegram only | Mirrors the adapter's existing `sendAck` pattern — no new transport concept. |
| **`run:event` emission** | **New prerequisite work in `agent-executor.ts`** | Narration's foundation does not exist: `processLangGraphEvent` records events to Postgres via `agentOpsService.recordEvent` but never emits to the `GatewayEventBus`, and `notification-router.ts` is `run:event`'s only consumer. Without this, all narration is dead code. `eventBus` is already a parameter of both `executeAgentRun` and `resumeApprovedRun` and is in scope at both `processLangGraphEvent` call sites. |
| Narration content | Deterministic template map (tool/node name → friendly phrase), LLM fallback for unmapped names | Per-event LLM translation adds latency/cost to every step; a lookup table is instant and free. The map must key on the **real** catalog — tools are generic (`execute_command`, `read_file`, `grep`, `get_aws_credentials`, `list_aws_accounts`, `search_knowledge_base`, …; AWS work happens through `execute_command` running the AWS CLI, not per-service tools) and nodes are LangGraph names (`planner`, `generate`, `agent`, `reflect`, `revise`, `evaluator`, `final`, …). |
| **Checklist step correlation** | **Keyed by `toolName`, not positional** | The executor records one `tool_call` per tool in a loop, so a parallel-tool turn yields N `tool_call`s then N `tool_result`s. A positional "complete the last step" would re-complete one step N times and strand the rest at ⏳ forever. `tool_result` events carry `toolName` but no `toolCallId`, so `toolName` is the available correlation key. Milestone events (`planning`, `reflection`) are added already-complete, since they represent a finished node, not work in flight. |
| Narration format | Running checklist, edited in place | Extends Telegram's existing `ackMessageIds` + `editMessage` mechanism; Slack posts once then edits via `chat.update`. One message, not chat spam. |
| Narration channel scope | Telegram + Slack + Discord | All three are post-ack and asynchronous, so the 3-second constraint that limits direct replies does not apply. Discord is included because Task 1 makes `run:event` fire for the first time, which activates its existing but never-executed `sendStreamChunk` — leaving it alone would newly expose raw internal text (`[tool_call] execute_command`) to users. Its `patchOriginalMessage` already edits in place, so it needs no message-id tracking. |
| **Slack narration transport** | **`chat.update` with a bot token (amends the original `response_url` plan)** | `response_url` caps at 5 sends per invocation and expires in 30 minutes — unusable for a 10+ minute narrated run. `chat.update` on a bot-posted message has no such cap, and the 2s rate floor keeps it inside Slack's Tier-3 limits. Without a bot token the adapter skips narration silently — identical to today's behavior, not a regression. |
| Narration trigger | Step-boundary driven (`planning`, `tool_call`, `tool_result`, `reflection`), `ChannelRateLimiter` kept only as a safety floor | A dumb timer can show a stale checklist mid-step or skip fast steps. Checklist *state* always updates on every boundary; only the network send is throttled, so a suppressed update is never lost — it is folded into the next allowed send. |
| Checklist length | Collapse steps older than the last 6 into `"✅ N earlier steps completed"` | Keeps the message well under Telegram's 4096-char cap while still showing recent detail. |
| Late-narration race | Per-run `finished` guard | `GatewayEventBus.emit` does not await its async subscribers, so a narration edit in flight can land *after* `sendResult`'s final summary and overwrite it with a stale checklist. `sendResult`/`sendError` mark the run finished first; `sendStreamChunk` bails on a finished run. |

---

## Architecture

### Current flow

```
Telegram/Slack message
        │
        ▼
adapter.validateRequest() → adapter.parseInbound() → GatewayMessage
        │
        ▼
GatewayService.handleInbound()
   if (replyContext) → handleResume()        ← only existing gate
   agentOpsService.createRun()                ← ALWAYS reached otherwise
   adapter.sendAck("Agent Ops Started...")
   executeAgentRun()  (fire-and-forget)
        │
        ▼
Full LangGraph run (10+ min for real work)
        │
        ▼
processLangGraphEvent() → recordEvent() → Postgres only
        │                  (no bus emit → sendStreamChunk NEVER runs)
        ▼
NotificationRouter → adapter.sendResult (final summary only)
```

### Proposed flow

```
GatewayMessage
        │
        ▼
GatewayService.handleInbound()
   if (replyContext) → handleResume()          ← unchanged, already catches
                                                   pending clarification/approval replies
   if (personaEnabled(channel) && triageEnabled && adapter.sendDirectReply):
       triageChatMessage(...)                   ← reused as-is
       if route === 'direct':
           text = generateDirectReply(...)
           return adapter.sendDirectReply(req, text)   ← Telegram only; no run created
   agentOpsService.createRun()                  ← unchanged path otherwise
   adapter.sendAck(...)
   executeAgentRun(run, eventBus)
        │
        ▼
processLangGraphEvent(runId, tenantId, event, toolsUsed, eventBus)
   recordEvent()  → Postgres            (unchanged)
   eventBus.emit({type:'run:event'})     ← NEW: step boundaries only
        │
        ▼
NotificationRouter → adapter.sendStreamChunk → checklist, edited in place:
   ✅ Reviewed the plan
   ✅ Ran an AWS CLI command
   ⏳ Reading a file...
   (older completed steps collapse to "✅ N earlier steps completed")
        │
        ▼
adapter.sendResult (final summary, as today)
```

## Out of scope

- Discord's missing awaiting-answer gate (pre-existing; Telegram and Slack have one, Discord does not).
- Direct replies on Slack, Discord, webhook, Jira, and API channels (see the 3-second constraint above); revisit with an ack-then-deliver design.
- Narration on webhook, Jira, and API channels — none has an in-place-editable message surface to render a live checklist into.
- Conversation history on direct replies. Not needed here: on the gateway path, any message arriving *during* an active conversation is already routed to `handleResume` by `parseInbound`, so a message the classifier sees as `'direct'` is by definition not a mid-conversation follow-up.
- Any change to `deliveryMode`, adapter transport, or the Channel Gateway's core event bus / notification-routing design.

## Testing

- Unit: `run:event` emission for step-boundary event types only; template-map translator (real tool/node names → expected phrases, unmapped → LLM fallback path); keyed checklist correlation under interleaved parallel tool calls; collapse behavior past 6 steps; `sendDirectReply` on Telegram.
- Integration: a "hi" on Telegram produces a direct reply with zero `AgentOpsRun` rows created; a message following an open clarification-awaiting run still routes to `handleResume`, never to the classifier; a callback-mode adapter implementing `sendStreamChunk` receives `run:event`.
- Manual: watch a real multi-step Agent Ops run over Telegram, Slack, and Discord and confirm the checklist edits in place, in readable language, within each platform's message-length limit (Telegram 4096, Discord 2000) and without the final summary being overwritten by a late narration edit. Confirm a greeting on Slack/Discord still starts a normal run.

**Known-red baseline:** `bunx vitest run tests/gateway` currently fails 5 pre-existing tests across `slack-adapter.test.ts` (3), `telegram-adapter.test.ts` (1), and `api-adapter.test.ts` (1). These are unrelated to this work — do not chase them, and do not treat a fully-green run of those files as the success criterion.

---

## Revisions

**2026-07-28 — post-review revision.** An Opus 5 review of the first implementation plan against the real codebase found five substantive errors in the original design's assumptions. All are corrected above:

1. **Narration had no foundation.** `run:event` is emitted nowhere; `sendStreamChunk` has never run in production. Added as explicit prerequisite scope.
2. **The narration vocabulary was fictional.** The original map keyed on invented per-service tool names (`ec2_list_instances`, …) and event-type-shaped node names; neither exists. Corrected to the real tool catalog and LangGraph node names.
3. **Positional checklist completion is wrong** under the executor's parallel tool-call loop. Corrected to `toolName`-keyed correlation.
4. **Slack and Discord direct replies would time out** against their 3-second interaction windows. Direct replies narrowed to Telegram.
5. **Jira direct replies would be silently discarded** by the webhook caller. Jira excluded.
