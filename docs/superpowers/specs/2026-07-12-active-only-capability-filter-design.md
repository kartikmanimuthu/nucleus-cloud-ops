# Active-only capability filter for AIOps & Agent Ops

**Date:** 2026-07-12
**Branch:** agent-ops-integration-channel

## Problem

In the AIOps (chat) and Agent Ops (scheduled/autonomous) consoles, inactive
capabilities can still be discovered and used by the agent. The requirement:
**only active skills, MCP servers, knowledge bases, and tools may be visible or
used in these two modules. Anything inactive must not be discoverable, and the
agent must never use it.**

An audit found the enforcement is inconsistent:

| Capability | "Active" field | State today |
| --- | --- | --- |
| Skills | `Skill.isEnabled` | ✅ Already filtered in every load-bearing path |
| MCP servers | config `enabled` (`disabled` JSON prop) | ❌ Filtered only in the Agent Ops auto-default case; missing for every explicitly-selected path and all pickers |
| Knowledge bases | `KnowledgeBase.status` (`active`/`inactive`) | ❌ Vestigial — never set to inactive, never filtered anywhere |
| Tools (built-in) | none | n/a — always-on, static booleans; MCP-provided tools inherit MCP semantics |

## Decisions (confirmed with user)

1. **Visibility scope — consoles only.** Hide inactive items in the AIOps chat
   pickers and Agent Ops selection surfaces. The dedicated Settings / management
   pages (MCP Settings, Skills, Knowledge Base admin) keep listing everything so
   items can be re-enabled.
2. **Runtime enforcement — hard-enforce active-only.** If a saved task or chat
   request still references an item that was deactivated after it was
   configured, the agent silently drops it at assembly/retrieval time. Filtering
   the pickers is not enough on its own.
3. **Knowledge bases — wire filter + add toggle.** The `status` field is inert
   today, so we add an Activate/Deactivate action (+ API) in the KB management
   page and make every consumer/agent path respect `status='active'`.

## Design

Two enforcement layers applied per capability.

- **Layer A — Console visibility:** the selection pickers inside AIOps chat and
  Agent Ops only *offer* active items.
- **Layer B — Runtime hard-enforcement:** shared assembly/retrieval choke-points
  drop inactive items even when an id was saved or passed explicitly. This is the
  guarantee that survives stale selections.

### Skills — no change

`Skill.isEnabled` is already filtered in the repo default (`listByTenant`), every
`skill-service` loader, `getSkillContent` (the content-injection path),
`/api/skills` (enabled-only unless `?all`), and auto-select's catalog +
membership guard. Skills already satisfy the requirement. No code change.

(Latent, out of scope: `getBySlug`/`getById`/`getSkillById` ignore `isEnabled`,
but all current callers guard, so no disabled skill leaks. Left as-is.)

### MCP servers / MCP tools

**Layer B (primary choke-point):**
- `lib/agent/agent-shared.ts` `getActiveMCPTools` (~line 601): the
  `requestedConfigs` filter intersects on requested id only. Add `&& c.enabled`
  so disabled servers are never connected and their tools are never bound. This
  single fix covers AIOps chat, Agent Ops (via `model-factory.assembleTools`),
  **and** deep-agent, because they all route MCP tools through this function.
- `lib/agent-ops/agent-executor.ts` (both connect sites, ~lines 100 and 572):
  when a scheduled task carries explicit `mcpServerIds`, filter them to enabled
  configs before `connectServers`, so a disabled server is not even warmed. (The
  empty/auto-default branch already filters by `c.enabled`.)

**Layer A (visibility):**
- `components/agent/chat-interface.tsx` MCP picker (~line 2035): add a
  `.filter(server => server.enabled)` before the search filter/map.
- `components/deep-agent/mcp-skill-selector.tsx`: same — filter to enabled before
  render. (Included because it shares the picker surface; low cost, keeps
  behavior consistent.)

**Unchanged:** `GET /api/mcp-servers` and `GET /api/agent-ops/mcp-settings` keep
returning all servers (management surfaces, per decision 1).

