# Memory Module — Design

**Date:** 2026-07-01
**Branch:** `skill-memory`
**Status:** Approved (design phase)

## Goal

A dedicated, read + delete UI module that surfaces the agent-generated memories
already stored in the `agent_memories` table, so users can review and prune what
the AIOps agent has learned during sessions. **No schema changes, no agent-code
changes** — this is a UI/API/repository slice over an existing table.

Future work (explicitly out of scope here): a background job that auto-generates
memory daily by front-running sessions. This design only builds the module that
displays what already exists.

## Existing backbone (no changes)

The `AgentMemory` Prisma model already exists and is populated by `memorySaveNode`
in `apps/web-ui/lib/agent/memory-nodes.ts` after agent runs:

```prisma
model AgentMemory {
  id         String                       @id @default(cuid())
  tenantId   String
  userId     String
  namespace  String                       // slash-joined, e.g. "infra/<account-id>"
  key        String
  value      Json                          // { fact, source, confidence }
  embedding  Unsupported("vector(1024)")?
  createdAt  DateTime                      @default(now())
  updatedAt  DateTime                      @updatedAt
  expiresAt  DateTime                      // 90-day TTL

  @@unique([tenantId, namespace, key])
  @@index([tenantId, userId])
  @@index([expiresAt])
  @@map("agent_memories")
}
```

- `value` JSON shape: `{ fact: string; source: string; confidence: "high" | "medium" | "low" }`.
- `namespace` conventions: `infra/<account-id>`, `user/preferences`,
  `patterns/<service-type>`, `errors/<service-type>`.
- Memories are NOT linked to a specific run/session today, and this design does
  not add such a link.

## Scope (locked decisions)

1. **Capabilities:** view, search/filter, and **delete**. No manual create/edit —
   memories stay agent-generated.
2. **Provenance:** existing fields only (`namespace`, `key`,
   `value.{fact, source, confidence}`, `createdAt`, `updatedAt`, `expiresAt`).
   No new columns; no migration.
3. **Tenant scope:** show ALL memories in the active tenant, regardless of which
   user's run created them. Memory is treated as shared org knowledge (mirrors the
   certificate/inventory module pattern).
4. **RBAC:** new `Memory` subject mapped to the existing `AIOps` module. `read` to
   view, `delete` to remove. Anyone with Agent Ops access sees it; no new permission
   toggle in the role matrix.

## Vertical slice (mirrors certificate-manager)

| Layer | Path |
|---|---|
| Nav entry | `apps/web-ui/lib/nav-config.ts` — "Memory" under the **Agentic Ops** group, `href: /app/memory` |
| Page | `apps/web-ui/app/app/memory/page.tsx` — server component rendering the client component |
| Components | `apps/web-ui/components/memory/` — `memory-client-component.tsx`, `memory-detail-dialog.tsx`, `delete-memory-dialog.tsx` |
| API | `apps/web-ui/app/api/agent-memories/route.ts` (`GET` list), `apps/web-ui/app/api/agent-memories/[id]/route.ts` (`GET` detail, `DELETE`) |
| Repository | `apps/web-ui/lib/db/repositories/agent-memory/interface.ts` + `postgres.ts` (via `getTenantClient(tenantId)`) |
| Repository factory | register `getAgentMemoryRepository()` in `apps/web-ui/lib/db/repository-factory.ts` |
| Queries | `apps/web-ui/lib/queries/agent-memories.ts` + entry in `apps/web-ui/lib/queries/query-keys.ts` |
| RBAC | `apps/web-ui/lib/rbac/types.ts` — add `Memory: 'AIOps'` to `SUBJECT_TO_MODULE` |

## Category derivation

`namespace` is a slash-joined string. The UI category = the first path segment:

| First segment | Category label |
|---|---|
| `infra` | Infra |
| `user` | User |
| `patterns` | Patterns |
| `errors` | Errors |
| anything else | Other |

This mapping lives in a small pure helper (e.g. `categoryFromNamespace(namespace)`)
that is unit-tested. Filtering by category is implemented in the repository as a
`namespace startsWith "<segment>/"` (or exact-match) predicate; the "Other" bucket
is "none of the known prefixes."

## UI

A sortable **table**, columns: *Category · Key · Fact (truncated) · Confidence ·
Created · Expires · ⋯actions*.

Controls above the table:
- **Category filter** — All / Infra / User / Patterns / Errors / Other.
- **Search box** — matches `key` and the `fact` text (case-insensitive contains).

Interactions:
- Row click → **detail dialog**: namespace, key, pretty-printed `value` JSON,
  source, confidence, created/updated/expires timestamps.
- Row ⋯ menu → **delete** (confirm dialog).
- **Empty state**: "No memories yet — the AIOps agent will populate these as it
  works."

Use existing primitives: TanStack Table (already a dependency) or the existing
table component pattern used by other modules, `Spinner` for loading, `sonner`
toasts for outcomes, framer-motion page transition (already wired globally).

## Data flow

**List:** `useAgentMemories(filters)` → `GET /api/agent-memories?category=&search=&page=&limit=`
→ `authorize('read', 'Memory')` → `getAgentMemoryRepository().listByTenant({ tenantId, category, search, page, limit })`
(uses `getTenantClient(tenantId)`, auto-scoped to tenant) →
`{ success: true, data: { memories, total } }`.

**Detail:** `useAgentMemory(id)` → `GET /api/agent-memories/[id]` →
`authorize('read', 'Memory')` → repository `getById(tenantId, id)`.

**Delete:** `useDeleteAgentMemory(id)` → `DELETE /api/agent-memories/[id]` →
`authorize('delete', 'Memory')` → pre-flight ownership check (fetch by
`tenantId + id`; 404 if not found / cross-tenant) → delete → client invalidates
`queryKeys.agentMemories.all`.

All reads/writes go through the repository factory and `getTenantClient` — never
Prisma directly from routes. Tenant scoping is automatic via the Prisma extension
(no `$executeRaw` here, so no manual scoping needed).

## Query keys

Add to `query-keys.ts`:

```ts
agentMemories: {
  all: ['agent-memories'] as const,
  lists: () => [...queryKeys.agentMemories.all, 'list'] as const,
  list: (filters?: unknown) => [...queryKeys.agentMemories.lists(), filters ?? {}] as const,
  details: () => [...queryKeys.agentMemories.all, 'detail'] as const,
  detail: (id: string) => [...queryKeys.agentMemories.details(), id] as const,
},
```

## Error handling

- API envelope: `{ success: true, data }` or `{ success: false, error: string }`.
- `authorize` returns a 403 `NextResponse` when denied (returned directly).
- Detail/delete on a missing or cross-tenant id → 404 `{ success: false, error: "Memory not found" }`.
- Unexpected failures → 500, `console.error('API - Error ...', error)`.
- Client surfaces errors and successes via `sonner` toasts.

## Testing (Vitest, web-ui)

1. **Repository tenant-scoping** — tenant A cannot `listByTenant` or delete tenant
   B's memory (mirrors existing repo isolation tests).
2. **API auth** — `GET`/`DELETE` return 403 when `authorize` denies; `DELETE`
   returns 404 for a cross-tenant / missing id.
3. **Category-derivation unit test** — `categoryFromNamespace` maps each known
   prefix correctly and falls back to "Other".

## Out of scope (YAGNI)

- Background daily auto-generation of memory (future work).
- Manual memory creation / editing.
- Embedding / semantic-search UI.
- Run/session → memory linkage (would require a schema column + agent change).