### Knowledge bases

**New capability — deactivation (decision 3):**
- `lib/db/repositories/knowledge-base/{interface,postgres}.ts`: allow
  `updateKnowledgeBase` to set `status` (currently updates only name/description),
  or add a dedicated `setStatus(kbId, tenantId, status)`.
- API: extend the existing `PUT /api/knowledge-base/[kbId]` (or add `PATCH`) to
  accept `status: 'active' | 'inactive'`. Must call `authorize` and
  `AuditService.logUserAction` like the other KB mutations in that route.
- `lib/queries/knowledge-base.ts`: add a `useSetKnowledgeBaseStatus` mutation
  that invalidates the KB list.
- `app/app/knowledge-base/page.tsx`: add an Activate/Deactivate action next to the
  existing status badge (which already renders `Active`/`Inactive`).

**Layer B (choke-point):**
- `lib/knowledge-base/retrieval.ts` `searchKbChunks`: the raw SQL selects chunks
  by `tenantId` (+ optional `knowledgeBaseIds`) with no reference to KB status.
  Restrict to chunks whose parent KB is active via a subquery/join, e.g.
  `AND "knowledgeBaseId" IN (SELECT id FROM knowledge_bases WHERE "tenantId" = $x AND status = 'active')`.
  This covers both explicit-id and tenant-wide search in one place. `$executeRaw`
  is not tenant-intercepted, so keep the existing manual `tenantId` scoping.
- `lib/agent/auto-kb-select.ts` `autoSelectKb` (~lines 26–29): add
  `k.status === 'active'` alongside the existing `vectorCount > 0` filter, so
  inactive KBs are never auto-selected.

**Layer A (visibility):**
- `components/agent/chat-interface.tsx` KB picker (~line 1923): filter
  `knowledgeBases` to `kb.status === 'active'` before map.
- `lib/db/repositories/knowledge-base/postgres.ts` `listKnowledgeBases`: stays
  unfiltered so the management page still shows inactive KBs.

### Tools (built-in)

No active/inactive concept — built-ins are always assembled, gated only by static
boolean options in `assembleTools`. MCP-provided tools inherit the MCP fix above.
No change.

## Testing

- `getActiveMCPTools`: a disabled server whose id is explicitly requested yields
  no tools.
- `searchKbChunks`: chunks belonging to an `inactive` KB are excluded, for both
  explicit `knowledgeBaseIds` and the tenant-wide (no-ids) path.
- `autoSelectKb`: an inactive KB (even with `vectorCount > 0`) is not selected.
- KB status mutation: repo `setStatus`/update persists status; `PUT`/`PATCH` route
  enforces auth and writes an audit entry.
- Keep the existing skill tests green (no behavior change there).

## Out of scope

- No new `tools` table or per-built-in-tool active flag.
- No changes to management/Settings page visibility.
- Skill `getBySlug`/`getById` hardening (latent, callers guard).
- MCP remote-URL SSRF hardening (pre-existing accepted risk, unrelated).

## Files touched (summary)

Runtime enforcement:
- `apps/web-ui/lib/agent/agent-shared.ts`
- `apps/web-ui/lib/agent-ops/agent-executor.ts`
- `apps/web-ui/lib/knowledge-base/retrieval.ts`
- `apps/web-ui/lib/agent/auto-kb-select.ts`

Console visibility:
- `apps/web-ui/components/agent/chat-interface.tsx`
- `apps/web-ui/components/deep-agent/mcp-skill-selector.tsx`

KB deactivation feature:
- `apps/web-ui/lib/db/repositories/knowledge-base/interface.ts`
- `apps/web-ui/lib/db/repositories/knowledge-base/postgres.ts`
- `apps/web-ui/lib/knowledge-base/service.ts`
- `apps/web-ui/app/api/knowledge-base/[kbId]/route.ts`
- `apps/web-ui/lib/queries/knowledge-base.ts`
- `apps/web-ui/app/app/knowledge-base/page.tsx`
